import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretValue, type DatabaseConfig } from '@starter/config';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DatabaseCredentialError,
  passwordProvider,
  rdsIamToken,
  type IamTokenGenerator,
} from '../../src/credentials.js';

const CANARY = 'canary-Pa55word-5e1d7b0c';
const base = {
  host: 'starter-dev-postgres.abc123.ap-southeast-1.rds.amazonaws.com',
  port: 5432,
  database: 'starterapp',
  user: 'starter_app',
  ssl: { mode: 'disable' },
  poolMax: 1,
} as const;

const config = (auth: DatabaseConfig['auth']): DatabaseConfig => ({ ...base, auth });

async function rejected(promise: Promise<unknown>): Promise<DatabaseCredentialError> {
  try {
    await promise;
  } catch (error) {
    return error as DatabaseCredentialError;
  }
  throw new Error('expected a rejection');
}

describe('password from the environment', () => {
  it('is handed to pg through a function, never as a stored string', async () => {
    const provider = passwordProvider(
      config({ mode: 'password', source: 'env', password: new SecretValue(CANARY) }),
    );
    expect(typeof provider).toBe('function');
    await expect(provider()).resolves.toBe(CANARY);
  });
});

describe('password file (rotation without restart)', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'starter-db-pwfile-'));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('re-reads the file for every new connection and strips one trailing newline', async () => {
    const path = join(dir, 'pw');
    const provider = passwordProvider(
      config({ mode: 'password', source: 'file', passwordFile: path }),
    );
    await writeFile(path, 'first-password-0001\n');
    await expect(provider()).resolves.toBe('first-password-0001');
    await writeFile(path, 'rotated-password-0002');
    await expect(provider()).resolves.toBe('rotated-password-0002');
  });

  it('missing or empty files fail with the path only', async () => {
    const missing = passwordProvider(
      config({ mode: 'password', source: 'file', passwordFile: join(dir, 'nope') }),
    );
    await expect(missing()).rejects.toThrow(
      new DatabaseCredentialError(`cannot read DB_PASSWORD_FILE ${join(dir, 'nope')} (ENOENT)`),
    );
    const empty = join(dir, 'empty');
    await writeFile(empty, '\n');
    await expect(
      passwordProvider(config({ mode: 'password', source: 'file', passwordFile: empty }))(),
    ).rejects.toThrow(/is empty/);
  });
});

describe('RDS IAM authentication', () => {
  it('generates a NEW token for every connection attempt (fake signer)', async () => {
    let issued = 0;
    const calls: Parameters<IamTokenGenerator>[0][] = [];
    const generator: IamTokenGenerator = async (target) => {
      calls.push(target);
      issued += 1;
      return `token-${issued}`;
    };
    const provider = passwordProvider(config({ mode: 'iam', region: 'ap-southeast-1' }), {
      iamTokenGenerator: generator,
    });
    expect(issued).toBe(0); // nothing is signed at start-up
    await expect(provider()).resolves.toBe('token-1');
    await expect(provider()).resolves.toBe('token-2');
    expect(calls).toEqual([
      { hostname: base.host, port: 5432, username: 'starter_app', region: 'ap-southeast-1' },
      { hostname: base.host, port: 5432, username: 'starter_app', region: 'ap-southeast-1' },
    ]);
  });

  it('a signing failure is a transient credential error without secrets', async () => {
    const provider = passwordProvider(config({ mode: 'iam', region: 'ap-southeast-1' }), {
      iamTokenGenerator: async () => {
        throw Object.assign(new Error(`no credentials ${CANARY}`), {
          name: 'CredentialsProviderError',
        });
      },
    });
    const error = await rejected(provider());
    expect(error).toBeInstanceOf(DatabaseCredentialError);
    expect(error.transient).toBe(true);
    expect(error.message).toBe(
      `could not generate an RDS IAM auth token for starter_app@${base.host}:5432 (CredentialsProviderError)`,
    );
  });

  it('the real signer works offline and presigns rds-db:connect for the role (15 min)', async () => {
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIAIOSFODNN7EXAMPLE');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', CANARY);
    vi.stubEnv('AWS_SESSION_TOKEN', '');
    try {
      const token = await rdsIamToken({
        hostname: base.host,
        port: 5432,
        username: 'starter_app',
        region: 'ap-southeast-1',
      });
      expect(token.startsWith(`${base.host}:5432/?`)).toBe(true);
      const query = new URLSearchParams(token.slice(token.indexOf('?') + 1));
      expect(query.get('Action')).toBe('connect');
      expect(query.get('DBUser')).toBe('starter_app');
      expect(query.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
      expect(query.get('X-Amz-Expires')).toBe('900');
      expect(query.get('X-Amz-Credential')).toMatch(
        /^AKIAIOSFODNN7EXAMPLE\/\d{8}\/ap-southeast-1\/rds-db\/aws4_request$/,
      );
      expect(token).not.toContain(CANARY);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('Secrets Manager (bootstrap task only)', () => {
  const arn =
    'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:starter-dev/rds/master-AbCdEf';
  const secretsConfig: DatabaseConfig = {
    ...config({ mode: 'secrets-manager', region: 'ap-southeast-1', secretArn: arn }),
    user: 'starteradmin',
  };

  it('reads the RDS secret format per connection and checks the user name', async () => {
    let reads = 0;
    const provider = passwordProvider(secretsConfig, {
      secretStringFetcher: async ({ secretArn, region }) => {
        reads += 1;
        expect({ secretArn, region }).toEqual({ secretArn: arn, region: 'ap-southeast-1' });
        return JSON.stringify({ engine: 'postgres', username: 'starteradmin', password: CANARY });
      },
    });
    await expect(provider()).resolves.toBe(CANARY);
    await expect(provider()).resolves.toBe(CANARY);
    expect(reads).toBe(2);
  });

  it.each([
    [
      'a different user',
      JSON.stringify({ username: 'someone', password: CANARY }),
      /does not match DB_USER/,
    ],
    ['no password', JSON.stringify({ username: 'starteradmin' }), /has no "password" field/],
    ['not JSON', `password=${CANARY}`, /is not a JSON object/],
  ])('refuses a secret with %s without echoing it', async (_name, secretString, message) => {
    const provider = passwordProvider(secretsConfig, {
      secretStringFetcher: async () => secretString,
    });
    const error = await rejected(provider());
    expect(error).toBeInstanceOf(DatabaseCredentialError);
    expect(error.message).toMatch(message);
    expect(error.message).not.toContain(CANARY);
    expect(error.transient).toBe(false);
  });

  it('a Secrets Manager outage is transient', async () => {
    const provider = passwordProvider(secretsConfig, {
      secretStringFetcher: async () => {
        throw Object.assign(new Error('throttled'), { name: 'ThrottlingException' });
      },
    });
    await expect(provider()).rejects.toMatchObject({ transient: true });
  });
});
