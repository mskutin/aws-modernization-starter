import { describe, expect, it } from 'vitest';
import { auditLinesIn, PSEUDONYM, requestIdFor } from '../audit-log.js';

const line = (record: Record<string, unknown>) => JSON.stringify(record);
const event = (requestId: string, extra: Record<string, unknown> = {}) => ({
  event: 'job.read',
  outcome: 'success',
  status: 200,
  requestId,
  ...extra,
});

describe('audit log reader', () => {
  it('returns only audit events of the given request id', () => {
    const text = [
      line({ msg: 'audit', requestId: 'r-1', audit: event('r-1', { principal: 'ab12' }) }),
      line({ msg: 'audit', requestId: 'r-2', audit: event('r-2') }),
      // Mentions r-1 but is not an audit event.
      line({ msg: 'request completed', requestId: 'r-1' }),
      // An audit line whose own request id differs (e.g. r-10 contains r-1).
      line({ msg: 'audit', requestId: 'r-10', audit: event('r-10') }),
      'not json r-1',
      '',
    ].join('\n');
    const found = auditLinesIn(text, 'r-1');
    expect(found.map((l) => l.audit)).toEqual([event('r-1', { principal: 'ab12' })]);
    expect(found[0]?.line).toContain('"principal":"ab12"');
  });

  it('ignores malformed audit objects', () => {
    const text = [
      line({ msg: 'audit', audit: { event: 'job.read', requestId: 'r-1' } }),
      line({ msg: 'audit', audit: 'r-1' }),
      line({ msg: 'audit', audit: event('r-1', { status: '200' }) }),
    ].join('\n');
    expect(auditLinesIn(text, 'r-1')).toEqual([]);
  });

  it('request ids are unique and acceptable to the API', () => {
    const a = requestIdFor('0a1b2c3d', 'create');
    expect(a).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
    expect(a).not.toBe(requestIdFor('0a1b2c3d', 'create'));
  });

  it('the pseudonym pattern is 16 lower-case hex digits', () => {
    expect('0123456789abcdef').toMatch(PSEUDONYM);
    expect('sectest-owner').not.toMatch(PSEUDONYM);
  });
});
