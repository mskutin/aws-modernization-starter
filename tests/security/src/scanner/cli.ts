#!/usr/bin/env node
/**
 * starter-leak-scan — scan CI artifacts / local reports for leaked secrets and canaries.
 *
 *   node tests/security/dist/scanner/cli.js --dir reports [--dir more] \
 *        [--secret-env DB_PASSWORD]... [--canaries file.json]... [--report out.json] [--max-bytes n]
 *
 * Exit codes: 0 = no findings, 1 = findings, 2 = usage error (bad arguments, missing directory).
 * Output never contains a matched value, only a redacted preview, so it can be published.
 */
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { SECRET_PATTERNS, type NamedValue } from '../leaks.js';
import { DEFAULT_MAX_BYTES, loadCanaryFile, scanDirectories, type ScanReport } from './scan.js';

export const EXIT = { OK: 0, FINDINGS: 1, USAGE: 2 } as const;

const USAGE = `starter-leak-scan --dir <path> [--dir <path>]... [options]
  --dir <path>          directory or file to scan (repeatable; required)
  --secret-env <NAME>   also flag the value of environment variable NAME (repeatable; unset = ignored)
  --canaries <file>     extra canaries file (repeatable); canaries.json files under --dir are always used
  --report <file>       write the JSON report
  --max-bytes <n>       skip larger files (default ${DEFAULT_MAX_BYTES})
Patterns: ${SECRET_PATTERNS.map((p) => p.id).join(', ')}`;

export function main(argv: string[], env: NodeJS.ProcessEnv = process.env): number {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        dir: { type: 'string', multiple: true },
        'secret-env': { type: 'string', multiple: true },
        canaries: { type: 'string', multiple: true },
        report: { type: 'string' },
        'max-bytes': { type: 'string' },
        help: { type: 'boolean' },
      },
    }));
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return EXIT.USAGE;
  }
  if (values.help) {
    console.log(USAGE);
    return EXIT.OK;
  }
  const dirs = values.dir ?? [];
  const missing = dirs.filter((d) => !existsSync(d));
  if (dirs.length === 0 || missing.length > 0) {
    console.error(
      `${dirs.length === 0 ? '--dir is required' : `not found: ${missing.join(', ')}`}\n\n${USAGE}`,
    );
    return EXIT.USAGE;
  }
  const maxBytes = values['max-bytes'] ? Number(values['max-bytes']) : DEFAULT_MAX_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    console.error('--max-bytes must be a positive integer');
    return EXIT.USAGE;
  }
  const secrets: NamedValue[] = (values['secret-env'] ?? []).flatMap((name) => {
    const value = env[name];
    return value ? [{ label: name, value }] : [];
  });
  let report: ScanReport;
  try {
    const canaries = (values.canaries ?? []).flatMap((f) => loadCanaryFile(f));
    report = scanDirectories(dirs, { secrets, canaries, maxBytes });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return EXIT.USAGE;
  }
  for (const f of report.findings) {
    console.log(`[LEAK] ${f.kind} ${f.file}:${f.line} ${f.preview}`);
  }
  for (const s of report.skipped) console.log(`[SKIP] ${s.file}: ${s.reason}`);
  console.log(
    `starter-leak-scan: ${report.findings.length === 0 ? 'PASSED' : 'FAILED'} files=${report.scannedFiles} skipped=${report.skipped.length} ` +
      `findings=${report.findings.length} canaries=${report.canaryCount} (from ${report.canarySources.length} file(s)) ` +
      `secret-values=${secrets.length}`,
  );
  if (values.report) {
    mkdirSync(dirname(values.report), { recursive: true });
    writeFileSync(values.report, JSON.stringify(report, null, 2));
  }
  return report.findings.length === 0 ? EXIT.OK : EXIT.FINDINGS;
}

const invokedDirectly = (() => {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invokedDirectly) process.exit(main(process.argv.slice(2)));
