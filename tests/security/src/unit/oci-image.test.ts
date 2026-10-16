import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXIT, main } from '../container/cli.js';
import {
  checkImageConfig,
  imageConfigFromOciArchive,
  readTar,
  type ImageConfig,
} from '../container/oci-image.js';

/** Minimal USTAR writer for fixtures. */
function tar(files: Record<string, Buffer | string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    header.write('0000644\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
    header.write('00000000000\0', 136);
    header.write('0', 156);
    header.write('ustar\0', 257);
    header.write('00', 263);
    header.fill(' ', 148, 156);
    const sum = header.reduce((a, b) => a + b, 0);
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

const digest = (data: string) => `sha256:${createHash('sha256').update(data).digest('hex')}`;

function ociArchive(config: ImageConfig): string {
  const configJson = JSON.stringify({ architecture: 'arm64', os: 'linux', config });
  const manifest = JSON.stringify({
    schemaVersion: 2,
    config: { digest: digest(configJson) },
    layers: [],
  });
  const index = JSON.stringify({ schemaVersion: 2, manifests: [{ digest: digest(manifest) }] });
  const file = join(mkdtempSync(join(tmpdir(), 'starter-oci-')), 'image.oci.tar');
  writeFileSync(
    file,
    tar({
      'oci-layout': '{"imageLayoutVersion":"1.0.0"}',
      'index.json': index,
      [`blobs/${digest(manifest).replace(':', '/')}`]: manifest,
      [`blobs/${digest(configJson).replace(':', '/')}`]: configJson,
    }),
  );
  return file;
}

const GOOD: ImageConfig = {
  User: '65532:65532',
  Entrypoint: ['/nodejs/bin/node'],
  Cmd: ['dist/server.js'],
  Env: ['NODE_ENV=production', 'PORT=8080'],
  ExposedPorts: { '8080/tcp': {} },
  Labels: { 'org.opencontainers.image.revision': 'abc', 'org.opencontainers.image.source': 'x' },
};

describe('built image config checks', () => {
  let logs: string[] = [];
  beforeEach(() => {
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void logs.push(a.join(' ')));
  });
  afterEach(() => vi.restoreAllMocks());

  it('reads the config through index → manifest → config from an OCI archive', () => {
    expect(imageConfigFromOciArchive(ociArchive(GOOD))).toEqual(GOOD);
    expect(
      readTar(tar({ a: 'x', 'dir/b': 'yy' }))
        .get('dir/b')
        ?.toString(),
    ).toBe('yy');
  });

  it('accepts the hardened API image shape', () => {
    expect(checkImageConfig(GOOD)).toEqual([]);
    expect(main(['--archive', ociArchive(GOOD)])).toBe(EXIT.OK);
  });

  it.each([
    ['root', { User: 'root' }],
    ['root with a group', { User: 'root:65532' }],
    ['uid 0', { User: '0' }],
    ['unset user', { User: '' }],
    ['named user (may map to uid 0)', { User: 'node' }],
    ['root group', { User: '65532:0' }],
    ['shell entrypoint', { Entrypoint: ['/bin/sh', '-c'], Cmd: ['node dist/server.js'] }],
    ['credential ENV name', { Env: ['DB_PASSWORD=x'] }],
    ['secret-looking ENV value', { Env: [`NOTE=postgres://u:${'pw'}@db/x`] }],
    ['extra port', { ExposedPorts: { '8080/tcp': {}, '9229/tcp': {} } }],
    ['missing provenance label', { Labels: {} }],
  ])('rejects %s', (_name, override) => {
    const config = { ...GOOD, ...override } as ImageConfig;
    expect(checkImageConfig(config)).not.toEqual([]);
    expect(main(['--archive', ociArchive(config)])).toBe(EXIT.PROBLEMS);
  });

  it('usage errors exit 2', () => {
    expect(main([])).toBe(EXIT.USAGE);
    expect(main(['--archive', join(tmpdir(), 'does-not-exist.tar')])).toBe(EXIT.USAGE);
  });
});
