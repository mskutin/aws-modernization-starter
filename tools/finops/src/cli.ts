/**
 * starter-finops CLI.
 *
 *   starter-finops check --base <cdk.out of target branch> --head <cdk.out of MR>
 *   starter-finops diff  ...same options; report only, never fails on thresholds
 *
 * Exit codes: 0 = passed (no approval needed, or approved), 1 = approval
 * required but missing, 2 = usage/configuration error.
 */
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { budgetCoverage } from './budgets.js';
import {
  ConfigError,
  DEFAULT_REGION,
  DEFAULT_THRESHOLDS,
  DEFAULT_USAGE,
  assertPriceTableRegion,
  loadPriceTable,
  loadPriceTableForRegion,
  loadThresholds,
  loadUsage,
  type PriceTable,
} from './config.js';
import { diffTemplates } from './diff.js';
import { estimate } from './estimate.js';
import { decide, readApproval } from './gate.js';
import { buildReport, toMarkdown, writeReports } from './report.js';
import { findTemplateFiles, loadTemplates, regionsOfAssembly } from './templates.js';

export const EXIT = { OK: 0, APPROVAL_REQUIRED: 1, USAGE: 2 } as const;

const USAGE = `starter-finops <check|diff> --head <dir> [--base <dir>] [options]

  --head <dir>         synthesized templates of the merge request (cdk.out)
  --base <dir>         synthesized templates of the target branch; missing/empty = everything is new
  --region <region>    region of the templates (default: the region the head cloud assembly's
                       stacks are pinned to, else ${DEFAULT_REGION}); must agree with the assembly
  --prices <file>      price table (default tools/finops/pricing/<region>.yaml; a region without
                       one is refused: prices are never taken from another region)
  --usage <file>       usage assumptions (default tools/finops/assumptions/usage.yaml)
  --thresholds <file>  approval thresholds (default tools/finops/thresholds.yaml)
  --out <dir>          report directory (default <repo>/reports/finops)
  --quiet              do not print the markdown summary

Approval signals (check): MR label in CI_MERGE_REQUEST_LABELS, or <approvalVariable>=true when configured.
Exit codes: 0 passed, 1 approval required but missing (check only), 2 usage/config error.
`;

const userPath = (p: string) =>
  isAbsolute(p) ? p : resolve(process.env['INIT_CWD'] ?? process.cwd(), p);

function repoRoot(start: string): string {
  let dir = start;
  while (!existsSync(join(dir, 'pnpm-workspace.yaml'))) {
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
  return dir;
}

/**
 * Region of one side's templates: the regions its cloud assembly manifests pin the stacks to.
 * An explicit `--region` must agree with them; templates spanning several regions are refused
 * (one price table per run); no manifest region falls back to `fallback` (the head's region, or
 * DEFAULT_REGION).
 */
function resolveRegion(
  dir: string,
  explicit: string | undefined,
  side: 'head' | 'base',
  fallback: string = DEFAULT_REGION,
): string {
  const found = regionsOfAssembly(dir);
  if (found.length > 1) {
    throw new ConfigError(
      `the ${side} templates span several regions (${found.join(', ')}); run finops once per region`,
    );
  }
  if (explicit !== undefined && found.length === 1 && found[0] !== explicit) {
    throw new ConfigError(
      `--region ${explicit} does not match the ${side} cloud assembly, whose stacks are in ${found[0]}`,
    );
  }
  return explicit ?? found[0] ?? fallback;
}

export function main(argv: string[], env: NodeJS.ProcessEnv = process.env, now?: Date): number {
  const [command, ...raw] = argv;
  // pnpm forwards a literal `--` (`pnpm run x -- --flag`); tolerate it.
  const rest = raw[0] === '--' ? raw.slice(1) : raw;
  if (command !== 'check' && command !== 'diff') {
    console.log(USAGE);
    return command === '--help' || command === '-h' ? EXIT.OK : EXIT.USAGE;
  }
  try {
    const { values } = parseArgs({
      args: rest,
      options: {
        base: { type: 'string' },
        head: { type: 'string' },
        prices: { type: 'string' },
        region: { type: 'string' },
        usage: { type: 'string' },
        thresholds: { type: 'string' },
        out: { type: 'string' },
        quiet: { type: 'boolean', default: false },
      },
    });
    if (!values.head) throw new ConfigError('--head is required');
    const headDir = userPath(values.head);
    if (findTemplateFiles(headDir).length === 0) {
      throw new ConfigError(`no *.template.json under --head ${headDir} (run cdk synth first)`);
    }
    const baseDir = values.base ? userPath(values.base) : undefined;
    const region = resolveRegion(headDir, values.region, 'head');
    const baseRegion = baseDir ? resolveRegion(baseDir, undefined, 'base', region) : region;
    let prices: PriceTable;
    if (values.prices) {
      const file = userPath(values.prices);
      prices = assertPriceTableRegion(loadPriceTable(file), region, file);
    } else {
      prices = loadPriceTableForRegion(region);
    }
    // A region move prices each side with its own region's table (never one for both).
    const basePrices = baseRegion === region ? prices : loadPriceTableForRegion(baseRegion);
    const usage = loadUsage(values.usage ? userPath(values.usage) : DEFAULT_USAGE);
    const thresholds = loadThresholds(
      values.thresholds ? userPath(values.thresholds) : DEFAULT_THRESHOLDS,
    );

    const base = baseDir ? loadTemplates(baseDir) : new Map();
    const head = loadTemplates(headDir);
    if (base.size === 0) {
      console.warn('[finops] no base templates: every resource is reported as new.');
    }
    const diff = diffTemplates(base, head);
    const baseEstimate = estimate(base, basePrices, usage);
    const headEstimate = estimate(head, prices, usage);
    const decision = decide(
      diff,
      baseEstimate,
      headEstimate,
      thresholds,
      readApproval(thresholds, env),
    );
    const report = buildReport({
      decision,
      diff,
      base: baseEstimate,
      head: headEstimate,
      budgets: budgetCoverage(head, headEstimate),
      thresholds,
      prices,
      ...(basePrices !== prices ? { basePrices } : {}),
      usage,
      ...(now ? { now } : {}),
    });
    const out = values.out
      ? userPath(values.out)
      : join(repoRoot(dirname(DEFAULT_THRESHOLDS)), 'reports', 'finops');
    const files = writeReports(report, out);
    if (!values.quiet) console.log(toMarkdown(report));
    console.log(`finops: reports written to ${files.join(', ')}`);
    if (command === 'diff') return EXIT.OK;
    return decision.passed ? EXIT.OK : EXIT.APPROVAL_REQUIRED;
  } catch (e) {
    console.error(`finops: ${e instanceof Error ? e.message : String(e)}`);
    return EXIT.USAGE;
  }
}
