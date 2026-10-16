/**
 * Tokens for the suites, minted by the TEST-ONLY issuer through its `POST /test/token` contract:
 * the test IdP container (external mode) or the harness control server
 * wrapping `@starter/testing/auth` (self mode). `options` are the issuer's MintOptions, so every
 * negative case of NEGATIVE_TOKEN_CASES is available in both modes.
 */
import type { MintOptions } from '@starter/testing/auth';

export const READ_WRITE = 'jobs:read jobs:write';

export interface MintRequest {
  sub: string;
  scope?: string;
  claims?: Record<string, unknown>;
  options?: MintOptions;
}

export async function mintToken(endpoint: string, request: MintRequest): Promise<string> {
  const init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scope: READ_WRITE, ...request }),
    signal: AbortSignal.timeout(10_000),
  };
  const res = await fetch(endpoint, init); // nosemgrep: nodejs_scan.javascript-ssrf-rule-node_ssrf -- test tool: `endpoint` is the suite's configured TEST-ONLY token endpoint (test IdP or harness control server), never request input
  const text = await res.text();
  if (res.status !== 200)
    throw new Error(`token endpoint answered ${res.status}: ${text.slice(0, 200)}`);
  const body = JSON.parse(text) as { access_token?: unknown };
  if (typeof body.access_token !== 'string')
    throw new Error('token endpoint returned no access_token');
  return body.access_token;
}

export async function postControl(endpoint: string, body: unknown = {}): Promise<unknown> {
  const init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  };
  const res = await fetch(endpoint, init); // nosemgrep: nodejs_scan.javascript-ssrf-rule-node_ssrf -- test tool: `endpoint` is a control URL of the TEST-ONLY issuer the suite itself started or was configured with, never request input
  const text = await res.text();
  if (res.status < 200 || res.status > 299) {
    throw new Error(`${endpoint} answered ${res.status}: ${text.slice(0, 200)}`);
  }
  return text ? (JSON.parse(text) as unknown) : undefined;
}

/** Unique principal names per run and suite, so per-principal rate limits never collide. */
export const principal = (runId: string, suite: string, name: string): string =>
  `sectest-${runId}-${suite}-${name}`;
