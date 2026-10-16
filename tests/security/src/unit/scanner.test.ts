import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXIT, main } from '../scanner/cli.js';
import { scanDirectories } from '../scanner/scan.js';

const pem = ['-----BEGIN', 'EC PRIVATE KEY-----'].join(' ');

function artifacts(): string {
  const dir = mkdtempSync(join(tmpdir(), 'starter-leak-scan-'));
  mkdirSync(join(dir, 'security', 'run1'), { recursive: true });
  mkdirSync(join(dir, 'junit'), { recursive: true });
  writeFileSync(join(dir, 'junit', 'clean.xml'), '<testsuite tests="1" failures="0"/>');
  writeFileSync(
    join(dir, 'security', 'run1', 'canaries.json'),
    JSON.stringify({
      runId: 'run1',
      canaries: [{ label: 'direct:token', value: 'cnry~0011~2233' }],
    }),
  );
  return dir;
}

describe('artifact leakage scanner', () => {
  let logs: string[] = [];
  beforeEach(() => {
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void logs.push(a.join(' ')));
  });
  afterEach(() => vi.restoreAllMocks());

  it('passes clean artifacts; canary files are loaded, not scanned', () => {
    const dir = artifacts();
    const report = scanDirectories([dir]);
    expect(report.findings).toEqual([]);
    expect(report.canaryCount).toBe(1);
    expect(report.scannedFiles).toBe(1);
    expect(main(['--dir', dir])).toBe(EXIT.OK);
  });

  it('finds canaries, secret formats and explicit secret values in nested files', () => {
    const dir = artifacts();
    writeFileSync(
      join(dir, 'security', 'run1', 'api-direct.log'),
      `{"msg":"x","title":"cnry~0011~2233"}\n`,
    );
    writeFileSync(join(dir, 'junit', 'leaky.xml'), `<failure>${pem}</failure>`);
    writeFileSync(join(dir, 'env.txt'), 'DB_PASSWORD=not-a-real-pw-123');
    const report = scanDirectories([dir], {
      secrets: [{ label: 'DB_PASSWORD', value: 'not-a-real-pw-123' }],
    });
    expect(report.findings.map((f) => f.kind).sort()).toEqual([
      'canary:direct:token',
      'private-key',
      'secret:DB_PASSWORD',
    ]);
  });

  it('CLI: exit 1 on findings, report without the leaked values; exit 2 on usage errors', () => {
    const dir = artifacts();
    writeFileSync(join(dir, 'api.log'), 'password not-a-real-pw-123 leaked');
    const out = join(dir, 'out', 'scan.json');
    expect(
      main(['--dir', dir, '--secret-env', 'SECTEST_UNIT_PW', '--report', out], {
        SECTEST_UNIT_PW: 'not-a-real-pw-123',
      }),
    ).toBe(EXIT.FINDINGS);
    const report = readFileSync(out, 'utf8');
    expect(report).toContain('secret:SECTEST_UNIT_PW');
    expect(report).not.toContain('not-a-real-pw-123');
    expect(logs.join('\n')).not.toContain('not-a-real-pw-123');
    expect(main([])).toBe(EXIT.USAGE);
    expect(main(['--dir', join(dir, 'missing')])).toBe(EXIT.USAGE);
  });

  it('skips binary and oversized files visibly', () => {
    const dir = artifacts();
    writeFileSync(join(dir, 'image.png'), Buffer.from([0x89, 0x50, 0x00, 0x47]));
    writeFileSync(join(dir, 'big.log'), 'x'.repeat(2048));
    const report = scanDirectories([dir], { maxBytes: 1024 });
    expect(report.skipped.map((s) => s.reason).sort()).toEqual([
      'binary',
      'larger than 1024 bytes',
    ]);
  });
});
