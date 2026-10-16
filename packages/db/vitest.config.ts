import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
        },
      },
      {
        // PostgreSQL from TEST_DB_* (CI service) or Testcontainers (local). Runs in CI.
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          exclude: ['test/integration/**/*.containers.test.ts'],
          globalSetup: ['test/integration/global-setup.ts'],
          testTimeout: 60_000,
          hookTimeout: 180_000,
          fileParallelism: false,
        },
      },
      {
        // LOCAL ONLY (needs a container runtime; CI jobs have no socket): each suite starts its own
        // PostgreSQL container — PostgreSQL's own TLS stack (the CI suite uses the TLS proxy) and a
        // cluster whose bootstrap superuser is starter_app (legacy local volumes).
        test: {
          name: 'containers',
          include: ['test/integration/**/*.containers.test.ts'],
          testTimeout: 60_000,
          hookTimeout: 180_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
