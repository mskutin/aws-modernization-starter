import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { JobList } from '../src/components/JobList';
import {
  JOB_ID,
  OTHER_JOB_ID,
  aSummary,
  clientWith,
  jsonResponse,
  problemResponse,
  requestUrl,
  sequenceFetch,
} from './helpers';

const THIRD_ID = '16fd2706-8baf-433b-82eb-8c7fada847da';

describe('JobList', () => {
  it('renders jobs newest first with links to their detail pages', async () => {
    const fetchMock = sequenceFetch(
      jsonResponse({
        items: [
          aSummary({ jobId: JOB_ID, title: 'Newest', status: 'PROCESSING' }),
          aSummary({ jobId: OTHER_JOB_ID, title: 'Older', status: 'FAILED' }),
        ],
        nextCursor: null,
      }),
    );
    render(<JobList client={clientWith(fetchMock)} />);

    const table = await screen.findByRole('table', { name: 'Recent jobs' });
    const rows = within(table).getAllByRole('row');
    expect(
      within(rows[0]!)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Title', 'Status', 'Submitted']);
    expect(within(rows[1]!).getByRole('link', { name: 'Newest' })).toHaveAttribute(
      'href',
      `#/jobs/${JOB_ID}`,
    );
    expect(rows[1]).toHaveTextContent('PROCESSING');
    expect(rows[2]).toHaveTextContent('Older');
    expect(rows[2]).toHaveTextContent('FAILED');
    expect(within(rows[1]!).getByText(/./, { selector: 'time' })).toHaveAttribute(
      'datetime',
      '2026-10-13T10:00:00.000Z',
    );
    expect(requestUrl(fetchMock)).toBe('/v1/jobs?limit=20');
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('shows an empty state', async () => {
    render(
      <JobList client={clientWith(sequenceFetch(jsonResponse({ items: [], nextCursor: null })))} />,
    );
    expect(await screen.findByText('No jobs yet. Submit a document to get started.')).toBeVisible();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('loads further pages with the cursor and appends them', async () => {
    const fetchMock = sequenceFetch(
      jsonResponse({
        items: [aSummary({ jobId: JOB_ID, title: 'First' })],
        nextCursor: 'cursor-1',
      }),
      jsonResponse({
        items: [aSummary({ jobId: OTHER_JOB_ID, title: 'Second' })],
        nextCursor: null,
      }),
    );
    const user = userEvent.setup();
    render(<JobList client={clientWith(fetchMock)} />);

    await user.click(await screen.findByRole('button', { name: 'Load more' }));

    expect(await screen.findByRole('link', { name: 'Second' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'First' })).toBeVisible();
    expect(requestUrl(fetchMock, 1)).toBe('/v1/jobs?limit=20&cursor=cursor-1');
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('refreshes the first page on demand', async () => {
    const fetchMock = sequenceFetch(
      jsonResponse({ items: [aSummary({ title: 'Before', status: 'PENDING' })], nextCursor: null }),
      jsonResponse({
        items: [
          aSummary({ jobId: THIRD_ID, title: 'Brand new', status: 'PENDING' }),
          aSummary({ title: 'Before', status: 'SUCCEEDED' }),
        ],
        nextCursor: null,
      }),
    );
    const user = userEvent.setup();
    render(<JobList client={clientWith(fetchMock)} />);
    await screen.findByRole('link', { name: 'Before' });

    await user.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(await screen.findByRole('link', { name: 'Brand new' })).toBeVisible();
    expect(screen.getAllByRole('row')).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports load failures in an alert and recovers on refresh', async () => {
    const fetchMock = sequenceFetch(
      problemResponse({
        status: 503,
        title: 'Service Unavailable',
        detail: 'Database unavailable',
      }),
      jsonResponse({ items: [aSummary({ title: 'Recovered' })], nextCursor: null }),
    );
    const user = userEvent.setup();
    render(<JobList client={clientWith(fetchMock)} />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load jobs.');
    expect(alert).toHaveTextContent('Database unavailable');

    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByRole('link', { name: 'Recovered' })).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
