/**
 * AWS Step Functions definition of the processing workflow, derived from the
 * shared spec (`../spec.ts`). Every state name, retry policy, timeout, catch
 * list and DynamoDB attribute written here comes from the spec so the AWS
 * workflow and the API's local adapter cannot drift apart silently.
 *
 * This module is exported as `@starter/workflow-processing/cdk` and is the only
 * place in the package that imports `aws-cdk-lib`.
 */
import { Duration } from 'aws-cdk-lib';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import type { Construct } from 'constructs';
import {
  EXECUTION_INPUT_KEYS,
  JobStateTable,
  PROCESSING_WORKFLOW,
  ProcessingState,
  WorkflowError,
  WorkflowStatus,
  jobStateKey,
  statusIndexKey,
  type RetryPolicy,
  type TaskSpec,
} from '../spec.js';

/**
 * Paths on the state document. Spec 2.0.0: Lambda task results are DISCARDED (`ResultPath:
 * null`), so the state data only ever holds the execution input and, on the failure path, the
 * caught error — never document content or analysis results.
 */
export const StatePaths = {
  /** `{ Error, Cause? }` of the failure as caught (Step Functions may omit `Cause`). */
  error: '$.error',
  /** Defaults merged under `$.error` by NormalizeError. */
  errorDefaults: '$.errorDefaults',
  /** Output of NormalizeError: `{ error: { Error, Cause } }` — both fields always present. */
  failure: '$.failure',
  /** The normalised `{ Error, Cause }` that RecordFailure writes and JobFailed reports. */
  failureError: '$.failure.error',
  /** A rejected RecordFailure write lands here so JobFailed still reports `$.error`. */
  recordFailureError: '$.recordFailureError',
} as const;

/** Error raised by the DynamoDB integration when a ConditionExpression fails. */
export const CONDITIONAL_CHECK_FAILED = 'DynamoDB.ConditionalCheckFailedException';

/**
 * Legal predecessor statuses of the two terminal writes. They mirror the job
 * lifecycle in `@starter/domain` (`allowedPredecessors`) so the native
 * RecordSuccess/RecordFailure writes are exactly the conditional transitions
 * of `DynamoDbJobStateStore.recordSuccess/recordFailure` (infra tests
 * cross-check both).
 */
export const RECORD_PREDECESSORS = {
  [WorkflowStatus.Succeeded]: [WorkflowStatus.Processing],
  [WorkflowStatus.Failed]: [
    WorkflowStatus.Pending,
    WorkflowStatus.Validating,
    WorkflowStatus.Processing,
  ],
} as const satisfies Record<'SUCCEEDED' | 'FAILED', readonly WorkflowStatus[]>;

/** Retry policy of the native DynamoDB `UpdateItem` record states (from the spec). */
export const RECORD_STATE_RETRY: RetryPolicy = PROCESSING_WORKFLOW.recordStates.retry[0];

/** Defaults for failures reported without a `Cause` (or, defensively, without an `Error`). */
export const FAILURE_DEFAULTS = {
  Error: 'States.Unknown',
  Cause: 'No cause was reported for this failure.',
} as const;

/** Maps a spec retry policy to CDK `RetryProps`. */
export function toRetryProps(policy: RetryPolicy): sfn.RetryProps {
  return {
    errors: [...policy.errors],
    interval: Duration.seconds(policy.intervalSeconds),
    maxAttempts: policy.maxAttempts,
    backoffRate: policy.backoffRate,
    maxDelay: Duration.seconds(policy.maxDelaySeconds),
    jitterStrategy: policy.jitter === 'FULL' ? sfn.JitterType.FULL : sfn.JitterType.NONE,
  };
}

/**
 * Renders a spec retry policy exactly as it must appear in Amazon States
 * Language. Used by tests to prove the synthesized definition equals the spec.
 */
export function toAslRetrier(policy: RetryPolicy): Record<string, unknown> {
  return {
    ErrorEquals: [...policy.errors],
    IntervalSeconds: policy.intervalSeconds,
    MaxAttempts: policy.maxAttempts,
    BackoffRate: policy.backoffRate,
    MaxDelaySeconds: policy.maxDelaySeconds,
    JitterStrategy: policy.jitter,
  };
}

export interface ProcessingDefinitionProps {
  /** Validator function; pass the `live` alias for version-aware deploys. */
  readonly validateFunction: lambda.IFunction;
  /** Processor function; pass the `live` alias for version-aware deploys. */
  readonly processFunction: lambda.IFunction;
  /** Job state table (layout per `JobStateTable` in the spec). */
  readonly table: dynamodb.ITable;
}

/**
 * The event every Lambda task receives: exactly the `ProcessingExecutionInput` fields (spec
 * `EXECUTION_INPUT_KEYS`) plus the execution ARN — the spec's `TASK_EVENT_KEYS`. Built field by
 * field, so nothing else in the state (or a field added to the input by mistake) is forwarded.
 */
export const TASK_EVENT_PARAMETERS: Readonly<Record<string, string>> = Object.fromEntries([
  ...EXECUTION_INPUT_KEYS.map((key) => [`${key}.$`, `$.${key}`] as const),
  ['executionArn.$', '$$.Execution.Id'] as const,
]);

function lambdaTask(scope: Construct, spec: TaskSpec, fn: lambda.IFunction): tasks.LambdaInvoke {
  const task = new tasks.LambdaInvoke(scope, spec.state, {
    lambdaFunction: fn,
    payload: sfn.TaskInput.fromObject({ ...TASK_EVENT_PARAMETERS }),
    payloadResponseOnly: true,
    // Spec 2.0.0: handler results never enter the state data (the processor stores its result
    // on the job-state item). Handlers still return only non-sensitive metadata, because the
    // raw task result is recorded in the execution history.
    resultPath: sfn.JsonPath.DISCARD,
    // Retries come exclusively from the spec; disable CDK's implicit retrier.
    retryOnServiceExceptions: false,
    taskTimeout: sfn.Timeout.duration(Duration.seconds(spec.timeoutSeconds)),
    comment: `${spec.state}: records status ${spec.status} (spec ${PROCESSING_WORKFLOW.version})`,
  });
  for (const retry of spec.retry) {
    task.addRetry(toRetryProps(retry));
  }
  return task;
}

const attr = JobStateTable.attributes;
const idx = JobStateTable.statusIndex;
/** `JOB#{}` / `STATE` — derived from the spec key builder. */
const stateKeyTemplate = jobStateKey('{}');

interface RecordStateSpec {
  readonly set: Record<string, tasks.DynamoAttributeValue>;
  readonly remove: readonly string[];
  /** Attributes that must already exist on the item for the write to apply. */
  readonly requireExisting: readonly string[];
}

/**
 * Native DynamoDB `UpdateItem` of the job's STATE item to a terminal status,
 * conditional on the current status being a legal predecessor:
 *
 *   SET status, updatedAt = $$.State.EnteredTime, version = version + 1,
 *       gsi1pk = STATUS#<status>, gsi1sk = <EnteredTime>#<jobId> [, extra]
 *   [REMOVE ...]
 *   IF attribute_exists(pk) AND status IN (<predecessors>) [AND attribute_exists(<required>)]
 */
function recordState(
  scope: Construct,
  id: string,
  table: dynamodb.ITable,
  status: keyof typeof RECORD_PREDECESSORS,
  { set: extraSet, remove, requireExisting }: RecordStateSpec,
): tasks.DynamoUpdateItem {
  const indexKey = statusIndexKey(status, '{}', '{}');
  const enteredTime = sfn.JsonPath.stringAt('$$.State.EnteredTime');
  const jobId = sfn.JsonPath.stringAt('$.jobId');
  const predecessors = RECORD_PREDECESSORS[status];

  const names: Record<string, string> = {
    '#pk': JobStateTable.partitionKey,
    '#status': attr.status,
    '#updatedAt': attr.updatedAt,
    '#version': attr.version,
    '#gsi1pk': idx.partitionKey,
    '#gsi1sk': idx.sortKey,
  };
  const values: Record<string, tasks.DynamoAttributeValue> = {
    ':status': tasks.DynamoAttributeValue.fromString(status),
    ':updatedAt': tasks.DynamoAttributeValue.fromString(enteredTime),
    ':one': tasks.DynamoAttributeValue.fromNumber(1),
    ':gsi1pk': tasks.DynamoAttributeValue.fromString(indexKey.gsi1pk),
    ':gsi1sk': tasks.DynamoAttributeValue.fromString(
      sfn.JsonPath.format(indexKey.gsi1sk, enteredTime, jobId),
    ),
  };
  const sets = [
    '#status = :status',
    '#updatedAt = :updatedAt',
    '#version = #version + :one',
    '#gsi1pk = :gsi1pk',
    '#gsi1sk = :gsi1sk',
  ];
  for (const [attribute, value] of Object.entries(extraSet)) {
    names[`#${attribute}`] = attribute;
    values[`:${attribute}`] = value;
    sets.push(`#${attribute} = :${attribute}`);
  }
  for (const attribute of [...remove, ...requireExisting]) {
    names[`#${attribute}`] = attribute;
  }
  predecessors.forEach((from, i) => {
    values[`:from${i}`] = tasks.DynamoAttributeValue.fromString(from);
  });
  const removeClause = remove.length > 0 ? ` REMOVE ${remove.map((a) => `#${a}`).join(', ')}` : '';
  const requireClause = requireExisting.map((a) => ` AND attribute_exists(#${a})`).join('');

  const task = new tasks.DynamoUpdateItem(scope, id, {
    table,
    key: {
      [JobStateTable.partitionKey]: tasks.DynamoAttributeValue.fromString(
        sfn.JsonPath.format(stateKeyTemplate.pk, jobId),
      ),
      [JobStateTable.sortKey]: tasks.DynamoAttributeValue.fromString(stateKeyTemplate.sk),
    },
    updateExpression: `SET ${sets.join(', ')}${removeClause}`,
    conditionExpression: `attribute_exists(#pk) AND #status IN (${predecessors
      .map((_, i) => `:from${i}`)
      .join(', ')})${requireClause}`,
    expressionAttributeNames: names,
    expressionAttributeValues: values,
    resultPath: sfn.JsonPath.DISCARD,
    // Bounded so the execution timeout always exceeds the worst-case path (spec tests).
    taskTimeout: sfn.Timeout.duration(
      Duration.seconds(PROCESSING_WORKFLOW.recordStates.timeoutSeconds),
    ),
    comment: `Native DynamoDB UpdateItem: ${attr.status}=${status} on ${stateKeyTemplate.pk}/${stateKeyTemplate.sk} if status in [${predecessors.join(', ')}]${requireExisting.length > 0 ? ` and ${requireExisting.join(', ')} stored` : ''}`,
  });
  for (const retry of PROCESSING_WORKFLOW.recordStates.retry) {
    task.addRetry(toRetryProps(retry));
  }
  return task;
}

/**
 * Builds the processing workflow:
 *
 *   ValidateJob -> ProcessJob -> RecordSuccess -> JobSucceeded
 *        |             |              |
 *        +-------------+--------------+--(catch States.ALL)--> FailureDefaults
 *                                  -> NormalizeError -> RecordFailure -> JobFailed
 *        +-------------+--(DuplicateExecutionError)----------> JobSucceeded
 *   RecordSuccess --(ConditionalCheckFailed: already recorded)--> JobSucceeded
 *   RecordFailure --(ConditionalCheckFailed: already terminal)--> JobFailed
 *   RecordFailure --(any other error)--> RecordingFailed (Fail; job may stay non-terminal
 *                                         until the stale-job reconciler closes it)
 *
 * NormalizeError merges the caught `$.error` over defaults with States.JsonMerge, so
 * RecordFailure and JobFailed never reference a missing `Cause` (a missing JSONPath raises
 * States.Runtime, which cannot be caught).
 *
 * Handler contract (functions/*, spec 2.0.0 — see docs/adr/0230-*):
 *   - event (both)     : exactly `TASK_EVENT_KEYS` (execution input + executionArn); handlers
 *                        load the document from PostgreSQL by `jobId` (claim check)
 *   - output (both)    : non-sensitive metadata only; DISCARDED (`ResultPath: null`)
 *   - processor        : writes the result to the job-state item (`resultJson`) itself;
 *                        RecordSuccess requires it (`attribute_exists(resultJson)`)
 */
export function buildProcessingDefinition(
  scope: Construct,
  props: ProcessingDefinitionProps,
): sfn.IChainable {
  const { validate: validateSpec, process: processSpec } = PROCESSING_WORKFLOW.tasks;

  const succeeded = new sfn.Succeed(scope, ProcessingState.Succeeded, {
    comment: 'Job completed (or a duplicate delivery of an already recorded job).',
  });
  const failed = new sfn.Fail(scope, ProcessingState.Failed, {
    errorPath: `${StatePaths.failureError}.Error`,
    causePath: `${StatePaths.failureError}.Cause`,
    comment: 'Job failed; the failure is recorded in DynamoDB.',
  });
  const recordingFailed = new sfn.Fail(scope, ProcessingState.RecordingFailed, {
    error: 'RecordFailureFailed',
    cause:
      'The failure could not be recorded in DynamoDB; the job may stay non-terminal. ' +
      'The failed-executions alarm fires; see the execution history.',
  });

  const recordFailure = recordState(
    scope,
    ProcessingState.RecordFailure,
    props.table,
    WorkflowStatus.Failed,
    {
      set: {
        [attr.errorName]: tasks.DynamoAttributeValue.fromString(
          sfn.JsonPath.stringAt(`${StatePaths.failureError}.Error`),
        ),
        [attr.errorMessage]: tasks.DynamoAttributeValue.fromString(
          sfn.JsonPath.stringAt(`${StatePaths.failureError}.Cause`),
        ),
      },
      // A failed job keeps no derived data (the processor may have stored a result already).
      remove: [attr.result],
      requireExisting: [],
    },
  );
  // The job is already terminal (e.g. recorded by an earlier delivery): keep
  // the original error for JobFailed instead of failing on the stale write.
  recordFailure.addCatch(failed, {
    errors: [CONDITIONAL_CHECK_FAILED],
    resultPath: StatePaths.recordFailureError,
  });
  // Anything else (AccessDenied, KMS, retries exhausted): end in an explicit, alarmed Fail.
  recordFailure.addCatch(recordingFailed, {
    errors: ['States.ALL'],
    resultPath: StatePaths.recordFailureError,
  });
  recordFailure.next(failed);

  const failureDefaults = new sfn.Pass(scope, ProcessingState.FailureDefaults, {
    comment: 'Defaults for failures reported without a Cause.',
    result: sfn.Result.fromObject({ ...FAILURE_DEFAULTS }),
    resultPath: StatePaths.errorDefaults,
  });
  const normalizeError = new sfn.Pass(scope, ProcessingState.NormalizeError, {
    comment: 'error = defaults merged with the caught error (caught fields win).',
    parameters: {
      error: sfn.JsonPath.jsonMerge(
        sfn.JsonPath.objectAt(StatePaths.errorDefaults),
        sfn.JsonPath.objectAt(StatePaths.error),
      ),
    },
    resultPath: StatePaths.failure,
  });
  failureDefaults.next(normalizeError).next(recordFailure);

  const recordSuccess = recordState(
    scope,
    ProcessingState.RecordSuccess,
    props.table,
    WorkflowStatus.Succeeded,
    {
      set: {},
      remove: [attr.errorName, attr.errorMessage],
      // The processor stored the result on the item; never mark SUCCEEDED without it.
      requireExisting: [attr.result],
    },
  );
  // Not PROCESSING any more: a duplicate delivery already recorded the
  // outcome (the store treats this as a no-op rejection, not an error). A
  // PROCESSING item without a stored result cannot occur unless the item was
  // tampered with; the reconciler reports that case (ExecutionStateMismatch).
  recordSuccess.addCatch(succeeded, {
    errors: [CONDITIONAL_CHECK_FAILED],
    resultPath: sfn.JsonPath.DISCARD,
  });
  recordSuccess.addCatch(failureDefaults, {
    errors: ['States.ALL'],
    resultPath: StatePaths.error,
  });

  const validate = lambdaTask(scope, validateSpec, props.validateFunction);
  const process = lambdaTask(scope, processSpec, props.processFunction);

  for (const [task, spec] of [
    [validate, validateSpec],
    [process, processSpec],
  ] as const) {
    // Spec: a duplicate delivery is treated as success. (The current handlers
    // absorb duplicates themselves and never throw this error.)
    task.addCatch(succeeded, {
      errors: [WorkflowError.Duplicate],
      resultPath: sfn.JsonPath.DISCARD,
    });
    task.addCatch(failureDefaults, { errors: [...spec.catch], resultPath: StatePaths.error });
  }

  return validate.next(process).next(recordSuccess).next(succeeded);
}
