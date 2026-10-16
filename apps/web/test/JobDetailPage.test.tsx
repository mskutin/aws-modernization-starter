import { render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { JobDetailPage } from '../src/components/JobDetailPage';
import {
  JOB_ID,
  aJob,
  aResult,
  clientWith,
  jsonResponse,
  problemResponse,
  sequenceFetch,
} from './helpers';

function renderDetail(...replies: Parameters<typeof sequenceFetch>) {
  const fetchMock = sequenceFetch(...replies);
  render(<JobDetailPage client={clientWith(fetchMock)} jobId={JOB_ID} />);
  return fetchMock;
}

describe('JobDetailPage', () => {
  it('shows the results of a succeeded job', async () => {
    renderDetail(jsonResponse(aJob({ status: 'SUCCEEDED', result: aResult() })));

    expect(await screen.findByRole('heading', { level: 2, name: 'Migration notes' })).toBeVisible();
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Status: SUCCEEDED');
    expect(status).toHaveAttribute('data-status', 'SUCCEEDED');
    expect(screen.queryByText('Updating automatically…')).not.toBeInTheDocument();

    const results = screen.getByRole('region', { name: 'Results' });
    expect(within(results).getByText('Words').nextElementSibling).toHaveTextContent('30');
    expect(within(results).getByText('Reading time').nextElementSibling).toHaveTextContent('9 s');
    expect(within(results).getByText('Lexical diversity').nextElementSibling).toHaveTextContent(
      '86.7%',
    );

    const terms = within(results).getByRole('table', { name: 'Top terms' });
    const rows = within(terms).getAllByRole('row').slice(1);
    expect(rows.map((row) => row.textContent)).toEqual([
      '1cloud3',
      '2migration3',
      '3applications1',
    ]);
    expect(within(results).getByText('ab'.repeat(32))).toBeVisible();
    // The title is set by an effect after the render that shows the heading. Under CI load the
    // effect can land after waitFor's 1 s default, so the
    // bounded wait gets more headroom; the assertion itself is unchanged.
    await waitFor(() => expect(document.title).toBe('Migration notes — Document Analysis'), {
      timeout: 5_000,
    });
  });

  it('shows the error of a failed job in an alert', async () => {
    renderDetail(
      jsonResponse(
        aJob({
          status: 'FAILED',
          error: {
            name: 'JobValidationError',
            message: 'Document rejected: content has 3 word(s); at least 10 are required',
          },
        }),
      ),
    );

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Job failed');
    expect(alert).toHaveTextContent('JobValidationError');
    expect(alert).toHaveTextContent('at least 10 are required');
    expect(screen.getByRole('status')).toHaveTextContent('Status: FAILED');
    expect(screen.queryByRole('region', { name: 'Results' })).not.toBeInTheDocument();
  });

  it('shows progress for a running job', async () => {
    renderDetail(jsonResponse(aJob({ status: 'PROCESSING' })));
    expect(await screen.findByRole('status')).toHaveTextContent('Status: PROCESSING');
    expect(screen.getByText('Updating automatically…')).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('Turnaround')).not.toBeInTheDocument();
  });

  it('shows the turnaround of a finished job', async () => {
    renderDetail(
      jsonResponse(
        aJob({
          status: 'SUCCEEDED',
          result: aResult(),
          createdAt: '2026-10-13T10:00:00.000Z',
          updatedAt: '2026-10-13T10:01:30.000Z',
        }),
      ),
    );
    expect(await screen.findByText('Turnaround')).toBeVisible();
    expect(screen.getByText('Turnaround').nextElementSibling).toHaveTextContent('1 min 30 s');
  });

  it('reads "under 1 s" for sub-second turnarounds (local simulation)', async () => {
    renderDetail(jsonResponse(aJob({ status: 'FAILED', error: null })));
    expect(await screen.findByText('Turnaround')).toBeVisible();
    expect(screen.getByText('Turnaround').nextElementSibling).toHaveTextContent('under 1 s');
  });

  it('explains when the job does not exist', async () => {
    renderDetail(
      problemResponse({ status: 404, title: 'Not Found', detail: 'No job with this id.' }),
    );
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByRole('heading', { name: 'Job not found' })).toBeVisible();
    expect(alert).toHaveTextContent('No job with this id.');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to jobs' })).toHaveAttribute('href', '#/');
  });
});
