/**
 * Runs one allowlisted call through the executor: classification, at most one extra tool-level
 * retry (throttling only — the CLI itself already retried in standard mode), raw persistence and
 * conversion into a sanitized evidence record. Strictly sequential: callers await every call.
 */
import { classify, statusOf, type Classified } from './errors.ts';
import { maskedCommand, type ProbeRecord } from './evidence.ts';
import type { CallRequest, Executor, ProcessResult } from './executor.ts';
import type { ProbeDef } from './policy.ts';
import type { RawStore } from './rawstore.ts';
import type { Sanitizer } from './sanitize.ts';
import type { Json } from './types.ts';

export interface RunContext {
  readonly executor: Executor;
  readonly raw: RawStore;
  readonly profile: string;
  readonly sleep: (ms: number) => Promise<void>;
  readonly throttleBackoffMs: number;
  readonly signal?: AbortSignal | undefined;
}

export interface CallOutcome {
  readonly callId: string;
  readonly def: ProbeDef;
  readonly request: CallRequest;
  readonly classified: Classified;
  readonly attempts: number;
  readonly argv: readonly string[];
}

const rawBody = (stdout: string): unknown => {
  try {
    return stdout.trim() === '' ? null : (JSON.parse(stdout) as unknown);
  } catch {
    return stdout;
  }
};

function rawRecord(callId: string, attempt: number, argv: readonly string[], r: ProcessResult) {
  return {
    callId,
    attempt,
    argv,
    exitCode: r.exitCode,
    signal: r.signal,
    timedOut: r.timedOut,
    aborted: r.aborted,
    durationMs: r.durationMs,
    stdout: rawBody(r.stdout),
    stderr: r.stderr,
  };
}

/**
 * Executes `request`. With `persistRaw: false` nothing is written (used for the very first
 * identity call, whose response may belong to a wrong account); the caller may persist it later
 * through `persist()`.
 */
export async function runCall(
  ctx: RunContext,
  callId: string,
  request: CallRequest,
  options: { persistRaw: boolean } = { persistRaw: true },
): Promise<CallOutcome & { persist: () => void }> {
  let attempts = 0;
  const rawFiles: (() => void)[] = [];
  for (;;) {
    attempts += 1;
    const attempt = attempts;
    const { def, argv, result } = await ctx.executor.call(request);
    const classified = classify(result);
    const write = () => void ctx.raw.write(callId, rawRecord(callId, attempt, argv, result));
    if (options.persistRaw) write();
    else rawFiles.push(write);
    if (classified.kind === 'throttled' && attempts === 1 && !ctx.signal?.aborted) {
      await ctx.sleep(ctx.throttleBackoffMs);
      continue;
    }
    return {
      callId,
      def,
      request,
      classified,
      attempts,
      argv,
      persist: () => rawFiles.splice(0).forEach((w) => w()),
    };
  }
}

/** Evidence record of a finished call; `data` is the probe's projection of the response. */
export function recordOf(outcome: CallOutcome, s: Sanitizer): ProbeRecord {
  const { def, classified } = outcome;
  const base = {
    id: outcome.callId,
    probe: def.id,
    area: def.area,
    phase: def.phase,
    region: outcome.request.region,
    iamAction: def.iamAction,
    command: maskedCommand(def, outcome.request.values, outcome.request.region, s),
    status: statusOf(classified),
    truncated: classified.kind === 'ok' ? classified.truncated : false,
    attempts: outcome.attempts,
  };
  if (classified.kind !== 'ok') {
    return { ...base, errorCode: s.text(classified.code, { domains: false }) };
  }
  let data: Json | undefined;
  try {
    data = def.project(classified.data, s);
  } catch {
    data = undefined;
  }
  return data === undefined
    ? { ...base, status: 'error', errorCode: 'UnexpectedResponseShape' }
    : { ...base, data };
}

/** Record for a call that was not made. */
export function skippedRecord(
  def: ProbeDef,
  callId: string,
  region: ProbeRecord['region'],
  command: string,
  reason: string,
): ProbeRecord {
  return {
    id: callId,
    probe: def.id,
    area: def.area,
    phase: def.phase,
    region,
    iamAction: def.iamAction,
    command,
    status: 'skipped',
    truncated: false,
    attempts: 0,
    skipReason: reason,
  };
}
