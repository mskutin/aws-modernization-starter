import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  RECONCILER_MIN_STALE_AFTER_SECONDS,
  loadJobAuditConfig,
  loadLambdaConfig,
  loadLocalReconcilerConfig,
  loadReconcilerLambdaConfig,
} from '../src/index.js';

const LAMBDA = { JOBS_TABLE_NAME: 'starter-jobs', AWS_REGION: 'ap-southeast-1' };
const SM = 'arn:aws:states:ap-southeast-1:123456789012:stateMachine:starter-dev-job-processing';

describe('JOB_AUDIT_TTL_DAYS', () => {
  it('is disabled (undefined) by default — audit items are kept until retention is approved', () => {
    expect(loadJobAuditConfig({})).toEqual({ auditTtlDays: undefined });
    expect(loadJobAuditConfig({ JOB_AUDIT_TTL_DAYS: '' })).toEqual({ auditTtlDays: undefined });
  });

  it('accepts 1..3650 days and rejects anything else', () => {
    expect(loadJobAuditConfig({ JOB_AUDIT_TTL_DAYS: '90' }).auditTtlDays).toBe(90);
    for (const bad of ['0', '-1', '3651', '1.5', 'forever']) {
      expect(() => loadJobAuditConfig({ JOB_AUDIT_TTL_DAYS: bad })).toThrow(ConfigError);
    }
  });
});

describe('Lambda APP_RUNTIME', () => {
  it('defaults to aws — CDK never sets it', () => {
    expect(loadLambdaConfig(LAMBDA).runtime).toBe('aws');
    expect(loadLambdaConfig({ ...LAMBDA, APP_RUNTIME: 'ci' }).runtime).toBe('ci');
    expect(() => loadLambdaConfig({ ...LAMBDA, APP_RUNTIME: 'prod' })).toThrow(ConfigError);
  });
});

describe('reconciler Lambda config', () => {
  it('has safe defaults: 900 s staleness, batch 25, live (not dry-run), 45 s budget', () => {
    expect(loadReconcilerLambdaConfig({ ...LAMBDA, STATE_MACHINE_ARN: SM })).toMatchObject({
      tableName: 'starter-jobs',
      stateMachineArn: SM,
      runtime: 'aws',
      reconciler: { staleAfterSeconds: 900, batchSize: 25, dryRun: false, maxRuntimeSeconds: 45 },
    });
  });

  it('never accepts a staleness threshold inside the execution timeout + grace', () => {
    expect(RECONCILER_MIN_STALE_AFTER_SECONDS).toBe(660);
    expect(() =>
      loadReconcilerLambdaConfig({
        ...LAMBDA,
        STATE_MACHINE_ARN: SM,
        RECONCILER_STALE_AFTER_SECONDS: '600',
      }),
    ).toThrow(/RECONCILER_STALE_AFTER_SECONDS: must be at least 660/);
  });

  it.each([
    ['a missing state machine ARN', {}, /STATE_MACHINE_ARN: is required/],
    ['a batch above 100', { STATE_MACHINE_ARN: SM, RECONCILER_BATCH_SIZE: '101' }, /BATCH_SIZE/],
    ['a non-boolean dry run', { STATE_MACHINE_ARN: SM, RECONCILER_DRY_RUN: 'yes' }, /DRY_RUN/],
  ])('rejects %s', (_name, extra, message) => {
    expect(() => loadReconcilerLambdaConfig({ ...LAMBDA, ...extra })).toThrow(message);
  });

  it('parses an explicit dry run', () => {
    expect(
      loadReconcilerLambdaConfig({ ...LAMBDA, STATE_MACHINE_ARN: SM, RECONCILER_DRY_RUN: 'true' })
        .reconciler.dryRun,
    ).toBe(true);
  });
});

describe('local (in-API) reconciler loop', () => {
  it('is disabled by default', () => {
    expect(loadLocalReconcilerConfig({}).intervalSeconds).toBe(0);
  });

  it('runs only with WORKFLOW_MODE=local outside AWS', () => {
    expect(
      loadLocalReconcilerConfig({
        RECONCILER_LOCAL_INTERVAL_SECONDS: '60',
        WORKFLOW_MODE: 'local',
        APP_RUNTIME: 'local',
      }).intervalSeconds,
    ).toBe(60);
  });

  it('is rejected with WORKFLOW_MODE=stepfunctions (the Lambda is the only reconciler there)', () => {
    expect(() =>
      loadLocalReconcilerConfig({
        RECONCILER_LOCAL_INTERVAL_SECONDS: '60',
        WORKFLOW_MODE: 'stepfunctions',
        APP_RUNTIME: 'local',
      }),
    ).toThrow(/RECONCILER_LOCAL_INTERVAL_SECONDS: is only allowed with WORKFLOW_MODE=local/);
  });

  it('is rejected in the aws runtime even in local workflow mode', () => {
    expect(() =>
      loadLocalReconcilerConfig({
        RECONCILER_LOCAL_INTERVAL_SECONDS: '60',
        WORKFLOW_MODE: 'local',
      }),
    ).toThrow(/is only allowed when APP_RUNTIME is local or ci/);
  });
});
