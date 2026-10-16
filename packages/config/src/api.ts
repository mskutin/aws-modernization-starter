/**
 * API configuration (docs/contracts.md §3). Names are identical
 * locally and on ECS. Optional extras beyond the contract table are marked.
 */
import { z } from 'zod';
import {
  DatabaseCliEnvSchema,
  describeDbConfig,
  toDatabaseConfig,
  type DatabaseConfig,
} from './database.js';
import {
  awsRegion,
  httpUrl,
  parseEnv,
  port,
  tableName,
  type Env,
  type LogLevel,
} from './shared.js';
import { LOCAL_ONLY_MESSAGE, allowsLocalRelaxations } from './runtime.js';
import {
  AuthEnvShape,
  authConfig,
  describeAuthConfig,
  rateLimitConfig,
  refineAuthEnv,
  type AuthConfig,
  type RateLimitConfig,
} from './auth.js';

const STATE_MACHINE_ARN =
  /^arn:aws[a-z-]*:states:[a-z0-9-]+:\d{12}:stateMachine:[A-Za-z0-9_-]{1,80}$/;

const origin = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value;
  } catch {
    return false;
  }
}, 'must be an origin such as https://app.example.com (scheme://host[:port], no path or trailing slash)');

// DB_* (+ APP_RUNTIME, LOG_LEVEL, APP_*) and their refinements: database.ts.
export const ApiEnvSchema = DatabaseCliEnvSchema.safeExtend({
  PORT: port.default(8080),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  JOBS_TABLE_NAME: tableName,
  DYNAMODB_ENDPOINT: httpUrl.optional(),
  AWS_REGION: awsRegion,
  WORKFLOW_MODE: z.enum(['local', 'stepfunctions']).default('stepfunctions'),
  STATE_MACHINE_ARN: z
    .string()
    .regex(STATE_MACHINE_ARN, 'must be a Step Functions state machine ARN')
    .optional(),
  CORS_ALLOWED_ORIGINS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean),
    )
    .pipe(z.array(origin)),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(20_000),
  // Identity: AUTH_*, RATE_LIMIT_*, TRUST_PROXY_HOPS.
  ...AuthEnvShape,
}).superRefine((env, ctx) => {
  // The in-process simulation (and with it PROCESSOR_DB_* and the local reconciler loop) is a
  // local/CI tool; a deployed task must use Step Functions.
  if (env.WORKFLOW_MODE === 'local' && !allowsLocalRelaxations(env.APP_RUNTIME)) {
    ctx.addIssue({
      code: 'custom',
      path: ['WORKFLOW_MODE'],
      message: `"local" ${LOCAL_ONLY_MESSAGE}`,
    });
  }
  if (env.WORKFLOW_MODE === 'stepfunctions' && !env.STATE_MACHINE_ARN) {
    ctx.addIssue({
      code: 'custom',
      path: ['STATE_MACHINE_ARN'],
      message: 'is required when WORKFLOW_MODE=stepfunctions',
    });
  }
  refineAuthEnv(env, ctx);
});

export type WorkflowConfig = { mode: 'local' } | { mode: 'stepfunctions'; stateMachineArn: string };

export interface ApiConfig {
  port: number;
  logLevel: LogLevel;
  nodeEnv: 'development' | 'test' | 'production';
  appVersion: string;
  environment: string;
  db: DatabaseConfig;
  dynamodb: { tableName: string; region: string; endpoint?: string | undefined };
  workflow: WorkflowConfig;
  cors: { allowedOrigins: string[] };
  shutdownTimeoutMs: number;
  auth: AuthConfig;
  rateLimit: RateLimitConfig;
  trustProxyHops: number;
}

export function loadApiConfig(env: Env = process.env): ApiConfig {
  const e = parseEnv('API', ApiEnvSchema, env);
  return {
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    nodeEnv: e.NODE_ENV,
    appVersion: e.APP_VERSION,
    environment: e.APP_ENVIRONMENT ?? e.NODE_ENV,
    db: toDatabaseConfig(e),
    dynamodb: { tableName: e.JOBS_TABLE_NAME, region: e.AWS_REGION, endpoint: e.DYNAMODB_ENDPOINT },
    workflow:
      e.WORKFLOW_MODE === 'local'
        ? { mode: 'local' }
        : { mode: 'stepfunctions', stateMachineArn: e.STATE_MACHINE_ARN ?? '' },
    cors: { allowedOrigins: e.CORS_ALLOWED_ORIGINS },
    shutdownTimeoutMs: e.SHUTDOWN_TIMEOUT_MS,
    auth: authConfig(e),
    rateLimit: rateLimitConfig(e),
    trustProxyHops: e.TRUST_PROXY_HOPS,
  };
}

/** Loggable view of the configuration (no credentials). */
export function describeApiConfig(config: ApiConfig): Record<string, unknown> {
  return {
    port: config.port,
    logLevel: config.logLevel,
    nodeEnv: config.nodeEnv,
    environment: config.environment,
    appVersion: config.appVersion,
    db: describeDbConfig(config.db),
    dynamodb: config.dynamodb,
    workflow: config.workflow,
    cors: config.cors,
    shutdownTimeoutMs: config.shutdownTimeoutMs,
    auth: describeAuthConfig(config.auth),
    rateLimit: config.rateLimit,
    trustProxyHops: config.trustProxyHops,
  };
}
