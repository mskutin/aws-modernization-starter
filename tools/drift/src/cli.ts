/**
 * starter-drift: opt-in CloudFormation drift detection for one stage.
 *
 *   starter-drift --stage prod [--cdk-out infra/cdk.out | --stacks a,b] [--region ap-southeast-1] --execute
 *
 * Runs ONLY with explicit opt-in (`--execute` or DRIFT_DETECTION_ENABLED=true)
 * AND resolvable AWS credentials. Otherwise writes
 * `{"status":"not-configured","executed":false,...}` and exits 3.
 *
 * Exit codes: 0 in sync, 1 drift detected, 2 error (usage, API, detection
 * failed/timed out), 3 not configured (no opt-in or no credentials).
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import {
  OFFLINE_NOTE,
  detectDrift,
  summarizeStatus,
  type DriftReport,
  type DriftRunStatus,
} from './detect.js';
import { stageStacks } from './stacks.js';

export const EXIT = { IN_SYNC: 0, DRIFTED: 1, ERROR: 2, NOT_CONFIGURED: 3 } as const;

const EXIT_BY_STATUS: Record<DriftRunStatus, number> = {
  'in-sync': EXIT.IN_SYNC,
  drifted: EXIT.DRIFTED,
  error: EXIT.ERROR,
  'not-configured': EXIT.NOT_CONFIGURED,
};

export interface Deps {
  env?: NodeJS.ProcessEnv;
  clientFactory?: (region: string | undefined) => CloudFormationClient;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  credentialTimeoutMs?: number;
  log?: (line: string) => void;
}

const ROOT = (() => {
  let dir = fileURLToPath(new URL('../', import.meta.url));
  while (!existsSync(join(dir, 'pnpm-workspace.yaml'))) {
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dir;
})();

const userPath = (p: string, env: NodeJS.ProcessEnv) =>
  isAbsolute(p) ? p : resolve(env['INIT_CWD'] ?? process.cwd(), p);

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    timer.unref();
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export function toMarkdown(r: DriftReport): string {
  const lines = [
    '## CloudFormation drift detection',
    '',
    `**Status: ${r.status}** (executed: ${r.executed})${r.reason ? ` — ${r.reason}` : ''}`,
    '',
    `> ${r.note}`,
    '',
  ];
  for (const s of r.stacks) {
    lines.push(
      `### ${s.stackName}: ${s.stackDriftStatus ?? 'unknown'}${s.error ? ` — ERROR: ${s.error}` : ''}`,
      '',
    );
    if (s.resources.length > 0) {
      lines.push(
        '| Resource | Type | Drift | Property | Expected | Actual |',
        '| --- | --- | --- | --- | --- | --- |',
      );
      for (const res of s.resources) {
        const diffs = res.differences.length > 0 ? res.differences : [undefined];
        for (const d of diffs) {
          lines.push(
            `| ${res.logicalId} | ${res.type ?? ''} | ${res.driftStatus ?? ''} | ${d?.path ?? ''} | ${(d?.expected ?? '').slice(0, 60)} | ${(d?.actual ?? '').slice(0, 60)} |`,
          );
        }
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

export async function run(
  argv: string[],
  deps: Deps = {},
): Promise<{ code: number; report?: DriftReport }> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((l: string) => console.log(l));
  let values;
  try {
    ({ values } = parseArgs({
      // pnpm forwards a literal `--` (`pnpm run x -- --flag`); tolerate it.
      args: argv[0] === '--' ? argv.slice(1) : argv,
      options: {
        stage: { type: 'string' },
        'cdk-out': { type: 'string' },
        stacks: { type: 'string' },
        region: { type: 'string' },
        execute: { type: 'boolean', default: false },
        out: { type: 'string' },
        'timeout-seconds': { type: 'string', default: '600' },
        'poll-seconds': { type: 'string', default: '5' },
      },
    }));
  } catch (e) {
    log(`starter-drift: ${e instanceof Error ? e.message : String(e)}`);
    return { code: EXIT.ERROR };
  }
  if (!values.stage && !values.stacks) {
    log('starter-drift: --stage (or --stacks) is required');
    return { code: EXIT.ERROR };
  }
  const out = values.out ? userPath(values.out, env) : join(ROOT, 'reports', 'drift');
  const base = {
    note: OFFLINE_NOTE,
    checkedAt: new Date(deps.now?.() ?? Date.now()).toISOString(),
    ...(values.stage ? { stage: values.stage } : {}),
  };
  const finish = (report: DriftReport) => {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'drift-report.json'), JSON.stringify(report, null, 2));
    writeFileSync(join(out, 'drift-report.md'), toMarkdown(report));
    log(toMarkdown(report));
    return { code: EXIT_BY_STATUS[report.status], report };
  };

  const optedIn =
    values.execute === true || (env['DRIFT_DETECTION_ENABLED'] ?? '').toLowerCase() === 'true';
  if (!optedIn) {
    return finish({
      ...base,
      status: 'not-configured',
      executed: false,
      reason:
        'explicit opt-in missing (pass --execute or set DRIFT_DETECTION_ENABLED=true); no AWS API was called',
      stacks: [],
    });
  }

  let stacks: string[];
  let region = values.region ?? env['AWS_REGION'] ?? env['AWS_DEFAULT_REGION'];
  try {
    if (values.stacks) {
      stacks = values.stacks
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      const cdkOut = values['cdk-out']
        ? userPath(values['cdk-out'], env)
        : join(ROOT, 'infra', 'cdk.out');
      const found = stageStacks(cdkOut, values.stage as string);
      if (found.length === 0) throw new Error(`no stacks for stage "${values.stage}" in ${cdkOut}`);
      stacks = found.map((s) => s.stackName);
      region ??= found.find((s) => s.region)?.region;
    }
  } catch (e) {
    log(`starter-drift: ${e instanceof Error ? e.message : String(e)}`);
    return finish({
      ...base,
      status: 'error',
      executed: false,
      reason: e instanceof Error ? e.message : String(e),
      stacks: [],
    });
  }

  const client = deps.clientFactory?.(region) ?? new CloudFormationClient(region ? { region } : {});
  try {
    await withTimeout(
      client.config.credentials(),
      deps.credentialTimeoutMs ?? 10_000,
      'credential resolution',
    );
  } catch (e) {
    return finish({
      ...base,
      ...(region ? { region } : {}),
      status: 'not-configured',
      executed: false,
      reason: `no AWS credentials could be resolved (${e instanceof Error ? e.message : String(e)}); no drift check was performed`,
      stacks: [],
    });
  }

  const results = await detectDrift({
    client,
    stacks,
    pollIntervalMs: Number(values['poll-seconds']) * 1000,
    timeoutMs: Number(values['timeout-seconds']) * 1000,
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });
  return finish({
    ...base,
    ...(region ? { region } : {}),
    status: summarizeStatus(results),
    executed: true,
    stacks: results,
  });
}
