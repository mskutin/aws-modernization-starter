/**
 * CDK's singleton custom-resource providers (e.g. the S3 auto-delete provider that empties a
 * bucket on `cdk destroy`) are raw `AWS::Lambda::Function` + `AWS::IAM::Role` resources at the
 * stack root. Untouched, the function's first invocation creates `/aws/lambda/<name>` with
 * infinite retention and no KMS key — a log group that outlives the stack.
 *
 * `manageCustomResourceProviders()` (used by the sandbox, the only profile with such
 * providers) gives each provider function a CloudFormation-managed, CMK-encrypted log group that
 * is deleted with the stack (BASE-LMB-005), the stack's tags in the template (BASE-TAG-001; the
 * stack tags would otherwise only be propagated at deploy time) and the arm64 architecture
 * (BASE-LMB-002; the handlers are plain JavaScript). Nothing else of the provider changes.
 */
import {
  CfnResource,
  CustomResourceProviderBase,
  type RemovalPolicy,
  type Stack,
} from 'aws-cdk-lib';
import type * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';

export interface ManagedProviderLogs {
  readonly logsKey: kms.IKey;
  readonly retention: logs.RetentionDays;
  readonly removalPolicy: RemovalPolicy;
}

/** Applies the managed log group, template tags and arm64 to every provider in `stack`. */
export function manageCustomResourceProviders(stack: Stack, opts: ManagedProviderLogs): number {
  const tags = Object.entries(stack.tags.tagValues())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([Key, Value]) => ({ Key, Value }));
  let count = 0;
  for (const provider of stack.node.children) {
    if (!(provider instanceof CustomResourceProviderBase)) continue;
    const handler = provider.node.tryFindChild('Handler');
    const role = provider.node.tryFindChild('Role');
    if (!CfnResource.isCfnResource(handler)) continue;
    const logGroup = new logs.LogGroup(provider, 'Logs', {
      retention: opts.retention,
      encryptionKey: opts.logsKey,
      removalPolicy: opts.removalPolicy,
    });
    handler.addPropertyOverride('LoggingConfig', { LogGroup: logGroup.logGroupName });
    handler.addPropertyOverride('Architectures', ['arm64']);
    handler.addPropertyOverride('Tags', tags);
    if (CfnResource.isCfnResource(role)) role.addPropertyOverride('Tags', tags);
    count++;
  }
  return count;
}
