/**
 * Runs CloudFormation Guard over synthesized templates, normalizes its
 * structured output and applies governed exceptions (Guard "skips").
 *
 * Exceptions are applied HERE, from exceptions.yaml only. Template metadata
 * (cdk_nag acknowledgements) is deliberately ignored, so an in-code
 * acknowledgement that bypasses governance still fails this second line.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { cdkPathOf, isBlockingSeverity, ruleById } from '../catalogue.js';
import {
  findException,
  type ExceptionIssue,
  type PolicyException,
} from '../exceptions/exceptions.js';
import { environmentOf } from '../rules/util.js';
import {
  ruleIdFromGuardName,
  type CfnTemplateJson,
  type Environment,
  type Severity,
} from '../types.js';
import { GUARD_RULES_DIR, LOCAL_GUARD_BIN } from './layout.js';

export const PINNED_GUARD_VERSION = '3.2.1';

export class GuardUnavailableError extends Error {}

/** Resolution order: $CFN_GUARD_BIN → policies/.tools/cfn-guard → cfn-guard on PATH. */
export function resolveGuardBinary(): { bin: string; version: string } {
  const candidates = [process.env['CFN_GUARD_BIN'], LOCAL_GUARD_BIN, 'cfn-guard'].filter(
    (c): c is string => typeof c === 'string' && c.length > 0,
  );
  for (const bin of candidates) {
    if (bin.includes('/') && !existsSync(bin)) continue;
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8' });
    if (r.status === 0) {
      return { bin, version: r.stdout.trim().replace(/^cfn-guard\s+/, '') };
    }
  }
  throw new GuardUnavailableError(
    'cfn-guard not found. Run `pnpm --filter @starter/policies guard:install` ' +
      '(pinned, SHA-256 verified) or set CFN_GUARD_BIN.',
  );
}

/** Recursively lists `*.template.json` files (CDK puts Stage templates in `assembly-*` subdirectories). */
export function findTemplates(dir: string): string[] {
  if (!existsSync(dir)) return [];
  if (statSync(dir).isFile()) return [dir];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findTemplates(full));
    else if (entry.isFile() && entry.name.endsWith('.template.json')) out.push(full);
  }
  return out.sort();
}

export interface GuardFinding {
  ruleId: string;
  guardRule: string;
  severity: Severity;
  blocking: boolean;
  template: string;
  logicalId: string;
  resourceType: string | undefined;
  cdkPath: string | undefined;
  environment: Environment | undefined;
  path: string;
  message: string;
  /** Set when a governed exception waives the finding. */
  exception?: { id: string; ticket: string; expiresAt: string; justification: string };
}

export interface GuardValidateResult {
  guardVersion: string;
  rulesDir: string;
  templates: string[];
  findings: GuardFinding[];
  /** Guard rule outcomes per template (for JUnit). */
  ruleStatus: { template: string; guardRule: string; status: 'PASS' | 'FAIL' | 'SKIP' }[];
  exceptionIssues: ExceptionIssue[];
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

interface Leaf {
  path: string;
  message: string;
  /** True when `message` is the rule author's custom message. */
  custom: boolean;
}

/** Collects failing clauses (custom message + first /Resources/... path) from a Guard rule report. */
export function collectLeaves(node: unknown, out: Leaf[] = []): Leaf[] {
  if (Array.isArray(node)) {
    node.forEach((n) => collectLeaves(n, out));
    return out;
  }
  if (!isObj(node)) return out;
  const clause = node['Clause'];
  if (isObj(clause)) {
    const path = firstResourcePath(clause);
    const custom = findKey(clause, 'custom_message');
    const error = findKey(clause, 'error_message');
    const customText = typeof custom === 'string' ? custom.trim() : '';
    const message = customText || (typeof error === 'string' ? error.trim() : '');
    out.push({ path: path ?? '', message, custom: customText.length > 0 });
    return out;
  }
  Object.values(node).forEach((v) => collectLeaves(v, out));
  return out;
}

function findKey(node: unknown, key: string): unknown {
  if (Array.isArray(node)) {
    for (const n of node) {
      const r = findKey(n, key);
      if (r !== undefined && r !== null) return r;
    }
    return undefined;
  }
  if (!isObj(node)) return undefined;
  if (node[key] !== undefined && node[key] !== null) return node[key];
  for (const v of Object.values(node)) {
    const r = findKey(v, key);
    if (r !== undefined && r !== null) return r;
  }
  return undefined;
}

function firstResourcePath(node: unknown): string | undefined {
  if (Array.isArray(node)) {
    for (const n of node) {
      const r = firstResourcePath(n);
      if (r) return r;
    }
    return undefined;
  }
  if (!isObj(node)) return undefined;
  const p = node['path'];
  if (typeof p === 'string' && p.startsWith('/Resources/')) return p;
  for (const v of Object.values(node)) {
    const r = firstResourcePath(v);
    if (r) return r;
  }
  return undefined;
}

/** `/Resources/Fn/Properties/Timeout` → { logicalId: 'Fn', path: 'Properties/Timeout' } */
export function splitResourcePath(p: string): { logicalId: string; path: string } {
  const [, , logicalId = '', ...rest] = p.split('/');
  return { logicalId, path: rest.join('/') };
}

export interface RunGuardOptions {
  templates: string[];
  rulesDir?: string;
  activeExceptions?: readonly PolicyException[];
  exceptionIssues?: ExceptionIssue[];
  /** Base directory for relative template paths in results. */
  baseDir?: string;
  guardBin?: string;
}

/** Evaluates the Guard rule set over the given templates (one Guard process per template). */
export function runGuardValidate(options: RunGuardOptions): GuardValidateResult {
  const { bin, version } = options.guardBin
    ? { bin: options.guardBin, version: 'unknown' }
    : resolveGuardBinary();
  const rulesDir = options.rulesDir ?? GUARD_RULES_DIR;
  const baseDir = options.baseDir ?? process.cwd();
  const findings: GuardFinding[] = [];
  const ruleStatus: GuardValidateResult['ruleStatus'] = [];
  for (const file of options.templates) {
    const template = JSON.parse(readFileSync(file, 'utf8')) as CfnTemplateJson;
    const rel = relative(baseDir, file) || file;
    const r = spawnSync(
      bin,
      [
        'validate',
        '-r',
        rulesDir,
        '-d',
        file,
        '-o',
        'json',
        '--structured',
        '--show-summary',
        'none',
      ],
      { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
    );
    // 0 = compliant, 19 = non-compliant; anything else is an execution error.
    if (r.status !== 0 && r.status !== 19) {
      throw new Error(
        `cfn-guard failed on ${rel} (exit ${String(r.status)}): ${r.stderr || r.stdout}`,
      );
    }
    const reports = JSON.parse(r.stdout) as Json[];
    for (const report of reports) {
      for (const [bucket, status] of [
        ['not_compliant', 'FAIL'],
        ['compliant', 'PASS'],
        ['not_applicable', 'SKIP'],
      ] as const) {
        for (const entry of (report[bucket] as unknown[] | undefined) ?? []) {
          const name =
            typeof entry === 'string' ? entry : (findKey(entry, 'name') as string | undefined);
          if (name) ruleStatus.push({ template: rel, guardRule: name, status });
          if (status !== 'FAIL' || !isObj(entry)) continue;
          const ruleId = ruleIdFromGuardName(String(name));
          const rule = ruleById(ruleId);
          // Prefer the clause carrying a custom message when several clauses (e.g. the
          // disjuncts of an `or`) point at the same property.
          const all = collectLeaves(entry);
          const leaves = new Map<string, Leaf>();
          for (const leaf of all.filter((l) => l.path)) {
            const prev = leaves.get(leaf.path);
            if (!prev || (!prev.custom && leaf.custom)) leaves.set(leaf.path, leaf);
          }
          if (leaves.size === 0) {
            // Variable-level failure without a resource path: never drop it silently.
            leaves.set('', all.find((l) => l.custom) ?? { path: '', message: '', custom: false });
          }
          for (const leaf of leaves.values()) {
            const { logicalId, path } = leaf.path
              ? splitResourcePath(leaf.path)
              : { logicalId: '(template)', path: '' };
            const resource = template.Resources?.[logicalId];
            const environment = resource ? environmentOf(resource, undefined) : undefined;
            const cdkPath = resource ? cdkPathOf(resource) : undefined;
            const severity: Severity = rule?.severity ?? 'high';
            const message = leaf.custom
              ? leaf.message
              : `${ruleId}: ${rule?.title ?? String(name)}${leaf.message ? ` - ${leaf.message}` : ''}`;
            const finding: GuardFinding = {
              ruleId,
              guardRule: String(name),
              severity,
              blocking: isBlockingSeverity(severity),
              template: rel,
              logicalId,
              resourceType: resource?.Type,
              cdkPath,
              environment,
              path,
              message,
            };
            const exc = findException(options.activeExceptions ?? [], {
              ruleId,
              environment,
              cdkPath,
              logicalId,
            });
            if (exc) {
              finding.exception = {
                id: exc.id,
                ticket: exc.ticket,
                expiresAt: exc.expiresAt ?? 'never (reference design)',
                justification: exc.justification,
              };
            }
            findings.push(finding);
          }
        }
      }
    }
  }
  return {
    guardVersion: version,
    rulesDir,
    templates: options.templates.map((t) => relative(baseDir, t) || t),
    findings,
    ruleStatus,
    exceptionIssues: options.exceptionIssues ?? [],
  };
}

export interface GuardSummary {
  templates: number;
  blocking: number;
  advisory: number;
  excepted: number;
  exceptionErrors: number;
  passed: boolean;
}

export function summarize(result: GuardValidateResult, failOnAdvisory = false): GuardSummary {
  const open = result.findings.filter((f) => !f.exception);
  const blocking = open.filter((f) => f.blocking).length;
  const advisory = open.filter((f) => !f.blocking).length;
  const exceptionErrors = result.exceptionIssues.filter((i) => i.level === 'error').length;
  return {
    templates: result.templates.length,
    blocking,
    advisory,
    excepted: result.findings.length - open.length,
    exceptionErrors,
    passed: blocking === 0 && exceptionErrors === 0 && (!failOnAdvisory || advisory === 0),
  };
}

export interface GuardTestResult {
  status: number;
  stdout: string;
  junit: string;
}

/** Runs Guard's own unit tests (`<rules>/tests/*_tests.yaml`). */
export function runGuardTests(rulesDir = GUARD_RULES_DIR, guardBin?: string): GuardTestResult {
  const bin = guardBin ?? resolveGuardBinary().bin;
  const human = spawnSync(bin, ['test', '-d', rulesDir], { encoding: 'utf8' });
  const junit = spawnSync(bin, ['test', '-d', rulesDir, '-o', 'junit'], { encoding: 'utf8' });
  if (human.status === null)
    throw new Error(`cfn-guard test could not run: ${String(human.error)}`);
  return { status: human.status, stdout: human.stdout + human.stderr, junit: junit.stdout };
}
