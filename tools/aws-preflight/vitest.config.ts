import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // The end-to-end tests run the CLI (and a fake `aws`) as child processes.
    testTimeout: 60_000,
  },
});
