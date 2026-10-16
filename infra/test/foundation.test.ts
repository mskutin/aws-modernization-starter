import { CfnResource, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as logs from 'aws-cdk-lib/aws-logs';
import { describe, expect, it } from 'vitest';
import {
  ImportedFoundationProvider,
  SandboxFoundationProvider,
  SandboxFoundationStack,
} from '../constructs/foundation/index.js';
import { loadEnvironmentConfig } from '../environments/index.js';
import { workloadStackProps } from '../stacks/workload-stack.js';
import { importedFoundation, nagViolations, newApp, synthStage, testStack } from './helpers.js';

describe('ImportedLandingZoneFoundation', () => {
  it('imports everything by id/ARN and creates no resources', () => {
    const stack = testStack();
    const f = importedFoundation(stack);
    expect(stack.node.findAll().filter((c) => CfnResource.isCfnResource(c))).toEqual([]);

    const cfg = loadEnvironmentConfig('dev').foundation;
    if (cfg.mode !== 'import') throw new Error('expected import');
    expect(f.vpc.vpcId).toBe(cfg.vpc.vpcId);
    expect(f.vpc.privateSubnets.map((s) => s.subnetId).sort()).toEqual(
      cfg.vpc.appSubnets.map((s) => s.subnetId).sort(),
    );
    expect(f.vpc.isolatedSubnets.map((s) => s.subnetId).sort()).toEqual(
      cfg.vpc.dataSubnets.map((s) => s.subnetId).sort(),
    );
    expect(f.dataKey.keyArn).toBe(cfg.kms.dataKeyArn);
    expect(f.logsKey.keyArn).toBe(cfg.kms.logsKeyArn);
    expect(f.permissionsBoundary.managedPolicyArn).toBe(cfg.permissionsBoundaryPolicyArn);
    expect(f.albCertificate.certificateArn).toBe(cfg.edge.albCertificateArn);
    expect(f.cloudFrontCertificate?.certificateArn).toMatch(/:acm:us-east-1:/);
  });

  it('provider gives each stack its own import (no cross-stack exports for foundation values)', () => {
    const app = newApp();
    const cfg = loadEnvironmentConfig('dev').foundation;
    if (cfg.mode !== 'import') throw new Error('expected import');
    const provider = new ImportedFoundationProvider(cfg);
    const a = new Stack(app, 'A', { env: { account: '000000000000', region: 'ap-southeast-1' } });
    const b = new Stack(app, 'B', { env: { account: '000000000000', region: 'ap-southeast-1' } });
    expect(provider.forStack(a)).toBe(provider.forStack(a));
    expect(provider.forStack(a)).not.toBe(provider.forStack(b));
  });

  it('a synthesized governed stage never imports foundation values across stacks', () => {
    const { templates } = synthStage('staging');
    const json = JSON.stringify(Object.values(templates).map((t) => t.toJSON()));
    const imports = [...json.matchAll(/"Fn::ImportValue":"([^"]+)"/g)].map((m) => m[1]!);
    expect(imports.length).toBeGreaterThan(0);
    for (const name of imports) {
      expect(name).not.toMatch(/Foundation|Vpc|Subnet|Key|Certificate/);
    }
  });

  it('no context lookups are performed (offline synth)', () => {
    const { app } = synthStage('prod');
    const missing = app.synth().manifest.missing ?? [];
    expect(missing).toEqual([]);
  });
});

describe('SandboxFoundation (opt-in, dev only)', () => {
  const config = loadEnvironmentConfig('dev', { foundationMode: 'sandbox' });
  if (config.foundation.mode !== 'sandbox') throw new Error('expected sandbox');
  const app = newApp();
  const stack = new SandboxFoundationStack(app, 'Foundation', {
    ...workloadStackProps(config, 'foundation', 'sandbox'),
    config: config.foundation,
    resourcePrefix: config.resourcePrefix,
    logRetention: logs.RetentionDays.ONE_MONTH,
  });
  const template = Template.fromStack(stack);

  it('creates a 3-tier VPC in explicit AZs with flow logs and gateway endpoints', () => {
    template.hasResourceProperties('AWS::EC2::VPC', { CidrBlock: '10.42.0.0/16' });
    const subnets = template.findResources('AWS::EC2::Subnet');
    expect(Object.keys(subnets)).toHaveLength(6);
    expect(stack.availabilityZones).toEqual(['ap-southeast-1a', 'ap-southeast-1b']);
    template.hasResourceProperties('AWS::EC2::FlowLog', { TrafficType: 'ALL' });
    template.resourceCountIs('AWS::EC2::VPCEndpoint', 2);
    template.resourceCountIs('AWS::EC2::NatGateway', 1);
  });

  it('creates rotating CMKs (logs key usable by CloudWatch Logs)', () => {
    template.resourceCountIs('AWS::KMS::Key', 2);
    template.hasResourceProperties('AWS::KMS::Key', {
      EnableKeyRotation: true,
      KeyPolicy: {
        Statement: Match.arrayWith([
          Match.objectLike({ Principal: { Service: 'logs.ap-southeast-1.amazonaws.com' } }),
        ]),
      },
    });
  });

  it('access-log bucket pre-authorises S3 server access logs and ALB logs', () => {
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Sid: 'S3ServerAccessLogs' }),
          Match.objectLike({ Sid: 'AlbAccessLogs' }),
        ]),
      },
    });
  });

  it('passes cdk-nag', () => {
    expect(nagViolations(stack)).toEqual([]);
  });

  it('consumers get re-imported keys and bucket, avoiding dependency cycles', () => {
    const provider = new SandboxFoundationProvider(stack);
    const consumer = new Stack(app, 'Consumer', {
      env: { account: '000000000000', region: 'ap-southeast-1' },
    });
    const view = provider.forStack(consumer);
    expect(view.dataKey).not.toBe(stack.foundation.dataKey);
    expect(view.accessLogsBucket).not.toBe(stack.foundation.accessLogsBucket);
    expect(consumer.dependencies).toContain(stack);
  });

  it('a full dev stage synthesizes in sandbox mode', () => {
    const { stage } = synthStage('dev', { foundationMode: 'sandbox' });
    expect(stage.foundationStack).toBeDefined();
    expect(nagViolations(stage)).toEqual([]);
  });
});

describe('SandboxFoundation in another region (region-specific constants looked up per region)', () => {
  const albLogPrincipal = (region: string): unknown => {
    const config = loadEnvironmentConfig('dev', { foundationMode: 'sandbox', region });
    if (config.foundation.mode !== 'sandbox') throw new Error('expected sandbox');
    const app = newApp();
    const stack = new SandboxFoundationStack(app, 'Foundation', {
      ...workloadStackProps(config, 'foundation', 'sandbox'),
      config: config.foundation,
      resourcePrefix: config.resourcePrefix,
      logRetention: logs.RetentionDays.ONE_MONTH,
    });
    expect(stack.region).toBe(region);
    expect(stack.availabilityZones).toEqual([`${region}a`, `${region}b`]);
    const policies = Template.fromStack(stack).findResources('AWS::S3::BucketPolicy');
    const statements = Object.values(policies).flatMap(
      (p) =>
        (p as { Properties: { PolicyDocument: { Statement: Record<string, unknown>[] } } })
          .Properties.PolicyDocument.Statement,
    );
    return statements.find((s) => s.Sid === 'AlbAccessLogs')?.Principal;
  };

  it('ALB log delivery: the ELB account of the region, never the default region one', () => {
    const def = JSON.stringify(albLogPrincipal('ap-southeast-1'));
    const eu = JSON.stringify(albLogPrincipal('eu-west-1'));
    expect(def).toContain('114774131450');
    expect(eu).toContain('156460612806');
    expect(eu).not.toContain('114774131450');
  });

  it('a region without an ELB account uses the log-delivery service principal', () => {
    expect(albLogPrincipal('ap-southeast-5')).toEqual({
      Service: 'logdelivery.elasticloadbalancing.amazonaws.com',
    });
  });
});
