import { IdempotencyKeySchema, type CreateJobRequest } from '@starter/contracts';
import { describe, expect, it } from 'vitest';
import {
  DERIVED_KEY_PREFIX,
  IDEMPOTENCY_TTL_SECONDS,
  canonicalJson,
  expiresAtEpochSeconds,
  principalKey,
  principalScope,
  requestFingerprint,
  resolveIdempotencyKey,
  sha256Hex,
  stepIdempotencyKey,
} from '../src/index.js';

const request: CreateJobRequest = { title: 'T', content: 'body', options: { topTerms: 10 } };
const ISSUER = 'https://idp.example.com';
const alice = principalKey(ISSUER, 'alice');
const bob = principalKey(ISSUER, 'bob');

describe('canonicalJson', () => {
  it('sorts keys recursively and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, 'x', null], c: true }, u: undefined })).toBe(
      '{"a":{"c":true,"d":[1,"x",null]},"b":1}',
    );
  });

  it('produces the same output regardless of key order', () => {
    expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }));
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])('rejects %s', (n) => {
    expect(() => canonicalJson({ n })).toThrow(TypeError);
  });

  it('rejects unsupported types', () => {
    expect(() => canonicalJson({ f: () => 1 })).toThrow(/unsupported type function/);
    expect(() => canonicalJson(BigInt(1))).toThrow(TypeError);
  });
});

describe('principal keys', () => {
  it('is the SHA-256 of iss|sub', () => {
    expect(alice).toBe(sha256Hex(`${ISSUER}|alice`));
    expect(alice).toMatch(/^[a-f0-9]{64}$/);
    expect(alice).not.toBe(bob);
    expect(principalKey('https://other.example.com', 'alice')).not.toBe(alice);
  });

  it('rejects an empty issuer or subject', () => {
    expect(() => principalKey('', 'alice')).toThrow(TypeError);
    expect(() => principalKey(ISSUER, '')).toThrow(TypeError);
  });

  it('only builds a scope from a well-formed principal key', () => {
    expect(principalScope(alice)).toBe(`p:${alice}:`);
    for (const bad of ['', 'alice', `${alice}:x`, alice.toUpperCase(), alice.slice(1)]) {
      expect(() => principalScope(bad), bad).toThrow(TypeError);
    }
  });
});

describe('idempotency keys', () => {
  it('derives a stable key from the canonical request when no header is sent', () => {
    const a = resolveIdempotencyKey(undefined, request, alice);
    const b = resolveIdempotencyKey(
      undefined,
      { options: { topTerms: 10 }, content: 'body', title: 'T' },
      alice,
    );
    expect(a).toEqual(b);
    expect(a.source).toBe('derived');
    expect(a.key).toBe(`p:${alice}:${DERIVED_KEY_PREFIX}${a.fingerprint}`);
    expect(a.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('scopes the same header key and the same body to each principal', () => {
    const header = (p: string) => resolveIdempotencyKey('client-key-123', request, p);
    const derived = (p: string) => resolveIdempotencyKey(undefined, request, p);
    expect(header(alice).key).not.toBe(header(bob).key);
    expect(derived(alice).key).not.toBe(derived(bob).key);
    // The fingerprint is a property of the body only (detects reuse with another body).
    expect(header(alice).fingerprint).toBe(header(bob).fingerprint);
  });

  it('can never produce a legacy (unscoped) key', () => {
    for (const resolved of [
      resolveIdempotencyKey('client-key-123', request, alice),
      resolveIdempotencyKey(undefined, request, alice),
    ]) {
      expect(resolved.key.startsWith('p:')).toBe(true);
      expect(resolved.key).not.toBe('client-key-123');
      expect(resolved.key.startsWith(DERIVED_KEY_PREFIX)).toBe(false);
    }
  });

  it('refuses to resolve a key without a principal scope', () => {
    expect(() => resolveIdempotencyKey('client-key-123', request, '')).toThrow(TypeError);
  });

  it('changes the fingerprint when any field changes', () => {
    const base = requestFingerprint(request);
    expect(requestFingerprint({ ...request, content: 'body ' })).not.toBe(base);
    expect(requestFingerprint({ ...request, options: { topTerms: 11 } })).not.toBe(base);
  });

  it('embeds the header key verbatim (scoped) and still fingerprints the body', () => {
    const resolved = resolveIdempotencyKey('client-key-123', request, alice);
    expect(resolved).toEqual({
      key: `p:${alice}:h:client-key-123`,
      source: 'header',
      fingerprint: requestFingerprint(request),
    });
  });

  it('server-generated keys can never be sent as a client header', () => {
    const derived = resolveIdempotencyKey(undefined, request, alice).key;
    expect(IdempotencyKeySchema.safeParse(derived).success).toBe(false);
    const scopedHeader = resolveIdempotencyKey('client-key-123', request, alice).key;
    expect(IdempotencyKeySchema.safeParse(scopedHeader).success).toBe(false);
    expect(IdempotencyKeySchema.safeParse(derived).success).toBe(false);
    expect(IdempotencyKeySchema.safeParse(stepIdempotencyKey('id', 'ProcessJob')).success).toBe(
      false,
    );
  });

  it('computes TTL expiry in epoch seconds', () => {
    const now = new Date('2026-10-13T00:00:00.000Z');
    expect(expiresAtEpochSeconds(now)).toBe(now.getTime() / 1000 + IDEMPOTENCY_TTL_SECONDS);
    expect(expiresAtEpochSeconds(now, 60)).toBe(now.getTime() / 1000 + 60);
  });
});
