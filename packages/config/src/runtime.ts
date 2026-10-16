/**
 * Where the process runs (`APP_RUNTIME`). Every relaxation that is acceptable on a developer
 * workstation or in a CI job — an `http:` test issuer, disabled database TLS, password
 * database authentication — is gated on this switch, never on `NODE_ENV`: local compose and
 * CI deliberately run the production build with `NODE_ENV=production`.
 *
 * Fail-safe default: unset means `aws`. CDK never sets the variable, so a deployed task or
 * Lambda always runs with the strict rules (a synth-time policy test asserts this).
 */
import { z } from 'zod';

export const APP_RUNTIMES = ['aws', 'ci', 'local'] as const;
export type AppRuntime = (typeof APP_RUNTIMES)[number];

/** zod field for `APP_RUNTIME`; add it to a component's environment schema. */
export const appRuntime = z.enum(APP_RUNTIMES).default('aws');

/** True only for `local` and `ci` — never for a deployed (`aws`) process. */
export function allowsLocalRelaxations(runtime: AppRuntime): boolean {
  return runtime !== 'aws';
}

/** Message for a refinement that rejects a relaxation outside local/CI runtimes. */
export const LOCAL_ONLY_MESSAGE = 'is only allowed when APP_RUNTIME is local or ci';
