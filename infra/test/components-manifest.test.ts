/**
 * components.yaml carries deployment metadata (owning stack, health checks, rollback) for
 * CI and operators. Keep it truthful: every `deploy.stack` must name a real stack of every
 * stage (`{Stage}` = STAGE_IDS[env]).
 */
import { readFileSync } from 'node:fs';
import { Stack } from 'aws-cdk-lib';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { ENVIRONMENT_NAMES } from '../environments/index.js';
import { STAGE_IDS } from '../stages/workload-stage.js';
import { synthStage } from './helpers.js';

interface ManifestComponent {
  id: string;
  deploy?: { stack: string };
}

const manifest = parse(readFileSync(new URL('../../components.yaml', import.meta.url), 'utf8')) as {
  components: ManifestComponent[];
};
const deployables = manifest.components.filter(
  (c): c is ManifestComponent & { deploy: { stack: string } } => c.deploy !== undefined,
);

describe('components.yaml deployment metadata', () => {
  it('lists deployable components', () => {
    expect(deployables.map((c) => c.id)).toEqual(expect.arrayContaining(['web', 'api']));
  });

  it.each(ENVIRONMENT_NAMES)('names stacks that exist in the %s stage', (name) => {
    const { stage } = synthStage(name);
    const stackIds = stage.node.children.filter((c) => Stack.isStack(c)).map((s) => s.node.id);
    for (const component of deployables) {
      const [stagePart, stackId] = component.deploy.stack.split('/');
      expect(stagePart, component.id).toBe('{Stage}');
      expect(stackIds, `${component.id} → ${STAGE_IDS[name]}/${stackId}`).toContain(stackId);
    }
  });
});
