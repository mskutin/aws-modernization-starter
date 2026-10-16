/**
 * pino logger factory with consistent base fields and secret/PII redaction.
 * JSON to stdout only — CloudWatch (ECS awslogs / Lambda) collects it.
 */
import { pino, type DestinationStream, type Level, type Logger, type LoggerOptions } from 'pino';

export type { Logger } from 'pino';
export type LogLevel = Level | 'silent';

/**
 * Paths censored in every log line. pino wildcards match one level, so common
 * nestings are listed explicitly. The submitted document (`content` and its
 * `title`) is treated as personal data and never logged.
 */
export const DEFAULT_REDACT_PATHS: readonly string[] = [
  'password',
  '*.password',
  'DB_PASSWORD',
  '*.DB_PASSWORD',
  'secret',
  '*.secret',
  'token',
  '*.token',
  'accessKeyId',
  'secretAccessKey',
  'sessionToken',
  '*.accessKeyId',
  '*.secretAccessKey',
  '*.sessionToken',
  'authorization',
  '*.authorization',
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  'content',
  '*.content',
  'payload.content',
  '*.payload.content',
  'body.content',
  'request.content',
  'title',
  '*.title',
  'payload.title',
  '*.payload.title',
  'body.title',
  'request.title',
  'document',
  '*.document',
  // PostgreSQL errors: `detail` can quote row values ("Failing row contains (...)"), and pg-pool
  // attaches the idle client (connection parameters, cancel key) as `client`. A `cause` is folded
  // into `err.message`/`err.stack` by pino's serializer, so its own fields never reach the line.
  'err.detail',
  'err.client',
];

/**
 * Extra paths for everything that handles documents or their analysis (workflow steps, the
 * local simulation, the reconciler): derived results and the pre-2.0 execution payload.
 * Defence in depth — that code never logs these fields on purpose.
 */
export const WORKFLOW_REDACT_PATHS: readonly string[] = [
  'payload',
  '*.payload',
  'result',
  '*.result',
  'resultJson',
  '*.resultJson',
  'topTerms',
  '*.topTerms',
];

export const REDACTED = '[REDACTED]';

export interface CreateLoggerOptions {
  service: string;
  version?: string | undefined;
  environment?: string | undefined;
  level?: LogLevel | undefined;
  /** Extra paths to censor in addition to `DEFAULT_REDACT_PATHS`. */
  redact?: readonly string[] | undefined;
  /** Synchronous stdout writes (use in Lambda so lines are flushed before freeze). */
  sync?: boolean | undefined;
  /** Test hook: write to a custom stream. */
  destination?: DestinationStream | undefined;
}

export function loggerOptions(options: CreateLoggerOptions): LoggerOptions {
  return {
    level: options.level ?? 'info',
    base: {
      service: options.service,
      version: options.version ?? 'unknown',
      env: options.environment ?? 'unknown',
    },
    messageKey: 'msg',
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    redact: { paths: [...DEFAULT_REDACT_PATHS, ...(options.redact ?? [])], censor: REDACTED },
  };
}

export function createLogger(options: CreateLoggerOptions): Logger {
  const destination =
    options.destination ?? pino.destination({ dest: 1, sync: options.sync ?? false });
  return pino(loggerOptions(options), destination);
}

/**
 * Child logger censoring `DEFAULT_REDACT_PATHS` plus `extraPaths`. A pino child given its own
 * `redact` option REPLACES the parent's paths, so the defaults are always passed again.
 */
export function childWithRedaction(
  logger: Logger,
  bindings: Record<string, unknown>,
  extraPaths: readonly string[],
): Logger {
  return logger.child(bindings, {
    redact: { paths: [...DEFAULT_REDACT_PATHS, ...extraPaths], censor: REDACTED },
  });
}
