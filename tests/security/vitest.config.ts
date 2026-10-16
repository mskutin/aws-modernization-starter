import { defineConfig } from 'vitest/config';

// Projects
//   unit     : pure tests of the suite's own tools (scanner, canaries, proxy, control server); no
//              network beyond 127.0.0.1, no containers. Part of the root `pnpm test`.
//   security : the black-box security suite, ONLY defined when SECTEST_MODE is set (so editor
//              runs and `vitest related` hooks never start its harness):
//                SECTEST_MODE=self      (test:integration) starts its own API processes, issuer,
//                                       proxies and fake Step Functions against PostgreSQL and
//                                       DynamoDB Local (CI services or Testcontainers);
//                SECTEST_MODE=external  (test:security) runs against API_BASE_URL / WEB_BASE_URL
//                                       with tokens from the test IdP (TEST_IDP_URL).
const security = process.env['SECTEST_MODE']
  ? [
      {
        extends: true as const,
        test: {
          name: 'security',
          include: ['src/suites/**/*.test.ts'],
          globalSetup: ['./src/harness/global-setup.ts'],
          testTimeout: 120_000,
          hookTimeout: 240_000,
        },
      },
    ]
  : [];

export default defineConfig({
  test: {
    reporters: ['default', 'junit'],
    outputFile: { junit: '../../reports/junit/security.xml' },
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['src/unit/**/*.test.ts'], testTimeout: 20_000 },
      },
      ...security,
    ],
  },
});
