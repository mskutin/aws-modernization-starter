/**
 * Container HEALTHCHECK for shell-less (distroless) images:
 *   HEALTHCHECK CMD ["/nodejs/bin/node", "dist/healthcheck.js"]
 * Exits 0 when GET /health/live returns 200 within 2 s, otherwise 1.
 */
const port = Number(process.env.PORT ?? 8080);

try {
  const response = await fetch(`http://127.0.0.1:${port}/health/live`, {
    signal: AbortSignal.timeout(2_000),
  });
  process.exit(response.status === 200 ? 0 : 1);
} catch {
  process.exit(1);
}
