/**
 * In-memory twin of `DynamoDbJobStateStore` with the same conditional-write
 * semantics (verified by the shared contract test suite). For unit tests and
 * fakes only — state lives in the process.
 */
import { decideTransition, type JobStatus } from '@starter/domain';
import { JobStateTable, WorkflowStatus } from '@starter/workflow-processing';
import { explainRejection, explainStoreRejection } from './dynamodb-store.js';
import { auditExpiresAt, epochSeconds, validateAuditTtlDays } from './items.js';
import type {
  ClaimOutcome,
  IdempotencyRecord,
  JobState,
  JobStateStore,
  StaleJobCandidate,
  StepAuditEntry,
  StoreResultOutcome,
  TransitionOptions,
  TransitionOutcome,
} from './types.js';

type Method = keyof JobStateStore;

interface StepItem extends StepAuditEntry {
  expiresAt?: number | undefined;
}

export class InMemoryJobStateStore implements JobStateStore {
  private readonly states = new Map<string, JobState>();
  private readonly idempotency = new Map<string, IdempotencyRecord>();
  private readonly steps = new Map<string, StepItem[]>();
  private readonly failures = new Map<Method, unknown[]>();
  private readonly auditTtlDays: number | undefined;
  /** Number of calls per method (handy for asserting idempotent short-circuits). */
  readonly calls = new Map<Method, number>();

  constructor(options: { auditTtlDays?: number | undefined } = {}) {
    this.auditTtlDays = validateAuditTtlDays(options.auditTtlDays);
  }

  /**
   * Every stored item, shaped like the DynamoDB items (test hook for leakage assertions and
   * retention checks).
   */
  items(): Record<string, unknown>[] {
    return [
      ...[...this.states.values()].map((s) => ({ pk: `JOB#${s.jobId}`, sk: 'STATE', ...s })),
      ...[...this.steps.values()]
        .flat()
        .map((e) => ({ pk: `JOB#${e.jobId}`, sk: `STEP#${e.at}#${e.state}`, ...e })),
      ...[...this.idempotency.values()].map((r) => ({
        pk: `IDEMPOTENCY#${r.key}`,
        sk: 'IDEMPOTENCY',
        ...r,
      })),
    ].map((item) => structuredClone(item));
  }

  /** Test hook: overwrites fields of a state item (e.g. an old `updatedAt` for staleness). */
  patchState(jobId: string, patch: Partial<JobState>): void {
    const state = this.states.get(jobId);
    if (!state) throw new Error(`no state for ${jobId}`);
    this.states.set(jobId, { ...state, ...patch });
  }

  /** Makes the next call(s) of `method` reject with `error` (failure injection). */
  failNext(method: Method, error: unknown, times = 1): void {
    const queue = this.failures.get(method) ?? [];
    for (let i = 0; i < times; i += 1) queue.push(error);
    this.failures.set(method, queue);
  }

  private async enter(method: Method): Promise<void> {
    this.calls.set(method, (this.calls.get(method) ?? 0) + 1);
    // Yield like real I/O so concurrency bugs surface in tests.
    await Promise.resolve();
    const queue = this.failures.get(method);
    if (queue && queue.length > 0) throw queue.shift();
  }

  async createInitial(jobId: string, at: string): Promise<{ created: boolean; state: JobState }> {
    await this.enter('createInitial');
    const existing = this.states.get(jobId);
    if (existing) return { created: false, state: structuredClone(existing) };
    const state: JobState = {
      jobId,
      status: WorkflowStatus.Pending,
      version: 1,
      createdAt: at,
      updatedAt: at,
    };
    this.states.set(jobId, state);
    return { created: true, state: structuredClone(state) };
  }

  async get(jobId: string): Promise<JobState | null> {
    await this.enter('get');
    const state = this.states.get(jobId);
    return state ? structuredClone(state) : null;
  }

  async getMany(jobIds: readonly string[]): Promise<Map<string, JobState>> {
    await this.enter('getMany');
    const result = new Map<string, JobState>();
    for (const id of jobIds) {
      const state = this.states.get(id);
      if (state) result.set(id, structuredClone(state));
    }
    return result;
  }

  async transition(
    jobId: string,
    to: 'VALIDATING' | 'PROCESSING',
    at: string,
    options: TransitionOptions = {},
  ): Promise<TransitionOutcome> {
    await this.enter('transition');
    return this.apply(jobId, to, at, options, {});
  }

  async storeResult(jobId: string, resultJson: string): Promise<StoreResultOutcome> {
    await this.enter('storeResult');
    const current = this.states.get(jobId);
    if (
      !current ||
      current.status !== WorkflowStatus.Processing ||
      current.resultJson !== undefined
    ) {
      return explainStoreRejection(current ? structuredClone(current) : null);
    }
    const next: JobState = { ...current, resultJson, version: current.version + 1 };
    this.states.set(jobId, next);
    return { kind: 'stored', state: structuredClone(next) };
  }

  async recordSuccess(
    jobId: string,
    at: string,
    options: TransitionOptions = {},
  ): Promise<TransitionOutcome> {
    await this.enter('recordSuccess');
    const current = this.states.get(jobId);
    if (
      current &&
      current.status === WorkflowStatus.Processing &&
      !current.resultJson &&
      this.conditionsHold(current, options)
    ) {
      return explainRejection(structuredClone(current), WorkflowStatus.Succeeded, undefined);
    }
    return this.apply(jobId, WorkflowStatus.Succeeded, at, options, {
      errorName: undefined,
      errorMessage: undefined,
    });
  }

  async recordFailure(
    jobId: string,
    error: { name: string; message: string },
    at: string,
    options: TransitionOptions = {},
  ): Promise<TransitionOutcome> {
    await this.enter('recordFailure');
    return this.apply(jobId, WorkflowStatus.Failed, at, options, {
      errorName: error.name.slice(0, 256) || 'Error',
      errorMessage: error.message.slice(0, 1_000),
      resultJson: undefined,
    });
  }

  async listStale(
    status: JobStatus,
    olderThan: string,
    limit: number,
  ): Promise<StaleJobCandidate[]> {
    await this.enter('listStale');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError('limit must be an integer between 1 and 100');
    }
    return [...this.states.values()]
      .filter((s) => s.status === status && `${s.updatedAt}#${s.jobId}` < olderThan)
      .sort((a, b) => (`${a.updatedAt}#${a.jobId}` < `${b.updatedAt}#${b.jobId}` ? -1 : 1))
      .slice(0, limit)
      .map((s) => ({ jobId: s.jobId, status: s.status, updatedAt: s.updatedAt }));
  }

  async attachExecution(jobId: string, executionArn: string): Promise<boolean> {
    await this.enter('attachExecution');
    const state = this.states.get(jobId);
    if (!state) return false;
    if (state.executionArn && state.executionArn !== executionArn) return false;
    state.executionArn = executionArn;
    state.version += 1;
    return true;
  }

  async appendStep(entry: StepAuditEntry): Promise<void> {
    await this.enter('appendStep');
    const list = (this.steps.get(entry.jobId) ?? []).filter(
      (e) => !(e.at === entry.at && e.state === entry.state),
    );
    const expiresAt = auditExpiresAt(entry.at, this.auditTtlDays);
    list.push({
      ...structuredClone(entry),
      ...(expiresAt === undefined ? {} : { [JobStateTable.ttlAttribute]: expiresAt }),
    });
    list.sort((a, b) => (`${a.at}#${a.state}` < `${b.at}#${b.state}` ? -1 : 1));
    this.steps.set(entry.jobId, list);
  }

  async listSteps(jobId: string): Promise<StepAuditEntry[]> {
    await this.enter('listSteps');
    return (this.steps.get(jobId) ?? []).map(({ expiresAt: _ttl, ...entry }) =>
      structuredClone(entry),
    );
  }

  async claimIdempotency(record: IdempotencyRecord, now: Date): Promise<ClaimOutcome> {
    await this.enter('claimIdempotency');
    const existing = this.idempotency.get(record.key);
    if (existing && existing.expiresAt > epochSeconds(now)) {
      return { claimed: false, existing: structuredClone(existing) };
    }
    this.idempotency.set(record.key, structuredClone(record));
    return { claimed: true, record };
  }

  async getIdempotency(key: string, now: Date): Promise<IdempotencyRecord | null> {
    await this.enter('getIdempotency');
    const record = this.idempotency.get(key);
    return record && record.expiresAt > epochSeconds(now) ? structuredClone(record) : null;
  }

  async putIdempotency(record: IdempotencyRecord): Promise<void> {
    await this.enter('putIdempotency');
    this.idempotency.set(record.key, structuredClone(record));
  }

  async ping(): Promise<void> {
    await this.enter('ping');
  }

  private conditionsHold(current: JobState, options: TransitionOptions): boolean {
    return (
      (options.expectedVersion === undefined || current.version === options.expectedVersion) &&
      (options.expectedStatus === undefined || current.status === options.expectedStatus)
    );
  }

  private apply(
    jobId: string,
    to: JobStatus,
    at: string,
    options: TransitionOptions,
    patch: Partial<JobState>,
  ): TransitionOutcome {
    const current = this.states.get(jobId) ?? null;
    if (
      !current ||
      decideTransition(current.status, to) !== 'apply' ||
      !this.conditionsHold(current, options)
    ) {
      return explainRejection(
        current ? structuredClone(current) : null,
        to,
        options.expectedVersion,
        options.expectedStatus,
      );
    }
    const next: JobState = {
      ...current,
      ...patch,
      status: to,
      updatedAt: at,
      version: current.version + 1,
    };
    for (const key of Object.keys(next) as (keyof JobState)[]) {
      if (next[key] === undefined) delete next[key];
    }
    this.states.set(jobId, next);
    return { kind: 'applied', state: structuredClone(next) };
  }
}
