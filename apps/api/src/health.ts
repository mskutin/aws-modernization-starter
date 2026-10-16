import type { HealthResponse } from '@starter/contracts';

export interface HealthCheck {
  name: string;
  check(): Promise<void>;
}

export interface Lifecycle {
  isDraining(): boolean;
  beginDrain(): void;
}

export function createLifecycle(): Lifecycle {
  let draining = false;
  return {
    isDraining: () => draining,
    beginDrain: () => {
      draining = true;
    },
  };
}

async function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`health check timed out after ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function readiness(
  checks: readonly HealthCheck[],
  lifecycle: Lifecycle,
  timeoutMs: number,
): Promise<{ ok: boolean; body: HealthResponse; failures: { name: string; error: unknown }[] }> {
  if (lifecycle.isDraining()) {
    return { ok: false, body: { status: 'unavailable', draining: true }, failures: [] };
  }
  const failures: { name: string; error: unknown }[] = [];
  const results = await Promise.all(
    checks.map(async (c) => {
      try {
        await withTimeout(c.check(), timeoutMs);
        return [c.name, 'ok'] as const;
      } catch (error) {
        failures.push({ name: c.name, error });
        return [c.name, 'fail'] as const;
      }
    }),
  );
  const ok = failures.length === 0;
  return {
    ok,
    body: {
      status: ok ? 'ok' : 'unavailable',
      draining: false,
      checks: Object.fromEntries(results),
    },
    failures,
  };
}
