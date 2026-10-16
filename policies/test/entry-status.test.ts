/**
 * The three kinds of register entry:
 * - `status: reference` — the starter's own reference code: undated, never expires, applies with no
 *   approval at any date, exact scope, never the sandbox — and only when PINNED with exactly its
 *   content in policies/src/exceptions/reference-pins.ts;
 * - no status — a project's own deviation: dated, expiring, approvable (unchanged model);
 * - `status: example` — the unloaded sandbox example: never applies, an error wherever loaded.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { App, CfnResource, Stack, Stage } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { parse, stringify } from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acknowledgeExceptions, stageEnvironment } from '../src/cdk/apply.js';
import { applyBaselinePolicies } from '../src/cdk/apply.js';
import { SuppressionAuditPlugin, resolveSuppression } from '../src/cdk/suppressions.js';
import { EXIT, main } from '../src/cli/main.js';
import { entryDigest } from '../src/exceptions/approvals.js';
import { auditSuppressions, type AuditTemplate } from '../src/exceptions/audit.js';
import { checkExceptions, exceptionReason } from '../src/exceptions/exceptions.js';
import { REFERENCE_ENTRY_DIGESTS } from '../src/exceptions/reference-pins.js';
import { checkSuppressions, suppressionReason } from '../src/exceptions/suppressions.js';
import { DEFAULT_EXCEPTIONS_PATH, DEFAULT_SUPPRESSIONS_PATH } from '../src/guard/layout.js';
import { tempDir } from './helpers.js';

const TODAY = '2026-10-13';
const DATES = [TODAY, '2027-04-12', '2031-01-01'];

/** Shipped, pinned reference entries, exactly as written in the registers. */
const shipped = (file: string, key: string, id: string): Record<string, unknown> => {
  const list = (parse(readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>[]>)[
    key
  ];
  const entry = list?.find((e) => e['id'] === id);
  if (!entry) throw new Error(`${id} not shipped`);
  return entry;
};
const EXC5 = shipped(DEFAULT_EXCEPTIONS_PATH, 'exceptions', 'EXC-0005');
const SUP1 = shipped(DEFAULT_SUPPRESSIONS_PATH, 'suppressions', 'SUP-0001');

/** Fixture reference entries: valid shape, but NOT pinned (they must never apply). */
const referenceException = {
  id: 'EXC-0100',
  status: 'reference',
  ruleId: 'BASE-CF-002',
  resource: '*/Edge/Topic/Resource',
  environments: ['dev', 'staging', 'prod'],
  justification: 'Fixture: the reference design serves this edge without a custom domain.',
  owner: 'platform-team',
  ticket: 'reference-design',
};
const referenceSuppression = {
  id: 'SUP-0100',
  status: 'reference',
  ruleId: 'AwsSolutions-SNS3',
  construct: 'Topics',
  resources: ['A/Resource'],
  environments: ['dev', 'staging', 'prod'],
  justification: 'Test fixture: the topic only receives messages from in-account AWS services.',
  owner: 'security-team',
};
const exampleSuppression = {
  ...referenceSuppression,
  id: 'SUP-0400',
  status: 'example',
  environments: ['sandbox'],
};
const exceptions = (today: string, ...entries: object[]) =>
  checkExceptions({ schemaVersion: 1, exceptions: entries }, { today });
const suppressions = (today: string, ...entries: object[]) =>
  checkSuppressions({ schemaVersion: 1, suppressions: entries }, { today });
const codes = (r: { issues: { code: string; level: string }[] }) =>
  r.issues.map((i) => `${i.level} ${i.code}`);
/** A reference entry turned into a project entry: no status, the project's dates. */
const dated = (e: Record<string, unknown>, extra: object) => {
  const { status: _s, ...rest } = e;
  return { ...rest, ...extra };
};

describe('reference-design entries: schema', () => {
  it.each(DATES)('pinned ones apply on %s with no dates, no approver and no issue', (today) => {
    const e = exceptions(today, EXC5);
    expect([e.ok, e.issues, e.active.map((x) => x.id)]).toEqual([true, [], ['EXC-0005']]);
    const s = suppressions(today, SUP1);
    expect([s.ok, s.issues, s.active.map((x) => x.id)]).toEqual([true, [], ['SUP-0001']]);
  });

  it('reject dates and an approver: a reference entry is never "approved" or dated', () => {
    for (const extra of [
      { createdAt: TODAY },
      { expiresAt: '2026-12-31' },
      { approver: 'security-lead' },
    ]) {
      const r = exceptions(TODAY, { ...referenceException, ...extra });
      expect(codes(r)).toEqual(['error MALFORMED']);
      expect(r.issues[0]?.message).toMatch(/a reference entry carries no/);
    }
    for (const extra of [{ reviewBy: '2026-12-31' }, { approver: 'security-lead' }]) {
      expect(codes(suppressions(TODAY, { ...referenceSuppression, ...extra }))).toEqual([
        'error MALFORMED',
      ]);
    }
  });

  it('are never scoped to the sandbox and explain themselves in >= 40 characters', () => {
    const sandbox = { environments: ['prod', 'sandbox'] };
    expect(exceptions(TODAY, { ...referenceException, ...sandbox }).issues[0]?.message).toContain(
      'never scoped to the sandbox',
    );
    expect(codes(suppressions(TODAY, { ...referenceSuppression, ...sandbox }))).toEqual([
      'error MALFORMED',
    ]);
    const short = exceptions(TODAY, {
      ...referenceException,
      justification: 'Thirty characters long, roughly.',
    });
    expect(short.issues[0]?.message).toContain('>= 40 chars');
  });

  it('keep the exact-scope rules of the register (no "**", IAM5 needs allowedActions)', () => {
    expect(codes(suppressions(TODAY, { ...referenceSuppression, resources: ['A/**'] }))).toContain(
      'error MALFORMED',
    );
    expect(
      codes(
        suppressions(TODAY, { ...referenceSuppression, ruleId: 'AwsSolutions-IAM5[Resource::*]' }),
      ),
    ).toContain('error ACTIONS_REQUIRED');
  });

  it('no other status exists, and an entry without status must carry its dates', () => {
    expect(codes(exceptions(TODAY, { ...referenceException, status: 'approved' }))).toEqual([
      'error MALFORMED',
    ]);
    const r = exceptions(TODAY, dated(referenceException, {}));
    expect(codes(r)).toEqual(['error MALFORMED', 'error MALFORMED']);
    expect(r.issues[0]?.message).toContain('is required');
  });

  it('their acknowledgement reason says reference design, without an expiry', () => {
    const e = exceptions(TODAY, EXC5).active[0];
    expect(e && exceptionReason(e)).toMatch(/^\[EXC-0005\] .*reference design: no expiry/);
    const s = suppressions(TODAY, SUP1).active[0];
    expect(s && suppressionReason(s)).toMatch(/^\[SUP-0001\] .*reference design: no review date/);
  });
});

describe('example entries (the unloaded sandbox register)', () => {
  it.each(DATES)('on %s: an error wherever loaded, never active', (today) => {
    const s = suppressions(today, exampleSuppression);
    expect([s.ok, s.active, codes(s)]).toEqual([false, [], ['error EXAMPLE_NOT_ADOPTED']]);
    const e = exceptions(today, { ...referenceException, status: 'example' });
    expect([e.ok, e.active, codes(e)]).toEqual([false, [], ['error EXAMPLE_NOT_ADOPTED']]);
  });

  it('carry no dates or approver either', () => {
    expect(codes(suppressions(TODAY, { ...exampleSuppression, reviewBy: '2026-12-31' }))).toEqual([
      'error MALFORMED',
    ]);
  });
});

/** Same class and child names as the reference code, so the pinned SUP-0001 governs it. */
class ApiService extends Construct {
  constructor(scope: Construct, id: string) {
    super(scope, id);
    new CfnResource(new Construct(this, 'TaskDefinition'), 'Resource', {
      type: 'AWS::ECS::TaskDefinition',
    });
  }
}
const apiIn = (stageName: string | undefined): ApiService => {
  const app = new App();
  const stack = stageName ? new Stack(new Stage(app, stageName), 'Api') : new Stack(app, 'Api');
  return new ApiService(stack, 'Service');
};
/** `<Stage>/Migrations/DatabaseBootstrap/TaskDefinition/Resource`, the scope of EXC-0005. */
const bootstrapTaskIn = (app: App, stage: string): void => {
  const task = new Construct(new Stack(new Stage(app, stage), 'Migrations'), 'DatabaseBootstrap');
  new CfnResource(new Construct(task, 'TaskDefinition'), 'Resource', {
    type: 'AWS::ECS::TaskDefinition',
  });
};

describe('where they apply', () => {
  it('the pinned EXC-0005 applies in the governed stages it lists, at any date', () => {
    for (const today of DATES) {
      const app = new App();
      for (const stage of ['Dev', 'Prod', 'Sandbox']) bootstrapTaskIn(app, stage);
      const applied = acknowledgeExceptions(app, exceptions(today, EXC5).active, stageEnvironment);
      expect(applied.map((a) => a.constructPath)).toEqual([
        'Dev/Migrations/DatabaseBootstrap/TaskDefinition/Resource',
        'Prod/Migrations/DatabaseBootstrap/TaskDefinition/Resource',
      ]);
    }
  });

  it('a reference suppression resolves in governed stages and outside any stage, not the sandbox', () => {
    const reg = suppressions('2031-01-01', SUP1);
    expect(resolveSuppression(apiIn('Dev'), 'AwsSolutions-ECS2', reg).entry.id).toBe('SUP-0001');
    expect(resolveSuppression(apiIn(undefined), 'AwsSolutions-ECS2', reg).entry.id).toBe(
      'SUP-0001',
    );
    expect(() => resolveSuppression(apiIn('Sandbox'), 'AwsSolutions-ECS2', reg)).toThrow(
      /limited to dev\/staging\/prod, not sandbox\. The live-validation sandbox ships its entries only as an EXAMPLE register/,
    );
  });

  it('a loaded example never resolves: synth of the stage fails with the reason', () => {
    const reg = suppressions(TODAY, { ...exampleSuppression, ...pick(SUP1) });
    expect(() => resolveSuppression(apiIn('Sandbox'), 'AwsSolutions-ECS2', reg)).toThrow(
      /SUP-0400 is not active[\s\S]*shipped example .* is not adopted and never applies/,
    );
  });

  it('the template audit holds a reference entry to its exact scope', () => {
    const reg = suppressions(TODAY, SUP1);
    const run = (cdkPath: string) =>
      auditSuppressions(
        [
          {
            file: 't.json',
            template: {
              Resources: {
                X: {
                  Type: 'AWS::ECS::TaskDefinition',
                  Metadata: {
                    'aws:cdk:path': cdkPath,
                    cdk_nag: {
                      rules_to_suppress: [{ id: 'AwsSolutions-ECS2', reason: '[SUP-0001] x' }],
                    },
                  },
                },
              },
            },
          } as AuditTemplate,
        ],
        { exceptions: [], suppressions: reg.active },
      ).issues.map((i) => i.code);
    expect(run('Dev/Api/Service/TaskDefinition/Resource')).toEqual([]);
    expect(run('Dev/Api/Service/ExecutionRole/Resource')).toEqual(['SCOPE_MISMATCH']);
    expect(run('Sandbox/Api/Service/TaskDefinition/Resource')).toEqual(['ENVIRONMENT_MISMATCH']);
  });
});

describe('check-exceptions (the CI gate)', () => {
  let logs: string[] = [];
  beforeEach(() => {
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void logs.push(a.join(' ')));
  });
  afterEach(() => vi.restoreAllMocks());

  function files(exc: object[], sup: object[]) {
    const dir = tempDir();
    const file = join(dir, 'exceptions.yaml');
    const register = join(dir, 'suppressions.yaml');
    writeFileSync(file, stringify({ schemaVersion: 1, exceptions: exc }));
    writeFileSync(register, stringify({ schemaVersion: 1, suppressions: sup }));
    return { dir, args: ['check-exceptions', '--file', file, '--suppressions', register] };
  }
  const approvalsFile = (dir: string, entries: { id: string; raw: object }[]) => {
    const path = join(dir, `approvals-${entries.length}.yaml`);
    writeFileSync(
      path,
      stringify({
        schemaVersion: 1,
        approvals: entries.map(({ id, raw }) => ({
          id,
          sha256: entryDigest(raw),
          approvedBy: 'security-lead',
          approvedAt: TODAY,
        })),
      }),
    );
    return path;
  };

  it.each(DATES)('on %s: pinned reference entries pass with no approvals at all', (today) => {
    const f = files([EXC5], [SUP1]);
    expect(main([...f.args, '--today', today])).toBe(EXIT.OK);
    expect(main([...f.args, '--today', today, '--approvals', approvalsFile(f.dir, [])])).toBe(
      EXIT.OK,
    );
    expect(logs.join('\n')).toContain('1 reference design: part of the code');
    expect(logs.join('\n')).not.toContain('UNAPPROVED_ENTRY');
    logs = [];
    expect(main(['approval-digests', ...f.args.slice(1)])).toBe(EXIT.OK);
    expect(logs).toEqual([
      'EXC-0005 (no approval: reference entry, pinned)',
      'SUP-0001 (no approval: reference entry, pinned)',
    ]);
  });

  it('a reference entry cannot be approved into covering a different scope', () => {
    // Widening it as a reference entry: the schema still forbids an approver, and the wider entry
    // is a code change; widening it as a PROJECT entry makes it a dated entry that needs its own
    // approval, which the digest of the reference content does not give.
    const wider = { ...EXC5, resource: '*/Migrations/DatabaseRetention/TaskDefinition/Resource' };
    expect(main([...files([{ ...wider, approver: 'security-lead' }], []).args])).toBe(EXIT.FAILED);
    expect(logs.join('\n')).toContain('MALFORMED');
    // As a reference entry the wider copy is not pinned, whatever an approvals file says.
    const f0 = files([wider], []);
    const pinnedApproval = approvalsFile(f0.dir, [{ id: 'EXC-0005', raw: EXC5 }]);
    logs = [];
    expect(main([...f0.args, '--today', TODAY, '--approvals', pinnedApproval])).toBe(EXIT.FAILED);
    expect(logs.join('\n')).toMatch(/UNPINNED_REFERENCE_ENTRY: EXC-0005: reference entry differs/);
    const widened = dated(wider, { createdAt: '2026-10-01', expiresAt: '2026-12-31' });
    const f = files([widened], []);
    const approvals = approvalsFile(f.dir, [{ id: 'EXC-0005', raw: EXC5 }]);
    logs = [];
    expect(main([...f.args, '--today', TODAY, '--approvals', approvals])).toBe(EXIT.FAILED);
    expect(logs.join('\n')).toMatch(/UNAPPROVED_ENTRY: EXC-0005: changed since it was approved/);
  });

  it('project entries keep the full model: unapproved, expired, example → fail', () => {
    const exc = dated(referenceException, { createdAt: '2026-10-01', expiresAt: '2026-12-31' });
    const f = files([exc], []);
    expect(main([...f.args, '--today', TODAY])).toBe(EXIT.OK);
    expect(main([...f.args, '--today', TODAY, '--approvals', approvalsFile(f.dir, [])])).toBe(
      EXIT.FAILED,
    );
    expect(logs.join('\n')).toContain('UNAPPROVED_ENTRY');
    expect(
      main([
        ...f.args,
        '--today',
        TODAY,
        '--approvals',
        approvalsFile(f.dir, [{ id: 'EXC-0100', raw: exc }]),
      ]),
    ).toBe(EXIT.OK);
    expect(main([...f.args, '--today', '2027-01-01'])).toBe(EXIT.FAILED);
    expect(main([...files([], [exampleSuppression]).args, '--today', TODAY])).toBe(EXIT.FAILED);
    expect(logs.join('\n')).toContain('EXAMPLE_NOT_ADOPTED');
  });
});

/** The scope-defining fields of a suppression entry (to build an example of the same scope). */
function pick(entry: Record<string, unknown>): Record<string, unknown> {
  const { ruleId, construct, resources } = entry;
  return { ruleId, construct, resources };
}

describe('pinning: only the shipped reference entries, with exactly their content', () => {
  const critical = {
    ...referenceException,
    id: 'EXC-0999',
    ruleId: 'BASE-S3-002',
    resource: '*/Edge/Bucket/Resource',
  };

  it.each(DATES)('on %s: a new reference entry is not pinned and never applies', (today) => {
    for (const entry of [referenceException, { ...EXC5, id: 'EXC-0999' }, critical]) {
      const r = exceptions(today, entry);
      expect([r.ok, r.active, codes(r)]).toEqual([false, [], ['error UNPINNED_REFERENCE_ENTRY']]);
    }
    expect(exceptions(today, critical).issues[0]?.message).toContain(
      'critical rule: only a pinned reference entry may waive it without an approver',
    );
    const s = suppressions(today, referenceSuppression);
    expect([s.ok, s.active, codes(s)]).toEqual([false, [], ['error UNPINNED_REFERENCE_ENTRY']]);
  });

  it('a widened or otherwise edited copy of a pinned entry is no longer pinned', () => {
    for (const edit of [
      { resource: '*/Migrations/DatabaseRetention/TaskDefinition/Resource' },
      { ruleId: 'BASE-ECS-008' },
      { justification: `${String(EXC5['justification'])} Widened.` },
    ]) {
      const r = exceptions(TODAY, { ...EXC5, ...edit });
      expect(codes(r)).toEqual(['error UNPINNED_REFERENCE_ENTRY']);
      expect(r.issues[0]?.message).toContain('differs from its pinned content');
    }
    for (const edit of [
      { resources: ['TaskDefinition/Resource', 'TaskDefinition/ExecutionRole/Resource'] },
      { environments: ['dev'] },
    ]) {
      expect(codes(suppressions(TODAY, { ...SUP1, ...edit }))).toEqual([
        'error UNPINNED_REFERENCE_ENTRY',
      ]);
    }
  });

  it('a reference exception names exact resources: "**" and later-segment wildcards are rejected', () => {
    for (const resource of [
      '**',
      '*',
      '*/**',
      'Dev/**/Resource',
      '*/Migrations/*/TaskDefinition/Resource',
      '*/Migrations/DatabaseBootstrap/TaskDefinition/Res?urce',
    ]) {
      const r = exceptions(TODAY, { ...EXC5, resource });
      expect(codes(r), resource).toEqual(['error MALFORMED']);
      expect(r.issues[0]?.message, resource).toContain('a reference entry names exact resources');
    }
    // Project entries keep their (dated, approvable) glob semantics.
    expect(
      exceptions(
        TODAY,
        dated(referenceException, {
          resource: 'Dev/**',
          createdAt: TODAY,
          expiresAt: '2026-12-31',
        }),
      ).ok,
    ).toBe(true);
  });

  it('an unpinned reference entry fails synth (BASE-EXC-001, BASE-SUP-001) and resolution', () => {
    const dir = tempDir();
    const file = join(dir, 'exceptions.yaml');
    writeFileSync(file, stringify({ schemaVersion: 1, exceptions: [{ ...EXC5, id: 'EXC-0999' }] }));
    const app = new App();
    bootstrapTaskIn(app, 'Dev');
    const { pack, applied } = applyBaselinePolicies(app, { exceptionsFile: file, register: false });
    expect(applied).toEqual([]);
    expect(pack.validateScope(app).violations.map((v) => v.ruleName)).toContain('BASE-EXC-001');
    const reg = suppressions(TODAY, { ...SUP1, environments: ['dev'] });
    expect(new SuppressionAuditPlugin({ register: reg }).validateScope(app).violations).toEqual([
      expect.objectContaining({ ruleName: 'BASE-SUP-001', severity: 'fatal' }),
    ]);
    expect(() => resolveSuppression(apiIn('Dev'), 'AwsSolutions-ECS2', reg)).toThrow(
      /SUP-0001 is not active[\s\S]*differs from its pinned content/,
    );
  });

  it('every pin names a shipped reference entry, and no shipped reference entry is unpinned', () => {
    const entries = [
      ...(parse(readFileSync(DEFAULT_EXCEPTIONS_PATH, 'utf8')) as { exceptions: object[] })
        .exceptions,
      ...(parse(readFileSync(DEFAULT_SUPPRESSIONS_PATH, 'utf8')) as { suppressions: object[] })
        .suppressions,
    ] as Record<string, unknown>[];
    const references = entries.filter((e) => e['status'] === 'reference');
    expect(Object.keys(REFERENCE_ENTRY_DIGESTS).sort()).toEqual(
      references.map((e) => String(e['id'])).sort(),
    );
    for (const e of references) {
      expect(REFERENCE_ENTRY_DIGESTS[String(e['id'])], String(e['id'])).toBe(entryDigest(e));
    }
  });
});
