/**
 * TEST ONLY — document source of the AWS integration mini-stack (ADR 0232).
 *
 * The mini-stack has no PostgreSQL. Its real-AWS tests seed SYNTHETIC documents into a
 * dedicated, ephemeral DynamoDB table; the mini-stack's handler entries
 * (`functions/{validator,processor}/src/integration-handler.ts`) read them through this source.
 * The environment stages never deploy that table or those entries (asserted by infra tests),
 * so PostgreSQL remains the only document store in dev/staging/prod. The same purge and SHA-256
 * verification as `PgDocumentSource` applies.
 *
 * Exported from the `@starter/documents/test-table` subpath so production bundles never import it.
 */
import { GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { sha256Hex } from '@starter/domain';
import type { JobOptions } from '@starter/contracts';
import { DocumentUnavailableError, classifySourceError } from './errors.js';
import type { DocumentSource, StoredDocument } from './types.js';
import { toVerifiedDocument } from './verify.js';

/** Partition key of the test document table. */
export const TEST_DOCUMENT_TABLE_KEY = 'jobId';

export interface TestDocumentTableOptions {
  client: DynamoDBDocumentClient;
  tableName: string;
}

/** Item a test writes to seed a document (hash computed exactly as the API stores it). */
export function testDocumentItem(
  jobId: string,
  doc: { title: string; content: string; options: JobOptions; contractVersion?: string },
): Record<string, unknown> {
  return {
    [TEST_DOCUMENT_TABLE_KEY]: jobId,
    title: doc.title,
    content: doc.content,
    options: doc.options,
    contentSha256: sha256Hex(doc.content),
    contractVersion: doc.contractVersion ?? '1.0.0',
  };
}

export class DynamoDbTestDocumentSource implements DocumentSource {
  constructor(private readonly options: TestDocumentTableOptions) {}

  async load(jobId: string): Promise<StoredDocument> {
    let item: Record<string, unknown> | undefined;
    try {
      const out = await this.options.client.send(
        new GetCommand({
          TableName: this.options.tableName,
          Key: { [TEST_DOCUMENT_TABLE_KEY]: jobId },
          ConsistentRead: true,
        }),
      );
      item = out.Item;
    } catch (error) {
      throw classifySourceError(error, jobId);
    }
    if (!item) throw new DocumentUnavailableError(jobId, 'no-document');
    const text = (value: unknown) => (typeof value === 'string' ? value : null);
    return toVerifiedDocument(jobId, {
      title: text(item.title),
      content: text(item.content),
      options: item.options,
      contentSha256: text(item.contentSha256) ?? '',
      contractVersion: text(item.contractVersion) ?? '',
      purgedAt: text(item.purgedAt),
    });
  }
}
