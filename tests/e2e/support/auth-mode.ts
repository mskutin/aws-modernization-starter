/**
 * How the browser signs in (live-contract.md §5):
 *
 *   E2E_AUTH_MODE unset             the SPA's issuer is the local TEST ONLY IdP itself (compose, CI)
 *   E2E_AUTH_MODE=aws-test-issuer   the SPA on CloudFront uses the sandbox test issuer
 *                                   (E2E_ISSUER, https: discovery + JWKS on CloudFront/S3); its
 *                                   `/authorize`, `/token` and `/logout` are routed by Playwright to
 *                                   the local IdP (E2E_IDP_URL) that holds the private key. The
 *                                   SPA's real discovery, PKCE and CSP stay in force.
 *
 * The routing is `support/aws-auth.ts`. Every browser context a spec uses must
 * be prepared: the `context` fixture (support/fixtures.ts) and `newAuthContext(browser)` for extra
 * users (e.g. the alice/bob isolation spec).
 */
import type { Browser, BrowserContext } from '@playwright/test';
import {
  AWS_TEST_ISSUER_MODE,
  type AwsTestIssuerOptions,
  awsTestIssuerOptionsFromEnv,
  installAwsTestIssuerRoutes,
} from './aws-auth.js';

/** The sign-in mode of a browser context (explicit, or from the environment). */
export type E2eAuthMode = { kind: 'local' } | ({ kind: 'aws-test-issuer' } & AwsTestIssuerOptions);

/** E2E_AUTH_MODE / E2E_ISSUER / E2E_IDP_URL, validated by support/aws-auth.ts. */
export function authModeFromEnv(
  env: Record<string, string | undefined> = process.env,
): E2eAuthMode {
  const options = awsTestIssuerOptionsFromEnv(env);
  return options ? { kind: AWS_TEST_ISSUER_MODE, ...options } : { kind: 'local' };
}

/** True in AWS mode: the browser carries live tokens of the sandbox (no traces, no screenshots). */
export function isAwsAuthMode(env: Record<string, string | undefined> = process.env): boolean {
  return env['E2E_AUTH_MODE'] === AWS_TEST_ISSUER_MODE;
}

/** Prepares a browser context for the configured auth mode (no-op locally). */
export async function prepareContext(
  context: BrowserContext,
  mode: E2eAuthMode = authModeFromEnv(),
): Promise<void> {
  if (mode.kind === 'local') return;
  await installAwsTestIssuerRoutes(context, { issuer: mode.issuer, idpUrl: mode.idpUrl });
}

/** A new context prepared like the default one (specs with several signed-in users). */
export async function newAuthContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext();
  try {
    await prepareContext(context);
  } catch (err) {
    await context.close();
    throw err;
  }
  return context;
}
