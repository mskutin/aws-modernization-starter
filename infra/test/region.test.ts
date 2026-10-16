import { describe, expect, it } from 'vitest';
import {
  CLOUDFRONT_ORIGIN_FACING_PREFIX_LIST_IDS,
  DEFAULT_AWS_REGION,
  defaultAvailabilityZones,
  knownCloudFrontOriginFacingPrefixListId,
  regionOverride,
} from '../lib/region.js';

const ctx = (values: Record<string, string>) => (key: string) => values[key];

describe('lib/region', () => {
  it('re-exports the single default (ap-southeast-1)', () => {
    expect(DEFAULT_AWS_REGION).toBe('ap-southeast-1');
  });

  it('knows region-specific constants only for the regions they were confirmed in', () => {
    expect(Object.keys(CLOUDFRONT_ORIGIN_FACING_PREFIX_LIST_IDS)).toEqual(['ap-southeast-1']);
    expect(knownCloudFrontOriginFacingPrefixListId('ap-southeast-1')).toBe('pl-31a34658');
    for (const region of ['eu-west-1', 'us-east-1', 'toString', '__proto__']) {
      expect(knownCloudFrontOriginFacingPrefixListId(region)).toBeUndefined();
    }
  });

  it('derives AZ names from the region', () => {
    expect(defaultAvailabilityZones('eu-west-1')).toEqual(['eu-west-1a', 'eu-west-1b']);
    expect(defaultAvailabilityZones('ap-southeast-1', 3)).toEqual([
      'ap-southeast-1a',
      'ap-southeast-1b',
      'ap-southeast-1c',
    ]);
  });

  it('an app without environments reads -c region only (never AWS_REGION)', () => {
    expect(regionOverride(ctx({}), { AWS_REGION: 'eu-west-1' })).toBeUndefined();
    expect(regionOverride(ctx({ region: 'eu-west-1' }), {})).toBe('eu-west-1');
    expect(regionOverride(ctx({ 'region.dev': 'eu-west-1' }), {})).toBeUndefined();
    expect(() => regionOverride(ctx({ region: 'us-gov-west-1' }), {})).toThrow(/aws-us-gov/);
  });
});
