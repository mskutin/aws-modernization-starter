import type { Finding, PolicyRule } from '../types.js';
import { finding, isClusterMemberInstance, isPresent, isRecord, props } from './util.js';

const INSTANCE = 'AWS::RDS::DBInstance';
const CLUSTER = 'AWS::RDS::DBCluster';
const PROTECTED_ENVS = ['staging', 'prod'] as const;
export const MIN_BACKUP_RETENTION_DAYS = 7;

/** PostgreSQL 15+ defaults `rds.force_ssl` to 1 in the default parameter group. */
const FORCE_SSL_DEFAULT_FROM_MAJOR = 15;

const postgresMajorFromFamily = (family: unknown): number | undefined => {
  const m = typeof family === 'string' ? /^(?:aurora-)?postgres(?:ql)?(\d+)/.exec(family) : null;
  return m?.[1] ? Number(m[1]) : undefined;
};

const postgresMajorFromVersion = (version: unknown): number | undefined => {
  const m = typeof version === 'string' ? /^(\d+)/.exec(version) : null;
  return m?.[1] ? Number(m[1]) : undefined;
};

export const rdsRules: PolicyRule[] = [
  {
    id: 'BASE-RDS-001',
    title: 'RDS storage is encrypted',
    description:
      'DB instances (other than Aurora members, which inherit from the cluster) and DB clusters set StorageEncrypted to true.',
    rationale: 'Encryption at rest is a baseline for any data classification above public.',
    severity: 'high',
    engines: ['cdk-nag', 'guard'],
    resourceTypes: [INSTANCE, CLUSTER],
    remediation:
      'Set `storageEncrypted: true` and preferably a customer-managed `storageEncryptionKey`.',
    evaluate: ({ resource }) => {
      if (isClusterMemberInstance(resource)) return 'not-applicable';
      return props(resource)['StorageEncrypted'] === true
        ? []
        : [finding('Properties/StorageEncrypted', 'StorageEncrypted is not true.')];
    },
  },
  {
    id: 'BASE-RDS-002',
    title: 'RDS instances are not publicly accessible',
    description: 'DB instances set PubliclyAccessible explicitly to false.',
    rationale:
      'The CloudFormation default depends on the subnet group (true in default VPCs); being explicit removes ambiguity.',
    severity: 'critical',
    engines: ['cdk-nag', 'guard'],
    resourceTypes: [INSTANCE],
    remediation: 'Place the database in isolated/private subnets (CDK then renders false).',
    evaluate: ({ resource }) =>
      props(resource)['PubliclyAccessible'] === false
        ? []
        : [finding('Properties/PubliclyAccessible', 'PubliclyAccessible must be false.')],
  },
  {
    id: 'BASE-RDS-003',
    title: 'RDS deletion protection in staging/prod',
    description:
      'In staging and prod, DB instances (non-Aurora members) and clusters set DeletionProtection to true.',
    rationale:
      'Prevents accidental deletion through the console, API or a CloudFormation replacement.',
    severity: 'high',
    engines: ['cdk-nag', 'guard'],
    resourceTypes: [INSTANCE, CLUSTER],
    environments: PROTECTED_ENVS,
    remediation: 'Set `deletionProtection: true` for staging/prod stages.',
    evaluate: ({ resource }) => {
      if (isClusterMemberInstance(resource)) return 'not-applicable';
      return props(resource)['DeletionProtection'] === true
        ? []
        : [finding('Properties/DeletionProtection', 'DeletionProtection is not true.')];
    },
  },
  {
    id: 'BASE-RDS-004',
    title: 'RDS automated backups in staging/prod',
    description: `In staging and prod, DB instances (non-Aurora members) and clusters keep automated backups for at least ${MIN_BACKUP_RETENTION_DAYS} days.`,
    rationale: 'Point-in-time restore is the primary recovery mechanism for the relational store.',
    severity: 'high',
    engines: ['cdk-nag', 'guard'],
    resourceTypes: [INSTANCE, CLUSTER],
    environments: PROTECTED_ENVS,
    remediation: `Set \`backupRetention: Duration.days(${MIN_BACKUP_RETENTION_DAYS})\` or more.`,
    evaluate: ({ resource }) => {
      if (isClusterMemberInstance(resource)) return 'not-applicable';
      const days = props(resource)['BackupRetentionPeriod'];
      return typeof days === 'number' && days >= MIN_BACKUP_RETENTION_DAYS
        ? []
        : [
            finding(
              'Properties/BackupRetentionPeriod',
              `BackupRetentionPeriod must be >= ${MIN_BACKUP_RETENTION_DAYS} (got ${String(days)}).`,
            ),
          ];
    },
  },
  {
    id: 'BASE-RDS-005',
    title: 'PostgreSQL connections require TLS',
    description:
      'PostgreSQL parameter groups never set rds.force_ssl to anything but 1, and must set it to 1 for engine majors below 15. PostgreSQL instances below major 15 must use a custom parameter group.',
    rationale:
      'Without rds.force_ssl, clients may connect in clear text. PostgreSQL 15+ default parameter groups enforce TLS.',
    severity: 'high',
    engines: ['cdk-nag', 'guard'],
    resourceTypes: ['AWS::RDS::DBParameterGroup', 'AWS::RDS::DBClusterParameterGroup', INSTANCE],
    remediation:
      'Use PostgreSQL 15+ (project: 17) and do not override rds.force_ssl, or set it to "1" in a custom parameter group.',
    evaluate: ({ resource }): Finding[] | 'not-applicable' => {
      const p = props(resource);
      if (resource.Type === INSTANCE) {
        if (p['Engine'] !== 'postgres') return 'not-applicable';
        const major = postgresMajorFromVersion(p['EngineVersion']);
        if (major !== undefined && major < FORCE_SSL_DEFAULT_FROM_MAJOR) {
          return isPresent(p['DBParameterGroupName'])
            ? []
            : [
                finding(
                  'Properties/DBParameterGroupName',
                  `PostgreSQL ${major} default parameter group does not enforce TLS.`,
                ),
              ];
        }
        return [];
      }
      const major = postgresMajorFromFamily(p['Family']);
      if (major === undefined) return 'not-applicable';
      const params = isRecord(p['Parameters']) ? p['Parameters'] : {};
      const force = params['rds.force_ssl'];
      if (force === undefined) {
        return major < FORCE_SSL_DEFAULT_FROM_MAJOR
          ? [
              finding(
                'Properties/Parameters/rds.force_ssl',
                `rds.force_ssl must be "1" for PostgreSQL ${major}.`,
              ),
            ]
          : [];
      }
      return String(force) === '1'
        ? []
        : [
            finding(
              'Properties/Parameters/rds.force_ssl',
              `rds.force_ssl is ${String(force)}; must be "1".`,
            ),
          ];
    },
  },
];
