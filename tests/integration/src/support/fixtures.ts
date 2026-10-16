/**
 * Request fixtures built from the shared @starter/testing builders/documents (owned by the app team),
 * made unique per call: the API deduplicates identical bodies, and the suite must be re-runnable
 * against long-lived stores.
 */
import { randomUUID } from 'node:crypto';
import {
  CONTROL_CHARACTER_DOCUMENT,
  TOO_SHORT_DOCUMENT,
  VALID_DOCUMENT,
  aCreateJobRequestInput,
} from '@starter/testing';

export { VALID_DOCUMENT };

/** Passes schema AND business rules (VALID_DOCUMENT: 30 words, 2 paragraphs). */
export function validDocument(label = 'doc') {
  return aCreateJobRequestInput({
    title: `it ${label} ${randomUUID()}`,
    options: { topTerms: 5 },
  });
}

/** Schema-valid but violates the min-word-count rule (-> FAILED, JobValidationError). */
export function businessInvalidDocument(label = 'short') {
  return aCreateJobRequestInput({
    title: `it ${label} ${randomUUID()}`,
    content: TOO_SHORT_DOCUMENT,
  });
}

/** Schema-valid but contains a forbidden control character (-> FAILED, JobValidationError). */
export function controlCharacterDocument(label = 'control') {
  return aCreateJobRequestInput({
    title: `it ${label} ${randomUUID()}`,
    content: CONTROL_CHARACTER_DOCUMENT,
  });
}
