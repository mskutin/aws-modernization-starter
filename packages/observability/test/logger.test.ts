import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  REDACTED,
  WORKFLOW_REDACT_PATHS,
  childWithRedaction,
  createLogger,
  isSafeId,
  lambdaCorrelation,
  requestIdFrom,
  withCorrelation,
} from '../src/index.js';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      }
      cb();
    },
  });
  return { lines, stream };
}

describe('createLogger', () => {
  it('emits JSON with service, version, env, level label and ISO time', () => {
    const { lines, stream } = capture();
    const logger = createLogger({
      service: 'api',
      version: '1.2.3',
      environment: 'test',
      destination: stream,
    });
    logger.info({ jobId: 'j1' }, 'hello');
    expect(lines[0]).toMatchObject({
      level: 'info',
      service: 'api',
      version: '1.2.3',
      env: 'test',
      jobId: 'j1',
      msg: 'hello',
    });
    expect(String(lines[0]?.time)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('redacts secrets, auth headers and document content', () => {
    const { lines, stream } = capture();
    const logger = createLogger({ service: 'api', destination: stream });
    logger.info(
      {
        password: 'p@ss',
        db: { password: 'p2', host: 'db.local' },
        req: { headers: { authorization: 'Bearer abc', cookie: 'sid=1', accept: '*/*' } },
        payload: { content: 'personal data', title: 'ok' },
        content: 'raw document',
        DB_PASSWORD: 'x',
      },
      'redaction',
    );
    const line = lines[0]!;
    const serialized = JSON.stringify(line);
    for (const secret of ['p@ss', 'p2', 'Bearer abc', 'sid=1', 'personal data', 'raw document']) {
      expect(serialized).not.toContain(secret);
    }
    expect(line).toMatchObject({
      password: REDACTED,
      db: { host: 'db.local', password: REDACTED },
      req: { headers: { accept: '*/*', authorization: REDACTED } },
      payload: { title: REDACTED, content: REDACTED },
    });
  });

  it('redacts document titles at any common nesting', () => {
    const { lines, stream } = capture();
    const logger = createLogger({ service: 'api', destination: stream });
    logger.info(
      { title: 'Canary title A', job: { title: 'Canary title B' }, document: { x: 'Canary C' } },
      'titles',
    );
    expect(JSON.stringify(lines)).not.toMatch(/Canary/);
  });

  it('redacts PostgreSQL error detail and an attached client; a cause adds its message only', () => {
    const { lines, stream } = capture();
    const logger = createLogger({ service: 'api', destination: stream });
    const pgError = Object.assign(new Error('new row for relation "jobs" violates check'), {
      code: '23514',
      detail: 'Failing row contains (Canary row, Canary content).',
      client: { user: 'starter_app', processID: 4242, secretKey: 'Canary cancel key' },
    });
    logger.error({ err: pgError }, 'unhandled error');
    logger.error({ err: new Error('dependency unavailable', { cause: pgError }) }, 'wrapped');
    expect(JSON.stringify(lines)).not.toMatch(/Canary|processID|secretKey/);
    expect(lines[0]).toMatchObject({ err: { code: '23514', detail: REDACTED, client: REDACTED } });
    expect(lines[1]).toMatchObject({
      err: { message: 'dependency unavailable: new row for relation "jobs" violates check' },
    });
  });

  it('adds workflow paths without dropping the defaults in a redacting child', () => {
    const { lines, stream } = capture();
    const logger = createLogger({ service: 'wf', destination: stream });
    const child = childWithRedaction(logger, { workflow: 'job-processing' }, WORKFLOW_REDACT_PATHS);
    child.info(
      {
        content: 'Canary content',
        title: 'Canary title',
        resultJson: '{"topTerms":["canary"]}',
        result: { topTerms: ['canary'] },
        payload: { anything: 'Canary payload' },
        jobId: 'j1',
      },
      'step',
    );
    expect(JSON.stringify(lines)).not.toMatch(/[Cc]anary/);
    expect(lines[0]).toMatchObject({ jobId: 'j1', workflow: 'job-processing' });
  });

  it('honours the level and extra redact paths', () => {
    const { lines, stream } = capture();
    const logger = createLogger({
      service: 's',
      level: 'warn',
      redact: ['custom.field'],
      destination: stream,
    });
    logger.info('dropped');
    logger.warn({ custom: { field: 'hide' } }, 'kept');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ msg: 'kept', custom: { field: REDACTED } });
  });

  it('binds correlation fields on child loggers', () => {
    const { lines, stream } = capture();
    const logger = withCorrelation(createLogger({ service: 's', destination: stream }), {
      requestId: 'r-1',
      jobId: 'j-1',
    });
    logger.info('child');
    expect(lines[0]).toMatchObject({ requestId: 'r-1', jobId: 'j-1' });
  });
});

describe('correlation ids', () => {
  it('reuses a well-formed incoming X-Request-Id', () => {
    expect(requestIdFrom({ 'x-request-id': 'abc-123' })).toBe('abc-123');
    expect(requestIdFrom({ 'x-request-id': ['first-id', 'second'] })).toBe('first-id');
  });

  it.each(['', 'has space', 'line\nbreak', 'x'.repeat(129), '<script>'])(
    'replaces unsafe id %j with a UUID',
    (value) => {
      const id = requestIdFrom({ 'x-request-id': value });
      expect(id).not.toBe(value);
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
    },
  );

  it('generates an id when the header is absent', () => {
    expect(isSafeId(requestIdFrom({}))).toBe(true);
  });

  it('builds Lambda correlation fields and drops unsafe job ids', () => {
    const context = { awsRequestId: 'aws-1', functionName: 'fn', functionVersion: '$LATEST' };
    expect(lambdaCorrelation(context, { jobId: 'job-1' })).toEqual({
      requestId: 'aws-1',
      functionName: 'fn',
      functionVersion: '$LATEST',
      jobId: 'job-1',
    });
    expect(lambdaCorrelation(context, { jobId: 'bad id\n' })).not.toHaveProperty('jobId');
  });
});
