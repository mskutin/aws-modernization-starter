import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXIT, main } from '../src/cli/main.js';
import { DEFAULT_EXCEPTIONS_PATH } from '../src/guard/layout.js';
import { resolveGuardBinary } from '../src/guard/runner.js';
import { RULE_CASES, tags, templateOf } from './fixtures/cases.js';
import { tempDir } from './helpers.js';

const guard = (() => {
  try {
    return resolveGuardBinary();
  } catch {
    return undefined;
  }
})();
const FIX = join(import.meta.dirname, 'fixtures', 'exceptions');
let logs: string[] = [];

beforeEach(() => {
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void logs.push(a.join(' ')));
});
afterEach(() => vi.restoreAllMocks());

describe('starter-policies CLI', () => {
  it('prints usage and exits 2 without a command; 2 for unknown commands', () => {
    expect(main([])).toBe(EXIT.USAGE);
    expect(main(['nope'])).toBe(EXIT.USAGE);
    expect(logs.join('\n')).toContain('NOT an approved control set');
  });

  it('check-exceptions: 0 for valid, 1 for expired/malformed, writes a JSON report', () => {
    const report = join(tempDir(), 'out', 'exceptions.json');
    // A fixed, empty register: the pinned --today must not depend on the repository's entries.
    const register = join(tempDir(), 'suppressions.yaml');
    writeFileSync(register, 'schemaVersion: 1\nsuppressions: []\n');
    expect(
      main([
        'check-exceptions',
        '--file',
        join(FIX, 'valid.yaml'),
        '--suppressions',
        register,
        '--today',
        '2026-10-13',
        '--report',
        report,
      ]),
    ).toBe(EXIT.OK);
    expect(JSON.parse(readFileSync(report, 'utf8'))).toMatchObject({ ok: true });
    expect(
      main(['check-exceptions', '--file', join(FIX, 'expired.yaml'), '--today', '2026-10-13']),
    ).toBe(EXIT.FAILED);
    expect(main(['check-exceptions', '--file', join(FIX, 'malformed.yaml')])).toBe(EXIT.FAILED);
    expect(logs.join('\n')).toContain('EXPIRED');
  });

  it('check-exceptions --templates flags ungoverned cdk_nag suppressions', () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, 'Dev.template.json'),
      JSON.stringify({
        Resources: {
          B: {
            Type: 'AWS::S3::Bucket',
            Metadata: {
              cdk_nag: { rules_to_suppress: [{ id: 'BASE-S3-001', reason: 'trust me' }] },
            },
          },
        },
      }),
    );
    expect(
      main([
        'check-exceptions',
        '--file',
        join(FIX, 'valid.yaml'),
        '--today',
        '2026-10-13',
        '--templates',
        dir,
      ]),
    ).toBe(EXIT.FAILED);
    expect(logs.join('\n')).toContain('UNGOVERNED_SUPPRESSION');
  });

  it('catalogue prints every rule', () => {
    expect(main(['catalogue'])).toBe(EXIT.OK);
    expect(logs.join('\n').match(/\| BASE-/g)?.length).toBe(RULE_CASES.length);
    logs = [];
    expect(main(['catalogue', '--format', 'json'])).toBe(EXIT.OK);
    expect(JSON.parse(logs.join('\n'))).toHaveLength(RULE_CASES.length);
  });

  it('guard-validate exits 2 when there is nothing to validate', () => {
    expect(main(['guard-validate', '--dir', join(tempDir(), 'missing')])).toBe(EXIT.USAGE);
  });
});

describe.runIf(guard)('starter-policies CLI with cfn-guard', () => {
  /** A fake cdk.out with a Stage assembly, mirroring CDK's layout. */
  function cdkOut(resources: Record<string, unknown>): string {
    const dir = tempDir('starter-cdk-out-');
    mkdirSync(join(dir, 'assembly-Staging'));
    writeFileSync(join(dir, 'manifest.json'), '{}');
    writeFileSync(
      join(dir, 'assembly-Staging', 'StagingEdge1234.template.json'),
      JSON.stringify(templateOf(resources as never)),
    );
    return dir;
  }
  const openBucket = {
    Type: 'AWS::S3::Bucket',
    Metadata: { 'aws:cdk:path': 'Staging/Edge/Assets/Resource' },
    Properties: {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
        BlockPublicPolicy: false,
      },
      Tags: tags('staging'),
    },
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
  };

  it('guard-validate: blocking finding → exit 1 with JUnit/SARIF/JSON/Markdown reports', () => {
    const out = tempDir();
    const dir = cdkOut({ Assets: openBucket });
    expect(main(['guard-validate', '--dir', dir, '--out', out, '--no-exceptions'])).toBe(
      EXIT.FAILED,
    );
    for (const f of ['guard-results.json', 'guard-junit.xml', 'guard.sarif', 'guard-summary.md']) {
      expect(existsSync(join(out, f))).toBe(true);
    }
    const junit = readFileSync(join(out, 'guard-junit.xml'), 'utf8');
    expect(junit).toMatch(
      /<testcase classname="assembly-Staging\/StagingEdge1234.template.json" name="BASE-S3-001[^"]*"><failure/,
    );
    const sarif = JSON.parse(readFileSync(join(out, 'guard.sarif'), 'utf8'));
    expect(sarif.runs[0].results[0]).toMatchObject({ ruleId: 'BASE-S3-001', level: 'error' });
    expect(sarif.runs[0].results[0].locations[0].logicalLocations[0].fullyQualifiedName).toBe(
      'Staging/Edge/Assets/Resource',
    );
    expect(readFileSync(join(out, 'guard-summary.md'), 'utf8')).toContain('FAILED');
  });

  it('guard-validate: a governed exception waives the finding → exit 0, recorded as suppression', () => {
    const out = tempDir();
    const dir = cdkOut({ Assets: openBucket });
    const exc = join(tempDir(), 'exceptions.yaml');
    writeFileSync(
      exc,
      `schemaVersion: 1
exceptions:
  - id: EXC-0042
    ruleId: BASE-S3-001
    resource: 'Staging/Edge/**'
    environments: [staging]
    justification: Bucket policy managed by a separate approved process during migration.
    owner: platform-team
    ticket: TKT-42
    createdAt: '2026-10-01'
    expiresAt: '2026-12-31'
`,
    );
    expect(
      main([
        'guard-validate',
        '--dir',
        dir,
        '--out',
        out,
        '--exceptions',
        exc,
        '--today',
        '2026-10-13',
      ]),
    ).toBe(EXIT.OK);
    const sarif = JSON.parse(readFileSync(join(out, 'guard.sarif'), 'utf8'));
    expect(sarif.runs[0].results[0].suppressions[0].justification).toContain('EXC-0042');
    expect(readFileSync(join(out, 'guard-junit.xml'), 'utf8')).toContain(
      'waived by governed exception',
    );
    // The same exception, once expired, fails the run.
    expect(
      main([
        'guard-validate',
        '--dir',
        dir,
        '--out',
        out,
        '--exceptions',
        exc,
        '--today',
        '2027-01-01',
      ]),
    ).toBe(EXIT.FAILED);
    expect(readFileSync(join(out, 'guard-junit.xml'), 'utf8')).toContain('exception-governance');
  });

  it('guard-validate: the pinned EXC-0005 waives exactly its scope at any date; unpinned or example never', () => {
    const out = tempDir();
    // The bootstrap-style task (DB_AUTH=secrets-manager): the finding EXC-0005 exists for.
    const ecs9 = RULE_CASES.find((c) => c.ruleId === 'BASE-ECS-009');
    const bootstrap = ecs9?.variants?.find((v) => v.name.startsWith('bootstrap-style'))?.resources[
      'TaskDef'
    ];
    const at = (cdkPath: string) => ({
      TaskDef: { ...bootstrap, Metadata: { 'aws:cdk:path': cdkPath } },
    });
    const run = (exceptionsFile: string, today: string, resources: Record<string, unknown>) => {
      logs = [];
      return main([
        'guard-validate',
        '--dir',
        cdkOut(resources),
        '--out',
        out,
        '--exceptions',
        exceptionsFile,
        '--today',
        today,
      ]);
    };
    const exc = join(tempDir(), 'exceptions.yaml');
    const shipped = parse(readFileSync(DEFAULT_EXCEPTIONS_PATH, 'utf8')) as {
      exceptions: Record<string, unknown>[];
    };
    const exc5 = shipped.exceptions.find((e) => e['id'] === 'EXC-0005') ?? {};
    const write = (entry: Record<string, unknown>) =>
      writeFileSync(exc, stringify({ schemaVersion: 1, exceptions: [entry] }));
    for (const today of ['2026-10-17', '2027-04-12', '2031-01-01']) {
      write(exc5);
      expect(run(exc, today, at('Dev/Migrations/DatabaseBootstrap/TaskDefinition/Resource'))).toBe(
        EXIT.OK,
      );
      expect(logs.join('\n')).toMatch(/blocking=0 advisory=0 waived=2 exceptionErrors=0/);
      // Same finding on another task: blocking.
      expect(run(exc, today, at('Dev/Migrations/OtherTask/TaskDefinition/Resource'))).toBe(
        EXIT.FAILED,
      );
      expect(logs.join('\n')).toMatch(/blocking=2 advisory=0 waived=0 exceptionErrors=0/);
      // A widened copy, an unpinned reference entry or an example: never waives, and fails.
      for (const entry of [
        { ...exc5, resource: '*/Migrations/*/TaskDefinition/Resource' },
        {
          ...exc5,
          environments: ['dev', 'staging', 'prod'],
          justification: `${String(exc5['justification'])} ` + 'x'.repeat(5),
        },
        { ...exc5, id: 'EXC-0999' },
        { ...exc5, status: 'example' },
      ]) {
        write(entry);
        expect(
          run(exc, today, at('Dev/Migrations/DatabaseBootstrap/TaskDefinition/Resource')),
        ).toBe(EXIT.FAILED);
        expect(logs.join('\n')).toMatch(/blocking=2 advisory=0 waived=0 exceptionErrors=1/);
      }
    }
  });

  it('guard-validate: advisory findings only fail with --fail-on-advisory', () => {
    const fn = RULE_CASES.find((c) => c.ruleId === 'BASE-LMB-002')?.fail ?? {};
    const dir = cdkOut(fn);
    expect(main(['guard-validate', '--dir', dir, '--out', tempDir(), '--no-exceptions'])).toBe(
      EXIT.OK,
    );
    expect(
      main([
        'guard-validate',
        '--dir',
        dir,
        '--out',
        tempDir(),
        '--no-exceptions',
        '--fail-on-advisory',
      ]),
    ).toBe(EXIT.FAILED);
  });

  it('guard-test runs the Guard unit tests and writes JUnit', () => {
    const out = tempDir();
    expect(main(['guard-test', '--out', out])).toBe(EXIT.OK);
    expect(readFileSync(join(out, 'guard-test-junit.xml'), 'utf8')).toContain('failures="0"');
  });
});
