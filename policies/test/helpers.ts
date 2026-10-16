import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App, Stack, type PolicyValidationPluginReport } from 'aws-cdk-lib';
import { CfnInclude } from 'aws-cdk-lib/cloudformation-include';
import { BaselineChecks, type BaselineChecksProps } from '../src/cdk/pack.js';
import { referencedLogicalIds } from '../src/rules/util.js';
import { templateOf, type Resources } from './fixtures/cases.js';

export const tempDir = (prefix = 'starter-policies-'): string =>
  mkdtempSync(join(tmpdir(), prefix));

export const newApp = (): App =>
  new App({
    outdir: tempDir('starter-cdk-out-'),
    context: { 'aws:cdk:enable-path-metadata': true },
  });

/** Loads a fixture template into a stack (CfnInclude), synthesizes, and runs the baseline pack. */
export function nagFixture(
  resources: Resources,
  props: BaselineChecksProps = {},
): { report: PolicyValidationPluginReport; pack: BaselineChecks } {
  const dir = tempDir();
  const file = join(dir, 'fixture.template.json');
  writeFileSync(file, JSON.stringify(withStubs(resources)));
  const app = newApp();
  const stack = new Stack(app, 'Fixture');
  new CfnInclude(stack, 'Template', { templateFile: file });
  app.synth();
  const pack = new BaselineChecks(app, props);
  return { report: pack.validateScope(app), pack };
}

export const violationsFor = (report: PolicyValidationPluginReport, ruleId: string) =>
  report.violations.filter((v) => v.ruleName === ruleId);

/**
 * CfnInclude rejects dangling Ref/GetAtt targets; fixtures reference resources
 * they do not define (e.g. a KMS key ARN), so stub them with a rule-neutral type.
 */
export function withStubs(resources: Resources) {
  const template = templateOf(resources);
  const defined = new Set(Object.keys(template.Resources));
  for (const id of referencedLogicalIds(template.Resources)) {
    if (!defined.has(id)) {
      (template.Resources as Resources)[id] = { Type: 'AWS::CloudFormation::WaitConditionHandle' };
    }
  }
  return template;
}
