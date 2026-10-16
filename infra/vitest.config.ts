import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Synthesizing full stages (with esbuild bundling) takes a few seconds each.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: 'forks',
  },
});
