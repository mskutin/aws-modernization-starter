/**
 * Rule fixtures: for every rule a passing and a failing CloudFormation fixture
 * plus the expected diagnostic. Single source for:
 *   - TypeScript rule tests and cdk-nag pack tests (via CfnInclude),
 *   - generated Guard unit tests (`policies/guard/tests/*_tests.yaml`),
 *   - Guard `validate` diagnostics tests and TS⇄Guard parity tests.
 */
import type { CfnResourceJson, PolicyOptions } from '../../src/types.js';

export type Resources = Record<string, CfnResourceJson>;
export type GuardStatus = 'PASS' | 'FAIL' | 'SKIP';

export interface RuleVariant {
  name: string;
  resources: Resources;
  /** Expected compliance of the rule under test (TS and Guard). */
  compliant: boolean;
  /** Expected Guard rule status (compliant ⇒ PASS or SKIP; non-compliant ⇒ FAIL). */
  guard: GuardStatus;
  /**
   * Expected diagnostic of a non-compliant variant: the first TypeScript finding matches
   * `path` and contains `message`; Guard reports the rule on `logicalId`.
   */
  expect?: { logicalId: string; path: string; message: string };
}

export interface RuleCase {
  ruleId: string;
  pass: Resources;
  fail: Resources;
  /** Expected diagnostic for the failing fixture (first finding). */
  expect: { logicalId: string; path: string; message: string };
  /** Guard status of the passing fixture (default PASS). */
  guardPass?: GuardStatus;
  options?: PolicyOptions;
  variants?: RuleVariant[];
}

export const tags = (env = 'dev', overrides: Record<string, string | null> = {}) => {
  const base: Record<string, string> = {
    Project: 'aws-modernization-starter',
    Environment: env,
    Owner: 'platform-team',
    CostCentre: 'CC-0000',
    DataClassification: 'internal',
    ManagedBy: 'aws-cdk',
  };
  return Object.entries({ ...base, ...overrides })
    .filter((e): e is [string, string] => e[1] !== null)
    .map(([Key, Value]) => ({ Key, Value }));
};

const BPA_ALL = {
  BlockPublicAcls: true,
  BlockPublicPolicy: true,
  IgnorePublicAcls: true,
  RestrictPublicBuckets: true,
};

const TLS_DENY = {
  Effect: 'Deny',
  Principal: { AWS: '*' },
  Action: 's3:*',
  Resource: [{ 'Fn::GetAtt': ['Bucket', 'Arn'] }],
  Condition: { Bool: { 'aws:SecureTransport': 'false' } },
};

const bucketPolicy = (statements: unknown[]): CfnResourceJson => ({
  Type: 'AWS::S3::BucketPolicy',
  Properties: {
    Bucket: { Ref: 'Bucket' },
    PolicyDocument: { Version: '2012-10-17', Statement: statements },
  },
});

const ACCOUNT_ALLOW = {
  Effect: 'Allow',
  Principal: { AWS: 'arn:aws:iam::111122223333:root' },
  Action: 's3:GetObject',
  Resource: { 'Fn::Join': ['', [{ 'Fn::GetAtt': ['Bucket', 'Arn'] }, '/*']] },
};

const S3_PRINCIPAL_PATH = 'Properties/PolicyDocument/Statement/0/Principal';

/** BASE-S3-002: a bucket policy whose first statement allows `principal` (plus the TLS deny). */
const s3Allow = (principal: unknown): Resources => ({
  BucketPolicy: bucketPolicy([{ ...ACCOUNT_ALLOW, Principal: principal }, TLS_DENY]),
});

/**
 * BASE-S3-002: the sandbox SPA bucket policy exactly as synthesized
 * (`infra/cdk.out/sandbox/.../SandboxFrontend*.template.json`, 2026-10-16): the TLS denies, the
 * CDK auto-delete-objects provider role (an AWS::IAM::Role, referenced by Fn::GetAtt Arn) and
 * CloudFront OAC (service principal + AWS:SourceArn). Logical IDs shortened.
 */
const SPA_BUCKET_ARN = { 'Fn::GetAtt': ['SpaHostingBucket', 'Arn'] };
const SPA_BUCKET_OBJECTS = { 'Fn::Join': ['', [SPA_BUCKET_ARN, '/*']] };
const SANDBOX_SPA_BUCKET_POLICY: Resources = {
  BucketPolicy: {
    Type: 'AWS::S3::BucketPolicy',
    Properties: {
      Bucket: { Ref: 'SpaHostingBucket' },
      PolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Action: 's3:*',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
            Effect: 'Deny',
            Principal: { AWS: '*' },
            Resource: [SPA_BUCKET_ARN, SPA_BUCKET_OBJECTS],
          },
          {
            Action: 's3:*',
            Condition: { NumericLessThan: { 's3:TlsVersion': 1.2 } },
            Effect: 'Deny',
            Principal: { AWS: '*' },
            Resource: [SPA_BUCKET_ARN, SPA_BUCKET_OBJECTS],
          },
          {
            Action: ['s3:DeleteObject*', 's3:GetBucket*', 's3:List*', 's3:PutBucketPolicy'],
            Effect: 'Allow',
            Principal: {
              AWS: { 'Fn::GetAtt': ['CustomS3AutoDeleteObjectsCustomResourceProviderRole', 'Arn'] },
            },
            Resource: [SPA_BUCKET_ARN, SPA_BUCKET_OBJECTS],
          },
          {
            Action: 's3:GetObject',
            Condition: {
              StringEquals: {
                'AWS:SourceArn': {
                  'Fn::Join': [
                    '',
                    [
                      'arn:',
                      { Ref: 'AWS::Partition' },
                      ':cloudfront::',
                      { Ref: 'AWS::AccountId' },
                      ':distribution/',
                      { Ref: 'SpaHostingDistribution' },
                    ],
                  ],
                },
              },
            },
            Effect: 'Allow',
            Principal: { Service: 'cloudfront.amazonaws.com' },
            Resource: SPA_BUCKET_OBJECTS,
          },
        ],
      },
    },
  },
  CustomS3AutoDeleteObjectsCustomResourceProviderRole: {
    Type: 'AWS::IAM::Role',
    Properties: {
      AssumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Action: 'sts:AssumeRole',
            Effect: 'Allow',
            Principal: { Service: 'lambda.amazonaws.com' },
          },
        ],
      },
    },
  },
  AutoDelete: {
    Type: 'Custom::S3AutoDeleteObjects',
    Properties: {
      ServiceToken: {
        'Fn::GetAtt': ['CustomS3AutoDeleteObjectsCustomResourceProviderHandler', 'Arn'],
      },
      BucketName: { Ref: 'SpaHostingBucket' },
    },
  },
};

const s3Origin = {
  Id: 'spa',
  DomainName: { 'Fn::GetAtt': ['Bucket', 'RegionalDomainName'] },
  S3OriginConfig: { OriginAccessIdentity: '' },
  OriginAccessControlId: { 'Fn::GetAtt': ['Oac', 'Id'] },
};

const albOrigin = (policy = 'https-only', ssl: string[] = ['TLSv1.2']) => ({
  Id: 'api',
  DomainName: 'api.internal.example.com',
  CustomOriginConfig: { OriginProtocolPolicy: policy, OriginSSLProtocols: ssl },
});

const distribution = (config: Record<string, unknown> = {}, env = 'dev'): CfnResourceJson => ({
  Type: 'AWS::CloudFront::Distribution',
  Properties: {
    DistributionConfig: {
      Enabled: true,
      Origins: [s3Origin],
      DefaultCacheBehavior: {
        TargetOriginId: 'spa',
        ViewerProtocolPolicy: 'redirect-to-https',
        ResponseHeadersPolicyId: '67f7725c-6f97-4210-82d7-5512b31e9d03',
      },
      ...config,
    },
    Tags: tags(env),
  },
});

const container = (overrides: Record<string, unknown> = {}) => ({
  Name: 'api',
  Image: '111122223333.dkr.ecr.ap-southeast-1.amazonaws.com/api:1.0.0',
  User: '1000:1000',
  ReadonlyRootFilesystem: true,
  Privileged: false,
  LogConfiguration: { LogDriver: 'awslogs', Options: { 'awslogs-group': 'api' } },
  // The deployed target (ADRs 0221, 0222 and 0511): IAM database auth with verified TLS.
  Environment: [
    { Name: 'DB_HOST', Value: 'db.internal' },
    { Name: 'DB_AUTH', Value: 'iam' },
    { Name: 'DB_SSL', Value: 'verify-full' },
    { Name: 'AUTH_ISSUER', Value: 'https://idp.example.com' },
    // Token-verifying container: its client allow-list (BASE-ECS-008).
    { Name: 'AUTH_ALLOWED_CLIENT_IDS', Value: 'starter-dev-web' },
  ],
  Secrets: [
    { Name: 'API_SIGNING_KEY', ValueFrom: 'arn:aws:secretsmanager:ap-southeast-1:1:secret:k' },
  ],
  ...overrides,
});

/** Container environment = the compliant baseline plus `extra` entries. */
const envWith = (...extra: { Name: string; Value: unknown }[]) => [
  ...(container().Environment as { Name: string; Value: unknown }[]),
  ...extra,
];
const envWithout = (name: string, ...extra: { Name: string; Value: unknown }[]) => [
  ...(container().Environment as { Name: string; Value: unknown }[]).filter((e) => e.Name !== name),
  ...extra,
];
/** Lambda environment variables of a function that reaches PostgreSQL the deployed way. */
const FN_DB_ENV = { DB_HOST: 'db.internal', DB_AUTH: 'iam', DB_SSL: 'verify-full' };
const fnEnv = (variables: Record<string, unknown>) => ({ Environment: { Variables: variables } });

const taskDef = (
  containerOverrides: Record<string, unknown> = {},
  props: Record<string, unknown> = {},
): CfnResourceJson => ({
  Type: 'AWS::ECS::TaskDefinition',
  Properties: {
    RequiresCompatibilities: ['FARGATE'],
    NetworkMode: 'awsvpc',
    Cpu: '256',
    Memory: '512',
    ContainerDefinitions: [container(containerOverrides)],
    Tags: tags(),
    ...props,
  },
});

const iamPolicy = (statements: unknown[]): CfnResourceJson => ({
  Type: 'AWS::IAM::Policy',
  Properties: {
    PolicyName: 'TaskRoleDefaultPolicy',
    Roles: [{ Ref: 'TaskRole' }],
    PolicyDocument: { Version: '2012-10-17', Statement: statements },
  },
});

const TRUST_ECS = {
  Version: '2012-10-17',
  Statement: [
    {
      Effect: 'Allow',
      Principal: { Service: 'ecs-tasks.amazonaws.com' },
      Action: 'sts:AssumeRole',
    },
  ],
};

const role = (props: Record<string, unknown> = {}): CfnResourceJson => ({
  Type: 'AWS::IAM::Role',
  Properties: { AssumeRolePolicyDocument: TRUST_ECS, ...props },
});

/** BASE-IAM-006: a role whose only trust statement uses `principal`. */
const trustRole = (principal: unknown): CfnResourceJson =>
  role({
    AssumeRolePolicyDocument: {
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Principal: principal, Action: 'sts:AssumeRole' }],
    },
  });

/** A third-party registry type whose provider returns "*". */
const ECHO: CfnResourceJson = { Type: 'Acme::Util::Echo', Properties: { Value: '*' } };

const PRINCIPAL_PATH = 'Properties/AssumeRolePolicyDocument/Statement/0/Principal';

/**
 * Every trust `Principal.Service` value in the synthesized dev/staging/prod/sandbox and
 * integration templates (infra/cdk.out, 2026-10-16). All are literal strings.
 */
const SYNTHESIZED_SERVICE_PRINCIPALS = [
  'ecs-tasks.amazonaws.com',
  'lambda.amazonaws.com',
  'states.amazonaws.com',
  'monitoring.rds.amazonaws.com',
  'vpc-flow-logs.amazonaws.com',
];

/** CDK `ArnPrincipal` built from the partition and account (integration mini-stack shape). */
const OPERATOR_ROLE_ARN = {
  'Fn::Join': [
    '',
    [
      'arn:',
      { Ref: 'AWS::Partition' },
      ':iam::',
      { Ref: 'AWS::AccountId' },
      ':role/starter-it-offline-placeholder-operator',
    ],
  ],
};

const managedArn = (name: string) => ({
  'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, `:iam::aws:policy/${name}`]],
});

const TABLE_ARN = { 'Fn::GetAtt': ['JobsTable', 'Arn'] };

const fn = (props: Record<string, unknown> = {}): CfnResourceJson => ({
  Type: 'AWS::Lambda::Function',
  Properties: {
    Runtime: 'nodejs24.x',
    Handler: 'index.handler',
    Code: { S3Bucket: 'assets', S3Key: 'validator.zip' },
    Role: { 'Fn::GetAtt': ['FnRole', 'Arn'] },
    Architectures: ['arm64'],
    Timeout: 15,
    MemorySize: 256,
    ReservedConcurrentExecutions: 5,
    LoggingConfig: { LogGroup: { Ref: 'FnLogs' } },
    TracingConfig: { Mode: 'Active' },
    Tags: tags(),
    ...props,
  },
});

const without = (obj: Record<string, unknown>, key: string) => {
  const { [key]: _drop, ...rest } = obj;
  return rest;
};

const dbInstance = (
  props: Record<string, unknown> = {},
  env = 'prod',
  policies: Partial<CfnResourceJson> = {
    DeletionPolicy: 'Snapshot',
    UpdateReplacePolicy: 'Snapshot',
  },
): CfnResourceJson => ({
  Type: 'AWS::RDS::DBInstance',
  ...policies,
  Properties: {
    Engine: 'postgres',
    EngineVersion: '17.6',
    DBInstanceClass: 'db.t4g.micro',
    AllocatedStorage: '20',
    StorageEncrypted: true,
    PubliclyAccessible: false,
    DeletionProtection: true,
    BackupRetentionPeriod: 7,
    Tags: tags(env),
    ...props,
  },
});

const pgParams = (family: string, parameters: Record<string, unknown>): CfnResourceJson => ({
  Type: 'AWS::RDS::DBParameterGroup',
  Properties: { Family: family, Description: 'app', Parameters: parameters },
});

const CMK = { 'Fn::GetAtt': ['DataKey', 'Arn'] };

const table = (
  props: Record<string, unknown> = {},
  env = 'prod',
  policies: Partial<CfnResourceJson> = { DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' },
): CfnResourceJson => ({
  Type: 'AWS::DynamoDB::Table',
  ...policies,
  Properties: {
    BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [
      { AttributeName: 'pk', KeyType: 'HASH' },
      { AttributeName: 'sk', KeyType: 'RANGE' },
    ],
    AttributeDefinitions: [
      { AttributeName: 'pk', AttributeType: 'S' },
      { AttributeName: 'sk', AttributeType: 'S' },
    ],
    SSESpecification: { SSEEnabled: true, SSEType: 'KMS', KMSMasterKeyId: CMK },
    PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    DeletionProtectionEnabled: true,
    Tags: tags(env),
    ...props,
  },
});

const globalTable = (replica: Record<string, unknown> = {}, env = 'prod'): CfnResourceJson => ({
  Type: 'AWS::DynamoDB::GlobalTable',
  DeletionPolicy: 'Retain',
  UpdateReplacePolicy: 'Retain',
  Properties: {
    BillingMode: 'PAY_PER_REQUEST',
    SSESpecification: { SSEEnabled: true, SSEType: 'KMS' },
    Replicas: [
      {
        Region: 'ap-southeast-1',
        SSESpecification: { KMSMasterKeyId: CMK },
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
        DeletionProtectionEnabled: true,
        Tags: tags(env),
        ...replica,
      },
    ],
  },
});

const logGroup = (props: Record<string, unknown> = {}): CfnResourceJson => ({
  Type: 'AWS::Logs::LogGroup',
  Properties: {
    RetentionInDays: 30,
    KmsKeyId: { 'Fn::GetAtt': ['LogKey', 'Arn'] },
    Tags: tags(),
    ...props,
  },
});

const stateMachine = (logging: unknown): CfnResourceJson => ({
  Type: 'AWS::StepFunctions::StateMachine',
  Properties: {
    RoleArn: { 'Fn::GetAtt': ['SfnRole', 'Arn'] },
    DefinitionString: '{}',
    LoggingConfiguration: logging,
    Tags: tags(),
  },
});

const bucket = (
  props: Record<string, unknown> = {},
  policies: Partial<CfnResourceJson> = {},
): CfnResourceJson => ({
  Type: 'AWS::S3::Bucket',
  ...policies,
  Properties: { PublicAccessBlockConfiguration: BPA_ALL, Tags: tags(), ...props },
});

const kmsKey = (
  props: Record<string, unknown> = {},
  env = 'dev',
  policies: Partial<CfnResourceJson> = {},
): CfnResourceJson => ({
  Type: 'AWS::KMS::Key',
  ...policies,
  Properties: {
    KeyPolicy: { Version: '2012-10-17', Statement: [] },
    EnableKeyRotation: true,
    Tags: tags(env),
    ...props,
  },
});

export const RULE_CASES: RuleCase[] = [
  // ───────────── S3 ─────────────
  {
    ruleId: 'BASE-S3-001',
    pass: { Bucket: bucket() },
    fail: {
      Bucket: bucket({ PublicAccessBlockConfiguration: { ...BPA_ALL, BlockPublicPolicy: false } }),
    },
    expect: {
      logicalId: 'Bucket',
      path: 'Properties/PublicAccessBlockConfiguration/BlockPublicPolicy',
      message: 'BlockPublicPolicy must be true',
    },
    variants: [
      {
        name: 'bucket without PublicAccessBlockConfiguration',
        resources: { Bucket: { Type: 'AWS::S3::Bucket' } },
        compliant: false,
        guard: 'FAIL',
      },
    ],
  },
  {
    ruleId: 'BASE-S3-002',
    pass: { BucketPolicy: bucketPolicy([TLS_DENY, ACCOUNT_ALLOW]) },
    fail: { BucketPolicy: bucketPolicy([{ ...ACCOUNT_ALLOW, Principal: { AWS: '*' } }]) },
    expect: {
      logicalId: 'BucketPolicy',
      path: 'Properties/PolicyDocument/Statement/0/Principal',
      message: 'wildcard principal',
    },
    variants: [
      // ── Accepted (allowlist shared with BASE-IAM-006) ──
      {
        name: 'synthesized sandbox SPA bucket policy (auto-delete provider role, CloudFront OAC, TLS denies)',
        resources: SANDBOX_SPA_BUCKET_POLICY,
        compliant: true,
        guard: 'PASS',
      },
      {
        name: 'only a Deny with wildcard principal (TLS enforcement)',
        resources: { BucketPolicy: bucketPolicy([TLS_DENY]) },
        compliant: true,
        guard: 'PASS',
      },
      {
        name: 'Deny + NotPrincipal (restricts, never grants)',
        resources: {
          BucketPolicy: bucketPolicy([
            ACCOUNT_ALLOW,
            {
              Effect: 'Deny',
              NotPrincipal: { AWS: 'arn:aws:iam::111122223333:root' },
              Action: 's3:*',
              Resource: [{ 'Fn::GetAtt': ['Bucket', 'Arn'] }],
            },
          ]),
        },
        compliant: true,
        guard: 'PASS',
      },
      {
        name: 'ARN principals built with Fn::Join, Fn::Sub and Ref AWS::AccountId',
        resources: {
          BucketPolicy: bucketPolicy([
            {
              ...ACCOUNT_ALLOW,
              Principal: {
                AWS: [
                  OPERATOR_ROLE_ARN,
                  { 'Fn::Sub': 'arn:${AWS::Partition}:iam::${AWS::AccountId}:root' },
                  { Ref: 'AWS::AccountId' },
                ],
              },
            },
          ]),
        },
        compliant: true,
        guard: 'PASS',
      },
      {
        name: 'sandbox provider-role principal in the dotted-string Fn::GetAtt form',
        resources: {
          ...s3Allow({
            AWS: { 'Fn::GetAtt': 'CustomS3AutoDeleteObjectsCustomResourceProviderRole.Arn' },
          }),
          CustomS3AutoDeleteObjectsCustomResourceProviderRole: SANDBOX_SPA_BUCKET_POLICY[
            'CustomS3AutoDeleteObjectsCustomResourceProviderRole'
          ] as CfnResourceJson,
        },
        compliant: true,
        guard: 'PASS',
      },
      // ── Rejected: literal and intrinsic-only "*" ──
      {
        name: 'Principal "*" string',
        resources: { BucketPolicy: bucketPolicy([{ ...ACCOUNT_ALLOW, Principal: '*' }]) },
        compliant: false,
        guard: 'FAIL',
        expect: {
          logicalId: 'BucketPolicy',
          path: S3_PRINCIPAL_PATH,
          message: 'wildcard principal ("*")',
        },
      },
      {
        name: 'Principal "*" with an aws:SourceArn condition (conditions do not scope a "*" grant)',
        resources: {
          BucketPolicy: bucketPolicy([
            {
              ...ACCOUNT_ALLOW,
              Principal: '*',
              Condition: {
                StringEquals: {
                  'AWS:SourceArn': 'arn:aws:cloudfront::111122223333:distribution/E2EXAMPLE',
                },
              },
            },
          ]),
        },
        compliant: false,
        guard: 'FAIL',
        expect: {
          logicalId: 'BucketPolicy',
          path: S3_PRINCIPAL_PATH,
          message: 'wildcard principal',
        },
      },
      {
        name: '"*" inside an AWS principal list',
        resources: s3Allow({ AWS: [OPERATOR_ROLE_ARN, '*'] }),
        compliant: false,
        guard: 'FAIL',
        expect: {
          logicalId: 'BucketPolicy',
          path: S3_PRINCIPAL_PATH,
          message: 'wildcard principal (AWS "*")',
        },
      },
      {
        name: 'Service "*"',
        resources: s3Allow({ Service: '*' }),
        compliant: false,
        guard: 'FAIL',
        expect: {
          logicalId: 'BucketPolicy',
          path: S3_PRINCIPAL_PATH,
          message: 'wildcard principal (Service "*")',
        },
      },
      {
        name: 'Fn::Sub "*"',
        resources: s3Allow({ AWS: { 'Fn::Sub': '*' } }),
        compliant: false,
        guard: 'FAIL',
        expect: { logicalId: 'BucketPolicy', path: S3_PRINCIPAL_PATH, message: 'Fn::Sub' },
      },
      {
        name: 'Fn::Join of only "*"',
        resources: s3Allow({ AWS: { 'Fn::Join': ['', ['*', '']] } }),
        compliant: false,
        guard: 'FAIL',
        expect: { logicalId: 'BucketPolicy', path: S3_PRINCIPAL_PATH, message: 'Fn::Join' },
      },
      {
        name: 'Fn::If with a "*" branch',
        resources: s3Allow({ AWS: { 'Fn::If': ['C', OPERATOR_ROLE_ARN, '*'] } }),
        compliant: false,
        guard: 'FAIL',
        expect: { logicalId: 'BucketPolicy', path: S3_PRINCIPAL_PATH, message: 'Fn::If' },
      },
      // ── Rejected (fail closed): bypass shapes ──
      {
        name: 'Fn::Select over ["*"]',
        resources: s3Allow({ AWS: { 'Fn::Select': [0, ['*']] } }),
        compliant: false,
        guard: 'FAIL',
        expect: { logicalId: 'BucketPolicy', path: S3_PRINCIPAL_PATH, message: 'Fn::Select' },
      },
      {
        name: 'Fn::Join of a nested Fn::Sub "*"',
        resources: s3Allow({ AWS: { 'Fn::Join': ['', [{ 'Fn::Sub': '*' }]] } }),
        compliant: false,
        guard: 'FAIL',
        expect: { logicalId: 'BucketPolicy', path: S3_PRINCIPAL_PATH, message: 'Fn::Join' },
      },
      {
        name: 'Fn::Join of "*" and Ref AWS::NoValue',
        resources: s3Allow({ AWS: { 'Fn::Join': ['', ['*', { Ref: 'AWS::NoValue' }]] } }),
        compliant: false,
        guard: 'FAIL',
        expect: { logicalId: 'BucketPolicy', path: S3_PRINCIPAL_PATH, message: 'Fn::Join' },
      },
      {
        name: 'Fn::Split of "*"',
        resources: s3Allow({ AWS: { 'Fn::Split': [',', '*'] } }),
        compliant: false,
        guard: 'FAIL',
        expect: { logicalId: 'BucketPolicy', path: S3_PRINCIPAL_PATH, message: 'Fn::Split' },
      },
      {
        name: 'Fn::Sub with a variable map resolving to "*"',
        resources: s3Allow({ AWS: { 'Fn::Sub': ['${X}', { X: '*' }] } }),
        compliant: false,
        guard: 'FAIL',
        expect: { logicalId: 'BucketPolicy', path: S3_PRINCIPAL_PATH, message: 'Fn::Sub' },
      },
      {
        name: 'Fn::If with a nested Fn::Sub "*" branch',
        resources: s3Allow({
          AWS: { 'Fn::If': ['C', { 'Fn::Sub': '*' }, 'arn:aws:iam::111122223333:root'] },
        }),
        compliant: false,
        guard: 'FAIL',
        expect: { logicalId: 'BucketPolicy', path: S3_PRINCIPAL_PATH, message: 'Fn::If' },
      },
      {
        name: 'Fn::If with a ["*"] list branch',
        resources: s3Allow({ AWS: { 'Fn::If': ['C', ['*'], 'arn:aws:iam::111122223333:root'] } }),
        compliant: false,
        guard: 'FAIL',
        expect: { logicalId: 'BucketPolicy', path: S3_PRINCIPAL_PATH, message: 'Fn::If' },
      },
      {
        name: 'Fn::If at the Principal level',
        resources: s3Allow({ 'Fn::If': ['C', '*', { AWS: 'arn:aws:iam::111122223333:root' }] }),
        compliant: false,
        guard: 'FAIL',
        expect: { logicalId: 'BucketPolicy', path: S3_PRINCIPAL_PATH, message: 'Fn::If' },
      },
      {
        name: 'Fn::If at the Statement level',
        resources: {
          BucketPolicy: bucketPolicy([
            { 'Fn::If': ['C', { ...ACCOUNT_ALLOW, Principal: '*' }, { Ref: 'AWS::NoValue' }] },
          ]),
        },
        compliant: false,
        guard: 'FAIL',
        expect: {
          logicalId: 'BucketPolicy',
          path: 'Properties/PolicyDocument/Statement/0',
          message: 'not a literal statement',
        },
      },
      {
        name: 'PolicyDocument behind Fn::If (no literal Statement)',
        resources: {
          BucketPolicy: {
            Type: 'AWS::S3::BucketPolicy',
            Properties: {
              Bucket: { Ref: 'Bucket' },
              PolicyDocument: { 'Fn::If': ['C', { Statement: [TLS_DENY] }, { Statement: [] }] },
            },
          },
        },
        compliant: false,
        guard: 'FAIL',
        expect: {
          logicalId: 'BucketPolicy',
          path: 'Properties/PolicyDocument',
          message: 'no literal Statement',
        },
      },
      // ── Rejected: NotPrincipal grants, non-literal Effect, unsafe Ref/GetAtt targets ──
      {
        name: 'Ref to a third-party registry type (Acme::Util::Echo, Value "*")',
        resources: { ...s3Allow({ AWS: { Ref: 'Echo' } }), Echo: ECHO },
        compliant: false,
        guard: 'FAIL',
        expect: { logicalId: 'BucketPolicy', path: S3_PRINCIPAL_PATH, message: 'Acme::Util::Echo' },
      },
      {
        name: 'Fn::GetAtt [Echo, Arn] of a third-party type',
        resources: { ...s3Allow({ AWS: { 'Fn::GetAtt': ['Echo', 'Arn'] } }), Echo: ECHO },
        compliant: false,
        guard: 'FAIL',
        expect: { logicalId: 'BucketPolicy', path: S3_PRINCIPAL_PATH, message: 'Acme::Util::Echo' },
      },
      {
        name: 'Fn::Sub with a ${Param} variable ("arn:aws:iam::${P}:root")',
        resources: s3Allow({ AWS: { 'Fn::Sub': 'arn:aws:iam::${P}:root' } }),
        compliant: false,
        guard: 'FAIL',
        expect: { logicalId: 'BucketPolicy', path: S3_PRINCIPAL_PATH, message: 'Fn::Sub' },
      },
      {
        name: 'Allow + NotPrincipal (grants everyone else)',
        resources: {
          BucketPolicy: bucketPolicy([
            {
              Effect: 'Allow',
              NotPrincipal: { AWS: 'arn:aws:iam::111122223333:root' },
              Action: 's3:GetObject',
              Resource: [{ 'Fn::GetAtt': ['Bucket', 'Arn'] }],
            },
          ]),
        },
        compliant: false,
        guard: 'FAIL',
        expect: {
          logicalId: 'BucketPolicy',
          path: 'Properties/PolicyDocument/Statement/0/NotPrincipal',
          message: 'NotPrincipal',
        },
      },
      {
        name: 'Effect is not a literal Allow/Deny',
        resources: {
          BucketPolicy: bucketPolicy([
            { ...ACCOUNT_ALLOW, Effect: { 'Fn::If': ['C', 'Allow', 'Deny'] }, Principal: '*' },
          ]),
        },
        compliant: false,
        guard: 'FAIL',
        expect: {
          logicalId: 'BucketPolicy',
          path: 'Properties/PolicyDocument/Statement/0/Effect',
          message: 'Effect',
        },
      },
      {
        name: 'Ref to a parameter (could resolve to "*")',
        resources: s3Allow({ AWS: { Ref: 'ReaderPrincipalArn' } }),
        compliant: false,
        guard: 'FAIL',
        expect: {
          logicalId: 'BucketPolicy',
          path: S3_PRINCIPAL_PATH,
          message: 'Ref "ReaderPrincipalArn"',
        },
      },
      {
        name: 'Fn::GetAtt Arn of the auto-delete custom resource (not its provider role)',
        resources: {
          ...s3Allow({ AWS: { 'Fn::GetAtt': ['AutoDelete', 'Arn'] } }),
          AutoDelete: SANDBOX_SPA_BUCKET_POLICY['AutoDelete'] as CfnResourceJson,
        },
        compliant: false,
        guard: 'FAIL',
        expect: { logicalId: 'BucketPolicy', path: S3_PRINCIPAL_PATH, message: 'custom resource' },
      },
    ],
  },
  {
    ruleId: 'BASE-S3-003',
    pass: { BucketPolicy: bucketPolicy([TLS_DENY, ACCOUNT_ALLOW]) },
    fail: { BucketPolicy: bucketPolicy([ACCOUNT_ALLOW]) },
    expect: {
      logicalId: 'BucketPolicy',
      path: 'Properties/PolicyDocument/Statement',
      message: 'aws:SecureTransport=false',
    },
  },
  // ───────────── CloudFront ─────────────
  {
    ruleId: 'BASE-CF-001',
    pass: { Distribution: distribution() },
    fail: {
      Distribution: distribution({
        Origins: [
          {
            Id: 'spa',
            DomainName: 'bucket.s3.ap-southeast-1.amazonaws.com',
            S3OriginConfig: { OriginAccessIdentity: 'origin-access-identity/cloudfront/E2EXAMPLE' },
          },
        ],
      }),
    },
    expect: {
      logicalId: 'Distribution',
      path: 'Properties/DistributionConfig/Origins/0/OriginAccessControlId',
      message: 'no OriginAccessControlId',
    },
  },
  {
    ruleId: 'BASE-CF-002',
    pass: {
      Distribution: distribution(
        {
          ViewerCertificate: {
            AcmCertificateArn: 'arn:aws:acm:us-east-1:111122223333:certificate/abc',
            SslSupportMethod: 'sni-only',
            MinimumProtocolVersion: 'TLSv1.2_2021',
          },
        },
        'prod',
      ),
    },
    fail: {
      Distribution: distribution(
        { ViewerCertificate: { CloudFrontDefaultCertificate: true } },
        'prod',
      ),
    },
    expect: {
      logicalId: 'Distribution',
      path: 'Properties/DistributionConfig/ViewerCertificate',
      message: 'must use a custom ACM certificate',
    },
    variants: [
      {
        name: 'dev may use the default certificate',
        resources: { Distribution: distribution({}, 'dev') },
        compliant: true,
        guard: 'SKIP',
      },
      {
        name: 'custom certificate with an outdated security policy',
        resources: {
          Distribution: distribution({
            ViewerCertificate: {
              AcmCertificateArn: 'arn:aws:acm:us-east-1:111122223333:certificate/abc',
              SslSupportMethod: 'sni-only',
              MinimumProtocolVersion: 'TLSv1.1_2016',
            },
          }),
        },
        compliant: false,
        guard: 'FAIL',
      },
    ],
  },
  {
    ruleId: 'BASE-CF-003',
    pass: {
      Distribution: distribution({
        CacheBehaviors: [
          { PathPattern: '/v1/*', TargetOriginId: 'api', ViewerProtocolPolicy: 'https-only' },
        ],
      }),
    },
    fail: {
      Distribution: distribution({
        CacheBehaviors: [
          { PathPattern: '/v1/*', TargetOriginId: 'api', ViewerProtocolPolicy: 'allow-all' },
        ],
      }),
    },
    expect: {
      logicalId: 'Distribution',
      path: 'Properties/DistributionConfig/CacheBehaviors/0/ViewerProtocolPolicy',
      message: 'ViewerProtocolPolicy is allow-all',
    },
  },
  {
    ruleId: 'BASE-CF-004',
    pass: {
      Distribution: distribution({
        Origins: [
          s3Origin,
          albOrigin(),
          { Id: 'vpc', DomainName: 'internal-alb', VpcOriginConfig: { VpcOriginId: 'vo-1' } },
        ],
      }),
    },
    fail: { Distribution: distribution({ Origins: [s3Origin, albOrigin('http-only')] }) },
    expect: {
      logicalId: 'Distribution',
      path: 'Properties/DistributionConfig/Origins/1/CustomOriginConfig/OriginProtocolPolicy',
      message: 'must be https-only',
    },
    variants: [
      {
        name: 'custom origin allowing TLSv1.1',
        resources: {
          Distribution: distribution({
            Origins: [albOrigin('https-only', ['TLSv1.1', 'TLSv1.2'])],
          }),
        },
        compliant: false,
        guard: 'FAIL',
      },
    ],
  },
  {
    ruleId: 'BASE-CF-005',
    pass: {
      Distribution: distribution({
        Logging: { Bucket: { 'Fn::GetAtt': ['LogBucket', 'RegionalDomainName'] }, Prefix: 'cf/' },
      }),
    },
    fail: { Distribution: distribution() },
    expect: {
      logicalId: 'Distribution',
      path: 'Properties/DistributionConfig/Logging',
      message: 'No standard logging bucket',
    },
    variants: [
      {
        name: 'standard logging v2 delivery source',
        resources: {
          Distribution: distribution(),
          AccessLogs: {
            Type: 'AWS::Logs::DeliverySource',
            Properties: {
              Name: 'cf-access',
              LogType: 'ACCESS_LOGS',
              ResourceArn: { 'Fn::GetAtt': ['Distribution', 'Arn'] },
            },
          },
        },
        compliant: true,
        guard: 'SKIP',
      },
    ],
  },
  {
    ruleId: 'BASE-CF-006',
    pass: {
      Distribution: distribution({
        DefaultCacheBehavior: {
          TargetOriginId: 'spa',
          ViewerProtocolPolicy: 'redirect-to-https',
          ResponseHeadersPolicyId: { Ref: 'SecurityHeaders' },
        },
      }),
      SecurityHeaders: {
        Type: 'AWS::CloudFront::ResponseHeadersPolicy',
        Properties: {
          ResponseHeadersPolicyConfig: {
            Name: 'spa-security-headers',
            SecurityHeadersConfig: {
              StrictTransportSecurity: {
                AccessControlMaxAgeSec: 63072000,
                IncludeSubdomains: true,
                Override: true,
              },
              ContentTypeOptions: { Override: true },
              FrameOptions: { FrameOption: 'DENY', Override: true },
              ReferrerPolicy: { ReferrerPolicy: 'strict-origin-when-cross-origin', Override: true },
            },
          },
        },
      },
    },
    fail: {
      Distribution: distribution({
        DefaultCacheBehavior: {
          TargetOriginId: 'spa',
          ViewerProtocolPolicy: 'redirect-to-https',
          ResponseHeadersPolicyId: '60669652-455b-4ae9-85a4-c4c02393f86c',
        },
      }),
    },
    expect: {
      logicalId: 'Distribution',
      path: 'Properties/DistributionConfig/DefaultCacheBehavior/ResponseHeadersPolicyId',
      message: 'is not one of the security-headers policies',
    },
    variants: [
      {
        name: 'custom policy with a short HSTS max-age',
        resources: {
          SecurityHeaders: {
            Type: 'AWS::CloudFront::ResponseHeadersPolicy',
            Properties: {
              ResponseHeadersPolicyConfig: {
                Name: 'weak',
                SecurityHeadersConfig: {
                  StrictTransportSecurity: { AccessControlMaxAgeSec: 300, Override: true },
                  ContentTypeOptions: { Override: true },
                  FrameOptions: { FrameOption: 'DENY', Override: true },
                  ReferrerPolicy: { ReferrerPolicy: 'no-referrer', Override: true },
                },
              },
            },
          },
        },
        compliant: false,
        guard: 'FAIL',
      },
      {
        name: 'no response headers policy at all',
        resources: {
          Distribution: distribution({
            DefaultCacheBehavior: { TargetOriginId: 'spa', ViewerProtocolPolicy: 'https-only' },
          }),
        },
        compliant: false,
        guard: 'FAIL',
      },
    ],
  },
  // ───────────── ECS ─────────────
  {
    ruleId: 'BASE-ECS-001',
    pass: { TaskDef: taskDef() },
    fail: { TaskDef: taskDef({ User: 'root' }) },
    expect: {
      logicalId: 'TaskDef',
      path: 'Properties/ContainerDefinitions/0/User',
      message: 'runs as root (root)',
    },
    variants: [
      {
        name: 'uid 0 with group',
        resources: { TaskDef: taskDef({ User: '0:0' }) },
        compliant: false,
        guard: 'FAIL',
      },
      {
        name: 'User not set',
        resources: { TaskDef: taskDef({ User: undefined }) },
        compliant: false,
        guard: 'FAIL',
      },
    ],
  },
  {
    ruleId: 'BASE-ECS-002',
    pass: { TaskDef: taskDef() },
    fail: { TaskDef: taskDef({ ReadonlyRootFilesystem: false }) },
    expect: {
      logicalId: 'TaskDef',
      path: 'Properties/ContainerDefinitions/0/ReadonlyRootFilesystem',
      message: 'read-only root FS',
    },
  },
  {
    ruleId: 'BASE-ECS-003',
    pass: { TaskDef: taskDef() },
    fail: { TaskDef: taskDef({ Privileged: true }) },
    expect: {
      logicalId: 'TaskDef',
      path: 'Properties/ContainerDefinitions/0/Privileged',
      message: 'is privileged',
    },
  },
  {
    ruleId: 'BASE-ECS-004',
    pass: { TaskDef: taskDef() },
    fail: { TaskDef: taskDef({}, { NetworkMode: 'bridge' }) },
    expect: { logicalId: 'TaskDef', path: 'Properties/NetworkMode', message: 'must be awsvpc' },
  },
  {
    ruleId: 'BASE-ECS-005',
    pass: { TaskDef: taskDef() },
    fail: { TaskDef: taskDef({ LogConfiguration: undefined }) },
    expect: {
      logicalId: 'TaskDef',
      path: 'Properties/ContainerDefinitions/0/LogConfiguration',
      message: 'has no awslogs/awsfirelens LogConfiguration',
    },
  },
  {
    ruleId: 'BASE-ECS-006',
    pass: { TaskDef: taskDef() },
    fail: {
      TaskDef: taskDef({
        Environment: [
          { Name: 'DB_HOST', Value: 'db.internal' },
          { Name: 'DB_PASSWORD', Value: 'hunter2' },
        ],
      }),
    },
    expect: {
      logicalId: 'TaskDef',
      path: 'Properties/ContainerDefinitions/0/Environment/1/Name',
      message: 'sets DB_PASSWORD as a plain environment variable',
    },
    variants: [
      {
        name: 'empty Environment list',
        resources: { TaskDef: taskDef({ Environment: [] }) },
        compliant: true,
        guard: 'SKIP',
      },
    ],
  },
  {
    ruleId: 'BASE-ECS-007',
    pass: {
      Service: {
        Type: 'AWS::ECS::Service',
        Properties: {
          NetworkConfiguration: {
            AwsvpcConfiguration: { AssignPublicIp: 'DISABLED', Subnets: ['subnet-1'] },
          },
          Tags: tags(),
        },
      },
    },
    fail: {
      Service: {
        Type: 'AWS::ECS::Service',
        Properties: {
          NetworkConfiguration: {
            AwsvpcConfiguration: { AssignPublicIp: 'ENABLED', Subnets: ['subnet-1'] },
          },
          Tags: tags(),
        },
      },
    },
    expect: {
      logicalId: 'Service',
      path: 'Properties/NetworkConfiguration/AwsvpcConfiguration/AssignPublicIp',
      message: 'assigns public IPs',
    },
  },
  {
    ruleId: 'BASE-ECS-008',
    pass: { TaskDef: taskDef() },
    fail: { TaskDef: taskDef({ Environment: envWith({ Name: 'APP_RUNTIME', Value: 'local' }) }) },
    expect: {
      logicalId: 'TaskDef',
      path: 'Properties/ContainerDefinitions/0/Environment/5/Value',
      message: 'sets APP_RUNTIME to a value other than aws',
    },
    variants: [
      {
        name: 'APP_RUNTIME=aws is the default and allowed',
        resources: {
          TaskDef: taskDef({ Environment: envWith({ Name: 'APP_RUNTIME', Value: 'aws' }) }),
        },
        compliant: true,
        guard: 'PASS',
      },
      {
        name: 'APP_RUNTIME from an intrinsic cannot be verified',
        resources: {
          TaskDef: taskDef({
            Environment: envWith({ Name: 'APP_RUNTIME', Value: { Ref: 'Runtime' } }),
          }),
        },
        compliant: false,
        guard: 'FAIL',
      },
      {
        name: 'AUTH_ALLOW_INSECURE_ISSUER set (even to false)',
        resources: {
          TaskDef: taskDef({
            Environment: envWith({ Name: 'AUTH_ALLOW_INSECURE_ISSUER', Value: 'false' }),
          }),
        },
        compliant: false,
        guard: 'FAIL',
      },
      {
        name: 'http: issuer',
        resources: {
          TaskDef: taskDef({
            Environment: envWithout('AUTH_ISSUER', {
              Name: 'AUTH_ISSUER',
              Value: 'http://idp:9400',
            }),
          }),
        },
        compliant: false,
        guard: 'FAIL',
      },
      {
        name: 'HTTP: JWKS URI (scheme is case-insensitive)',
        resources: {
          TaskDef: taskDef({
            Environment: envWith({ Name: 'AUTH_JWKS_URI', Value: 'HTTP://idp/jwks.json' }),
          }),
        },
        compliant: false,
        guard: 'FAIL',
      },
      {
        name: 'https JWKS URI',
        resources: {
          TaskDef: taskDef({
            Environment: envWith({ Name: 'AUTH_JWKS_URI', Value: 'https://idp/jwks.json' }),
          }),
        },
        compliant: true,
        guard: 'PASS',
      },
      {
        name: 'DB_SSL=require (the old permissive mode)',
        resources: {
          TaskDef: taskDef({
            Environment: envWithout('DB_SSL', { Name: 'DB_SSL', Value: 'require' }),
          }),
        },
        compliant: false,
        guard: 'FAIL',
      },
      {
        name: 'DB_HOST without DB_SSL',
        resources: { TaskDef: taskDef({ Environment: envWithout('DB_SSL') }) },
        compliant: false,
        guard: 'FAIL',
      },
      {
        name: 'DB_PASSWORD injected from a secret',
        resources: {
          TaskDef: taskDef({
            Secrets: [{ Name: 'DB_PASSWORD', ValueFrom: 'arn:aws:secretsmanager:x:1:secret:db' }],
          }),
        },
        compliant: false,
        guard: 'FAIL',
      },
      {
        name: 'no environment at all',
        resources: { TaskDef: taskDef({ Environment: undefined, Secrets: undefined }) },
        compliant: true,
        guard: 'SKIP',
      },
      {
        name: 'token-verifying container without AUTH_ALLOWED_CLIENT_IDS',
        resources: { TaskDef: taskDef({ Environment: envWithout('AUTH_ALLOWED_CLIENT_IDS') }) },
        compliant: false,
        guard: 'FAIL',
      },
      {
        name: 'AUTH_AUDIENCE alone also marks a token-verifying container',
        resources: {
          TaskDef: taskDef({
            Environment: [
              { Name: 'PORT', Value: '8080' },
              { Name: 'AUTH_AUDIENCE', Value: 'api://starter-dev-jobs' },
            ],
            Secrets: undefined,
          }),
        },
        compliant: false,
        guard: 'FAIL',
      },
      {
        name: 'empty AUTH_ALLOWED_CLIENT_IDS',
        resources: {
          TaskDef: taskDef({
            Environment: envWithout('AUTH_ALLOWED_CLIENT_IDS', {
              Name: 'AUTH_ALLOWED_CLIENT_IDS',
              Value: '',
            }),
          }),
        },
        compliant: false,
        guard: 'FAIL',
      },
      {
        name: 'AUTH_ALLOWED_CLIENT_IDS of separators and blanks only',
        resources: {
          TaskDef: taskDef({
            Environment: envWithout('AUTH_ALLOWED_CLIENT_IDS', {
              Name: 'AUTH_ALLOWED_CLIENT_IDS',
              Value: ' , ,',
            }),
          }),
        },
        compliant: false,
        guard: 'FAIL',
      },
      {
        name: 'several client ids',
        resources: {
          TaskDef: taskDef({
            Environment: envWithout('AUTH_ALLOWED_CLIENT_IDS', {
              Name: 'AUTH_ALLOWED_CLIENT_IDS',
              Value: 'starter-dev-web,starter-dev-cli',
            }),
          }),
        },
        compliant: true,
        guard: 'PASS',
      },
      {
        name: 'AUTH_ALLOWED_CLIENT_IDS from an intrinsic is accepted (resolved at deploy time)',
        resources: {
          TaskDef: taskDef({
            Environment: envWithout('AUTH_ALLOWED_CLIENT_IDS', {
              Name: 'AUTH_ALLOWED_CLIENT_IDS',
              Value: { Ref: 'SpaClientId' },
            }),
          }),
        },
        compliant: true,
        guard: 'PASS',
      },
      {
        name: 'AUTH_ALLOWED_CLIENT_IDS from an SSM parameter (ECS secret) is accepted',
        resources: {
          TaskDef: taskDef({
            Environment: envWithout('AUTH_ALLOWED_CLIENT_IDS'),
            Secrets: [
              {
                Name: 'AUTH_ALLOWED_CLIENT_IDS',
                ValueFrom: 'arn:aws:ssm:ap-southeast-1:111122223333:parameter/starter/clients',
              },
            ],
          }),
        },
        compliant: true,
        guard: 'PASS',
      },
      {
        name: 'a container that verifies no tokens needs no allow-list (migrations)',
        resources: {
          TaskDef: taskDef({
            Environment: envWithout('AUTH_ISSUER').filter(
              (e) => e.Name !== 'AUTH_ALLOWED_CLIENT_IDS',
            ),
          }),
        },
        compliant: true,
        guard: 'PASS',
      },
    ],
  },
  {
    ruleId: 'BASE-ECS-009',
    pass: { TaskDef: taskDef() },
    fail: {
      TaskDef: taskDef({
        Environment: envWithout('DB_AUTH'),
        Secrets: [{ Name: 'DB_PASSWORD', ValueFrom: 'arn:aws:secretsmanager:x:1:secret:master' }],
      }),
    },
    expect: {
      logicalId: 'TaskDef',
      path: 'Properties/ContainerDefinitions/0/Secrets/0/Name',
      message: 'injects DB_PASSWORD from a secret; use DB_AUTH=iam instead',
    },
    variants: [
      {
        name: 'bootstrap-style task: DB_AUTH=secrets-manager with DB_SECRET_ARN',
        resources: {
          TaskDef: taskDef({
            Environment: envWithout(
              'DB_AUTH',
              { Name: 'DB_AUTH', Value: 'secrets-manager' },
              { Name: 'DB_SECRET_ARN', Value: 'arn:aws:secretsmanager:x:1:secret:master' },
            ),
          }),
        },
        compliant: false,
        guard: 'FAIL',
      },
      {
        name: 'DB_USER injected from the master secret',
        resources: {
          TaskDef: taskDef({
            Secrets: [{ Name: 'DB_USER', ValueFrom: 'arn:aws:secretsmanager:x:1:secret:master' }],
          }),
        },
        compliant: false,
        guard: 'FAIL',
      },
      {
        name: 'DB_HOST without DB_AUTH',
        resources: { TaskDef: taskDef({ Environment: envWithout('DB_AUTH') }) },
        compliant: false,
        guard: 'FAIL',
      },
      {
        name: 'no database at all',
        resources: {
          TaskDef: taskDef({ Environment: [{ Name: 'PORT', Value: '8080' }], Secrets: undefined }),
        },
        compliant: true,
        guard: 'PASS',
      },
    ],
  },
  // ───────────── IAM ─────────────
  {
    ruleId: 'BASE-IAM-001',
    pass: {
      Policy: iamPolicy([
        { Effect: 'Allow', Action: ['s3:GetObject*', 's3:List*'], Resource: 'arn:aws:s3:::spa/*' },
        {
          Effect: 'Deny',
          Action: '*',
          Resource: '*',
          Condition: { Bool: { 'aws:SecureTransport': 'false' } },
        },
      ]),
    },
    fail: {
      Policy: iamPolicy([{ Effect: 'Allow', Action: 's3:*', Resource: 'arn:aws:s3:::spa/*' }]),
    },
    expect: {
      logicalId: 'Policy',
      path: 'Properties/PolicyDocument/Statement/0/Action',
      message: 'wildcard action "s3:*"',
    },
    variants: [
      {
        name: 'inline role policy with "*"',
        resources: {
          Role: role({
            Policies: [
              {
                PolicyName: 'inline',
                PolicyDocument: {
                  Version: '2012-10-17',
                  Statement: [{ Effect: 'Allow', Action: '*', Resource: TABLE_ARN }],
                },
              },
            ],
          }),
        },
        compliant: false,
        guard: 'FAIL',
      },
      {
        name: 'Allow with NotAction',
        resources: {
          Policy: iamPolicy([{ Effect: 'Allow', NotAction: 'iam:*', Resource: TABLE_ARN }]),
        },
        compliant: false,
        guard: 'FAIL',
      },
    ],
  },
  {
    ruleId: 'BASE-IAM-002',
    pass: {
      Policy: iamPolicy([
        {
          Effect: 'Allow',
          Action: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'],
          Resource: '*',
        },
        {
          Effect: 'Allow',
          Action: ['dynamodb:GetItem', 'dynamodb:PutItem'],
          Resource: [TABLE_ARN],
        },
      ]),
    },
    fail: { Policy: iamPolicy([{ Effect: 'Allow', Action: 'dynamodb:GetItem', Resource: '*' }]) },
    expect: {
      logicalId: 'Policy',
      path: 'Properties/PolicyDocument/Statement/0/Resource',
      message: 'Action "dynamodb:GetItem" is granted on Resource "*"',
    },
    variants: [
      {
        name: 'allowlisted action mixed with a scoped-able action on "*"',
        resources: {
          Policy: iamPolicy([
            {
              Effect: 'Allow',
              Action: ['ecr:GetAuthorizationToken', 'ecr:BatchGetImage'],
              Resource: ['*'],
            },
          ]),
        },
        compliant: false,
        guard: 'FAIL',
      },
      {
        name: 'Allow with NotResource',
        resources: {
          Policy: iamPolicy([
            { Effect: 'Allow', Action: 's3:GetObject', NotResource: 'arn:aws:s3:::x/*' },
          ]),
        },
        compliant: false,
        guard: 'FAIL',
      },
    ],
  },
  {
    ruleId: 'BASE-IAM-003',
    pass: {
      Role: role({ ManagedPolicyArns: [managedArn('service-role/AWSLambdaBasicExecutionRole')] }),
    },
    fail: { Role: role({ ManagedPolicyArns: [managedArn('AdministratorAccess')] }) },
    expect: {
      logicalId: 'Role',
      path: 'Properties/ManagedPolicyArns/0',
      message: 'Attaches managed policy AdministratorAccess',
    },
    variants: [
      {
        name: 'literal PowerUserAccess ARN',
        resources: {
          Role: role({ ManagedPolicyArns: ['arn:aws:iam::aws:policy/PowerUserAccess'] }),
        },
        compliant: false,
        guard: 'FAIL',
      },
      {
        name: 'inline Allow * on *',
        resources: { Policy: iamPolicy([{ Effect: 'Allow', Action: '*', Resource: '*' }]) },
        compliant: false,
        guard: 'FAIL',
      },
    ],
  },
  {
    ruleId: 'BASE-IAM-004',
    options: {
      permissionsBoundaryArn: 'arn:aws:iam::111122223333:policy/starter-workload-boundary',
    },
    pass: {
      Role: role({
        PermissionsBoundary: 'arn:aws:iam::111122223333:policy/starter-workload-boundary',
      }),
    },
    fail: { Role: role() },
    expect: {
      logicalId: 'Role',
      path: 'Properties/PermissionsBoundary',
      message: 'no permissions boundary',
    },
  },
  {
    ruleId: 'BASE-IAM-005',
    pass: { Role: role() },
    guardPass: 'SKIP',
    fail: { User: { Type: 'AWS::IAM::User', Properties: { UserName: 'ci-deployer' } } },
    expect: { logicalId: 'User', path: 'Type', message: 'creates long-lived IAM credentials' },
    variants: [
      {
        name: 'access key',
        resources: {
          Key: { Type: 'AWS::IAM::AccessKey', Properties: { UserName: 'someone' } },
        },
        compliant: false,
        guard: 'FAIL',
      },
    ],
  },
  {
    ruleId: 'BASE-IAM-006',
    pass: {
      Role: role({
        AssumeRolePolicyDocument: {
          Version: '2012-10-17',
          Statement: [
            ...TRUST_ECS.Statement,
            {
              Effect: 'Allow',
              Principal: { AWS: 'arn:aws:iam::111122223333:root' },
              Action: 'sts:AssumeRole',
            },
            // Regression: the shape CDK synthesizes for an ArnPrincipal built
            // from the partition and account (IntegrationWorkflowStack operator role).
            {
              Effect: 'Allow',
              Principal: { AWS: OPERATOR_ROLE_ARN },
              Action: 'sts:AssumeRole',
              Condition: { StringLike: { 'sts:RoleSessionName': 'starter-it-*' } },
            },
          ],
        },
      }),
    },
    fail: {
      Role: role({
        AssumeRolePolicyDocument: {
          Version: '2012-10-17',
          Statement: [{ Effect: 'Allow', Principal: { AWS: '*' }, Action: 'sts:AssumeRole' }],
        },
      }),
    },
    expect: {
      logicalId: 'Role',
      path: 'Properties/AssumeRolePolicyDocument/Statement/0/Principal',
      message: 'wildcard principal',
    },
    variants: [
      // ── Accepted (allowlist): literal principals and ARN-building intrinsics ──
      {
        name: 'every Service principal the infra synthesizes (dev/staging/prod/sandbox/integration)',
        resources: {
          Role: role({
            AssumeRolePolicyDocument: {
              Version: '2012-10-17',
              Statement: SYNTHESIZED_SERVICE_PRINCIPALS.map((service) => ({
                Effect: 'Allow',
                Principal: { Service: service },
                Action: 'sts:AssumeRole',
              })),
            },
          }),
        },
        compliant: true,
        guard: 'PASS',
      },
      {
        name: 'single Statement object (not a list)',
        resources: {
          Role: role({
            AssumeRolePolicyDocument: {
              Version: '2012-10-17',
              Statement: {
                Effect: 'Allow',
                Principal: { Service: 'lambda.amazonaws.com' },
                Action: 'sts:AssumeRole',
              },
            },
          }),
        },
        compliant: true,
        guard: 'PASS',
      },
      {
        name: 'Federated OIDC provider ARN and CanonicalUser ID literals',
        resources: {
          Role: trustRole({
            Federated: 'arn:aws:iam::111122223333:oidc-provider/gitlab.example.com',
            CanonicalUser: '79a59df900b949e55d96a1e698fbacedfd6e09d98eacf8f8d5218e7cd47ef2be',
          }),
        },
        compliant: true,
        guard: 'PASS',
      },
      {
        name: 'Fn::Sub string-form account-root ARN',
        resources: {
          Role: trustRole({
            AWS: { 'Fn::Sub': 'arn:${AWS::Partition}:iam::${AWS::AccountId}:root' },
          }),
        },
        compliant: true,
        guard: 'PASS',
      },
      {
        name: 'Ref AWS::AccountId (account principal)',
        resources: { Role: trustRole({ AWS: { Ref: 'AWS::AccountId' } }) },
        compliant: true,
        guard: 'PASS',
      },
      {
        name: 'Ref to an OIDC provider in the template (Ref returns its ARN)',
        resources: {
          Role: trustRole({ Federated: { Ref: 'GitLabOidc' } }),
          GitLabOidc: {
            Type: 'AWS::IAM::OIDCProvider',
            Properties: { Url: 'https://gitlab.example.com', ClientIdList: ['sts.amazonaws.com'] },
          },
        },
        compliant: true,
        guard: 'PASS',
      },
      {
        name: 'Fn::GetAtt Arn of a role in the template',
        resources: {
          Role: trustRole({ AWS: { 'Fn::GetAtt': ['OperatorRole', 'Arn'] } }),
          OperatorRole: role(),
        },
        compliant: true,
        guard: 'PASS',
      },
      {
        name: 'list mixing literal and intrinsic ARNs',
        resources: {
          Role: trustRole({
            AWS: [
              'arn:aws:iam::111122223333:root',
              OPERATOR_ROLE_ARN,
              { 'Fn::GetAtt': ['OperatorRole', 'Arn'] },
            ],
          }),
          OperatorRole: role(),
        },
        compliant: true,
        guard: 'PASS',
      },
      {
        name: 'Fn::Join of literal ARN parts',
        resources: {
          Role: trustRole({
            AWS: { 'Fn::Join': ['', ['arn:aws:iam::', '111122223333', ':root']] },
          }),
        },
        compliant: true,
        guard: 'PASS',
      },
      {
        name: 'Fn::Join with ":" delimiter and leading "arn"',
        resources: {
          Role: trustRole({
            AWS: {
              'Fn::Join': [
                ':',
                ['arn', { Ref: 'AWS::Partition' }, 'iam', '', { Ref: 'AWS::AccountId' }, 'root'],
              ],
            },
          }),
        },
        compliant: true,
        guard: 'PASS',
      },
      {
        name: 'Fn::Join with a Fn::GetAtt Arn part',
        resources: {
          Role: trustRole({
            AWS: { 'Fn::Join': ['', ['arn:', { 'Fn::GetAtt': ['OperatorRole', 'Arn'] }]] },
          }),
          OperatorRole: role(),
        },
        compliant: true,
        guard: 'PASS',
      },
      {
        name: 'Deny statement with a "*" principal (restricts, never grants)',
        resources: {
          Role: role({
            AssumeRolePolicyDocument: {
              Version: '2012-10-17',
              Statement: [
                ...TRUST_ECS.Statement,
                { Effect: 'Deny', Principal: { AWS: '*' }, Action: 'sts:AssumeRole' },
              ],
            },
          }),
        },
        compliant: true,
        guard: 'PASS',
      },
      {
        name: 'Fn::GetAtt dotted-string form "Role.Arn" (YAML !GetAtt short form)',
        resources: {
          Role: trustRole({ AWS: { 'Fn::GetAtt': 'OperatorRole.Arn' } }),
          OperatorRole: role(),
        },
        compliant: true,
        guard: 'PASS',
      },
      {
        name: 'Fn::GetAtt Arn of an IAM user and Ref to a SAML provider',
        resources: {
          Role: trustRole({
            AWS: { 'Fn::GetAtt': ['BreakGlassUser', 'Arn'] },
            Federated: { Ref: 'Saml' },
          }),
          BreakGlassUser: { Type: 'AWS::IAM::User', Properties: {} },
          Saml: { Type: 'AWS::IAM::SAMLProvider', Properties: { SamlMetadataDocument: '<x/>' } },
        },
        compliant: true,
        guard: 'PASS',
      },
      {
        name: 'Fn::Sub using all four accepted pseudo parameters',
        resources: {
          Role: trustRole({
            AWS: {
              'Fn::Sub':
                'arn:${AWS::Partition}:iam::${AWS::AccountId}:role/${AWS::Region}-${AWS::URLSuffix}',
            },
          }),
        },
        compliant: true,
        guard: 'PASS',
      },
      // ── Rejected: literal wildcards ──
      {
        name: 'Principal "*"',
        resources: { Role: trustRole('*') },
        compliant: false,
        guard: 'FAIL',
        expect: { logicalId: 'Role', path: PRINCIPAL_PATH, message: 'wildcard principal ("*")' },
      },
      {
        name: '"*" inside an AWS principal list',
        resources: { Role: trustRole({ AWS: [OPERATOR_ROLE_ARN, '*'] }) },
        compliant: false,
        guard: 'FAIL',
        expect: {
          logicalId: 'Role',
          path: PRINCIPAL_PATH,
          message: 'wildcard principal (AWS "*")',
        },
      },
      {
        name: 'Service "*"',
        resources: { Role: trustRole({ Service: '*' }) },
        compliant: false,
        guard: 'FAIL',
        expect: {
          logicalId: 'Role',
          path: PRINCIPAL_PATH,
          message: 'wildcard principal (Service "*")',
        },
      },
      {
        name: 'Federated "*"',
        resources: { Role: trustRole({ Federated: '*' }) },
        compliant: false,
        guard: 'FAIL',
        expect: {
          logicalId: 'Role',
          path: PRINCIPAL_PATH,
          message: 'wildcard principal (Federated "*")',
        },
      },
      {
        name: 'CanonicalUser "*"',
        resources: { Role: trustRole({ CanonicalUser: '*' }) },
        compliant: false,
        guard: 'FAIL',
        expect: {
          logicalId: 'Role',
          path: PRINCIPAL_PATH,
          message: 'wildcard principal (CanonicalUser "*")',
        },
      },
      {
        name: 'wildcard pattern in a literal ARN',
        resources: { Role: trustRole({ AWS: 'arn:aws:iam::*:root' }) },
        compliant: false,
        guard: 'FAIL',
        expect: { logicalId: 'Role', path: PRINCIPAL_PATH, message: 'wildcard principal' },
      },
      // ── Rejected: NotPrincipal (any effect) ──
      {
        name: 'Allow + NotPrincipal',
        resources: {
          Role: role({
            AssumeRolePolicyDocument: {
              Version: '2012-10-17',
              Statement: [
                {
                  Effect: 'Allow',
                  NotPrincipal: { AWS: 'arn:aws:iam::111122223333:root' },
                  Action: 'sts:AssumeRole',
                },
              ],
            },
          }),
        },
        compliant: false,
        guard: 'FAIL',
        expect: {
          logicalId: 'Role',
          path: 'Properties/AssumeRolePolicyDocument/Statement/0/NotPrincipal',
          message: 'NotPrincipal',
        },
      },
      {
        name: 'Deny + NotPrincipal',
        resources: {
          Role: role({
            AssumeRolePolicyDocument: {
              Version: '2012-10-17',
              Statement: [
                ...TRUST_ECS.Statement,
                {
                  Effect: 'Deny',
                  NotPrincipal: { AWS: 'arn:aws:iam::111122223333:root' },
                  Action: 'sts:AssumeRole',
                },
              ],
            },
          }),
        },
        compliant: false,
        guard: 'FAIL',
        expect: {
          logicalId: 'Role',
          path: 'Properties/AssumeRolePolicyDocument/Statement/1/NotPrincipal',
          message: 'NotPrincipal',
        },
      },
      // ── Rejected (fail closed): bypasses of an earlier denylist ──
      {
        name: 'Fn::Select over ["*"]',
        resources: { Role: trustRole({ AWS: { 'Fn::Select': [0, ['*']] } }) },
        compliant: false,
        guard: 'FAIL',
        expect: { logicalId: 'Role', path: PRINCIPAL_PATH, message: 'Fn::Select' },
      },
      {
        name: 'Fn::Join of a nested Fn::Sub "*"',
        resources: { Role: trustRole({ AWS: { 'Fn::Join': ['', [{ 'Fn::Sub': '*' }]] } }) },
        compliant: false,
        guard: 'FAIL',
        expect: { logicalId: 'Role', path: PRINCIPAL_PATH, message: 'Fn::Join' },
      },
      {
        name: 'Fn::Join of "*" and Ref AWS::NoValue',
        resources: {
          Role: trustRole({ AWS: { 'Fn::Join': ['', ['*', { Ref: 'AWS::NoValue' }]] } }),
        },
        compliant: false,
        guard: 'FAIL',
        expect: { logicalId: 'Role', path: PRINCIPAL_PATH, message: 'Fn::Join' },
      },
      {
        name: 'Fn::Split of "*"',
        resources: { Role: trustRole({ AWS: { 'Fn::Split': [',', '*'] } }) },
        compliant: false,
        guard: 'FAIL',
        expect: { logicalId: 'Role', path: PRINCIPAL_PATH, message: 'Fn::Split' },
      },
      {
        name: 'Fn::Sub with a variable map resolving to "*"',
        resources: { Role: trustRole({ AWS: { 'Fn::Sub': ['${X}', { X: '*' }] } }) },
        compliant: false,
        guard: 'FAIL',
        expect: { logicalId: 'Role', path: PRINCIPAL_PATH, message: 'Fn::Sub' },
      },
      {
        name: 'Fn::If with a nested Fn::Sub "*" branch',
        resources: {
          Role: trustRole({
            AWS: { 'Fn::If': ['C', { 'Fn::Sub': '*' }, 'arn:aws:iam::111122223333:root'] },
          }),
        },
        compliant: false,
        guard: 'FAIL',
        expect: { logicalId: 'Role', path: PRINCIPAL_PATH, message: 'Fn::If' },
      },
      {
        name: 'Fn::If with a ["*"] list branch (former engine disagreement)',
        resources: {
          Role: trustRole({ AWS: { 'Fn::If': ['C', ['*'], 'arn:aws:iam::111122223333:root'] } }),
        },
        compliant: false,
        guard: 'FAIL',
        expect: { logicalId: 'Role', path: PRINCIPAL_PATH, message: 'Fn::If' },
      },
      {
        name: 'Fn::If at the Principal level',
        resources: {
          Role: trustRole({ 'Fn::If': ['C', '*', { AWS: 'arn:aws:iam::111122223333:root' }] }),
        },
        compliant: false,
        guard: 'FAIL',
        expect: { logicalId: 'Role', path: PRINCIPAL_PATH, message: 'Fn::If' },
      },
      {
        name: 'Fn::If at the Statement level',
        resources: {
          Role: role({
            AssumeRolePolicyDocument: {
              Version: '2012-10-17',
              Statement: [
                {
                  'Fn::If': [
                    'C',
                    { Effect: 'Allow', Principal: '*', Action: 'sts:AssumeRole' },
                    { Ref: 'AWS::NoValue' },
                  ],
                },
              ],
            },
          }),
        },
        compliant: false,
        guard: 'FAIL',
        expect: {
          logicalId: 'Role',
          path: 'Properties/AssumeRolePolicyDocument/Statement/0',
          message: 'not a literal statement',
        },
      },
      {
        name: 'AssumeRolePolicyDocument behind Fn::If (no literal Statement)',
        resources: {
          Role: role({
            AssumeRolePolicyDocument: {
              'Fn::If': ['C', TRUST_ECS, { Version: '2012-10-17', Statement: [] }],
            },
          }),
        },
        compliant: false,
        guard: 'FAIL',
        expect: {
          logicalId: 'Role',
          path: 'Properties/AssumeRolePolicyDocument',
          message: 'no literal Statement',
        },
      },
      // ── Rejected (fail closed): other shapes outside the allowlist ──
      {
        name: 'Fn::If between two ARNs',
        resources: {
          Role: trustRole({
            AWS: { 'Fn::If': ['IsProd', 'arn:aws:iam::111122223333:root', OPERATOR_ROLE_ARN] },
          }),
        },
        compliant: false,
        guard: 'FAIL',
        expect: { logicalId: 'Role', path: PRINCIPAL_PATH, message: 'Fn::If' },
      },
      {
        name: 'Fn::Sub with a variable map (even when it builds an ARN)',
        resources: {
          Role: trustRole({
            AWS: { 'Fn::Sub': ['arn:aws:iam::${Acct}:root', { Acct: { Ref: 'AWS::AccountId' } }] },
          }),
        },
        compliant: false,
        guard: 'FAIL',
        expect: { logicalId: 'Role', path: PRINCIPAL_PATH, message: 'Fn::Sub' },
      },
      {
        name: 'Fn::Sub that does not start with "arn:"',
        resources: { Role: trustRole({ AWS: { 'Fn::Sub': '${AWS::AccountId}' } }) },
        compliant: false,
        guard: 'FAIL',
        expect: { logicalId: 'Role', path: PRINCIPAL_PATH, message: 'Fn::Sub' },
      },
      {
        name: 'Fn::ImportValue',
        resources: { Role: trustRole({ AWS: { 'Fn::ImportValue': 'shared-operator-arn' } }) },
        compliant: false,
        guard: 'FAIL',
        expect: { logicalId: 'Role', path: PRINCIPAL_PATH, message: 'Fn::ImportValue' },
      },
      {
        name: 'Ref to a parameter (could resolve to "*")',
        resources: { Role: trustRole({ AWS: { Ref: 'TrustedPrincipalArn' } }) },
        compliant: false,
        guard: 'FAIL',
        expect: { logicalId: 'Role', path: PRINCIPAL_PATH, message: 'Ref "TrustedPrincipalArn"' },
      },
      {
        name: 'Ref to a custom resource (value set by its provider)',
        resources: {
          Role: trustRole({ AWS: { Ref: 'Lookup' } }),
          Lookup: { Type: 'Custom::PrincipalLookup', Properties: { ServiceToken: 'arn:x' } },
        },
        compliant: false,
        guard: 'FAIL',
        expect: { logicalId: 'Role', path: PRINCIPAL_PATH, message: 'Ref "Lookup"' },
      },
      {
        name: 'Fn::GetAtt of a resource that is not in the template',
        resources: { Role: trustRole({ AWS: { 'Fn::GetAtt': ['OperatorRole', 'Arn'] } }) },
        compliant: false,
        guard: 'FAIL',
        expect: { logicalId: 'Role', path: PRINCIPAL_PATH, message: 'Fn::GetAtt' },
      },
      {
        name: 'Fn::GetAtt of a non-ARN attribute (SSM parameter Value)',
        resources: {
          Role: trustRole({ AWS: { 'Fn::GetAtt': ['Param', 'Value'] } }),
          Param: { Type: 'AWS::SSM::Parameter', Properties: { Type: 'String', Value: '*' } },
        },
        compliant: false,
        guard: 'FAIL',
        expect: { logicalId: 'Role', path: PRINCIPAL_PATH, message: 'Fn::GetAtt' },
      },
      {
        name: 'Fn::GetAtt Arn of a custom resource',
        resources: {
          Role: trustRole({ AWS: { 'Fn::GetAtt': ['Lookup', 'Arn'] } }),
          Lookup: { Type: 'Custom::PrincipalLookup', Properties: { ServiceToken: 'arn:x' } },
        },
        compliant: false,
        guard: 'FAIL',
        expect: { logicalId: 'Role', path: PRINCIPAL_PATH, message: 'Fn::GetAtt' },
      },
      {
        name: 'Fn::Join without a literal ARN prefix',
        resources: {
          Role: trustRole({ AWS: { 'Fn::Join': ['', [{ Ref: 'AWS::AccountId' }]] } }),
        },
        compliant: false,
        guard: 'FAIL',
        expect: { logicalId: 'Role', path: PRINCIPAL_PATH, message: 'Fn::Join' },
      },
      {
        name: 'Fn::Join over a non-literal part list (Fn::Split)',
        resources: {
          Role: trustRole({ AWS: { 'Fn::Join': ['', { 'Fn::Split': [',', 'arn:,*'] }] } }),
        },
        compliant: false,
        guard: 'FAIL',
        expect: { logicalId: 'Role', path: PRINCIPAL_PATH, message: 'Fn::Join' },
      },
      {
        name: 'object with two intrinsic keys',
        resources: {
          Role: trustRole({
            AWS: { Ref: 'AWS::AccountId', 'Fn::Sub': 'arn:aws:iam::111122223333:root' },
          }),
        },
        compliant: false,
        guard: 'FAIL',
        expect: { logicalId: 'Role', path: PRINCIPAL_PATH, message: 'single intrinsic' },
      },
      {
        name: 'nested list inside an AWS principal list',
        resources: { Role: trustRole({ AWS: [['*']] }) },
        compliant: false,
        guard: 'FAIL',
        expect: { logicalId: 'Role', path: PRINCIPAL_PATH, message: 'not a string' },
      },
      {
        name: 'Effect is not a literal Allow/Deny',
        resources: {
          Role: role({
            AssumeRolePolicyDocument: {
              Version: '2012-10-17',
              Statement: [
                {
                  Effect: { 'Fn::If': ['C', 'Allow', 'Deny'] },
                  Principal: '*',
                  Action: 'sts:AssumeRole',
                },
              ],
            },
          }),
        },
        compliant: false,
        guard: 'FAIL',
        expect: {
          logicalId: 'Role',
          path: 'Properties/AssumeRolePolicyDocument/Statement/0/Effect',
          message: 'Effect',
        },
      },
      // ── Rejected: registry/non-principal types and Fn::Sub variable probes ──
      {
        name: 'Ref to a third-party registry type (Acme::Util::Echo, Value "*")',
        resources: { Role: trustRole({ AWS: { Ref: 'Echo' } }), Echo: ECHO },
        compliant: false,
        guard: 'FAIL',
        expect: { logicalId: 'Role', path: PRINCIPAL_PATH, message: 'Acme::Util::Echo' },
      },
      {
        name: 'Fn::GetAtt [Echo, Arn] of a third-party type',
        resources: { Role: trustRole({ AWS: { 'Fn::GetAtt': ['Echo', 'Arn'] } }), Echo: ECHO },
        compliant: false,
        guard: 'FAIL',
        expect: { logicalId: 'Role', path: PRINCIPAL_PATH, message: 'Acme::Util::Echo' },
      },
      {
        name: 'Fn::GetAtt [EchoMod, ValueArn] of a ::MODULE type',
        resources: {
          Role: trustRole({ AWS: { 'Fn::GetAtt': ['EchoMod', 'ValueArn'] } }),
          EchoMod: { Type: 'Acme::Util::Echo::MODULE', Properties: { Value: '*' } },
        },
        compliant: false,
        guard: 'FAIL',
        expect: { logicalId: 'Role', path: PRINCIPAL_PATH, message: 'Fn::GetAtt' },
      },
      {
        name: 'Service Ref to a third-party type',
        resources: { Role: trustRole({ Service: { Ref: 'Echo' } }), Echo: ECHO },
        compliant: false,
        guard: 'FAIL',
        expect: { logicalId: 'Role', path: PRINCIPAL_PATH, message: 'Acme::Util::Echo' },
      },
      {
        name: 'Ref to an AWS::SSM::Parameter (AWS type, not a principal)',
        resources: {
          Role: trustRole({ AWS: { Ref: 'Ssm' } }),
          Ssm: { Type: 'AWS::SSM::Parameter', Properties: { Type: 'String', Value: '*' } },
        },
        compliant: false,
        guard: 'FAIL',
        expect: { logicalId: 'Role', path: PRINCIPAL_PATH, message: 'AWS::SSM::Parameter' },
      },
      {
        name: 'Service Ref to a Route53 RecordSet named "*.example.com."',
        resources: {
          Role: trustRole({ Service: { Ref: 'Rec' } }),
          Rec: {
            Type: 'AWS::Route53::RecordSet',
            Properties: { Name: '*.example.com.', Type: 'A', HostedZoneId: 'Z1' },
          },
        },
        compliant: false,
        guard: 'FAIL',
        expect: { logicalId: 'Role', path: PRINCIPAL_PATH, message: 'AWS::Route53::RecordSet' },
      },
      {
        name: 'Fn::Join with a Ref part to a third-party type',
        resources: {
          Role: trustRole({
            AWS: { 'Fn::Join': ['', ['arn:aws:iam::', { Ref: 'Echo' }, ':root']] },
          }),
          Echo: ECHO,
        },
        compliant: false,
        guard: 'FAIL',
        expect: { logicalId: 'Role', path: PRINCIPAL_PATH, message: 'Acme::Util::Echo' },
      },
      {
        name: 'Ref to an IAM role (Ref returns the role name, not an ARN)',
        resources: { Role: trustRole({ AWS: { Ref: 'OperatorRole' } }), OperatorRole: role() },
        compliant: false,
        guard: 'FAIL',
        expect: { logicalId: 'Role', path: PRINCIPAL_PATH, message: 'AWS::IAM::Role' },
      },
      {
        name: 'Ref AWS::StackName (not an accepted pseudo parameter)',
        resources: { Role: trustRole({ AWS: { Ref: 'AWS::StackName' } }) },
        compliant: false,
        guard: 'FAIL',
        expect: { logicalId: 'Role', path: PRINCIPAL_PATH, message: 'Ref "AWS::StackName"' },
      },
      {
        name: 'Fn::GetAtt dotted-string form of a non-Arn attribute ("Role.RoleId")',
        resources: {
          Role: trustRole({ AWS: { 'Fn::GetAtt': 'OperatorRole.RoleId' } }),
          OperatorRole: role(),
        },
        compliant: false,
        guard: 'FAIL',
        expect: { logicalId: 'Role', path: PRINCIPAL_PATH, message: 'Fn::GetAtt' },
      },
      {
        name: 'Fn::Sub with a ${Param} variable ("arn:aws:iam::${P}:root")',
        resources: { Role: trustRole({ AWS: { 'Fn::Sub': 'arn:aws:iam::${P}:root' } }) },
        compliant: false,
        guard: 'FAIL',
        expect: { logicalId: 'Role', path: PRINCIPAL_PATH, message: 'Fn::Sub' },
      },
      {
        name: 'Fn::Sub with a custom-resource attribute ("arn:${Cust.Arn}")',
        resources: {
          Role: trustRole({ AWS: { 'Fn::Sub': 'arn:${Cust.Arn}' } }),
          Cust: { Type: 'Custom::X', Properties: { ServiceToken: 'arn:x' } },
        },
        compliant: false,
        guard: 'FAIL',
        expect: { logicalId: 'Role', path: PRINCIPAL_PATH, message: 'Fn::Sub' },
      },
      {
        name: 'Fn::Sub with a third-party resource ("arn:${Echo}")',
        resources: { Role: trustRole({ AWS: { 'Fn::Sub': 'arn:${Echo}' } }), Echo: ECHO },
        compliant: false,
        guard: 'FAIL',
        expect: { logicalId: 'Role', path: PRINCIPAL_PATH, message: 'Fn::Sub' },
      },
      {
        name: 'Fn::Sub with ${AWS::NoValue}',
        resources: { Role: trustRole({ AWS: { 'Fn::Sub': 'arn:${AWS::NoValue}' } }) },
        compliant: false,
        guard: 'FAIL',
        expect: { logicalId: 'Role', path: PRINCIPAL_PATH, message: 'Fn::Sub' },
      },
      {
        name: 'parity: Fn::GetAtt ["OperatorRole", ["Arn"]] (list attribute)',
        resources: {
          Role: trustRole({ AWS: { 'Fn::GetAtt': ['OperatorRole', ['Arn']] } }),
          OperatorRole: role(),
        },
        compliant: false,
        guard: 'FAIL',
        expect: { logicalId: 'Role', path: PRINCIPAL_PATH, message: 'Fn::GetAtt' },
      },
      {
        name: 'parity: Ref ["AWS::AccountId"] (list target)',
        resources: { Role: trustRole({ AWS: { Ref: ['AWS::AccountId'] } }) },
        compliant: false,
        guard: 'FAIL',
        expect: { logicalId: 'Role', path: PRINCIPAL_PATH, message: 'Ref target' },
      },
      {
        name: 'parity: Fn::Join part Ref ["AWS::AccountId"]',
        resources: {
          Role: trustRole({ AWS: { 'Fn::Join': ['', ['arn:x', { Ref: ['AWS::AccountId'] }]] } }),
        },
        compliant: false,
        guard: 'FAIL',
        expect: { logicalId: 'Role', path: PRINCIPAL_PATH, message: 'Ref target' },
      },
      {
        name: 'parity: Fn::Sub ["arn:aws:iam::111122223333:root"] (1-element list)',
        resources: { Role: trustRole({ AWS: { 'Fn::Sub': ['arn:aws:iam::111122223333:root'] } }) },
        compliant: false,
        guard: 'FAIL',
        expect: { logicalId: 'Role', path: PRINCIPAL_PATH, message: 'Fn::Sub' },
      },
      {
        name: 'parity: Fn::Sub ["arn:a", "arn:b"] (two strings)',
        resources: { Role: trustRole({ AWS: { 'Fn::Sub': ['arn:a', 'arn:b'] } }) },
        compliant: false,
        guard: 'FAIL',
        expect: { logicalId: 'Role', path: PRINCIPAL_PATH, message: 'Fn::Sub' },
      },
      {
        name: 'parity: Fn::Join first part is a list ([["arn"], "x"])',
        resources: { Role: trustRole({ AWS: { 'Fn::Join': [':', [['arn'], 'x']] } }) },
        compliant: false,
        guard: 'FAIL',
        expect: { logicalId: 'Role', path: PRINCIPAL_PATH, message: 'Fn::Join' },
      },
      // Shapes of the earlier denylist (kept as regressions).
      {
        name: 'Fn::Sub "*"',
        resources: { Role: trustRole({ AWS: { 'Fn::Sub': '*' } }) },
        compliant: false,
        guard: 'FAIL',
      },
      {
        name: 'Fn::Sub list form with template "*"',
        resources: { Role: trustRole({ AWS: { 'Fn::Sub': ['*', {}] } }) },
        compliant: false,
        guard: 'FAIL',
      },
      {
        name: 'Fn::Join of only "*"',
        resources: { Role: trustRole({ AWS: { 'Fn::Join': ['', ['*', '']] } }) },
        compliant: false,
        guard: 'FAIL',
      },
      {
        name: 'Fn::Join with "*" delimiter and empty parts',
        resources: { Role: trustRole({ AWS: { 'Fn::Join': ['*', ['', '']] } }) },
        compliant: false,
        guard: 'FAIL',
      },
      {
        name: 'Fn::If with a "*" branch',
        resources: { Role: trustRole({ AWS: { 'Fn::If': ['IsProd', OPERATOR_ROLE_ARN, '*'] } }) },
        compliant: false,
        guard: 'FAIL',
      },
      {
        name: 'Fn::Sub "*" inside a list of ARNs',
        resources: { Role: trustRole({ AWS: [OPERATOR_ROLE_ARN, { 'Fn::Sub': '*' }] }) },
        compliant: false,
        guard: 'FAIL',
      },
    ],
  },
  // ───────────── Lambda ─────────────
  {
    ruleId: 'BASE-LMB-001',
    pass: { Fn: fn() },
    fail: { Fn: fn({ Runtime: 'nodejs16.x' }) },
    expect: {
      logicalId: 'Fn',
      path: 'Properties/Runtime',
      message: 'nodejs16.x is not on the allowlist',
    },
    variants: [
      {
        name: 'container image function',
        resources: {
          Fn: fn({
            Runtime: undefined,
            Handler: undefined,
            PackageType: 'Image',
            Code: { ImageUri: 'x' },
          }),
        },
        compliant: true,
        guard: 'SKIP',
      },
    ],
  },
  {
    ruleId: 'BASE-LMB-002',
    pass: { Fn: fn() },
    fail: { Fn: fn({ Architectures: ['x86_64'] }) },
    expect: { logicalId: 'Fn', path: 'Properties/Architectures', message: 'does not use arm64' },
    variants: [
      {
        name: 'Architectures omitted (defaults to x86_64)',
        resources: { Fn: fn({ Architectures: undefined }) },
        compliant: false,
        guard: 'FAIL',
      },
    ],
  },
  {
    ruleId: 'BASE-LMB-003',
    pass: { Fn: fn({ Timeout: 60 }) },
    fail: { Fn: fn({ Timeout: 900 }) },
    expect: { logicalId: 'Fn', path: 'Properties/Timeout', message: 'Timeout 900s exceeds 300s' },
    variants: [
      {
        name: 'Timeout omitted',
        resources: { Fn: fn({ Timeout: undefined }) },
        compliant: false,
        guard: 'FAIL',
      },
    ],
  },
  {
    ruleId: 'BASE-LMB-004',
    pass: { Fn: fn() },
    fail: { Fn: fn({ ReservedConcurrentExecutions: undefined }) },
    expect: {
      logicalId: 'Fn',
      path: 'Properties/ReservedConcurrentExecutions',
      message: 'Reserved concurrency is not set',
    },
  },
  {
    ruleId: 'BASE-LMB-005',
    pass: { Fn: fn() },
    fail: { Fn: fn({ LoggingConfig: { LogFormat: 'JSON' } }) },
    expect: {
      logicalId: 'Fn',
      path: 'Properties/LoggingConfig/LogGroup',
      message: 'No explicit log group configured',
    },
  },
  {
    ruleId: 'BASE-LMB-006',
    pass: { Fn: fn() },
    fail: { Fn: fn({ TracingConfig: { Mode: 'PassThrough' } }) },
    expect: {
      logicalId: 'Fn',
      path: 'Properties/TracingConfig/Mode',
      message: 'Active tracing is not enabled',
    },
  },
  {
    ruleId: 'BASE-LMB-007',
    pass: { Fn: fn(fnEnv(FN_DB_ENV)) },
    fail: { Fn: fn(fnEnv({ ...FN_DB_ENV, DB_SSL: 'disable' })) },
    expect: {
      logicalId: 'Fn',
      path: 'Properties/Environment/Variables/DB_SSL',
      message: 'sets DB_SSL to a mode other than verify-full',
    },
    variants: [
      {
        name: 'APP_RUNTIME=ci',
        resources: { Fn: fn(fnEnv({ ...FN_DB_ENV, APP_RUNTIME: 'ci' })) },
        compliant: false,
        guard: 'FAIL',
      },
      {
        name: 'AUTH_ALLOW_INSECURE_ISSUER',
        resources: { Fn: fn(fnEnv({ AUTH_ALLOW_INSECURE_ISSUER: 'true' })) },
        compliant: false,
        guard: 'FAIL',
      },
      {
        name: 'http: issuer',
        resources: { Fn: fn(fnEnv({ AUTH_ISSUER: 'http://test-idp:9400' })) },
        compliant: false,
        guard: 'FAIL',
      },
      {
        name: 'DB_HOST without DB_SSL',
        resources: { Fn: fn(fnEnv({ DB_HOST: 'db.internal', DB_AUTH: 'iam' })) },
        compliant: false,
        guard: 'FAIL',
      },
      {
        name: 'DB_PASSWORD',
        resources: { Fn: fn(fnEnv({ ...FN_DB_ENV, DB_PASSWORD: 'not-a-real-password' })) },
        compliant: false,
        guard: 'FAIL',
      },
      {
        name: 'no environment',
        resources: { Fn: fn() },
        compliant: true,
        guard: 'SKIP',
      },
    ],
  },
  {
    ruleId: 'BASE-LMB-008',
    pass: { Fn: fn(fnEnv(FN_DB_ENV)) },
    fail: { Fn: fn(fnEnv({ ...FN_DB_ENV, DB_AUTH: 'password' })) },
    expect: {
      logicalId: 'Fn',
      path: 'Properties/Environment/Variables/DB_AUTH',
      message: 'sets DB_AUTH to a mode other than iam',
    },
    variants: [
      {
        name: 'DB_SECRET_ARN (master secret reference)',
        resources: {
          Fn: fn(fnEnv({ ...FN_DB_ENV, DB_SECRET_ARN: 'arn:aws:secretsmanager:x:1:secret:m' })),
        },
        compliant: false,
        guard: 'FAIL',
      },
      {
        name: 'DB_HOST without DB_AUTH',
        resources: { Fn: fn(fnEnv({ DB_HOST: 'db.internal', DB_SSL: 'verify-full' })) },
        compliant: false,
        guard: 'FAIL',
      },
      {
        name: 'no database settings',
        resources: { Fn: fn(fnEnv({ LOG_LEVEL: 'info' })) },
        compliant: true,
        guard: 'PASS',
      },
    ],
  },
  // ───────────── RDS ─────────────
  {
    ruleId: 'BASE-RDS-001',
    pass: { Db: dbInstance() },
    fail: { Db: dbInstance({ StorageEncrypted: false }) },
    expect: {
      logicalId: 'Db',
      path: 'Properties/StorageEncrypted',
      message: 'StorageEncrypted is not true',
    },
    variants: [
      {
        name: 'Aurora member instance inherits cluster encryption',
        resources: {
          Db: dbInstance({
            Engine: 'aurora-postgresql',
            DBClusterIdentifier: { Ref: 'Cluster' },
            StorageEncrypted: undefined,
          }),
        },
        compliant: true,
        guard: 'SKIP',
      },
      {
        name: 'unencrypted cluster',
        resources: {
          Cluster: {
            Type: 'AWS::RDS::DBCluster',
            Properties: { Engine: 'aurora-postgresql', StorageEncrypted: false, Tags: tags() },
          },
        },
        compliant: false,
        guard: 'FAIL',
      },
    ],
  },
  {
    ruleId: 'BASE-RDS-002',
    pass: { Db: dbInstance() },
    fail: { Db: dbInstance({ PubliclyAccessible: true }) },
    expect: { logicalId: 'Db', path: 'Properties/PubliclyAccessible', message: 'must be false' },
    variants: [
      {
        name: 'PubliclyAccessible omitted',
        resources: { Db: dbInstance({ PubliclyAccessible: undefined }) },
        compliant: false,
        guard: 'FAIL',
      },
    ],
  },
  {
    ruleId: 'BASE-RDS-003',
    pass: { Db: dbInstance() },
    fail: { Db: dbInstance({ DeletionProtection: false }) },
    expect: {
      logicalId: 'Db',
      path: 'Properties/DeletionProtection',
      message: 'DeletionProtection is not true',
    },
    variants: [
      {
        name: 'dev without deletion protection',
        resources: { Db: dbInstance({ DeletionProtection: false }, 'dev') },
        compliant: true,
        guard: 'SKIP',
      },
    ],
  },
  {
    ruleId: 'BASE-RDS-004',
    pass: { Db: dbInstance() },
    fail: { Db: dbInstance({ BackupRetentionPeriod: 1 }, 'staging') },
    expect: {
      logicalId: 'Db',
      path: 'Properties/BackupRetentionPeriod',
      message: 'BackupRetentionPeriod must be >= 7 (got 1)',
    },
    variants: [
      {
        name: 'dev with 1 day of backups',
        resources: { Db: dbInstance({ BackupRetentionPeriod: 1 }, 'dev') },
        compliant: true,
        guard: 'SKIP',
      },
    ],
  },
  {
    ruleId: 'BASE-RDS-005',
    pass: {
      Params: pgParams('postgres17', { 'rds.force_ssl': '1', log_min_duration_statement: '500' }),
    },
    fail: { Params: pgParams('postgres17', { 'rds.force_ssl': '0' }) },
    expect: {
      logicalId: 'Params',
      path: 'Properties/Parameters/rds.force_ssl',
      message: 'rds.force_ssl is 0; must be "1"',
    },
    variants: [
      {
        name: 'postgres16 default (force_ssl not overridden)',
        resources: { Params: pgParams('postgres16', { log_connections: '1' }) },
        compliant: true,
        guard: 'SKIP',
      },
      {
        name: 'postgres14 parameter group without force_ssl',
        resources: { Params: pgParams('postgres14', {}) },
        compliant: false,
        guard: 'FAIL',
      },
      {
        name: 'postgres 14 instance on the default parameter group',
        resources: { Db: dbInstance({ EngineVersion: '14.12' }) },
        compliant: false,
        guard: 'FAIL',
      },
    ],
  },
  // ───────────── DynamoDB ─────────────
  {
    ruleId: 'BASE-DDB-001',
    pass: { JobsTable: table() },
    fail: { JobsTable: table({ SSESpecification: { SSEEnabled: true, SSEType: 'KMS' } }) },
    expect: {
      logicalId: 'JobsTable',
      path: 'Properties/SSESpecification/KMSMasterKeyId',
      message: 'No customer-managed key',
    },
    variants: [
      {
        name: 'global table with a CMK per replica',
        resources: { JobsTable: globalTable() },
        compliant: true,
        guard: 'PASS',
      },
      {
        name: 'global table replica without a CMK',
        resources: { JobsTable: globalTable({ SSESpecification: undefined }) },
        compliant: false,
        guard: 'FAIL',
      },
      {
        name: 'table without SSESpecification (AWS-owned key)',
        resources: { JobsTable: table({ SSESpecification: undefined }) },
        compliant: false,
        guard: 'FAIL',
      },
    ],
  },
  {
    ruleId: 'BASE-DDB-002',
    pass: { JobsTable: table() },
    fail: { JobsTable: table({ PointInTimeRecoverySpecification: undefined }) },
    expect: {
      logicalId: 'JobsTable',
      path: 'Properties/PointInTimeRecoverySpecification',
      message: 'PITR is not enabled',
    },
    variants: [
      {
        name: 'global table replica without PITR',
        resources: { JobsTable: globalTable({ PointInTimeRecoverySpecification: undefined }) },
        compliant: false,
        guard: 'FAIL',
      },
    ],
  },
  {
    ruleId: 'BASE-DDB-003',
    pass: { JobsTable: table() },
    fail: { JobsTable: table({ DeletionProtectionEnabled: false }) },
    expect: {
      logicalId: 'JobsTable',
      path: 'Properties/DeletionProtectionEnabled',
      message: 'Deletion protection is not enabled',
    },
    variants: [
      {
        name: 'staging table without deletion protection',
        resources: { JobsTable: table({ DeletionProtectionEnabled: false }, 'staging') },
        compliant: true,
        guard: 'SKIP',
      },
      {
        name: 'prod global table replica without deletion protection',
        resources: { JobsTable: globalTable({ DeletionProtectionEnabled: false }) },
        compliant: false,
        guard: 'FAIL',
      },
    ],
  },
  // ───────────── Logging ─────────────
  {
    ruleId: 'BASE-LOG-001',
    pass: { FnLogs: logGroup() },
    fail: { FnLogs: logGroup({ RetentionInDays: undefined }) },
    expect: { logicalId: 'FnLogs', path: 'Properties/RetentionInDays', message: 'never expires' },
  },
  {
    ruleId: 'BASE-LOG-002',
    pass: { FnLogs: logGroup() },
    fail: { FnLogs: logGroup({ KmsKeyId: undefined }) },
    expect: {
      logicalId: 'FnLogs',
      path: 'Properties/KmsKeyId',
      message: 'not encrypted with a KMS key',
    },
  },
  {
    ruleId: 'BASE-LOG-003',
    pass: {
      Workflow: stateMachine({
        Level: 'ERROR',
        IncludeExecutionData: false,
        Destinations: [
          { CloudWatchLogsLogGroup: { LogGroupArn: { 'Fn::GetAtt': ['SfnLogs', 'Arn'] } } },
        ],
      }),
    },
    fail: { Workflow: stateMachine({ Level: 'OFF' }) },
    expect: {
      logicalId: 'Workflow',
      path: 'Properties/LoggingConfiguration/Level',
      message: 'Logging level is OFF',
    },
  },
  // ───────────── Tags / governance ─────────────
  {
    ruleId: 'BASE-TAG-001',
    pass: { Bucket: bucket() },
    fail: { Bucket: bucket({ Tags: tags('dev', { Owner: null }) }) },
    expect: {
      logicalId: 'Bucket',
      path: 'Properties/Tags',
      message: 'Required tag Owner is missing',
    },
    variants: [
      {
        name: 'empty CostCentre value',
        resources: { Bucket: bucket({ Tags: tags('dev', { CostCentre: '  ' }) }) },
        compliant: false,
        guard: 'FAIL',
      },
      {
        name: 'untagged bucket without properties',
        resources: { Bucket: { Type: 'AWS::S3::Bucket' } },
        compliant: false,
        guard: 'FAIL',
      },
    ],
  },
  {
    ruleId: 'BASE-TAG-002',
    pass: { Bucket: bucket({ Tags: tags('prod') }) },
    fail: { Bucket: bucket({ Tags: tags('production') }) },
    expect: {
      logicalId: 'Bucket',
      path: 'Properties/Tags',
      message: 'Environment tag value production is not allowed',
    },
    variants: [
      {
        // The non-governed sandbox scopes exceptions, but is never an allowed tag value.
        name: 'Environment=sandbox is not a governed environment',
        resources: { Bucket: bucket({ Tags: tags('sandbox') }) },
        compliant: false,
        guard: 'FAIL',
      },
    ],
  },
  {
    ruleId: 'BASE-STATE-001',
    pass: { JobsTable: table() },
    fail: {
      JobsTable: table({}, 'prod', { DeletionPolicy: 'Delete', UpdateReplacePolicy: 'Delete' }),
    },
    expect: { logicalId: 'JobsTable', path: 'DeletionPolicy', message: 'DeletionPolicy is Delete' },
    variants: [
      {
        name: 'dev table may be deleted with the stack',
        resources: {
          JobsTable: table({}, 'dev', { DeletionPolicy: 'Delete', UpdateReplacePolicy: 'Delete' }),
        },
        compliant: true,
        guard: 'SKIP',
      },
      {
        name: 'staging KMS key without DeletionPolicy',
        resources: { DataKey: kmsKey({}, 'staging') },
        compliant: false,
        guard: 'FAIL',
      },
      {
        name: 'prod RDS instance with Snapshot policies',
        resources: { Db: dbInstance() },
        compliant: true,
        guard: 'PASS',
      },
    ],
  },
  {
    ruleId: 'BASE-KMS-001',
    pass: { DataKey: kmsKey() },
    fail: { DataKey: kmsKey({ EnableKeyRotation: false }) },
    expect: {
      logicalId: 'DataKey',
      path: 'Properties/EnableKeyRotation',
      message: 'Key rotation is not enabled',
    },
    variants: [
      {
        name: 'asymmetric signing key',
        resources: {
          DataKey: kmsKey({
            KeySpec: 'RSA_2048',
            KeyUsage: 'SIGN_VERIFY',
            EnableKeyRotation: false,
          }),
        },
        compliant: true,
        guard: 'SKIP',
      },
    ],
  },
];

/** Removes properties explicitly set to `undefined` (fixtures use them to drop defaults). */
export function clean<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export const templateOf = (resources: Resources) => clean({ Resources: resources });

export { without };
