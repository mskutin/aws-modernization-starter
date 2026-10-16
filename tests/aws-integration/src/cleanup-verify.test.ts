import { describe, expect, it } from 'vitest';
import {
  DescribeStacksCommand,
  type DeleteStackCommand,
  type DescribeStacksCommandOutput,
  type DeleteStackCommandOutput,
  type Stack,
} from '@aws-sdk/client-cloudformation';
import {
  type GetResourcesCommand,
  type GetResourcesCommandOutput,
} from '@aws-sdk/client-resource-groups-tagging-api';
import { type DescribeKeyCommand, type DescribeKeyCommandOutput } from '@aws-sdk/client-kms';
import {
  CLEANUP_EXIT_CODES,
  classifyResidual,
  exitCodeFor,
  verifyCleanup,
  type CleanupStatus,
  type KmsLike,
  type TaggingLike,
} from './cleanup-verify.js';
import { type CloudFormationLike } from './sweeper.js';

const runStack = (name: string, runId: string, status: Stack['StackStatus']): Stack => ({
  StackName: name,
  StackStatus: status,
  CreationTime: new Date(),
  Tags: [
    { Key: 'starter:run-id', Value: runId },
    { Key: 'starter:ephemeral', Value: 'true' },
  ],
});

/** Mocked clients whose state advances one "tick" per DescribeStacks page-1 call. */
function fakes(timeline: { stacks: Stack[][]; resources: string[][] }) {
  let tick = 0;
  const cfn: CloudFormationLike = {
    async send(
      cmd: DescribeStacksCommand | DeleteStackCommand,
    ): Promise<DescribeStacksCommandOutput | DeleteStackCommandOutput> {
      if (!(cmd instanceof DescribeStacksCommand)) throw new Error('unexpected');
      const snapshot = timeline.stacks[Math.min(tick, timeline.stacks.length - 1)] ?? [];
      return { $metadata: {}, Stacks: snapshot };
    },
  };
  const tagging: TaggingLike = {
    async send(_cmd: GetResourcesCommand): Promise<GetResourcesCommandOutput> {
      const snapshot = timeline.resources[Math.min(tick, timeline.resources.length - 1)] ?? [];
      tick += 1;
      return {
        $metadata: {},
        ResourceTagMappingList: snapshot.map((ResourceARN) => ({ ResourceARN })),
      };
    },
  };
  return { cfn, tagging };
}

const fastOpts = (t: { now: number }) => ({
  runId: 'r1',
  region: 'ap-southeast-1',
  destroyExitCode: 0,
  waitSeconds: 60,
  strictResources: false,
  pollIntervalMs: 15_000,
  clock: () => t.now,
  sleep: async (ms: number) => {
    t.now += ms;
  },
});

describe('verifyCleanup', () => {
  it('is clean once stacks finish deleting (ignores other runs and DELETE_COMPLETE)', async () => {
    const t = { now: 0 };
    const deps = fakes({
      stacks: [
        [
          runStack('starter-it-r1', 'r1', 'DELETE_IN_PROGRESS'),
          runStack('starter-it-r2', 'r2', 'CREATE_COMPLETE'),
        ],
        [
          runStack('starter-it-r1', 'r1', 'DELETE_COMPLETE'),
          runStack('starter-it-r2', 'r2', 'CREATE_COMPLETE'),
        ],
      ],
      resources: [['arn:aws:dynamodb:ap-southeast-1:1:table/x'], []],
    });
    const r = await verifyCleanup(deps, fastOpts(t));
    expect(r.status).toBe('clean');
    expect(r.remainingStacks).toEqual([]);
    expect(t.now).toBe(15_000);
  });

  it('reports leaked stacks after the deadline', async () => {
    const t = { now: 0 };
    const deps = fakes({
      stacks: [[runStack('starter-it-r1', 'r1', 'DELETE_FAILED')]],
      resources: [[]],
    });
    const r = await verifyCleanup(deps, fastOpts(t));
    expect(r.status).toBe('leaked');
    expect(r.remainingStacks).toEqual([{ stackName: 'starter-it-r1', status: 'DELETE_FAILED' }]);
    expect(t.now).toBeGreaterThanOrEqual(60_000);
  });

  it('treats lingering tagged resources as NOT verified (exit 4), a leak when strict', async () => {
    const t1 = { now: 0 };
    const lingering = { stacks: [[]], resources: [['arn:aws:logs:ap-southeast-1:1:log-group:/x']] };
    const lenient = await verifyCleanup(fakes(lingering), fastOpts(t1));
    expect(lenient.status).toBe('clean-with-residual-resources');
    expect(lenient.message).toMatch(/NOT verified clean/);
    expect(exitCodeFor(lenient.status)).toBe(4);
    const t2 = { now: 0 };
    const strict = await verifyCleanup(fakes(lingering), {
      ...fastOpts(t2),
      strictResources: true,
    });
    expect(strict.status).toBe('leaked');
  });

  it('returns status=error when the AWS API call fails', async () => {
    const t = { now: 0 };
    const r = await verifyCleanup(
      {
        cfn: {
          send: async () => {
            throw Object.assign(new Error('Rate exceeded'), { name: 'Throttling' });
          },
        },
        tagging: fakes({ stacks: [[]], resources: [[]] }).tagging,
      },
      fastOpts(t),
    );
    expect(r.status).toBe('error');
    expect(r.message).toMatch(/Throttling: Rate exceeded/);
  });

  const deniedTagging = (error: Error): TaggingLike => ({
    send: async () => {
      throw error;
    },
  });
  const accessDenied = () =>
    Object.assign(new Error('not authorized to perform: tag:GetResources'), {
      name: 'AccessDeniedException',
      $metadata: { httpStatusCode: 400 },
    });

  it('tag:GetResources denied: stacks-clean (not clean) when no stack remains, sweep marked not-permitted', async () => {
    const t = { now: 0 };
    const r = await verifyCleanup(
      { cfn: fakes({ stacks: [[]], resources: [[]] }).cfn, tagging: deniedTagging(accessDenied()) },
      fastOpts(t),
    );
    expect(r).toMatchObject({
      status: 'stacks-clean',
      taggingCheck: 'not-permitted',
      residualResources: [],
    });
    expect(r.message).toMatch(/NOT checked/);
  });

  it('tag:GetResources denied: a remaining stack is still a leak', async () => {
    const t = { now: 0 };
    const r = await verifyCleanup(
      {
        cfn: fakes({ stacks: [[runStack('a', 'r1', 'DELETE_FAILED')]], resources: [[]] }).cfn,
        tagging: deniedTagging(
          Object.assign(new Error('denied'), { $metadata: { httpStatusCode: 403 } }),
        ),
      },
      fastOpts(t),
    );
    expect(r).toMatchObject({ status: 'leaked', taggingCheck: 'not-permitted' });
  });

  it('a tagging failure that is not a refusal stays an error', async () => {
    const t = { now: 0 };
    const r = await verifyCleanup(
      {
        cfn: fakes({ stacks: [[]], resources: [[]] }).cfn,
        tagging: deniedTagging(
          Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' }),
        ),
      },
      fastOpts(t),
    );
    expect(r.status).toBe('error');
  });

  it('a listed KMS key whose state cannot be read is unverifiable (exit 6), never clean', async () => {
    const t = { now: 0 };
    const key = 'arn:aws:kms:ap-southeast-1:111122223333:key/dddd-4444';
    const deps = fakes({ stacks: [[]], resources: [[key]] });
    const kms: KmsLike = {
      send: async () => {
        throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
      },
    };
    const r = await verifyCleanup({ ...deps, kms }, fastOpts(t));
    expect(r).toMatchObject({
      status: 'unverifiable',
      residualResources: [],
      unverifiableResources: [key],
    });
    expect(r.message).toMatch(/NOT verified/);
    expect(exitCodeFor(r.status)).toBe(6);
    // It kept polling until the deadline (a throttle could have cleared).
    expect(t.now).toBeGreaterThanOrEqual(60_000);
  });

  it('the normal path reports taggingCheck=done', async () => {
    const t = { now: 0 };
    const r = await verifyCleanup(fakes({ stacks: [[]], resources: [[]] }), fastOpts(t));
    expect(r).toMatchObject({ status: 'clean', taggingCheck: 'done' });
  });
});

describe('deleteRemainingStacks', () => {
  it('deletes unprotected run stacks only', async () => {
    const { deleteRemainingStacks } = await import('./cleanup-verify.js');
    const { DeleteStackCommand: Del } = await import('@aws-sdk/client-cloudformation');
    const deleted: string[] = [];
    const stacks: Stack[] = [
      { ...runStack('a', 'r1', 'CREATE_COMPLETE'), StackId: 'id-a' },
      {
        ...runStack('b', 'r1', 'UPDATE_ROLLBACK_COMPLETE'),
        StackId: 'id-b',
        EnableTerminationProtection: true,
      },
      { ...runStack('c', 'r2', 'CREATE_COMPLETE'), StackId: 'id-c' },
    ];
    const cfn: CloudFormationLike = {
      async send(cmd) {
        if (cmd instanceof Del) {
          deleted.push(cmd.input.StackName ?? '');
          return { $metadata: {} };
        }
        return { $metadata: {}, Stacks: stacks };
      },
    };
    const r = await deleteRemainingStacks(cfn, 'r1');
    expect(deleted).toEqual(['id-a']);
    expect(r).toEqual({ requested: ['a'], skipped: ['b'] });
  });

  const arn = (account: string, name: string) =>
    `arn:aws:cloudformation:ap-southeast-1:${account}:stack/${name}/1`;
  const recorder = (stacks: Stack[]) => {
    const deleted: string[] = [];
    const cfn: CloudFormationLike = {
      async send(cmd) {
        if (!(cmd instanceof DescribeStacksCommand)) {
          deleted.push(String((cmd as DeleteStackCommand).input.StackName));
          return { $metadata: {} };
        }
        return { $metadata: {}, Stacks: stacks };
      },
    };
    return { cfn, deleted };
  };

  it('with an expected account: deletes when every run stack is in that account', async () => {
    const { deleteRemainingStacks } = await import('./cleanup-verify.js');
    const { cfn, deleted } = recorder([
      { ...runStack('a', 'r1', 'CREATE_COMPLETE'), StackId: arn('111122223333', 'a') },
    ]);
    await deleteRemainingStacks(cfn, 'r1', '111122223333');
    expect(deleted).toEqual([arn('111122223333', 'a')]);
  });

  it('with an expected account: refuses (deletes nothing) when a run stack is elsewhere', async () => {
    const { AccountMismatchError, deleteRemainingStacks } = await import('./cleanup-verify.js');
    const { cfn, deleted } = recorder([
      { ...runStack('a', 'r1', 'CREATE_COMPLETE'), StackId: arn('111122223333', 'a') },
      { ...runStack('b', 'r1', 'CREATE_COMPLETE'), StackId: arn('999988887777', 'b') },
    ]);
    const err = await deleteRemainingStacks(cfn, 'r1', '111122223333').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AccountMismatchError);
    expect(String(err)).toContain('********3333');
    expect(String(err)).not.toContain('999988887777');
    expect(deleted).toEqual([]);
  });

  it('with an expected account: a stack without an ARN is not assumed to be in it', async () => {
    const { AccountMismatchError, deleteRemainingStacks } = await import('./cleanup-verify.js');
    const { cfn, deleted } = recorder([
      { ...runStack('a', 'r1', 'CREATE_COMPLETE'), StackId: 'id-a' },
    ]);
    await expect(deleteRemainingStacks(cfn, 'r1', '111122223333')).rejects.toBeInstanceOf(
      AccountMismatchError,
    );
    expect(deleted).toEqual([]);
  });
});

describe('accountOfStackArn', () => {
  it('extracts the account of a stack ARN in any partition, nothing else', async () => {
    const { accountOfStackArn } = await import('./cleanup-verify.js');
    expect(accountOfStackArn('arn:aws:cloudformation:ap-southeast-1:123456789012:stack/x/1')).toBe(
      '123456789012',
    );
    expect(
      accountOfStackArn('arn:aws-us-gov:cloudformation:us-gov-west-1:123456789012:stack/x/1'),
    ).toBe('123456789012');
    expect(accountOfStackArn('arn:aws:s3:::123456789012')).toBeUndefined();
    expect(accountOfStackArn(undefined)).toBeUndefined();
  });
});

describe('classifyResidual', () => {
  it('treats KMS keys in PendingDeletion as expected, everything else as residual', async () => {
    const pending = 'arn:aws:kms:ap-southeast-1:111122223333:key/aaaa-1111';
    const enabled = 'arn:aws:kms:ap-southeast-1:111122223333:key/bbbb-2222';
    const gone = 'arn:aws:kms:ap-southeast-1:111122223333:key/cccc-3333';
    const denied = 'arn:aws:kms:ap-southeast-1:111122223333:key/dddd-4444';
    const table = 'arn:aws:dynamodb:ap-southeast-1:111122223333:table/starter-it-r1-job-state';
    const kms: KmsLike = {
      async send(cmd: DescribeKeyCommand): Promise<DescribeKeyCommandOutput> {
        const id = cmd.input.KeyId;
        if (id === gone) throw Object.assign(new Error('not found'), { name: 'NotFoundException' });
        if (id === denied) {
          throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
        }
        return {
          $metadata: {},
          KeyMetadata: { KeyId: id, KeyState: id === pending ? 'PendingDeletion' : 'Enabled' },
        };
      },
    };
    const r = await classifyResidual(kms, [pending, enabled, gone, denied, table]);
    expect(r.pendingDeletion).toEqual([pending]);
    expect(r.residual).toEqual([enabled, table]);
    expect(r.unverifiable).toEqual([denied]);
    // without a KMS client nothing can be excused
    expect((await classifyResidual(undefined, [pending])).residual).toEqual([pending]);
  });
});

describe('exit codes', () => {
  it('only a verified clean exits 0; every other verdict has its own documented non-zero code', () => {
    const statuses: CleanupStatus[] = [
      'clean',
      'leaked',
      'error',
      'stacks-clean',
      'clean-with-residual-resources',
      'unverifiable',
    ];
    expect(Object.keys(CLEANUP_EXIT_CODES).sort()).toEqual([...statuses].sort());
    expect(statuses.map(exitCodeFor)).toEqual([0, 1, 2, 3, 4, 6]);
    expect(new Set(statuses.map(exitCodeFor)).size).toBe(statuses.length);
    // 5 is cleanup.sh's finops "settled by fallbacks"; cleanup-verify never uses it.
    expect(statuses.map(exitCodeFor)).not.toContain(5);
  });
});
