import { describe, expect, it } from 'vitest';
import {
  NOT_ENFORCED_PROPERTIES,
  UNCOMPARED_PROPERTIES,
  UNSUPPORTED_PROPERTIES,
  UnresolvableTokenError,
  canonical,
  classifyUncovered,
  isDefaultReadBack,
  parsePolicyDocument,
  reconcile,
  resolveTokens,
  sameJson,
  settledFunctionConfiguration,
  verifyDestroyed,
  verifyUpdate,
  type EmulatorReader,
  type PropertyCheck,
  type SettleOptions,
  type StackResourceInfo,
  type Template,
  type TemplateResource,
} from './emulator-reconcile.js';

const REGION = 'ap-southeast-1';
const ACCOUNT = '000000000001';
const STACK = 'starter-it-em-abc123';
const arn = (service: string, rest: string) => `arn:aws:${service}:${REGION}:${ACCOUNT}:${rest}`;
const FN = `${STACK}-Fn-1`;
const FN_ARN = arn('lambda', `function:${FN}`);
const TABLE = `${STACK}-job-state`;
const TABLE_ARN = arn('dynamodb', `table/${TABLE}`);
const KEY_ID = '11111111-2222-3333-4444-555555555555';
const KEY_ARN = arn('kms', `key/${KEY_ID}`);
const ROLE = `${STACK}-Role-1`;
const ROLE_ARN = `arn:aws:iam::${ACCOUNT}:role/${ROLE}`;
const SM_ARN = arn('states', `stateMachine:${STACK}-job-processing`);
const LOG = `/starter/${STACK}/lambda/fn`;
const POLICY_DOC = {
  Version: '2012-10-17',
  Statement: [
    { Effect: 'Allow', Action: 'dynamodb:GetItem', Resource: { 'Fn::GetAtt': ['Table', 'Arn'] } },
  ],
};
const TRUST = {
  Version: '2012-10-17',
  Statement: [
    { Effect: 'Allow', Action: 'sts:AssumeRole', Principal: { Service: 'lambda.amazonaws.com' } },
  ],
};
const ASL = (fnArn: unknown) => ({
  'Fn::Join': [
    '',
    [
      '{"StartAt":"A","TimeoutSeconds":45,"States":{"A":{"Type":"Task","Resource":"',
      fnArn,
      '","End":true}}}',
    ],
  ],
});

const template: Template = {
  Resources: {
    CDKMetadata: { Type: 'AWS::CDK::Metadata', Properties: { Analytics: 'v2:deflate64:x' } },
    Key: {
      Type: 'AWS::KMS::Key',
      Properties: {
        Description: 'cmk',
        EnableKeyRotation: true,
        KeyPolicy: { Version: '2012-10-17', Statement: [] },
      },
    },
    Table: {
      Type: 'AWS::DynamoDB::Table',
      Properties: {
        TableName: TABLE,
        BillingMode: 'PAY_PER_REQUEST',
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      },
    },
    Logs: {
      Type: 'AWS::Logs::LogGroup',
      Properties: {
        LogGroupName: LOG,
        RetentionInDays: 1,
        KmsKeyId: { 'Fn::GetAtt': ['Key', 'Arn'] },
      },
    },
    Role: { Type: 'AWS::IAM::Role', Properties: { AssumeRolePolicyDocument: TRUST } },
    Policy: {
      Type: 'AWS::IAM::Policy',
      Properties: {
        PolicyName: 'RolePolicy',
        PolicyDocument: POLICY_DOC,
        Roles: [{ Ref: 'Role' }],
      },
    },
    Fn: {
      Type: 'AWS::Lambda::Function',
      Properties: {
        Runtime: 'nodejs24.x',
        Handler: 'index.handler',
        Timeout: 20,
        MemorySize: 512,
        Architectures: ['arm64'],
        Role: { 'Fn::GetAtt': ['Role', 'Arn'] },
        Environment: { Variables: { TABLE: { Ref: 'Table' }, LOG_LEVEL: 'debug' } },
      },
    },
    FnVersion: { Type: 'AWS::Lambda::Version', Properties: { FunctionName: { Ref: 'Fn' } } },
    FnAlias: {
      Type: 'AWS::Lambda::Alias',
      Properties: {
        Name: 'live',
        FunctionName: { Ref: 'Fn' },
        FunctionVersion: { 'Fn::GetAtt': ['FnVersion', 'Version'] },
      },
    },
    Machine: {
      Type: 'AWS::StepFunctions::StateMachine',
      Properties: {
        StateMachineName: `${STACK}-job-processing`,
        RoleArn: { 'Fn::GetAtt': ['Role', 'Arn'] },
        DefinitionString: ASL({ 'Fn::GetAtt': ['Fn', 'Arn'] }),
      },
    },
  },
};

const stackResources = (): StackResourceInfo[] => [
  {
    logicalId: 'CDKMetadata',
    type: 'AWS::CDK::Metadata',
    physicalId: 'CDKMetadata-CDKMetadata',
    status: 'CREATE_COMPLETE',
  },
  { logicalId: 'Key', type: 'AWS::KMS::Key', physicalId: KEY_ID, status: 'CREATE_COMPLETE' },
  {
    logicalId: 'Table',
    type: 'AWS::DynamoDB::Table',
    physicalId: TABLE,
    status: 'CREATE_COMPLETE',
  },
  { logicalId: 'Logs', type: 'AWS::Logs::LogGroup', physicalId: LOG, status: 'CREATE_COMPLETE' },
  { logicalId: 'Role', type: 'AWS::IAM::Role', physicalId: ROLE, status: 'CREATE_COMPLETE' },
  {
    logicalId: 'Policy',
    type: 'AWS::IAM::Policy',
    physicalId: `${STACK}-Policy-X`,
    status: 'CREATE_COMPLETE',
  },
  { logicalId: 'Fn', type: 'AWS::Lambda::Function', physicalId: FN, status: 'CREATE_COMPLETE' },
  {
    logicalId: 'FnVersion',
    type: 'AWS::Lambda::Version',
    physicalId: `${FN_ARN}:1`,
    status: 'CREATE_COMPLETE',
  },
  {
    logicalId: 'FnAlias',
    type: 'AWS::Lambda::Alias',
    physicalId: `${FN_ARN}:live`,
    status: 'CREATE_COMPLETE',
  },
  {
    logicalId: 'Machine',
    type: 'AWS::StepFunctions::StateMachine',
    physicalId: SM_ARN,
    status: 'CREATE_COMPLETE',
  },
];

/** A fake emulator whose read-backs match the template (tests then break one thing at a time). */
function world() {
  const state = {
    stackStatus: 'CREATE_COMPLETE' as string | undefined,
    resources: stackResources(),
    table: {
      TableName: TABLE,
      TableArn: TABLE_ARN,
      TableStatus: 'ACTIVE',
      KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
      AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
      BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
    } as Record<string, unknown> | undefined,
    pitr: 'DISABLED',
    fn: {
      FunctionName: FN,
      FunctionArn: FN_ARN,
      State: 'Active',
      LastUpdateStatus: 'Successful',
      Runtime: 'nodejs24.x',
      Handler: 'index.handler',
      Timeout: 20,
      MemorySize: 512,
      Architectures: ['arm64'],
      Role: ROLE_ARN,
      Environment: { Variables: { TABLE, LOG_LEVEL: 'debug' } },
    } as Record<string, unknown> | undefined,
    versions: ['$LATEST', '1'],
    alias: { Name: 'live', FunctionVersion: '1', AliasArn: `${FN_ARN}:live` } as Record<
      string,
      unknown
    >,
    definition: `{"StartAt":"A","TimeoutSeconds":45,"States":{"A":{"Type":"Task","Resource":"${FN_ARN}","End":true}}}`,
    machine: true,
    logGroup: true as boolean,
    role: true as boolean,
    keyState: 'Enabled',
    logKmsKeyId: KEY_ARN,
    tags: {} as Record<string, Record<string, string> | undefined>,
    stackTags: {} as Record<string, string>,
  };
  const reader: EmulatorReader = {
    stack: async () =>
      state.stackStatus
        ? {
            stackId: `arn:aws:cloudformation:${REGION}:${ACCOUNT}:stack/${STACK}/x`,
            status: state.stackStatus,
            tags: state.stackTags,
          }
        : undefined,
    stackResources: async () => state.resources,
    table: async () => state.table,
    timeToLive: async () => ({ TimeToLiveStatus: 'DISABLED' }),
    continuousBackups: async () => ({
      PointInTimeRecoveryDescription: { PointInTimeRecoveryStatus: state.pitr },
    }),
    functionConfiguration: async (_name, qualifier) =>
      state.fn ? { ...state.fn, Version: qualifier ?? '$LATEST' } : undefined,
    functionVersions: async () => state.versions,
    alias: async () => state.alias,
    eventInvokeConfig: async () => undefined,
    stateMachine: async () =>
      state.machine
        ? {
            stateMachineArn: SM_ARN,
            name: `${STACK}-job-processing`,
            roleArn: ROLE_ARN,
            definition: state.definition,
          }
        : undefined,
    logGroup: async () =>
      state.logGroup
        ? {
            logGroupName: LOG,
            retentionInDays: 1,
            kmsKeyId: state.logKmsKeyId,
            arn: `${arn('logs', `log-group:${LOG}`)}:*`,
          }
        : undefined,
    role: async () =>
      state.role
        ? {
            RoleName: ROLE,
            Arn: ROLE_ARN,
            Path: '/',
            AssumeRolePolicyDocument: encodeURIComponent(JSON.stringify(TRUST)),
          }
        : undefined,
    rolePolicy: async () =>
      JSON.stringify({
        ...POLICY_DOC,
        Statement: [{ ...POLICY_DOC.Statement[0], Resource: TABLE_ARN }],
      }),
    key: async () => ({
      KeyId: KEY_ID,
      Arn: KEY_ARN,
      KeyState: state.keyState,
      Description: 'cmk',
      KeySpec: 'SYMMETRIC_DEFAULT',
      KeyUsage: 'ENCRYPT_DECRYPT',
    }),
    keyRotation: async () => true,
    keyPolicy: async () => JSON.stringify({ Version: '2012-10-17', Statement: [] }),
    tags: async (type) => state.tags[type],
  };
  return { state, reader };
}

const NO_WAIT: SettleOptions = { timeoutMs: 0, intervalMs: 1, sleep: async () => undefined };
const run = (reader: EmulatorReader, t: Template = template) =>
  reconcile({
    reader,
    template: t,
    stackName: STACK,
    region: REGION,
    account: ACCOUNT,
    settle: NO_WAIT,
  });

/** The template with one resource's properties extended (or replaced). */
const withProps = (id: string, props: Record<string, unknown>): Template => {
  const res = template.Resources[id] as TemplateResource;
  return {
    Resources: {
      ...template.Resources,
      [id]: { ...res, Properties: { ...res.Properties, ...props } },
    },
  };
};
const resource = async (reader: EmulatorReader, id: string, t: Template = template) => {
  const r = await run(reader, t);
  return { report: r, res: r.resources.find((x) => x.logicalId === id)! };
};
const check = (res: { checks: PropertyCheck[] }, property: string) =>
  res.checks.find((c) => c.property === property);

describe('token resolution', () => {
  const ctx = {
    refs: { Fn: FN, Alias: `${FN_ARN}:live` },
    attrs: { 'Fn.Arn': FN_ARN, 'Machine.Name': 'm' },
    pseudo: { 'AWS::Region': REGION, 'AWS::AccountId': ACCOUNT, 'AWS::Partition': 'aws' },
  };
  it('resolves Ref, GetAtt (both forms), Join, Select/Split and Sub', () => {
    expect(resolveTokens({ Ref: 'Fn' }, ctx)).toBe(FN);
    expect(resolveTokens({ 'Fn::GetAtt': ['Fn', 'Arn'] }, ctx)).toBe(FN_ARN);
    expect(resolveTokens({ 'Fn::GetAtt': 'Fn.Arn' }, ctx)).toBe(FN_ARN);
    expect(
      resolveTokens({ 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':x']] }, ctx),
    ).toBe('arn:aws:x');
    expect(
      resolveTokens({ 'Fn::Select': [7, { 'Fn::Split': [':', { Ref: 'Alias' }] }] }, ctx),
    ).toBe('live');
    expect(
      resolveTokens(
        { 'Fn::Sub': 'arn:${AWS::Partition}:states:${AWS::Region}:${Machine.Name}' },
        ctx,
      ),
    ).toBe(`arn:aws:states:${REGION}:m`);
    expect(resolveTokens({ 'Fn::Sub': ['${X}-y', { X: { Ref: 'Fn' } }] }, ctx)).toBe(`${FN}-y`);
    expect(resolveTokens({ a: [{ Ref: 'Fn' }, 1, true] }, ctx)).toEqual({ a: [FN, 1, true] });
  });
  it('fails on unknown references and unsupported intrinsics instead of guessing', () => {
    expect(() => resolveTokens({ Ref: 'Nope' }, ctx)).toThrow(UnresolvableTokenError);
    expect(() => resolveTokens({ 'Fn::GetAtt': ['Fn', 'Nope'] }, ctx)).toThrow(
      /no read-back value/,
    );
    expect(() => resolveTokens({ 'Fn::If': ['c', 1, 2] }, ctx)).toThrow(/not supported/);
  });
  it('compares JSON canonically (key order, IAM single values)', () => {
    expect(sameJson({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
    expect(sameJson({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
    expect(
      sameJson({ Action: 'x:Y', Resource: ['b', 'a'] }, { Resource: ['a', 'b'], Action: ['x:Y'] }),
    ).toBe(true);
    expect(canonical({ b: 1, a: { d: 1, c: 2 } })).toEqual({ a: { c: 2, d: 1 }, b: 1 });
    expect(parsePolicyDocument(encodeURIComponent('{"a":1}'))).toEqual({ a: 1 });
    expect(parsePolicyDocument('{"a":1}')).toEqual({ a: 1 });
  });
});

describe('reconcile', () => {
  it('reads every resource back; unsupported / not-enforced properties are never counted reconciled', async () => {
    const { reader } = world();
    const r = await run(reader);
    expect(r.ok).toBe(true);
    expect(r.templateResources).toBe(10);
    expect(r.counts).toEqual({
      reconciled: 4,
      'compared-not-enforced': 1,
      unsupported: 4,
      'metadata-only': 1,
      failed: 0,
    });
    const status = Object.fromEntries(r.resources.map((x) => [x.logicalId, x.status]));
    expect(status).toMatchObject({
      Fn: 'reconciled',
      FnVersion: 'reconciled',
      FnAlias: 'reconciled',
      Machine: 'reconciled',
      Table: 'unsupported', // PITR not applied by the emulator (read-back DISABLED)
      Logs: 'compared-not-enforced', // KmsKeyId stored and equal, but no encryption
      Role: 'unsupported', // IAM not enforced
      Policy: 'unsupported',
      Key: 'unsupported', // KMS not enforced
      CDKMetadata: 'metadata-only',
    });
    const table = r.resources.find((x) => x.logicalId === 'Table')!;
    expect(check(table, 'PointInTimeRecoverySpecification')).toMatchObject({
      status: 'unsupported',
      expected: { Status: 'ENABLED' },
      actual: { Status: 'DISABLED' },
      reason: expect.stringMatching(/does not apply PITR/),
    });
    expect(
      check(
        r.resources.find((x) => x.logicalId === 'Logs')!,
        'KmsKeyId',
      ),
    ).toMatchObject({
      status: 'compared-not-enforced',
      expected: KEY_ARN,
      actual: KEY_ARN,
    });
    // CDK::Metadata: its only property is uncompared, with a reason.
    expect(r.resources.find((x) => x.logicalId === 'CDKMetadata')!.checks).toEqual([
      expect.objectContaining({ property: 'Analytics', status: 'uncompared' }),
    ]);
    expect(r.propertyCounts.unknown).toBe(0);
    expect(r.propertyCounts.mismatch).toBe(0);
    expect(r.propertyCounts['compared-not-enforced']).toBe(1);
    expect(r.classification).toContainEqual(
      expect.objectContaining({
        type: 'AWS::Logs::LogGroup',
        property: 'KmsKeyId',
        status: 'compared-not-enforced',
        resources: 1,
      }),
    );
    expect(r.unsupported.map((u) => u.logicalId).sort()).toEqual([
      'Key',
      'Policy',
      'Role',
      'Table',
    ]);
    // The ASL equals the synthesized definition after token resolution, TimeoutSeconds included.
    const machine = r.resources.find((x) => x.logicalId === 'Machine')!;
    expect(machine.checks.filter((c) => c.status === 'match').map((c) => c.property)).toEqual(
      expect.arrayContaining([
        'DefinitionString (ASL, tokens resolved)',
        'Definition.TimeoutSeconds',
      ]),
    );
  });

  it('fails on a property mismatch (e.g. a Lambda timeout)', async () => {
    const { state, reader } = world();
    state.fn = { ...state.fn!, Timeout: 61 };
    const r = await run(reader);
    expect(r.ok).toBe(false);
    const fn = r.resources.find((x) => x.logicalId === 'Fn')!;
    expect(fn.status).toBe('failed');
    expect(fn.checks.find((c) => c.property === 'Timeout')).toMatchObject({
      status: 'mismatch',
      expected: 20,
      actual: 61,
    });
  });

  it('fails when the deployed ASL differs from the synthesized one', async () => {
    const { state, reader } = world();
    state.definition = state.definition.replace('"TimeoutSeconds":45', '"TimeoutSeconds":600');
    const r = await run(reader);
    const machine = r.resources.find((x) => x.logicalId === 'Machine')!;
    expect(machine.status).toBe('failed');
    expect(machine.checks.filter((c) => c.status === 'mismatch').map((c) => c.property)).toEqual([
      'DefinitionString (ASL, tokens resolved)',
      'Definition.TimeoutSeconds',
    ]);
  });

  it('fails when an environment VALUE differs, not only a key', async () => {
    const { state, reader } = world();
    state.fn = {
      ...state.fn!,
      Environment: { Variables: { TABLE: 'other-table', LOG_LEVEL: 'debug' } },
    };
    const fn = (await run(reader)).resources.find((x) => x.logicalId === 'Fn')!;
    expect(fn.checks.find((c) => c.property === 'Environment.Variables (values)')?.status).toBe(
      'mismatch',
    );
    expect(fn.checks.find((c) => c.property === 'Environment.Variables (keys)')?.status).toBe(
      'match',
    );
  });

  it('fails when the alias points at another version', async () => {
    const { state, reader } = world();
    state.alias = { ...state.alias, FunctionVersion: '2' };
    expect((await run(reader)).resources.find((x) => x.logicalId === 'FnAlias')!.status).toBe(
      'failed',
    );
  });

  it('detects a no-op placeholder physical id', async () => {
    const { state, reader } = world();
    state.resources = state.resources.map((x) =>
      x.logicalId === 'Fn' ? { ...x, physicalId: `${STACK}-Fn-noop-0a1b2c3d` } : x,
    );
    const r = await run(reader);
    expect(r.ok).toBe(false);
    expect(r.noopPlaceholders).toEqual(['Fn']);
    expect(r.resources.find((x) => x.logicalId === 'Fn')!.error).toMatch(/no-op placeholder/);
  });

  it('fails on a missing stack resource, an empty read-back, a bad status or an unknown type', async () => {
    const missing = world();
    missing.state.resources = missing.state.resources.filter((x) => x.logicalId !== 'Table');
    const r1 = await run(missing.reader);
    expect(r1.ok).toBe(false);
    expect(r1.resources.find((x) => x.logicalId === 'Table')!.error).toMatch(/no physical id/);

    const gone = world();
    gone.state.role = false;
    expect((await run(gone.reader)).resources.find((x) => x.logicalId === 'Role')!.error).toMatch(
      /read-back empty/,
    );

    const failedStatus = world();
    failedStatus.state.resources = failedStatus.state.resources.map((x) =>
      x.logicalId === 'Fn' ? { ...x, status: 'CREATE_FAILED' } : x,
    );
    expect(
      (await run(failedStatus.reader)).resources.find((x) => x.logicalId === 'Fn')!.error,
    ).toMatch(/CREATE_FAILED/);

    const unknown = world();
    unknown.state.resources.push({
      logicalId: 'Q',
      type: 'AWS::SQS::Queue',
      physicalId: 'q',
      status: 'CREATE_COMPLETE',
    });
    const t: Template = { Resources: { ...template.Resources, Q: { Type: 'AWS::SQS::Queue' } } };
    expect(
      (await run(unknown.reader, t)).resources.find((x) => x.logicalId === 'Q')!.error,
    ).toMatch(/no service read-back implemented/);
  });

  it('fails on stack resources the template does not have, or a stack not in a complete state', async () => {
    const extra = world();
    extra.state.resources.push({
      logicalId: 'Extra',
      type: 'AWS::SQS::Queue',
      physicalId: 'q',
      status: 'CREATE_COMPLETE',
    });
    const r = await run(extra.reader);
    expect(r.extraStackResources).toEqual(['Extra']);
    expect(r.ok).toBe(false);
    const rolledBack = world();
    rolledBack.state.stackStatus = 'UPDATE_ROLLBACK_COMPLETE';
    expect((await run(rolledBack.reader)).ok).toBe(false);
  });
});

describe('compare before classifying: stored-not-enforced values must match', () => {
  it('a log group with a DIFFERENT KMS key fails (not "unsupported")', async () => {
    const { state, reader } = world();
    state.logKmsKeyId = arn('kms', 'key/99999999-9999-9999-9999-999999999999');
    const { report, res } = await resource(reader, 'Logs');
    expect(report.ok).toBe(false);
    expect(res.status).toBe('failed');
    expect(check(res, 'KmsKeyId')).toMatchObject({ status: 'mismatch', expected: KEY_ARN });
  });

  it('a log group whose KMS key is not returned at all fails too', async () => {
    const { state, reader } = world();
    state.logKmsKeyId = undefined as unknown as string;
    const { report, res } = await resource(reader, 'Logs');
    expect(report.ok).toBe(false);
    expect(check(res, 'KmsKeyId')?.status).toBe('mismatch');
  });

  it('a function with the wrong tracing mode fails; the right one is compared-not-enforced', async () => {
    const t = withProps('Fn', { TracingConfig: { Mode: 'Active' } });
    const wrong = world();
    wrong.state.fn = { ...wrong.state.fn!, TracingConfig: { Mode: 'PassThrough' } };
    const bad = await resource(wrong.reader, 'Fn', t);
    expect(bad.report.ok).toBe(false);
    expect(bad.res.status).toBe('failed');
    expect(check(bad.res, 'TracingConfig.Mode')).toMatchObject({
      status: 'mismatch',
      expected: 'Active',
      actual: 'PassThrough',
    });

    const right = world();
    right.state.fn = { ...right.state.fn!, TracingConfig: { Mode: 'Active' } };
    const good = await resource(right.reader, 'Fn', t);
    expect(good.report.ok).toBe(true);
    expect(good.res.status).toBe('compared-not-enforced');
    expect(check(good.res, 'TracingConfig.Mode')).toMatchObject({
      status: 'compared-not-enforced',
      reason: expect.stringMatching(/X-Ray/),
    });
    expect(good.report.counts.reconciled).toBe(3); // the function is no longer counted
  });

  it('an "unsupported" property is unsupported only while the read-back is absent or default', async () => {
    const t = withProps('Table', {
      TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
    });
    const absent = world();
    const r1 = await resource(absent.reader, 'Table', t);
    expect(check(r1.res, 'TimeToLiveSpecification')?.status).toBe('unsupported');

    // A real, different value is a mismatch, not "unsupported".
    const other = world();
    other.reader.timeToLive = async () => ({ TimeToLiveStatus: 'ENABLED', AttributeName: 'ttl' });
    const r2 = await resource(other.reader, 'Table', t);
    expect(r2.report.ok).toBe(false);
    expect(check(r2.res, 'TimeToLiveSpecification')).toMatchObject({
      status: 'mismatch',
      actual: { AttributeName: 'ttl', Status: 'ENABLED' },
    });

    // The emulator returning the value: compared-not-enforced (no longer unsupported).
    const equal = world();
    equal.reader.timeToLive = async () => ({
      TimeToLiveStatus: 'ENABLED',
      AttributeName: 'expiresAt',
    });
    const r3 = await resource(equal.reader, 'Table', t);
    expect(check(r3.res, 'TimeToLiveSpecification')?.status).toBe('compared-not-enforced');
  });

  it('classifies read-backs as default only when they carry no setting', () => {
    for (const v of [undefined, null, false, '', 'DISABLED', 'OFF', [], {}, { a: undefined }]) {
      expect(isDefaultReadBack(v)).toBe(true);
    }
    expect(isDefaultReadBack({ level: 'OFF', includeExecutionData: false, destinations: [] })).toBe(
      true,
    );
    for (const v of ['ENABLED', 'ALL', true, 1, ['x'], { a: 'x' }, KEY_ARN]) {
      expect(isDefaultReadBack(v)).toBe(false);
    }
  });

  it('every listed property has a concrete reason and is in exactly one list', () => {
    const lists = { NOT_ENFORCED_PROPERTIES, UNSUPPORTED_PROPERTIES, UNCOMPARED_PROPERTIES };
    const seen = new Map<string, string>();
    for (const [list, byType] of Object.entries(lists)) {
      for (const [type, props] of Object.entries(byType)) {
        for (const [prop, reason] of Object.entries(props)) {
          expect(reason.length, `${list} ${type}.${prop}`).toBeGreaterThan(30);
          const key = `${type}.${prop}`;
          expect(seen.get(key), `${key} in ${list} and ${String(seen.get(key))}`).toBeUndefined();
          seen.set(key, list);
        }
      }
    }
  });
});

describe('Lambda update state', () => {
  it.each([
    ['Failed', 'boom'],
    ['InProgress', undefined],
    [undefined, undefined],
  ])('LastUpdateStatus=%s after the settle-wait fails the function', async (status, reason) => {
    const { state, reader } = world();
    state.fn = { ...state.fn!, LastUpdateStatus: status, LastUpdateStatusReason: reason };
    const { report, res } = await resource(reader, 'Fn');
    expect(report.ok).toBe(false);
    expect(res.status).toBe('failed');
    expect(check(res, 'LastUpdateStatus')).toMatchObject({
      status: 'mismatch',
      expected: 'Successful',
      ...(reason ? { actual: `${status} (${reason})` } : {}),
    });
  });

  it('a function that is not Active fails even with a successful last update', async () => {
    const { state, reader } = world();
    state.fn = { ...state.fn!, State: 'Failed' };
    expect((await resource(reader, 'Fn')).res.status).toBe('failed');
  });
});

describe('every template property is classified', () => {
  it('properties no comparer knows are "unknown" and fail the run', async () => {
    const { reader } = world();
    const t = withProps('Fn', {
      ReservedConcurrentExecutions: 1,
      KmsKeyArn: KEY_ARN,
      VpcConfig: { SubnetIds: ['subnet-1'] },
    });
    const { report, res } = await resource(reader, 'Fn', t);
    expect(report.ok).toBe(false);
    expect(res.status).toBe('failed');
    expect(res.checks.filter((c) => c.status === 'unknown').map((c) => c.property)).toEqual([
      'ReservedConcurrentExecutions',
      'KmsKeyArn',
      'VpcConfig',
    ]);
    expect(res.error).toMatch(/unknown properties: ReservedConcurrentExecutions, KmsKeyArn/);
    expect(report.propertyCounts.unknown).toBe(3);
  });

  it('an unknown sub-key of a partly compared property fails', async () => {
    const { reader } = world();
    const t = withProps('Table', {
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true, Future: 1 },
    });
    const { report, res } = await resource(reader, 'Table', t);
    expect(report.ok).toBe(false);
    expect(check(res, 'PointInTimeRecoverySpecification.Future')?.status).toBe('unknown');
  });

  it('an allowlisted uncompared property passes, with its reason', async () => {
    const { reader } = world();
    const t = withProps('Fn', { Code: { S3Bucket: 'b', S3Key: 'k.zip' } });
    const { report, res } = await resource(reader, 'Fn', t);
    expect(report.ok).toBe(true);
    expect(res.status).toBe('reconciled');
    expect(check(res, 'Code')).toMatchObject({
      status: 'uncompared',
      reason: expect.stringMatching(/CodeSha256/),
    });
  });

  it('a metadata-only resource with an unlisted property fails', async () => {
    const { reader } = world();
    const t = withProps('CDKMetadata', { Condition: 'x' });
    const { report, res } = await resource(reader, 'CDKMetadata', t);
    expect(report.ok).toBe(false);
    expect(res.status).toBe('failed');
  });

  it('tags are compared (CloudFormation aws: tags ignored); a missing or different tag fails', async () => {
    const tags = [{ Key: 'starter:run-id', Value: 'em-abc123' }];
    const t = withProps('Fn', { Tags: tags });
    const ok = world();
    ok.state.tags['AWS::Lambda::Function'] = {
      'starter:run-id': 'em-abc123',
      'aws:cloudformation:stack-name': STACK,
    };
    expect((await resource(ok.reader, 'Fn', t)).res.status).toBe('reconciled');

    const wrong = world();
    wrong.state.tags['AWS::Lambda::Function'] = { 'starter:run-id': 'other' };
    const bad = await resource(wrong.reader, 'Fn', t);
    expect(bad.report.ok).toBe(false);
    expect(check(bad.res, 'Tags')?.status).toBe('mismatch');

    const none = world();
    expect(check((await resource(none.reader, 'Fn', t)).res, 'Tags')?.status).toBe('mismatch');

    // Stack-level tags propagate to every resource (as on AWS): expected, and required.
    const stackTagged = world();
    stackTagged.state.stackTags = { 'starter:ephemeral': 'true' };
    stackTagged.state.tags['AWS::Lambda::Function'] = { 'starter:run-id': 'em-abc123' };
    const missing = await resource(stackTagged.reader, 'Fn', t);
    expect(check(missing.res, 'Tags')).toMatchObject({
      status: 'mismatch',
      expected: { 'starter:ephemeral': 'true', 'starter:run-id': 'em-abc123' },
    });
    stackTagged.state.tags['AWS::Lambda::Function'] = {
      'starter:run-id': 'em-abc123',
      'starter:ephemeral': 'true',
    };
    expect((await resource(stackTagged.reader, 'Fn', t)).res.status).toBe('reconciled');
  });

  it('classifyUncovered: covered sub-keys leave the others to the lists', () => {
    expect(
      classifyUncovered(
        'AWS::KMS::Key',
        { PendingWindowInDays: 7, X: { a: 1, b: 2 } },
        new Set(['X.a']),
      ),
    ).toEqual([
      expect.objectContaining({ property: 'PendingWindowInDays', status: 'uncompared' }),
      expect.objectContaining({ property: 'X.b', status: 'unknown', expected: 2 }),
    ]);
  });
});

describe('update and destroy verification', () => {
  const snap = (aliasVersion: string, versions: string[], appVersion?: string) => ({
    functionName: FN,
    aliasVersion,
    versions,
    ...(appVersion ? { appVersion } : {}),
  });

  it('an update must publish a new version, move the alias to it and carry the new APP_VERSION', () => {
    expect(verifyUpdate([snap('1', ['1'], 'a')], [snap('2', ['2'], 'b')], 'b').ok).toBe(true);
    const stuck = verifyUpdate([snap('1', ['1'], 'a')], [snap('1', ['1'], 'b')], 'b');
    expect(stuck.ok).toBe(false);
    expect(stuck.functions[0]!.problems.join('\n')).toMatch(/alias did not move/);
    expect(
      verifyUpdate([snap('1', ['1'])], [snap('2', ['2'], 'old')], 'b').functions[0]!.problems.join(
        '\n',
      ),
    ).toMatch(/APP_VERSION is old/);
    expect(
      verifyUpdate([snap('1', ['1'])], [snap('2', ['1'], 'b')], 'b').functions[0]!.problems.join(
        '\n',
      ),
    ).toMatch(/unpublished version 2/);
    expect(verifyUpdate([], [], 'b').ok).toBe(false);
  });

  it('destroy: DELETE_COMPLETE and nothing left (a CMK may be pending deletion)', async () => {
    const w = world();
    w.state.stackStatus = 'DELETE_COMPLETE';
    w.state.table = undefined;
    w.state.fn = undefined;
    w.state.machine = false;
    w.state.logGroup = false;
    w.state.role = false;
    w.state.keyState = 'PendingDeletion';
    const ok = await verifyDestroyed({
      reader: w.reader,
      stackName: STACK,
      resources: stackResources(),
    });
    expect(ok).toMatchObject({
      ok: true,
      stackStatus: 'DELETE_COMPLETE',
      remaining: [],
      checked: 6,
    });

    w.state.table = { TableName: TABLE };
    w.state.keyState = 'Enabled';
    const left = await verifyDestroyed({
      reader: w.reader,
      stackName: STACK,
      resources: stackResources(),
    });
    expect(left.ok).toBe(false);
    expect(left.remaining.map((x) => x.logicalId)).toEqual(['Key', 'Table']);

    const w2 = world();
    w2.state.stackStatus = 'DELETE_FAILED';
    expect((await verifyDestroyed({ reader: w2.reader, stackName: STACK, resources: [] })).ok).toBe(
      false,
    );
  });
});

describe('Lambda read-back waits for a settled function', () => {
  const readerOf = (states: Record<string, unknown>[]) => {
    let calls = 0;
    const reader = {
      functionConfiguration: async () => states[Math.min(calls++, states.length - 1)],
    } as unknown as EmulatorReader;
    return { reader, calls: () => calls };
  };
  const noSleep = { timeoutMs: 60_000, intervalMs: 1_000, sleep: async () => undefined };

  it('polls past Pending / InProgress and returns the settled configuration', async () => {
    const { reader, calls } = readerOf([
      { State: 'Pending', LastUpdateStatus: 'InProgress' },
      { State: 'Active', LastUpdateStatus: 'InProgress' },
      { State: 'Active', LastUpdateStatus: 'Successful' },
    ]);
    const config = await settledFunctionConfiguration(reader, 'fn', noSleep);
    expect(config).toEqual({ State: 'Active', LastUpdateStatus: 'Successful' });
    expect(calls()).toBe(3);
  });

  it('is bounded: a function that stays Pending is returned as such (and then fails the State check)', async () => {
    const { reader } = readerOf([{ State: 'Pending' }]);
    const config = await settledFunctionConfiguration(reader, 'fn', {
      timeoutMs: 0,
      intervalMs: 1,
      sleep: async () => undefined,
    });
    expect(config).toEqual({ State: 'Pending' });
  });

  it('does not wait for a missing function', async () => {
    const { reader, calls } = readerOf([undefined as unknown as Record<string, unknown>]);
    expect(await settledFunctionConfiguration(reader, 'fn', noSleep)).toBeUndefined();
    expect(calls()).toBe(1);
  });
});
