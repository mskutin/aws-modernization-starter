import type { Finding, PolicyRule } from '../types.js';
import { asArray, finding, get, isPresent, props } from './util.js';

const TABLE = 'AWS::DynamoDB::Table';
const GLOBAL = 'AWS::DynamoDB::GlobalTable';

/** Runs `check` for a Table, or once per replica of a GlobalTable (TableV2). */
const perTableOrReplica = (
  resource: Parameters<PolicyRule['evaluate']>[0]['resource'],
  check: (holder: unknown, base: string) => Finding[],
): Finding[] => {
  const p = props(resource);
  if (resource.Type === TABLE) return check(p, 'Properties');
  const replicas = asArray(p['Replicas']);
  if (replicas.length === 0)
    return [finding('Properties/Replicas', 'Global table has no replicas.')];
  return replicas.flatMap((r, i) => check(r, `Properties/Replicas/${i}`));
};

export const dynamoDbRules: PolicyRule[] = [
  {
    id: 'BASE-DDB-001',
    title: 'DynamoDB tables are encrypted with a customer-managed KMS key',
    description:
      'Tables set SSESpecification SSEEnabled=true, SSEType=KMS and a KMSMasterKeyId; global tables set SSEEnabled/SSEType=KMS and a KMSMasterKeyId on every replica.',
    rationale:
      'A CMK gives the project control over key policy, rotation and the ability to revoke access (crypto-shredding).',
    severity: 'high',
    engines: ['cdk-nag', 'guard'],
    resourceTypes: [TABLE, GLOBAL],
    remediation:
      'Table: `encryption: TableEncryption.CUSTOMER_MANAGED, encryptionKey`. TableV2: `encryption: TableEncryptionV2.customerManagedKey(key)`.',
    evaluate: ({ resource }) => {
      const sse = get(props(resource), 'SSESpecification');
      const out: Finding[] = [];
      if (get(sse, 'SSEEnabled') !== true || get(sse, 'SSEType') !== 'KMS') {
        out.push(
          finding('Properties/SSESpecification', 'SSEEnabled must be true with SSEType KMS.'),
        );
      }
      if (resource.Type === TABLE) {
        if (!isPresent(get(sse, 'KMSMasterKeyId'))) {
          out.push(
            finding(
              'Properties/SSESpecification/KMSMasterKeyId',
              'No customer-managed key (KMSMasterKeyId).',
            ),
          );
        }
        return out;
      }
      return out.concat(
        perTableOrReplica(resource, (replica, base) =>
          isPresent(get(replica, 'SSESpecification', 'KMSMasterKeyId'))
            ? []
            : [
                finding(
                  `${base}/SSESpecification/KMSMasterKeyId`,
                  'Replica has no customer-managed key.',
                ),
              ],
        ),
      );
    },
  },
  {
    id: 'BASE-DDB-002',
    title: 'DynamoDB point-in-time recovery is enabled',
    description: 'Tables (and every global-table replica) enable point-in-time recovery.',
    rationale: 'PITR protects against accidental writes/deletes with 35 days of continuous backup.',
    severity: 'medium',
    engines: ['cdk-nag', 'guard'],
    resourceTypes: [TABLE, GLOBAL],
    remediation:
      'Set `pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true }` (or `pointInTimeRecovery: true`).',
    evaluate: ({ resource }) =>
      perTableOrReplica(resource, (holder, base) =>
        get(holder, 'PointInTimeRecoverySpecification', 'PointInTimeRecoveryEnabled') === true
          ? []
          : [finding(`${base}/PointInTimeRecoverySpecification`, 'PITR is not enabled.')],
      ),
  },
  {
    id: 'BASE-DDB-003',
    title: 'DynamoDB deletion protection in prod',
    description: 'In prod, tables (and every global-table replica) set DeletionProtectionEnabled.',
    rationale: 'Prevents accidental table deletion, which PITR cannot undo after 35 days.',
    severity: 'high',
    engines: ['cdk-nag', 'guard'],
    resourceTypes: [TABLE, GLOBAL],
    environments: ['prod'],
    remediation: 'Set `deletionProtection: true` for the prod stage.',
    evaluate: ({ resource }) =>
      perTableOrReplica(resource, (holder, base) =>
        get(holder, 'DeletionProtectionEnabled') === true
          ? []
          : [finding(`${base}/DeletionProtectionEnabled`, 'Deletion protection is not enabled.')],
      ),
  },
];
