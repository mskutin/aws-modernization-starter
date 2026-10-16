import { describe, expect, it } from 'vitest';
import {
  DeleteStackCommand,
  DescribeStacksCommand,
  type DeleteStackCommandOutput,
  type DescribeStacksCommandOutput,
  type Stack,
  type StackStatus,
} from '@aws-sdk/client-cloudformation';
import {
  classify,
  parseCliArgs,
  sweep,
  type CloudFormationLike,
  type SweepOptions,
} from './sweeper.js';

const NOW = new Date('2026-10-13T12:00:00.000Z');
const HOUR = 3_600_000;

function stack(
  name: string,
  opts: {
    ephemeral?: string | null;
    expiresAt?: string | null;
    status?: StackStatus;
    createdHoursAgo?: number;
    protection?: boolean;
    runId?: string;
  } = {},
): Stack {
  const tags = [
    ...(opts.ephemeral === null
      ? []
      : [{ Key: 'starter:ephemeral', Value: opts.ephemeral ?? 'true' }]),
    ...(opts.expiresAt === null || opts.expiresAt === undefined
      ? []
      : [{ Key: 'starter:expires-at', Value: opts.expiresAt }]),
    ...(opts.runId ? [{ Key: 'starter:run-id', Value: opts.runId }] : []),
  ];
  return {
    StackName: name,
    StackId: `arn:aws:cloudformation:ap-southeast-1:111122223333:stack/${name}/uuid-${name}`,
    StackStatus: opts.status ?? 'CREATE_COMPLETE',
    CreationTime: new Date(NOW.getTime() - (opts.createdHoursAgo ?? 3) * HOUR),
    EnableTerminationProtection: opts.protection ?? false,
    Tags: tags,
  };
}

const past = new Date(NOW.getTime() - HOUR).toISOString();
const future = new Date(NOW.getTime() + HOUR).toISOString();

/**
 * Mocked CloudFormation client: in-memory stacks, paginated DescribeStacks, DeleteStack that
 * transitions DELETE_IN_PROGRESS -> DELETE_COMPLETE after `deletePolls` describes.
 */
class FakeCloudFormation implements CloudFormationLike {
  readonly deleted: string[] = [];
  readonly calls: string[] = [];
  private readonly polls = new Map<string, number>();

  constructor(
    private readonly stacks: Stack[],
    private readonly behaviour: {
      pageSize?: number;
      failDeleteFor?: string[];
      deletePolls?: number;
      endInDeleteFailed?: string[];
    } = {},
  ) {}

  async send(
    command: DescribeStacksCommand | DeleteStackCommand,
  ): Promise<DescribeStacksCommandOutput | DeleteStackCommandOutput> {
    const $metadata = {};
    if (command instanceof DeleteStackCommand) {
      const id = command.input.StackName ?? '';
      this.calls.push(`DeleteStack:${id}`);
      if (this.behaviour.failDeleteFor?.some((n) => id.includes(`/${n}/`))) {
        const err = new Error('User is not authorized to perform cloudformation:DeleteStack');
        err.name = 'AccessDenied';
        throw err;
      }
      this.deleted.push(id);
      const s = this.stacks.find((x) => x.StackId === id);
      if (s) s.StackStatus = 'DELETE_IN_PROGRESS';
      return { $metadata };
    }
    if (command instanceof DescribeStacksCommand) {
      const { StackName, NextToken } = command.input;
      if (StackName) {
        this.calls.push(`DescribeStacks:${StackName}`);
        const s = this.stacks.find((x) => x.StackId === StackName);
        if (!s) throw new Error(`Stack with id ${StackName} does not exist`);
        const n = (this.polls.get(StackName) ?? 0) + 1;
        this.polls.set(StackName, n);
        if (s.StackStatus === 'DELETE_IN_PROGRESS' && n >= (this.behaviour.deletePolls ?? 1)) {
          s.StackStatus = this.behaviour.endInDeleteFailed?.includes(s.StackName ?? '')
            ? 'DELETE_FAILED'
            : 'DELETE_COMPLETE';
        }
        return { $metadata, Stacks: [{ ...s }] };
      }
      this.calls.push(`DescribeStacks:page:${NextToken ?? 0}`);
      const size = this.behaviour.pageSize ?? 100;
      const start = Number(NextToken ?? 0);
      const live = this.stacks.filter((s) => s.StackStatus !== 'DELETE_COMPLETE');
      const page = live.slice(start, start + size).map((s) => ({ ...s }));
      const next = start + size < live.length ? String(start + size) : undefined;
      return { $metadata, Stacks: page, NextToken: next };
    }
    throw new Error('unexpected command');
  }
}

const baseOpts: SweepOptions = {
  apply: false,
  now: NOW,
  maxAgeHours: 24,
  waitSeconds: 0,
  sleep: async () => {},
};

describe('classify', () => {
  it('ignores stacks without starter:ephemeral=true (exact match)', () => {
    expect(classify(stack('prod', { ephemeral: null, expiresAt: past }), baseOpts)).toBeNull();
    expect(classify(stack('x', { ephemeral: 'TRUE', expiresAt: past }), baseOpts)).toBeNull();
    expect(classify(stack('x', { ephemeral: 'false', expiresAt: past }), baseOpts)).toBeNull();
  });

  it('keeps not-yet-expired stacks and deletes expired ones', () => {
    expect(classify(stack('a', { expiresAt: future }), baseOpts)?.decision).toBe('keep');
    expect(classify(stack('b', { expiresAt: past }), baseOpts)?.decision).toBe('delete');
    // boundary: expiry exactly now counts as expired
    expect(classify(stack('c', { expiresAt: NOW.toISOString() }), baseOpts)?.decision).toBe(
      'delete',
    );
  });

  it('falls back to max age when expires-at is missing or invalid', () => {
    expect(classify(stack('young', { createdHoursAgo: 2 }), baseOpts)?.decision).toBe('keep');
    expect(classify(stack('old', { createdHoursAgo: 30 }), baseOpts)?.decision).toBe('delete');
    const bad = classify(stack('bad', { expiresAt: 'tomorrow', createdHoursAgo: 30 }), baseOpts);
    expect(bad?.decision).toBe('delete');
    expect(bad?.reason).toMatch(/invalid/);
  });

  it('does not touch stacks mid-operation and blocks termination-protected stacks', () => {
    for (const status of ['CREATE_IN_PROGRESS', 'UPDATE_IN_PROGRESS', 'DELETE_IN_PROGRESS']) {
      const v = classify(
        stack('busy', { expiresAt: past, status: status as StackStatus }),
        baseOpts,
      );
      expect(v?.decision).toBe('keep');
    }
    expect(classify(stack('prot', { expiresAt: past, protection: true }), baseOpts)?.decision).toBe(
      'blocked',
    );
  });

  it('retries expired DELETE_FAILED stacks', () => {
    const v = classify(stack('df', { expiresAt: past, status: 'DELETE_FAILED' }), baseOpts);
    expect(v?.decision).toBe('delete');
    expect(v?.reason).toMatch(/retrying failed delete/);
  });

  it('honours the optional name prefix', () => {
    const opts = { ...baseOpts, namePrefix: 'starter-it-' };
    expect(classify(stack('other-stack', { expiresAt: past }), opts)).toBeNull();
    expect(classify(stack('starter-it-123', { expiresAt: past }), opts)?.decision).toBe('delete');
  });
});

describe('sweep', () => {
  const fleet = () => [
    stack('starter-it-expired', { expiresAt: past, runId: 'r1' }),
    stack('starter-it-fresh', { expiresAt: future }),
    stack('starter-prod-network', { ephemeral: null }),
    stack('starter-it-protected', { expiresAt: past, protection: true }),
    stack('starter-it-creating', { expiresAt: past, status: 'CREATE_IN_PROGRESS' }),
    stack('starter-it-no-expiry-old', { createdHoursAgo: 48 }),
  ];

  it('is a dry run by default: reports but deletes nothing', async () => {
    const cfn = new FakeCloudFormation(fleet());
    const report = await sweep(cfn, baseOpts);
    expect(cfn.deleted).toEqual([]);
    expect(cfn.calls.some((c) => c.startsWith('DeleteStack'))).toBe(false);
    expect(report.mode).toBe('dry-run');
    expect(report.scanned).toBe(6);
    expect(report.ephemeral).toBe(5);
    expect(report.summary['would-delete']).toBe(2);
    expect(report.summary.blocked).toBe(1);
    expect(report.summary.kept).toBe(2);
    expect(report.ok).toBe(true);
    expect(report.findings.find((f) => f.stackName === 'starter-it-expired')?.runId).toBe('r1');
    expect(report.findings.some((f) => f.stackName === 'starter-prod-network')).toBe(false);
  });

  it('with --apply deletes only expired, unprotected, idle ephemeral stacks', async () => {
    const cfn = new FakeCloudFormation(fleet());
    const report = await sweep(cfn, { ...baseOpts, apply: true });
    expect(cfn.deleted.map((id) => id.split('/')[1]).sort()).toEqual([
      'starter-it-expired',
      'starter-it-no-expiry-old',
    ]);
    expect(report.summary['delete-requested']).toBe(2);
    expect(report.ok).toBe(true);
  });

  it('follows DescribeStacks pagination', async () => {
    const many = Array.from({ length: 7 }, (_, i) => stack(`starter-it-${i}`, { expiresAt: past }));
    const cfn = new FakeCloudFormation(many, { pageSize: 3 });
    const report = await sweep(cfn, baseOpts);
    expect(report.scanned).toBe(7);
    expect(cfn.calls.filter((c) => c.startsWith('DescribeStacks:page')).length).toBe(3);
  });

  it('reports delete failures and marks the run not ok', async () => {
    const cfn = new FakeCloudFormation(fleet(), { failDeleteFor: ['starter-it-expired'] });
    const report = await sweep(cfn, { ...baseOpts, apply: true });
    const f = report.findings.find((x) => x.stackName === 'starter-it-expired');
    expect(f?.outcome).toBe('delete-failed');
    expect(f?.error).toMatch(/AccessDenied/);
    expect(report.ok).toBe(false);
    // the other expired stack is still processed
    expect(cfn.deleted).toHaveLength(1);
  });

  it('waits for DELETE_COMPLETE when --wait-seconds > 0 (deterministic fake clock)', async () => {
    let t = 0;
    const cfn = new FakeCloudFormation([stack('starter-it-a', { expiresAt: past })], {
      deletePolls: 3,
    });
    const report = await sweep(cfn, {
      ...baseOpts,
      apply: true,
      waitSeconds: 600,
      pollIntervalMs: 15_000,
      clock: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    });
    expect(report.findings[0]?.outcome).toBe('deleted');
    expect(t).toBe(30_000); // two sleeps between three polls
  });

  it('reports DELETE_FAILED after waiting and times out at the deadline', async () => {
    const failing = new FakeCloudFormation([stack('starter-it-b', { expiresAt: past })], {
      endInDeleteFailed: ['starter-it-b'],
    });
    const r1 = await sweep(failing, { ...baseOpts, apply: true, waitSeconds: 60 });
    expect(r1.findings[0]?.outcome).toBe('delete-failed');
    expect(r1.ok).toBe(false);

    let t = 0;
    const slow = new FakeCloudFormation([stack('starter-it-c', { expiresAt: past })], {
      deletePolls: 1_000,
    });
    const r2 = await sweep(slow, {
      ...baseOpts,
      apply: true,
      waitSeconds: 60,
      pollIntervalMs: 15_000,
      clock: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    });
    expect(r2.findings[0]?.outcome).toBe('wait-timeout');
    expect(r2.ok).toBe(false);
  });
});

describe('parseCliArgs', () => {
  it('defaults to dry-run with region from AWS_REGION', () => {
    const a = parseCliArgs([], { AWS_REGION: 'ap-southeast-1' });
    expect(a).toMatchObject({ apply: false, regions: ['ap-southeast-1'], maxAgeHours: 24 });
  });

  it('accepts multiple / comma-separated regions and --apply', () => {
    const a = parseCliArgs(['--apply', '--region', 'ap-southeast-1,ap-southeast-5'], {});
    expect(a.apply).toBe(true);
    expect(a.regions).toEqual(['ap-southeast-1', 'ap-southeast-5']);
  });

  it('rejects malformed regions and other partitions (one validation, @starter/config/region)', () => {
    expect(() => parseCliArgs(['--region', 'ap-southeast-1,Nowhere'], {})).toThrow(
      /Invalid --region="Nowhere"/,
    );
    expect(() => parseCliArgs([], { AWS_REGION: 'cn-north-1' })).toThrow(
      /Unsupported AWS_REGION=cn-north-1: .*aws-cn partition/,
    );
    expect(parseCliArgs(['--region', 'eu-west-1'], {}).regions).toEqual(['eu-west-1']);
  });

  it('rejects missing region, bad numbers and unknown flags', () => {
    expect(() => parseCliArgs([], {})).toThrow(/region/);
    const env = { AWS_REGION: 'ap-southeast-1' };
    expect(() => parseCliArgs(['--max-age-hours', '0'], env)).toThrow(/max-age-hours/);
    expect(() => parseCliArgs(['--wait-seconds', '-1'], env)).toThrow(/wait-seconds/);
    expect(() => parseCliArgs(['--force'], env)).toThrow();
  });
});
