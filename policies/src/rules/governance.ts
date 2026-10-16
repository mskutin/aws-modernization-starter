import { BASELINE_ENVIRONMENTS, type PolicyRule } from '../types.js';
import {
  STATEFUL_TYPES,
  finding,
  isClusterMemberInstance,
  isPresent,
  props,
  resourceTags,
} from './util.js';

/** Tag keys applied by the infrastructure Aspect and enforced here. */
export const REQUIRED_TAG_KEYS = [
  'Project',
  'Environment',
  'Owner',
  'CostCentre',
  'DataClassification',
  'ManagedBy',
] as const;

/**
 * Cost- or data-bearing resource types whose tags are checked. Limited to types
 * that use the `[{Key, Value}]` tag list format. Keep in sync with
 * `guard/rules/tags.guard`.
 */
export const TAGGED_RESOURCE_TYPES = [
  'AWS::S3::Bucket',
  'AWS::CloudFront::Distribution',
  'AWS::ECS::Cluster',
  'AWS::ECS::Service',
  'AWS::ECS::TaskDefinition',
  'AWS::Lambda::Function',
  'AWS::RDS::DBInstance',
  'AWS::RDS::DBCluster',
  'AWS::DynamoDB::Table',
  'AWS::Logs::LogGroup',
  'AWS::KMS::Key',
  'AWS::EC2::VPC',
  'AWS::EC2::NatGateway',
  'AWS::ElasticLoadBalancingV2::LoadBalancer',
  'AWS::StepFunctions::StateMachine',
  'AWS::SecretsManager::Secret',
  'AWS::ECR::Repository',
] as const;

const RETAIN_POLICIES = ['Retain', 'Snapshot', 'RetainExceptOnCreate'];

export const governanceRules: PolicyRule[] = [
  {
    id: 'BASE-TAG-001',
    title: 'Required cost-allocation tags are present',
    description: `Cost- and data-bearing resources carry non-empty tags: ${REQUIRED_TAG_KEYS.join(', ')}.`,
    rationale:
      'Tags drive cost allocation (CostCentre), ownership and data-handling (DataClassification) and the environment-aware rules in this baseline.',
    severity: 'medium',
    engines: ['cdk-nag', 'guard'],
    resourceTypes: TAGGED_RESOURCE_TYPES,
    remediation:
      'Apply tags with `Tags.of(stage).add(...)` at the Stage/Stack level (App-level Aspects do not propagate into Stages).',
    evaluate: ({ resource }) => {
      const tags = resourceTags(resource);
      return REQUIRED_TAG_KEYS.filter((k) => !isPresent(tags.get(k))).map((k) =>
        finding('Properties/Tags', `Required tag ${k} is missing or empty.`),
      );
    },
  },
  {
    id: 'BASE-TAG-002',
    title: 'Environment tag uses an allowed value',
    description: `The Environment tag, when present, is one of ${BASELINE_ENVIRONMENTS.join(', ')}.`,
    rationale:
      'Environment-aware rules (deletion protection, backups, TLS certificates) key off this tag.',
    severity: 'medium',
    engines: ['cdk-nag', 'guard'],
    resourceTypes: TAGGED_RESOURCE_TYPES,
    remediation: 'Use the stage name exactly: dev, staging or prod.',
    evaluate: ({ resource }) => {
      const tags = resourceTags(resource);
      if (!tags.has('Environment')) return 'not-applicable';
      const v = tags.get('Environment');
      return typeof v === 'string' && (BASELINE_ENVIRONMENTS as readonly string[]).includes(v)
        ? []
        : [finding('Properties/Tags', `Environment tag value ${String(v)} is not allowed.`)];
    },
  },
  {
    id: 'BASE-STATE-001',
    title: 'Stateful resources are retained in staging/prod',
    description:
      'In staging and prod, RDS instances/clusters, DynamoDB tables, KMS keys and S3 buckets set DeletionPolicy and UpdateReplacePolicy to Retain or Snapshot (DeletionPolicy may also be RetainExceptOnCreate).',
    rationale:
      'A stack deletion or a replacement-causing change must never destroy data or the keys that decrypt it.',
    severity: 'high',
    engines: ['cdk-nag', 'guard'],
    resourceTypes: STATEFUL_TYPES,
    environments: ['staging', 'prod'],
    remediation: 'Set `removalPolicy: RemovalPolicy.RETAIN` (or SNAPSHOT for RDS) in staging/prod.',
    evaluate: ({ resource }) => {
      if (isClusterMemberInstance(resource)) return 'not-applicable';
      const out = [];
      if (!RETAIN_POLICIES.includes(resource.DeletionPolicy ?? 'Delete')) {
        out.push(
          finding('DeletionPolicy', `DeletionPolicy is ${resource.DeletionPolicy ?? 'Delete'}.`),
        );
      }
      if (!['Retain', 'Snapshot'].includes(resource.UpdateReplacePolicy ?? 'Delete')) {
        out.push(
          finding(
            'UpdateReplacePolicy',
            `UpdateReplacePolicy is ${resource.UpdateReplacePolicy ?? 'Delete'}.`,
          ),
        );
      }
      return out;
    },
  },
  {
    id: 'BASE-KMS-001',
    title: 'Symmetric KMS keys rotate',
    description:
      'Symmetric (SYMMETRIC_DEFAULT) customer-managed keys set EnableKeyRotation to true.',
    rationale: 'Automatic rotation limits the amount of data protected by one key version.',
    severity: 'medium',
    engines: ['cdk-nag', 'guard'],
    resourceTypes: ['AWS::KMS::Key'],
    remediation: 'Set `enableKeyRotation: true`.',
    evaluate: ({ resource }) => {
      const p = props(resource);
      const spec = p['KeySpec'];
      if (spec !== undefined && spec !== 'SYMMETRIC_DEFAULT') return 'not-applicable';
      return p['EnableKeyRotation'] === true
        ? []
        : [finding('Properties/EnableKeyRotation', 'Key rotation is not enabled.')];
    },
  },
];
