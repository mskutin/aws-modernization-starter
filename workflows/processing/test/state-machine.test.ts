import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { describe, expect, it } from 'vitest';
import { ProcessingStateMachine, resolveExecutionTimeoutSeconds } from '../src/cdk/index.js';
import { PROCESSING_WORKFLOW } from '../src/spec.js';

interface Asl {
  TimeoutSeconds?: number;
  States: Record<string, { TimeoutSeconds?: number; Retry?: unknown[]; Catch?: unknown[] }>;
}

/** Synthesizes one ProcessingStateMachine and returns its definition (tokens rendered as text). */
function definition(executionTimeoutSeconds?: number): Asl {
  const stack = new Stack(new App(), 'Test', {
    env: { account: '000000000000', region: 'ap-southeast-1' },
  });
  const fn = (name: string) =>
    lambda.Function.fromFunctionArn(
      stack,
      name,
      `arn:aws:lambda:ap-southeast-1:000000000000:function:${name}:live`,
    );
  new ProcessingStateMachine(stack, 'Machine', {
    validateFunction: fn('validator'),
    processFunction: fn('processor'),
    table: dynamodb.Table.fromTableName(stack, 'Table', 'jobs'),
    logGroup: new logs.LogGroup(stack, 'Logs'),
    ...(executionTimeoutSeconds === undefined ? {} : { executionTimeoutSeconds }),
  });
  const resources = Template.fromStack(stack).findResources('AWS::StepFunctions::StateMachine');
  const [machine] = Object.values(resources) as { Properties: { DefinitionString: unknown } }[];
  const raw = machine!.Properties.DefinitionString as { 'Fn::Join': [string, unknown[]] };
  const text = raw['Fn::Join'][1].map((p) => (typeof p === 'string' ? p : 'TOKEN')).join('');
  return JSON.parse(text) as Asl;
}

describe('ProcessingStateMachine execution timeout', () => {
  it('uses the spec value by default (every environment stage)', () => {
    expect(definition().TimeoutSeconds).toBe(PROCESSING_WORKFLOW.executionTimeoutSeconds);
  });

  it('can only be SHORTENED (AWS integration mini-stack timeout test); task timeouts, retries and catches are unchanged', () => {
    const base = definition();
    const short = definition(45);
    expect(short.TimeoutSeconds).toBe(45);
    expect(short.States).toEqual(base.States);
  });

  it.each([0, -1, 1.5, PROCESSING_WORKFLOW.executionTimeoutSeconds + 1, Number.NaN])(
    'rejects %s',
    (value) => {
      expect(() => resolveExecutionTimeoutSeconds(value)).toThrow(/only shorten/);
    },
  );

  it('accepts the bounds', () => {
    expect(resolveExecutionTimeoutSeconds(1)).toBe(1);
    expect(resolveExecutionTimeoutSeconds(PROCESSING_WORKFLOW.executionTimeoutSeconds)).toBe(
      PROCESSING_WORKFLOW.executionTimeoutSeconds,
    );
    expect(resolveExecutionTimeoutSeconds(undefined)).toBe(
      PROCESSING_WORKFLOW.executionTimeoutSeconds,
    );
  });
});
