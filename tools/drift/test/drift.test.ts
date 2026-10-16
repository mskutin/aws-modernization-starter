import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CloudFormationClient,
  DescribeStackDriftDetectionStatusCommand,
  DescribeStackResourceDriftsCommand,
  DetectStackDriftCommand,
} from '@aws-sdk/client-cloudformation';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { EXIT, run, type Deps } from '../src/cli.js';
import { detectDrift } from '../src/detect.js';
import { stageStacks } from '../src/stacks.js';

const CDK_OUT = join(import.meta.dirname, 'fixtures', 'cloud-assembly');
const cfn = mockClient(CloudFormationClient);
const out = () => mkdtempSync(join(tmpdir(), 'starter-drift-'));
const lines: string[] = [];

/** Client with static fake credentials (never sent anywhere: `send` is mocked). */
const fakeClient = (region?: string) =>
  new CloudFormationClient({
    region: region ?? 'ap-southeast-1',
    credentials: { accessKeyId: 'test-access-key-id', secretAccessKey: 'test-secret-access-key' },
  });

const deps = (extra: Partial<Deps> = {}): Deps => {
  let t = 0;
  return {
    env: {},
    clientFactory: fakeClient,
    sleep: async () => undefined,
    now: () => (t += 1000),
    log: (l) => void lines.push(l),
    ...extra,
  };
};

beforeEach(() => {
  cfn.reset();
  lines.length = 0;
});

describe('stage stack resolution', () => {
  it('reads stack names and region from the Stage nested assembly', () => {
    expect(stageStacks(CDK_OUT, 'prod')).toEqual([
      {
        stackName: 'starter-prd-data',
        displayName: 'Prod/Data',
        account: '111122223333',
        region: 'ap-southeast-1',
      },
      {
        stackName: 'starter-prd-api',
        displayName: 'Prod/Api',
        account: '111122223333',
        region: 'ap-southeast-1',
      },
    ]);
    expect(stageStacks(CDK_OUT, 'dev')).toEqual([]);
  });
});

describe('gating: never runs without opt-in and credentials', () => {
  it('without opt-in: not-configured, executed=false, exit 3, no AWS call', async () => {
    const dir = out();
    const { code, report } = await run(
      ['--stage', 'prod', '--cdk-out', CDK_OUT, '--out', dir],
      deps(),
    );
    expect(code).toBe(EXIT.NOT_CONFIGURED);
    expect(report).toMatchObject({ status: 'not-configured', executed: false, stacks: [] });
    expect(report?.reason).toContain('opt-in');
    expect(cfn.calls()).toHaveLength(0);
    const written = JSON.parse(readFileSync(join(dir, 'drift-report.json'), 'utf8'));
    expect(written).toMatchObject({ status: 'not-configured', executed: false });
    expect(written.note).toContain('do not and cannot detect drift');
  });

  it('opted in but no credentials: not-configured, exit 3, no API call', async () => {
    const noCreds = (region?: string) =>
      new CloudFormationClient({
        region: region ?? 'ap-southeast-1',
        credentials: async () => {
          throw new Error('Could not load credentials from any providers');
        },
      });
    const { code, report } = await run(
      ['--stage', 'prod', '--cdk-out', CDK_OUT, '--out', out(), '--execute'],
      deps({ clientFactory: noCreds }),
    );
    expect(code).toBe(EXIT.NOT_CONFIGURED);
    expect(report?.executed).toBe(false);
    expect(report?.reason).toContain('no AWS credentials');
    expect(cfn.calls()).toHaveLength(0);
  });

  it('DRIFT_DETECTION_ENABLED=true is an accepted opt-in', async () => {
    cfn.on(DetectStackDriftCommand).resolves({ StackDriftDetectionId: 'd-1' });
    cfn.on(DescribeStackDriftDetectionStatusCommand).resolves({
      StackId: 'x',
      StackDriftDetectionId: 'd-1',
      DetectionStatus: 'DETECTION_COMPLETE',
      StackDriftStatus: 'IN_SYNC',
      Timestamp: new Date(0),
    });
    const { code, report } = await run(
      ['--stacks', 'starter-prd-data', '--out', out()],
      deps({ env: { DRIFT_DETECTION_ENABLED: 'true' } }),
    );
    expect(code).toBe(EXIT.IN_SYNC);
    expect(report).toMatchObject({ status: 'in-sync', executed: true });
  });
});

describe('drift detection with a mocked CloudFormation API', () => {
  it('polls until complete and reports drifted resources with property differences', async () => {
    cfn
      .on(DetectStackDriftCommand, { StackName: 'starter-prd-data' })
      .resolves({ StackDriftDetectionId: 'd-data' });
    cfn
      .on(DetectStackDriftCommand, { StackName: 'starter-prd-api' })
      .resolves({ StackDriftDetectionId: 'd-api' });
    cfn
      .on(DescribeStackDriftDetectionStatusCommand, { StackDriftDetectionId: 'd-data' })
      .resolvesOnce({
        StackId: 's',
        StackDriftDetectionId: 'd-data',
        DetectionStatus: 'DETECTION_IN_PROGRESS',
        Timestamp: new Date(0),
      })
      .resolves({
        StackId: 's',
        StackDriftDetectionId: 'd-data',
        DetectionStatus: 'DETECTION_COMPLETE',
        StackDriftStatus: 'DRIFTED',
        DriftedStackResourceCount: 1,
        Timestamp: new Date(0),
      });
    cfn.on(DescribeStackDriftDetectionStatusCommand, { StackDriftDetectionId: 'd-api' }).resolves({
      StackId: 's',
      StackDriftDetectionId: 'd-api',
      DetectionStatus: 'DETECTION_COMPLETE',
      StackDriftStatus: 'IN_SYNC',
      Timestamp: new Date(0),
    });
    cfn
      .on(DescribeStackResourceDriftsCommand)
      .resolvesOnce({
        StackResourceDrifts: [
          {
            StackId: 's',
            LogicalResourceId: 'DatabaseInstanceAA8A5FDE',
            PhysicalResourceId: 'starter-prd-postgres',
            ResourceType: 'AWS::RDS::DBInstance',
            StackResourceDriftStatus: 'MODIFIED',
            Timestamp: new Date(0),
            PropertyDifferences: [
              {
                PropertyPath: '/DeletionProtection',
                ExpectedValue: 'true',
                ActualValue: 'false',
                DifferenceType: 'NOT_EQUAL',
              },
            ],
          },
        ],
        NextToken: 'page-2',
      })
      .resolves({
        StackResourceDrifts: [
          {
            StackId: 's',
            LogicalResourceId: 'JobStateTableDF750A7D',
            ResourceType: 'AWS::DynamoDB::Table',
            StackResourceDriftStatus: 'DELETED',
            Timestamp: new Date(0),
          },
        ],
      });

    const dir = out();
    const { code, report } = await run(
      ['--stage', 'prod', '--cdk-out', CDK_OUT, '--out', dir, '--execute'],
      deps(),
    );
    expect(code).toBe(EXIT.DRIFTED);
    expect(report).toMatchObject({ status: 'drifted', executed: true, region: 'ap-southeast-1' });
    const data = report?.stacks[0];
    expect(data).toMatchObject({
      stackName: 'starter-prd-data',
      stackDriftStatus: 'DRIFTED',
      driftedResourceCount: 1,
    });
    expect(data?.resources.map((r) => [r.logicalId, r.driftStatus])).toEqual([
      ['DatabaseInstanceAA8A5FDE', 'MODIFIED'],
      ['JobStateTableDF750A7D', 'DELETED'],
    ]);
    expect(data?.resources[0]?.differences[0]).toEqual({
      path: '/DeletionProtection',
      expected: 'true',
      actual: 'false',
      type: 'NOT_EQUAL',
    });
    expect(report?.stacks[1]).toMatchObject({
      stackName: 'starter-prd-api',
      stackDriftStatus: 'IN_SYNC',
      resources: [],
    });
    expect(cfn.commandCalls(DescribeStackDriftDetectionStatusCommand)).toHaveLength(3);
    expect(cfn.commandCalls(DescribeStackResourceDriftsCommand)[0]?.args[0].input).toMatchObject({
      StackName: 'starter-prd-data',
      StackResourceDriftStatusFilters: ['MODIFIED', 'DELETED'],
    });
    expect(readFileSync(join(dir, 'drift-report.md'), 'utf8')).toContain(
      '| DatabaseInstanceAA8A5FDE |',
    );
  });

  it('API errors (e.g. stack not deployed) → status error, exit 2', async () => {
    cfn.on(DetectStackDriftCommand).rejects(
      Object.assign(new Error('Stack with id starter-prd-data does not exist'), {
        name: 'ValidationError',
      }),
    );
    const { code, report } = await run(
      ['--stacks', 'starter-prd-data', '--out', out(), '--execute'],
      deps(),
    );
    expect(code).toBe(EXIT.ERROR);
    expect(report?.stacks[0]?.error).toContain('does not exist');
  });

  it('detection failure and timeout are errors, never "in sync"', async () => {
    cfn.on(DetectStackDriftCommand).resolves({ StackDriftDetectionId: 'd' });
    cfn.on(DescribeStackDriftDetectionStatusCommand).resolves({
      StackId: 's',
      StackDriftDetectionId: 'd',
      DetectionStatus: 'DETECTION_IN_PROGRESS',
      Timestamp: new Date(0),
    });
    let t = 0;
    const results = await detectDrift({
      client: fakeClient(),
      stacks: ['a'],
      timeoutMs: 3000,
      pollIntervalMs: 1000,
      sleep: async () => undefined,
      now: () => (t += 1000),
    });
    expect(results[0]?.error).toContain('did not complete');

    cfn.on(DescribeStackDriftDetectionStatusCommand).resolves({
      StackId: 's',
      StackDriftDetectionId: 'd',
      DetectionStatus: 'DETECTION_FAILED',
      DetectionStatusReason: 'Failed to detect drift on resource X',
      StackDriftStatus: 'UNKNOWN',
      Timestamp: new Date(0),
    });
    cfn.on(DescribeStackResourceDriftsCommand).resolves({ StackResourceDrifts: [] });
    const { code } = await run(['--stacks', 'a', '--out', out(), '--execute'], deps());
    expect(code).toBe(EXIT.ERROR);
  });

  it('usage errors exit 2', async () => {
    expect((await run([], deps())).code).toBe(EXIT.ERROR);
    expect((await run(['--bogus'], deps())).code).toBe(EXIT.ERROR);
    const missing = await run(
      ['--stage', 'prod', '--cdk-out', join(CDK_OUT, 'nope'), '--out', out(), '--execute'],
      deps(),
    );
    expect(missing.code).toBe(EXIT.ERROR);
    expect(missing.report?.executed).toBe(false);
  });
});
