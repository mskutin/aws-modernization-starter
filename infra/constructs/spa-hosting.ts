import { Duration, RemovalPolicy, Token } from 'aws-cdk-lib';
import type * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import type * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { acknowledgeAnnotation, acknowledgeRule } from '../lib/policy-hook.js';

/** Path pattern routed to the API so the browser stays same-origin. */
export const API_PATH_PATTERN = '/v1/*';
/**
 * Health endpoints, routed to the API only for the sandbox-only public HTTP origin (its ALB is not
 * reachable directly, so smoke checks go through CloudFront).
 */
export const HEALTH_PATH_PATTERN = '/health/*';

/**
 * Viewer-request rewrite for client-side routes: any path whose last segment
 * has no file extension is served `/index.html`. Attached ONLY to the default
 * (S3) behaviour, so API 404s under `/v1/*` are never masked (unlike global
 * custom error responses).
 */
export const SPA_REWRITE_FUNCTION_CODE = `function handler(event) {
  var request = event.request;
  var uri = request.uri;
  var last = uri.substring(uri.lastIndexOf('/') + 1);
  if (uri.endsWith('/') || last.indexOf('.') === -1) {
    request.uri = '/index.html';
  }
  return request;
}`;

/** The SPA's runtime auth configuration (`/config.json`, identity, ADR 0213). */
export interface SpaAuthSettings {
  /** OIDC issuer (https); its exact origin is the only addition to CSP connect-src. */
  readonly issuer: string;
  /** Public client id of the SPA (authorization code + PKCE). */
  readonly clientId: string;
  /** Scopes the SPA requests. */
  readonly scope: string;
}

/** `/config.json` body for the SPA (no secrets: issuer, public client id, scopes). */
export function spaRuntimeConfig(auth: SpaAuthSettings): string {
  return JSON.stringify({
    auth: { issuer: auth.issuer, clientId: auth.clientId, scope: auth.scope },
  });
}

/**
 * The viewer-request function of the default behaviour with the runtime configuration: answers
 * `/config.json` at the edge (one SPA build for every environment, nothing to upload to S3, the
 * value cannot drift from the stack), and otherwise performs the SPA rewrite above.
 */
export function spaViewerRequestFunctionCode(auth?: SpaAuthSettings): string {
  if (!auth) return SPA_REWRITE_FUNCTION_CODE;
  return `var CONFIG_JSON = ${JSON.stringify(spaRuntimeConfig(auth))};
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  if (uri === '/config.json') {
    return {
      statusCode: 200,
      statusDescription: 'OK',
      headers: {
        'content-type': { value: 'application/json' },
        'cache-control': { value: 'no-store' },
        'x-content-type-options': { value: 'nosniff' }
      },
      body: { encoding: 'text', data: CONFIG_JSON }
    };
  }
  var last = uri.substring(uri.lastIndexOf('/') + 1);
  if (uri.endsWith('/') || last.indexOf('.') === -1) {
    request.uri = '/index.html';
  }
  return request;
}`;
}

/**
 * Exact origin of an https URL (scheme://host[:port]). A URL holding a CloudFormation token (the
 * sandbox test issuer, `https://<distribution domain>`) must be exactly `https://<host>`: it is its
 * own origin.
 */
export function originOf(url: string): string {
  if (Token.isUnresolved(url)) {
    if (!/^https:\/\/[^/?#\s]+$/.test(url)) {
      throw new Error(
        `SpaHosting: an unresolved issuer must be exactly https://<host>, got ${url}`,
      );
    }
    return url;
  }
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error(`SpaHosting: ${url} must be an https URL`);
  return parsed.origin;
}

/**
 * The default CSP; with an IdP the SPA also talks to the issuer origin (discovery + token
 * endpoint) — exactly that origin, nothing broader, never `unsafe-*`.
 */
export function contentSecurityPolicy(auth?: SpaAuthSettings): string {
  if (!auth) return DEFAULT_CONTENT_SECURITY_POLICY;
  return DEFAULT_CONTENT_SECURITY_POLICY.replace(
    "connect-src 'self'",
    `connect-src 'self' ${originOf(auth.issuer)}`,
  );
}

export const DEFAULT_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  'upgrade-insecure-requests',
].join('; ');

/** Internal ALB reached through a CloudFront VPC origin for `/v1/*` (governed environments). */
export interface VpcApiOrigin {
  readonly kind?: 'vpc-origin';
  readonly loadBalancer: elbv2.IApplicationLoadBalancer;
  /** Name presented to the ALB (SNI/Host); must match the ALB certificate. */
  readonly domainName: string;
}

/**
 * SANDBOX ONLY (live validation, not a governed environment): internet-facing ALB reached over HTTP for `/v1/*`
 * and `/health/*`; CloudFront adds the per-run origin-verify header to every origin request.
 */
export interface PublicHttpApiOrigin {
  readonly kind: 'public-http';
  /** ALB DNS name. */
  readonly domainName: string;
  readonly verifyHeader: { readonly name: string; readonly value: string };
}

export interface SpaHostingProps {
  readonly resourcePrefix: string;
  /**
   * Destination for S3 server access logs and CloudFront standard logs. Omitted only in the
   * sandbox (no access logging, nothing left after `cdk destroy`).
   */
  readonly accessLogsBucket?: s3.IBucket;
  /**
   * `destroy` (sandbox only): the bucket is emptied and deleted with the stack.
   * @default 'retain'
   */
  readonly teardown?: 'retain' | 'destroy';
  /** The API behind CloudFront (same origin for the browser). */
  readonly apiOrigin?: VpcApiOrigin | PublicHttpApiOrigin;
  readonly domain?: {
    readonly name: string;
    /** us-east-1 ACM certificate (CloudFront requirement). */
    readonly certificate: acm.ICertificate;
    readonly hostedZone?: route53.IHostedZone;
  };
  readonly webAclArn?: string;
  readonly priceClass: cloudfront.PriceClass;
  /** ISO country allowlist; empty for none. */
  readonly geoAllowlist?: readonly string[];
  readonly contentSecurityPolicy?: string;
  /** SPA sign-in configuration (identity): served as /config.json, issuer added to CSP. */
  readonly auth?: SpaAuthSettings;
}

/**
 * SPA hosting: private, versioned S3 bucket reachable only through CloudFront
 * Origin Access Control; HTTPS-only with TLS 1.2 (2021) minimum; security
 * headers; SPA routing via a CloudFront Function; same-origin API behaviour.
 */
export class SpaHosting extends Construct {
  public readonly bucket: s3.Bucket;
  public readonly distribution: cloudfront.Distribution;
  public readonly responseHeadersPolicy: cloudfront.ResponseHeadersPolicy;
  public readonly rewriteFunction: cloudfront.Function;

  constructor(scope: Construct, id: string, props: SpaHostingProps) {
    super(scope, id);
    const destroy = props.teardown === 'destroy';

    this.bucket = new s3.Bucket(this, 'Bucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      minimumTLSVersion: 1.2,
      // Static build artefacts (public by nature) — SSE-S3 keeps OAC simple.
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      ...(props.accessLogsBucket
        ? {
            serverAccessLogsBucket: props.accessLogsBucket,
            serverAccessLogsPrefix: `s3/${props.resourcePrefix}-web/`,
          }
        : {}),
      lifecycleRules: [
        { id: 'expire-noncurrent', noncurrentVersionExpiration: Duration.days(30) },
        { id: 'abort-incomplete-mpu', abortIncompleteMultipartUploadAfter: Duration.days(7) },
      ],
      ...(destroy
        ? { removalPolicy: RemovalPolicy.DESTROY, autoDeleteObjects: true }
        : { removalPolicy: RemovalPolicy.RETAIN }),
    });

    if (!props.accessLogsBucket) {
      acknowledgeRule(
        this.bucket,
        'AwsSolutions-S1',
        'SANDBOX (live validation, not a governed environment): the ephemeral sandbox has no access-log bucket, so nothing survives cdk destroy.',
      );
    } else if (!(props.accessLogsBucket instanceof s3.Bucket)) {
      acknowledgeAnnotation(
        this.bucket,
        '@aws-cdk/aws-s3:accessLogsPolicyNotAdded',
        'The access-log bucket is owned by the landing-zone foundation (or the sandbox foundation stack), whose bucket policy pre-authorises logging.s3.amazonaws.com for this account.',
      );
    }

    this.rewriteFunction = new cloudfront.Function(this, 'SpaRewrite', {
      functionName: `${props.resourcePrefix}-spa-rewrite`,
      comment: 'Rewrite extension-less paths to /index.html (default behaviour only)',
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(spaViewerRequestFunctionCode(props.auth)),
    });

    this.responseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      responseHeadersPolicyName: `${props.resourcePrefix}-security-headers`,
      comment: 'Security headers for SPA and API responses',
      securityHeadersBehavior: {
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(730),
          includeSubdomains: true,
          preload: false,
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
        contentSecurityPolicy: {
          contentSecurityPolicy: props.contentSecurityPolicy ?? contentSecurityPolicy(props.auth),
          override: true,
        },
        xssProtection: { protection: false, override: true },
      },
      customHeadersBehavior: {
        customHeaders: [
          {
            header: 'Permissions-Policy',
            value: 'camera=(), geolocation=(), microphone=()',
            override: true,
          },
          { header: 'Cross-Origin-Opener-Policy', value: 'same-origin', override: true },
        ],
      },
      removeHeaders: ['Server', 'X-Powered-By'],
    });

    const additionalBehaviors: Record<string, cloudfront.BehaviorOptions> = {};
    const api = props.apiOrigin;
    if (api) {
      const apiBehavior: cloudfront.BehaviorOptions = {
        origin:
          api.kind === 'public-http'
            ? new origins.HttpOrigin(api.domainName, {
                protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
                httpPort: 80,
                readTimeout: Duration.seconds(30),
                customHeaders: { [api.verifyHeader.name]: api.verifyHeader.value },
              })
            : origins.VpcOrigin.withApplicationLoadBalancer(api.loadBalancer, {
                domainName: api.domainName,
                protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
                originSslProtocols: [cloudfront.OriginSslPolicy.TLS_V1_2],
                httpsPort: 443,
                readTimeout: Duration.seconds(30),
                vpcOriginName: `${props.resourcePrefix}-api`,
              }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        // Identity: the API authenticates every request with the bearer token. Forwarding
        // ALL viewer headers (except Host) forwards `Authorization` on every method, and
        // CachingDisabled guarantees no per-user response is ever served from the edge cache
        // (the CloudFront-documented combination; not validated on AWS).
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        responseHeadersPolicy: this.responseHeadersPolicy,
        compress: true,
      };
      additionalBehaviors[API_PATH_PATTERN] = apiBehavior;
      if (api.kind === 'public-http') additionalBehaviors[HEALTH_PATH_PATTERN] = apiBehavior;
    }

    const geo = props.geoAllowlist ?? [];
    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `${props.resourcePrefix} SPA + same-origin API`,
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.bucket, {
          originAccessLevels: [cloudfront.AccessLevel.READ],
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: this.responseHeadersPolicy,
        functionAssociations: [
          {
            function: this.rewriteFunction,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
        compress: true,
      },
      additionalBehaviors,
      // Viewer TLS settings apply to a custom certificate only (the default *.cloudfront.net
      // certificate ignores them).
      ...(props.domain
        ? {
            domainNames: [props.domain.name],
            certificate: props.domain.certificate,
            minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
            sslSupportMethod: cloudfront.SSLMethod.SNI,
          }
        : {}),
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      enableIpv6: true,
      priceClass: props.priceClass,
      webAclId: props.webAclArn,
      ...(geo.length > 0 ? { geoRestriction: cloudfront.GeoRestriction.allowlist(...geo) } : {}),
      ...(props.accessLogsBucket
        ? {
            enableLogging: true,
            logBucket: props.accessLogsBucket,
            logFilePrefix: `cloudfront/${props.resourcePrefix}/`,
            logIncludesCookies: false,
          }
        : { enableLogging: false }),
    });

    if (props.domain?.hostedZone) {
      const target = route53.RecordTarget.fromAlias(
        new targets.CloudFrontTarget(this.distribution),
      );
      new route53.ARecord(this, 'AliasA', {
        zone: props.domain.hostedZone,
        recordName: props.domain.name,
        target,
      });
      new route53.AaaaRecord(this, 'AliasAAAA', {
        zone: props.domain.hostedZone,
        recordName: props.domain.name,
        target,
      });
    }

    // --- Policy acknowledgments -----------------------------------------
    if (geo.length === 0) {
      acknowledgeRule(
        this.distribution,
        'AwsSolutions-CFR1',
        'No geo restriction by default: the service is public-facing; organizations set frontend.geoAllowlist where policy requires it.',
      );
    }
    if (!props.webAclArn) {
      acknowledgeRule(
        this.distribution,
        'AwsSolutions-CFR2',
        'No WAF in the opt-in sandbox; the config schema requires the platform-managed CLOUDFRONT web ACL in staging and prod.',
      );
    }
    if (api?.kind === 'public-http') {
      acknowledgeRule(
        this.distribution,
        'AwsSolutions-CFR5',
        'SANDBOX (live validation, not a governed environment): HTTP to the internet-facing ALB, guarded by the CloudFront origin-facing prefix list and the X-Origin-Verify header.',
      );
    }
    if (!props.accessLogsBucket) {
      acknowledgeRule(
        this.distribution,
        'AwsSolutions-CFR3',
        'SANDBOX (live validation, not a governed environment): the ephemeral sandbox has no access-log bucket, so nothing survives cdk destroy.',
      );
    }
    if (!props.domain) {
      acknowledgeRule(
        this.distribution,
        'AwsSolutions-CFR4',
        'Sandbox without a custom domain uses the default *.cloudfront.net certificate, for which CloudFront cannot enforce a minimum TLS policy; custom domains (required outside sandboxes) use TLSv1.2_2021.',
      );
    }
  }
}
