import { CfnOutput } from 'aws-cdk-lib';
import type * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import type * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import type { Construct } from 'constructs';
import { ORIGIN_VERIFY_HEADER } from '../constructs/api-service.js';
import { SpaHosting, type SpaHostingProps } from '../constructs/spa-hosting.js';
import { manageCustomResourceProviders } from '../lib/custom-resource-providers.js';
import type { IssuerEndpoints } from './api-stack.js';
import { WorkloadStack, type WorkloadStackProps } from './workload-stack.js';

export interface FrontendStackProps extends Omit<WorkloadStackProps, 'suffix' | 'description'> {
  readonly apiLoadBalancer: elbv2.IApplicationLoadBalancer;
  /** Issuer for `/config.json` and CSP (stage-resolved: `config.auth`, or the test issuer). */
  readonly identity: IssuerEndpoints;
  /** Per-run X-Origin-Verify value; required for the sandbox-only `public-alb-http` origin. */
  readonly originVerifySecret?: string;
}

/** Edge tier: private S3 + CloudFront (OAC) with `/v1/*` routed to the internal ALB. */
export class FrontendStack extends WorkloadStack {
  public readonly spa: SpaHosting;

  constructor(scope: Construct, id: string, props: FrontendStackProps) {
    super(scope, id, {
      ...props,
      suffix: 'frontend',
      description: 'AWS modernization starter: SPA hosting and edge',
    });
    const { config, foundation } = this;
    let apiOrigin: SpaHostingProps['apiOrigin'];
    if (config.api.originMode === 'public-alb-http') {
      if (!props.originVerifySecret) {
        throw new Error('FrontendStack: public-alb-http needs originVerifySecret');
      }
      apiOrigin = {
        kind: 'public-http',
        domainName: props.apiLoadBalancer.loadBalancerDnsName,
        verifyHeader: { name: ORIGIN_VERIFY_HEADER, value: props.originVerifySecret },
      };
    } else {
      if (!foundation.apiOriginDomainName) {
        throw new Error('FrontendStack: the VPC origin needs foundation.edge.apiOriginDomainName');
      }
      apiOrigin = {
        loadBalancer: props.apiLoadBalancer,
        domainName: foundation.apiOriginDomainName,
      };
    }

    this.spa = new SpaHosting(this, 'SpaHosting', {
      resourcePrefix: config.resourcePrefix,
      accessLogsBucket: foundation.accessLogsBucket,
      teardown: config.teardown,
      apiOrigin,
      domain:
        foundation.webDomainName && foundation.cloudFrontCertificate
          ? {
              name: foundation.webDomainName,
              certificate: foundation.cloudFrontCertificate,
              hostedZone: foundation.hostedZone,
            }
          : undefined,
      webAclArn: foundation.wafWebAclArn,
      priceClass: config.frontend.priceClass as cloudfront.PriceClass,
      geoAllowlist: config.frontend.geoAllowlist,
      // Identity: SPA sign-in configuration (/config.json) and the issuer in CSP.
      auth: {
        issuer: props.identity.issuer,
        clientId: config.auth.spaClientId,
        scope: config.auth.spaScope,
      },
    });
    if (config.teardown === 'destroy') {
      // The bucket's auto-delete provider: managed log group, deleted with the stack.
      manageCustomResourceProviders(this, {
        logsKey: foundation.logsKey,
        retention: this.logRetention,
        removalPolicy: this.logRemovalPolicy,
      });
    }

    new CfnOutput(this, 'WebBucketName', { value: this.spa.bucket.bucketName });
    new CfnOutput(this, 'DistributionId', { value: this.spa.distribution.distributionId });
    new CfnOutput(this, 'DistributionDomainName', {
      value: this.spa.distribution.distributionDomainName,
    });
    new CfnOutput(this, 'WebUrl', {
      value: `https://${foundation.webDomainName ?? this.spa.distribution.distributionDomainName}`,
    });
  }
}
