import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { HistoryEvent } from '@aws-sdk/client-sfn';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EMULATOR_GAPS,
  LiveHarness,
  attemptsByState,
  unlessEmulatorGap,
  emulatorLambdaExecutor,
  emulatorNotApplicable,
  gapApplies,
  onAws,
  suiteTitle,
  lambdaTaskScheduled,
  resolveTarget,
  titled,
  belongsToRun,
  breakValidateParameters,
  enteredStates,
  evidenceDir,
  extraOutputsFromCdkFile,
  failedOnceWithoutRetry,
  historyOutline,
  maskAccountIds,
  recordEvidence,
  registerAccountId,
} from './live-harness.js';

const ACCOUNT = '111122223333';
const SM = `arn:aws:states:ap-southeast-1:${ACCOUNT}:stateMachine:starter-it-abc-job-processing`;

describe('extraOutputsFromCdkFile', () => {
  it('reads the mini-stack outputs by their exact ids and ignores everything else', () => {
    const outputs = extraOutputsFromCdkFile({
      'starter-it-abc': {
        StateMachineArn: SM,
        StateMachineAliasArn: `${SM}:live`,
        StateMachineVersionArn: `${SM}:1`,
        ExecutionTimeoutSeconds: '45',
        KeyProbeRoleArn: `arn:aws:iam::${ACCOUNT}:role/probe`,
        ProcessorLogGroupName: '/starter/starter-it-abc/lambda/processor',
        Unrelated: 'x',
        KeyArn: 42,
      },
    });
    expect(outputs).toEqual({
      stateMachineAliasArn: `${SM}:live`,
      stateMachineVersionArn: `${SM}:1`,
      executionTimeoutSeconds: '45',
      keyProbeRoleArn: `arn:aws:iam::${ACCOUNT}:role/probe`,
      processorLogGroupName: '/starter/starter-it-abc/lambda/processor',
    });
    expect(extraOutputsFromCdkFile(null)).toEqual({});
  });
});

describe('maskAccountIds', () => {
  it('masks account ids in ARNs (any service, with or without region) and standalone', () => {
    const text = [
      SM,
      `arn:aws:iam::${ACCOUNT}:role/x`,
      `arn:aws:sts::${ACCOUNT}:assumed-role/probe/session`,
      `account ${ACCOUNT}.`,
    ].join(' ');
    const masked = maskAccountIds(text);
    expect(masked).not.toContain(ACCOUNT);
    expect(masked).toContain('arn:aws:states:ap-southeast-1:********3333:stateMachine:');
    expect(masked).toContain('arn:aws:iam::********3333:role/x');
    // The session name (often a person's login) is masked too.
    expect(masked).toContain('arn:aws:sts::********3333:assumed-role/probe/********');
    expect(masked).toContain('account ********3333.');
  });

  it('leaves digits inside identifiers alone (UUID groups, longer numbers)', () => {
    const id = '0d3b7f46-2a4f-4d43-9a0e-123456789012';
    expect(maskAccountIds(id)).toBe(id);
    expect(maskAccountIds('1234567890123')).toBe('1234567890123');
  });
});

/** A minimal history: ProcessJob retried twice, RecordSuccess rejected by its condition. */
function history(): HistoryEvent[] {
  let id = 0;
  const e = (type: string, extra: Partial<HistoryEvent> = {}): HistoryEvent =>
    ({ id: ++id, type, timestamp: new Date(0), ...extra }) as HistoryEvent;
  return [
    e('ExecutionStarted', { executionStartedEventDetails: { input: '{"jobId":"j"}' } }),
    e('TaskStateEntered', { stateEnteredEventDetails: { name: 'ValidateJob', input: '{}' } }),
    e('LambdaFunctionScheduled'),
    e('LambdaFunctionStarted'),
    e('LambdaFunctionSucceeded'),
    e('TaskStateExited', { stateExitedEventDetails: { name: 'ValidateJob' } }),
    e('TaskStateEntered', { stateEnteredEventDetails: { name: 'ProcessJob' } }),
    e('LambdaFunctionScheduled'),
    e('LambdaFunctionFailed', {
      lambdaFunctionFailedEventDetails: { error: 'TransientDependencyError', cause: 'secret?' },
    }),
    e('LambdaFunctionScheduled'),
    e('LambdaFunctionTimedOut', {
      lambdaFunctionTimedOutEventDetails: { error: 'States.Timeout' },
    }),
    e('LambdaFunctionScheduled'),
    e('LambdaFunctionSucceeded'),
    e('TaskStateExited', { stateExitedEventDetails: { name: 'ProcessJob' } }),
    e('TaskStateEntered', { stateEnteredEventDetails: { name: 'RecordSuccess' } }),
    e('TaskScheduled'),
    e('TaskFailed', {
      taskFailedEventDetails: {
        resourceType: 'dynamodb',
        resource: 'updateItem',
        error: 'DynamoDB.ConditionalCheckFailedException',
        cause: 'c',
      },
    }),
    e('TaskStateExited', { stateExitedEventDetails: { name: 'RecordSuccess' } }),
    e('SucceedStateEntered', { stateEnteredEventDetails: { name: 'JobSucceeded' } }),
    e('ExecutionSucceeded'),
  ];
}

describe('history analysis', () => {
  it('lists entered states in order', () => {
    expect(enteredStates(history())).toEqual([
      'ValidateJob',
      'ProcessJob',
      'RecordSuccess',
      'JobSucceeded',
    ]);
  });

  it('counts attempts per state (retries do not re-enter a state) with their error names', () => {
    expect(attemptsByState(history())).toEqual({
      ValidateJob: { attempts: 1, succeeded: 1, errors: [] },
      ProcessJob: {
        attempts: 3,
        succeeded: 1,
        errors: ['TransientDependencyError', 'States.Timeout'],
      },
      RecordSuccess: {
        attempts: 1,
        succeeded: 0,
        errors: ['DynamoDB.ConditionalCheckFailedException'],
      },
      JobSucceeded: { attempts: 0, succeeded: 0, errors: [] },
    });
  });

  it('recognises a permanent failure (exactly one failure with that error, no retry after it)', () => {
    const one = { attempts: 1, succeeded: 0, errors: ['JobValidationError'] };
    expect(failedOnceWithoutRetry(one, 'JobValidationError')).toBe(true);
    const afterHiccup = {
      attempts: 2,
      succeeded: 0,
      errors: ['Lambda.ServiceException', 'JobValidationError'],
    };
    expect(failedOnceWithoutRetry(afterHiccup, 'JobValidationError')).toBe(true);
    const retried = {
      attempts: 2,
      succeeded: 0,
      errors: ['JobValidationError', 'JobValidationError'],
    };
    expect(failedOnceWithoutRetry(retried, 'JobValidationError')).toBe(false);
    const healed = { attempts: 2, succeeded: 1, errors: ['JobValidationError'] };
    expect(failedOnceWithoutRetry(healed, 'JobValidationError')).toBe(false);
    expect(failedOnceWithoutRetry(undefined, 'JobValidationError')).toBe(false);
  });

  it('outlines a history without inputs, outputs or cause text', () => {
    const outline = historyOutline(history());
    const text = JSON.stringify(outline);
    expect(text).not.toContain('jobId');
    expect(text).not.toContain('secret?');
    expect(outline[8]).toMatchObject({
      type: 'LambdaFunctionFailed',
      state: 'ProcessJob',
      error: 'TransientDependencyError',
      hasCause: true,
    });
  });
});

describe('breakValidateParameters', () => {
  const definition = JSON.stringify({
    StartAt: 'ValidateJob',
    TimeoutSeconds: 45,
    States: {
      ValidateJob: {
        Type: 'Task',
        Resource: 'arn:aws:lambda:ap-southeast-1:111122223333:function:v:live',
        Parameters: {
          'jobId.$': '$.jobId',
          'contractVersion.$': '$.contractVersion',
          'submittedAt.$': '$.submittedAt',
          'executionArn.$': '$$.Execution.Id',
        },
        Next: 'ProcessJob',
      },
      ProcessJob: { Type: 'Task', Parameters: { 'submittedAt.$': '$.submittedAt' }, End: true },
    },
  });

  it('drops submittedAt from ValidateJob only; everything else is unchanged', () => {
    const broken = JSON.parse(breakValidateParameters(definition)) as {
      States: Record<string, { Parameters: Record<string, string> }>;
    };
    const original = JSON.parse(definition) as typeof broken;
    expect(Object.keys(broken.States.ValidateJob!.Parameters).sort()).toEqual(
      ['contractVersion.$', 'executionArn.$', 'jobId.$'].sort(),
    );
    expect(broken.States.ProcessJob).toEqual(original.States.ProcessJob);
    expect({ ...broken, States: {} }).toEqual({ ...original, States: {} });
  });

  it('refuses a definition it does not recognise', () => {
    expect(() => breakValidateParameters('{"States":{}}')).toThrow(/submittedAt/);
  });
});

describe('recordEvidence', () => {
  let dir: string | undefined;
  const previous = process.env.AWS_INTEGRATION_REPORT_DIR;
  afterEach(() => {
    if (previous === undefined) delete process.env.AWS_INTEGRATION_REPORT_DIR;
    else process.env.AWS_INTEGRATION_REPORT_DIR = previous;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('writes masked JSON under <report dir>/evidence', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'starter-evidence-'));
    process.env.AWS_INTEGRATION_REPORT_DIR = dir;
    recordEvidence('unit-check', { executionArn: `${SM.replace('stateMachine', 'execution')}:x` });
    const file = path.join(evidenceDir(), 'unit-check.json');
    expect(file.startsWith(dir)).toBe(true);
    const body = readFileSync(file, 'utf8');
    expect(body).not.toContain(ACCOUNT);
    expect(JSON.parse(body)).toMatchObject({ recordedAt: expect.any(String) });
    expect(() => recordEvidence('../escape', {})).toThrow(/evidence name/);
  });
});

describe('run ownership', () => {
  const RUN = 'it-a1b2c3';
  const SM_ARN = `arn:aws:states:ap-southeast-1:${ACCOUNT}:stateMachine:starter-it-${RUN}-job-processing`;

  it.each([
    SM_ARN,
    `${SM_ARN}:live`,
    `${SM_ARN}:2`,
    `starter-it-${RUN}-job-state`,
    `starter-it-${RUN}-ProcessingWorkflowProcessor9-AbCdEf123456`,
    `arn:aws:iam::${ACCOUNT}:role/starter-it-${RUN}-KeyProbeRole0A856A16-Xy12`,
    `/starter/starter-it-${RUN}/lambda/processor`,
    `/aws/vendedlogs/states/starter-it-${RUN}-job-processing`,
  ])('accepts %s', (value) => {
    expect(belongsToRun(value, RUN)).toBe(true);
  });

  it.each([
    `starter-it-it-a1b2c4-job-state`,
    `starter-it-${RUN}x-job-state`,
    `xstarter-it-${RUN}-job-state`,
    `arn:aws:states:ap-southeast-1:${ACCOUNT}:stateMachine:prod-job-processing`,
    'Prod-Workflow-ProcessorFunction',
  ])('rejects %s', (value) => {
    expect(belongsToRun(value, RUN)).toBe(false);
  });

  function outputsFile(stack: string, extra: Record<string, string> = {}): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'starter-outputs-'));
    const file = path.join(dir, 'outputs.json');
    writeFileSync(file, JSON.stringify({ [stack]: { StateMachineArn: SM_ARN, ...extra } }));
    return file;
  }
  const gate = (overrides: Partial<{ tableName: string }> = {}) => ({
    region: 'ap-southeast-1',
    outputs: {
      stateMachineArn: SM_ARN,
      tableName: `starter-it-${RUN}-job-state`,
      documentsTableName: `starter-it-${RUN}-test-documents`,
      reconcilerFunctionName: `starter-it-${RUN}-ReconcilerFunction0432-AbC`,
      ...overrides,
    },
  });

  it('builds a harness only for the run named by AWS_INTEGRATION_RUN_ID', async () => {
    const h = await LiveHarness.create(gate(), {
      AWS_INTEGRATION_RUN_ID: RUN,
      AWS_INTEGRATION_OUTPUTS: outputsFile(`starter-it-${RUN}`, {
        StateMachineAliasArn: `${SM_ARN}:live`,
      }),
    });
    try {
      expect(h.assertRunTarget(`${SM_ARN}:live`)).toBe(`${SM_ARN}:live`);
      expect(() => h.assertRunTarget('starter-it-other-run-job-state')).toThrow(/Refusing/);
    } finally {
      h.destroy();
    }
  });

  it('refuses without a run id, with another stack in the outputs, or an output of another run', async () => {
    await expect(LiveHarness.create(gate(), {})).rejects.toThrow(/AWS_INTEGRATION_RUN_ID/);
    await expect(
      LiveHarness.create(gate(), {
        AWS_INTEGRATION_RUN_ID: RUN,
        AWS_INTEGRATION_OUTPUTS: outputsFile('starter-it-it-ffffff'),
      }),
    ).rejects.toThrow(/exactly the outputs of stack/);
    await expect(
      LiveHarness.create(gate({ tableName: 'Prod-Data-JobStateTable' }), {
        AWS_INTEGRATION_RUN_ID: RUN,
      }),
    ).rejects.toThrow(/not a resource of run/);
  });
});

describe('evidence masking', () => {
  it('masks registered and dash-adjacent account ids, session names and e-mails; keeps UUIDs', () => {
    registerAccountId('444455556666');
    const uuid = '0d3b7f46-2a4f-4d43-9a0e-123456789012';
    const text = [
      'cdk-starter-deploy-role-444455556666-ap-southeast-1',
      'acct444455556666x',
      'arn:aws:sts::444455556666:assumed-role/AWSReservedSSO_Dev_abc/jane.doe@example.com',
      'arn:aws:sts::777788889999:assumed-role/probe/starter-it-kms-probe',
      'contact ops.person@example.org now',
      uuid,
    ].join(' ');
    const masked = maskAccountIds(text);
    expect(masked).not.toContain('444455556666');
    expect(masked).not.toContain('777788889999');
    expect(masked).not.toContain('jane.doe');
    expect(masked).not.toContain('starter-it-kms-probe');
    expect(masked).not.toContain('ops.person');
    expect(masked).toContain('assumed-role/AWSReservedSSO_Dev_abc/********');
    expect(masked).toContain('<email>');
    expect(masked).toContain(uuid);
  });
});

describe('integration target (AWS vs the emulator)', () => {
  const emulatorEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    AWS_INTEGRATION_TARGET: 'emulator',
    AWS_ENDPOINT_URL: 'http://127.0.0.1:45660',
    AWS_ACCESS_KEY_ID: '000000000001',
    AWS_SECRET_ACCESS_KEY: 'ministack-local-only',
    AWS_CONFIG_FILE: '/dev/null',
    AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
    AWS_EC2_METADATA_DISABLED: 'true',
    // The CDK CLI phone-home switches the shared guard requires.
    CDK_DISABLE_CLI_TELEMETRY: 'true',
    CDK_DISABLE_VERSION_CHECK: 'true',
    ...extra,
  });

  it('is AWS unless AWS_INTEGRATION_TARGET=emulator passes the shared emulator guard', () => {
    expect(resolveTarget({})).toBe('aws');
    expect(resolveTarget({ AWS_INTEGRATION_TARGET: 'aws' })).toBe('aws');
    expect(resolveTarget(emulatorEnv())).toBe('emulator');
    expect(
      resolveTarget(
        emulatorEnv({
          GITLAB_CI: 'true',
          STARTER_EMULATOR_MODE: 'ci-service',
          STARTER_EMULATOR_ALLOWED_ENDPOINT: 'http://ministack:4566',
          AWS_ENDPOINT_URL: 'http://ministack:4566',
        }),
      ),
    ).toBe('emulator');
    expect(() =>
      resolveTarget(
        emulatorEnv({ AWS_ENDPOINT_URL: 'https://states.ap-southeast-1.amazonaws.com' }),
      ),
    ).toThrow(/loopback/);
    expect(() => resolveTarget(emulatorEnv({ AWS_ENDPOINT_URL: undefined }))).toThrow(
      /AWS_ENDPOINT_URL is not set/,
    );
    expect(() =>
      resolveTarget(emulatorEnv({ AWS_ENDPOINT_URL_SFN: 'http://127.0.0.1:1' })),
    ).toThrow(/AWS_ENDPOINT_URL_SFN/);
    expect(() => resolveTarget(emulatorEnv({ AWS_PROFILE: 'p' }))).toThrow(/AWS_PROFILE/);
    expect(() => resolveTarget({ AWS_INTEGRATION_TARGET: 'localstack' })).toThrow(/expected/);
  });

  it('marks not-applicable tests on the emulator only', () => {
    expect(emulatorNotApplicable('executionTimeout', 'aws')).toBeUndefined();
    expect(emulatorNotApplicable('executionTimeout', 'emulator')).toBe(
      `emulator-not-applicable: ${EMULATOR_GAPS.executionTimeout}`,
    );
    expect(titled('t', 'executionTimeout', 'aws')).toBe('t');
    expect(titled('t', 'executionTimeout', 'emulator')).toMatch(/^t \[emulator-not-applicable: /);
  });

  it('applies the error-name gap only to the socket-less local Lambda executor', () => {
    expect(emulatorLambdaExecutor({})).toBe('local');
    expect(emulatorLambdaExecutor({ MINISTACK_LAMBDA_EXECUTOR: 'docker' })).toBe('docker');
    expect(gapApplies('localExecutorErrorNames', 'emulator', {})).toBe(true);
    expect(
      gapApplies('localExecutorErrorNames', 'emulator', { MINISTACK_LAMBDA_EXECUTOR: 'local' }),
    ).toBe(true);
    expect(
      gapApplies('localExecutorErrorNames', 'emulator', { MINISTACK_LAMBDA_EXECUTOR: 'docker' }),
    ).toBe(false);
    expect(gapApplies('localExecutorErrorNames', 'aws', {})).toBe(false);
    // Executor-independent gaps hold with every executor.
    expect(
      gapApplies('retryJitterMaxDelay', 'emulator', { MINISTACK_LAMBDA_EXECUTOR: 'docker' }),
    ).toBe(true);
  });

  it('titles name their target and drop AWS-only claims on the emulator', () => {
    expect(suiteTitle('workflow', 'aws')).toBe('AWS integration stack workflow');
    expect(suiteTitle('workflow', 'emulator')).toBe(
      '[ministack-emulator] integration stack workflow',
    );
    expect(onAws('real ', 'emulated ', 'aws')).toBe('real ');
    expect(onAws('real ', 'emulated ', 'emulator')).toBe('emulated ');
    expect(onAws(' (real calls)', undefined, 'emulator')).toBe('');
  });

  it('runs unlessEmulatorGap assertions on AWS (this unit run is the AWS target)', () => {
    let ran = false;
    unlessEmulatorGap('failStatePaths', 'probe', () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it('a real-AWS harness refuses an endpoint override', async () => {
    await expect(
      LiveHarness.create(
        {
          region: 'ap-southeast-1',
          outputs: {
            stateMachineArn: SM,
            tableName: 'starter-it-it-a1b2c3-job-state',
            documentsTableName: 'starter-it-it-a1b2c3-test-documents',
          },
        },
        { AWS_INTEGRATION_RUN_ID: 'it-a1b2c3', AWS_ENDPOINT_URL: 'http://127.0.0.1:45660' },
      ),
    ).rejects.toThrow(/endpoint override is not AWS/);
  });

  it('finds the Lambda task scheduling events of both history shapes', () => {
    const events = [
      { type: 'LambdaFunctionScheduled' },
      { type: 'TaskScheduled', taskScheduledEventDetails: { resourceType: 'lambda' } },
      { type: 'TaskScheduled', taskScheduledEventDetails: { resourceType: 'dynamodb' } },
    ] as HistoryEvent[];
    expect(lambdaTaskScheduled(events)).toHaveLength(2);
  });
});
