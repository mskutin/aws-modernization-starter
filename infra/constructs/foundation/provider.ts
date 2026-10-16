import { Stack, type StackProps } from 'aws-cdk-lib';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import type { FoundationConfig } from '../../environments/schema.js';
import { ImportedLandingZoneFoundation } from './imported-foundation.js';
import { SandboxFoundation, type SandboxFoundationProps } from './sandbox-foundation.js';
import type { ILandingZoneFoundation } from './types.js';

/**
 * Hands each stack its view of the foundation:
 *  - import mode : an `ImportedLandingZoneFoundation` created inside that stack
 *    (pure references, no cross-stack exports);
 *  - sandbox mode: the resources of the shared `SandboxFoundationStack`, with
 *    the KMS keys and access-log bucket re-imported per stack so consumers
 *    never edit the producer's key/bucket policies (which would create
 *    dependency cycles) — the same semantics as imported landing-zone resources.
 */
export interface FoundationProvider {
  readonly mode: 'import' | 'sandbox';
  forStack(stack: Stack): ILandingZoneFoundation;
}

export class ImportedFoundationProvider implements FoundationProvider {
  public readonly mode = 'import' as const;
  private readonly cache = new Map<Stack, ILandingZoneFoundation>();

  constructor(private readonly config: Extract<FoundationConfig, { mode: 'import' }>) {}

  public forStack(stack: Stack): ILandingZoneFoundation {
    let foundation = this.cache.get(stack);
    if (!foundation) {
      foundation = new ImportedLandingZoneFoundation(stack, 'LandingZoneFoundation', this.config);
      this.cache.set(stack, foundation);
    }
    return foundation;
  }
}

export interface SandboxFoundationStackProps extends StackProps, SandboxFoundationProps {}

export class SandboxFoundationStack extends Stack {
  public readonly foundation: SandboxFoundation;
  private readonly explicitAzs: string[];

  constructor(scope: Construct, id: string, props: SandboxFoundationStackProps) {
    super(scope, id, props);
    this.explicitAzs = [...props.config.availabilityZones];
    this.foundation = new SandboxFoundation(this, 'SandboxFoundation', props);
  }

  /** Explicit AZs: prevents the `availability-zones` context lookup (offline synth). */
  public override get availabilityZones(): string[] {
    return this.explicitAzs;
  }
}

export class SandboxFoundationProvider implements FoundationProvider {
  public readonly mode = 'sandbox' as const;
  private readonly cache = new Map<Stack, ILandingZoneFoundation>();

  constructor(private readonly foundationStack: SandboxFoundationStack) {}

  public forStack(stack: Stack): ILandingZoneFoundation {
    if (stack === this.foundationStack) return this.foundationStack.foundation;
    let view = this.cache.get(stack);
    if (!view) {
      const f = this.foundationStack.foundation;
      const accessLogsBucket = f.accessLogsBucket
        ? s3.Bucket.fromBucketAttributes(stack, 'SandboxAccessLogsBucket', {
            bucketName: f.accessLogsBucket.bucketName,
            bucketArn: f.accessLogsBucket.bucketArn,
            bucketRegionalDomainName: f.accessLogsBucket.bucketRegionalDomainName,
          })
        : undefined;
      stack.addStackDependency(this.foundationStack);
      view = {
        mode: f.mode,
        vpc: f.vpc,
        appSubnets: f.appSubnets,
        ingressSubnets: f.ingressSubnets,
        dataSubnets: f.dataSubnets,
        dataKey: kms.Key.fromKeyArn(stack, 'SandboxDataKey', f.dataKey.keyArn),
        logsKey: kms.Key.fromKeyArn(stack, 'SandboxLogsKey', f.logsKey.keyArn),
        accessLogsBucket,
        permissionsBoundary: f.permissionsBoundary,
        albCertificate: f.albCertificate,
        apiOriginDomainName: f.apiOriginDomainName,
        cloudFrontCertificate: f.cloudFrontCertificate,
        webDomainName: f.webDomainName,
        hostedZone: f.hostedZone,
        wafWebAclArn: f.wafWebAclArn,
        cloudFrontOriginFacingPrefixListId: f.cloudFrontOriginFacingPrefixListId,
        mandatoryTags: f.mandatoryTags,
      };
      this.cache.set(stack, view);
    }
    return view;
  }
}
