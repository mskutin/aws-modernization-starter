import type { PolicyRule } from '../types.js';
import { policyDocumentFindings } from './principals.js';
import { asArray, finding, get, isRecord, props } from './util.js';

const BPA_FLAGS = [
  'BlockPublicAcls',
  'BlockPublicPolicy',
  'IgnorePublicAcls',
  'RestrictPublicBuckets',
] as const;

/** BASE-S3-002: bucket policies check principals of Allow statements only (TLS denies use "*"). */
const BUCKET_POLICY = { subject: 'Bucket policy', notPrincipal: 'allow' } as const;

export const s3Rules: PolicyRule[] = [
  {
    id: 'BASE-S3-001',
    title: 'S3 buckets block all public access',
    description:
      'Every S3 bucket sets PublicAccessBlockConfiguration with BlockPublicAcls, BlockPublicPolicy, IgnorePublicAcls and RestrictPublicBuckets all true.',
    rationale:
      'Bucket-level Block Public Access prevents accidental exposure through ACLs or bucket policies, independent of the account-level setting. The SPA bucket is served through CloudFront OAC and never needs public access.',
    severity: 'high',
    engines: ['cdk-nag', 'guard'],
    resourceTypes: ['AWS::S3::Bucket'],
    remediation: 'Set `blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL` on the bucket.',
    notes: 'Overlaps AwsSolutions-S2; kept so the Guard second line covers it independently.',
    evaluate: ({ resource }) => {
      const cfg = props(resource)['PublicAccessBlockConfiguration'];
      if (!isRecord(cfg)) {
        return [
          finding(
            'Properties/PublicAccessBlockConfiguration',
            'PublicAccessBlockConfiguration is missing; all four Block Public Access flags must be true.',
          ),
        ];
      }
      return BPA_FLAGS.filter((flag) => cfg[flag] !== true).map((flag) =>
        finding(
          `Properties/PublicAccessBlockConfiguration/${flag}`,
          `${flag} must be true to block public access.`,
        ),
      );
    },
  },
  {
    id: 'BASE-S3-002',
    title: 'Bucket policies never allow anonymous principals',
    description:
      'No AWS::S3::BucketPolicy Allow statement grants access to an anonymous principal. Fail closed (allowlist shared with BASE-IAM-006): every Allow statement Principal is a map of AWS/Service/Federated/CanonicalUser whose values are literal strings without `*`/`?` or ARN-building intrinsics (Ref to AWS::AccountId/Partition/Region/URLSuffix or an IAM OIDC/SAML provider, Fn::GetAtt Arn of an AWS::IAM::Role/User, Fn::Join with a literal "arn:" prefix, string-form Fn::Sub starting with "arn:" using only those pseudo parameters; any other resource type, including custom and third-party types, fails). `Principal: "*"` fails even with conditions. Any other shape, NotPrincipal in an Allow statement, a non-literal statement or Effect is a finding.',
    rationale:
      'An Allow to `*` makes objects readable or writable by anyone on the internet. Service access (e.g. CloudFront OAC) must use a service principal scoped with aws:SourceArn. Values the rule cannot prove safe offline are rejected rather than skipped.',
    severity: 'critical',
    engines: ['cdk-nag', 'guard'],
    resourceTypes: ['AWS::S3::BucketPolicy'],
    remediation:
      'Grant access to a specific principal (e.g. `cloudfront.amazonaws.com` with an `AWS:SourceArn` condition via S3BucketOrigin.withOriginAccessControl). A legitimate shape outside the allowlist needs a governed exception.',
    notes:
      'Fail closed: an earlier Guard rule compared intrinsic principals (e.g. the CDK auto-delete-objects provider role ARN) with "*" and failed them, while cdk-nag accepted any intrinsic. Deny statements are not checked.',
    evaluate: ({ resource, template }) =>
      policyDocumentFindings(
        props(resource)['PolicyDocument'],
        'Properties/PolicyDocument',
        template,
        BUCKET_POLICY,
      ),
  },
  {
    id: 'BASE-S3-003',
    title: 'Bucket policies deny non-TLS requests',
    description:
      'Every AWS::S3::BucketPolicy contains a Deny statement conditioned on `aws:SecureTransport` = false.',
    rationale:
      'Enforces encryption in transit for all S3 API calls, including those from inside the VPC.',
    severity: 'high',
    engines: ['cdk-nag', 'guard'],
    resourceTypes: ['AWS::S3::BucketPolicy'],
    remediation: 'Set `enforceSSL: true` on the bucket (CDK adds the Deny statement).',
    notes:
      'Buckets without any bucket policy are not detected by this rule; AwsSolutions-S10 covers that case at synth time.',
    evaluate: ({ resource }) => {
      const statements = asArray(get(props(resource), 'PolicyDocument', 'Statement'));
      const enforces = statements.some((stmt) => {
        if (!isRecord(stmt) || stmt['Effect'] !== 'Deny') return false;
        const v = get(stmt, 'Condition', 'Bool', 'aws:SecureTransport');
        return v === 'false' || v === false;
      });
      return enforces
        ? []
        : [
            finding(
              'Properties/PolicyDocument/Statement',
              'No Deny statement with Condition Bool aws:SecureTransport=false.',
            ),
          ];
    },
  },
];
