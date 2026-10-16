/**
 * verify-clean: a read-only sweep of every service the sandbox stage and the mini-stack use,
 * classifying each experiment resource it finds:
 *   remaining           — still exists (fails the verification)
 *   pending-deletion    — KMS key / secret scheduled for deletion, DynamoDB system backup
 *                         (date and residual cost reported)
 *   retained-by-design  — left by a DeletionPolicy (final RDS snapshot, retained automated
 *                         backups); none is expected in the sandbox, so each one is flagged
 *   not-owned           — name-prefix match only, and listed in the baseline or older than --since
 * Verdict: clean (exit 0) needs every category proven by an exhaustive listing. When the
 * operator's role cannot list a category, a fallback finds what it can (tag index, the run's
 * inventory, aliases, deleted-stack resources) and the verdict is at best
 * `clean-with-unverifiable` (exit 5), naming each such category and its evidence.
 * It NEVER deletes or changes anything: there is no mutating operation in the allowlist.
 */
import { readFileSync } from 'node:fs';
import { maskString } from './mask.js';
import { normalizeArn, ownership, RUN_ID_TAG, type MatchContext } from './match.js';
import type { PriceBook } from './model/prices.js';
import type { Finding } from './schemas.js';
import type { ReadOnlyAws } from './aws/session.js';
import { collectCloudFormationEvidence } from './sweep/cfn-evidence.js';
import type {
  CategoryStatus,
  CfnEvidence,
  InventoryEvidence,
  RawFinding,
  SweepEnv,
  SweepOutcome,
} from './sweep/common.js';
import {
  schedulerNotUsed,
  sweepEcs,
  sweepEvents,
  sweepLambda,
  sweepStepFunctions,
} from './sweep/compute.js';
import {
  sweepDynamoDb,
  sweepEcr,
  sweepKms,
  sweepRds,
  sweepS3,
  sweepSecrets,
} from './sweep/data.js';
import { sweepLoadBalancing, sweepNetwork } from './sweep/network.js';
import {
  sweepCloudFormation,
  sweepCloudFront,
  sweepCloudWatch,
  sweepIamSns,
  sweepSsm,
  sweepTagIndex,
} from './sweep/platform.js';

export interface VerifyOptions {
  readonly runId: string;
  readonly region: string;
  readonly includeBootstrap: boolean;
  /** retained-by-design findings fail too. */
  readonly strict: boolean;
  /** Ids / ARNs (masked form) of pre-existing resources: weak matches among them are not-owned. */
  readonly baseline?: ReadonlySet<string> | undefined;
  /** Weak matches created before this instant are not-owned. */
  readonly since?: Date | undefined;
  /** The run's inventory: its resource ids are the run's own (strong evidence after deletion). */
  readonly inventory?: InventoryEvidence | undefined;
  readonly now?: Date | undefined;
}

export type VerifyStatus = 'clean' | 'clean-with-unverifiable' | 'not-clean' | 'incomplete';

export interface CoverageEntry {
  service: string;
  operations: string[];
  status: CategoryStatus;
  errors: { operation: string; kind: string; code: string; message: string }[];
  denied: string[];
  evidence: string[];
  justification?: string;
}

export interface VerifyCore {
  readonly status: VerifyStatus;
  readonly statusReason: string;
  readonly findings: Finding[];
  readonly bootstrap: Finding[];
  readonly tagIndexOnly: {
    arn: string;
    service: string;
    covered: boolean;
    /** Tagged for THIS run, or of an unswept type: no clean verdict while it is listed. */
    blocking: boolean;
    note: string;
  }[];
  readonly coverage: CoverageEntry[];
  readonly deletionEvidence: CfnEvidence | null;
  readonly summary: {
    remaining: number;
    pendingDeletion: number;
    retainedByDesign: number;
    notOwned: number;
    bootstrapReported: number;
    remainingUsdPerHour: number;
    residualLikelyUsd: number;
    residualWorstUsd: number;
    pendingDeletionUntil: string | null;
    incomplete: boolean;
    /** Categories that could not be proven exhaustively, with their evidence. */
    unverifiable: { category: string; status: CategoryStatus; evidence: string[] }[];
  };
}

/** Services the tag index cross-check treats as swept (ARN service prefix). */
const COVERED_ARN_SERVICES = new Set([
  'cloudformation',
  'elasticloadbalancing',
  'ecs',
  'rds',
  'dynamodb',
  'lambda',
  'states',
  'cloudfront',
  's3',
  'ecr',
  'logs',
  'cloudwatch',
  'kms',
  'secretsmanager',
  'iam',
  'sns',
  'ssm',
  'events',
  // Scalable targets are deregistered with their ECS service.
  'application-autoscaling',
]);
/** EC2 resource types swept directly or gone with their (swept) VPC. */
const COVERED_EC2_TYPES = new Set([
  'vpc',
  'subnet',
  'internet-gateway',
  'natgateway',
  'elastic-ip',
  'network-interface',
  'security-group',
  'security-group-rule',
  'vpc-endpoint',
  'route-table',
  'network-acl',
  'vpc-flow-log',
]);
const ARN_SERVICE: Readonly<Record<string, string>> = {
  elbv2: 'elasticloadbalancing',
  stepfunctions: 'states',
};

const lastSegment = (s: string) => s.split(/[/:]/).filter(Boolean).pop() ?? s;

/** `service:last-segment` of an ARN (task definitions by family, log groups by full name). */
export function arnKey(arn: string): string {
  const parts = arn.split(':');
  const service = parts[2] ?? '';
  const resource = parts.slice(5).join(':').replace(/:\*$/, '');
  if (service === 'logs') return `logs:${resource.replace(/^log-group:/, '')}`;
  if (service === 'ecs' && resource.startsWith('task-definition/')) {
    return `ecs:${resource.slice('task-definition/'.length).replace(/:\d+$/, '')}`;
  }
  return `${service}:${lastSegment(resource)}`;
}

const findingKey = (f: RawFinding) =>
  `${ARN_SERVICE[f.service] ?? f.service}:${f.service === 'logs' ? f.id : lastSegment(f.id)}`;

/** Loads a baseline: a previous verify-clean report, `{ ids: [...] }`, or an array of strings. */
export function loadBaseline(file: string): Set<string> {
  const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
  const out = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v === 'string' && v.length > 0) out.add(maskString(v));
  };
  if (Array.isArray(raw)) raw.forEach(add);
  else if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    if (Array.isArray(o['ids'])) o['ids'].forEach(add);
    for (const key of ['findings', 'bootstrap']) {
      if (!Array.isArray(o[key])) continue;
      for (const f of o[key] as Record<string, unknown>[]) {
        add(f['id']);
        add(f['arn']);
      }
    }
  }
  return out;
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

export function classify(f: RawFinding): Finding['class'] {
  if (f.notOwned) return 'not-owned';
  if (f.disposition === 'pending-deletion') return 'pending-deletion';
  if (f.disposition === 'retained') return 'retained-by-design';
  return 'remaining';
}

function toFinding(f: RawFinding): Finding {
  const match = [...f.ownership.reasons];
  if (f.ownership.otherRunId) match.push(`other-run:${f.ownership.otherRunId}`);
  if (f.ownership.strength === 'weak') match.push('weak:name-only');
  const opt = <T>(k: string, v: T | undefined) => (v === undefined ? {} : { [k]: v });
  return {
    class: classify(f),
    scope: f.ownership.scope,
    service: f.service,
    resourceType: f.resourceType,
    id: maskString(f.id),
    ...opt('arn', f.arn ? maskString(f.arn) : undefined),
    ...opt('name', f.name ? maskString(f.name) : undefined),
    ...opt('state', f.state ? maskString(f.state) : undefined),
    ...opt('createdAt', f.createdAt),
    ...opt('deletionDate', f.deletionDate),
    match,
    ...opt('note', f.note ? maskString(f.note) : undefined),
    ...opt(
      'hourlyUsdIfLeft',
      f.hourlyUsdIfLeft === undefined ? undefined : round(f.hourlyUsdIfLeft),
    ),
    ...opt('residualLikelyUsd', f.residualLikelyUsd),
    ...opt('residualWorstUsd', f.residualWorstUsd),
  } as Finding;
}

export async function verifyClean(
  aws: ReadOnlyAws,
  book: PriceBook,
  options: VerifyOptions,
): Promise<VerifyCore> {
  const now = options.now ?? new Date();
  const baseline = options.baseline ?? new Set<string>();
  const match: MatchContext & {
    experimentVpcIds: Set<string>;
    taggedArns: Map<string, Record<string, string>>;
  } = {
    runId: options.runId,
    taggedArns: new Map(),
    experimentVpcIds: new Set(),
  };
  /** Masked physical ids of the run's own stack resources -> why they are known. */
  const knownIds = new Map<string, string>();
  for (const id of options.inventory?.physicalIds ?? []) knownIds.set(maskString(id), 'inventory');
  const env: SweepEnv = {
    aws,
    runId: options.runId,
    region: options.region,
    book,
    now,
    match,
    inventory: options.inventory,
    judge(c, meta) {
      const known =
        knownIds.get(maskString(meta.id)) ??
        (c.arn !== undefined ? knownIds.get(maskString(normalizeArn(c.arn))) : undefined);
      let o = ownership(c, match);
      if (known && o?.scope !== 'bootstrap' && (!o || o.strength === 'weak')) {
        o = { scope: 'experiment', strength: 'run', reasons: [known, ...(o?.reasons ?? [])] };
      }
      if (!o) return undefined;
      let notOwned = false;
      if (o.strength === 'weak') {
        const inBaseline =
          baseline.has(maskString(meta.id)) ||
          (c.arn !== undefined && baseline.has(maskString(normalizeArn(c.arn))));
        const before =
          options.since !== undefined &&
          meta.createdAt !== undefined &&
          Date.parse(meta.createdAt) < options.since.getTime();
        notOwned = inBaseline || before;
      }
      return { ownership: o, notOwned };
    },
  };

  const tagIndex = await sweepTagIndex(env);
  for (const [arn, tags] of tagIndex.arns) match.taggedArns.set(arn, tags);
  if (options.inventory) {
    env.cfn = await collectCloudFormationEvidence(aws, options.inventory);
    for (const x of env.cfn.resources) {
      if (x.physicalId && !knownIds.has(maskString(x.physicalId))) {
        knownIds.set(maskString(x.physicalId), 'deleted-stack resource');
      }
    }
  }
  const outcomes: SweepOutcome[] = [tagIndex];
  // Order matters: VPC ids first (dependent resources), RDS instances before their snapshots.
  for (const sweep of [
    sweepCloudFormation,
    sweepNetwork,
    sweepLoadBalancing,
    sweepEcs,
    sweepRds,
    sweepDynamoDb,
    sweepLambda,
    sweepStepFunctions,
    sweepCloudFront,
    sweepS3,
    sweepEcr,
    sweepCloudWatch,
    sweepKms,
    sweepSecrets,
    sweepIamSns,
    sweepSsm,
    sweepEvents,
  ]) {
    outcomes.push(await sweep(env));
  }
  outcomes.push(schedulerNotUsed());

  const raw = outcomes.flatMap((o) => o.findings);
  const live = raw.filter((f) => f.disposition !== 'gone');
  const all = live.map(toFinding);
  const counted = all.filter((f) => f.scope === 'experiment' || options.includeBootstrap);
  const bootstrap = options.includeBootstrap ? [] : all.filter((f) => f.scope === 'bootstrap');

  // Tag index cross-check: tagged ARNs that no service listing returned.
  const seenArns = new Set([
    ...raw.map((f) => f.arn).filter((a): a is string => a !== undefined),
    ...outcomes.flatMap((o) => o.accountedArns),
  ]);
  const seenKeys = new Set([...raw.map(findingKey), ...[...seenArns].map(arnKey)]);
  const ecsListed = outcomes.some(
    (o) =>
      o.service === 'ecs' &&
      o.errors.length === 0 &&
      o.operations.includes('ecs list-task-definition-families'),
  );
  const tagIndexOnly: VerifyCore['tagIndexOnly'] = [];
  for (const arn of tagIndex.arns.keys()) {
    if (seenArns.has(arn) || seenKeys.has(arnKey(arn))) continue;
    const service = arn.split(':')[2] ?? 'unknown';
    const ec2Type =
      service === 'ec2' ? (arn.split(':').slice(5).join(':').split('/')[0] ?? '') : '';
    const covered =
      service === 'ec2' ? COVERED_EC2_TYPES.has(ec2Type) : COVERED_ARN_SERVICES.has(service);
    const thisRun = tagIndex.arns.get(arn)?.[RUN_ID_TAG] === options.runId;
    // Deregistered (INACTIVE) task-definition revisions stay in the tag index; the ECS sweep lists
    // every family with an ACTIVE revision, so one it did not return has none (no charge).
    const inactiveRevision =
      service === 'ecs' &&
      arn.split(':').slice(5).join(':').startsWith('task-definition/') &&
      ecsListed;
    tagIndexOnly.push({
      arn: maskString(arn),
      service,
      covered,
      blocking: !covered || (thisRun && !inactiveRevision),
      note: inactiveRevision
        ? 'task-definition revision not ACTIVE (the ECS sweep lists every ACTIVE family): deregistered, no charge (warning only)'
        : !covered
          ? 'tagged resource of a type this tool does not sweep: verify it manually (no clean verdict until then)'
          : thisRun
            ? 'tagged for this run and listed by the tag index, but not by the service: re-run once the index has caught up with the deletion (no clean verdict until then)'
            : 'tagged for another experiment run, listed by the tag index but not by the service: the index lags deletions (warning only)',
    });
  }

  const coverage: CoverageEntry[] = outcomes.map((o) => ({
    service: o.service,
    operations: o.operations,
    // A failed call without a fallback outranks the category's own status.
    status: o.errors.length > 0 ? 'error' : (o.status ?? 'ok'),
    errors: o.errors.map((e) => ({ ...e, message: maskString(e.message) })),
    denied: o.denied,
    evidence: o.evidence.map(maskString),
    ...(o.justification ? { justification: o.justification } : {}),
  }));
  const unverifiable = coverage
    .filter((c) => c.status === 'fallback' || c.status === 'unverifiable-with-this-role')
    .map((c) => ({ category: c.service, status: c.status, evidence: c.evidence }));

  const by = (c: Finding['class']) => counted.filter((f) => f.class === c);
  const remaining = by('remaining');
  const pending = by('pending-deletion');
  const retained = by('retained-by-design');
  const notOwned = by('not-owned');
  const sumOf = (
    list: Finding[],
    k: 'hourlyUsdIfLeft' | 'residualLikelyUsd' | 'residualWorstUsd',
  ) => round(list.reduce((a, f) => a + (f[k] ?? 0), 0));
  const dates = pending
    .map((f) => f.deletionDate)
    .filter((d): d is string => d !== undefined)
    .sort();
  const uncovered = tagIndexOnly.filter((t) => t.blocking).length;
  const errors = coverage.reduce((a, c) => a + c.errors.length, 0);
  const incomplete = errors > 0 || uncovered > 0;

  let status: VerifyCore['status'];
  let statusReason: string;
  if (remaining.length > 0 || (options.strict && retained.length > 0)) {
    status = 'not-clean';
    statusReason = `${remaining.length} experiment resource(s) remain${options.strict && retained.length > 0 ? `, ${retained.length} retained-by-design (strict)` : ''}${incomplete ? '; the sweep is also incomplete' : ''}`;
  } else if (incomplete) {
    status = 'incomplete';
    statusReason = `cannot prove clean: ${errors} failed call(s), ${uncovered} tagged resource(s) listed only by the tag index (unswept type or tagged for this run)`;
  } else if (unverifiable.length > 0) {
    status = 'clean-with-unverifiable';
    statusReason = `no experiment resource found, but not provable with this role for: ${unverifiable.map((u) => `${u.category} (${u.status})`).join(', ')}${pending.length ? `; ${pending.length} pending deletion until ${dates[dates.length - 1] ?? 'unknown'}` : ''}`;
  } else {
    status = 'clean';
    statusReason = `no experiment resource remains${pending.length ? `; ${pending.length} pending deletion until ${dates[dates.length - 1] ?? 'unknown'}` : ''}${retained.length ? `; ${retained.length} retained-by-design flagged` : ''}`;
  }

  return {
    status,
    statusReason,
    findings: counted,
    bootstrap,
    tagIndexOnly,
    coverage,
    deletionEvidence: env.cfn ?? null,
    summary: {
      remaining: remaining.length,
      pendingDeletion: pending.length,
      retainedByDesign: retained.length,
      notOwned: notOwned.length,
      bootstrapReported: bootstrap.length,
      remainingUsdPerHour: sumOf(remaining, 'hourlyUsdIfLeft'),
      residualLikelyUsd: round(
        sumOf(pending, 'residualLikelyUsd') + sumOf(retained, 'residualLikelyUsd'),
      ),
      residualWorstUsd: round(
        sumOf(pending, 'residualWorstUsd') + sumOf(retained, 'residualWorstUsd'),
      ),
      pendingDeletionUntil: dates[dates.length - 1] ?? null,
      incomplete,
      unverifiable,
    },
  };
}
