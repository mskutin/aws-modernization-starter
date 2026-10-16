import { CfnOutput } from 'aws-cdk-lib';
import type * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import type { Construct } from 'constructs';
import { TestIssuerHosting } from '../constructs/test-issuer.js';
import { manageCustomResourceProviders } from '../lib/custom-resource-providers.js';
import { WorkloadStack, type WorkloadStackProps } from './workload-stack.js';

export type TestIssuerStackProps = Omit<WorkloadStackProps, 'suffix' | 'description'>;

/**
 * SANDBOX ONLY (live validation, never a governed environment): the stage-hosted test issuer
 * (`Sandbox-TestIssuer`). Created only when `auth.testIssuer` is set; the
 * API task environment and the SPA `/config.json` take the issuer from it. No dependency on any
 * other stack except the foundation (log key of the bucket's auto-delete provider), so it deploys
 * first and the lifecycle script uploads the issuer documents before the API starts.
 */
export class TestIssuerStack extends WorkloadStack {
  public readonly issuer: TestIssuerHosting;

  constructor(scope: Construct, id: string, props: TestIssuerStackProps) {
    super(scope, id, {
      ...props,
      suffix: 'test-issuer',
      description:
        'AWS modernization starter: SANDBOX test issuer (OIDC discovery + JWKS), not for governed environments',
    });
    const { config, foundation } = this;

    this.issuer = new TestIssuerHosting(this, 'TestIssuer', {
      resourcePrefix: config.resourcePrefix,
      priceClass: config.frontend.priceClass as cloudfront.PriceClass,
    });
    manageCustomResourceProviders(this, {
      logsKey: foundation.logsKey,
      retention: this.logRetention,
      removalPolicy: this.logRemovalPolicy,
    });

    new CfnOutput(this, 'IssuerUrl', { value: this.issuer.issuerUrl });
    new CfnOutput(this, 'IssuerBucketName', { value: this.issuer.bucket.bucketName });
    new CfnOutput(this, 'IssuerDistributionId', {
      value: this.issuer.distribution.distributionId,
    });
  }
}
