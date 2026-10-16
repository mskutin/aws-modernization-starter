/**
 * The call plan, rendered from the allowlist without credentials or AWS calls: markdown table,
 * JSON, and the least-privilege IAM policy, for a workload region (default
 * DEFAULT_WORKLOAD_REGION). Also generates the README table section and
 * iam/discovery-readonly-policy.json for the DEFAULT region (test/docs.test.ts fails when they
 * drift).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { formatText } from './format.ts';
import { boundArgs, REQUIRED_GLOBAL_ARGS, type Placeholder, type ProbeDef } from './policy.ts';
import {
  ACTIVE_STACK_STATUSES,
  CDK_DEFAULT_QUALIFIER,
  DEFAULT_DB_ENGINE_VERSION,
  DEFAULT_QUALIFIER,
  MAX_BUDGET_NOTIFICATION_CALLS,
  MAX_POLICY_DOCUMENTS,
  probesFor,
  VERIFIED_CLI_VERSION,
} from './probes.ts';
import { allowedRegions, DEFAULT_WORKLOAD_REGION, GLOBAL_REGION } from './types.ts';

export const README_PATH = fileURLToPath(new URL('../README.md', import.meta.url));
export const POLICY_PATH = fileURLToPath(
  new URL('../iam/discovery-readonly-policy.json', import.meta.url),
);
export const README_BEGIN =
  '<!-- BEGIN GENERATED probe table: node tools/aws-preflight/src/cli.ts plan --write -->';
export const README_END = '<!-- END GENERATED probe table -->';

const DISPLAY: Readonly<Record<Placeholder, string>> = {
  account: '<account>',
  qualifier: '<qualifier>',
  vpcId: '<vpc-id>',
  kmsKeyRef: '<kms-alias>',
  boundaryPolicyArn: '<boundary-policy-arn>',
  customerPolicyArn: '<customer-policy-arn>',
  policyVersionId: '<default-version-id>',
  dbEngineVersion: '<db-engine-version>',
  budgetName: '<budget-name>',
  roleName: '<caller-role>',
  policyName: '<inline-policy-name>',
};

const display = (tokens: readonly string[]) =>
  tokens.map((t) =>
    t.replace(/\{([A-Za-z]+)\}/g, (_, n: string) => DISPLAY[n as Placeholder] ?? `<${n}>`),
  );

/** Arguments every call gets after the probe's own arguments. */
export const COMMON_ARGS = `--profile <profile> --region <region> ${REQUIRED_GLOBAL_ARGS.join(' ')}`;

const ACTIVE_STATUSES_TEXT = ACTIVE_STACK_STATUSES.join(' ');
const ACTIVE_STATUSES_TOKEN = '<active-stack-statuses>';

/**
 * `aws <service> <operation> <args> [vpc filter] <bound>` with placeholders shown as `<name>`.
 * `compact` abbreviates the 22 list-stacks statuses (markdown table only).
 */
export function templateCommand(def: ProbeDef, options: { compact?: boolean } = {}): string {
  const parts = [def.service, def.operation, ...display(def.args)];
  if (def.vpcFilter) parts.push(`[${display(def.vpcFilter).join(' ')}]`);
  parts.push(...boundArgs(def.bound));
  const command = `aws ${parts.join(' ')}`;
  return options.compact ? command.replace(ACTIVE_STATUSES_TEXT, ACTIVE_STATUSES_TOKEN) : command;
}

function scope(def: ProbeDef): string {
  const notes: string[] = [];
  if (def.repeat === 'qualifier') {
    notes.push(
      `per qualifier: --qualifier (default ${DEFAULT_QUALIFIER}) and ${CDK_DEFAULT_QUALIFIER}`,
    );
  }
  if (def.repeat === 'kmsKeyRef') notes.push('per --kms-key');
  if (def.repeat === 'budgetName')
    notes.push(`per budget, at most ${MAX_BUDGET_NOTIFICATION_CALLS}`);
  if (def.repeat === 'policyName') {
    notes.push(`per inline policy of the caller role, at most ${MAX_POLICY_DOCUMENTS}`);
  }
  if (def.repeat === 'customerPolicyArn') {
    notes.push(`per attached customer managed policy, at most ${MAX_POLICY_DOCUMENTS}`);
  }
  if (def.requires === 'boundaryPolicyArn') notes.push('only with --boundary-policy-arn');
  if (def.vpcFilter) notes.push('VPC filter only with --vpc-id');
  if (def.phase === 'identity') notes.push('identity gate');
  return notes.join('; ');
}

export interface PlanRow {
  readonly id: string;
  readonly area: string;
  readonly phase: string;
  readonly service: string;
  readonly operation: string;
  readonly iamAction: string;
  readonly iamResources: readonly string[];
  readonly regions: readonly string[];
  readonly command: string;
  readonly scope: string;
  readonly purpose: string;
}

export function planRows(workload: string = DEFAULT_WORKLOAD_REGION): PlanRow[] {
  return probesFor(workload).probes.map((def) => ({
    id: def.id,
    area: def.area,
    phase: def.phase,
    service: def.service,
    operation: def.operation,
    iamAction: def.iamAction,
    iamResources: [...(def.iamResources ?? ['*'])],
    regions: [...def.regions],
    command: templateCommand(def),
    scope: scope(def),
    purpose: def.purpose,
  }));
}

export function renderPlanTable(workload: string = DEFAULT_WORKLOAD_REGION): string {
  const lines = [
    '| Probe | Area | AWS CLI command | IAM action | Regions | Purpose |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const def of probesFor(workload).probes) {
    const notes = scope(def);
    const purpose = notes ? `${def.purpose} (${notes})` : def.purpose;
    const iam = def.iamResources
      ? `\`${def.iamAction}\` on ${def.iamResources.map((r) => `\`${r}\``).join(', ')}`
      : `\`${def.iamAction}\``;
    lines.push(
      `| \`${def.id}\` | ${def.area} | \`${templateCommand(def, { compact: true })}\` | ${iam} | ${def.regions.join(', ')} | ${purpose} |`,
    );
  }
  lines.push(
    '',
    `\`${ACTIVE_STATUSES_TOKEN}\`: every stack status except \`DELETE_COMPLETE\` — ${ACTIVE_STACK_STATUSES.map((x) => `\`${x}\``).join(', ')}.`,
  );
  return lines.join('\n');
}

export function renderPlanMarkdown(workload: string = DEFAULT_WORKLOAD_REGION): string {
  return [
    '# starter-aws-preflight call plan',
    '',
    `Verified against aws-cli ${VERIFIED_CLI_VERSION}. Workload region ${workload}; global endpoints in ${GLOBAL_REGION}.`,
    `Every call also gets: \`${COMMON_ARGS}\`.`,
    'No credentials were used and no AWS call was made to produce this plan.',
    '',
    renderPlanTable(workload),
    '',
  ].join('\n');
}

export function renderPlanJson(workload: string = DEFAULT_WORKLOAD_REGION): object {
  return {
    tool: '@starter/tool-aws-preflight',
    verifiedCliVersion: VERIFIED_CLI_VERSION,
    regions: { workload, global: GLOBAL_REGION },
    commonArgs: COMMON_ARGS,
    defaults: {
      qualifier: DEFAULT_QUALIFIER,
      cdkDefaultQualifier: CDK_DEFAULT_QUALIFIER,
      dbEngineVersion: DEFAULT_DB_ENGINE_VERSION,
    },
    probes: planRows(workload),
  };
}

/** Resources of each allowlisted IAM action: `*`, or the union of the probes' iamResources. */
export function iamActionResources(
  workload: string = DEFAULT_WORKLOAD_REGION,
): Map<string, readonly string[] | '*'> {
  const out = new Map<string, Set<string> | '*'>();
  for (const p of probesFor(workload).probes) {
    const current = out.get(p.iamAction);
    if (!p.iamResources || p.iamResources.length === 0) out.set(p.iamAction, '*');
    else if (current !== '*')
      out.set(p.iamAction, new Set([...(current ?? []), ...p.iamResources]));
  }
  return new Map([...out].map(([a, r]) => [a, r === '*' ? '*' : [...r].sort()]));
}

const sidOf = (action: string) =>
  `AwsPreflight${action
    .split(':')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
    .replace(/[^A-Za-z0-9]/g, '')}`;

/**
 * Least-privilege IAM policy: exactly the allowlisted IAM actions, in the workload region and the
 * global-endpoint region only. Actions
 * that read documents or values (ssm:GetParameter, cloudformation:DescribeStacks,
 * iam:GetRolePolicy) get their own statement limited to the resources the probes read.
 */
export function iamPolicy(workload: string = DEFAULT_WORKLOAD_REGION): object {
  const condition = { StringEquals: { 'aws:RequestedRegion': [...allowedRegions(workload)] } };
  const resources = iamActionResources(workload);
  const wildcard = [...resources].filter(([, r]) => r === '*').map(([a]) => a);
  const scoped = [...resources].filter((e): e is [string, readonly string[]] => e[1] !== '*');
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'AwsPreflightReadOnlyDiscovery',
        Effect: 'Allow',
        Action: wildcard.sort(),
        Resource: '*',
        Condition: condition,
      },
      ...scoped
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([action, res]) => ({
          Sid: sidOf(action),
          Effect: 'Allow',
          Action: [action],
          Resource: [...res],
          Condition: condition,
        })),
    ],
  };
}

export async function renderPolicyFile(): Promise<string> {
  return formatText(`${JSON.stringify(iamPolicy(), null, 2)}\n`, 'json');
}

/** The README with its generated section replaced (Prettier-formatted). */
export async function renderReadme(
  current: string = readFileSync(README_PATH, 'utf8'),
): Promise<string> {
  const start = current.indexOf(README_BEGIN);
  const end = current.indexOf(README_END);
  if (start < 0 || end < start)
    throw new Error(`README markers not found: ${README_BEGIN} … ${README_END}`);
  const next = `${current.slice(0, start)}${README_BEGIN}\n\n${renderPlanTable()}\n\n${current.slice(end)}`;
  return formatText(next, 'markdown');
}
