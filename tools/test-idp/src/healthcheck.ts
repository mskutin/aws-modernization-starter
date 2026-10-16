/**
 * Container HEALTHCHECK for the shell-less test IdP image:
 *   ["/nodejs/bin/node", "/app/healthcheck.mjs"] — exits 0 when /healthz answers 200 within 2 s.
 */
const port = Number(process.env.TEST_IDP_PORT ?? 9400);
try {
  const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
    signal: AbortSignal.timeout(2_000),
  });
  process.exit(response.status === 200 ? 0 : 1);
} catch {
  process.exit(1);
}
