import type { Component, Manifest } from './manifest.ts';
import type { Workspace } from './workspace.ts';

/** Patterns owned by a component itself (not including its dependencies). */
export function ownPatterns(component: Component): string[] {
  const own = component.path ? [`${component.path.replace(/\/+$/, '')}/**/*`] : [];
  return [...own, ...component.extraPaths];
}

/**
 * Component graph = manifest components + edges from package.json workspace
 * dependencies + explicit `dependsOn` edges.
 */
export interface ComponentGraph {
  components: Component[];
  byId: Map<string, Component>;
  /** id -> ids it depends on directly */
  deps: Map<string, Set<string>>;
  /** id -> ids that depend on it directly */
  dependents: Map<string, Set<string>>;
}

export interface ConsistencyProblem {
  severity: 'error' | 'warning';
  message: string;
}

export function buildGraph(manifest: Manifest, workspace: Workspace): ComponentGraph {
  const byId = new Map(manifest.components.map((c) => [c.id, c]));
  const byPackage = new Map(
    manifest.components.filter((c) => c.package).map((c) => [c.package as string, c.id]),
  );
  const deps = new Map<string, Set<string>>();
  const dependents = new Map<string, Set<string>>();
  for (const c of manifest.components) {
    deps.set(c.id, new Set());
    dependents.set(c.id, new Set());
  }
  const addEdge = (from: string, to: string): void => {
    if (from === to) return;
    deps.get(from)?.add(to);
    dependents.get(to)?.add(from);
  };
  for (const c of manifest.components) {
    for (const ref of c.dependsOn) addEdge(c.id, ref);
    const pkg = c.package ? workspace.byName.get(c.package) : undefined;
    for (const dep of pkg?.internalDeps ?? []) {
      const target = byPackage.get(dep);
      if (target) addEdge(c.id, target);
    }
  }
  return { components: manifest.components, byId, deps, dependents };
}

function closure(start: Iterable<string>, edges: Map<string, Set<string>>): Set<string> {
  const seen = new Set<string>();
  const stack = [...start];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const next of edges.get(id) ?? []) stack.push(next);
  }
  return seen;
}

/** The component plus everything it transitively depends on. */
export function dependencyClosure(graph: ComponentGraph, id: string): Set<string> {
  return closure([id], graph.deps);
}

/** The given components plus everything that transitively depends on them. */
export function reverseClosure(graph: ComponentGraph, ids: Iterable<string>): Set<string> {
  return closure(ids, graph.dependents);
}

/** One dependency path from `from` to `to` (for human-readable reasons). */
export function dependencyPath(graph: ComponentGraph, from: string, to: string): string[] {
  const queue: string[][] = [[from]];
  const seen = new Set([from]);
  while (queue.length > 0) {
    const path = queue.shift() as string[];
    const last = path[path.length - 1] as string;
    if (last === to) return path;
    for (const next of [...(graph.deps.get(last) ?? [])].sort()) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push([...path, next]);
      }
    }
  }
  return [from, to];
}

/**
 * Change patterns that must trigger a component's jobs: its own paths plus the
 * own paths of everything it transitively depends on, plus global paths.
 * Matching ANY of them is equivalent to "component is in the reverse
 * dependency closure of a changed component" — which is what the analyser
 * computes. Tests assert that equivalence.
 */
export function triggerPatterns(
  graph: ComponentGraph,
  manifest: Manifest,
  ids: Iterable<string>,
): string[] {
  const members = new Set<string>();
  for (const id of ids) for (const m of dependencyClosure(graph, id)) members.add(m);
  const patterns = new Set<string>();
  for (const id of [...members].sort()) {
    const component = graph.byId.get(id);
    if (component) for (const p of ownPatterns(component)) patterns.add(p);
  }
  for (const p of manifest.global) patterns.add(p);
  return [...patterns];
}

/** Cross-check manifest vs. workspace: every package must be declared, every declaration must exist. */
export function checkConsistency(manifest: Manifest, workspace: Workspace): ConsistencyProblem[] {
  const problems: ConsistencyProblem[] = [];
  const declared = new Map(
    manifest.components.filter((c) => c.package).map((c) => [c.package as string, c]),
  );
  for (const pkg of workspace.packages) {
    const component = declared.get(pkg.name);
    if (!component) {
      problems.push({
        severity: 'error',
        message: `workspace package ${pkg.name} (${pkg.dir}) is not declared in components.yaml — add an entry so CI builds and tests it`,
      });
    } else if (component.path !== pkg.dir) {
      problems.push({
        severity: 'error',
        message: `component "${component.id}" declares path "${component.path}" but ${pkg.name} lives in "${pkg.dir}"`,
      });
    }
  }
  for (const c of manifest.components) {
    if (c.package && !workspace.byName.has(c.package)) {
      problems.push({
        severity: 'error',
        message: `component "${c.id}" references package ${c.package}, which is not in the pnpm workspace`,
      });
    }
  }
  return problems;
}
