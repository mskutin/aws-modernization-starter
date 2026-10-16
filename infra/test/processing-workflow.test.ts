import {
  JobStateTable as Spec,
  PROCESSING_WORKFLOW,
  ProcessingState,
  TASK_EVENT_KEYS,
  WorkflowError,
  WorkflowStatus,
} from '@starter/workflow-processing';
import { allowedPredecessors } from '@starter/domain';
import {
  CONDITIONAL_CHECK_FAILED,
  FAILURE_DEFAULTS,
  RECORD_PREDECESSORS,
  RECORD_STATE_RETRY,
  TASK_EVENT_PARAMETERS,
  toAslRetrier,
} from '@starter/workflow-processing/cdk';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { rdsCaBundlePath } from '@starter/db';
import { RemovalPolicy } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as logs from 'aws-cdk-lib/aws-logs';
import { describe, expect, it } from 'vitest';
import { JobStateTable } from '../constructs/job-state-table.js';
import { LIVE_ALIAS, ProcessingWorkflow } from '../constructs/processing-workflow.js';
import { RelationalDatabase } from '../constructs/relational-database.js';
import { HANDLER_TABLE_ACTIONS } from '../lib/grants.js';
import {
  FIXTURE_ENTRIES,
  importedFoundation,
  nagViolations,
  newApp,
  requirePnpmOnPath,
  resourcesOf,
  stateMachineDefinition,
  testStack,
} from './helpers.js';

type Mode = 'postgres' | 'test-table';

function build(
  opts: {
    mode?: Mode;
    bundle?: boolean;
    /** `null` = omit (to test the guard). */
    reservedConcurrency?: number | null;
    /** `false` = no VPC (to test the guard). */
    network?: boolean;
    auditRetentionDays?: number;
  } = {},
) {
  const mode = opts.mode ?? 'postgres';
  const app = newApp({ bundle: opts.bundle });
  const stack = testStack(app);
  const f = importedFoundation(stack);
  const table = new JobStateTable(stack, 'Jobs', {
    encryptionKey: f.dataKey,
    deletionProtection: true,
    removalPolicy: RemovalPolicy.RETAIN,
    pitrRecoveryPeriodDays: 35,
  });
  const database =
    mode === 'postgres'
      ? new RelationalDatabase(stack, 'Database', {
          resourcePrefix: 'starter-test',
          vpc: f.vpc,
          subnets: f.dataSubnets,
          encryptionKey: f.dataKey,
          logsKey: f.logsKey,
          logRetention: logs.RetentionDays.ONE_MONTH,
          engineVersion: '17.9',
          instanceType: 't4g.micro',
          multiAz: false,
          allocatedStorageGiB: 20,
          maxAllocatedStorageGiB: 50,
          backupRetentionDays: 1,
          deletionProtection: false,
          removalPolicy: RemovalPolicy.SNAPSHOT,
          performanceInsights: false,
          monitoringIntervalSeconds: 0,
          databaseName: 'starterapp',
          masterUsername: 'starteradmin',
          rotation: { enabled: false, intervalDays: 30 },
        })
      : undefined;
  const testDocuments =
    mode === 'test-table'
      ? new dynamodb.Table(stack, 'TestDocuments', {
          partitionKey: { name: 'jobId', type: dynamodb.AttributeType.STRING },
          encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
          encryptionKey: f.dataKey,
          pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
        })
      : undefined;
  const workflow = new ProcessingWorkflow(stack, 'Workflow', {
    resourcePrefix: 'starter-test',
    entries: FIXTURE_ENTRIES,
    table: table.table,
    tableKey: f.dataKey,
    logsKey: f.logsKey,
    logRetention: logs.RetentionDays.ONE_MONTH,
    logRemovalPolicy: RemovalPolicy.RETAIN,
    versionRemovalPolicy: RemovalPolicy.RETAIN,
    logLevel: 'info',
    environmentName: 'test',
    appVersion: 'abc1234',
    memoryMiB: 512,
    reservedConcurrency:
      opts.reservedConcurrency === null
        ? undefined
        : (opts.reservedConcurrency ?? (mode === 'postgres' ? 5 : undefined)),
    logExecutionData: false,
    network:
      mode === 'postgres' && opts.network !== false
        ? { vpc: f.vpc, subnets: f.appSubnets }
        : undefined,
    documents:
      database !== undefined
        ? { kind: 'postgres', database, caBundlePath: rdsCaBundlePath() }
        : { kind: 'test-table', table: testDocuments!, key: f.dataKey },
    ...(opts.auditRetentionDays !== undefined
      ? { auditRetentionDays: opts.auditRetentionDays }
      : {}),
  });
  return { app, stack, f, table, database, workflow, template: Template.fromStack(stack) };
}

const envOf = (template: Template) =>
  resourcesOf(template, 'AWS::Lambda::Function').map(
    ([, fn]) => (fn.Environment as { Variables: Record<string, unknown> }).Variables,
  );

describe('ProcessingWorkflow — Lambda functions', () => {
  const { template, f, stack } = build();

  it('two Node.js 24 arm64 functions with X-Ray and their own encrypted log groups', () => {
    const fns = resourcesOf(template, 'AWS::Lambda::Function');
    expect(fns).toHaveLength(2);
    for (const [, props] of fns) {
      expect(props).toMatchObject({
        Runtime: 'nodejs24.x',
        Architectures: ['arm64'],
        Handler: 'index.handler',
        TracingConfig: { Mode: 'Active' },
      });
    }
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/starter/starter-test/lambda/validator',
      RetentionInDays: 30,
      KmsKeyId: f.logsKey.keyArn,
    });
  });

  it('timeouts equal the spec task timeouts', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Timeout: PROCESSING_WORKFLOW.tasks.validate.timeoutSeconds,
      Description: Match.stringLikeRegexp(ProcessingState.Validate),
    });
    template.hasResourceProperties('AWS::Lambda::Function', {
      Timeout: PROCESSING_WORKFLOW.tasks.process.timeoutSeconds,
      Description: Match.stringLikeRegexp(ProcessingState.Process),
    });
  });

  it('reserves concurrency for database-connected functions and refuses to omit it', () => {
    const fns = resourcesOf(template, 'AWS::Lambda::Function');
    expect(fns.map(([, props]) => props.ReservedConcurrentExecutions)).toEqual([5, 5]);
    const reserved = build({ reservedConcurrency: 7 }).template;
    expect(
      resourcesOf(reserved, 'AWS::Lambda::Function').map(([, p]) => p.ReservedConcurrentExecutions),
    ).toEqual([7, 7]);
    expect(() => build({ reservedConcurrency: null })).toThrow(/need reservedConcurrency$/);
    // The mini-stack's functions hold no database connections: a reservation is optional there.
    expect(() => build({ mode: 'test-table', reservedConcurrency: null })).not.toThrow();
  });

  it('publishes versions behind a `live` alias (version-aware deploys)', () => {
    template.resourceCountIs('AWS::Lambda::Version', 2);
    template.resourceCountIs('AWS::Lambda::Alias', 2);
    template.hasResourceProperties('AWS::Lambda::Alias', { Name: LIVE_ALIAS });
    template.hasResource('AWS::Lambda::Version', { DeletionPolicy: 'Retain' });
  });

  it('gets the handler env contract (AWS_REGION is set by Lambda; never DYNAMODB_ENDPOINT)', () => {
    for (const vars of envOf(template)) {
      expect(vars).toMatchObject({
        JOBS_TABLE_NAME: expect.anything(),
        LOG_LEVEL: 'info',
        APP_ENVIRONMENT: 'test',
        APP_VERSION: 'abc1234',
      });
      expect(vars).not.toHaveProperty('DYNAMODB_ENDPOINT');
      expect(vars).not.toHaveProperty('AWS_REGION');
    }
  });

  it('connects to PostgreSQL as starter_processor with explicit IAM auth and verify-full (BASE-LMB-007/008)', () => {
    for (const vars of envOf(template)) {
      expect(vars).toMatchObject({
        DB_HOST: expect.anything(),
        DB_PORT: '5432',
        DB_NAME: 'starterapp',
        DB_USER: 'starter_processor',
        DB_AUTH: 'iam',
        DB_SSL: 'verify-full',
        DB_SSL_ROOT_CERT: '/var/task/rds-global-bundle.pem',
        DB_POOL_MAX: '1',
      });
      for (const forbidden of [
        'DB_PASSWORD',
        'DB_SECRET_ARN',
        'APP_RUNTIME',
        'TEST_DOCUMENTS_TABLE_NAME',
      ]) {
        expect(vars).not.toHaveProperty(forbidden);
      }
    }
  });

  it('may connect as starter_processor only (rds-db:connect on dbuser:<DbiResourceId>/starter_processor)', () => {
    const grants = resourcesOf(template, 'AWS::IAM::Policy').flatMap(([, policy]) =>
      (
        policy.PolicyDocument as { Statement: { Action: string | string[]; Resource: unknown }[] }
      ).Statement.filter((s) => [s.Action].flat().includes('rds-db:connect')),
    );
    expect(grants).toHaveLength(2);
    for (const grant of grants)
      expect(JSON.stringify(grant.Resource)).toMatch(/\/starter_processor"/);
    expect(JSON.stringify(stack.resolve(grants))).not.toMatch(
      /starter_app|starter_migrator|starteradmin/,
    );
  });

  it('runs in the app subnets; egress HTTPS to AWS APIs and PostgreSQL (5432) to the DB only', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      VpcConfig: { SubnetIds: f.vpc.privateSubnets.map((s) => s.subnetId) },
    });
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      SecurityGroupEgress: Match.arrayWith([
        Match.objectLike({ CidrIp: '0.0.0.0/0', FromPort: 443, ToPort: 443 }),
      ]),
    });
    template.hasResourceProperties('AWS::EC2::SecurityGroupEgress', {
      IpProtocol: 'tcp',
      FromPort: 5432,
      ToPort: 5432,
      DestinationSecurityGroupId: Match.anyValue(),
    });
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      IpProtocol: 'tcp',
      FromPort: 5432,
      ToPort: 5432,
      SourceSecurityGroupId: Match.anyValue(),
    });
  });

  it('refuses PostgreSQL access from outside the VPC', () => {
    expect(() => build({ network: false })).toThrow(/requires `network` \(VPC\)/);
  });

  it('enables the STEP# audit TTL only when configured (disabled by default)', () => {
    for (const vars of envOf(template)) expect(vars).not.toHaveProperty('JOB_AUDIT_TTL_DAYS');
    for (const vars of envOf(build({ auditRetentionDays: 90 }).template)) {
      expect(vars).toMatchObject({ JOB_AUDIT_TTL_DAYS: '90' });
    }
  });

  it('handler roles: no managed policies, item-level DynamoDB actions only, KMS via DynamoDB', () => {
    for (const [, role] of resourcesOf(template, 'AWS::IAM::Role')) {
      expect(role.ManagedPolicyArns).toBeUndefined();
    }
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'JobTableItemAccess',
            Action: [...HANDLER_TABLE_ACTIONS].sort(),
          }),
          Match.objectLike({
            Sid: 'JobTableKmsViaDynamoDb',
            Resource: f.dataKey.keyArn,
            Condition: {
              StringEquals: { 'kms:ViaService': 'dynamodb.ap-southeast-1.amazonaws.com' },
            },
          }),
        ]),
      },
    });
  });

  it('handler item access is limited to JOB# partitions (dynamodb:LeadingKeys)', () => {
    const itemStatements = resourcesOf(template, 'AWS::IAM::Policy').flatMap(([, policy]) =>
      (
        policy.PolicyDocument as { Statement: { Sid?: string; Condition?: unknown }[] }
      ).Statement.filter((statement) => statement.Sid === 'JobTableItemAccess'),
    );
    // One statement per handler role (validator + processor), each scoped to JOB# items.
    expect(itemStatements).toHaveLength(2);
    for (const statement of itemStatements) {
      expect(statement.Condition).toEqual({
        'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['JOB#*'] },
      });
    }
  });

  it('no IAM statement grants a wildcard action', () => {
    for (const [, policy] of resourcesOf(template, 'AWS::IAM::Policy')) {
      const statements = (policy.PolicyDocument as { Statement: { Action: string | string[] }[] })
        .Statement;
      for (const s of statements) {
        for (const action of [s.Action].flat()) expect(action).not.toMatch(/^\*$|:\*$/);
      }
    }
  });
});

describe('ProcessingWorkflow — Step Functions definition equals the spec', () => {
  const { template, f } = build({ mode: 'test-table' });
  const def = stateMachineDefinition(template);
  const { validate, process } = PROCESSING_WORKFLOW.tasks;

  it('is a STANDARD machine with execution timeout, ALL logging and X-Ray', () => {
    template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
      StateMachineType: 'STANDARD',
      StateMachineName: `starter-test-${PROCESSING_WORKFLOW.name}`,
      LoggingConfiguration: Match.objectLike({ Level: 'ALL', IncludeExecutionData: false }),
      TracingConfiguration: { Enabled: true },
    });
    expect(def.TimeoutSeconds).toBe(PROCESSING_WORKFLOW.executionTimeoutSeconds);
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: `/aws/vendedlogs/states/starter-test-${PROCESSING_WORKFLOW.name}`,
      KmsKeyId: f.logsKey.keyArn,
    });
  });

  it('has exactly the spec states', () => {
    expect(def.StartAt).toBe(ProcessingState.Validate);
    expect(Object.keys(def.States).sort()).toEqual(Object.values(ProcessingState).sort());
    expect(def.States[ProcessingState.Succeeded]!.Type).toBe('Succeed');
    expect(def.States[ProcessingState.Failed]!.Type).toBe('Fail');
  });

  it.each([
    ['validate', validate, ProcessingState.Process],
    ['process', process, ProcessingState.RecordSuccess],
  ] as const)(
    '%s task: retry, timeout, catch, discarded result and transition',
    (_, spec, next) => {
      const state = def.States[spec.state]!;
      expect(state.Type).toBe('Task');
      expect(state.TimeoutSeconds).toBe(spec.timeoutSeconds);
      expect(state.Retry).toEqual(spec.retry.map(toAslRetrier));
      expect(state.Catch).toEqual([
        {
          ErrorEquals: [WorkflowError.Duplicate],
          ResultPath: null,
          Next: ProcessingState.Succeeded,
        },
        {
          ErrorEquals: [...spec.catch],
          ResultPath: '$.error',
          Next: ProcessingState.FailureDefaults,
        },
      ]);
      // Spec 2.0.0: handler results never enter the state data (or the final output).
      expect(state.ResultPath).toBeNull();
      expect(state.Next).toBe(next);
    },
  );

  it('handlers receive exactly the job reference + execution ARN (spec 2.0.0 task event)', () => {
    const event = {
      'jobId.$': '$.jobId',
      'contractVersion.$': '$.contractVersion',
      'submittedAt.$': '$.submittedAt',
      'executionArn.$': '$$.Execution.Id',
    };
    expect(TASK_EVENT_PARAMETERS).toEqual(event);
    // payloadResponseOnly: Parameters is the Lambda event itself.
    for (const task of [validate, process]) {
      const parameters = def.States[task.state]!.Parameters as Record<string, unknown>;
      expect(parameters).toEqual(event);
      expect(Object.keys(parameters).map((k) => k.replace(/\.\$$/, ''))).toEqual([
        ...TASK_EVENT_KEYS,
      ]);
    }
  });

  it('no state reads, writes or forwards document data or analysis results', () => {
    const forbidden = /\$\.(payload|content|title|document|validation|processing|result)\b/;
    for (const [name, state] of Object.entries(def.States)) {
      const text = JSON.stringify(state);
      expect(text, name).not.toMatch(forbidden);
      expect(text, name).not.toMatch(/idempotencyKey/);
    }
  });

  it('invokes the live aliases (not $LATEST)', () => {
    const [, machine] = resourcesOf(template, 'AWS::StepFunctions::StateMachine')[0]!;
    const definition = machine.DefinitionString as { 'Fn::Join': [string, unknown[]] };
    const refs = definition['Fn::Join'][1].filter((p) => typeof p !== 'string');
    const aliasIds = resourcesOf(template, 'AWS::Lambda::Alias').map(([id]) => id);
    expect(refs).toEqual(expect.arrayContaining(aliasIds.map((id) => ({ Ref: id }))));
  });

  type UpdateParams = {
    Key: Record<string, unknown>;
    UpdateExpression: string;
    ConditionExpression: string;
    ExpressionAttributeNames: Record<string, string>;
    ExpressionAttributeValues: Record<string, Record<string, string>>;
  };
  const common = (status: string) => ({
    Key: {
      [Spec.partitionKey]: { 'S.$': "States.Format('JOB#{}', $.jobId)" },
      [Spec.sortKey]: { S: 'STATE' },
    },
    names: {
      '#pk': Spec.partitionKey,
      '#status': Spec.attributes.status,
      '#updatedAt': Spec.attributes.updatedAt,
      '#version': Spec.attributes.version,
      '#gsi1pk': Spec.statusIndex.partitionKey,
      '#gsi1sk': Spec.statusIndex.sortKey,
    },
    values: {
      ':status': { S: status },
      ':updatedAt': { 'S.$': '$$.State.EnteredTime' },
      ':one': { N: '1' },
      ':gsi1pk': { S: `STATUS#${status}` },
      ':gsi1sk': { 'S.$': "States.Format('{}#{}', $$.State.EnteredTime, $.jobId)" },
    },
  });
  const SET_COMMON =
    'SET #status = :status, #updatedAt = :updatedAt, #version = #version + :one, #gsi1pk = :gsi1pk, #gsi1sk = :gsi1sk';

  it('RecordSuccess: conditional native UpdateItem mirroring DynamoDbJobStateStore.recordSuccess', () => {
    const state = def.States[ProcessingState.RecordSuccess]!;
    const params = state.Parameters as UpdateParams;
    const c = common(WorkflowStatus.Succeeded);
    expect(state.Resource).toMatch(/:states:::dynamodb:updateItem$/);
    expect(params.Key).toEqual(c.Key);
    // Spec 2.0.0: the processor stored the result; RecordSuccess only completes the transition,
    // and only when the result is there.
    expect(params.UpdateExpression).toBe(`${SET_COMMON} REMOVE #errorName, #errorMessage`);
    expect(params.ConditionExpression).toBe(
      'attribute_exists(#pk) AND #status IN (:from0) AND attribute_exists(#resultJson)',
    );
    expect(params.ExpressionAttributeNames).toEqual({
      ...c.names,
      '#resultJson': Spec.attributes.result,
      '#errorName': Spec.attributes.errorName,
      '#errorMessage': Spec.attributes.errorMessage,
    });
    expect(params.ExpressionAttributeValues).toEqual({
      ...c.values,
      ':from0': { S: WorkflowStatus.Processing },
    });
    expect(state.Retry).toEqual([toAslRetrier(RECORD_STATE_RETRY)]);
    expect(state.Catch).toEqual([
      {
        ErrorEquals: [CONDITIONAL_CHECK_FAILED],
        ResultPath: null,
        Next: ProcessingState.Succeeded,
      },
      { ErrorEquals: ['States.ALL'], ResultPath: '$.error', Next: ProcessingState.FailureDefaults },
    ]);
    expect(state.Next).toBe(ProcessingState.Succeeded);
    expect(state.TimeoutSeconds).toBe(PROCESSING_WORKFLOW.recordStates.timeoutSeconds);
  });

  it('RecordFailure: conditional native UpdateItem mirroring DynamoDbJobStateStore.recordFailure', () => {
    const state = def.States[ProcessingState.RecordFailure]!;
    const params = state.Parameters as UpdateParams;
    const c = common(WorkflowStatus.Failed);
    expect(params.Key).toEqual(c.Key);
    // A failed job keeps no derived data.
    expect(params.UpdateExpression).toBe(
      `${SET_COMMON}, #errorName = :errorName, #errorMessage = :errorMessage REMOVE #resultJson`,
    );
    expect(params.ExpressionAttributeNames).toMatchObject({
      '#resultJson': Spec.attributes.result,
    });
    expect(params.ConditionExpression).toBe(
      'attribute_exists(#pk) AND #status IN (:from0, :from1, :from2)',
    );
    expect(params.ExpressionAttributeValues).toEqual({
      ...c.values,
      ':errorName': { 'S.$': '$.failure.error.Error' },
      ':errorMessage': { 'S.$': '$.failure.error.Cause' },
      ':from0': { S: WorkflowStatus.Pending },
      ':from1': { S: WorkflowStatus.Validating },
      ':from2': { S: WorkflowStatus.Processing },
    });
    expect(state.Retry).toEqual([toAslRetrier(RECORD_STATE_RETRY)]);
    expect(state.Catch).toEqual([
      {
        ErrorEquals: [CONDITIONAL_CHECK_FAILED],
        ResultPath: '$.recordFailureError',
        Next: ProcessingState.Failed,
      },
      // Anything else must end in an explicit, alarmed Fail — never States.Runtime.
      {
        ErrorEquals: ['States.ALL'],
        ResultPath: '$.recordFailureError',
        Next: ProcessingState.RecordingFailed,
      },
    ]);
    expect(state.Next).toBe(ProcessingState.Failed);
    expect(state.TimeoutSeconds).toBe(PROCESSING_WORKFLOW.recordStates.timeoutSeconds);
    expect(def.States[ProcessingState.Failed]).toMatchObject({
      ErrorPath: '$.failure.error.Error',
      CausePath: '$.failure.error.Cause',
    });
    expect(def.States[ProcessingState.RecordingFailed]).toMatchObject({
      Type: 'Fail',
      Error: 'RecordFailureFailed',
    });
  });

  it('normalises the caught error so RecordFailure never reads a missing Cause', () => {
    expect(def.States[ProcessingState.FailureDefaults]).toEqual({
      Type: 'Pass',
      Comment: expect.any(String),
      Result: { ...FAILURE_DEFAULTS },
      ResultPath: '$.errorDefaults',
      Next: ProcessingState.NormalizeError,
    });
    expect(def.States[ProcessingState.NormalizeError]).toEqual({
      Type: 'Pass',
      Comment: expect.any(String),
      Parameters: { 'error.$': 'States.JsonMerge($.errorDefaults, $.error, false)' },
      ResultPath: '$.failure',
      Next: ProcessingState.RecordFailure,
    });
  });

  it('encrypts the state machine (definition, history, inputs) with the data CMK', () => {
    template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
      EncryptionConfiguration: Match.objectLike({
        Type: 'CUSTOMER_MANAGED_KMS_KEY',
        KmsKeyId: f.dataKey.keyArn,
      }),
    });
  });

  it('terminal-write predecessors equal the @starter/domain job lifecycle', () => {
    for (const status of [WorkflowStatus.Succeeded, WorkflowStatus.Failed] as const) {
      expect([...RECORD_PREDECESSORS[status]].sort()).toEqual(
        [...allowedPredecessors(status)].sort(),
      );
    }
  });

  it('state machine role: UpdateItem on the table + KMS via DynamoDB only', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Action: 'dynamodb:UpdateItem' }),
          Match.objectLike({ Sid: 'JobTableKmsViaDynamoDb' }),
        ]),
      },
    });
  });
});

describe('ProcessingWorkflow — mini-stack document source (TEST ONLY, ADR 0232)', () => {
  const { template } = build({ mode: 'test-table' });

  it('reads the test document table instead of PostgreSQL', () => {
    for (const vars of envOf(template)) {
      expect(vars).toMatchObject({ TEST_DOCUMENTS_TABLE_NAME: expect.anything() });
      expect(Object.keys(vars).filter((k) => k.startsWith('DB_'))).toEqual([]);
    }
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Sid: 'TestDocumentTableRead', Action: 'dynamodb:GetItem' }),
        ]),
      },
    });
  });
});

describe('ProcessingWorkflow — policy', () => {
  it.each(['postgres', 'test-table'] as const)('passes cdk-nag (%s)', (mode) => {
    // The workflow's own resources (the test database is the RelationalDatabase construct).
    expect(nagViolations(build({ mode }).workflow)).toEqual([]);
  });

  it('bundles locally with esbuild (no Docker) into ESM assets, with the RDS CA bundle', () => {
    requirePnpmOnPath();
    const { app, template } = build({ bundle: true });
    const assembly = app.synth();
    for (const [, fn] of resourcesOf(template, 'AWS::Lambda::Function')) {
      const key = (fn.Code as { S3Key: string }).S3Key;
      expect(key).toMatch(/^[a-f0-9]{64}\.zip$/);
      const assetDir = path.join(assembly.directory, `asset.${key.replace(/\.zip$/, '')}`);
      expect(existsSync(path.join(assetDir, 'index.mjs'))).toBe(true);
      expect(existsSync(path.join(assetDir, 'rds-global-bundle.pem'))).toBe(true);
    }
  });
});
