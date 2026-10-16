/**
 * Deployment region: the single source of truth for the default region and the one validation
 * function for AWS region names. Pure (no zod, no I/O), so the CDK apps, the AWS tooling and the
 * runtime configuration can all import it (`@starter/config/region`).
 *
 * The reference targets `ap-southeast-1` by default. Another region of the commercial `aws`
 * partition can be configured (`-c region=…` for the CDK apps, `--region` / the documented
 * environment variables for the scripts); region-specific data (FinOps price tables, AWS-managed
 * prefix list ids) must then exist for that region, or the tooling refuses it.
 *
 * Copies of DEFAULT_AWS_REGION in code that cannot import this module (the dependency-free
 * tools/aws-preflight and the shell scripts) are pinned to it by tests.
 */

/** The default deployment region. Change the default here only. */
export const DEFAULT_AWS_REGION = 'ap-southeast-1';

/** The only AWS partition this reference supports. */
export const SUPPORTED_AWS_PARTITION = 'aws';

/**
 * Syntax of an AWS region name: `<2-letter area>[-gov|-iso<x>]-<direction>-<number>`, e.g.
 * `ap-southeast-1`, `eu-west-1`, `us-gov-west-1`, `us-isob-east-1`. Syntax only: the partition is
 * checked separately (`awsPartitionOf`).
 */
export const AWS_REGION_PATTERN = /^[a-z]{2}(?:-gov|-iso[a-z]?)?-[a-z]+-\d{1,2}$/;

/** `aws`, `aws-cn`, `aws-us-gov`, `aws-iso`, `aws-iso-<letter>` (e.g. `aws-iso-b`). */
export type AwsPartition = 'aws' | 'aws-cn' | 'aws-us-gov' | `aws-iso${string}`;

export class RegionError extends Error {
  override readonly name = 'RegionError';
}

/** True when `value` is syntactically an AWS region name (any partition). */
export function isAwsRegionSyntax(value: unknown): value is string {
  return typeof value === 'string' && AWS_REGION_PATTERN.test(value);
}

/** The partition of a syntactically valid region name. */
export function awsPartitionOf(region: string): AwsPartition {
  if (region.startsWith('cn-')) return 'aws-cn';
  if (/^[a-z]{2}-gov-/.test(region)) return 'aws-us-gov';
  const iso = /^[a-z]{2}-iso([a-z]?)-/.exec(region);
  if (iso) return iso[1] ? `aws-iso-${iso[1]}` : 'aws-iso';
  return 'aws';
}

/**
 * THE region validation: returns the region when it is a syntactically valid region of the
 * supported `aws` partition, otherwise throws `RegionError`. `source` names where the value came
 * from (e.g. `-c region`, `--region`, `AWS_REGION`) for the message; the value itself is a region
 * name, never a secret, so it is echoed.
 */
export function validateAwsRegion(value: unknown, source = 'region'): string {
  if (!isAwsRegionSyntax(value)) {
    throw new RegionError(
      `Invalid ${source}=${typeof value === 'string' ? JSON.stringify(value.slice(0, 40)) : typeof value}: expected an AWS region name such as ${DEFAULT_AWS_REGION}`,
    );
  }
  const partition = awsPartitionOf(value);
  if (partition !== SUPPORTED_AWS_PARTITION) {
    throw new RegionError(
      `Unsupported ${source}=${value}: it belongs to the ${partition} partition; this reference supports the ${SUPPORTED_AWS_PARTITION} partition only`,
    );
  }
  return value;
}

/**
 * Resolves a region from candidate sources in precedence order (the first one that is set and
 * non-empty wins), falling back to DEFAULT_AWS_REGION, then validates it.
 */
export function resolveAwsRegion(
  candidates: readonly { readonly source: string; readonly value: unknown }[],
): { readonly region: string; readonly source: string } {
  for (const c of candidates) {
    if (c.value === undefined || c.value === null || c.value === '') continue;
    return { region: validateAwsRegion(c.value, c.source), source: c.source };
  }
  return { region: DEFAULT_AWS_REGION, source: 'default' };
}
