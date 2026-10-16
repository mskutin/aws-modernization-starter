/** The AWS mini-stack's TEST-ONLY document table source, against DynamoDB Local. */
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { uniqueTableName } from '@starter/testing';
import { inject } from 'vitest';
import {
  DynamoDbTestDocumentSource,
  TEST_DOCUMENT_TABLE_KEY,
  testDocumentItem,
} from '../../src/test-table.js';
import { describeDocumentSourceContract } from '../source-contract.js';

describeDocumentSourceContract('DynamoDB test document table (mini-stack only)', async () => {
  const { dynamodbEndpoint } = inject('integrationInfra');
  const client = new DynamoDBClient({
    region: 'ap-southeast-1',
    endpoint: dynamodbEndpoint,
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });
  const doc = DynamoDBDocumentClient.from(client);
  const tableName = uniqueTableName('starter-test-documents');
  await client.send(
    new CreateTableCommand({
      TableName: tableName,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [{ AttributeName: TEST_DOCUMENT_TABLE_KEY, AttributeType: 'S' }],
      KeySchema: [{ AttributeName: TEST_DOCUMENT_TABLE_KEY, KeyType: 'HASH' }],
    }),
  );
  await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName: tableName });
  const update = (jobId: string, expression: string, values: Record<string, unknown>) =>
    doc.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { [TEST_DOCUMENT_TABLE_KEY]: jobId },
        UpdateExpression: expression,
        ExpressionAttributeValues: values,
      }),
    );
  return {
    source: new DynamoDbTestDocumentSource({ client: doc, tableName }),
    seed: async (jobId, d) => {
      await doc.send(
        new PutCommand({
          TableName: tableName,
          Item: testDocumentItem(jobId, {
            title: d.title,
            content: d.content,
            options: { topTerms: d.topTerms },
          }),
        }),
      );
    },
    purge: async (jobId) => {
      await update(jobId, 'SET purgedAt = :at', { ':at': new Date().toISOString() });
    },
    tamper: async (jobId, content) => {
      await update(jobId, 'SET content = :c', { ':c': content });
    },
    cleanup: async () => {
      await client.send(new DeleteTableCommand({ TableName: tableName }));
      client.destroy();
    },
  };
});
