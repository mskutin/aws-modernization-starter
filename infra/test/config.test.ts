import { ASYMMETRIC_JWS_ALGORITHMS } from '@starter/config';
import { describe, expect, it } from 'vitest';
import { devSandboxFoundation } from '../environments/dev.js';
import { placeholderImportedFoundation } from '../environments/placeholders.js';
import {
  AUTH_ALGORITHMS,
  ConfigValidationError,
  ENVIRONMENT_NAMES,
  PLACEHOLDER_ACCOUNT_ID,
  RAW_ENVIRONMENT_CONFIGS,
  PLACEHOLDER_PREFIX_LIST_ID,
  REQUIRED_TAG_KEYS,
  knownCloudFrontOriginFacingPrefixListId,
  loadEnvironmentConfig,
  parseEnvironmentConfig,
  resolveConfigOverrides,
  type EnvironmentConfigInput,
} from '../environments/index.js';

const clone = (name: 'dev' | 'staging' | 'prod'): EnvironmentConfigInput =>
  structuredClone(RAW_ENVIRONMENT_CONFIGS[name]);

/** Mutates a deep clone of `name`'s raw config and returns the parse error message. */
function errorFor(
  name: 'dev' | 'staging' | 'prod',
  mutate: (c: Record<string, unknown> & EnvironmentConfigInput) => void,
): string {
  const raw = clone(name) as Record<string, unknown> & EnvironmentConfigInput;
  mutate(raw);
  try {
    parseEnvironmentConfig(name, raw);
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigValidationError);
    return (err as Error).message;
  }
  throw new Error('expected the config to be rejected');
}

describe('environment configs', () => {
  it.each(ENVIRONMENT_NAMES)('%s parses and targets ap-southeast-1', (name) => {
    const cfg = loadEnvironmentConfig(name);
    expect(cfg.region).toBe('ap-southeast-1');
    expect(cfg.name).toBe(name);
    expect(Object.keys(cfg.tags).sort()).toEqual([...REQUIRED_TAG_KEYS].sort());
  });

  it('committed account ids are clearly marked placeholders', () => {
    for (const name of ENVIRONMENT_NAMES) {
      expect(loadEnvironmentConfig(name).account).toBe(PLACEHOLDER_ACCOUNT_ID);
    }
  });

  it('staging and prod import the landing-zone foundation; prod is hardened', () => {
    for (const name of ['staging', 'prod'] as const) {
      const cfg = loadEnvironmentConfig(name);
      expect(cfg.foundation.mode).toBe('import');
      expect(cfg.database.deletionProtection).toBe(true);
      expect(cfg.database.removalPolicy).toBe('retain');
      expect(cfg.jobTable.removalPolicy).toBe('retain');
      expect(cfg.foundation.edge.wafWebAclArn).toBeDefined();
    }
    const prod = loadEnvironmentConfig('prod');
    expect(prod.database.multiAz).toBe(true);
    expect(prod.api.minCapacity).toBeGreaterThanOrEqual(2);
    expect(prod.observability.logRetentionDays).toBeGreaterThanOrEqual(365);
  });

  it('environments differ only in data: identical key sets', () => {
    const keys = (o: object): string[] =>
      Object.entries(o)
        .flatMap(([k, v]) =>
          v && typeof v === 'object' && !Array.isArray(v) && k !== 'foundation' && k !== 'tags'
            ? keys(v).map((s) => `${k}.${s}`)
            : [k],
        )
        .sort();
    const [dev, staging, prod] = ENVIRONMENT_NAMES.map((n) => keys(loadEnvironmentConfig(n)));
    expect(staging).toEqual(dev);
    expect(prod).toEqual(dev);
  });
});

describe('config validation (negative cases)', () => {
  it('rejects the sandbox foundation outside dev with a clear message', () => {
    expect(() => loadEnvironmentConfig('prod', { foundationMode: 'sandbox' })).toThrow(
      /Invalid configuration for environment "prod":[\s\S]*foundation\.mode: prod must import landing-zone foundation resources/,
    );
    expect(() => loadEnvironmentConfig('staging', { foundationMode: 'sandbox' })).toThrow(
      ConfigValidationError,
    );
    expect(loadEnvironmentConfig('dev', { foundationMode: 'sandbox' }).foundation.mode).toBe(
      'sandbox',
    );
  });

  it('rejects malformed account ids', () => {
    expect(() => loadEnvironmentConfig('dev', { account: '1234' })).toThrow(
      /account: must be a 12-digit AWS account ID/,
    );
  });

  it('rejects a region the committed region-specific values do not belong to', () => {
    const msg = errorFor('dev', (c) => Object.assign(c, { region: 'us-east-1' }));
    expect(msg).toMatch(/foundation\.vpc\.appSubnets: subnets must be in us-east-1/);
    expect(msg).toMatch(/foundation\.vpc\.dataSubnets: subnets must be in us-east-1/);
    expect(msg).toMatch(/foundation\.kms\.dataKeyArn: must be a KMS key in us-east-1/);
    expect(msg).toMatch(/foundation\.kms\.logsKeyArn: must be a KMS key in us-east-1/);
    expect(msg).toMatch(
      /foundation\.edge\.albCertificateArn: ALB certificate must be in us-east-1/,
    );
  });

  it.each([
    ['Nowhere', /region: must be an AWS region such as ap-southeast-1/],
    ['ap-southeast-1a', /region: must be an AWS region/],
    ['cn-north-1', /region: Unsupported region=cn-north-1: it belongs to the aws-cn partition/],
    ['us-gov-west-1', /region: Unsupported region=us-gov-west-1: .*aws-us-gov partition/],
  ])('rejects the region %s', (region, message) => {
    expect(errorFor('dev', (c) => Object.assign(c, { region }))).toMatch(message);
  });

  it('rejects sandbox-foundation AZs of another region', () => {
    const msg = errorFor('dev', (c) => {
      c.foundation = {
        ...structuredClone(devSandboxFoundation),
        availabilityZones: ['eu-west-1a', 'eu-west-1b'],
      };
    });
    expect(msg).toMatch(
      /foundation\.availabilityZones: must be availability zones of ap-southeast-1/,
    );
  });

  it('rejects prod without deletion protection / RETAIN / Multi-AZ', () => {
    const msg = errorFor('prod', (c) => {
      c.database.deletionProtection = false;
      c.database.removalPolicy = 'snapshot';
      c.database.multiAz = false;
      c.jobTable.deletionProtection = false;
      c.jobTable.removalPolicy = 'destroy';
    });
    expect(msg).toMatch(/database\.deletionProtection: prod requires RDS deletion protection/);
    expect(msg).toMatch(/database\.removalPolicy: prod requires "retain"/);
    expect(msg).toMatch(/database\.multiAz: prod requires Multi-AZ RDS/);
    expect(msg).toMatch(/jobTable\.deletionProtection/);
    expect(msg).toMatch(/jobTable\.removalPolicy/);
  });

  it('rejects a CloudFront certificate outside us-east-1', () => {
    const msg = errorFor('staging', (c) => {
      c.foundation.edge.cloudFrontCertificateArn = c.foundation.edge.albCertificateArn;
    });
    expect(msg).toMatch(
      /cloudFrontCertificateArn: CloudFront certificates must be issued in us-east-1/,
    );
  });

  it('rejects an ALB certificate from another region', () => {
    const msg = errorFor('dev', (c) => {
      c.foundation.edge.albCertificateArn = String(c.foundation.edge.albCertificateArn).replace(
        'ap-southeast-1',
        'us-west-2',
      );
    });
    expect(msg).toMatch(/albCertificateArn: ALB certificate must be in ap-southeast-1/);
  });

  it('requires a WAF web ACL in staging and prod', () => {
    expect(
      errorFor('prod', (c) => {
        delete c.foundation.edge.wafWebAclArn;
      }),
    ).toMatch(/wafWebAclArn: prod requires a CLOUDFRONT-scope WAF web ACL/);
  });

  it('rejects missing, extra or mismatched tags', () => {
    expect(
      errorFor('dev', (c) => {
        delete (c.tags as Partial<typeof c.tags>).CostCentre;
      }),
    ).toMatch(/tags\.CostCentre/);
    expect(
      errorFor('dev', (c) => {
        (c.tags as Record<string, string>).Team = 'x';
      }),
    ).toMatch(/tags/);
    expect(
      errorFor('dev', (c) => {
        c.tags.Environment = 'prod';
      }),
    ).toMatch(/tags\.Environment: must equal the environment name "dev"/);
  });

  it('rejects subnets that do not span the same AZs or repeat an AZ', () => {
    const msg = errorFor('prod', (c) => {
      if (c.foundation.mode !== 'import') throw new Error('expected import');
      c.foundation.vpc.dataSubnets = c.foundation.vpc.dataSubnets.slice(0, 2);
      c.foundation.vpc.appSubnets[1]!.availabilityZone = 'ap-southeast-1a';
    });
    expect(msg).toMatch(/appSubnets: must contain exactly one subnet per availability zone/);
    expect(msg).toMatch(/dataSubnets: app and data subnets must span the same AZs/);
  });

  it('rejects inconsistent capacity and invalid log retention', () => {
    const msg = errorFor('dev', (c) => {
      c.api.desiredCount = 10;
      c.observability.logRetentionDays = 42;
    });
    expect(msg).toMatch(
      /api\.desiredCount: must satisfy minCapacity <= desiredCount <= maxCapacity/,
    );
    expect(msg).toMatch(/observability\.logRetentionDays: must be one of/);
  });

  it('rejects unknown keys (typos do not silently fall back to defaults)', () => {
    expect(errorFor('dev', (c) => Object.assign(c, { databse: {} }))).toMatch(/databse/);
  });
});

describe('auth (identity)', () => {
  it.each(ENVIRONMENT_NAMES)(
    '%s: https issuer, API audience distinct from the SPA client',
    (name) => {
      const { auth } = loadEnvironmentConfig(name);
      expect(auth.issuer).toMatch(/^https:\/\//);
      expect(auth.audience).not.toBe(auth.spaClientId);
      expect(auth.spaScope.split(' ')).toEqual(
        expect.arrayContaining(['openid', 'jobs:read', 'jobs:write']),
      );
      expect(auth.maxTokenAgeSeconds).toBe(3600);
      expect(auth.rateLimit).toEqual({
        windowSeconds: 60,
        readMax: 120,
        writeMax: 20,
        unauthenticatedMax: 30,
      });
    },
  );

  it.each(['dev', 'staging', 'prod'] as const)(
    '%s rejects an http issuer or JWKS URL (dev included)',
    (name) => {
      expect(
        errorFor(name, (c) => {
          c.auth = { ...c.auth, issuer: 'http://idp.internal/realm' };
        }),
      ).toMatch(/auth\.issuer: must be an https URL/);
      expect(
        errorFor(name, (c) => {
          c.auth = { ...c.auth, jwksUri: 'http://idp.internal/jwks' };
        }),
      ).toMatch(/auth\.jwksUri/);
    },
  );

  it('rejects the SPA client id as API audience (ID-token confusion)', () => {
    expect(
      errorFor('dev', (c) => {
        c.auth = { ...c.auth, audience: c.auth.spaClientId };
      }),
    ).toMatch(/auth\.audience: must identify the API/);
    expect(
      errorFor('dev', (c) => {
        c.auth = { ...c.auth, allowedClientIds: [c.auth.audience] };
      }),
    ).toMatch(/auth\.allowedClientIds/);
  });

  it('requires the SPA to request openid and both API scopes', () => {
    expect(
      errorFor('staging', (c) => {
        c.auth = { ...c.auth, spaScope: 'openid jobs:read' };
      }),
    ).toMatch(/auth\.spaScope: must include jobs:write/);
  });

  it('accepts only asymmetric algorithms, the same list as the API configuration', () => {
    expect([...AUTH_ALGORITHMS]).toEqual([...ASYMMETRIC_JWS_ALGORITHMS]);
    expect(
      errorFor('prod', (c) => {
        c.auth = { ...c.auth, algorithms: ['HS256' as never] };
      }),
    ).toMatch(/auth\.algorithms/);
  });
});

describe('config overrides', () => {
  it('context wins over environment variables, which win over the file', () => {
    const ctx = (key: string) => (key === 'account.prod' ? '111111111111' : undefined);
    expect(
      resolveConfigOverrides('prod', ctx, { STARTER_ACCOUNT_ID_PROD: '222222222222' }),
    ).toEqual({
      account: '111111111111',
    });
    expect(
      resolveConfigOverrides('prod', () => undefined, { STARTER_ACCOUNT_ID_PROD: '222222222222' }),
    ).toEqual({
      account: '222222222222',
    });
    expect(resolveConfigOverrides('prod', () => undefined, {})).toEqual({});
  });

  it('validates foundationMode context', () => {
    expect(() =>
      resolveConfigOverrides('dev', (k) => (k === 'foundationMode' ? 'lookup' : undefined), {}),
    ).toThrow(/foundationMode=lookup/);
  });

  it('region: -c region.<env> > -c region > STARTER_REGION_<ENV> > config; AWS_REGION is ignored', () => {
    const ctx = (values: Record<string, string>) => (key: string) => values[key];
    const env = { STARTER_REGION_PROD: 'eu-central-1', AWS_REGION: 'us-west-2' };
    expect(
      resolveConfigOverrides('prod', ctx({ 'region.prod': 'eu-west-1', region: 'eu-west-2' }), env),
    ).toEqual({ region: 'eu-west-1' });
    expect(resolveConfigOverrides('prod', ctx({ region: 'eu-west-2' }), env)).toEqual({
      region: 'eu-west-2',
    });
    expect(resolveConfigOverrides('prod', ctx({}), env)).toEqual({ region: 'eu-central-1' });
    expect(resolveConfigOverrides('prod', ctx({}), { AWS_REGION: 'us-west-2' })).toEqual({});
    expect(resolveConfigOverrides('dev', ctx({ 'region.prod': 'eu-west-1' }), {})).toEqual({});
  });

  it.each([
    [{ region: 'mars-1' }, {}, /Invalid -c region="mars-1"/],
    [{ 'region.dev': 'cn-north-1' }, {}, /Unsupported -c region\.dev=cn-north-1/],
    [{}, { STARTER_REGION_DEV: 'us-gov-east-1' }, /Unsupported STARTER_REGION_DEV=us-gov-east-1/],
  ])('refuses an invalid region override %j %j', (context, env, message) => {
    expect(() =>
      resolveConfigOverrides('dev', (k) => (context as Record<string, string>)[k], env),
    ).toThrow(message);
  });

  it('the default region is unchanged without an override', () => {
    for (const name of ENVIRONMENT_NAMES) {
      expect(loadEnvironmentConfig(name, {}).region).toBe('ap-southeast-1');
    }
  });

  it.each(ENVIRONMENT_NAMES)(
    '%s built for another region: placeholders follow, no ap-southeast-1 value remains',
    (name) => {
      const cfg = loadEnvironmentConfig(name, { region: 'eu-west-1' });
      expect(cfg.region).toBe('eu-west-1');
      const f = cfg.foundation;
      if (f.mode !== 'import') throw new Error('expected an imported foundation');
      expect(f.vpc.appSubnets.map((s) => s.availabilityZone)).toEqual([
        'eu-west-1a',
        'eu-west-1b',
        'eu-west-1c',
      ]);
      expect(f.kms.dataKeyArn).toMatch(/^arn:aws:kms:eu-west-1:/);
      expect(f.edge.albCertificateArn).toMatch(/^arn:aws:acm:eu-west-1:/);
      // CloudFront certificates and the WAF web ACL stay in us-east-1 whatever the region.
      expect(f.edge.cloudFrontCertificateArn).toMatch(/^arn:aws:acm:us-east-1:/);
      // No confirmed origin-facing prefix list id for eu-west-1: a placeholder, never pl-31a34658.
      expect(f.edge.cloudFrontOriginFacingPrefixListId).toBe(PLACEHOLDER_PREFIX_LIST_ID);
      expect(JSON.stringify(cfg)).not.toContain('ap-southeast-1');
    },
  );

  it('the origin-facing prefix list id is looked up per region', () => {
    expect(knownCloudFrontOriginFacingPrefixListId('ap-southeast-1')).toBe('pl-31a34658');
    expect(knownCloudFrontOriginFacingPrefixListId('eu-west-1')).toBeUndefined();
    expect(knownCloudFrontOriginFacingPrefixListId('constructor')).toBeUndefined();
    expect(loadEnvironmentConfig('dev').foundation.edge.cloudFrontOriginFacingPrefixListId).toBe(
      'pl-31a34658',
    );
  });

  it('foundationMode=sandbox builds the dev sandbox foundation in the configured region', () => {
    const cfg = loadEnvironmentConfig('dev', { region: 'eu-west-1', foundationMode: 'sandbox' });
    if (cfg.foundation.mode !== 'sandbox') throw new Error('expected the sandbox foundation');
    expect(cfg.foundation.availabilityZones).toEqual(['eu-west-1a', 'eu-west-1b']);
  });

  it('a config with real values of one region is refused in another (no silent re-targeting)', () => {
    // An adopter's prod.ts with a hard-coded region: the override still wins and the schema
    // refuses the region-specific values of the old region.
    expect(() => parseEnvironmentConfig('prod', { ...clone('prod'), region: 'eu-west-1' })).toThrow(
      /subnets must be in eu-west-1/,
    );
  });
});

describe('database section (ADR 0220-0223)', () => {
  it.each(ENVIRONMENT_NAMES)(
    '%s: master rotation on, retention disabled, pool and connection limits explicit',
    (name) => {
      const { database } = loadEnvironmentConfig(name);
      expect(database.rotation).toEqual({ enabled: true, intervalDays: 30 });
      expect(database.retention).toEqual({ mode: 'disabled' });
      expect(database.apiPoolMax).toBe(5);
      expect(database.connectionLimits).toEqual({ migrator: 3, processor: 20, retention: 2 });
    },
  );

  it('master secret rotation is required in every environment (no SMG4 suppression exists)', () => {
    expect(
      errorFor('dev', (c) => {
        c.database.rotation = { enabled: false };
      }),
    ).toMatch(/database\.rotation\.enabled: master secret rotation is required/);
  });

  it('the master user can never be one of the managed starter_* roles', () => {
    expect(
      errorFor('prod', (c) => {
        c.database.masterUsername = 'starter_app';
      }),
    ).toMatch(/database\.masterUsername: must not use the starter_ prefix/);
  });

  it('retention "apply" requires the reference of an approved policy', () => {
    expect(
      errorFor('staging', (c) => {
        c.database.retention = { mode: 'apply', contentDays: 90 };
      }),
    ).toMatch(/database\.retention\.approvalRef: is required when the retention mode is "apply"/);
    expect(
      parseEnvironmentConfig('staging', {
        ...clone('staging'),
        database: {
          ...clone('staging').database,
          retention: { mode: 'apply', contentDays: 90, approvalRef: 'RET-2026-001' },
        },
      }).database.retention,
    ).toEqual({
      mode: 'apply',
      contentDays: 90,
      approvalRef: 'RET-2026-001',
      batchSize: 100,
      maxBatches: 50,
    });
  });
});

describe('sandbox-only options (live validation, not a governed environment) never reach dev/staging/prod', () => {
  const sandboxOptions: [string, (c: Record<string, unknown> & EnvironmentConfigInput) => void][] =
    [
      ['teardown', (c) => Object.assign(c, { teardown: 'destroy' })],
      [
        'run',
        (c) =>
          Object.assign(c, { run: { runId: 'sbx-0a1b2c', expiresAt: '2026-10-16T06:00:00Z' } }),
      ],
      ['api.originMode', (c) => Object.assign(c.api, { originMode: 'public-alb-http' })],
      [
        'database.deleteAutomatedBackups',
        (c) => Object.assign(c.database, { deleteAutomatedBackups: true }),
      ],
      ['database.removalPolicy', (c) => Object.assign(c.database, { removalPolicy: 'destroy' })],
      [
        'workflow.reservedConcurrency',
        (c) => Object.assign(c.workflow, { reservedConcurrency: null }),
      ],
      [
        'observability.logRetentionDays',
        (c) => Object.assign(c.observability, { logRetentionDays: 1 }),
      ],
      ['auth.testIssuer', (c) => Object.assign(c.auth, { testIssuer: true, issuer: undefined })],
    ];

  it.each(ENVIRONMENT_NAMES)('%s rejects every sandbox-only option', (name) => {
    for (const [path, mutate] of sandboxOptions) {
      const message = errorFor(name, mutate);
      expect(message, path).toMatch(new RegExp(`${path.replace('.', '\\.')}: `));
    }
  });

  it('dev with the sandbox foundation still rejects disabling access logs or ALL flow logs', () => {
    const devSandbox = () => {
      const c = clone('dev') as Record<string, unknown> & EnvironmentConfigInput;
      c.foundation = { ...structuredClone(devSandboxFoundation) };
      return c;
    };
    for (const [field, value] of [
      ['accessLogs', false],
      ['flowLogs', 'reject'],
    ] as const) {
      const c = devSandbox();
      Object.assign(c.foundation, { [field]: value });
      expect(() => parseEnvironmentConfig('dev', c)).toThrow(
        new RegExp(`foundation\\.${field}: .*sandbox-only`),
      );
    }
  });

  it('the sandbox itself must be ephemeral, self-contained and carry a run identity', () => {
    const c = structuredClone(RAW_ENVIRONMENT_CONFIGS.sandbox) as Record<string, unknown> &
      EnvironmentConfigInput;
    c.teardown = 'retain';
    delete c.run;
    c.foundation = placeholderImportedFoundation('de', 'sandbox');
    let message = '';
    try {
      parseEnvironmentConfig('sandbox', c);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/foundation\.mode: the sandbox creates its own foundation/);
    expect(message).toMatch(/teardown: the sandbox is ephemeral/);
    expect(message).toMatch(/run: is required for the sandbox/);
  });

  it('the issuer comes from config or from the test issuer, never both or neither', () => {
    expect(
      errorFor('dev', (c) => {
        delete c.auth.issuer;
      }),
    ).toMatch(/auth\.issuer: is required/);
    const c = structuredClone(RAW_ENVIRONMENT_CONFIGS.sandbox);
    c.auth = { ...c.auth, issuer: 'https://idp.example.com' };
    expect(() => parseEnvironmentConfig('sandbox', c)).toThrow(
      /auth\.issuer: omit issuer and jwksUri/,
    );
  });

  it('the HTTPS VPC origin still requires the ALB certificate and origin name', () => {
    const msg = errorFor('dev', (c) => {
      c.foundation = { ...structuredClone(devSandboxFoundation) };
      delete (c.foundation.edge as { albCertificateArn?: string }).albCertificateArn;
      delete (c.foundation.edge as { apiOriginDomainName?: string }).apiOriginDomainName;
    });
    expect(msg).toMatch(
      /foundation\.edge\.apiOriginDomainName: is required for the CloudFront VPC origin/,
    );
    expect(msg).toMatch(/foundation\.edge\.albCertificateArn: is required for the HTTPS ALB/);
  });

  it('context overrides: runId/expiresAt/sandbox.reservedConcurrency for the sandbox only', () => {
    const ctx = (values: Record<string, unknown>) => (key: string) => values[key];
    const all = {
      runId: 'sbx-0a1b2c',
      expiresAt: '2026-10-16T06:00:00Z',
      'sandbox.reservedConcurrency': 'none',
    };
    expect(resolveConfigOverrides('sandbox', ctx(all), {})).toEqual({
      run: { runId: 'sbx-0a1b2c', expiresAt: '2026-10-16T06:00:00Z' },
      reservedConcurrency: null,
    });
    expect(resolveConfigOverrides('dev', ctx(all), {})).toEqual({});
    expect(
      resolveConfigOverrides('sandbox', ctx({ 'sandbox.reservedConcurrency': '3' }), {}),
    ).toEqual({
      reservedConcurrency: 3,
    });
    expect(() =>
      resolveConfigOverrides('sandbox', ctx({ 'sandbox.reservedConcurrency': 'lots' }), {}),
    ).toThrow(/expected "none" or an integer/);
    const pl = resolveConfigOverrides(
      'sandbox',
      ctx({ 'sandbox.originPrefixListId': 'pl-0123abcd' }),
      {},
    );
    expect(
      loadEnvironmentConfig('sandbox', pl).foundation.edge.cloudFrontOriginFacingPrefixListId,
    ).toBe('pl-0123abcd');
    expect(() => loadEnvironmentConfig('sandbox', { originPrefixListId: 'sg-0123abcd' })).toThrow(
      /cloudFrontOriginFacingPrefixListId/,
    );
    expect(() => loadEnvironmentConfig('dev', { originPrefixListId: 'pl-0123abcd' })).toThrow(
      /sandbox-only/,
    );
  });
});
