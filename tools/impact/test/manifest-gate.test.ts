import { describe, expect, it } from 'vitest';
import type { ImpactResult } from '../src/analyze.ts';
import { evaluateGate, passedJobsFromEnv } from '../src/gate.ts';
import { manifestJsonSchema, parseManifest } from '../src/manifest.ts';
import { FIXTURE_COMPONENTS } from './fixture.ts';

describe('components.yaml schema', () => {
  it('accepts the fixture manifest and applies defaults', () => {
    const m = parseManifest(FIXTURE_COMPONENTS);
    const contracts = m.components.find((c) => c.id === 'contracts');
    expect(contracts?.test.unit).toBe('pnpm --filter {package} run test:unit');
    expect(contracts?.build.artifact.type).toBe('none');
  });

  it.each([
    [
      'unsupported schema version',
      FIXTURE_COMPONENTS.replace('schemaVersion: 1', 'schemaVersion: 2'),
      /schemaVersion/,
    ],
    [
      'duplicate ids',
      FIXTURE_COMPONENTS.replace('id: domain', 'id: contracts'),
      /duplicate id "contracts"/,
    ],
    [
      'unknown dependsOn',
      FIXTURE_COMPONENTS.replace('dependsOn: [fn-validator]', 'dependsOn: [nope]'),
      /unknown component "nope"/,
    ],
    [
      'non-recursive glob',
      FIXTURE_COMPONENTS.replace('- docs/**/*', '- docs/**'),
      /single path segment/,
    ],
    ['bad kind', FIXTURE_COMPONENTS.replace('kind: policy', 'kind: magic'), /kind/],
    [
      'container without dockerfile',
      FIXTURE_COMPONENTS.replace('dockerfile: apps/api/Dockerfile, ', ''),
      /container-image artifacts need "dockerfile" and "image"/,
    ],
    [
      'deployable without deploy block',
      FIXTURE_COMPONENTS.replace(
        / {4}deploy:\n {6}stack: '\{Stage\}\/Web'\n {6}strategy: s3\n {6}rollback: \{ automated: false, mechanism: redeploy previous artifact \}\n/,
        '',
      ),
      /needs a "deploy" block/,
    ],
    [
      'infra without environments',
      FIXTURE_COMPONENTS.replace(
        / {4}infra:\n {6}environments: \[dev, prod\]\n {6}policyComponents: \[policies\]\n {6}finopsComponents: \[tool-finops\]\n/,
        '',
      ),
      /needs an "infra" block/,
    ],
    ['invalid yaml', 'components: [', /invalid YAML/],
  ])('rejects %s', (_name, source, message) => {
    expect(() => parseManifest(source)).toThrow(message);
  });

  it('exports a JSON schema for editor validation', () => {
    const schema = manifestJsonSchema() as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining(['schemaVersion', 'global', 'components']),
    );
  });
});

function result(partial: Partial<ImpactResult>): ImpactResult {
  return {
    schemaVersion: 1,
    mode: 'selective',
    reasons: [],
    base: null,
    head: null,
    changedFiles: [],
    files: [],
    unmapped: [],
    components: [],
    jobs: [],
    errors: [],
    ...partial,
  };
}

const job = (
  name: string,
  extra: Partial<ImpactResult['jobs'][number]> = {},
): ImpactResult['jobs'][number] => ({
  name,
  family: name.split(':')[0] ?? name,
  source: 'generated',
  gated: true,
  selected: true,
  reason: 'test',
  ...extra,
});

describe('mandatory gate', () => {
  it('collects GATE_<id> markers only', () => {
    expect(
      passedJobsFromEnv({
        GATE_1: 'lint',
        GATE_X: 'nope',
        OTHER: 'x',
        GATE_2: 'synth:infra: [dev]',
      }),
    ).toEqual(['lint', 'synth:infra: [dev]']);
  });

  it('requires selected gated jobs, ignores unselected/ungated ones', () => {
    const r = result({
      jobs: [
        job('lint'),
        job('test:web', { selected: false }),
        job('container:build:api', { gated: false }),
      ],
    });
    expect(evaluateGate(r, ['lint'])).toMatchObject({ ok: true, required: ['lint'] });
  });

  it('fails with run-all guidance when a required job is missing', () => {
    const r = result({
      mode: 'all',
      reasons: ['change set unknown'],
      jobs: [job('lint'), job('test:api')],
    });
    const outcome = evaluateGate(r, ['lint']);
    expect(outcome.ok).toBe(false);
    expect(outcome.missing).toEqual(['test:api']);
    expect(outcome.messages.join()).toMatch(/IMPACT_RUN_ALL=true/);
    // The MR path is a temporary project variable, not the Run pipeline form.
    expect(outcome.messages.join()).toMatch(
      /project CI\/CD variable IMPACT_RUN_ALL=true, re-runs the MR pipeline/,
    );
    expect(outcome.messages.join()).toMatch(/MR pipelines accept no run-time variables/);
  });

  it('accepts matrix instances and detects partial matrices', () => {
    const synth = job('synth:infra', { matrix: { variable: 'CDK_ENV', values: ['dev', 'prod'] } });
    expect(
      evaluateGate(result({ jobs: [synth] }), ['synth:infra: [dev]', 'synth:infra: [prod]']).ok,
    ).toBe(true);
    const partial = evaluateGate(result({ jobs: [synth] }), ['synth:infra: [dev]']);
    expect(partial.ok).toBe(false);
    expect(partial.messages.join()).toMatch(/1\/2 matrix instances/);
  });

  it('does not confuse job names sharing a prefix', () => {
    const r = result({ jobs: [job('test:api')] });
    expect(evaluateGate(r, ['test:api-client']).ok).toBe(false);
  });

  it('fails when the impact analysis itself reported errors', () => {
    expect(evaluateGate(result({ errors: ['unmapped'] }), []).ok).toBe(false);
  });
});
