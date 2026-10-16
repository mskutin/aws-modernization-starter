/**
 * The authentication shell: signed-out page, sign-in redirect, callback completion (once, also
 * under StrictMode), the app with a bearer token, 401 → back to sign-in, sign-out, and the rule
 * that tokens never land in Web Storage.
 */
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../src/api/client';
import { AuthGate, type AuthGateDeps } from '../src/auth/AuthGate';
import type { AuthConfig } from '../src/auth/config';
import type { OidcClient, Session } from '../src/auth/oidc';
import { aSummary, jsonResponse, problemResponse, routedFetch, type FetchMock } from './helpers';

const CONFIG: AuthConfig = {
  issuer: 'https://idp.example.com',
  clientId: 'starter-web',
  scope: 'openid jobs:read jobs:write',
};
const SESSION: Session = {
  accessToken: 'secret-access-token',
  expiresAt: Date.now() + 600_000,
  user: { sub: 'user-1', name: 'alice' },
};

function fakeOidc(callback: Awaited<ReturnType<OidcClient['handleCallback']>> | Error) {
  return {
    handleCallback: vi.fn(async () => {
      if (callback instanceof Error) throw callback;
      return callback;
    }),
    beginLogin: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
  };
}

function deps(
  oidc: ReturnType<typeof fakeOidc>,
  fetchMock: FetchMock,
  overrides: Partial<AuthGateDeps> = {},
): AuthGateDeps {
  return {
    loadConfig: async () => CONFIG,
    createOidc: () => oidc as unknown as OidcClient,
    createClient: (options) => createApiClient({ baseUrl: '/v1', fetch: fetchMock, ...options }),
    currentUrl: () => 'https://app.example.com/?code=c&state=s',
    replaceUrl: vi.fn(),
    now: () => Date.now(),
    ...overrides,
  };
}

const listing = () =>
  routedFetch([
    {
      url: /\/v1\/jobs(\?.*)?$/,
      reply: () => jsonResponse({ items: [aSummary()], nextCursor: null }),
    },
  ]);

describe('AuthGate', () => {
  it('shows the sign-in page when nobody is signed in, and starts the redirect', async () => {
    const oidc = fakeOidc(null);
    const user = userEvent.setup();
    window.location.hash = '#/jobs/0f8fad5b-d9cb-469f-a165-70867728950e';
    render(<AuthGate deps={deps(oidc, listing())} />);
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeVisible();
    expect(screen.queryByRole('form', { name: 'Analyse a document' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(oidc.beginLogin).toHaveBeenCalledWith('#/jobs/0f8fad5b-d9cb-469f-a165-70867728950e');
  });

  it('completes the callback once (StrictMode), cleans the URL and calls the API with the token', async () => {
    const oidc = fakeOidc({ session: SESSION, returnTo: '#/' });
    const fetchMock = listing();
    const replaceUrl = vi.fn();
    render(
      <StrictMode>
        <AuthGate deps={deps(oidc, fetchMock, { replaceUrl })} />
      </StrictMode>,
    );
    expect(await screen.findByText('alice')).toBeVisible();
    expect(await screen.findByRole('link', { name: 'Migration notes' })).toBeVisible();
    expect(oidc.handleCallback).toHaveBeenCalledTimes(1);
    expect(replaceUrl).toHaveBeenCalledWith('/#/');
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get('authorization')).toBe('Bearer secret-access-token');
    // Tokens live in memory only.
    expect(JSON.stringify({ ...sessionStorage })).not.toContain('secret-access-token');
    expect(JSON.stringify({ ...localStorage })).not.toContain('secret-access-token');
  });

  it('returns to the sign-in page with a notice when the API answers 401', async () => {
    const oidc = fakeOidc({ session: SESSION, returnTo: '#/' });
    const fetchMock = routedFetch([
      {
        url: /\/v1\/jobs(\?.*)?$/,
        reply: () =>
          problemResponse({
            status: 401,
            type: 'urn:starter:problem:unauthorized',
            title: 'Unauthorized',
          }),
      },
    ]);
    render(<AuthGate deps={deps(oidc, fetchMock)} />);
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('Your session has ended');
  });

  it('ends the session when the access token expires', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const oidc = fakeOidc({
        session: { ...SESSION, expiresAt: Date.now() + 20_000 },
        returnTo: '#/',
      });
      render(<AuthGate deps={deps(oidc, listing())} />);
      expect(await screen.findByText('alice')).toBeVisible();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(16_000);
      });
      expect(screen.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    } finally {
      vi.useRealTimers();
    }
  });

  it('signs out locally and at the IdP', async () => {
    const oidc = fakeOidc({ session: SESSION, returnTo: '#/' });
    const user = userEvent.setup();
    render(<AuthGate deps={deps(oidc, listing())} />);
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    expect(oidc.logout).toHaveBeenCalledOnce();
  });

  it('reports a rejected sign-in response', async () => {
    const oidc = fakeOidc(
      new Error('This sign-in response was not requested by this browser tab.'),
    );
    render(<AuthGate deps={deps(oidc, listing())} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('not requested by this browser tab');
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });

  it('explains a missing configuration instead of guessing an IdP', async () => {
    const oidc = fakeOidc(null);
    render(
      <AuthGate
        deps={deps(oidc, listing(), {
          loadConfig: async () => {
            throw new Error('404');
          },
        })}
      />,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('/config.json');
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
  });
});
