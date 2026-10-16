import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import {
  APP_RUNTIMES,
  ConfigError,
  LOCAL_ONLY_MESSAGE,
  allowsLocalRelaxations,
  appRuntime,
} from '../src/index.js';
import { parseEnv } from '../src/shared.js';

/** A component schema that accepts a relaxation only outside AWS, as the API/Lambdas do. */
const Schema = z
  .object({ APP_RUNTIME: appRuntime, RELAXED: z.enum(['true', 'false']).default('false') })
  .superRefine((env, ctx) => {
    if (env.RELAXED === 'true' && !allowsLocalRelaxations(env.APP_RUNTIME)) {
      ctx.addIssue({ code: 'custom', path: ['RELAXED'], message: LOCAL_ONLY_MESSAGE });
    }
  });

describe('APP_RUNTIME', () => {
  it('defaults to aws (fail-safe) when unset or empty', () => {
    expect(parseEnv('test', Schema, {}).APP_RUNTIME).toBe('aws');
    expect(parseEnv('test', Schema, { APP_RUNTIME: '' }).APP_RUNTIME).toBe('aws');
  });

  it('accepts only aws, ci and local', () => {
    expect([...APP_RUNTIMES]).toEqual(['aws', 'ci', 'local']);
    expect(() => parseEnv('test', Schema, { APP_RUNTIME: 'production' })).toThrow(ConfigError);
    expect(() => parseEnv('test', Schema, { APP_RUNTIME: 'LOCAL' })).toThrow(ConfigError);
  });

  it('allows local relaxations only for ci and local', () => {
    expect(allowsLocalRelaxations('aws')).toBe(false);
    expect(allowsLocalRelaxations('ci')).toBe(true);
    expect(allowsLocalRelaxations('local')).toBe(true);
  });

  it('rejects a relaxation on aws, including the default', () => {
    for (const env of [{ RELAXED: 'true' }, { RELAXED: 'true', APP_RUNTIME: 'aws' }]) {
      expect(() => parseEnv('test', Schema, env)).toThrow(`RELAXED: ${LOCAL_ONLY_MESSAGE}`);
    }
    expect(parseEnv('test', Schema, { RELAXED: 'true', APP_RUNTIME: 'ci' }).RELAXED).toBe('true');
  });
});
