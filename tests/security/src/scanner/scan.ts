/**
 * Artifact leakage scanner: walks directories of CI artifacts / local reports (JUnit XML, logs,
 * JSON reports) and reports secret formats, explicit secret values and per-run canaries.
 *
 * Canary sources are `canaries.json` files written by the security suite
 * (`{ "runId": "...", "canaries": [{ "label": "...", "value": "..." }] }`); they are loaded, never
 * scanned. Binary files and files above the size limit are skipped and listed as such, so a skip
 * is visible in the report instead of silently passing.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { findLeaks, type LeakFinding, type NamedValue } from '../leaks.js';

export const CANARY_FILE = 'canaries.json';
export const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const SKIP_DIRS = new Set(['node_modules', '.git']);

export interface ScanOptions {
  secrets?: readonly NamedValue[];
  /** Additional canaries (besides those found in `canaries.json` files). */
  canaries?: readonly NamedValue[];
  maxBytes?: number;
}

export interface FileFinding extends LeakFinding {
  file: string;
}

export interface ScanReport {
  roots: string[];
  scannedFiles: number;
  skipped: { file: string; reason: string }[];
  canarySources: string[];
  canaryCount: number;
  findings: FileFinding[];
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(join(dir, entry.name));
    } else if (entry.isFile()) {
      yield join(dir, entry.name);
    }
  }
}

/** A NUL byte in the first 8 KiB marks a binary file. */
const isBinary = (buf: Buffer) => buf.subarray(0, 8192).includes(0);

export function loadCanaryFile(file: string): NamedValue[] {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { canaries?: unknown };
  if (!Array.isArray(parsed.canaries)) throw new Error(`${file}: "canaries" must be an array`);
  return parsed.canaries.flatMap((c: unknown) => {
    const item = c as { label?: unknown; value?: unknown };
    return typeof item.label === 'string' && typeof item.value === 'string'
      ? [{ label: item.label, value: item.value }]
      : [];
  });
}

export function scanDirectories(roots: readonly string[], options: ScanOptions = {}): ScanReport {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const files = roots.flatMap((root) =>
    statSync(root).isDirectory() ? [...walk(root)].map((f) => ({ root, f })) : [{ root, f: root }],
  );
  const canarySources = files.filter(({ f }) => f.endsWith(`/${CANARY_FILE}`) || f === CANARY_FILE);
  const canaries = [
    ...(options.canaries ?? []),
    ...canarySources.flatMap(({ f }) => loadCanaryFile(f)),
  ];
  const report: ScanReport = {
    roots: [...roots],
    scannedFiles: 0,
    skipped: [],
    canarySources: canarySources.map(({ f }) => f),
    canaryCount: canaries.length,
    findings: [],
  };
  for (const { root, f } of files) {
    if (canarySources.some((c) => c.f === f)) continue;
    const display = relative(process.cwd(), f) || relative(root, f) || f;
    const size = statSync(f).size;
    if (size > maxBytes) {
      report.skipped.push({ file: display, reason: `larger than ${maxBytes} bytes` });
      continue;
    }
    const buf = readFileSync(f);
    if (isBinary(buf)) {
      report.skipped.push({ file: display, reason: 'binary' });
      continue;
    }
    report.scannedFiles++;
    for (const finding of findLeaks(buf.toString('utf8'), {
      secrets: options.secrets ?? [],
      canaries,
    })) {
      report.findings.push({ ...finding, file: display });
    }
  }
  return report;
}
