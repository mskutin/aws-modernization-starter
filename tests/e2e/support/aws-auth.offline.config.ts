import { defineConfig } from '@playwright/test';

/**
 * Offline self-test of the aws-test-issuer routing helper: support/aws-auth.offline.ts.
 * Separate from playwright.config.ts (the E2E suite against a running web tier): no global setup,
 * no WEB_BASE_URL, everything local. Traces, screenshots and videos are OFF: the run handles real
 * (if short-lived and locally trusted) tokens and PKCE verifiers.
 *
 *   pnpm build && pnpm --filter @starter/tests-e2e run test:aws-auth-offline
 */
export default defineConfig({
  testDir: '.',
  testMatch: 'aws-auth.offline.ts',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  outputDir: '../../../reports/e2e-aws-auth-offline',
  reporter: [['list']],
  use: { trace: 'off', screenshot: 'off', video: 'off' },
});
