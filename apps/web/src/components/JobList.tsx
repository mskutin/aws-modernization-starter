import type { JobSummary } from '@starter/contracts';
import { useEffect, useState } from 'react';
import type { ApiClient } from '../api/client';
import { isAbortError, toApiError, type ApiError } from '../api/errors';
import { formatDateTime } from '../lib/format';
import { jobHref } from '../routing';
import { ErrorReference, describeApiError } from './ApiErrorMessage';
import { StatusBadge } from './StatusBadge';

interface ListState {
  items: JobSummary[];
  nextCursor: string | null;
  phase: 'loading' | 'idle' | 'loading-more';
  error: ApiError | null;
}

export const DEFAULT_PAGE_SIZE = 20;

function mergeById(current: JobSummary[], incoming: JobSummary[]): JobSummary[] {
  const seen = new Set(current.map((job) => job.jobId));
  return [...current, ...incoming.filter((job) => !seen.has(job.jobId))];
}

export function JobList({
  client,
  pageSize = DEFAULT_PAGE_SIZE,
}: {
  client: ApiClient;
  pageSize?: number;
}) {
  const [state, setState] = useState<ListState>({
    items: [],
    nextCursor: null,
    phase: 'loading',
    error: null,
  });
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    client.listJobs({ limit: pageSize }, controller.signal).then(
      (page) =>
        setState({ items: page.items, nextCursor: page.nextCursor, phase: 'idle', error: null }),
      (caught: unknown) => {
        if (isAbortError(caught)) return;
        setState((previous) => ({ ...previous, phase: 'idle', error: toApiError(caught) }));
      },
    );
    return () => controller.abort();
  }, [client, pageSize, reloadToken]);

  function refresh() {
    setState((previous) => ({ ...previous, phase: 'loading', error: null }));
    setReloadToken((token) => token + 1);
  }

  async function loadMore() {
    const cursor = state.nextCursor;
    if (!cursor || state.phase !== 'idle') return;
    setState((previous) => ({ ...previous, phase: 'loading-more', error: null }));
    try {
      const page = await client.listJobs({ limit: pageSize, cursor });
      setState((previous) => ({
        items: mergeById(previous.items, page.items),
        nextCursor: page.nextCursor,
        phase: 'idle',
        error: null,
      }));
    } catch (caught) {
      if (isAbortError(caught)) return;
      setState((previous) => ({ ...previous, phase: 'idle', error: toApiError(caught) }));
    }
  }

  const { items, nextCursor, phase, error } = state;

  return (
    <section className="card" aria-labelledby="jobs-heading" aria-busy={phase !== 'idle'}>
      <div className="section-header">
        <h2 id="jobs-heading">Recent jobs</h2>
        <button type="button" className="button" onClick={refresh} disabled={phase === 'loading'}>
          Refresh
        </button>
      </div>

      {error && (
        <div className="alert alert--error" role="alert">
          <p className="alert__title">Could not load jobs.</p>
          <p>{describeApiError(error)}</p>
          <ErrorReference error={error} />
        </div>
      )}

      {phase === 'loading' && items.length === 0 && <p className="muted">Loading jobs…</p>}

      {phase !== 'loading' && items.length === 0 && !error && (
        <p className="muted">No jobs yet. Submit a document to get started.</p>
      )}

      {items.length > 0 && (
        <div className="table-scroll">
          <table className="jobs">
            <caption className="visually-hidden">Recent jobs</caption>
            <thead>
              <tr>
                <th scope="col">Title</th>
                <th scope="col">Status</th>
                <th scope="col">Submitted</th>
              </tr>
            </thead>
            <tbody>
              {items.map((job) => (
                <tr key={job.jobId}>
                  <td>
                    <a href={jobHref(job.jobId)}>{job.title}</a>
                  </td>
                  <td>
                    <StatusBadge status={job.status} />
                  </td>
                  <td>
                    <time dateTime={job.createdAt}>{formatDateTime(job.createdAt)}</time>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {nextCursor && (
        <button
          type="button"
          className="button"
          onClick={() => void loadMore()}
          disabled={phase !== 'idle'}
        >
          {phase === 'loading-more' ? 'Loading…' : 'Load more'}
        </button>
      )}
    </section>
  );
}
