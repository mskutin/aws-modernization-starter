/**
 * PLACEHOLDER identifiers for the landing-zone (foundation) resources.
 *
 * Nothing in this repository has been deployed to AWS. Every value below is a
 * syntactically valid stand-in so `cdk synth` and the tests run offline. Each
 * one MUST be replaced with the real value issued by the platform team
 * before any deployment (see docs/landing-zone-adaptation.md). Values are grouped per
 * environment by a short hex code: dev `de`, staging `5a`, prod `f0`.
 */
import {
  DEFAULT_AWS_REGION,
  PLACEHOLDER_PREFIX_LIST_ID,
  defaultAvailabilityZones,
  knownCloudFrontOriginFacingPrefixListId,
} from '../lib/region.js';
import {
  PLACEHOLDER_ACCOUNT_ID,
  type EdgeSchema,
  type ImportedFoundationSchema,
} from './schema.js';
import type { z } from 'zod';

type EnvCode = 'de' | '5a' | 'f0';

const id17 = (code: EnvCode, suffix: string) => `0${code}${suffix.padStart(14, '0')}`;
const uuid = (code: EnvCode, suffix: string) =>
  `00000000-0000-4000-8000-${`${code}${suffix}`.padStart(12, '0')}`;

/**
 * Placeholder id of the AWS-managed prefix list `com.amazonaws.global.cloudfront.origin-facing`
 * in `region`: the confirmed id where one is known (lib/region.ts), otherwise the non-existent
 * PLACEHOLDER_PREFIX_LIST_ID — never another region's id. Verify with:
 *   aws ec2 describe-managed-prefix-lists --region <region>
 *   --filters Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing
 */
export function placeholderOriginFacingPrefixListId(region: string): string {
  return knownCloudFrontOriginFacingPrefixListId(region) ?? PLACEHOLDER_PREFIX_LIST_ID;
}

export function placeholderEdge(
  code: EnvCode,
  envName: string,
  region: string = DEFAULT_AWS_REGION,
): z.input<typeof EdgeSchema> {
  const zone = `${envName}.starter.example.com`;
  return {
    apiOriginDomainName: `api-origin.${zone}`,
    albCertificateArn: `arn:aws:acm:${region}:${PLACEHOLDER_ACCOUNT_ID}:certificate/${uuid(code, 'a01')}`,
    webDomainName: `app.${zone}`,
    cloudFrontCertificateArn: `arn:aws:acm:us-east-1:${PLACEHOLDER_ACCOUNT_ID}:certificate/${uuid(code, 'c01')}`,
    hostedZone: { hostedZoneId: `Z0000000000000000${code.toUpperCase()}01`, zoneName: zone },
    wafWebAclArn: `arn:aws:wafv2:us-east-1:${PLACEHOLDER_ACCOUNT_ID}:global/webacl/starter-placeholder-${envName}/${uuid(code, 'f01')}`,
    cloudFrontOriginFacingPrefixListId: placeholderOriginFacingPrefixListId(region),
  };
}

/**
 * PLACEHOLDER identity provider registration (identity). Replace with the organization IdP's
 * issuer, the API audience and the SPA client id (docs/landing-zone-adaptation.md). https in every stage.
 */
export function placeholderAuth(envName: string): {
  issuer: string;
  audience: string;
  spaClientId: string;
} {
  return {
    issuer: `https://idp.${envName}.starter.example.com/realms/starter`,
    audience: `api://starter-${envName}-jobs`,
    spaClientId: `starter-${envName}-web`,
  };
}

export function placeholderImportedFoundation(
  code: EnvCode,
  envName: string,
  region: string = DEFAULT_AWS_REGION,
): z.input<typeof ImportedFoundationSchema> {
  const azs = defaultAvailabilityZones(region, 3);
  const subnets = (tier: 'a' | 'd') =>
    azs.map((availabilityZone, i) => ({
      subnetId: `subnet-${id17(code, `${tier}${i + 1}`)}`,
      availabilityZone,
      routeTableId: `rtb-${id17(code, `${tier}${i + 1}`)}`,
    }));
  return {
    mode: 'import',
    vpc: {
      vpcId: `vpc-${id17(code, '1')}`,
      vpcCidrBlock: '10.0.0.0/16',
      appSubnets: subnets('a'),
      dataSubnets: subnets('d'),
    },
    kms: {
      dataKeyArn: `arn:aws:kms:${region}:${PLACEHOLDER_ACCOUNT_ID}:key/${uuid(code, 'd01')}`,
      logsKeyArn: `arn:aws:kms:${region}:${PLACEHOLDER_ACCOUNT_ID}:key/${uuid(code, 'd02')}`,
    },
    permissionsBoundaryPolicyArn: `arn:aws:iam::${PLACEHOLDER_ACCOUNT_ID}:policy/STARTER-PLACEHOLDER-PermissionsBoundary`,
    logging: {
      accessLogsBucketName: `starter-placeholder-${envName}-access-logs-${PLACEHOLDER_ACCOUNT_ID}`,
    },
    edge: placeholderEdge(code, envName, region),
    mandatoryTags: {},
  };
}
