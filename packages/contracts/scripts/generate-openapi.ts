/**
 * Regenerates `openapi/v1.json` from the zod contracts.
 * Usage: pnpm --filter @starter/contracts run openapi:generate
 */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as prettier from 'prettier';
import { buildOpenApiDocument } from '../src/v1/openapi.js';

const target = fileURLToPath(new URL('../openapi/v1.json', import.meta.url));
const options = (await prettier.resolveConfig(target)) ?? {};
const formatted = await prettier.format(JSON.stringify(buildOpenApiDocument()), {
  ...options,
  parser: 'json',
});
await writeFile(target, formatted, 'utf8');
console.warn(`wrote ${target}`);
