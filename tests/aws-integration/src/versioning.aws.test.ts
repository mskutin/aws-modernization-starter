/**
 * REAL AWS (opt-in, see aws-gate.ts): Step Functions VERSIONS and ALIASES as the deployment and
 * rollback mechanism of the workflow, and what a failing version looks like.
 *
 * The mini-stack's deploy publishes the deployed revision as a version (V1, CloudFormation) and
 * routes the `live` alias 100 % to it. The test then:
 *   1. runs a job through the alias → SUCCEEDED on V1;
 *   2. publishes a deliberately BROKEN revision as V2 (ValidateJob no longer forwards
 *      `submittedAt`: a definition that breaks the handler contract) and immediately restores the
 *      unqualified state machine ($LATEST) to the original definition;
 *   3. repoints the alias to V2 ("bad deploy") → a job through the alias FAILS (the strict
 *      handler rejects the event: JobValidationError, recorded by RecordFailure);
 *   4. rolls back by repointing the alias to V1 → the next job SUCCEEDS on V1; a job on the
 *      unqualified ARN ($LATEST, restored) succeeds too;
 *   5. deletes V2 and verifies only the CloudFormation-managed V1 remains, routed 100 %.
 *
 * UpdateStateMachineAlias is eventually consistent ("Executions started immediately after
 * calling UpdateStateMachineAlias may use the previous routing configuration", API reference):
 * after each repoint the test runs jobs until one lands on the expected version (bounded) and
 * records the ones that did not.
 *
 * Resources created outside CloudFormation: version V2 (deleted here). Should the test die before
 * that, `DeleteStateMachine` — run by the stack deletion — "also deletes all versions and aliases
 * associated with a state machine" (Step Functions API reference, DeleteStateMachine).
 * Evidence: reports/aws-integration/evidence/versioning-alias-rollback.json.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DeleteStateMachineVersionCommand,
  DescribeStateMachineAliasCommand,
  DescribeStateMachineCommand,
  ListStateMachineVersionsCommand,
  UpdateStateMachineAliasCommand,
  UpdateStateMachineCommand,
  type DescribeExecutionCommandOutput,
} from '@aws-sdk/client-sfn';
import { JobStateTable, WorkflowError, WorkflowStatus } from '@starter/workflow-processing';
import { VALID_DOCUMENT, anExecutionInput } from '@starter/testing';
import { resolveAwsGate } from './aws-gate.js';
import {
  LiveHarness,
  breakValidateParameters,
  executionSummary,
  recordEvidence,
  emulatorNotApplicable,
  suiteTitle,
} from './live-harness.js';

const gate = await resolveAwsGate(process.env);
const title = gate.enabled
  ? suiteTitle('versions and alias rollback')
  : `${suiteTitle('versions and alias rollback')} [SKIPPED: ${gate.reason}]`;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** Bound for the alias / version changes to propagate ("within a few seconds"). */
const PROPAGATION_DEADLINE_MS = 60_000;

interface JobRun {
  jobId: string;
  done: DescribeExecutionCommandOutput;
  item?: Record<string, unknown> | undefined;
}

const notApplicable = emulatorNotApplicable('versionsAliases');

describe.skipIf(!gate.enabled || notApplicable !== undefined)(
  notApplicable ? `${title} [${notApplicable}]` : title,
  () => {
    let h: LiveHarness;
    const a = JobStateTable.attributes;

    beforeAll(async () => {
      if (!gate.enabled) return;
      h = await LiveHarness.create(gate);
    });
    afterAll(() => {
      h?.destroy();
    });

    it('runs through the alias, routes it to a failing version, and rolls back by repointing it', async () => {
      // Every mutation below targets these run-owned ARNs (checked again at each call).
      const stateMachineArn = h.assertRunTarget(h.outputs.stateMachineArn, 'state machine');
      const aliasArn = h.assertRunTarget(h.output('stateMachineAliasArn'), 'alias');
      const v1 = h.assertRunTarget(h.output('stateMachineVersionArn'), 'version');

      const route = (versionArn: string) =>
        h.sfn.send(
          new UpdateStateMachineAliasCommand({
            stateMachineAliasArn: h.assertRunTarget(aliasArn, 'alias'),
            routingConfiguration: [
              { stateMachineVersionArn: h.assertRunTarget(versionArn, 'version'), weight: 100 },
            ],
          }),
        );
      const routing = async () =>
        (await h.sfn.send(new DescribeStateMachineAliasCommand({ stateMachineAliasArn: aliasArn })))
          .routingConfiguration ?? [];
      const versions = async () =>
        (
          (await h.sfn.send(new ListStateMachineVersionsCommand({ stateMachineArn })))
            .stateMachineVersions ?? []
        ).map((v) => v.stateMachineVersionArn);
      const runJob = async (label: string, via: string): Promise<JobRun> => {
        const input = anExecutionInput({ submittedAt: new Date().toISOString() });
        await h.seed(input, { title: `versioning ${label}`, content: VALID_DOCUMENT });
        const done = await h.waitForCompletion(await h.start(input, { stateMachineArn: via }));
        return { jobId: input.jobId, done, item: await h.stateItem(input.jobId) };
      };
      const summary = (run: JobRun) => ({
        jobId: run.jobId,
        ...executionSummary(run.done),
        jobStatus: run.item?.[a.status],
        jobErrorName: run.item?.[a.errorName],
      });
      /** Runs jobs through the alias until one lands on `versionArn` (alias update propagation). */
      const runOn = async (label: string, versionArn: string) => {
        const stale: Record<string, unknown>[] = [];
        const deadline = Date.now() + PROPAGATION_DEADLINE_MS;
        for (;;) {
          const run = await runJob(label, aliasArn);
          if (run.done.stateMachineVersionArn === versionArn) return { run, stale };
          stale.push(summary(run));
          if (Date.now() > deadline) {
            throw new Error(
              `alias did not route to ${versionArn} within ${PROPAGATION_DEADLINE_MS}ms`,
            );
          }
          await sleep(3_000);
        }
      };

      const evidence: Record<string, unknown> = { aliasArn, deployedVersion: v1 };
      let v2: string | undefined;
      let original: string | undefined;
      try {
        evidence.routingAtStart = await routing();
        evidence.versionsAtStart = await versions();
        expect(evidence.routingAtStart).toEqual([{ stateMachineVersionArn: v1, weight: 100 }]);
        expect(evidence.versionsAtStart).toContain(v1);

        // 1. Through the alias on the deployed version.
        const first = await runJob('v1', aliasArn);
        evidence.first = summary(first);
        expect(first.done.status).toBe('SUCCEEDED');
        expect(first.done.stateMachineAliasArn).toBe(aliasArn);
        expect(first.done.stateMachineVersionArn).toBe(v1);

        // 2. Publish a broken revision as V2; restore $LATEST at once.
        original = (await h.sfn.send(new DescribeStateMachineCommand({ stateMachineArn })))
          .definition;
        if (!original) throw new Error('DescribeStateMachine returned no definition');
        const published = await h.sfn.send(
          new UpdateStateMachineCommand({
            stateMachineArn: h.assertRunTarget(stateMachineArn, 'state machine'),
            definition: breakValidateParameters(original),
            publish: true,
            versionDescription: 'live test: deliberately broken (ValidateJob drops submittedAt)',
          }),
        );
        v2 = published.stateMachineVersionArn;
        if (!v2) throw new Error('UpdateStateMachine(publish) returned no version ARN');
        await h.sfn.send(
          new UpdateStateMachineCommand({
            stateMachineArn: h.assertRunTarget(stateMachineArn, 'state machine'),
            definition: original,
          }),
        );
        const latest = (await h.sfn.send(new DescribeStateMachineCommand({ stateMachineArn })))
          .definition;
        const v2Definition = (
          await h.sfn.send(new DescribeStateMachineCommand({ stateMachineArn: v2 }))
        ).definition;
        evidence.brokenVersion = v2;
        evidence.latestRestoredToOriginal = latest === original;
        evidence.brokenVersionDiffersFromOriginal = v2Definition !== original;
        expect(v2).not.toBe(v1);
        expect(latest).toBe(original);
        expect(v2Definition).not.toBe(original);

        // 3. "Bad deploy": the alias routes to V2 → the job fails.
        await route(v2);
        evidence.routingDuringBadDeploy = await routing();
        const bad = await runOn('v2', v2);
        evidence.duringBadDeploy = summary(bad.run);
        evidence.ranOnPreviousRoutingDuringPropagation = bad.stale;
        expect(bad.run.done.status).toBe('FAILED');
        expect(bad.run.done.error).toBe(WorkflowError.Validation);
        expect(bad.run.done.stateMachineAliasArn).toBe(aliasArn);
        expect(bad.run.item?.[a.status]).toBe(WorkflowStatus.Failed);
        expect(bad.run.item?.[a.errorName]).toBe(WorkflowError.Validation);

        // 4. Roll back: the alias routes to V1 again; $LATEST serves the original definition.
        await route(v1);
        evidence.routingAfterRollback = await routing();
        const rolledBack = await runOn('rollback', v1);
        evidence.afterRollback = summary(rolledBack.run);
        evidence.ranOnPreviousRoutingAfterRollback = rolledBack.stale;
        expect(rolledBack.run.done.status).toBe('SUCCEEDED');
        expect(rolledBack.run.item?.[a.status]).toBe(WorkflowStatus.Succeeded);
        const unqualified = await runJob('latest', stateMachineArn);
        evidence.unqualified = summary(unqualified);
        expect(unqualified.done.status).toBe('SUCCEEDED');
        expect(unqualified.done.stateMachineVersionArn).toBeUndefined();
      } finally {
        // Leave the stack as CloudFormation deployed it, whatever happened above.
        const cleanup: Record<string, unknown> = {};
        await route(v1).then(
          () => (cleanup.aliasRoutedToV1 = true),
          (e: unknown) => (cleanup.aliasRoutedToV1 = `failed: ${String(e)}`),
        );
        if (original) {
          await h.sfn
            .send(
              new UpdateStateMachineCommand({
                stateMachineArn: h.assertRunTarget(stateMachineArn, 'state machine'),
                definition: original,
              }),
            )
            .then(
              () => (cleanup.latestRestored = true),
              (e: unknown) => (cleanup.latestRestored = `failed: ${String(e)}`),
            );
        }
        if (v2) {
          // A version still referenced by the (eventually consistent) alias cannot be deleted yet.
          const deadline = Date.now() + PROPAGATION_DEADLINE_MS;
          let deleted = false;
          for (;;) {
            if (!deleted) {
              try {
                await h.sfn.send(
                  new DeleteStateMachineVersionCommand({
                    stateMachineVersionArn: h.assertRunTarget(v2, 'version'),
                  }),
                );
                deleted = true;
              } catch (e) {
                cleanup.lastDeleteError = String(e);
              }
            }
            if (deleted && !(await versions()).includes(v2)) {
              cleanup.brokenVersionDeleted = true;
              break;
            }
            if (Date.now() > deadline) {
              cleanup.brokenVersionDeleted = deleted ? 'deleted but still listed' : 'not deleted';
              break;
            }
            await sleep(3_000);
          }
        }
        cleanup.versionsAfterCleanup = await versions().catch((e: unknown) => String(e));
        cleanup.routingAfterCleanup = await routing().catch((e: unknown) => String(e));
        evidence.cleanup = cleanup;
        recordEvidence('versioning-alias-rollback', evidence);
      }
      expect(evidence.cleanup).toMatchObject({
        aliasRoutedToV1: true,
        latestRestored: true,
        brokenVersionDeleted: true,
        versionsAfterCleanup: [v1],
        routingAfterCleanup: [{ stateMachineVersionArn: v1, weight: 100 }],
      });
    });
  },
);
