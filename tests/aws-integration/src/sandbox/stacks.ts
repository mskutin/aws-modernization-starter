/**
 * The sandbox stage's CloudFormation stacks and how down.sh finds them when
 * the run directory is gone: by NAME (`Sandbox-<Stack>`) and TAGS (`starter:experiment=live-validation`,
 * `starter:run-id=sbx-…`). A `Sandbox-*` stack that carries neither tag is not ours and is never
 * returned; a stack of another run is returned only when no run id filter is given.
 */

/** Deploy order (dependencies first). Teardown is the reverse. */
export const SANDBOX_STACKS = [
  'Foundation',
  'TestIssuer',
  'Platform',
  'Data',
  'Workflow',
  'Migrations',
  'Api',
  'Frontend',
  'Observability',
] as const;
export type SandboxStack = (typeof SANDBOX_STACKS)[number];

export const STACK_PREFIX = 'Sandbox-';
export const EXPERIMENT_TAG = 'starter:experiment';
export const EXPERIMENT = 'live-validation';
export const RUN_ID_TAG = 'starter:run-id';
export const SANDBOX_RUN_ID = /^sbx-[0-9a-f]{6}$/;

export interface FoundStack {
  stackName: string;
  stack: SandboxStack | null;
  status: string;
  runId: string | null;
  terminationProtection: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function tag(tags: unknown, key: string): string | null {
  for (const t of Array.isArray(tags) ? (tags as unknown[]) : []) {
    if (isRecord(t) && t.Key === key && typeof t.Value === 'string') return t.Value;
  }
  return null;
}

const order = (s: SandboxStack | null) => (s === null ? -1 : SANDBOX_STACKS.indexOf(s));

/** Experiment stacks from `describe-stacks --output json`, in TEARDOWN order (reverse deploy). */
export function experimentStacks(json: unknown, runId?: string): FoundStack[] {
  const stacks = isRecord(json) && Array.isArray(json.Stacks) ? (json.Stacks as unknown[]) : [];
  const out: FoundStack[] = [];
  for (const s of stacks) {
    if (!isRecord(s) || typeof s.StackName !== 'string' || !s.StackName.startsWith(STACK_PREFIX))
      continue;
    if (s.StackStatus === 'DELETE_COMPLETE') continue;
    const experiment = tag(s.Tags, EXPERIMENT_TAG);
    const stackRun = tag(s.Tags, RUN_ID_TAG);
    const ours = experiment === EXPERIMENT || (stackRun !== null && SANDBOX_RUN_ID.test(stackRun));
    if (!ours) continue;
    if (runId !== undefined && stackRun !== null && stackRun !== runId) continue;
    const name = s.StackName.slice(STACK_PREFIX.length);
    out.push({
      stackName: s.StackName,
      stack: (SANDBOX_STACKS as readonly string[]).includes(name) ? (name as SandboxStack) : null,
      status: String(s.StackStatus ?? '?'),
      runId: stackRun,
      terminationProtection: s.EnableTerminationProtection === true,
    });
  }
  // Unknown Sandbox-* experiment stacks first (they may depend on anything), then reverse order.
  return out.sort((a, b) => order(b.stack) - order(a.stack));
}

/** Run ids of deployed experiment stacks other than `runId` (up.sh refuses to mix runs). */
export function otherRuns(json: unknown, runId: string): string[] {
  const ids = new Set<string>();
  for (const s of experimentStacks(json)) if (s.runId && s.runId !== runId) ids.add(s.runId);
  return [...ids].sort();
}
