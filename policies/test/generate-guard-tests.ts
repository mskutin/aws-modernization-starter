/** Regenerates policies/guard/rules/tests/*_tests.yaml from the shared rule fixtures. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { format, resolveConfig } from 'prettier';
import { stringify } from 'yaml';
import { GUARD_TESTS_DIR } from '../src/guard/layout.js';
import { GUARD_TESTS_HEADER, buildGuardTests } from './guard-test-model.js';

mkdirSync(GUARD_TESTS_DIR, { recursive: true });
for (const [file, cases] of buildGuardTests()) {
  const path = join(GUARD_TESTS_DIR, `${file}_tests.yaml`);
  const options = (await resolveConfig(path)) ?? {};
  const text = await format(GUARD_TESTS_HEADER + stringify(cases, { lineWidth: 0 }), {
    ...options,
    parser: 'yaml',
  });
  writeFileSync(path, text);
  console.log(`wrote ${path} (${cases.length} cases)`);
}
