/**
 * Deployment region of the CDK apps and region-specific constants.
 *
 * The default region and the region validation come from `@starter/config/region` (the single
 * source of truth). Dependency-free besides that module (no aws-cdk-lib), so
 * `@starter/tests-aws-integration` imports it as `@starter/infra/region`.
 *
 * Region-dependent AWS constants are looked up PER REGION here; a region without a known value
 * gets none (`undefined`), never the value of another region.
 */
import { resolveAwsRegion } from '@starter/config/region';

export {
  DEFAULT_AWS_REGION,
  RegionError,
  SUPPORTED_AWS_PARTITION,
  isAwsRegionSyntax,
  resolveAwsRegion,
  validateAwsRegion,
} from '@starter/config/region';

/**
 * Id of the AWS-managed prefix list `com.amazonaws.global.cloudfront.origin-facing` per region
 * (the id differs per region). Only ids confirmed by a read-only discovery are listed; add a row
 * after confirming it with
 *   aws ec2 describe-managed-prefix-lists --region <region> \
 *     --filters Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing
 */
export const CLOUDFRONT_ORIGIN_FACING_PREFIX_LIST_IDS: Readonly<Record<string, string>> =
  Object.freeze({
    'ap-southeast-1': 'pl-31a34658',
  });

/** The confirmed origin-facing prefix list id of `region`, or undefined (never another region's). */
export function knownCloudFrontOriginFacingPrefixListId(region: string): string | undefined {
  return Object.hasOwn(CLOUDFRONT_ORIGIN_FACING_PREFIX_LIST_IDS, region)
    ? CLOUDFRONT_ORIGIN_FACING_PREFIX_LIST_IDS[region]
    : undefined;
}

/**
 * Syntactically valid stand-in for a prefix list id that is not known for the configured region.
 * No such prefix list exists; the sandbox stage treats it as a placeholder (non-deployable
 * template, refused by `-c requireDeployInputs=true`).
 */
export const PLACEHOLDER_PREFIX_LIST_ID = 'pl-00000000';

/**
 * Availability zones `<region>a`, `<region>b` (and `c`): every region of the aws partition has
 * at least three AZs with these letters. Used for the committed placeholders and the sandbox
 * foundation; an imported landing zone names its real subnets and AZs.
 */
export function defaultAvailabilityZones(region: string, count: 2 | 3 = 2): string[] {
  return ['a', 'b', 'c'].slice(0, count).map((letter) => `${region}${letter}`);
}

/**
 * The region of a CDK app: `-c region.<env>` > `-c region` > `STARTER_REGION_<ENV>` (environment
 * apps only) > the committed config > DEFAULT_AWS_REGION. Ambient `AWS_REGION` /
 * `AWS_DEFAULT_REGION` are NOT read: the stack environment is pinned explicitly, so a shell's
 * region never redirects a deployment. Returns undefined when nothing overrides the config.
 */
export function regionOverride(
  tryGetContext: (key: string) => unknown,
  env: NodeJS.ProcessEnv,
  name?: string,
): string | undefined {
  const candidates =
    name === undefined
      ? [{ source: '-c region', value: tryGetContext('region') }]
      : [
          { source: `-c region.${name}`, value: tryGetContext(`region.${name}`) },
          { source: '-c region', value: tryGetContext('region') },
          {
            source: `STARTER_REGION_${name.toUpperCase()}`,
            value: env[`STARTER_REGION_${name.toUpperCase()}`],
          },
        ];
  const resolved = resolveAwsRegion(candidates);
  return resolved.source === 'default' ? undefined : resolved.region;
}
