import { RemovalPolicy } from 'aws-cdk-lib';
import type { RemovalPolicyName } from '../environments/schema.js';

export function toRemovalPolicy(name: RemovalPolicyName): RemovalPolicy {
  switch (name) {
    case 'retain':
      return RemovalPolicy.RETAIN;
    case 'snapshot':
      return RemovalPolicy.SNAPSHOT;
    case 'destroy':
      return RemovalPolicy.DESTROY;
  }
}

/** Log groups and other non-snapshot-capable resources: SNAPSHOT means RETAIN. */
export function toNonSnapshotRemovalPolicy(name: RemovalPolicyName): RemovalPolicy {
  return name === 'destroy' ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN;
}
