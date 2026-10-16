/**
 * Read-only policy of the tool: the probe model, the rules every allowlisted probe must satisfy,
 * the denylist of dangerous read-like operations and flags, and the final argv check that runs at
 * the exec boundary. The allowlist itself lives in probes.ts; it is validated against these rules
 * when the module loads. Every call is re-validated by the executor before it is spawned, against
 * the independent list in boundary.ts (not against the registry).
 */
import { boundaryAllows, FORBIDDEN_OPTION_PREFIXES, STANDARD_FLAGS } from './boundary.ts';
import type { Sanitizer } from './sanitize.ts';
import { isWorkloadRegion } from './region.ts';
import {
  AREAS,
  DEFAULT_WORKLOAD_REGION,
  allowedRegions,
  type Area,
  type Json,
  type Region,
} from './types.ts';
import { PATTERNS, type PatternName } from './validate.ts';

/** Values that may be interpolated into probe arguments (each re-validated at the boundary). */
export type Placeholder =
  | 'account'
  | 'qualifier'
  | 'vpcId'
  | 'kmsKeyRef'
  | 'boundaryPolicyArn'
  | 'customerPolicyArn'
  | 'policyVersionId'
  | 'dbEngineVersion'
  | 'budgetName'
  | 'roleName'
  | 'policyName';

export const PLACEHOLDER_PATTERN: Readonly<Record<Placeholder, PatternName>> = {
  account: 'account',
  qualifier: 'qualifier',
  vpcId: 'vpcId',
  kmsKeyRef: 'kmsKeyRef',
  boundaryPolicyArn: 'boundaryPolicyArn',
  customerPolicyArn: 'customerPolicyArn',
  policyVersionId: 'policyVersionId',
  dbEngineVersion: 'dbEngineVersion',
  budgetName: 'budgetName',
  roleName: 'roleName',
  policyName: 'policyName',
};

export type PlaceholderValues = Partial<Record<Placeholder, string>>;

/** How a probe's response size is bounded. */
export type Bound =
  /** CLI-paginated operation: `--max-items N` (the CLI stops after N items, returns NextToken). */
  | { readonly kind: 'max-items'; readonly value: number }
  /** Single-page operation with a service page-size parameter; the next page is never fetched. */
  | {
      readonly kind: 'page-limit';
      readonly flag: '--limit' | '--max-results';
      readonly value: number;
    }
  /** One object (or one page that the service does not let us size). Never paginated by the tool. */
  | { readonly kind: 'single-response' };

export type Projection = (data: unknown, s: Sanitizer) => Json | undefined;

export interface ProbeDef {
  readonly id: string;
  readonly area: Area;
  /** `identity` probes run only inside the identity gate; `discovery` probes only after it. */
  readonly phase: 'identity' | 'discovery';
  /** AWS CLI v2 service name, e.g. `ec2`, `service-quotas`. */
  readonly service: string;
  /** AWS CLI v2 operation, always `get-*`, `list-*` or `describe-*`. */
  readonly operation: string;
  /** The exact IAM action the call needs (Service Authorization Reference). */
  readonly iamAction: string;
  /**
   * Resources for the generated least-privilege policy (default `*`). Used for actions that read
   * data or documents; `aws:RequestedRegion` still applies.
   */
  readonly iamResources?: readonly string[];
  readonly regions: readonly Region[];
  /**
   * Operation arguments. `{placeholder}` tokens are replaced by validated values only, always in
   * the `--option={placeholder}` form (or inside a literal such as `Name=vpc-id,Values={vpcId}`).
   */
  readonly args: readonly string[];
  /** Appended only when `--vpc-id` is given (VPC-scoped resources). Must contain `{vpcId}`. */
  readonly vpcFilter?: readonly string[];
  readonly bound: Bound;
  /** One call per value of this list-valued input. */
  readonly repeat?: 'qualifier' | 'kmsKeyRef' | 'budgetName' | 'policyName' | 'customerPolicyArn';
  /** Recorded as `skipped` when this optional operator input is absent. */
  readonly requires?: 'boundaryPolicyArn' | 'kmsKeyRef';
  readonly purpose: string;
  /** Sanitizing projection: an allowlist of response fields; everything else is dropped. */
  readonly project: Projection;
}

// ── Rules every allowlisted probe must satisfy ───────────────────────────────────────────────

export const OPERATION_RE = /^(get|list|describe)-[a-z0-9-]+$/;
export const IAM_ACTION_RE = /^[a-z0-9-]+:(Get|List|Describe)[A-Za-z0-9]+$/;

/**
 * Reviewed exceptions to the Get/List/Describe IAM verb rule. AWS Budgets authorizes
 * DescribeBudgets and DescribeNotificationsForBudget with `budgets:ViewBudget` (access level
 * Read): https://docs.aws.amazon.com/service-authorization/latest/reference/list_budgets.html
 * The same action also authorizes DescribeSubscribersForNotification, DescribeBudgetPerformance-
 * History and DescribeBudgetNotificationsForAccount, which this tool never calls (the subscriber
 * operation is denylisted below); an IAM policy cannot separate them.
 */
export const IAM_VERB_EXCEPTIONS: ReadonlyMap<string, readonly string[]> = new Map([
  ['budgets:ViewBudget', ['budgets describe-budgets', 'budgets describe-notifications-for-budget']],
]);

/** The only CLI services the allowlist may use, with their IAM service prefix. */
export const SERVICE_IAM_PREFIX: Readonly<Record<string, string>> = {
  acm: 'acm',
  budgets: 'budgets',
  cloudformation: 'cloudformation',
  dynamodb: 'dynamodb',
  ec2: 'ec2',
  ecr: 'ecr',
  ecs: 'ecs',
  elbv2: 'elasticloadbalancing',
  iam: 'iam',
  kms: 'kms',
  lambda: 'lambda',
  logs: 'logs',
  organizations: 'organizations',
  rds: 'rds',
  route53: 'route53',
  'service-quotas': 'servicequotas',
  ssm: 'ssm',
  sts: 'sts',
  wafv2: 'wafv2',
};

/** Services that must never be called at all. */
export const DENIED_SERVICES: readonly string[] = [
  's3',
  's3api',
  's3control',
  'ce', // Cost Explorer API requests are billed
  'configure', // configure export-credentials / get print credentials
  'sso', // sso get-role-credentials
  'sso-oidc',
  'login',
  'secretsmanager',
  'ecr-public', // get-login-password
];

/** Read-like operations that return secrets, data, credentials or PII. Never allowlisted. */
export const DENIED_OPERATIONS: readonly (readonly [service: string, operation: string])[] = [
  ['secretsmanager', 'get-secret-value'],
  ['secretsmanager', 'batch-get-secret-value'],
  ['ssm', 'get-parameters-by-path'],
  ['ssm', 'get-parameters'],
  ['ssm', 'get-parameter-history'],
  ['kms', 'get-key-policy'],
  ['kms', 'decrypt'],
  ['kms', 'generate-data-key'],
  ['ec2', 'get-password-data'],
  ['ec2', 'get-console-output'],
  ['ec2', 'get-console-screenshot'],
  ['ec2', 'get-launch-template-data'],
  ['ec2', 'describe-instance-attribute'],
  ['ecr', 'get-login-password'],
  ['ecr', 'get-authorization-token'],
  ['ecr', 'get-download-url-for-layer'],
  ['ecr', 'batch-get-image'],
  ['sts', 'get-session-token'],
  ['sts', 'get-federation-token'],
  ['sts', 'assume-role'],
  ['sts', 'assume-role-with-saml'],
  ['sts', 'assume-role-with-web-identity'],
  ['sts', 'assume-root'],
  ['lambda', 'get-function'],
  ['lambda', 'get-function-configuration'],
  ['cloudformation', 'get-template'],
  ['iam', 'get-account-authorization-details'],
  ['iam', 'get-credential-report'],
  ['iam', 'generate-credential-report'],
  ['logs', 'get-log-events'],
  ['logs', 'filter-log-events'],
  ['logs', 'get-query-results'],
  ['logs', 'start-query'],
  ['s3api', 'get-object'],
  ['dynamodb', 'get-item'],
  ['dynamodb', 'batch-get-item'],
  ['dynamodb', 'query'],
  ['dynamodb', 'scan'],
  ['sqs', 'receive-message'],
  ['stepfunctions', 'get-execution-history'],
  ['stepfunctions', 'describe-execution'],
  ['rds', 'download-db-log-file-portion'],
  ['rds', 'generate-db-auth-token'],
  ['eks', 'get-token'],
  ['codeartifact', 'get-authorization-token'],
  ['budgets', 'describe-subscribers-for-notification'],
  ['budgets', 'describe-budget-performance-history'],
  ['organizations', 'list-accounts'],
  ['organizations', 'describe-account'],
  ['account', 'get-contact-information'],
  ['account', 'get-alternate-contact'],
  ['account', 'get-primary-email'],
];

/** Flags that must never appear in an AWS CLI argv built by this tool (exact or `--flag=`). */
export const DENIED_FLAGS: readonly string[] = [
  '--debug',
  '--endpoint-url',
  '--no-verify-ssl',
  '--with-decryption',
  '--ca-bundle',
  '--cli-input-json',
  '--cli-input-yaml',
  '--generate-cli-skeleton',
  '--cli-auto-prompt',
  '--query',
  '--no-sign-request',
  '--no-paginate',
  '--cli-binary-format',
  '--cli-error-format',
  '--color',
  '--version',
];

/** Flags only the executor adds (never part of a probe's own arguments). */
export const RESERVED_FLAGS: readonly string[] = [
  ...STANDARD_FLAGS,
  '--max-items',
  '--page-size',
  '--starting-token',
  '--limit',
  '--max-results',
  '--next-token',
  '--next-marker',
];

/** Global arguments appended to every call after `--profile <p> --region <r>`. */
export const REQUIRED_GLOBAL_ARGS: readonly string[] = [
  '--output',
  'json',
  '--no-cli-pager',
  '--cli-connect-timeout',
  '10',
  '--cli-read-timeout',
  '30',
];

const SERVICE_RE = /^[a-z0-9-]{2,40}$/;
const PROBE_ID_RE = /^[a-z][a-z0-9.-]{2,80}$/;
const ARG_TOKEN_RE = /^[A-Za-z0-9_.:/=,{}+@-]{1,200}$/;
const PLACEHOLDER_RE = /\{([A-Za-z]+)\}/g;
const IAM_RESOURCE_RE = /^arn:aws:[a-z0-9-]+:[a-z0-9*-]*:[0-9*]*:[A-Za-z0-9/*._+=,@-]+$/;

export const flagMatches = (token: string, flag: string): boolean =>
  token === flag || token.startsWith(`${flag}=`);

export const isDeniedOperation = (service: string, operation: string): boolean =>
  DENIED_SERVICES.includes(service) ||
  DENIED_OPERATIONS.some(([s, o]) => s === service && o === operation);

export function iamActionProblem(def: Pick<ProbeDef, 'service' | 'operation' | 'iamAction'>) {
  const exception = IAM_VERB_EXCEPTIONS.get(def.iamAction);
  if (exception) {
    return exception.includes(`${def.service} ${def.operation}`)
      ? undefined
      : `${def.iamAction} is only allowed for ${exception.join(', ')}`;
  }
  if (!IAM_ACTION_RE.test(def.iamAction)) {
    return `IAM action "${def.iamAction}" is not a Get/List/Describe action`;
  }
  const [prefix, name = ''] = def.iamAction.split(':');
  if (prefix !== SERVICE_IAM_PREFIX[def.service]) {
    return `IAM prefix "${prefix}" does not belong to CLI service "${def.service}"`;
  }
  if (def.operation.replace(/-/g, '') !== name.toLowerCase()) {
    return `IAM action "${def.iamAction}" does not match operation "${def.operation}"`;
  }
  return undefined;
}

export function placeholdersIn(tokens: readonly string[]): string[] {
  const names: string[] = [];
  for (const t of tokens) for (const m of t.matchAll(PLACEHOLDER_RE)) names.push(m[1] ?? '');
  return names;
}

const optionName = (token: string) =>
  token.includes('=') ? token.slice(0, token.indexOf('=')) : token;

function argProblems(tokens: readonly string[], what: string): string[] {
  const problems: string[] = [];
  for (const t of tokens) {
    if (!ARG_TOKEN_RE.test(t)) problems.push(`${what} token "${t}" has disallowed characters`);
    for (const f of [...DENIED_FLAGS, ...RESERVED_FLAGS]) {
      if (flagMatches(t, f)) problems.push(`${what} contains the forbidden or reserved flag ${f}`);
    }
    for (const prefix of FORBIDDEN_OPTION_PREFIXES) {
      if (t.startsWith(prefix)) problems.push(`${what} token "${t}" starts with ${prefix}`);
    }
    if (t.startsWith('-') && !t.startsWith('--')) problems.push(`${what} has a short option ${t}`);
    // An interpolated value is never a token of its own: `--option={value}` or inside a literal.
    if (/^\{[A-Za-z]+\}$/.test(t)) problems.push(`${what} token "${t}" is a bare placeholder`);
    if (t.startsWith('--') && t.includes('{') && !/^--[a-z0-9-]+=[^=]*\{/.test(t)) {
      problems.push(`${what} token "${t}" must use --option={placeholder}`);
    }
  }
  for (const name of placeholdersIn(tokens)) {
    if (!(name in PLACEHOLDER_PATTERN)) problems.push(`${what} uses unknown placeholder {${name}}`);
  }
  return problems;
}

/**
 * Every rule a probe definition must satisfy; empty when the definition is acceptable. `workload`
 * is the run's workload region: a probe may target it and the global-endpoint region only.
 */
export function probeDefProblems(
  def: ProbeDef,
  workload: string = DEFAULT_WORKLOAD_REGION,
): string[] {
  const p: string[] = [];
  if (!PROBE_ID_RE.test(def.id)) p.push(`id "${def.id}" is malformed`);
  if (!AREAS.includes(def.area)) p.push(`area "${def.area}" is not one of ${AREAS.join(', ')}`);
  if (def.phase !== 'identity' && def.phase !== 'discovery') p.push('phase is invalid');
  if (!SERVICE_RE.test(def.service) || !(def.service in SERVICE_IAM_PREFIX)) {
    p.push(`service "${def.service}" is not an allowed AWS CLI service`);
  }
  if (!OPERATION_RE.test(def.operation)) {
    p.push(`operation "${def.operation}" is not a get-/list-/describe- operation`);
  }
  if (isDeniedOperation(def.service, def.operation)) {
    p.push(`${def.service} ${def.operation} is denylisted`);
  }
  const iam = iamActionProblem(def);
  if (iam) p.push(iam);
  if (!boundaryAllows(def.service, def.operation, def.iamAction)) {
    p.push(`${def.service} ${def.operation} ${def.iamAction} is not in the boundary list`);
  }
  if (def.regions.length === 0) p.push('regions is empty');
  if (new Set(def.regions).size !== def.regions.length) p.push('regions has duplicates');
  if (!isWorkloadRegion(workload)) p.push('the workload region is not an aws-partition region');
  for (const r of def.regions) {
    if (!allowedRegions(workload).includes(r)) p.push(`region "${r}" is not allowed`);
  }
  for (const resource of def.iamResources ?? []) {
    if (!IAM_RESOURCE_RE.test(resource)) p.push(`iamResources entry "${resource}" is malformed`);
  }
  p.push(...argProblems(def.args, 'args'));
  if (def.vpcFilter) {
    p.push(...argProblems(def.vpcFilter, 'vpcFilter'));
    if (!placeholdersIn(def.vpcFilter).includes('vpcId')) p.push('vpcFilter must use {vpcId}');
  }
  if (def.repeat && !placeholdersIn(def.args).includes(def.repeat)) {
    p.push(`repeat "${def.repeat}" is not used in args`);
  }
  if (def.requires && !placeholdersIn(def.args).includes(def.requires)) {
    p.push(`requires "${def.requires}" is not used in args`);
  }
  const b = def.bound;
  if (b.kind === 'max-items' || b.kind === 'page-limit') {
    if (!Number.isInteger(b.value) || b.value < 1 || b.value > 1000)
      p.push('bound is out of range');
  }
  if (b.kind === 'page-limit' && b.flag !== '--limit' && b.flag !== '--max-results') {
    p.push('page-limit flag is invalid');
  }
  if (!def.purpose || def.purpose.length > 220 || /[|<>`]/.test(def.purpose)) {
    p.push('purpose must be 1-220 characters without | < > or backticks');
  }
  if (typeof def.project !== 'function') p.push('project is missing');
  return p;
}

/** Throws when any definition breaks a rule or ids repeat. Called at module load (probes.ts). */
export function assertValidRegistry(
  defs: readonly ProbeDef[],
  workload: string = DEFAULT_WORKLOAD_REGION,
): void {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const def of defs) {
    for (const problem of probeDefProblems(def, workload)) problems.push(`${def.id}: ${problem}`);
    if (ids.has(def.id)) problems.push(`${def.id}: duplicate id`);
    ids.add(def.id);
  }
  if (problems.length > 0) {
    throw new Error(`aws-preflight probe allowlist is invalid:\n  ${problems.join('\n  ')}`);
  }
}

/** Replaces `{placeholder}` tokens with values that pass their validator; throws otherwise. */
export function renderArgs(tokens: readonly string[], values: PlaceholderValues): string[] {
  return tokens.map((token) =>
    token.replace(PLACEHOLDER_RE, (_, name: string) => {
      const pattern = PLACEHOLDER_PATTERN[name as Placeholder];
      const value = values[name as Placeholder];
      if (!pattern || value === undefined || !PATTERNS[pattern].test(value)) {
        throw new BoundaryViolation(`placeholder {${name}} has no valid value`);
      }
      return value;
    }),
  );
}

export const boundArgs = (bound: Bound): string[] =>
  bound.kind === 'max-items'
    ? ['--max-items', String(bound.value)]
    : bound.kind === 'page-limit'
      ? [bound.flag, String(bound.value)]
      : [];

export class BoundaryViolation extends Error {
  override name = 'BoundaryViolation';
}

/**
 * Final check of a complete AWS CLI argv (without the executable) immediately before it is
 * spawned. Independent of how the argv was built and of the registry object:
 * - `service operation iamAction` must be in the hand-maintained boundary list (boundary.ts);
 * - only option tokens that occur in the probe's own static arguments, its bound flag and the
 *   standard flags are accepted, each in the form the probe uses (`--opt=v` or `--opt v`);
 * - abbreviation prefixes the CLI's argparse would expand (`--no-verify`, `--deb`, `--endpoint`,
 *   ...) and denied flags are refused;
 * - the standard flags appear exactly once with their fixed values;
 * - the region is one the probe targets: the run's workload region or the global-endpoint region.
 */
export function assertArgvSafe(
  argv: readonly string[],
  def: ProbeDef,
  region: Region,
  workload: string = DEFAULT_WORKLOAD_REGION,
): void {
  const fail = (why: string): never => {
    throw new BoundaryViolation(`refusing to run ${def.id}: ${why}`);
  };
  const [service, operation] = argv;
  if (service !== def.service || operation !== def.operation) fail('argv does not match the probe');
  // Rule checks first (each is reachable with a forged definition), then the independent list.
  if (!OPERATION_RE.test(operation ?? '')) fail('operation is not get-/list-/describe-');
  if (isDeniedOperation(service ?? '', operation ?? '')) fail('operation is denylisted');
  if (iamActionProblem(def)) fail('IAM action is not read-only');
  if (!boundaryAllows(service ?? '', operation ?? '', def.iamAction)) {
    fail('operation is not in the boundary list');
  }
  if (
    !isWorkloadRegion(workload) ||
    !allowedRegions(workload).includes(region) ||
    !def.regions.includes(region)
  ) {
    fail(`region ${region} is not allowed for this probe`);
  }

  // Option tokens the probe itself uses, and whether it uses the `=` form.
  const allowed = new Map<string, boolean>();
  for (const t of [...def.args, ...(def.vpcFilter ?? [])]) {
    if (t.startsWith('--')) allowed.set(optionName(t), t.includes('='));
  }
  for (const t of boundArgs(def.bound)) if (t.startsWith('--')) allowed.set(t, false);
  for (const flag of STANDARD_FLAGS) allowed.set(flag, false);

  for (const token of argv.slice(2)) {
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(token)) fail('control character in argv');
    for (const flag of DENIED_FLAGS) if (flagMatches(token, flag)) fail(`forbidden flag ${flag}`);
    if (!token.startsWith('-')) continue;
    if (!token.startsWith('--')) fail(`short option ${token}`);
    for (const prefix of FORBIDDEN_OPTION_PREFIXES) {
      if (token.startsWith(prefix)) fail(`option ${optionName(token)} is refused (${prefix}…)`);
    }
    const usesEq = allowed.get(optionName(token));
    if (usesEq === undefined) fail(`option ${optionName(token)} is not part of this probe`);
    if (usesEq !== token.includes('=')) fail(`option ${optionName(token)} is in the wrong form`);
  }

  const count = (flag: string) => argv.filter((t) => optionName(t) === flag).length;
  for (const t of boundArgs(def.bound)) {
    if (t.startsWith('--') && count(t) !== 1) fail(`${t} must appear exactly once`);
  }
  const once = (flag: string): string | undefined => {
    const at = argv.indexOf(flag);
    if (count(flag) !== 1 || at < 0) fail(`${flag} must appear exactly once`);
    return argv[at + 1];
  };
  const profile = once('--profile');
  if (!PATTERNS.profile.test(profile ?? '')) fail('invalid --profile');
  if (once('--region') !== region) fail('--region does not match');
  if (once('--output') !== 'json') fail('--output must be json');
  once('--no-cli-pager');
  if (once('--cli-connect-timeout') !== '10') fail('--cli-connect-timeout must be 10');
  if (once('--cli-read-timeout') !== '30') fail('--cli-read-timeout must be 30');
}
