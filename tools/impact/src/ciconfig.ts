import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument, type Tags } from 'yaml';

/**
 * Minimal reader for the hand-written GitLab CI files. The analyser and the
 * generator use it to discover which hand-written jobs are impact-scoped
 * (`extends: .impact:<component>`), always-run (`.rules:always`) and
 * gate-relevant (`.gated`) — so the CI YAML itself stays the single source of
 * truth for hand-written jobs.
 */

export const GENERATED_FILE = '.gitlab/ci/generated/components.yml';

/** Generated rules template of jobs that need the image build (impact rules + opt-out). */
export const IMAGE_PREFIX = '.impact-image:';

export interface CiJob {
  name: string;
  file: string;
  extendsChain: string[];
  stage?: string;
  trigger: { kind: 'always' } | { kind: 'component'; components: string[] } | { kind: 'other' };
  gated: boolean;
  /** Extends `.impact-image:<component>`: part of the image build chain (opt-out aware). */
  requiresContainerBuild: boolean;
}

/** `!reference [a, b]` support — we only need to parse, not resolve, references. */
const customTags: Tags = [
  {
    tag: '!reference',
    collection: 'seq',
    default: false,
    resolve: (value: unknown) => ({ __reference: (value as { toJSON(): unknown }).toJSON() }),
  } as unknown as Tags[number],
];

export function readCiYaml(file: string): Record<string, unknown> {
  const doc = parseDocument(readFileSync(file, 'utf8'), { customTags });
  if (doc.errors.length > 0) {
    throw new Error(`${file}: ${doc.errors.map((e) => e.message).join('; ')}`);
  }
  const value = doc.toJS() as unknown;
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function localIncludes(config: Record<string, unknown>): string[] {
  const include = config.include;
  const list = Array.isArray(include) ? include : include ? [include] : [];
  const out: string[] = [];
  for (const entry of list) {
    if (typeof entry === 'string') out.push(entry);
    else if (
      entry &&
      typeof entry === 'object' &&
      typeof (entry as { local?: unknown }).local === 'string'
    ) {
      out.push((entry as { local: string }).local);
    }
  }
  return out.map((p) => p.replace(/^\//, ''));
}

const RESERVED = new Set([
  'default',
  'include',
  'stages',
  'variables',
  'workflow',
  'image',
  'services',
  'cache',
  'before_script',
  'after_script',
]);

/** Load all job definitions (hidden templates included) from the CI entrypoint and its local includes. */
export function loadCiDefinitions(
  root: string,
  options: { includeGenerated?: boolean } = {},
): Map<string, { file: string; body: Record<string, unknown> }> {
  const defs = new Map<string, { file: string; body: Record<string, unknown> }>();
  const visit = (rel: string): void => {
    if (!options.includeGenerated && rel === GENERATED_FILE) return;
    const abs = join(root, rel);
    if (!existsSync(abs)) {
      if (rel === GENERATED_FILE) return;
      throw new Error(`CI include not found: ${rel}`);
    }
    const config = readCiYaml(abs);
    for (const inc of localIncludes(config)) visit(inc);
    for (const [key, body] of Object.entries(config)) {
      if (RESERVED.has(key) || !body || typeof body !== 'object' || Array.isArray(body)) continue;
      if (defs.has(key))
        throw new Error(`CI job/template "${key}" defined twice (${defs.get(key)?.file}, ${rel})`);
      defs.set(key, { file: rel, body: body as Record<string, unknown> });
    }
  };
  visit('.gitlab-ci.yml');
  return defs;
}

function extendsOf(body: Record<string, unknown>): string[] {
  const ext = body.extends;
  if (typeof ext === 'string') return [ext];
  if (Array.isArray(ext)) return ext.filter((e): e is string => typeof e === 'string');
  return [];
}

export function resolveExtendsChain(
  defs: Map<string, { body: Record<string, unknown> }>,
  name: string,
  seen = new Set<string>(),
): string[] {
  const def = defs.get(name);
  if (!def || seen.has(name)) return [];
  seen.add(name);
  const chain: string[] = [];
  for (const parent of extendsOf(def.body)) {
    chain.push(parent, ...resolveExtendsChain(defs, parent, seen));
  }
  return chain;
}

/** Visible (non-template) hand-written jobs with their impact classification. */
export function loadCiJobs(root: string): CiJob[] {
  const defs = loadCiDefinitions(root);
  const jobs: CiJob[] = [];
  for (const [name, def] of defs) {
    if (name.startsWith('.')) continue;
    const chain = resolveExtendsChain(defs, name);
    // `.impact-image:<id>` = `.impact:<id>` plus the STARTER_CONTAINER_BUILD opt-out (generated).
    const image = chain.filter((t) => t.startsWith(IMAGE_PREFIX));
    const impact = [
      ...chain.filter((t) => t.startsWith('.impact:')).map((t) => t.slice('.impact:'.length)),
      ...image.map((t) => t.slice(IMAGE_PREFIX.length)),
    ];
    const trigger: CiJob['trigger'] = chain.includes('.rules:always')
      ? { kind: 'always' }
      : impact.length > 0
        ? { kind: 'component', components: [...new Set(impact)] }
        : { kind: 'other' };
    let stage = typeof def.body.stage === 'string' ? def.body.stage : undefined;
    for (const t of chain) {
      if (stage) break;
      const s = defs.get(t)?.body.stage;
      if (typeof s === 'string') stage = s;
    }
    jobs.push({
      name,
      file: def.file,
      extendsChain: chain,
      trigger,
      gated: chain.includes('.gated'),
      requiresContainerBuild: image.length > 0,
      ...(stage ? { stage } : {}),
    });
  }
  return jobs.sort((a, b) => a.name.localeCompare(b.name));
}
