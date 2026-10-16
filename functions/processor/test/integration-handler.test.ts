/**
 * Arming of TEST fault injection in the mini-stack entry: only
 * TEST_FAULT_INJECTION=enabled wraps the TEST-ONLY document source; anything but "enabled" or
 * unset is a configuration error. Builds the dependencies only (no AWS call is made).
 */
import { FaultInjectingDocumentSource } from '@starter/documents/test-faults';
import { DynamoDbTestDocumentSource } from '@starter/documents/test-table';
import { ProcessingState } from '@starter/workflow-processing';
import { describe, expect, it } from 'vitest';
import { integrationDeps } from '../src/integration-handler.js';

const BASE = {
  JOBS_TABLE_NAME: 'starter-it-test-job-state',
  AWS_REGION: 'ap-southeast-1',
  TEST_DOCUMENTS_TABLE_NAME: 'starter-it-test-test-documents',
};

describe('processor integration entry: fault-injection arming', () => {
  it('without TEST_FAULT_INJECTION uses the plain TEST-ONLY document source', () => {
    const { documents } = integrationDeps({ ...BASE });
    expect(documents).toBeInstanceOf(DynamoDbTestDocumentSource);
    expect(documents).not.toBeInstanceOf(FaultInjectingDocumentSource);
  });

  it('TEST_FAULT_INJECTION=enabled wraps it, for the ProcessJob state only', () => {
    const { documents } = integrationDeps({ ...BASE, TEST_FAULT_INJECTION: 'enabled' });
    expect(documents).toBeInstanceOf(FaultInjectingDocumentSource);
    expect((documents as FaultInjectingDocumentSource).step).toBe(ProcessingState.Process);
  });

  it.each(['true', '1', 'yes'])('TEST_FAULT_INJECTION=%s is a configuration error', (value) => {
    expect(() => integrationDeps({ ...BASE, TEST_FAULT_INJECTION: value })).toThrow(
      expect.objectContaining({ name: 'ConfigError' }),
    );
  });

  it('requires the TEST-ONLY document table', () => {
    expect(() =>
      integrationDeps({
        ...BASE,
        TEST_DOCUMENTS_TABLE_NAME: undefined,
        TEST_FAULT_INJECTION: 'enabled',
      }),
    ).toThrow(expect.objectContaining({ name: 'ConfigError' }));
  });
});
