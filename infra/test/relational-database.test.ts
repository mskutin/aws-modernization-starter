import { RemovalPolicy } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as logs from 'aws-cdk-lib/aws-logs';
import { describe, expect, it } from 'vitest';
import { POSTGRES_LOG_EXPORTS, RelationalDatabase } from '../constructs/relational-database.js';
import { importedFoundation, nagViolations, testStack } from './helpers.js';

type Variant = 'prod' | 'dev';

function build(
  variant: Variant,
  rotation = true,
  beforeSynth?: (ctx: {
    stack: ReturnType<typeof testStack>;
    db: RelationalDatabase;
    f: ReturnType<typeof importedFoundation>;
  }) => void,
) {
  const stack = testStack();
  const f = importedFoundation(stack);
  const prod = variant === 'prod';
  const db = new RelationalDatabase(stack, 'Database', {
    resourcePrefix: 'starter-test',
    vpc: f.vpc,
    subnets: f.dataSubnets,
    rotationSubnets: f.appSubnets,
    encryptionKey: f.dataKey,
    logsKey: f.logsKey,
    logRetention: logs.RetentionDays.ONE_YEAR,
    engineVersion: '17.9',
    instanceType: prod ? 'm7g.large' : 't4g.micro',
    multiAz: prod,
    allocatedStorageGiB: 100,
    maxAllocatedStorageGiB: 500,
    backupRetentionDays: prod ? 35 : 1,
    deletionProtection: prod,
    removalPolicy: prod ? RemovalPolicy.RETAIN : RemovalPolicy.SNAPSHOT,
    performanceInsights: prod,
    monitoringIntervalSeconds: prod ? 15 : 0,
    databaseName: 'starterapp',
    masterUsername: 'starteradmin',
    rotation: { enabled: rotation, intervalDays: 30 },
  });
  beforeSynth?.({ stack, db, f });
  return { stack, db, f, template: Template.fromStack(stack) };
}

describe('RelationalDatabase', () => {
  it('runs PostgreSQL 17 privately in the data subnets with CMK-encrypted storage', () => {
    const { template, f } = build('prod');
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      Engine: 'postgres',
      EngineVersion: Match.stringLikeRegexp('^17\\.'),
      PubliclyAccessible: false,
      StorageEncrypted: true,
      KmsKeyId: f.dataKey.keyArn,
      StorageType: 'gp3',
      EnableIAMDatabaseAuthentication: true,
      CACertificateIdentifier: 'rds-ca-rsa2048-g1',
      EnableCloudwatchLogsExports: [...POSTGRES_LOG_EXPORTS],
    });
    template.hasResourceProperties('AWS::RDS::DBSubnetGroup', {
      SubnetIds: f.vpc.isolatedSubnets.map((s) => s.subnetId),
    });
  });

  it('generates credentials in Secrets Manager encrypted with the data key', () => {
    const { template, f } = build('prod');
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'starter-test/rds/master',
      KmsKeyId: f.dataKey.keyArn,
      GenerateSecretString: Match.objectLike({
        SecretStringTemplate: '{"username":"starteradmin"}',
      }),
    });
  });

  it('forces SSL and SCRAM via the parameter group', () => {
    build('dev').template.hasResourceProperties('AWS::RDS::DBParameterGroup', {
      Family: 'postgres17',
      Parameters: Match.objectLike({ 'rds.force_ssl': '1', password_encryption: 'scram-sha-256' }),
    });
  });

  it('keeps bind parameters (titles, document content) out of the exported PostgreSQL log', () => {
    build('prod').template.hasResourceProperties('AWS::RDS::DBParameterGroup', {
      Parameters: Match.objectLike({
        log_min_duration_statement: '1000',
        log_parameter_max_length: '0',
        log_parameter_max_length_on_error: '0',
      }),
    });
  });

  it('pre-creates encrypted export log groups with retention', () => {
    const { template, f } = build('prod');
    for (const type of POSTGRES_LOG_EXPORTS) {
      template.hasResourceProperties('AWS::Logs::LogGroup', {
        LogGroupName: `/aws/rds/instance/starter-test-postgres/${type}`,
        RetentionInDays: 365,
        KmsKeyId: f.logsKey.keyArn,
      });
    }
  });

  it('prod: Multi-AZ, deletion protection, RETAIN, backups, PI and enhanced monitoring', () => {
    build('prod').template.hasResource('AWS::RDS::DBInstance', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
      Properties: Match.objectLike({
        MultiAZ: true,
        DeletionProtection: true,
        BackupRetentionPeriod: 35,
        EnablePerformanceInsights: true,
        MonitoringInterval: 15,
      }),
    });
  });

  it('dev: SNAPSHOT on delete, no deletion protection', () => {
    build('dev').template.hasResource('AWS::RDS::DBInstance', {
      DeletionPolicy: 'Snapshot',
      Properties: Match.objectLike({ MultiAZ: false, DeletionProtection: false }),
    });
  });

  it('security group has no ingress until a client is allowed, then only that client', () => {
    build('prod').template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: Match.stringLikeRegexp('PostgreSQL'),
      SecurityGroupIngress: Match.absent(),
    });
    let clientId: unknown;
    const { template } = build('prod', false, ({ stack, db, f }) => {
      const client = new ec2.SecurityGroup(stack, 'Client', {
        vpc: f.vpc,
        allowAllOutbound: false,
      });
      db.allowFrom(client, 'test client');
      clientId = stack.resolve(client.securityGroupId);
    });
    template.resourceCountIs('AWS::EC2::SecurityGroupIngress', 1);
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      IpProtocol: 'tcp',
      FromPort: 5432,
      ToPort: 5432,
      SourceSecurityGroupId: clientId,
    });
  });

  it('rotates the master secret (hosted rotation, 30 days)', () => {
    build('prod').template.hasResourceProperties('AWS::SecretsManager::RotationSchedule', {
      RotationRules: { ScheduleExpression: 'rate(30 days)' },
    });
  });

  it('without rotation cdk-nag reports AwsSolutions-SMG4: there is no suppression for it', () => {
    const findings = nagViolations(build('dev', false).stack);
    expect(findings.some((f) => f.includes('AwsSolutions-SMG4'))).toBe(true);
  });

  describe('identities (ADR 0220/0221)', () => {
    it('grantConnect: rds-db:connect for exactly one login role on this instance', () => {
      let roleId: unknown;
      const { template, stack, db } = build('prod', true, ({ stack, db }) => {
        const role = new iam.Role(stack, 'AppTaskRole', {
          assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
        });
        db.grantConnect(role, 'starter_app');
        roleId = stack.resolve(role.roleName);
      });
      template.hasResourceProperties('AWS::IAM::Policy', {
        Roles: [roleId],
        PolicyDocument: {
          Statement: [
            {
              Action: 'rds-db:connect',
              Effect: 'Allow',
              Resource: {
                'Fn::Join': [
                  '',
                  [
                    Match.stringLikeRegexp('^arn:aws:rds-db:ap-southeast-1:\\d{12}:dbuser:$'),
                    stack.resolve(db.instanceResourceId),
                    '/starter_app',
                  ],
                ],
              },
            },
          ],
        },
      });
    });

    it.each(['starteradmin', 'starter_owner', 'postgres', 'starter_app*'])(
      'grantConnect refuses %s (master, NOLOGIN owner or not a contract login role)',
      (user) => {
        expect(() =>
          build('dev', true, ({ stack, db }) => {
            const role = new iam.Role(stack, 'Role', {
              assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
            });
            db.grantConnect(role, user as 'starter_app');
          }),
        ).toThrow(/is not a login role/);
      },
    );

    it('iamConnection (runtime) and bootstrapConnection (master, bootstrap task only)', () => {
      const { db } = build('dev');
      expect(
        db.iamConnection('starter_processor', { sslRootCertPath: '/var/task/rds.pem' }),
      ).toMatchObject({
        user: 'starter_processor',
        auth: { mode: 'iam' },
        name: 'starterapp',
        port: 5432,
        sslRootCertPath: '/var/task/rds.pem',
      });
      const bootstrap = db.bootstrapConnection();
      expect(bootstrap).toMatchObject({ user: 'starteradmin', auth: { mode: 'secrets-manager' } });
      expect(bootstrap.auth.mode === 'secrets-manager' && bootstrap.auth.secret).toBe(db.secret);
    });
  });

  it.each(['prod', 'dev'] as const)(
    '%s variant passes cdk-nag (with documented acknowledgments)',
    (v) => {
      expect(nagViolations(build(v).stack)).toEqual([]);
    },
  );
});
