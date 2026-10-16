import { randomUUID } from 'node:crypto';
import { expect, type Locator, type Page } from '@playwright/test';
import { TOO_SHORT_DOCUMENT, VALID_DOCUMENT } from '@starter/testing';

/**
 * Shared documents from @starter/testing (VALID_DOCUMENT: top terms "cloud" and "migration"), with a
 * unique title so every submission is a distinct job.
 */
export function validDocument() {
  return { title: `E2E report ${randomUUID().slice(0, 8)}`, content: VALID_DOCUMENT };
}

export function shortDocument() {
  return { title: `E2E short ${randomUUID().slice(0, 8)}`, content: TOO_SHORT_DOCUMENT };
}

/** Accessible locators for the submission form (labels/roles only — no CSS or test ids). */
export function form(page: Page) {
  return {
    title: page.getByLabel(/^title/i),
    content: page.getByLabel(/^(document|content|text)/i),
    submit: page.getByRole('button', { name: /submit|analy[sz]e/i }),
  };
}

/** Keyboard-only navigation: press Tab until `target` has focus (bounded). */
export async function tabTo(page: Page, target: Locator, maxTabs = 25): Promise<void> {
  for (let i = 0; i < maxTabs; i += 1) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  await expect(target, `not reachable within ${maxTabs} Tab presses`).toBeFocused();
}

/** Status line on the job page: <p role="status">Status: X</p>. */
export const jobStatus = (page: Page) => page.getByRole('status').filter({ hasText: /^Status:/ });

export type TestUser = 'alice' | 'bob' | 'mallory';

/**
 * Signs in through the TEST ONLY identity provider (authorization code + PKCE): the SPA's
 * "Sign in" button → the IdP's sign-in page → "Sign in as <user>" → back on the SPA, signed in.
 * `path` is opened first (e.g. a deep link) and restored after the redirect.
 */
export async function signIn(page: Page, user: TestUser = 'alice', path = '/'): Promise<void> {
  await page.goto(path);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('TEST ONLY identity provider')).toBeVisible();
  await page.getByRole('button', { name: `Sign in as ${user}` }).click();
  await expect(page.getByText(`Signed in as ${user}`)).toBeVisible();
}
