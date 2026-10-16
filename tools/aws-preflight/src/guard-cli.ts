#!/usr/bin/env node
/**
 * starter-aws-guard — the account guard run before every mutating AWS command of a
 * personal-sandbox run (README "Mutation guard").
 * Built to dist/guard-cli.js by `pnpm --filter @starter/tool-aws-preflight build`.
 *
 *   check --execution-profile personal-sandbox --profile <p> --expected-account-file <file>
 *         --region <region> --label "<what is about to run>" [--log <file.jsonl>]
 *         [--expected-role-pattern <glob>] [--aws-cli <path>] [--call-timeout <seconds>]
 *
 * Exit 0 = verified (one JSON line on stdout); any other code = refuse (guard.ts GUARD_EXIT).
 * When it runs from dist/, it refuses (exit 17) unless dist/ was built from the current src/.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { GUARD_EXIT, runGuardCheck, type GuardDeps } from './guard.ts';
import { VERIFIED_CLI_NIXPKGS_REV, VERIFIED_CLI_VERSION } from './probes.ts';
import { toolSourceSha256 } from './provenance.ts';
import { findRepoRoot } from './sandbox.ts';
import { preGateConsoleMask } from './sanitize.ts';
import { isRecord } from './types.ts';

const HERE = fileURLToPath(import.meta.url);
const TOOL_DIR = fileURLToPath(new URL('..', import.meta.url));
/** Written by scripts/build-info.ts after `tsc -p tsconfig.build.json`. */
export const BUILD_INFO = 'build-info.json';

export const GUARD_USAGE = `starter-aws-guard check [options]   (personal-sandbox account guard; README "Mutation guard")

Required
  --execution-profile personal-sandbox   the strict profile never authorizes a mutation (exit 2)
  --profile <name>                       the sandbox IAM Identity Center profile (never "default")
  --expected-account-file <file>         private file (0600) holding the 12-digit sandbox account
  --region <region>                      the run's configured region (aws partition; the
                                         scripts default to ap-southeast-1); AWS_REGION /
                                         AWS_DEFAULT_REGION must not name another
  --label "<text>"                       what is about to run (logged; no account IDs or e-mails)

Options
  --log <file.jsonl>                     append the JSON line here (default $SANDBOX_GUARD_LOG); 0600
  --expected-role-pattern <glob>         e.g. 'AWSReservedSSO_<PermissionSet>_*'
  --aws-cli <path>                       AWS CLI ${VERIFIED_CLI_VERSION} (default: first 'aws' on PATH)
  --call-timeout <seconds>               default 60

Exit codes: 0 verified; 1 error; 2 usage/strict/CI; 3 account mismatch; 4 principal rejected;
6 SSO session expired; 10 region; 11 no profile; 12 environment conflict; 13 STS failure;
14 AWS CLI not pinned; 15 ~/.aws configuration or fallback identity refused; 16 log;
17 stale build; 130 interrupted.
AWS CLI pin: nix shell github:NixOS/nixpkgs/${VERIFIED_CLI_NIXPKGS_REV}#awscli2`;

const OPTIONS = {
  'execution-profile': { type: 'string' },
  profile: { type: 'string' },
  'expected-account-file': { type: 'string' },
  region: { type: 'string' },
  label: { type: 'string' },
  log: { type: 'string' },
  'expected-role-pattern': { type: 'string' },
  'aws-cli': { type: 'string' },
  'call-timeout': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const;

/**
 * When this module runs from dist/, dist/build-info.json must name the SHA-256 of the current
 * sources (a stale or foreign build is refused). From src/ (tests, `node src/guard-cli.ts`) the
 * sources are what runs. Does not detect a modified dist/: rebuild from a clean checkout.
 */
export function buildProblem(here: string, sourceSha256: string): string | undefined {
  if (basename(dirname(here)) !== 'dist') return undefined;
  const file = join(dirname(here), BUILD_INFO);
  if (!existsSync(file)) {
    return `dist/${BUILD_INFO} is missing; rebuild: pnpm --filter @starter/tool-aws-preflight build`;
  }
  try {
    const info: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const built = isRecord(info) ? info['sourceSha256'] : undefined;
    if (built !== sourceSha256) {
      return 'dist/ was built from other sources than the current src/ (stale build); rebuild: pnpm --filter @starter/tool-aws-preflight build';
    }
  } catch {
    return `dist/${BUILD_INFO} is unreadable; rebuild: pnpm --filter @starter/tool-aws-preflight build`;
  }
  return undefined;
}

export async function main(argv: readonly string[], deps: GuardDeps = {}): Promise<number> {
  const out = deps.stdout ?? ((line: string) => console.log(line));
  const err = deps.stderr ?? ((line: string) => console.error(line));
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    });
  } catch (e) {
    err(
      preGateConsoleMask(
        `GUARD REFUSED (exit 2, usage) — ${e instanceof Error ? e.message : String(e)}`,
      ),
    );
    err(GUARD_USAGE);
    return GUARD_EXIT.USAGE;
  }
  const { values: v, positionals } = parsed;
  if (v.help) {
    out(GUARD_USAGE);
    return GUARD_EXIT.VERIFIED;
  }
  if (positionals.length !== 1 || positionals[0] !== 'check') {
    err(GUARD_USAGE);
    return GUARD_EXIT.USAGE;
  }
  const sourceSha256 = deps.toolSourceSha256 ?? toolSourceSha256(TOOL_DIR);
  try {
    return await runGuardCheck(
      {
        executionProfile: v['execution-profile'],
        profile: v.profile,
        expectedAccountFile: v['expected-account-file'],
        region: v.region,
        label: v.label,
        log: v.log,
        expectedRolePattern: v['expected-role-pattern'],
        awsCli: v['aws-cli'],
        callTimeout: v['call-timeout'],
      },
      {
        ...deps,
        repoRoot: deps.repoRoot ?? findRepoRoot(TOOL_DIR),
        toolSourceSha256: sourceSha256,
        buildProblem: 'buildProblem' in deps ? deps.buildProblem : buildProblem(HERE, sourceSha256),
      },
    );
  } catch (e) {
    err(preGateConsoleMask(`GUARD ERROR (exit 1) — ${e instanceof Error ? e.message : String(e)}`));
    return GUARD_EXIT.ERROR;
  }
}

if (import.meta.main) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  main(process.argv.slice(2), { signal: controller.signal }).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.exitCode = GUARD_EXIT.ERROR;
    },
  );
}
