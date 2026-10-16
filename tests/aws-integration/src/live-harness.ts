/**
 * Shared helpers of the real-AWS mini-stack suites (`*.aws.test.ts`): the mini-stack's extra
 * outputs, seeding, starting and awaiting executions, reading histories, invoking the reconciler,
 * and the SANITIZED evidence each test records for a live validation.
 *
 * Pure parts (output parsing, masking, history analysis) are unit-tested in
 * `live-harness.test.ts`. Everything that calls AWS runs only behind the AWS gate (aws-gate.ts):
 * nothing here creates AWS clients at import time.
 *
 * Evidence: `recordEvidence(name, data)` writes `<report dir>/evidence/<name>.json` (default
 * `reports/aws-integration/evidence/`). Account ids are masked (`********1234`); evidence carries
 * names, ids, statuses, error names and counts — never document content, execution input/output
 * or causes (only whether a cause is present).
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import {
  DescribeExecutionCommand,
  GetExecutionHistoryCommand,
  SFNClient,
  StartExecutionCommand,
  type DescribeExecutionCommandOutput,
  type HistoryEvent,
} from '@aws-sdk/client-sfn';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { withTestFault, type TestFault } from '@starter/documents/test-faults';
import { testDocumentItem, TEST_DOCUMENT_TABLE_KEY } from '@starter/documents/test-table';
import {
  JobStateTable,
  PROCESSING_WORKFLOW,
  WorkflowStatus,
  executionNameFor,
  jobStateKey,
  serializeExecutionInput,
  statusIndexKey,
  type ProcessingExecutionInput,
} from '@starter/workflow-processing';
import { expect } from 'vitest';
import { assertEmulatorEnvironment } from '@starter/infra/emulator-guard';
import {
  EMULATOR_GAPS,
  EXECUTOR_SPECIFIC_GAPS,
  emulatorLambdaExecutor,
  type EmulatorGap,
} from './emulator-gaps.js';
import type { IntegrationStackOutputs } from './aws-gate.js';

// ---------------------------------------------------------------------------------------------
// Target: real AWS (default) or the MiniStack emulator (tests/aws-integration/emulator)
// ---------------------------------------------------------------------------------------------

export type IntegrationTarget = 'aws' | 'emulator';

/**
 * `AWS_INTEGRATION_TARGET=emulator` runs the suites against the MiniStack emulator; it is only
 * accepted in an environment the SHARED emulator guard accepts (`@starter/infra/emulator-guard`: a
 * loopback or the allowlisted CI-service endpoint, the fake keys, `/dev/null` config files, no
 * profile, token, role or per-service endpoint). Anything else is real AWS — and a real-AWS run
 * refuses any endpoint override (`LiveHarness.create`), so an emulator run can never be recorded
 * as AWS evidence.
 */
export function resolveTarget(env: NodeJS.ProcessEnv = process.env): IntegrationTarget {
  const target = env.AWS_INTEGRATION_TARGET;
  if (target === undefined || target === '' || target === 'aws') return 'aws';
  if (target !== 'emulator') {
    throw new Error(`AWS_INTEGRATION_TARGET=${target}: expected aws or emulator`);
  }
  assertEmulatorEnvironment(env);
  return 'emulator';
}

export const TARGET: IntegrationTarget = resolveTarget();
/** The `target` field of every evidence and result record. */
export const TARGET_LABEL = TARGET === 'emulator' ? 'ministack-emulator' : 'aws';

/**
 * Title of a suite: the target is the first word, so no emulator record reads like an AWS one
 * (`AWS integration stack workflow` / `[ministack-emulator] integration stack workflow`).
 */
export function suiteTitle(name: string, target: IntegrationTarget = TARGET): string {
  return target === 'emulator'
    ? `[ministack-emulator] integration stack ${name}`
    : `AWS integration stack ${name}`;
}

/** `text` on AWS, `otherwise` on the emulator (for titles that state AWS-only properties). */
export function onAws(text: string, otherwise = '', target: IntegrationTarget = TARGET): string {
  return target === 'aws' ? text : otherwise;
}

export {
  EMULATOR_GAPS,
  EXECUTOR_SPECIFIC_GAPS,
  emulatorLambdaExecutor,
  type EmulatorGap,
  type LambdaExecutor,
} from './emulator-gaps.js';

/** Whether `gap` applies to this run: emulator target, and the gap's executor (if any). */
export function gapApplies(
  gap: EmulatorGap,
  target: IntegrationTarget = TARGET,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (target !== 'emulator') return false;
  const executors = EXECUTOR_SPECIFIC_GAPS[gap];
  return executors === undefined || executors.includes(emulatorLambdaExecutor(env));
}

/** `emulator-not-applicable: <why>` when `gap` applies to this run, else undefined. */
export function emulatorNotApplicable(
  gap: EmulatorGap,
  target: IntegrationTarget = TARGET,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return gapApplies(gap, target, env)
    ? `emulator-not-applicable: ${EMULATOR_GAPS[gap]}`
    : undefined;
}

/** A test title carrying its not-applicable reason when the gap applies (results read it). */
export function titled(
  title: string,
  gap: EmulatorGap,
  target: IntegrationTarget = TARGET,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const na = emulatorNotApplicable(gap, target, env);
  return na ? `${title} [${na}]` : title;
}

/** File (JSONL) of the assertions the emulator could not check, one record per assertion. */
export const NOT_APPLICABLE_ASSERTIONS_FILE = 'emulator-not-applicable-assertions.jsonl';

/**
 * Runs `assertion` unless `gap` applies to this run (always on AWS). When it applies the assertion
 * does NOT run: it is recorded as an `emulator-not-applicable` assertion of the current test (the
 * run's results list it and the baseline must declare it), so a test that passes on the emulator
 * says exactly which of its checks were not exercised.
 */
export function unlessEmulatorGap(gap: EmulatorGap, what: string, assertion: () => void): void {
  if (!gapApplies(gap)) {
    assertion();
    return;
  }
  const record = {
    test: expect.getState().currentTestName ?? 'unknown',
    what,
    gap,
    reason: `emulator-not-applicable: ${EMULATOR_GAPS[gap]}`,
  };
  try {
    mkdirSync(evidenceDir(), { recursive: true });
    appendFileSync(
      path.join(evidenceDir(), NOT_APPLICABLE_ASSERTIONS_FILE),
      `${JSON.stringify(record)}\n`,
    );
  } catch (error) {
    console.warn(`[aws-integration] not-applicable assertion not recorded: ${String(error)}`);
  }
}

/** Emulator identity for evidence (set by tests/aws-integration/emulator/{ci,run}.sh). */
function emulatorIdentity(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  return {
    name: 'MiniStack',
    note: 'EMULATOR — not AWS; results say nothing about AWS behaviour',
    version: env.MINISTACK_VERSION,
    image: env.MINISTACK_IMAGE,
    lambdaExecutor: emulatorLambdaExecutor(env),
    ...(env.MINISTACK_LAMBDA_IMAGE_DIGEST
      ? { lambdaRuntimeImageDigest: env.MINISTACK_LAMBDA_IMAGE_DIGEST }
      : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------------------------

/** Outputs of the mini-stack beyond the ones aws-gate.ts resolves (exact CfnOutput ids). */
export const EXTRA_OUTPUT_KEYS = {
  executionTimeoutSeconds: 'ExecutionTimeoutSeconds',
  stateMachineVersionArn: 'StateMachineVersionArn',
  stateMachineAliasArn: 'StateMachineAliasArn',
  keyArn: 'KeyArn',
  validatorRoleArn: 'ValidatorRoleArn',
  processorRoleArn: 'ProcessorRoleArn',
  reconcilerRoleArn: 'ReconcilerRoleArn',
  stateMachineRoleArn: 'StateMachineRoleArn',
  keyProbeRoleArn: 'KeyProbeRoleArn',
  validatorFunctionName: 'ValidatorFunctionName',
  processorFunctionName: 'ProcessorFunctionName',
  validatorAliasArn: 'ValidatorAliasArn',
  processorAliasArn: 'ProcessorAliasArn',
  stateMachineLogGroupName: 'StateMachineLogGroupName',
  validatorLogGroupName: 'ValidatorLogGroupName',
  processorLogGroupName: 'ProcessorLogGroupName',
  reconcilerLogGroupName: 'ReconcilerLogGroupName',
} as const;
export type ExtraOutputName = keyof typeof EXTRA_OUTPUT_KEYS;
export type ExtraOutputs = Partial<Record<ExtraOutputName, string>>;

/** Extra outputs from a `cdk deploy --outputs-file` JSON (`{ <stack>: { <id>: <value> } }`). */
export function extraOutputsFromCdkFile(json: unknown): ExtraOutputs {
  const found: ExtraOutputs = {};
  if (typeof json !== 'object' || json === null) return found;
  for (const stackOutputs of Object.values(json as Record<string, unknown>)) {
    if (typeof stackOutputs !== 'object' || stackOutputs === null) continue;
    const values = stackOutputs as Record<string, unknown>;
    for (const [name, key] of Object.entries(EXTRA_OUTPUT_KEYS) as [ExtraOutputName, string][]) {
      const value = values[key];
      if (typeof value === 'string' && value !== '') found[name] = value;
    }
  }
  return found;
}

// ---------------------------------------------------------------------------------------------
// Masking and evidence
// ---------------------------------------------------------------------------------------------

const mask = (account: string) => `********${account.slice(-4)}`;

/** Account ids this run knows (registered by the harness): masked wherever they appear. */
const knownAccounts = new Set<string>();

export function registerAccountId(account: string): void {
  if (/^\d{12}$/.test(account)) knownAccounts.add(account);
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Sanitizes evidence text:
 *  - 12-digit AWS account ids: registered ones anywhere, ARN account fields, and any other
 *    12-digit number not glued to letters or digits (also next to `-`, e.g. bootstrap role names);
 *    UUIDs (job ids) are kept intact;
 *  - assumed-role SESSION names (`…:assumed-role/<role>/<session>`: often a person's login);
 *  - e-mail-shaped strings.
 */
export function maskAccountIds(text: string): string {
  const uuids: string[] = [];
  let out = text.replace(UUID, (u) => `\uE000${uuids.push(u) - 1}\uE001`);
  for (const account of knownAccounts) out = out.split(account).join(mask(account));
  out = out
    .replace(
      /(arn:aws[a-z-]*:[a-z0-9-]*:[a-z0-9-]*:)(\d{12})(?=:)/g,
      (_m, prefix: string, account: string) => `${prefix}${mask(account)}`,
    )
    .replace(/(?<![0-9A-Za-z])\d{12}(?![0-9A-Za-z])/g, (account) => mask(account))
    .replace(/(:assumed-role\/[^/\s"'\\]+\/)[^\s"',)\\]+/g, '$1********')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, '<email>');
  return out.replace(/\uE000(\d+)\uE001/g, (_m, i: string) => uuids[Number(i)] ?? '');
}

/** The physical-name stem of every resource of run `runId` (stack name `starter-it-<runId>`). */
export const runPrefix = (runId: string) => `starter-it-${runId}`;

/**
 * True when `value` (a name or an ARN) names a resource of run `runId`: the run prefix starts the
 * name or an ARN/path segment and is followed by `-`, `/`, `:` or the end (so `starter-it-abc` never
 * matches `starter-it-abcd-…`).
 */
export function belongsToRun(value: string, runId: string): boolean {
  const escaped = runPrefix(runId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[:/])${escaped}(?:[-/:]|$)`).test(value);
}

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** Directory the sanitized evidence of this run goes to. */
export function evidenceDir(env: NodeJS.ProcessEnv = process.env): string {
  const reportDir =
    env.AWS_INTEGRATION_REPORT_DIR ?? path.join(REPO_ROOT, 'reports/aws-integration');
  return path.join(reportDir, 'evidence');
}

/** Writes `<evidence dir>/<name>.json` (masked, pretty-printed). Never throws into the test. */
export function recordEvidence(name: string, data: unknown): void {
  if (!/^[a-z0-9][a-z0-9.-]{0,80}$/.test(name)) throw new Error(`bad evidence name ${name}`);
  try {
    const dir = evidenceDir();
    mkdirSync(dir, { recursive: true });
    const body = JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        target: TARGET_LABEL,
        ...(TARGET === 'emulator' ? { emulator: emulatorIdentity() } : {}),
        ...(data as object),
      },
      (_k, v: unknown) => (v instanceof Date ? v.toISOString() : v),
      2,
    );
    writeFileSync(path.join(dir, `${name}.json`), `${maskAccountIds(body)}\n`, { mode: 0o644 });
  } catch (error) {
    console.warn(`[aws-integration] evidence ${name} not written: ${String(error)}`);
  }
}

// ---------------------------------------------------------------------------------------------
// History analysis (pure)
// ---------------------------------------------------------------------------------------------

/** States in the order the execution entered them. */
export function enteredStates(events: readonly HistoryEvent[]): string[] {
  return events.flatMap((e) =>
    e.stateEnteredEventDetails?.name ? [e.stateEnteredEventDetails.name] : [],
  );
}

/**
 * Scheduling events of the Lambda tasks: `LambdaFunctionScheduled` (the legacy Lambda resource
 * the definition uses, on AWS) or a `TaskScheduled` whose resource type is lambda (MiniStack).
 */
export function lambdaTaskScheduled(events: readonly HistoryEvent[]): HistoryEvent[] {
  return events.filter(
    (e) =>
      e.type === 'LambdaFunctionScheduled' ||
      (e.type === 'TaskScheduled' && e.taskScheduledEventDetails?.resourceType === 'lambda'),
  );
}

export interface StateAttempts {
  /** Lambda invocations / service-integration calls scheduled (1 + retries). */
  attempts: number;
  succeeded: number;
  /** Error name of every failed attempt, in order. */
  errors: string[];
}

/**
 * Attempts per task state, from the events between a state's `…StateEntered` and
 * `…StateExited`. Retries do not re-enter a state, so every `LambdaFunctionScheduled` /
 * `TaskScheduled` (or a failure to schedule) inside it is one attempt.
 */
export function attemptsByState(events: readonly HistoryEvent[]): Record<string, StateAttempts> {
  const out: Record<string, StateAttempts> = {};
  let current: string | undefined;
  const of = (state: string) => (out[state] ??= { attempts: 0, succeeded: 0, errors: [] });
  for (const e of events) {
    const type = e.type ?? '';
    if (type.endsWith('StateEntered')) {
      current = e.stateEnteredEventDetails?.name;
      continue;
    }
    if (type.endsWith('StateExited')) {
      current = undefined;
      continue;
    }
    if (current === undefined) continue;
    const s = of(current);
    switch (type) {
      case 'LambdaFunctionScheduled':
      case 'TaskScheduled':
        s.attempts += 1;
        break;
      case 'LambdaFunctionScheduleFailed':
        s.attempts += 1;
        s.errors.push(e.lambdaFunctionScheduleFailedEventDetails?.error ?? 'unknown');
        break;
      case 'LambdaFunctionSucceeded':
      case 'TaskSucceeded':
        s.succeeded += 1;
        break;
      case 'LambdaFunctionFailed':
        s.errors.push(e.lambdaFunctionFailedEventDetails?.error ?? 'unknown');
        break;
      case 'LambdaFunctionStartFailed':
        s.errors.push(e.lambdaFunctionStartFailedEventDetails?.error ?? 'unknown');
        break;
      case 'LambdaFunctionTimedOut':
        s.errors.push(e.lambdaFunctionTimedOutEventDetails?.error ?? 'States.Timeout');
        break;
      case 'TaskFailed':
        s.errors.push(e.taskFailedEventDetails?.error ?? 'unknown');
        break;
      case 'TaskStartFailed':
        s.errors.push(e.taskStartFailedEventDetails?.error ?? 'unknown');
        break;
      case 'TaskSubmitFailed':
        s.errors.push(e.taskSubmitFailedEventDetails?.error ?? 'unknown');
        break;
      case 'TaskTimedOut':
        s.errors.push(e.taskTimedOutEventDetails?.error ?? 'States.Timeout');
        break;
      default:
        break;
    }
  }
  return out;
}

/**
 * The state failed with `error` exactly once and was not retried after it (a permanent error).
 * Robust to a rare Lambda service hiccup retried BEFORE it (those are retried by design).
 */
export function failedOnceWithoutRetry(s: StateAttempts | undefined, error: string): boolean {
  if (!s) return false;
  return (
    s.succeeded === 0 &&
    s.errors.at(-1) === error &&
    s.errors.filter((e) => e === error).length === 1 &&
    s.attempts === s.errors.length
  );
}

/** History without data: id, type, state, error name (never input, output or cause text). */
export function historyOutline(events: readonly HistoryEvent[]): Record<string, unknown>[] {
  let current: string | undefined;
  return events.map((e) => {
    if (e.stateEnteredEventDetails?.name) current = e.stateEnteredEventDetails.name;
    const failure =
      e.lambdaFunctionFailedEventDetails ??
      e.lambdaFunctionStartFailedEventDetails ??
      e.lambdaFunctionTimedOutEventDetails ??
      e.lambdaFunctionScheduleFailedEventDetails ??
      e.taskFailedEventDetails ??
      e.taskTimedOutEventDetails ??
      e.executionFailedEventDetails ??
      e.executionTimedOutEventDetails;
    return {
      id: e.id,
      type: e.type,
      at: e.timestamp,
      ...(current ? { state: current } : {}),
      ...(failure?.error ? { error: failure.error } : {}),
      ...(failure ? { hasCause: typeof failure.cause === 'string' && failure.cause !== '' } : {}),
    };
  });
}

/**
 * A deliberately BROKEN revision of a deployed definition (versioning test): ValidateJob stops
 * forwarding `submittedAt`, so the strict handlers reject every event (a contract-breaking deploy).
 */
export function breakValidateParameters(definition: string): string {
  const asl = JSON.parse(definition) as {
    States?: Record<string, { Parameters?: Record<string, unknown> }>;
  };
  const parameters = asl.States?.ValidateJob?.Parameters;
  if (!parameters || !('submittedAt.$' in parameters)) {
    throw new Error('ValidateJob.Parameters["submittedAt.$"] not found in the deployed definition');
  }
  delete parameters['submittedAt.$'];
  return JSON.stringify(asl);
}

/** An execution's status line for evidence (no input, output or cause text). */
export function executionSummary(d: DescribeExecutionCommandOutput): Record<string, unknown> {
  return {
    executionArn: d.executionArn,
    status: d.status,
    startDate: d.startDate,
    stopDate: d.stopDate,
    durationMs:
      d.startDate && d.stopDate ? d.stopDate.getTime() - d.startDate.getTime() : undefined,
    error: d.error,
    hasCause: typeof d.cause === 'string' && d.cause !== '',
    stateMachineVersionArn: d.stateMachineVersionArn,
    stateMachineAliasArn: d.stateMachineAliasArn,
  };
}

// ---------------------------------------------------------------------------------------------
// AWS-facing harness
// ---------------------------------------------------------------------------------------------

/** The subset of the reconciler's run summary the tests read. */
export interface ReconcileSummaryLike {
  staleCandidates: number;
  examined: number;
  skippedRunning: number;
  skippedNotStale: number;
  markedFailed: number;
  completed: number;
  conflicts: number;
  anomalies: number;
  dependencyErrors: number;
  aborted: boolean;
}

export interface SeedOptions {
  /** TEST fault plan for this job (honoured by the mini-stack's armed handlers). */
  fault?: TestFault;
  /** Extra attributes of the document item (e.g. `purgedAt`). */
  documentExtra?: Record<string, unknown>;
  /** Extra attributes merged into the PENDING job-state item. */
  jobExtra?: Record<string, unknown>;
}

export interface StartOptions {
  /** Unqualified (default), version or alias ARN. */
  stateMachineArn?: string;
  /** Execution name (default: the deterministic `executionNameFor(jobId)`). */
  name?: string;
  /** Raw input instead of the canonical serialisation. */
  rawInput?: string;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Seconds the poller allows an execution beyond its configured timeout. */
const DEADLINE_SLACK_SECONDS = 60;

export class LiveHarness {
  readonly sfn: SFNClient;
  readonly ddb: DynamoDBDocumentClient;
  readonly lambda: LambdaClient;

  private constructor(
    readonly region: string,
    readonly outputs: IntegrationStackOutputs,
    readonly extra: ExtraOutputs,
    readonly runId: string,
  ) {
    this.sfn = new SFNClient({ region });
    this.ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
    this.lambda = new LambdaClient({ region });
  }

  /** Reads the extra outputs from `AWS_INTEGRATION_OUTPUTS` (written by scripts/deploy.sh). */
  /**
   * Reads the extra outputs from `AWS_INTEGRATION_OUTPUTS` and verifies that EVERY resource the
   * suites touch belongs to this run (`starter-it-<AWS_INTEGRATION_RUN_ID>`); mutating calls check
   * their target again with `assertRunTarget`.
   */
  static async create(
    gate: { region: string; outputs: IntegrationStackOutputs },
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<LiveHarness> {
    if (resolveTarget(env) === 'aws' && env.AWS_ENDPOINT_URL) {
      throw new Error(
        'AWS_ENDPOINT_URL is set but the target is AWS: an endpoint override is not AWS ' +
          '(use AWS_INTEGRATION_TARGET=emulator for the local emulator)',
      );
    }
    const runId = env.AWS_INTEGRATION_RUN_ID;
    if (!runId || !/^[a-z0-9](?:[a-z0-9-]{1,22}[a-z0-9])$/.test(runId)) {
      throw new Error(
        'AWS_INTEGRATION_RUN_ID (the deployed run, e.g. it-a1b2c3) is required: the suites only ' +
          'touch resources of that run',
      );
    }
    let extra: ExtraOutputs = {};
    if (env.AWS_INTEGRATION_OUTPUTS) {
      const json = JSON.parse(await readFile(env.AWS_INTEGRATION_OUTPUTS, 'utf8')) as unknown;
      const stacks = Object.keys((json ?? {}) as object);
      if (stacks.length !== 1 || stacks[0] !== runPrefix(runId)) {
        throw new Error(
          `AWS_INTEGRATION_OUTPUTS must hold exactly the outputs of stack ${runPrefix(runId)}`,
        );
      }
      extra = extraOutputsFromCdkFile(json);
    }
    const accountOf = /^arn:aws[a-z-]*:states:[^:]*:(\d{12}):/.exec(gate.outputs.stateMachineArn);
    if (accountOf?.[1]) registerAccountId(accountOf[1]);
    const named: Record<string, string | undefined> = {
      stateMachineArn: gate.outputs.stateMachineArn,
      tableName: gate.outputs.tableName,
      documentsTableName: gate.outputs.documentsTableName,
      reconcilerFunctionName: gate.outputs.reconcilerFunctionName,
      ...Object.fromEntries(
        Object.entries(extra).filter(([k]) => k !== 'keyArn' && k !== 'executionTimeoutSeconds'),
      ),
    };
    for (const [name, value] of Object.entries(named)) {
      if (value !== undefined && !belongsToRun(value, runId)) {
        throw new Error(
          `Refusing to run: output ${name} (${maskAccountIds(value)}) is not a resource of run ${runPrefix(runId)}`,
        );
      }
    }
    return new LiveHarness(gate.region, gate.outputs, extra, runId);
  }

  /** Refuses (throws) unless `target` names a resource of this run. */
  assertRunTarget(target: string, what = 'target'): string {
    if (!belongsToRun(target, this.runId)) {
      throw new Error(
        `Refusing to use ${what} ${maskAccountIds(target)}: not a resource of run ${runPrefix(this.runId)}`,
      );
    }
    return target;
  }

  /** An extra output, or a clear failure (stack deployed by an older version of the mini-stack). */
  output(name: ExtraOutputName): string {
    const value = this.extra[name];
    if (!value) {
      throw new Error(
        `mini-stack output ${EXTRA_OUTPUT_KEYS[name]} is missing from AWS_INTEGRATION_OUTPUTS ` +
          '(redeploy the mini-stack with scripts/deploy.sh)',
      );
    }
    return value;
  }

  destroy(): void {
    this.sfn.destroy();
    this.ddb.destroy();
    this.lambda.destroy();
  }

  /**
   * The API stores the document (PostgreSQL) and creates the PENDING state item before
   * StartExecution (persist-then-start); the mini-stack has no API, so the test writes the
   * synthetic document to the TEST-ONLY table and the same PENDING item (conditional, like the API).
   */
  async seed(
    input: ProcessingExecutionInput,
    doc: { title: string; content: string },
    options: SeedOptions = {},
  ): Promise<void> {
    const docItem = {
      ...testDocumentItem(input.jobId, { ...doc, options: { topTerms: 5 } }),
      ...options.documentExtra,
    };
    await this.ddb.send(
      new PutCommand({
        TableName: this.assertRunTarget(this.outputs.documentsTableName),
        Item: options.fault ? withTestFault(docItem, options.fault) : docItem,
      }),
    );
    const at = input.submittedAt;
    const a = JobStateTable.attributes;
    try {
      await this.ddb.send(
        new PutCommand({
          TableName: this.assertRunTarget(this.outputs.tableName),
          Item: {
            ...jobStateKey(input.jobId),
            [a.jobId]: input.jobId,
            [a.status]: WorkflowStatus.Pending,
            [a.version]: 1,
            createdAt: at,
            [a.updatedAt]: at,
            ...statusIndexKey(WorkflowStatus.Pending, at, input.jobId),
            ...options.jobExtra,
          },
          ConditionExpression: 'attribute_not_exists(#pk)',
          ExpressionAttributeNames: { '#pk': JobStateTable.partitionKey },
        }),
      );
    } catch (err) {
      if (!(err instanceof Error && err.name === 'ConditionalCheckFailedException')) throw err;
    }
  }

  async start(input: ProcessingExecutionInput, options: StartOptions = {}): Promise<string> {
    const out = await this.sfn.send(
      new StartExecutionCommand({
        stateMachineArn: this.assertRunTarget(
          options.stateMachineArn ?? this.outputs.stateMachineArn,
          'state machine',
        ),
        name: options.name ?? executionNameFor(input.jobId),
        input: options.rawInput ?? serializeExecutionInput(input),
      }),
    );
    if (!out.executionArn) throw new Error('StartExecution returned no executionArn');
    return out.executionArn;
  }

  async describe(executionArn: string): Promise<DescribeExecutionCommandOutput> {
    return this.sfn.send(new DescribeExecutionCommand({ executionArn }));
  }

  /** The deployed execution timeout (output), else the spec's. */
  get executionTimeoutSeconds(): number {
    const value = Number(this.extra.executionTimeoutSeconds);
    return Number.isInteger(value) && value > 0
      ? value
      : PROCESSING_WORKFLOW.executionTimeoutSeconds;
  }

  /** Polls until the execution leaves RUNNING (deadline: the execution timeout + slack). */
  async waitForCompletion(
    executionArn: string,
    deadlineMs = (this.executionTimeoutSeconds + DEADLINE_SLACK_SECONDS) * 1000,
  ): Promise<DescribeExecutionCommandOutput> {
    const deadline = Date.now() + deadlineMs;
    let delay = 500;
    for (;;) {
      const d = await this.describe(executionArn);
      if (d.status !== 'RUNNING' && d.status !== 'PENDING_REDRIVE') return d;
      if (Date.now() > deadline) {
        throw new Error(`execution ${executionArn} still ${d.status} after ${deadlineMs}ms`);
      }
      await sleep(delay);
      delay = Math.min(delay * 2, 3_000);
    }
  }

  async history(executionArn: string): Promise<HistoryEvent[]> {
    const events: HistoryEvent[] = [];
    let nextToken: string | undefined;
    do {
      const page = await this.sfn.send(
        new GetExecutionHistoryCommand({ executionArn, nextToken, maxResults: 1000 }),
      );
      events.push(...(page.events ?? []));
      nextToken = page.nextToken;
    } while (nextToken);
    return events;
  }

  async stateItem(jobId: string): Promise<Record<string, unknown> | undefined> {
    const r = await this.ddb.send(
      new GetCommand({
        TableName: this.outputs.tableName,
        Key: jobStateKey(jobId),
        ConsistentRead: true,
      }),
    );
    return r.Item;
  }

  /** Polls the job-state item until `predicate` holds (consistent reads). */
  async waitForItem(
    jobId: string,
    predicate: (item: Record<string, unknown> | undefined) => boolean,
    deadlineMs: number,
  ): Promise<Record<string, unknown> | undefined> {
    const deadline = Date.now() + deadlineMs;
    for (;;) {
      const item = await this.stateItem(jobId);
      if (predicate(item)) return item;
      if (Date.now() > deadline) {
        throw new Error(`job ${jobId} did not reach the expected state within ${deadlineMs}ms`);
      }
      await sleep(1_000);
    }
  }

  /** Invokes the reconciler once (synchronously) and returns its run summary. */
  async invokeReconciler(): Promise<ReconcileSummaryLike> {
    const name = this.outputs.reconcilerFunctionName;
    if (!name) throw new Error('the mini-stack has no ReconcilerFunctionName output');
    this.assertRunTarget(name, 'reconciler function');
    const out = await this.lambda.send(
      new InvokeCommand({ FunctionName: name, Payload: new TextEncoder().encode('{}') }),
    );
    const payload = new TextDecoder().decode(out.Payload);
    if (out.FunctionError) throw new Error(`reconciler failed: ${payload.slice(0, 500)}`);
    return JSON.parse(payload) as ReconcileSummaryLike;
  }

  /**
   * Makes a job look stale to the reconciler (last transition `hoursAgo` hours back) without
   * touching its status or version — conditional on both, so a concurrent writer is never
   * overwritten. Simulates the 15-minute threshold the tests cannot wait for.
   */
  async backdate(
    jobId: string,
    expected: { status: string; version: number },
    hoursAgo = 2,
  ): Promise<string> {
    const at = new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
    const a = JobStateTable.attributes;
    const idx = statusIndexKey(expected.status as WorkflowStatus, at, jobId);
    await this.ddb.send(
      new UpdateCommand({
        TableName: this.assertRunTarget(this.outputs.tableName),
        Key: jobStateKey(jobId),
        UpdateExpression: 'SET #updatedAt = :at, #gsi1sk = :gsi1sk',
        ConditionExpression: '#status = :status AND #version = :version',
        ExpressionAttributeNames: {
          '#updatedAt': a.updatedAt,
          '#gsi1sk': JobStateTable.statusIndex.sortKey,
          '#status': a.status,
          '#version': a.version,
        },
        ExpressionAttributeValues: {
          ':at': at,
          ':gsi1sk': idx.gsi1sk,
          ':status': expected.status,
          ':version': expected.version,
        },
      }),
    );
    return at;
  }

  /** Removes a test job's state item and document (cleanup of deliberately malformed items). */
  async deleteJob(jobId: string): Promise<void> {
    await this.ddb.send(
      new DeleteCommand({
        TableName: this.assertRunTarget(this.outputs.tableName),
        Key: jobStateKey(jobId),
      }),
    );
    await this.ddb.send(
      new DeleteCommand({
        TableName: this.assertRunTarget(this.outputs.documentsTableName),
        Key: { [TEST_DOCUMENT_TABLE_KEY]: jobId },
      }),
    );
  }
}
