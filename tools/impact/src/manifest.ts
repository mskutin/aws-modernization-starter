import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import { lintPattern } from './glob.ts';

/**
 * components.yaml — the machine-readable component manifest.
 *
 * It is the single input for: impact analysis, the generated GitLab job/rule
 * file, the mandatory gate, and deployment/rollback documentation. Adding a
 * service or Lambda = add a workspace package + one entry here, then run
 * `pnpm --filter @starter/tool-impact run generate`.
 */

export const SCHEMA_VERSION = 1;

export const COMPONENT_KINDS = [
  'spa',
  'service',
  'lambda',
  'workflow',
  'library',
  'infra',
  'datastore',
  'policy',
  'tool',
  'test-suite',
] as const;

export const ARTIFACT_TYPES = [
  'none',
  'static-site',
  'node-dist',
  'lambda-bundle',
  'container-image',
  'cdk-assembly',
  'library-dist',
] as const;

const id = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/, 'component ids are lower-case kebab-case (used in job names)');

const pattern = z
  .string()
  .min(1)
  .superRefine((value, ctx) => {
    const problem = lintPattern(value);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  });

const command = z.string().min(1);

const healthCheck = z.object({
  type: z.enum(['http', 'container', 'lambda-invoke', 'state-machine', 'cloudfront', 'sql']),
  target: z.string().describe('Path, URL template, function alias or query used by the check'),
  expect: z.string().optional().describe('Expected outcome, e.g. "200" or "SUCCEEDED"'),
});

const artifact = z
  .object({
    type: z.enum(ARTIFACT_TYPES),
    location: z.string().optional().describe('Repo-relative build output location'),
    dockerfile: z.string().optional().describe('Required for container-image artifacts'),
    image: z
      .string()
      .regex(/^[a-z0-9][a-z0-9._/-]*$/)
      .optional()
      .describe('Repository name inside the registry, e.g. "starter/api"'),
    context: z.string().default('.').describe('Container build context (repo-relative)'),
    ignoreFile: z.string().optional().describe('Container build ignore file'),
  })
  .superRefine((value, ctx) => {
    if (value.type === 'container-image' && (!value.dockerfile || !value.image)) {
      ctx.addIssue({
        code: 'custom',
        message: 'container-image artifacts need "dockerfile" and "image"',
      });
    }
  });

const build = z.object({
  command: command
    .nullable()
    .default(null)
    .describe(
      'Defaults to `pnpm --filter <package> run build`; null when the package has no build',
    ),
  artifact: artifact.default({ type: 'none', context: '.' }),
});

const test = z.object({
  typecheck: z.boolean().default(true),
  unit: command
    .nullable()
    .default('pnpm --filter {package} run test:unit')
    .describe('null = no unit tests (the test job still builds and typechecks)'),
  unitRunner: z
    .enum(['vitest', 'other'])
    .default('vitest')
    .describe('vitest: CI appends JUnit + Cobertura reporter flags'),
  integration: command
    .optional()
    .describe(
      'Generates an integration:<id> job (after the gate) with PostgreSQL + DynamoDB Local services',
    ),
  integrationRunner: z
    .enum(['vitest', 'other'])
    .default('vitest')
    .describe('vitest: CI appends JUnit reporter flags to the integration command'),
});

const rollback = z.object({
  automated: z.boolean(),
  mechanism: z.string().min(1),
});

const deploy = z.object({
  stack: z
    .string()
    .regex(/^\{Stage\}\/[A-Za-z][A-Za-z0-9]*$/, 'must be {Stage}/<StackId>')
    .describe('Owning CDK stack: {Stage} = Dev | Staging | Prod (infra/stages STAGE_IDS)'),
  strategy: z.string().min(1),
  healthChecks: z.array(healthCheck).default([]),
  rollback,
});

const migrations = z.object({
  path: z.string(),
  command: z.string(),
  runs: z.string().describe('Where/when migrations run'),
  policy: z.enum(['expand-contract', 'forward-only']),
  rollback: z.string(),
});

const componentCi = z.object({
  variables: z
    .record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), z.string())
    .default({})
    .describe("Extra job variables for this component's generated jobs (no secrets)"),
  setup: z
    .array(command)
    .default([])
    .describe('Commands run before build/tests in generated jobs (e.g. pinned tool installs)'),
});

const infraCi = z.object({
  environments: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)).min(1),
  policyComponents: z
    .array(id)
    .default([])
    .describe('Components whose change re-runs the policy check'),
  finopsComponents: z
    .array(id)
    .default([])
    .describe('Components whose change re-runs the FinOps diff'),
});

export const componentSchema = z.object({
  id,
  kind: z.enum(COMPONENT_KINDS),
  description: z.string().optional(),
  path: z.string().optional().describe('Workspace package directory (absent for datastores)'),
  package: z.string().optional().describe('Workspace package name'),
  owner: z.string().optional().describe('Owning team'),
  dependsOn: z
    .array(id)
    .default([])
    .describe('Extra component edges not visible in package.json (e.g. infra bundles lambdas)'),
  extraPaths: z
    .array(pattern)
    .default([])
    .describe('Non-package paths whose change affects this component'),
  build: build.default({ command: null, artifact: { type: 'none', context: '.' } }),
  test: test.default({
    typecheck: true,
    unit: 'pnpm --filter {package} run test:unit',
    unitRunner: 'vitest',
    integrationRunner: 'vitest',
  }),
  deploy: deploy.optional(),
  migrations: migrations.optional(),
  infra: infraCi.optional().describe('Only for kind=infra: synth matrix and policy/FinOps inputs'),
  ci: componentCi.default({ variables: {}, setup: [] }),
});

export const manifestSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    global: z
      .array(pattern)
      .min(1)
      .describe('Changing any of these runs EVERY job (fail-safe for shared config)'),
    nonComponent: z
      .array(pattern)
      .default([])
      .describe('Known paths that affect no component (docs etc.): only repo-wide jobs run'),
    components: z.array(componentSchema).min(1),
  })
  .superRefine((m, ctx) => {
    const ids = new Set<string>();
    const packages = new Set<string>();
    for (const [index, c] of m.components.entries()) {
      if (ids.has(c.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['components', index, 'id'],
          message: `duplicate id "${c.id}"`,
        });
      }
      ids.add(c.id);
      if (c.package) {
        if (packages.has(c.package)) {
          ctx.addIssue({
            code: 'custom',
            path: ['components', index, 'package'],
            message: `package "${c.package}" declared twice`,
          });
        }
        packages.add(c.package);
      }
      if (c.kind !== 'datastore' && (!c.path || !c.package)) {
        ctx.addIssue({
          code: 'custom',
          path: ['components', index],
          message: `component "${c.id}" (${c.kind}) needs "path" and "package"`,
        });
      }
      if (c.kind === 'infra' && !c.infra) {
        ctx.addIssue({
          code: 'custom',
          path: ['components', index, 'infra'],
          message: `infra component "${c.id}" needs an "infra" block (environments)`,
        });
      }
      if (['service', 'lambda', 'spa', 'workflow', 'datastore'].includes(c.kind) && !c.deploy) {
        ctx.addIssue({
          code: 'custom',
          path: ['components', index, 'deploy'],
          message: `deployable component "${c.id}" (${c.kind}) needs a "deploy" block (stack, strategy, health checks, rollback)`,
        });
      }
    }
    for (const [index, c] of m.components.entries()) {
      const refs = [
        ...c.dependsOn,
        ...(c.infra?.policyComponents ?? []),
        ...(c.infra?.finopsComponents ?? []),
      ];
      for (const ref of refs) {
        if (!ids.has(ref)) {
          ctx.addIssue({
            code: 'custom',
            path: ['components', index],
            message: `component "${c.id}" references unknown component "${ref}"`,
          });
        }
      }
    }
  });

export type Manifest = z.infer<typeof manifestSchema>;
export type Component = z.infer<typeof componentSchema>;

export class ManifestError extends Error {
  override name = 'ManifestError';
}

export function parseManifest(source: string, origin = 'components.yaml'): Manifest {
  let raw: unknown;
  try {
    raw = parse(source);
  } catch (error) {
    throw new ManifestError(`${origin}: invalid YAML: ${(error as Error).message}`);
  }
  const result = manifestSchema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new ManifestError(`${origin}: schema validation failed\n${details}`);
  }
  return result.data;
}

export function loadManifest(file: string): Manifest {
  return parseManifest(readFileSync(file, 'utf8'), file);
}

export function manifestJsonSchema(): unknown {
  return z.toJSONSchema(manifestSchema, { io: 'input', unrepresentable: 'any' });
}
