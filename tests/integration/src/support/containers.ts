/**
 * Minimal Docker-Engine-compatible API client over the DOCKER_HOST unix socket (rootless Podman
 * locally). Used only by LOCAL outage tests; CI jobs have no container socket.
 */
import { request as httpRequest } from 'node:http';

export function containerControl(): { socketPath: string } | { skip: string } {
  if (process.env.LOCAL_CONTAINER_CONTROL !== 'true') {
    return {
      skip: 'LOCAL_CONTAINER_CONTROL is not "true" — outage tests need to stop/start local containers (never in CI)',
    };
  }
  const host = process.env.DOCKER_HOST ?? '';
  if (!host.startsWith('unix://')) {
    return { skip: `DOCKER_HOST must be a unix socket (got "${host}")` };
  }
  return { socketPath: host.slice('unix://'.length) };
}

function call(
  socketPath: string,
  method: string,
  path: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath, method, path, timeout: 60_000 }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('timeout', () => req.destroy(new Error(`${method} ${path} timed out`)));
    req.on('error', reject);
    req.end();
  });
}

/** 204 = done, 304 = already in that state. */
async function lifecycle(socketPath: string, name: string, action: 'stop' | 'start') {
  const qs = action === 'stop' ? '?t=10' : '';
  const r = await call(
    socketPath,
    'POST',
    `/containers/${encodeURIComponent(name)}/${action}${qs}`,
  );
  if (r.status !== 204 && r.status !== 304) {
    throw new Error(`${action} ${name}: HTTP ${r.status} ${r.body}`);
  }
}

export const stopContainer = (socketPath: string, name: string) =>
  lifecycle(socketPath, name, 'stop');
export const startContainer = (socketPath: string, name: string) =>
  lifecycle(socketPath, name, 'start');

export async function isRunning(socketPath: string, name: string): Promise<boolean> {
  const r = await call(socketPath, 'GET', `/containers/${encodeURIComponent(name)}/json`);
  if (r.status !== 200) throw new Error(`inspect ${name}: HTTP ${r.status} ${r.body}`);
  return (JSON.parse(r.body) as { State?: { Running?: boolean } }).State?.Running === true;
}
