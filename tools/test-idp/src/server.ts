#!/usr/bin/env node
/**
 * Entry point of the TEST-ONLY identity provider (dist/server.js; bundled into the container as
 * /app/server.mjs). Refuses to start unless APP_RUNTIME is local or ci. Never deployed by CDK.
 */
import { createServer } from 'node:http';
import { TestIdpConfigError, loadTestIdpConfig } from './config.js';
import { createTestIdp } from './idp.js';
import { SigningKeyError } from './signing-key.js';

const log = (level: string, msg: string, extra: Record<string, unknown> = {}) =>
  console.warn(JSON.stringify({ level, service: 'test-idp', msg, ...extra }));

async function main(): Promise<void> {
  const config = loadTestIdpConfig();
  const idp = await createTestIdp(config);
  const server = createServer((req, res) => void idp.handle(req, res));
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;

  const stop = () => {
    log('info', 'stopping');
    server.close(() => process.exit(0));
    server.closeAllConnections();
    setTimeout(() => process.exit(0), 3_000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => resolve());
  });
  log('warn', 'TEST ONLY identity provider started - never use it with real users or data', {
    issuer: config.issuer,
    listen: `${config.host}:${config.port}`,
    clientId: config.clientId,
    audience: config.audience,
    redirectUris: config.redirectUris,
    testEndpoints: config.enableTestEndpoints,
    // Public facts only: never the key, never the key file contents.
    signingKey: { source: idp.keySource, alg: idp.issuer.algorithm, kid: idp.issuer.activeKid },
  });
}

main().catch((error: unknown) => {
  const message =
    error instanceof TestIdpConfigError || error instanceof SigningKeyError
      ? error.message
      : String(error);
  console.error(JSON.stringify({ level: 'fatal', service: 'test-idp', msg: message }));
  process.exit(1);
});
