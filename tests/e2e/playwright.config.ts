import { defineConfig, devices } from '@playwright/test';
import { isAwsAuthMode } from './support/auth-mode.js';

const isCI = !!process.env.CI;
/**
 * AWS mode (E2E_AUTH_MODE=aws-test-issuer, an AWS sandbox): traces, screenshots and videos are
 * OFF — they would record live bearer tokens, the token response and the PKCE verifier.
 * Failures are diagnosed from the assertion messages and the JSON/JUnit reports.
 */
const awsMode = isAwsAuthMode();

/**
 * E2E against a RUNNING web tier (WEB_BASE_URL): locally the compose `web` service (nginx serving
 * apps/web/dist and proxying /v1 + /health to the API, like CloudFront), or the Vite dev server.
 *
 * Flake policy: no silent retries. CI retries once ONLY to capture a trace of the second attempt,
 * and failOnFlakyTests makes a pass-on-retry still fail the job (it is reported as "flaky").
 */
export default defineConfig({
  testDir: './specs',
  globalSetup: './support/global-setup.ts',
  timeout: 60_000,
  // Generous assertion timeout: web-first assertions poll until the job reaches its terminal state.
  expect: { timeout: 30_000 },
  fullyParallel: true,
  workers: isCI ? 2 : undefined,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  failOnFlakyTests: isCI,
  outputDir: '../../reports/e2e-artifacts',
  reporter: [
    [isCI ? 'line' : 'list'],
    ['junit', { outputFile: '../../reports/junit/e2e.xml' }],
    ['html', { outputFolder: '../../reports/e2e-html', open: 'never' }],
  ],
  use: {
    baseURL: process.env.WEB_BASE_URL ?? 'http://127.0.0.1:4173',
    trace: awsMode ? 'off' : 'retain-on-failure',
    screenshot: awsMode ? 'off' : 'only-on-failure',
    video: 'off',
    locale: 'en-GB',
    timezoneId: 'UTC',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
