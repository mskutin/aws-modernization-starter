import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ENVIRONMENTS, type Environment } from './config.js';

export interface CfnResource {
  Type: string;
  Properties?: Record<string, unknown>;
  DeletionPolicy?: string;
  UpdateReplacePolicy?: string;
  Metadata?: Record<string, unknown>;
}

export interface CfnTemplate {
  Resources?: Record<string, CfnResource>;
}

export interface LoadedTemplate {
  /** Stable key: path relative to the cdk.out root, e.g. `assembly-Prod/ProdData90A795AA.template.json`. */
  key: string;
  template: CfnTemplate;
  environment: Environment | undefined;
}

export function findTemplateFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  if (statSync(dir).isFile()) return [dir];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...findTemplateFiles(full));
    else if (e.isFile() && e.name.endsWith('.template.json')) out.push(full);
  }
  return out.sort();
}

const isEnv = (v: unknown): v is Environment =>
  typeof v === 'string' && (ENVIRONMENTS as readonly string[]).includes(v);

/**
 * Environment of a template: most common `Environment` tag value among its
 * resources, else the Stage assembly directory name (`assembly-Prod` → prod).
 */
export function environmentOfTemplate(key: string, template: CfnTemplate): Environment | undefined {
  const counts = new Map<Environment, number>();
  for (const r of Object.values(template.Resources ?? {})) {
    const tags = r.Properties?.['Tags'];
    if (!Array.isArray(tags)) continue;
    for (const t of tags as { Key?: unknown; Value?: unknown }[]) {
      if (t.Key === 'Environment' && isEnv(t.Value))
        counts.set(t.Value, (counts.get(t.Value) ?? 0) + 1);
    }
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (best) return best;
  const m = /assembly-([A-Za-z]+)/.exec(key)?.[1]?.toLowerCase();
  return isEnv(m) ? m : undefined;
}

/** Loads every `*.template.json` below `dir`. A missing directory yields an empty set. */
export function loadTemplates(dir: string): Map<string, LoadedTemplate> {
  const out = new Map<string, LoadedTemplate>();
  for (const file of findTemplateFiles(dir)) {
    const key = statSync(dir).isFile() ? (file.split('/').pop() ?? file) : relative(dir, file);
    const template = JSON.parse(readFileSync(file, 'utf8')) as CfnTemplate;
    out.set(key, { key, template, environment: environmentOfTemplate(key, template) });
  }
  return out;
}

export const cdkPathOf = (r: CfnResource | undefined): string | undefined => {
  const p = r?.Metadata?.['aws:cdk:path'];
  return typeof p === 'string' ? p : undefined;
};

/** `manifest.json` files below `dir` (cloud assembly manifests, nested assemblies included). */
function findManifests(dir: string): string[] {
  if (!existsSync(dir) || statSync(dir).isFile()) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...findManifests(full));
    else if (e.isFile() && e.name === 'manifest.json') out.push(full);
  }
  return out.sort();
}

/**
 * Regions the CloudFormation stacks of a cloud assembly (`cdk.out`) are pinned to, from the
 * artifacts' `environment` (`aws://<account>/<region>`) in its manifests; environment-agnostic
 * stacks (`unknown-region`) are not counted. Sorted, unique; empty when no manifest says.
 */
export function regionsOfAssembly(dir: string): string[] {
  const regions = new Set<string>();
  for (const file of findManifests(dir)) {
    let manifest: unknown;
    try {
      manifest = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const artifacts = (manifest as { artifacts?: unknown }).artifacts;
    if (typeof artifacts !== 'object' || artifacts === null) continue;
    for (const a of Object.values(artifacts as Record<string, unknown>)) {
      const { type, environment } = (a ?? {}) as { type?: unknown; environment?: unknown };
      if (type !== 'aws:cloudformation:stack' || typeof environment !== 'string') continue;
      const region = /^aws:\/\/[^/]+\/(.+)$/.exec(environment)?.[1];
      if (region && region !== 'unknown-region') regions.add(region);
    }
  }
  return [...regions].sort();
}
