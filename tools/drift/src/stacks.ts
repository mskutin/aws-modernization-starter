/** Resolves deployed stack names for a stage from a CDK cloud assembly (cdk.out). */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

interface Artifact {
  type: string;
  displayName?: string;
  environment?: string;
  properties?: { directoryName?: string; displayName?: string; stackName?: string };
}

interface Manifest {
  artifacts?: Record<string, Artifact>;
}

export interface StageStack {
  stackName: string;
  displayName: string;
  account: string | undefined;
  region: string | undefined;
}

const readManifest = (dir: string): Manifest => {
  const file = join(dir, 'manifest.json');
  if (!existsSync(file))
    throw new Error(`No cloud assembly manifest at ${file} (run cdk synth first)`);
  return JSON.parse(readFileSync(file, 'utf8')) as Manifest;
};

function stacksIn(dir: string): StageStack[] {
  return Object.entries(readManifest(dir).artifacts ?? {})
    .filter(([, a]) => a.type === 'aws:cloudformation:stack')
    .map(([id, a]) => {
      const env = /^aws:\/\/([^/]+)\/(.+)$/.exec(a.environment ?? '');
      return {
        stackName: a.properties?.stackName ?? id,
        displayName: a.displayName ?? id,
        account: env?.[1] && !env[1].startsWith('unknown') ? env[1] : undefined,
        region: env?.[2] && !env[2].startsWith('unknown') ? env[2] : undefined,
      };
    });
}

/**
 * Stacks of one Stage (`dev` matches the `Dev` nested assembly). Without a
 * matching nested assembly, top-level stacks whose display name starts with
 * the stage are returned.
 */
export function stageStacks(cdkOut: string, stage: string): StageStack[] {
  const root = readManifest(cdkOut);
  const nested = Object.values(root.artifacts ?? {}).find(
    (a) =>
      a.type === 'cdk:cloud-assembly' &&
      (a.properties?.displayName ?? a.displayName ?? '').toLowerCase() === stage.toLowerCase(),
  );
  if (nested?.properties?.directoryName)
    return stacksIn(join(cdkOut, nested.properties.directoryName));
  return stacksIn(cdkOut).filter((s) =>
    s.displayName.toLowerCase().startsWith(`${stage.toLowerCase()}/`),
  );
}
