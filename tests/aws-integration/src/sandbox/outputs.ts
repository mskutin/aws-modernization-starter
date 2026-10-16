/**
 * Stack outputs of the sandbox stage and small JSON helpers for the shell scripts.
 *
 * `outputs.json` has the shape of a `cdk deploy --outputs-file` (`{ <stackName>: { <key>: value } }`)
 * but is always rebuilt from `aws cloudformation describe-stacks`, so it can be refreshed at any
 * time (also when the run directory was lost) and never depends on which stack was deployed last.
 * Output keys follow the sandbox stage's CfnOutput ids; a CfnOutput declared inside a construct gets an
 * 8-hex-digit hash suffix from CDK, which the lookup tolerates.
 */

export type StackOutputs = Record<string, Record<string, string>>;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** `describe-stacks --output json` → `{ stackName: { OutputKey: OutputValue } }`. */
export function outputsFromDescribeStacks(json: unknown): StackOutputs {
  const out: StackOutputs = {};
  const stacks = isRecord(json) && Array.isArray(json.Stacks) ? (json.Stacks as unknown[]) : [];
  for (const s of stacks) {
    if (!isRecord(s) || typeof s.StackName !== 'string') continue;
    const values: Record<string, string> = {};
    for (const o of Array.isArray(s.Outputs) ? (s.Outputs as unknown[]) : []) {
      if (isRecord(o) && typeof o.OutputKey === 'string' && typeof o.OutputValue === 'string') {
        values[o.OutputKey] = o.OutputValue;
      }
    }
    out[s.StackName] = values;
  }
  return out;
}

export function mergeOutputs(...parts: StackOutputs[]): StackOutputs {
  const out: StackOutputs = {};
  for (const p of parts)
    for (const [stack, values] of Object.entries(p)) out[stack] = { ...out[stack], ...values };
  return out;
}

export class OutputLookupError extends Error {
  override name = 'OutputLookupError';
}

/** Exact key, else the single key that is `<anything><key>` or `<key><8 hex>` (CDK-hashed id). */
export function findOutput(outputs: StackOutputs, stack: string, key: string): string {
  const values = outputs[stack];
  if (!values) throw new OutputLookupError(`no outputs for stack ${stack}`);
  const exact = values[key];
  if (exact !== undefined) return exact;
  const pattern = new RegExp(`(?:^|[A-Za-z0-9])${key}(?:[0-9A-F]{8})?$`);
  const matches = Object.keys(values).filter((k) => pattern.test(k));
  if (matches.length === 1) return values[matches[0] as string] as string;
  if (matches.length > 1) {
    throw new OutputLookupError(`ambiguous output ${key} in ${stack}: ${matches.join(', ')}`);
  }
  throw new OutputLookupError(
    `output ${key} not found in ${stack} (have: ${Object.keys(values).join(', ') || 'none'})`,
  );
}

/**
 * Value at a path: dot-separated segments, numbers index arrays (`length` is an array's size),
 * `[key]` for keys that contain dots (`tasks.0.containers.0.exitCode`, `options.awslogs-group`,
 * `Labels[org.opencontainers.image.revision]`). Returns undefined when any segment is missing.
 */
export function getPath(json: unknown, path: string): unknown {
  let cur: unknown = json;
  for (const m of path.matchAll(/\[([^\]]+)\]|([^.[\]]+)/g)) {
    const seg = (m[1] ?? m[2]) as string;
    if (Array.isArray(cur) && /^\d+$/.test(seg)) cur = cur[Number(seg)];
    else if (Array.isArray(cur) && seg === 'length') cur = cur.length;
    else if (isRecord(cur)) cur = cur[seg];
    else return undefined;
  }
  return cur;
}

/** Scalar → its string form; objects/arrays → JSON; undefined/null → undefined. */
export function scalarText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}
