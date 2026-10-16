import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { TransientDependencyError } from '@starter/domain';
import { ProcessingState, WorkflowError } from '@starter/workflow-processing';
import { describe, expect, it } from 'vitest';
import { DocumentSourceError, InMemoryDocumentSource } from '../src/index.js';
import {
  FaultInjectingDocumentSource,
  TEST_FAULT_ATTRIBUTE,
  TestFaultSchema,
  faultAttemptKey,
  testFaultInjectionEnabled,
  withTestFault,
  type InjectedFault,
  type TestFault,
} from '../src/test-faults.js';
import { testDocumentItem } from '../src/test-table.js';

const JOB = '0d3b7f46-2a4f-4d43-9a0e-2f4c3c7b8e11';
const CONTENT = 'Cloud migration is a journey. Every migration starts with discovery and planning.';

/** In-memory stand-in for the two tables the decorator touches (Get plan, Update counter). */
class FakeTables {
  readonly plans = new Map<string, unknown>();
  readonly counters = new Map<string, number>();
  readonly calls: string[] = [];
  failWith?: Error;

  async send(
    command: unknown,
  ): Promise<{ Item?: Record<string, unknown>; Attributes?: Record<string, unknown> }> {
    if (this.failWith) throw this.failWith;
    if (command instanceof GetCommand) {
      const { TableName, Key, ConsistentRead } = command.input;
      this.calls.push(`get ${TableName} consistent=${String(ConsistentRead)}`);
      const plan = this.plans.get(String(Key?.jobId));
      return plan === undefined ? {} : { Item: { [TEST_FAULT_ATTRIBUTE]: plan } };
    }
    if (command instanceof UpdateCommand) {
      const { TableName, Key } = command.input;
      const id = `${String(Key?.pk)}|${String(Key?.sk)}`;
      this.calls.push(`update ${TableName} ${id}`);
      const next = (this.counters.get(id) ?? 0) + 1;
      this.counters.set(id, next);
      return { Attributes: { attempts: next } };
    }
    throw new Error('unexpected command');
  }
}

function setup(step: (typeof ProcessingState)['Validate' | 'Process'], fault?: unknown) {
  const tables = new FakeTables();
  if (fault !== undefined) tables.plans.set(JOB, fault);
  const inner = new InMemoryDocumentSource();
  inner.put(JOB, { title: 'synthetic', content: CONTENT });
  const sleeps: number[] = [];
  const injected: InjectedFault[] = [];
  const source = new FaultInjectingDocumentSource(inner, {
    client: tables,
    documentsTableName: 'docs',
    jobsTableName: 'jobs',
    step,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    onFault: (f) => injected.push(f),
  });
  return { tables, source, sleeps, injected };
}

describe('FaultInjectingDocumentSource (TEST ONLY)', () => {
  it('without a plan behaves exactly like the wrapped source (one consistent plan read)', async () => {
    const { source, tables, sleeps, injected } = setup(ProcessingState.Process);
    const doc = await source.load(JOB);
    expect(doc.content).toBe(CONTENT);
    expect(tables.calls).toEqual(['get docs consistent=true']);
    expect(sleeps).toEqual([]);
    expect(injected).toEqual([]);
  });

  it('transient: fails the first N loads with TransientDependencyError (retried per spec), then loads', async () => {
    const fault: TestFault = { kind: 'transient', step: ProcessingState.Process, failures: 2 };
    const { source, tables, injected } = setup(ProcessingState.Process, fault);
    for (const attempt of [1, 2]) {
      const error = await source.load(JOB).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TransientDependencyError);
      expect((error as Error).name).toBe(WorkflowError.Transient);
      expect((error as Error).message).toContain(`${attempt} of 2`);
    }
    expect((await source.load(JOB)).content).toBe(CONTENT);
    const key = faultAttemptKey(JOB, ProcessingState.Process);
    expect(key).toEqual({ pk: `JOB#${JOB}`, sk: 'FAULT#ProcessJob' });
    expect(tables.counters.get(`${key.pk}|${key.sk}`)).toBe(3);
    expect(injected).toEqual([
      { step: 'ProcessJob', kind: 'transient', attempt: 1 },
      { step: 'ProcessJob', kind: 'transient', attempt: 2 },
    ]);
  });

  it('delay: waits, then loads normally', async () => {
    const { source, sleeps, injected } = setup(ProcessingState.Validate, {
      kind: 'delay',
      step: ProcessingState.Validate,
      seconds: 25,
    });
    expect((await source.load(JOB)).content).toBe(CONTENT);
    expect(sleeps).toEqual([25_000]);
    expect(injected).toEqual([{ step: 'ValidateJob', kind: 'delay', seconds: 25 }]);
  });

  it('ignores a plan for another state', async () => {
    const { source, tables, sleeps } = setup(ProcessingState.Validate, {
      kind: 'transient',
      step: ProcessingState.Process,
      failures: 3,
    });
    expect((await source.load(JOB)).content).toBe(CONTENT);
    expect(tables.calls).toEqual(['get docs consistent=true']);
    expect(sleeps).toEqual([]);
  });

  it('rejects a malformed plan loudly (non-retryable DocumentSourceError)', async () => {
    const { source } = setup(ProcessingState.Process, { kind: 'transient', failures: 9 });
    await expect(source.load(JOB)).rejects.toBeInstanceOf(DocumentSourceError);
  });

  it('classifies a throttled plan read as transient', async () => {
    const { source, tables } = setup(ProcessingState.Process);
    tables.failWith = Object.assign(new Error('slow down'), { name: 'ThrottlingException' });
    await expect(source.load(JOB)).rejects.toBeInstanceOf(TransientDependencyError);
  });
});

describe('fault plan helpers', () => {
  it('withTestFault validates and attaches the plan to a seeded document item', () => {
    const item = withTestFault(
      testDocumentItem(JOB, { title: 't', content: CONTENT, options: { topTerms: 5 } }),
      { kind: 'delay', step: ProcessingState.Process, seconds: 53 },
    );
    expect(item[TEST_FAULT_ATTRIBUTE]).toEqual({ kind: 'delay', step: 'ProcessJob', seconds: 53 });
    expect(() =>
      withTestFault({}, { kind: 'delay', step: ProcessingState.Process, seconds: 120 }),
    ).toThrow();
  });

  it('bounds faults inside the spec budgets (at most 3 failures, delays below the 60 s task timeout)', () => {
    expect(
      TestFaultSchema.safeParse({ kind: 'transient', step: 'ProcessJob', failures: 4 }).success,
    ).toBe(false);
    expect(
      TestFaultSchema.safeParse({ kind: 'delay', step: 'ProcessJob', seconds: 59 }).success,
    ).toBe(false);
    expect(
      TestFaultSchema.safeParse({ kind: 'delay', step: 'RecordSuccess', seconds: 5 }).success,
    ).toBe(false);
  });

  it('is armed only by TEST_FAULT_INJECTION=enabled', () => {
    expect(testFaultInjectionEnabled({})).toBe(false);
    expect(testFaultInjectionEnabled({ TEST_FAULT_INJECTION: '' })).toBe(false);
    expect(testFaultInjectionEnabled({ TEST_FAULT_INJECTION: 'enabled' })).toBe(true);
    expect(() => testFaultInjectionEnabled({ TEST_FAULT_INJECTION: 'true' })).toThrow(/enabled/);
  });
});
