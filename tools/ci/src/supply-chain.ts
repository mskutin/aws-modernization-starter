/**
 * Supply-chain lint:
 *  1. every CI image/service reference resolves to `<repo>:<tag>@sha256:<64 hex>`
 *  2. every Dockerfile/Containerfile FROM is digest-pinned
 *  3. every security exception (Trivy ignore file, license exceptions, SAST waivers, image
 *     release-age exceptions) is justified and expires within the allowed window
 */

export const DIGEST_PINNED =
  /^[a-z0-9.-]+(?::\d+)?\/[a-z0-9._/-]+:[A-Za-z0-9._-]+@sha256:[a-f0-9]{64}$/;
export const MAX_EXCEPTION_DAYS = 90;

export interface Finding {
  check: 'image-pin' | 'dockerfile-pin' | 'exception';
  subject: string;
  level: 'error' | 'warning';
  message: string;
}

export interface ImageRef {
  file: string;
  job: string;
  field: 'image' | 'services';
  raw: string;
}

function asName(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (
    value &&
    typeof value === 'object' &&
    typeof (value as { name?: unknown }).name === 'string'
  ) {
    return (value as { name: string }).name;
  }
  return undefined;
}

/** Collect image/services references from parsed CI YAML documents. */
export function collectImageRefs(
  docs: Array<{ file: string; doc: Record<string, unknown> }>,
): ImageRef[] {
  const refs: ImageRef[] = [];
  for (const { file, doc } of docs) {
    const visit = (job: string, body: unknown): void => {
      if (!body || typeof body !== 'object' || Array.isArray(body)) return;
      const b = body as Record<string, unknown>;
      const image = asName(b.image);
      if (image) refs.push({ file, job, field: 'image', raw: image });
      if (Array.isArray(b.services)) {
        for (const s of b.services) {
          const name = asName(s);
          if (name) refs.push({ file, job, field: 'services', raw: name });
        }
      }
    };
    for (const [key, body] of Object.entries(doc)) {
      if (key === 'variables' || key === 'include' || key === 'stages' || key === 'workflow')
        continue;
      if (key === 'image' || key === 'services') visit('(top level)', { [key]: body });
      else visit(key, body);
    }
  }
  return refs;
}

export function resolveVars(
  raw: string,
  vars: Record<string, string>,
): { value: string; unresolved: string[] } {
  const unresolved: string[] = [];
  const value = raw.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (_m, name: string) => {
    const v = vars[name];
    if (v === undefined) {
      unresolved.push(name);
      return `$${name}`;
    }
    return v;
  });
  return { value, unresolved };
}

/** Normalise short Docker Hub names so the pin regex can require an explicit registry. */
export function checkImageRefs(refs: ImageRef[], vars: Record<string, string>): Finding[] {
  const findings: Finding[] = [];
  for (const ref of refs) {
    const { value, unresolved } = resolveVars(ref.raw, vars);
    const subject = `${ref.file} ${ref.job} ${ref.field}`;
    if (unresolved.length > 0) {
      findings.push({
        check: 'image-pin',
        subject,
        level: 'error',
        message: `unresolved variable(s) ${unresolved.join(', ')} in "${ref.raw}"`,
      });
    } else if (!DIGEST_PINNED.test(value)) {
      findings.push({
        check: 'image-pin',
        subject,
        level: 'error',
        message: `"${value}" is not pinned as <registry>/<repo>:<tag>@sha256:<digest>`,
      });
    }
  }
  return findings;
}

export function checkImageVariables(vars: Record<string, string>, prefix = 'IMG_'): Finding[] {
  return Object.entries(vars)
    .filter(([k]) => k.startsWith(prefix))
    .flatMap(([k, v]): Finding[] => {
      if (!DIGEST_PINNED.test(v)) {
        return [
          {
            check: 'image-pin',
            subject: k,
            level: 'error',
            message: `"${v}" is not version+digest pinned`,
          },
        ];
      }
      if (/:latest@/.test(v)) {
        return [
          {
            check: 'image-pin',
            subject: k,
            level: 'error',
            message: `"${v}" uses the mutable "latest" tag`,
          },
        ];
      }
      return [];
    });
}

/** Check FROM lines of a Dockerfile. ARG defaults declared before FROM are resolved. */
export function checkDockerfile(file: string, content: string): Finding[] {
  const findings: Finding[] = [];
  const args: Record<string, string> = {};
  const stages = new Set<string>();
  const lines = content.replace(/\\\r?\n/g, ' ').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    const arg = /^ARG\s+([A-Za-z_][A-Za-z0-9_]*)(?:=(.*))?$/i.exec(trimmed);
    if (arg?.[1]) {
      // `ARG X` (no default) inside a stage re-declares; only a default value resolves FROM.
      if (arg[2] !== undefined) args[arg[1]] = arg[2].replace(/^["']|["']$/g, '');
      continue;
    }
    const from = /^FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i.exec(trimmed);
    if (!from?.[1]) continue;
    const { value, unresolved } = resolveVars(from[1], args);
    if (from[2]) stages.add(from[2].toLowerCase());
    if (value === 'scratch' || stages.has(value.toLowerCase())) continue;
    if (unresolved.length > 0) {
      findings.push({
        check: 'dockerfile-pin',
        subject: file,
        level: 'error',
        message: `FROM ${from[1]}: ARG ${unresolved.join(', ')} has no default`,
      });
    } else if (!DIGEST_PINNED.test(value)) {
      findings.push({
        check: 'dockerfile-pin',
        subject: file,
        level: 'error',
        message: `FROM ${value} is not pinned as <registry>/<repo>:<tag>@sha256:<digest>`,
      });
    }
  }
  return findings;
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export interface ExceptionEntry {
  source: string;
  id: string;
  expires?: unknown;
  justification?: unknown;
}

export function checkExceptions(
  entries: ExceptionEntry[],
  today: string,
  maxDays = MAX_EXCEPTION_DAYS,
): Finding[] {
  const findings: Finding[] = [];
  for (const e of entries) {
    const subject = `${e.source}: ${e.id}`;
    if (typeof e.justification !== 'string' || e.justification.trim().length < 10) {
      findings.push({
        check: 'exception',
        subject,
        level: 'error',
        message: 'missing justification (statement/reason)',
      });
    }
    const expires = e.expires instanceof Date ? e.expires.toISOString().slice(0, 10) : e.expires;
    if (typeof expires !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(expires)) {
      findings.push({
        check: 'exception',
        subject,
        level: 'error',
        message: 'missing or invalid expiry date (YYYY-MM-DD)',
      });
      continue;
    }
    const days = daysBetween(today, expires.slice(0, 10));
    if (days < 0) {
      findings.push({
        check: 'exception',
        subject,
        level: 'warning',
        message: `expired on ${expires.slice(0, 10)} — no longer applied; remove or renew it`,
      });
    } else if (days > maxDays) {
      findings.push({
        check: 'exception',
        subject,
        level: 'error',
        message: `expires in ${days} days; the maximum is ${maxDays}`,
      });
    }
  }
  return findings;
}

/** Minimum age of a CI image release before it may be pinned (`.gitlab/ci/images.yml`). */
export const MIN_IMAGE_AGE_DAYS = 14;

function isoDate(value: unknown): string | undefined {
  const v = value instanceof Date ? value.toISOString().slice(0, 10) : value;
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined;
}

/**
 * Release-age exceptions (`.gitlab/security/image-age-exceptions.yaml`): a pin younger than
 * MIN_IMAGE_AGE_DAYS needs an entry naming the IMG_* variable and its EXACT current value, the
 * release date, the reason, the approver and an expiry. Besides the common exception rules
 * (justification, expiry <= 90 days, checked by checkExceptions), an entry
 *  - covers only the exact reference it names: a different pin (new version or digest) under the
 *    same variable is an error, so an exception never carries over to another image;
 *  - may not outlive the age window: expires <= released + MIN_IMAGE_AGE_DAYS.
 *
 * The exception is consulted only while the pinned release is younger than MIN_IMAGE_AGE_DAYS:
 *  - release younger, entry not expired: the exception applies;
 *  - release younger, entry expired: ERROR (the pin violates the age rule and nothing covers it;
 *    renew the exception or pin an older release);
 *  - release old enough (on or after released + MIN_IMAGE_AGE_DAYS): the entry is no longer
 *    needed, whatever its expiry; WARNING to delete it. Nothing fails because time passed.
 */
export function imageAgeExceptionEntries(
  source: string,
  doc: unknown,
  vars: Record<string, string>,
  today: string,
): { entries: ExceptionEntry[]; findings: Finding[] } {
  const list = (doc as { exceptions?: unknown } | null | undefined)?.exceptions;
  const items = Array.isArray(list) ? (list as Array<Record<string, unknown>>) : [];
  const entries: ExceptionEntry[] = [];
  const findings: Finding[] = [];
  for (const item of items) {
    const variable = typeof item.variable === 'string' ? item.variable : '(no variable)';
    const subject = `${source}: ${variable}`;
    const error = (message: string): void => {
      findings.push({ check: 'exception', subject, level: 'error', message });
    };
    const pinned = vars[variable];
    if (!variable.startsWith('IMG_') || pinned === undefined) {
      error('names no IMG_* variable of the CI configuration');
    } else if (item.image !== pinned) {
      error(
        `covers "${String(item.image)}" but ${variable} pins "${pinned}": a new pin needs its own exception`,
      );
    }
    if (typeof item.approvedBy !== 'string' || item.approvedBy.trim().length < 3) {
      error('missing approvedBy');
    }
    const released = isoDate(item.released);
    const expires = isoDate(item.expires);
    if (!released) {
      error('missing or invalid release date "released" (YYYY-MM-DD)');
    } else if (daysBetween(today, released) > 0) {
      error(`release date ${released} is in the future`);
    } else if (expires && daysBetween(released, expires) > MIN_IMAGE_AGE_DAYS) {
      error(
        `expires ${expires}, later than ${MIN_IMAGE_AGE_DAYS} days after the release (${released}): the exception may not outlive the age rule`,
      );
    }
    const age = released ? daysBetween(released, today) : undefined;
    if (age !== undefined && age >= MIN_IMAGE_AGE_DAYS) {
      // Not consulted any more: the release qualifies on its own.
      findings.push({
        check: 'exception',
        subject,
        level: 'warning',
        message: `the pinned release is ${age} days old (released ${released}) and qualifies on its own: the exception is no longer needed; delete it`,
      });
      continue;
    }
    if (expires && daysBetween(today, expires) < 0) {
      // Reported here as an error instead of the common "expired" warning of checkExceptions.
      error(
        `expired on ${expires} while the pinned release (${released ?? 'unknown release date'}) is younger than ${MIN_IMAGE_AGE_DAYS} days: the pin violates the release-age rule; renew the exception or pin an older release`,
      );
      continue;
    }
    entries.push({ source, id: variable, expires: item.expires, justification: item.reason });
  }
  return { entries, findings };
}

/** Entries of a Trivy YAML ignore file (vulnerabilities, misconfigurations, secrets, licenses). */
export function trivyIgnoreEntries(source: string, doc: unknown): ExceptionEntry[] {
  if (!doc || typeof doc !== 'object') return [];
  const out: ExceptionEntry[] = [];
  for (const section of ['vulnerabilities', 'misconfigurations', 'secrets', 'licenses']) {
    const list = (doc as Record<string, unknown>)[section];
    if (!Array.isArray(list)) continue;
    for (const item of list as Array<Record<string, unknown>>) {
      out.push({
        source: `${source}#${section}`,
        id: String(item.id ?? '(no id)'),
        expires: item.expired_at,
        justification: item.statement,
      });
    }
  }
  return out;
}

/**
 * A SAST waiver must name the flagged code (sha256 fingerprint of the flagged lines,
 * see tools/ci/scripts/sast-gate.py --fingerprint) or at least the exact start line. A rule + path
 * entry would waive every future finding of that rule anywhere in the file.
 */
export function checkSastExceptionScope(
  source: string,
  entries: Array<Record<string, unknown>>,
): Finding[] {
  return entries.flatMap((e): Finding[] => {
    const subject = `${source}: ${String(e.rule)} @ ${String(e.path)}`;
    const fp = e.fingerprint;
    if (typeof fp === 'string' && /^[a-f0-9]{64}$/.test(fp)) return [];
    if (fp === undefined && typeof e.line === 'number' && Number.isInteger(e.line) && e.line > 0)
      return [];
    return [
      {
        check: 'exception',
        subject,
        level: 'error',
        message:
          'whole-file SAST waiver: add "fingerprint" (python3 tools/ci/scripts/sast-gate.py --fingerprint <path> <line>) or an exact "line"',
      },
    ];
  });
}
