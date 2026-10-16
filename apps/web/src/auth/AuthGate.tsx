/**
 * Authentication shell of the SPA: loads `/config.json`, completes an OIDC callback (once, also
 * under React StrictMode), keeps the session in memory and renders either the sign-in page or the
 * application with an API client that sends the bearer token. A 401 from the API, or the token's
 * expiry, ends the session and returns to the sign-in page (the current route is restored after
 * signing in again).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { App } from '../App';
import { createApiClient, type ApiClient } from '../api/client';
import { SignInPage } from '../components/SignInPage';
import { loadAuthConfig, type AuthConfig } from './config';
import { browserOidcClient, type OidcClient, type Session } from './oidc';

type GateState =
  | { phase: 'loading' }
  | { phase: 'signed-out'; notice?: string | undefined; error?: string | undefined }
  | { phase: 'signed-in'; session: Session }
  | { phase: 'misconfigured'; error: string };

export interface AuthGateDeps {
  loadConfig: () => Promise<AuthConfig>;
  createOidc: (config: AuthConfig) => OidcClient;
  createClient: (options: {
    getAccessToken: () => string | undefined;
    onUnauthorized: () => void;
  }) => ApiClient;
  currentUrl: () => string;
  /** Replaces the address bar without navigating (drops `?code=…&state=…`). */
  replaceUrl: (url: string) => void;
  now: () => number;
}

const browserDeps: AuthGateDeps = {
  loadConfig: () => loadAuthConfig(),
  createOidc: browserOidcClient,
  createClient: (options) => createApiClient(options),
  currentUrl: () => window.location.href,
  replaceUrl: (url) => window.history.replaceState(null, '', url),
  now: () => Date.now(),
};

const EXPIRED = 'Your session has ended. Please sign in again.';

export function AuthGate({ deps = browserDeps }: { deps?: AuthGateDeps }) {
  const [state, setState] = useState<GateState>({ phase: 'loading' });
  const oidc = useRef<OidcClient | null>(null);
  const started = useRef(false);
  const session = state.phase === 'signed-in' ? state.session : null;

  useEffect(() => {
    if (started.current) return; // StrictMode re-runs effects; a callback is handled once
    started.current = true;
    void (async () => {
      let config: AuthConfig;
      try {
        config = await deps.loadConfig();
      } catch {
        setState({
          phase: 'misconfigured',
          error: 'Sign-in is not configured for this site (missing or invalid /config.json).',
        });
        return;
      }
      oidc.current = deps.createOidc(config);
      try {
        const result = await oidc.current.handleCallback(deps.currentUrl());
        if (!result) {
          setState({ phase: 'signed-out' });
          return;
        }
        const url = new URL(deps.currentUrl());
        deps.replaceUrl(`${url.pathname}${result.returnTo}`);
        setState({ phase: 'signed-in', session: result.session });
      } catch (error) {
        const url = new URL(deps.currentUrl());
        deps.replaceUrl(`${url.pathname}${url.hash}`);
        setState({
          phase: 'signed-out',
          error: error instanceof Error ? error.message : 'Sign-in failed. Please try again.',
        });
      }
    })();
  }, [deps]);

  // End the session when the access token expires (never send a token we know is expired).
  useEffect(() => {
    if (!session) return;
    const timer = setTimeout(
      () => setState({ phase: 'signed-out', notice: EXPIRED }),
      Math.max(0, session.expiresAt - deps.now() - 5_000),
    );
    return () => clearTimeout(timer);
  }, [session, deps]);

  const signIn = useCallback(() => {
    const client = oidc.current;
    if (!client) return;
    client.beginLogin(window.location.hash).catch((error: unknown) =>
      setState({
        phase: 'signed-out',
        error: error instanceof Error ? error.message : 'Sign-in failed. Please try again.',
      }),
    );
  }, []);

  const signOut = useCallback(() => {
    setState({ phase: 'signed-out' });
    void oidc.current?.logout();
  }, []);

  // One client per session: it sends that session's token and ends it on a 401.
  const client = useMemo(() => {
    if (!session) return null;
    const { accessToken } = session;
    return deps.createClient({
      getAccessToken: () => accessToken,
      onUnauthorized: () => setState({ phase: 'signed-out', notice: EXPIRED }),
    });
  }, [session, deps]);

  switch (state.phase) {
    case 'loading':
      return (
        <p className="container muted" role="status">
          Loading…
        </p>
      );
    case 'misconfigured':
      return <SignInPage error={state.error} />;
    case 'signed-out':
      return <SignInPage onSignIn={signIn} notice={state.notice} error={state.error} />;
    case 'signed-in':
      return client ? <App client={client} user={state.session.user} onSignOut={signOut} /> : null;
  }
}
