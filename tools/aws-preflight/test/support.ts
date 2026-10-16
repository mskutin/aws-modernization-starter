/**
 * Test support: a fake AWS CLI (injected ProcessRunner) and a realistic happy-path scenario.
 * All identifiers are fake: accounts 111122223333 (sandbox), 444455556666 (other),
 * 999988887777 (management); example.com domains; documentation IP ranges; a permission-set
 * name with '@' shaped like the operator's (`<org>@<PermissionSet>-<7 hex>`) but invented. Values
 * shaped like credentials are assembled at runtime so secret scanners never see them in source.
 */
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, type Deps } from '../src/cli.ts';
import type { ProcessRequest, ProcessResult, ProcessRunner } from '../src/executor.ts';
import { iamPolicy } from '../src/plan.ts';

export const SANDBOX = '111122223333';
export const OTHER = '444455556666';
export const MANAGEMENT = '999988887777';
export const SSO_ROLE_NAME = 'AccountDiscovery';
export const ROLE = `AWSReservedSSO_${SSO_ROLE_NAME}_0123456789abcdef`;
export const SESSION = 'jane.doe@example.com';
export const ROLE_PATTERN = 'AWSReservedSSO_AccountDiscovery_*';
/** The operator's profile shape: `[profile <name>]` + `[sso-session <name>]`, no digits. */
export const PROFILE = 'starter-sandbox-developer';
export const SSO_SESSION_NAME = 'starter-sandbox';
/** A permission set with '@' (IAM Identity Center allows `[\w+=,.@-]`), invented. */
export const AT_SSO_ROLE_NAME = 'acme-aws@Developer-0a1b2c3';
export const AT_ROLE = `AWSReservedSSO_${AT_SSO_ROLE_NAME}_0123456789abcdef`;
export const AT_ROLE_PATTERN = `AWSReservedSSO_${AT_SSO_ROLE_NAME}_*`;
export const SSO_ROLE_PATH = '/aws-reserved/sso.amazonaws.com/ap-southeast-1/';

/** `~/.aws/config` of a native IAM Identity Center profile (exactly the operator's key set). */
export function ssoConfig(
  options: {
    profile?: string;
    account?: string;
    ssoRoleName?: string;
    profileExtra?: string;
    sessionExtra?: string;
    before?: string;
    after?: string;
  } = {},
): string {
  return [
    options.before ?? '# managed by aws configure sso',
    `[profile ${options.profile ?? PROFILE}]`,
    `sso_session = ${SSO_SESSION_NAME}`,
    `sso_account_id = ${options.account ?? SANDBOX}`,
    `sso_role_name = ${options.ssoRoleName ?? SSO_ROLE_NAME}`,
    'region = ap-southeast-1',
    'output = json',
    ...(options.profileExtra ? [options.profileExtra] : []),
    '',
    `[sso-session ${SSO_SESSION_NAME}]`,
    'sso_start_url = https://d-0000000000.awsapps.com/start',
    'sso_region = ap-southeast-1',
    'sso_registration_scopes = sso:account:access',
    ...(options.sessionExtra ? [options.sessionExtra] : []),
    '',
    options.after ?? '',
  ].join('\n');
}

/** A private HOME with `.aws/config` (0700 / 0600, like `aws configure sso` creates it). */
export function makeHome(parent: string, config: string = ssoConfig()): string {
  const home = join(parent, 'home');
  mkdirSync(join(home, '.aws'), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, '.aws', 'config'), config, { mode: 0o600 });
  return home;
}

/** Low-entropy fake UUID: 00000000-0000-4000-8000-00000000000n. */
export const fakeUuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
/** Low-entropy fake 17-hex resource id. */
export const rid = (prefix: string, n: number) => `${prefix}-${String(n).padStart(17, '0')}`;

export interface FakeResponse {
  readonly stdout?: unknown;
  readonly stderr?: string;
  readonly exit?: number;
  readonly timedOut?: boolean;
  readonly spawnError?: string;
}
export type Responder = FakeResponse | ((args: readonly string[], nth: number) => FakeResponse);

export interface FakeCall {
  readonly file: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly envNames: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
}

export const ok = (stdout: unknown): FakeResponse => ({ stdout });
export const awsError = (code: string, message = 'details'): FakeResponse => ({
  stderr: `\naws: [ERROR]: An error occurred (${code}) when calling the Operation operation: ${message}\n`,
  exit: 254,
});
export const ssoExpired: FakeResponse = {
  stderr:
    '\naws: [ERROR]: Error when retrieving token from sso: Token has expired and refresh failed\n',
  exit: 255,
};

export function fakeRunner(
  responses: Readonly<Record<string, Responder>>,
  options: { version?: string } = {},
) {
  const calls: FakeCall[] = [];
  const counts = new Map<string, number>();
  const runner: ProcessRunner = async (req: ProcessRequest): Promise<ProcessResult> => {
    calls.push({
      file: req.file,
      args: [...req.args],
      env: { ...req.env },
      envNames: Object.keys(req.env).sort(),
      cwd: req.cwd,
      timeoutMs: req.timeoutMs,
    });
    const base = { signal: null, aborted: false, outputTooLarge: false, durationMs: 1 };
    if (req.args[0] === '--version') {
      return {
        ...base,
        exitCode: 0,
        stdout: `aws-cli/${options.version ?? '2.35.11'} Python/3.14.7 Linux/6.12 source/x86_64\n`,
        stderr: '',
        timedOut: false,
      };
    }
    const key = `${req.args[0]} ${req.args[1]}`;
    const nth = (counts.get(key) ?? 0) + 1;
    counts.set(key, nth);
    const responder = responses[key] ?? ok({});
    const r = typeof responder === 'function' ? responder(req.args, nth) : responder;
    if (r.timedOut) {
      return { ...base, exitCode: null, signal: 'SIGKILL', stdout: '', stderr: '', timedOut: true };
    }
    return {
      ...base,
      exitCode: r.spawnError ? null : (r.exit ?? 0),
      stdout: r.stdout === undefined ? '' : JSON.stringify(r.stdout),
      stderr: r.stderr ?? '',
      timedOut: false,
      spawnError: r.spawnError,
    };
  };
  /** Calls that reached the AWS CLI with an operation (everything except `--version`). */
  const awsCalls = () => calls.filter((c) => c.args[0] !== '--version');
  return { runner, calls, awsCalls };
}

/** `service operation` pairs of the recorded calls. */
export const ops = (calls: readonly FakeCall[]) => calls.map((c) => `${c.args[0]} ${c.args[1]}`);
/** Value of `--flag value` (two-token form). */
export const argOf = (args: readonly string[], flag: string) =>
  args.indexOf(flag) < 0 ? undefined : args[args.indexOf(flag) + 1];
/** Value of `--flag=value` (the form used for every interpolated value). */
export const valueOf = (args: readonly string[], flag: string) =>
  args.find((a) => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
const roleNameOf = (args: readonly string[]) => valueOf(args, '--role-name') ?? 'unknown';

/** Names of unrelated workloads in the fixtures: they must never reach the evidence. */
export const UNRELATED = {
  stack: 'acme-patient-records-prod',
  vpcName: 'acme-shared-vpc',
  kmsAlias: 'alias/acme-payments-key',
  webAcl: 'FMManagedWebACLV2-acme-baseline-1700000000',
  budget: 'payments.acme.example.com monthly',
  logPolicy: 'acme-pii-protection',
} as const;

/** The generated least-privilege policy (what the recommended permission set uses inline). */
export const GENERATED_POLICY_DOCUMENT = iamPolicy();

// ── Happy-path responses (contain values the sanitizer must remove) ──────────────────────────

const roleResponse = (name: string, extra: Record<string, unknown> = {}) => ({
  Role: {
    Path: name.startsWith('AWSReservedSSO_') ? SSO_ROLE_PATH : '/',
    RoleName: name,
    RoleId: 'AROAFAKEROLEID00000001',
    Arn: `arn:aws:iam::${SANDBOX}:role/${name}`,
    CreateDate: '2026-01-02T03:04:05+00:00',
    Description: `Created by ${SESSION} for acme.example.com`,
    AssumeRolePolicyDocument: {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: { AWS: [`arn:aws:iam::${SANDBOX}:root`, `arn:aws:iam::${OTHER}:root`] },
          Action: ['sts:AssumeRole', 'sts:TagSession'],
          Condition: { StringEquals: { 'sts:ExternalId': 'external-id-value' } },
        },
      ],
    },
    MaxSessionDuration: 3600,
    Tags: [
      { Key: 'Name', Value: 'cdk-role' },
      { Key: 'owner', Value: SESSION },
    ],
    ...extra,
  },
});

export function happyResponses(
  overrides: Record<string, Responder> = {},
): Record<string, Responder> {
  return {
    'sts get-caller-identity': ok({
      UserId: `AROAFAKEROLEID00000001:${SESSION}`,
      Account: SANDBOX,
      Arn: `arn:aws:sts::${SANDBOX}:assumed-role/${ROLE}/${SESSION}`,
    }),
    'iam get-role': (args) => ok(roleResponse(roleNameOf(args))),
    // The recommended permission set: metadata-only AWS managed policies plus the generated
    // policy as the permission set's inline policy -> verified-read-only.
    'iam list-attached-role-policies': ok({
      AttachedPolicies: [
        {
          PolicyName: 'AWSBudgetsReadOnlyAccess',
          PolicyArn: 'arn:aws:iam::aws:policy/AWSBudgetsReadOnlyAccess',
        },
        {
          PolicyName: 'ServiceQuotasReadOnlyAccess',
          PolicyArn: 'arn:aws:iam::aws:policy/ServiceQuotasReadOnlyAccess',
        },
      ],
    }),
    'iam list-role-policies': ok({ PolicyNames: ['AwsSSOInlinePolicy'] }),
    'iam get-role-policy': (args) =>
      ok({
        RoleName: roleNameOf(args),
        PolicyName: valueOf(args, '--policy-name'),
        PolicyDocument: GENERATED_POLICY_DOCUMENT,
      }),
    'iam get-policy-version': ok({
      PolicyVersion: {
        Document: GENERATED_POLICY_DOCUMENT,
        VersionId: 'v3',
        IsDefaultVersion: true,
        CreateDate: '2026-09-01T00:00:00+00:00',
      },
    }),
    'organizations describe-organization': ok({
      Organization: {
        Id: 'o-exampleorgid1',
        Arn: `arn:aws:organizations::${MANAGEMENT}:organization/o-exampleorgid1`,
        FeatureSet: 'ALL',
        MasterAccountArn: `arn:aws:organizations::${MANAGEMENT}:account/o-exampleorgid1/${MANAGEMENT}`,
        MasterAccountId: MANAGEMENT,
        MasterAccountEmail: 'aws-root@example.com',
        AvailablePolicyTypes: [{ Type: 'SERVICE_CONTROL_POLICY', Status: 'ENABLED' }],
      },
    }),
    'organizations list-parents': awsError('AccessDeniedException'),
    'organizations list-policies-for-target': awsError('AccessDeniedException'),
    'organizations describe-effective-policy': (args) =>
      argOf(args, '--policy-type') === 'TAG_POLICY'
        ? ok({
            EffectivePolicy: {
              PolicyContent: JSON.stringify({
                tags: {
                  costcenter: {
                    tag_key: { '@@assign': 'CostCenter' },
                    tag_value: { '@@assign': ['CC-1234', 'CC-5678'] },
                    enforced_for: { '@@assign': ['ec2:instance'] },
                  },
                },
              }),
              LastUpdatedTimestamp: '2026-09-01T00:00:00+00:00',
              TargetId: SANDBOX,
              PolicyType: 'TAG_POLICY',
            },
          })
        : ok({
            EffectivePolicy: {
              PolicyContent: JSON.stringify({
                ec2_attributes: {
                  vpc_block_public_access: {
                    internet_gateway_block: { mode: { '@@assign': 'block_ingress' } },
                  },
                  exception_message: { '@@assign': `Contact ${SESSION}` },
                  allowed_images_settings: {
                    image_criteria: {
                      criteria_1: { allowed_image_providers: { '@@append': [OTHER] } },
                    },
                  },
                },
              }),
              TargetId: SANDBOX,
              PolicyType: 'DECLARATIVE_POLICY_EC2',
            },
          }),
    'iam get-account-summary': ok({ SummaryMap: { Roles: 12, Policies: 3, RolesQuota: 1000 } }),
    'iam list-account-aliases': ok({ AccountAliases: ['acme-sandbox-alias'] }),
    'iam get-policy': (args) => {
      const arn = valueOf(args, '--policy-arn') ?? '';
      return ok({
        Policy: {
          PolicyName: arn.slice(arn.lastIndexOf('/') + 1),
          PolicyId: 'ANPAFAKEPOLICYID000002',
          Arn: arn,
          Path: '/',
          DefaultVersionId: 'v3',
          AttachmentCount: 1,
          IsAttachable: true,
          Description: 'Maintained by platform@example.com',
        },
      });
    },
    'iam list-policies': ok({
      Policies: [
        {
          PolicyName: 'ExamplePermissionsBoundary',
          PolicyId: 'ANPAFAKEPOLICYID000001',
          Arn: `arn:aws:iam::${SANDBOX}:policy/ExamplePermissionsBoundary`,
          Path: '/',
          DefaultVersionId: 'v3',
          AttachmentCount: 4,
          PermissionsBoundaryUsageCount: 4,
          IsAttachable: true,
          Description: 'Maintained by platform@example.com',
        },
      ],
    }),
    'cloudformation describe-stacks': (args) => {
      // us-east-1 has no bootstrap stack; ap-southeast-1 does.
      if (argOf(args, '--region') === 'us-east-1') {
        return {
          stderr:
            '\naws: [ERROR]: An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id CDKToolkit does not exist\n',
          exit: 254,
        };
      }
      return ok({
        Stacks: [
          {
            StackId: `arn:aws:cloudformation:ap-southeast-1:${SANDBOX}:stack/CDKToolkit/${fakeUuid(7)}`,
            StackName: 'CDKToolkit',
            Description:
              'This stack includes resources needed to deploy AWS CDK apps into this environment',
            Parameters: [
              { ParameterKey: 'TrustedAccounts', ParameterValue: OTHER },
              { ParameterKey: 'Qualifier', ParameterValue: 'hnb659fds' },
              {
                ParameterKey: 'CloudFormationExecutionPolicies',
                ParameterValue: 'arn:aws:iam::aws:policy/AdministratorAccess',
              },
            ],
            Outputs: [
              {
                OutputKey: 'BucketName',
                OutputValue: `cdk-hnb659fds-assets-${SANDBOX}-ap-southeast-1`,
              },
              {
                OutputKey: 'BucketDomainName',
                OutputValue: `cdk-hnb659fds-assets-${SANDBOX}-ap-southeast-1.s3.ap-southeast-1.amazonaws.com`,
              },
              { OutputKey: 'BootstrapVersion', OutputValue: '29' },
            ],
            StackStatus: 'UPDATE_COMPLETE',
            CreationTime: '2026-01-01T00:00:00+00:00',
            Tags: [{ Key: 'owner', Value: SESSION }],
          },
        ],
      });
    },
    'cloudformation list-stacks': ok({
      StackSummaries: [
        {
          StackId: `arn:aws:cloudformation:ap-southeast-1:${SANDBOX}:stack/CDKToolkit/${fakeUuid(7)}`,
          StackName: 'CDKToolkit',
          TemplateDescription: 'Bootstrap',
          StackStatus: 'UPDATE_COMPLETE',
          StackStatusReason: `Updated by ${SESSION}`,
          CreationTime: '2026-01-01T00:00:00+00:00',
        },
        {
          StackId: `arn:aws:cloudformation:ap-southeast-1:${SANDBOX}:stack/${UNRELATED.stack}/${fakeUuid(8)}`,
          StackName: UNRELATED.stack,
          StackStatus: 'CREATE_COMPLETE',
          CreationTime: '2026-02-01T00:00:00+00:00',
        },
        {
          StackId: `arn:aws:cloudformation:ap-southeast-1:${SANDBOX}:stack/starter-dev-network/${fakeUuid(10)}`,
          StackName: 'starter-dev-network',
          StackStatus: 'CREATE_COMPLETE',
          CreationTime: '2026-03-01T00:00:00+00:00',
        },
      ],
    }),
    'cloudformation list-types': (args) =>
      ok({
        TypeSummaries:
          argOf(args, '--visibility') === 'PUBLIC'
            ? [
                {
                  Type: 'HOOK',
                  TypeName: 'AWS::ControlTower::Hook',
                  TypeArn: `arn:aws:cloudformation:ap-southeast-1:${SANDBOX}:type/hook/AWS-ControlTower-Hook`,
                  Description: `Activated by ${SESSION}`,
                  PublisherId: 'aws-hooks',
                  IsActivated: true,
                },
              ]
            : [],
      }),
    'ssm get-parameter': (args) =>
      (valueOf(args, '--name') ?? '').includes('/hnb659fds/')
        ? ok({
            Parameter: {
              Name: '/cdk-bootstrap/hnb659fds/version',
              Type: 'String',
              Value: '29',
              Version: 3,
            },
          })
        : awsError('ParameterNotFound'),
    'ec2 describe-availability-zones': ok({
      AvailabilityZones: [
        {
          ZoneName: 'ap-southeast-1a',
          ZoneId: 'apse1-az1',
          State: 'available',
          RegionName: 'ap-southeast-1',
          ZoneType: 'availability-zone',
        },
        {
          ZoneName: 'ap-southeast-1b',
          ZoneId: 'apse1-az2',
          State: 'available',
          RegionName: 'ap-southeast-1',
          ZoneType: 'availability-zone',
        },
      ],
    }),
    'ec2 describe-account-attributes': ok({
      AccountAttributes: [
        { AttributeName: 'default-vpc', AttributeValues: [{ AttributeValue: rid('vpc', 1) }] },
        { AttributeName: 'max-elastic-ips', AttributeValues: [{ AttributeValue: '5' }] },
      ],
    }),
    'ec2 describe-vpcs': ok({
      Vpcs: [
        {
          VpcId: rid('vpc', 1),
          OwnerId: SANDBOX,
          CidrBlock: '10.20.0.0/16',
          DhcpOptionsId: rid('dopt', 1),
          IsDefault: true,
          State: 'available',
          Tags: [
            { Key: 'Name', Value: UNRELATED.vpcName },
            { Key: 'contact', Value: SESSION },
          ],
        },
      ],
    }),
    'ec2 describe-subnets': ok({
      Subnets: [
        {
          SubnetId: rid('subnet', 1),
          VpcId: rid('vpc', 1),
          SubnetArn: `arn:aws:ec2:ap-southeast-1:${SANDBOX}:subnet/${rid('subnet', 1)}`,
          AvailabilityZone: 'ap-southeast-1a',
          AvailabilityZoneId: 'apse1-az1',
          CidrBlock: '10.20.1.0/24',
          AvailableIpAddressCount: 250,
          MapPublicIpOnLaunch: false,
          OwnerId: SANDBOX,
        },
      ],
    }),
    'ec2 describe-route-tables': ok({
      RouteTables: [
        {
          RouteTableId: rid('rtb', 1),
          VpcId: rid('vpc', 1),
          OwnerId: SANDBOX,
          Associations: [
            {
              Main: true,
              RouteTableId: rid('rtb', 1),
              RouteTableAssociationId: rid('rtbassoc', 1),
            },
          ],
          Routes: [
            {
              DestinationCidrBlock: '10.20.0.0/16',
              GatewayId: 'local',
              State: 'active',
              Origin: 'CreateRouteTable',
            },
            {
              DestinationCidrBlock: '0.0.0.0/0',
              NatGatewayId: rid('nat', 1),
              State: 'active',
              Origin: 'CreateRoute',
            },
          ],
        },
      ],
    }),
    'ec2 describe-internet-gateways': ok({
      InternetGateways: [
        {
          InternetGatewayId: rid('igw', 1),
          OwnerId: SANDBOX,
          Attachments: [{ VpcId: rid('vpc', 1), State: 'available' }],
        },
      ],
    }),
    'ec2 describe-nat-gateways': ok({
      NatGateways: [
        {
          NatGatewayId: rid('nat', 1),
          SubnetId: rid('subnet', 1),
          VpcId: rid('vpc', 1),
          State: 'available',
          ConnectivityType: 'public',
          NatGatewayAddresses: [
            {
              AllocationId: rid('eipalloc', 1),
              PublicIp: '203.0.113.10',
              PrivateIp: '10.20.1.5',
              IsPrimary: true,
              Status: 'succeeded',
            },
          ],
        },
      ],
    }),
    'ec2 describe-vpc-endpoints': ok({
      VpcEndpoints: [
        {
          VpcEndpointId: rid('vpce', 1),
          VpcEndpointType: 'Gateway',
          VpcId: rid('vpc', 1),
          ServiceName: 'com.amazonaws.ap-southeast-1.s3',
          State: 'available',
          PolicyDocument: '{"Statement":[{"Effect":"Allow","Principal":"*","Action":"*"}]}',
          RouteTableIds: [rid('rtb', 1)],
          DnsEntries: [{ DnsName: 'vpce.example.internal', HostedZoneId: 'Z0000000000000000001' }],
          OwnerId: SANDBOX,
        },
      ],
    }),
    'ec2 describe-managed-prefix-lists': ok({
      PrefixLists: [
        {
          PrefixListId: 'pl-31a34658',
          AddressFamily: 'IPv4',
          State: 'create-complete',
          PrefixListArn: 'arn:aws:ec2:ap-southeast-1:aws:prefix-list/pl-31a34658',
          PrefixListName: 'com.amazonaws.global.cloudfront.origin-facing',
          MaxEntries: 55,
          Version: 12,
          OwnerId: 'AWS',
        },
      ],
    }),
    'ec2 describe-vpc-block-public-access-options': ok({
      VpcBlockPublicAccessOptions: {
        AwsAccountId: SANDBOX,
        AwsRegion: 'ap-southeast-1',
        State: 'default-state',
        InternetGatewayBlockMode: 'off',
        Reason: `Set by ${SESSION}`,
      },
    }),
    'ec2 describe-vpc-block-public-access-exclusions': ok({ VpcBlockPublicAccessExclusions: [] }),
    'elbv2 describe-account-limits': ok({
      Limits: [{ Name: 'application-load-balancers', Max: '50' }],
    }),
    'route53 list-hosted-zones': ok({
      HostedZones: [
        {
          Id: '/hostedzone/Z0000000000000000001',
          Name: 'sandbox.example.com.',
          CallerReference: 'caller-ref-1',
          Config: { Comment: `owner ${SESSION}`, PrivateZone: false },
          ResourceRecordSetCount: 4,
        },
      ],
    }),
    'acm list-certificates': (args) =>
      ok({
        CertificateSummaryList:
          argOf(args, '--region') === 'us-east-1'
            ? [
                {
                  CertificateArn: `arn:aws:acm:us-east-1:${SANDBOX}:certificate/${fakeUuid(3)}`,
                  DomainName: '*.sandbox.example.com',
                  SubjectAlternativeNameSummaries: ['sandbox.example.com', '*.sandbox.example.com'],
                  Status: 'ISSUED',
                  Type: 'AMAZON_ISSUED',
                  KeyAlgorithm: 'RSA_2048',
                  InUse: false,
                },
              ]
            : [],
      }),
    'wafv2 list-web-acls': ok({
      WebACLs: [
        {
          Name: UNRELATED.webAcl,
          Id: fakeUuid(9),
          Description: `Managed by ${SESSION}`,
          LockToken: 'lock-token-value',
          ARN: `arn:aws:wafv2:us-east-1:${SANDBOX}:global/webacl/${UNRELATED.webAcl}/${fakeUuid(9)}`,
        },
      ],
    }),
    'lambda get-account-settings': ok({
      AccountLimit: {
        TotalCodeSize: 80530636800,
        CodeSizeUnzipped: 262144000,
        ConcurrentExecutions: 10,
        UnreservedConcurrentExecutions: 10,
      },
      AccountUsage: { TotalCodeSize: 0, FunctionCount: 0 },
    }),
    'service-quotas list-service-quotas': (args) =>
      ok({
        Quotas: [
          {
            ServiceCode: argOf(args, '--service-code'),
            QuotaArn: `arn:aws:servicequotas:ap-southeast-1:${SANDBOX}:lambda/L-B99A9384`,
            QuotaCode: 'L-B99A9384',
            QuotaName: 'Concurrent executions',
            Value: 10,
            Unit: 'None',
            Adjustable: true,
            GlobalQuota: false,
          },
        ],
      }),
    'service-quotas get-aws-default-service-quota': ok({
      Quota: {
        ServiceCode: 'lambda',
        QuotaCode: 'L-B99A9384',
        QuotaName: 'Concurrent executions',
        Value: 1000,
        Adjustable: true,
      },
    }),
    'service-quotas list-requested-service-quota-change-history-by-quota': ok({
      RequestedQuotas: [
        {
          Id: 'request-id-value',
          CaseId: 'case-id-value',
          ServiceCode: 'lambda',
          QuotaCode: 'L-B99A9384',
          DesiredValue: 1000,
          Status: 'CASE_OPENED',
          Created: '2026-10-01T00:00:00+00:00',
          LastUpdated: '2026-10-02T00:00:00+00:00',
          Requester: `{"accountId":"${SANDBOX}","callerArn":"arn:aws:sts::${SANDBOX}:assumed-role/${ROLE}/${SESSION}"}`,
          QuotaArn: `arn:aws:servicequotas:ap-southeast-1:${SANDBOX}:lambda/L-B99A9384`,
        },
      ],
    }),
    'service-quotas get-service-quota': ok({
      Quota: {
        ServiceCode: 'ec2',
        QuotaCode: 'L-0263D0A3',
        QuotaName: 'EC2-VPC Elastic IPs',
        Value: 5,
        Adjustable: true,
      },
    }),
    'rds describe-db-engine-versions': ok({
      DBEngineVersions: [
        {
          Engine: 'postgres',
          EngineVersion: '17.9',
          DBParameterGroupFamily: 'postgres17',
          Status: 'available',
          SupportedCACertificateIdentifiers: ['rds-ca-rsa2048-g1', 'rds-ca-ecc384-g1'],
          ValidUpgradeTarget: [
            { EngineVersion: '17.10', IsMajorVersionUpgrade: false, AutoUpgrade: false },
          ],
        },
      ],
    }),
    'rds describe-orderable-db-instance-options': (args) =>
      ok({
        OrderableDBInstanceOptions: [
          {
            Engine: 'postgres',
            EngineVersion: '17.9',
            DBInstanceClass: argOf(args, '--db-instance-class'),
            AvailabilityZones: [{ Name: 'ap-southeast-1a' }],
            MultiAZCapable: true,
            StorageType: 'gp3',
            SupportsIAMDatabaseAuthentication: true,
          },
        ],
      }),
    'rds describe-certificates': ok({
      Certificates: [
        {
          CertificateIdentifier: 'rds-ca-rsa2048-g1',
          CertificateType: 'CA',
          Thumbprint: '0000000000000000000000000000000000000000',
          ValidTill: '2061-05-20T00:00:00+00:00',
        },
      ],
      DefaultCertificateForNewLaunches: 'rds-ca-rsa2048-g1',
    }),
    'rds describe-account-attributes': ok({
      AccountQuotas: [{ AccountQuotaName: 'DBInstances', Used: 0, Max: 40 }],
    }),
    'ecs list-account-settings': ok({
      settings: [
        {
          name: 'containerInsights',
          value: 'enabled',
          principalArn: `arn:aws:iam::${SANDBOX}:role/${ROLE}`,
          type: 'user',
        },
      ],
    }),
    'ecr describe-registry': ok({ registryId: SANDBOX, replicationConfiguration: { rules: [] } }),
    'ecr get-registry-scanning-configuration': ok({
      registryId: SANDBOX,
      scanningConfiguration: { scanType: 'BASIC', rules: [] },
    }),
    'dynamodb describe-limits': ok({
      AccountMaxReadCapacityUnits: 80000,
      AccountMaxWriteCapacityUnits: 80000,
      TableMaxReadCapacityUnits: 40000,
      TableMaxWriteCapacityUnits: 40000,
    }),
    'cloudformation describe-account-limits': ok({
      AccountLimits: [{ Name: 'StackLimit', Value: 2000 }],
    }),
    'kms list-aliases': ok({
      Aliases: [
        {
          AliasName: 'alias/aws/s3',
          AliasArn: `arn:aws:kms:ap-southeast-1:${SANDBOX}:alias/aws/s3`,
          TargetKeyId: fakeUuid(11),
        },
        {
          AliasName: UNRELATED.kmsAlias,
          AliasArn: `arn:aws:kms:ap-southeast-1:${SANDBOX}:${UNRELATED.kmsAlias}`,
          TargetKeyId: fakeUuid(13),
        },
        {
          AliasName: 'alias/starter-data',
          AliasArn: `arn:aws:kms:ap-southeast-1:${SANDBOX}:alias/starter-data`,
          TargetKeyId: fakeUuid(14),
        },
      ],
    }),
    'kms describe-key': ok({
      KeyMetadata: {
        AWSAccountId: SANDBOX,
        KeyId: fakeUuid(12),
        Arn: `arn:aws:kms:ap-southeast-1:${SANDBOX}:key/${fakeUuid(12)}`,
        Description: `Data key owned by ${SESSION}`,
        KeyState: 'Enabled',
        KeyManager: 'CUSTOMER',
      },
    }),
    'logs describe-resource-policies': ok({
      resourcePolicies: [
        {
          policyName: 'AWSLogDeliveryWrite20150319',
          policyDocument: `{"Statement":[{"Principal":{"AWS":"${OTHER}"}}]}`,
          lastUpdatedTime: 1760000000000,
        },
        { policyName: UNRELATED.logPolicy, policyDocument: '{}', lastUpdatedTime: 1760000000001 },
      ],
    }),
    'logs describe-account-policies': ok({
      accountPolicies: [
        {
          policyName: UNRELATED.logPolicy,
          policyDocument: `{"Name":"x","Description":"${SESSION}"}`,
          policyType: 'DATA_PROTECTION_POLICY',
          scope: 'ALL',
          accountId: SANDBOX,
        },
      ],
    }),
    'budgets describe-budgets': ok({
      Budgets: [
        {
          BudgetName: UNRELATED.budget,
          BudgetLimit: { Amount: '100.0', Unit: 'USD' },
          CostFilters: { LinkedAccount: [SANDBOX] },
          TimeUnit: 'MONTHLY',
          BudgetType: 'COST',
          CalculatedSpend: { ActualSpend: { Amount: '42.17', Unit: 'USD' } },
        },
        { BudgetName: '-ignored-leading-dash', BudgetType: 'COST', TimeUnit: 'MONTHLY' },
      ],
    }),
    'budgets describe-notifications-for-budget': ok({
      Notifications: [
        {
          NotificationType: 'ACTUAL',
          ComparisonOperator: 'GREATER_THAN',
          Threshold: 80,
          ThresholdType: 'PERCENTAGE',
        },
      ],
    }),
    ...overrides,
  };
}

// ── Running the CLI in-process ───────────────────────────────────────────────────────────────

export interface Sandbox {
  readonly dir: string;
  /** HOME of the run: `.aws/config` holds the native SSO profile (see ssoConfig). */
  readonly home: string;
  readonly rawDir: string;
  readonly evidence: string;
  readonly awsCli: string;
}

/** Sandboxes by evidence path, so runCli can give each run its own HOME. */
const SANDBOXES = new Map<string, Sandbox>();

/**
 * Temp dirs outside any git work tree: a HOME with the SSO profile, a private raw directory and a
 * dummy `aws` executable (never executed in-process; it is hashed and its modes are checked).
 */
export function sandbox(options: { config?: string } = {}): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), 'aws-preflight-test-'));
  const home = makeHome(dir, options.config);
  const rawDir = join(dir, 'raw');
  mkdirSync(rawDir, { mode: 0o700 });
  const bin = join(dir, 'bin');
  mkdirSync(bin, { mode: 0o755 });
  chmodSync(bin, 0o755);
  const awsCli = join(bin, 'aws');
  writeFileSync(awsCli, '#!/bin/sh\nexit 99\n');
  chmodSync(awsCli, 0o755);
  const box = { dir, home, rawDir, evidence: join(dir, 'evidence', 'discovery.json'), awsCli };
  SANDBOXES.set(box.evidence, box);
  return box;
}

export function liveArgs(
  command: 'identity' | 'discover',
  box: Sandbox,
  extra: string[] = [],
): string[] {
  return [
    command,
    '--profile',
    PROFILE,
    '--expected-account',
    SANDBOX,
    '--expected-role-pattern',
    ROLE_PATTERN,
    '--region',
    'ap-southeast-1',
    '--raw-dir',
    box.rawDir,
    '--evidence-out',
    box.evidence,
    '--aws-cli',
    box.awsCli,
    ...extra,
  ];
}

export async function runCli(
  argv: string[],
  runner: ProcessRunner,
  deps: Partial<Deps> = {},
): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const box = SANDBOXES.get(argOf(argv, '--evidence-out') ?? '');
  const code = await run(argv, {
    env: { HOME: box?.home ?? '/nonexistent-home', PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    cwd: tmpdir(),
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
    runner,
    sleep: async () => undefined,
    throttleBackoffMs: 0,
    now: () => new Date('2026-10-14T05:30:00.000Z'),
    randomHex: () => 'a1b2c3',
    ...deps,
  });
  return { code, out, err };
}
