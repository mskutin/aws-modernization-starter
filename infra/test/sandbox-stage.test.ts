/**
 * The opt-in live-validation `Sandbox` stage. NOT a governed environment: these tests pin the
 * sandbox-only deviations (public HTTP ALB origin, test issuer, destroy-on-delete, 1-day logs, no
 * access logging) and that none of them can reach a governed stage.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Stack } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { ORIGIN_VERIFY_HEADER } from '../constructs/api-service.js';
import {
  ENVIRONMENT_NAMES,
  PLACEHOLDER_ACCOUNT_ID,
  PLACEHOLDER_PREFIX_LIST_ID,
  REQUIRED_TAG_KEYS,
  loadEnvironmentConfig,
  selectEnvironments,
} from '../environments/index.js';
import { resolveImageDigest } from '../lib/image.js';
import {
  PLACEHOLDER_ORIGIN_VERIFY_SECRET,
  SANDBOX_PLACEHOLDER_RULE_ID,
  assertSandboxDeployable,
  resolveOriginVerifySecret,
  sandboxPlaceholders,
} from '../lib/sandbox-inputs.js';
import {
  SANDBOX_OPERATOR_KEY_ACTIONS,
  SANDBOX_OPERATOR_KEY_SID,
  SANDBOX_OPERATOR_LOGS_KEY_SIDS,
  STEP_FUNCTIONS_LOG_DELIVERY_SID,
} from '../constructs/foundation/index.js';
import { RUN_TAG_KEYS } from '../lib/tagging.js';
import { EPHEMERAL_TAGS } from '../stacks/integration-workflow-stack.js';
import { SANDBOX_OUTPUTS } from '../stages/sandbox-outputs.js';
import { TEST_ORIGIN_VERIFY_SECRET, nagViolations, resourcesOf, synthStage } from './helpers.js';
import { useSandboxAdoptedRegisters } from './policy-registers.js';

// The shipped registers carry no sandbox entry: adopt the sandbox example register in memory.
useSandboxAdoptedRegisters();

/** Managed CloudFront policies (AWS-published ids). */
const CACHING_DISABLED = '4135ea2d-6df8-44a3-9df3-4b5a84be39ad';
const ALL_VIEWER_EXCEPT_HOST_HEADER = 'b689b0a8-53d0-40ab-baf2-68738e2966ac';

const synth = () => synthStage('sandbox');
/** An IAM Identity Center permission-set role (path included), as the operator's role. */
const OPERATOR =
  'arn:aws:iam::123456789012:role/aws-reserved/sso.amazonaws.com/ap-southeast-1/AWSReservedSSO_Developer_0123456789abcdef';

function allTemplates(): [string, Template][] {
  const { templates, foundationTemplate, testIssuerTemplate } = synth();
  if (!foundationTemplate || !testIssuerTemplate) throw new Error('sandbox stacks missing');
  return [
    ['Foundation', foundationTemplate],
    ['TestIssuer', testIssuerTemplate],
    ...Object.entries(templates),
  ];
}

type Resources = Record<
  string,
  {
    Type: string;
    Properties?: Record<string, unknown>;
    DeletionPolicy?: string;
    UpdateReplacePolicy?: string;
  }
>;
const resources = (t: Template) => t.toJSON().Resources as Resources;
const json = (t: Template) => JSON.stringify(t.toJSON());
const issuerDomainImport = Match.objectLike({
  'Fn::ImportValue': Match.stringLikeRegexp('^Sandbox-TestIssuer:.*DomainName'),
});

describe('sandbox environment selection and config', () => {
  it('is opt-in: the default synth set stays dev, staging, prod', () => {
    expect(selectEnvironments(undefined)).toEqual(['dev', 'staging', 'prod']);
    expect(selectEnvironments('')).toEqual([...ENVIRONMENT_NAMES]);
    expect(selectEnvironments('sandbox')).toEqual(['sandbox']);
    expect(() => selectEnvironments('sandbox,qa')).toThrow(/Unknown environment\(s\).*qa/);
  });

  it('parses with the contract identity: prefix, qualifier, tags, test issuer audience/client', () => {
    const cfg = loadEnvironmentConfig('sandbox');
    expect(cfg).toMatchObject({
      name: 'sandbox',
      region: 'ap-southeast-1',
      resourcePrefix: 'starter-sbx',
      cdkBootstrapQualifier: 'starter',
      teardown: 'destroy',
      tags: {
        Environment: 'sandbox',
        Owner: 'sandbox-operator',
        CostCentre: 'sandbox',
        DataClassification: 'Synthetic',
        Project: 'aws-modernization-starter',
        ManagedBy: 'aws-cdk',
      },
      auth: {
        testIssuer: true,
        audience: 'starter-jobs-api-sandbox',
        spaClientId: 'starter-web-sandbox',
        algorithms: ['ES256'],
      },
      run: { runId: 'sbx-000000', experiment: 'live-validation' },
    });
    expect(cfg.auth.issuer).toBeUndefined();
  });

  it('takes the run identity and an unreserved workflow from context (sandbox only)', () => {
    const cfg = loadEnvironmentConfig('sandbox', {
      run: { runId: 'sbx-0a1b2c', expiresAt: '2026-10-16T06:00:00Z' },
      reservedConcurrency: null,
    });
    expect(cfg.run).toEqual({
      runId: 'sbx-0a1b2c',
      expiresAt: '2026-10-16T06:00:00Z',
      experiment: 'live-validation',
    });
    expect(cfg.workflow.reservedConcurrency).toBeNull();
    expect(() =>
      loadEnvironmentConfig('sandbox', { run: { runId: 'it-abc123', expiresAt: 'x' } }),
    ).toThrow(/run\.runId: must look like sbx-<6 hex>[\s\S]*run\.expiresAt/);
    for (const name of ENVIRONMENT_NAMES) {
      expect(() =>
        loadEnvironmentConfig(name, {
          run: { runId: 'sbx-0a1b2c', expiresAt: '2026-10-16T06:00:00Z' },
        }),
      ).toThrow(/sandbox-only/);
      expect(() => loadEnvironmentConfig(name, { reservedConcurrency: null })).toThrow(
        /sandbox-only/,
      );
    }
  });

  it('run tag keys match the integration mini-stack sweeper tags', () => {
    expect(RUN_TAG_KEYS).toMatchObject(EPHEMERAL_TAGS);
    expect(RUN_TAG_KEYS.experiment).toBe('starter:experiment');
  });
});

describe('sandbox deploy inputs (requireDeployInputs)', () => {
  const now = new Date('2026-10-15T06:00:00Z');
  const real = () =>
    loadEnvironmentConfig('sandbox', {
      account: '123456789012',
      run: { runId: 'sbx-0a1b2c', expiresAt: '2026-10-16T06:00:00Z' },
      operatorPrincipalArn: OPERATOR,
    });

  it('refuses every placeholder at once', () => {
    expect(() =>
      assertSandboxDeployable(
        loadEnvironmentConfig('sandbox'),
        { originVerifySecret: PLACEHOLDER_ORIGIN_VERIFY_SECRET, imageDigestIsPlaceholder: true },
        now,
      ),
    ).toThrow(
      /account\.sandbox[\s\S]*operatorPrincipalArn[\s\S]*runId=sbx-<6 hex>[\s\S]*originVerifySecret[\s\S]*apiImageDigest[\s\S]*expiresAt/,
    );
  });

  it('accepts real inputs; refuses an expiry in the past or more than 72 h ahead', () => {
    const inputs = {
      originVerifySecret: TEST_ORIGIN_VERIFY_SECRET,
      imageDigestIsPlaceholder: false,
    };
    expect(() => assertSandboxDeployable(real(), inputs, now)).not.toThrow();
    expect(() => assertSandboxDeployable(real(), inputs, new Date('2026-10-17T00:00:00Z'))).toThrow(
      /expiresAt/,
    );
    expect(() => assertSandboxDeployable(real(), inputs, new Date('2026-10-12T00:00:00Z'))).toThrow(
      /expiresAt/,
    );
    expect(real().account).not.toBe(PLACEHOLDER_ACCOUNT_ID);
  });

  it('another region without a confirmed origin-facing prefix list id needs it from discovery', () => {
    const inputs = {
      originVerifySecret: TEST_ORIGIN_VERIFY_SECRET,
      imageDigestIsPlaceholder: false,
    };
    const inRegion = (originPrefixListId?: string) =>
      loadEnvironmentConfig('sandbox', {
        account: '123456789012',
        region: 'eu-west-1',
        run: { runId: 'sbx-0a1b2c', expiresAt: '2026-10-16T06:00:00Z' },
        operatorPrincipalArn: OPERATOR,
        ...(originPrefixListId ? { originPrefixListId } : {}),
      });
    expect(inRegion().foundation.edge.cloudFrontOriginFacingPrefixListId).toBe(
      PLACEHOLDER_PREFIX_LIST_ID,
    );
    expect(sandboxPlaceholders(inRegion(), inputs)).toEqual([
      '-c sandbox.originPrefixListId=<id of com.amazonaws.global.cloudfront.origin-facing in eu-west-1>',
    ]);
    expect(() => assertSandboxDeployable(inRegion(), inputs, now)).toThrow(
      /sandbox\.originPrefixListId=<id of com\.amazonaws\.global\.cloudfront\.origin-facing in eu-west-1>/,
    );
    expect(() => assertSandboxDeployable(inRegion('pl-0123abcd'), inputs, now)).not.toThrow();
  });

  it('validates the origin-verify secret without echoing it, and implies requireImageDigest', () => {
    const ctx = (values: Record<string, unknown>) => (key: string) => values[key];
    expect(resolveOriginVerifySecret(ctx({}))).toBe(PLACEHOLDER_ORIGIN_VERIFY_SECRET);
    expect(resolveOriginVerifySecret(ctx({ originVerifySecret: 'a'.repeat(64) }))).toBe(
      'a'.repeat(64),
    );
    let message = '';
    try {
      resolveOriginVerifySecret(ctx({ originVerifySecret: 'short*secret' }));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/Invalid originVerifySecret/);
    expect(message).not.toContain('short*secret');
    const dir = mkdtempSync(path.join(tmpdir(), 'starter-ovs-'));
    const file = path.join(dir, 'origin-verify');
    writeFileSync(file, `${'b'.repeat(64)}\n`, { mode: 0o600 });
    expect(resolveOriginVerifySecret(ctx({ originVerifySecretFile: file }))).toBe('b'.repeat(64));
    chmodSync(file, 0o644);
    expect(() => resolveOriginVerifySecret(ctx({ originVerifySecretFile: file }))).toThrow(
      /must not be readable by group or others/,
    );
    expect(() =>
      resolveOriginVerifySecret(ctx({ originVerifySecretFile: file, originVerifySecret: 'x' })),
    ).toThrow(/not both/);
    rmSync(dir, { recursive: true, force: true });
    expect(() => resolveImageDigest(ctx({ requireDeployInputs: 'true' }), {})).toThrow(
      /no apiImageDigest/,
    );
  });
});

describe('Sandbox stage (live validation, not a governed environment)', () => {
  const { stage, templates, config, foundationTemplate, testIssuerTemplate } = synth();
  const foundation = foundationTemplate as Template;
  const issuer = testIssuerTemplate as Template;

  it('has the contract stacks: Sandbox-<Id>, qualifier starter, no termination protection', () => {
    const stacks = [
      stage.foundationStack,
      stage.testIssuer,
      stage.platform,
      stage.data,
      stage.workflow,
      stage.migrations,
      stage.api,
      stage.frontend,
      stage.observability,
    ];
    expect(stacks.map((s) => s?.stackName)).toEqual(
      [
        'Foundation',
        'TestIssuer',
        'Platform',
        'Data',
        'Workflow',
        'Migrations',
        'Api',
        'Frontend',
        'Observability',
      ].map((id) => `Sandbox-${id}`),
    );
    for (const s of stacks) expect(s?.terminationProtection).toBe(false);
    expect(templates.Api.toJSON().Parameters.BootstrapVersion.Default).toBe(
      '/cdk-bootstrap/starter/version',
    );
    // The test issuer depends on the foundation only, so it deploys before the API.
    expect(stage.testIssuer?.dependencies.map((d) => d.node.id)).toEqual(['Foundation']);
    expect(stage.api.dependencies.map((d) => d.node.id)).toContain('TestIssuer');
    expect(stage.frontend.dependencies.map((d) => d.node.id)).toEqual(
      expect.arrayContaining(['Api', 'TestIssuer']),
    );
  });

  it('passes cdk-nag with no unacknowledged findings and has no synth errors', () => {
    expect(nagViolations(stage)).toEqual([]);
    for (const s of [stage.foundationStack, stage.testIssuer, stage.api, stage.frontend]) {
      expect(Annotations.fromStack(s!).findError('*', Match.anyValue())).toEqual([]);
    }
  });

  it('foundation: 2 AZs, 1 NAT, S3 + DynamoDB gateway endpoints, REJECT flow logs, no log bucket', () => {
    foundation.resourceCountIs('AWS::EC2::NatGateway', 1);
    foundation.resourceCountIs('AWS::EC2::EIP', 1);
    foundation.resourceCountIs('AWS::EC2::Subnet', 6);
    foundation.resourceCountIs('AWS::EC2::VPCEndpoint', 2);
    foundation.hasResourceProperties('AWS::EC2::FlowLog', { TrafficType: 'REJECT' });
    foundation.resourceCountIs('AWS::S3::Bucket', 0);
    foundation.resourceCountIs('AWS::KMS::Key', 2);
    for (const [, key] of resourcesOf(foundation, 'AWS::KMS::Key')) {
      expect(key.PendingWindowInDays).toBe(7);
    }
  });

  it('API origin: internet-facing ALB in the public subnets, HTTP:80, prefix-list-only ingress', () => {
    templates.Api.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      Scheme: 'internet-facing',
      Subnets: Match.arrayWith([
        Match.objectLike({ 'Fn::ImportValue': Match.stringLikeRegexp('ingressSubnet1') }),
      ]),
    });
    const listeners = resourcesOf(templates.Api, 'AWS::ElasticLoadBalancingV2::Listener');
    expect(listeners).toHaveLength(1);
    expect(listeners[0]![1]).toMatchObject({
      Port: 80,
      Protocol: 'HTTP',
      DefaultActions: [{ Type: 'fixed-response', FixedResponseConfig: { StatusCode: '403' } }],
    });
    templates.Api.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
      Priority: 10,
      Conditions: [
        {
          Field: 'http-header',
          HttpHeaderConfig: {
            HttpHeaderName: ORIGIN_VERIFY_HEADER,
            Values: [TEST_ORIGIN_VERIFY_SECRET],
          },
        },
      ],
      Actions: [Match.objectLike({ Type: 'forward' })],
    });
    templates.Api.resourceCountIs('AWS::ElasticLoadBalancingV2::ListenerRule', 1);
    const albSg = Object.entries(resources(templates.Api)).find(
      ([id, r]) =>
        r.Type === 'AWS::EC2::SecurityGroup' && id.startsWith('ApiServiceAlbSecurityGroup'),
    )?.[0];
    const ingress = resourcesOf(templates.Api, 'AWS::EC2::SecurityGroupIngress').filter(([, p]) =>
      JSON.stringify(p.GroupId).includes(albSg ?? '?'),
    );
    expect(ingress.map(([, p]) => [p.SourcePrefixListId, p.FromPort, p.ToPort, p.CidrIp])).toEqual([
      [config.foundation.edge.cloudFrontOriginFacingPrefixListId, 80, 80, undefined],
    ]);
    expect(json(templates.Api)).not.toContain('0.0.0.0/0","Description":"Allow from anyone');
  });

  it('CloudFront: /v1/* and /health/* to the ALB over HTTP with the origin-verify header', () => {
    const [[, dist]] = resourcesOf(templates.Frontend, 'AWS::CloudFront::Distribution') as [
      [string, { DistributionConfig: Record<string, unknown> }],
    ];
    const dc = dist.DistributionConfig as {
      Origins: {
        Id: string;
        CustomOriginConfig?: Record<string, unknown>;
        OriginCustomHeaders?: unknown;
      }[];
      CacheBehaviors: Record<string, unknown>[];
      ViewerCertificate?: unknown;
      Logging?: unknown;
      WebACLId?: unknown;
    };
    const http = dc.Origins.find((o) => o.CustomOriginConfig);
    expect(http).toMatchObject({
      CustomOriginConfig: { OriginProtocolPolicy: 'http-only', HTTPPort: 80 },
      OriginCustomHeaders: [
        { HeaderName: ORIGIN_VERIFY_HEADER, HeaderValue: TEST_ORIGIN_VERIFY_SECRET },
      ],
      DomainName: expect.anything(),
    });
    expect(dc.CacheBehaviors.map((b) => b.PathPattern)).toEqual(['/v1/*', '/health/*']);
    for (const b of dc.CacheBehaviors) {
      expect(b).toMatchObject({
        TargetOriginId: http?.Id,
        ViewerProtocolPolicy: 'https-only',
        CachePolicyId: CACHING_DISABLED,
        OriginRequestPolicyId: ALL_VIEWER_EXCEPT_HOST_HEADER,
        ResponseHeadersPolicyId: expect.anything(),
      });
      expect(b.FunctionAssociations).toBeUndefined();
    }
    expect(dc.ViewerCertificate).toBeUndefined(); // default *.cloudfront.net certificate
    expect(dc.Logging).toBeUndefined();
    expect(dc.WebACLId).toBeUndefined();
    templates.Frontend.resourceCountIs('AWS::CloudFront::VpcOrigin', 0);
  });

  it('wires the test issuer into the API task, the SPA /config.json and the CSP', () => {
    const [[, td]] = resourcesOf(templates.Api, 'AWS::ECS::TaskDefinition') as [
      [string, { ContainerDefinitions: { Environment: { Name: string; Value: unknown }[] }[] }],
    ];
    const env = Object.fromEntries(
      td.ContainerDefinitions[0]!.Environment.map((e) => [e.Name, e.Value]),
    );
    expect(env).toMatchObject({
      AUTH_ISSUER: {
        'Fn::Join': [
          '',
          [
            'https://',
            expect.objectContaining({
              'Fn::ImportValue': expect.stringMatching(/^Sandbox-TestIssuer:/),
            }),
          ],
        ],
      },
      AUTH_JWKS_URI: { 'Fn::Join': ['', ['https://', expect.anything(), '/jwks.json']] },
      AUTH_AUDIENCE: 'starter-jobs-api-sandbox',
      AUTH_ALLOWED_CLIENT_IDS: 'starter-web-sandbox',
      AUTH_ALGORITHMS: 'ES256',
      APP_ENVIRONMENT: 'sandbox',
      TRUST_PROXY_HOPS: '2',
    });
    expect(env.AUTH_ALLOW_INSECURE_ISSUER).toBeUndefined();
    expect(env.APP_RUNTIME).toBeUndefined();

    templates.Frontend.hasResourceProperties('AWS::CloudFront::Function', {
      FunctionCode: {
        'Fn::Join': [
          '',
          Match.arrayWith([issuerDomainImport, Match.stringLikeRegexp('starter-web-sandbox')]),
        ],
      },
    });
    templates.Frontend.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: Match.objectLike({
          ContentSecurityPolicy: {
            ContentSecurityPolicy: {
              'Fn::Join': [
                '',
                [
                  Match.stringLikeRegexp("connect-src 'self' https://$"),
                  issuerDomainImport,
                  Match.stringLikeRegexp('^; object-src'),
                ],
              ],
            },
            Override: true,
          },
        }),
      }),
    });
  });

  it('test issuer: private bucket (destroy, emptied) behind OAC + HTTPS-only CloudFront, no rewrite', () => {
    issuer.hasResource('AWS::S3::Bucket', {
      DeletionPolicy: 'Delete',
      Properties: Match.objectLike({
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      }),
    });
    issuer.resourceCountIs('Custom::S3AutoDeleteObjects', 1);
    issuer.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
    issuer.resourceCountIs('AWS::CloudFront::Function', 0);
    issuer.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({
          ViewerProtocolPolicy: 'https-only',
          AllowedMethods: ['GET', 'HEAD'],
          CachePolicyId: CACHING_DISABLED,
          ResponseHeadersPolicyId: Match.objectLike({ Ref: Match.stringLikeRegexp('Headers') }),
        }),
      }),
    });
    // Explicit CORS (the managed policy dropped the header for browser requests on AWS).
    issuer.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: Match.objectLike({
        CorsConfig: Match.objectLike({
          AccessControlAllowOrigins: { Items: ['*'] },
          AccessControlAllowHeaders: { Items: ['*'] },
          AccessControlAllowCredentials: false,
          OriginOverride: true,
        }),
      }),
    });
    const outputs = Object.keys(issuer.toJSON().Outputs as object);
    expect(outputs).toEqual(
      expect.arrayContaining(['IssuerUrl', 'IssuerBucketName', 'IssuerDistributionId']),
    );
  });

  it('nothing is retained: no Retain/Snapshot policy; RDS, DynamoDB, ECR, buckets, keys deleted', () => {
    for (const [name, t] of allTemplates()) {
      for (const [id, r] of Object.entries(resources(t))) {
        expect([r.DeletionPolicy, r.UpdateReplacePolicy], `${name}/${id}`).not.toContain('Retain');
        expect([r.DeletionPolicy, r.UpdateReplacePolicy], `${name}/${id}`).not.toContain(
          'Snapshot',
        );
      }
    }
    templates.Data.hasResource('AWS::RDS::DBInstance', {
      DeletionPolicy: 'Delete',
      Properties: Match.objectLike({
        DBInstanceClass: 'db.t4g.micro',
        MultiAZ: false,
        AllocatedStorage: '20',
        DeletionProtection: false,
        DeleteAutomatedBackups: true,
        EnableIAMDatabaseAuthentication: true,
        PubliclyAccessible: false,
      }),
    });
    templates.Data.hasResource('AWS::DynamoDB::Table', {
      DeletionPolicy: 'Delete',
      Properties: Match.objectLike({ DeletionProtectionEnabled: false }),
    });
    templates.Platform.hasResource('AWS::ECR::Repository', {
      DeletionPolicy: 'Delete',
      Properties: Match.objectLike({ EmptyOnDelete: true }),
    });
    templates.Frontend.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Delete' });
    templates.Frontend.resourceCountIs('Custom::S3AutoDeleteObjects', 1);
    templates.Observability.hasResource('AWS::KMS::Key', {
      DeletionPolicy: 'Delete',
      Properties: Match.objectLike({ PendingWindowInDays: 7, EnableKeyRotation: true }),
    });
  });

  it('every log group: 1-day retention, CMK, deleted with the stack (custom-resource providers too)', () => {
    let groups = 0;
    for (const [name, t] of allTemplates()) {
      for (const [id, r] of Object.entries(resources(t))) {
        if (r.Type !== 'AWS::Logs::LogGroup') continue;
        groups++;
        expect(r.Properties?.RetentionInDays, `${name}/${id}`).toBe(1);
        expect(r.Properties?.KmsKeyId, `${name}/${id}`).toBeDefined();
        expect(r.DeletionPolicy, `${name}/${id}`).toBe('Delete');
      }
      for (const [id, fn] of resourcesOf(t, 'AWS::Lambda::Function')) {
        expect(fn.LoggingConfig, `${name}/${id}`).toMatchObject({ LogGroup: expect.anything() });
      }
    }
    expect(groups).toBeGreaterThan(10);
  });

  it('every tagged resource carries the required and the ephemeral run tags', () => {
    let checked = 0;
    for (const [name, t] of allTemplates()) {
      for (const [id, r] of Object.entries(resources(t))) {
        const tags = r.Properties?.Tags;
        if (!Array.isArray(tags)) continue;
        const map = Object.fromEntries(
          (tags as { Key: string; Value: string }[]).map((x) => [x.Key, x.Value]),
        );
        for (const k of REQUIRED_TAG_KEYS) expect(map[k], `${name}/${id} ${k}`).toBeDefined();
        expect(map, `${name}/${id}`).toMatchObject({
          Environment: 'sandbox',
          'starter:ephemeral': 'true',
          'starter:run-id': 'sbx-000000',
          'starter:expires-at': '2000-01-01T00:00:00.000Z',
          'starter:experiment': 'live-validation',
        });
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(40);
    expect(stage.api.tags.tagValues()).toMatchObject({
      'starter:run-id': 'sbx-000000',
      Environment: 'sandbox',
    });
  });

  it('defines every contract output', () => {
    const byStack: Record<string, Template> = {
      Foundation: foundation,
      TestIssuer: issuer,
      ...templates,
    };
    for (const [stack, names] of Object.entries(SANDBOX_OUTPUTS)) {
      const outputs = Object.keys((byStack[stack]!.toJSON().Outputs ?? {}) as object);
      expect(outputs, stack).toEqual(expect.arrayContaining([...names]));
    }
  });

  it('ECS: on-demand Fargate arm64, desired 1 (max 2), circuit breaker with rollback', () => {
    templates.Api.hasResourceProperties('AWS::ECS::Service', {
      DesiredCount: 1,
      CapacityProviderStrategy: [{ CapacityProvider: 'FARGATE', Weight: 1 }],
      DeploymentConfiguration: Match.objectLike({
        DeploymentCircuitBreaker: { Enable: true, Rollback: true },
        MinimumHealthyPercent: 100,
        MaximumPercent: 200,
      }),
    });
    templates.Api.hasResourceProperties('AWS::ApplicationAutoScaling::ScalableTarget', {
      MinCapacity: 1,
      MaxCapacity: 2,
    });
    templates.Api.hasResourceProperties('AWS::ECS::TaskDefinition', {
      RuntimePlatform: { CpuArchitecture: 'ARM64', OperatingSystemFamily: 'LINUX' },
    });
  });

  it('workflow: small reservations by default; unreserved only through the sandbox switch', () => {
    const reserved = resourcesOf(templates.Workflow, 'AWS::Lambda::Function').map(([id, p]) => [
      id.replace(/[A-F0-9]{8}$/, ''),
      p.ReservedConcurrentExecutions,
    ]);
    expect(reserved).toEqual([
      ['ProcessingWorkflowValidator', 2],
      ['ProcessingWorkflowProcessor', 2],
      ['ReconcilerFunction', 1],
    ]);
    const unreserved = synthStage('sandbox', { reservedConcurrency: null });
    for (const [, p] of resourcesOf(unreserved.templates.Workflow, 'AWS::Lambda::Function')) {
      expect(p.ReservedConcurrentExecutions).toBeUndefined();
    }
    // Superseded Lambda versions are deleted too (RETAIN in the governed environments).
    const versions = Object.entries(resources(templates.Workflow)).filter(
      ([, r]) => r.Type === 'AWS::Lambda::Version',
    );
    expect(versions).toHaveLength(3);
    for (const [id, r] of versions) expect(r.DeletionPolicy, id).toBe('Delete');
  });
});

describe('sandbox operator key access and other live-validation adjustments', () => {
  const keyStatements = (t: Template, keyIdPrefix: string) =>
    Object.entries(resources(t))
      .filter(([id, r]) => r.Type === 'AWS::KMS::Key' && id.startsWith(keyIdPrefix))
      .flatMap(
        ([, r]) => (r.Properties?.KeyPolicy as { Statement: Record<string, unknown>[] }).Statement,
      );

  it('the data key names the operator role, for use through DynamoDB and Step Functions only', () => {
    const { foundationTemplate } = synthStage('sandbox', {
      account: '123456789012',
      operatorPrincipalArn: OPERATOR,
    });
    const operator = keyStatements(foundationTemplate!, 'SandboxFoundationDataKey').filter(
      (s) => s.Sid === SANDBOX_OPERATOR_KEY_SID,
    );
    expect(operator).toEqual([
      {
        Sid: SANDBOX_OPERATOR_KEY_SID,
        Effect: 'Allow',
        Principal: { AWS: OPERATOR },
        Action: [...SANDBOX_OPERATOR_KEY_ACTIONS].sort(),
        Resource: '*',
        Condition: {
          StringEquals: {
            'kms:ViaService': [
              'dynamodb.ap-southeast-1.amazonaws.com',
              'states.ap-southeast-1.amazonaws.com',
            ],
          },
        },
      },
    ]);
    // On the logs key the operator appears only in the two CloudWatch Logs statements (below).
    const logs = keyStatements(foundationTemplate!, 'SandboxFoundationLogsKey');
    expect(logs.filter((s) => JSON.stringify(s).includes(OPERATOR)).map((s) => s.Sid)).toEqual(
      Object.values(SANDBOX_OPERATOR_LOGS_KEY_SIDS),
    );
    // The job table and the state machine are the data key's (operator-read) consumers.
    const stage = synthStage('sandbox').stage;
    expect(stage.data.jobTable.encryptionKey).toBeDefined();
    expect(stage.workflow.workflow.stateMachine).toBeDefined();
  });

  it('no governed template (or the dev sandbox foundation) carries an operator key statement', () => {
    for (const name of ENVIRONMENT_NAMES) {
      for (const t of Object.values(synthStage(name).templates)) {
        expect(json(t)).not.toContain(SANDBOX_OPERATOR_KEY_SID);
      }
    }
    const devSandbox = synthStage('dev', { foundationMode: 'sandbox' });
    expect(json(devSandbox.foundationTemplate!)).not.toContain(SANDBOX_OPERATOR_KEY_SID);
  });

  it('validates the operator role: IAM role ARN with path, same account, sandbox only', () => {
    const cfg = loadEnvironmentConfig('sandbox', {
      account: '123456789012',
      operatorPrincipalArn: OPERATOR,
    });
    expect(cfg.operatorPrincipalArn).toBe(OPERATOR);
    expect(() =>
      loadEnvironmentConfig('sandbox', {
        account: '123456789012',
        operatorPrincipalArn:
          'arn:aws:sts::123456789012:assumed-role/AWSReservedSSO_Developer_0123456789abcdef/me',
      }),
    ).toThrow(/operatorPrincipalArn: must be an IAM role ARN with its path/);
    expect(() =>
      loadEnvironmentConfig('sandbox', {
        account: '123456789012',
        operatorPrincipalArn: OPERATOR.replace('123456789012', '210987654321'),
      }),
    ).toThrow(/operatorPrincipalArn: must be a role in the sandbox account 123456789012/);
    for (const name of ENVIRONMENT_NAMES) {
      expect(() => loadEnvironmentConfig(name, { operatorPrincipalArn: OPERATOR })).toThrow(
        /sandbox-only/,
      );
    }
  });

  it('raises the unauthenticated rate limit for the negative-auth matrix (sandbox only)', () => {
    const env = (name: 'sandbox' | 'dev' | 'staging' | 'prod') => {
      const [[, td]] = resourcesOf(synthStage(name).templates.Api, 'AWS::ECS::TaskDefinition') as [
        [string, { ContainerDefinitions: { Environment: { Name: string; Value: unknown }[] }[] }],
      ];
      return Object.fromEntries(
        td.ContainerDefinitions[0]!.Environment.map((e) => [e.Name, e.Value]),
      );
    };
    expect(env('sandbox')).toMatchObject({
      RATE_LIMIT_WINDOW_SECONDS: '60',
      RATE_LIMIT_READ_MAX: '120',
      RATE_LIMIT_WRITE_MAX: '20',
      RATE_LIMIT_UNAUTHENTICATED_MAX: '250',
    });
    for (const name of ENVIRONMENT_NAMES) {
      expect(env(name).RATE_LIMIT_UNAUTHENTICATED_MAX).toBe('30');
    }
  });

  it('master-secret rotation: on by default; the sandbox-only switch removes the transform', () => {
    const on = synthStage('sandbox').templates.Data;
    expect(on.toJSON().Transform).toBe('AWS::SecretsManager-2024-09-16');
    on.resourceCountIs('AWS::SecretsManager::RotationSchedule', 1);
    const off = synthStage('sandbox', { masterSecretRotation: false });
    expect(off.templates.Data.toJSON().Transform).toBeUndefined();
    off.templates.Data.resourceCountIs('AWS::SecretsManager::RotationSchedule', 0);
    expect(nagViolations(off.stage)).toEqual([]);
    for (const name of ENVIRONMENT_NAMES) {
      expect(() => loadEnvironmentConfig(name, { masterSecretRotation: false })).toThrow(
        /sandbox-only/,
      );
    }
  });

  it('the stage needs no context lookups (no lookup role, offline synth)', () => {
    const { app } = synth();
    expect(app.synth().manifest.missing ?? []).toEqual([]);
  });
});

describe('log delivery key access and placeholder guard', () => {
  const statements = (t: Template, keyIdPrefix: string) =>
    Object.entries(resources(t))
      .filter(([id, r]) => r.Type === 'AWS::KMS::Key' && id.startsWith(keyIdPrefix))
      .flatMap(
        ([, r]) => (r.Properties?.KeyPolicy as { Statement: Record<string, unknown>[] }).Statement,
      );
  const real = () =>
    synthStage('sandbox', {
      account: '123456789012',
      run: { runId: 'sbx-0a1b2c', expiresAt: '2026-10-16T06:00:00Z' },
      operatorPrincipalArn: OPERATOR,
    });

  it('the data key lets CloudWatch log delivery decrypt Step Functions log data keys', () => {
    const { foundationTemplate, templates } = real();
    const delivery = statements(foundationTemplate!, 'SandboxFoundationDataKey').filter(
      (s) => s.Sid === STEP_FUNCTIONS_LOG_DELIVERY_SID,
    );
    expect(delivery).toEqual([
      {
        Sid: STEP_FUNCTIONS_LOG_DELIVERY_SID,
        Effect: 'Allow',
        Principal: { Service: 'delivery.logs.amazonaws.com' },
        Action: 'kms:Decrypt',
        Resource: '*',
        Condition: {
          StringLike: {
            'kms:EncryptionContext:SourceArn': 'arn:aws:logs:ap-southeast-1:123456789012:*',
          },
        },
      },
    ]);
    // The same encryption context the state machine role generates the log data keys with.
    expect(json(templates.Workflow)).toContain(
      '"kms:EncryptionContext:SourceArn":"arn:aws:logs:ap-southeast-1:123456789012:*"',
    );
    templates.Workflow.hasResourceProperties('AWS::StepFunctions::StateMachine', {
      EncryptionConfiguration: Match.objectLike({ Type: 'CUSTOMER_MANAGED_KMS_KEY' }),
      LoggingConfiguration: Match.objectLike({ Level: 'ALL' }),
    });
  });

  it('the logs key lets the operator decrypt (and describe) through CloudWatch Logs only', () => {
    const logs = statements(real().foundationTemplate!, 'SandboxFoundationLogsKey');
    const bySid = Object.fromEntries(logs.map((s) => [s.Sid, s]));
    expect(bySid[SANDBOX_OPERATOR_LOGS_KEY_SIDS.decrypt]).toEqual({
      Sid: SANDBOX_OPERATOR_LOGS_KEY_SIDS.decrypt,
      Effect: 'Allow',
      Principal: { AWS: OPERATOR },
      Action: 'kms:Decrypt',
      Resource: '*',
      Condition: {
        StringEquals: { 'kms:ViaService': 'logs.ap-southeast-1.amazonaws.com' },
        ArnLike: {
          'kms:EncryptionContext:aws:logs:arn': {
            'Fn::Join': [
              '',
              [
                'arn:',
                { Ref: 'AWS::Partition' },
                ':logs:ap-southeast-1:',
                { Ref: 'AWS::AccountId' },
                ':log-group:*',
              ],
            ],
          },
        },
      },
    });
    expect(bySid[SANDBOX_OPERATOR_LOGS_KEY_SIDS.describe]).toEqual({
      Sid: SANDBOX_OPERATOR_LOGS_KEY_SIDS.describe,
      Effect: 'Allow',
      Principal: { AWS: OPERATOR },
      Action: 'kms:DescribeKey',
      Resource: '*',
      Condition: { StringEquals: { 'kms:ViaService': 'logs.ap-southeast-1.amazonaws.com' } },
    });
  });

  it('neither statement exists outside the sandbox (governed stages, dev sandbox foundation)', () => {
    const sids = [
      STEP_FUNCTIONS_LOG_DELIVERY_SID,
      ...Object.values(SANDBOX_OPERATOR_LOGS_KEY_SIDS),
    ];
    const others = [
      ...ENVIRONMENT_NAMES.flatMap((n) => Object.values(synthStage(n).templates)),
      synthStage('dev', { foundationMode: 'sandbox' }).foundationTemplate!,
    ];
    for (const t of others) for (const sid of sids) expect(json(t)).not.toContain(sid);
  });

  it('placeholder inputs add an always-failing rule to every sandbox stack', () => {
    const { stage } = synth(); // account, operator, run id and expiry are placeholders here
    const stacks = stage.node.children.filter((c): c is Stack => Stack.isStack(c));
    expect(stacks).toHaveLength(9);
    for (const s of stacks) {
      const rule = (Template.fromStack(s).toJSON().Rules ?? {})[SANDBOX_PLACEHOLDER_RULE_ID] as {
        Assertions: { Assert: unknown; AssertDescription: string }[];
      };
      expect(rule, s.stackName).toBeDefined();
      expect(rule.Assertions).toEqual([
        {
          Assert: { 'Fn::Equals': ['placeholder-inputs', 'deployable-inputs'] },
          AssertDescription: expect.stringMatching(
            /^NOT DEPLOYABLE: .*account\.sandbox.*operatorPrincipalArn.*runId.*expiresAt.*requireDeployInputs=true\.$/,
          ),
        },
      ]);
    }
  });

  it('real inputs carry no such rule; governed stages never do', () => {
    const { stage } = real();
    for (const s of stage.node.children.filter((c): c is Stack => Stack.isStack(c))) {
      expect(Object.keys(Template.fromStack(s).toJSON().Rules ?? {})).not.toContain(
        SANDBOX_PLACEHOLDER_RULE_ID,
      );
    }
    for (const name of ENVIRONMENT_NAMES) {
      for (const t of Object.values(synthStage(name).templates)) {
        expect(Object.keys(t.toJSON().Rules ?? {})).not.toContain(SANDBOX_PLACEHOLDER_RULE_ID);
      }
    }
  });

  it('a sandbox in a region without a confirmed prefix list id is not deployable', () => {
    const { stage } = synthStage('sandbox', {
      account: '123456789012',
      region: 'eu-west-1',
      run: { runId: 'sbx-0a1b2c', expiresAt: '2026-10-16T06:00:00Z' },
      operatorPrincipalArn: OPERATOR,
    });
    const stacks = stage.node.children.filter((c): c is Stack => Stack.isStack(c));
    expect(stacks.length).toBeGreaterThan(0);
    for (const st of stacks) {
      expect(st.region).toBe('eu-west-1');
      const rule = (
        Template.fromStack(st).toJSON().Rules as Record<
          string,
          { Assertions: { AssertDescription: string }[] }
        >
      )[SANDBOX_PLACEHOLDER_RULE_ID];
      expect(rule?.Assertions[0]?.AssertDescription).toMatch(
        /sandbox\.originPrefixListId=<id of com\.amazonaws\.global\.cloudfront\.origin-facing in eu-west-1>/,
      );
    }
  });

  it('lists each placeholder (origin-verify value and image digest included)', () => {
    expect(
      sandboxPlaceholders(loadEnvironmentConfig('sandbox'), {
        originVerifySecret: PLACEHOLDER_ORIGIN_VERIFY_SECRET,
        imageDigestIsPlaceholder: true,
      }),
    ).toEqual([
      '-c account.sandbox=<account id>',
      '-c operatorPrincipalArn=<operator role ARN with path>',
      '-c runId=sbx-<6 hex>',
      '-c expiresAt=<ISO-8601 UTC>',
      '-c originVerifySecretFile=<0600 file>',
      '-c apiImageDigest=sha256:<digest>',
    ]);
  });
});
