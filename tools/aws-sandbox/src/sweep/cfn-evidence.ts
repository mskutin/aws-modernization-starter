/**
 * Deletion evidence from CloudFormation for the stacks the run's inventory recorded: a deleted
 * stack stays queryable by its stack id for 90 days. `list-stacks` maps the inventory's (masked)
 * stack id to the real one; `list-stack-resources` on it gives each resource's final status
 * (DELETE_COMPLETE, DELETE_SKIPPED = retained, DELETE_FAILED). This is supplementary evidence for
 * categories the role cannot list (e.g. Secrets Manager): it never replaces an exhaustive listing,
 * and its own failure is reported, not counted as a failed sweep.
 */
import { maskString } from '../mask.js';
import { items, iso, str, type CfnEvidence, type InventoryEvidence } from './common.js';
import type { ReadOnlyAws } from '../aws/session.js';

export async function collectCloudFormationEvidence(
  aws: ReadOnlyAws,
  inventory: InventoryEvidence,
): Promise<CfnEvidence> {
  const listed = await aws.call('cloudformation', 'list-stacks');
  if (!listed.ok) {
    return {
      available: false,
      note: `cloudformation list-stacks failed (${listed.error.code}): no deleted-stack evidence`,
      stacks: [],
      resources: [],
    };
  }
  const summaries = items(listed.data, 'StackSummaries');
  const stacks: { name: string; status: string; deletedAt?: string | undefined }[] = [];
  const resources: CfnEvidence['resources'][number][] = [];
  const problems: string[] = [];
  for (const inv of inventory.stacks) {
    const match = summaries.find(
      (s) => inv.id !== null && maskString(str(s['StackId']) ?? '') === inv.id,
    );
    if (!match) {
      stacks.push({ name: inv.name, status: 'NOT_FOUND_IN_LIST_STACKS' });
      continue;
    }
    const status = str(match['StackStatus']) ?? 'UNKNOWN';
    stacks.push({ name: inv.name, status, deletedAt: iso(match['DeletionTime']) });
    const r = await aws.call('cloudformation', 'list-stack-resources', [
      '--stack-name',
      str(match['StackId']) as string,
    ]);
    if (!r.ok) {
      problems.push(`${inv.name}: list-stack-resources ${r.error.code}`);
      continue;
    }
    for (const x of items(r.data, 'StackResourceSummaries')) {
      resources.push({
        stack: inv.name,
        logicalId: str(x['LogicalResourceId']) ?? 'unknown',
        type: str(x['ResourceType']) ?? 'unknown',
        physicalId: str(x['PhysicalResourceId']),
        status: str(x['ResourceStatus']) ?? 'UNKNOWN',
      });
    }
  }
  return {
    available: true,
    note: `final resource states of the ${stacks.length} inventoried stack(s) (cloudformation list-stacks + list-stack-resources)${problems.length ? `; ${problems.join('; ')}` : ''}`,
    stacks,
    resources,
  };
}
