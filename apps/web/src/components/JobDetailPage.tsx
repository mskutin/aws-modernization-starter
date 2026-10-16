import { useEffect } from 'react';
import type { ApiClient } from '../api/client';
import { useJobPolling } from '../hooks/useJobPolling';
import { elapsedSeconds, formatDateTime, formatInteger, formatTurnaround } from '../lib/format';
import { HOME_HREF } from '../routing';
import { ErrorReference, describeApiError } from './ApiErrorMessage';
import { JobResultView } from './JobResultView';

export function JobDetailPage({ client, jobId }: { client: ApiClient; jobId: string }) {
  const { job, error, polling } = useJobPolling(client, jobId);
  const title = job?.title;
  // Only finished jobs have a meaningful submitted → last-update interval.
  const turnaround =
    job && (job.status === 'SUCCEEDED' || job.status === 'FAILED')
      ? elapsedSeconds(job.createdAt, job.updatedAt)
      : null;

  useEffect(() => {
    document.title = `${title ?? 'Job'} — Document Analysis`;
  }, [title]);

  return (
    <article className="card job-detail" aria-labelledby={job ? 'job-heading' : undefined}>
      <p className="back-link">
        <a href={HOME_HREF}>Back to jobs</a>
      </p>

      {job === null && error === null && <p className="muted">Loading job…</p>}

      {error !== null && !polling && (
        <div className="alert alert--error" role="alert">
          <h2 className="alert__title">
            {error.status === 404 ? 'Job not found' : 'Could not load this job'}
          </h2>
          <p>{describeApiError(error)}</p>
          <ErrorReference error={error} />
        </div>
      )}

      {error !== null && polling && (
        <p className="notice">
          {describeApiError(error)} Retrying automatically
          {job ? '; showing the last known status.' : '.'}
        </p>
      )}

      {job !== null && (
        <>
          <h2 id="job-heading">{job.title}</h2>
          <p className="job-status" role="status" aria-live="polite" data-status={job.status}>
            Status: {job.status}
          </p>
          {polling && (
            <p className="muted polling-indicator">
              <span className="spinner" aria-hidden="true" /> Updating automatically…
            </p>
          )}

          <dl className="meta">
            <div>
              <dt>Job ID</dt>
              <dd>
                <code>{job.jobId}</code>
              </dd>
            </div>
            <div>
              <dt>Submitted</dt>
              <dd>
                <time dateTime={job.createdAt}>{formatDateTime(job.createdAt)}</time>
              </dd>
            </div>
            <div>
              <dt>Last updated</dt>
              <dd>
                <time dateTime={job.updatedAt}>{formatDateTime(job.updatedAt)}</time>
              </dd>
            </div>
            {turnaround !== null && (
              <div>
                <dt>Turnaround</dt>
                <dd>{formatTurnaround(turnaround)}</dd>
              </div>
            )}
            <div>
              <dt>Document length</dt>
              <dd>{formatInteger(job.contentLength)} characters</dd>
            </div>
            <div>
              <dt>Top terms requested</dt>
              <dd>{job.options.topTerms}</dd>
            </div>
          </dl>

          {job.status === 'FAILED' && (
            <div className="alert alert--error" role="alert">
              <h3 className="alert__title">Job failed</h3>
              {job.error ? (
                <p>
                  <strong className="error-name">{job.error.name}</strong>: {job.error.message}
                </p>
              ) : (
                <p>The job failed without an error description.</p>
              )}
            </div>
          )}

          {job.status === 'SUCCEEDED' && job.result && <JobResultView result={job.result} />}
        </>
      )}
    </article>
  );
}
