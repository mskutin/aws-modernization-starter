// Bundles the TEST-ONLY IdP into self-contained ESM files for its container image
// (dist/bundle/server.mjs, dist/bundle/healthcheck.mjs): no node_modules at runtime.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
await build({
  absWorkingDir: root,
  entryPoints: { server: 'src/server.ts', healthcheck: 'src/healthcheck.ts' },
  outdir: 'dist/bundle',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  minify: false,
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'warning',
});
console.warn('bundled dist/bundle/{server,healthcheck}.mjs');
