import { TEST_FAULT_ATTRIBUTE, TEST_FAULT_INJECTION_ENV } from '@starter/documents/test-faults';
import { PROCESSING_WORKFLOW } from '@starter/workflow-processing';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { buildSync } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { ALL_ENVIRONMENT_NAMES } from '../environments/index.js';
import { handlerEntries } from '../lib/lambda-entries.js';
import {
  DEFAULT_EXPERIMENT,
  DEFAULT_INTEGRATION_QUALIFIER,
  DEFAULT_TEST_EXECUTION_TIMEOUT_SECONDS,
  EPHEMERAL_TAGS,
  IntegrationWorkflowStack,
  STATE_MACHINE_ALIAS,
  integrationRequiredTags,
  resolveExecutionTimeout,
  resolveExpiresAt,
  resolveIntegrationAccount,
  assertEmulatorAccount,
  resolveDeployTarget,
  resolveOperatorPrincipalArn,
  OFFLINE_OPERATOR_ROLE_NAME,
  KEY_PROBE_SESSION_NAME,
  assertEmulatorRegion,
  validateRegion,
  validateQualifier,
  validateRunId,
  type IntegrationWorkflowStackProps,
} from '../stacks/integration-workflow-stack.js';
import { EMULATOR_ACCOUNT, EMULATOR_REGION, EmulatorGuardRefusal } from '../lib/emulator-guard.js';
import {
  FIXTURE_ENTRIES,
  nagViolations,
  newApp,
  requirePnpmOnPath,
  resourcesOf,
  stateMachineDefinition,
  synthStage,
} from './helpers.js';
import { useSandboxAdoptedRegisters } from './policy-registers.js';

// The Sandbox stage (in ALL_ENVIRONMENT_NAMES) needs the sandbox example register, adopted in memory.
useSandboxAdoptedRegisters();

const TAGS = integrationRequiredTags({ costCentre: 'CC-1' });
/** An IAM Identity Center permission-set role: the ARN carries a path. */
const OPERATOR =
  'arn:aws:iam::000000000000:role/aws-reserved/sso.amazonaws.com/ap-southeast-1/AWSReservedSSO_ExampleDeveloper_0123456789abcdef';

function build(bundle = false, overrides: Partial<IntegrationWorkflowStackProps> = {}) {
  const app = newApp({ bundle });
  const stack = new IntegrationWorkflowStack(app, 'IntegrationWorkflowStack', {
    env: { region: 'ap-southeast-1' },
    runId: 'mr42-abc1',
    expiresAt: '2030-01-01T06:00:00.000Z',
    handlerEntries: FIXTURE_ENTRIES,
    permissionsBoundaryArn: 'arn:aws:iam::000000000000:policy/SandboxBoundary',
    requiredTags: TAGS,
    executionTimeoutSeconds: DEFAULT_TEST_EXECUTION_TIMEOUT_SECONDS,
    ...overrides,
  });
  return { app, stack, template: Template.fromStack(stack) };
}

type Statement = {
  Sid?: string;
  Action: string | string[];
  Resource: unknown;
  Condition?: unknown;
};

/** Identity statements attached to the role whose logical id starts with `rolePrefix`. */
function roleStatements(template: Template, rolePrefix: string): Statement[] {
  return resourcesOf(template, 'AWS::IAM::Policy')
    .filter(([, p]) => (p.Roles as { Ref: string }[]).some((r) => r.Ref.startsWith(rolePrefix)))
    .flatMap(([, p]) => (p.PolicyDocument as { Statement: Statement[] }).Statement);
}

describe('IntegrationWorkflowStack', () => {
  const { stack, template } = build();

  it('is uniquely named from the run id', () => {
    expect(stack.stackName).toBe('starter-it-mr42-abc1');
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'starter-it-mr42-abc1-job-state',
    });
    template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
      StateMachineName: 'starter-it-mr42-abc1-job-processing',
    });
  });

  it('contains only the tables, the three functions and the workflow (no VPC, no shared resources)', () => {
    const types = new Set(
      Object.values(template.toJSON().Resources as Record<string, { Type: string }>).map(
        (r) => r.Type,
      ),
    );
    expect([...types].sort()).toEqual(
      [
        'AWS::DynamoDB::Table',
        'AWS::IAM::Policy',
        'AWS::IAM::Role',
        'AWS::KMS::Key',
        'AWS::Lambda::Alias',
        'AWS::Lambda::EventInvokeConfig',
        'AWS::Lambda::Function',
        'AWS::Lambda::Version',
        'AWS::Logs::LogGroup',
        'AWS::StepFunctions::StateMachine',
        'AWS::StepFunctions::StateMachineAlias',
        'AWS::StepFunctions::StateMachineVersion',
      ].sort(),
    );
  });

  it('everything is destroyable (no RETAIN, no deletion protection)', () => {
    for (const r of Object.values(
      template.toJSON().Resources as Record<
        string,
        { DeletionPolicy?: string; UpdateReplacePolicy?: string }
      >,
    )) {
      expect(r.DeletionPolicy ?? 'Delete').toBe('Delete');
      expect(r.UpdateReplacePolicy ?? 'Delete').toBe('Delete');
    }
    template.hasResourceProperties('AWS::DynamoDB::Table', { DeletionProtectionEnabled: false });
    expect(stack.terminationProtection).toBe(false);
  });

  it('keeps the experiment cheap to leave: 1-day logs, 7-day KMS deletion window', () => {
    const groups = resourcesOf(template, 'AWS::Logs::LogGroup');
    expect(groups).toHaveLength(4);
    for (const [, group] of groups) expect(group.RetentionInDays).toBe(1);
    template.hasResource('AWS::KMS::Key', {
      Properties: Match.objectLike({ PendingWindowInDays: 7, EnableKeyRotation: true }),
      DeletionPolicy: 'Delete',
    });
  });

  it('carries sweeper tags and the required tags', () => {
    expect(stack.tags.tagValues()).toMatchObject({
      [EPHEMERAL_TAGS.ephemeral]: 'true',
      [EPHEMERAL_TAGS.runId]: 'mr42-abc1',
      [EPHEMERAL_TAGS.expiresAt]: '2030-01-01T06:00:00.000Z',
      [EPHEMERAL_TAGS.experiment]: DEFAULT_EXPERIMENT,
      ...TAGS,
    });
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      Tags: Match.arrayWith([{ Key: 'Environment', Value: 'dev' }]),
    });
  });

  it('defaults to the sandbox tag values (Environment stays dev: BASE-TAG-002)', () => {
    expect(integrationRequiredTags()).toEqual({
      Project: 'aws-modernization-starter',
      Environment: 'dev',
      Owner: 'sandbox-operator',
      CostCentre: 'sandbox',
      DataClassification: 'Synthetic',
      ManagedBy: 'aws-cdk',
    });
    const { stack: tagged } = build(false, { experiment: 'v9-test' });
    expect(tagged.tags.tagValues()[EPHEMERAL_TAGS.experiment]).toBe('v9-test');
    expect(() => build(false, { experiment: 'bad value!' })).toThrow(/experiment/);
  });

  it('uses the starter bootstrap (qualifier, roles, assets, version parameter) by default', () => {
    const { app } = build();
    const manifest = app.synth().getStackArtifact('IntegrationWorkflowStack');
    expect(manifest.assumeRoleArn).toContain(`cdk-${DEFAULT_INTEGRATION_QUALIFIER}-deploy-role-`);
    expect(manifest.cloudFormationExecutionRoleArn).toContain(
      `cdk-${DEFAULT_INTEGRATION_QUALIFIER}-cfn-exec-role-`,
    );
    expect(manifest.stackTemplateAssetObjectUrl).toContain(
      `cdk-${DEFAULT_INTEGRATION_QUALIFIER}-assets-`,
    );
    expect(manifest.bootstrapStackVersionSsmParameter).toBe('/cdk-bootstrap/starter/version');
    const { app: other } = build(false, { qualifier: 'abc123' });
    expect(other.synth().getStackArtifact('IntegrationWorkflowStack').assumeRoleArn).toContain(
      'cdk-abc123-deploy-role-',
    );
    expect(() => validateQualifier('Has-Caps')).toThrow(/qualifier/);
  });

  it('applies the optional permissions boundary to every role', () => {
    for (const [, role] of resourcesOf(template, 'AWS::IAM::Role')) {
      expect(role.PermissionsBoundary).toBe('arn:aws:iam::000000000000:policy/SandboxBoundary');
    }
  });

  it('has no PostgreSQL: handlers read the TEST-ONLY document table, the reconciler is not scheduled', () => {
    template.resourceCountIs('AWS::RDS::DBInstance', 0);
    template.resourceCountIs('AWS::Events::Rule', 0);
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'starter-it-mr42-abc1-test-documents',
      SSESpecification: { SSEEnabled: true, SSEType: 'KMS' },
    });
    const vars = resourcesOf(template, 'AWS::Lambda::Function').map(
      ([, fn]) => (fn.Environment as { Variables: Record<string, unknown> }).Variables,
    );
    const steps = vars.filter((v) => 'TEST_DOCUMENTS_TABLE_NAME' in v);
    expect(steps).toHaveLength(2);
    for (const v of vars) expect(Object.keys(v).filter((k) => k.startsWith('DB_'))).toEqual([]);
  });

  it('exposes the outputs the integration tests need', () => {
    const outputs = Object.keys(template.toJSON().Outputs as object);
    expect(outputs).toEqual(
      expect.arrayContaining([
        'RunId',
        'ExpiresAt',
        'Region',
        'StateMachineArn',
        'JobsTableName',
        'ValidatorFunctionName',
        'ProcessorFunctionName',
        'ValidatorAliasArn',
        'ProcessorAliasArn',
        'StateMachineLogGroupName',
        'TestDocumentsTableName',
        'ReconcilerFunctionName',
        'ExecutionTimeoutSeconds',
        'StateMachineVersionArn',
        'StateMachineAliasArn',
        'KeyArn',
        'ValidatorRoleArn',
        'ProcessorRoleArn',
        'ReconcilerRoleArn',
        'StateMachineRoleArn',
        'KeyProbeRoleArn',
        'ValidatorLogGroupName',
        'ProcessorLogGroupName',
        'ReconcilerLogGroupName',
      ]),
    );
  });

  it('publishes the deployed revision as a version behind the `live` alias (100 %)', () => {
    const versions = resourcesOf(template, 'AWS::StepFunctions::StateMachineVersion');
    expect(versions).toHaveLength(1);
    const [versionId, version] = versions[0]!;
    const [machineId] = resourcesOf(template, 'AWS::StepFunctions::StateMachine')[0]!;
    expect(version).toMatchObject({
      StateMachineArn: { Ref: machineId },
      // A new version whenever the definition changes (CloudFormation replaces the version).
      StateMachineRevisionId: { 'Fn::GetAtt': [machineId, 'StateMachineRevisionId'] },
    });
    template.hasResourceProperties('AWS::StepFunctions::StateMachineAlias', {
      Name: STATE_MACHINE_ALIAS,
      RoutingConfiguration: [
        { StateMachineVersionArn: { 'Fn::GetAtt': [versionId, 'Arn'] }, Weight: 100 },
      ],
    });
  });

  it('shortens ONLY the execution timeout (default 45 s); task timeouts, retries and catches stay the spec ones', () => {
    const short = stateMachineDefinition(template);
    expect(short.TimeoutSeconds).toBe(DEFAULT_TEST_EXECUTION_TIMEOUT_SECONDS);
    const { template: spec } = build(false, { executionTimeoutSeconds: undefined });
    const full = stateMachineDefinition(spec);
    expect(full.TimeoutSeconds).toBe(PROCESSING_WORKFLOW.executionTimeoutSeconds);
    expect(short.States).toEqual(full.States);
    expect(template.toJSON().Outputs.ExecutionTimeoutSeconds.Value).toBe('45');
  });

  it('arms TEST fault injection on the two step functions only', () => {
    const fns = resourcesOf(template, 'AWS::Lambda::Function').map(
      ([, fn]) => (fn.Environment as { Variables: Record<string, unknown> }).Variables,
    );
    const armed = fns.filter((v) => v.TEST_FAULT_INJECTION === 'enabled');
    expect(armed).toHaveLength(2);
    for (const v of armed) expect(v).toHaveProperty('TEST_DOCUMENTS_TABLE_NAME');
  });

  it('KeyProbeRole: job-table read only, no KMS grant, assumable by the operator role only', () => {
    const { template: t } = build(false, { operatorPrincipalArn: OPERATOR });
    const roles = resourcesOf(t, 'AWS::IAM::Role').filter(([id]) => id.startsWith('KeyProbeRole'));
    expect(roles).toHaveLength(1);
    expect(roles[0]![1].AssumeRolePolicyDocument).toEqual({
      Version: '2012-10-17',
      Statement: [
        {
          Action: 'sts:AssumeRole',
          Effect: 'Allow',
          Principal: { AWS: OPERATOR },
          // Only under the session name the KMS test uses.
          Condition: { StringEquals: { 'sts:RoleSessionName': KEY_PROBE_SESSION_NAME } },
        },
      ],
    });
    expect(KEY_PROBE_SESSION_NAME).toBe('starter-it-kms-probe');
    const statements = roleStatements(t, 'KeyProbeRole');
    expect(statements).toEqual([
      expect.objectContaining({
        Action: ['dynamodb:DescribeTable', 'dynamodb:GetItem'],
        Resource: { 'Fn::GetAtt': [expect.stringMatching(/^JobStateTable/), 'Arn'] },
      }),
    ]);
    expect(JSON.stringify(statements)).not.toMatch(/kms:/);
    // The key policy grants nothing to the probe either.
    const keys = resourcesOf(t, 'AWS::KMS::Key');
    expect(keys).toHaveLength(1);
    expect(JSON.stringify(keys[0]![1].KeyPolicy)).not.toMatch(/KeyProbeRole/);
  });

  it('grants the operator role the CMK only via DynamoDB, Step Functions and Logs, plus key metadata', () => {
    const { template: t } = build(false, { operatorPrincipalArn: OPERATOR });
    const keys = resourcesOf(t, 'AWS::KMS::Key');
    const policy = keys[0]![1].KeyPolicy as {
      Statement: { Sid?: string; Principal?: unknown; Action: unknown; Condition?: unknown }[];
    };
    const operatorStatements = policy.Statement.filter(
      (st) => JSON.stringify(st.Principal) === JSON.stringify({ AWS: OPERATOR }),
    );
    expect(operatorStatements).toEqual([
      expect.objectContaining({
        Sid: 'OperatorUseViaDataServices',
        Action: [
          'kms:Decrypt',
          'kms:DescribeKey',
          'kms:Encrypt',
          'kms:GenerateDataKey*',
          'kms:ReEncrypt*',
        ],
        Condition: {
          StringEquals: {
            'kms:ViaService': [
              'dynamodb.ap-southeast-1.amazonaws.com',
              'states.ap-southeast-1.amazonaws.com',
              'logs.ap-southeast-1.amazonaws.com',
            ],
          },
        },
      }),
      expect.objectContaining({
        Sid: 'OperatorReadKeyMetadata',
        Action: ['kms:DescribeKey', 'kms:GetKeyRotationStatus'],
      }),
    ]);
    expect(operatorStatements[1]!.Condition).toBeUndefined();
  });

  it('offline (no operator given): a non-deployable placeholder principal', () => {
    const text = JSON.stringify(template.toJSON());
    expect(text).toContain(`:role/${OFFLINE_OPERATOR_ROLE_NAME}`);
  });

  it('passes cdk-nag', () => {
    expect(nagViolations(stack)).toEqual([]);
  });

  it('bundles the handlers locally (no Docker)', () => {
    requirePnpmOnPath();
    const { template: bundled } = build(true);
    expect(resourcesOf(bundled, 'AWS::Lambda::Function')).toHaveLength(3);
  });
});

describe('stage templates never carry the mini-stack test hooks', () => {
  it.each([...ALL_ENVIRONMENT_NAMES])(
    '%s: no fault injection, no version/alias, spec timeout',
    (name) => {
      const { templates } = synthStage(name);
      const wf = templates.Workflow;
      const functions = resourcesOf(wf, 'AWS::Lambda::Function');
      expect(functions.length).toBeGreaterThanOrEqual(3);
      for (const [, fn] of functions) {
        const vars = (fn.Environment as { Variables: Record<string, unknown> }).Variables;
        expect(vars).not.toHaveProperty(TEST_FAULT_INJECTION_ENV);
        expect(vars).not.toHaveProperty('TEST_DOCUMENTS_TABLE_NAME');
      }
      expect(resourcesOf(wf, 'AWS::StepFunctions::StateMachineVersion')).toEqual([]);
      expect(resourcesOf(wf, 'AWS::StepFunctions::StateMachineAlias')).toEqual([]);
      expect(stateMachineDefinition(wf).TimeoutSeconds).toBe(
        PROCESSING_WORKFLOW.executionTimeoutSeconds,
      );
      // The sandbox stage is checked like the governed stages.
      expect(ALL_ENVIRONMENT_NAMES).toContain('sandbox');
    },
  );
});

/** Minified ESM bundle of a handler entry, as NodejsFunction builds it (no Docker, in memory). */
function bundleText(entry: string): string {
  const out = buildSync({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    mainFields: ['module', 'main'],
    minify: true,
    write: false,
    logLevel: 'silent',
  });
  return out.outputFiles.map((f) => f.text).join('');
}

describe('handler bundles: fault injection exists in the mini-stack entries only', () => {
  const stage = handlerEntries('source', 'stage');
  const integration = handlerEntries('source', 'integration');

  it.each(['validator', 'processor'] as const)(
    '%s: the stage bundle has no fault code; the integration bundle has it (control)',
    (name) => {
      const stageBundle = bundleText(stage[name]);
      expect(stageBundle).not.toContain(TEST_FAULT_INJECTION_ENV);
      expect(stageBundle).not.toContain(TEST_FAULT_ATTRIBUTE);
      const integrationBundle = bundleText(integration[name]);
      expect(integrationBundle).toContain(TEST_FAULT_INJECTION_ENV);
      expect(integrationBundle).toContain(TEST_FAULT_ATTRIBUTE);
    },
  );

  it('reconciler (one entry for stages and mini-stack) has no fault code', () => {
    expect(bundleText(stage.reconciler)).not.toContain(TEST_FAULT_INJECTION_ENV);
  });
});

describe('account pin', () => {
  it('pins -c account and accepts matching credentials', () => {
    expect(resolveIntegrationAccount({ contextAccount: '111122223333' })).toBe('111122223333');
    expect(
      resolveIntegrationAccount({
        contextAccount: '111122223333',
        cdkDefaultAccount: '111122223333',
      }),
    ).toBe('111122223333');
  });

  it('stays environment-agnostic offline (no credentials, no pin)', () => {
    expect(resolveIntegrationAccount({})).toBeUndefined();
    expect(resolveIntegrationAccount({ cdkDefaultAccount: '' })).toBeUndefined();
  });

  it('refuses to synthesize for AWS without the pin or with another account (masked in the message)', () => {
    expect(() => resolveIntegrationAccount({ cdkDefaultAccount: '111122223333' })).toThrow(
      /Refusing.*-c account.*\*{8}3333/,
    );
    let message = '';
    try {
      resolveIntegrationAccount({
        contextAccount: '444455556666',
        cdkDefaultAccount: '111122223333',
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/mismatch/);
    expect(message).not.toMatch(/111122223333|444455556666/);
    expect(() => resolveIntegrationAccount({ contextAccount: '12345' })).toThrow(/12 digits/);
  });
});

describe('operator principal', () => {
  it('accepts an IAM role ARN with a path in the stack account', () => {
    expect(
      resolveOperatorPrincipalArn({
        contextValue: OPERATOR,
        account: '000000000000',
        cdkDefaultAccount: '000000000000',
      }),
    ).toBe(OPERATOR);
    expect(
      resolveOperatorPrincipalArn({ contextValue: 'arn:aws:iam::000000000000:role/Operator' }),
    ).toBe('arn:aws:iam::000000000000:role/Operator');
  });

  it('is optional offline and required once credentials resolved (deploy, destroy)', () => {
    expect(resolveOperatorPrincipalArn({})).toBeUndefined();
    expect(() => resolveOperatorPrincipalArn({ cdkDefaultAccount: '000000000000' })).toThrow(
      /Refusing.*operatorPrincipalArn/,
    );
  });

  it.each([
    [
      'an assumed-role session ARN',
      'arn:aws:sts::000000000000:assumed-role/Operator/me',
      /session/,
    ],
    ['the account root', 'arn:aws:iam::000000000000:root', /expected arn/],
    ['a user', 'arn:aws:iam::000000000000:user/me', /expected arn/],
    ['a wildcard', 'arn:aws:iam::000000000000:role/*', /expected arn/],
    ['another account', 'arn:aws:iam::111122223333:role/Operator', /not the stack account/],
  ])('rejects %s', (_label, value, message) => {
    expect(() =>
      resolveOperatorPrincipalArn({ contextValue: value, account: '000000000000' }),
    ).toThrow(message);
  });
});

describe('region and environment pin', () => {
  it('defaults to ap-southeast-1 and accepts another aws-partition region', () => {
    expect(validateRegion(undefined)).toBe('ap-southeast-1');
    expect(validateRegion('')).toBe('ap-southeast-1');
    expect(validateRegion('ap-southeast-1')).toBe('ap-southeast-1');
    expect(validateRegion('eu-west-1')).toBe('eu-west-1');
  });

  it.each([
    ['a malformed name', 'Nowhere', /Invalid -c region="Nowhere"/],
    ['an AZ instead of a region', 'eu-west-1a', /Invalid -c region=/],
    ['the China partition', 'cn-north-1', /Unsupported -c region=cn-north-1: .*aws-cn partition/],
    ['GovCloud', 'us-gov-west-1', /Unsupported -c region=us-gov-west-1: .*aws-us-gov/],
  ])('refuses %s', (_label, value, message) => {
    expect(() => validateRegion(value)).toThrow(message);
  });

  it('synthesizes in the configured region (env, ARNs and service principals follow it)', () => {
    const { stack, template } = build(false, {
      env: { account: '000000000000', region: 'eu-west-1' },
      operatorPrincipalArn: OPERATOR,
    });
    expect(stack.region).toBe('eu-west-1');
    const json = JSON.stringify(template.toJSON());
    expect(json).toContain('logs.eu-west-1.amazonaws.com');
    expect(json).toContain('dynamodb.eu-west-1.amazonaws.com');
    // The operator fixture is an IAM Identity Center role whose PATH names its home region.
    expect(json.replaceAll(OPERATOR, '<operator>')).not.toContain('ap-southeast-1');
  });

  it('an environment-agnostic (offline) template carries a rule that refuses any deployment', () => {
    const { template: offline } = build();
    const rules = offline.toJSON().Rules as Record<string, { Assertions: unknown[] }>;
    expect(rules.OfflineSynthOnly).toEqual({
      Assertions: [
        {
          Assert: { 'Fn::Equals': ['environment-agnostic', 'pinned'] },
          AssertDescription: expect.stringMatching(/-c account/),
        },
      ],
    });
  });

  it('a pinned template (account + region) has no such rule', () => {
    const { stack: pinned, template: t } = build(false, {
      env: { account: '000000000000', region: 'ap-southeast-1' },
      operatorPrincipalArn: OPERATOR,
    });
    expect(pinned.account).toBe('000000000000');
    expect(pinned.region).toBe('ap-southeast-1');
    expect(Object.keys(t.toJSON().Rules ?? {})).not.toContain('OfflineSynthOnly');
  });

  it('refuses an invalid or unsupported region in the stack props too', () => {
    expect(() => build(false, { env: { region: 'cn-north-1' } })).toThrow(/aws-cn partition/);
    expect(() => build(false, { env: { region: 'eu-west' } })).toThrow(/Invalid -c region/);
  });

  it('the emulator variant runs only in the emulator region', () => {
    expect(() => assertEmulatorRegion(EMULATOR_REGION)).not.toThrow();
    expect(() => assertEmulatorRegion('eu-west-1')).toThrow(
      `-c target=emulator requires -c region=${EMULATOR_REGION}`,
    );
  });
});

describe('emulator variant (-c target=emulator)', () => {
  it('omits only the state machine version and alias, and says where it may run', () => {
    const { template: aws } = build();
    const { template: emu } = build(false, { emulator: true });
    expect(resourcesOf(emu, 'AWS::StepFunctions::StateMachineVersion')).toEqual([]);
    expect(resourcesOf(emu, 'AWS::StepFunctions::StateMachineAlias')).toEqual([]);
    const types = (t: Template) =>
      Object.values(t.toJSON().Resources as Record<string, { Type: string }>)
        .map((r) => r.Type)
        .filter((type) => !type.startsWith('AWS::StepFunctions::StateMachine'))
        .sort();
    expect(types(emu)).toEqual(types(aws));
    expect(stateMachineDefinition(emu)).toEqual(stateMachineDefinition(aws));
    expect(emu.toJSON().Outputs.DeployTarget.Value).toBe('ministack-emulator');
    expect(aws.toJSON().Outputs.DeployTarget.Value).toBe('aws');
    expect(Object.keys(emu.toJSON().Outputs as object)).not.toContain('StateMachineAliasArn');
  });

  const emulatorEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    AWS_ENDPOINT_URL: 'http://127.0.0.1:45660',
    AWS_ACCESS_KEY_ID: EMULATOR_ACCOUNT,
    AWS_SECRET_ACCESS_KEY: 'ministack-local-only',
    AWS_CONFIG_FILE: '/dev/null',
    AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
    AWS_EC2_METADATA_DISABLED: 'true',
    // The CDK CLI phone-home switches the shared guard requires.
    CDK_DISABLE_CLI_TELEMETRY: 'true',
    CDK_DISABLE_VERSION_CHECK: 'true',
    ...extra,
  });

  it('is only synthesized in an environment the shared emulator guard accepts', () => {
    expect(resolveDeployTarget(undefined, {})).toBe('aws');
    expect(resolveDeployTarget('aws', emulatorEnv())).toBe('aws');
    expect(resolveDeployTarget('emulator', emulatorEnv())).toBe('emulator');
    expect(
      resolveDeployTarget('emulator', emulatorEnv({ AWS_ENDPOINT_URL: 'http://127.0.0.1:4566/' })),
    ).toBe('emulator');
    // Only the loopback literal, never the name `localhost`.
    expect(() =>
      resolveDeployTarget('emulator', emulatorEnv({ AWS_ENDPOINT_URL: 'http://localhost:4566/' })),
    ).toThrow(EmulatorGuardRefusal);
    expect(
      resolveDeployTarget(
        'emulator',
        emulatorEnv({
          GITLAB_CI: 'true',
          STARTER_EMULATOR_MODE: 'ci-service',
          STARTER_EMULATOR_ALLOWED_ENDPOINT: 'http://ministack:4566',
          AWS_ENDPOINT_URL: 'http://ministack:4566',
        }),
      ),
    ).toBe('emulator');
    expect(() =>
      resolveDeployTarget('emulator', emulatorEnv({ AWS_ENDPOINT_URL: undefined })),
    ).toThrow(EmulatorGuardRefusal);
    expect(() =>
      resolveDeployTarget(
        'emulator',
        emulatorEnv({ AWS_ENDPOINT_URL: 'https://cloudformation.ap-southeast-1.amazonaws.com' }),
      ),
    ).toThrow(/loopback/);
    expect(() =>
      resolveDeployTarget('emulator', emulatorEnv({ AWS_ENDPOINT_URL: 'http://ministack:4566' })),
    ).toThrow(/loopback/);
    expect(() => resolveDeployTarget('emulator', emulatorEnv({ AWS_PROFILE: 'sandbox' }))).toThrow(
      /AWS_PROFILE/,
    );
    expect(() => resolveDeployTarget('localstack', emulatorEnv())).toThrow(/target/);
  });

  it('runs only in the fake emulator account', () => {
    expect(() => assertEmulatorAccount(EMULATOR_ACCOUNT)).not.toThrow();
    expect(() => assertEmulatorAccount(undefined)).toThrow(/000000000001/);
    expect(() => assertEmulatorAccount('123456789012')).toThrow(/000000000001/);
  });
});

describe('execution timeout context', () => {
  it('defaults to the short test timeout; "spec" deploys the spec value', () => {
    expect(resolveExecutionTimeout(undefined)).toBe(DEFAULT_TEST_EXECUTION_TIMEOUT_SECONDS);
    expect(resolveExecutionTimeout('50')).toBe(50);
    expect(resolveExecutionTimeout('spec')).toBeUndefined();
    expect(resolveExecutionTimeout(String(PROCESSING_WORKFLOW.executionTimeoutSeconds))).toBe(
      undefined,
    );
  });

  it.each(['29', '601', 'abc', '45.5'])('rejects %s', (value) => {
    expect(() => resolveExecutionTimeout(value)).toThrow(/executionTimeoutSeconds/);
  });
});

describe('run id and expiry validation', () => {
  it.each(['ab', 'UPPER', '-lead', 'trail-', 'has_underscore', 'x'.repeat(25), undefined, 42])(
    'rejects runId %s',
    (v) => {
      expect(() => validateRunId(v)).toThrow(/runId/);
    },
  );

  it.each(['abc', 'mr42-abc1', 'p-1234567890abcdef', 'a'.repeat(24)])('accepts runId %s', (v) => {
    expect(validateRunId(v)).toBe(v);
  });

  it('computes expiry from ttlHours (default 6h) or validates an explicit expiresAt', () => {
    const now = new Date('2026-10-13T00:00:00.000Z');
    expect(resolveExpiresAt(() => undefined, now)).toBe('2026-10-13T06:00:00.000Z');
    expect(resolveExpiresAt((k) => (k === 'ttlHours' ? '2' : undefined), now)).toBe(
      '2026-10-13T02:00:00.000Z',
    );
    expect(() => resolveExpiresAt((k) => (k === 'ttlHours' ? '0' : undefined), now)).toThrow(
      /ttlHours/,
    );
    expect(() =>
      resolveExpiresAt((k) => (k === 'expiresAt' ? '2026-10-12T00:00:00Z' : undefined), now),
    ).toThrow(/expiresAt/);
    expect(
      resolveExpiresAt((k) => (k === 'expiresAt' ? '2026-10-13T12:00:00Z' : undefined), now),
    ).toBe('2026-10-13T12:00:00.000Z');
  });
});
