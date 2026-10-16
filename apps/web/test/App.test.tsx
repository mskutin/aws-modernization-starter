import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { JOB_ID, aJob, aResult, aSummary, clientWith, jsonResponse, routedFetch } from './helpers';

const LIST = /\/v1\/jobs(\?.*)?$/;
const DETAIL = new RegExp(`/v1/jobs/${JOB_ID}$`);

async function goTo(hash: string) {
  await act(async () => {
    window.location.hash = hash;
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('App', () => {
  it('renders landmarks, the submit form and the job list on the home route', async () => {
    const fetchMock = routedFetch([
      { url: LIST, reply: () => jsonResponse({ items: [aSummary()], nextCursor: null }) },
    ]);
    render(<App client={clientWith(fetchMock)} />);

    expect(screen.getByRole('banner')).toHaveTextContent('Document Analysis');
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Jobs' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('main')).toBeVisible();
    expect(screen.getByRole('form', { name: 'Analyse a document' })).toBeVisible();
    expect(screen.getByRole('heading', { level: 2, name: 'Recent jobs' })).toBeVisible();
    expect(await screen.findByRole('link', { name: 'Migration notes' })).toBeVisible();
  });

  it('submits a document and follows the job to its results', async () => {
    let polls = 0;
    const fetchMock = routedFetch([
      { url: LIST, reply: () => jsonResponse({ items: [], nextCursor: null }) },
      { method: 'POST', url: /\/v1\/jobs$/, reply: () => jsonResponse(aJob(), { status: 202 }) },
      {
        url: DETAIL,
        reply: () => {
          polls += 1;
          return jsonResponse(aJob({ status: 'SUCCEEDED', result: aResult() }));
        },
      },
    ]);
    const user = userEvent.setup();
    render(<App client={clientWith(fetchMock)} />);

    await user.type(screen.getByLabelText('Title'), 'Migration notes');
    await user.click(screen.getByLabelText('Document text'));
    await user.paste('Cloud migration is a journey. Every migration starts with discovery!');
    await user.click(screen.getByRole('button', { name: 'Analyse document' }));

    expect(await screen.findByRole('heading', { level: 2, name: 'Migration notes' })).toBeVisible();
    expect(window.location.hash).toBe(`#/jobs/${JOB_ID}`);
    expect(screen.getByRole('status')).toHaveTextContent('Status: SUCCEEDED');
    expect(screen.getByRole('table', { name: 'Top terms' })).toBeVisible();
    expect(screen.getByRole('main')).toHaveFocus();
    expect(polls).toBe(1);
  });

  it('opens a job from the list via its link', async () => {
    const fetchMock = routedFetch([
      { url: LIST, reply: () => jsonResponse({ items: [aSummary()], nextCursor: null }) },
      {
        url: DETAIL,
        reply: () =>
          jsonResponse(
            aJob({ status: 'FAILED', error: { name: 'JobValidationError', message: 'too short' } }),
          ),
      },
    ]);
    const user = userEvent.setup();
    render(<App client={clientWith(fetchMock)} />);

    await user.click(await screen.findByRole('link', { name: 'Migration notes' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('JobValidationError: too short');
    expect(screen.getByRole('link', { name: 'Jobs' })).not.toHaveAttribute('aria-current');
  });

  it.each(['#/does-not-exist', '#/jobs/not-a-uuid'])(
    'shows a not-found page for %s',
    async (hash) => {
      const fetchMock = routedFetch([]);
      window.location.hash = hash;
      render(<App client={clientWith(fetchMock)} />);

      expect(screen.getByRole('heading', { level: 2, name: 'Page not found' })).toBeVisible();
      expect(
        within(screen.getByRole('main')).getByRole('link', { name: 'Back to jobs' }),
      ).toHaveAttribute('href', '#/');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(document.title).toBe('Page not found — Document Analysis');
    },
  );

  it('returns home when the hash changes back', async () => {
    const fetchMock = routedFetch([
      { url: LIST, reply: () => jsonResponse({ items: [], nextCursor: null }) },
    ]);
    window.location.hash = '#/nowhere';
    render(<App client={clientWith(fetchMock)} />);
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeVisible();

    await goTo('#/');
    expect(screen.getByRole('form', { name: 'Analyse a document' })).toBeVisible();
    expect(screen.getByRole('main')).toHaveFocus();
  });
});
