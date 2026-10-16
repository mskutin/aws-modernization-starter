/**
 * The ONLY AWS operations this tool may run: a static allowlist of read-only AWS CLI v2
 * `list-*` / `describe-*` / `get-*` operations, each with its exact IAM action and the options it
 * may pass. The executor refuses anything else, and the denylists below are checked again at the
 * exec boundary (independently of the allowlist), so a careless addition cannot introduce a
 * mutating or data-reading call. There is no delete, no put, no Cost Explorer and no STS here
 * (the account guard owns STS).
 */

export interface OperationDef {
  /** AWS CLI v2 service name. */
  readonly service: string;
  /** AWS CLI v2 operation. */
  readonly operation: string;
  /** IAM action the call needs (Service Authorization Reference). */
  readonly iamAction: string;
  /** Options this tool may pass (values are validated separately). */
  readonly options: readonly string[];
  /** Options that take no value. */
  readonly flags?: readonly string[];
  readonly purpose: string;
  /**
   * The raw response can contain configuration this tool never keeps (environment variables,
   * origin custom headers). The caller projects it field by field; it is never written or logged.
   */
  readonly sensitiveResponse?: string;
  /**
   * Reviewed value restriction: the option may only take these exact values (checked by the
   * executor and again at the exec boundary). Required for every operation in VALUE_RESTRICTED.
   */
  readonly fixedValues?: Readonly<Record<string, readonly string[]>>;
}

const op = (
  service: string,
  operation: string,
  iamAction: string,
  purpose: string,
  options: readonly string[] = [],
  extra: Partial<Pick<OperationDef, 'flags' | 'sensitiveResponse' | 'fixedValues'>> = {},
): OperationDef => ({ service, operation, iamAction, options, purpose, ...extra });

/** The only SSM parameter this tool may read (by name; `--with-decryption` stays denied). */
export const BOOTSTRAP_VERSION_PARAMETER = '/cdk-bootstrap/starter/version';

/**
 * Reviewed exceptions to the "no value-returning read" rule: allowed only with every option
 * pinned by `fixedValues`. `ssm get-parameters` replaces `ssm describe-parameters`, which the
 * typical sandbox Developer permission set does not grant.
 */
export const VALUE_RESTRICTED: readonly string[] = ['ssm get-parameters'];

export const OPERATIONS: readonly OperationDef[] = Object.freeze([
  op(
    'resourcegroupstaggingapi',
    'get-resources',
    'tag:GetResources',
    'resources tagged with the run id / experiment (regional tag index)',
    ['--tag-filters'],
  ),
  op(
    'cloudformation',
    'describe-stacks',
    'cloudformation:DescribeStacks',
    'stacks (incl. DELETE_FAILED), tags, creation time',
  ),
  op(
    'cloudformation',
    'list-stacks',
    'cloudformation:ListStacks',
    'deleted stacks of the inventoried run (90 days): their stack ids for the deletion evidence',
  ),
  op(
    'cloudformation',
    'list-stack-resources',
    'cloudformation:ListStackResources',
    'resources of an experiment stack (inventory) or final resource status of a deleted one',
    ['--stack-name'],
  ),
  op(
    'cloudformation',
    'describe-stack-events',
    'cloudformation:DescribeStackEvents',
    'resource creation timestamps (inventory)',
    ['--stack-name'],
  ),
  op('ecs', 'list-clusters', 'ecs:ListClusters', 'ECS clusters'),
  op('ecs', 'describe-clusters', 'ecs:DescribeClusters', 'cluster status and tags', [
    '--clusters',
    '--include',
  ]),
  op('ecs', 'list-services', 'ecs:ListServices', 'services of an experiment cluster', [
    '--cluster',
  ]),
  op('ecs', 'describe-services', 'ecs:DescribeServices', 'service status, desired/running count', [
    '--cluster',
    '--services',
    '--include',
  ]),
  op('ecs', 'list-tasks', 'ecs:ListTasks', 'running tasks of an experiment cluster', ['--cluster']),
  op(
    'ecs',
    'list-task-definition-families',
    'ecs:ListTaskDefinitionFamilies',
    'task definition families with ACTIVE revisions',
    ['--status'],
  ),
  op(
    'ecs',
    'list-task-definitions',
    'ecs:ListTaskDefinitions',
    'ACTIVE revisions of an experiment family',
    ['--family-prefix', '--status'],
  ),
  op('ec2', 'describe-vpcs', 'ec2:DescribeVpcs', 'VPCs'),
  op('ec2', 'describe-subnets', 'ec2:DescribeSubnets', 'subnets'),
  op('ec2', 'describe-nat-gateways', 'ec2:DescribeNatGateways', 'NAT gateways (hourly billed)'),
  op(
    'ec2',
    'describe-addresses',
    'ec2:DescribeAddresses',
    'Elastic IPs (public IPv4, hourly billed)',
  ),
  op(
    'ec2',
    'describe-network-interfaces',
    'ec2:DescribeNetworkInterfaces',
    'ENIs left in experiment VPCs',
  ),
  op('ec2', 'describe-security-groups', 'ec2:DescribeSecurityGroups', 'security groups'),
  op('ec2', 'describe-vpc-endpoints', 'ec2:DescribeVpcEndpoints', 'VPC endpoints'),
  op('ec2', 'describe-internet-gateways', 'ec2:DescribeInternetGateways', 'internet gateways'),
  op(
    'elbv2',
    'describe-load-balancers',
    'elasticloadbalancing:DescribeLoadBalancers',
    'load balancers (hourly billed)',
  ),
  op(
    'elbv2',
    'describe-target-groups',
    'elasticloadbalancing:DescribeTargetGroups',
    'target groups',
  ),
  op(
    'elbv2',
    'describe-tags',
    'elasticloadbalancing:DescribeTags',
    'load balancer and target group tags',
    ['--resource-arns'],
  ),
  op('rds', 'describe-db-instances', 'rds:DescribeDBInstances', 'DB instances (hourly billed)'),
  op(
    'rds',
    'describe-db-snapshots',
    'rds:DescribeDBSnapshots',
    'manual and automated DB snapshots (billed storage)',
  ),
  op(
    'rds',
    'describe-db-instance-automated-backups',
    'rds:DescribeDBInstanceAutomatedBackups',
    'retained automated backups (billed storage)',
  ),
  op('rds', 'describe-db-parameter-groups', 'rds:DescribeDBParameterGroups', 'DB parameter groups'),
  op('rds', 'describe-db-subnet-groups', 'rds:DescribeDBSubnetGroups', 'DB subnet groups'),
  op('dynamodb', 'list-tables', 'dynamodb:ListTables', 'tables'),
  op(
    'dynamodb',
    'describe-table',
    'dynamodb:DescribeTable',
    'status and creation time of a matched table',
    ['--table-name'],
  ),
  op('dynamodb', 'list-backups', 'dynamodb:ListBackups', 'user and system backups', [
    '--backup-type',
  ]),
  op('lambda', 'list-functions', 'lambda:ListFunctions', 'functions', [], {
    sensitiveResponse:
      'function configurations include environment variables; only FunctionName, FunctionArn and LastModified are kept',
  }),
  op('lambda', 'list-layers', 'lambda:ListLayers', 'layers'),
  op('stepfunctions', 'list-state-machines', 'states:ListStateMachines', 'state machines'),
  op(
    'stepfunctions',
    'list-state-machine-versions',
    'states:ListStateMachineVersions',
    'versions of a matched state machine',
    ['--state-machine-arn'],
  ),
  op(
    'stepfunctions',
    'list-state-machine-aliases',
    'states:ListStateMachineAliases',
    'aliases of a matched state machine',
    ['--state-machine-arn'],
  ),
  op(
    'cloudfront',
    'list-distributions',
    'cloudfront:ListDistributions',
    'distributions incl. disabled ones',
    [],
    {
      sensitiveResponse:
        'distribution summaries include origin custom headers (the origin-verify value); only Id, ARN, Status, Enabled, DomainName, Comment and LastModifiedTime are kept',
    },
  ),
  op(
    'cloudfront',
    'list-tags-for-resource',
    'cloudfront:ListTagsForResource',
    'distribution tags',
    ['--resource'],
  ),
  op(
    'cloudfront',
    'list-origin-access-controls',
    'cloudfront:ListOriginAccessControls',
    'origin access controls',
  ),
  op(
    'cloudfront',
    'list-functions',
    'cloudfront:ListFunctions',
    'CloudFront Functions (metadata only)',
  ),
  op('cloudfront', 'list-cache-policies', 'cloudfront:ListCachePolicies', 'custom cache policies', [
    '--type',
  ]),
  op(
    'cloudfront',
    'list-response-headers-policies',
    'cloudfront:ListResponseHeadersPolicies',
    'custom response headers policies',
    ['--type'],
  ),
  op(
    'cloudfront',
    'list-origin-request-policies',
    'cloudfront:ListOriginRequestPolicies',
    'custom origin request policies',
    ['--type'],
  ),
  op('cloudfront', 'list-vpc-origins', 'cloudfront:ListVpcOrigins', 'VPC origins'),
  op('s3api', 'list-buckets', 's3:ListAllMyBuckets', 'bucket names and creation dates'),
  op('ecr', 'describe-repositories', 'ecr:DescribeRepositories', 'repositories'),
  op(
    'ecr',
    'describe-images',
    'ecr:DescribeImages',
    'image count and size of a matched repository',
    ['--repository-name'],
  ),
  op(
    'logs',
    'describe-log-groups',
    'logs:DescribeLogGroups',
    'log groups (names, stored bytes, retention)',
  ),
  op('cloudwatch', 'describe-alarms', 'cloudwatch:DescribeAlarms', 'alarms (metric and composite)'),
  op('cloudwatch', 'list-dashboards', 'cloudwatch:ListDashboards', 'dashboards'),
  op('kms', 'list-keys', 'kms:ListKeys', 'key ids'),
  op('kms', 'describe-key', 'kms:DescribeKey', 'key state, manager, deletion date', ['--key-id']),
  op('kms', 'list-aliases', 'kms:ListAliases', 'aliases'),
  op('kms', 'list-resource-tags', 'kms:ListResourceTags', 'customer managed key tags', [
    '--key-id',
  ]),
  op(
    'secretsmanager',
    'list-secrets',
    'secretsmanager:ListSecrets',
    'secret metadata incl. scheduled deletions (never values)',
    [],
    {
      flags: ['--include-planned-deletion'],
    },
  ),
  op('iam', 'list-roles', 'iam:ListRoles', 'roles created by the stacks (global)'),
  op('iam', 'list-policies', 'iam:ListPolicies', 'customer managed policies (global)', ['--scope']),
  op('sns', 'list-topics', 'sns:ListTopics', 'topics'),
  op('events', 'list-rules', 'events:ListRules', 'EventBridge rules (default bus)'),
  op(
    'ssm',
    'get-parameters',
    'ssm:GetParameters',
    'existence of the CDK bootstrap version parameter only (name pinned; the value is dropped)',
    ['--names'],
    {
      fixedValues: { '--names': [BOOTSTRAP_VERSION_PARAMETER] },
      sensitiveResponse:
        'returns parameter values; only Name, Version and LastModifiedDate are kept (the bootstrap version number is not secret)',
    },
  ),
]);

const key = (service: string, operation: string) => `${service} ${operation}`;
export const OPERATIONS_BY_KEY: ReadonlyMap<string, OperationDef> = new Map(
  OPERATIONS.map((o) => [key(o.service, o.operation), o]),
);

export const OPERATION_RE = /^(list|describe|get)-[a-z0-9-]+$/;
export const IAM_ACTION_RE = /^[a-z0-9-]+:(List|Describe|Get)[A-Za-z0-9]+$/;

/** Services never called (billed APIs, credential and data-plane surfaces, the guard's STS). */
export const DENIED_SERVICES: readonly string[] = [
  'ce', // Cost Explorer API requests are billed per request
  'cur',
  'sts',
  'sso',
  'sso-oidc',
  'login',
  'configure',
  's3', // high-level s3 commands (cp, rm, sync, rb)
  's3control',
  'ecr-public',
  'secretsmanager-data',
];

/** Read-like operations that return secrets, data, credentials or configuration values. */
export const DENIED_OPERATIONS: readonly string[] = [
  'secretsmanager get-secret-value',
  'secretsmanager batch-get-secret-value',
  'secretsmanager describe-secret', // not needed; list-secrets has the metadata
  'ssm get-parameter',
  'ssm get-parameters-by-path',
  'ssm get-parameter-history',
  'kms get-key-policy',
  'kms decrypt',
  'kms generate-data-key',
  'ec2 get-password-data',
  'ec2 get-console-output',
  'ec2 get-console-screenshot',
  'ec2 get-launch-template-data',
  'ecr get-login-password',
  'ecr get-authorization-token',
  'ecr get-download-url-for-layer',
  'ecr batch-get-image',
  'lambda get-function',
  'lambda get-function-configuration',
  'cloudformation get-template',
  'cloudfront get-distribution',
  'cloudfront get-distribution-config',
  'cloudfront get-function',
  'ecs describe-task-definition',
  'logs get-log-events',
  'logs filter-log-events',
  'logs start-query',
  'logs get-query-results',
  's3api get-object',
  's3api get-bucket-policy',
  'dynamodb get-item',
  'dynamodb batch-get-item',
  'dynamodb query',
  'dynamodb scan',
  'stepfunctions get-execution-history',
  'stepfunctions describe-execution',
  'rds download-db-log-file-portion',
  'rds generate-db-auth-token',
  'iam get-account-authorization-details',
  'iam get-credential-report',
];

/** Flags never passed (endpoint and TLS overrides, debug output, client-side filters, input files). */
export const DENIED_FLAGS: readonly string[] = [
  '--endpoint-url',
  '--debug',
  '--no-verify-ssl',
  '--ca-bundle',
  '--query',
  '--cli-input-json',
  '--cli-input-yaml',
  '--generate-cli-skeleton',
  '--cli-auto-prompt',
  '--no-sign-request',
  '--no-paginate',
  '--color',
  '--version',
];

/** Global options only the executor appends (exactly once, fixed values). */
export const RESERVED_FLAGS: readonly string[] = [
  '--profile',
  '--region',
  '--output',
  '--no-cli-pager',
  '--cli-connect-timeout',
  '--cli-read-timeout',
];

export const isDenied = (service: string, operation: string): boolean =>
  DENIED_SERVICES.includes(service) || DENIED_OPERATIONS.includes(key(service, operation));

/** Problems of one definition (empty = acceptable). Checked for the whole list at module load. */
export function definitionProblems(def: OperationDef): string[] {
  const p: string[] = [];
  if (!OPERATION_RE.test(def.operation)) p.push(`${def.operation} is not list-/describe-/get-`);
  if (!IAM_ACTION_RE.test(def.iamAction))
    p.push(`${def.iamAction} is not a List/Describe/Get action`);
  if (isDenied(def.service, def.operation))
    p.push(`${key(def.service, def.operation)} is denylisted`);
  for (const o of [...def.options, ...(def.flags ?? [])]) {
    if (!/^--[a-z0-9-]+$/.test(o)) p.push(`option ${o} is malformed`);
    if (DENIED_FLAGS.includes(o) || RESERVED_FLAGS.includes(o))
      p.push(`option ${o} is reserved or denied`);
  }
  if (VALUE_RESTRICTED.includes(key(def.service, def.operation))) {
    if ((def.flags ?? []).length > 0) p.push('a value-restricted operation takes no flags');
    for (const o of def.options) {
      if (!def.fixedValues?.[o]?.length) p.push(`value-restricted option ${o} has no fixedValues`);
    }
  }
  return p;
}

export function assertValidAllowlist(defs: readonly OperationDef[] = OPERATIONS): void {
  const problems = defs.flatMap((d) =>
    definitionProblems(d).map((x) => `${d.service} ${d.operation}: ${x}`),
  );
  const keys = defs.map((d) => key(d.service, d.operation));
  for (const k of keys)
    if (keys.indexOf(k) !== keys.lastIndexOf(k)) problems.push(`${k}: duplicate`);
  if (problems.length > 0) {
    throw new Error(`aws-sandbox read-only allowlist is invalid:\n  ${problems.join('\n  ')}`);
  }
}
assertValidAllowlist();

/** The least-privilege read-only IAM policy this tool needs (documentation; never applied by it). */
export function iamPolicyDocument(): {
  Version: '2012-10-17';
  Statement: { Sid: string; Effect: 'Allow'; Action: string[]; Resource: '*' }[];
} {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'AwsSandboxReadOnly',
        Effect: 'Allow',
        Action: [...new Set(OPERATIONS.map((o) => o.iamAction))].sort(),
        Resource: '*',
      },
    ],
  };
}
