import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MigrationError,
  checksumOf,
  loadMigrations,
  plan,
  type Migration,
} from '../../src/persistence/migrations.js';

const REPO_MIGRATIONS = fileURLToPath(new URL('../../migrations/', import.meta.url));

const m = (version: string, sql = `-- ${version}`): Migration => ({
  version,
  name: `m${version}`,
  filename: `${version}_m${version}.sql`,
  sql,
  checksum: checksumOf(sql),
  transactional: true,
});

describe('migration planning', () => {
  it('returns pending migrations in order', () => {
    const disk = [m('0001'), m('0002'), m('0003')];
    const result = plan(disk, [{ version: '0001', name: 'm0001', checksum: disk[0]!.checksum }]);
    expect(result.pending.map((x) => x.version)).toEqual(['0002', '0003']);
  });

  it('refuses a migration modified after it was applied', () => {
    expect(() =>
      plan(
        [m('0001', 'ALTER TABLE x')],
        [{ version: '0001', name: 'm0001', checksum: checksumOf('old') }],
      ),
    ).toThrow(/0001_m0001\.sql was modified after it was applied/);
  });

  it('refuses when an applied migration is missing on disk', () => {
    expect(() => plan([], [{ version: '0001', name: 'gone', checksum: 'x' }])).toThrow(
      /applied migration 0001_gone is missing/,
    );
  });

  it('refuses out-of-order migrations', () => {
    const disk = [m('0001'), m('0002'), m('0003')];
    const applied = [
      { version: '0001', name: 'm0001', checksum: disk[0]!.checksum },
      { version: '0003', name: 'm0003', checksum: disk[2]!.checksum },
    ];
    expect(() => plan(disk, applied)).toThrow(MigrationError);
  });

  it('normalises CRLF so checkouts on Windows do not change checksums', () => {
    expect(checksumOf('a\r\nb')).toBe(checksumOf('a\nb'));
  });
});

describe('loadMigrations', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('loads the repository migrations in version order', async () => {
    const migrations = await loadMigrations(REPO_MIGRATIONS);
    expect(migrations.map((x) => x.filename)).toEqual([
      '0001_create_jobs.sql',
      '0002_jobs_listing_index.sql',
      '0003_role_privileges.sql',
      '0004_job_content_retention.sql',
      '0005_job_owner.sql',
      '0006_job_owner_index.sql',
    ]);
    // Only the CONCURRENTLY index build opts out of the per-migration transaction.
    expect(migrations.filter((x) => !x.transactional).map((x) => x.filename)).toEqual([
      '0006_job_owner_index.sql',
    ]);
  });

  it('detects the no-transaction directive', async () => {
    dir = await mkdtemp(join(tmpdir(), 'starter-mig-'));
    await writeFile(
      join(dir, '0001_idx.sql'),
      '-- migrate:no-transaction\nCREATE INDEX CONCURRENTLY i ON t (c);',
    );
    expect((await loadMigrations(dir))[0]?.transactional).toBe(false);
  });

  it.each([
    [['1_bad.sql'], /invalid migration filename "1_bad.sql"/],
    [['0001_UPPER.sql'], /invalid migration filename/],
    [['0001_a.sql', '0001_b.sql'], /duplicate migration version 0001/],
  ])('rejects %j', async (files, message) => {
    dir = await mkdtemp(join(tmpdir(), 'starter-mig-'));
    for (const f of files) await writeFile(join(dir, f), 'SELECT 1;');
    await expect(loadMigrations(dir)).rejects.toThrow(message);
  });
});
