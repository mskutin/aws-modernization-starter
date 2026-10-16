import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SubmitJobForm } from '../src/components/SubmitJobForm';
import {
  aJob,
  clientWith,
  jsonResponse,
  problemResponse,
  requestHeaders,
  sequenceFetch,
  type FetchMock,
} from './helpers';

const DOCUMENT = 'Cloud migration is a journey. Every migration starts with discovery!';

function setup(fetchMock: FetchMock) {
  const onCreated = vi.fn();
  const user = userEvent.setup();
  render(<SubmitJobForm client={clientWith(fetchMock)} onCreated={onCreated} />);
  const form = screen.getByRole('form', { name: 'Analyse a document' });
  const title = within(form).getByLabelText('Title');
  const content = within(form).getByLabelText('Document text');
  const topTerms = within(form).getByLabelText('Top terms');
  const submit = within(form).getByRole('button', { name: 'Analyse document' });

  async function fill(values: { title?: string; content?: string; topTerms?: string }) {
    if (values.title !== undefined) {
      await user.clear(title);
      if (values.title) await user.type(title, values.title);
    }
    if (values.content !== undefined) {
      await user.clear(content);
      if (values.content) {
        await user.click(content);
        await user.paste(values.content);
      }
    }
    if (values.topTerms !== undefined) {
      await user.clear(topTerms);
      if (values.topTerms) await user.type(topTerms, values.topTerms);
    }
  }

  return { user, onCreated, form, title, content, topTerms, submit, fill };
}

describe('SubmitJobForm', () => {
  it('blocks submission and explains errors when required fields are empty', async () => {
    const fetchMock = sequenceFetch();
    const { user, submit, title, content } = setup(fetchMock);

    await user.click(submit);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(title).toBeInvalid();
    expect(title).toHaveAccessibleDescription('Enter a title.');
    expect(content).toBeInvalid();
    expect(content).toHaveAccessibleDescription(
      expect.stringContaining('Enter the document text.'),
    );
    expect(title).toHaveFocus();
  });

  it('rejects whitespace-only text and out-of-range top terms like the contract', async () => {
    const fetchMock = sequenceFetch();
    const { user, submit, fill, content, topTerms, title } = setup(fetchMock);

    await fill({ title: 'Report', content: '   \n\t ', topTerms: '26' });
    await user.click(submit);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(title).toBeValid();
    expect(content).toHaveAccessibleDescription(
      expect.stringContaining('Enter the document text.'),
    );
    expect(topTerms).toHaveAccessibleDescription(
      expect.stringContaining('Top terms must be a whole number from 1 to 25.'),
    );
    expect(content).toHaveFocus();
  });

  it('clears a field error as soon as the user edits that field', async () => {
    const { user, submit, title } = setup(sequenceFetch());
    await user.click(submit);
    expect(title).toBeInvalid();
    await user.type(title, 'R');
    expect(title).toBeValid();
  });

  it('submits the parsed request with an Idempotency-Key and reports the created job', async () => {
    const job = aJob();
    const fetchMock = sequenceFetch(jsonResponse(job, { status: 202 }));
    const { user, submit, fill, onCreated } = setup(fetchMock);

    await fill({ title: '  Report  ', content: DOCUMENT, topTerms: '5' });
    await user.click(submit);

    expect(onCreated).toHaveBeenCalledWith(job);
    expect(fetchMock).toHaveBeenCalledOnce();
    const body: unknown = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toEqual({ title: 'Report', content: DOCUMENT, options: { topTerms: 5 } });
    expect(requestHeaders(fetchMock).get('Idempotency-Key')).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
  });

  it('shows a busy, disabled button while submitting', async () => {
    let release: (response: Response) => void = () => {};
    const fetchMock = sequenceFetch(() => new Promise<Response>((resolve) => (release = resolve)));
    const { user, submit, fill, onCreated } = setup(fetchMock);
    await fill({ title: 'Report', content: DOCUMENT });

    await user.click(submit);
    expect(submit).toBeDisabled();
    expect(submit).toHaveTextContent('Submitting…');
    await user.click(submit);
    expect(fetchMock).toHaveBeenCalledOnce();

    release(jsonResponse(aJob(), { status: 202 }));
    await vi.waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
    expect(submit).toBeEnabled();
    expect(submit).toHaveTextContent('Analyse document');
  });

  it('reuses the Idempotency-Key when retrying identical contents after a failure', async () => {
    const fetchMock = sequenceFetch(
      problemResponse({ status: 503, title: 'Service Unavailable', detail: 'Try again later.' }),
      jsonResponse(aJob(), { status: 200, headers: { 'Idempotent-Replayed': 'true' } }),
    );
    const { user, submit, fill, onCreated } = setup(fetchMock);
    await fill({ title: 'Report', content: DOCUMENT });

    await user.click(submit);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Try again later.');
    expect(alert).toHaveTextContent('Reference: req-123');
    expect(alert).toHaveFocus();
    expect(onCreated).not.toHaveBeenCalled();

    await user.click(submit);
    await vi.waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
    expect(requestHeaders(fetchMock, 1).get('Idempotency-Key')).toBe(
      requestHeaders(fetchMock, 0).get('Idempotency-Key'),
    );
  });

  it('uses a new Idempotency-Key once the contents change', async () => {
    const fetchMock = sequenceFetch(
      problemResponse({ status: 503, title: 'Service Unavailable' }),
      jsonResponse(aJob(), { status: 202 }),
    );
    const { user, submit, fill, onCreated } = setup(fetchMock);
    await fill({ title: 'Report', content: DOCUMENT });
    await user.click(submit);
    await screen.findByRole('alert');

    await fill({ title: 'Report v2' });
    await user.click(submit);
    await vi.waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
    expect(requestHeaders(fetchMock, 1).get('Idempotency-Key')).not.toBe(
      requestHeaders(fetchMock, 0).get('Idempotency-Key'),
    );
  });

  it('maps server-side 400 field errors onto fields and lists the rest', async () => {
    const fetchMock = sequenceFetch(
      problemResponse({
        status: 400,
        title: 'Bad Request',
        detail: 'Request validation failed.',
        errors: [
          { path: 'body.title', message: 'Title rejected by server' },
          { path: 'header.idempotency-key', message: 'Invalid key' },
        ],
      }),
    );
    const { user, submit, fill, title } = setup(fetchMock);
    await fill({ title: 'Report', content: DOCUMENT });
    await user.click(submit);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Request validation failed.');
    expect(within(alert).getByRole('listitem')).toHaveTextContent(
      'header.idempotency-key: Invalid key',
    );
    expect(title).toBeInvalid();
    expect(title).toHaveAccessibleDescription('Title rejected by server');
  });

  it('explains network failures', async () => {
    const { user, submit, fill } = setup(sequenceFetch(new TypeError('Failed to fetch')));
    await fill({ title: 'Report', content: DOCUMENT });
    await user.click(submit);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not reach the API. Check your connection and try again.',
    );
  });
});
