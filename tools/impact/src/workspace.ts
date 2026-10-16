import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { parse } from 'yaml';
import { matchGlob } from './glob.ts';

/**
 * The pnpm workspace dependency graph, read straight from pnpm-workspace.yaml
 * and each package.json (no Nx/Turbo, no pnpm process needed).
 */

export interface WorkspacePackage {
  name: string;
  /** Repo-relative directory, forward slashes. */
  dir: string;
  /** Internal (workspace) dependencies by package name, all dependency kinds. */
  internalDeps: string[];
}

export interface Workspace {
  root: string;
  packages: WorkspacePackage[];
  byName: Map<string, WorkspacePackage>;
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', 'cdk.out', '.pnpm-store']);
const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

function listDirs(root: string, maxDepth: number): string[] {
  const out: string[] = [];
  const walk = (abs: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      const child = join(abs, entry.name);
      out.push(toPosix(relative(root, child)));
      walk(child, depth + 1);
    }
  };
  walk(root, 1);
  return out;
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

export function workspacePatterns(root: string): string[] {
  const file = join(root, 'pnpm-workspace.yaml');
  if (!existsSync(file)) throw new Error(`pnpm-workspace.yaml not found in ${root}`);
  const doc = parse(readFileSync(file, 'utf8')) as { packages?: unknown } | null;
  const patterns = doc?.packages;
  if (!Array.isArray(patterns) || patterns.some((p) => typeof p !== 'string')) {
    throw new Error('pnpm-workspace.yaml: "packages" must be a list of glob strings');
  }
  return patterns as string[];
}

export function loadWorkspace(root: string): Workspace {
  const patterns = workspacePatterns(root);
  const include = patterns.filter((p) => !p.startsWith('!'));
  const exclude = patterns.filter((p) => p.startsWith('!')).map((p) => p.slice(1));
  const maxDepth = Math.max(...include.map((p) => (p.includes('**') ? 6 : p.split('/').length)), 1);
  const dirs = listDirs(root, maxDepth).filter(
    (dir) =>
      include.some((p) => matchGlob(p.replace(/\/$/, ''), dir)) &&
      !exclude.some((p) => matchGlob(p.replace(/\/$/, ''), dir)) &&
      existsSync(join(root, dir, 'package.json')),
  );

  const raw = dirs.map((dir) => ({ dir, json: readJson(join(root, dir, 'package.json')) }));
  const names = new Set(
    raw.map((r) => r.json.name).filter((n): n is string => typeof n === 'string'),
  );
  const packages: WorkspacePackage[] = raw
    .filter(
      (r): r is { dir: string; json: Record<string, unknown> & { name: string } } =>
        typeof r.json.name === 'string',
    )
    .map(({ dir, json }) => {
      const deps = new Set<string>();
      for (const field of DEP_FIELDS) {
        const block = json[field];
        if (block && typeof block === 'object') {
          for (const dep of Object.keys(block))
            if (names.has(dep) && dep !== json.name) deps.add(dep);
        }
      }
      return { name: json.name, dir, internalDeps: [...deps].sort() };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return { root, packages, byName: new Map(packages.map((p) => [p.name, p])) };
}
