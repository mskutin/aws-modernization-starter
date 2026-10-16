import { defineConfig } from 'vitest/config';

// Projects
//   api       : black-box API + direct store assertions. Safe to run in parallel against a shared
//               API (every submission carries a unique nonce). Runs locally and in CI.
//   outage    : LOCAL ONLY — stops/starts the PostgreSQL container through the Podman/Docker API to
//               prove readiness semantics. Skips with a reason unless LOCAL_CONTAINER_CONTROL=true.
//               Never run concurrently with `api` (it takes the database away).
//   local-env : the local-environment scripts (scripts/podman, scripts/git-hooks, local/compose/bin)
//               with stub tools and a fake Podman API — no containers, no stack, no network.
//               `pnpm --filter @starter/tests-integration test`.
const stackSetup = ['./src/support/global-setup.ts'];

export default defineConfig({
  test: {
    reporters: ['default', 'junit'],
    outputFile: { junit: '../../reports/junit/integration.xml' },
    testTimeout: 60_000,
    hookTimeout: 60_000,
    projects: [
      {
        extends: true,
        test: {
          name: 'api',
          globalSetup: stackSetup,
          include: ['src/api/**/*.test.ts', 'src/negative/**/*.test.ts'],
          exclude: ['src/**/*.outage.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'outage',
          globalSetup: stackSetup,
          include: ['src/**/*.outage.test.ts'],
          fileParallelism: false,
          testTimeout: 180_000,
          hookTimeout: 180_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'local-env',
          include: ['src/local-env/**/*.test.ts'],
        },
      },
    ],
  },
});
