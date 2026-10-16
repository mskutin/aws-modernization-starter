import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  UpdateTimeToLiveCommand,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { JobStateTable } from '@starter/workflow-processing';

export interface DynamoDbClientOptions {
  region: string;
  /** DynamoDB Local endpoint (local development / tests only). */
  endpoint?: string | undefined;
  maxAttempts?: number | undefined;
  requestTimeoutMs?: number | undefined;
  connectionTimeoutMs?: number | undefined;
}

export interface DynamoDbClients {
  client: DynamoDBClient;
  doc: DynamoDBDocumentClient;
  destroy(): void;
}

export function createDynamoDbClients(options: DynamoDbClientOptions): DynamoDbClients {
  // DynamoDB Local accepts any credentials; avoid probing the credential chain locally.
  const localCredentials =
    options.endpoint && !process.env.AWS_ACCESS_KEY_ID
      ? { credentials: { accessKeyId: 'local', secretAccessKey: 'local' } }
      : {};
  const client = new DynamoDBClient({
    region: options.region,
    ...(options.endpoint ? { endpoint: options.endpoint } : {}),
    maxAttempts: options.maxAttempts ?? 3,
    requestHandler: {
      requestTimeout: options.requestTimeoutMs ?? 3_000,
      connectionTimeout: options.connectionTimeoutMs ?? 1_000,
    },
    ...localCredentials,
  });
  const doc = DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
  });
  return {
    client,
    doc,
    destroy: () => {
      doc.destroy();
      client.destroy();
    },
  };
}

/**
 * Creates the job-state table with the spec layout if it does not exist.
 * For DynamoDB Local / tests only — on AWS the table is owned by CDK.
 */
export async function ensureJobsTable(client: DynamoDBClient, tableName: string): Promise<boolean> {
  try {
    await client.send(new DescribeTableCommand({ TableName: tableName }));
    return false;
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'ResourceNotFoundException') throw error;
  }
  const { partitionKey, sortKey, statusIndex, ttlAttribute } = JobStateTable;
  try {
    await client.send(
      new CreateTableCommand({
        TableName: tableName,
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [
          { AttributeName: partitionKey, AttributeType: 'S' },
          { AttributeName: sortKey, AttributeType: 'S' },
          { AttributeName: statusIndex.partitionKey, AttributeType: 'S' },
          { AttributeName: statusIndex.sortKey, AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: partitionKey, KeyType: 'HASH' },
          { AttributeName: sortKey, KeyType: 'RANGE' },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: statusIndex.name,
            KeySchema: [
              { AttributeName: statusIndex.partitionKey, KeyType: 'HASH' },
              { AttributeName: statusIndex.sortKey, KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          },
        ],
      }),
    );
  } catch (error) {
    // Another process created it concurrently.
    if (!(error instanceof Error) || error.name !== 'ResourceInUseException') throw error;
  }
  await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName: tableName });
  await client.send(
    new UpdateTimeToLiveCommand({
      TableName: tableName,
      TimeToLiveSpecification: { AttributeName: ttlAttribute, Enabled: true },
    }),
  );
  return true;
}
