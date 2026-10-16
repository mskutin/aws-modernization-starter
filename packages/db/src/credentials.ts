/**
 * Per-connection credentials (ADR 0221). `pg` calls the password function for every NEW
 * physical connection; established connections are never re-authenticated. That single hook
 * gives every mode the same rotation behaviour:
 *
 * - `iam` (API, migrator, retention job, Lambdas on AWS): a fresh RDS IAM authentication token per
 *   connection (SigV4 presigned, valid 15 minutes for establishing a connection), signed with the
 *   task/Lambda role credentials, which the AWS SDK refreshes itself. A token is NEVER created
 *   once at start-up. NOT validated against AWS.
 * - `secrets-manager` (one-off bootstrap task only): the RDS-managed master secret is read when the
 *   connection is opened, so a rotated master password is always current. NOT validated on AWS.
 * - `password` + `DB_PASSWORD` (local/CI): a fixed value for the process lifetime.
 * - `password` + `DB_PASSWORD_FILE` (local/CI): the file is re-read for each new connection, so a
 *   rotated password is used without a restart while existing sessions keep working until they
 *   are recycled (`maxLifetimeSeconds`). Tested against a real PostgreSQL.
 *
 * Providers never log or embed a secret in an error message.
 */
import { readFile } from 'node:fs/promises';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { Signer } from '@aws-sdk/rds-signer';
import type { DatabaseConfig } from '@starter/config';

/** Resolves the password (or IAM token) for one new connection. */
export type PasswordProvider = () => Promise<string>;

/** Generates an RDS IAM auth token (injectable for tests). */
export type IamTokenGenerator = (target: {
  hostname: string;
  port: number;
  username: string;
  region: string;
}) => Promise<string>;

/** Returns the `SecretString` of a Secrets Manager secret (injectable for tests). */
export type SecretStringFetcher = (target: {
  secretArn: string;
  region: string;
}) => Promise<string>;

export class DatabaseCredentialError extends Error {
  override readonly name = 'DatabaseCredentialError';
  /** True when retrying later can succeed (credential service hiccup), false for configuration errors. */
  readonly transient: boolean;

  constructor(message: string, options: { cause?: unknown; transient?: boolean } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.transient = options.transient ?? false;
  }
}

/** Default IAM token generator: `@aws-sdk/rds-signer` with the default credential chain. */
export const rdsIamToken: IamTokenGenerator = async (target) =>
  new Signer({
    hostname: target.hostname,
    port: target.port,
    username: target.username,
    region: target.region,
  }).getAuthToken();

/** Default secret reader: one GetSecretValue call (the bootstrap opens one connection). */
export const secretsManagerSecretString: SecretStringFetcher = async ({ secretArn, region }) => {
  const client = new SecretsManagerClient({ region, maxAttempts: 3 });
  try {
    const output = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
    if (!output.SecretString) {
      throw new DatabaseCredentialError(`secret ${secretArn} has no SecretString`);
    }
    return output.SecretString;
  } finally {
    client.destroy();
  }
};

/** Strips one trailing newline (files written by editors/`echo`); everything else is kept. */
function fromFile(content: string): string {
  return content.replace(/\r?\n$/, '');
}

export interface PasswordProviderOptions {
  /** Override the IAM token generator (unit tests; never needed at runtime). */
  iamTokenGenerator?: IamTokenGenerator;
  /** Override the Secrets Manager reader (unit tests; never needed at runtime). */
  secretStringFetcher?: SecretStringFetcher;
}

function passwordFromSecretString(secretString: string, user: string, secretArn: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(secretString);
  } catch {
    throw new DatabaseCredentialError(`secret ${secretArn} is not a JSON object`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new DatabaseCredentialError(`secret ${secretArn} is not a JSON object`);
  }
  const { username, password } = parsed as { username?: unknown; password?: unknown };
  if (typeof password !== 'string' || password.length === 0) {
    throw new DatabaseCredentialError(`secret ${secretArn} has no "password" field`);
  }
  if (username !== undefined && username !== user) {
    throw new DatabaseCredentialError(
      `the "username" of secret ${secretArn} does not match DB_USER ${user}`,
    );
  }
  return password;
}

export function passwordProvider(
  config: DatabaseConfig,
  options: PasswordProviderOptions = {},
): PasswordProvider {
  const { auth } = config;
  switch (auth.mode) {
    case 'iam': {
      const generate = options.iamTokenGenerator ?? rdsIamToken;
      const target = {
        hostname: config.host,
        port: config.port,
        username: config.user,
        region: auth.region,
      };
      return async () => {
        try {
          return await generate(target);
        } catch (error) {
          throw new DatabaseCredentialError(
            `could not generate an RDS IAM auth token for ${config.user}@${config.host}:${config.port} (${(error as Error).name})`,
            { cause: error, transient: true },
          );
        }
      };
    }
    case 'secrets-manager': {
      const readSecretString = options.secretStringFetcher ?? secretsManagerSecretString;
      return async () => {
        let secretString: string;
        try {
          secretString = await readSecretString({ secretArn: auth.secretArn, region: auth.region });
        } catch (error) {
          if (error instanceof DatabaseCredentialError) throw error;
          throw new DatabaseCredentialError(
            `could not read secret ${auth.secretArn} (${(error as Error).name})`,
            { cause: error, transient: true },
          );
        }
        return passwordFromSecretString(secretString, config.user, auth.secretArn);
      };
    }
    case 'password':
      if (auth.source === 'file') {
        const path = auth.passwordFile;
        return async () => {
          let content: string;
          try {
            content = await readFile(path, 'utf8');
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code ?? 'read error';
            throw new DatabaseCredentialError(`cannot read DB_PASSWORD_FILE ${path} (${code})`);
          }
          const password = fromFile(content);
          if (password.length === 0) {
            throw new DatabaseCredentialError(`DB_PASSWORD_FILE ${path} is empty`);
          }
          return password;
        };
      }
      return async () => auth.password.reveal();
  }
}
