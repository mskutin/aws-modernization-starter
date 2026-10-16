/**
 * Fixtures and builders shared by unit and integration tests. Builders return
 * fresh objects so tests can mutate them safely.
 */
import { randomInt, randomUUID } from 'node:crypto';
import type { CreateJobRequest, CreateJobRequestInput, JobResult } from '@starter/contracts';
import type { ProcessingExecutionInput } from '@starter/workflow-processing';

/** A document that passes every business rule (and yields stable statistics). */
export const VALID_DOCUMENT = [
  'Cloud migration is a journey. Every migration starts with discovery!',
  '',
  'Teams assess workloads, plan the migration waves, and modernize applications. Is the cloud cheaper? Often, cloud costs drop after optimisation.',
].join('\n');

/** Fails the business rule "minimum word count" (but passes the API schema). */
export const TOO_SHORT_DOCUMENT = 'Far too short.';

/** Fails the business rule "forbidden control characters" (but passes the API schema). */
export const CONTROL_CHARACTER_DOCUMENT = `${VALID_DOCUMENT}\u0007 bell character inside`;

export function aCreateJobRequestInput(
  overrides: Partial<CreateJobRequestInput> = {},
): CreateJobRequestInput {
  return { title: 'Migration notes', content: VALID_DOCUMENT, ...overrides };
}

export function aCreateJobRequest(overrides: Partial<CreateJobRequest> = {}): CreateJobRequest {
  return {
    title: 'Migration notes',
    content: VALID_DOCUMENT,
    options: { topTerms: 10 },
    ...overrides,
  };
}

/** Spec 2.0.0 execution input: a job reference and non-sensitive metadata only. */
export function anExecutionInput(
  overrides: Partial<ProcessingExecutionInput> = {},
): ProcessingExecutionInput {
  return {
    jobId: randomUUID(),
    contractVersion: '1.0.0',
    submittedAt: '2026-10-13T10:00:00.000Z',
    ...overrides,
  };
}

/**
 * Synthetic document carrying unique markers for leakage tests: submit it, then assert that no
 * log line, workflow payload, error or state item outside PostgreSQL contains any marker.
 *
 * Markers are raw document data only: a whole sentence, a numeric token (the analysis never
 * reports numbers as terms) and the title — never a word that may legitimately appear in the
 * stored analysis (`topTerms`). The content passes every business rule.
 */
export interface LeakCanary {
  title: string;
  content: string;
  /** Strings that must not appear anywhere but the system of record. */
  markers: readonly string[];
}

const canaryToken = () => Array.from({ length: 16 }, () => randomInt(10)).join('');

export function leakCanary(): LeakCanary {
  const token = canaryToken();
  const sentence = `Canary sentence ${token} stays inside the system of record`;
  const title = `Canary title ${token}`;
  return { title, content: `${VALID_DOCUMENT}\n\n${sentence}.`, markers: [token, sentence, title] };
}

/** A canary document that fails the minimum-word-count rule (exercises the rejection path). */
export function rejectedLeakCanary(): LeakCanary {
  const token = canaryToken();
  const title = `Canary title ${token}`;
  return { title, content: `Rejected canary ${token}.`, markers: [token, title] };
}

/** Markers of `canary` found anywhere in `haystack` (serialised as JSON). Empty = no leak. */
export function findLeaks(haystack: unknown, canary: Pick<LeakCanary, 'markers'>): string[] {
  const text = typeof haystack === 'string' ? haystack : JSON.stringify(haystack);
  return canary.markers.filter((marker) => text.includes(marker));
}

export function aJobResult(overrides: Partial<JobResult> = {}): JobResult {
  return {
    algorithmVersion: '1.0.0',
    wordCount: 30,
    uniqueWordCount: 26,
    sentenceCount: 5,
    paragraphCount: 2,
    characterCount: 211,
    averageWordLength: 5.6,
    averageSentenceLength: 6,
    lexicalDiversity: 0.8667,
    readingTimeSeconds: 9,
    topTerms: [{ term: 'cloud', count: 3 }],
    checksumSha256: 'a'.repeat(64),
    ...overrides,
  };
}

/** Deterministic clock for tests: each call advances by `stepMs`. */
export function steppingClock(start = '2026-10-13T10:00:00.000Z', stepMs = 1): () => Date {
  let current = new Date(start).getTime();
  return () => {
    const now = new Date(current);
    current += stepMs;
    return now;
  };
}
