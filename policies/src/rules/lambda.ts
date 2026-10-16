import type { PolicyRule } from '../types.js';
import { databaseAuthFindings, functionEntries, relaxationFindings } from './runtime.js';
import { asArray, finding, get, isPresent, props } from './util.js';

const FN = 'AWS::Lambda::Function';

/** Default runtime allowlist (2026-10). Keep in sync with `guard/rules/lambda.guard`. */
export const DEFAULT_ALLOWED_RUNTIMES = [
  'nodejs24.x',
  'nodejs22.x',
  'python3.13',
  'python3.14',
  'java21',
  'provided.al2023',
] as const;

/** Default upper bound for function timeouts. Keep in sync with `guard/rules/lambda.guard`. */
export const DEFAULT_MAX_TIMEOUT_SECONDS = 300;

const isImage = (p: Record<string, unknown>) => p['PackageType'] === 'Image';

export const lambdaRules: PolicyRule[] = [
  {
    id: 'BASE-LMB-001',
    title: 'Lambda runtimes are on the allowlist',
    description: `Zip-packaged functions use a runtime from the allowlist (default: ${DEFAULT_ALLOWED_RUNTIMES.join(', ')}).`,
    rationale:
      'Deprecated runtimes stop receiving security patches; the allowlist is the set the project supports.',
    severity: 'high',
    engines: ['cdk-nag', 'guard'],
    resourceTypes: [FN],
    remediation: 'Use `lambda.Runtime.NODEJS_24_X` (the project standard).',
    notes: 'Container-image functions are not applicable. The cdk-nag list is configurable.',
    evaluate: ({ resource, options }) => {
      const p = props(resource);
      if (isImage(p)) return 'not-applicable';
      const runtime = p['Runtime'];
      return typeof runtime === 'string' && options.lambda.allowedRuntimes.includes(runtime)
        ? []
        : [finding('Properties/Runtime', `Runtime ${String(runtime)} is not on the allowlist.`)];
    },
  },
  {
    id: 'BASE-LMB-002',
    title: 'Lambda functions prefer arm64',
    description: 'Functions set Architectures to [arm64] (Graviton).',
    rationale: 'arm64 is ~20% cheaper per GB-second and the project builds arm64 artefacts.',
    severity: 'low',
    engines: ['cdk-nag', 'guard'],
    resourceTypes: [FN],
    remediation: 'Set `architecture: lambda.Architecture.ARM_64`.',
    notes: 'Advisory (warning): does not fail the build.',
    evaluate: ({ resource }) => {
      const arch = asArray(props(resource)['Architectures']);
      return arch.length === 1 && arch[0] === 'arm64'
        ? []
        : [finding('Properties/Architectures', 'Function does not use arm64.')];
    },
  },
  {
    id: 'BASE-LMB-003',
    title: 'Lambda timeouts are explicit and bounded',
    description: `Functions set Timeout explicitly and no higher than the bound (default ${DEFAULT_MAX_TIMEOUT_SECONDS} s).`,
    rationale:
      'Bounded timeouts cap runaway cost and keep functions below the Step Functions task timeouts in the workflow spec.',
    severity: 'medium',
    engines: ['cdk-nag', 'guard'],
    resourceTypes: [FN],
    remediation: 'Set `timeout: Duration.seconds(n)` matching the workflow task timeout.',
    notes:
      'The cdk-nag bound is configurable (`lambda.maxTimeoutSeconds`); Guard uses the default.',
    evaluate: ({ resource, options }) => {
      const t = props(resource)['Timeout'];
      if (typeof t !== 'number') {
        return [finding('Properties/Timeout', 'Timeout is not set explicitly (default 3 s).')];
      }
      return t <= options.lambda.maxTimeoutSeconds
        ? []
        : [
            finding(
              'Properties/Timeout',
              `Timeout ${t}s exceeds ${options.lambda.maxTimeoutSeconds}s.`,
            ),
          ];
    },
  },
  {
    id: 'BASE-LMB-004',
    title: 'Lambda reserved concurrency is set',
    description: 'Functions set ReservedConcurrentExecutions to a value >= 1.',
    rationale:
      'Caps blast radius and spend, and protects downstream databases from connection storms.',
    severity: 'low',
    engines: ['cdk-nag', 'guard'],
    resourceTypes: [FN],
    remediation:
      'Set `reservedConcurrentExecutions`. New accounts with a 10-concurrency quota cannot reserve capacity; request a quota increase first.',
    notes: 'Advisory (warning) because reservation fails on low-quota accounts.',
    evaluate: ({ resource }) => {
      const rc = props(resource)['ReservedConcurrentExecutions'];
      return typeof rc === 'number' && rc >= 1
        ? []
        : [
            finding(
              'Properties/ReservedConcurrentExecutions',
              'Reserved concurrency is not set (>= 1).',
            ),
          ];
    },
  },
  {
    id: 'BASE-LMB-005',
    title: 'Lambda logs go to a managed log group',
    description:
      'Functions set LoggingConfig.LogGroup to a CloudFormation-managed log group (so BASE-LOG-001/002 retention and encryption apply).',
    rationale:
      'Otherwise Lambda creates /aws/lambda/<name> on first invoke with infinite retention and no KMS key, outside IaC.',
    severity: 'medium',
    engines: ['cdk-nag', 'guard'],
    resourceTypes: [FN],
    remediation: 'Pass `logGroup: new logs.LogGroup(...)` to the function.',
    evaluate: ({ resource }) =>
      isPresent(get(props(resource), 'LoggingConfig', 'LogGroup'))
        ? []
        : [finding('Properties/LoggingConfig/LogGroup', 'No explicit log group configured.')],
  },
  {
    id: 'BASE-LMB-006',
    title: 'Lambda active tracing is enabled',
    description: 'Functions set TracingConfig.Mode to Active.',
    rationale: 'End-to-end traces across API → Step Functions → Lambda are needed for operations.',
    severity: 'medium',
    engines: ['cdk-nag', 'guard'],
    resourceTypes: [FN],
    remediation: 'Set `tracing: lambda.Tracing.ACTIVE`.',
    evaluate: ({ resource }) =>
      get(props(resource), 'TracingConfig', 'Mode') === 'Active'
        ? []
        : [finding('Properties/TracingConfig/Mode', 'Active tracing is not enabled.')],
  },
  {
    id: 'BASE-LMB-007',
    title: 'Lambda functions carry no local/CI relaxations',
    description:
      'Function environment variables do not set APP_RUNTIME other than aws, AUTH_ALLOW_INSECURE_ISSUER, an http: AUTH_ISSUER or AUTH_JWKS_URI, DB_SSL other than verify-full (a DB_HOST needs an explicit DB_SSL=verify-full), or DB_PASSWORD.',
    rationale:
      'Local and CI relaxations key on APP_RUNTIME, which CDK never sets; a deployed function that carries one runs with production data and weakened controls.',
    severity: 'high',
    engines: ['cdk-nag', 'guard'],
    resourceTypes: [FN],
    remediation:
      'Remove the variable; use DB_AUTH=iam with DB_SSL=verify-full and an https issuer.',
    notes: 'Deployed-runtime settings (ADR 0511). No exemptions.',
    evaluate: ({ resource }) =>
      relaxationFindings(
        functionEntries(get(props(resource), 'Environment', 'Variables')),
        'Function',
      ),
  },
  {
    id: 'BASE-LMB-008',
    title: 'Lambda functions authenticate to PostgreSQL with IAM',
    description:
      'Function environment variables do not set DB_AUTH other than iam (a DB_HOST needs an explicit DB_AUTH=iam) or a DB_*SECRET* variable such as DB_SECRET_ARN.',
    rationale:
      'Functions use short-lived RDS IAM tokens; a database secret reference gives the function role long-lived database credentials.',
    severity: 'high',
    engines: ['cdk-nag', 'guard'],
    resourceTypes: [FN],
    remediation: 'Set DB_AUTH=iam and grant rds-db:connect for the function database user.',
    notes: 'ADRs 0221 and 0511. No exemptions for functions.',
    evaluate: ({ resource }) =>
      databaseAuthFindings(
        functionEntries(get(props(resource), 'Environment', 'Variables')),
        'Function',
      ),
  },
];
