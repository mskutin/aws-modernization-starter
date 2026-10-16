import type { ApiError } from '../api/errors';

export function describeApiError(error: ApiError): string {
  // Identity: clear, actionable wording for authorization and throttling.
  if (error.status === 401) return 'Your session has ended. Please sign in again.';
  if (error.status === 403) {
    return 'Your account is not permitted to do this. Ask your administrator for access.';
  }
  if (error.status === 429) {
    const wait = error.retryAfterSeconds;
    return `Too many requests. Please wait ${wait ? `${wait} second${wait === 1 ? '' : 's'}` : 'a moment'} and try again.`;
  }
  switch (error.kind) {
    case 'network':
      return 'Could not reach the API. Check your connection and try again.';
    case 'problem':
      return error.problem?.detail ?? error.problem?.title ?? error.message;
    case 'http':
      return error.status !== null && error.status >= 500
        ? 'The service is temporarily unavailable. Please try again shortly.'
        : error.message;
    case 'invalid-response':
      return 'The API returned an unexpected response. Reload the page and try again.';
  }
}

/** Support reference (the API's request id) when the server provided one. */
export function ErrorReference({ error }: { error: ApiError }) {
  const requestId = error.problem?.requestId;
  if (!requestId) return null;
  return (
    <p className="error-reference">
      Reference: <code>{requestId}</code>
    </p>
  );
}
