import { Annotations, AspectPriority, Aspects, Stack, Token, type IAspect } from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { IConstruct } from 'constructs';

/**
 * Log retention policy: every CloudWatch log group must have an explicit
 * retention and a customer-managed KMS key. Violations fail synth.
 */
export class LogGroupComplianceAspect implements IAspect {
  public visit(node: IConstruct): void {
    if (!(node instanceof logs.CfnLogGroup)) return;
    const resolved = Stack.of(node).resolve(node.retentionInDays) as unknown;
    if (resolved === undefined || (typeof resolved === 'number' && resolved <= 0)) {
      Annotations.of(node).addError(
        'Log group must set an explicit retention (log retention policy)',
      );
    }
    if (
      node.kmsKeyId === undefined ||
      (typeof node.kmsKeyId === 'string' &&
        !Token.isUnresolved(node.kmsKeyId) &&
        node.kmsKeyId === '')
    ) {
      Annotations.of(node).addError('Log group must be encrypted with a customer-managed KMS key');
    }
  }
}

export function applyLogGroupCompliance(scope: IConstruct): void {
  Aspects.of(scope).add(new LogGroupComplianceAspect(), { priority: AspectPriority.READONLY });
}
