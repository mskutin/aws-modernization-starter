/**
 * Waits (bounded) for the API under test to report ready — and for the TEST-ONLY IdP that issues
 * the suite's tokens — before any test runs, so suites never race a still-starting stack. A
 * never-ready API or IdP FAILS the run; it is not a reason to skip.
 */
import { testIdpUrl } from './auth.js';
import { config } from './env.js';
import { pollUntil } from './poll.js';

export default async function setup(): Promise<void> {
  const url = new URL('/health/ready', config.apiBaseUrl);
  console.log(`[integration] API under test: ${config.apiBaseUrl}`);
  await pollUntil(
    `${url.href} to return 200`,
    async () => {
      const r = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      await r.arrayBuffer();
      return r.status === 200 ? true : undefined;
    },
    { deadlineMs: config.readyDeadlineMs, initialDelayMs: 200, maxDelayMs: 2_000 },
  );
  const discovery = new URL('/.well-known/openid-configuration', testIdpUrl);
  console.log(`[integration] token issuer (TEST ONLY IdP): ${testIdpUrl}`);
  await pollUntil(
    `${discovery.href} to return 200`,
    async () => {
      const r = await fetch(discovery, { signal: AbortSignal.timeout(5_000) });
      await r.arrayBuffer();
      return r.status === 200 ? true : undefined;
    },
    { deadlineMs: config.readyDeadlineMs, initialDelayMs: 200, maxDelayMs: 2_000 },
  );
}
