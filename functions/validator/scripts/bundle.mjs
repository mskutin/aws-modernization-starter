// Bundles the Lambda entry point into a single ESM file for deployment
// artefacts (dist/lambda/index.mjs, handler "index.handler"). CDK's
// NodejsFunction may instead bundle src/handler.ts itself.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/handler.ts'],
  outfile: 'dist/lambda/index.mjs',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  minify: true,
  sourcemap: true,
  legalComments: 'none',
  metafile: true,
  logLevel: 'warning',
  // Some CommonJS dependencies call require(); provide it inside the ESM bundle.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
});
const bytes = Object.values(result.metafile.outputs).reduce((sum, o) => sum + o.bytes, 0);
console.warn(`bundled dist/lambda/index.mjs (${(bytes / 1024).toFixed(0)} KiB incl. sourcemap)`);
