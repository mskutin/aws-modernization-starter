import { existsSync } from 'node:fs';
import { RemovalPolicy, Stack } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import { describe, expect, it } from 'vitest';
import { applyLogGroupCompliance } from '../lib/aspects.js';
import { PLACEHOLDER_IMAGE_DIGEST, resolveImageDigest } from '../lib/image.js';
import { handlerEntries, resolveHandlerEntries } from '../lib/lambda-entries.js';
import { REPO_ROOT } from '../lib/paths.js';
import { applyRequiredTags, assertRequiredTags } from '../lib/tagging.js';
import { newApp, TEST_ENV } from './helpers.js';

const TAGS = {
  Project: 'aws-modernization-starter',
  Environment: 'dev',
  Owner: 'platform-team',
  CostCentre: 'CC-1',
  DataClassification: 'Internal',
  ManagedBy: 'aws-cdk',
};

describe('required tags aspect', () => {
  it('tags every taggable resource with exactly the six keys plus mandatory extras', () => {
    const stack = new Stack(newApp(), 'S', { env: TEST_ENV });
    new sns.Topic(stack, 'T', { enforceSSL: true });
    applyRequiredTags(stack, TAGS, { BusinessUnit: 'Platform' });
    const [topic] = Object.values(Template.fromStack(stack).findResources('AWS::SNS::Topic'));
    const tags = (topic as { Properties: { Tags: { Key: string; Value: string }[] } }).Properties
      .Tags;
    expect(Object.fromEntries(tags.map((t) => [t.Key, t.Value]))).toEqual({
      ...TAGS,
      BusinessUnit: 'Platform',
    });
    expect(Annotations.fromStack(stack).findError('*', Match.anyValue())).toEqual([]);
  });

  it('required values cannot be overridden by ad-hoc tags', () => {
    const stack = new Stack(newApp(), 'S', { env: TEST_ENV });
    new sns.Topic(stack, 'T');
    applyRequiredTags(stack, TAGS, { Environment: 'prod' });
    Template.fromStack(stack).hasResourceProperties('AWS::SNS::Topic', {
      Tags: Match.arrayWith([{ Key: 'Environment', Value: 'dev' }]),
    });
  });

  it('rejects missing, extra or empty required tags', () => {
    const { CostCentre: _omit, ...missing } = TAGS;
    expect(() => assertRequiredTags(missing)).toThrow(/missing: CostCentre/);
    expect(() => assertRequiredTags({ ...TAGS, Team: 'x' })).toThrow(/unexpected: Team/);
    expect(() => assertRequiredTags({ ...TAGS, Owner: ' ' })).toThrow(/empty: Owner/);
  });
});

describe('log group compliance aspect', () => {
  it('errors on log groups without retention or KMS', () => {
    const stack = new Stack(newApp(), 'S', { env: TEST_ENV });
    new logs.LogGroup(stack, 'Bad', {
      retention: logs.RetentionDays.INFINITE,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    applyLogGroupCompliance(stack);
    expect(() => Template.fromStack(stack)).toThrow(
      /Log group must set an explicit retention[\s\S]*Log group must be encrypted with a customer-managed KMS key/,
    );
  });

  it('accepts compliant log groups', () => {
    const stack = new Stack(newApp(), 'S', { env: TEST_ENV });
    new logs.LogGroup(stack, 'Good', {
      retention: logs.RetentionDays.ONE_MONTH,
      encryptionKey: new kms.Key(stack, 'K', { enableKeyRotation: true }),
      removalPolicy: RemovalPolicy.DESTROY,
    });
    applyLogGroupCompliance(stack);
    expect(Annotations.fromStack(stack).findError('*', Match.anyValue())).toEqual([]);
  });
});

describe('image digest resolution', () => {
  const ctx = (values: Record<string, unknown>) => (k: string) => values[k];
  const digest = `sha256:${'b'.repeat(64)}`;

  it('uses the context digest, then API_IMAGE_DIGEST, else the placeholder', () => {
    expect(resolveImageDigest(ctx({ apiImageDigest: digest }), {})).toEqual({
      digest,
      isPlaceholder: false,
    });
    expect(resolveImageDigest(ctx({}), { API_IMAGE_DIGEST: digest })).toEqual({
      digest,
      isPlaceholder: false,
    });
    expect(resolveImageDigest(ctx({}), {})).toEqual({
      digest: PLACEHOLDER_IMAGE_DIGEST,
      isPlaceholder: true,
    });
  });

  it('rejects tags/malformed digests and, when required, missing or placeholder digests', () => {
    expect(() => resolveImageDigest(ctx({ apiImageDigest: 'latest' }), {})).toThrow(/sha256/);
    expect(() => resolveImageDigest(ctx({ requireImageDigest: 'true' }), {})).toThrow(
      /requireImageDigest/,
    );
    expect(() =>
      resolveImageDigest(
        ctx({ requireImageDigest: true, apiImageDigest: PLACEHOLDER_IMAGE_DIGEST }),
        {},
      ),
    ).toThrow(/placeholder/);
  });
});

describe('Lambda handler entries', () => {
  it('fixtures exist; real entries point at functions/<name>/src/handler.ts', () => {
    const fixtures = resolveHandlerEntries('fixtures');
    expect(Object.values(fixtures).every((file) => existsSync(file))).toBe(true);
    expect(handlerEntries('source')).toEqual({
      validator: `${REPO_ROOT}/functions/validator/src/handler.ts`,
      processor: `${REPO_ROOT}/functions/processor/src/handler.ts`,
      reconciler: `${REPO_ROOT}/functions/reconciler/src/handler.ts`,
    });
    expect(() => resolveHandlerEntries('docker')).toThrow(/lambdaHandlers=docker/);
  });

  it('the mini-stack uses the integration entries (TEST-ONLY document table), stages never do', () => {
    expect(handlerEntries('source', 'integration')).toEqual({
      validator: `${REPO_ROOT}/functions/validator/src/integration-handler.ts`,
      processor: `${REPO_ROOT}/functions/processor/src/integration-handler.ts`,
      reconciler: `${REPO_ROOT}/functions/reconciler/src/handler.ts`,
    });
    expect(Object.values(handlerEntries('source')).join()).not.toContain('integration-handler');
  });
});
