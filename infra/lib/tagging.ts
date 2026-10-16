import {
  Annotations,
  AspectPriority,
  Aspects,
  Stack,
  TagManager,
  Tags,
  type IAspect,
} from 'aws-cdk-lib';
import type { IConstruct } from 'constructs';
import {
  REQUIRED_TAG_KEYS,
  type EnvironmentConfig,
  type RequiredTagKey,
} from '../environments/schema.js';

export type RequiredTags = Readonly<Record<RequiredTagKey, string>>;

/**
 * Ephemeral-run tag keys (same keys as the integration mini-stack's `EPHEMERAL_TAGS`, which the
 * sweeper and the teardown verification search for) plus the experiment marker.
 */
export const RUN_TAG_KEYS = {
  ephemeral: 'starter:ephemeral',
  runId: 'starter:run-id',
  expiresAt: 'starter:expires-at',
  experiment: 'starter:experiment',
} as const;

/** Tags of the sandbox's ephemeral run (none for the governed environments, which have no `run`). */
export function runTags(config: Pick<EnvironmentConfig, 'run'>): Record<string, string> {
  if (!config.run) return {};
  return {
    [RUN_TAG_KEYS.ephemeral]: 'true',
    [RUN_TAG_KEYS.runId]: config.run.runId,
    [RUN_TAG_KEYS.expiresAt]: config.run.expiresAt,
    [RUN_TAG_KEYS.experiment]: config.run.experiment,
  };
}

/** Throws unless `tags` has exactly the required keys, each non-empty. */
export function assertRequiredTags(
  tags: Readonly<Record<string, string>>,
): asserts tags is RequiredTags {
  const keys = Object.keys(tags).sort();
  const expected = [...REQUIRED_TAG_KEYS].sort();
  const missing = expected.filter((k) => !keys.includes(k));
  const unexpected = keys.filter((k) => !(expected as string[]).includes(k));
  const empty = keys.filter((k) => (tags[k] ?? '').trim() === '');
  if (missing.length + unexpected.length + empty.length > 0) {
    throw new Error(
      `Required tags must be exactly ${expected.join(', ')}` +
        (missing.length ? `; missing: ${missing.join(', ')}` : '') +
        (unexpected.length ? `; unexpected: ${unexpected.join(', ')}` : '') +
        (empty.length ? `; empty: ${empty.join(', ')}` : ''),
    );
  }
}

/**
 * Applies the six required tags (plus any landing-zone mandatory tags) to
 * every taggable resource under `scope` via CDK tag aspects, and registers a
 * read-only aspect that fails synth if any taggable resource ends up without
 * one of the required keys.
 */
export function applyRequiredTags(
  scope: IConstruct,
  tags: RequiredTags,
  additional: Readonly<Record<string, string>> = {},
): void {
  assertRequiredTags(tags);
  for (const [key, value] of Object.entries(additional)) {
    Tags.of(scope).add(key, value);
  }
  for (const [key, value] of Object.entries(tags)) {
    // Higher priority than ad-hoc tags so required values cannot be overridden.
    Tags.of(scope).add(key, value, { priority: 300 });
  }
  Aspects.of(scope).add(new RequiredTagsVerifier(), { priority: AspectPriority.READONLY });
}

/**
 * Errors on any taggable resource that is missing a required tag key. Stacks
 * are skipped: with `@aws-cdk/core:explicitStackTags` their tags are set via
 * stack props (see `workloadStackProps`), not via aspects.
 */
export class RequiredTagsVerifier implements IAspect {
  public visit(node: IConstruct): void {
    if (Stack.isStack(node)) return;
    if (!TagManager.isTaggable(node) && !TagManager.isTaggableV2(node)) return;
    const manager = TagManager.of(node);
    if (!manager) return;
    const present = manager.tagValues();
    const missing = REQUIRED_TAG_KEYS.filter((k) => !(k in present));
    if (missing.length > 0) {
      Annotations.of(node).addError(`Missing required tag(s): ${missing.join(', ')}`);
    }
  }
}
