/** Lambda configuration (docs/contracts.md §4). */
import { z } from 'zod';
import { appRuntime, type AppRuntime } from './runtime.js';
import {
  awsRegion,
  httpUrl,
  logLevel,
  parseEnv,
  tableName,
  type Env,
  type LogLevel,
} from './shared.js';

export const LambdaEnvSchema = z.object({
  JOBS_TABLE_NAME: tableName,
  AWS_REGION: awsRegion,
  LOG_LEVEL: logLevel,
  DYNAMODB_ENDPOINT: httpUrl.optional(),
  APP_VERSION: z.string().max(128).default('unknown'),
  APP_ENVIRONMENT: z.string().max(64).default('unknown'),
  /** `aws` (default; never set by CDK) | `ci` | `local` — gates local-only relaxations. */
  APP_RUNTIME: appRuntime,
});

export interface LambdaConfig {
  tableName: string;
  region: string;
  endpoint?: string | undefined;
  logLevel: LogLevel;
  appVersion: string;
  environment: string;
  runtime: AppRuntime;
}

export function loadLambdaConfig(env: Env = process.env): LambdaConfig {
  const e = parseEnv('Lambda', LambdaEnvSchema, env);
  return {
    tableName: e.JOBS_TABLE_NAME,
    region: e.AWS_REGION,
    endpoint: e.DYNAMODB_ENDPOINT,
    logLevel: e.LOG_LEVEL,
    appVersion: e.APP_VERSION,
    environment: e.APP_ENVIRONMENT,
    runtime: e.APP_RUNTIME,
  };
}
