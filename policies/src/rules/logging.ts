import type { Finding, PolicyRule } from '../types.js';
import { asArray, finding, get, isPresent, props } from './util.js';

const LOG_GROUP = 'AWS::Logs::LogGroup';

export const loggingRules: PolicyRule[] = [
  {
    id: 'BASE-LOG-001',
    title: 'Log groups have a retention period',
    description: 'Every AWS::Logs::LogGroup sets RetentionInDays.',
    rationale:
      'Never-expire log groups grow cost without bound and keep personal data longer than needed.',
    severity: 'medium',
    engines: ['cdk-nag', 'guard'],
    resourceTypes: [LOG_GROUP],
    remediation: 'Set `retention: logs.RetentionDays.<period>` per the stage configuration.',
    evaluate: ({ resource }) =>
      typeof props(resource)['RetentionInDays'] === 'number'
        ? []
        : [finding('Properties/RetentionInDays', 'RetentionInDays is not set (never expires).')],
  },
  {
    id: 'BASE-LOG-002',
    title: 'Log groups are encrypted with KMS',
    description: 'Every AWS::Logs::LogGroup sets KmsKeyId.',
    rationale:
      'Application logs can contain personal data; a CMK allows access control and crypto-shredding.',
    severity: 'medium',
    engines: ['cdk-nag', 'guard'],
    resourceTypes: [LOG_GROUP],
    remediation:
      'Set `encryptionKey` (the key policy must allow the `logs.<region>.amazonaws.com` principal).',
    evaluate: ({ resource }) =>
      isPresent(props(resource)['KmsKeyId'])
        ? []
        : [finding('Properties/KmsKeyId', 'Log group is not encrypted with a KMS key.')],
  },
  {
    id: 'BASE-LOG-003',
    title: 'State machines emit execution logs',
    description:
      'Every AWS::StepFunctions::StateMachine sets LoggingConfiguration with Level ALL, ERROR or FATAL and at least one destination.',
    rationale:
      'Execution history alone expires and is hard to search; logs are needed to diagnose failed jobs.',
    severity: 'medium',
    engines: ['cdk-nag', 'guard'],
    resourceTypes: ['AWS::StepFunctions::StateMachine'],
    remediation: 'Set `logs: { destination: logGroup, level: sfn.LogLevel.ERROR }` (or ALL).',
    evaluate: ({ resource }) => {
      const cfg = get(props(resource), 'LoggingConfiguration');
      const out: Finding[] = [];
      const level = get(cfg, 'Level');
      if (typeof level !== 'string' || !['ALL', 'ERROR', 'FATAL'].includes(level)) {
        out.push(
          finding('Properties/LoggingConfiguration/Level', `Logging level is ${String(level)}.`),
        );
      }
      if (asArray(get(cfg, 'Destinations')).length === 0) {
        out.push(
          finding('Properties/LoggingConfiguration/Destinations', 'No logging destination.'),
        );
      }
      return out;
    },
  },
];
