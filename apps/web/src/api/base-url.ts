/** API version prefix the SPA speaks (contract v1). */
export const API_VERSION_PREFIX = '/v1';

/**
 * Resolves the API base URL (always ending in `/v1`, no trailing slash).
 * Empty/unset → same origin (`/v1`). Invalid values fall back to the default
 * with a console warning rather than breaking the whole page.
 */
export function resolveApiBase(configured: string | undefined): string {
  const value = configured?.trim() ?? '';
  if (value === '') return API_VERSION_PREFIX;

  const isAbsoluteUrl = /^https?:\/\/[^/\s]+/i.test(value);
  const isAbsolutePath = value.startsWith('/') && !value.startsWith('//');
  if (!isAbsoluteUrl && !isAbsolutePath) {
    console.warn(
      `Ignoring invalid VITE_API_BASE_URL (expected an http(s) URL or an absolute path); using ${API_VERSION_PREFIX}`,
    );
    return API_VERSION_PREFIX;
  }

  const trimmed = value.replace(/\/+$/, '');
  return trimmed.endsWith(API_VERSION_PREFIX) ? trimmed : `${trimmed}${API_VERSION_PREFIX}`;
}

export function apiBaseFromEnv(env: ImportMetaEnv = import.meta.env): string {
  return resolveApiBase(env.VITE_API_BASE_URL);
}
