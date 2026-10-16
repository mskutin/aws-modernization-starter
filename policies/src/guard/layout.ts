import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `policies/` package root (works from `src/` via tsx and from `dist/`). */
export const POLICIES_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const GUARD_RULES_DIR = join(POLICIES_ROOT, 'guard', 'rules');
/** `cfn-guard test --dir` expects `<rules>/tests/<file>_tests.yaml`. */
export const GUARD_TESTS_DIR = join(GUARD_RULES_DIR, 'tests');
export const DEFAULT_EXCEPTIONS_PATH = join(POLICIES_ROOT, 'exceptions', 'exceptions.yaml');
export const DEFAULT_SUPPRESSIONS_PATH = join(POLICIES_ROOT, 'exceptions', 'suppressions.yaml');
export const LOCAL_GUARD_BIN = join(POLICIES_ROOT, '.tools', 'cfn-guard');

/** Guard rule file (without extension) that hosts a rule, by ID domain. */
const GUARD_FILE_BY_DOMAIN: Readonly<Record<string, string>> = {
  S3: 's3',
  CF: 'cloudfront',
  ECS: 'ecs',
  IAM: 'iam',
  LMB: 'lambda',
  RDS: 'rds',
  DDB: 'dynamodb',
  LOG: 'logging',
  TAG: 'governance',
  STATE: 'governance',
  KMS: 'governance',
};

export function guardFileFor(ruleId: string): string {
  const domain = ruleId.split('-')[1] ?? '';
  const file = GUARD_FILE_BY_DOMAIN[domain];
  if (!file) throw new Error(`No Guard rule file mapped for ${ruleId}`);
  return file;
}

/** Repository root: nearest ancestor containing pnpm-workspace.yaml. */
export function repoRoot(start = POLICIES_ROOT): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

/**
 * Resolves a user-supplied path. pnpm runs package scripts with cwd = package
 * dir, so relative paths are resolved against the directory pnpm was invoked
 * from (`INIT_CWD`) when available.
 */
export const userPath = (p: string): string =>
  isAbsolute(p) ? p : resolve(process.env['INIT_CWD'] ?? process.cwd(), p);
