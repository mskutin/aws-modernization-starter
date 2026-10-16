/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Optional API base URL. Default: same origin, requests go to `/v1/...`.
   * Accepts an absolute http(s) URL or an absolute path, with or without the
   * trailing `/v1` (e.g. `https://api.example.com` or `https://api.example.com/v1`).
   */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
