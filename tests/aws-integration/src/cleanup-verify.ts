/**
 * Verifies that an integration run left nothing behind and writes
 * reports/aws-integration/cleanup-status.json (consumed by CI and humans).
 *
 *   node dist/cleanup-verify.js --run-id <id> --region ap-southeast-1 \
 *     --destroy-exit-code 0 --wait-seconds 900 --out reports/aws-integration/cleanup-status.json
 *
 * Checks (polled until clean or the deadline):
 *   1. no CloudFormation stack tagged starter:run-id=<id> exists in any state but DELETE_COMPLETE;
 *   2. no resource tagged starter:run-id=<id> is still returned by the Resource Groups Tagging API
 *      (catches RETAIN'ed tables, log groups, buckets). The tagging index lags deletions, so
 *      residual resources are NOT verified clean (`clean-with-residual-resources`, exit 4), and a
 *      leak with --strict-resources. KMS keys that are already in PendingDeletion (the
 *      mini-stack's CMK has a 7-day window by design) are reported separately and do not count as
 *      residual; a key whose state cannot be read (DescribeKey denied or failing) is
 *      `unverifiable` (exit 6), never residual-and-fine.
 * With --delete-remaining it first issues DeleteStack for every run-tagged stack (fallback when
 * `cdk destroy` itself failed, e.g. on a synth error); termination-protected stacks are left alone.
 * --delete-remaining requires --expected-account <12 digits>: nothing is deleted unless
 * every stack of the run is in that account (the account id inside the stack ARN).
 * A permission set without tag:GetResources (such as the sandbox Developer set) gives `stacks-clean` instead of
 * `clean` (taggingCheck "not-permitted"): no stack remains, the tagged-resource sweep did not run.
 * Exit (CLEANUP_EXIT_CODES; only `clean` is 0 — every verdict that is not verified clean is
 * non-zero): 0 clean, 1 leaked (or residual resources with
 * --strict-resources), 2 usage/API error, 3 stacks-clean (tagged-resource sweep not permitted),
 * 4 clean-with-residual-resources, 6 unverifiable (a listed KMS key's state could not be read).
 * (5 is left out on purpose: cleanup.sh uses it for the finops sweep's "settled by fallbacks".)
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { validateAwsRegion } from '@starter/infra/region';
import {
  CloudFormationClient,
  DeleteStackCommand,
  DescribeStacksCommand,
  type Stack,
} from '@aws-sdk/client-cloudformation';
import { DescribeKeyCommand, KMSClient, type DescribeKeyCommandOutput } from '@aws-sdk/client-kms';
import {
  GetResourcesCommand,
  ResourceGroupsTaggingAPIClient,
  type GetResourcesCommandOutput,
} from '@aws-sdk/client-resource-groups-tagging-api';
import { RUN_ID_TAG, type CloudFormationLike } from './sweeper.js';

/** Mirrors RUN_ID_PATTERN in infra/stacks/integration-workflow-stack.ts. */
export const RUN_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,22}[a-z0-9])$/;

export interface TaggingLike {
  send(command: GetResourcesCommand): Promise<GetResourcesCommandOutput>;
}

export interface KmsLike {
  send(command: DescribeKeyCommand): Promise<DescribeKeyCommandOutput>;
}

const KMS_KEY_ARN = /^arn:aws[a-z-]*:kms:[^:]+:\d{12}:key\//;

/**
 * `stacks-clean`: no stack of the run remains, but the tagged-resource sweep could not run because
 * the credentials may not call tag:GetResources (the sandbox Developer permission set) — not "clean":
 * cleanup.sh then requires another sweep (the finops verify-clean) before it reports success.
 */
export type CleanupStatus =
  'clean' | 'clean-with-residual-resources' | 'stacks-clean' | 'unverifiable' | 'leaked' | 'error';

/** Exit code per verdict. Only a verified `clean` is 0. */
export const CLEANUP_EXIT_CODES: Readonly<Record<CleanupStatus, number>> = {
  clean: 0,
  leaked: 1,
  error: 2,
  'stacks-clean': 3,
  'clean-with-residual-resources': 4,
  unverifiable: 6,
};

export function exitCodeFor(status: CleanupStatus): number {
  return CLEANUP_EXIT_CODES[status];
}

/** Whether the tagged-resource sweep ran. */
export type TaggingCheck = 'done' | 'not-permitted';

export interface CleanupReport {
  runId: string;
  region: string;
  checkedAt: string;
  destroyExitCode: number | null;
  status: CleanupStatus;
  remainingStacks: Array<{ stackName: string; status: string }>;
  residualResources: string[];
  /** CMKs already scheduled for deletion (expected; they disappear after the pending window). */
  keysPendingDeletion: string[];
  /** Listed resources whose state could not be read (e.g. kms:DescribeKey denied): NOT verified. */
  unverifiableResources: string[];
  taggingCheck: TaggingCheck;
  message: string;
}

/** An authorization refusal (as opposed to a throttle or a network error). */
export function isAccessDenied(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return /AccessDenied|UnauthorizedOperation|NotAuthorized/i.test(err.name) || status === 403;
}

export async function remainingStacksForRun(
  cfn: CloudFormationLike,
  runId: string,
): Promise<Stack[]> {
  const out: Stack[] = [];
  let token: string | undefined;
  do {
    const page = (await cfn.send(new DescribeStacksCommand({ NextToken: token }))) as {
      Stacks?: Stack[];
      NextToken?: string;
    };
    for (const s of page.Stacks ?? []) {
      const tagged = s.Tags?.some((t) => t.Key === RUN_ID_TAG && t.Value === runId);
      if (tagged && s.StackStatus !== 'DELETE_COMPLETE') out.push(s);
    }
    token = page.NextToken;
  } while (token);
  return out;
}

/** Account id inside a CloudFormation stack ARN (undefined when it is not an ARN). */
export function accountOfStackArn(stackId: string | undefined): string | undefined {
  return /^arn:aws[a-z-]*:cloudformation:[^:]+:(\d{12}):stack\//.exec(stackId ?? '')?.[1];
}

export class AccountMismatchError extends Error {
  override name = 'AccountMismatchError';
}

/**
 * Fallback: request deletion of every remaining (unprotected) stack of the run. With
 * `expectedAccount` nothing is deleted unless every stack of the run lives in that
 * account: DescribeStacks answers for the caller's account, so a mismatch means the credentials
 * belong to another account.
 */
export async function deleteRemainingStacks(
  cfn: CloudFormationLike,
  runId: string,
  expectedAccount?: string,
): Promise<{ requested: string[]; skipped: string[] }> {
  const requested: string[] = [];
  const skipped: string[] = [];
  const stacks = await remainingStacksForRun(cfn, runId);
  if (expectedAccount !== undefined) {
    const foreign = stacks.filter((s) => accountOfStackArn(s.StackId) !== expectedAccount);
    if (foreign.length > 0) {
      throw new AccountMismatchError(
        `refusing DeleteStack: ${foreign.length} stack(s) of run ${runId} are not in the expected account ********${expectedAccount.slice(-4)}`,
      );
    }
  }
  for (const s of stacks) {
    const id = s.StackId ?? s.StackName;
    if (!id || s.EnableTerminationProtection || s.StackStatus === 'DELETE_IN_PROGRESS') {
      skipped.push(s.StackName ?? '?');
      continue;
    }
    await cfn.send(new DeleteStackCommand({ StackName: id }));
    requested.push(s.StackName ?? id);
  }
  return { requested, skipped };
}

export async function residualResourcesForRun(
  tagging: TaggingLike,
  runId: string,
): Promise<string[]> {
  const arns: string[] = [];
  let token: string | undefined;
  do {
    const page = await tagging.send(
      new GetResourcesCommand({
        TagFilters: [{ Key: RUN_ID_TAG, Values: [runId] }],
        PaginationToken: token,
      }),
    );
    for (const m of page.ResourceTagMappingList ?? []) if (m.ResourceARN) arns.push(m.ResourceARN);
    token = page.PaginationToken || undefined;
  } while (token);
  return arns;
}

/**
 * Separates KMS keys already in PendingDeletion from genuinely residual resources, and keys whose
 * state could not be read (`unverifiable`) from both.
 */
export async function classifyResidual(
  kms: KmsLike | undefined,
  arns: readonly string[],
): Promise<{ residual: string[]; pendingDeletion: string[]; unverifiable: string[] }> {
  const residual: string[] = [];
  const pendingDeletion: string[] = [];
  const unverifiable: string[] = [];
  for (const arn of arns) {
    if (!kms || !KMS_KEY_ARN.test(arn)) {
      residual.push(arn);
      continue;
    }
    try {
      const d = await kms.send(new DescribeKeyCommand({ KeyId: arn }));
      if (d.KeyMetadata?.KeyState === 'PendingDeletion') pendingDeletion.push(arn);
      else residual.push(arn);
    } catch (err) {
      // Already gone is fine; anything else (e.g. AccessDenied) cannot be verified.
      if (!(err instanceof Error && err.name === 'NotFoundException')) unverifiable.push(arn);
    }
  }
  return { residual, pendingDeletion, unverifiable };
}

export async function verifyCleanup(
  deps: { cfn: CloudFormationLike; tagging: TaggingLike; kms?: KmsLike },
  opts: {
    runId: string;
    region: string;
    destroyExitCode: number | null;
    waitSeconds: number;
    strictResources: boolean;
    pollIntervalMs?: number;
    clock?: () => number;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<CleanupReport> {
  const clock = opts.clock ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = clock() + opts.waitSeconds * 1000;
  const base = {
    runId: opts.runId,
    region: opts.region,
    destroyExitCode: opts.destroyExitCode,
  };
  let taggingCheck: TaggingCheck = 'done';
  for (;;) {
    let stacks: Stack[];
    let residual: string[];
    let pendingDeletion: string[];
    let unverifiable: string[];
    try {
      stacks = await remainingStacksForRun(deps.cfn, opts.runId);
      let tagged: string[] = [];
      if (taggingCheck === 'done') {
        try {
          tagged = await residualResourcesForRun(deps.tagging, opts.runId);
        } catch (err) {
          // A permission set without tag:GetResources: the sweep cannot run (said so, not hidden).
          if (!isAccessDenied(err)) throw err;
          taggingCheck = 'not-permitted';
        }
      }
      ({ residual, pendingDeletion, unverifiable } = await classifyResidual(deps.kms, tagged));
    } catch (err) {
      return {
        ...base,
        checkedAt: new Date(clock()).toISOString(),
        status: 'error',
        remainingStacks: [],
        residualResources: [],
        keysPendingDeletion: [],
        unverifiableResources: [],
        taggingCheck,
        message: `verification failed: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
      };
    }
    const remainingStacks = stacks.map((s) => ({
      stackName: s.StackName ?? '?',
      status: s.StackStatus ?? '?',
    }));
    // An unreadable key keeps polling too (a throttle may clear); at the deadline it is reported.
    const done = stacks.length === 0 && residual.length === 0 && unverifiable.length === 0;
    if (done || clock() >= deadline) {
      let status: CleanupStatus;
      let message: string;
      if (stacks.length > 0) {
        status = 'leaked';
        message = `${stacks.length} stack(s) for run ${opts.runId} still exist; the scheduled sweeper will retry`;
      } else if (residual.length > 0) {
        status = opts.strictResources ? 'leaked' : 'clean-with-residual-resources';
        message = `${residual.length} tagged resource(s) still listed (tagging index may lag deletions); NOT verified clean`;
      } else if (unverifiable.length > 0) {
        status = 'unverifiable';
        message = `no stacks remain for run ${opts.runId}, but the state of ${unverifiable.length} listed KMS key(s) could not be read — NOT verified`;
      } else if (taggingCheck === 'not-permitted') {
        status = 'stacks-clean';
        message = `no stacks remain for run ${opts.runId}; tagged resources NOT checked (tag:GetResources is not permitted) — another sweep is required`;
      } else {
        status = 'clean';
        message = `no stacks or tagged resources remain for run ${opts.runId}`;
      }
      return {
        ...base,
        checkedAt: new Date(clock()).toISOString(),
        status,
        remainingStacks,
        residualResources: residual,
        keysPendingDeletion: pendingDeletion,
        unverifiableResources: unverifiable,
        taggingCheck,
        message,
      };
    }
    await sleep(opts.pollIntervalMs ?? 15_000);
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      'run-id': { type: 'string' },
      region: { type: 'string' },
      'destroy-exit-code': { type: 'string' },
      'wait-seconds': { type: 'string', default: '600' },
      'strict-resources': { type: 'boolean', default: false },
      'delete-remaining': { type: 'boolean', default: false },
      'expected-account': { type: 'string' },
      out: { type: 'string', default: 'reports/aws-integration/cleanup-status.json' },
    },
    strict: true,
  });
  const runId = values['run-id'];
  const region = values.region ?? process.env.AWS_REGION;
  const expectedAccount = values['expected-account'];
  if (
    !runId ||
    !RUN_ID_PATTERN.test(runId) ||
    !region ||
    (expectedAccount !== undefined && !/^\d{12}$/.test(expectedAccount))
  ) {
    console.error(
      'usage: cleanup-verify --run-id <id> --region <region> [--expected-account <12 digits>] [--wait-seconds N]',
    );
    return 2;
  }
  try {
    validateAwsRegion(region, values.region ? '--region' : 'AWS_REGION');
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 2;
  }
  const destroyRaw = values['destroy-exit-code'];
  const destroyExitCode = destroyRaw === undefined ? null : Number(destroyRaw);
  const cfn = new CloudFormationClient({ region });
  if (values['delete-remaining']) {
    if (expectedAccount === undefined) {
      console.error('--delete-remaining requires --expected-account');
      return 2;
    }
    try {
      const { requested, skipped } = await deleteRemainingStacks(cfn, runId, expectedAccount);
      for (const n of requested) console.log(`  DeleteStack requested: ${n}`);
      for (const n of skipped) console.error(`  not deleted (protected or already deleting): ${n}`);
    } catch (err) {
      if (!(err instanceof AccountMismatchError)) throw err;
      const refused: CleanupReport = {
        runId,
        region,
        checkedAt: new Date().toISOString(),
        destroyExitCode,
        status: 'error',
        remainingStacks: [],
        residualResources: [],
        keysPendingDeletion: [],
        unverifiableResources: [],
        taggingCheck: 'done',
        message: err.message,
      };
      await mkdir(dirname(values.out), { recursive: true });
      await writeFile(values.out, `${JSON.stringify(refused, null, 2)}\n`);
      console.error(`cleanup error: ${err.message}`);
      return 2;
    }
  }
  const report = await verifyCleanup(
    {
      cfn,
      tagging: new ResourceGroupsTaggingAPIClient({ region }),
      kms: new KMSClient({ region }),
    },
    {
      runId,
      region,
      destroyExitCode,
      waitSeconds: Number(values['wait-seconds']),
      strictResources: values['strict-resources'] ?? false,
    },
  );
  await mkdir(dirname(values.out), { recursive: true });
  await writeFile(values.out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`cleanup ${report.status}: ${report.message}`);
  for (const s of report.remainingStacks) console.error(`  stack ${s.stackName} ${s.status}`);
  for (const r of report.residualResources) console.error(`  resource ${r}`);
  for (const k of report.keysPendingDeletion) console.log(`  KMS key pending deletion: ${k}`);
  for (const u of report.unverifiableResources) console.error(`  unverifiable: ${u}`);
  return exitCodeFor(report.status);
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
