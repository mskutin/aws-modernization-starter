/**
 * starter-aws-sandbox — live sandbox FinOps, inventory and teardown verification.
 *
 *   estimate      --phase 1|2 [--hours n]... [--synth <cdk.out>] [--region r] [stop-rule options] [--out f] [--markdown f]
 *   inventory     --run-id <id> [--phase 1|2] --out <file> [--markdown f] [--synth <cdk.out>] [AWS options]
 *   verify-clean  --run-id <id> [--inventory f] [--include-bootstrap] [--strict] [--baseline f] [--since iso] --out <file> [AWS options]
 *   reconcile     --estimate <estimate.json> --billed <billed.json> [--hours n] [--out f] [--markdown f]
 *   reconcile     --template --run-id <id> --phase 1|2 --out <billed.json>
 *   render        --in <report.json> [--out <file.md>]
 *   schema        [--kind <name>] [--write]
 *   iam-policy    (prints the read-only IAM actions this tool needs)
 *
 * AWS options (inventory, verify-clean): --profile (starter-sandbox-developer) --region (default
 *   ap-southeast-1; only a region with committed sandbox price data, see `sandboxRegions`; AWS_REGION /
 *   AWS_DEFAULT_REGION, when set, must equal it)
 *   --expected-account-file (${SANDBOX_HOME:-~/.config/starter-aws-sandbox}/expected-account)
 *   --guard-cli (tools/aws-preflight/dist/guard-cli.js) --guard-log <file.jsonl> --aws-cli <path>
 *   --timeout-seconds <n per call>
 *
 * Exit codes: 0 ok / clean; 1 not clean (verify-clean) or stop rule reached (reconcile);
 * 2 usage or input error; 3 refused (account guard, CI, ambient credentials); 4 incomplete
 * (a read failed, a listing was truncated, or a tagged resource type is not swept);
 * 5 clean-with-unverifiable (verify-clean: nothing found, but the role could not list every
 * category — each one is named in the report with its fallback evidence).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import type { z } from 'zod';
import { iamPolicyDocument } from './aws/allowlist.js';
import {
  ALLOWED_REGIONS,
  AwsCliRefused,
  BoundaryViolation,
  createAwsCli,
  parentEnvProblems,
  resolveAwsCli,
  type AwsCli,
  type ProcessRunner,
} from './aws/executor.js';
import { DEFAULT_GUARD_CLI, GuardRefused, GuardSession } from './aws/guard.js';
import { CredentialsError, GuardedSession } from './aws/session.js';
import { buildInventory, experimentResourcesOf, inventoryEvidence } from './inventory.js';
import { assertNoSecrets, LeakError, maskDeep } from './mask.js';
import { RUN_ID_RE } from './match.js';
import { DEFAULTS, estimate, type Estimate, type EstimateOptions } from './model/estimate.js';
import { DEFAULT_REGION, regionsOfAssembly } from '@starter/tool-finops';
import { loadPriceBook, PACKAGE_ROOT, PriceBookError, type PriceBook } from './model/prices.js';
import {
  contractTopology,
  loadSynthStacks,
  synthTopology,
  SynthError,
  type Phase,
} from './model/topology.js';
import { billedTemplate, reconcile } from './reconcile.js';
import { renderAny, renderEstimate } from './render.js';
import {
  billedInputSchema,
  estimateSchema,
  inventorySchema,
  jsonSchemaFor,
  reconciliationSchema,
  SCHEMAS,
  verifyReportSchema,
  type SchemaName,
} from './schemas.js';
import { loadBaseline, verifyClean } from './verify.js';

export const EXIT = {
  OK: 0,
  NOT_CLEAN: 1,
  USAGE: 2,
  REFUSED: 3,
  INCOMPLETE: 4,
  CLEAN_WITH_UNVERIFIABLE: 5,
} as const;

export interface Deps {
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly now?: () => Date;
  /** AWS CLI process runner (tests inject a fake). */
  readonly awsRunner?: ProcessRunner;
  /** Guard process runner (tests inject a fake). */
  readonly guardRunner?: ProcessRunner;
  readonly stdout?: (s: string) => void;
  readonly stderr?: (s: string) => void;
}

class UsageError extends Error {
  override name = 'UsageError';
}

const USAGE = `usage: starter-aws-sandbox <estimate|inventory|verify-clean|reconcile|render|schema|iam-policy> [options]
  see the header of tools/aws-sandbox/src/cli.ts or tools/aws-sandbox/README.md`;

const COMMON_OPTIONS = {
  out: { type: 'string' },
  markdown: { type: 'string' },
  quiet: { type: 'boolean', default: false },
} as const;

const ESTIMATE_OPTIONS = {
  phase: { type: 'string' },
  hours: { type: 'string', multiple: true },
  synth: { type: 'string' },
  'stack-prefix': { type: 'string' },
  spent: { type: 'string' },
  'stop-usd': { type: 'string' },
  'budget-usd': { type: 'string' },
  'margin-percent': { type: 'string' },
  'tax-rate-percent': { type: 'string' },
  'account-level-usd': { type: 'string' },
  'time-box-hours': { type: 'string' },
  prices: { type: 'string' },
  supplement: { type: 'string' },
  /** Price data region (estimate; AWS commands pin it with AWS_OPTIONS.region). */
  region: { type: 'string' },
} as const;

const AWS_OPTIONS = {
  'run-id': { type: 'string' },
  profile: { type: 'string', default: 'starter-sandbox-developer' },
  region: { type: 'string', default: DEFAULT_REGION },
  'expected-account-file': { type: 'string' },
  'guard-cli': { type: 'string' },
  'guard-log': { type: 'string' },
  'aws-cli': { type: 'string' },
  'timeout-seconds': { type: 'string', default: '120' },
  'guard-max-age-seconds': { type: 'string', default: '0' },
} as const;

const numberOpt = (v: string | undefined, name: string, fallback?: number): number | undefined => {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new UsageError(`--${name} must be a non-negative number`);
  return n;
};

const phaseOpt = (v: string | undefined, runId?: string): Phase => {
  if (v === '1' || v === '2') return Number(v) as Phase;
  if (v !== undefined) throw new UsageError('--phase must be 1 or 2');
  if (runId?.startsWith('sbx-')) return 2;
  if (runId?.startsWith('it-')) return 1;
  throw new UsageError('--phase is required (it cannot be inferred from the run id)');
};

const sandboxHome = (env: NodeJS.ProcessEnv) =>
  env['SANDBOX_HOME'] ?? join(env['HOME'] ?? homedir(), '.config', 'starter-aws-sandbox');

const sha256Of = (file: string): string | null => {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
};

/** Masks, validates against the output schema, refuses secret-shaped content, then writes. */
type Literal = { readonly label: string; readonly value: string };

const REPO_ROOT = resolve(PACKAGE_ROOT, '..', '..');

/** The operator's home directory (as given and resolved): never written to evidence. */
function homeDirs(env: NodeJS.ProcessEnv): string[] {
  const home = env['HOME'];
  if (!home || home.length < 5) return [];
  try {
    return [...new Set([home, realpathSync(home)])];
  } catch {
    return [home];
  }
}

/** Repository-relative or `~/…` path for evidence (no local user name in reports). */
function displayPath(path: string, deps: Deps): string {
  const abs = resolve(deps.cwd, path);
  if (abs === REPO_ROOT || abs.startsWith(`${REPO_ROOT}${sep}`)) {
    return relative(REPO_ROOT, abs) || '.';
  }
  for (const home of homeDirs(deps.env)) {
    if (abs === home || abs.startsWith(`${home}${sep}`)) return `~${abs.slice(home.length)}`;
  }
  return abs;
}

/**
 * Values that must never appear in a report: the run's origin-verify value and issuer private key
 * component (read from the run directory when present; never printed) and the home directory.
 */
function leakLiterals(deps: Deps, runId?: string): Literal[] {
  const literals: Literal[] = homeDirs(deps.env).map((value) => ({
    label: "the operator's home directory path",
    value,
  }));
  if (!runId) return literals;
  const runDir = join(sandboxHome(deps.env), 'runs', runId);
  try {
    const v = readFileSync(join(runDir, 'origin-verify'), 'utf8').trim();
    if (v.length >= 8) literals.push({ label: "the run's origin-verify value", value: v });
  } catch {
    // no run directory / no value: nothing to add
  }
  try {
    const jwk = JSON.parse(readFileSync(join(runDir, 'issuer-key.jwk'), 'utf8')) as { d?: unknown };
    if (typeof jwk.d === 'string' && jwk.d.length >= 8) {
      literals.push({ label: "the run's issuer private key", value: jwk.d });
    }
  } catch {
    // absent or unreadable: nothing to add
  }
  return literals;
}

function writeReport<T>(
  file: string,
  value: NoInfer<T>,
  schema: z.ZodType<T>,
  what: string,
  literals: readonly Literal[] = [],
): T {
  const masked = maskDeep(value);
  const parsed = schema.safeParse(masked);
  if (!parsed.success) {
    throw new Error(
      `internal error: ${what} does not match its schema:\n` +
        parsed.error.issues
          .slice(0, 10)
          .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
          .join('\n'),
    );
  }
  const text = `${JSON.stringify(parsed.data, null, 2)}\n`;
  assertNoSecrets(text, what, literals);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return parsed.data;
}

function writeText(
  file: string,
  text: string,
  what: string,
  literals: readonly Literal[] = [],
): void {
  assertNoSecrets(text, what, literals);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/**
 * Region of the price book: `--region`, else the region the `--synth` cloud assembly's stacks are
 * pinned to, else DEFAULT_REGION. A `--region` that disagrees with `--synth` is refused; a region
 * without committed price data fails closed in `loadPriceBook` (naming the missing files).
 */
function bookRegion(
  values: { region?: string | undefined; synth?: string | undefined },
  cwd: string,
): string {
  const found = values.synth ? regionsOfAssembly(resolve(cwd, values.synth)) : [];
  if (found.length > 1) {
    throw new UsageError(`--synth spans several regions (${found.join(', ')})`);
  }
  if (values.region !== undefined && found.length === 1 && found[0] !== values.region) {
    throw new UsageError(
      `--region ${values.region} does not match --synth, whose stacks are in ${found[0]}`,
    );
  }
  return values.region ?? found[0] ?? DEFAULT_REGION;
}

function loadBook(
  values: {
    prices?: string | undefined;
    supplement?: string | undefined;
    region?: string | undefined;
    synth?: string | undefined;
  },
  cwd: string,
): PriceBook {
  return loadPriceBook({
    region: bookRegion(values, cwd),
    snapshotFile: values.prices ? resolve(cwd, values.prices) : undefined,
    supplementFile: values.supplement ? resolve(cwd, values.supplement) : undefined,
  });
}

function buildEstimate(
  values: Record<string, string | string[] | boolean | undefined>,
  phase: Phase,
  book: PriceBook,
  deps: Deps,
  now: Date,
): Estimate {
  const cwd = deps.cwd;
  const displayRef = (p: string) => displayPath(p, deps);
  const synth = values['synth'] as string | undefined;
  const synthTopo = synth
    ? synthTopology(resolve(cwd, synth), phase, values['stack-prefix'] as string | undefined)
    : undefined;
  const topology = synthTopo
    ? { ...synthTopo, basis: { ...synthTopo.basis, ref: displayRef(synthTopo.basis.ref) } }
    : contractTopology(phase);
  const hours = ((values['hours'] as string[] | undefined) ?? []).map(
    (h) => numberOpt(h, 'hours') as number,
  );
  const opts: EstimateOptions = {
    hours: [...DEFAULTS.hours, ...hours],
    spentUsd: numberOpt(values['spent'] as string | undefined, 'spent', 0),
    stopUsd: numberOpt(values['stop-usd'] as string | undefined, 'stop-usd', DEFAULTS.stopUsd),
    budgetUsd: numberOpt(
      values['budget-usd'] as string | undefined,
      'budget-usd',
      DEFAULTS.budgetUsd,
    ),
    marginPercent: numberOpt(
      values['margin-percent'] as string | undefined,
      'margin-percent',
      DEFAULTS.marginPercent,
    ),
    taxRatePercent: numberOpt(
      values['tax-rate-percent'] as string | undefined,
      'tax-rate-percent',
      DEFAULTS.taxRatePercent,
    ),
    accountLevelUsd: numberOpt(
      values['account-level-usd'] as string | undefined,
      'account-level-usd',
    ),
    timeBoxHours: numberOpt(values['time-box-hours'] as string | undefined, 'time-box-hours'),
    now,
  };
  return estimate(topology, book, opts);
}

async function cmdEstimate(argv: string[], deps: Deps, out: (s: string) => void): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { ...COMMON_OPTIONS, ...ESTIMATE_OPTIONS },
    strict: true,
  });
  const phase = phaseOpt(values.phase);
  const now = deps.now?.() ?? new Date();
  const book = loadBook(values, deps.cwd);
  const est = buildEstimate(values, phase, book, deps, now);
  const written = values.out
    ? writeReport(
        resolve(deps.cwd, values.out),
        est,
        estimateSchema as unknown as z.ZodType<Estimate>,
        'the estimate',
        leakLiterals(deps),
      )
    : est;
  const md = renderEstimate(written);
  if (values.markdown) {
    writeText(resolve(deps.cwd, values.markdown), md, 'the estimate markdown', leakLiterals(deps));
  }
  if (!values.quiet) out(md);
  return EXIT.OK;
}

interface AwsContext {
  session: GuardedSession;
  guard: GuardSession;
  cli: AwsCli;
  guardCli: string;
}

function awsContext(
  values: Record<string, string | string[] | boolean | undefined>,
  runId: string,
  label: string,
  deps: Deps,
): AwsContext | { refused: string } {
  const profile = values['profile'] as string;
  const region = values['region'] as string;
  if (!ALLOWED_REGIONS.includes(region)) {
    return {
      refused: `--region ${region.slice(0, 40)} is not a sandbox region (regions with committed sandbox price data: ${ALLOWED_REGIONS.join(', ')}); add tools/finops/pricing/<region>.yaml and tools/aws-sandbox/pricing/supplement.<region>.json first`,
    };
  }
  const problems = parentEnvProblems(deps.env, profile, region);
  if (problems.length > 0) return { refused: problems.join('; ') };
  const cliInfo = resolveAwsCli({
    explicitPath: values['aws-cli'] as string | undefined,
    parentEnv: deps.env,
    cwd: deps.cwd,
  });
  if ('error' in cliInfo) return { refused: cliInfo.error };
  const home = sandboxHome(deps.env);
  const runLog = join(home, 'runs', runId, 'guard.log');
  const guardCli = resolve(
    deps.cwd,
    (values['guard-cli'] as string | undefined) ?? DEFAULT_GUARD_CLI,
  );
  const guard = new GuardSession(
    {
      guardCli,
      profile,
      region,
      expectedAccountFile: resolve(
        deps.cwd,
        (values['expected-account-file'] as string | undefined) ?? join(home, 'expected-account'),
      ),
      logFile:
        (values['guard-log'] as string | undefined) ??
        (existsSync(dirname(runLog)) ? runLog : undefined),
    },
    {
      runner: deps.guardRunner,
      parentEnv: deps.env,
      cwd: deps.cwd,
      maxAgeMs:
        (numberOpt(
          values['guard-max-age-seconds'] as string,
          'guard-max-age-seconds',
          0,
        ) as number) * 1000,
    },
  );
  const cli = createAwsCli({
    info: cliInfo,
    profile,
    region,
    parentEnv: deps.env,
    cwd: deps.cwd,
    timeoutMs:
      (numberOpt(values['timeout-seconds'] as string, 'timeout-seconds', 120) as number) * 1000,
    ...(deps.awsRunner ? { runner: deps.awsRunner } : {}),
  });
  return { session: new GuardedSession(cli, guard, label), guard, cli, guardCli };
}

const guardCliPath = (values: Record<string, unknown>, deps: Deps) =>
  resolve(deps.cwd, (values['guard-cli'] as string | undefined) ?? DEFAULT_GUARD_CLI);

const toolInfo = (ctx: AwsContext | undefined, guardCli: string, deps: Deps) => ({
  awsCli: ctx
    ? {
        path: displayPath(ctx.cli.info.realpath, deps),
        sha256: ctx.cli.info.sha256,
        version: ctx.cli.version() ?? null,
      }
    : null,
  guardCli: { path: displayPath(guardCli, deps), sha256: sha256Of(guardCli) },
  awsCalls: ctx ? [...ctx.cli.records] : [],
});

const guardInfo = (
  c: AwsContext | undefined,
  refusal: string | null,
  values: Record<string, unknown>,
) => ({
  checks: c ? [...c.guard.checks] : [],
  refusal,
  maxAgeSeconds: c
    ? c.guard.maxAgeSeconds
    : (numberOpt(values['guard-max-age-seconds'] as string, 'guard-max-age-seconds', 0) as number),
});

function runIdOpt(v: string | undefined): string {
  if (!v || !RUN_ID_RE.test(v)) {
    throw new UsageError(
      '--run-id is required: 3-24 chars [a-z0-9-], alphanumeric at both ends (sbx-<6 hex> or it-<6 hex>)',
    );
  }
  return v;
}

async function cmdInventory(
  argv: string[],
  deps: Deps,
  out: (s: string) => void,
  err: (s: string) => void,
): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      ...COMMON_OPTIONS,
      ...ESTIMATE_OPTIONS,
      ...AWS_OPTIONS,
      'teardown-command': { type: 'string' },
    },
    strict: true,
  });
  const runId = runIdOpt(values['run-id']);
  const phase = phaseOpt(values.phase, runId);
  if (!values.out) throw new UsageError('--out <inventory.json> is required');
  const now = deps.now?.() ?? new Date();
  const book = loadBook(values, deps.cwd);
  const est = buildEstimate(values, phase, book, deps, now);
  const synthStacks = values.synth ? loadSynthStacks(resolve(deps.cwd, values.synth)) : undefined;
  const label = `starter-aws-sandbox inventory ${runId} (read-only)`;
  const ctx = awsContext(values, runId, label, deps);
  const literals = leakLiterals(deps, runId);
  const base = {
    kind: 'starter-aws-sandbox/inventory' as const,
    schemaVersion: 1 as const,
    generatedAt: now.toISOString(),
    runId,
    phase,
    region: values.region,
    executionProfile: 'personal-sandbox' as const,
    readOnly: true as const,
  };
  const refusedReport = (reason: string, guardCli: string, c?: AwsContext) => ({
    ...base,
    account: null,
    status: 'guard-refused' as const,
    statusReason: reason,
    stacks: [],
    bootstrap: null,
    experimentResources: { kmsKeys: [], secrets: [], logGroups: [] },
    otherRunStacks: [],
    cost: {
      disclaimer: est.disclaimer,
      estimateBasis: est.topology.basis.kind,
      priceBasis: `finops ${est.priceBasis.snapshot} + supplement ${est.priceBasis.supplement}; not live pricing`,
      resourcesUsdPerHour: 0,
      otherUsdPerHour: 0,
      totalUsdPerHour: est.totals.perHourUsd,
      oneTimeUsd: est.totals.oneTimeUsd,
      partialHourRoundingUsd: est.totals.partialHourRoundingUsd,
      accountLevelUsd: est.accountLevel.usedUsd,
      startedAt: null,
      elapsedHours: null,
      estimatedSpendSoFarUsd: null,
    },
    runtime: {
      stopUsd: est.stopRule.stopUsd,
      spentUsd: est.stopRule.spentUsd,
      marginPercent: est.stopRule.marginPercent,
      taxRatePercent: est.stopRule.taxRatePercent,
      maxRuntimeHours: est.stopRule.maxRuntimeHours,
      timeBoxHours: est.stopRule.timeBoxHours,
      effectiveMaxRuntimeHours: est.stopRule.effectiveMaxRuntimeHours,
      bindingLimit: est.stopRule.bindingLimit,
      teardownStartBy: null,
      allDeletedBy: null,
      expiresAtTag: null,
      basis: est.stopRule.formula,
    },
    teardown: { owner: 'operator', command: '—', verifyCommand: '—', notes: [] },
    guard: guardInfo(c, reason, values),
    tool: toolInfo(c, guardCli, deps),
    errors: [],
    notes: ['No inventory was taken: the run was refused before (or while) reading AWS.'],
  });
  if ('refused' in ctx) {
    writeReport(
      resolve(deps.cwd, values.out),
      refusedReport(ctx.refused, guardCliPath(values, deps)),
      inventorySchema,
      'the inventory',
      literals,
    );
    err(`refused: ${ctx.refused}`);
    return EXIT.REFUSED;
  }
  try {
    const core = await buildInventory(ctx.session, {
      runId,
      phase,
      book,
      estimate: est,
      synthStacks,
      teardownCommand: values['teardown-command'],
      now,
    });
    const account = ctx.guard.checks[0]?.account ?? null;
    const report = writeReport(
      resolve(deps.cwd, values.out),
      {
        ...base,
        account,
        ...core,
        experimentResources: experimentResourcesOf(core.stacks, values.region, account),
        guard: guardInfo(ctx, null, values),
        tool: toolInfo(ctx, ctx.guardCli, deps),
      },
      inventorySchema,
      'the inventory',
      literals,
    );
    const md = renderAny(report);
    if (values.markdown)
      writeText(resolve(deps.cwd, values.markdown), md, 'the inventory markdown', literals);
    if (!values.quiet) out(`inventory ${report.status}: ${report.statusReason}\n`);
    return report.status === 'incomplete' ? EXIT.INCOMPLETE : EXIT.OK;
  } catch (e) {
    if (e instanceof GuardRefused || e instanceof CredentialsError || e instanceof AwsCliRefused) {
      writeReport(
        resolve(deps.cwd, values.out),
        refusedReport(e.message, ctx.guardCli, ctx),
        inventorySchema,
        'the inventory',
        literals,
      );
      err(`refused: ${e.message}`);
      return EXIT.REFUSED;
    }
    throw e;
  }
}

async function cmdVerify(
  argv: string[],
  deps: Deps,
  out: (s: string) => void,
  err: (s: string) => void,
): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      ...COMMON_OPTIONS,
      ...AWS_OPTIONS,
      'include-bootstrap': { type: 'boolean', default: false },
      // Strict is the default (retained billing residue fails); --strict is kept as a no-op.
      strict: { type: 'boolean', default: false },
      lenient: { type: 'boolean', default: false },
      baseline: { type: 'string' },
      since: { type: 'string' },
      inventory: { type: 'string' },
      prices: { type: 'string' },
      supplement: { type: 'string' },
    },
    strict: true,
  });
  const runId = runIdOpt(values['run-id']);
  if (!values.out) throw new UsageError('--out <verify-clean.json> is required');
  if (values.strict && values.lenient)
    throw new UsageError('--strict and --lenient exclude each other');
  const inventoryFile = values.inventory ? resolve(deps.cwd, values.inventory) : undefined;
  let inventory: ReturnType<typeof inventoryEvidence> | undefined;
  if (inventoryFile) {
    const parsed = inventorySchema.safeParse(readJson(inventoryFile, '--inventory'));
    if (!parsed.success) {
      throw new UsageError(
        `--inventory ${inventoryFile} is not a starter-aws-sandbox inventory (${parsed.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
          .join('; ')})`,
      );
    }
    if (parsed.data.runId !== runId) {
      throw new UsageError(`--inventory is for run ${parsed.data.runId}, not ${runId}`);
    }
    inventory = inventoryEvidence(parsed.data, inventoryFile);
  }
  const flagSince = values.since ? new Date(values.since) : undefined;
  if (flagSince && Number.isNaN(flagSince.getTime()))
    throw new UsageError('--since must be an ISO-8601 timestamp');
  // Weak (name-only) matches older than the run's first stack cannot be the run's.
  const since = flagSince ?? (inventory?.startedAt ? new Date(inventory.startedAt) : undefined);
  const sinceSource = flagSince ? ('flag' as const) : since ? ('inventory' as const) : null;
  const baselineFile = values.baseline ? resolve(deps.cwd, values.baseline) : undefined;
  let baseline: Set<string> | undefined;
  try {
    baseline = baselineFile ? loadBaseline(baselineFile) : undefined;
  } catch (e) {
    throw new UsageError(
      `--baseline ${baselineFile}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const now = deps.now?.() ?? new Date();
  const book = loadBook(values, deps.cwd);
  const ctx = awsContext(
    values,
    runId,
    `starter-aws-sandbox verify-clean ${runId} (read-only)`,
    deps,
  );
  const literals = leakLiterals(deps, runId);
  const base = {
    kind: 'starter-aws-sandbox/verify-clean' as const,
    schemaVersion: 1 as const,
    generatedAt: now.toISOString(),
    runId,
    region: values.region,
    executionProfile: 'personal-sandbox' as const,
    readOnly: true as const,
    deletesNothing: true as const,
    includeBootstrap: values['include-bootstrap'] ?? false,
    strict: !values.lenient,
    baseline:
      baselineFile && baseline
        ? { file: displayPath(baselineFile, deps), entries: baseline.size }
        : null,
    since: since ? since.toISOString() : null,
    sinceSource,
    inventory: inventory
      ? { file: displayPath(inventory.file, deps), runId: inventory.runId }
      : null,
  };
  const refused = (reason: string, guardCli: string, c?: AwsContext) =>
    writeReport(
      resolve(deps.cwd, values.out as string),
      {
        ...base,
        account: c?.guard.checks[0]?.account ?? null,
        status: 'guard-refused' as const,
        statusReason: reason,
        summary: {
          remaining: 0,
          pendingDeletion: 0,
          retainedByDesign: 0,
          notOwned: 0,
          bootstrapReported: 0,
          remainingUsdPerHour: 0,
          residualLikelyUsd: 0,
          residualWorstUsd: 0,
          pendingDeletionUntil: null,
          incomplete: true,
          unverifiable: [],
        },
        coverage: [],
        deletionEvidence: null,
        findings: [],
        bootstrap: [],
        tagIndexOnly: [],
        guard: guardInfo(c, reason, values),
        tool: toolInfo(c, guardCli, deps),
        notes: ['Nothing was verified: the run was refused. This is NOT a clean verdict.'],
      },
      verifyReportSchema,
      'the verify-clean report',
      literals,
    );
  if ('refused' in ctx) {
    refused(ctx.refused, guardCliPath(values, deps));
    err(`refused: ${ctx.refused}`);
    return EXIT.REFUSED;
  }
  try {
    const core = await verifyClean(ctx.session, book, {
      runId,
      region: values.region,
      includeBootstrap: base.includeBootstrap,
      strict: base.strict,
      baseline,
      since,
      inventory,
      now,
    });
    const report = writeReport(
      resolve(deps.cwd, values.out),
      {
        ...base,
        account: ctx.guard.checks[0]?.account ?? null,
        ...core,
        guard: guardInfo(ctx, null, values),
        tool: toolInfo(ctx, ctx.guardCli, deps),
        notes: [
          'Read-only: this sweep never deletes or changes anything.',
          'Global services (CloudFront, IAM, S3 bucket list) are swept through their own APIs; the regional tag index does not list them.',
          'Billing is not checked here: see `reconcile` (billing lags; no Cost Explorer API calls).',
        ],
      },
      verifyReportSchema,
      'the verify-clean report',
      literals,
    );
    if (values.markdown)
      writeText(
        resolve(deps.cwd, values.markdown),
        renderAny(report),
        'the verify-clean markdown',
        literals,
      );
    if (!values.quiet) {
      out(`verify-clean ${report.status}: ${report.statusReason}\n`);
      for (const u of report.summary.unverifiable) {
        out(`  ${u.status.padEnd(18)} ${u.category}: ${u.evidence[0] ?? ''}\n`);
      }
      for (const f of report.findings.filter((x) => x.class !== 'not-owned')) {
        out(
          `  ${f.class.padEnd(18)} ${f.resourceType} ${f.id}${f.deletionDate ? ` (until ${f.deletionDate})` : ''}\n`,
        );
      }
    }
    if (report.status === 'not-clean') return EXIT.NOT_CLEAN;
    if (report.status === 'incomplete') return EXIT.INCOMPLETE;
    if (report.status === 'clean-with-unverifiable') return EXIT.CLEAN_WITH_UNVERIFIABLE;
    return EXIT.OK;
  } catch (e) {
    if (e instanceof GuardRefused || e instanceof CredentialsError || e instanceof AwsCliRefused) {
      refused(e.message, ctx.guardCli, ctx);
      err(`refused: ${e.message}`);
      return EXIT.REFUSED;
    }
    throw e;
  }
}

function readJson(file: string, what: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new UsageError(`${what} ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function cmdReconcile(argv: string[], deps: Deps, out: (s: string) => void): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      ...COMMON_OPTIONS,
      estimate: { type: 'string' },
      billed: { type: 'string' },
      hours: { type: 'string' },
      template: { type: 'boolean', default: false },
      'run-id': { type: 'string' },
      phase: { type: 'string' },
    },
    strict: true,
  });
  if (values.template) {
    const runId = runIdOpt(values['run-id']);
    const t = billedTemplate(runId, phaseOpt(values.phase, runId));
    const text = `${JSON.stringify(t, null, 2)}\n`;
    if (values.out) writeText(resolve(deps.cwd, values.out), text, 'the billed-input template');
    else out(text);
    return EXIT.OK;
  }
  if (!values.estimate || !values.billed)
    throw new UsageError('--estimate and --billed are required');
  const est = estimateSchema.safeParse(readJson(resolve(deps.cwd, values.estimate), '--estimate'));
  if (!est.success) throw new UsageError('--estimate is not a starter-aws-sandbox estimate report');
  const billed = billedInputSchema.safeParse(
    readJson(resolve(deps.cwd, values.billed), '--billed'),
  );
  if (!billed.success) {
    throw new UsageError(
      `--billed is invalid:\n${billed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')}`,
    );
  }
  const r = reconcile(est.data as unknown as Estimate, billed.data, {
    hoursRun: numberOpt(values.hours, 'hours'),
    now: deps.now?.() ?? new Date(),
  });
  const written = values.out
    ? writeReport(resolve(deps.cwd, values.out), r, reconciliationSchema, 'the reconciliation')
    : r;
  const md = renderAny(written);
  if (values.markdown)
    writeText(resolve(deps.cwd, values.markdown), md, 'the reconciliation markdown');
  if (!values.quiet) out(md);
  return r.stopRule.reached ? EXIT.NOT_CLEAN : EXIT.OK;
}

async function cmdRender(argv: string[], deps: Deps, out: (s: string) => void): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { in: { type: 'string' }, out: { type: 'string' } },
    strict: true,
  });
  if (!values.in) throw new UsageError('--in <report.json> is required');
  const report = readJson(resolve(deps.cwd, values.in), '--in') as { kind?: unknown };
  const schema = Object.values(SCHEMAS).find((s) => s.safeParse(report).success);
  if (!schema) throw new UsageError('--in is not a valid starter-aws-sandbox report');
  const md = renderAny(report);
  if (values.out) writeText(resolve(deps.cwd, values.out), md, 'the markdown');
  else out(md);
  return EXIT.OK;
}

async function cmdSchema(argv: string[], deps: Deps, out: (s: string) => void): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { kind: { type: 'string' }, write: { type: 'boolean', default: false } },
    strict: true,
  });
  const names = Object.keys(SCHEMAS) as SchemaName[];
  if (values.kind && !names.includes(values.kind as SchemaName)) {
    throw new UsageError(`--kind must be one of ${names.join(', ')}`);
  }
  const selected = values.kind ? [values.kind as SchemaName] : names;
  for (const name of selected) {
    const text = `${JSON.stringify(jsonSchemaFor(name), null, 2)}\n`;
    if (values.write)
      writeText(join(PACKAGE_ROOT, 'schema', `${name}.schema.json`), text, `the ${name} schema`);
    else out(text);
  }
  return EXIT.OK;
}

export async function main(
  argv: readonly string[],
  deps: Deps = { env: process.env, cwd: process.cwd() },
): Promise<number> {
  const out = deps.stdout ?? ((s: string) => process.stdout.write(s));
  const err = deps.stderr ?? ((s: string) => process.stderr.write(`${s}\n`));
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'estimate':
        return await cmdEstimate(rest, deps, out);
      case 'inventory':
        return await cmdInventory(rest, deps, out, err);
      case 'verify-clean':
        return await cmdVerify(rest, deps, out, err);
      case 'reconcile':
        return await cmdReconcile(rest, deps, out);
      case 'render':
        return await cmdRender(rest, deps, out);
      case 'schema':
        return await cmdSchema(rest, deps, out);
      case 'iam-policy':
        out(`${JSON.stringify(iamPolicyDocument(), null, 2)}\n`);
        return EXIT.OK;
      default:
        err(USAGE);
        return EXIT.USAGE;
    }
  } catch (e) {
    if (e instanceof BoundaryViolation) {
      err(`refused: ${e.message}`);
      return EXIT.REFUSED;
    }
    if (
      e instanceof UsageError ||
      e instanceof PriceBookError ||
      e instanceof SynthError ||
      e instanceof LeakError ||
      (e instanceof TypeError &&
        'code' in e &&
        String((e as { code?: unknown }).code).startsWith('ERR_PARSE_ARGS'))
    ) {
      err(`error: ${e.message}`);
      return EXIT.USAGE;
    }
    throw e;
  }
}
