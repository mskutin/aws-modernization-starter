/**
 * Offline check of the operator's AWS CLI configuration, run before ANY `aws` process
 * (including `aws --version`).
 *
 * The AWS CLI child receives HOME, so it loads `$HOME/.aws`: command aliases (`cli/alias`, incl.
 * `!` shell aliases), service models (`models`), plugins, `data_path`, endpoint overrides,
 * `credential_process`, assume-role chains and `cli_history`. Any of them can replace, extend or
 * redirect an allowlisted call after every check in this tool has passed. The tool therefore runs
 * only with the minimal native IAM Identity Center profile shape and refuses everything else.
 *
 * The parser mirrors what aws-cli 2.35.11 does (botocore `raw_config_parse` = Python
 * `configparser.RawConfigParser`: keys lower-cased, `[DEFAULT]` inherited by every section,
 * duplicates are errors, indented `key =` blocks are nested sub-keys; `build_profile_map`:
 * `[default]`, and sections starting with `profile` / `sso-session` / `services` split into two
 * words). Only section headers, key names and four values are used (`sso_session`,
 * `sso_account_id`, `sso_role_name`, `cli_history`); values are never printed.
 */
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { maskAccount } from './validate.ts';

/** The only keys the selected profile, its sso-session and `[default]` may contain. */
export const ALLOWED_PROFILE_KEYS: readonly string[] = [
  'sso_session',
  'sso_start_url',
  'sso_region',
  'sso_account_id',
  'sso_role_name',
  'sso_registration_scopes',
  'region',
  'output',
];

/** Keys refused anywhere in the config file, also as nested sub-keys. */
export const FORBIDDEN_CONFIG_KEYS: readonly string[] = [
  'data_path',
  'endpoint_url',
  'ca_bundle',
  'credential_process',
  'credential_source',
  'role_arn',
  'source_profile',
  'web_identity_token_file',
];

/** IAM Identity Center permission-set names: `[\w+=,.@-]`, 1-32 characters. */
const SSO_ROLE_NAME_RE = /^[A-Za-z0-9_+=,.@-]{1,32}$/;

interface IniKey {
  readonly name: string;
  readonly nested: boolean;
  readonly value: string;
  /** Continuation lines follow a non-empty first line (the CLI joins them into the value). */
  multiline?: boolean;
}
interface IniSection {
  readonly header: string;
  readonly keys: IniKey[];
}

/** RawConfigParser-compatible parse of key names (and first-line values). */
export function parseIni(text: string): { sections: IniSection[] } | { error: string } {
  const sections: IniSection[] = [];
  const headers = new Set<string>();
  let current: IniSection | undefined;
  let currentKey: { key: IniKey; indent: number } | undefined;
  const lines = text.split(/\r\n|\n|\r/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const stripped = raw.trim();
    if (stripped === '' || stripped.startsWith('#') || stripped.startsWith(';')) continue;
    const indent = raw.length - raw.trimStart().length;
    if (current && currentKey && indent > currentKey.indent) {
      // Continuation line. If the key's first line was empty, botocore parses the block as
      // nested `sub_key = value` pairs (and fails without '=').
      if (currentKey.key.value === '') {
        const eq = stripped.indexOf('=');
        if (eq <= 0) return { error: `line ${i + 1}: malformed nested value` };
        current.keys.push({
          name: stripped.slice(0, eq).trim().toLowerCase(),
          nested: true,
          value: '',
        });
      } else {
        currentKey.key.multiline = true;
      }
      continue;
    }
    const header = /^\[(.+)\]/.exec(stripped);
    if (header?.[1] !== undefined) {
      const name = header[1];
      if (headers.has(name)) return { error: `duplicate section [${name}]` };
      headers.add(name);
      current = { header: name, keys: [] };
      sections.push(current);
      currentKey = undefined;
      continue;
    }
    if (!current) return { error: `line ${i + 1}: a key before the first section header` };
    const kv = /^(.*?)\s*[=:]\s*(.*)$/.exec(stripped);
    const name = kv?.[1]?.trimEnd().toLowerCase();
    if (!kv || !name) return { error: `line ${i + 1}: not a "key = value" line` };
    if (current.keys.some((k) => !k.nested && k.name === name)) {
      return { error: `duplicate key ${name} in [${current.header}]` };
    }
    const key: IniKey = { name, nested: false, value: kv[2] ?? '' };
    current.keys.push(key);
    currentKey = { key, indent };
  }
  return { sections };
}

type SectionKind =
  'DEFAULT' | 'default' | 'profile' | 'sso-session' | 'services' | 'plugins' | 'other';

/** botocore build_profile_map: kind and (for profile/sso-session/services) the second word. */
function classify(header: string): { kind: SectionKind; name?: string } | { error: string } {
  if (header === 'DEFAULT') return { kind: 'DEFAULT' };
  if (header === 'default') return { kind: 'default', name: 'default' };
  if (header === 'plugins') return { kind: 'plugins' };
  for (const kind of ['profile', 'sso-session', 'services'] as const) {
    if (!header.startsWith(kind)) continue;
    // botocore uses shlex.split(); refuse what a whitespace split would not reproduce.
    if (/["'\\]/.test(header)) return { error: `unusual section header [${header}]` };
    const parts = header.split(/\s+/).filter(Boolean);
    return parts.length === 2 ? { kind, name: parts[1] } : { kind: 'other' };
  }
  return { kind: 'other' };
}

/**
 * Can the glob (`*` any run, `?` one character) match some role named
 * `AWSReservedSSO_<ssoRoleName>_<16 lowercase hex>`?
 */
export function globCanMatchSsoRole(pattern: string, ssoRoleName: string): boolean {
  type Pos = { readonly literal: string } | { readonly hex: true };
  const text: Pos[] = [
    ...[...`AWSReservedSSO_${ssoRoleName}_`].map((literal) => ({ literal })),
    ...Array.from({ length: 16 }, () => ({ hex: true as const })),
  ];
  const p = [...pattern];
  const matchesChar = (c: string, t: Pos) =>
    'literal' in t ? t.literal === c : /^[0-9a-f]$/.test(c);
  // dp[j]: p[0..i) matches text[0..j)
  let dp = Array.from({ length: text.length + 1 }, (_, j) => j === 0);
  for (const c of p) {
    const next = Array.from({ length: text.length + 1 }, () => false);
    if (c === '*') {
      let any = false;
      for (let j = 0; j <= text.length; j++) {
        any = any || (dp[j] ?? false);
        next[j] = any;
      }
    } else {
      for (let j = 1; j <= text.length; j++) {
        const t = text[j - 1];
        next[j] = (dp[j - 1] ?? false) && t !== undefined && (c === '?' || matchesChar(c, t));
      }
    }
    dp = next;
  }
  return dp[text.length] ?? false;
}

export interface ConfigCheckOptions {
  readonly home: string;
  readonly profile: string;
  readonly expectedAccount: string;
  /** `--expected-role-pattern`; the mutation guard may run without one (no role check then). */
  readonly rolePattern?: string | undefined;
}

export type ConfigCheckResult =
  | {
      readonly ok: true;
      readonly ssoAccountId: string;
      readonly ssoRoleName: string;
      readonly ssoSession: string | undefined;
      /** Key names (never values) of the selected profile and of its sso-session, for evidence. */
      readonly profileKeys: readonly string[];
      readonly ssoSessionKeys: readonly string[];
    }
  | {
      readonly ok: false;
      readonly problems: readonly string[];
      /** The profile's sso_account_id is not the expected account (offline). */
      readonly accountMismatch?: true;
      /** The profile is not defined in ~/.aws/config. */
      readonly profileMissing?: true;
    };

const readText = (path: string): string | undefined => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
};

/** Every refusal reason (empty = the configuration is the minimal SSO shape and consistent). */
export function checkAwsCliConfig(options: ConfigCheckOptions): ConfigCheckResult {
  const problems: string[] = [];
  const aws = join(options.home, '.aws');
  const exists = (path: string) => {
    try {
      lstatSync(path);
      return true;
    } catch {
      return false;
    }
  };
  if (exists(join(aws, 'cli', 'alias'))) {
    problems.push(
      '~/.aws/cli/alias exists (CLI aliases can replace any command, incl. `!` shell aliases)',
    );
  }
  if (exists(join(aws, 'models'))) {
    problems.push('~/.aws/models exists (service models there override the built-in ones)');
  }

  const configText = existsSync(join(aws, 'config')) ? readText(join(aws, 'config')) : undefined;
  if (configText === undefined) {
    problems.push('~/.aws/config is missing or unreadable (the SSO profile must be defined there)');
    return { ok: false, problems };
  }
  const parsed = parseIni(configText);
  if ('error' in parsed) {
    problems.push(`~/.aws/config cannot be parsed safely: ${parsed.error}`);
    return { ok: false, problems };
  }

  const profiles: IniSection[] = [];
  const ssoSessions = new Map<string, IniSection[]>();
  let defaultSection: IniSection | undefined;
  for (const section of parsed.sections) {
    const c = classify(section.header);
    if ('error' in c) {
      problems.push(`~/.aws/config: ${c.error}`);
      continue;
    }
    if (c.kind === 'DEFAULT')
      problems.push('~/.aws/config has a [DEFAULT] section (inherited by every section)');
    if (c.kind === 'plugins')
      problems.push('~/.aws/config has a [plugins] section (loads Python code into the CLI)');
    if (c.kind === 'services') {
      problems.push(
        `~/.aws/config has a [${section.header}] section (per-service endpoint overrides)`,
      );
    }
    for (const key of section.keys) {
      if (FORBIDDEN_CONFIG_KEYS.includes(key.name)) {
        problems.push(
          `~/.aws/config [${section.header}] sets ${key.nested ? 'nested ' : ''}${key.name}`,
        );
      }
      if (
        key.name === 'cli_history' &&
        !key.nested &&
        key.value.trim().toLowerCase() !== 'disabled'
      ) {
        problems.push(
          `~/.aws/config [${section.header}] enables cli_history (requests incl. tokens are recorded)`,
        );
      }
    }
    if (c.kind === 'default') defaultSection = section;
    // `[profile default]` and `[default]` both define the default profile (both found = refused).
    if (c.kind === 'profile' && c.name === options.profile) profiles.push(section);
    if (c.kind === 'sso-session' && c.name !== undefined) {
      ssoSessions.set(c.name, [...(ssoSessions.get(c.name) ?? []), section]);
    }
  }
  if (options.profile === 'default' && defaultSection) profiles.push(defaultSection);

  const checkKeys = (section: IniSection, what: string) => {
    const extra = section.keys
      .filter((k) => k.nested || k.multiline || !ALLOWED_PROFILE_KEYS.includes(k.name))
      .map((k) =>
        k.nested ? `${k.name} (nested)` : k.multiline ? `${k.name} (multi-line value)` : k.name,
      );
    if (extra.length > 0) {
      problems.push(
        `${what} [${section.header}] has keys outside the SSO allowlist: ${extra.join(', ')}`,
      );
    }
  };
  if (defaultSection && options.profile !== 'default') checkKeys(defaultSection, '~/.aws/config');

  let ssoAccountId: string | undefined;
  let ssoRoleName: string | undefined;
  let ssoSession: string | undefined;
  let profileKeys: string[] = [];
  let ssoSessionKeys: string[] = [];
  let accountMismatch = false;
  let profileMissing = false;
  if (profiles.length === 0) {
    profileMissing = true;
    problems.push(`profile "${options.profile}" is not defined in ~/.aws/config`);
  } else if (profiles.length > 1) {
    problems.push(`profile "${options.profile}" is defined more than once in ~/.aws/config`);
  } else {
    const profile = profiles[0] as IniSection;
    checkKeys(profile, '~/.aws/config');
    profileKeys = profile.keys.map((k) => k.name).sort();
    const value = (name: string) =>
      profile.keys.find((k) => !k.nested && k.name === name)?.value.trim();
    ssoAccountId = value('sso_account_id');
    ssoRoleName = value('sso_role_name');
    ssoSession = value('sso_session');
    if (ssoSession !== undefined) {
      const sessions = ssoSessions.get(ssoSession) ?? [];
      if (sessions.length !== 1) {
        problems.push(
          `sso_session "${ssoSession}" must be defined exactly once ([sso-session ${ssoSession}])`,
        );
      } else {
        checkKeys(sessions[0] as IniSection, '~/.aws/config');
        ssoSessionKeys = (sessions[0] as IniSection).keys.map((k) => k.name).sort();
      }
    }
    if (!ssoAccountId || !/^\d{12}$/.test(ssoAccountId)) {
      problems.push(
        'the profile has no valid sso_account_id (a native IAM Identity Center profile is required)',
      );
    } else if (ssoAccountId !== options.expectedAccount) {
      accountMismatch = true;
      problems.push(
        `ACCOUNT MISMATCH (offline): the profile's sso_account_id is ${maskAccount(ssoAccountId)}, --expected-account is ${maskAccount(options.expectedAccount)}`,
      );
    }
    if (!ssoRoleName || !SSO_ROLE_NAME_RE.test(ssoRoleName)) {
      problems.push(
        'the profile has no valid sso_role_name (a native IAM Identity Center profile is required)',
      );
    } else if (
      options.rolePattern !== undefined &&
      !globCanMatchSsoRole(options.rolePattern, ssoRoleName)
    ) {
      problems.push(
        `--expected-role-pattern cannot match the profile's role AWSReservedSSO_${ssoRoleName}_<16 hex>`,
      );
    }
  }

  const credentialsText = readText(join(aws, 'credentials'));
  if (credentialsText !== undefined) {
    const creds = parseIni(credentialsText);
    if ('error' in creds) {
      problems.push(`~/.aws/credentials cannot be parsed safely: ${creds.error}`);
    } else if (creds.sections.some((s) => s.header === options.profile)) {
      problems.push(
        `~/.aws/credentials has a [${options.profile}] section (static keys for the profile)`,
      );
    }
  }

  if (problems.length > 0 || !ssoAccountId || !ssoRoleName) {
    return {
      ok: false,
      problems: problems.length > 0 ? problems : ['incomplete SSO profile'],
      ...(accountMismatch ? { accountMismatch: true as const } : {}),
      ...(profileMissing ? { profileMissing: true as const } : {}),
    };
  }
  return { ok: true, ssoAccountId, ssoRoleName, ssoSession, profileKeys, ssoSessionKeys };
}

// ── personal-sandbox: identities a child could fall back to ─────────────────────────────────

/** A `cdk.json` the CDK CLI may read (`~/.cdk.json`, the working directory's, the project's). */
export interface CdkSettingsFile {
  readonly path: string;
  /** How the file is named in messages (no local paths). */
  readonly label: string;
}

const lexists = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

/**
 * personal-sandbox only: refusal reasons for every identity a guarded child could use
 * instead of the selected profile when it loses `AWS_PROFILE`, or that the CDK CLI prefers over
 * it: a `[default]` / `[profile default]` section in `~/.aws/config`, a `~/.aws/credentials` file
 * with any section or key, and a `profile` key in a CDK settings file. Values are never printed.
 */
export function fallbackIdentityProblems(options: {
  readonly home: string;
  readonly cdkSettings: readonly CdkSettingsFile[];
}): string[] {
  const problems: string[] = [];
  const aws = join(options.home, '.aws');
  const configText = readText(join(aws, 'config'));
  if (configText !== undefined) {
    const parsed = parseIni(configText);
    if ('error' in parsed) {
      problems.push(`~/.aws/config cannot be parsed safely: ${parsed.error}`);
    } else {
      for (const section of parsed.sections) {
        const c = classify(section.header);
        if ('error' in c) continue;
        if (c.kind === 'default' || (c.kind === 'profile' && c.name === 'default')) {
          problems.push(
            `~/.aws/config has a [${section.header}] section: a command that loses AWS_PROFILE would use it`,
          );
        }
      }
    }
  }
  const credentials = join(aws, 'credentials');
  if (lexists(credentials)) {
    const text = readText(credentials);
    const parsed = text === undefined ? undefined : parseIni(text);
    if (parsed === undefined) {
      problems.push('~/.aws/credentials exists and cannot be read');
    } else if ('error' in parsed) {
      problems.push(
        '~/.aws/credentials holds keys outside a clean section layout: remove the file (the sandbox uses the SSO profile only)',
      );
    } else if (parsed.sections.length > 0) {
      problems.push(
        `~/.aws/credentials has ${parsed.sections.length} section(s): static keys a command could fall back to; remove the file (the sandbox uses the SSO profile only)`,
      );
    }
  }
  for (const file of options.cdkSettings) {
    if (!lexists(file.path)) continue;
    const text = readText(file.path);
    let settings: unknown;
    try {
      settings = text === undefined ? undefined : (JSON.parse(text) as unknown);
    } catch {
      problems.push(`${file.label} cannot be parsed: a "profile" setting cannot be ruled out`);
      continue;
    }
    if (settings === undefined) {
      problems.push(`${file.label} cannot be read: a "profile" setting cannot be ruled out`);
    } else if (typeof settings === 'object' && settings !== null && 'profile' in settings) {
      problems.push(
        `${file.label} sets "profile": the CDK CLI would prefer it over AWS_PROFILE; remove the key`,
      );
    }
  }
  return problems;
}
