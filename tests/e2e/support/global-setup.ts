/**
 * Waits (bounded) until the web tier serves the SPA (and its /config.json), its /health/ready
 * route reaches a ready API, and the identity provider named by /config.json answers discovery,
 * so specs never race a starting stack. Never-ready FAILS the run.
 */
import { type FullConfig } from '@playwright/test';

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL ?? 'http://127.0.0.1:4173';
  const deadline = Date.now() + Number(process.env.E2E_READY_DEADLINE_MS ?? 60_000);
  let last: string;
  let delay = 200;
  for (;;) {
    try {
      const [shell, ready, config] = await Promise.all([
        fetch(new URL('/', baseURL), { signal: AbortSignal.timeout(5_000) }),
        fetch(new URL('/health/ready', baseURL), { signal: AbortSignal.timeout(5_000) }),
        fetch(new URL('/config.json', baseURL), { signal: AbortSignal.timeout(5_000) }),
      ]);
      const html = await shell.text();
      await ready.arrayBuffer();
      const issuer = config.ok
        ? ((await config.json()) as { auth?: { issuer?: string } }).auth?.issuer
        : undefined;
      const idp = issuer
        ? await fetch(`${issuer}/.well-known/openid-configuration`, {
            signal: AbortSignal.timeout(5_000),
          })
        : undefined;
      await idp?.arrayBuffer();
      if (shell.ok && html.includes('<div id="root"') && ready.status === 200 && idp?.ok) return;
      last = `shell ${shell.status}, ready ${ready.status}, config ${config.status}, idp ${idp?.status ?? 'n/a'}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    if (Date.now() > deadline) {
      throw new Error(`web tier at ${baseURL} not ready before deadline (${last})`);
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 2_000);
  }
}
