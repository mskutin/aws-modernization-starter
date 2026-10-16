/**
 * User journeys through the SPA served by the web tier (CloudFront stand-in): sign in through
 * the TEST ONLY identity provider, submit, follow the job to its terminal state, see results or
 * the failure, client-side validation, keyboard-only use, sign-out and per-user isolation.
 * Selectors: roles, labels and visible text only.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Request } from '@playwright/test';
import { newAuthContext } from '../support/auth-mode.js';
import { expect, test } from '../support/fixtures.js';
import {
  form,
  jobStatus,
  shortDocument,
  signIn,
  tabTo,
  validDocument,
} from '../support/helpers.js';

const JOB_URL = /#\/jobs\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test.describe('document analysis jobs', () => {
  test('submit a document → SUCCEEDED → results render (same-origin API)', async ({
    page,
    baseURL,
  }) => {
    const apiCalls: Request[] = [];
    page.on('request', (r) => {
      if (new URL(r.url()).pathname.startsWith('/v1/')) apiCalls.push(r);
    });
    const doc = validDocument();

    await signIn(page);
    const f = form(page);
    await f.title.fill(doc.title);
    await f.content.fill(doc.content);
    await f.submit.click();

    await expect(page).toHaveURL(JOB_URL);
    await expect(page.getByRole('heading', { name: doc.title })).toBeVisible();
    await expect(jobStatus(page)).toHaveText('Status: SUCCEEDED');

    const results = page.getByRole('region', { name: 'Results' });
    await expect(results).toBeVisible();
    const topTerms = results.getByRole('table', { name: 'Top terms' });
    await expect(topTerms).toBeVisible();
    await expect(topTerms.getByRole('rowheader', { name: 'cloud', exact: true })).toBeVisible();
    await expect(topTerms.getByRole('rowheader', { name: 'migration', exact: true })).toBeVisible();
    const sha = createHash('sha256').update(doc.content, 'utf8').digest('hex');
    await expect(results.getByText(sha)).toBeVisible();

    // The browser only ever talks to its own origin (CloudFront/nginx routes /v1 to the API).
    expect(apiCalls.length).toBeGreaterThan(0);
    const origin = new URL(baseURL ?? '').origin;
    for (const r of apiCalls) expect(new URL(r.url()).origin).toBe(origin);
    expect(apiCalls.some((r) => r.method() === 'POST')).toBe(true);
    // Every API call carried the bearer token (kept in memory, never in Web Storage).
    for (const r of apiCalls)
      expect(r.headers().authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    const storage = await page.evaluate(() =>
      JSON.stringify({ ...sessionStorage, ...localStorage }),
    );
    expect(storage).not.toMatch(/eyJ[\w-]+\.[\w-]+\./);
  });

  test('business-rule failure → FAILED state with the validation message', async ({ page }) => {
    const doc = shortDocument();
    await signIn(page);
    const f = form(page);
    await f.title.fill(doc.title);
    await f.content.fill(doc.content);
    await f.submit.click();

    await expect(page).toHaveURL(JOB_URL);
    await expect(jobStatus(page)).toHaveText('Status: FAILED');
    const alert = page
      .getByRole('alert')
      .filter({ has: page.getByRole('heading', { name: 'Job failed' }) });
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('JobValidationError');
    await expect(alert).toContainText(/at least 10/i);
    await expect(page.getByRole('region', { name: 'Results' })).toHaveCount(0);
  });

  test('client-side validation blocks an empty submission (no API call)', async ({ page }) => {
    let posts = 0;
    page.on('request', (r) => {
      if (r.method() === 'POST' && new URL(r.url()).pathname === '/v1/jobs') posts += 1;
    });
    await signIn(page);
    const f = form(page);
    await f.submit.click();

    // still on the form; both fields flagged invalid with the message as accessible description,
    // and focus moved to the first invalid field
    await expect(page).not.toHaveURL(JOB_URL);
    await expect(f.title).toHaveAttribute('aria-invalid', 'true');
    await expect(f.title).toHaveAccessibleDescription(/enter a title/i);
    await expect(f.content).toHaveAttribute('aria-invalid', 'true');
    await expect(f.content).toHaveAccessibleDescription(/enter the document text/i);
    await expect(f.title).toBeFocused();

    // whitespace-only content is rejected too
    await f.title.fill('Has a title');
    await f.content.fill('   \n  ');
    await f.submit.click();
    await expect(page).not.toHaveURL(JOB_URL);
    await expect(f.title).not.toHaveAttribute('aria-invalid', 'true');
    await expect(f.content).toHaveAttribute('aria-invalid', 'true');
    await expect(f.content).toBeFocused();
    expect(posts).toBe(0);
  });

  test('keyboard-only: Tab to each field, type, submit with Enter, reach SUCCEEDED', async ({
    page,
  }) => {
    const doc = validDocument();
    await signIn(page);
    const f = form(page);

    await tabTo(page, f.title);
    await page.keyboard.type(doc.title);
    await tabTo(page, f.content);
    await page.keyboard.type(doc.content);
    await tabTo(page, f.submit);
    await page.keyboard.press('Enter');

    await expect(page).toHaveURL(JOB_URL);
    await expect(jobStatus(page)).toHaveText('Status: SUCCEEDED');
    await expect(page.getByRole('region', { name: 'Results' })).toBeVisible();

    // and back to the list with the keyboard
    const back = page.getByRole('link', { name: 'Back to jobs' });
    await tabTo(page, back);
    await page.keyboard.press('Enter');
    await expect(page).not.toHaveURL(JOB_URL);
    await expect(form(page).title).toBeVisible();
  });

  test('deep link to an unknown job shows "Job not found" (the link survives the sign-in)', async ({
    page,
  }) => {
    const id = randomUUID();
    await signIn(page, 'alice', `/#/jobs/${id}`);
    await expect(page).toHaveURL(new RegExp(`#/jobs/${id}$`));
    const alert = page.getByRole('alert');
    await expect(alert.getByRole('heading', { name: 'Job not found' })).toBeVisible();
  });
});

test.describe('identity', () => {
  test('nobody signed in: the sign-in page, and no API call', async ({ page }) => {
    let apiCalls = 0;
    page.on('request', (r) => {
      if (new URL(r.url()).pathname.startsWith('/v1/')) apiCalls += 1;
    });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByRole('form', { name: 'Analyse a document' })).toHaveCount(0);
    expect(apiCalls).toBe(0);
  });

  test("bob cannot open alice's job by its link, nor see it in his list", async ({ browser }) => {
    const doc = validDocument();
    const alice = await newAuthContext(browser);
    const bob = await newAuthContext(browser);
    try {
      const a = await alice.newPage();
      await signIn(a, 'alice');
      await form(a).title.fill(doc.title);
      await form(a).content.fill(doc.content);
      await form(a).submit.click();
      await expect(a).toHaveURL(JOB_URL);
      const jobPath = new URL(a.url()).hash;

      const b = await bob.newPage();
      await signIn(b, 'bob', `/${jobPath}`);
      await expect(b.getByRole('heading', { name: 'Job not found' })).toBeVisible();
      await expect(b.getByText(doc.title)).toHaveCount(0);
      await b.goto('/#/');
      await expect(b.getByRole('heading', { name: 'Recent jobs' })).toBeVisible();
      await expect(b.getByRole('link', { name: doc.title })).toHaveCount(0);
    } finally {
      await alice.close();
      await bob.close();
    }
  });

  test('sign out returns to the sign-in page', async ({ page }) => {
    await signIn(page, 'mallory');
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByText('Signed in as')).toHaveCount(0);
  });
});
