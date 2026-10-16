/**
 * Workflow-side settings:
 * DynamoDB audit retention and the stale-job reconciler (ADR 0231).
 */
import { z } from 'zod';
import { LambdaEnvSchema, type LambdaConfig } from './lambda.js';
import { LOCAL_ONLY_MESSAGE, allowsLocalRelaxations, appRuntime } from './runtime.js';
import { parseEnv, type Env } from './shared.js';

/**
 * Lower bound of `RECONCILER_STALE_AFTER_SECONDS`: the workflow's execution timeout (600 s) plus a
 * 60 s grace period. Kept equal to `RECONCILIATION.minimumStaleAfterSeconds` of the workflow spec
 * (asserted by the reconciler's tests; `@starter/config` stays dependency-free).
 */
export const RECONCILER_MIN_STALE_AFTER_SECONDS = 660;

const STATE_MACHINE_ARN =
  /^arn:aws[a-z-]*:states:[a-z0-9-]+:\d{12}:stateMachine:[A-Za-z0-9_-]{1,80}$/;
const flag = z.enum(['true', 'false'], { error: 'must be "true" or "false"' });

/** `JOB_AUDIT_TTL_DAYS`: retention of STEP# audit items. Unset (default) = never expire. */
export const JobAuditEnvSchema = z.object({
  JOB_AUDIT_TTL_DAYS: z.coerce.number().int().min(1).max(3650).optional(),
});

export interface JobAuditConfig {
  /** Days until STEP# audit items expire (DynamoDB TTL); undefined = kept (default). */
  auditTtlDays: number | undefined;
}

export function loadJobAuditConfig(env: Env = process.env): JobAuditConfig {
  return { auditTtlDays: parseEnv('job audit', JobAuditEnvSchema, env).JOB_AUDIT_TTL_DAYS };
}

export const ReconcilerSettingsEnvSchema = z.object({
  /** A non-terminal job counts as stale when its last transition is older than this. */
  RECONCILER_STALE_AFTER_SECONDS: z.coerce
    .number()
    .int()
    .min(RECONCILER_MIN_STALE_AFTER_SECONDS, {
      message: `must be at least ${RECONCILER_MIN_STALE_AFTER_SECONDS} (execution timeout + grace)`,
    })
    .max(7 * 86_400)
    .default(900),
  /** Jobs examined per run, across all non-terminal statuses. */
  RECONCILER_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(25),
  /** Log and count the decisions without writing anything. */
  RECONCILER_DRY_RUN: flag.default('false'),
  /** Wall-clock budget of one run; no new job is examined after it. */
  RECONCILER_MAX_RUNTIME_SECONDS: z.coerce.number().int().min(5).max(840).default(45),
});

export interface ReconcilerSettings {
  staleAfterSeconds: number;
  batchSize: number;
  dryRun: boolean;
  maxRuntimeSeconds: number;
}

function toSettings(e: z.output<typeof ReconcilerSettingsEnvSchema>): ReconcilerSettings {
  return {
    staleAfterSeconds: e.RECONCILER_STALE_AFTER_SECONDS,
    batchSize: e.RECONCILER_BATCH_SIZE,
    dryRun: e.RECONCILER_DRY_RUN === 'true',
    maxRuntimeSeconds: e.RECONCILER_MAX_RUNTIME_SECONDS,
  };
}

export const ReconcilerLambdaEnvSchema = LambdaEnvSchema.extend({
  STATE_MACHINE_ARN: z
    .string()
    .regex(STATE_MACHINE_ARN, 'must be a Step Functions state machine ARN'),
}).extend(ReconcilerSettingsEnvSchema.shape);

export interface ReconcilerLambdaConfig extends LambdaConfig {
  stateMachineArn: string;
  reconciler: ReconcilerSettings;
}

/** The ONE scheduled reconciler Lambda on AWS (`functions/reconciler`, reserved concurrency 1). */
export function loadReconcilerLambdaConfig(env: Env = process.env): ReconcilerLambdaConfig {
  const e = parseEnv('reconciler Lambda', ReconcilerLambdaEnvSchema, env);
  return {
    tableName: e.JOBS_TABLE_NAME,
    region: e.AWS_REGION,
    endpoint: e.DYNAMODB_ENDPOINT,
    logLevel: e.LOG_LEVEL,
    appVersion: e.APP_VERSION,
    environment: e.APP_ENVIRONMENT,
    runtime: e.APP_RUNTIME,
    stateMachineArn: e.STATE_MACHINE_ARN,
    reconciler: toSettings(e),
  };
}

export const LocalReconcilerEnvSchema = ReconcilerSettingsEnvSchema.extend({
  /**
   * Run the reconciler inside the API process every N seconds against the LOCAL workflow
   * simulator. 0 (default) = disabled. Allowed only with `WORKFLOW_MODE=local` outside AWS: the
   * simulator's executions live in that one process, so the loop is correct for a single API
   * process only. On AWS the scheduled Lambda is the only reconciler.
   */
  RECONCILER_LOCAL_INTERVAL_SECONDS: z.coerce.number().int().min(0).max(86_400).default(0),
  WORKFLOW_MODE: z.enum(['local', 'stepfunctions']).default('stepfunctions'),
  APP_RUNTIME: appRuntime,
}).superRefine((env, ctx) => {
  if (env.RECONCILER_LOCAL_INTERVAL_SECONDS === 0) return;
  if (env.WORKFLOW_MODE !== 'local') {
    ctx.addIssue({
      code: 'custom',
      path: ['RECONCILER_LOCAL_INTERVAL_SECONDS'],
      message:
        'is only allowed with WORKFLOW_MODE=local (on AWS the scheduled reconciler Lambda is the only reconciler)',
    });
  }
  if (!allowsLocalRelaxations(env.APP_RUNTIME)) {
    ctx.addIssue({
      code: 'custom',
      path: ['RECONCILER_LOCAL_INTERVAL_SECONDS'],
      message: LOCAL_ONLY_MESSAGE,
    });
  }
});

export interface LocalReconcilerConfig extends ReconcilerSettings {
  /** 0 = disabled. */
  intervalSeconds: number;
}

/** The opt-in in-process loop of the API (`WORKFLOW_MODE=local` only). */
export function loadLocalReconcilerConfig(env: Env = process.env): LocalReconcilerConfig {
  const e = parseEnv('local reconciler', LocalReconcilerEnvSchema, env);
  return { ...toSettings(e), intervalSeconds: e.RECONCILER_LOCAL_INTERVAL_SECONDS };
}
