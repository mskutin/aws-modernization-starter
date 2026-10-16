/**
 * Records which sources dist/ was built from (run by `build` after tsc). guard-cli.js refuses to
 * run from dist/ when the current src/ no longer matches (stale build, exit 17).
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toolSourceSha256 } from '../src/provenance.ts';

const toolDir = fileURLToPath(new URL('..', import.meta.url));
const file = join(toolDir, 'dist', 'build-info.json');
writeFileSync(file, `${JSON.stringify({ sourceSha256: toolSourceSha256(toolDir) })}\n`);
console.log(`wrote dist/build-info.json`);
