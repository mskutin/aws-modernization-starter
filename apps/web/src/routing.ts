/**
 * Minimal hash router: `#/` (home) and `#/jobs/<uuid>` (job detail). Hash
 * routing works from any static host (S3/CloudFront) without rewrite rules.
 */
import { JobIdSchema } from '@starter/contracts';
import { useSyncExternalStore } from 'react';

export type Route =
  { name: 'home' } | { name: 'job'; jobId: string } | { name: 'not-found'; path: string };

export const HOME_HREF = '#/';

export function jobHref(jobId: string): string {
  return `#/jobs/${encodeURIComponent(jobId)}`;
}

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, '') || '/';
  if (path === '/') return { name: 'home' };
  const match = /^\/jobs\/([^/?#]+)\/?$/.exec(path);
  if (match) {
    let jobId: string;
    try {
      jobId = decodeURIComponent(match[1]!);
    } catch {
      return { name: 'not-found', path };
    }
    if (JobIdSchema.safeParse(jobId).success) return { name: 'job', jobId };
  }
  return { name: 'not-found', path };
}

/** Stable string identity of a route (for effects keyed on navigation). */
export function routeKey(route: Route): string {
  switch (route.name) {
    case 'home':
      return 'home';
    case 'job':
      return `job:${route.jobId}`;
    case 'not-found':
      return `not-found:${route.path}`;
  }
}

export function navigate(href: string): void {
  window.location.hash = href.startsWith('#') ? href.slice(1) : href;
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

const getHash = () => window.location.hash;
const getServerHash = () => '';

export function useHashRoute(): Route {
  return parseRoute(useSyncExternalStore(subscribe, getHash, getServerHash));
}
