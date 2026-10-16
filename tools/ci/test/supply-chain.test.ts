import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  checkDockerfile,
  checkExceptions,
  checkImageRefs,
  checkImageVariables,
  checkSastExceptionScope,
  collectImageRefs,
  imageAgeExceptionEntries,
  trivyIgnoreEntries,
} from '../src/supply-chain.ts';

const PINNED = 'docker.io/library/node:24.21.0-trixie@sha256:' + 'a'.repeat(64);
const repoRoot = join(import.meta.dirname, '../../..');

describe('image pinning', () => {
  const docs = [
    {
      file: 'ci.yml',
      doc: {
        variables: { IMG_NODE: PINNED },
        'job:a': { image: '$IMG_NODE', services: [{ name: '${IMG_NODE}', alias: 'x' }] },
        'job:b': { image: { name: 'docker.io/library/node:24', entrypoint: [''] } },
        'job:c': { image: 'node@sha256:' + 'b'.repeat(64) },
        'job:d': { image: '$IMG_MISSING' },
        'job:e': { services: ['docker.io/library/postgres:17.11'] },
      },
    },
  ];
  const findings = checkImageRefs(collectImageRefs(docs), { IMG_NODE: PINNED });

  it('accepts version + digest pinned references through variables', () => {
    expect(findings.filter((f) => f.subject.includes('job:a'))).toEqual([]);
  });

  it.each([
    ['job:b', /not pinned/],
    ['job:c', /not pinned/], // digest without registry + tag
    ['job:d', /unresolved variable/],
    ['job:e', /not pinned/],
  ])('rejects %s', (job, message) => {
    expect(findings.find((f) => f.subject.includes(job))?.message).toMatch(message);
  });

  it('rejects unpinned or latest IMG_* variables', () => {
    const f = checkImageVariables({
      IMG_A: 'docker.io/x/y:1.0',
      IMG_B: `docker.io/x/y:latest@sha256:${'c'.repeat(64)}`,
      OTHER: 'ignored',
    });
    expect(f.map((x) => x.subject)).toEqual(['IMG_A', 'IMG_B']);
  });

  it('the repository CI configuration is fully pinned', () => {
    const images = parse(readFileSync(join(repoRoot, '.gitlab/ci/images.yml'), 'utf8')) as {
      variables: Record<string, string>;
    };
    expect(checkImageVariables(images.variables)).toEqual([]);
    expect(Object.keys(images.variables).length).toBeGreaterThan(10);
  });
});

describe('Dockerfile pinning', () => {
  it('resolves ARG defaults and ignores stage references and scratch', () => {
    const content = `ARG BASE=${PINNED}
FROM \${BASE} AS build
FROM build AS test
FROM scratch
FROM --platform=linux/arm64 ${PINNED}
`;
    expect(checkDockerfile('Dockerfile', content)).toEqual([]);
  });

  it('flags tag-only and ARG-without-default FROM lines', () => {
    const f = checkDockerfile('Dockerfile', 'ARG X\nFROM node:24\nFROM ${X}\n');
    expect(f.map((x) => x.message)).toEqual([
      expect.stringMatching(/node:24 is not pinned/),
      expect.stringMatching(/ARG X has no default/),
    ]);
  });

  it('the API Dockerfile is digest-pinned', () => {
    const file = join(repoRoot, 'apps/api/Dockerfile');
    expect(checkDockerfile('apps/api/Dockerfile', readFileSync(file, 'utf8'))).toEqual([]);
  });
});

describe('exception expiry', () => {
  const today = '2026-10-13';
  it('requires justification and a bounded expiry', () => {
    const f = checkExceptions(
      [
        {
          source: 's',
          id: 'ok',
          expires: '2026-11-30',
          justification: 'Not reachable from the runtime image.',
        },
        { source: 's', id: 'nojust', expires: '2026-11-30', justification: '' },
        { source: 's', id: 'noexp', justification: 'A long enough justification.' },
        {
          source: 's',
          id: 'far',
          expires: '2027-12-31',
          justification: 'A long enough justification.',
        },
        {
          source: 's',
          id: 'expired',
          expires: '2026-01-01',
          justification: 'A long enough justification.',
        },
      ],
      today,
    );
    expect(f.map((x) => [x.subject, x.level])).toEqual([
      ['s: nojust', 'error'],
      ['s: noexp', 'error'],
      ['s: far', 'error'],
      ['s: expired', 'warning'],
    ]);
  });

  it('reads Trivy YAML ignore entries (incl. YAML dates)', () => {
    const doc = parse(
      'vulnerabilities:\n  - id: CVE-1\n    statement: Not shipped in runtime image.\n    expired_at: 2026-11-01\n',
    );
    const entries = trivyIgnoreEntries('ignore.yaml', doc);
    expect(entries[0]?.id).toBe('CVE-1');
    expect(checkExceptions(entries, today)).toEqual([]);
  });

  it('the repository Trivy ignore file is valid', () => {
    const doc = parse(readFileSync(join(repoRoot, '.gitlab/security/trivyignore.yaml'), 'utf8'));
    expect(checkExceptions(trivyIgnoreEntries('trivyignore.yaml', doc), today)).toEqual([]);
  });
});

describe('image release-age exceptions', () => {
  const MS = `docker.io/ministackorg/ministack:1.5.26@sha256:${'d'.repeat(64)}`;
  const vars = { IMG_MINISTACK: MS, IMG_NODE: PINNED, GIT_DEPTH: '50' };
  const entry = {
    variable: 'IMG_MINISTACK',
    image: MS,
    released: '2026-10-11',
    reason: 'Emulator service with fake credentials and synthetic data only.',
    approvedBy: 'ci-team',
    expires: '2026-10-25',
  };
  const run = (items: Array<Record<string, unknown>>, today = '2026-10-15') =>
    imageAgeExceptionEntries('age.yaml', { exceptions: items }, vars, today);

  it('accepts an exact, approved entry that ends when the release is 14 days old', () => {
    const r = run([entry]);
    expect(r.findings).toEqual([]);
    expect(checkExceptions(r.entries, '2026-10-15')).toEqual([]);
  });

  it.each([
    ['another digest', { image: MS.replace(/d{64}$/, 'e'.repeat(64)) }, /new pin needs its own/],
    ['another version', { image: MS.replace('1.5.26', '1.5.27') }, /new pin needs its own/],
    ['an unknown variable', { variable: 'IMG_OTHER' }, /names no IMG_\* variable/],
    ['a non-image variable', { variable: 'GIT_DEPTH' }, /names no IMG_\* variable/],
    ['no approver', { approvedBy: '' }, /missing approvedBy/],
    ['no release date', { released: undefined }, /release date/],
    ['a future release date', { released: '2026-10-20' }, /in the future/],
    ['an expiry past the age window', { expires: '2026-10-26' }, /may not outlive the age rule/],
  ])('rejects %s', (_name, patch, message) => {
    const r = run([{ ...entry, ...patch }]);
    expect(r.findings.map((f) => [f.level, f.message])).toEqual([
      ['error', expect.stringMatching(message)],
    ]);
  });

  // Fixed clock, release 2026-10-11, MIN_IMAGE_AGE_DAYS 14: the release qualifies on 2026-10-25.
  const levels = (r: ReturnType<typeof run>, today: string) =>
    [...r.findings, ...checkExceptions(r.entries, today)].map((f) => [f.level, f.message]);

  it('applies the exception while the release is younger than 14 days', () => {
    const r = run([entry], '2026-10-24');
    expect(r.entries).toHaveLength(1);
    expect(levels(r, '2026-10-24')).toEqual([]);
  });

  it.each(['2026-10-25', '2026-10-26', '2027-06-30', '2030-01-01'])(
    'on %s the release qualifies on its own: the entry is not consulted, a warning asks to delete it, nothing fails',
    (today) => {
      const r = run([entry], today);
      expect(r.entries).toEqual([]);
      expect(levels(r, today)).toEqual([
        ['warning', expect.stringMatching(/qualifies on its own: .* delete it/)],
      ]);
    },
  );

  it('an entry that expired while the release is still younger than 14 days FAILS (never a pass)', () => {
    const short = { ...entry, expires: '2026-10-15' };
    const r = run([short], '2026-10-16');
    expect(levels(r, '2026-10-16')).toEqual([
      ['error', expect.stringMatching(/expired on 2026-10-15 .* violates the release-age rule/)],
    ]);
  });

  it('an expired entry without a release date fails (age unknown: assume too young)', () => {
    const r = run([{ ...entry, released: undefined }], '2026-10-26');
    expect(r.findings.map((f) => f.level)).toEqual(['error', 'error']);
    expect(r.findings[1]?.message).toMatch(/unknown release date/);
  });

  it('feeds reason and expiry into the common exception rules', () => {
    const r = run([{ ...entry, reason: '' }]);
    expect(checkExceptions(r.entries, '2026-10-15').map((f) => f.message)).toEqual([
      expect.stringMatching(/missing justification/),
    ]);
  });

  it('the repository exceptions cover the pinned images exactly', () => {
    const images = parse(readFileSync(join(repoRoot, '.gitlab/ci/images.yml'), 'utf8')) as {
      variables: Record<string, string>;
    };
    const doc = parse(
      readFileSync(join(repoRoot, '.gitlab/security/image-age-exceptions.yaml'), 'utf8'),
    ) as { exceptions: Array<{ released: string }> };
    // Evaluated on each entry's release day, so the test does not age with the calendar.
    for (const e of doc.exceptions) {
      const r = imageAgeExceptionEntries('repo', { exceptions: [e] }, images.variables, e.released);
      expect(r.findings).toEqual([]);
      expect(checkExceptions(r.entries, e.released)).toEqual([]);
    }
  });

  it('the repository exceptions never fail the lint as time passes (warnings only)', () => {
    const images = parse(readFileSync(join(repoRoot, '.gitlab/ci/images.yml'), 'utf8')) as {
      variables: Record<string, string>;
    };
    const doc = parse(
      readFileSync(join(repoRoot, '.gitlab/security/image-age-exceptions.yaml'), 'utf8'),
    ) as { exceptions: Array<{ released: string; expires: string }> };
    for (const e of doc.exceptions) {
      for (const today of [e.expires, '2027-01-01', '2030-01-01']) {
        const r = imageAgeExceptionEntries('repo', { exceptions: [e] }, images.variables, today);
        const all = [...r.findings, ...checkExceptions(r.entries, today)];
        expect(all.filter((f) => f.level === 'error')).toEqual([]);
      }
    }
  });
});

describe('supply-chain:lint over the repository with a fixed future clock', () => {
  it.each(['2027-01-01', '2030-01-01'])(
    'passes on %s (no shipped entry turns into an error)',
    (today) => {
      const out = mkdtempSync(join(tmpdir(), 'supply-chain-lint-'));
      try {
        const r = spawnSync(
          process.execPath,
          [
            join(repoRoot, 'tools/ci/src/cli.ts'),
            'supply-chain-lint',
            '--today',
            today,
            '--out',
            out,
          ],
          { cwd: repoRoot, encoding: 'utf8' },
        );
        expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
        expect(r.stdout).toMatch(/supply-chain-lint: 0 error\(s\)/);
      } finally {
        rmSync(out, { recursive: true, force: true });
      }
    },
  );
});

describe('SAST waivers name the flagged code', () => {
  const fp = 'a'.repeat(64);
  it('accepts a fingerprint or an exact line and rejects rule + path only', () => {
    const f = checkSastExceptionScope('sast.json', [
      { rule: 'r1', path: 'a.ts', fingerprint: fp },
      { rule: 'r2', path: 'b.ts', line: 12 },
      { rule: 'r3', path: 'c.ts' },
      { rule: 'r4', path: 'd.ts', fingerprint: 'short' },
    ]);
    expect(f.map((x) => x.subject)).toEqual(['sast.json: r3 @ c.ts', 'sast.json: r4 @ d.ts']);
    expect(f[0]?.message).toMatch(/whole-file SAST waiver/);
  });

  it('the repository waivers are code-scoped (the shipped register is empty)', () => {
    const doc = JSON.parse(
      readFileSync(join(repoRoot, '.gitlab/security/sast-exceptions.json'), 'utf8'),
    ) as { exceptions: Array<Record<string, unknown>> };
    expect(doc.exceptions).toEqual([]);
    expect(checkSastExceptionScope('repo', doc.exceptions)).toEqual([]);
  });
});
