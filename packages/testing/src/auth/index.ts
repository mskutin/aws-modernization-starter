/**
 * TEST ONLY — `@starter/testing/auth` (also re-exported from `@starter/testing`).
 * In-process OIDC test issuer and negative-token helpers (ADR 0213).
 * Import from the `./auth` subpath when you must not load the rest of the package
 * (Testcontainers, pg), e.g. in the test IdP server bundle.
 */
export {
  INSUFFICIENT_SCOPE,
  NEGATIVE_TOKEN_CASES,
  OTHER_CLIENT,
  TEST_ISSUER_DEFAULTS,
  bearer,
  createTestIssuer,
  type MintOptions,
  type NegativeTokenCase,
  type PublicJwks,
  type TestIssuer,
  type TestIssuerOptions,
  type TestSigningAlgorithm,
} from './issuer.js';
export { startTestIssuer, type IssuerOutage, type StartedTestIssuer } from './server.js';
