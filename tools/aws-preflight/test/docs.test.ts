import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  iamPolicy,
  POLICY_PATH,
  README_PATH,
  renderPolicyFile,
  renderReadme,
} from '../src/plan.ts';
import { PROBES, VERIFIED_CLI_NIXPKGS_REV, VERIFIED_CLI_VERSION } from '../src/probes.ts';

describe('generated artefacts match the allowlist', () => {
  it('README probe table (regenerate: node tools/aws-preflight/src/cli.ts plan --write)', async () => {
    const current = readFileSync(README_PATH, 'utf8');
    expect(await renderReadme(current)).toBe(current);
    for (const def of PROBES) expect(current).toContain(`\`${def.id}\``);
  });

  it('iam/discovery-readonly-policy.json (regenerate with plan --write)', async () => {
    const current = readFileSync(POLICY_PATH, 'utf8');
    expect(await renderPolicyFile()).toBe(current);
    expect(JSON.parse(current)).toEqual(iamPolicy());
  });
});

describe('README statements that must stay true', () => {
  const readme = readFileSync(README_PATH, 'utf8');

  it('states the allowlist size the registry has', () => {
    const ops = new Set(PROBES.map((p) => `${p.service} ${p.operation}`)).size;
    const actions = new Set(PROBES.map((p) => p.iamAction)).size;
    const services = new Set(PROBES.map((p) => p.service)).size;
    expect(readme).toContain(
      `${PROBES.length} probe definitions, ${ops} AWS CLI\n  operations, ${actions} IAM actions, ${services} services`,
    );
  });

  it('names the CLI pin, the trust assumptions, logout and raw-directory retention', () => {
    expect(readme).toContain(`github:NixOS/nixpkgs/${VERIFIED_CLI_NIXPKGS_REV}#awscli2`);
    expect(readme).toContain(`**${VERIFIED_CLI_VERSION}**`);
    expect(readme).toContain('### Trust assumptions');
    expect(readme).toContain('aws sso logout');
    expect(readme).toContain('rests **entirely on this tool**');
    expect(readme).toContain('DescribeBudgetPerformanceHistory');
    expect(readme).toContain('aws-portal:ViewBilling');
    expect(readme).toMatch(/delete the raw run directory/);
    // The rev-1 claims that were wrong must not come back.
    expect(readme).not.toContain('there is no code path');
    expect(readme).not.toMatch(/ReadOnlyAccess`?: it cannot change resources/);
    expect(readme).not.toContain('Console output is sanitized the same way');
  });
});
