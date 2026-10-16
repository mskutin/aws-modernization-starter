/**
 * Canary documents for leakage tests.
 *
 * Canaries target RAW document data: the title, a whole sentence, and a token the
 * analyser can never turn into a term. Derived results (`topTerms`) legitimately live in the
 * DynamoDB job item, the step idempotency item and responses to the owner, so a canary must never
 * be something that can appear there: every canary string contains spaces or `~`, which the
 * tokenizer treats as separators (`packages/domain/src/text.ts`), and all of it is lower case, so
 * case folding cannot hide a leak either. Values are unique per run and per document.
 */
import { randomBytes } from 'node:crypto';

export interface CanaryDocument {
  title: string;
  content: string;
  /** Strings that must not appear outside PostgreSQL and the owner's responses. */
  canaries: { title: string; sentence: string; token: string };
}

const hex = (bytes: number) => randomBytes(bytes).toString('hex');

/** Neutral filler (≥ 10 words per the validation rules), no canary material. */
const FILLER = [
  'Teams assess workloads and plan the migration waves carefully.',
  'Operations staff review dashboards before every weekly release.',
  'Archived records remain available for the statutory retention period.',
];

export function canaryDocument(runId: string, label: string): CanaryDocument {
  const id = `${runId}~${label}~${hex(4)}`.toLowerCase();
  const token = `cnry~${hex(6)}~${hex(6)}`;
  const sentence = `the quiet lantern ${hex(3)}~${hex(3)} must never leave the database.`;
  const title = `sectest canary title ${id}`;
  const content = [
    FILLER[0],
    `${sentence} Reference ${token} is confidential.`,
    ...FILLER.slice(1),
  ].join('\n\n');
  return { title, content, canaries: { title, sentence, token } };
}

export const canaryValues = (doc: CanaryDocument): string[] => Object.values(doc.canaries);
