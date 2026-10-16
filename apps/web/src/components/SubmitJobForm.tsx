import {
  CreateJobRequestSchema,
  LIMITS,
  type Job,
  type ProblemFieldError,
} from '@starter/contracts';
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import type { ApiClient } from '../api/client';
import { isAbortError, toApiError } from '../api/errors';
import { formatInteger } from '../lib/format';
import { newIdempotencyKey } from '../lib/idempotency';
import { describeApiError } from './ApiErrorMessage';

type FieldName = 'title' | 'content' | 'topTerms';
type FieldErrors = Partial<Record<FieldName, string>>;
type FormValues = Record<FieldName, string>;

interface SubmitError {
  message: string;
  details: string[];
  requestId?: string | undefined;
}

const FIELD_ORDER: readonly FieldName[] = ['title', 'content', 'topTerms'];
const TOP_TERMS_MESSAGE = `Top terms must be a whole number from ${LIMITS.topTermsMin} to ${LIMITS.topTermsMax}.`;

/** Maps a contract path (`title`, `options.topTerms`, …) to a form field. */
export function fieldForPath(path: readonly (string | number)[]): FieldName | null {
  const [first, second] = path;
  if (first === 'title') return 'title';
  if (first === 'content') return 'content';
  if (first === 'options' && (second === undefined || second === 'topTerms')) return 'topTerms';
  return null;
}

/** Friendly messages for the client-side checks that mirror the contract. */
function messageFor(field: FieldName, code: string): string {
  switch (field) {
    case 'title':
      return code === 'too_big'
        ? `Title must be at most ${formatInteger(LIMITS.titleMaxLength)} characters.`
        : 'Enter a title.';
    case 'content':
      return code === 'too_big'
        ? `Document text must be at most ${formatInteger(LIMITS.contentMaxLength)} characters.`
        : 'Enter the document text.';
    case 'topTerms':
      return TOP_TERMS_MESSAGE;
  }
}

function errorsFromIssues(
  issues: readonly { code: string; path: readonly PropertyKey[] }[],
): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of issues) {
    const field = fieldForPath(issue.path.filter((p) => typeof p !== 'symbol'));
    if (field && !errors[field]) errors[field] = messageFor(field, issue.code);
  }
  return errors;
}

/** Splits server-side `errors[]` (paths like `body.title`) into field and form-level messages. */
function errorsFromProblem(fieldErrors: readonly ProblemFieldError[]): {
  fields: FieldErrors;
  unmapped: string[];
} {
  const fields: FieldErrors = {};
  const unmapped: string[] = [];
  for (const { path, message } of fieldErrors) {
    const segments = path.split('.');
    const field = fieldForPath(segments[0] === 'body' ? segments.slice(1) : segments);
    if (field) fields[field] ??= message;
    else unmapped.push(`${path}: ${message}`);
  }
  return { fields, unmapped };
}

const describedBy = (...ids: (string | false | undefined)[]) =>
  ids.filter(Boolean).join(' ') || undefined;

export interface SubmitJobFormProps {
  client: ApiClient;
  onCreated: (job: Job) => void;
}

export function SubmitJobForm({ client, onCreated }: SubmitJobFormProps) {
  const [values, setValues] = useState<FormValues>({
    title: '',
    content: '',
    topTerms: String(LIMITS.topTermsDefault),
  });
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<SubmitError | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const titleRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLTextAreaElement>(null);
  const topTermsRef = useRef<HTMLInputElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  /** Same key for retries of identical contents; a new key once the contents change. */
  const idempotencyRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (submitError) alertRef.current?.focus();
  }, [submitError]);

  const onChange =
    (field: FieldName) => (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const { value } = event.target;
      setValues((previous) => ({ ...previous, [field]: value }));
      setFieldErrors((previous) => {
        if (!previous[field]) return previous;
        const next = { ...previous };
        delete next[field];
        return next;
      });
    };

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlightRef.current) return;

    const topTerms = values.topTerms.trim() === '' ? Number.NaN : Number(values.topTerms);
    const parsed = CreateJobRequestSchema.safeParse({
      title: values.title,
      content: values.content,
      options: { topTerms },
    });
    if (!parsed.success) {
      const errors = errorsFromIssues(parsed.error.issues);
      setFieldErrors(errors);
      setSubmitError(null);
      const first = FIELD_ORDER.find((field) => errors[field]);
      if (first === 'title') titleRef.current?.focus();
      else if (first === 'content') contentRef.current?.focus();
      else if (first === 'topTerms') topTermsRef.current?.focus();
      return;
    }

    const fingerprint = JSON.stringify(parsed.data);
    if (idempotencyRef.current?.fingerprint !== fingerprint) {
      idempotencyRef.current = { fingerprint, key: newIdempotencyKey() };
    }
    const { key } = idempotencyRef.current;

    inFlightRef.current = true;
    setSubmitting(true);
    setFieldErrors({});
    setSubmitError(null);
    try {
      const { job } = await client.createJob(parsed.data, key);
      onCreated(job);
    } catch (caught) {
      if (isAbortError(caught)) return;
      const error = toApiError(caught);
      const { fields, unmapped } = errorsFromProblem(error.fieldErrors);
      setFieldErrors(fields);
      setSubmitError({
        message: describeApiError(error),
        details: unmapped,
        requestId: error.problem?.requestId,
      });
    } finally {
      inFlightRef.current = false;
      setSubmitting(false);
    }
  }

  const contentLength = values.content.length;

  return (
    <section className="card" aria-labelledby="submit-heading">
      <h2 id="submit-heading">Analyse a document</h2>
      <p className="lead">
        Paste plain text (up to {formatInteger(LIMITS.contentMaxLength)} characters). Processing is
        asynchronous and applies business rules such as a minimum word count.
      </p>

      <form
        aria-labelledby="submit-heading"
        noValidate
        onSubmit={(event) => void handleSubmit(event)}
      >
        {submitError && (
          <div className="alert alert--error" role="alert" tabIndex={-1} ref={alertRef}>
            <p className="alert__title">The job could not be submitted.</p>
            <p>{submitError.message}</p>
            {submitError.details.length > 0 && (
              <ul>
                {submitError.details.map((detail) => (
                  <li key={detail}>{detail}</li>
                ))}
              </ul>
            )}
            {submitError.requestId && (
              <p className="error-reference">
                Reference: <code>{submitError.requestId}</code>
              </p>
            )}
          </div>
        )}

        <div className="field">
          <label htmlFor="job-title">Title</label>
          <input
            id="job-title"
            name="title"
            type="text"
            autoComplete="off"
            required
            ref={titleRef}
            value={values.title}
            onChange={onChange('title')}
            aria-invalid={fieldErrors.title ? true : undefined}
            aria-describedby={describedBy(fieldErrors.title && 'job-title-error')}
          />
          {fieldErrors.title && (
            <p id="job-title-error" className="field-error">
              {fieldErrors.title}
            </p>
          )}
        </div>

        <div className="field">
          <label htmlFor="job-content">Document text</label>
          <textarea
            id="job-content"
            name="content"
            rows={10}
            required
            ref={contentRef}
            value={values.content}
            onChange={onChange('content')}
            aria-invalid={fieldErrors.content ? true : undefined}
            aria-describedby={describedBy(
              'job-content-hint',
              fieldErrors.content && 'job-content-error',
            )}
          />
          <p
            id="job-content-hint"
            className={`hint${contentLength > LIMITS.contentMaxLength ? ' hint--over' : ''}`}
          >
            {formatInteger(contentLength)} / {formatInteger(LIMITS.contentMaxLength)} characters
          </p>
          {fieldErrors.content && (
            <p id="job-content-error" className="field-error">
              {fieldErrors.content}
            </p>
          )}
        </div>

        <div className="field field--narrow">
          <label htmlFor="job-top-terms">Top terms</label>
          <input
            id="job-top-terms"
            name="topTerms"
            type="number"
            inputMode="numeric"
            min={LIMITS.topTermsMin}
            max={LIMITS.topTermsMax}
            step={1}
            ref={topTermsRef}
            value={values.topTerms}
            onChange={onChange('topTerms')}
            aria-invalid={fieldErrors.topTerms ? true : undefined}
            aria-describedby={describedBy(
              'job-top-terms-hint',
              fieldErrors.topTerms && 'job-top-terms-error',
            )}
          />
          <p id="job-top-terms-hint" className="hint">
            How many frequent terms to report ({LIMITS.topTermsMin}–{LIMITS.topTermsMax}).
          </p>
          {fieldErrors.topTerms && (
            <p id="job-top-terms-error" className="field-error">
              {fieldErrors.topTerms}
            </p>
          )}
        </div>

        <button type="submit" className="button button--primary" disabled={submitting}>
          {submitting ? 'Submitting…' : 'Analyse document'}
        </button>
      </form>
    </section>
  );
}
