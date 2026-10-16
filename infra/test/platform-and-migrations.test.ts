import { Match } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import {
  BOOTSTRAP_COMMAND,
  BOOTSTRAP_CONTAINER_NAME,
  MIGRATION_COMMAND,
  MIGRATION_CONTAINER_NAME,
  RETENTION_COMMAND,
  RETENTION_CONTAINER_NAME,
} from '../constructs/database-migration-task.js';
import { IMAGE_RDS_CA_BUNDLE_PATH, NODE_CONTAINER_USER } from '../constructs/node-container.js';
import { TEST_DIGEST, nagViolations, resourcesOf, synthStage } from './helpers.js';

describe('PlatformStack', () => {
  const { templates, config, stage } = synthStage('prod');
  const t = templates.Platform;

  it('owns the ECS cluster (Fargate + Spot providers, Container Insights enhanced)', () => {
    t.hasResourceProperties('AWS::ECS::Cluster', {
      ClusterName: `${config.resourcePrefix}-cluster`,
      ClusterSettings: [{ Name: 'containerInsights', Value: 'enhanced' }],
    });
    t.hasResourceProperties('AWS::ECS::ClusterCapacityProviderAssociations', {
      CapacityProviders: ['FARGATE', 'FARGATE_SPOT'],
    });
  });

  it('owns the immutable, scanned, CMK-encrypted image repository', () => {
    t.hasResource('AWS::ECR::Repository', {
      DeletionPolicy: 'Retain',
      Properties: Match.objectLike({
        RepositoryName: `${config.resourcePrefix}/api`,
        ImageTagMutability: 'IMMUTABLE',
        ImageScanningConfiguration: { ScanOnPush: true },
      }),
    });
    expect(Object.keys(t.toJSON().Outputs as object)).toEqual(
      expect.arrayContaining(['ClusterName', 'EcrRepositoryUri', 'EcrRepositoryName']),
    );
  });

  it('API and migration stacks consume the platform; API waits for migrations', () => {
    expect(stage.migrations.dependencies).toContain(stage.platform);
    expect(stage.api.dependencies).toEqual(
      expect.arrayContaining([stage.platform, stage.migrations]),
    );
  });

  it('passes cdk-nag', () => {
    expect(nagViolations(stage.platform)).toEqual([]);
  });
});

describe('MigrationsStack (one-off database tasks, ADR 0220/0221)', () => {
  const { templates, config, stage } = synthStage('prod');
  const t = templates.Migrations;
  const taskDefs = resourcesOf(t, 'AWS::ECS::TaskDefinition');
  const byFamily = (family: string) => {
    const found = taskDefs.find(([, td]) => td.Family === family);
    if (!found) throw new Error(`no task definition ${family}`);
    return found[1];
  };
  const containerOf = (td: Record<string, unknown>) =>
    (td.ContainerDefinitions as Record<string, unknown>[])[0]!;
  const envOf = (td: Record<string, unknown>) =>
    Object.fromEntries(
      (containerOf(td).Environment as { Name: string; Value: unknown }[]).map((e) => [
        e.Name,
        e.Value,
      ]),
    );
  const migrationTd = byFamily(`${config.resourcePrefix}-db-migrate`);
  const bootstrapTd = byFamily(`${config.resourcePrefix}-db-bootstrap`);
  const retentionTd = byFamily(`${config.resourcePrefix}-db-retention`);
  const policies = resourcesOf(t, 'AWS::IAM::Policy').map(([, p]) => p);
  const statementsOf = (roleRef: RegExp) =>
    policies
      .filter((p) => JSON.stringify(p.Roles).match(roleRef))
      .flatMap((p) => (p.PolicyDocument as { Statement: Record<string, unknown>[] }).Statement);

  it('three hardened one-off tasks on the API image digest: bootstrap, migrate, retention', () => {
    expect(taskDefs).toHaveLength(3);
    for (const [td, name, command] of [
      [migrationTd, MIGRATION_CONTAINER_NAME, MIGRATION_COMMAND],
      [bootstrapTd, BOOTSTRAP_CONTAINER_NAME, BOOTSTRAP_COMMAND],
      [retentionTd, RETENTION_CONTAINER_NAME, RETENTION_COMMAND],
    ] as const) {
      const container = containerOf(td);
      expect(JSON.stringify(container.Image)).toContain(`@${TEST_DIGEST}`);
      expect(container).toMatchObject({
        Name: name,
        Command: command,
        User: NODE_CONTAINER_USER,
        ReadonlyRootFilesystem: true,
        Privileged: false,
        LinuxParameters: { Capabilities: { Drop: ['ALL'] }, InitProcessEnabled: true },
      });
      expect(container.HealthCheck).toBeUndefined();
      expect(container.Secrets).toBeUndefined(); // no ECS-injected credential at all
      expect(td).toMatchObject({
        RuntimePlatform: { CpuArchitecture: 'ARM64', OperatingSystemFamily: 'LINUX' },
      });
    }
  });

  it('migration task: starter_migrator with IAM auth and verify-full TLS, nothing secret', () => {
    expect(envOf(migrationTd)).toMatchObject({
      DB_USER: 'starter_migrator',
      DB_AUTH: 'iam',
      DB_SSL: 'verify-full',
      DB_SSL_ROOT_CERT: IMAGE_RDS_CA_BUNDLE_PATH,
      AWS_REGION: 'ap-southeast-1',
      NODE_ENV: 'production',
    });
    expect(Object.keys(envOf(migrationTd)).sort()).toEqual(
      [
        'APP_ENVIRONMENT',
        'AWS_REGION',
        'DB_AUTH',
        'DB_HOST',
        'DB_NAME',
        'DB_PORT',
        'DB_SSL',
        'DB_SSL_ROOT_CERT',
        'DB_USER',
        'LOG_LEVEL',
        'NODE_ENV',
      ].sort(),
    );
    // Task role: rds-db:connect as starter_migrator, nothing else.
    const statements = statementsOf(/DatabaseMigrationTaskRole/);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatchObject({ Action: 'rds-db:connect', Effect: 'Allow' });
    expect(JSON.stringify(statements[0]?.Resource)).toMatch(/dbuser:.*\/starter_migrator"/);
  });

  it('bootstrap task: master user, secret ARN only (read at runtime), login roles on IAM', () => {
    const env = envOf(bootstrapTd);
    expect(env).toMatchObject({
      DB_USER: config.database.masterUsername,
      DB_AUTH: 'secrets-manager',
      DB_SSL: 'verify-full',
      DB_SSL_ROOT_CERT: IMAGE_RDS_CA_BUNDLE_PATH,
      DB_BOOTSTRAP_LOGIN_AUTH: 'iam',
      // prod: 2 x maxCapacity (9) x apiPoolMax (5)
      DB_BOOTSTRAP_APP_CONNECTION_LIMIT: String(
        2 * config.api.maxCapacity * config.database.apiPoolMax,
      ),
      DB_BOOTSTRAP_MIGRATOR_CONNECTION_LIMIT: '3',
      DB_BOOTSTRAP_PROCESSOR_CONNECTION_LIMIT: '20',
      DB_BOOTSTRAP_RETENTION_CONNECTION_LIMIT: '2',
    });
    expect(JSON.stringify(env.DB_SECRET_ARN)).toContain('Fn::ImportValue');
    expect(Object.keys(env)).not.toContain('DB_PASSWORD');
    // Task role: read exactly the master secret, decrypt only via Secrets Manager; no rds-db.
    const statements = statementsOf(/DatabaseBootstrapTaskRole/);
    expect(statements.map((st) => st.Sid).sort()).toEqual([
      'DecryptMasterSecretViaSecretsManager',
      'ReadMasterSecretAtRuntime',
    ]);
    expect(statements.find((st) => st.Sid === 'ReadMasterSecretAtRuntime')).toMatchObject({
      Action: 'secretsmanager:GetSecretValue',
    });
    expect(JSON.stringify(statements)).not.toContain('rds-db:connect');
  });

  it('retention task: starter_retention with IAM auth, DISABLED by default, not scheduled', () => {
    expect(envOf(retentionTd)).toMatchObject({
      DB_USER: 'starter_retention',
      DB_AUTH: 'iam',
      DB_SSL: 'verify-full',
      RETENTION_MODE: 'disabled',
    });
    expect(Object.keys(envOf(retentionTd))).not.toContain('RETENTION_APPROVAL_REF');
    const statements = statementsOf(/DatabaseRetentionTaskRole/);
    expect(statements).toHaveLength(1);
    expect(JSON.stringify(statements[0]?.Resource)).toMatch(/dbuser:.*\/starter_retention"/);
    // No schedule: nothing in the stack runs the task.
    expect(resourcesOf(t, 'AWS::Events::Rule')).toEqual([]);
    expect(resourcesOf(t, 'AWS::Scheduler::Schedule')).toEqual([]);
  });

  it('execution roles never touch secrets; security groups have no ingress', () => {
    for (const statement of statementsOf(/ExecutionRole/)) {
      expect(JSON.stringify(statement)).not.toMatch(/secretsmanager|kms:Decrypt/);
    }
    for (const description of ['DB migration task', 'DB bootstrap task', 'DB retention task']) {
      t.hasResourceProperties('AWS::EC2::SecurityGroup', {
        GroupDescription: Match.stringLikeRegexp(description),
        SecurityGroupEgress: [Match.objectLike({ FromPort: 443, ToPort: 443 })],
        SecurityGroupIngress: Match.absent(),
      });
    }
    const ingress = resourcesOf(t, 'AWS::EC2::SecurityGroupIngress').map(([, r]) => r);
    expect(ingress).toHaveLength(3);
    for (const rule of ingress) {
      expect(rule).toMatchObject({ FromPort: 5432, ToPort: 5432 });
      expect(JSON.stringify(rule.GroupId)).toMatch(/DatabaseSecurityGroup/);
    }
  });

  it('exposes what the pipeline needs to run the tasks (bootstrap first)', () => {
    expect(Object.keys(t.toJSON().Outputs as object)).toEqual(
      expect.arrayContaining([
        'MigrationClusterName',
        'MigrationSubnetIds',
        'BootstrapTaskDefinitionArn',
        'BootstrapContainerName',
        'BootstrapSecurityGroupId',
        'BootstrapLogGroupName',
        'MigrationTaskDefinitionArn',
        'MigrationContainerName',
        'MigrationSecurityGroupId',
        'MigrationLogGroupName',
        'RetentionTaskDefinitionArn',
        'RetentionContainerName',
        'RetentionSecurityGroupId',
      ]),
    );
  });

  it('passes cdk-nag', () => {
    expect(nagViolations(stage.migrations)).toEqual([]);
  });
});

describe('ApiStack database identity (DB wiring of the API task)', () => {
  const { templates } = synthStage('prod');
  const t = templates.Api;

  it('the API task role may connect as starter_app only, via IAM', () => {
    const statements = resourcesOf(t, 'AWS::IAM::Policy').flatMap(
      ([, p]) => (p.PolicyDocument as { Statement: Record<string, unknown>[] }).Statement,
    );
    const connect = statements.filter((st) => st.Action === 'rds-db:connect');
    expect(connect).toHaveLength(1);
    expect(JSON.stringify(connect[0]?.Resource)).toMatch(/dbuser:.*\/starter_app"/);
    expect(JSON.stringify(statements)).not.toMatch(/secretsmanager|DecryptDbSecret/);
  });

  it('no master secret reference and no DB credential in the API task definition', () => {
    const [, td] = resourcesOf(t, 'AWS::ECS::TaskDefinition')[0]!;
    const container = (td.ContainerDefinitions as Record<string, unknown>[])[0]!;
    expect(container.Secrets).toBeUndefined();
    const env = Object.fromEntries(
      (container.Environment as { Name: string; Value: unknown }[]).map((e) => [e.Name, e.Value]),
    );
    expect(env).toMatchObject({
      DB_USER: 'starter_app',
      DB_AUTH: 'iam',
      DB_SSL: 'verify-full',
      DB_SSL_ROOT_CERT: IMAGE_RDS_CA_BUNDLE_PATH,
    });
    expect(JSON.stringify(td)).not.toMatch(/DatabaseSecret|SecretTargetAttachment|secretsmanager/i);
  });
});
