/**
 * Identity gate, in this order; any failure stops the run before discovery (and nothing is
 * written to the evidence file):
 *   1. sts get-caller-identity: account == --expected-account (else exit 3, after exactly this
 *      one call); principal is an assumed role (root / IAM user / federated user: exit 4) whose
 *      name matches --expected-role-pattern (else exit 4).
 *   2. The caller's own role: get-role, list-attached-role-policies, list-role-policies, then the
 *      document of every inline policy (get-role-policy) and of every attached customer managed
 *      policy (get-policy + get-policy-version), at most 10 each. Assessment (see assess()):
 *        - hard stop (exit 5, no override): AdministratorAccess*, IAMFullAccess,
 *          AWSOrganizationsFullAccess, or an administrator-equivalent inline/customer policy;
 *        - verified-read-only: only metadata-only AWS managed policies and inline/customer
 *          policies that allow nothing but this tool's allowlisted actions (Deny is fine);
 *        - read-only-data-capable or unverified: needs --attest-read-only (human-written);
 *        - write-capable (incl. ReadOnlyAccess): needs --accept-write-capable (human decision),
 *          and only when the policy lists and documents were all readable.
 *   3. organizations describe-organization (us-east-1): management account or no organization:
 *      exit 7; AccessDenied: UNKNOWN, continue; any other failure: exit 7 (fail closed).
 * Expired or invalid credentials at any step: exit 6, never retried.
 *
 * `personal-sandbox` execution profile (sandbox.ts): steps 1 and 3 are unchanged; step 2 computes
 * the same assessment, but every level, administrator-equivalent included, is accepted on the
 * owner's `--owner-authorization` (validated by the caller), and the evidence records the level,
 * `accepted: personal-sandbox`, the masked principal ARN and the authorization verbatim.
 */
import { BOUNDARY_OPERATIONS } from './boundary.ts';
import { recordOf, runCall, type CallOutcome, type RunContext } from './calls.ts';
import type { Classified } from './errors.ts';
import type { IdentityEvidence, PolicyFactEvidence, ProbeRecord } from './evidence.ts';
import { analyzePolicyDocument, type DocFacts } from './policydoc.ts';
import { MAX_POLICY_DOCUMENTS } from './probes.ts';
import { maskPrincipalArn, SANDBOX_KEEP_NAME_PREFIXES, type ExecutionProfile } from './sandbox.ts';
import { createSanitizer, type Sanitizer } from './sanitize.ts';
import { EXIT, GLOBAL_REGION, isRecord, type ExitCode } from './types.ts';
import { maskAccount, PATTERNS } from './validate.ts';

// ── AWS managed policies (documents checked 2026-10-14 in the AWS managed policy reference) ──

export type ManagedCategory =
  'metadata-only' | 'data-capable' | 'read-all' | 'write-capable' | 'hard-stop';

/**
 * Reviewed AWS managed policies. Everything not listed is treated as write-capable.
 * - metadata-only: no workload-data, secret or state-changing reads. AWSBudgetsReadOnlyAccess v2
 *   (aws-portal:ViewBilling, budgets:ViewBudget, budgets:Describe*, budgets:ListTagsForResource) and
 *   ServiceQuotasReadOnlyAccess v5 (quotas and account limits, CloudWatch alarms and metric data,
 *   tag keys/values, notification contacts and organizations:DescribeAccount, i.e. contact e-mail
 *   addresses). Like budgets:ViewBudget in the tool's own policy, they can read contact metadata.
 * - data-capable: read-only, but can read data or secrets: ViewOnlyAccess (ecs:Describe* incl.
 *   task-definition environments, apigateway:GET), SecurityAudit (lambda:GetFunctionConfiguration,
 *   iam:GetCredentialReport, cloudformation:GetTemplate, kms:GetKeyPolicy,
 *   rds:DownloadDBLogFilePortion), AWSOrganizationsReadOnlyAccess (account contact information).
 * - read-all: ReadOnlyAccess (s3:Get*, dynamodb:Query/Scan, logs:Get*, ssm:Get*, and
 *   sqs:Receive*, which changes queue state).
 * - hard-stop: AdministratorAccess (and AdministratorAccess-*), IAMFullAccess,
 *   AWSOrganizationsFullAccess.
 */
export const MANAGED_POLICY_CATEGORY: ReadonlyMap<string, ManagedCategory> = new Map([
  ['arn:aws:iam::aws:policy/AWSBudgetsReadOnlyAccess', 'metadata-only'],
  ['arn:aws:iam::aws:policy/ServiceQuotasReadOnlyAccess', 'metadata-only'],
  ['arn:aws:iam::aws:policy/job-function/ViewOnlyAccess', 'data-capable'],
  ['arn:aws:iam::aws:policy/SecurityAudit', 'data-capable'],
  ['arn:aws:iam::aws:policy/AWSOrganizationsReadOnlyAccess', 'data-capable'],
  ['arn:aws:iam::aws:policy/ReadOnlyAccess', 'read-all'],
  ['arn:aws:iam::aws:policy/PowerUserAccess', 'write-capable'],
  ['arn:aws:iam::aws:policy/AdministratorAccess', 'hard-stop'],
  ['arn:aws:iam::aws:policy/IAMFullAccess', 'hard-stop'],
  ['arn:aws:iam::aws:policy/AWSOrganizationsFullAccess', 'hard-stop'],
]);

export function managedPolicyCategory(arn: string): ManagedCategory {
  const known = MANAGED_POLICY_CATEGORY.get(arn);
  if (known) return known;
  const name = arn.slice(arn.lastIndexOf('/') + 1);
  // AdministratorAccess-Amplify, AdministratorAccess-AWSElasticBeanstalk, ...
  if (name.startsWith('AdministratorAccess')) return 'hard-stop';
  return 'write-capable';
}

const AWS_MANAGED_PREFIX = 'arn:aws:iam::aws:policy/';

/** IAM actions of the tool's allowlist (from the independent boundary list). */
export const ALLOWLISTED_IAM_ACTIONS: ReadonlySet<string> = new Set(
  BOUNDARY_OPERATIONS.map((entry) => entry.slice(entry.lastIndexOf(' ') + 1)),
);

// ── Principal ────────────────────────────────────────────────────────────────────────────────

export type Principal =
  | { readonly type: 'assumed-role'; readonly roleName: string; readonly sessionName: string }
  | { readonly type: 'root' | 'iam-user' | 'federated-user' | 'other' };

export function parsePrincipal(arn: string, account: string): Principal {
  const m = /^arn:aws:(sts|iam)::(\d{12}):(.+)$/.exec(arn);
  if (!m || m[2] !== account) return { type: 'other' };
  const service = m[1];
  const resource = m[3] ?? '';
  if (service === 'iam' && resource === 'root') return { type: 'root' };
  if (service === 'iam' && resource.startsWith('user/')) return { type: 'iam-user' };
  if (service === 'sts' && resource.startsWith('federated-user/'))
    return { type: 'federated-user' };
  const role = /^assumed-role\/([^/]+)\/(.+)$/.exec(resource);
  if (service === 'sts' && role?.[1] && role[2]) {
    return { type: 'assumed-role', roleName: role[1], sessionName: role[2] };
  }
  return { type: 'other' };
}

// ── Assessment ───────────────────────────────────────────────────────────────────────────────

export type Level =
  'verified-read-only' | 'read-only-data-capable' | 'unverified' | 'write-capable' | 'hard-stop';

const LEVEL_ORDER: readonly Level[] = [
  'verified-read-only',
  'read-only-data-capable',
  'unverified',
  'write-capable',
  'hard-stop',
];
const worse = (a: Level, b: Level): Level =>
  LEVEL_ORDER.indexOf(b) > LEVEL_ORDER.indexOf(a) ? b : a;

export interface PolicyFact {
  readonly kind: 'aws-managed' | 'customer-managed' | 'inline';
  readonly name: string;
  readonly arn?: string;
  /** Managed category, document classification, or `unreadable`. */
  readonly category: string;
  readonly documentSha256?: string | null;
  readonly allowStatements?: number;
  readonly denyStatements?: number;
  readonly nonAllowlistedActions?: readonly string[];
}

export interface DocumentRead {
  readonly kind: 'customer-managed' | 'inline';
  readonly name: string;
  readonly arn?: string;
  /** The analysed document, or why it could not be read. */
  readonly result: DocFacts | { readonly unreadable: string };
}

export interface Assessment {
  readonly level: Level;
  readonly hardStops: readonly string[];
  readonly writeCapable: readonly string[];
  readonly dataCapable: readonly string[];
  readonly unverified: readonly string[];
  /** Policy lists complete and every inline/customer document read and parsed. */
  readonly adminRuledOut: boolean;
  readonly facts: readonly PolicyFact[];
  readonly roleKind: 'iam-identity-center-permission-set' | 'iam-role' | 'unknown';
  readonly boundaryArn: string | null;
}

const failure = (what: string, c: Classified) =>
  `${what}: ${c.kind} (${'code' in c ? c.code : ''})`;

const nameOfArn = (arn: string) => arn.slice(arn.lastIndexOf('/') + 1);

export function assess(input: {
  role: Classified;
  managed: Classified;
  inline: Classified;
  documents: readonly DocumentRead[];
}): Assessment {
  let level: Level = 'verified-read-only';
  const hardStops: string[] = [];
  const writeCapable: string[] = [];
  const dataCapable: string[] = [];
  const unverified: string[] = [];
  const facts: PolicyFact[] = [];
  let adminRuledOut = true;
  const raise = (to: Level) => (level = worse(level, to));

  const { managed, inline, role } = input;
  if (
    managed.kind === 'ok' &&
    isRecord(managed.data) &&
    Array.isArray(managed.data['AttachedPolicies'])
  ) {
    if (managed.truncated) {
      unverified.push('the managed policy list is truncated');
      adminRuledOut = false;
      raise('unverified');
    }
    for (const p of managed.data['AttachedPolicies']) {
      const arn = isRecord(p) ? p['PolicyArn'] : undefined;
      if (typeof arn !== 'string') {
        unverified.push('a managed policy without an ARN');
        adminRuledOut = false;
        raise('unverified');
        continue;
      }
      if (!arn.startsWith(AWS_MANAGED_PREFIX)) continue; // customer managed: see documents
      const category = managedPolicyCategory(arn);
      const name = arn.slice(AWS_MANAGED_PREFIX.length);
      facts.push({ kind: 'aws-managed', name, arn, category });
      if (category === 'hard-stop') {
        hardStops.push(`AWS managed policy ${name}`);
        raise('hard-stop');
      } else if (category === 'write-capable' || category === 'read-all') {
        writeCapable.push(
          category === 'read-all'
            ? `AWS managed policy ${name} (reads data and changes SQS state)`
            : MANAGED_POLICY_CATEGORY.has(arn)
              ? `AWS managed policy ${name}`
              : `AWS managed policy ${name} (not in the reviewed list; treated as write-capable)`,
        );
        raise('write-capable');
      } else if (category === 'data-capable') {
        dataCapable.push(`AWS managed policy ${name}`);
        raise('read-only-data-capable');
      }
    }
  } else {
    unverified.push(failure('list-attached-role-policies', managed));
    adminRuledOut = false;
    raise('unverified');
  }

  if (inline.kind === 'ok' && isRecord(inline.data) && Array.isArray(inline.data['PolicyNames'])) {
    if (inline.truncated) {
      unverified.push('the inline policy list is truncated');
      adminRuledOut = false;
      raise('unverified');
    }
  } else {
    unverified.push(failure('list-role-policies', inline));
    adminRuledOut = false;
    raise('unverified');
  }

  for (const doc of input.documents) {
    const label = `${doc.kind === 'inline' ? 'inline' : 'customer managed'} policy ${doc.name}`;
    if ('unreadable' in doc.result) {
      facts.push({
        kind: doc.kind,
        name: doc.name,
        ...(doc.arn ? { arn: doc.arn } : {}),
        category: 'unreadable',
      });
      unverified.push(`${label}: ${doc.result.unreadable}`);
      adminRuledOut = false;
      raise('unverified');
      continue;
    }
    const f = doc.result;
    facts.push({
      kind: doc.kind,
      name: doc.name,
      ...(doc.arn ? { arn: doc.arn } : {}),
      category: f.classification,
      documentSha256: f.sha256,
      allowStatements: f.allowStatements,
      denyStatements: f.denyStatements,
      nonAllowlistedActions: f.nonAllowlistedActions,
    });
    switch (f.classification) {
      case 'admin-equivalent':
        hardStops.push(`${label} is administrator-equivalent`);
        raise('hard-stop');
        break;
      case 'write-capable':
        writeCapable.push(`${label} allows ${f.nonAllowlistedActions.slice(0, 5).join(', ')}`);
        raise('write-capable');
        break;
      case 'read-only-data-capable':
        dataCapable.push(
          `${label} allows reads outside the allowlist (${f.nonAllowlistedActions.slice(0, 5).join(', ')})`,
        );
        raise('read-only-data-capable');
        break;
      case 'unparseable':
        unverified.push(`${label} could not be parsed`);
        adminRuledOut = false;
        raise('unverified');
        break;
      default:
        break;
    }
  }

  let roleKind: Assessment['roleKind'] = 'unknown';
  let boundaryArn: string | null = null;
  if (role.kind === 'ok' && isRecord(role.data) && isRecord(role.data['Role'])) {
    const r = role.data['Role'];
    const path = typeof r['Path'] === 'string' ? r['Path'] : '';
    roleKind = path.startsWith('/aws-reserved/sso.amazonaws.com/')
      ? 'iam-identity-center-permission-set'
      : 'iam-role';
    const pb = r['PermissionsBoundary'];
    const pbArn = isRecord(pb) ? pb['PermissionsBoundaryArn'] : undefined;
    boundaryArn = typeof pbArn === 'string' ? pbArn : null;
  } else {
    unverified.push(failure('get-role', role));
    raise('unverified');
  }
  return {
    level,
    hardStops,
    writeCapable,
    dataCapable,
    unverified,
    adminRuledOut,
    facts,
    roleKind,
    boundaryArn,
  };
}

// ── Gate ─────────────────────────────────────────────────────────────────────────────────────

export type GateResult =
  | {
      readonly ok: true;
      readonly account: string;
      readonly callerArn: string;
      readonly roleName: string;
      readonly sanitizer: Sanitizer;
      readonly identity: IdentityEvidence;
      readonly records: readonly ProbeRecord[];
    }
  | { readonly ok: false; readonly exit: ExitCode; readonly message: string };

export interface GateOptions {
  readonly expectedAccount: string;
  readonly rolePattern: RegExp;
  readonly rolePatternText: string;
  /** `--attest-read-only`: a human statement that the identity is read-only. */
  readonly attestation?: string | undefined;
  /** `--accept-write-capable`: a human decision to run with a write-capable identity. */
  readonly acceptance?: string | undefined;
  /** Default `strict`. */
  readonly executionProfile?: ExecutionProfile | undefined;
  /** personal-sandbox: the account owner's statement (required there, refused in strict). */
  readonly ownerAuthorization?: string | undefined;
  readonly log: (line: string) => void;
}

const credentialsStop = (profileLabel: string, code: string): GateResult => ({
  ok: false,
  exit: EXIT.CREDENTIALS,
  message: `CREDENTIALS — the AWS session is expired or invalid (${code}). Run: aws sso login --profile ${profileLabel}`,
});

/** Common handling of credential failures and interrupts for every gate call. */
function stopFor(outcome: CallOutcome, profileLabel: string): GateResult | undefined {
  const c = outcome.classified;
  if (c.kind === 'credentials') return credentialsStop(profileLabel, c.code);
  if (c.kind === 'interrupted')
    return { ok: false, exit: EXIT.INTERRUPTED, message: 'interrupted' };
  return undefined;
}

const NOTE =
  'verified-read-only: only metadata-only AWS managed policies and inline/customer policies that allow nothing but the allowlisted actions. attested: an operator statement recorded verbatim, NOT a verification. write-capable-accepted: a human accepted a write-capable identity for this run; the read-only guarantee then rests on the tool alone (allowlist, exec boundary, configuration refusals).';
const PERSONAL_SANDBOX_NOTE =
  'personal-sandbox-accepted: the account owner authorized this identity (ownerAuthorization, recorded verbatim) for this dedicated sandbox account only; computedLevel is what the gate computed and may be administrator-equivalent. The read-only guarantee rests entirely on the tool (allowlist, exec boundary, configuration refusals). verified-read-only: as in the strict profile.';

export async function runIdentityGate(
  ctx: RunContext,
  options: GateOptions & { readonly profileLabel: string },
): Promise<GateResult> {
  const { log } = options;
  const personal = options.executionProfile === 'personal-sandbox';
  // ── 1. caller ──────────────────────────────────────────────────────────────────────────────
  const caller = await runCall(
    ctx,
    `identity.caller@${ctx.executor.workloadRegion}`,
    { probeId: 'identity.caller', region: ctx.executor.workloadRegion, values: {} },
    { persistRaw: false },
  );
  const stop1 = stopFor(caller, options.profileLabel);
  if (stop1) return stop1;
  const c1 = caller.classified;
  if (c1.kind !== 'ok') {
    return {
      ok: false,
      exit: EXIT.ERROR,
      message: `STOP — identity could not be established (${failure('sts get-caller-identity', c1)}).`,
    };
  }
  const account = isRecord(c1.data) ? c1.data['Account'] : undefined;
  const callerArn = isRecord(c1.data) ? c1.data['Arn'] : undefined;
  if (
    typeof account !== 'string' ||
    !PATTERNS.account.test(account) ||
    typeof callerArn !== 'string'
  ) {
    return {
      ok: false,
      exit: EXIT.ERROR,
      message: 'STOP — unexpected sts get-caller-identity output.',
    };
  }
  if (account !== options.expectedAccount) {
    return {
      ok: false,
      exit: EXIT.ACCOUNT_MISMATCH,
      message: `ACCOUNT MISMATCH — STOP. The profile resolves to account ${maskAccount(account)}, expected ${maskAccount(options.expectedAccount)}. Only sts get-caller-identity was called; nothing was written.`,
    };
  }
  caller.persist();
  const principal = parsePrincipal(callerArn, account);
  if (principal.type !== 'assumed-role') {
    const why = {
      root: 'the account root user',
      'iam-user': 'an IAM user (long-lived access keys)',
      'federated-user': 'a federated user (GetFederationToken, derived from long-lived keys)',
      other: 'an unexpected principal type',
    }[principal.type];
    return {
      ok: false,
      exit: EXIT.PRINCIPAL_REJECTED,
      message: `REJECTED — the caller is ${why}. Use an IAM Identity Center (SSO) role session.`,
    };
  }
  const s = createSanitizer({
    sandboxAccount: account,
    sessionName: principal.sessionName,
    ...(personal ? { keepNamePrefixes: SANDBOX_KEEP_NAME_PREFIXES } : {}),
  });
  if (
    !PATTERNS.roleName.test(principal.roleName) ||
    !options.rolePattern.test(principal.roleName)
  ) {
    return {
      ok: false,
      exit: EXIT.PRINCIPAL_REJECTED,
      message: s.console(
        `REJECTED — role ${principal.roleName} does not match --expected-role-pattern ${options.rolePatternText}.`,
      ),
    };
  }
  log(
    s.console(
      `  [1/3] caller: account ${maskAccount(account)} (expected), assumed role ${principal.roleName} (matches the pattern)`,
    ),
  );

  // ── 2. own-role privilege check ────────────────────────────────────────────────────────────
  const roleName = principal.roleName;
  const outcomes: CallOutcome[] = [caller];
  const call = async (callId: string, probeId: string, values: Record<string, string>) => {
    const out = await runCall(ctx, callId, {
      probeId,
      region: ctx.executor.workloadRegion,
      values,
    });
    outcomes.push(out);
    return out;
  };
  const role = await call(`identity.role@${ctx.executor.workloadRegion}`, 'identity.role', {
    roleName,
  });
  const stop2a = stopFor(role, options.profileLabel);
  if (stop2a) return stop2a;
  const managed = await call(
    `identity.role-managed-policies@${ctx.executor.workloadRegion}`,
    'identity.role-managed-policies',
    { roleName },
  );
  const stop2b = stopFor(managed, options.profileLabel);
  if (stop2b) return stop2b;
  const inline = await call(
    `identity.role-inline-policies@${ctx.executor.workloadRegion}`,
    'identity.role-inline-policies',
    { roleName },
  );
  const stop2c = stopFor(inline, options.profileLabel);
  if (stop2c) return stop2c;

  const documents: DocumentRead[] = [];
  // Inline policy documents.
  const rawNames: unknown[] =
    inline.classified.kind === 'ok' &&
    isRecord(inline.classified.data) &&
    Array.isArray(inline.classified.data['PolicyNames'])
      ? inline.classified.data['PolicyNames']
      : [];
  // A name that is not a string cannot be read back: it keeps the identity unverified.
  const inlineNames = rawNames.map((n) => (typeof n === 'string' ? n : ''));
  for (const [i, name] of inlineNames.entries()) {
    if (i >= MAX_POLICY_DOCUMENTS) {
      documents.push({
        kind: 'inline',
        name,
        result: { unreadable: `more than ${MAX_POLICY_DOCUMENTS} inline policies` },
      });
      continue;
    }
    if (!PATTERNS.policyName.test(name)) {
      documents.push({
        kind: 'inline',
        name,
        result: { unreadable: 'name not usable as an argument' },
      });
      continue;
    }
    const out = await call(
      `identity.role-inline-policy#${i + 1}@${ctx.executor.workloadRegion}`,
      'identity.role-inline-policy',
      { roleName, policyName: name },
    );
    const stop = stopFor(out, options.profileLabel);
    if (stop) return stop;
    const c = out.classified;
    documents.push({
      kind: 'inline',
      name,
      result:
        c.kind === 'ok' && isRecord(c.data)
          ? analyzePolicyDocument(c.data['PolicyDocument'], ALLOWLISTED_IAM_ACTIONS)
          : { unreadable: failure('get-role-policy', c) },
    });
  }
  // Customer managed policy documents (default version).
  const attached =
    managed.classified.kind === 'ok' &&
    isRecord(managed.classified.data) &&
    Array.isArray(managed.classified.data['AttachedPolicies'])
      ? managed.classified.data['AttachedPolicies']
          .map((p) => (isRecord(p) ? p['PolicyArn'] : undefined))
          .filter((a): a is string => typeof a === 'string' && !a.startsWith(AWS_MANAGED_PREFIX))
      : [];
  for (const [i, arn] of attached.entries()) {
    const name = nameOfArn(arn);
    if (i >= MAX_POLICY_DOCUMENTS) {
      documents.push({
        kind: 'customer-managed',
        name,
        arn,
        result: { unreadable: `more than ${MAX_POLICY_DOCUMENTS} customer managed policies` },
      });
      continue;
    }
    if (!PATTERNS.customerPolicyArn.test(arn) || arn.split(':')[4] !== account) {
      documents.push({
        kind: 'customer-managed',
        name,
        arn,
        result: { unreadable: 'ARN not usable as an argument' },
      });
      continue;
    }
    const policy = await call(
      `identity.customer-policy#${i + 1}@${ctx.executor.workloadRegion}`,
      'identity.customer-policy',
      { customerPolicyArn: arn },
    );
    const stopP = stopFor(policy, options.profileLabel);
    if (stopP) return stopP;
    const pc = policy.classified;
    const version =
      pc.kind === 'ok' && isRecord(pc.data) && isRecord(pc.data['Policy'])
        ? pc.data['Policy']['DefaultVersionId']
        : undefined;
    if (typeof version !== 'string' || !PATTERNS.policyVersionId.test(version)) {
      documents.push({
        kind: 'customer-managed',
        name,
        arn,
        result: { unreadable: pc.kind === 'ok' ? 'no default version' : failure('get-policy', pc) },
      });
      continue;
    }
    const pv = await call(
      `identity.customer-policy-version#${i + 1}@${ctx.executor.workloadRegion}`,
      'identity.customer-policy-version',
      { customerPolicyArn: arn, policyVersionId: version },
    );
    const stopV = stopFor(pv, options.profileLabel);
    if (stopV) return stopV;
    const vc = pv.classified;
    documents.push({
      kind: 'customer-managed',
      name,
      arn,
      result:
        vc.kind === 'ok' && isRecord(vc.data) && isRecord(vc.data['PolicyVersion'])
          ? analyzePolicyDocument(vc.data['PolicyVersion']['Document'], ALLOWLISTED_IAM_ACTIONS)
          : { unreadable: failure('get-policy-version', vc) },
    });
  }

  const assessment = assess({
    role: role.classified,
    managed: managed.classified,
    inline: inline.classified,
    documents,
  });
  const list = (items: readonly string[]) => items.join('; ');
  if (assessment.level === 'hard-stop' && !personal) {
    return {
      ok: false,
      exit: EXIT.PRIVILEGE_CHECK_FAILED,
      message: s.console(
        `STOP — administrator-equivalent identity: ${list(assessment.hardStops)}. No override.`,
      ),
    };
  }
  let readOnlyAssessment: IdentityEvidence['readOnlyAssessment'];
  let overrideUnused = false;
  if (personal) {
    if (options.ownerAuthorization === undefined) {
      return {
        ok: false,
        exit: EXIT.PRIVILEGE_CHECK_FAILED,
        message: 'STOP — personal-sandbox needs the owner authorization (--owner-authorization).',
      };
    }
    readOnlyAssessment =
      assessment.level === 'verified-read-only'
        ? 'verified-read-only'
        : 'personal-sandbox-accepted';
  } else if (assessment.level === 'verified-read-only') {
    readOnlyAssessment = 'verified-read-only';
    overrideUnused = options.attestation !== undefined || options.acceptance !== undefined;
  } else if (options.acceptance !== undefined) {
    if (!assessment.adminRuledOut) {
      return {
        ok: false,
        exit: EXIT.PRIVILEGE_CHECK_FAILED,
        message: s.console(
          `STOP — --accept-write-capable needs complete policy lists and readable policy documents to rule out an administrator-equivalent identity; not possible: ${list(assessment.unverified)}.`,
        ),
      };
    }
    readOnlyAssessment = 'write-capable-accepted';
  } else if (options.attestation !== undefined) {
    if (assessment.level === 'write-capable') {
      return {
        ok: false,
        exit: EXIT.PRIVILEGE_CHECK_FAILED,
        message: s.console(
          `STOP — write-capable identity (${list(assessment.writeCapable)}) cannot be attested as read-only. A human decision is required: --accept-write-capable "<who, when, why>".`,
        ),
      };
    }
    readOnlyAssessment = 'attested';
  } else {
    const why = [...assessment.writeCapable, ...assessment.dataCapable, ...assessment.unverified];
    const next =
      assessment.level === 'write-capable'
        ? 'Use a read-only permission set (README), or record a human decision with --accept-write-capable "<who, when, why>".'
        : 'Use the generated permission set (README), or re-run with --attest-read-only "<permission set + who checked it>".';
    return {
      ok: false,
      exit: EXIT.PRIVILEGE_CHECK_FAILED,
      message: s.console(`STOP — ${assessment.level} identity: ${list(why)}. ${next}`),
    };
  }
  const computedLevel: IdentityEvidence['computedLevel'] =
    assessment.level === 'hard-stop' ? 'administrator-equivalent' : assessment.level;
  log(
    s.console(
      personal
        ? `  [2/3] own role: computed level ${computedLevel}; recorded as ${readOnlyAssessment} (execution profile personal-sandbox, owner authorization, this account only)`
        : `  [2/3] own role: computed level ${assessment.level}; recorded as ${readOnlyAssessment}${overrideUnused ? ' (the override was not needed)' : ''}`,
    ),
  );

  // ── 3. organization ────────────────────────────────────────────────────────────────────────
  const org = await runCall(ctx, `identity.organization@${GLOBAL_REGION}`, {
    probeId: 'identity.organization',
    region: GLOBAL_REGION,
    values: {},
  });
  outcomes.push(org);
  const stop3 = stopFor(org, options.profileLabel);
  if (stop3) return stop3;
  const c3 = org.classified;
  let organization: IdentityEvidence['organization'];
  if (c3.kind === 'org-not-in-use') {
    return {
      ok: false,
      exit: EXIT.ORGANIZATION,
      message:
        'STOP — not-in-org: the account is not a member of an AWS Organization (AWSOrganizationsNotInUseException); the sandbox must be an organization member account.',
    };
  } else if (c3.kind === 'ok') {
    const o =
      isRecord(c3.data) && isRecord(c3.data['Organization']) ? c3.data['Organization'] : undefined;
    const management = o?.['MasterAccountId'];
    if (typeof management !== 'string' || !PATTERNS.account.test(management)) {
      return {
        ok: false,
        exit: EXIT.ORGANIZATION,
        message:
          'STOP — organization membership could not be determined (no management account in the response).',
      };
    }
    if (management === account) {
      return {
        ok: false,
        exit: EXIT.ORGANIZATION,
        message:
          'STOP — management: this is the organization MANAGEMENT account. Never run discovery in the management account.',
      };
    }
    organization = {
      status: 'member',
      ...(typeof o?.['Id'] === 'string' ? { organizationId: s.text(o['Id']) } : {}),
      managementAccount: s.account(management),
      ...(typeof o?.['FeatureSet'] === 'string'
        ? { featureSet: s.text(o['FeatureSet'], { domains: false }) }
        : {}),
    };
  } else if (c3.kind === 'access-denied') {
    organization = { status: 'unknown', errorCode: c3.code };
  } else {
    return {
      ok: false,
      exit: EXIT.ORGANIZATION,
      message: `STOP — organization membership could not be determined (${failure('describe-organization', c3)}); re-run later.`,
    };
  }
  log(
    s.console(
      organization.status === 'member'
        ? `  [3/3] organization: member (management account ${organization.managementAccount ?? '?'})`
        : `  [3/3] organization: UNKNOWN (${organization.errorCode ?? ''}) — membership is not evidenced; continuing`,
    ),
  );

  const permissionSet =
    assessment.roleKind === 'iam-identity-center-permission-set'
      ? /^AWSReservedSSO_(.+)_[0-9a-f]{16}$/.exec(roleName)?.[1]
      : undefined;
  const policies: PolicyFactEvidence[] = assessment.facts.map((f) => ({
    kind: f.kind,
    name: f.kind === 'aws-managed' ? f.name : s.text(f.name),
    ...(f.arn ? { arn: f.kind === 'aws-managed' ? f.arn : s.arn(f.arn) } : {}),
    category: f.category,
    ...(f.documentSha256 !== undefined ? { documentSha256: f.documentSha256 } : {}),
    ...(f.allowStatements !== undefined ? { allowStatements: f.allowStatements } : {}),
    ...(f.denyStatements !== undefined ? { denyStatements: f.denyStatements } : {}),
    ...(f.nonAllowlistedActions ? { nonAllowlistedActions: [...f.nonAllowlistedActions] } : {}),
  }));
  const identity: IdentityEvidence = {
    account: maskAccount(account),
    principalType: 'assumed-role',
    role: s.text(permissionSet ?? roleName),
    roleKind: assessment.roleKind,
    sessionName: '<masked>',
    readOnlyAssessment,
    computedLevel,
    ...(overrideUnused ? { overrideUnused: true } : {}),
    policies,
    permissionsBoundary: assessment.boundaryArn ? s.arn(assessment.boundaryArn) : null,
    reasons: {
      writeCapable: assessment.writeCapable.map((r) => s.text(r)),
      dataCapable: assessment.dataCapable.map((r) => s.text(r)),
      unverified: assessment.unverified.map((r) => s.text(r)),
      ...(personal ? { administratorEquivalent: assessment.hardStops.map((r) => s.text(r)) } : {}),
    },
    ...(readOnlyAssessment === 'attested'
      ? { attestation: s.maskSession(options.attestation ?? '') }
      : {}),
    ...(readOnlyAssessment === 'write-capable-accepted'
      ? { acceptance: s.maskSession(options.acceptance ?? '') }
      : {}),
    ...(personal
      ? {
          executionProfile: 'personal-sandbox' as const,
          principalArn: maskPrincipalArn(callerArn),
          ownerAuthorization: s.maskSession(options.ownerAuthorization ?? ''),
          ...(readOnlyAssessment === 'personal-sandbox-accepted'
            ? { accepted: 'personal-sandbox' as const }
            : {}),
        }
      : {}),
    note: personal ? PERSONAL_SANDBOX_NOTE : NOTE,
    organization,
  };
  ctx.executor.unlockDiscovery();
  const records = outcomes.map((o) => recordOf(o, s));
  return { ok: true, account, callerArn, roleName, sanitizer: s, identity, records };
}
