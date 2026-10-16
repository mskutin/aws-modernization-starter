/**
 * Rollback test helpers (rollback.sh), pure functions over AWS CLI JSON:
 *
 *  - deriveUnhealthyImage  edits an OCI image layout (skopeo `oci:` copy of the healthy image) so
 *                          the image's CMD exits 1 — `FROM <api>@sha256:…` with a failing CMD,
 *                          built without a container engine. Layers are untouched (ECR already
 *                          has them); only the config and manifest blobs are new.
 *  - cloneTaskDefinition   `describe-task-definition` → `register-task-definition` input with a
 *                          different image, read-only fields removed.
 *  - observeRollout        one `describe-services` snapshot → the phase of the experiment, with
 *                          the first time each milestone was seen (state carried between polls).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export const UNHEALTHY_CMD = [
  '-e',
  "console.error('starter-sbx: deliberately unhealthy revision (rollback test)');process.exit(1)",
];

const REF_NAME = 'org.opencontainers.image.ref.name';

interface Descriptor {
  mediaType: string;
  digest: string;
  size: number;
  annotations?: Record<string, string>;
  [k: string]: unknown;
}

function blobPath(layout: string, digest: string): string {
  const [alg, hex] = digest.split(':');
  if (alg !== 'sha256' || !hex || !/^[a-f0-9]{64}$/.test(hex))
    throw new Error(`unsupported digest ${digest}`);
  return join(layout, 'blobs', 'sha256', hex);
}

function writeBlob(layout: string, bytes: Buffer): { digest: string; size: number } {
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  mkdirSync(join(layout, 'blobs', 'sha256'), { recursive: true });
  writeFileSync(blobPath(layout, digest), bytes);
  return { digest, size: bytes.length };
}

/**
 * Adds `toTag` to the OCI layout: the image `fromTag` with CMD = UNHEALTHY_CMD and labels saying
 * so. Returns the new manifest digest (= the image digest a registry will report).
 */
export function deriveUnhealthyImage(
  layout: string,
  fromTag: string,
  toTag: string,
  now = new Date(),
): string {
  const indexFile = join(layout, 'index.json');
  const index = JSON.parse(readFileSync(indexFile, 'utf8')) as {
    manifests?: Descriptor[];
  } & Record<string, unknown>;
  const manifests = index.manifests ?? [];
  const source = manifests.find((m) => m.annotations?.[REF_NAME] === fromTag);
  if (!source) throw new Error(`tag ${fromTag} not found in ${indexFile}`);
  if (!/manifest\.v1\+json$|manifest\.v2\+json$/.test(source.mediaType)) {
    throw new Error(`${fromTag} is ${source.mediaType}, expected a single-platform image manifest`);
  }
  const manifest = JSON.parse(readFileSync(blobPath(layout, source.digest), 'utf8')) as {
    config: Descriptor;
  } & Record<string, unknown>;
  const config = JSON.parse(
    readFileSync(blobPath(layout, manifest.config.digest), 'utf8'),
  ) as Record<string, unknown>;
  const inner = isRecord(config.config) ? { ...config.config } : {};
  inner.Cmd = UNHEALTHY_CMD;
  inner.Labels = {
    ...(isRecord(inner.Labels) ? inner.Labels : {}),
    'org.opencontainers.image.description':
      'DELIBERATELY UNHEALTHY: CMD exits 1 (starter sandbox rollback test)',
    'starter.sandbox.unhealthy': 'true',
  };
  const history = Array.isArray(config.history) ? [...(config.history as unknown[])] : [];
  history.push({
    created: now.toISOString(),
    created_by: 'starter-sbx rollback test: CMD replaced by a command that exits 1',
    empty_layer: true,
  });
  const newConfig = writeBlob(
    layout,
    Buffer.from(JSON.stringify({ ...config, config: inner, history })),
  );
  const newManifest = writeBlob(
    layout,
    Buffer.from(
      JSON.stringify({
        ...manifest,
        config: { ...manifest.config, digest: newConfig.digest, size: newConfig.size },
      }),
    ),
  );
  const entry: Descriptor = {
    ...source,
    digest: newManifest.digest,
    size: newManifest.size,
    annotations: { ...source.annotations, [REF_NAME]: toTag },
  };
  index.manifests = [...manifests.filter((m) => m.annotations?.[REF_NAME] !== toTag), entry];
  writeFileSync(indexFile, JSON.stringify(index));
  return newManifest.digest;
}

const READ_ONLY_TASKDEF_FIELDS = [
  'taskDefinitionArn',
  'revision',
  'status',
  'requiresAttributes',
  'compatibilities',
  'registeredAt',
  'registeredBy',
  'deregisteredAt',
];

/** `describe-task-definition --include TAGS` output → `register-task-definition` input. */
export function cloneTaskDefinition(
  described: unknown,
  image: string,
  container?: string,
  extraTags: Record<string, string> = {},
): Record<string, unknown> {
  if (!isRecord(described) || !isRecord(described.taskDefinition)) {
    throw new Error('not a describe-task-definition result');
  }
  const td: Record<string, unknown> = { ...described.taskDefinition };
  for (const f of READ_ONLY_TASKDEF_FIELDS) delete td[f];
  const containers = Array.isArray(td.containerDefinitions)
    ? (td.containerDefinitions as unknown[]).filter(isRecord)
    : [];
  const idx = container ? containers.findIndex((c) => c.name === container) : 0;
  if (idx < 0 || !containers[idx])
    throw new Error(`container ${container ?? '#0'} not in the task definition`);
  td.containerDefinitions = containers.map((c, i) => (i === idx ? { ...c, image } : c));
  const tags = (Array.isArray(described.tags) ? (described.tags as unknown[]) : [])
    .filter(isRecord)
    .filter((t) => typeof t.key === 'string' && !t.key.startsWith('aws:') && !(t.key in extraTags));
  const all = [...tags, ...Object.entries(extraTags).map(([key, value]) => ({ key, value }))];
  if (all.length > 0) td.tags = all;
  return td;
}

export type RolloutPhase =
  'waiting' | 'target-deploying' | 'target-failed' | 'rolled-back' | 'target-serving';

export interface RolloutState {
  baseline: string;
  target: string;
  phase: RolloutPhase;
  /** First observation (ISO) of each milestone. */
  seen: Partial<
    Record<
      'targetDeployment' | 'targetFailed' | 'rollbackDeployment' | 'rolledBack' | 'targetServing',
      string
    >
  >;
  targetRolloutStateReason?: string;
  targetFailedTasks?: number;
  snapshots: number;
}

export function initialRolloutState(baseline: string, target: string): RolloutState {
  return { baseline, target, phase: 'waiting', seen: {}, snapshots: 0 };
}

interface Deployment {
  id?: string;
  status?: string;
  taskDefinition?: string;
  rolloutState?: string;
  rolloutStateReason?: string;
  failedTasks?: number;
  runningCount?: number;
  desiredCount?: number;
}

/**
 * Advances the state with one `describe-services` snapshot. `rolled-back` requires that the
 * target deployment was seen and either FAILED or vanished while the service returned to the
 * baseline, with one COMPLETED PRIMARY deployment of the baseline at full count.
 */
export function observeRollout(prev: RolloutState, snapshot: unknown, at: Date): RolloutState {
  const s: RolloutState = { ...prev, seen: { ...prev.seen }, snapshots: prev.snapshots + 1 };
  const svc =
    isRecord(snapshot) && Array.isArray(snapshot.services)
      ? (snapshot.services as unknown[])[0]
      : undefined;
  if (!isRecord(svc)) return s;
  const deployments = (Array.isArray(svc.deployments) ? (svc.deployments as unknown[]) : []).filter(
    isRecord,
  ) as Deployment[];
  const when = at.toISOString();
  const mark = (k: keyof RolloutState['seen']) => {
    s.seen[k] ??= when;
  };
  const target = deployments.find((d) => d.taskDefinition === s.target);
  if (target) {
    mark('targetDeployment');
    if (target.rolloutStateReason) s.targetRolloutStateReason = target.rolloutStateReason;
    if (typeof target.failedTasks === 'number') s.targetFailedTasks = target.failedTasks;
    if (target.rolloutState === 'FAILED') mark('targetFailed');
    if (target.status === 'PRIMARY' && target.rolloutState === 'COMPLETED') mark('targetServing');
  }
  const primary = deployments.find((d) => d.status === 'PRIMARY');
  if (s.seen.targetDeployment && primary?.taskDefinition === s.baseline) mark('rollbackDeployment');
  const settled =
    deployments.length === 1 &&
    primary?.taskDefinition === s.baseline &&
    primary.rolloutState === 'COMPLETED' &&
    svc.taskDefinition === s.baseline &&
    typeof svc.desiredCount === 'number' &&
    svc.runningCount === svc.desiredCount;
  if (s.seen.targetServing) s.phase = 'target-serving';
  else if (s.seen.targetDeployment && settled) {
    mark('rolledBack');
    s.phase = 'rolled-back';
  } else if (s.seen.targetFailed) s.phase = 'target-failed';
  else if (s.seen.targetDeployment) s.phase = 'target-deploying';
  return s;
}

/** Service events since `since` (oldest first), for the evidence. */
export function serviceEventsSince(
  snapshot: unknown,
  since: Date,
): { createdAt: string; message: string }[] {
  const svc =
    isRecord(snapshot) && Array.isArray(snapshot.services)
      ? (snapshot.services as unknown[])[0]
      : undefined;
  const events =
    isRecord(svc) && Array.isArray(svc.events) ? (svc.events as unknown[]).filter(isRecord) : [];
  return events
    .map((e) => ({ createdAt: String(e.createdAt ?? ''), message: String(e.message ?? '') }))
    .filter((e) => {
      const t = Date.parse(e.createdAt) || Number(e.createdAt) * 1000;
      return Number.isFinite(t) && t >= since.getTime();
    })
    .reverse();
}
