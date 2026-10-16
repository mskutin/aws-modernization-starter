/**
 * The exec boundary's own list of permitted calls: `service operation iamAction`.
 *
 * Maintained by hand and deliberately NOT derived from probes.ts. A probe that is added to or
 * changed in the registry without the same change here is refused at the exec boundary, and
 * test/policy.test.ts fails until both lists agree. Every entry was checked with
 * `aws <service> <operation> help` (aws-cli 2.35.11) and against the Service Authorization
 * Reference. Keep it sorted.
 */
export const BOUNDARY_OPERATIONS: readonly string[] = Object.freeze([
  'acm list-certificates acm:ListCertificates',
  'budgets describe-budgets budgets:ViewBudget',
  'budgets describe-notifications-for-budget budgets:ViewBudget',
  'cloudformation describe-account-limits cloudformation:DescribeAccountLimits',
  'cloudformation describe-stacks cloudformation:DescribeStacks',
  'cloudformation list-stacks cloudformation:ListStacks',
  'cloudformation list-types cloudformation:ListTypes',
  'dynamodb describe-limits dynamodb:DescribeLimits',
  'ec2 describe-account-attributes ec2:DescribeAccountAttributes',
  'ec2 describe-availability-zones ec2:DescribeAvailabilityZones',
  'ec2 describe-internet-gateways ec2:DescribeInternetGateways',
  'ec2 describe-managed-prefix-lists ec2:DescribeManagedPrefixLists',
  'ec2 describe-nat-gateways ec2:DescribeNatGateways',
  'ec2 describe-route-tables ec2:DescribeRouteTables',
  'ec2 describe-subnets ec2:DescribeSubnets',
  'ec2 describe-vpc-block-public-access-exclusions ec2:DescribeVpcBlockPublicAccessExclusions',
  'ec2 describe-vpc-block-public-access-options ec2:DescribeVpcBlockPublicAccessOptions',
  'ec2 describe-vpc-endpoints ec2:DescribeVpcEndpoints',
  'ec2 describe-vpcs ec2:DescribeVpcs',
  'ecr describe-registry ecr:DescribeRegistry',
  'ecr get-registry-scanning-configuration ecr:GetRegistryScanningConfiguration',
  'ecs list-account-settings ecs:ListAccountSettings',
  'elbv2 describe-account-limits elasticloadbalancing:DescribeAccountLimits',
  'iam get-account-summary iam:GetAccountSummary',
  'iam get-policy iam:GetPolicy',
  'iam get-policy-version iam:GetPolicyVersion',
  'iam get-role iam:GetRole',
  'iam get-role-policy iam:GetRolePolicy',
  'iam list-account-aliases iam:ListAccountAliases',
  'iam list-attached-role-policies iam:ListAttachedRolePolicies',
  'iam list-policies iam:ListPolicies',
  'iam list-role-policies iam:ListRolePolicies',
  'kms describe-key kms:DescribeKey',
  'kms list-aliases kms:ListAliases',
  'lambda get-account-settings lambda:GetAccountSettings',
  'logs describe-account-policies logs:DescribeAccountPolicies',
  'logs describe-resource-policies logs:DescribeResourcePolicies',
  'organizations describe-effective-policy organizations:DescribeEffectivePolicy',
  'organizations describe-organization organizations:DescribeOrganization',
  'organizations list-parents organizations:ListParents',
  'organizations list-policies-for-target organizations:ListPoliciesForTarget',
  'rds describe-account-attributes rds:DescribeAccountAttributes',
  'rds describe-certificates rds:DescribeCertificates',
  'rds describe-db-engine-versions rds:DescribeDBEngineVersions',
  'rds describe-orderable-db-instance-options rds:DescribeOrderableDBInstanceOptions',
  'route53 list-hosted-zones route53:ListHostedZones',
  'service-quotas get-aws-default-service-quota servicequotas:GetAWSDefaultServiceQuota',
  'service-quotas get-service-quota servicequotas:GetServiceQuota',
  'service-quotas list-requested-service-quota-change-history-by-quota servicequotas:ListRequestedServiceQuotaChangeHistoryByQuota',
  'service-quotas list-service-quotas servicequotas:ListServiceQuotas',
  'ssm get-parameter ssm:GetParameter',
  'sts get-caller-identity sts:GetCallerIdentity',
  'wafv2 list-web-acls wafv2:ListWebACLs',
]);

const BOUNDARY_SET: ReadonlySet<string> = new Set(BOUNDARY_OPERATIONS);

export const boundaryAllows = (service: string, operation: string, iamAction: string): boolean =>
  BOUNDARY_SET.has(`${service} ${operation} ${iamAction}`);

/**
 * Option prefixes the boundary refuses outright. The AWS CLI's argparse accepts unambiguous
 * abbreviations (`--no-verify` = `--no-verify-ssl`, `--deb` = `--debug`, `--endpoint=x` =
 * `--endpoint-url`), so exact matching alone is not enough.
 */
export const FORBIDDEN_OPTION_PREFIXES: readonly string[] = Object.freeze([
  '--no-verify',
  '--endpoint',
  '--deb',
  '--with-dec',
  '--cli-input',
  '--generate-cli',
  '--ca-bundle',
  '--query',
  '--no-sign',
  '--no-pag',
  '--cli-binary',
  '--cli-error',
  '--cli-auto',
  '--no-cli-auto',
  '--color',
  '--profile=',
  '--region=',
  '--output=',
]);

/** The standard flags the executor appends (two-token form only, exactly once each). */
export const STANDARD_FLAGS: readonly string[] = Object.freeze([
  '--profile',
  '--region',
  '--output',
  '--no-cli-pager',
  '--cli-connect-timeout',
  '--cli-read-timeout',
]);
