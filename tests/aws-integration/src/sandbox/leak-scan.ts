/**
 * Leak scan of the run's CloudWatch Logs and Step Functions execution histories (test.sh), over
 * files the script downloaded with the AWS CLI (read-only calls; this module makes none):
 *
 *   logs/index.jsonl          {"file":"<name>.json","group":"<log group>"} per downloaded group
 *   logs/<name>.json          `aws logs filter-log-events --output json` ({ events: [{ message }] })
 *   history/<exec>.json       `aws stepfunctions get-execution-history --include-execution-data`
 *
 * Positive controls first — a zero-hit scan proves nothing unless the scan demonstrably covers the
 * run and the scanner finds a canary where it legitimately is:
 *   - the owner's GET of the canary job shows the title canary (and no content canary);
 *   - every `--expect-log <group-substring>=<jobId>` group has an event naming that job;
 *   - every `--expect-history <exec>` history exists, is non-empty and names its job.
 * Then absence: no canary (title, sentence, token; ours and the security suite's), no JWT, no
 * origin-verify value and no private-key parameter in any log event or history event.
 * `--failure-execution <exec>`: the business-invalid job took the Lambda failure path
 * (JobValidationError caught, RecordFailure entered). Findings are counts and labels only.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface NamedValue {
  label: string;
  value: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Canaries from our CanaryRun file or the security suite's `canaries.json`. */
export function loadCanaries(json: unknown, prefix: string): NamedValue[] {
  if (!isRecord(json)) return [];
  if (isRecord(json.canaries)) {
    return Object.entries(json.canaries)
      .filter((e): e is [string, string] => typeof e[1] === 'string' && e[1].length >= 8)
      .map(([label, value]) => ({ label: `${prefix}:${label}`, value }));
  }
  if (Array.isArray(json.canaries)) {
    return (json.canaries as unknown[])
      .filter(
        (c): c is { label: string; value: string } =>
          isRecord(c) &&
          typeof c.label === 'string' &&
          typeof c.value === 'string' &&
          c.value.length >= 8,
      )
      .map((c) => ({ label: `${prefix}:${c.label}`, value: c.value }));
  }
  return [];
}

export const JWT_PATTERN = /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}/g;

export interface SourceScan {
  kind: 'log' | 'history';
  name: string;
  events: number;
  canaryHits: Record<string, number>;
  secretHits: Record<string, number>;
  jwtHits: number;
}

export function scanTexts(
  kind: SourceScan['kind'],
  name: string,
  texts: readonly string[],
  canaries: readonly NamedValue[],
  secrets: readonly NamedValue[],
): SourceScan {
  const canaryHits: Record<string, number> = {};
  const secretHits: Record<string, number> = {};
  let jwtHits = 0;
  for (const text of texts) {
    for (const c of canaries)
      if (text.includes(c.value)) canaryHits[c.label] = (canaryHits[c.label] ?? 0) + 1;
    for (const s of secrets)
      if (text.includes(s.value)) secretHits[s.label] = (secretHits[s.label] ?? 0) + 1;
    jwtHits += text.match(JWT_PATTERN)?.length ?? 0;
  }
  return { kind, name, events: texts.length, canaryHits, secretHits, jwtHits };
}

export const logMessages = (json: unknown): string[] =>
  isRecord(json) && Array.isArray(json.events)
    ? (json.events as unknown[]).filter(isRecord).map((e) => String(e.message ?? ''))
    : [];

/** Every history event as JSON text (input, output, error, cause — whatever the event carries). */
export const historyTexts = (json: unknown): string[] =>
  isRecord(json) && Array.isArray(json.events)
    ? (json.events as unknown[]).map((e) => JSON.stringify(e))
    : [];

export interface FailurePath {
  execution: string;
  found: boolean;
  validationErrorEvents: number;
  recordFailureEntered: boolean;
  lastEventType: string | null;
}

export function failurePathOf(execution: string, history: unknown): FailurePath {
  const events =
    isRecord(history) && Array.isArray(history.events)
      ? (history.events as unknown[]).filter(isRecord)
      : [];
  let validationErrorEvents = 0;
  let recordFailureEntered = false;
  for (const e of events) {
    const type = String(e.type ?? '');
    if (/Failed$/.test(type) && JSON.stringify(e).includes('JobValidationError'))
      validationErrorEvents += 1;
    const entered = isRecord(e.stateEnteredEventDetails)
      ? e.stateEnteredEventDetails.name
      : undefined;
    if (entered === 'RecordFailure') recordFailureEntered = true;
  }
  const last = events.at(-1);
  return {
    execution,
    found: events.length > 0,
    validationErrorEvents,
    recordFailureEntered,
    lastEventType: last ? String(last.type ?? '') : null,
  };
}

export interface Control {
  name: string;
  ok: boolean;
  detail: string;
}

export interface LeakReport {
  sources: SourceScan[];
  controls: Control[];
  failurePaths: FailurePath[];
  findings: string[];
  ok: boolean;
}

export interface LeakScanInput {
  logsDir?: string | undefined;
  historyDir?: string | undefined;
  canaries: NamedValue[];
  secrets: NamedValue[];
  /** [groupSubstring, jobId] */
  expectLogs: [string, string][];
  /** [executionName, jobId] */
  expectHistories: [string, string][];
  failureExecutions: string[];
  /** Owner's view of the canary job (from the CanaryRun). */
  ownerView?: { titleFound: boolean; contentCanariesFound: number } | undefined;
}

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'));

export function leakScan(input: LeakScanInput): LeakReport {
  const sources: SourceScan[] = [];
  const controls: Control[] = [];
  const logTexts = new Map<string, string[]>();
  if (input.logsDir && existsSync(join(input.logsDir, 'index.jsonl'))) {
    for (const line of readFileSync(join(input.logsDir, 'index.jsonl'), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line) as { file: string; group: string };
      const texts = logMessages(readJson(join(input.logsDir, entry.file)));
      logTexts.set(entry.group, [...(logTexts.get(entry.group) ?? []), ...texts]);
    }
  }
  for (const [group, texts] of logTexts)
    sources.push(scanTexts('log', group, texts, input.canaries, input.secrets));

  const histories = new Map<string, unknown>();
  if (input.historyDir && existsSync(input.historyDir)) {
    for (const f of readdirSync(input.historyDir)
      .filter((n) => n.endsWith('.json'))
      .sort()) {
      histories.set(f.replace(/\.json$/, ''), readJson(join(input.historyDir, f)));
    }
  }
  for (const [name, h] of histories)
    sources.push(scanTexts('history', name, historyTexts(h), input.canaries, input.secrets));

  if (input.ownerView) {
    controls.push({
      name: "positive control: the owner's GET shows the title canary and no content canary",
      ok: input.ownerView.titleFound && input.ownerView.contentCanariesFound === 0,
      detail: `title ${input.ownerView.titleFound ? 'found' : 'NOT found'}; content canaries found: ${input.ownerView.contentCanariesFound}`,
    });
  }
  for (const [sub, jobId] of input.expectLogs) {
    const groups = [...logTexts.keys()].filter((g) => g.includes(sub));
    const hits = groups.filter((g) => (logTexts.get(g) ?? []).some((t) => t.includes(jobId)));
    controls.push({
      name: `positive control: logs of *${sub}* cover job ${jobId}`,
      ok: hits.length > 0,
      detail:
        groups.length === 0
          ? 'no such log group downloaded'
          : `${hits.length}/${groups.length} group(s) name the job`,
    });
  }
  for (const [exec, jobId] of input.expectHistories) {
    const h = histories.get(exec);
    const texts = historyTexts(h);
    controls.push({
      name: `positive control: execution history ${exec} was read and names its job`,
      ok: texts.length > 0 && texts.some((t) => t.includes(jobId)),
      detail: h === undefined ? 'history not downloaded' : `${texts.length} event(s)`,
    });
  }
  const failurePaths = input.failureExecutions.map((e) => failurePathOf(e, histories.get(e)));
  for (const fp of failurePaths) {
    controls.push({
      name: `Lambda failure path: ${fp.execution} caught JobValidationError and entered RecordFailure`,
      ok: fp.found && fp.validationErrorEvents > 0 && fp.recordFailureEntered,
      detail: `events: ${fp.found ? 'yes' : 'none'}; JobValidationError failure events: ${fp.validationErrorEvents}; RecordFailure entered: ${fp.recordFailureEntered}; last event: ${fp.lastEventType ?? '-'}`,
    });
  }

  const findings: string[] = [];
  for (const s of sources) {
    for (const [label, n] of Object.entries(s.canaryHits))
      findings.push(`${s.kind} ${s.name}: canary ${label} x${n}`);
    for (const [label, n] of Object.entries(s.secretHits))
      findings.push(`${s.kind} ${s.name}: secret ${label} x${n}`);
    if (s.jwtHits > 0) findings.push(`${s.kind} ${s.name}: JWT-shaped string x${s.jwtHits}`);
  }
  if (sources.length === 0) findings.push('nothing was scanned (no logs or histories downloaded)');
  if (input.canaries.length === 0) findings.push('no canary values loaded');
  const ok = findings.length === 0 && controls.every((c) => c.ok);
  return { sources, controls, failurePaths, findings, ok };
}

/** Private JWK parameters (EC `d`; RSA `d`, `p`, `q`, `dp`, `dq`, `qi`) as secrets to look for. */
export function privateJwkSecrets(jwk: unknown, label: string): NamedValue[] {
  if (!isRecord(jwk)) return [];
  return ['d', 'p', 'q', 'dp', 'dq', 'qi']
    .filter((k) => typeof jwk[k] === 'string' && (jwk[k] as string).length >= 16)
    .map((k) => ({ label: `${label}.${k}`, value: jwk[k] as string }));
}
