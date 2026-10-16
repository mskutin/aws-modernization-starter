/**
 * Deployed configuration of the BUILT API: CDK never sets
 * APP_RUNTIME, so a deployed task runs with the strict default (aws). There the API must refuse to
 * start without a client allow-list (AUTH_ALLOWED_CLIENT_IDS): an empty list accepts the tokens of
 * every OAuth client of the issuer. Synth-time counterpart: BASE-ECS-008 (policies).
 *
 * Each case starts `apps/api/dist/server.js` with an environment that is complete and valid for
 * APP_RUNTIME=aws except for the setting under test, and asserts the EXACT list of variables the
 * refusal names — so the refusal is about that setting and the rest of the environment is valid:
 *  - no AUTH_ALLOWED_CLIENT_IDS                → refused, naming only AUTH_ALLOWED_CLIENT_IDS;
 *  - control: the list set, but containing the API audience → refused, naming only AUTH_AUDIENCE
 *    (ID-token confusion): the allow-list check passed and the same validation still ran.
 * The process must exit before it logs "starting API" (nothing opened, nothing listened).
 *
 * Nothing here can reach AWS: AWS_ENDPOINT_URL and the issuer point at 127.0.0.1:9 (closed),
 * credentials are static dummies and IMDS is disabled. Self mode only (needs the local build).
 */
import { describe, expect, it } from 'vitest';
import { context } from '../context.js';
import { runApiToExit } from '../harness/api-process.js';
import { mutated } from '../harness/mutations.js';
import { findLeaks } from '../leaks.js';
import { precondition } from '../support.js';

const ctx = context();
const selfNote = ctx.mode === 'self' ? '' : ' [skipped: self-started harness only]';
const AUDIENCE = 'starter-jobs-api';

/** Complete for APP_RUNTIME=aws (unset = aws), apart from the client allow-list. */
const DEPLOYED_LIKE: Record<string, string> = {
  NODE_ENV: 'production',
  LOG_LEVEL: 'info',
  DB_HOST: '127.0.0.1',
  DB_PORT: '9',
  DB_NAME: 'starter_app',
  DB_USER: 'starter_app',
  DB_AUTH: 'iam',
  DB_SSL: 'verify-full',
  DB_SSL_ROOT_CERT: '/nonexistent/sectest-rds-ca.pem',
  JOBS_TABLE_NAME: 'starter-sectest-not-a-table',
  AWS_REGION: 'ap-southeast-1',
  WORKFLOW_MODE: 'stepfunctions',
  STATE_MACHINE_ARN: 'arn:aws:states:ap-southeast-1:000000000000:stateMachine:sectest-none',
  AUTH_ISSUER: 'https://127.0.0.1:9/realms/sectest',
  AUTH_AUDIENCE: AUDIENCE,
  // Belt and braces: nothing may reach AWS even if a refusal regressed.
  AWS_ENDPOINT_URL: 'http://127.0.0.1:9',
  AWS_EC2_METADATA_DISABLED: 'true',
  AWS_ACCESS_KEY_ID: 'local',
  AWS_SECRET_ACCESS_KEY: 'local',
};

/** Variables named by the API's fatal configuration error (`  - NAME: message` lines). */
function refusedVariables(output: string): string[] {
  for (const line of output.split('\n')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const { level, msg } = parsed as { level?: unknown; msg?: unknown };
    if (level !== 'fatal' || typeof msg !== 'string') continue;
    return [...msg.matchAll(/^\s+- ([A-Z0-9_]+):/gm)].map((m) => m[1] ?? '');
  }
  return [];
}

describe('API start-up refuses an unsafe deployed configuration (APP_RUNTIME=aws)', () => {
  const cases: [string, Record<string, string>, string[]][] = [
    [
      'without AUTH_ALLOWED_CLIENT_IDS → refused for AUTH_ALLOWED_CLIENT_IDS',
      {},
      ['AUTH_ALLOWED_CLIENT_IDS'],
    ],
    [
      'control: the allow-list naming the API audience → refused for AUTH_AUDIENCE only',
      { AUTH_ALLOWED_CLIENT_IDS: `starter-web-local,${AUDIENCE}` },
      ['AUTH_AUDIENCE'],
    ],
  ];
  it.for(cases)(`%s${selfNote}`, async ([, delta, refused], t) => {
    precondition(t, ctx, ctx.mode === 'self', 'starts the local API build (self mode only)');
    const run = await runApiToExit({
      ...DEPLOYED_LIKE,
      ...delta,
      // Mutation run only: the local relaxations a deployment must never get.
      ...(mutated('relaxed-runtime') ? { APP_RUNTIME: 'ci' } : {}),
    });
    expect(run.code, `the API kept running:\n${run.output.slice(0, 600)}`).toBe(1);
    expect(refusedVariables(run.output)).toEqual(refused);
    expect(run.output, 'refused before start-up').not.toContain('starting API');
    expect(findLeaks(run.output, { patterns: true })).toEqual([]);
  });
});
