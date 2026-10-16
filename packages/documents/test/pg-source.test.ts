import { randomUUID } from 'node:crypto';
import { sha256Hex, TransientDependencyError } from '@starter/domain';
import { WorkflowError } from '@starter/workflow-processing';
import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_QUERY,
  DocumentSourceError,
  DocumentUnavailableError,
  PgDocumentSource,
  type SqlClient,
} from '../src/index.js';

const CONTENT = 'Canary 4815162342 document body';

/** Records every statement; answers from a queue of row sets or errors. */
class FakeSql implements SqlClient {
  readonly statements: { text: string; values: unknown[] | undefined }[] = [];
  readonly answers: ({ rows: unknown[] } | Error)[] = [];

  async query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> {
    this.statements.push({ text, values });
    const next = this.answers.shift() ?? { rows: [] };
    if (next instanceof Error) throw next;
    return next;
  }
}

const row = (overrides: Record<string, unknown> = {}) => ({
  title: 'Title',
  content: CONTENT,
  options: { topTerms: 5 },
  content_sha256: sha256Hex(CONTENT),
  contract_version: '1.0.0',
  content_purged_at: null,
  ...overrides,
});

const pgError = (code: string, message: string) => Object.assign(new Error(message), { code });

async function failure(sql: FakeSql, jobId: string = randomUUID()): Promise<Error> {
  return (await new PgDocumentSource(sql).load(jobId).catch((e: unknown) => e)) as Error;
}

describe('PgDocumentSource — only the SECURITY DEFINER function', () => {
  it('sends exactly one parameterised call of load_job_document and never touches the table', async () => {
    const sql = new FakeSql();
    sql.answers.push({ rows: [row()] });
    const jobId = randomUUID();
    await expect(new PgDocumentSource(sql).load(jobId)).resolves.toMatchObject({
      jobId,
      title: 'Title',
      content: CONTENT,
      options: { topTerms: 5 },
    });
    expect(sql.statements).toEqual([
      { text: 'SELECT * FROM load_job_document($1)', values: [jobId] },
    ]);
    expect(DOCUMENT_QUERY).not.toMatch(/\bjobs\b/);
  });

  it('accepts a function result without the purge-marker column (before migration 0005)', async () => {
    const sql = new FakeSql();
    const { content_purged_at: _omitted, ...withoutMarker } = row();
    sql.answers.push({ rows: [withoutMarker] });
    await expect(new PgDocumentSource(sql).load(randomUUID())).resolves.toMatchObject({
      content: CONTENT,
    });
  });

  it('never queries for an id that is not a UUID', async () => {
    const sql = new FakeSql();
    const error = await failure(sql, "x' OR '1'='1");
    expect(error).toBeInstanceOf(DocumentUnavailableError);
    expect(sql.statements).toHaveLength(0);
  });

  it('treats "no row" (missing, purged or outside the window) as a permanent no-document failure', async () => {
    const sql = new FakeSql();
    sql.answers.push({ rows: [] });
    const error = await failure(sql);
    expect(error).toBeInstanceOf(DocumentUnavailableError);
    expect(error.name).toBe(WorkflowError.DocumentUnavailable);
    expect((error as DocumentUnavailableError).reason).toBe('no-document');
  });

  it('refuses more than one row (the function contract returns at most one)', async () => {
    const sql = new FakeSql();
    sql.answers.push({ rows: [row(), row()] });
    const error = await failure(sql);
    expect(error).toBeInstanceOf(DocumentSourceError);
    expect((error as DocumentSourceError).code).toBe('MULTIPLE_ROWS');
  });

  it.each([
    ['a purge marker', row({ content_purged_at: new Date() }), 'purged'],
    ['NULL content', row({ content: null }), 'purged'],
    ['NULL title', row({ title: null }), 'purged'],
    ['content not matching its hash', row({ content: `${CONTENT}!` }), 'integrity'],
  ])('treats %s as unavailable', async (_name, stored, reason) => {
    const sql = new FakeSql();
    sql.answers.push({ rows: [stored] });
    const error = await failure(sql);
    expect(error).toBeInstanceOf(DocumentUnavailableError);
    expect((error as DocumentUnavailableError).reason).toBe(reason);
    expect(error.message).not.toContain(CONTENT);
  });

  it('rejects a malformed row naming fields only', async () => {
    const sql = new FakeSql();
    sql.answers.push({ rows: [row({ options: { topTerms: 'lots', secret: CONTENT } })] });
    const error = await failure(sql);
    expect(error).toBeInstanceOf(DocumentSourceError);
    expect(error.message).toMatch(/is malformed \(options/);
    expect(error.message).not.toContain(CONTENT);
  });
});

describe('PgDocumentSource — failure classification (retry semantics)', () => {
  it.each([
    [
      'connection refused',
      Object.assign(new Error('connect ECONNREFUSED 10.1.2.3:5432'), { code: 'ECONNREFUSED' }),
    ],
    ['connection failure (08006)', pgError('08006', 'connection failure')],
    ['admin shutdown during failover (57P01)', pgError('57P01', 'terminating connection')],
    ['too many connections (53300)', pgError('53300', 'sorry, too many clients already')],
    ['pool connect timeout', new Error('timeout exceeded when trying to connect')],
    ['dropped connection', new Error('Connection terminated unexpectedly')],
    [
      'IAM token throttling',
      Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' }),
    ],
  ])('%s → TransientDependencyError (retried by the spec)', async (_name, cause) => {
    const sql = new FakeSql();
    sql.answers.push(cause);
    const jobId = randomUUID();
    const error = await failure(sql, jobId);
    expect(error).toBeInstanceOf(TransientDependencyError);
    expect(error.name).toBe(WorkflowError.Transient);
    expect(error.message).toMatch(
      new RegExp(`^document source temporarily unavailable for job ${jobId} \\(`),
    );
    expect(error.message).not.toContain('10.1.2.3');
  });

  it.each([
    [
      'statement timeout (57014: permanent per the @starter/db classifier)',
      pgError('57014', 'canceling statement due to statement timeout'),
      '57014',
    ],
    [
      'no EXECUTE on the function (42501)',
      pgError('42501', 'permission denied for function'),
      '42501',
    ],
    [
      'function missing (42883)',
      pgError('42883', 'function load_job_document(unknown) does not exist'),
      '42883',
    ],
    [
      'authentication failed (28P01)',
      pgError('28P01', 'password authentication failed for user "starter_processor"'),
      '28P01',
    ],
    [
      'TLS hostname mismatch',
      Object.assign(new Error("Hostname/IP does not match certificate's altnames: Host: db"), {
        code: 'ERR_TLS_CERT_ALTNAME_INVALID',
      }),
      'ERR_TLS_CERT_ALTNAME_INVALID',
    ],
    [
      'self-signed certificate',
      Object.assign(new Error('self-signed certificate in certificate chain'), {
        code: 'SELF_SIGNED_CERT_IN_CHAIN',
      }),
      'SELF_SIGNED_CERT_IN_CHAIN',
    ],
  ])(
    '%s → DocumentSourceError (not retried; message carries the code only)',
    async (_n, cause, code) => {
      const sql = new FakeSql();
      sql.answers.push(cause);
      const jobId = randomUUID();
      const error = await failure(sql, jobId);
      expect(error).toBeInstanceOf(DocumentSourceError);
      expect(error.message).toBe(`document source failed for job ${jobId} (${code})`);
    },
  );
});
