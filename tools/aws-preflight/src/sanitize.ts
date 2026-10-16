/**
 * Sanitizer for everything that leaves the private raw directory (evidence file and console).
 *
 * Masking rules (README "Sanitization"):
 * - the sandbox account ID -> `<sandbox-account>`; any other 12-digit account ID (also written as
 *   `1111-2222-3333` or with spaces) -> `<other-account-N>` (stable within one run);
 * - e-mail addresses (also `%40`-encoded) -> `<email>`; the caller's session name -> `<session>`
 *   (as a substring when 6+ characters, as a whole identifier when shorter);
 * - AWS access key IDs -> `<access-key-id>`; IAM unique IDs (AROA..., AIDA...) -> `<iam-unique-id-N>`;
 * - resource IDs keep their type prefix and get a per-run sequence number: `vpc-0a1b...` ->
 *   `<vpc-1>`, `subnet-...` -> `<subnet-3>`, UUIDs (KMS keys, ACM certificates, WAF ACLs, stack
 *   IDs) -> `<uuid-N>`, organization IDs -> `<org-N>`, `<ou-N>`, `<org-root-N>`, `<policy-N>`;
 * - names of workloads that are not this project's (stacks, `Name` tags, customer KMS aliases,
 *   web ACLs, budgets, log policies) -> `<stack-N>`, `<name-N>`, `alias/<kms-alias-N>`,
 *   `<web-acl-N>`, `<budget-N>`, `<log-policy-N>`, also inside ARNs;
 * - customer domain names -> `<domain-N>.<tld>`; AWS-owned names (amazonaws.com, ...) are kept;
 * - integers with exactly 12 digits -> account token or `<12-digit-number>`.
 * AWS-managed public identifiers (AZ IDs, managed prefix-list IDs, AWS managed policy ARNs,
 * quota codes) are kept by the projections that know them to be public.
 */
import { sessionNameRegExp } from './leak.ts';

export interface SanitizerOptions {
  /** The verified sandbox account (12 digits). */
  readonly sandboxAccount: string;
  /** The caller's role session name (masked wherever it appears). */
  readonly sessionName?: string | undefined;
  /**
   * Extra stack and `Name`-tag prefixes kept readable (personal-sandbox: the sandbox stage's
   * `Sandbox-` stacks). Empty for the strict profile.
   */
  readonly keepNamePrefixes?: readonly string[] | undefined;
}

/** Names that are tokenized unless they belong to this project (or to AWS). */
export type NameKind = 'stack' | 'name' | 'kms-alias' | 'web-acl' | 'budget' | 'log-policy';

const PROJECT_NAME_RE = /^starter(?:[-_/]|$)/;

/** Which names stay readable in committed evidence. */
export const KEEP_NAME: Readonly<Record<NameKind, (value: string) => boolean>> = {
  stack: (v) =>
    v === 'CDKToolkit' ||
    PROJECT_NAME_RE.test(v) ||
    v.startsWith('StackSet-AWSControlTower') ||
    v.startsWith('AWSAccelerator'),
  name: (v) => PROJECT_NAME_RE.test(v),
  'kms-alias': (v) => v.startsWith('alias/aws/') || /^alias\/starter([-_/]|$)/.test(v),
  'web-acl': () => false,
  budget: (v) => PROJECT_NAME_RE.test(v),
  'log-policy': () => false,
};

export interface Sanitizer {
  readonly sandboxAccount: string;
  readonly sessionName: string | undefined;
  isSandboxAccount(value: string): boolean;
  account(value: string): string;
  arn(value: string): string;
  /** Opaque identifier without a recognisable pattern: `<kind-N>`. */
  id(kind: string, value: string): string;
  /** A workload name: kept when it is this project's (KEEP_NAME), else `<kind-N>`. */
  name(kind: NameKind, value: string): string;
  text(value: string, options?: { domains?: boolean }): string;
  domain(value: string): string;
  number(value: number): number | string;
  /** Console line: same rules as text(), no truncation (`domains: false` for local paths). */
  console(line: string, options?: { domains?: boolean }): string;
  /** Replaces only the session name (operator text that must otherwise stay verbatim). */
  maskSession(value: string): string;
}

const MAX_TEXT = 256;

/** AWS-owned DNS suffixes: names under these are AWS endpoints, not customer domains. */
const AWS_DNS_SUFFIXES = [
  'amazonaws.com',
  'amazonaws.com.cn',
  'amazon.com',
  'aws.amazon.com',
  'cloudfront.net',
  'on.aws',
  'api.aws',
  'compute.internal',
  'ec2.internal',
  'awsapps.com',
];

/** EC2/VPC resource ID prefixes (`<prefix>-<8 or 17 hex>`). */
const RESOURCE_PREFIXES = [
  'vpcbpa-exclude',
  'vpce-svc',
  'tgw-attach',
  'rtbassoc',
  'aclassoc',
  'eipalloc',
  'eipassoc',
  'subnet',
  'vpce',
  'eigw',
  'dopt',
  'vpc',
  'rtb',
  'igw',
  'nat',
  'eni',
  'tgw',
  'pcx',
  'acl',
  'sgr',
  'vgw',
  'cgw',
  'vpn',
  'ami',
  'snap',
  'vol',
  'sg',
  'lt',
  'pl',
  'i',
];

const RE = {
  email: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  encodedEmail: /[A-Za-z0-9._%+-]+%40[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gi,
  accessKeyId: /\b(?:AKIA|ASIA|ABIA|ACCA|A3T[A-Z0-9])[A-Z0-9]{16}\b/g,
  iamUniqueId: /\b(?:AIDA|AROA|ANPA|AGPA|AIPA|ANVA|APKA)[A-Z0-9]{12,28}\b/g,
  uuid: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  mrk: /\bmrk-[0-9a-f]{32}\b/g,
  twelveDigits: /(?<!\d)\d{12}(?!\d)/g,
  separatedAccount: /(?<!\d)(\d{4})[- ](\d{4})[- ](\d{4})(?!\d)/g,
  resourceId: new RegExp(`\\b(${RESOURCE_PREFIXES.join('|')})-([0-9a-f]{17}|[0-9a-f]{8})\\b`, 'g'),
  ou: /\bou-[a-z0-9]{4,32}-[a-z0-9]{8,32}\b/g,
  org: /\bo-[a-z0-9]{10,32}\b/g,
  root: /\br-[a-z0-9]{4,32}\b/g,
  scp: /\bp-[a-z0-9_]{8,128}\b/g,
  // A reversed AWS service name (com.amazonaws.<region>.<svc>) or a DNS name.
  dns: /\b(?:com|aws)\.amazonaws\.[A-Za-z0-9.-]+|(?:\*\.)?\b(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}\b/g,
};

export function createSanitizer(options: SanitizerOptions): Sanitizer {
  const { sandboxAccount } = options;
  if (!/^\d{12}$/.test(sandboxAccount)) throw new Error('sandbox account must be 12 digits');
  const sessionName = options.sessionName ? options.sessionName : undefined;
  const sessionRe = sessionName ? sessionNameRegExp(sessionName, 'gi') : undefined;

  const maps = new Map<string, Map<string, string>>();
  const token = (kind: string, raw: string): string => {
    let m = maps.get(kind);
    if (!m) maps.set(kind, (m = new Map()));
    let t = m.get(raw);
    if (!t) m.set(raw, (t = `<${kind}-${m.size + 1}>`));
    return t;
  };
  const accountToken = (acct: string): string =>
    acct === sandboxAccount ? '<sandbox-account>' : token('other-account', acct);

  const isAwsDns = (name: string): boolean => {
    const n = name.toLowerCase().replace(/^\*\./, '');
    return AWS_DNS_SUFFIXES.some((s) => n === s || n.endsWith(`.${s}`));
  };

  const domain = (value: string): string => {
    const lower = value.toLowerCase().replace(/\.$/, '');
    const wildcard = lower.startsWith('*.');
    const name = wildcard ? lower.slice(2) : lower;
    if (!/^[a-z0-9.-]+$/.test(name) || !name.includes('.')) return text(value);
    if (isAwsDns(name)) return lower;
    const tld = name.slice(name.lastIndexOf('.') + 1);
    const masked = `${token('domain', name)}.${/^[a-z]{2,63}$/.test(tld) ? tld : 'tld'}`;
    return wildcard ? `*.${masked}` : masked;
  };

  const text = (value: string, opts: { domains?: boolean } = {}): string => {
    let s = value;
    if (sessionRe) s = s.replace(sessionRe, '<session>');
    s = s.replace(RE.encodedEmail, '<email>');
    s = s.replace(RE.email, '<email>');
    s = s.replace(RE.accessKeyId, '<access-key-id>');
    s = s.replace(RE.iamUniqueId, (m) => token('iam-unique-id', m));
    s = s.replace(RE.uuid, (m) => token('uuid', m.toLowerCase()));
    s = s.replace(RE.mrk, (m) => token('kms-mrk', m));
    // Resource and organization IDs first: their hex may contain a run of 12 decimal digits.
    s = s.replace(RE.resourceId, (m, prefix: string) => token(prefix, m));
    s = s.replace(RE.ou, (m) => token('ou', m));
    s = s.replace(RE.org, (m) => token('org', m));
    s = s.replace(RE.root, (m) => token('org-root', m));
    s = s.replace(RE.scp, (m) => token('policy', m));
    s = s.replace(RE.twelveDigits, (m) => accountToken(m));
    s = s.replace(RE.separatedAccount, (_, a: string, b: string, c: string) =>
      accountToken(`${a}${b}${c}`),
    );
    if (opts.domains !== false) {
      s = s.replace(RE.dns, (m) => {
        if (/^(?:com|aws)\.amazonaws\./i.test(m) || isAwsDns(m)) return m;
        return domain(m);
      });
    }
    return s;
  };

  const truncate = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s);

  const keepPrefixes = options.keepNamePrefixes ?? [];
  const keepExtra = (kind: NameKind, value: string) =>
    (kind === 'stack' || kind === 'name') && keepPrefixes.some((p) => value.startsWith(p));
  const name = (kind: NameKind, value: string): string => {
    if (KEEP_NAME[kind](value) || keepExtra(kind, value)) return truncate(text(value));
    return kind === 'kms-alias' ? `alias/${token(kind, value)}` : token(kind, value);
  };

  const arn = (value: string): string => {
    const m = /^arn:(aws[a-z-]*):([a-z0-9-]*):([a-z0-9-]*):([^:]*):(.*)$/.exec(value);
    if (!m) return truncate(text(value));
    const [, partition, service, region, acct = '', resource = ''] = m;
    const acctOut =
      acct === '' || acct === 'aws'
        ? acct
        : /^\d{12}$/.test(acct)
          ? accountToken(acct)
          : text(acct);
    let res = resource;
    if (service === 'route53') {
      res = res.replace(
        /^(hostedzone\/)([A-Z0-9]{4,32})$/,
        (_, p: string, idv: string) => p + token('hostedzone', idv),
      );
    }
    // Workload names inside ARNs, masked like the name fields.
    if (service === 'cloudformation') {
      res = res.replace(
        /^(stack|stackset)\/([^/]+)/,
        (_, p: string, n: string) => `${p}/${name('stack', n)}`,
      );
    }
    if (service === 'wafv2') {
      res = res.replace(
        /^(.*\/webacl\/)([^/]+)/,
        (_, p: string, n: string) => p + name('web-acl', n),
      );
    }
    if (service === 'kms') res = res.replace(/^alias\/.+$/, (a) => name('kms-alias', a));
    return truncate(`arn:${partition}:${service}:${region}:${acctOut}:${text(res)}`);
  };

  return {
    sandboxAccount,
    sessionName,
    isSandboxAccount: (v) => v === sandboxAccount,
    account: (v) =>
      /^\d{12}$/.test(v) ? accountToken(v) : v === 'aws' || v === 'AWS' ? v : truncate(text(v)),
    arn,
    id: (kind, v) => token(kind, v),
    name,
    text: (v, opts) => truncate(text(v, opts)),
    domain: (v) => truncate(domain(v)),
    number: (n) => {
      if (!Number.isInteger(n) || String(Math.abs(n)).length !== 12) return n;
      const digits = String(Math.abs(n));
      return digits === sandboxAccount || maps.get('other-account')?.has(digits)
        ? accountToken(digits)
        : '<12-digit-number>';
    },
    console: (line, opts) => text(line, opts),
    maskSession: (v) => (sessionRe ? v.replace(sessionRe, '<session>') : v),
  };
}

/**
 * Console masking before the identity gate (no sanitizer yet): 12-digit runs, separated account
 * IDs and e-mail addresses.
 */
export const preGateConsoleMask = (line: string): string =>
  line
    .replace(RE.encodedEmail, '<email>')
    .replace(RE.email, '<email>')
    .replace(RE.twelveDigits, '<12-digit-number>')
    .replace(RE.separatedAccount, '<12-digit-number>');
