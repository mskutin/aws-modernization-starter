/**
 * Where token-verification keys come from (ADR 0210).
 *
 * `RemoteJwksSource` fetches the issuer's JWK Set (OIDC discovery, or AUTH_JWKS_URI) and is
 * built for hostile input and IdP outages:
 *
 *  - Bounded fetching: at most ONE fetch attempt (success or failure) per `cooldownMs`, no matter
 *    how many requests arrive. A flood of tokens with random `kid`s therefore causes at most one
 *    refetch per cooldown; a failing IdP is not hammered either. Concurrent callers share the
 *    in-flight fetch.
 *  - Rotation: a token whose `kid` is unknown triggers that (rate-limited) refetch, so a newly
 *    published key is accepted, and a key removed from the JWKS stops verifying once the set
 *    has been refreshed (on such a refetch or the periodic `maxAgeMs` refresh).
 *  - Stale-while-error: a failed refresh keeps the last good key set (keys do not change while
 *    the IdP is unreachable) for at most `maxStaleMs`; after that, or when no set was ever
 *    loaded, verification fails with `AuthUnavailableError` (503), never with a crash.
 *  - Strict transport: timeout, no redirects, response-size cap, https unless the local
 *    `allowInsecure` switch is on (config refuses it in production), discovery `issuer` must
 *    equal the configured issuer exactly, private or symmetric keys are dropped.
 */
import type { Logger } from '@starter/observability';
import { createLocalJWKSet, type JWK, type JSONWebKeySet, type LocalJWKSet } from 'jose';

/** Keys of the issuer as a jose resolver (selects by `kid` and `alg`). */
export type KeySet = LocalJWKSet;

/** The keys needed to verify tokens cannot be obtained right now → 503, not 401. */
export class AuthUnavailableError extends Error {
  override readonly name = 'AuthUnavailableError';
}

export interface KeySource {
  /** Current key set; loads it on first use. Throws `AuthUnavailableError`. */
  current(): Promise<KeySet>;
  /**
   * A token names a `kid` the current set lacks: refetch unless one happened within the cooldown.
   * Returns the refreshed set, `null` while cooling down; throws `AuthUnavailableError` when the
   * refetch fails.
   */
  refreshForUnknownKey(): Promise<KeySet | null>;
}

/** Fixed key set (unit tests, or keys provisioned out of band). Never refetches. */
export class StaticKeySource implements KeySource {
  private readonly keys: KeySet;
  constructor(jwks: JSONWebKeySet) {
    this.keys = createLocalJWKSet({ keys: filterSigningKeys(jwks.keys) });
  }
  async current(): Promise<KeySet> {
    return this.keys;
  }
  async refreshForUnknownKey(): Promise<KeySet | null> {
    return null;
  }
}

const ASYMMETRIC_KEY_TYPES = new Set(['RSA', 'EC', 'OKP']);
const PRIVATE_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'];
export const MAX_JWKS_KEYS = 100;

/**
 * Public, asymmetric signature keys only. Symmetric (`oct`) keys are never usable for
 * verification here, and a JWKS that leaks private members is an IdP misconfiguration whose
 * keys we refuse rather than use.
 */
export function filterSigningKeys(keys: readonly unknown[], algorithms?: readonly string[]): JWK[] {
  const usable: JWK[] = [];
  for (const key of keys.slice(0, MAX_JWKS_KEYS)) {
    if (typeof key !== 'object' || key === null || Array.isArray(key)) continue;
    const jwk = key as JWK & Record<string, unknown>;
    if (typeof jwk.kty !== 'string' || !ASYMMETRIC_KEY_TYPES.has(jwk.kty)) continue;
    if (PRIVATE_MEMBERS.some((member) => member in jwk)) continue;
    if (jwk.use !== undefined && jwk.use !== 'sig') continue;
    if (algorithms && jwk.alg !== undefined && !algorithms.includes(jwk.alg)) continue;
    usable.push(jwk);
  }
  return usable;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface RemoteJwksOptions {
  /** Configured issuer; discovery must report exactly this value. */
  issuer: string;
  /** Explicit JWKS URL (AUTH_JWKS_URI); otherwise OIDC discovery. */
  jwksUri?: string | undefined;
  /** Accept http: URLs (local test IdP only; refused in production by the config schema). */
  allowInsecure: boolean;
  /** Accepted JWS algorithms; keys declaring another `alg` are dropped. */
  algorithms: readonly string[];
  logger: Pick<Logger, 'info' | 'warn'>;
  fetch?: FetchLike;
  /** Epoch milliseconds. */
  now?: () => number;
  timeoutMs?: number;
  cooldownMs?: number;
  maxAgeMs?: number;
  maxStaleMs?: number;
  maxBytes?: number;
}

export const JWKS_DEFAULTS = {
  timeoutMs: 3_000,
  cooldownMs: 30_000,
  maxAgeMs: 10 * 60_000,
  maxStaleMs: 24 * 60 * 60_000,
  maxBytes: 256 * 1024,
} as const;

interface LoadedSet {
  keys: KeySet;
  kids: string[];
  fetchedAt: number;
}

export function discoveryUrl(issuer: string): string {
  return `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`response of ${declared} bytes exceeds ${maxBytes}`);
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`response exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export class RemoteJwksSource implements KeySource {
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly cooldownMs: number;
  private readonly maxAgeMs: number;
  private readonly maxStaleMs: number;
  private readonly maxBytes: number;
  private jwksUri: string | undefined;
  /** Discovery document URL, transport-checked like every other fetch. */
  private readonly discoveryUri: string | undefined;
  private loaded: LoadedSet | undefined;
  private inflight: Promise<LoadedSet> | undefined;
  private lastAttemptAt = Number.NEGATIVE_INFINITY;
  /** Fetch attempts (discovery + JWKS count as one) and failures, for tests and metrics. */
  readonly stats = { attempts: 0, failures: 0 };

  constructor(private readonly options: RemoteJwksOptions) {
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init)); // nosemgrep: nodejs_scan.javascript-ssrf-rule-node_ssrf -- only operator-configured issuer/JWKS URLs or the IdP's discovered jwks_uri, all https-checked by checkedUrl; never request input
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? JWKS_DEFAULTS.timeoutMs;
    this.cooldownMs = options.cooldownMs ?? JWKS_DEFAULTS.cooldownMs;
    this.maxAgeMs = options.maxAgeMs ?? JWKS_DEFAULTS.maxAgeMs;
    this.maxStaleMs = options.maxStaleMs ?? JWKS_DEFAULTS.maxStaleMs;
    this.maxBytes = options.maxBytes ?? JWKS_DEFAULTS.maxBytes;
    // Fail at construction (start-up) on a non-https JWKS or discovery URL.
    if (options.jwksUri) this.jwksUri = this.checkedUrl(options.jwksUri, 'AUTH_JWKS_URI');
    else this.discoveryUri = this.checkedUrl(discoveryUrl(options.issuer), 'discovery URL');
  }

  async current(): Promise<KeySet> {
    const loaded = this.loaded;
    if (!loaded) return (await this.awaitOrStart('initial')).keys;
    const age = this.now() - loaded.fetchedAt;
    if (age >= this.maxStaleMs) {
      // Too old to keep trusting without a successful refresh.
      return (await this.awaitOrStart('max-stale')).keys;
    }
    if (age >= this.maxAgeMs && !this.inflight && !this.coolingDown()) {
      // Stale-while-revalidate: serve the cached keys, refresh in the background.
      this.start('max-age').catch(() => undefined);
    }
    return loaded.keys;
  }

  async refreshForUnknownKey(): Promise<KeySet | null> {
    if (this.inflight) return (await this.settle(this.inflight)).keys;
    if (this.coolingDown()) return null;
    return (await this.settle(this.start('unknown-kid'))).keys;
  }

  /** Loads the keys eagerly (start-up); failures are logged, never thrown. */
  async warmUp(): Promise<boolean> {
    try {
      await this.current();
      return true;
    } catch {
      return false;
    }
  }

  private coolingDown(): boolean {
    return this.now() - this.lastAttemptAt < this.cooldownMs;
  }

  /** Joins an in-flight fetch, or starts one unless the cooldown forbids it. */
  private async awaitOrStart(reason: string): Promise<LoadedSet> {
    if (this.inflight) return this.settle(this.inflight);
    if (this.coolingDown()) {
      throw new AuthUnavailableError('issuer keys unavailable (last fetch failed; cooling down)');
    }
    return this.settle(this.start(reason));
  }

  private async settle(pending: Promise<LoadedSet>): Promise<LoadedSet> {
    try {
      return await pending;
    } catch (error) {
      throw new AuthUnavailableError('issuer keys unavailable', { cause: error });
    }
  }

  private start(reason: string): Promise<LoadedSet> {
    this.lastAttemptAt = this.now();
    this.stats.attempts += 1;
    const pending = this.load().then(
      (loaded) => {
        const previous = this.loaded?.kids ?? [];
        this.loaded = loaded;
        this.options.logger.info(
          {
            jwks: {
              reason,
              kids: loaded.kids,
              removed: previous.filter((k) => !loaded.kids.includes(k)),
            },
          },
          'issuer signing keys loaded',
        );
        return loaded;
      },
      (error: unknown) => {
        this.stats.failures += 1;
        this.options.logger.warn(
          {
            jwks: { reason, keepingCachedKeys: Boolean(this.loaded) },
            err: { message: error instanceof Error ? error.message : String(error) },
          },
          'issuer signing keys could not be fetched',
        );
        throw error;
      },
    );
    const tracked = pending.finally(() => {
      if (this.inflight === tracked) this.inflight = undefined;
    });
    this.inflight = tracked;
    return tracked;
  }

  private async load(): Promise<LoadedSet> {
    this.jwksUri ??= await this.discover();
    try {
      return await this.loadKeys(this.jwksUri);
    } catch (error) {
      // A discovered jwks_uri may have moved: re-discover on the next (rate-limited) attempt.
      if (!this.options.jwksUri) this.jwksUri = undefined;
      throw error;
    }
  }

  private async loadKeys(jwksUri: string): Promise<LoadedSet> {
    const body = await this.getJson(jwksUri);
    const rawKeys =
      typeof body === 'object' && body !== null && Array.isArray((body as { keys?: unknown }).keys)
        ? (body as { keys: unknown[] }).keys
        : undefined;
    if (!rawKeys) throw new Error('JWKS response is not a JWK Set');
    const keys = filterSigningKeys(rawKeys, this.options.algorithms);
    if (keys.length === 0) throw new Error('JWKS contains no usable public signing key');
    return {
      keys: createLocalJWKSet({ keys }),
      kids: keys.map((k) => k.kid ?? '(no kid)'),
      fetchedAt: this.now(),
    };
  }

  private async discover(): Promise<string> {
    if (!this.discoveryUri) throw new Error('no discovery URL (AUTH_JWKS_URI is set)');
    const document = await this.getJson(this.discoveryUri);
    if (typeof document !== 'object' || document === null) {
      throw new Error('discovery document is not a JSON object');
    }
    const { issuer, jwks_uri: jwksUri } = document as { issuer?: unknown; jwks_uri?: unknown };
    if (issuer !== this.options.issuer) {
      throw new Error('discovery document issuer does not match AUTH_ISSUER');
    }
    if (typeof jwksUri !== 'string') throw new Error('discovery document has no jwks_uri');
    return this.checkedUrl(jwksUri, 'jwks_uri');
  }

  private checkedUrl(value: string, label: string): string {
    const url = new URL(value);
    if (url.protocol === 'https:' || (url.protocol === 'http:' && this.options.allowInsecure)) {
      return url.href;
    }
    throw new Error(`${label} must be an https URL`);
  }

  /** Only called with URLs that passed `checkedUrl` (constructor, `discover`). */
  private async getJson(url: string): Promise<unknown> {
    const response = await this.fetchImpl(url, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status} from ${url}`);
    }
    return JSON.parse(await readCapped(response, this.maxBytes)) as unknown;
  }
}
