/**
 * Sanitized, committable evidence: assembly, Prettier formatting (explicit options, see format.ts)
 * and a leak-scanned, exclusive write. Nothing is written when the leak scanner finds anything.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { formatText } from './format.ts';
import { scanText, scanValue, type LeakFinding, type LeakSecrets } from './leak.ts';
import {
  boundArgs,
  REQUIRED_GLOBAL_ARGS,
  type Placeholder,
  type PlaceholderValues,
  type ProbeDef,
} from './policy.ts';
import type { ExecutionProfile } from './sandbox.ts';
import type { Sanitizer } from './sanitize.ts';
import {
  AREAS,
  PROBE_STATUSES,
  type Area,
  type Json,
  type ProbeStatus,
  type Region,
} from './types.ts';

/**
 * 4: strict runs (gate summary, policy facts, provenance, masked workload names). Each call record
 * names its discovery area in `area` (one of `AREAS`) and `summary.byArea` counts statuses per area.
 * Schema 2 (strict) and 3 (personal sandbox) were the previous revision, which coded the area as a
 * single letter; this tool no longer writes them.
 */
export const EVIDENCE_SCHEMA_VERSION = 4;
/**
 * 5: schema 4 plus the execution profile. Written only by `--execution-profile personal-sandbox`
 * runs: top-level `executionProfile`, `gate.accepted`, `identity.principalArn`,
 * `identity.ownerAuthorization`, `identity.reasons.administratorEquivalent`, the
 * `personal-sandbox-accepted` assessment and the `administrator-equivalent` computed level. Strict
 * runs keep writing schema 4, unchanged (a schema-4 document is a strict run by definition).
 * Schema 3 was schema 2 plus the execution profile.
 */
export const PERSONAL_SANDBOX_SCHEMA_VERSION = 5;

export interface ProbeRecord {
  /** Call id: `<probe>[<qualifier>]@<region>` or `<probe>#<n>@<region>`. */
  readonly id: string;
  readonly probe: string;
  readonly area: Area;
  readonly phase: 'identity' | 'discovery';
  readonly region: Region;
  readonly iamAction: string;
  /** Command line rebuilt from the probe definition with masked values (see maskedCommand). */
  readonly command: string;
  readonly status: ProbeStatus;
  readonly errorCode?: string;
  readonly truncated: boolean;
  readonly attempts: number;
  readonly skipReason?: string;
  readonly data?: Json;
}

/** Derived facts about one policy of the caller's role; documents never leave the raw directory. */
export interface PolicyFactEvidence {
  readonly kind: 'aws-managed' | 'customer-managed' | 'inline';
  readonly name: string;
  readonly arn?: string;
  /** Managed-policy category, document classification, or `unreadable`. */
  readonly category: string;
  /** SHA-256 of the canonical (sorted-key) policy document. */
  readonly documentSha256?: string | null;
  readonly allowStatements?: number;
  readonly denyStatements?: number;
  /** Allowed actions outside the tool's allowlist (at most 50). */
  readonly nonAllowlistedActions?: readonly string[];
}

export type OrganizationStatus = 'member' | 'management' | 'not-in-org' | 'unknown';
export type ReadOnlyAssessment =
  | 'verified-read-only'
  | 'attested'
  | 'write-capable-accepted'
  /** personal-sandbox only: the owner authorized this identity in this account. */
  | 'personal-sandbox-accepted';
export type ComputedLevel =
  | 'verified-read-only'
  | 'read-only-data-capable'
  | 'unverified'
  | 'write-capable'
  /** personal-sandbox only (strict stops on it and writes no evidence). */
  | 'administrator-equivalent';

export interface IdentityEvidence {
  /** `********1234`. */
  readonly account: string;
  readonly principalType: 'assumed-role';
  /** Permission-set name for IAM Identity Center roles, otherwise the role name. */
  readonly role: string;
  /** From the role path (`/aws-reserved/sso.amazonaws.com/`), not from the name. */
  readonly roleKind: 'iam-identity-center-permission-set' | 'iam-role' | 'unknown';
  readonly sessionName: '<masked>';
  /** What the run was allowed on: verified, a human attestation, or a human acceptance. */
  readonly readOnlyAssessment: ReadOnlyAssessment;
  /** What the gate computed from the policies it could read. */
  readonly computedLevel: ComputedLevel;
  /** An override was given although the identity verified read-only. */
  readonly overrideUnused?: true;
  readonly policies: readonly PolicyFactEvidence[];
  readonly permissionsBoundary: string | null;
  readonly reasons: {
    readonly writeCapable: readonly string[];
    readonly dataCapable: readonly string[];
    readonly unverified: readonly string[];
    /** personal-sandbox only: why the identity is administrator-equivalent. */
    readonly administratorEquivalent?: readonly string[];
  };
  /** `--attest-read-only`, verbatim (session name masked). */
  readonly attestation?: string;
  /** `--accept-write-capable`, verbatim (session name masked). */
  readonly acceptance?: string;
  /** personal-sandbox only. */
  readonly executionProfile?: 'personal-sandbox';
  /** personal-sandbox only: the caller ARN, account `********1234`, session `<session>`. */
  readonly principalArn?: string;
  /** personal-sandbox only: `--owner-authorization`, verbatim (session name masked). */
  readonly ownerAuthorization?: string;
  /** personal-sandbox only, when the assessment is `personal-sandbox-accepted`. */
  readonly accepted?: 'personal-sandbox';
  readonly note: string;
  readonly organization: {
    readonly status: OrganizationStatus;
    readonly organizationId?: string;
    readonly managementAccount?: string;
    readonly featureSet?: string;
    readonly errorCode?: string;
  };
  readonly recheck?: { readonly status: 'same-principal' | 'failed'; readonly errorCode?: string };
}

export interface ToolProvenance {
  readonly name: string;
  readonly version: string;
  /** HEAD of the checkout (not necessarily the code that ran: see sourceSha256 and gitDirty). */
  readonly gitCommit: string;
  /** SHA-256 over package.json and src/*.ts of the code that ran. */
  readonly sourceSha256: string;
  readonly gitDirty: boolean | 'unknown';
  readonly gitDirtyReason?: string;
}

export interface AwsCliProvenance {
  readonly version: string;
  readonly verifiedAgainst: string;
  /** Where it was found (home directory and user names masked). */
  readonly path: string;
  readonly realpath: string;
  /** SHA-256 of the executable entry point (for Nix: the wrapper, which names its store paths). */
  readonly sha256: string;
}

export interface EvidenceInput {
  readonly command: 'identity' | 'discover';
  /** Omitted (or `strict`) for strict runs: schema 4, unchanged. */
  readonly executionProfile?: ExecutionProfile | undefined;
  readonly complete: boolean;
  readonly incompleteReason?: string | undefined;
  readonly tool: ToolProvenance;
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly awsCli: AwsCliProvenance;
  readonly regions: { readonly workload: Region; readonly global: Region };
  readonly childEnvironment: {
    readonly passedThroughNames: readonly string[];
    readonly fixed: Readonly<Record<string, string>>;
  };
  readonly inputs: { readonly [key: string]: Json };
  readonly identity: IdentityEvidence;
  readonly probes: readonly ProbeRecord[];
}

export function summarize(probes: readonly ProbeRecord[]) {
  const zero = () =>
    Object.fromEntries(PROBE_STATUSES.map((s) => [s, 0])) as Record<ProbeStatus, number>;
  const byStatus = zero();
  const byArea = Object.fromEntries(AREAS.map((a) => [a, zero()])) as Record<
    Area,
    Record<ProbeStatus, number>
  >;
  for (const p of probes) {
    byStatus[p.status] += 1;
    byArea[p.area][p.status] += 1;
  }
  return { calls: probes.length, byStatus, byArea };
}

export const EVIDENCE_NOTES: readonly string[] = [
  'The tool issued only the allowlisted get-/list-/describe- AWS CLI calls recorded below (plus a local `aws --version`). Before starting the AWS CLI it refused any configuration in $HOME/.aws that could replace, extend or redirect a call (README "Trust assumptions"); it cannot observe what the CLI or the environment did beyond that.',
  'gate.readOnlyAssessment: verified-read-only = only metadata-only AWS managed policies and policies that allow nothing but the allowlisted actions; attested = a human statement, not a verification; write-capable-accepted = a human accepted a write-capable identity for this run, so the read-only guarantee rests on the tool alone.',
  'gate.organization: unknown means DescribeOrganization was denied; membership (and "not the management account") is then NOT evidenced.',
  'access-denied means UNKNOWN visibility for this identity, not absence of the resource.',
  'Sanitized output: see tools/aws-preflight/README.md (Sanitization). Raw responses stay in the operator-private raw directory.',
];

/** Added to the notes of personal-sandbox evidence (schema 5). */
export const PERSONAL_SANDBOX_NOTE =
  'executionProfile personal-sandbox: an ordinary, dedicated sandbox account, NOT a governed account. The account owner authorized the operator identity (gate.accepted, identity.ownerAuthorization), which may be administrator-equivalent; nothing on the AWS side keeps this run read-only, the read-only guarantee rests entirely on the tool (allowlist, exec boundary, configuration refusals). Says nothing about compliance with the controls of any organization.';

export function buildEvidence(input: EvidenceInput) {
  const { identity } = input;
  const personal = input.executionProfile === 'personal-sandbox';
  return {
    schemaVersion: personal ? PERSONAL_SANDBOX_SCHEMA_VERSION : EVIDENCE_SCHEMA_VERSION,
    kind: 'starter-aws-preflight-evidence',
    ...(personal ? { executionProfile: 'personal-sandbox' as const } : {}),
    command: input.command,
    complete: input.complete,
    ...(input.incompleteReason ? { incompleteReason: input.incompleteReason } : {}),
    gate: {
      organization: identity.organization.status,
      readOnlyAssessment: identity.readOnlyAssessment,
      computedLevel: identity.computedLevel,
      ...(identity.accepted ? { accepted: identity.accepted } : {}),
      roleKind: identity.roleKind,
      principalRecheck: identity.recheck?.status ?? 'not-run',
    },
    tool: input.tool,
    run: { id: input.runId, startedAt: input.startedAt, finishedAt: input.finishedAt },
    awsCli: input.awsCli,
    regions: input.regions,
    childEnvironment: input.childEnvironment,
    inputs: input.inputs,
    notes: personal ? [...EVIDENCE_NOTES, PERSONAL_SANDBOX_NOTE] : EVIDENCE_NOTES,
    identity,
    summary: summarize(input.probes),
    probes: input.probes,
  };
}

/** Formats JSON with the repository's Prettier options (no configuration file is resolved). */
export async function formatJson(value: unknown): Promise<string> {
  const json = `${JSON.stringify(value, null, 2)}\n`;
  try {
    return await formatText(json, 'json');
  } catch {
    return json;
  }
}

export type WriteOutcome =
  | { readonly written: true; readonly path: string }
  | { readonly written: false; readonly findings: readonly LeakFinding[] };

/**
 * Leak-scans the object and the formatted text; writes (exclusive create) only when both are clean.
 */
export async function writeEvidence(
  path: string,
  evidence: unknown,
  secrets: LeakSecrets,
): Promise<WriteOutcome> {
  const findings = scanValue(evidence, secrets);
  if (findings.length > 0) return { written: false, findings };
  if (existsSync(path)) throw new Error(`refusing to overwrite ${path}`);
  const text = await formatJson(evidence);
  const textFindings = scanText(text, secrets);
  if (textFindings.length > 0) return { written: false, findings: textFindings };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { flag: 'wx' });
  return { written: true, path };
}

/** How each interpolated value is shown in the evidence `command`. */
const MASKED_VALUE: Readonly<Record<Placeholder, (value: string, s: Sanitizer) => string>> = {
  account: () => '<account>',
  qualifier: (v) => v,
  vpcId: (v, s) => s.text(v),
  kmsKeyRef: (v, s) => s.name('kms-alias', v),
  boundaryPolicyArn: (v, s) => s.arn(v),
  customerPolicyArn: (v, s) => s.arn(v),
  policyVersionId: (v) => v,
  dbEngineVersion: (v) => v,
  budgetName: (v, s) => s.name('budget', v),
  roleName: (v, s) => s.text(v),
  policyName: (v, s) => s.text(v),
};

const quote = (t: string) =>
  /^[A-Za-z0-9_.:/=,@+%<>{}*-]+$/.test(t) ? t : `'${t.replace(/'/g, `'\\''`)}'`;

/**
 * The command line of one call, rebuilt from the probe definition: static arguments verbatim,
 * interpolated values masked like the data (accounts, names of unrelated workloads, domains),
 * `--profile <profile>`.
 */
export function maskedCommand(
  def: ProbeDef,
  values: PlaceholderValues,
  region: Region,
  s: Sanitizer,
): string {
  const render = (tokens: readonly string[]) =>
    tokens.map((token) =>
      token.replace(/\{([A-Za-z]+)\}/g, (_, name: string) => {
        const value = values[name as Placeholder];
        const mask = MASKED_VALUE[name as Placeholder];
        return value === undefined || !mask ? `<${name}>` : mask(value, s);
      }),
    );
  const parts = [
    def.service,
    def.operation,
    ...render(def.args),
    ...(def.vpcFilter && values.vpcId !== undefined ? render(def.vpcFilter) : []),
    ...boundArgs(def.bound),
    '--profile',
    '<profile>',
    '--region',
    region,
    ...REQUIRED_GLOBAL_ARGS,
  ];
  return `aws ${parts.map(quote).join(' ')}`;
}

/** Local paths in evidence and console: home directory -> `~`, user names -> `<user>`. */
export function maskLocalPath(path: string, home: string | undefined): string {
  let p = path;
  if (home && home !== '/' && (p === home || p.startsWith(`${home}/`))) {
    p = `~${p.slice(home.length)}`;
  }
  return p
    .replace(/^\/(Users|home)\/[^/]+(?=\/|$)/, '/$1/<user>')
    .replace(/\/per-user\/[^/]+(?=\/|$)/, '/per-user/<user>');
}
