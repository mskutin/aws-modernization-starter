import { CONTRACT_VERSION, type Job } from '@starter/contracts';
import { useEffect, useRef } from 'react';
import { createApiClient, type ApiClient } from './api/client';
import { JobDetailPage } from './components/JobDetailPage';
import { JobList } from './components/JobList';
import { NotFound } from './components/NotFound';
import { SubmitJobForm } from './components/SubmitJobForm';
import { HOME_HREF, jobHref, navigate, routeKey, useHashRoute } from './routing';

const defaultClient = createApiClient();
const APP_NAME = 'Document Analysis';

export interface AppProps {
  client?: ApiClient;
  /** The signed-in user (identity); shown with a sign-out button when present. */
  user?: { name: string } | undefined;
  onSignOut?: (() => void) | undefined;
}

export function App({ client = defaultClient, user, onSignOut }: AppProps) {
  const route = useHashRoute();
  const key = routeKey(route);
  const mainRef = useRef<HTMLElement>(null);
  const previousKey = useRef<string | null>(null);

  // Move focus to the new view on client-side navigation (not on first load)
  // so keyboard and screen-reader users start at the new content.
  useEffect(() => {
    if (previousKey.current !== null && previousKey.current !== key) mainRef.current?.focus();
    previousKey.current = key;
    if (route.name === 'home') document.title = APP_NAME;
    if (route.name === 'not-found') document.title = `Page not found — ${APP_NAME}`;
  }, [key, route.name]);

  const onCreated = (job: Job) => navigate(jobHref(job.jobId));

  return (
    <>
      <a
        className="skip-link"
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          mainRef.current?.focus();
        }}
      >
        Skip to main content
      </a>
      <header className="site-header">
        <div className="container site-header__inner">
          <h1 className="site-title">{APP_NAME}</h1>
          <nav aria-label="Main">
            <ul className="nav-list">
              <li>
                <a href={HOME_HREF} aria-current={route.name === 'home' ? 'page' : undefined}>
                  Jobs
                </a>
              </li>
            </ul>
          </nav>
          {user && (
            <div className="session">
              <span className="muted">
                Signed in as <strong>{user.name}</strong>
              </span>
              {onSignOut && (
                <button type="button" className="button" onClick={onSignOut}>
                  Sign out
                </button>
              )}
            </div>
          )}
        </div>
      </header>

      <main id="main-content" className="container" ref={mainRef} tabIndex={-1}>
        {route.name === 'home' && (
          <>
            <SubmitJobForm client={client} onCreated={onCreated} />
            <JobList client={client} />
          </>
        )}
        {route.name === 'job' && (
          <JobDetailPage key={route.jobId} client={client} jobId={route.jobId} />
        )}
        {route.name === 'not-found' && <NotFound />}
      </main>

      <footer className="site-footer">
        <div className="container">
          AWS modernization starter · API contract v{CONTRACT_VERSION}
        </div>
      </footer>
    </>
  );
}
