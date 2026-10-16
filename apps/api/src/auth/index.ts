export { registerAuthentication, requirePrincipal, type AuthDeps } from './hooks.js';
export {
  AuthUnavailableError,
  RemoteJwksSource,
  StaticKeySource,
  type KeySet,
  type KeySource,
  type RemoteJwksOptions,
} from './key-source.js';
export { createPrincipal, scopesFromClaims, type Principal } from './principal.js';
export { FixedWindowRateLimiter, clientAddressKey, type RateLimitDecision } from './rate-limit.js';
export {
  TokenVerifier,
  type AuthFailureReason,
  type TokenVerifierOptions,
  type VerificationResult,
} from './verifier.js';
