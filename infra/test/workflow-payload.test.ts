/**
 * Workflow payload minimization and single-reconciler checks across every deployable variant (Dev, Staging, Prod and the integration
 * mini-stack): the synthesized workflows pass only the job reference to their tasks, no state
 * reads or forwards document data or analysis results, the stages load documents only from
 * PostgreSQL with IAM auth + verify-full, the mini-stack only from its TEST-ONLY table, and each
 * stage has exactly one reconciler. Offline synth — nothing here proves AWS behaviour.
 */
import { ENVIRONMENT_NAMES, type EnvironmentName } from '../environments/index.js';
import { TASK_EVENT_KEYS, PROCESSING_WORKFLOW } from '@starter/workflow-processing';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import {
  IntegrationWorkflowStack,
  integrationRequiredTags,
} from '../stacks/integration-workflow-stack.js';
import {
  FIXTURE_ENTRIES,
  newApp,
  resourcesOf,
  stateMachineDefinition,
  synthStage,
} from './helpers.js';

const FORBIDDEN_PATH = /\$\.(payload|content|title|document|validation|processing|result)\b/;

function workflowStack(): Template {
  const app = newApp();
  return Template.fromStack(
    new IntegrationWorkflowStack(app, 'IntegrationWorkflowStack', {
      env: { region: 'ap-southeast-1' },
      runId: 'payload-check',
      expiresAt: '2030-01-01T00:00:00.000Z',
      handlerEntries: FIXTURE_ENTRIES,
      requiredTags: integrationRequiredTags(),
    }),
  );
}

const variants: [string, () => Template][] = [
  ...ENVIRONMENT_NAMES.map(
    (name: EnvironmentName) =>
      [name, () => synthStage(name).templates.Workflow] as [string, () => Template],
  ),
  ['integration mini-stack', workflowStack],
];

const functionEnv = (template: Template) =>
  resourcesOf(template, 'AWS::Lambda::Function').map(([id, fn]) => ({
    id,
    vars: (fn.Environment as { Variables: Record<string, unknown> }).Variables,
  }));

describe.each(variants)('synthesized workflow: %s', (name, template) => {
  const t = template();
  const def = stateMachineDefinition(t);

  it('passes each task exactly the job reference + execution ARN, and discards task results', () => {
    for (const task of Object.values(PROCESSING_WORKFLOW.tasks)) {
      const state = def.States[task.state]!;
      const keys = Object.keys(state.Parameters as object).map((k) => k.replace(/\.\$$/, ''));
      expect(keys).toEqual([...TASK_EVENT_KEYS]);
      expect(state.ResultPath).toBeNull();
    }
  });

  it('no state reads or forwards document data, idempotency keys or analysis results', () => {
    for (const [stateName, state] of Object.entries(def.States)) {
      const text = JSON.stringify(state);
      expect(text, stateName).not.toMatch(FORBIDDEN_PATH);
      expect(text, stateName).not.toMatch(/idempotencyKey/);
    }
  });

  it('keeps STEP# audit items until a retention policy is approved (no JOB_AUDIT_TTL_DAYS)', () => {
    for (const { vars } of functionEnv(t)) expect(vars).not.toHaveProperty('JOB_AUDIT_TTL_DAYS');
  });

  if (name === 'integration mini-stack') {
    it('reads documents from the TEST-ONLY table, never a database', () => {
      const steps = functionEnv(t).filter(({ vars }) => 'TEST_DOCUMENTS_TABLE_NAME' in vars);
      expect(steps).toHaveLength(2);
      for (const { vars } of functionEnv(t)) {
        expect(Object.keys(vars).filter((k) => k.startsWith('DB_'))).toEqual([]);
      }
    });
  } else {
    it('reads documents only through PostgreSQL as starter_processor (IAM auth, verify-full)', () => {
      const env = functionEnv(t);
      const steps = env.filter(({ id }) => /Validator|Processor/.test(id));
      expect(steps).toHaveLength(2);
      for (const { vars } of steps) {
        expect(vars).toMatchObject({
          DB_USER: 'starter_processor',
          DB_AUTH: 'iam',
          DB_SSL: 'verify-full',
        });
      }
      for (const { vars } of env) {
        expect(vars).not.toHaveProperty('TEST_DOCUMENTS_TABLE_NAME');
        expect(vars).not.toHaveProperty('DB_PASSWORD');
        expect(vars).not.toHaveProperty('APP_RUNTIME');
      }
    });

    it('has exactly one scheduled reconciler (reserved concurrency 1)', () => {
      const reconcilers = resourcesOf(t, 'AWS::Lambda::Function').filter(([id]) =>
        id.startsWith('ReconcilerFunction'),
      );
      expect(reconcilers.map(([, fn]) => fn.ReservedConcurrentExecutions)).toEqual([1]);
      expect(resourcesOf(t, 'AWS::Events::Rule')).toHaveLength(1);
      const policies = JSON.stringify(t.toJSON());
      expect(policies).not.toMatch(/states:StartExecution/);
    });
  }
});
