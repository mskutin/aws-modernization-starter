/**
 * CloudFormation drift detection against REAL deployed stacks.
 *
 * Runs only when explicitly opted in AND AWS credentials resolve. Otherwise it
 * returns `{ status: 'not-configured', executed: false }` — it never infers
 * drift from offline artefacts. Offline checks (cdk-nag, Guard, FinOps
 * template diff) compare code with code; only this API call compares code
 * with what is actually deployed.
 */
import {
  type CloudFormationClient,
  DescribeStackDriftDetectionStatusCommand,
  DetectStackDriftCommand,
  paginateDescribeStackResourceDrifts,
  type StackResourceDrift,
} from '@aws-sdk/client-cloudformation';

export type DriftRunStatus = 'in-sync' | 'drifted' | 'not-configured' | 'error';

export interface PropertyDifference {
  path: string;
  expected: string | undefined;
  actual: string | undefined;
  type: string | undefined;
}

export interface ResourceDrift {
  logicalId: string;
  physicalId: string | undefined;
  type: string | undefined;
  driftStatus: string | undefined;
  differences: PropertyDifference[];
}

export interface StackDriftResult {
  stackName: string;
  detectionId?: string;
  detectionStatus?: string;
  stackDriftStatus?: string;
  driftedResourceCount?: number;
  resources: ResourceDrift[];
  error?: string;
}

export interface DriftReport {
  status: DriftRunStatus;
  executed: boolean;
  reason?: string;
  note: string;
  stage?: string;
  region?: string;
  checkedAt: string;
  stacks: StackDriftResult[];
}

export const OFFLINE_NOTE =
  'Drift is only detected by CloudFormation DetectStackDrift against deployed stacks. ' +
  'Offline checks (cdk-nag, Guard, FinOps template diff) do not and cannot detect drift.';

export interface DetectOptions {
  client: CloudFormationClient;
  stacks: readonly string[];
  /** Delay between DescribeStackDriftDetectionStatus polls. */
  pollIntervalMs?: number;
  /** Per-stack timeout for a detection to complete. */
  timeoutMs?: number;
  /** Injectable for tests (no real sleeping). */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const message = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

async function detectOne(
  stackName: string,
  o: Required<Omit<DetectOptions, 'stacks'>>,
): Promise<StackDriftResult> {
  const result: StackDriftResult = { stackName, resources: [] };
  try {
    const started = await o.client.send(new DetectStackDriftCommand({ StackName: stackName }));
    const id = started.StackDriftDetectionId;
    if (!id) throw new Error('DetectStackDrift returned no StackDriftDetectionId');
    result.detectionId = id;
    const deadline = o.now() + o.timeoutMs;
    for (;;) {
      const s = await o.client.send(
        new DescribeStackDriftDetectionStatusCommand({ StackDriftDetectionId: id }),
      );
      result.detectionStatus = s.DetectionStatus;
      result.stackDriftStatus = s.StackDriftStatus;
      result.driftedResourceCount = s.DriftedStackResourceCount;
      if (s.DetectionStatus !== 'DETECTION_IN_PROGRESS') {
        if (s.DetectionStatus === 'DETECTION_FAILED') {
          result.error = `Detection failed: ${s.DetectionStatusReason ?? 'no reason given'}`;
        }
        break;
      }
      if (o.now() >= deadline) {
        result.error = `Detection did not complete within ${o.timeoutMs} ms`;
        return result;
      }
      await o.sleep(o.pollIntervalMs);
    }
    if (result.stackDriftStatus === 'DRIFTED' || result.detectionStatus === 'DETECTION_FAILED') {
      const drifts: StackResourceDrift[] = [];
      for await (const page of paginateDescribeStackResourceDrifts(
        { client: o.client },
        { StackName: stackName, StackResourceDriftStatusFilters: ['MODIFIED', 'DELETED'] },
      )) {
        drifts.push(...(page.StackResourceDrifts ?? []));
      }
      result.resources = drifts.map((d) => ({
        logicalId: d.LogicalResourceId ?? '?',
        physicalId: d.PhysicalResourceId,
        type: d.ResourceType,
        driftStatus: d.StackResourceDriftStatus,
        differences: (d.PropertyDifferences ?? []).map((p) => ({
          path: p.PropertyPath ?? '',
          expected: p.ExpectedValue,
          actual: p.ActualValue,
          type: p.DifferenceType,
        })),
      }));
    }
  } catch (e) {
    result.error = message(e);
  }
  return result;
}

/** Detects drift for each stack sequentially (CloudFormation limits concurrent detections). */
export async function detectDrift(options: DetectOptions): Promise<StackDriftResult[]> {
  const o = {
    client: options.client,
    pollIntervalMs: options.pollIntervalMs ?? 5_000,
    timeoutMs: options.timeoutMs ?? 600_000,
    sleep: options.sleep ?? defaultSleep,
    now: options.now ?? Date.now,
  };
  const out: StackDriftResult[] = [];
  for (const stack of options.stacks) out.push(await detectOne(stack, o));
  return out;
}

export function summarizeStatus(stacks: StackDriftResult[]): DriftRunStatus {
  if (stacks.some((s) => s.error)) return 'error';
  if (stacks.some((s) => s.stackDriftStatus === 'DRIFTED')) return 'drifted';
  return 'in-sync';
}
