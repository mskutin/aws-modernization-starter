#!/usr/bin/env node
/**
 * `sbx-tool` — the TypeScript half of the Phase 2 sandbox lifecycle (tests/aws-integration/sandbox).
 * The shell scripts make every AWS call (AWS CLI, profile/region pinned, mutations through the
 * account guard); this tool only parses their JSON, evaluates results and talks HTTPS to the public
 * endpoints. The one exception is `log-follow`, which runs the read-only `aws logs
 * filter-log-events` with the command line the script hands it (SBX_AWS).
 *
 *   node dist/sandbox/cli.js <command> [options]     (exit 0 ok, 1 check failed, 2 usage/error)
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { executionArnFor, executionNameFor } from '@starter/workflow-processing';
import {
  albSecurityGroupCheck,
  listenerCheck,
  redactRules,
  smokeSteps,
  stepFunctionsSummary,
} from './aws-checks.js';
import { submitCanaries } from './canary.js';
import { evaluateProbe, probeLines, probeOverrides } from './db-probe.js';
import {
  albDirectCheck,
  clockSkewCheck,
  healthCheck,
  issuerCheck,
  spaCheck,
  type CheckOutcome,
} from './http-checks.js';
import { leakScan, loadCanaries, privateJwkSecrets, type NamedValue } from './leak-scan.js';
import { follow } from './log-follow.js';
import {
  findOutput,
  getPath,
  mergeOutputs,
  outputsFromDescribeStacks,
  scalarText,
  type StackOutputs,
} from './outputs.js';
import {
  appendRecords,
  fromPlaywrightJson,
  fromVitestJson,
  isResultStatus,
  makeRecord,
  readRecords,
  summarize,
  type ResultRecord,
} from './results.js';
import {
  cloneTaskDefinition,
  deriveUnhealthyImage,
  initialRolloutState,
  observeRollout,
  serviceEventsSince,
  type RolloutState,
} from './rollback.js';
import { experimentStacks, otherRuns } from './stacks.js';
import { unverifiableLines } from './verify-report.js';

class UsageError extends Error {
  override name = 'UsageError';
}

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'));
const writeJson = (file: string, value: unknown) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};
const need = (v: string | undefined, name: string): string => {
  if (v === undefined || v === '') throw new UsageError(`missing --${name}`);
  return v;
};

/** Records check outcomes (when --results is given) and returns the exit code. */
function report(
  outcomes: readonly CheckOutcome[],
  opts: { results?: string | undefined; check: string; evidence: string },
): number {
  for (const o of outcomes) console.log(`${o.ok ? 'ok  ' : 'FAIL'} ${o.name} — ${o.detail}`);
  if (opts.results) {
    appendRecords(
      opts.results,
      outcomes.map((o) =>
        makeRecord({
          check: opts.check,
          name: o.name,
          status: o.ok ? 'passed' : 'failed',
          evidence: opts.evidence,
          detail: o.detail,
        }),
      ),
    );
  }
  return outcomes.length > 0 && outcomes.every((o) => o.ok) ? 0 : 1;
}

/** Retries an HTTP check until every outcome is ok or the deadline passes (CloudFront propagation). */
async function untilOk(
  deadlineMs: number,
  intervalMs: number,
  fn: () => Promise<CheckOutcome[]>,
): Promise<CheckOutcome[]> {
  const until = Date.now() + deadlineMs;
  for (;;) {
    let last: CheckOutcome[];
    try {
      last = await fn();
    } catch (err) {
      last = [
        {
          name: 'request',
          ok: false,
          detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        },
      ];
    }
    if (last.every((o) => o.ok) || Date.now() >= until) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

const common = {
  results: { type: 'string' },
  check: { type: 'string' },
  evidence: { type: 'string' },
  'deadline-ms': { type: 'string' },
} as const;

type Handler = (args: string[]) => Promise<number>;

const commands: Record<string, Handler> = {
  async 'json-get'(args) {
    const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
    const [file, path] = positionals;
    const value = scalarText(getPath(readJson(need(file, 'file')), need(path, 'path')));
    if (value === undefined) return 1;
    console.log(value);
    return 0;
  },

  async unverifiable(args) {
    // The finops verify-clean report (exit 5, clean-with-unverifiable): every category the role
    // could not list, with the fallback evidence it was settled by. Exit 1 when there is none.
    const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
    const lines = unverifiableLines(readJson(need(positionals[0], 'report')));
    for (const line of lines) console.log(line);
    return lines.length > 0 ? 0 : 1;
  },

  async 'outputs-from-stacks'(args) {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: { out: { type: 'string' }, merge: { type: 'string' } },
    });
    // --merge <outputs.json>: keep the other stacks' outputs (refresh after one deploy).
    let base: StackOutputs = {};
    if (values.merge) {
      try {
        base = readJson(values.merge) as StackOutputs;
      } catch {
        base = {};
      }
    }
    const merged: StackOutputs = mergeOutputs(
      base,
      ...positionals.map((f) => outputsFromDescribeStacks(readJson(f))),
    );
    writeJson(need(values.out, 'out'), merged);
    return 0;
  },

  async output(args) {
    const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
    const [file, stack, key] = positionals;
    console.log(
      findOutput(
        readJson(need(file, 'file')) as StackOutputs,
        need(stack, 'stack'),
        need(key, 'key'),
      ),
    );
    return 0;
  },

  async 's3-delete-payload'(args) {
    // `s3api list-object-versions --output json` → a `delete-objects --delete file://…` document
    // (versions and delete markers, at most 1000 per call); prints the number of objects.
    const { values } = parseArgs({
      args,
      options: { in: { type: 'string' }, out: { type: 'string' } },
    });
    const listed = readJson(need(values.in, 'in')) as {
      Versions?: unknown[];
      DeleteMarkers?: unknown[];
    };
    const objects = [...(listed.Versions ?? []), ...(listed.DeleteMarkers ?? [])]
      .filter(
        (o): o is { Key: string; VersionId?: string } =>
          typeof o === 'object' && o !== null && typeof (o as { Key?: unknown }).Key === 'string',
      )
      .slice(0, 1000)
      .map((o) => (o.VersionId ? { Key: o.Key, VersionId: o.VersionId } : { Key: o.Key }));
    writeJson(need(values.out, 'out'), { Objects: objects, Quiet: true });
    console.log(objects.length);
    return 0;
  },

  async 'experiment-stacks'(args) {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: { 'run-id': { type: 'string' } },
    });
    for (const s of experimentStacks(
      readJson(need(positionals[0], 'describe-stacks json')),
      values['run-id'],
    )) {
      console.log(`${s.stackName}\t${s.status}\t${s.runId ?? '-'}\t${s.terminationProtection}`);
    }
    return 0;
  },

  async 'other-runs'(args) {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: { 'run-id': { type: 'string' } },
    });
    for (const r of otherRuns(
      readJson(need(positionals[0], 'describe-stacks json')),
      need(values['run-id'], 'run-id'),
    ))
      console.log(r);
    return 0;
  },

  async 'execution-arn'(args) {
    const { values } = parseArgs({
      args,
      options: { 'state-machine': { type: 'string' }, 'job-id': { type: 'string' } },
    });
    const sm = need(values['state-machine'], 'state-machine');
    console.log(executionArnFor(sm, executionNameFor(need(values['job-id'], 'job-id'))));
    return 0;
  },

  async 'results-add'(args) {
    const { values } = parseArgs({
      args,
      options: {
        ...common,
        name: { type: 'string' },
        status: { type: 'string' },
        detail: { type: 'string' },
      },
    });
    const status = need(values.status, 'status');
    if (!isResultStatus(status)) throw new UsageError(`bad --status ${status}`);
    appendRecords(need(values.results, 'results'), [
      makeRecord({
        check: need(values.check, 'check'),
        name: need(values.name, 'name'),
        status,
        evidence: need(values.evidence, 'evidence'),
        detail: values.detail,
      }),
    ]);
    return 0;
  },

  async 'results-vitest'(args) {
    const { values } = parseArgs({ args, options: { ...common, report: { type: 'string' } } });
    const evidence = need(values.evidence, 'evidence');
    const check = need(values.check, 'check');
    let records: ResultRecord[];
    try {
      records = fromVitestJson(readJson(need(values.report, 'report')), check, evidence);
    } catch (err) {
      records = [
        makeRecord({
          check,
          name: `${check}: report`,
          status: 'error',
          evidence,
          detail: `unreadable report: ${String(err)}`,
        }),
      ];
    }
    appendRecords(need(values.results, 'results'), records);
    return records.some((r) => r.status === 'failed' || r.status === 'error') ? 1 : 0;
  },

  async 'results-playwright'(args) {
    const { values } = parseArgs({ args, options: { ...common, report: { type: 'string' } } });
    const evidence = need(values.evidence, 'evidence');
    const check = need(values.check, 'check');
    let records: ResultRecord[];
    try {
      records = fromPlaywrightJson(readJson(need(values.report, 'report')), check, evidence);
    } catch (err) {
      records = [
        makeRecord({
          check,
          name: `${check}: report`,
          status: 'error',
          evidence,
          detail: `unreadable report: ${String(err)}`,
        }),
      ];
    }
    appendRecords(need(values.results, 'results'), records);
    return records.some((r) => r.status === 'failed' || r.status === 'error') ? 1 : 0;
  },

  async 'results-summary'(args) {
    const { values } = parseArgs({
      args,
      options: { results: { type: 'string' }, out: { type: 'string' } },
    });
    const records = readRecords(need(values.results, 'results'));
    const summary = summarize(records);
    if (values.out) writeJson(values.out, { generatedAt: new Date().toISOString(), ...summary });
    for (const c of summary.checks) {
      const n = c.counts;
      console.log(
        `${c.status.padEnd(8)} ${c.check.padEnd(22)} passed ${n.passed}, failed ${n.failed}, skipped ${n.skipped}, not-run ${n['not-run']}, error ${n.error}`,
      );
    }
    console.log(
      `overall: ${summary.ok ? 'PASSED' : 'NOT PASSED'} (${JSON.stringify(summary.counts)})`,
    );
    return summary.ok ? 0 : 1;
  },

  async 'issuer-check'(args) {
    const { values } = parseArgs({
      args,
      options: {
        ...common,
        issuer: { type: 'string' },
        jwks: { type: 'string' },
        'idp-url': { type: 'string' },
        audience: { type: 'string' },
      },
    });
    const expectedJwks = readJson(need(values.jwks, 'jwks'));
    const outcomes = await untilOk(Number(values['deadline-ms'] ?? 600_000), 10_000, () =>
      issuerCheck({
        issuer: need(values.issuer, 'issuer'),
        expectedJwks,
        idpUrl: values['idp-url'],
        audience: need(values.audience, 'audience'),
      }),
    );
    return report(outcomes, {
      results: values.results,
      check: values.check ?? 'issuer',
      evidence: values.evidence ?? '-',
    });
  },

  async 'spa-check'(args) {
    const { values } = parseArgs({
      args,
      options: {
        ...common,
        'base-url': { type: 'string' },
        issuer: { type: 'string' },
        'client-id': { type: 'string' },
      },
    });
    const outcomes = await untilOk(Number(values['deadline-ms'] ?? 300_000), 10_000, () =>
      spaCheck({
        baseUrl: need(values['base-url'], 'base-url'),
        issuer: need(values.issuer, 'issuer'),
        clientId: need(values['client-id'], 'client-id'),
      }),
    );
    return report(outcomes, {
      results: values.results,
      check: values.check ?? 'spa',
      evidence: values.evidence ?? '-',
    });
  },

  async 'health-check'(args) {
    const { values } = parseArgs({ args, options: { ...common, 'base-url': { type: 'string' } } });
    const outcomes = await untilOk(Number(values['deadline-ms'] ?? 300_000), 5_000, () =>
      healthCheck({ baseUrl: need(values['base-url'], 'base-url') }),
    );
    return report(outcomes, {
      results: values.results,
      check: values.check ?? 'health',
      evidence: values.evidence ?? '-',
    });
  },

  async 'clock-skew'(args) {
    const { values } = parseArgs({
      args,
      options: { ...common, url: { type: 'string' }, 'max-seconds': { type: 'string' } },
    });
    const outcomes = await clockSkewCheck({
      url: need(values.url, 'url'),
      maxSkewSeconds: Number(values['max-seconds'] ?? 30),
    });
    return report(outcomes, {
      results: values.results,
      check: values.check ?? 'clock',
      evidence: values.evidence ?? '-',
    });
  },

  async 'alb-direct-check'(args) {
    const { values } = parseArgs({ args, options: { ...common, alb: { type: 'string' } } });
    const outcomes = await albDirectCheck({ albDnsName: need(values.alb, 'alb') });
    return report(outcomes, {
      results: values.results,
      check: values.check ?? 'origin-protection',
      evidence: values.evidence ?? '-',
    });
  },

  async 'canary-submit'(args) {
    const { values } = parseArgs({
      args,
      options: {
        'base-url': { type: 'string' },
        'idp-url': { type: 'string' },
        'run-id': { type: 'string' },
        out: { type: 'string' },
      },
    });
    const run = await submitCanaries({
      baseUrl: need(values['base-url'], 'base-url'),
      idpUrl: need(values['idp-url'], 'idp-url'),
      runId: need(values['run-id'], 'run-id'),
    });
    writeJson(need(values.out, 'out'), run);
    console.log(
      `canary job ${run.canaryJobId} ${run.canaryStatus}; failure job ${run.failureJobId} ${run.failureStatus} (${run.failureErrorName ?? '-'})`,
    );
    return run.canaryStatus === 'SUCCEEDED' && run.failureStatus === 'FAILED' ? 0 : 1;
  },

  async 'leak-scan'(args) {
    const { values } = parseArgs({
      args,
      options: {
        ...common,
        'canary-run': { type: 'string' },
        canaries: { type: 'string', multiple: true },
        'logs-dir': { type: 'string' },
        'history-dir': { type: 'string' },
        'expect-log': { type: 'string', multiple: true },
        'expect-history': { type: 'string', multiple: true },
        'failure-execution': { type: 'string', multiple: true },
        'secret-file': { type: 'string', multiple: true },
        'jwk-file': { type: 'string', multiple: true },
        out: { type: 'string' },
      },
    });
    const pair = (s: string): [string, string] => {
      const i = s.lastIndexOf('=');
      if (i <= 0) throw new UsageError(`expected <a>=<b>, got ${s}`);
      return [s.slice(0, i), s.slice(i + 1)];
    };
    const canaryRun = values['canary-run']
      ? (readJson(values['canary-run']) as {
          ownerView?: { titleFound: boolean; contentCanariesFound: number };
        })
      : undefined;
    const canaries: NamedValue[] = [
      ...(canaryRun ? loadCanaries(canaryRun, 'live') : []),
      ...(values.canaries ?? []).flatMap((f, i) => loadCanaries(readJson(f), `suite${i}`)),
    ];
    const secrets: NamedValue[] = [
      ...(values['secret-file'] ?? []).map((f, i) => ({
        label: `secret-file-${i}`,
        value: readFileSync(f, 'utf8').trim(),
      })),
      ...(values['jwk-file'] ?? []).flatMap((f, i) =>
        privateJwkSecrets(readJson(f), `private-jwk-${i}`),
      ),
    ].filter((s) => s.value.length >= 8);
    const result = leakScan({
      logsDir: values['logs-dir'],
      historyDir: values['history-dir'],
      canaries,
      secrets,
      expectLogs: (values['expect-log'] ?? []).map(pair),
      expectHistories: (values['expect-history'] ?? []).map(pair),
      failureExecutions: values['failure-execution'] ?? [],
      ownerView: canaryRun?.ownerView,
    });
    writeJson(need(values.out, 'out'), result);
    for (const s of result.sources) {
      const hits =
        Object.values(s.canaryHits).reduce((a, b) => a + b, 0) +
        Object.values(s.secretHits).reduce((a, b) => a + b, 0) +
        s.jwtHits;
      console.log(`${hits === 0 ? 'clean' : 'HITS '} ${s.kind} ${s.name} (${s.events} events)`);
    }
    for (const f of result.findings) console.log(`FINDING ${f}`);
    const evidence = values.evidence ?? '-';
    const check = values.check ?? 'leak-scan';
    const outcomes: CheckOutcome[] = [
      ...result.controls.map((c) => ({ name: c.name, ok: c.ok, detail: c.detail })),
      {
        name: 'no canary, token, origin-verify value or private-key parameter in CloudWatch Logs or execution histories',
        ok: result.findings.length === 0,
        detail: `${result.sources.length} source(s), ${canaries.length} canaries, ${secrets.length} secret values; ${result.findings.length} finding(s)`,
      },
    ];
    // Lambda failure path is a mission check of its own.
    const failure = outcomes.filter((o) => o.name.startsWith('Lambda failure path'));
    const rest = outcomes.filter((o) => !o.name.startsWith('Lambda failure path'));
    const a = report(rest, { results: values.results, check, evidence });
    const b = failure.length
      ? report(failure, { results: values.results, check: 'lambda-failure-path', evidence })
      : 0;
    return a || b;
  },

  async 'listener-check'(args) {
    const { values } = parseArgs({
      args,
      options: {
        ...common,
        rules: { type: 'string' },
        'secret-file': { type: 'string' },
        'redacted-out': { type: 'string' },
      },
    });
    const secret = readFileSync(need(values['secret-file'], 'secret-file'), 'utf8').trim();
    const rules = readJson(need(values.rules, 'rules'));
    if (values['redacted-out']) writeJson(values['redacted-out'], redactRules(rules, secret));
    const outcomes = listenerCheck(rules, secret);
    return report(outcomes, {
      results: values.results,
      check: values.check ?? 'origin-protection',
      evidence: values.evidence ?? '-',
    });
  },

  async 'alb-sg-check'(args) {
    const { values } = parseArgs({ args, options: { ...common, groups: { type: 'string' } } });
    const outcomes = albSecurityGroupCheck(readJson(need(values.groups, 'groups')));
    return report(outcomes, {
      results: values.results,
      check: values.check ?? 'origin-protection',
      evidence: values.evidence ?? '-',
    });
  },

  async 'results-smoke'(args) {
    const { values } = parseArgs({ args, options: { ...common, log: { type: 'string' } } });
    const steps = smokeSteps(readFileSync(need(values.log, 'log'), 'utf8'));
    const check = values.check ?? 'smoke';
    appendRecords(
      need(values.results, 'results'),
      steps.map((s) =>
        makeRecord({
          check,
          name: s.name,
          status: s.status,
          evidence: values.evidence ?? '-',
          detail: s.detail,
        }),
      ),
    );
    return steps.every((s) => s.status === 'passed') ? 0 : 1;
  },

  async 'sfn-summary'(args) {
    const { values } = parseArgs({
      args,
      options: { ...common, executions: { type: 'string' }, since: { type: 'string' } },
    });
    const outcomes = stepFunctionsSummary(
      readJson(need(values.executions, 'executions')),
      new Date(need(values.since, 'since')),
    );
    return report(outcomes, {
      results: values.results,
      check: values.check ?? 'step-functions',
      evidence: values.evidence ?? '-',
    });
  },

  async 'probe-overrides'(args) {
    const { values } = parseArgs({
      args,
      options: {
        container: { type: 'string' },
        'run-id': { type: 'string' },
        out: { type: 'string' },
      },
    });
    writeJson(
      need(values.out, 'out'),
      probeOverrides(need(values.container, 'container'), need(values['run-id'], 'run-id')),
    );
    return 0;
  },

  async 'probe-evaluate'(args) {
    const { values } = parseArgs({
      args,
      options: {
        ...common,
        events: { type: 'string' },
        'run-id': { type: 'string' },
        out: { type: 'string' },
      },
    });
    const json = readJson(need(values.events, 'events')) as { events?: { message?: string }[] };
    const lines = probeLines(
      (json.events ?? []).map((e) => String(e.message ?? '')),
      need(values['run-id'], 'run-id'),
    );
    const verdicts = evaluateProbe(lines);
    if (values.out) writeJson(values.out, { lines, verdicts });
    return report(verdicts, {
      results: values.results,
      check: values.check ?? 'db-probe',
      evidence: values.evidence ?? '-',
    });
  },

  async 'unhealthy-image'(args) {
    const { values } = parseArgs({
      args,
      options: { layout: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' } },
    });
    console.log(
      deriveUnhealthyImage(
        need(values.layout, 'layout'),
        need(values.from, 'from'),
        need(values.to, 'to'),
      ),
    );
    return 0;
  },

  async 'taskdef-clone'(args) {
    const { values } = parseArgs({
      args,
      options: {
        in: { type: 'string' },
        image: { type: 'string' },
        container: { type: 'string' },
        out: { type: 'string' },
        tag: { type: 'string', multiple: true },
      },
    });
    const tags = Object.fromEntries(
      (values.tag ?? []).map((t) => [t.slice(0, t.indexOf('=')), t.slice(t.indexOf('=') + 1)]),
    );
    writeJson(
      need(values.out, 'out'),
      cloneTaskDefinition(
        readJson(need(values.in, 'in')),
        need(values.image, 'image'),
        values.container,
        tags,
      ),
    );
    return 0;
  },

  async 'rollback-observe'(args) {
    const { values } = parseArgs({
      args,
      options: {
        snapshot: { type: 'string' },
        baseline: { type: 'string' },
        target: { type: 'string' },
        state: { type: 'string' },
        since: { type: 'string' },
        events: { type: 'string' },
      },
    });
    const stateFile = need(values.state, 'state');
    let state: RolloutState;
    try {
      state = readJson(stateFile) as RolloutState;
    } catch {
      state = initialRolloutState(need(values.baseline, 'baseline'), need(values.target, 'target'));
    }
    const snapshot = readJson(need(values.snapshot, 'snapshot'));
    state = observeRollout(state, snapshot, new Date());
    writeJson(stateFile, state);
    if (values.events && values.since)
      writeJson(values.events, serviceEventsSince(snapshot, new Date(values.since)));
    console.log(state.phase);
    return 0;
  },

  async 'log-follow'(args) {
    const { values } = parseArgs({
      args,
      options: {
        group: { type: 'string' },
        out: { type: 'string' },
        'start-ms': { type: 'string' },
        'interval-ms': { type: 'string' },
      },
    });
    const aws = (process.env.SBX_AWS ?? 'aws').split(/\s+/).filter(Boolean);
    const controller = new AbortController();
    for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => controller.abort());
    const n = await follow({
      aws,
      group: need(values.group, 'group'),
      out: need(values.out, 'out'),
      startMs: Number(values['start-ms'] ?? Date.now()),
      intervalMs: Number(values['interval-ms'] ?? 2_000),
      lookbackMs: 60_000,
      signal: controller.signal,
      onError: (m) => console.error(`log-follow: ${m}`),
    });
    console.error(`log-follow: ${n} event(s) written`);
    return 0;
  },
};

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  const handler = command ? commands[command] : undefined;
  if (!handler) {
    console.error(`usage: sbx-tool <${Object.keys(commands).join('|')}> [options]`);
    return 2;
  }
  try {
    return await handler(args);
  } catch (err) {
    console.error(`sbx-tool ${command}: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err);
    process.exit(2);
  },
);
