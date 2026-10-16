/**
 * Document data stays where it belongs.
 *
 * Canary documents (canary.ts: title, a whole sentence and a non-term token, unique per run) are
 * submitted on every target and processed to the end. Then:
 *  - responses to the owner may show the title but never the content; responses to anyone else
 *    show nothing of the document;
 *  - the API logs (self mode, or SECTEST_LOG_FILES) contain the jobs' ids (positive control) but no
 *    canary, no bearer token and no known secret (the database password);
 *  - no DynamoDB item (job item, step records) contains a canary — derived terms may be there;
 *  - the Step Functions execution input the API sends (captured by the fake endpoint) carries no
 *    document data and, from workflow spec 2.0.0 on, exactly { jobId, contractVersion, submittedAt }.
 * The canaries are written to <evidence>/canaries.json for the artifact scanner (scanner/cli.ts).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, type ScanCommandOutput } from '@aws-sdk/lib-dynamodb';
import { beforeAll, describe, expect, it } from 'vitest';
import { canaryDocument, canaryValues, type CanaryDocument } from '../canary.js';
import { atLeast, context, type Target } from '../context.js';
import { call, describeRes, pollUntil } from '../http.js';
import { findLeaks, findLeaksInValue, type NamedValue } from '../leaks.js';
import {
  expectAccepted,
  getJob,
  listJobs,
  precondition,
  submit,
  waitTerminal,
} from '../support.js';
import { mintToken, principal } from '../tokens.js';

const ctx = context();
const SUITE = 'leak';
/** Workflow spec in which the claim check (no document data in the execution input) is implemented. */
const CLAIM_CHECK_SPEC = '2.0.0';
const claimCheck = atLeast(ctx.workflowSpecVersion, CLAIM_CHECK_SPEC);
/** JUnit drops skip notes, so a skip's reason is part of the test name (repo convention). */
const claimCheckNote = claimCheck
  ? ''
  : ` [skipped until workflow spec ${CLAIM_CHECK_SPEC}; code under test: ${ctx.workflowSpecVersion}]`;
const logsNote =
  ctx.logFiles.length > 0
    ? ''
    : ' [skipped: no API log files; run starter-leak-scan over the logs]';
const dynamoNote = ctx.stores.dynamodb ? '' : ' [skipped: no DynamoDB store configured]';
const sfnNote = ctx.stepFunctions ? '' : ' [skipped: self-started harness only]';

interface Submitted {
  target: Target;
  doc: CanaryDocument;
  jobId: string;
}

const named = (doc: CanaryDocument): NamedValue[] =>
  Object.entries(doc.canaries).map(([label, value]) => ({ label, value }));

describe('document leakage (canaries)', () => {
  const submitted: Submitted[] = [];
  const tokens: string[] = [];
  let ownerToken: string;
  let otherToken: string;

  beforeAll(async () => {
    [ownerToken, otherToken] = await Promise.all([
      mintToken(ctx.tokenEndpoint, { sub: principal(ctx.runId, SUITE, 'owner') }),
      mintToken(ctx.tokenEndpoint, { sub: principal(ctx.runId, SUITE, 'other') }),
    ]);
    tokens.push(ownerToken, otherToken);
    for (const target of ctx.targets) {
      const doc = canaryDocument(ctx.runId, `${SUITE}-${target.name}`);
      const job = expectAccepted(
        await submit(target, ownerToken, { title: doc.title, content: doc.content }),
      );
      submitted.push({ target, doc, jobId: job.jobId });
    }
    for (const s of submitted) await waitTerminal(s.target, ownerToken, s.jobId);
    writeFileSync(
      join(ctx.evidenceDir, 'canaries.json'),
      JSON.stringify(
        {
          runId: ctx.runId,
          canaries: submitted.flatMap((s) =>
            named(s.doc).map((c) => ({ label: `${s.target.name}:${c.label}`, value: c.value })),
          ),
        },
        null,
        2,
      ),
    );
  });

  const allCanaries = (): NamedValue[] =>
    submitted.flatMap((s) =>
      named(s.doc).map((c) => ({ ...c, label: `${s.target.name}:${c.label}` })),
    );
  const contentCanaries = (): NamedValue[] =>
    allCanaries().filter((c) => !c.label.endsWith(':title'));

  it('the owner sees her title but never the content; anyone else sees nothing of the document', async () => {
    for (const s of submitted) {
      const own = await getJob(s.target, ownerToken, s.jobId);
      expect(own.status, describeRes(own)).toBe(200);
      expect(
        findLeaks(own.text, { canaries: [{ label: 'title', value: s.doc.canaries.title }] }),
      ).toHaveLength(1);
      expect(findLeaks(own.text, { canaries: contentCanaries(), patterns: false })).toEqual([]);

      const foreign = await getJob(s.target, otherToken, s.jobId);
      expect(foreign.status, describeRes(foreign)).toBe(404);
      const list = await listJobs(s.target, otherToken, '?limit=100');
      for (const text of [foreign.text, list.res.text]) {
        expect(findLeaks(text, { canaries: allCanaries(), patterns: false })).toEqual([]);
      }
    }
  });

  const NO_LOGS =
    'no API log files (external mode: scan the logs with starter-leak-scan after the run)';
  /** The API logs, once they cover every canary job (positive control: logs were written). */
  const settledLogs = () =>
    pollUntil('API logs mentioning every canary job', async () => {
      const text = ctx.logFiles.map((f) => readFileSync(f, 'utf8')).join('\n');
      return submitted.every((s) => text.includes(s.jobId)) ? text : undefined;
    });

  it(`API logs: cover the jobs (positive control) but contain no content, token or secret${logsNote}`, async (t) => {
    precondition(t, ctx, ctx.logFiles.length > 0, NO_LOGS);
    const logs = await settledLogs();
    const secrets: NamedValue[] = [
      ...ctx.knownSecrets.map((value, i) => ({ label: `known-secret-${i}`, value })),
      ...tokens.map((value, i) => ({ label: `bearer-token-${i}`, value })),
      // A token's signature alone is enough to replay nothing, but must still never be logged.
      ...tokens.map((value, i) => ({
        label: `token-signature-${i}`,
        value: value.split('.')[2] ?? '',
      })),
    ];
    expect(findLeaks(logs, { secrets, canaries: contentCanaries() })).toEqual([]);
  });

  it(`API logs: titles are redacted${logsNote || claimCheckNote}`, async (t) => {
    precondition(t, ctx, ctx.logFiles.length > 0, NO_LOGS);
    precondition(
      t,
      ctx,
      claimCheck,
      `title redaction in logs arrives with workflow spec ${CLAIM_CHECK_SPEC} (code under test: ${ctx.workflowSpecVersion})`,
    );
    const titles = allCanaries().filter((c) => c.label.endsWith(':title'));
    expect(findLeaks(await settledLogs(), { canaries: titles, patterns: false })).toEqual([]);
  });

  it(`DynamoDB: no item contains document data (derived terms may)${dynamoNote}`, async (t) => {
    const store = ctx.stores.dynamodb;
    precondition(
      t,
      ctx,
      store !== undefined,
      'no DYNAMODB_ENDPOINT (or SECTEST_DYNAMODB_AWS=true) + JOBS_TABLE_NAME for the API under test',
    );
    // DynamoDB Local takes dummy keys; the real table (external mode, SECTEST_DYNAMODB_AWS=true)
    // is read with the default credential chain.
    const client = new DynamoDBClient(
      store.endpoint
        ? {
            region: store.region,
            endpoint: store.endpoint,
            credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
          }
        : { region: store.region },
    );
    const doc = DynamoDBDocumentClient.from(client);
    const items: Record<string, unknown>[] = [];
    try {
      let start: ScanCommandOutput['LastEvaluatedKey'];
      do {
        const page = await doc.send(
          new ScanCommand({ TableName: store.tableName, ExclusiveStartKey: start }),
        );
        items.push(...((page.Items ?? []) as Record<string, unknown>[]));
        start = page.LastEvaluatedKey;
      } while (start);
    } finally {
      client.destroy();
    }
    const ours = items.filter((i) => submitted.some((s) => JSON.stringify(i).includes(s.jobId)));
    expect(ours.length, 'the canary jobs have state items').toBeGreaterThanOrEqual(
      submitted.length,
    );
    const leaks = items.flatMap((item) =>
      findLeaksInValue(item, { canaries: allCanaries(), patterns: false }).map((l) => ({
        key: `${String(item['pk'] ?? '')}|${String(item['sk'] ?? '')}`,
        kind: l.kind,
      })),
    );
    expect(leaks).toEqual([]);
  });

  it(`Step Functions execution input carries no document data${sfnNote || claimCheckNote}`, async (t) => {
    const sfn = ctx.stepFunctions;
    precondition(
      t,
      ctx,
      sfn !== undefined,
      'needs the self-started harness (fake Step Functions endpoint)',
    );
    const doc = canaryDocument(ctx.runId, `${SUITE}-sfn`);
    const job = expectAccepted(
      await submit(sfn.target, ownerToken, { title: doc.title, content: doc.content }),
    );
    const capture = await pollUntil('the StartExecution call for the canary job', async () => {
      const res = await fetch(sfn.capturesUrl);
      const captures = (await res.json()) as { input: string; name: string }[];
      return captures.find((c) => c.input.includes(job.jobId));
    });
    const leaks = findLeaks(capture.input, { canaries: named(doc), patterns: false });
    precondition(
      t,
      ctx,
      claimCheck,
      `the claim check lands with workflow spec ${CLAIM_CHECK_SPEC}; the code under test (${ctx.workflowSpecVersion}) still sends the document (${leaks.length} canary hit(s))`,
    );
    expect(leaks).toEqual([]);
    const input = JSON.parse(capture.input) as Record<string, unknown>;
    expect(Object.keys(input).sort()).toEqual(['contractVersion', 'jobId', 'submittedAt']);
    expect(input['jobId']).toBe(job.jobId);
  });

  it('an error response never echoes document data', async () => {
    for (const target of ctx.targets) {
      const doc = canaryDocument(ctx.runId, `${SUITE}-err-${target.name}`);
      // Invalid options make the request fail validation with the document in the body.
      const r = await call(target, 'POST', '/v1/jobs', {
        token: ownerToken,
        json: { title: doc.title, content: doc.content, options: { topTerms: 9999 } },
      });
      expect(r.status, describeRes(r)).toBe(400);
      expect(
        findLeaks(r.text, {
          canaries: canaryValues(doc).map((value, i) => ({ label: `c${i}`, value })),
          patterns: false,
        }),
      ).toEqual([]);
    }
  });
});
