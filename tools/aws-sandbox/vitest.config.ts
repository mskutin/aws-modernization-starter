import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // The end-to-end tests run the built CLI with a fake `aws` and a fake guard as child processes.
    testTimeout: 60_000,
  },
});
