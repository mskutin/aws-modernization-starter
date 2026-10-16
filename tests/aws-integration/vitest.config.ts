import { defineConfig } from 'vitest/config';

// Two projects:
//   unit : sweeper + helpers, AWS SDK mocked — always runs, no credentials needed.
//   aws  : real AWS mini-stack tests — skip with an explicit reason unless
//          AWS_INTEGRATION_ENABLED=true and credentials resolve (see src/aws-gate.ts).
export default defineConfig({
  test: {
    reporters: ['default', 'junit'],
    outputFile: { junit: '../../reports/junit/aws-integration.xml' },
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.aws.test.ts'],
        },
      },
      {
        test: {
          name: 'aws',
          include: ['src/**/*.aws.test.ts'],
          testTimeout: 300_000,
          hookTimeout: 120_000,
          // One mini-stack per run: keep executions sequential and readable.
          fileParallelism: false,
        },
      },
    ],
  },
});
