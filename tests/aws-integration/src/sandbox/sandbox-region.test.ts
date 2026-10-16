/**
 * The sandbox lifecycle's region (sandbox/_lib.sh): SANDBOX_REGION, default ap-southeast-1, any
 * aws-partition region; a run is always handled in the region it was deployed to (run.env REGION).
 * Sources the real _lib.sh in bash; nothing touches AWS.
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const LIB = fileURLToPath(new URL('../../sandbox/_lib.sh', import.meta.url));

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'starter-sbx-region-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function run(script: string, env: Record<string, string> = {}) {
  return new Promise<{ code: number | null; out: string }>((resolve, reject) => {
    const child = spawn(
      'bash',
      ['-c', `set -euo pipefail; source ${JSON.stringify(LIB)}; ${script}`],
      {
        env: { PATH: process.env['PATH'] ?? '', HOME: home, SANDBOX_HOME: home, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    child.stderr.on('data', (c: Buffer) => (out += c.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out }));
  });
}

describe('sandbox lifecycle region', () => {
  it('defaults to ap-southeast-1 and accepts another aws-partition region', async () => {
    const def = await run('sbx_check_region; printf "REGION=%s\\n" "$SBX_REGION"');
    expect(def.code, def.out).toBe(0);
    expect(def.out).toContain('REGION=ap-southeast-1');
    const other = await run('sbx_check_region; printf "REGION=%s|%s\\n" "$SBX_REGION" "$SBX_AWS"', {
      SANDBOX_REGION: 'eu-west-1',
    });
    expect(other.code, other.out).toBe(0);
    expect(other.out).toMatch(/REGION=eu-west-1\|.* --region eu-west-1 /);
  });

  it.each(['cn-north-1', 'us-gov-west-1', 'eu-west-1a', 'Nowhere', ''])(
    'refuses SANDBOX_REGION=%j (exit 4)',
    async (region) => {
      const r = await run('sbx_check_region; echo RAN', { SANDBOX_REGION: region });
      if (region === '') {
        // Empty means unset: the default applies.
        expect(r.code, r.out).toBe(0);
        return;
      }
      expect(r.code, r.out).toBe(4);
      expect(r.out).toMatch(/SANDBOX_REGION is not an aws-partition region name/);
      expect(r.out).not.toContain('RAN');
    },
  );

  it('refuses to handle a run in another region than the one it was deployed to', async () => {
    const runDir = join(home, 'runs', 'sbx-0a1b2c');
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, 'run.env'), 'RUN_ID=sbx-0a1b2c\nREGION=ap-southeast-1\n');
    const script = `RUN_ID=sbx-0a1b2c; RUN_DIR=${JSON.stringify(runDir)}; sbx_check_region; echo RAN`;
    const same = await run(script);
    expect(same.code, same.out).toBe(0);
    const other = await run(script, { SANDBOX_REGION: 'eu-west-1' });
    expect(other.code, other.out).toBe(4);
    expect(other.out).toMatch(
      /run sbx-0a1b2c was deployed in ap-southeast-1, not eu-west-1: set SANDBOX_REGION=ap-southeast-1/,
    );
    expect(other.out).not.toContain('RAN');
  });
});
