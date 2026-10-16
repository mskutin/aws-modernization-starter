/** Fixture tests of the execution-history leak scanner (no AWS needed). */
import { describe, expect, it } from 'vitest';
import {
  executionStartedInputKeys,
  findHistoryLeaks,
  hasMinimalExecutionInput,
} from './history-leaks.js';

const MARKERS = ['5550123456789012', 'Canary sentence 5550123456789012 stays inside the system'];
const minimalInput = JSON.stringify({
  jobId: '4194b63d-9c1e-4c8a-9f43-1a2b3c4d5e6f',
  contractVersion: '1.0.0',
  submittedAt: '2026-10-14T00:00:00.000Z',
});

/** Shaped like `GetExecutionHistory` events of the spec 2.0.0 workflow. */
const cleanHistory = [
  { id: 1, type: 'ExecutionStarted', executionStartedEventDetails: { input: minimalInput } },
  {
    id: 2,
    type: 'TaskStateEntered',
    stateEnteredEventDetails: { name: 'ValidateJob', input: minimalInput },
  },
  {
    id: 3,
    type: 'TaskScheduled',
    taskScheduledEventDetails: {
      resource: 'invoke',
      parameters: `{"FunctionName":"fn","Payload":${minimalInput}}`,
    },
  },
  {
    id: 4,
    type: 'TaskSucceeded',
    taskSucceededEventDetails: {
      output: '{"jobId":"x","valid":true,"rulesVersion":"1.0.0","duplicate":false}',
    },
  },
  { id: 5, type: 'ExecutionSucceeded', executionSucceededEventDetails: { output: minimalInput } },
];

describe('findHistoryLeaks', () => {
  it('reports nothing for a spec 2.0.0 history', () => {
    expect(findHistoryLeaks(cleanHistory, MARKERS)).toEqual([]);
  });

  it.each([
    ['a 1.x execution input with the document', 'executionStartedEventDetails', 'ExecutionStarted'],
    ['a task output carrying text', 'taskSucceededEventDetails', 'TaskSucceeded'],
    ['an error cause quoting the document', 'taskFailedEventDetails', 'TaskFailed'],
  ])('finds the canary in %s', (_name, detailsKey, type) => {
    const leaking = [
      ...cleanHistory,
      {
        id: 9,
        type,
        [detailsKey]: {
          input: JSON.stringify({ payload: { content: `x ${MARKERS[1]} y` } }),
          output: `{"text":"${MARKERS[0]}"}`,
          cause: `boom near ${MARKERS[0]}`,
        },
      },
    ];
    const leaks = findHistoryLeaks(leaking, MARKERS);
    expect(leaks.length).toBeGreaterThan(0);
    expect(leaks.every((l) => l.eventId === 9 && l.type === type)).toBe(true);
  });

  it('also finds markers that appear JSON-escaped inside nested payload strings', () => {
    const nested = [
      {
        id: 7,
        type: 'TaskScheduled',
        details: JSON.stringify({ p: JSON.stringify({ c: MARKERS[1] }) }),
      },
    ];
    expect(findHistoryLeaks(nested, MARKERS).map((l) => l.marker)).toContain(MARKERS[1]);
  });
});

describe('execution input recorded in the history', () => {
  it('is exactly the job reference for a spec 2.0.0 execution', () => {
    expect(executionStartedInputKeys(cleanHistory)).toEqual([
      'contractVersion',
      'jobId',
      'submittedAt',
    ]);
    expect(hasMinimalExecutionInput(cleanHistory)).toBe(true);
  });

  it('flags a payload-carrying (1.x) input', () => {
    const legacy = [
      {
        type: 'ExecutionStarted',
        executionStartedEventDetails: {
          input: JSON.stringify({ ...JSON.parse(minimalInput), idempotencyKey: 'k', payload: {} }),
        },
      },
    ];
    expect(hasMinimalExecutionInput(legacy)).toBe(false);
    expect(hasMinimalExecutionInput([])).toBe(false);
  });
});
