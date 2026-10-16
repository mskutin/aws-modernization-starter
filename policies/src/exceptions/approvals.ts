/**
 * Approvals of governed exceptions and register entries that an MR cannot grant itself: an
 * exception added by an MR must not count as approved merely because it is in the MR.
 *
 * An approval is the SHA-256 of the entry's canonical JSON, recorded by an approver OUTSIDE the
 * repository — e.g. in the Maintainer-only gate project or a protected file variable that the
 * CI configuration wires in. `check-exceptions --approvals <file>` then fails on every entry whose exact
 * content has no approval, so adding an entry, or editing one (a new expiry, a wider resource),
 * needs a fresh approval. `starter-policies approval-digests` prints the digests to record.
 *
 * Without `--approvals` nothing is enforced: the Maintainer's merge is then the
 * approval (docs/policy-as-code.md). The mechanism is only as strong as the place the approvals file
 * comes from.
 */
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { entryDigest } from './digest.js';
import { isoDate, type ExceptionIssue } from './exceptions.js';

export { canonicalJson, entryDigest } from './digest.js';

export const approvalsFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    approvals: z
      .array(
        z
          .object({
            id: z.string().regex(/^(EXC|SUP)-\d{4}$/),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
            approvedBy: z.string().trim().min(3),
            approvedAt: isoDate,
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export type Approvals = z.infer<typeof approvalsFileSchema>['approvals'];

/** Raw entries (as written in YAML) of an exceptions or suppressions file, by id. */
export function rawEntries(
  file: string,
  listKey: 'exceptions' | 'suppressions',
): { id: string; raw: unknown }[] {
  const doc = parseYaml(readFileSync(file, 'utf8')) as Record<string, unknown> | null;
  const list = doc?.[listKey];
  if (!Array.isArray(list)) return [];
  return list.flatMap((raw: unknown) => {
    const id = (raw as { id?: unknown } | null)?.id;
    return typeof id === 'string' ? [{ id, raw }] : [];
  });
}

export function loadApprovals(file: string): Approvals {
  return approvalsFileSchema.parse(parseYaml(readFileSync(file, 'utf8'))).approvals;
}

/** UNAPPROVED_ENTRY for every entry whose exact content has no recorded approval. */
export function checkApprovals(
  entries: readonly { id: string; raw: unknown }[],
  approvals: Approvals,
): ExceptionIssue[] {
  return entries.flatMap(({ id, raw }) => {
    const digest = entryDigest(raw);
    if (approvals.some((a) => a.id === id && a.sha256 === digest)) return [];
    const stale = approvals.some((a) => a.id === id);
    return [
      {
        level: 'error' as const,
        code: 'UNAPPROVED_ENTRY' as const,
        exceptionId: id,
        message: `${id}: ${stale ? 'changed since it was approved' : 'has no approval'} (sha256 ${digest}); an approver records it outside the MR`,
      },
    ];
  });
}
