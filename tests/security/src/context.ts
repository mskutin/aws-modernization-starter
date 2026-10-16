/**
 * What the global setup hands to the security suites (vitest `provide`/`inject`).
 *
 * Two modes (SECTEST_MODE):
 *  - `self`     the suite started everything itself (see harness/global-setup.ts): API processes,
 *               an in-process TEST-ONLY issuer, XFF-appending proxies and a fake Step Functions
 *               endpoint, against PostgreSQL and DynamoDB Local.
 *  - `external` a running stack (local compose, a deployed environment): API_BASE_URL and/or
 *               WEB_BASE_URL, tokens from the test IdP's `POST /test/token`.
 */
import { inject } from 'vitest';

export type TargetName = 'direct' | 'proxy';

export interface Target {
  name: TargetName;
  /** Base URL the requests go to (no trailing slash). */
  baseUrl: string;
  /** Human-readable description for test names and reports. */
  description: string;
}

export interface DynamoStore {
  /**
   * DynamoDB Local (self mode, compose). Absent = the real DynamoDB of a deployed environment,
   * read with the default credential chain (external mode, SECTEST_DYNAMODB_AWS=true).
   */
  endpoint?: string | undefined;
  region: string;
  tableName: string;
}

export interface PostgresStore {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export interface SecTestContext {
  mode: 'self' | 'external';
  /** Unique per run: used in principals, idempotency keys and canaries. */
  runId: string;
  /** Targets every suite runs against (same assertions on each). */
  targets: Target[];
  /** `POST` endpoint with the test IdP contract: `{ sub?, scope?, claims?, options? }` → `{ access_token }`. */
  tokenEndpoint: string;
  /** `POST` endpoint rotating the signing key (test IdP contract), if available. */
  rotateEndpoint: string | undefined;
  issuer: string;
  audience: string;
  /** Origin the API allows for CORS, if any (self mode). */
  allowedOrigin: string | undefined;
  /** Self mode: API pairs with low limits, reserved for the rate-limit suite. */
  rateLimit:
    | {
        targets: Target[];
        unauthenticatedMax: number;
        readMax: number;
        writeMax: number;
        windowSeconds: number;
      }
    | undefined;
  /** Self mode: an API with its own issuer, for JWKS rotation/outage tests. */
  jwks:
    | {
        target: Target;
        tokenEndpoint: string;
        rotateEndpoint: string;
        outageEndpoint: string;
      }
    | undefined;
  /** Self mode: an API whose Step Functions client talks to a capturing fake. */
  stepFunctions: { target: Target; capturesUrl: string } | undefined;
  /**
   * Self mode: an API (WORKFLOW_MODE=stepfunctions) whose fake Step Functions can HOLD
   * StartExecution, so a POST /v1/jobs can be caught after the job row exists and before the
   * response (client-disconnect audit). It also runs with a non-default
   * AUTH_MAX_TOKEN_AGE_SECONDS (`maxTokenAgeSeconds`).
   */
  gated:
    | {
        target: Target;
        /** Base URL of the fake's `/__hold`, `/__held` and `/__release`. */
        controlUrl: string;
        logFile: string;
        maxTokenAgeSeconds: number;
      }
    | undefined;
  /**
   * AUTH_MAX_TOKEN_AGE_SECONDS of the `targets` (self mode: the API default, 3600; external mode:
   * SECTEST_MAX_TOKEN_AGE_SECONDS, default 3600).
   */
  maxTokenAgeSeconds: number;
  /** Stores behind the API, for leakage assertions (absent = those assertions are skipped). */
  stores: { postgres: PostgresStore | undefined; dynamodb: DynamoStore | undefined };
  /** Files with the API processes' logs (self mode), or provided by SECTEST_LOG_FILES. */
  logFiles: string[];
  /** Directory for this run's evidence (canaries, captures): reports/security/<runId>. */
  evidenceDir: string;
  /** Workflow spec version of the code under test (gates the execution-input checks until spec 2.0.0 lands). */
  workflowSpecVersion: string;
  /** SECTEST_REQUIRE_ALL=1: a gated or unconfigured check fails instead of skipping. */
  requireAll: boolean;
  /** Secrets the API holds that must never appear in responses or logs (e.g. DB password). */
  knownSecrets: string[];
}

declare module 'vitest' {
  export interface ProvidedContext {
    sectest: SecTestContext;
  }
}

export const context = (): SecTestContext => inject('sectest');

/** True when `version` (x.y.z) is at least `minimum`. */
export function atLeast(version: string, minimum: string): boolean {
  const parse = (v: string) => v.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const [a, b] = [parse(version), parse(minimum)];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return true;
}
