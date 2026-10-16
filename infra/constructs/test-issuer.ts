import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { acknowledgeRule } from '../lib/policy-hook.js';

/** OIDC discovery document key (served at `/.well-known/openid-configuration`). */
export const ISSUER_DISCOVERY_KEY = '.well-known/openid-configuration';
/** JWKS key (served at `/jwks.json`); `jwks_uri` of the discovery document. */
export const ISSUER_JWKS_KEY = 'jwks.json';

export interface TestIssuerHostingProps {
  readonly resourcePrefix: string;
  readonly priceClass: cloudfront.PriceClass;
}

/**
 * SANDBOX ONLY (live validation, not a governed environment): the public half of the
 * test identity provider. A private S3 bucket behind CloudFront (Origin Access Control, HTTPS
 * only, default *.cloudfront.net certificate) serves exactly two public documents that the
 * lifecycle script uploads with `content-type: application/json`:
 *
 *  - `/.well-known/openid-configuration` (issuer `https://<domain>`, `jwks_uri` …/jwks.json)
 *  - `/jwks.json` (public ES256 keys only)
 *
 * The private key never leaves the operator host and there is no token endpoint here: tokens are
 * minted by the local test IdP. No SPA rewrite, caching disabled (a key rotation is visible
 * immediately), CORS `*` without credentials so the SPA can run OIDC discovery from the browser
 * (both documents are public by design). The bucket is emptied and deleted with the stack.
 */
export class TestIssuerHosting extends Construct {
  public readonly bucket: s3.Bucket;
  public readonly distribution: cloudfront.Distribution;
  public readonly headers: cloudfront.ResponseHeadersPolicy;
  /** `https://<distribution domain>` — the exact `iss` (CloudFormation token). */
  public readonly issuerUrl: string;
  /** `https://<distribution domain>/jwks.json`. */
  public readonly jwksUri: string;

  constructor(scope: Construct, id: string, props: TestIssuerHostingProps) {
    super(scope, id);

    this.bucket = new s3.Bucket(this, 'Bucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      minimumTLSVersion: 1.2,
      encryption: s3.BucketEncryption.S3_MANAGED,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Found during live validation: the managed CORS-and-SecurityHeadersPolicy (empty allow-headers list)
    // omits Access-Control-Allow-Origin when the request carries any further header, and Chromium
    // sends `priority: u=1, i` on every fetch, so browsers could not read the discovery document
    // while curl could. Explicit CORS for any request header, origin override, same security
    // headers.
    this.headers = new cloudfront.ResponseHeadersPolicy(this, 'Headers', {
      responseHeadersPolicyName: `${props.resourcePrefix}-issuer-headers`,
      comment: 'SANDBOX test issuer: public CORS for discovery + JWKS, security headers',
      corsBehavior: {
        accessControlAllowOrigins: ['*'],
        accessControlAllowHeaders: ['*'],
        accessControlAllowMethods: ['GET', 'HEAD'],
        accessControlAllowCredentials: false,
        accessControlMaxAge: Duration.minutes(10),
        originOverride: true,
      },
      securityHeadersBehavior: {
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.SAMEORIGIN, override: true },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: false,
        },
        strictTransportSecurity: { accessControlMaxAge: Duration.days(365), override: false },
        xssProtection: { protection: true, modeBlock: true, override: false },
      },
    });
    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `${props.resourcePrefix} SANDBOX test issuer (OIDC discovery + JWKS), not for governed environments`,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.bucket, {
          originAccessLevels: [cloudfront.AccessLevel.READ],
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        responseHeadersPolicy: this.headers,
        compress: true,
      },
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      enableIpv6: true,
      priceClass: props.priceClass,
      enableLogging: false,
    });

    this.issuerUrl = `https://${this.distribution.distributionDomainName}`;
    this.jwksUri = `${this.issuerUrl}/${ISSUER_JWKS_KEY}`;

    const sandbox = 'SANDBOX (live validation, not a governed environment):';
    acknowledgeRule(
      this.bucket,
      'AwsSolutions-S1',
      `${sandbox} two public documents; no access-log bucket in the ephemeral sandbox.`,
    );
    for (const [rule, why] of [
      ['AwsSolutions-CFR1', 'public OIDC metadata, no geo restriction.'],
      ['AwsSolutions-CFR2', 'no WAF in the sandbox; static public documents only.'],
      ['AwsSolutions-CFR3', 'no access-log bucket in the ephemeral sandbox.'],
      ['AwsSolutions-CFR4', 'default *.cloudfront.net certificate, no custom domain.'],
    ] as const) {
      acknowledgeRule(this.distribution, rule, `${sandbox} ${why}`);
    }
  }
}
