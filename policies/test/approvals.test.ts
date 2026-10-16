import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXIT, main } from '../src/cli/main.js';
import {
  canonicalJson,
  checkApprovals,
  entryDigest,
  rawEntries,
} from '../src/exceptions/approvals.js';
import { tempDir } from './helpers.js';

const TODAY = '2026-10-13';
const exception = {
  id: 'EXC-0100',
  ruleId: 'BASE-CF-002',
  resource: 'Staging/Edge/Distribution/Resource',
  environments: ['staging'],
  justification: 'Staging has no custom domain yet; synthetic test data only.',
  owner: 'platform-team',
  // A self-approval written into the MR itself.
  approver: 'platform-team',
  ticket: 'T-1',
  createdAt: '2026-10-01',
  expiresAt: '2026-12-31',
};

describe('approvals recorded outside the MR', () => {
  it('canonical JSON ignores key order; the digest changes with any field', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
    expect(entryDigest({ ...exception })).toBe(
      entryDigest(Object.fromEntries(Object.entries(exception).reverse())),
    );
    expect(entryDigest({ ...exception, expiresAt: '2027-03-31' })).not.toBe(entryDigest(exception));
  });

  it('an entry is approved only by a recorded digest of its exact content — not by `approver` in the MR', () => {
    const approval = {
      id: 'EXC-0100',
      sha256: entryDigest(exception),
      approvedBy: 'security-lead',
      approvedAt: TODAY,
    };
    expect(checkApprovals([{ id: 'EXC-0100', raw: exception }], [])).toEqual([
      expect.objectContaining({ code: 'UNAPPROVED_ENTRY', exceptionId: 'EXC-0100' }),
    ]);
    expect(checkApprovals([{ id: 'EXC-0100', raw: exception }], [approval])).toEqual([]);
    const extended = { ...exception, expiresAt: '2027-03-31' };
    const [issue] = checkApprovals([{ id: 'EXC-0100', raw: extended }], [approval]);
    expect(issue?.message).toContain('changed since it was approved');
  });

  describe('CLI', () => {
    let logs: string[] = [];
    beforeEach(() => {
      logs = [];
      vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.join(' ')));
      vi.spyOn(console, 'error').mockImplementation(
        (...a: unknown[]) => void logs.push(a.join(' ')),
      );
    });
    afterEach(() => vi.restoreAllMocks());

    it('check-exceptions --approvals fails on unapproved entries; approval-digests prints what to record', () => {
      const dir = tempDir();
      const exc = join(dir, 'exceptions.yaml');
      const sup = join(dir, 'suppressions.yaml');
      writeFileSync(exc, stringify({ schemaVersion: 1, exceptions: [exception] }));
      writeFileSync(sup, stringify({ schemaVersion: 1, suppressions: [] }));
      const approvals = join(dir, 'approvals.yaml');
      writeFileSync(approvals, stringify({ schemaVersion: 1, approvals: [] }));
      const args = [
        'check-exceptions',
        '--file',
        exc,
        '--suppressions',
        sup,
        '--today',
        TODAY,
        '--approvals',
        approvals,
      ];

      expect(main(args)).toBe(EXIT.FAILED);
      expect(logs.join('\n')).toContain('UNAPPROVED_ENTRY');

      logs = [];
      expect(main(['approval-digests', '--file', exc, '--suppressions', sup])).toBe(EXIT.OK);
      const [id, sha256] = (logs[0] ?? '').split(' ');
      expect(id).toBe('EXC-0100');
      expect(sha256).toBe(entryDigest(rawEntries(exc, 'exceptions')[0]?.raw));
      writeFileSync(
        approvals,
        stringify({
          schemaVersion: 1,
          approvals: [{ id, sha256, approvedBy: 'security-lead', approvedAt: TODAY }],
        }),
      );
      expect(main(args)).toBe(EXIT.OK);
    });
  });
});
