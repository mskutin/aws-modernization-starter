import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AWS_REGION,
  RegionError,
  awsPartitionOf,
  isAwsRegionSyntax,
  resolveAwsRegion,
  validateAwsRegion,
} from '../src/region.js';

const repoFile = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), 'utf8');

describe('deployment region', () => {
  it('keeps ap-southeast-1 as the documented default', () => {
    expect(DEFAULT_AWS_REGION).toBe('ap-southeast-1');
    expect(resolveAwsRegion([])).toEqual({ region: 'ap-southeast-1', source: 'default' });
  });

  it.each([
    'ap-southeast-1',
    'eu-west-1',
    'us-east-1',
    'ap-southeast-5',
    'me-central-1',
    'il-central-1',
  ])('accepts the aws-partition region %s', (region) => {
    expect(validateAwsRegion(region)).toBe(region);
  });

  it.each([
    '',
    'Frankfurt',
    'ap-southeast',
    'ap-southeast-1a',
    'AP-SOUTHEAST-1',
    ' ap-southeast-1',
    'ap-southeast-1\n',
    'ap_southeast_1',
    'eusc-de-east-1',
    'ap-southeast-100',
    '--region',
  ])('rejects the malformed region %j', (value) => {
    expect(() => validateAwsRegion(value, '-c region')).toThrow(RegionError);
    expect(() => validateAwsRegion(value, '-c region')).toThrow(/Invalid -c region=/);
  });

  it('rejects non-strings without echoing them', () => {
    expect(() => validateAwsRegion(42)).toThrow('Invalid region=number');
    expect(() => validateAwsRegion(undefined)).toThrow(RegionError);
  });

  it.each([
    ['cn-north-1', 'aws-cn'],
    ['cn-northwest-1', 'aws-cn'],
    ['us-gov-west-1', 'aws-us-gov'],
    ['us-iso-east-1', 'aws-iso'],
    ['us-isob-east-1', 'aws-iso-b'],
    ['eu-isoe-west-1', 'aws-iso-e'],
  ])('refuses %s explicitly (partition %s)', (region, partition) => {
    expect(isAwsRegionSyntax(region)).toBe(true);
    expect(awsPartitionOf(region)).toBe(partition);
    expect(() => validateAwsRegion(region, '--region')).toThrow(
      `Unsupported --region=${region}: it belongs to the ${partition} partition`,
    );
  });

  it('resolves the first set candidate, in precedence order, and validates it', () => {
    expect(
      resolveAwsRegion([
        { source: '-c region', value: undefined },
        { source: 'AWS_REGION', value: '' },
        { source: 'AWS_DEFAULT_REGION', value: 'eu-west-1' },
      ]),
    ).toEqual({ region: 'eu-west-1', source: 'AWS_DEFAULT_REGION' });
    expect(() =>
      resolveAwsRegion([
        { source: '-c region', value: 'cn-north-1' },
        { source: 'AWS_REGION', value: 'eu-west-1' },
      ]),
    ).toThrow(/Unsupported -c region=cn-north-1/);
  });

  // The copies that cannot import this module are pinned to the default here as well as in their
  // own packages' tests (tools/aws-preflight/test/region.test.ts also runs the copied validations
  // on the same inputs), so changing the default without them fails here.
  it.each([
    ['tools/aws-preflight/src/types.ts', /export const DEFAULT_WORKLOAD_REGION = '([a-z0-9-]+)';/],
    ['tools/finops/src/config.ts', /export const DEFAULT_REGION = '([a-z0-9-]+)';/],
    ['tools/aws-preflight/scripts/region.sh', /^STARTER_DEFAULT_REGION=([a-z0-9-]+)$/m],
  ])('%s carries the same default region', (path, pattern) => {
    expect(pattern.exec(repoFile(path))?.[1]).toBe(DEFAULT_AWS_REGION);
  });
});
