/**
 * Shared helpers of the sandbox tests: temporary directories OUTSIDE any repository (the key-file
 * rules refuse repository paths), and the TEST-ONLY IdP on an ephemeral loopback port.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTestIdpConfig, type TestIdpConfig } from '../src/config.js';
import { createTestIdp, type TestIdp } from '../src/idp.js';

export interface Cleanup {
  add(fn: () => void | Promise<void>): void;
  run(): Promise<void>;
}

export function cleanup(): Cleanup {
  const fns: (() => void | Promise<void>)[] = [];
  return {
    add: (fn) => void fns.push(fn),
    async run() {
      for (const fn of fns.splice(0).reverse()) await fn();
    },
  };
}

/** A fresh 0700 directory under the OS temp dir, removed by `cleanup.run()`. */
export function tempDir(c: Cleanup, prefix = 'starter-sbx-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  c.add(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export interface RunningIdp {
  /** Where the IdP listens (http://127.0.0.1:<port>), NOT its issuer identifier. */
  base: string;
  config: TestIdpConfig;
  idp: TestIdp;
}

export async function startIdp(c: Cleanup, env: Record<string, string>): Promise<RunningIdp> {
  const config = loadTestIdpConfig({ APP_RUNTIME: 'local', ...env });
  const idp = await createTestIdp(config);
  const server: Server = createServer((req, res) => void idp.handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  c.add(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, config, idp };
}

/** Hosts `startIdp` binds to: these tests mint only from an IdP on this machine, never remotely. */
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** `POST /test/token` of a running IdP → the access token. Refuses a non-loopback or non-http base. */
export async function mintViaIdp(base: string, body: Record<string, unknown>): Promise<string> {
  const endpoint = new URL('/test/token', base);
  if (endpoint.protocol === 'http:' && LOOPBACK_HOSTS.has(endpoint.hostname)) {
    const response = await fetch(endpoint, {
      redirect: 'error', // the loopback check above must hold for the whole request
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (response.status !== 200) throw new Error(`/test/token answered ${response.status}`);
    return ((await response.json()) as { access_token: string }).access_token;
  }
  throw new Error(`mintViaIdp calls only a loopback http IdP, not ${endpoint.origin}`);
}
