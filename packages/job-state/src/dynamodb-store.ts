/**
 * DynamoDB implementation of the job-state store, following the single-table
 * layout in `workflows/processing/src/spec.ts`:
 *
 *   JOB#<jobId> / STATE                        execution state (+ GSI1 by status)
 *   JOB#<jobId> / STEP#<iso>#<state>           step audit trail
 *   IDEMPOTENCY#<key> / IDEMPOTENCY            idempotency records (TTL expiresAt)
 *
 * Every state write is conditional: transitions require the current status to
 * be a legal predecessor (and optionally an expected `version`), so duplicate
 * or out-of-order deliveries can never move a job backwards.
 *
 * Spec 2.0.0: the processor stores its result on the PROCESSING item
 * (`storeResult`), RecordSuccess requires it, and every FAILED transition
 * removes it — no derived data survives on a failed job. Items never contain
 * the document title or content.
 */
import {
  BatchGetCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { allowedPredecessors, decideTransition, type JobStatus } from '@starter/domain';
import {
  JobStateTable,
  WorkflowStatus,
  idempotencyKey,
  jobStateKey,
  jobStepKey,
  statusIndexKey,
} from '@starter/workflow-processing';
import { isConditionalCheckFailed } from './errors.js';
import {
  auditExpiresAt,
  epochSeconds,
  toIdempotencyRecord,
  toJobState,
  toStaleCandidate,
  toStepEntry,
  validateAuditTtlDays,
} from './items.js';
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

const A = JobStateTable.attributes;
const GSI = JobStateTable.statusIndex;
const BATCH_GET_LIMIT = 100;
const MAX_ERROR_MESSAGE = 1_000;
const MAX_STALE_PAGE = 100;

export interface DynamoDbJobStateStoreOptions {
  client: DynamoDBDocumentClient;
  tableName: string;
  /** Pause between BatchGet retries of unprocessed keys (ms). */
  backoffMs?: number;
  /**
   * Retention of STEP# audit items in days (`JOB_AUDIT_TTL_DAYS`): sets the table's TTL
   * attribute on new audit items. Undefined (the default) = audit items never expire; enable
   * only under an approved retention policy.
   */
  auditTtlDays?: number | undefined;
}

interface UpdateSpec {
  set?: Record<string, string | number>;
  remove?: readonly string[];
  /** Attributes that must exist for the write to apply. */
  requireExisting?: readonly string[];
  expectedVersion?: number | undefined;
  expectedStatus?: JobStatus | undefined;
}

export class DynamoDbJobStateStore implements JobStateStore {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;
  private readonly backoffMs: number;
  private readonly auditTtlDays: number | undefined;

  constructor(options: DynamoDbJobStateStoreOptions) {
    this.client = options.client;
    this.tableName = options.tableName;
    this.backoffMs = options.backoffMs ?? 50;
    this.auditTtlDays = validateAuditTtlDays(options.auditTtlDays);
  }

  async createInitial(jobId: string, at: string): Promise<{ created: boolean; state: JobState }> {
    const item = {
      ...jobStateKey(jobId),
      [A.jobId]: jobId,
      [A.status]: WorkflowStatus.Pending,
      [A.version]: 1,
      createdAt: at,
      [A.updatedAt]: at,
      ...statusIndexKey(WorkflowStatus.Pending, at, jobId),
    };
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: item,
          ConditionExpression: 'attribute_not_exists(#pk)',
          ExpressionAttributeNames: { '#pk': JobStateTable.partitionKey },
        }),
      );
      return { created: true, state: toJobState(item) };
    } catch (error) {
      if (!isConditionalCheckFailed(error)) throw error;
      const existing = await this.get(jobId);
      if (!existing) throw error;
      return { created: false, state: existing };
    }
  }

  async get(jobId: string): Promise<JobState | null> {
    const out = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: jobStateKey(jobId), ConsistentRead: true }),
    );
    return out.Item ? toJobState(out.Item) : null;
  }

  async getMany(jobIds: readonly string[]): Promise<Map<string, JobState>> {
    const result = new Map<string, JobState>();
    const unique = [...new Set(jobIds)];
    for (let i = 0; i < unique.length; i += BATCH_GET_LIMIT) {
      let keys: Record<string, unknown>[] = unique
        .slice(i, i + BATCH_GET_LIMIT)
        .map((id) => jobStateKey(id));
      for (let attempt = 0; keys.length > 0; attempt += 1) {
        if (attempt > 0) await sleep(this.backoffMs * 2 ** (attempt - 1));
        if (attempt > 5) throw new Error('BatchGet left unprocessed keys after 5 retries');
        const out = await this.client.send(
          new BatchGetCommand({
            RequestItems: { [this.tableName]: { Keys: keys, ConsistentRead: true } },
          }),
        );
        for (const item of out.Responses?.[this.tableName] ?? []) {
          const state = toJobState(item);
          result.set(state.jobId, state);
        }
        keys = out.UnprocessedKeys?.[this.tableName]?.Keys ?? [];
      }
    }
    return result;
  }

  transition(
    jobId: string,
    to: 'VALIDATING' | 'PROCESSING',
    at: string,
    options: TransitionOptions = {},
  ): Promise<TransitionOutcome> {
    return this.update(jobId, to, at, {
      expectedVersion: options.expectedVersion,
      expectedStatus: options.expectedStatus,
    });
  }

  async storeResult(jobId: string, resultJson: string): Promise<StoreResultOutcome> {
    try {
      const out = await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: jobStateKey(jobId),
          UpdateExpression: 'SET #result = :result, #version = #version + :one',
          ConditionExpression:
            'attribute_exists(#pk) AND #status = :processing AND attribute_not_exists(#result)',
          ExpressionAttributeNames: {
            '#pk': JobStateTable.partitionKey,
            '#status': A.status,
            '#result': A.result,
            '#version': A.version,
          },
          ExpressionAttributeValues: {
            ':result': resultJson,
            ':one': 1,
            ':processing': WorkflowStatus.Processing,
          },
          ReturnValues: 'ALL_NEW',
        }),
      );
      return { kind: 'stored', state: toJobState(out.Attributes) };
    } catch (error) {
      if (!isConditionalCheckFailed(error)) throw error;
      return explainStoreRejection(await this.get(jobId));
    }
  }

  recordSuccess(
    jobId: string,
    at: string,
    options: TransitionOptions = {},
  ): Promise<TransitionOutcome> {
    return this.update(jobId, WorkflowStatus.Succeeded, at, {
      remove: [A.errorName, A.errorMessage],
      requireExisting: [A.result],
      expectedVersion: options.expectedVersion,
      expectedStatus: options.expectedStatus,
    });
  }

  recordFailure(
    jobId: string,
    error: { name: string; message: string },
    at: string,
    options: TransitionOptions = {},
  ): Promise<TransitionOutcome> {
    return this.update(jobId, WorkflowStatus.Failed, at, {
      set: {
        [A.errorName]: error.name.slice(0, 256) || 'Error',
        [A.errorMessage]: error.message.slice(0, MAX_ERROR_MESSAGE),
      },
      remove: [A.result],
      expectedVersion: options.expectedVersion,
      expectedStatus: options.expectedStatus,
    });
  }

  async listStale(
    status: JobStatus,
    olderThan: string,
    limit: number,
  ): Promise<StaleJobCandidate[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_STALE_PAGE) {
      throw new RangeError(`limit must be an integer between 1 and ${MAX_STALE_PAGE}`);
    }
    // gsi1sk = <updatedAt>#<jobId>: every key below the bare cutoff timestamp was last
    // written strictly before it (ISO-8601 sorts lexicographically).
    const out = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: GSI.name,
        KeyConditionExpression: '#gpk = :gpk AND #gsk < :cutoff',
        ExpressionAttributeNames: {
          '#gpk': GSI.partitionKey,
          '#gsk': GSI.sortKey,
          '#jobId': A.jobId,
          '#status': A.status,
          '#updatedAt': A.updatedAt,
        },
        ExpressionAttributeValues: {
          ':gpk': statusIndexKey(status, olderThan, '').gsi1pk,
          ':cutoff': olderThan,
        },
        // Only what the reconciler needs: never results or error texts.
        ProjectionExpression: '#jobId, #status, #updatedAt',
        ScanIndexForward: true,
        Limit: limit,
      }),
    );
    return (out.Items ?? []).map(toStaleCandidate);
  }

  async attachExecution(jobId: string, executionArn: string): Promise<boolean> {
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: jobStateKey(jobId),
          UpdateExpression: 'SET #arn = :arn, #version = #version + :one',
          ConditionExpression:
            'attribute_exists(#pk) AND (attribute_not_exists(#arn) OR #arn = :arn)',
          ExpressionAttributeNames: {
            '#pk': JobStateTable.partitionKey,
            '#arn': A.executionArn,
            '#version': A.version,
          },
          ExpressionAttributeValues: { ':arn': executionArn, ':one': 1 },
        }),
      );
      return true;
    } catch (error) {
      if (isConditionalCheckFailed(error)) return false;
      throw error;
    }
  }

  async appendStep(entry: StepAuditEntry): Promise<void> {
    const expiresAt = auditExpiresAt(entry.at, this.auditTtlDays);
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          ...jobStepKey(entry.jobId, entry.at, entry.state),
          ...entry,
          ...(expiresAt === undefined ? {} : { [JobStateTable.ttlAttribute]: expiresAt }),
        },
      }),
    );
  }

  async listSteps(jobId: string): Promise<StepAuditEntry[]> {
    const out = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :prefix)',
        ExpressionAttributeNames: {
          '#pk': JobStateTable.partitionKey,
          '#sk': JobStateTable.sortKey,
        },
        ExpressionAttributeValues: { ':pk': jobStateKey(jobId).pk, ':prefix': 'STEP#' },
        ConsistentRead: true,
      }),
    );
    return (out.Items ?? []).map(toStepEntry);
  }

  async claimIdempotency(record: IdempotencyRecord, now: Date): Promise<ClaimOutcome> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.client.send(
          new PutCommand({
            TableName: this.tableName,
            Item: { ...idempotencyKey(record.key), ...record },
            // Expired-but-not-yet-deleted records (TTL deletion is lazy) may be reclaimed.
            ConditionExpression: 'attribute_not_exists(#pk) OR #expiresAt <= :now',
            ExpressionAttributeNames: {
              '#pk': JobStateTable.partitionKey,
              '#expiresAt': JobStateTable.ttlAttribute,
            },
            ExpressionAttributeValues: { ':now': epochSeconds(now) },
          }),
        );
        return { claimed: true, record };
      } catch (error) {
        if (!isConditionalCheckFailed(error)) throw error;
        const existing = await this.getIdempotency(record.key, now);
        if (existing) return { claimed: false, existing };
        // Expired between the write and the read — try again.
      }
    }
    throw new Error(`could not claim idempotency key after 3 attempts`);
  }

  async getIdempotency(key: string, now: Date): Promise<IdempotencyRecord | null> {
    const out = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: idempotencyKey(key), ConsistentRead: true }),
    );
    if (!out.Item) return null;
    const record = toIdempotencyRecord(out.Item);
    return record.expiresAt > epochSeconds(now) ? record : null;
  }

  async putIdempotency(record: IdempotencyRecord): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: { ...idempotencyKey(record.key), ...record },
      }),
    );
  }

  async ping(): Promise<void> {
    await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: { pk: 'HEALTHCHECK', sk: 'HEALTHCHECK' } }),
    );
  }

  private async update(
    jobId: string,
    to: JobStatus,
    at: string,
    spec: UpdateSpec,
  ): Promise<TransitionOutcome> {
    const predecessors = allowedPredecessors(to);
    const names: Record<string, string> = {
      '#pk': JobStateTable.partitionKey,
      '#status': A.status,
      '#updatedAt': A.updatedAt,
      '#version': A.version,
      '#gsi1pk': GSI.partitionKey,
      '#gsi1sk': GSI.sortKey,
    };
    const gsi = statusIndexKey(to, at, jobId);
    const values: Record<string, string | number> = {
      ':to': to,
      ':at': at,
      ':one': 1,
      ':gsi1pk': gsi.gsi1pk,
      ':gsi1sk': gsi.gsi1sk,
    };
    const sets = [
      '#status = :to',
      '#updatedAt = :at',
      '#version = #version + :one',
      '#gsi1pk = :gsi1pk',
      '#gsi1sk = :gsi1sk',
    ];
    Object.entries(spec.set ?? {}).forEach(([attribute, value], i) => {
      names[`#s${i}`] = attribute;
      values[`:s${i}`] = value;
      sets.push(`#s${i} = :s${i}`);
    });
    const removes = (spec.remove ?? []).map((attribute, i) => {
      names[`#r${i}`] = attribute;
      return `#r${i}`;
    });
    predecessors.forEach((status, i) => {
      values[`:from${i}`] = status;
    });
    let condition = `attribute_exists(#pk) AND #status IN (${predecessors.map((_, i) => `:from${i}`).join(', ')})`;
    (spec.requireExisting ?? []).forEach((attribute, i) => {
      names[`#e${i}`] = attribute;
      condition += ` AND attribute_exists(#e${i})`;
    });
    if (spec.expectedVersion !== undefined) {
      condition += ' AND #version = :expectedVersion';
      values[':expectedVersion'] = spec.expectedVersion;
    }
    if (spec.expectedStatus !== undefined) {
      condition += ' AND #status = :expectedStatus';
      values[':expectedStatus'] = spec.expectedStatus;
    }

    try {
      const out = await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: jobStateKey(jobId),
          UpdateExpression: `SET ${sets.join(', ')}${removes.length ? ` REMOVE ${removes.join(', ')}` : ''}`,
          ConditionExpression: condition,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ReturnValues: 'ALL_NEW',
        }),
      );
      return { kind: 'applied', state: toJobState(out.Attributes) };
    } catch (error) {
      if (!isConditionalCheckFailed(error)) throw error;
      return explainRejection(await this.get(jobId), to, spec.expectedVersion, spec.expectedStatus);
    }
  }
}

/** Why `storeResult` did not write (shared by both stores). */
export function explainStoreRejection(current: JobState | null): StoreResultOutcome {
  if (!current) return { kind: 'rejected', state: null, reason: 'job state not found' };
  if (
    current.resultJson !== undefined &&
    (current.status === WorkflowStatus.Processing || current.status === WorkflowStatus.Succeeded)
  ) {
    return { kind: 'exists', state: current };
  }
  return {
    kind: 'rejected',
    state: current,
    reason: `cannot store a result in status ${current.status}`,
  };
}

/** Shared by both stores: why a conditional transition did not apply. */
export function explainRejection(
  current: JobState | null,
  to: JobStatus,
  expectedVersion: number | undefined,
  expectedStatus?: JobStatus | undefined,
): TransitionOutcome {
  if (!current) return { kind: 'rejected', state: null, reason: 'job state not found' };
  const decision = decideTransition(current.status, to);
  if (decision === 'noop') return { kind: 'noop', state: current };
  if (decision === 'apply') {
    return {
      kind: 'rejected',
      state: current,
      reason:
        expectedStatus !== undefined && current.status !== expectedStatus
          ? `status conflict: expected ${expectedStatus}, found ${current.status}`
          : expectedVersion !== undefined && current.version !== expectedVersion
            ? `version conflict: expected ${expectedVersion}, found ${current.version}`
            : to === WorkflowStatus.Succeeded && current.resultJson === undefined
              ? 'no stored result'
              : 'concurrent modification; re-read and retry',
    };
  }
  return {
    kind: 'rejected',
    state: current,
    reason: `illegal transition ${current.status} → ${to}`,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
