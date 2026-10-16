#!/usr/bin/env node
/**
 * starter-image-check — security checks on a built image's config (see oci-image.ts).
 *
 *   node tests/security/dist/container/cli.js --archive oci-out/api/image.oci.tar [--report f.json]
 *
 * Exit codes: 0 compliant, 1 problems found, 2 usage error (missing or unreadable archive).
 */
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { checkImageConfig, imageConfigFromOciArchive } from './oci-image.js';

export const EXIT = { OK: 0, PROBLEMS: 1, USAGE: 2 } as const;

export function main(argv: string[]): number {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { archive: { type: 'string' }, report: { type: 'string' } },
    }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return EXIT.USAGE;
  }
  if (!values.archive) {
    console.error('usage: starter-image-check --archive <image.oci.tar> [--report <file.json>]');
    return EXIT.USAGE;
  }
  let config: ReturnType<typeof imageConfigFromOciArchive>;
  try {
    config = imageConfigFromOciArchive(values.archive);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return EXIT.USAGE;
  }
  const user = config.User ?? '';
  const problems = checkImageConfig(config);
  for (const p of problems) console.log(`[IMAGE] ${p}`);
  console.log(
    `starter-image-check: ${problems.length === 0 ? 'PASSED' : 'FAILED'} ${values.archive} (User ${user || '<unset>'})`,
  );
  if (values.report) {
    mkdirSync(dirname(values.report), { recursive: true });
    writeFileSync(
      values.report,
      JSON.stringify({ archive: values.archive, user, problems }, null, 2),
    );
  }
  return problems.length === 0 ? EXIT.OK : EXIT.PROBLEMS;
}

const invokedDirectly = (() => {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invokedDirectly) process.exit(main(process.argv.slice(2)));
