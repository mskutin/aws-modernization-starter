import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { INFRA_ROOT, REPO_ROOT } from './paths.js';

/**
 * Where the Lambda handler sources come from:
 *  - `source`   : the real handlers in `functions/<name>/src/` (default)
 *  - `fixtures` : minimal stand-ins in `infra/test/fixtures/handlers/` used by
 *                 infra tests and for synth before the real handlers exist.
 */
export type HandlerSource = 'source' | 'fixtures';

/**
 * Which entry modules of the real handlers:
 *  - `stage`       : production entries (documents from PostgreSQL via `load_job_document`)
 *  - `integration` : the AWS integration mini-stack's entries — same step code, documents from
 *                    its TEST-ONLY document table (ADR 0232); never used by the stages.
 */
export type HandlerVariant = 'stage' | 'integration';

export interface WorkflowHandlerEntries {
  readonly validator: string;
  readonly processor: string;
  readonly reconciler: string;
}

export function handlerEntries(
  source: HandlerSource,
  variant: HandlerVariant = 'stage',
): WorkflowHandlerEntries {
  if (source === 'fixtures') {
    return {
      validator: path.join(INFRA_ROOT, 'test/fixtures/handlers/validator.ts'),
      processor: path.join(INFRA_ROOT, 'test/fixtures/handlers/processor.ts'),
      reconciler: path.join(INFRA_ROOT, 'test/fixtures/handlers/reconciler.ts'),
    };
  }
  const step = variant === 'integration' ? 'integration-handler.ts' : 'handler.ts';
  return {
    validator: path.join(REPO_ROOT, `functions/validator/src/${step}`),
    processor: path.join(REPO_ROOT, `functions/processor/src/${step}`),
    reconciler: path.join(REPO_ROOT, 'functions/reconciler/src/handler.ts'),
  };
}

/** Workspace (`@starter/*`) dependencies of a function package whose `dist` is missing. */
export function unbuiltWorkspaceDependencies(functionDir: string): string[] {
  const manifest = JSON.parse(readFileSync(path.join(functionDir, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const missing: string[] = [];
  for (const dep of Object.keys(manifest.dependencies ?? {}).filter((d) =>
    d.startsWith('@starter/'),
  )) {
    const depDir = path.join(functionDir, 'node_modules', dep);
    const depManifestPath = path.join(depDir, 'package.json');
    if (!existsSync(depManifestPath)) {
      missing.push(`${dep} (not installed)`);
      continue;
    }
    const depManifest = JSON.parse(readFileSync(depManifestPath, 'utf8')) as {
      exports?: Record<string, { default?: string } | string>;
    };
    const root = depManifest.exports?.['.'];
    const target = typeof root === 'string' ? root : root?.default;
    if (target && !existsSync(path.join(depDir, target))) missing.push(dep);
  }
  return missing;
}

/** Resolves entries and fails with an actionable message if anything is missing. */
export function resolveHandlerEntries(
  sourceValue: unknown,
  variant: HandlerVariant = 'stage',
): WorkflowHandlerEntries {
  const source = sourceValue ?? 'source';
  if (source !== 'source' && source !== 'fixtures') {
    throw new Error(
      `Invalid context lambdaHandlers=${String(source)}; expected "source" or "fixtures"`,
    );
  }
  const entries = handlerEntries(source, variant);
  for (const [name, file] of Object.entries(entries)) {
    if (!existsSync(file)) {
      throw new Error(
        `Lambda handler entry for ${name} not found: ${file}. ` +
          (source === 'source'
            ? 'Check out the functions workspace, or synth with -c lambdaHandlers=fixtures.'
            : 'The infra test fixtures are missing.'),
      );
    }
    if (source === 'source') {
      // Handlers import workspace packages through their `exports` -> dist/.
      const unbuilt = unbuiltWorkspaceDependencies(path.resolve(path.dirname(file), '..'));
      if (unbuilt.length > 0) {
        throw new Error(
          `Lambda ${name} depends on unbuilt workspace packages: ${unbuilt.join(', ')}. ` +
            'Run `pnpm --filter @starter/infra... build` before synth.',
        );
      }
    }
  }
  return entries;
}
