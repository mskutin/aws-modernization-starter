/**
 * TEST ONLY — fault injection for the AWS integration mini-stack (live validation).
 *
 * The real-AWS tests need failures that production code never produces on demand: a transient
 * dependency failure that heals on retry, and a slow dependency that outlasts a timeout. A test
 * asks for one by writing a `testFault` attribute on the SYNTHETIC document item it seeds in the
 * mini-stack's TEST-ONLY document table (`./test-table`, ADR 0232). The mini-stack's integration
 * handler entries (`functions/{validator,processor}/src/integration-handler.ts`) wrap their
 * document source with `FaultInjectingDocumentSource` only when `TEST_FAULT_INJECTION=enabled`,
 * which only the mini-stack sets. The environment stages deploy neither those entries nor that
 * variable (infra tests assert both), and this module is reachable only through the
 * `@starter/documents/test-faults` subpath, so production bundles never contain it.
 *
 * Faults act inside `load()`, where a step depends on its system of record:
 *   - `transient`: the first `failures` loads of the named step throw `TransientDependencyError`
 *     (retried by the workflow per spec). Attempts are counted atomically on a
 *     `JOB#<jobId>` / `FAULT#<state>` item of the job table — the handlers' own partition, so
 *     their least-privilege grant (`dynamodb:LeadingKeys = JOB#*`) covers it.
 *   - `delay`: the load first waits `seconds` (a slow dependency), then continues normally.
 * Nothing else changes: the step logic, the state machine and the data written are the real ones.
 */
import { GetCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { TransientDependencyError } from '@starter/domain';
import { ProcessingState, jobStateKey } from '@starter/workflow-processing';
import { z } from 'zod';
import { DocumentSourceError, classifySourceError } from './errors.js';
import { TEST_DOCUMENT_TABLE_KEY } from './test-table.js';
import type { DocumentSource, StoredDocument } from './types.js';

/** Environment variable that arms fault injection (value `enabled`); set by the mini-stack only. */
export const TEST_FAULT_INJECTION_ENV = 'TEST_FAULT_INJECTION';
/** Attribute of a test document item that carries its fault plan. */
export const TEST_FAULT_ATTRIBUTE = 'testFault';
/** Attribute of the fault counter item (`JOB#<jobId>` / `FAULT#<state>`). */
export const FAULT_ATTEMPTS_ATTRIBUTE = 'attempts';

export const FAULT_STEPS = [ProcessingState.Validate, ProcessingState.Process] as const;
export type FaultStep = (typeof FAULT_STEPS)[number];

/**
 * Longest injected delay: below the processor's 60 s task and Lambda timeout, so a delayed
 * ProcessJob still completes (the execution-timeout test observes that late completion). The
 * same bound applies to ValidateJob on purpose: its timeout is 20 s, so any validator delay above
 * 20 s ends with the Lambda stopped at its timeout (the task-timeout test uses 25 s).
 */
export const MAX_FAULT_DELAY_SECONDS = 58;

export const TestFaultSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('transient'),
    step: z.enum(FAULT_STEPS),
    /** Loads that fail before one succeeds (within every step's retry budget of the spec). */
    failures: z.int().min(1).max(3),
  }),
  z.strictObject({
    kind: z.literal('delay'),
    step: z.enum(FAULT_STEPS),
    seconds: z.int().min(1).max(MAX_FAULT_DELAY_SECONDS),
  }),
]);
export type TestFault = z.infer<typeof TestFaultSchema>;

/** What a fault did (non-sensitive: names and counts only), for the handler's log. */
export interface InjectedFault {
  step: FaultStep;
  kind: TestFault['kind'];
  attempt?: number;
  seconds?: number;
}

/** Key of the attempt counter of `step` for `jobId` (inside the job's own partition). */
export const faultAttemptKey = (jobId: string, step: FaultStep) =>
  ({ pk: jobStateKey(jobId).pk, sk: `FAULT#${step}` }) as const;

/** A seeded test document item with a fault plan attached (validated: a typo fails the test). */
export function withTestFault(
  item: Record<string, unknown>,
  fault: TestFault,
): Record<string, unknown> {
  return { ...item, [TEST_FAULT_ATTRIBUTE]: TestFaultSchema.parse(fault) };
}

/** `true` only for `TEST_FAULT_INJECTION=enabled`; unset/empty is off; anything else is an error. */
export function testFaultInjectionEnabled(env: Record<string, string | undefined>): boolean {
  const value = env[TEST_FAULT_INJECTION_ENV];
  if (value === undefined || value === '') return false;
  if (value === 'enabled') return true;
  throw new Error(`${TEST_FAULT_INJECTION_ENV} must be "enabled" or unset`);
}

export interface FaultInjectionOptions {
  client: Pick<DynamoDBDocumentClient, 'send'>;
  /** The TEST-ONLY document table that holds the fault plans. */
  documentsTableName: string;
  /** The job table that holds the attempt counters. */
  jobsTableName: string;
  /** The state this handler implements; faults for other states are ignored. */
  step: FaultStep;
  sleep?: (ms: number) => Promise<void>;
  /** Called just before a fault takes effect. */
  onFault?: (fault: InjectedFault) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class FaultInjectingDocumentSource implements DocumentSource {
  constructor(
    private readonly inner: DocumentSource,
    private readonly options: FaultInjectionOptions,
  ) {}

  /** The state whose faults this source honours. */
  get step(): FaultStep {
    return this.options.step;
  }

  async load(jobId: string): Promise<StoredDocument> {
    const fault = await this.readFault(jobId);
    if (fault?.step === this.options.step) {
      if (fault.kind === 'delay') {
        this.options.onFault?.({ step: fault.step, kind: 'delay', seconds: fault.seconds });
        await (this.options.sleep ?? defaultSleep)(fault.seconds * 1000);
      } else {
        const attempt = await this.countAttempt(jobId);
        if (attempt <= fault.failures) {
          this.options.onFault?.({ step: fault.step, kind: 'transient', attempt });
          throw new TransientDependencyError(
            `TEST fault injection: transient failure ${attempt} of ${fault.failures} for job ${jobId}`,
          );
        }
      }
    }
    return this.inner.load(jobId);
  }

  private async readFault(jobId: string): Promise<TestFault | undefined> {
    let raw: unknown;
    try {
      const out = await this.options.client.send(
        new GetCommand({
          TableName: this.options.documentsTableName,
          Key: { [TEST_DOCUMENT_TABLE_KEY]: jobId },
          ConsistentRead: true,
          ProjectionExpression: '#fault',
          ExpressionAttributeNames: { '#fault': TEST_FAULT_ATTRIBUTE },
        }),
      );
      raw = out.Item?.[TEST_FAULT_ATTRIBUTE];
    } catch (error) {
      throw classifySourceError(error, jobId);
    }
    if (raw === undefined) return undefined;
    const parsed = TestFaultSchema.safeParse(raw);
    if (!parsed.success) {
      throw new DocumentSourceError(`invalid TEST fault plan for job ${jobId}`, 'InvalidTestFault');
    }
    return parsed.data;
  }

  private async countAttempt(jobId: string): Promise<number> {
    let attempts: unknown;
    try {
      const out = await this.options.client.send(
        new UpdateCommand({
          TableName: this.options.jobsTableName,
          Key: faultAttemptKey(jobId, this.options.step),
          UpdateExpression: 'ADD #attempts :one',
          ExpressionAttributeNames: { '#attempts': FAULT_ATTEMPTS_ATTRIBUTE },
          ExpressionAttributeValues: { ':one': 1 },
          ReturnValues: 'UPDATED_NEW',
        }),
      );
      attempts = out.Attributes?.[FAULT_ATTEMPTS_ATTRIBUTE];
    } catch (error) {
      throw classifySourceError(error, jobId);
    }
    if (typeof attempts !== 'number') {
      throw new DocumentSourceError(
        `TEST fault counter of job ${jobId} returned no count`,
        'InvalidTestFault',
      );
    }
    return attempts;
  }
}
