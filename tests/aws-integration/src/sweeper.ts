/**
 * Periodic sweeper for ephemeral AWS integration mini-stacks.
 *
 * Finds CloudFormation stacks tagged `starter:ephemeral=true` whose `starter:expires-at` (ISO-8601)
 * has passed and deletes them. DRY-RUN by default; `--apply` is required to delete anything.
 *
 *   node dist/sweeper.js --region ap-southeast-1                 # report only
 *   node dist/sweeper.js --region ap-southeast-1 --apply         # delete expired stacks
 *   node dist/sweeper.js --apply --wait-seconds 900 --report reports/aws-integration/sweeper.json
 *
 * Safety rules (all must hold before a stack is deleted):
 *   - tag starter:ephemeral == "true" (exact), and optional --name-prefix matches;
 *   - starter:expires-at is a valid timestamp in the past, OR the tag is missing/invalid and the
 *     stack is older than --max-age-hours (fallback so a broken tagger cannot leak stacks forever);
 *   - stack is not mid-operation (*_IN_PROGRESS) and termination protection is off.
 */
import { parseArgs } from 'node:util';
import { validateAwsRegion } from '@starter/infra/region';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CloudFormationClient,
  DeleteStackCommand,
  DescribeStacksCommand,
  type DeleteStackCommandOutput,
  type DescribeStacksCommandOutput,
  type Stack,
} from '@aws-sdk/client-cloudformation';

export const EPHEMERAL_TAG = 'starter:ephemeral';
export const EXPIRES_AT_TAG = 'starter:expires-at';
export const RUN_ID_TAG = 'starter:run-id';

/** Minimal surface of the CloudFormation client used here (lets tests inject a fake). */
export interface CloudFormationLike {
  send(
    command: DescribeStacksCommand | DeleteStackCommand,
  ): Promise<DescribeStacksCommandOutput | DeleteStackCommandOutput>;
}

const describeStacks = async (
  client: CloudFormationLike,
  input: DescribeStacksCommand['input'],
): Promise<DescribeStacksCommandOutput> =>
  (await client.send(new DescribeStacksCommand(input))) as DescribeStacksCommandOutput;

export interface SweepOptions {
  apply: boolean;
  now: Date;
  /** Fallback max age for ephemeral stacks without a valid expires-at tag. */
  maxAgeHours: number;
  namePrefix?: string;
  /** 0 = request deletion and return; >0 = poll until DELETE_COMPLETE or deadline. */
  waitSeconds: number;
  pollIntervalMs?: number;
  /** Injected for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
}

export type Decision = 'delete' | 'keep' | 'blocked';
export type Outcome =
  | 'would-delete'
  | 'delete-requested'
  | 'deleted'
  | 'delete-failed'
  | 'wait-timeout'
  | 'kept'
  | 'blocked';

export interface StackFinding {
  stackName: string;
  stackId: string;
  status: string;
  createdAt: string | null;
  runId: string | null;
  expiresAt: string | null;
  decision: Decision;
  reason: string;
  outcome: Outcome;
  error?: string;
}

export interface SweepReport {
  mode: 'dry-run' | 'apply';
  sweptAt: string;
  scanned: number;
  ephemeral: number;
  findings: StackFinding[];
  summary: Record<Outcome, number>;
  ok: boolean;
}

const tagValue = (stack: Stack, key: string): string | undefined =>
  stack.Tags?.find((t) => t.Key === key)?.Value;

/** Classify a single stack. Pure; exported for unit tests. */
export function classify(
  stack: Stack,
  opts: Pick<SweepOptions, 'now' | 'maxAgeHours' | 'namePrefix'>,
): { decision: Decision; reason: string; expiresAt: string | null } | null {
  if (tagValue(stack, EPHEMERAL_TAG) !== 'true') return null; // not ours: never reported
  const name = stack.StackName ?? '';
  if (opts.namePrefix && !name.startsWith(opts.namePrefix)) return null;

  const status = stack.StackStatus ?? 'UNKNOWN';
  const rawExpiry = tagValue(stack, EXPIRES_AT_TAG);
  const expiryMs = rawExpiry ? Date.parse(rawExpiry) : Number.NaN;
  const now = opts.now.getTime();

  let expired: boolean;
  let why: string;
  if (Number.isFinite(expiryMs)) {
    expired = expiryMs <= now;
    why = expired ? `expired at ${rawExpiry}` : `expires at ${rawExpiry}`;
  } else {
    const created = stack.CreationTime ? new Date(stack.CreationTime).getTime() : Number.NaN;
    const maxAgeMs = opts.maxAgeHours * 3_600_000;
    if (!Number.isFinite(created)) {
      return {
        decision: 'blocked',
        reason: `${EXPIRES_AT_TAG} ${rawExpiry ? `invalid ("${rawExpiry}")` : 'missing'} and no CreationTime`,
        expiresAt: rawExpiry ?? null,
      };
    }
    expired = now - created >= maxAgeMs;
    why = `${EXPIRES_AT_TAG} ${rawExpiry ? `invalid ("${rawExpiry}")` : 'missing'}; age ${(
      (now - created) /
      3_600_000
    ).toFixed(1)}h vs fallback max ${opts.maxAgeHours}h`;
  }

  if (!expired) return { decision: 'keep', reason: why, expiresAt: rawExpiry ?? null };
  if (status === 'DELETE_IN_PROGRESS' || status === 'DELETE_COMPLETE') {
    return { decision: 'keep', reason: `${why}; already ${status}`, expiresAt: rawExpiry ?? null };
  }
  if (status.endsWith('_IN_PROGRESS')) {
    return {
      decision: 'keep',
      reason: `${why}; ${status} — retry on next sweep`,
      expiresAt: rawExpiry ?? null,
    };
  }
  if (stack.EnableTerminationProtection) {
    return {
      decision: 'blocked',
      reason: `${why}; termination protection enabled — needs manual review`,
      expiresAt: rawExpiry ?? null,
    };
  }
  return {
    decision: 'delete',
    reason: status === 'DELETE_FAILED' ? `${why}; retrying failed delete` : why,
    expiresAt: rawExpiry ?? null,
  };
}

async function listAllStacks(client: CloudFormationLike): Promise<Stack[]> {
  const stacks: Stack[] = [];
  let token: string | undefined;
  do {
    const page = await describeStacks(client, { NextToken: token });
    stacks.push(...(page.Stacks ?? []));
    token = page.NextToken;
  } while (token);
  return stacks;
}

async function waitForDeletion(
  client: CloudFormationLike,
  stackId: string,
  opts: SweepOptions,
): Promise<'deleted' | 'delete-failed' | 'wait-timeout'> {
  const clock = opts.clock ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = clock() + opts.waitSeconds * 1000;
  for (;;) {
    let status: string | undefined;
    try {
      const res = await describeStacks(client, { StackName: stackId });
      status = res.Stacks?.[0]?.StackStatus;
    } catch (err) {
      // DescribeStacks by *name* of a deleted stack throws "does not exist".
      if (err instanceof Error && /does not exist/i.test(err.message)) return 'deleted';
      throw err;
    }
    if (status === undefined || status === 'DELETE_COMPLETE') return 'deleted';
    if (status === 'DELETE_FAILED') return 'delete-failed';
    if (clock() >= deadline) return 'wait-timeout';
    await sleep(opts.pollIntervalMs ?? 15_000);
  }
}

export async function sweep(client: CloudFormationLike, opts: SweepOptions): Promise<SweepReport> {
  const stacks = await listAllStacks(client);
  const findings: StackFinding[] = [];
  const requestToken = `starter-sweeper-${opts.now.getTime()}`;

  for (const stack of stacks) {
    const verdict = classify(stack, opts);
    if (!verdict) continue;
    const finding: StackFinding = {
      stackName: stack.StackName ?? '',
      stackId: stack.StackId ?? stack.StackName ?? '',
      status: stack.StackStatus ?? 'UNKNOWN',
      createdAt: stack.CreationTime ? new Date(stack.CreationTime).toISOString() : null,
      runId: tagValue(stack, RUN_ID_TAG) ?? null,
      expiresAt: verdict.expiresAt,
      decision: verdict.decision,
      reason: verdict.reason,
      outcome:
        verdict.decision === 'keep'
          ? 'kept'
          : verdict.decision === 'blocked'
            ? 'blocked'
            : 'would-delete',
    };
    findings.push(finding);
    if (verdict.decision !== 'delete' || !opts.apply) continue;

    try {
      await client.send(
        new DeleteStackCommand({ StackName: finding.stackId, ClientRequestToken: requestToken }),
      );
      finding.outcome = 'delete-requested';
      if (opts.waitSeconds > 0) {
        finding.outcome = await waitForDeletion(client, finding.stackId, opts);
        if (finding.outcome === 'delete-failed') {
          finding.error = 'stack entered DELETE_FAILED; inspect stack events';
        }
      }
    } catch (err) {
      finding.outcome = 'delete-failed';
      finding.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    }
  }

  const summary = Object.fromEntries(
    (
      [
        'would-delete',
        'delete-requested',
        'deleted',
        'delete-failed',
        'wait-timeout',
        'kept',
        'blocked',
      ] as const
    ).map((o) => [o, findings.filter((f) => f.outcome === o).length]),
  ) as Record<Outcome, number>;

  return {
    mode: opts.apply ? 'apply' : 'dry-run',
    sweptAt: opts.now.toISOString(),
    scanned: stacks.length,
    ephemeral: findings.length,
    findings,
    summary,
    ok: summary['delete-failed'] === 0 && summary['wait-timeout'] === 0,
  };
}

export interface CliArgs {
  apply: boolean;
  regions: string[];
  maxAgeHours: number;
  namePrefix?: string;
  waitSeconds: number;
  report?: string;
}

export function parseCliArgs(argv: readonly string[], env: NodeJS.ProcessEnv): CliArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      apply: { type: 'boolean', default: false },
      region: { type: 'string', multiple: true },
      'max-age-hours': { type: 'string', default: '24' },
      'name-prefix': { type: 'string' },
      'wait-seconds': { type: 'string', default: '0' },
      report: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  const regions = (values.region ?? [env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? ''])
    .flatMap((r) => r.split(','))
    .map((r) => r.trim())
    .filter(Boolean);
  if (regions.length === 0) throw new Error('no region: pass --region or set AWS_REGION');
  // aws-partition region names only (one validation: @starter/config/region via @starter/infra).
  for (const r of regions) validateAwsRegion(r, values.region ? '--region' : 'AWS_REGION');
  const maxAgeHours = Number(values['max-age-hours']);
  const waitSeconds = Number(values['wait-seconds']);
  if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) {
    throw new Error('--max-age-hours must be a positive number');
  }
  if (!Number.isInteger(waitSeconds) || waitSeconds < 0) {
    throw new Error('--wait-seconds must be a non-negative integer');
  }
  return {
    apply: values.apply ?? false,
    regions,
    maxAgeHours,
    namePrefix: values['name-prefix'],
    waitSeconds,
    report: values.report,
  };
}

async function main(): Promise<number> {
  const args = parseCliArgs(process.argv.slice(2), process.env);
  const now = new Date();
  const reports: Array<SweepReport & { region: string }> = [];
  for (const region of args.regions) {
    const client = new CloudFormationClient({ region });
    const report = await sweep(client, {
      apply: args.apply,
      now,
      maxAgeHours: args.maxAgeHours,
      namePrefix: args.namePrefix,
      waitSeconds: args.waitSeconds,
    });
    reports.push({ region, ...report });
    for (const f of report.findings) {
      console.log(`[${region}] ${f.outcome.padEnd(16)} ${f.stackName} (${f.status}) — ${f.reason}`);
      if (f.error) console.error(`[${region}]   error: ${f.error}`);
    }
    console.log(
      `[${region}] ${report.mode}: scanned=${report.scanned} ephemeral=${report.ephemeral} ` +
        Object.entries(report.summary)
          .filter(([, n]) => n > 0)
          .map(([k, n]) => `${k}=${n}`)
          .join(' '),
    );
  }
  if (!args.apply) console.log('dry-run: nothing was deleted (pass --apply to delete).');
  if (args.report) {
    await mkdir(dirname(args.report), { recursive: true });
    await writeFile(args.report, `${JSON.stringify(reports, null, 2)}\n`);
  }
  return reports.every((r) => r.ok) ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(2);
    },
  );
}
