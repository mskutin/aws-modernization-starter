/**
 * inventory: the machine-readable experiment inventory of one run — its CloudFormation stacks
 * (status, creation time, tags), every stack resource (logical id, type, physical id, creation
 * timestamp from the stack events), the expected hourly cost per resource and in total, the
 * maximum permitted runtime from the stop rule, and the teardown owner and command.
 * Read-only: describe-stacks, list-stack-resources, describe-stack-events.
 */
import { RUN_ID_TAG, BOOTSTRAP_STACK } from './match.js';
import { resourceHourlyUsd, taskHour, type Estimate } from './model/estimate.js';
import { HOURS_PER_MONTH, type PriceBook } from './model/prices.js';
import { PHASE_STACK_PATTERNS, type Phase, type SynthStack } from './model/topology.js';
import type { ReadOnlyAws } from './aws/session.js';
import type { Inventory } from './schemas.js';
import { items, iso, str, tagMap, type InventoryEvidence } from './sweep/common.js';

/** Line items that are time-based but not tied to one stack resource (EMF metrics, storage). */
const NON_RESOURCE_FIXED = new Set(['SBX-14', 'SBX-15', 'SBX-16', 'SBX-17', 'SBX-18']);

export interface InventoryOptions {
  readonly runId: string;
  readonly phase: Phase;
  readonly book: PriceBook;
  readonly estimate: Estimate;
  readonly synthStacks?: readonly SynthStack[] | undefined;
  readonly teardownCommand?: string | undefined;
  readonly now?: Date | undefined;
}

export interface InventoryResource {
  logicalId: string;
  type: string;
  physicalId: string | null;
  status: string | null;
  createdAt: string | null;
  lastUpdatedAt: string | null;
  hourlyUsd: number;
  nestedStack?: string;
}

export interface InventoryStack {
  name: string;
  id: string | null;
  status: string | null;
  createdAt: string | null;
  lastUpdatedAt: string | null;
  terminationProtection: boolean;
  tags: Record<string, string>;
  resources: InventoryResource[];
  hourlyUsd: number;
}

export interface InventoryCore {
  status: 'ok' | 'incomplete' | 'no-stacks';
  statusReason: string;
  stacks: InventoryStack[];
  bootstrap: InventoryStack | null;
  otherRunStacks: { name: string; runId: string | null }[];
  cost: {
    disclaimer: string;
    estimateBasis: 'contract' | 'synth';
    priceBasis: string;
    resourcesUsdPerHour: number;
    otherUsdPerHour: number;
    totalUsdPerHour: number;
    oneTimeUsd: number;
    partialHourRoundingUsd: number;
    accountLevelUsd: number;
    startedAt: string | null;
    elapsedHours: number | null;
    estimatedSpendSoFarUsd: number | null;
  };
  runtime: {
    stopUsd: number;
    spentUsd: number;
    marginPercent: number;
    taxRatePercent: number;
    maxRuntimeHours: number;
    timeBoxHours: number;
    effectiveMaxRuntimeHours: number;
    bindingLimit: 'time-box' | 'stop-rule';
    teardownStartBy: string | null;
    allDeletedBy: string | null;
    expiresAtTag: string | null;
    basis: string;
  };
  teardown: { owner: string; command: string; verifyCommand: string; notes: string[] };
  errors: { operation: string; kind: string; code: string; message: string }[];
  notes: string[];
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;
const addHours = (isoDate: string, h: number) =>
  new Date(Date.parse(isoDate) + h * 3_600_000).toISOString();

export const TEARDOWN = {
  owner: 'operator — a human-approved operator session; automation never runs AWS calls on its own',
  1: () =>
    'AWS_INTEGRATION_ENABLED=true tests/aws-integration/scripts/cleanup.sh (Phase 1 mini-stack; guard on every mutation)',
  2: (runId: string) =>
    `SBX_RUN_ID=${runId} tests/aws-integration/sandbox/down.sh (works from CloudFormation names/tags when the run directory is gone; --all-runs for every experiment stack)`,
} as const;

/** What verify-clean needs after the stacks are gone: KMS keys, secrets and log groups by id. */
export interface ExperimentResources {
  kmsKeys: { stack: string; logicalId: string; keyId: string; arn: string | null }[];
  secrets: { stack: string; logicalId: string; arn: string }[];
  logGroups: { stack: string; logicalId: string; name: string }[];
}

/** From the run's stack resources (nested stacks included); `account` is the masked account. */
export function experimentResourcesOf(
  stacks: readonly InventoryStack[],
  region: string,
  account: string | null,
): ExperimentResources {
  const out: ExperimentResources = { kmsKeys: [], secrets: [], logGroups: [] };
  for (const s of stacks) {
    for (const r of s.resources) {
      if (!r.physicalId || r.status === 'DELETE_COMPLETE') continue;
      const stack = r.nestedStack ? `${s.name}/${r.nestedStack}` : s.name;
      if (r.type === 'AWS::KMS::Key') {
        const keyId = r.physicalId.split('/').pop() ?? r.physicalId;
        out.kmsKeys.push({
          stack,
          logicalId: r.logicalId,
          keyId,
          arn: account ? `arn:aws:kms:${region}:${account}:key/${keyId}` : null,
        });
      } else if (r.type === 'AWS::SecretsManager::Secret') {
        out.secrets.push({ stack, logicalId: r.logicalId, arn: r.physicalId });
      } else if (r.type === 'AWS::Logs::LogGroup') {
        out.logGroups.push({ stack, logicalId: r.logicalId, name: r.physicalId });
      }
    }
  }
  return out;
}

/** Per-resource hourly-cost context from the synthesized template of the stack, if any. */
function contextFor(
  type: string,
  logicalId: string,
  template: SynthStack['template'] | undefined,
  options: InventoryOptions,
) {
  const topo = options.estimate.topology;
  const res = template?.Resources?.[logicalId];
  const p = res?.Properties ?? {};
  switch (type) {
    case 'AWS::ElasticLoadBalancingV2::LoadBalancer': {
      if (res) {
        const internet = (p['Scheme'] ?? 'internet-facing') === 'internet-facing';
        const subnets = p['Subnets'] ?? p['SubnetMappings'];
        return {
          albPublicIpv4PerAlb: internet ? (Array.isArray(subnets) ? subnets.length : 2) : 0,
        };
      }
      return { albPublicIpv4PerAlb: topo.albs > 0 ? topo.albPublicIpv4 / topo.albs : 2 };
    }
    case 'AWS::RDS::DBInstance': {
      if (res) {
        return {
          rdsClass: String(p['DBInstanceClass'] ?? 'db.t4g.micro'),
          rdsMultiAz: p['MultiAZ'] === true,
          rdsStorageGiB: Number(p['AllocatedStorage'] ?? 20),
          rdsStorageType: String(p['StorageType'] ?? 'gp2'),
        };
      }
      const db = topo.rds[0];
      return db
        ? {
            rdsClass: db.instanceClass,
            rdsMultiAz: db.multiAz,
            rdsStorageGiB: db.storageGiB,
            rdsStorageType: db.storageType,
          }
        : {};
    }
    case 'AWS::ECS::Service': {
      if (res) {
        const tdRef = (p['TaskDefinition'] as { Ref?: string } | undefined)?.Ref;
        const td = tdRef ? template?.Resources?.[tdRef]?.Properties : undefined;
        const arch =
          (td?.['RuntimePlatform'] as { CpuArchitecture?: string } | undefined)?.CpuArchitecture ===
          'ARM64'
            ? 'arm64'
            : 'x86_64';
        const rate = taskHour(
          options.book,
          Number(td?.['Cpu'] ?? 256) / 1024,
          Number(td?.['Memory'] ?? 512) / 1024,
          arch,
        );
        return { serviceTaskHourUsd: Number(p['DesiredCount'] ?? 1) * rate };
      }
      const svc = topo.fargateServices[0];
      return svc
        ? {
            serviceTaskHourUsd:
              svc.desiredCount * taskHour(options.book, svc.vcpu, svc.memoryGb, svc.arch),
          }
        : {};
    }
    case 'AWS::ECS::Cluster': {
      const settings = (res ? (p['ClusterSettings'] ?? []) : []) as {
        Name?: string;
        Value?: string;
      }[];
      const ci = res
        ? settings.find((s) => s.Name === 'containerInsights')?.Value
        : topo.containerInsights;
      const metrics = options.estimate.assumptions.find((a) => a.id === 'L2-L03')?.value ?? 137;
      return { containerInsightsMetrics: ci === 'enhanced' || ci === 'enabled' ? metrics : 0 };
    }
    default:
      return {};
  }
}

export async function buildInventory(
  aws: ReadOnlyAws,
  options: InventoryOptions,
): Promise<InventoryCore> {
  const now = options.now ?? new Date();
  const errors: InventoryCore['errors'] = [];
  const notes: string[] = [];
  const get = async (service: string, operation: string, args: string[] = []) => {
    const r = await aws.call(service, operation, args);
    if (r.ok) return r.data;
    errors.push({ operation: `${service} ${operation}`, ...r.error });
    return undefined;
  };

  const all = items(await get('cloudformation', 'describe-stacks'), 'Stacks');
  const patterns = PHASE_STACK_PATTERNS[options.phase];
  const selected: Record<string, unknown>[] = [];
  const otherRunStacks: InventoryCore['otherRunStacks'] = [];
  let bootstrapRaw: Record<string, unknown> | undefined;
  for (const s of all) {
    const name = str(s['StackName']);
    if (!name) continue;
    if (name === BOOTSTRAP_STACK) {
      bootstrapRaw = s;
      continue;
    }
    if (str(s['ParentId'])) continue; // nested stacks are listed under their parent
    if (!patterns.some((p) => p.test(name))) continue;
    const runTag = tagMap(s['Tags'])[RUN_ID_TAG];
    if (runTag === options.runId) selected.push(s);
    else if (
      runTag === undefined &&
      (options.phase === 2 || name === `starter-it-${options.runId}`)
    ) {
      selected.push(s);
      notes.push(`${name} carries no ${RUN_ID_TAG} stack tag; included by name`);
    } else otherRunStacks.push({ name, runId: runTag ?? null });
  }

  const synthByName = new Map((options.synthStacks ?? []).map((s) => [s.stackName, s]));
  const describeStack = async (s: Record<string, unknown>): Promise<InventoryStack> => {
    const name = str(s['StackName']) ?? 'unknown';
    const id = str(s['StackId']) ?? null;
    const resources: InventoryResource[] = [];
    const collect = async (
      stackRef: string,
      template: SynthStack['template'] | undefined,
      nested?: string,
    ) => {
      const created = new Map<string, string>();
      const events = items(
        await get('cloudformation', 'describe-stack-events', ['--stack-name', stackRef]),
        'StackEvents',
      );
      // Events are newest first: the last CREATE_IN_PROGRESS seen is the earliest.
      for (const e of events) {
        const lid = str(e['LogicalResourceId']);
        const ts = iso(e['Timestamp']);
        if (lid && ts && str(e['ResourceStatus']) === 'CREATE_IN_PROGRESS') created.set(lid, ts);
      }
      const summaries = items(
        await get('cloudformation', 'list-stack-resources', ['--stack-name', stackRef]),
        'StackResourceSummaries',
      );
      for (const r of summaries) {
        const logicalId = str(r['LogicalResourceId']) ?? 'unknown';
        const type = str(r['ResourceType']) ?? 'unknown';
        const physicalId = str(r['PhysicalResourceId']) ?? null;
        const status = str(r['ResourceStatus']) ?? null;
        const gone = status === 'DELETE_COMPLETE';
        const hourly = gone
          ? 0
          : resourceHourlyUsd(type, options.book, contextFor(type, logicalId, template, options));
        resources.push({
          logicalId,
          type,
          physicalId,
          status,
          createdAt: created.get(logicalId) ?? null,
          lastUpdatedAt: iso(r['LastUpdatedTimestamp']) ?? null,
          hourlyUsd: round(hourly),
          ...(nested ? { nestedStack: nested } : {}),
        });
        if (type === 'AWS::CloudFormation::Stack' && physicalId && !nested) {
          await collect(physicalId, undefined, physicalId.split('/')[1] ?? physicalId);
        }
      }
    };
    await collect(id ?? name, synthByName.get(name)?.template);
    return {
      name,
      id,
      status: str(s['StackStatus']) ?? null,
      createdAt: iso(s['CreationTime']) ?? null,
      lastUpdatedAt: iso(s['LastUpdatedTime']) ?? null,
      terminationProtection: s['EnableTerminationProtection'] === true,
      tags: tagMap(s['Tags']),
      resources,
      hourlyUsd: round(resources.reduce((a, r) => a + r.hourlyUsd, 0)),
    };
  };

  const stacks: InventoryStack[] = [];
  for (const s of selected) stacks.push(await describeStack(s));
  const bootstrap = bootstrapRaw ? await describeStack(bootstrapRaw) : null;

  const est = options.estimate;
  const resourcesUsdPerHour = round(stacks.reduce((a, s) => a + s.hourlyUsd, 0));
  const otherUsdPerHour = round(
    est.totals.perHourUsageUsd +
      est.lineItems
        .filter((i) => NON_RESOURCE_FIXED.has(i.id))
        .reduce((a, i) => a + i.usdPerHour, 0),
  );
  const totalUsdPerHour = round(resourcesUsdPerHour + otherUsdPerHour);
  const created = stacks
    .map((s) => s.createdAt)
    .filter((c): c is string => c !== null)
    .sort();
  const startedAt = created[0] ?? null;
  const elapsedHours = startedAt
    ? round((now.getTime() - Date.parse(startedAt)) / 3_600_000)
    : null;
  const sr = est.stopRule;
  const effective = sr.effectiveMaxRuntimeHours;
  const expiresAtTag =
    stacks.map((s) => s.tags['starter:expires-at']).find((t) => t !== undefined) ?? null;

  if (bootstrap) {
    notes.push(
      `bootstrap stack ${BOOTSTRAP_STACK} is ${bootstrap.status}; it is not part of the run teardown`,
    );
  }
  if (otherRunStacks.length > 0) {
    notes.push(
      `${otherRunStacks.length} stack(s) of another run match the phase names: they are not in this inventory`,
    );
  }
  const fixedMonthly = round(resourcesUsdPerHour * HOURS_PER_MONTH);
  notes.push(
    `Left running for a month, the time-based resources alone would cost about ${fixedMonthly} USD (list prices).`,
  );

  return {
    status: stacks.length === 0 ? 'no-stacks' : errors.length > 0 ? 'incomplete' : 'ok',
    statusReason:
      stacks.length === 0
        ? `no ${options.phase === 1 ? 'starter-it-*' : 'Sandbox-* / starter-sbx-*'} stack of run ${options.runId}`
        : errors.length > 0
          ? `${errors.length} AWS call(s) failed; the inventory may be incomplete`
          : `${stacks.length} stack(s), ${stacks.reduce((a, s) => a + s.resources.length, 0)} resource(s)`,
    stacks,
    bootstrap,
    otherRunStacks,
    cost: {
      disclaimer: est.disclaimer,
      estimateBasis: est.topology.basis.kind,
      priceBasis: `finops snapshot ${est.priceBasis.snapshot} (captured ${est.priceBasis.snapshotCapturedAt}) + supplement ${est.priceBasis.supplement} (captured ${est.priceBasis.supplementCapturedAt}); not live pricing`,
      resourcesUsdPerHour,
      otherUsdPerHour,
      totalUsdPerHour,
      oneTimeUsd: est.totals.oneTimeUsd,
      partialHourRoundingUsd: est.totals.partialHourRoundingUsd,
      accountLevelUsd: est.accountLevel.usedUsd,
      startedAt,
      elapsedHours,
      estimatedSpendSoFarUsd:
        elapsedHours === null
          ? null
          : round(
              est.totals.oneTimeUsd +
                est.totals.partialHourRoundingUsd +
                totalUsdPerHour * Math.max(0, elapsedHours),
            ),
    },
    runtime: {
      stopUsd: sr.stopUsd,
      spentUsd: sr.spentUsd,
      marginPercent: sr.marginPercent,
      taxRatePercent: sr.taxRatePercent,
      maxRuntimeHours: sr.maxRuntimeHours,
      timeBoxHours: sr.timeBoxHours,
      effectiveMaxRuntimeHours: effective,
      bindingLimit: sr.bindingLimit,
      teardownStartBy: startedAt
        ? addHours(startedAt, Math.max(0, effective - sr.teardownHours))
        : null,
      allDeletedBy: startedAt ? addHours(startedAt, effective) : null,
      expiresAtTag,
      basis: `${sr.formula}; time box ${sr.timeBoxBasis}`,
    },
    teardown: {
      owner: TEARDOWN.owner,
      command: options.teardownCommand ?? TEARDOWN[options.phase](options.runId),
      verifyCommand: `node tools/aws-sandbox/dist/bin.js verify-clean --run-id ${options.runId} --inventory "\${SANDBOX_HOME:-$HOME/.config/starter-aws-sandbox}/runs/${options.runId}/inventory.json" --out "\${SANDBOX_HOME:-$HOME/.config/starter-aws-sandbox}/runs/${options.runId}/verify-clean.json"`,
      notes: [
        'Start the teardown no later than runtime.teardownStartBy; everything must be deleted by runtime.allDeletedBy.',
        'Teardown is complete only when verify-clean reports status "clean" (pending-deletion items listed with their dates).',
        stacks.some((s) => s.resources.some((r) => r.type === 'AWS::KMS::Key'))
          ? 'KMS keys go to PendingDeletion (7-day window): never cancel the deletion to keep backups restorable.'
          : 'No KMS key in the stacks.',
      ],
    },
    errors,
    notes,
  };
}

/** Reads a committed / run-directory inventory as verify-clean evidence (masked ids as written). */
export function inventoryEvidence(inventory: Inventory, file: string): InventoryEvidence {
  const resources = experimentResourcesOf(inventory.stacks, inventory.region, inventory.account);
  return {
    file,
    runId: inventory.runId,
    startedAt: inventory.cost.startedAt,
    stacks: inventory.stacks.map((s) => ({ name: s.name, id: s.id })),
    kmsKeys: resources.kmsKeys,
    secrets: resources.secrets,
    logGroups: resources.logGroups,
    physicalIds: inventory.stacks.flatMap((s) =>
      s.resources.map((r) => r.physicalId).filter((p): p is string => p !== null),
    ),
  };
}
