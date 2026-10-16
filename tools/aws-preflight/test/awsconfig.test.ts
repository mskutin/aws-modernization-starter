/**
 * The offline check of $HOME/.aws that runs before any aws process. Every refusal of the
 * coordinator's list has a case here; the CLI-level cases (exit 2, not even `aws --version`) are
 * in preflight.test.ts and e2e.test.ts.
 */
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_PROFILE_KEYS,
  checkAwsCliConfig,
  FORBIDDEN_CONFIG_KEYS,
  globCanMatchSsoRole,
  parseIni,
} from '../src/awsconfig.ts';
import {
  AT_ROLE_PATTERN,
  AT_SSO_ROLE_NAME,
  makeHome,
  PROFILE,
  ROLE_PATTERN,
  SANDBOX,
  SSO_ROLE_NAME,
  ssoConfig,
} from './support.ts';

const home = (config: string = ssoConfig()) =>
  makeHome(mkdtempSync(join(tmpdir(), 'aws-preflight-config-')), config);
const check = (h: string, overrides: Partial<Parameters<typeof checkAwsCliConfig>[0]> = {}) =>
  checkAwsCliConfig({
    home: h,
    profile: PROFILE,
    expectedAccount: SANDBOX,
    rolePattern: ROLE_PATTERN,
    ...overrides,
  });
const problems = (h: string, overrides = {}) => {
  const r = check(h, overrides);
  return r.ok ? [] : r.problems;
};

describe('the native IAM Identity Center profile shape is accepted', () => {
  it("the operator's exact shape passes and reports key names only", () => {
    const r = check(home());
    expect(r).toEqual({
      ok: true,
      ssoAccountId: SANDBOX,
      ssoRoleName: SSO_ROLE_NAME,
      ssoSession: 'starter-sandbox',
      profileKeys: ['output', 'region', 'sso_account_id', 'sso_role_name', 'sso_session'],
      ssoSessionKeys: ['sso_region', 'sso_registration_scopes', 'sso_start_url'],
    });
  });

  it("a permission-set name with '@' matches its role pattern", () => {
    const h = home(ssoConfig({ ssoRoleName: AT_SSO_ROLE_NAME }));
    expect(check(h, { rolePattern: AT_ROLE_PATTERN })).toMatchObject({
      ok: true,
      ssoRoleName: AT_SSO_ROLE_NAME,
    });
  });

  it('other profiles, comments, ":" delimiters, CRLF and the legacy SSO keys are fine', () => {
    const config = [
      '; comment',
      '[profile other-team]',
      'sso_session: starter-sandbox',
      'sso_account_id = 444455556666',
      'sso_role_name = Other',
      '',
      ssoConfig(),
    ].join('\r\n');
    expect(check(home(config)).ok).toBe(true);
    const legacy = [
      `[profile ${PROFILE}]`,
      'sso_start_url = https://d-0000000000.awsapps.com/start',
      'sso_region = ap-southeast-1',
      `sso_account_id = ${SANDBOX}`,
      `sso_role_name = ${SSO_ROLE_NAME}`,
      'region = ap-southeast-1',
    ].join('\n');
    expect(check(home(legacy)).ok).toBe(true);
  });

  it('cli_history = disabled is accepted (anything else is refused)', () => {
    expect(check(home(ssoConfig({ after: '[profile x]\ncli_history = disabled\n' }))).ok).toBe(
      true,
    );
    expect(problems(home(ssoConfig({ after: '[profile x]\ncli_history = enabled\n' })))).toEqual([
      '~/.aws/config [profile x] enables cli_history (requests incl. tokens are recorded)',
    ]);
  });
});

describe('refusals (each one keeps every aws process from starting)', () => {
  it('~/.aws/cli/alias exists (aliases replace commands, `!` aliases run a shell)', () => {
    const h = home();
    mkdirSync(join(h, '.aws', 'cli'));
    writeFileSync(join(h, '.aws', 'cli', 'alias'), '[toplevel]\n');
    expect(problems(h).join('\n')).toContain('~/.aws/cli/alias exists');
  });

  it('~/.aws/cli/alias is refused even as a dangling symlink', () => {
    const h = home();
    mkdirSync(join(h, '.aws', 'cli'));
    symlinkSync('/nonexistent/alias', join(h, '.aws', 'cli', 'alias'));
    expect(problems(h).join('\n')).toContain('~/.aws/cli/alias exists');
  });

  it('~/.aws/models exists (models override the built-in ones)', () => {
    const h = home();
    mkdirSync(join(h, '.aws', 'models'));
    expect(problems(h).join('\n')).toContain('~/.aws/models exists');
  });

  it.each([
    [
      '[plugins]',
      ssoConfig({ after: '[plugins]\ncli_legacy_plugin_path = /tmp\n' }),
      'has a [plugins] section',
    ],
    [
      '[services ...]',
      ssoConfig({ after: '[services local]\nsts =\n  endpoint_url = http://x\n' }),
      'has a [services local] section',
    ],
    [
      '[DEFAULT]',
      ssoConfig({ before: '[DEFAULT]\nregion = eu-west-1' }),
      'has a [DEFAULT] section',
    ],
  ])('a %s section', (_, config, message) => {
    expect(problems(home(config)).join('\n')).toContain(message);
  });

  it.each(FORBIDDEN_CONFIG_KEYS.map((k) => [k]))(
    '%s anywhere in the file (also in other profiles)',
    (key) => {
      const p = problems(home(ssoConfig({ after: `[profile unrelated]\n${key} = x\n` })));
      expect(p).toContain(`~/.aws/config [profile unrelated] sets ${key}`);
    },
  );

  it('a nested key under any section (s3 = / endpoint_url = ...)', () => {
    const p = problems(
      home(ssoConfig({ after: '[profile unrelated]\ns3 =\n  endpoint_url = http://x\n' })),
    );
    expect(p).toContain('~/.aws/config [profile unrelated] sets nested endpoint_url');
  });

  it.each([
    [
      'the profile',
      { profileExtra: 'cli_pager = less' },
      `[profile ${PROFILE}] has keys outside the SSO allowlist: cli_pager`,
    ],
    [
      'the profile (nested)',
      { profileExtra: 's3 =\n  max_concurrent_requests = 1' },
      'has keys outside the SSO allowlist: s3, max_concurrent_requests (nested)',
    ],
    [
      'its sso-session',
      { sessionExtra: 'ca_bundle = /tmp/ca.pem' },
      '[sso-session starter-sandbox] has keys outside the SSO allowlist: ca_bundle',
    ],
    [
      '[default]',
      { after: '[default]\nregion = ap-southeast-1\ncli_binary_format = raw-in-base64-out\n' },
      '[default] has keys outside the SSO allowlist: cli_binary_format',
    ],
    [
      'the profile (role chaining)',
      { profileExtra: 'role_arn = arn:aws:iam::111122223333:role/x\nsource_profile = other' },
      'role_arn, source_profile',
    ],
  ] as const)('a key outside the allowlist in %s', (_, options, message) => {
    expect(problems(home(ssoConfig(options))).join('\n')).toContain(message);
  });

  it('a multi-line value in the profile (the CLI would join the lines into the value)', () => {
    const config = ssoConfig().replace(
      'sso_session = starter-sandbox\n',
      'sso_session = starter-sandbox\n  credential_process = /tmp/evil\n',
    );
    expect(problems(home(config)).join('\n')).toContain('sso_session (multi-line value)');
  });

  it('a section for the profile in ~/.aws/credentials (static keys)', () => {
    const h = home();
    writeFileSync(join(h, '.aws', 'credentials'), `[${PROFILE}]\naws_access_key_id = unused\n`);
    expect(problems(h)).toContain(
      `~/.aws/credentials has a [${PROFILE}] section (static keys for the profile)`,
    );
    // Other profiles' keys in the credentials file are not this run's concern.
    const h2 = home();
    writeFileSync(join(h2, '.aws', 'credentials'), '[other]\naws_access_key_id = unused\n');
    expect(check(h2).ok).toBe(true);
  });

  it('ACCOUNT MISMATCH offline: sso_account_id differs from --expected-account (masked)', () => {
    const p = problems(home(ssoConfig({ account: '444455556666' })));
    expect(p).toEqual([
      "ACCOUNT MISMATCH (offline): the profile's sso_account_id is ********6666, --expected-account is ********3333",
    ]);
  });

  it('the role pattern cannot match AWSReservedSSO_<sso_role_name>_<16 hex>', () => {
    expect(problems(home(), { rolePattern: 'AWSReservedSSO_AdministratorAccess_*' })).toEqual([
      "--expected-role-pattern cannot match the profile's role AWSReservedSSO_AccountDiscovery_<16 hex>",
    ]);
    expect(check(home(), { rolePattern: '*AccountDiscovery*' }).ok).toBe(true);
    expect(
      check(home(), { rolePattern: 'AWSReservedSSO_AccountDiscovery_0123456789abcdef' }).ok,
    ).toBe(true);
    expect(
      problems(home(), { rolePattern: 'AWSReservedSSO_AccountDiscovery_0123456789ABCDEF' }),
    ).toHaveLength(1);
  });

  it.each([
    ['a missing profile', ssoConfig({ profile: 'another' }), `profile "${PROFILE}" is not defined`],
    [
      'a missing sso-session',
      ssoConfig().replace('[sso-session starter-sandbox]', '[sso-session other]'),
      'sso_session "starter-sandbox" must be defined exactly once',
    ],
    [
      'no sso_account_id (not an SSO profile)',
      ssoConfig().replace(/sso_account_id = \d+\n/, ''),
      'no valid sso_account_id',
    ],
    [
      'a duplicate section',
      `${ssoConfig()}\n[profile ${PROFILE}]\nregion = x\n`,
      'cannot be parsed safely: duplicate section',
    ],
    [
      'a duplicate key',
      ssoConfig({ profileExtra: 'region = eu-west-1' }),
      'cannot be parsed safely: duplicate key region',
    ],
    [
      'a key before any section',
      `region = x\n${ssoConfig()}`,
      'a key before the first section header',
    ],
    [
      'an unusual quoted header',
      ssoConfig({ after: '[profile "a b"]\nregion = x\n' }),
      'unusual section header',
    ],
  ])('%s', (_, config, message) => {
    expect(problems(home(config)).join('\n')).toContain(message);
  });

  it('the default profile defined twice ([default] and [profile default])', () => {
    const config = ssoConfig({
      profile: 'default',
      after: `[default]\nsso_session = starter-sandbox\nsso_account_id = ${SANDBOX}\nsso_role_name = ${SSO_ROLE_NAME}\n`,
    });
    expect(problems(home(config), { profile: 'default' }).join('\n')).toContain(
      'defined more than once',
    );
  });

  it('no ~/.aws/config at all', () => {
    const h = mkdtempSync(join(tmpdir(), 'aws-preflight-nohome-'));
    expect(problems(h)).toEqual([
      '~/.aws/config is missing or unreadable (the SSO profile must be defined there)',
    ]);
  });

  it('never prints configuration values', () => {
    const p = problems(
      home(ssoConfig({ profileExtra: 'credential_process = /secret/path --token abc' })),
    );
    expect(p.join('\n')).not.toContain('/secret/path');
  });
});

describe('parser and glob helpers', () => {
  it('parses like RawConfigParser: lower-cased keys, nested blocks, continuation lines', () => {
    const r = parseIni(
      '[profile a]\nRegion = x\ns3 =\n  max_bandwidth = 1\nlong = a\n  continued\n',
    );
    expect(r).toEqual({
      sections: [
        {
          header: 'profile a',
          keys: [
            { name: 'region', nested: false, value: 'x' },
            { name: 's3', nested: false, value: '' },
            { name: 'max_bandwidth', nested: true, value: '' },
            { name: 'long', nested: false, value: 'a', multiline: true },
          ],
        },
      ],
    });
    expect(parseIni('[a]\nnovalue\n')).toHaveProperty('error');
  });

  it('the allowlisted keys are exactly the coordinator list', () => {
    expect([...ALLOWED_PROFILE_KEYS].sort()).toEqual([
      'output',
      'region',
      'sso_account_id',
      'sso_region',
      'sso_registration_scopes',
      'sso_role_name',
      'sso_session',
      'sso_start_url',
    ]);
  });

  it.each([
    ['AWSReservedSSO_AccountDiscovery_*', 'AccountDiscovery', true],
    ['AWSReservedSSO_*_*', 'AccountDiscovery', true],
    ['AWSReservedSSO_AccountDiscovery_????????????????', 'AccountDiscovery', true],
    ['AWSReservedSSO_AccountDiscovery_???????????????', 'AccountDiscovery', false],
    ['AWSReservedSSO_AccountDiscovery', 'AccountDiscovery', false],
    ['AWSReservedSSO_Admin*', 'AccountDiscovery', false],
    [AT_ROLE_PATTERN, AT_SSO_ROLE_NAME, true],
    ['AWSReservedSSO_acme-aws@*_*', AT_SSO_ROLE_NAME, true],
    ['AWSReservedSSO_acme-aws_*', AT_SSO_ROLE_NAME, false],
  ] as const)('glob %s vs sso_role_name %s -> %s', (pattern, name, expected) => {
    expect(globCanMatchSsoRole(pattern, name)).toBe(expected);
  });
});
