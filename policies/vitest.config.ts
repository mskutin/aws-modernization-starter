import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Skip CDK's built-in CloudFormation Validate plugin in unit tests (slow WASM init);
    // the baseline pack and Guard are exercised explicitly.
    env: { CDK_VALIDATION: 'false' },
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
