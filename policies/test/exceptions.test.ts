import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { App, Stack, Stage } from 'aws-cdk-lib';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { stageEnvironment } from '../src/cdk/apply.js';
import { auditTemplateSuppressions } from '../src/exceptions/audit.js';
import {
  checkExceptions,
  findException,
  globToRegExp,
  loadExceptionsFile,
  type PolicyException,
} from '../src/exceptions/exceptions.js';
import { DEFAULT_EXCEPTIONS_PATH } from '../src/guard/layout.js';

const FIX = join(import.meta.dirname, 'fixtures', 'exceptions');
const TODAY = '2026-10-13';
const load = (name: string, today = TODAY) => loadExceptionsFile(join(FIX, name), { today });
const codes = (r: ReturnType<typeof load>) => r.issues.map((i) => i.code);

describe('exceptions governance', () => {
  it('accepts a valid file and warns about exceptions expiring soon', () => {
    const r = load('valid.yaml');
    expect(r.ok).toBe(true);
    expect(r.active.map((e) => e.id)).toEqual(['EXC-0001', 'EXC-0002']);
    expect(r.issues).toEqual([
      expect.objectContaining({ level: 'warning', code: 'EXPIRING_SOON', exceptionId: 'EXC-0002' }),
    ]);
  });

  it('fails expired exceptions and does not activate them', () => {
    const r = load('expired.yaml');
    expect(r.ok).toBe(false);
    expect(r.active).toEqual([]);
    expect(r.issues[0]).toMatchObject({ level: 'error', code: 'EXPIRED', exceptionId: 'EXC-0003' });
    expect(r.issues[0]?.message).toContain('expired on 2026-09-30');
  });

  it('treats the expiry date as inclusive', () => {
    expect(load('expired.yaml', '2026-09-30').ok).toBe(true);
    expect(load('expired.yaml', '2026-10-01').ok).toBe(false);
  });

  it('fails malformed entries with field-level messages', () => {
    const r = load('malformed.yaml');
    expect(r.ok).toBe(false);
    expect(new Set(codes(r))).toEqual(new Set(['MALFORMED']));
    const text = r.issues.map((i) => i.message).join('\n');
    for (const field of [
      'exceptions.0.id',
      'exceptions.0.ruleId',
      'exceptions.0.environments.0',
      'exceptions.0.justification',
      'exceptions.0.ticket',
      'exceptions.0.createdAt',
    ]) {
      expect(text).toContain(field);
    }
    expect(text).toMatch(/unexpected/);
  });

  it('fails a file that is not valid YAML', () => {
    const r = load('invalid-yaml.txt');
    expect(r.ok).toBe(false);
    expect(codes(r)).toEqual(['MALFORMED']);
  });

  it('enforces governance rules: known rule, unique id, approver for critical, max window', () => {
    const r = load('governance.yaml');
    expect(r.ok).toBe(false);
    expect(codes(r)).toEqual([
      'UNKNOWN_RULE',
      'DUPLICATE_ID',
      'APPROVER_REQUIRED',
      'INVALID_WINDOW',
    ]);
    expect(r.active.map((e) => e.id)).toEqual(['EXC-0012']);
  });

  it('rejects createdAt in the future and expiresAt before createdAt', () => {
    const base = {
      id: 'EXC-0100',
      ruleId: 'BASE-LOG-001',
      resource: '**',
      environments: ['dev'],
      justification: 'A sufficiently long justification text.',
      owner: 'platform-team',
      ticket: 'T-1',
    };
    const future = checkExceptions(
      {
        schemaVersion: 1,
        exceptions: [{ ...base, createdAt: '2026-11-01', expiresAt: '2026-12-01' }],
      },
      { today: TODAY },
    );
    expect(future.issues[0]?.message).toContain('in the future');
    const inverted = checkExceptions(
      {
        schemaVersion: 1,
        exceptions: [{ ...base, createdAt: '2026-10-01', expiresAt: '2026-09-01' }],
      },
      { today: TODAY },
    );
    expect(codes(inverted)).toContain('INVALID_WINDOW');
  });

  it('rejects an unknown schema version', () => {
    expect(checkExceptions({ schemaVersion: 2, exceptions: [] }).ok).toBe(false);
  });

  it('the repository exceptions file is valid today', () => {
    const r = loadExceptionsFile(DEFAULT_EXCEPTIONS_PATH);
    expect(r.issues.filter((i) => i.level === 'error')).toEqual([]);
    expect(parse(readFileSync(DEFAULT_EXCEPTIONS_PATH, 'utf8'))).toMatchObject({
      schemaVersion: 1,
    });
  });
});

describe('exception matching', () => {
  it('globs: * stays within a path segment, ** crosses segments', () => {
    expect(globToRegExp('Dev/*/Resource').test('Dev/Bucket/Resource')).toBe(true);
    expect(globToRegExp('Dev/*/Resource').test('Dev/Edge/Bucket/Resource')).toBe(false);
    expect(globToRegExp('Dev/**').test('Dev/Edge/Bucket/Resource')).toBe(true);
    expect(globToRegExp('Dev/Fn?').test('Dev/Fn1')).toBe(true);
    expect(globToRegExp('a.b(c)').test('a.b(c)')).toBe(true);
    expect(globToRegExp('a.b').test('aXb')).toBe(false);
  });

  const active = load('valid.yaml').active;

  it('matches on rule, environment and construct path', () => {
    const target = {
      ruleId: 'BASE-CF-002',
      environment: 'staging' as const,
      cdkPath: 'Staging/Edge/Distribution/Resource',
      logicalId: 'Dist1234',
    };
    expect(findException(active, target)?.id).toBe('EXC-0001');
    expect(findException(active, { ...target, environment: 'prod' })).toBeUndefined();
    expect(findException(active, { ...target, ruleId: 'BASE-CF-003' })).toBeUndefined();
    expect(
      findException(active, { ...target, cdkPath: 'Prod/Edge/Distribution/Resource' }),
    ).toBeUndefined();
    expect(findException(active, { ...target, environment: undefined })).toBeUndefined();
  });

  it('matches an exact logical ID', () => {
    expect(
      findException(active, {
        ruleId: 'BASE-LMB-004',
        environment: 'dev',
        cdkPath: undefined,
        logicalId: 'Fn',
      })?.id,
    ).toBe('EXC-0002');
  });

  it('the non-governed sandbox stage has its own environment: sandbox-scoped exceptions apply only there', () => {
    const sandboxOnly = checkExceptions(
      {
        schemaVersion: 1,
        exceptions: [
          {
            id: 'EXC-0100',
            ruleId: 'BASE-TAG-002',
            resource: 'Sandbox/**',
            environments: ['sandbox'],
            justification:
              'Fixture: the sandbox tags Environment=sandbox, not a governed environment.',
            owner: 'platform-team',
            ticket: 'fixture',
            createdAt: '2026-10-01',
            expiresAt: '2026-12-31',
          },
        ],
      },
      { today: TODAY },
    );
    expect(sandboxOnly.ok).toBe(true);
    const target = {
      ruleId: 'BASE-TAG-002',
      cdkPath: 'Sandbox/Api/Alb/Resource',
      logicalId: 'Alb',
    };
    expect(findException(sandboxOnly.active, { ...target, environment: 'sandbox' })?.id).toBe(
      'EXC-0100',
    );
    expect(findException(sandboxOnly.active, { ...target, environment: 'dev' })).toBeUndefined();
    expect(stageEnvironment(new Stack(new Stage(new App(), 'Sandbox'), 'S'))).toBe('sandbox');
    expect(stageEnvironment(new Stack(new App(), 'IntegrationWorkflowStack'))).toBeUndefined();
  });
});

describe('template suppression audit (governed exceptions)', () => {
  const active: PolicyException[] = load('valid.yaml').active;
  const templateWith = (
    id: string,
    reason: string,
    cdkPath = 'Staging/Edge/Distribution/Resource',
  ) => ({
    file: 'Staging.template.json',
    template: {
      Resources: {
        Dist: {
          Metadata: {
            'aws:cdk:path': cdkPath,
            cdk_nag: { rules_to_suppress: [{ id, reason }] },
          },
        },
      },
    },
  });

  it('accepts suppressions that cite an active exception for the same rule, resource and environment', () => {
    expect(
      auditTemplateSuppressions([templateWith('BASE-CF-002', '[EXC-0001] justified')], active),
    ).toEqual([]);
  });

  it('flags ungoverned or mismatched suppressions; scope baseline audits BASE-* only', () => {
    const templates = [
      templateWith('BASE-CF-002', 'because I said so'),
      templateWith('BASE-S3-001', '[EXC-0001] wrong rule'),
      templateWith('AwsSolutions-S1', '[EXC-9999] unknown'),
    ];
    expect(auditTemplateSuppressions(templates, active, 'baseline').map((i) => i.code)).toEqual([
      'UNGOVERNED_SUPPRESSION',
      'UNGOVERNED_SUPPRESSION',
    ]);
    // Default scope (all): every suppression must be governed.
    expect(auditTemplateSuppressions(templates, active)).toHaveLength(3);
  });

  it('flags a valid citation outside the exception scope or environment', () => {
    const outside = auditTemplateSuppressions(
      [templateWith('BASE-CF-002', '[EXC-0001] justified', 'Staging/Api/Alb/Resource')],
      active,
    );
    expect(outside.map((i) => i.code)).toEqual(['SCOPE_MISMATCH']);
    const prod = auditTemplateSuppressions(
      [templateWith('BASE-CF-002', '[EXC-0001] justified', 'Prod/Edge/Distribution/Resource')],
      active,
    );
    expect(prod.map((i) => i.code)).toEqual(['SCOPE_MISMATCH', 'ENVIRONMENT_MISMATCH']);
  });
});
