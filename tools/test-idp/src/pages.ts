/**
 * HTML of the TEST-ONLY sign-in page. Every reflected value is escaped; the page carries a
 * strict CSP (no scripts; the one style block is allowed by its hash) and cannot be framed.
 */
import { createHash } from 'node:crypto';

export const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );

const STYLE = `body{font-family:system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem}
.banner{background:#b00020;color:#fff;padding:.75rem 1rem;font-weight:700}
button{display:block;width:100%;margin:.5rem 0;padding:.75rem;font-size:1rem;cursor:pointer}
.muted{color:#555;font-size:.875rem}`;

/** CSP for the HTML pages of the test IdP. */
export const PAGE_CSP = [
  "default-src 'none'",
  `style-src 'sha256-${createHash('sha256').update(STYLE).digest('base64')}'`,
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body>
<p class="banner" role="note">TEST ONLY identity provider — local development and CI. Never use it with real users or data.</p>
${body}
</body>
</html>`;
}

/** The sign-in page: one button per test user; the validated request is echoed as hidden fields. */
export function signInPage(fields: Record<string, string>, users: readonly string[]): string {
  const hidden = Object.entries(fields)
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
    )
    .join('\n');
  const buttons = users
    .map(
      (user) =>
        `<button type="submit" name="user" value="${escapeHtml(user)}">Sign in as ${escapeHtml(user)}</button>`,
    )
    .join('\n');
  return page(
    'Sign in — TEST IdP',
    `<h1>Sign in</h1>
<p class="muted">Client <code>${escapeHtml(fields.client_id ?? '')}</code> asks for <code>${escapeHtml(fields.scope ?? '')}</code>.</p>
<form method="post" action="/authorize">
${hidden}
${buttons}
</form>`,
  );
}

export function errorPage(message: string): string {
  return page('Error — TEST IdP', `<h1>Request rejected</h1><p>${escapeHtml(message)}</p>`);
}

export function signedOutPage(): string {
  return page('Signed out — TEST IdP', '<h1>Signed out</h1><p>You can close this window.</p>');
}
