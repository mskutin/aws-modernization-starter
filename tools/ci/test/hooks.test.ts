import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Git-hook pnpm launcher (tools/ci/hooks/pnpm.sh + pnpm-shim.sh). Regression: with no pnpm on
 * PATH the pre-push hook prepended a shim that the launcher resolved again, so shim -> launcher ->
 * shim exec'd forever and `git push` hung.
 */
const repoRoot = join(import.meta.dirname, '../../..');
const packageManager = (
  JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { packageManager: string }
).packageManager;
const pnpmVersion = (packageManager.split('@')[1] ?? '').split('+')[0];

const dirs: string[] = [];
const tempDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'starter-hooks-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A fake executable that records its name and arguments, then exits 0. */
function fakeTool(dir: string, name: string, log: string): void {
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\nprintf '%s %s\\n' '${name}' "$*" >> '${log}'\n`);
  chmodSync(file, 0o755);
}

function makeShim(): string {
  const r = spawnSync('sh', [join(repoRoot, 'tools/ci/hooks/pnpm-shim.sh'), repoRoot], {
    encoding: 'utf8',
  });
  expect(r.status, r.stderr).toBe(0);
  const shim = r.stdout.trim();
  dirs.push(shim);
  return shim;
}

function runShim(shim: string, path: string[]): { status: number | null; log: string } {
  const r = spawnSync(join(shim, 'pnpm'), ['--version'], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 15_000,
    // Only the PATH under test: no pnpm/corepack from the developer machine may leak in.
    env: { PATH: [shim, ...path, '/usr/bin', '/bin'].join(':'), HOME: tmpdir() },
  });
  expect(r.error, 'the launcher must terminate (no shim -> launcher -> shim loop)').toBeUndefined();
  return { status: r.status, log: r.stdout };
}

describe('git hook pnpm launcher', () => {
  it('falls through to npm exec of the packageManager version when no pnpm is installed', () => {
    const shim = makeShim();
    const bin = tempDir();
    const log = join(bin, 'calls.log');
    symlinkSync(process.execPath, join(bin, 'node'));
    fakeTool(bin, 'npm', log);
    const { status } = runShim(shim, [bin]);
    expect(status).toBe(0);
    expect(readFileSync(log, 'utf8').trim()).toBe(
      `npm exec --yes pnpm@${pnpmVersion} -- --version`,
    );
  });

  it('uses a real pnpm that sits behind the shim on PATH', () => {
    const shim = makeShim();
    const bin = tempDir();
    const log = join(bin, 'calls.log');
    fakeTool(bin, 'pnpm', log);
    const { status } = runShim(shim, [bin]);
    expect(status).toBe(0);
    expect(readFileSync(log, 'utf8').trim()).toBe('pnpm --version');
  });

  it('prefers corepack over npm exec when it exists', () => {
    const shim = makeShim();
    const bin = tempDir();
    const log = join(bin, 'calls.log');
    fakeTool(bin, 'corepack', log);
    fakeTool(bin, 'npm', log);
    const { status } = runShim(shim, [bin]);
    expect(status).toBe(0);
    expect(readFileSync(log, 'utf8').trim()).toBe('corepack pnpm --version');
  });

  it('never resolves the shim itself, even when STARTER_PNPM_SHIM_DIR is only set by the shim', () => {
    const shim = makeShim();
    expect(readFileSync(join(shim, 'pnpm'), 'utf8')).toContain(`STARTER_PNPM_SHIM_DIR='${shim}'`);
  });
});
