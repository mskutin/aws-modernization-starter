import { describe, expect, it } from 'vitest';
import { outputsFromCdkFile, resolveAwsGate } from './aws-gate.js';

const okCreds = async () => ({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'x' });
const noCreds = async () => {
  throw new Error('Could not load credentials from any providers');
};
const ARN = 'arn:aws:states:ap-southeast-1:111122223333:stateMachine:starter-it-abc-processing';

describe('resolveAwsGate', () => {
  it('skips (with reason) unless AWS_INTEGRATION_ENABLED=true', async () => {
    const g = await resolveAwsGate({}, { resolveCredentials: okCreds });
    expect(g).toEqual({
      enabled: false,
      required: false,
      reason: expect.stringMatching(/AWS_INTEGRATION_ENABLED/),
    });
  });

  it('skips when credentials do not resolve, and marks it required when asked', async () => {
    const env = { AWS_INTEGRATION_ENABLED: 'true', AWS_REGION: 'ap-southeast-1' };
    const g = await resolveAwsGate(env, { resolveCredentials: noCreds });
    expect(g.enabled).toBe(false);
    if (!g.enabled) expect(g.reason).toMatch(/no AWS credentials/);
    const r = await resolveAwsGate(
      { ...env, AWS_INTEGRATION_REQUIRED: 'true' },
      { resolveCredentials: noCreds },
    );
    expect(r.enabled === false && r.required).toBe(true);
  });

  it('skips without a region', async () => {
    const g = await resolveAwsGate(
      { AWS_INTEGRATION_ENABLED: 'true' },
      { resolveCredentials: okCreds },
    );
    expect(g.enabled === false && g.reason).toMatch(/AWS_REGION/);
  });

  it('fails loudly (does not skip) when enabled with credentials but no stack outputs', async () => {
    await expect(
      resolveAwsGate(
        { AWS_INTEGRATION_ENABLED: 'true', AWS_REGION: 'ap-southeast-1' },
        { resolveCredentials: okCreds },
      ),
    ).rejects.toThrow(/outputs are missing/);
  });

  it('reads outputs from a cdk outputs file', async () => {
    const file = JSON.stringify({
      'starter-it-abc': {
        ProcessingStateMachineArn12AB: ARN,
        JobsTableName9F: 'starter-it-abc-jobs',
        TestDocumentsTableName: 'starter-it-abc-test-documents',
        ReconcilerFunctionName: 'starter-it-abc-reconciler',
      },
    });
    const g = await resolveAwsGate(
      {
        AWS_INTEGRATION_ENABLED: 'true',
        AWS_REGION: 'ap-southeast-1',
        AWS_INTEGRATION_OUTPUTS: 'outputs.json',
        AWS_INTEGRATION_RUN_ID: 'abc',
      },
      { resolveCredentials: okCreds, readText: async () => file },
    );
    expect(g).toEqual({
      enabled: true,
      region: 'ap-southeast-1',
      runId: 'abc',
      outputs: {
        stateMachineArn: ARN,
        tableName: 'starter-it-abc-jobs',
        documentsTableName: 'starter-it-abc-test-documents',
        reconcilerFunctionName: 'starter-it-abc-reconciler',
      },
    });
  });

  it('fails loudly when the test-document table output is missing (spec 2.0.0 needs it)', async () => {
    const file = JSON.stringify({ s: { StateMachineArn: ARN, JobsTableName: 'jobs' } });
    await expect(
      resolveAwsGate(
        {
          AWS_INTEGRATION_ENABLED: 'true',
          AWS_REGION: 'ap-southeast-1',
          AWS_INTEGRATION_OUTPUTS: 'outputs.json',
        },
        { resolveCredentials: okCreds, readText: async () => file },
      ),
    ).rejects.toThrow(/TEST_DOCUMENTS_TABLE_NAME/);
  });
});

describe('outputsFromCdkFile', () => {
  it('ignores non-matching keys and non-ARN values', () => {
    expect(
      outputsFromCdkFile({ s: { StateMachineArn: 'not-an-arn', Other: 'x', TableName: 't' } }),
    ).toEqual({ tableName: 't' });
    expect(outputsFromCdkFile(null)).toEqual({});
  });

  it('never mistakes the test-document table for the job table', () => {
    expect(
      outputsFromCdkFile({
        s: { TestDocumentsTableName: 'docs', JobsTableName: 'jobs' },
      }),
    ).toEqual({ documentsTableName: 'docs', tableName: 'jobs' });
  });
});
