import { Writable } from 'node:stream';
import { DEFAULT_SCOPES } from '@starter/contracts';
import { principalKey } from '@starter/domain';
import { InMemoryJobStateStore } from '@starter/job-state';
import { createLogger, type Logger } from '@starter/observability';
import { bearer, createTestIssuer, type MintOptions, type TestIssuer } from '@starter/testing';
import { assertExecutionInput, type ProcessingExecutionInput } from '@starter/workflow-processing';
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import { buildApp, type App, type AppDeps } from '../../src/app.js';
import type { AuthDeps } from '../../src/auth/hooks.js';
import { StaticKeySource, type KeySource } from '../../src/auth/key-source.js';
import { TokenVerifier } from '../../src/auth/verifier.js';
import type { Cursor } from '../../src/cursor.js';
import { createLifecycle, type HealthCheck } from '../../src/health.js';
import {
  OwnershipConflictError,
  type InsertOutcome,
  type JobOwner,
  type JobRecord,
  type JobRecordRepository,
  type JobRecordSummary,
  type NewJobRecord,
} from '../../src/persistence/job-repository.js';
import type { StartResult, WorkflowPort } from '../../src/workflow/port.js';

const sameOwner = (a: JobOwner, b: JobOwner) => a.issuer === b.issuer && a.subject === b.subject;
/** The read model never carries the document content. */
const withoutContent = ({ content: _content, ...record }: NewJobRecord): JobRecord => record;

export class InMemoryJobRepository implements JobRecordRepository {
  /** Stored rows INCLUDING content (what PostgreSQL holds); reads strip it. */
  readonly records = new Map<string, NewJobRecord>();
  private failures: unknown[] = [];

  failNext(error: unknown): void {
    this.failures.push(error);
  }

  private maybeFail(): void {
    const next = this.failures.shift();
    if (next) throw next;
  }

  /** Mirrors PgJobRepository: global unique id/key, conflicts resolved among the owner's rows. */
  async insert(record: NewJobRecord): Promise<InsertOutcome> {
    this.maybeFail();
    const sameId = this.records.get(record.id);
    const sameKey = [...this.records.values()].find(
      (r) => r.idempotencyKey === record.idempotencyKey,
    );
    const conflict = sameId ?? sameKey;
    if (conflict) {
      if (!sameOwner(conflict.owner, record.owner)) {
        throw new OwnershipConflictError('insert conflicted with a row of another owner');
      }
      return conflict === sameId
        ? { status: 'exists', record: withoutContent(conflict) }
        : { status: 'key-conflict', record: withoutContent(conflict) };
    }
    this.records.set(record.id, structuredClone(record));
    return { status: 'inserted', record: withoutContent(record) };
  }

  async findOwned(id: string, owner: JobOwner): Promise<JobRecord | null> {
    this.maybeFail();
    const record = this.records.get(id);
    return record && sameOwner(record.owner, owner) ? withoutContent(record) : null;
  }

  async listOwned(owner: JobOwner, limit: number, after?: Cursor): Promise<JobRecordSummary[]> {
    this.maybeFail();
    return [...this.records.values()]
      .filter((r) => sameOwner(r.owner, owner))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1))
      .filter(
        (r) =>
          !after ||
          r.createdAt.getTime() < after.createdAt.getTime() ||
          (r.createdAt.getTime() === after.createdAt.getTime() && r.id < after.id),
      )
      .slice(0, limit)
      .map((r) => ({ id: r.id, title: r.title, createdAt: r.createdAt }));
  }

  async ping(): Promise<void> {
    this.maybeFail();
  }
}

export class FakeWorkflow implements WorkflowPort {
  readonly kind = 'stepfunctions' as const;
  readonly started: ProcessingExecutionInput[] = [];
  private failures: unknown[] = [];

  failNext(error: unknown): void {
    this.failures.push(error);
  }

  async start(input: ProcessingExecutionInput): Promise<StartResult> {
    const failure = this.failures.shift();
    if (failure) throw failure;
    // Same guard as the real adapters (spec 2.0.0); records a copy of exactly what was sent.
    assertExecutionInput(input);
    this.started.push(structuredClone(input));
    return { executionArn: `arn:fake:execution:${input.jobId}`, alreadyStarted: false };
  }

  async drain(): Promise<void> {}
}

/** A workflow whose `start` blocks until `release()`: lets a test act while a create is in flight. */
export class GatedWorkflow extends FakeWorkflow {
  private open: () => void = () => {};
  private signalEntered: () => void = () => {};
  private readonly gate = new Promise<void>((resolve) => {
    this.open = resolve;
  });
  /** Resolves once `start` was called, i.e. the job row and its state exist. */
  readonly entered = new Promise<void>((resolve) => {
    this.signalEntered = resolve;
  });

  release(): void {
    this.open();
  }

  override async start(input: ProcessingExecutionInput): Promise<StartResult> {
    this.signalEntered();
    await this.gate;
    return super.start(input);
  }
}

export function capturingLogger(): {
  logger: Logger;
  lines: Record<string, unknown>[];
  raw: string[];
} {
  const lines: Record<string, unknown>[] = [];
  const raw: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) {
        raw.push(line);
        lines.push(JSON.parse(line) as Record<string, unknown>);
      }
      cb();
    },
  });
  return {
    logger: createLogger({ service: 'api-test', level: 'debug', destination: stream }),
    lines,
    raw,
  };
}

/** Issuer identifier of the unit-test tokens (keys are static: no HTTP in unit tests). */
export const UNIT_ISSUER = 'https://idp.unit.test';
export const UNIT_AUDIENCE = 'starter-jobs-api';

let sharedIssuer: Promise<TestIssuer> | undefined;
/** One RSA issuer per test file (key generation is the slow part). Never rotate it. */
export const unitIssuer = () =>
  (sharedIssuer ??= createTestIssuer({ issuer: UNIT_ISSUER, audience: UNIT_AUDIENCE }));

/** sha256(iss|sub): the idempotency scope of a unit-test principal. */
export const unitPrincipalKey = (sub: string) => principalKey(UNIT_ISSUER, sub);

export const GENEROUS_LIMITS: AuthDeps['rateLimit'] = {
  windowSeconds: 60,
  readMax: 10_000,
  writeMax: 10_000,
  unauthenticatedMax: 10_000,
};

/** Auth deps for unit tests. `now` drives the rate limiter only (tokens use the real clock). */
export function testAuth(
  keys: KeySource,
  overrides: Partial<Omit<AuthDeps, 'verifier'>> = {},
): AuthDeps {
  return {
    verifier: new TokenVerifier({
      issuer: UNIT_ISSUER,
      audience: UNIT_AUDIENCE,
      algorithms: ['RS256', 'ES256'],
      clockToleranceSeconds: 30,
      keys,
    }),
    scopes: { ...DEFAULT_SCOPES },
    rateLimit: GENEROUS_LIMITS,
    ...overrides,
  };
}

export type AuthInjectOptions = Omit<InjectOptions, 'headers'> & {
  headers?: Record<string, string>;
  /** Caller (`sub`) whose token is attached; `null` = anonymous. Default `alice`. */
  as?: string | null;
};

/**
 * The unit-test harness. Annotated explicitly: an inferred type would name
 * `light-my-request` (fastify's inject response) through pnpm's virtual store,
 * which TypeScript rejects as non-portable on some file systems (TS2883 in CI).
 */
export interface TestApp {
  app: App;
  jobs: InMemoryJobRepository;
  state: InMemoryJobStateStore;
  workflow: FakeWorkflow;
  lifecycle: ReturnType<typeof createLifecycle>;
  lines: ReturnType<typeof capturingLogger>['lines'];
  raw: ReturnType<typeof capturingLogger>['raw'];
  issuer: TestIssuer;
  /** `app.inject` with `Authorization: Bearer <token of opts.as>` unless anonymous or explicit. */
  inject: (options: AuthInjectOptions) => Promise<LightMyRequestResponse>;
  /** A valid token for `sub` (cached per harness). */
  tokenFor: (sub?: string) => Promise<string>;
  /** A token for `sub` with mint options (negative cases, scopes). */
  mint: (opts?: MintOptions, claims?: Record<string, unknown>) => Promise<string>;
}

export async function buildTestApp(overrides: Partial<AppDeps> = {}): Promise<TestApp> {
  const issuer = await unitIssuer();
  const jobs = new InMemoryJobRepository();
  const state = new InMemoryJobStateStore();
  const workflow = new FakeWorkflow();
  const lifecycle = createLifecycle();
  const { logger, lines, raw } = capturingLogger();
  let tick = Date.parse('2026-10-13T10:00:00.000Z');
  const healthChecks: HealthCheck[] = [
    { name: 'postgres', check: () => jobs.ping() },
    { name: 'dynamodb', check: () => state.ping() },
  ];
  const app = await buildApp({
    logger,
    jobs,
    state,
    workflow,
    lifecycle,
    healthChecks,
    corsAllowedOrigins: [],
    auth: testAuth(new StaticKeySource(issuer.jwks())),
    clock: () => new Date((tick += 1000)),
    readinessTimeoutMs: 200,
    ...overrides,
  });

  const tokens = new Map<string, string>();
  /** A valid token for `sub` (cached per harness). */
  const tokenFor = async (sub = 'alice') => {
    let token = tokens.get(sub);
    if (!token) {
      token = await issuer.mint({ sub });
      tokens.set(sub, token);
    }
    return token;
  };
  /** `app.inject` with `Authorization: Bearer <token of opts.as>` unless anonymous or explicit. */
  const inject = async ({ as = 'alice', headers = {}, ...rest }: AuthInjectOptions) => {
    const merged = { ...headers };
    if (as !== null && merged.authorization === undefined) {
      merged.authorization = bearer(await tokenFor(as));
    }
    return app.inject({ ...rest, headers: merged });
  };
  /** A token for `sub` with mint options (negative cases, scopes). */
  const mint = (opts: MintOptions = {}, claims: Record<string, unknown> = {}) =>
    issuer.mint({ sub: 'alice', ...claims }, opts);
  return { app, jobs, state, workflow, lifecycle, lines, raw, issuer, inject, tokenFor, mint };
}
