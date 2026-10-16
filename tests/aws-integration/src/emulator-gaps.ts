/**
 * The declared gaps of the MiniStack EMULATOR (behaviour MiniStack 1.5.26 does not reproduce,
 * verified against its source and by running the suites). Shared by the live-test harness and the
 * results CLI; no vitest, no SDK. Every not-applicable test and assertion names one of these gaps
 * and is listed in tests/aws-integration/emulator/expected-not-applicable.json.
 */

/** MiniStack's Lambda executor: `local` (socket-less default) or `docker` (needs an engine API). */
export type LambdaExecutor = 'local' | 'docker';

/** The executor the emulator scripts started MiniStack with (`MINISTACK_LAMBDA_EXECUTOR`). */
export function emulatorLambdaExecutor(env: NodeJS.ProcessEnv = process.env): LambdaExecutor {
  return env.MINISTACK_LAMBDA_EXECUTOR === 'docker' ? 'docker' : 'local';
}

/**
 * Behaviour MiniStack 1.5.26 does not reproduce (verified against its source and by running the
 * suites). A test or assertion depending on one is reported `emulator-not-applicable` on the
 * emulator — never counted as passed — and runs unchanged on AWS. Every not-applicable test and
 * assertion is listed in tests/aws-integration/emulator/expected-not-applicable.json; the
 * emulator results fail on any that is not.
 */
export const EMULATOR_GAPS = {
  failStatePaths:
    'MiniStack ignores Fail-state ErrorPath/CausePath: a failed execution reports error States.Fail and no cause',
  taskInputNotInHistory:
    'MiniStack records no task input in the execution history (TaskScheduled carries the resource only)',
  executionTimeout:
    'MiniStack never times out an execution: the state machine TimeoutSeconds is not enforced and TIMED_OUT is never set',
  versionsAliases:
    'MiniStack runs executions started through a version or alias on the latest revision, omits their version/alias ARNs, and its CloudFormation does not provision StateMachineVersion/Alias',
  iamNotEnforced:
    'MiniStack stores IAM policies without enforcing them; its SimulatePrincipalPolicy is its own evaluator, not AWS',
  kmsNotEnforced:
    'MiniStack enforces neither KMS key policies nor the caller-side KMS checks of DynamoDB and Step Functions',
  lambdaThrottle:
    'Reserved concurrency 0 does not throttle Step Functions task invocations in MiniStack (the execution succeeds)',
  ddbUpdateTypeCheck:
    'MiniStack DynamoDB does not reject SET a = a + :n on a non-numeric attribute (DynamoDB raises ValidationException), so RecordFailure cannot be made to fail this way',
  sfnExecutionLogs:
    'MiniStack stores the state machine logging configuration but delivers no execution events to CloudWatch Logs',
  localExecutorErrorNames:
    "MiniStack's socket-less local Lambda executor reports every handler error as Runtime.HandlerError (the thrown error's name is dropped), so Retry/Catch on handler error names (TransientDependencyError, DuplicateExecutionError) and error-name assertions cannot be verified",
  retryJitterMaxDelay:
    'MiniStack implements neither MaxDelaySeconds nor JitterStrategy of a Retrier (plain exponential backoff), so the capped, jittered waits between retries are not verifiable',
} as const;
export type EmulatorGap = keyof typeof EMULATOR_GAPS;

/** Gaps that hold only with some Lambda executors (all others hold on every emulator run). */
export const EXECUTOR_SPECIFIC_GAPS: Partial<Record<EmulatorGap, readonly LambdaExecutor[]>> = {
  localExecutorErrorNames: ['local'],
};

/** The gap whose reason a `emulator-not-applicable: <reason>` marker carries (reverse lookup). */
export function gapOfReason(reason: string): EmulatorGap | undefined {
  const text = reason.replace(/^emulator-not-applicable:\s*/, '');
  return (Object.keys(EMULATOR_GAPS) as EmulatorGap[]).find((g) => EMULATOR_GAPS[g] === text);
}
