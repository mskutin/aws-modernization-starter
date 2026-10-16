/**
 * Emission lifecycle of the audit event (audit.ts), independent of Fastify's hook
 * order: exactly one event per request, `aborted` only when the response closed before it
 * finished. The HTTP-level behaviour (real sockets) is covered in auth.test.ts.
 */
import { EventEmitter } from 'node:events';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { auditReplySending, emitAudit, openAudit, recordAudit } from '../../src/auth/audit.js';

const JOB_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

function exchange(status = 202) {
  const lines: { audit: { outcome: string; status: number; jobIds?: string[] } }[] = [];
  const raw = new EventEmitter();
  const request = {
    id: 'req-1',
    method: 'POST',
    routeOptions: { url: '/v1/jobs' },
    principal: null,
    audit: null,
    log: { info: (line: (typeof lines)[number]) => lines.push(line) },
  } as unknown as FastifyRequest;
  const reply = { raw, statusCode: status } as unknown as FastifyReply;
  openAudit(request, reply);
  const outcomes = () => lines.map((l) => l.audit.outcome);
  return { request, reply, raw, lines, outcomes };
}

describe('audit emission lifecycle', () => {
  it('a finished response is never reported as aborted, even if `close` precedes onResponse', () => {
    const x = exchange();
    auditReplySending(x.request, x.reply); // onSend
    x.raw.emit('finish');
    x.raw.emit('close'); // e.g. an earlier async onResponse hook delayed ours
    emitAudit(x.request, x.reply); // onResponse
    expect(x.outcomes()).toEqual(['success']);
  });

  it('close before the handler settled: one `aborted` event from onSend, with the job ids', () => {
    const x = exchange();
    x.raw.emit('close');
    expect(x.lines).toHaveLength(0); // the outcome is not known yet
    recordAudit(x.request, { jobIds: [JOB_ID] });
    auditReplySending(x.request, x.reply);
    expect(x.lines).toEqual([
      { audit: expect.objectContaining({ outcome: 'aborted', status: 202, jobIds: [JOB_ID] }) },
    ]);
  });

  it('close while the reply is being sent: emitted at close, never twice', () => {
    const x = exchange();
    auditReplySending(x.request, x.reply);
    x.raw.emit('close');
    expect(x.outcomes()).toEqual(['aborted']);
    emitAudit(x.request, x.reply); // e.g. onResponse after a response `error`
    expect(x.outcomes()).toEqual(['aborted']);
  });
});
