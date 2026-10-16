/**
 * `test` with the auth-mode-aware `context` fixture (support/auth-mode.ts): in
 * E2E_AUTH_MODE=aws-test-issuer every page of the default context reaches the local test IdP
 * through the sandbox issuer's routes; locally nothing changes.
 */
import { test as base } from '@playwright/test';
import { prepareContext } from './auth-mode.js';

export const test = base.extend({
  context: async ({ context }, use) => {
    await prepareContext(context);
    await use(context);
  },
});

export { expect } from '@playwright/test';
