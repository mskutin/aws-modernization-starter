import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { describe, expect, it } from 'vitest';
import {
  API_PATH_PATTERN,
  DEFAULT_CONTENT_SECURITY_POLICY,
  SPA_REWRITE_FUNCTION_CODE,
  SpaHosting,
  contentSecurityPolicy,
  originOf,
  spaViewerRequestFunctionCode,
} from '../constructs/spa-hosting.js';
import { importedFoundation, nagViolations, resourcesOf, testStack } from './helpers.js';

type Variant = 'governed' | 'sandbox';

function build(variant: Variant) {
  const stack = testStack();
  const f = importedFoundation(stack);
  const alb = new elbv2.ApplicationLoadBalancer(stack, 'Alb', {
    vpc: f.vpc,
    vpcSubnets: f.appSubnets,
    internetFacing: false,
    securityGroup: new ec2.SecurityGroup(stack, 'AlbSg', { vpc: f.vpc }),
  });
  const governed = variant === 'governed';
  const spa = new SpaHosting(stack, 'Spa', {
    resourcePrefix: 'starter-test',
    accessLogsBucket: f.accessLogsBucket,
    apiOrigin: { loadBalancer: alb, domainName: 'api-origin.test.example.com' },
    domain: governed
      ? {
          name: 'app.test.example.com',
          certificate: acm.Certificate.fromCertificateArn(
            stack,
            'Cf',
            'arn:aws:acm:us-east-1:000000000000:certificate/00000000-0000-4000-8000-000000000001',
          ),
          hostedZone: f.hostedZone,
        }
      : undefined,
    webAclArn: governed ? f.wafWebAclArn : undefined,
    priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
    geoAllowlist: governed ? ['US'] : [],
  });
  return { stack, f, spa, template: Template.fromStack(stack) };
}

const distributionConfig = (template: Template) =>
  resourcesOf(template, 'AWS::CloudFront::Distribution')[0]![1].DistributionConfig as Record<
    string,
    unknown
  > & {
    DefaultCacheBehavior: Record<string, unknown>;
    CacheBehaviors: Record<string, unknown>[];
    Origins: Record<string, unknown>[];
  };

describe('SpaHosting', () => {
  const { stack, template, f } = build('governed');
  const cfg = distributionConfig(template);

  it('private bucket: block public access, SSL-only, encrypted, versioned, access-logged', () => {
    template.hasResource('AWS::S3::Bucket', {
      DeletionPolicy: 'Retain',
      Properties: Match.objectLike({
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
          ],
        },
        VersioningConfiguration: { Status: 'Enabled' },
        LoggingConfiguration: {
          DestinationBucketName: f.accessLogsBucket.bucketName,
          LogFilePrefix: 's3/starter-test-web/',
        },
        OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
      }),
    });
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
        ]),
      },
    });
  });

  it('S3 origin uses Origin Access Control (no OAI), bucket readable only by this distribution', () => {
    template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
    template.resourceCountIs('AWS::CloudFront::CloudFrontOriginAccessIdentity', 0);
    const s3Origin = cfg.Origins.find((o) => 'S3OriginConfig' in o)!;
    expect(s3Origin.OriginAccessControlId).toBeDefined();
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 's3:GetObject',
            Principal: { Service: 'cloudfront.amazonaws.com' },
            Condition: { StringEquals: { 'AWS:SourceArn': Match.anyValue() } },
          }),
        ]),
      },
    });
  });

  it('HTTPS only with TLS 1.2 (2021) minimum on a us-east-1 certificate', () => {
    expect(cfg.DefaultCacheBehavior.ViewerProtocolPolicy).toBe('redirect-to-https');
    expect(cfg.ViewerCertificate).toMatchObject({
      MinimumProtocolVersion: 'TLSv1.2_2021',
      SslSupportMethod: 'sni-only',
      AcmCertificateArn: expect.stringContaining(':acm:us-east-1:'),
    });
    expect(cfg.Aliases).toEqual(['app.test.example.com']);
  });

  it('security headers policy on every behaviour', () => {
    template.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: Match.objectLike({
          StrictTransportSecurity: Match.objectLike({
            AccessControlMaxAgeSec: 63072000,
            IncludeSubdomains: true,
          }),
          ContentTypeOptions: { Override: true },
          FrameOptions: { FrameOption: 'DENY', Override: true },
          ContentSecurityPolicy: Match.objectLike({
            ContentSecurityPolicy: Match.stringLikeRegexp("frame-ancestors 'none'"),
          }),
        }),
      }),
    });
    expect(cfg.DefaultCacheBehavior.ResponseHeadersPolicyId).toBeDefined();
    expect(cfg.CacheBehaviors[0]!.ResponseHeadersPolicyId).toEqual(
      cfg.DefaultCacheBehavior.ResponseHeadersPolicyId,
    );
  });

  it('SPA routing via a CloudFront Function on the DEFAULT behaviour only; no global error responses', () => {
    expect(cfg.CustomErrorResponses).toBeUndefined();
    expect(cfg.DefaultCacheBehavior.FunctionAssociations).toEqual([
      { EventType: 'viewer-request', FunctionARN: expect.anything() },
    ]);
    expect(cfg.CacheBehaviors[0]!.FunctionAssociations).toBeUndefined();
    template.hasResourceProperties('AWS::CloudFront::Function', {
      FunctionConfig: Match.objectLike({ Runtime: 'cloudfront-js-2.0' }),
      FunctionCode: SPA_REWRITE_FUNCTION_CODE,
    });
  });

  it('the rewrite function maps client routes to /index.html and leaves assets alone', () => {
    const handler = new Function(`${SPA_REWRITE_FUNCTION_CODE}; return handler;`)() as (e: {
      request: { uri: string };
    }) => { uri: string };
    const rewrite = (uri: string) => handler({ request: { uri } }).uri;
    expect(rewrite('/')).toBe('/index.html');
    expect(rewrite('/jobs')).toBe('/index.html');
    expect(rewrite('/jobs/123/')).toBe('/index.html');
    expect(rewrite('/assets/app.3f2a.js')).toBe('/assets/app.3f2a.js');
    expect(rewrite('/favicon.ico')).toBe('/favicon.ico');
  });

  it('/v1/* goes to the internal ALB via a VPC origin over HTTPS, uncached, all methods', () => {
    expect(cfg.CacheBehaviors).toHaveLength(1);
    expect(cfg.CacheBehaviors[0]).toMatchObject({
      PathPattern: API_PATH_PATTERN,
      ViewerProtocolPolicy: 'https-only',
      AllowedMethods: expect.arrayContaining(['POST', 'PUT', 'PATCH', 'DELETE']),
      CachePolicyId: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad', // Managed-CachingDisabled
      OriginRequestPolicyId: 'b689b0a8-53d0-40ab-baf2-68738e2966ac', // AllViewerExceptHostHeader
    });
    template.hasResourceProperties('AWS::CloudFront::VpcOrigin', {
      VpcOriginEndpointConfig: Match.objectLike({
        OriginProtocolPolicy: 'https-only',
        OriginSSLProtocols: ['TLSv1.2'],
        HTTPSPort: 443,
      }),
    });
    const apiOrigin = cfg.Origins.find((o) => 'VpcOriginConfig' in o)!;
    expect(apiOrigin.DomainName).toBe('api-origin.test.example.com');
  });

  it('standard logging, WAF, geo restriction and DNS aliases', () => {
    expect(cfg.Logging).toMatchObject({
      IncludeCookies: false,
      Prefix: 'cloudfront/starter-test/',
    });
    expect(cfg.WebACLId).toBe(f.wafWebAclArn);
    expect(cfg.Restrictions).toEqual({
      GeoRestriction: { Locations: ['US'], RestrictionType: 'whitelist' },
    });
    template.resourceCountIs('AWS::Route53::RecordSet', 2);
  });

  it('passes cdk-nag in both governed and sandbox variants', () => {
    // Only the construct under test (the helper ALB is not part of SpaHosting).
    const spaOnly = (v: string) => v.includes('/Spa/');
    expect(nagViolations(stack).filter(spaOnly)).toEqual([]);
    expect(nagViolations(build('sandbox').stack).filter(spaOnly)).toEqual([]);
  });

  it('works with a bucket created in the same stack (sandbox-style log bucket)', () => {
    const s = testStack();
    const logs = new s3.Bucket(s, 'Logs', { objectOwnership: s3.ObjectOwnership.OBJECT_WRITER });
    new SpaHosting(s, 'Spa', {
      resourcePrefix: 'x',
      accessLogsBucket: logs,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      apiOrigin: undefined,
    });
    // A bucket we own gets the S3 log-delivery policy added by CDK.
    Template.fromStack(s).hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Principal: { Service: 'logging.s3.amazonaws.com' } }),
        ]),
      },
    });
  });
});

describe('SpaHosting with sign-in (identity)', () => {
  const AUTH = {
    issuer: 'https://idp.test.example.com/realms/starter',
    clientId: 'starter-test-web',
    scope: 'openid jobs:read jobs:write',
  };

  function buildWithAuth() {
    const stack = testStack();
    const f = importedFoundation(stack);
    const alb = new elbv2.ApplicationLoadBalancer(stack, 'Alb', {
      vpc: f.vpc,
      vpcSubnets: f.appSubnets,
      internetFacing: false,
      securityGroup: new ec2.SecurityGroup(stack, 'AlbSg', { vpc: f.vpc }),
    });
    new SpaHosting(stack, 'Spa', {
      resourcePrefix: 'starter-test',
      accessLogsBucket: f.accessLogsBucket,
      apiOrigin: { loadBalancer: alb, domainName: 'api-origin.test.example.com' },
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
      auth: AUTH,
    });
    return Template.fromStack(stack);
  }

  type Response = {
    statusCode?: number;
    headers?: Record<string, { value: string }>;
    body?: { encoding: string; data: string };
    uri?: string;
  };
  const viewerRequest = (code: string) =>
    new Function(`${code}; return handler;`)() as (e: { request: { uri: string } }) => Response;

  it('answers /config.json at the edge with the issuer, the public client id and the scopes', () => {
    const handler = viewerRequest(spaViewerRequestFunctionCode(AUTH));
    const response = handler({ request: { uri: '/config.json' } });
    expect(response.statusCode).toBe(200);
    expect(response.headers?.['cache-control']?.value).toBe('no-store');
    expect(response.headers?.['content-type']?.value).toBe('application/json');
    expect(JSON.parse(response.body?.data ?? '{}')).toEqual({ auth: AUTH });
    // ...and keeps the SPA rewrite for everything else.
    expect(handler({ request: { uri: '/jobs' } }).uri).toBe('/index.html');
    expect(handler({ request: { uri: '/assets/app.js' } }).uri).toBe('/assets/app.js');
    expect(spaViewerRequestFunctionCode()).toBe(SPA_REWRITE_FUNCTION_CODE);
  });

  it('deploys that function and a CSP that adds exactly the issuer origin', () => {
    const template = buildWithAuth();
    template.hasResourceProperties('AWS::CloudFront::Function', {
      FunctionCode: spaViewerRequestFunctionCode(AUTH),
    });
    const [, policy] = resourcesOf(template, 'AWS::CloudFront::ResponseHeadersPolicy')[0]!;
    const csp = (
      policy.ResponseHeadersPolicyConfig as {
        SecurityHeadersConfig: { ContentSecurityPolicy: { ContentSecurityPolicy: string } };
      }
    ).SecurityHeadersConfig.ContentSecurityPolicy.ContentSecurityPolicy;
    expect(csp).toContain("connect-src 'self' https://idp.test.example.com;");
    expect(csp).not.toMatch(/unsafe-/);
    expect(
      csp.replace("connect-src 'self' https://idp.test.example.com", "connect-src 'self'"),
    ).toBe(DEFAULT_CONTENT_SECURITY_POLICY);
  });

  it('never widens CSP to a non-https issuer', () => {
    expect(() => originOf('http://idp.internal')).toThrow(/https/);
    expect(() => contentSecurityPolicy({ ...AUTH, issuer: 'http://idp.internal' })).toThrow();
    expect(contentSecurityPolicy()).toBe(DEFAULT_CONTENT_SECURITY_POLICY);
  });
});
