#!/usr/bin/env node
/**
 * Entry point of `sandbox-issuer` (dist/sandbox-issuer.js): key generation and the static
 * discovery/JWKS export for the AWS sandbox test issuer. See sandbox-cli.ts and the README.
 * Operator host only; it never contacts AWS.
 */
import { runSandboxIssuerCli } from './sandbox-cli.js';

process.exitCode = await runSandboxIssuerCli(process.argv.slice(2), {
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
});
