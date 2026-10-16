import {
  Aws,
  CfnOutput,
  CfnRule,
  Fn,
  Token,
  DefaultStackSynthesizer,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
} from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import type { Construct } from 'constructs';
import { TEST_FAULT_INJECTION_ENV } from '@starter/documents/test-faults';
import { TEST_DOCUMENT_TABLE_KEY } from '@starter/documents/test-table';
import { PROCESSING_WORKFLOW } from '@starter/workflow-processing';
import { JobReconciler } from '../constructs/job-reconciler.js';
import { JobStateTable } from '../constructs/job-state-table.js';
import { ProcessingWorkflow } from '../constructs/processing-workflow.js';
import { applyLogGroupCompliance } from '../lib/aspects.js';
import type { WorkflowHandlerEntries } from '../lib/lambda-entries.js';
import { EMULATOR_REGION } from '../lib/emulator-guard.js';
import { DEFAULT_AWS_REGION, validateAwsRegion } from '../lib/region.js';
import { applyRequiredTags, type RequiredTags } from '../lib/tagging.js';

/** 3-24 chars, lowercase alphanumerics and hyphens, no leading/trailing hyphen. */
export const RUN_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,22}[a-z0-9])$/;
export const DEFAULT_TTL_HOURS = 6;
export const MAX_TTL_HOURS = 72;

/** Tags the sweeper uses to find and delete abandoned integration stacks. */
export const EPHEMERAL_TAGS = {
  ephemeral: 'starter:ephemeral',
  runId: 'starter:run-id',
  expiresAt: 'starter:expires-at',
  /** Experiment the run belongs to; inventory and teardown checks use it. */
  experiment: 'starter:experiment',
} as const;

/** `starter:experiment` of the live validation (override with `-c experiment=<id>`). */
export const DEFAULT_EXPERIMENT = 'live-validation';
const EXPERIMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/**
 * CDK bootstrap qualifier: the SAME bootstrap as the sandbox stage, i.e.
 * `cdk bootstrap --qualifier starter --toolkit-stack-name starter-cdk-toolkit`. The version check
 * reads `/cdk-bootstrap/<qualifier>/version`, which that bootstrap writes whatever the toolkit
 * stack is called.
 */
export const DEFAULT_INTEGRATION_QUALIFIER = 'starter';
const QUALIFIER_PATTERN = /^[a-z0-9]{1,10}$/;

/** SSM parameter the CDK CLI checks the bootstrap version against (qualifier-scoped). */
export const bootstrapVersionParameter = (qualifier: string) =>
  `/cdk-bootstrap/${qualifier}/version`;

export function validateQualifier(value: string): string {
  if (!QUALIFIER_PATTERN.test(value)) {
    throw new Error(`Invalid qualifier=${value}: expected 1-10 lowercase alphanumerics`);
  }
  return value;
}

/** Alias of the state machine (the Lambda functions' alias has the same name). */
export const STATE_MACHINE_ALIAS = 'live';

/**
 * Execution timeout of the mini-stack's state machine. Shorter than the spec's 600 s so the
 * execution-timeout test (uncatchable TIMED_OUT, then the reconciler) runs in about a minute;
 * every other mini-stack execution finishes well inside it (the slowest, retries exhausted on a
 * throttled processor, needs at most ~35 s). `-c executionTimeoutSeconds=spec` deploys the spec
 * value instead (the timeout test then fails, explaining why).
 */
export const DEFAULT_TEST_EXECUTION_TIMEOUT_SECONDS = 45;
export const MIN_TEST_EXECUTION_TIMEOUT_SECONDS = 30;

/** `-c executionTimeoutSeconds=<30..600|spec>` → the override, or `undefined` for the spec value. */
export function resolveExecutionTimeout(value: unknown): number | undefined {
  if (value === undefined || value === '') return DEFAULT_TEST_EXECUTION_TIMEOUT_SECONDS;
  if (value === 'spec') return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  const max = PROCESSING_WORKFLOW.executionTimeoutSeconds;
  if (!Number.isInteger(n) || n < MIN_TEST_EXECUTION_TIMEOUT_SECONDS || n > max) {
    throw new Error(
      `Invalid executionTimeoutSeconds=${String(value)}: expected an integer ${MIN_TEST_EXECUTION_TIMEOUT_SECONDS}..${max} or "spec"`,
    );
  }
  return n === max ? undefined : n;
}

const maskAccount = (account: string) => `********${account.slice(-4)}`;

/**
 * The account the mini-stack is pinned to. `-c account=<12 digits>` is pinned into the
 * stack environment. When the CDK CLI resolved credentials (it then sets CDK_DEFAULT_ACCOUNT, as
 * for every deploy or destroy), the pin is REQUIRED and must equal that account, so a deploy can
 * never land in whatever account the ambient credentials belong to. Without credentials (offline
 * review synth) the stack stays environment-agnostic.
 */
export function resolveIntegrationAccount(input: {
  contextAccount?: string | undefined;
  cdkDefaultAccount?: string | undefined;
}): string | undefined {
  const { contextAccount, cdkDefaultAccount } = input;
  if (contextAccount !== undefined && !/^\d{12}$/.test(contextAccount)) {
    throw new Error('Invalid -c account: expected 12 digits');
  }
  if (cdkDefaultAccount === undefined || cdkDefaultAccount === '') return contextAccount;
  if (contextAccount === undefined) {
    throw new Error(
      `Refusing to synthesize for AWS without -c account=<expected account id>: credentials resolve to ${maskAccount(cdkDefaultAccount)}, and the mini-stack is pinned to an explicit account`,
    );
  }
  if (contextAccount !== cdkDefaultAccount) {
    throw new Error(
      `Account mismatch: -c account=${maskAccount(contextAccount)} but the credentials resolve to ${maskAccount(cdkDefaultAccount)}`,
    );
  }
  return contextAccount;
}

/**
 * Role name used in place of the operator's role for an OFFLINE synth. No such role exists, so
 * CloudFormation rejects a deploy of a template that still carries it (invalid principal).
 */
export const OFFLINE_OPERATOR_ROLE_NAME = 'starter-it-offline-placeholder-operator';

/**
 * The only session name under which the operator may assume the KeyProbeRole
 * (`sts:RoleSessionName` condition). tests/aws-integration/src/iam-kms.aws.test.ts uses it.
 */
export const KEY_PROBE_SESSION_NAME = 'starter-it-kms-probe';

/**
 * The mini-stack's region: `-c region` (any region of the aws partition) or DEFAULT_AWS_REGION.
 * Malformed names and other partitions are refused (`validateAwsRegion`).
 */
export function validateRegion(value: string | undefined): string {
  return value === undefined || value === ''
    ? DEFAULT_AWS_REGION
    : validateAwsRegion(value, '-c region');
}

/** `arn:<partition>:iam::<account>:role/<path/>name` (path segments and name: IAM characters). */
const ROLE_ARN_PATTERN = /^arn:aws[a-z-]*:iam::(\d{12}):role\/(?:[\w+=,.@-]+\/)*[\w+=,.@-]{1,64}$/;

/**
 * The IAM ROLE (ARN including its path, e.g. an IAM Identity Center permission-set role
 * `…:role/aws-reserved/sso.amazonaws.com/<region>/AWSReservedSSO_<set>_<suffix>`) of the operator
 * who deploys the mini-stack and runs its tests. The CMK's key policy and the KeyProbeRole trust
 * name it directly, so the operator needs neither kms:* nor sts:AssumeRole in its own identity
 * policies. Required whenever the CDK CLI resolved credentials (deploy, destroy); offline the
 * stack carries a placeholder that CloudFormation would reject.
 */
export function resolveOperatorPrincipalArn(input: {
  contextValue?: string | undefined;
  account?: string | undefined;
  cdkDefaultAccount?: string | undefined;
}): string | undefined {
  const { contextValue, account, cdkDefaultAccount } = input;
  if (contextValue === undefined || contextValue === '') {
    if (cdkDefaultAccount !== undefined && cdkDefaultAccount !== '') {
      throw new Error(
        'Refusing to synthesize for AWS without -c operatorPrincipalArn=<IAM role ARN incl. path of the operator> ' +
          '(the mini-stack key policy and the KeyProbeRole trust name it; resolve it with ' +
          '`aws iam get-role --role-name <role name> --query Role.Arn`)',
      );
    }
    return undefined;
  }
  if (/^arn:aws[a-z-]*:sts::/.test(contextValue)) {
    throw new Error(
      'Invalid -c operatorPrincipalArn: pass the IAM ROLE ARN including its path, not the assumed-role ' +
        'session ARN (`aws iam get-role --role-name <role name> --query Role.Arn`)',
    );
  }
  const match = ROLE_ARN_PATTERN.exec(contextValue);
  if (!match) {
    throw new Error(
      'Invalid -c operatorPrincipalArn: expected arn:<partition>:iam::<account>:role/<path/>name',
    );
  }
  const roleAccount = match[1]!;
  for (const expected of [account, cdkDefaultAccount]) {
    if (expected !== undefined && expected !== '' && expected !== roleAccount) {
      throw new Error(
        `Invalid -c operatorPrincipalArn: its account ${maskAccount(roleAccount)} is not the stack account ${maskAccount(expected)}`,
      );
    }
  }
  return contextValue;
}

/** `DeployTarget` output of the emulator variant (the emulator scripts refuse anything else). */
export const EMULATOR_DEPLOY_TARGET = 'ministack-emulator';

// The target resolution and account check live in the gated guard module, so a change
// to this stack file cannot weaken them; re-exported for existing importers.
export { assertEmulatorAccount, resolveDeployTarget } from '../lib/emulator-guard.js';

/**
 * The emulator variant runs in the emulator's fixed region (`EMULATOR_REGION`, the MiniStack
 * setting of the emulator scripts and the CI service), whatever region the AWS runs use.
 */
export function assertEmulatorRegion(region: string): void {
  if (region !== EMULATOR_REGION) {
    throw new Error(
      `-c target=emulator requires -c region=${EMULATOR_REGION} (the emulator's fixed region), not ${region}`,
    );
  }
}

export function validateRunId(value: unknown): string {
  if (typeof value !== 'string' || !RUN_ID_PATTERN.test(value)) {
    throw new Error(
      `Invalid or missing context runId=${String(value)}: expected 3-24 chars of [a-z0-9-], ` +
        'starting and ending with an alphanumeric (e.g. -c runId=mr123-a1b2)',
    );
  }
  return value;
}

/** Resolves `starter:expires-at` from `-c expiresAt=<ISO>` or `-c ttlHours=<n>` (default 6h). */
export function resolveExpiresAt(
  tryGetContext: (key: string) => unknown,
  now: Date = new Date(),
): string {
  const explicit = tryGetContext('expiresAt');
  if (typeof explicit === 'string' && explicit !== '') {
    const t = Date.parse(explicit);
    if (Number.isNaN(t) || t <= now.getTime() || t - now.getTime() > MAX_TTL_HOURS * 3_600_000) {
      throw new Error(
        `Invalid expiresAt=${explicit}: must be an ISO-8601 time within ${MAX_TTL_HOURS}h`,
      );
    }
    return new Date(t).toISOString();
  }
  const ttl = Number(tryGetContext('ttlHours') ?? DEFAULT_TTL_HOURS);
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > MAX_TTL_HOURS) {
    throw new Error(`Invalid ttlHours=${String(ttl)}: expected an integer 1..${MAX_TTL_HOURS}`);
  }
  return new Date(now.getTime() + ttl * 3_600_000).toISOString();
}

/**
 * Required cost-allocation tags for the mini-stack, with the sandbox values
 * (`Owner=sandbox-operator`, `CostCentre=sandbox`, `DataClassification=Synthetic`:
 * the mini-stack only ever holds synthetic test documents, ADR 0232). EXCEPT `Environment`, which
 * stays `dev`: the policy gate of the integration app (BASE-TAG-002) only allows
 * `dev | staging | prod`; `sandbox` needs a policy-baseline decision first (reported, not waived
 * here). The ephemeral nature is carried by the `starter:*` stack tags.
 */
export function integrationRequiredTags(
  overrides: { owner?: string; costCentre?: string; dataClassification?: string } = {},
): RequiredTags {
  return {
    Project: 'aws-modernization-starter',
    Environment: 'dev',
    Owner: overrides.owner ?? 'sandbox-operator',
    CostCentre: overrides.costCentre ?? 'sandbox',
    DataClassification: overrides.dataClassification ?? 'Synthetic',
    ManagedBy: 'aws-cdk',
  };
}

export interface IntegrationWorkflowStackProps extends StackProps {
  readonly runId: string;
  /** ISO-8601 expiry for the sweeper (`starter:expires-at`). */
  readonly expiresAt: string;
  readonly handlerEntries: WorkflowHandlerEntries;
  /** Optional permissions boundary for the sandbox/integration account. */
  readonly permissionsBoundaryArn?: string;
  /** CDK bootstrap qualifier of the integration account. @default DEFAULT_INTEGRATION_QUALIFIER */
  readonly qualifier?: string;
  readonly requiredTags: RequiredTags;
  /** `APP_VERSION` for the Lambdas (e.g. git SHA). */
  readonly appVersion?: string;
  /**
   * Shortened execution timeout of the state machine (see `resolveExecutionTimeout`);
   * `undefined` deploys the spec's value.
   */
  readonly executionTimeoutSeconds?: number;
  /** `starter:experiment` tag. @default DEFAULT_EXPERIMENT */
  readonly experiment?: string;
  /**
   * IAM role ARN (with path) of the operator who runs the tests (`resolveOperatorPrincipalArn`).
   * Named in the CMK key policy (use via DynamoDB, Step Functions and CloudWatch Logs only, plus key
   * metadata) and as the ONLY principal the KeyProbeRole trusts.
   * @default a placeholder role that does not exist (offline synth only; not deployable)
   */
  readonly operatorPrincipalArn?: string;
  /**
   * EMULATOR variant (MiniStack, tests/aws-integration/emulator): the template omits the state
   * machine version and alias, whose CloudFormation types the emulator does not provision.
   * Everything else is identical. Never deployed to AWS: the app synthesizes it only in an
   * environment the shared emulator guard accepts (`resolveDeployTarget`).
   * @default false
   */
  readonly emulator?: boolean;
}

/**
 * Isolated, disposable stack for AWS integration tests of the processing
 * workflow: DynamoDB job table + validator/processor Lambdas + Step Functions +
 * the reconciler (no schedule; invoked by the tests), using the SAME constructs
 * as the environment stages. Everything is DESTROY-able and tagged for the
 * sweeper. No VPC, no shared resources.
 *
 * Test-only additions (live validation; none of them exists in a stage):
 *  - a published state machine VERSION behind a `live` ALIAS (versioning and rollback test);
 *  - a shortened execution timeout (`executionTimeoutSeconds`, execution-timeout test);
 *  - `TEST_FAULT_INJECTION=enabled` on the validator/processor (transient-failure and delay
 *    faults requested by a test through its synthetic document, `@starter/documents/test-faults`);
 *  - `KeyProbeRole`: may read the job table but holds no grant on the CMK (KMS denial test);
 *    only the operator role may assume it;
 *  - a key-policy grant for the operator role (`operatorPrincipalArn`): the operator's permission
 *    set has no kms:* of its own, yet its test calls read and write the CMK-encrypted tables,
 *    execution history and logs (always via those services, never direct key use).
 *
 * NO PostgreSQL (ADR 0232): the handlers load SYNTHETIC documents from a
 * TEST-ONLY DynamoDB table that the tests seed (`TestDocumentsTableName`). The
 * claim-check contract, ASL, IAM to DynamoDB/Step Functions and packaging are
 * exercised; RDS document retrieval (IAM auth, verify-full, load_job_document)
 * is NOT — it is first exercised by a sandbox stage deployment.
 */
export class IntegrationWorkflowStack extends Stack {
  public readonly table: JobStateTable;
  public readonly workflow: ProcessingWorkflow;
  public readonly reconciler: JobReconciler;
  /** TEST-ONLY synthetic documents (ADR 0232). */
  public readonly testDocuments: dynamodb.Table;
  public readonly key: kms.Key;
  /** Absent in the emulator variant. */
  public readonly stateMachineVersion?: sfn.CfnStateMachineVersion;
  /** Absent in the emulator variant. */
  public readonly stateMachineAlias?: sfn.CfnStateMachineAlias;
  /** TEST-ONLY: DynamoDB read on the job table, no KMS grant (KMS denial test). */
  public readonly keyProbeRole: iam.Role;

  constructor(scope: Construct, id: string, props: IntegrationWorkflowStackProps) {
    const runId = validateRunId(props.runId);
    const prefix = `starter-it-${runId}`;
    const qualifier = validateQualifier(props.qualifier ?? DEFAULT_INTEGRATION_QUALIFIER);
    const experiment = props.experiment ?? DEFAULT_EXPERIMENT;
    if (!EXPERIMENT_PATTERN.test(experiment)) {
      throw new Error(`Invalid experiment=${experiment}: expected a tag value of [A-Za-z0-9._:-]`);
    }
    super(scope, id, {
      ...props,
      stackName: prefix,
      description: `AWS modernization starter: EPHEMERAL integration mini-stack (run ${runId}, expires ${props.expiresAt})`,
      terminationProtection: false,
      synthesizer: new DefaultStackSynthesizer({
        qualifier,
        bootstrapStackVersionSsmParameter: bootstrapVersionParameter(qualifier),
      }),
      tags: {
        ...props.requiredTags,
        [EPHEMERAL_TAGS.ephemeral]: 'true',
        [EPHEMERAL_TAGS.runId]: runId,
        [EPHEMERAL_TAGS.expiresAt]: props.expiresAt,
        [EPHEMERAL_TAGS.experiment]: experiment,
      },
    });
    validateRegion(Token.isUnresolved(this.region) ? undefined : this.region);
    if (Token.isUnresolved(this.account)) {
      // Environment-agnostic (offline review / CI synth, no -c account): CloudFormation refuses to
      // create or update a stack from this template, so it can never be deployed into whatever
      // account some credentials belong to (`cdk deploy --app <cdk.out>`). A deployable template
      // is only synthesized with `-c account` (pinned env, checked by the CLI).
      new CfnRule(this, 'OfflineSynthOnly', {
        assertions: [
          {
            assert: Fn.conditionEquals('environment-agnostic', 'pinned'),
            assertDescription:
              'This mini-stack template was synthesized without -c account (offline only); synthesize it with -c account=<expected account> to deploy.',
          },
        ],
      });
    }

    if (props.permissionsBoundaryArn) {
      iam.PermissionsBoundary.of(this).apply(
        iam.ManagedPolicy.fromManagedPolicyArn(
          this,
          'PermissionsBoundary',
          props.permissionsBoundaryArn,
        ),
      );
    }

    // Ephemeral CMK so the test exercises the same KMS permissions as the
    // environments (DynamoDB + CloudWatch Logs). Scheduled for deletion on destroy.
    this.key = new kms.Key(this, 'Key', {
      description: `${prefix} ephemeral CMK (integration tests)`,
      enableKeyRotation: true,
      pendingWindow: Duration.days(7),
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.key.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCloudWatchLogs',
        principals: [new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`)],
        actions: [
          'kms:Encrypt*',
          'kms:Decrypt*',
          'kms:ReEncrypt*',
          'kms:GenerateDataKey*',
          'kms:Describe*',
        ],
        resources: ['*'],
        conditions: {
          ArnLike: {
            'kms:EncryptionContext:aws:logs:arn': `arn:${Aws.PARTITION}:logs:${this.region}:${Aws.ACCOUNT_ID}:log-group:*`,
          },
        },
      }),
    );

    // The operator (tests, CLI) uses the key only THROUGH the services that hold the data, plus
    // read-only key metadata. Named directly: in the same account a key policy alone grants access.
    const operator = new iam.ArnPrincipal(
      props.operatorPrincipalArn ??
        `arn:${Aws.PARTITION}:iam::${Aws.ACCOUNT_ID}:role/${OFFLINE_OPERATOR_ROLE_NAME}`,
    );
    this.key.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'OperatorUseViaDataServices',
        principals: [operator],
        actions: [
          'kms:Decrypt',
          'kms:Encrypt',
          'kms:GenerateDataKey*',
          'kms:ReEncrypt*',
          'kms:DescribeKey',
        ],
        resources: ['*'],
        conditions: {
          StringEquals: {
            'kms:ViaService': ['dynamodb', 'states', 'logs'].map(
              (service) => `${service}.${this.region}.amazonaws.com`,
            ),
          },
        },
      }),
    );
    this.key.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'OperatorReadKeyMetadata',
        principals: [operator],
        actions: ['kms:DescribeKey', 'kms:GetKeyRotationStatus'],
        resources: ['*'],
      }),
    );

    this.table = new JobStateTable(this, 'JobStateTable', {
      tableName: `${prefix}-job-state`,
      encryptionKey: this.key,
      deletionProtection: false,
      removalPolicy: RemovalPolicy.DESTROY,
      pitrRecoveryPeriodDays: 1,
    });

    this.testDocuments = new dynamodb.Table(this, 'TestDocuments', {
      tableName: `${prefix}-test-documents`,
      partitionKey: { name: TEST_DOCUMENT_TABLE_KEY, type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.key,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
        recoveryPeriodInDays: 1,
      },
      deletionProtection: false,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.workflow = new ProcessingWorkflow(this, 'ProcessingWorkflow', {
      resourcePrefix: prefix,
      entries: props.handlerEntries,
      table: this.table.table,
      tableKey: this.key,
      logsKey: this.key,
      logRetention: logs.RetentionDays.ONE_DAY,
      logRemovalPolicy: RemovalPolicy.DESTROY,
      versionRemovalPolicy: RemovalPolicy.DESTROY,
      logLevel: 'debug',
      environmentName: 'integration',
      appVersion: props.appVersion,
      memoryMiB: 512,
      logExecutionData: true,
      documents: { kind: 'test-table', table: this.testDocuments, key: this.key },
      ...(props.executionTimeoutSeconds === undefined
        ? {}
        : { executionTimeoutSeconds: props.executionTimeoutSeconds }),
    });
    // Faults are requested per job by the tests (their synthetic documents); nothing else changes.
    for (const step of [this.workflow.validator, this.workflow.processor]) {
      step.fn.addEnvironment(TEST_FAULT_INJECTION_ENV, 'enabled');
    }

    // Versioning: the deploy publishes the current revision as a version (a new one whenever the
    // definition changes) and points the `live` alias at it. The versioning test publishes a
    // deliberately broken version, routes the alias to it and rolls back by repointing the alias.
    const machine = this.workflow.stateMachine;
    if (!props.emulator) {
      this.stateMachineVersion = new sfn.CfnStateMachineVersion(this, 'StateMachineVersion', {
        stateMachineArn: machine.stateMachineArn,
        stateMachineRevisionId: machine.stateMachineRevisionId,
        description: `Published by the deploy of run ${runId} (spec ${PROCESSING_WORKFLOW.version})`,
      });
      this.stateMachineVersion.applyRemovalPolicy(RemovalPolicy.DESTROY);
      this.stateMachineAlias = new sfn.CfnStateMachineAlias(this, 'StateMachineAlias', {
        name: STATE_MACHINE_ALIAS,
        description: 'Routes executions to the version published by the deploy; tests repoint it',
        routingConfiguration: [
          { stateMachineVersionArn: this.stateMachineVersion.attrArn, weight: 100 },
        ],
      });
      this.stateMachineAlias.applyRemovalPolicy(RemovalPolicy.DESTROY);
    }

    // Same construct as the stages; no schedule (the tests invoke it) and no reservation
    // (sandbox accounts may have a low concurrency quota).
    this.reconciler = new JobReconciler(this, 'Reconciler', {
      resourcePrefix: prefix,
      entry: props.handlerEntries.reconciler,
      table: this.table.table,
      tableKey: this.key,
      statusIndexArn: this.table.statusIndexArn,
      stateMachine: this.workflow.stateMachine,
      logsKey: this.key,
      logRetention: logs.RetentionDays.ONE_DAY,
      logRemovalPolicy: RemovalPolicy.DESTROY,
      versionRemovalPolicy: RemovalPolicy.DESTROY,
      logLevel: 'debug',
      environmentName: 'integration',
      appVersion: props.appVersion,
      settings: { staleAfterSeconds: 900, batchSize: 25, dryRun: false, maxRuntimeSeconds: 45 },
      reserveConcurrency: false,
    });

    // A principal that may read the job table (IAM) but holds NO grant on its CMK: the KMS test
    // assumes it and expects DynamoDB to refuse the read and KMS to refuse direct key use. Its
    // trust names the operator ROLE directly (not the account): in the same account that alone
    // allows the operator to assume it, without sts:AssumeRole in the operator's own policies.
    this.keyProbeRole = new iam.Role(this, 'KeyProbeRole', {
      assumedBy: operator.withConditions({
        StringEquals: { 'sts:RoleSessionName': KEY_PROBE_SESSION_NAME },
      }),
      description: `${prefix} TEST-ONLY probe: job-table read without any grant on its CMK`,
      maxSessionDuration: Duration.hours(1),
    });
    this.keyProbeRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'JobTableReadWithoutKeyGrant',
        actions: ['dynamodb:DescribeTable', 'dynamodb:GetItem'],
        resources: [this.table.table.tableArn],
      }),
    );

    applyRequiredTags(this, props.requiredTags);
    applyLogGroupCompliance(this);

    const out = (name: string, value: string, description: string) =>
      new CfnOutput(this, name, { value, description });
    out('RunId', runId, 'Integration run id');
    out('ExpiresAt', props.expiresAt, 'Sweeper deletes the stack after this time');
    out('Region', this.region, 'Deployment region');
    out('StateMachineArn', this.workflow.stateMachine.stateMachineArn, 'Processing workflow');
    out('JobsTableName', this.table.table.tableName, 'DynamoDB job-state table');
    out(
      'TestDocumentsTableName',
      this.testDocuments.tableName,
      'TEST-ONLY synthetic documents (no PostgreSQL in the mini-stack, ADR 0232)',
    );
    out('ReconcilerFunctionName', this.reconciler.fn.functionName, 'Stale-job reconciler');
    out('ValidatorFunctionName', this.workflow.validator.fn.functionName, 'Validator Lambda');
    out('ProcessorFunctionName', this.workflow.processor.fn.functionName, 'Processor Lambda');
    out('ValidatorAliasArn', this.workflow.validator.alias.functionArn, 'Validator live alias');
    out('ProcessorAliasArn', this.workflow.processor.alias.functionArn, 'Processor live alias');
    out(
      'StateMachineLogGroupName',
      this.workflow.stateMachineLogGroup.logGroupName,
      'Execution logs',
    );
    out(
      'ExecutionTimeoutSeconds',
      String(props.executionTimeoutSeconds ?? PROCESSING_WORKFLOW.executionTimeoutSeconds),
      'Execution timeout of the state machine (shortened for the timeout test)',
    );
    if (this.stateMachineVersion && this.stateMachineAlias) {
      out(
        'StateMachineVersionArn',
        this.stateMachineVersion.attrArn,
        'Version published by this deploy',
      );
      out(
        'StateMachineAliasArn',
        this.stateMachineAlias.attrArn,
        'live alias of the state machine',
      );
    }
    out(
      'DeployTarget',
      props.emulator ? EMULATOR_DEPLOY_TARGET : 'aws',
      'Where this template is meant to run (the emulator variant never runs on AWS)',
    );
    out('KeyArn', this.key.keyArn, 'CMK of the tables, the logs and the execution history');
    out('ValidatorRoleArn', this.workflow.validator.role.roleArn, 'Validator execution role');
    out('ProcessorRoleArn', this.workflow.processor.role.roleArn, 'Processor execution role');
    out('ReconcilerRoleArn', this.reconciler.role.roleArn, 'Reconciler execution role');
    out('StateMachineRoleArn', machine.role.roleArn, 'State machine execution role');
    out('KeyProbeRoleArn', this.keyProbeRole.roleArn, 'TEST-ONLY role without a CMK grant');
    out('ValidatorLogGroupName', this.workflow.validator.logGroup.logGroupName, 'Validator logs');
    out('ProcessorLogGroupName', this.workflow.processor.logGroup.logGroupName, 'Processor logs');
    out('ReconcilerLogGroupName', this.reconciler.logGroup.logGroupName, 'Reconciler logs');
  }
}
