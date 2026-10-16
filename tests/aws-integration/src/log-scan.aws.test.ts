/**
 * REAL AWS (opt-in, see aws-gate.ts): CloudWatch Logs canary scan WITH POSITIVE CONTROLS.
 *
 * A zero-hit scan proves nothing unless the scan demonstrably sees the run's logs. Per log group
 * this test therefore requires a positive control before it counts canary hits:
 *   - state machine group: a marker deliberately placed in one execution INPUT must be found
 *     (the mini-stack logs execution data, `includeExecutionData: true`) — proves delivery,
 *     group name and matching on real, JSON-escaped log events;
 *   - validator / processor groups: the (non-sensitive) job id of this test's canary job must be
 *     found in their structured logs;
 *   - reconciler group: its Embedded Metric Format record (namespace Workload/Reconciler).
 * Then it counts events containing any canary marker: this test's canary document markers and the
 * literal prefixes every `leakCanary()` / `rejectedLeakCanary()` marker of the whole run carries
 * ("Canary title", "Canary sentence"). Expected: 0 in every group. Counts only — matched text is
 * never recorded.
 *
 * Lambda logs "might take 5 to 10 minutes" to appear (Lambda developer guide): the controls are
 * polled for up to 8 minutes.
 * Two tests: the Lambda groups, and the state machine group (whose execution-data logging the
 * local emulator does not deliver).
 * Evidence: reports/aws-integration/evidence/log-canary-scan-{lambda,state-machine}.json.
 */
import { randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
  type FilteredLogEvent,
} from '@aws-sdk/client-cloudwatch-logs';
import { RECONCILER_METRICS, serializeExecutionInput } from '@starter/workflow-processing';
import { VALID_DOCUMENT, anExecutionInput, leakCanary } from '@starter/testing';
import { resolveAwsGate } from './aws-gate.js';
import {
  LiveHarness,
  emulatorNotApplicable,
  executionSummary,
  recordEvidence,
  titled,
  suiteTitle,
} from './live-harness.js';

const gate = await resolveAwsGate(process.env);
const title = gate.enabled
  ? suiteTitle('log canary scan')
  : `${suiteTitle('log canary scan')} [SKIPPED: ${gate.reason}]`;

const CONTROL_DEADLINE_MS = 8 * 60_000;
/** Literal prefixes of every canary marker the suite generates (@starter/testing). */
const CANARY_LITERALS = ['Canary title', 'Canary sentence'];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe.skipIf(!gate.enabled)(title, () => {
  let h: LiveHarness;
  let logs: CloudWatchLogsClient;

  beforeAll(async () => {
    if (!gate.enabled) return;
    h = await LiveHarness.create(gate);
    logs = new CloudWatchLogsClient({ region: gate.region });
  });
  afterAll(() => {
    h?.destroy();
    logs?.destroy();
  });

  /** Every event of a group (the groups exist only for this run). */
  async function allEvents(logGroupName: string): Promise<FilteredLogEvent[]> {
    const events: FilteredLogEvent[] = [];
    let nextToken: string | undefined;
    do {
      const page = await logs.send(new FilterLogEventsCommand({ logGroupName, nextToken }));
      events.push(...(page.events ?? []));
      nextToken = page.nextToken;
    } while (nextToken);
    return events;
  }

  interface GroupSpec {
    name: string;
    control: string;
    controlKind: string;
  }

  /** Polls every group until its positive control is visible (bounded), then counts. */
  async function scan(groups: Record<string, GroupSpec>, extraMarkers: readonly string[]) {
    const deadline = Date.now() + CONTROL_DEADLINE_MS;
    const t0 = Date.now();
    let events: Record<string, FilteredLogEvent[]>;
    let missing: string[];
    for (;;) {
      events = {};
      for (const [key, g] of Object.entries(groups)) events[key] = await allEvents(g.name);
      missing = Object.entries(groups)
        .filter(
          ([key, g]) => !(events[key] ?? []).some((e) => (e.message ?? '').includes(g.control)),
        )
        .map(([key]) => key);
      if (missing.length === 0 || Date.now() > deadline) break;
      await sleep(15_000);
    }
    const markers = [...CANARY_LITERALS, ...extraMarkers];
    const perGroup = Object.fromEntries(
      Object.entries(groups).map(([key, g]) => {
        const list = events[key] ?? [];
        return [
          key,
          {
            logGroupName: g.name,
            events: list.length,
            positiveControl: g.controlKind,
            positiveControlHits: list.filter((e) => (e.message ?? '').includes(g.control)).length,
            canaryHits: list.filter((e) => markers.some((m) => (e.message ?? '').includes(m)))
              .length,
          },
        ];
      }),
    );
    return {
      missing,
      perGroup,
      secondsUntilAllControlsVisible:
        missing.length === 0 ? Math.round((Date.now() - t0) / 1000) : null,
    };
  }

  function expectClean(result: Awaited<ReturnType<typeof scan>>) {
    expect(result.missing).toEqual([]);
    for (const g of Object.values(result.perGroup)) {
      expect(g.events).toBeGreaterThan(0);
      expect(g.positiveControlHits).toBeGreaterThan(0);
      expect(g.canaryHits).toBe(0);
    }
  }

  it(
    'Lambda groups (validator, processor, reconciler): positive control found, no canary marker',
    async () => {
      // A canary job (document markers must never reach a log) and one reconciler run (EMF).
      const canary = leakCanary();
      const input = anExecutionInput({ submittedAt: new Date().toISOString() });
      await h.seed(input, { title: canary.title, content: canary.content });
      const canaryRun = await h.waitForCompletion(await h.start(input));
      await h.invokeReconciler();
      const result = await scan(
        {
          validator: {
            name: h.output('validatorLogGroupName'),
            control: input.jobId,
            controlKind: 'job id of the canary job',
          },
          processor: {
            name: h.output('processorLogGroupName'),
            control: input.jobId,
            controlKind: 'job id of the canary job',
          },
          reconciler: {
            name: h.output('reconcilerLogGroupName'),
            control: RECONCILER_METRICS.namespace,
            controlKind: 'EMF metrics record',
          },
        },
        canary.markers,
      );
      recordEvidence('log-canary-scan-lambda', {
        canaryJob: { jobId: input.jobId, ...executionSummary(canaryRun) },
        markerKinds: ['Canary title', 'Canary sentence', 'this test canary token/sentence/title'],
        controlsMissing: result.missing,
        secondsUntilAllControlsVisible: result.secondsUntilAllControlsVisible,
        groups: result.perGroup,
      });

      expect(canaryRun.status).toBe('SUCCEEDED');
      expectClean(result);
    },
    CONTROL_DEADLINE_MS + 120_000,
  );

  it.skipIf(emulatorNotApplicable('sfnExecutionLogs') !== undefined)(
    titled(
      'state machine group: a marker placed in an execution input is found (execution data logged), no canary marker',
      'sfnExecutionLogs',
    ),
    async () => {
      const marker = `Positive control ${Array.from({ length: 16 }, () => randomInt(10)).join('')}`;
      const control = anExecutionInput({ submittedAt: new Date().toISOString() });
      await h.seed(control, { title: 'log control', content: VALID_DOCUMENT });
      const controlRun = await h.waitForCompletion(
        await h.start(control, {
          rawInput: JSON.stringify({
            ...JSON.parse(serializeExecutionInput(control)),
            payload: { title: marker },
          }),
        }),
      );
      const result = await scan(
        {
          stateMachine: {
            name: h.output('stateMachineLogGroupName'),
            control: marker,
            controlKind: 'marker in an execution input (execution data logged)',
          },
        },
        [],
      );
      recordEvidence('log-canary-scan-state-machine', {
        controlJob: { jobId: control.jobId, ...executionSummary(controlRun) },
        controlsMissing: result.missing,
        secondsUntilAllControlsVisible: result.secondsUntilAllControlsVisible,
        groups: result.perGroup,
      });

      expect(controlRun.status).toBe('SUCCEEDED');
      expectClean(result);
    },
    CONTROL_DEADLINE_MS + 120_000,
  );
});
