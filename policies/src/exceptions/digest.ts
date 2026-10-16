/**
 * Content digests of register entries: the SHA-256 of an entry's canonical JSON (keys sorted at
 * every level, so YAML formatting does not matter). Used for approvals recorded outside the MR
 * (`approvals.ts`) and for the pinned reference-design entries (`reference-pins.ts`).
 */
import { createHash } from 'node:crypto';

/** JSON with object keys sorted at every level (stable across YAML formatting). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export const entryDigest = (entry: unknown): string =>
  createHash('sha256').update(canonicalJson(entry)).digest('hex');
