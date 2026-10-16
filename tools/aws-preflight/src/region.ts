/**
 * Workload region validation: the same rules as `validateAwsRegion` of `@starter/config/region`
 * (the single source of truth), copied because this tool is dependency-free on purpose. A test
 * (test/region.test.ts) runs both on the same inputs and fails when they disagree.
 */

/** `<2-letter area>[-gov|-iso<x>]-<direction>-<number>`: syntax only, any partition. */
const AWS_REGION_PATTERN = /^[a-z]{2}(?:-gov|-iso[a-z]?)?-[a-z]+-\d{1,2}$/;

/** The partition of a syntactically valid region name. */
export function partitionOf(region: string): string {
  if (region.startsWith('cn-')) return 'aws-cn';
  if (/^[a-z]{2}-gov-/.test(region)) return 'aws-us-gov';
  const iso = /^[a-z]{2}-iso([a-z]?)-/.exec(region);
  if (iso) return iso[1] ? `aws-iso-${iso[1]}` : 'aws-iso';
  return 'aws';
}

/**
 * Why `value` is not an acceptable workload region (a syntactically valid region of the `aws`
 * partition), or undefined. The message never echoes more than 40 characters of the value.
 */
export function workloadRegionProblem(value: unknown): string | undefined {
  if (typeof value !== 'string' || !AWS_REGION_PATTERN.test(value)) {
    const shown = typeof value === 'string' ? JSON.stringify(value.slice(0, 40)) : typeof value;
    return `${shown} is not an AWS region name (e.g. ap-southeast-1)`;
  }
  const partition = partitionOf(value);
  if (partition !== 'aws') {
    return `${value} belongs to the ${partition} partition; only the aws partition is supported`;
  }
  return undefined;
}

export const isWorkloadRegion = (value: unknown): value is string =>
  workloadRegionProblem(value) === undefined;
