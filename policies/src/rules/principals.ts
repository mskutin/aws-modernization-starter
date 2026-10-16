/**
 * Principal allowlist shared by BASE-IAM-006 (role trust policies) and BASE-S3-002 (bucket
 * policies). Fail closed: a principal value passes only when it is a literal without
 * wildcards or a positively safe, ARN-building intrinsic; every other shape is a finding.
 * The Guard counterpart is the block between `BEGIN/END shared principal allowlist` markers
 * in `guard/rules/iam.guard` and `guard/rules/s3.guard` (a test keeps them identical).
 */
import type { CfnTemplateJson, Finding } from '../types.js';
import { asArray, finding, get, isRecord } from './util.js';

/** Keys of a `Principal` map that the principal allowlist accepts. */
export const PRINCIPAL_KEYS = ['AWS', 'Service', 'Federated', 'CanonicalUser'] as const;

/**
 * Pseudo parameters a principal may `Ref` (alone or in an ARN-building `Fn::Join`) or use as a
 * `${...}` variable in a string `Fn::Sub`. None can resolve to "*". Everything else, including
 * `AWS::NoValue` and `AWS::NotificationARNs`, fails. Keep in sync with
 * `guard/rules/{iam,s3}.guard` (a parity test enforces this).
 */
export const SAFE_PSEUDO_PARAMETERS = [
  'AWS::AccountId',
  'AWS::Partition',
  'AWS::Region',
  'AWS::URLSuffix',
] as const;

/**
 * Resource types whose `Ref` returns an IAM principal ARN (identity-provider ARNs for
 * `Federated`). A positive allowlist: custom resources, third-party registry
 * types and every other AWS type fail, because their values are not IAM principal ARNs and may
 * be set by a provider. Keep in sync with the Guard rule files (a parity test enforces this).
 */
export const PRINCIPAL_REF_TYPES = ['AWS::IAM::OIDCProvider', 'AWS::IAM::SAMLProvider'] as const;

/**
 * Resource types whose `Fn::GetAtt ... Arn` is an IAM principal ARN. Only the `Arn` attribute
 * is accepted, in list (`[id, "Arn"]`) or dotted-string (`"id.Arn"`, the YAML `!GetAtt` short
 * form) shape. Keep in sync with the Guard rule files (a parity test enforces this).
 */
export const PRINCIPAL_GETATT_ARN_TYPES = ['AWS::IAM::Role', 'AWS::IAM::User'] as const;

/** `*` and `?` are IAM wildcards; principals never legitimately contain them. */
const WILDCARD = /[*?]/;
/** Dotted-string `Fn::GetAtt` accepted in a principal: `<LogicalId>.Arn`. */
const DOTTED_GETATT_ARN = /^([A-Za-z0-9]+)\.Arn$/;
/**
 * String `Fn::Sub` accepted in a principal: a literal `arn:` prefix, no wildcard, and no
 * `${...}` other than the safe pseudo parameters. Mirrored in the Guard files.
 */
export const ARN_SUB_TEMPLATE = new RegExp(
  `^arn:([^*?$]|\\$\\{(${SAFE_PSEUDO_PARAMETERS.join('|')})\\})*$`,
);

const FAIL_CLOSED_HINT =
  'only literal principals and ARN-building Ref/Fn::GetAtt/Fn::Join/Fn::Sub are accepted';

/** Problem with a `Ref`/`Fn::GetAtt` target, or undefined when its type is allowlisted. */
function referencedResourceProblem(
  fn: string,
  target: string,
  template: CfnTemplateJson,
  types: readonly string[],
): string | undefined {
  const resources = template.Resources ?? {};
  const resource = Object.hasOwn(resources, target) ? resources[target] : undefined;
  if (!resource) {
    return `${fn} "${target}" is not a resource in this template or an accepted pseudo parameter (a parameter, mapping or import can resolve to "*")`;
  }
  if (!types.includes(resource.Type)) {
    return `${fn} "${target}" names a ${resource.Type}, not one of ${types.join(', ')} (custom resources and third-party types set their own values)`;
  }
  return undefined;
}

function refProblem(target: unknown, template: CfnTemplateJson): string | undefined {
  if (typeof target !== 'string') return 'Ref target is not a literal logical ID';
  if ((SAFE_PSEUDO_PARAMETERS as readonly string[]).includes(target)) return undefined;
  return referencedResourceProblem('Ref', target, template, PRINCIPAL_REF_TYPES);
}

function getAttProblem(args: unknown, template: CfnTemplateJson): string | undefined {
  let target: string;
  if (typeof args === 'string') {
    const m = DOTTED_GETATT_ARN.exec(args);
    if (!m?.[1]) return `Fn::GetAtt "${args}" is not "<logicalId>.Arn"`;
    target = m[1];
  } else if (
    Array.isArray(args) &&
    args.length === 2 &&
    typeof args[0] === 'string' &&
    typeof args[1] === 'string'
  ) {
    if (args[1] !== 'Arn') return `Fn::GetAtt attribute "${args[1]}" is not Arn`;
    target = args[0];
  } else {
    return 'Fn::GetAtt is not [logicalId, "Arn"] or "<logicalId>.Arn"';
  }
  return referencedResourceProblem('Fn::GetAtt', target, template, PRINCIPAL_GETATT_ARN_TYPES);
}

function joinProblem(args: unknown, template: CfnTemplateJson): string | undefined {
  if (!Array.isArray(args) || args.length !== 2) {
    return 'Fn::Join is not [delimiter, [parts]]';
  }
  const [delimiter, parts] = args as [unknown, unknown];
  if (typeof delimiter !== 'string' || WILDCARD.test(delimiter)) {
    return 'Fn::Join delimiter is not a literal string without wildcards';
  }
  if (!Array.isArray(parts)) return 'Fn::Join parts are not a literal list';
  const first: unknown = parts[0];
  const arnPrefix =
    typeof first === 'string' &&
    (first.startsWith('arn:') || (delimiter === ':' && first === 'arn'));
  if (!arnPrefix) return 'Fn::Join does not start with a literal "arn:" prefix';
  for (const part of parts) {
    if (typeof part === 'string') {
      if (WILDCARD.test(part)) return `Fn::Join part "${part}" contains a wildcard`;
      continue;
    }
    const problem = intrinsicProblem(part, template, ['Ref', 'Fn::GetAtt']);
    if (problem) return `Fn::Join part: ${problem}`;
  }
  return undefined;
}

/**
 * Problem with an intrinsic used as (part of) a trust principal, or undefined when it is
 * one of the positively safe shapes in `allowed`. Anything else fails closed.
 */
function intrinsicProblem(
  value: unknown,
  template: CfnTemplateJson,
  allowed: readonly string[],
): string | undefined {
  if (!isRecord(value)) return 'value is not a string or an intrinsic function';
  const keys = Object.keys(value);
  if (keys.length !== 1) return 'value is not a single intrinsic function';
  const fn = keys[0] ?? '';
  if (!allowed.includes(fn)) return `${fn} is not an accepted intrinsic (${FAIL_CLOSED_HINT})`;
  const args = value[fn];
  switch (fn) {
    case 'Ref':
      return refProblem(args, template);
    case 'Fn::GetAtt':
      return getAttProblem(args, template);
    case 'Fn::Join':
      return joinProblem(args, template);
    default: // Fn::Sub
      return typeof args === 'string' && ARN_SUB_TEMPLATE.test(args)
        ? undefined
        : `Fn::Sub is not the string form of a template starting with "arn:" without wildcards, using only \${${SAFE_PSEUDO_PARAMETERS.join('|')}}`;
  }
}

export interface PolicyStatementOptions {
  /** Message subject, e.g. "Trust policy" or "Bucket policy". */
  subject: string;
  /** Reject NotPrincipal in every statement (`any`) or only in Allow statements (`allow`). */
  notPrincipal: 'any' | 'allow';
}

/**
 * Findings for one policy statement. Fail closed (allowlist): an Allow statement passes only
 * when its `Principal` is a map of AWS/Service/Federated/CanonicalUser whose every value is a
 * literal string without wildcards, or one of the ARN-building intrinsic shapes accepted by
 * `intrinsicProblem`. Deny statements are not checked for principals. Mirrors the shared
 * principal block in `guard/rules/iam.guard` (BASE-IAM-006) and `guard/rules/s3.guard` (BASE-S3-002).
 */
export function policyStatementFindings(
  statement: unknown,
  path: string,
  template: CfnTemplateJson,
  { subject, notPrincipal }: PolicyStatementOptions,
): Finding[] {
  if (!isRecord(statement) || Object.keys(statement).some((k) => k.startsWith('Fn::'))) {
    return [
      finding(
        path,
        `${subject} statement is not a literal statement object (e.g. Fn::If); not accepted (fail closed).`,
      ),
    ];
  }
  const out: Finding[] = [];
  const effect = statement['Effect'];
  if (statement['NotPrincipal'] !== undefined && (notPrincipal === 'any' || effect === 'Allow')) {
    out.push(finding(`${path}/NotPrincipal`, `${subject} uses NotPrincipal.`));
  }
  if (effect !== 'Allow' && effect !== 'Deny') {
    out.push(finding(`${path}/Effect`, `${subject} Effect is not a literal "Allow" or "Deny".`));
  }
  if (effect !== 'Allow') return out;
  const at = `${path}/Principal`;
  const principal = statement['Principal'];
  if (principal === '*') {
    return [...out, finding(at, `${subject} allows a wildcard principal ("*").`)];
  }
  if (!isRecord(principal) || Object.keys(principal).length === 0) {
    return [
      ...out,
      finding(at, `${subject} Principal is not a map of ${PRINCIPAL_KEYS.join('/')}.`),
    ];
  }
  for (const key of Object.keys(principal)) {
    if (!(PRINCIPAL_KEYS as readonly string[]).includes(key)) {
      out.push(
        finding(
          at,
          `${subject} Principal key "${key}" is not accepted (fail closed; e.g. Fn::If).`,
        ),
      );
      continue;
    }
    const raw = principal[key];
    const values = Array.isArray(raw) ? raw : [raw];
    if (values.length === 0) out.push(finding(at, `${subject} principal ${key} has no values.`));
    for (const value of values) {
      if (typeof value === 'string') {
        if (WILDCARD.test(value)) {
          out.push(finding(at, `${subject} allows a wildcard principal (${key} "${value}").`));
        }
        continue;
      }
      const problem = intrinsicProblem(value, template, [
        'Ref',
        'Fn::GetAtt',
        'Fn::Join',
        'Fn::Sub',
      ]);
      if (problem) {
        out.push(
          finding(at, `${subject} principal ${key} is not accepted (fail closed): ${problem}.`),
        );
      }
    }
  }
  return out;
}

/** Findings for a policy document: it must carry a literal, non-empty `Statement`. */
export function policyDocumentFindings(
  doc: unknown,
  docPath: string,
  template: CfnTemplateJson,
  options: PolicyStatementOptions,
): Finding[] {
  const statements = asArray(get(doc, 'Statement'));
  if (statements.length === 0) {
    return [
      finding(
        docPath,
        `${options.subject} has no literal Statement list; not accepted (fail closed).`,
      ),
    ];
  }
  return statements.flatMap((s, i) =>
    policyStatementFindings(s, `${docPath}/Statement/${i}`, template, options),
  );
}
