/**
 * Shown while nobody is signed in: explains why, offers the sign-in button, and reports an
 * expired session or a failed sign-in. Without `onSignIn` (no configuration) it only explains.
 */
const APP_NAME = 'Document Analysis';

export interface SignInPageProps {
  onSignIn?: (() => void) | undefined;
  /** Informational message, e.g. an expired session. */
  notice?: string | undefined;
  /** Something went wrong (sign-in rejected, configuration missing). */
  error?: string | undefined;
}

export function SignInPage({ onSignIn, notice, error }: SignInPageProps) {
  return (
    <>
      <header className="site-header">
        <div className="container site-header__inner">
          <h1 className="site-title">{APP_NAME}</h1>
        </div>
      </header>
      <main id="main-content" className="container" tabIndex={-1}>
        <section className="card" aria-labelledby="sign-in-heading">
          <h2 id="sign-in-heading">Sign in</h2>
          <p className="lead">
            Sign in with your organisation account to submit documents and see your own jobs.
          </p>
          {notice && (
            <div className="alert" role="status">
              <p>{notice}</p>
            </div>
          )}
          {error && (
            <div className="alert alert--error" role="alert">
              <p className="alert__title">Sign-in problem</p>
              <p>{error}</p>
            </div>
          )}
          {onSignIn && (
            <button type="button" className="button button--primary" onClick={onSignIn}>
              Sign in
            </button>
          )}
        </section>
      </main>
    </>
  );
}
