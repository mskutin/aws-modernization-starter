import { describe, expect, it } from 'vitest';
import { InMemoryJobStateStore } from '../src/index.js';
import { describeJobStateStoreContract } from './store-contract.js';

describeJobStateStoreContract('in-memory', async () => ({ store: new InMemoryJobStateStore() }));

describe('InMemoryJobStateStore test hooks', () => {
  it('injects failures and counts calls', async () => {
    const store = new InMemoryJobStateStore();
    store.failNext('get', new Error('boom'), 2);
    await expect(store.get('x')).rejects.toThrow('boom');
    await expect(store.get('x')).rejects.toThrow('boom');
    await expect(store.get('x')).resolves.toBeNull();
    expect(store.calls.get('get')).toBe(3);
  });

  it('returns copies so callers cannot mutate stored state', async () => {
    const store = new InMemoryJobStateStore();
    const { state } = await store.createInitial('j', '2026-10-13T10:00:00.000Z');
    state.status = 'SUCCEEDED';
    expect((await store.get('j'))?.status).toBe('PENDING');
  });
});

describe('STEP# audit retention (JOB_AUDIT_TTL_DAYS)', () => {
  const step = {
    jobId: 'j',
    state: 'ValidateJob' as const,
    at: '2026-10-13T10:00:00.000Z',
    outcome: 'succeeded' as const,
  };

  it('is disabled by default: audit items get no TTL attribute', async () => {
    const store = new InMemoryJobStateStore();
    await store.appendStep(step);
    const [item] = store.items().filter((i) => String(i.sk).startsWith('STEP#'));
    expect(item).toBeDefined();
    expect(item).not.toHaveProperty('expiresAt');
  });

  it('sets expiresAt = step time + N days when configured', async () => {
    const store = new InMemoryJobStateStore({ auditTtlDays: 30 });
    await store.appendStep(step);
    const [item] = store.items().filter((i) => String(i.sk).startsWith('STEP#'));
    expect(item?.expiresAt).toBe(Date.parse(step.at) / 1000 + 30 * 86_400);
    // The audit read model is unchanged.
    expect(await store.listSteps('j')).toEqual([step]);
  });

  it.each([0, -1, 1.5, 3651])('rejects auditTtlDays=%s', (days) => {
    expect(() => new InMemoryJobStateStore({ auditTtlDays: days })).toThrow(RangeError);
  });
});
