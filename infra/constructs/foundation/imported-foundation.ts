import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import type {
  EdgeConfig,
  ImportedFoundationConfig,
  SandboxEdgeConfig,
} from '../../environments/schema.js';
import type { ILandingZoneFoundation } from './types.js';

export interface ImportedEdge {
  /** Absent only for the sandbox-only `public-alb-http` API origin (no HTTPS listener). */
  readonly albCertificate?: acm.ICertificate;
  readonly apiOriginDomainName?: string;
  readonly cloudFrontCertificate?: acm.ICertificate;
  readonly webDomainName?: string;
  readonly hostedZone?: route53.IHostedZone;
  readonly wafWebAclArn?: string;
  readonly cloudFrontOriginFacingPrefixListId: string;
}

/** Imports DNS/certificates/WAF references. Offline-safe (no lookups). */
export function importEdge(scope: Construct, edge: EdgeConfig | SandboxEdgeConfig): ImportedEdge {
  return {
    albCertificate: edge.albCertificateArn
      ? acm.Certificate.fromCertificateArn(scope, 'AlbCertificate', edge.albCertificateArn)
      : undefined,
    apiOriginDomainName: edge.apiOriginDomainName,
    cloudFrontCertificate: edge.cloudFrontCertificateArn
      ? acm.Certificate.fromCertificateArn(
          scope,
          'CloudFrontCertificate',
          edge.cloudFrontCertificateArn,
        )
      : undefined,
    webDomainName: edge.webDomainName,
    hostedZone: edge.hostedZone
      ? route53.PublicHostedZone.fromHostedZoneAttributes(scope, 'HostedZone', {
          hostedZoneId: edge.hostedZone.hostedZoneId,
          zoneName: edge.hostedZone.zoneName,
        })
      : undefined,
    wafWebAclArn: edge.wafWebAclArn,
    cloudFrontOriginFacingPrefixListId: edge.cloudFrontOriginFacingPrefixListId,
  };
}

/**
 * Landing-zone resources imported by ID/ARN. Creates no AWS resources and
 * performs no lookups, so synth works without credentials. Instantiate once
 * per stack that needs the foundation (imports are free).
 */
export class ImportedLandingZoneFoundation extends Construct implements ILandingZoneFoundation {
  public readonly mode = 'import' as const;
  public readonly vpc: ec2.IVpc;
  public readonly appSubnets: ec2.SubnetSelection;
  public readonly dataSubnets: ec2.SubnetSelection;
  public readonly dataKey: kms.IKey;
  public readonly logsKey: kms.IKey;
  public readonly accessLogsBucket: s3.IBucket;
  public readonly permissionsBoundary: iam.IManagedPolicy;
  public readonly albCertificate: acm.ICertificate;
  public readonly apiOriginDomainName: string;
  public readonly cloudFrontCertificate?: acm.ICertificate;
  public readonly webDomainName?: string;
  public readonly hostedZone?: route53.IHostedZone;
  public readonly wafWebAclArn?: string;
  public readonly cloudFrontOriginFacingPrefixListId: string;
  public readonly mandatoryTags: Readonly<Record<string, string>>;

  constructor(scope: Construct, id: string, config: ImportedFoundationConfig) {
    super(scope, id);
    const byAz = <T extends { availabilityZone: string }>(subnets: readonly T[]) =>
      [...subnets].sort((a, b) => a.availabilityZone.localeCompare(b.availabilityZone));
    const app = byAz(config.vpc.appSubnets);
    const data = byAz(config.vpc.dataSubnets);

    this.vpc = ec2.Vpc.fromVpcAttributes(this, 'Vpc', {
      vpcId: config.vpc.vpcId,
      vpcCidrBlock: config.vpc.vpcCidrBlock,
      availabilityZones: app.map((s) => s.availabilityZone),
      privateSubnetIds: app.map((s) => s.subnetId),
      privateSubnetRouteTableIds: app.map((s) => s.routeTableId),
      isolatedSubnetIds: data.map((s) => s.subnetId),
      isolatedSubnetRouteTableIds: data.map((s) => s.routeTableId),
    });
    this.appSubnets = { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS };
    this.dataSubnets = { subnetType: ec2.SubnetType.PRIVATE_ISOLATED };

    this.dataKey = kms.Key.fromKeyArn(this, 'DataKey', config.kms.dataKeyArn);
    this.logsKey = kms.Key.fromKeyArn(this, 'LogsKey', config.kms.logsKeyArn);
    this.accessLogsBucket = s3.Bucket.fromBucketName(
      this,
      'AccessLogsBucket',
      config.logging.accessLogsBucketName,
    );
    this.permissionsBoundary = iam.ManagedPolicy.fromManagedPolicyArn(
      this,
      'PermissionsBoundary',
      config.permissionsBoundaryPolicyArn,
    );

    const edge = importEdge(this, config.edge);
    // A landing-zone foundation always has both (EdgeSchema requires them).
    if (!edge.albCertificate) throw new Error('ImportedLandingZoneFoundation: no ALB certificate');
    this.albCertificate = edge.albCertificate;
    this.apiOriginDomainName = config.edge.apiOriginDomainName;
    this.cloudFrontCertificate = edge.cloudFrontCertificate;
    this.webDomainName = edge.webDomainName;
    this.hostedZone = edge.hostedZone;
    this.wafWebAclArn = edge.wafWebAclArn;
    this.cloudFrontOriginFacingPrefixListId = edge.cloudFrontOriginFacingPrefixListId;
    this.mandatoryTags = config.mandatoryTags;
  }
}
