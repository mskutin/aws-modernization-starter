/**
 * Deterministic polling: re-evaluate `probe` with bounded exponential backoff until it yields a
 * value or the deadline passes. Never a fixed sleep — the wait ends as soon as the condition holds.
 */
export async function pollUntil<T>(
  what: string,
  probe: () => Promise<T | undefined>,
  opts: { deadlineMs: number; initialDelayMs?: number; maxDelayMs?: number },
): Promise<T> {
  const deadline = Date.now() + opts.deadlineMs;
  let delay = opts.initialDelayMs ?? 50;
  let last: unknown;
  for (;;) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch (err) {
      last = err;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const tail = last instanceof Error ? ` (last error: ${last.message})` : '';
      throw new Error(`timed out after ${opts.deadlineMs}ms waiting for ${what}${tail}`, {
        cause: last,
      });
    }
    await new Promise((r) => setTimeout(r, Math.min(delay, remaining)));
    delay = Math.min(delay * 2, opts.maxDelayMs ?? 1_000);
  }
}
