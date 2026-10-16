import { z } from 'zod';
import { DEFAULT_AWS_REGION, isAwsRegionSyntax } from './region.js';

export type Env = Record<string, string | undefined>;

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const logLevel = z.enum(LOG_LEVELS).default('info');
export const port = z.coerce.number().int().min(1).max(65_535);
export const nonEmpty = z.string().trim().min(1, 'must not be empty');
/** Runtime region (set by AWS): region-name syntax of any partition (`./region.ts`). */
export const awsRegion = z
  .string()
  .refine(isAwsRegionSyntax, `must be an AWS region such as ${DEFAULT_AWS_REGION}`);
/** DynamoDB table-name rules. */
export const tableName = z
  .string()
  .regex(/^[A-Za-z0-9_.-]{3,255}$/, 'must be a valid DynamoDB table name');
export const httpUrl = z.url({ protocol: /^https?$/, error: 'must be an http(s) URL' });

/** Thrown when the environment is invalid. Lists variable names, never values. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
  constructor(
    readonly component: string,
    readonly issues: readonly { variable: string; message: string }[],
  ) {
    super(
      `Invalid ${component} configuration:\n${issues
        .map((i) => `  - ${i.variable}: ${i.message}`)
        .join('\n')}`,
    );
  }
}

/** Treat empty strings as "unset" so `FOO=` behaves like an absent variable. */
export function withoutEmpty(env: Env): Env {
  return Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
}

export function parseEnv<S extends z.ZodType>(component: string, schema: S, env: Env): z.output<S> {
  const result = schema.safeParse(withoutEmpty(env));
  if (!result.success) {
    throw new ConfigError(
      component,
      result.error.issues.map((issue) => {
        const [variable, ...rest] = issue.path.map(String);
        // zod's default "expected string, received undefined" is unclear for env vars.
        const message =
          issue.code === 'invalid_type' && issue.input === undefined
            ? 'is required'
            : issue.message;
        return {
          variable: variable ?? '(root)',
          message: rest.length > 0 ? `entry ${rest.join('.')}: ${message}` : message,
        };
      }),
    );
  }
  return result.data;
}
