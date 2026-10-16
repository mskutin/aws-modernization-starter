import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin, type PreviewServer, type ViteDevServer } from 'vite';

/**
 * Local API target for the dev/preview proxy (docs/contracts.md §5).
 * `API_PROXY_TARGET` may point elsewhere (e.g. a containerised API in E2E).
 */
const apiTarget = process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:8080';

const proxy = {
  '/v1': { target: apiTarget, changeOrigin: false },
  '/health': { target: apiTarget, changeOrigin: false },
};

/**
 * `/config.json` for the dev and preview servers (identity): the SPA's runtime auth
 * configuration from SPA_AUTH_* env, defaulting to the local TEST ONLY IdP. Served by middleware
 * only — never written into dist/, so a deployment can never ship a development configuration.
 */
function runtimeConfig(): Plugin {
  const body = JSON.stringify({
    auth: {
      issuer: process.env.SPA_AUTH_ISSUER ?? 'http://127.0.0.1:9400',
      clientId: process.env.SPA_AUTH_CLIENT_ID ?? 'starter-web-local',
      scope: process.env.SPA_AUTH_SCOPE ?? 'openid jobs:read jobs:write',
    },
  });
  const serve = (server: ViteDevServer | PreviewServer) => {
    server.middlewares.use((req, res, next) => {
      if (req.url !== '/config.json') return next();
      res.setHeader('content-type', 'application/json');
      res.setHeader('cache-control', 'no-store');
      res.end(body);
    });
  };
  return { name: 'starter-runtime-config', configureServer: serve, configurePreviewServer: serve };
}

export default defineConfig({
  // Unit tests (vitest) need no dev-server middleware.
  plugins: [react(), ...(process.env.VITEST ? [] : [runtimeConfig()])],
  server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true, proxy },
  build: { outDir: 'dist', sourcemap: true, target: 'es2022' },
});
