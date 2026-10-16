import type * as acm from 'aws-cdk-lib/aws-certificatemanager';
import type * as ec2 from 'aws-cdk-lib/aws-ec2';
import type * as iam from 'aws-cdk-lib/aws-iam';
import type * as kms from 'aws-cdk-lib/aws-kms';
import type * as route53 from 'aws-cdk-lib/aws-route53';
import type * as s3 from 'aws-cdk-lib/aws-s3';

/**
 * The landing-zone ("foundation") resources this application consumes but
 * never owns. In staging/prod every member is IMPORTED by ID/ARN (offline-safe,
 * no lookups); only the opt-in sandbox creates a minimal VPC/KMS/log bucket.
 *
 * Assumptions (verify per organization, see docs/landing-zone-adaptation.md):
 *  - app subnets are private with egress via landing-zone-controlled paths (or VPC
 *    endpoints) to AWS APIs: ECR, CloudWatch Logs, Secrets Manager, STS,
 *    DynamoDB, Step Functions, KMS, X-Ray;
 *  - data subnets are isolated (no route to the internet);
 *  - the logs key policy allows `logs.<region>.amazonaws.com`;
 *  - the data key policy delegates to IAM in this account (CDK cannot edit
 *    imported key policies);
 *  - the access-logs bucket accepts S3 server access logs, ALB logs and
 *    CloudFront standard logs (SSE-S3, ACLs enabled for CloudFront).
 */
export interface ILandingZoneFoundation {
  readonly mode: 'import' | 'sandbox';
  readonly vpc: ec2.IVpc;
  /** Private application tier: ECS tasks, Lambda ENIs, internal ALB. */
  readonly appSubnets: ec2.SubnetSelection;
  /**
   * Public ingress tier (sandbox foundation only): the internet-facing ALB of the sandbox-only
   * `public-alb-http` API origin. Landing-zone foundations provide none.
   */
  readonly ingressSubnets?: ec2.SubnetSelection;
  /** Isolated data tier: RDS. */
  readonly dataSubnets: ec2.SubnetSelection;
  /** CMK for data at rest (RDS, DynamoDB, Secrets Manager, ECR). */
  readonly dataKey: kms.IKey;
  /** CMK for CloudWatch Logs. */
  readonly logsKey: kms.IKey;
  /**
   * Bucket receiving S3 server access logs, ALB access logs and CloudFront logs. Always set for a
   * landing-zone foundation; absent only in the sandbox (`accessLogs: false`, no access logging).
   */
  readonly accessLogsBucket?: s3.IBucket;
  /** Mandatory permissions boundary for every IAM role (landing-zone requirement). */
  readonly permissionsBoundary?: iam.IManagedPolicy;
  /** HTTPS ALB certificate and origin name (CloudFront VPC origin); absent for `public-alb-http`. */
  readonly albCertificate?: acm.ICertificate;
  readonly apiOriginDomainName?: string;
  readonly cloudFrontCertificate?: acm.ICertificate;
  readonly webDomainName?: string;
  readonly hostedZone?: route53.IHostedZone;
  readonly wafWebAclArn?: string;
  readonly cloudFrontOriginFacingPrefixListId: string;
  readonly mandatoryTags: Readonly<Record<string, string>>;
}
