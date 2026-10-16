import { PROCESSING_WORKFLOW } from '@starter/workflow-processing';
import { toAslRetrier } from '@starter/workflow-processing/cdk';
import { Stack } from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import {
  ENVIRONMENT_NAMES,
  REQUIRED_TAG_KEYS,
  loadEnvironmentConfig,
} from '../environments/index.js';
import { applyPolicyChecks } from '../lib/policy-hook.js';
import { WorkloadStage, STAGE_IDS } from '../stages/workload-stage.js';
import {
  FIXTURE_ENTRIES,
  TEST_DIGEST,
  nagViolations,
  newApp,
  resourcesOf,
  stateMachineDefinition,
  synthStage,
} from './helpers.js';

describe.each(ENVIRONMENT_NAMES)('%s stage', (name) => {
  const { stage, templates, config } = synthStage(name);
  const stacks = [
    stage.platform,
    stage.data,
    stage.workflow,
    stage.migrations,
    stage.api,
    stage.frontend,
    stage.observability,
  ];
  const all = Object.values(templates);
  const regulated = name !== 'dev';

  it('has the expected stacks, names, env and bootstrap qualifier', () => {
    expect(stacks.map((s) => s.stackName)).toEqual(
      ['platform', 'data', 'workflow', 'migrations', 'api', 'frontend', 'observability'].map(
        (s) => `${config.resourcePrefix}-${s}`,
      ),
    );
    for (const s of stacks) {
      expect(s.region).toBe('ap-southeast-1');
      expect(s.account).toBe(config.account);
      expect(s.terminationProtection).toBe(regulated);
    }
    expect(templates.Data.toJSON().Parameters.BootstrapVersion.Default).toBe(
      `/cdk-bootstrap/${config.cdkBootstrapQualifier}/version`,
    );
  });

  it('passes cdk-nag with no unacknowledged findings', () => {
    expect(nagViolations(stage)).toEqual([]);
  });

  it('has no synth errors (required tags, log retention/KMS aspects)', () => {
    for (const s of stacks) {
      expect(Annotations.fromStack(s).findError('*', Match.anyValue())).toEqual([]);
    }
  });

  it('every taggable resource carries the six required tags', () => {
    let checked = 0;
    for (const t of all) {
      for (const [, r] of Object.entries(
        t.toJSON().Resources as Record<string, { Properties?: { Tags?: unknown } }>,
      )) {
        const tags = r.Properties?.Tags;
        if (!Array.isArray(tags)) continue;
        const keys = (tags as { Key: string }[]).map((x) => x.Key);
        for (const k of REQUIRED_TAG_KEYS) expect(keys).toContain(k);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(20);
    for (const s of stacks) expect(Stack.of(s).tags.tagValues()).toMatchObject(config.tags);
  });

  it('every IAM role has the landing-zone permissions boundary', () => {
    const boundary =
      config.foundation.mode === 'import'
        ? config.foundation.permissionsBoundaryPolicyArn
        : undefined;
    const roles = all.flatMap((t) => resourcesOf(t, 'AWS::IAM::Role'));
    expect(roles.length).toBeGreaterThan(3);
    for (const [, role] of roles) expect(role.PermissionsBoundary).toBe(boundary);
  });

  it('stateful resources: RDS + DynamoDB protection matches the environment', () => {
    templates.Data.hasResource('AWS::RDS::DBInstance', {
      DeletionPolicy: regulated ? 'Retain' : 'Snapshot',
      Properties: Match.objectLike({
        DeletionProtection: regulated,
        StorageEncrypted: true,
        PubliclyAccessible: false,
      }),
    });
    templates.Data.hasResource('AWS::DynamoDB::Table', {
      DeletionPolicy: regulated ? 'Retain' : 'Delete',
      Properties: Match.objectLike({
        DeletionProtectionEnabled: regulated,
        PointInTimeRecoverySpecification: Match.objectLike({ PointInTimeRecoveryEnabled: true }),
      }),
    });
  });

  it('no public S3: every bucket blocks public access; no Allow to "*"', () => {
    for (const t of all) {
      for (const [, b] of resourcesOf(t, 'AWS::S3::Bucket')) {
        expect(b.PublicAccessBlockConfiguration).toEqual({
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        });
      }
      for (const [, p] of resourcesOf(t, 'AWS::S3::BucketPolicy')) {
        for (const s of (
          p.PolicyDocument as { Statement: { Effect: string; Principal: unknown }[] }
        ).Statement) {
          if (s.Effect === 'Allow') expect(s.Principal).not.toEqual({ AWS: '*' });
        }
      }
    }
  });

  it('CloudFront uses OAC, TLSv1.2_2021 and the us-east-1 certificate; ALB is internal HTTPS', () => {
    templates.Frontend.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
    templates.Frontend.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        ViewerCertificate: Match.objectLike({
          MinimumProtocolVersion: 'TLSv1.2_2021',
          AcmCertificateArn: config.foundation.edge.cloudFrontCertificateArn,
        }),
        ...(regulated ? { WebACLId: config.foundation.edge.wafWebAclArn } : {}),
      }),
    });
    templates.Api.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      Scheme: 'internal',
    });
    for (const [, l] of resourcesOf(templates.Api, 'AWS::ElasticLoadBalancingV2::Listener')) {
      expect(l.Protocol).toBe('HTTPS');
    }
  });

  it('Lambda versions + live aliases, and Step Functions retries equal the spec', () => {
    // validator, processor and the reconciler
    templates.Workflow.resourceCountIs('AWS::Lambda::Alias', 3);
    templates.Workflow.resourceCountIs('AWS::Lambda::Version', 3);
    const def = stateMachineDefinition(templates.Workflow);
    for (const task of Object.values(PROCESSING_WORKFLOW.tasks)) {
      expect(def.States[task.state]!.Retry).toEqual(task.retry.map(toAslRetrier));
      expect(def.States[task.state]!.TimeoutSeconds).toBe(task.timeoutSeconds);
    }
    expect(def.TimeoutSeconds).toBe(PROCESSING_WORKFLOW.executionTimeoutSeconds);
  });

  it('workflow Lambdas reserve concurrency within the starter_processor connection limit', () => {
    const fns = resourcesOf(templates.Workflow, 'AWS::Lambda::Function');
    const steps = fns.filter(([id]) => /Validator|Processor/.test(id));
    expect(steps).toHaveLength(2);
    expect(steps.map(([, p]) => p.ReservedConcurrentExecutions)).toEqual(
      Array(2).fill(config.workflow.reservedConcurrency),
    );
    // One connection per warm environment (pool max 1): both functions at full concurrency fit.
    expect(config.workflow.reservedConcurrency).not.toBeNull();
    expect(2 * (config.workflow.reservedConcurrency ?? Infinity)).toBeLessThanOrEqual(
      config.database.connectionLimits.processor - 2,
    );
    // Exactly ONE reconciler, reserved concurrency 1.
    const reconcilers = fns.filter(([id]) => id.startsWith('ReconcilerFunction'));
    expect(reconcilers.map(([, p]) => p.ReservedConcurrentExecutions)).toEqual([1]);
  });

  it('state machine is CMK-encrypted and the API may encrypt execution input with it', () => {
    templates.Workflow.hasResourceProperties('AWS::StepFunctions::StateMachine', {
      EncryptionConfiguration: Match.objectLike({ Type: 'CUSTOMER_MANAGED_KMS_KEY' }),
    });
    const api = JSON.stringify(templates.Api.toJSON());
    expect(api).toContain('StartExecutionWithCmk');
    expect(api).toContain('kms:EncryptionContext:aws:states:stateMachineArn');
  });

  it('never logs execution payloads outside dev', () => {
    const [[, machine]] = resourcesOf(templates.Workflow, 'AWS::StepFunctions::StateMachine') as [
      [string, { LoggingConfiguration: { IncludeExecutionData: boolean } }],
    ];
    expect(machine.LoggingConfiguration.IncludeExecutionData).toBe(name === 'dev');
  });

  it('ECS image is pinned by digest', () => {
    expect(JSON.stringify(templates.Api.toJSON())).toContain(`@${TEST_DIGEST}`);
  });

  it('templates stay well inside CloudFormation limits', () => {
    for (const t of all) {
      const json = JSON.stringify(t.toJSON());
      expect(json.length).toBeLessThan(400_000);
      expect(Object.keys(t.toJSON().Resources).length).toBeLessThan(250);
    }
  });
});

describe('environment differences are data only', () => {
  it('dev, staging and prod synthesize the same resource types per stack', () => {
    const types = (name: (typeof ENVIRONMENT_NAMES)[number]) =>
      Object.fromEntries(
        Object.entries(synthStage(name).templates).map(([k, t]) => [
          k,
          [
            ...new Set(
              Object.values(t.toJSON().Resources as Record<string, { Type: string }>).map(
                (r) => r.Type,
              ),
            ),
          ].sort(),
        ]),
      );
    const dev = types('dev');
    const prod = types('prod');
    // prod adds the RDS enhanced-monitoring role; everything else is identical.
    expect({ ...prod, Data: prod.Data!.filter((t) => t !== 'AWS::IAM::Role') }).toEqual({
      ...dev,
      Data: dev.Data!.filter((t) => t !== 'AWS::IAM::Role'),
    });
    expect(types('staging')).toEqual(prod);
  });
});

describe('policy hook at app level', () => {
  it('a full three-environment app synthesizes with AwsSolutions enabled', () => {
    const app = newApp();
    for (const name of ENVIRONMENT_NAMES) {
      new WorkloadStage(app, STAGE_IDS[name], {
        config: loadEnvironmentConfig(name),
        imageDigest: TEST_DIGEST,
        handlerEntries: FIXTURE_ENTRIES,
      });
    }
    applyPolicyChecks(app);
    expect(() => app.synth()).not.toThrow();
  });
});

describe.each(ENVIRONMENT_NAMES)('%s stage in another region (-c region=eu-west-1)', (name) => {
  const { stage, templates, config } = synthStage(name, { region: 'eu-west-1' });

  it('pins every stack to the configured region; nothing refers to the default region', () => {
    expect(config.region).toBe('eu-west-1');
    for (const s of stage.node.children.filter((c): c is Stack => Stack.isStack(c))) {
      expect(s.region).toBe('eu-west-1');
    }
    for (const t of Object.values(templates)) {
      expect(JSON.stringify(t.toJSON())).not.toContain('ap-southeast-1');
    }
    expect(JSON.stringify(templates.Data.toJSON())).toContain('arn:aws:kms:eu-west-1:');
  });

  it('passes cdk-nag with no unacknowledged findings', () => {
    expect(nagViolations(stage)).toEqual([]);
  });
});
