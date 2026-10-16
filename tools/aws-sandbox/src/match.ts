/**
 * Which resources belong to the experiment. Strong evidence: the run / experiment tags,
 * the CloudFormation stack tag of an experiment stack, or living in an
 * experiment VPC. Weak evidence: a name prefix only (`starter-sbx`, `Sandbox-`, `starter-it-`); a weak
 * match is `not-owned` when the operator's baseline lists it or it predates `--since`.
 * The CDK toolkit (`starter-cdk-toolkit`, `cdk-starter-*`) is its own scope, reported separately.
 */

export const RUN_ID_TAG = 'starter:run-id';
export const EXPERIMENT_TAG = 'starter:experiment';
export const EXPERIMENT_VALUE = 'live-validation';
export const STACK_NAME_TAG = 'aws:cloudformation:stack-name';
export const BOOTSTRAP_STACK = 'starter-cdk-toolkit';

/** Run ids: Phase 2 `sbx-<6 hex>`, Phase 1 `it-<6 hex>`; generic RUN_ID_RE of _common.sh. */
export const RUN_ID_RE = /^[a-z0-9](?:[a-z0-9-]{1,22}[a-z0-9])$/;

/** Name prefixes of experiment resources (matched against every name segment). */
export const EXPERIMENT_NAME_PATTERNS: readonly { readonly re: RegExp; readonly label: string }[] =
  [
    { re: /^starter-?sbx/i, label: 'starter-sbx' },
    // Physical names CloudFormation derives from `Sandbox-*` stack names (RDS and S3 lower-case them).
    { re: /^sandbox-/i, label: 'Sandbox-' },
    // CDK unique names derived from the `Sandbox/<Stack>` construct path (e.g. CloudFront OACs).
    { re: /^Sandbox[A-Z]/, label: 'Sandbox<Stack>' },
    { re: /^starter-it-/i, label: 'starter-it-' },
  ];

export const BOOTSTRAP_NAME_PATTERNS: readonly { readonly re: RegExp; readonly label: string }[] = [
  { re: /^cdk-starter-/i, label: 'cdk-starter-' },
  { re: /^starter-cdk-toolkit/i, label: BOOTSTRAP_STACK },
];
/** Whole-name patterns (names whose segments alone would not say it). */
const BOOTSTRAP_FULL_NAMES: readonly RegExp[] = [/^\/cdk-bootstrap\/starter\//];

export const EXPERIMENT_STACK_RE = /^(Sandbox-|starter-sbx-|starter-it-)/;

/** `a/b:c d` -> [whole, a, b, c d] (path, ARN and alias segments; also the part after "ENI-"). */
export function nameSegments(name: string): string[] {
  const parts = name.split(/[/:]/).filter((p) => p.length > 0);
  const extra = parts.flatMap((p) => {
    const words = p.split(/\s+/).filter((w) => w.length > 0);
    return [
      ...(words.length > 1 ? words : []),
      // Lambda hyperplane ENIs: "AWS Lambda VPC ENI-<function name>-<id>".
      ...words.filter((w) => w.startsWith('ENI-')).map((w) => w.slice(4)),
    ];
  });
  return [name, ...parts, ...extra];
}

export function matchName(
  names: readonly (string | undefined)[],
): { scope: 'experiment' | 'bootstrap'; label: string; name: string } | undefined {
  const list = names.filter((n): n is string => typeof n === 'string' && n.length > 0);
  for (const name of list) {
    if (BOOTSTRAP_FULL_NAMES.some((re) => re.test(name))) {
      return { scope: 'bootstrap', label: 'cdk-bootstrap/starter', name };
    }
    for (const seg of nameSegments(name)) {
      const b = BOOTSTRAP_NAME_PATTERNS.find((p) => p.re.test(seg));
      if (b) return { scope: 'bootstrap', label: b.label, name };
    }
  }
  for (const name of list) {
    for (const seg of nameSegments(name)) {
      const e = EXPERIMENT_NAME_PATTERNS.find((p) => p.re.test(seg));
      if (e) return { scope: 'experiment', label: e.label, name };
    }
  }
  return undefined;
}

/** Normalizes an ARN for comparisons (log-group ARNs carry a trailing `:*`). */
export const normalizeArn = (arn: string): string => arn.replace(/:\*$/, '');

export interface Candidate {
  readonly names: readonly (string | undefined)[];
  readonly arn?: string | undefined;
  readonly tags?: Readonly<Record<string, string>> | undefined;
  readonly vpcId?: string | undefined;
}

export interface Ownership {
  readonly scope: 'experiment' | 'bootstrap';
  readonly strength: 'run' | 'experiment' | 'weak';
  readonly reasons: readonly string[];
  /** starter:run-id of the resource when it differs from the verified run. */
  readonly otherRunId?: string;
}

export interface MatchContext {
  readonly runId: string;
  /** Tags from the regional tag index, by normalized ARN. */
  readonly taggedArns: ReadonlyMap<string, Readonly<Record<string, string>>>;
  readonly experimentVpcIds: ReadonlySet<string>;
}

export function ownership(c: Candidate, ctx: MatchContext): Ownership | undefined {
  const tags: Record<string, string> = {
    ...(c.arn ? (ctx.taggedArns.get(normalizeArn(c.arn)) ?? {}) : {}),
    ...(c.tags ?? {}),
  };
  const stackTag = tags[STACK_NAME_TAG];
  const byName = matchName(c.names);
  if (stackTag === BOOTSTRAP_STACK || byName?.scope === 'bootstrap') {
    return {
      scope: 'bootstrap',
      strength: 'experiment',
      reasons: [
        stackTag === BOOTSTRAP_STACK ? `stack-tag:${BOOTSTRAP_STACK}` : `name:${byName?.label}`,
      ],
    };
  }
  const reasons: string[] = [];
  const runTag = tags[RUN_ID_TAG];
  let strength: Ownership['strength'] | undefined;
  if (runTag === ctx.runId) {
    strength = 'run';
    reasons.push(`tag:${RUN_ID_TAG}`);
  }
  if (tags[EXPERIMENT_TAG] === EXPERIMENT_VALUE) {
    strength ??= 'experiment';
    reasons.push(`tag:${EXPERIMENT_TAG}`);
  }
  if (stackTag && EXPERIMENT_STACK_RE.test(stackTag)) {
    strength ??= 'experiment';
    reasons.push(`stack-tag:${stackTag}`);
  }
  if (c.vpcId && ctx.experimentVpcIds.has(c.vpcId)) {
    strength ??= 'experiment';
    reasons.push('in-experiment-vpc');
  }
  if (byName) {
    strength ??= 'weak';
    reasons.push(`name:${byName.label}`);
  }
  if (!strength) return undefined;
  const otherRunId = runTag && runTag !== ctx.runId ? runTag : undefined;
  return { scope: 'experiment', strength, reasons, ...(otherRunId ? { otherRunId } : {}) };
}
