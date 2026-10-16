/**
 * License compliance: every installed package's declared license (SPDX
 * expression) must be satisfiable by the allowlist, or covered by an
 * unexpired, justified package exception. Unknown / missing licenses fail.
 */

export interface LicenseException {
  package: string;
  license: string;
  reason: string;
  approvedBy: string;
  expires: string; // YYYY-MM-DD
}

export interface LicensePolicy {
  version: 1;
  allowed: string[];
  denied: string[];
  exceptions: LicenseException[];
}

export interface PackageLicense {
  name: string;
  versions: string[];
  license: string;
}

export type Verdict =
  | { status: 'allowed' }
  | { status: 'excepted'; exception: LicenseException }
  | { status: 'denied'; reason: string };

export interface LicenseFinding extends PackageLicense {
  verdict: Verdict;
}

/** Flatten `pnpm licenses list --json` output ({ [license]: [{name, versions, license}] }). */
export function fromPnpmJson(json: unknown): PackageLicense[] {
  if (!json || typeof json !== 'object')
    throw new Error('unexpected `pnpm licenses list --json` output');
  const out = new Map<string, PackageLicense>();
  for (const [group, entries] of Object.entries(json as Record<string, unknown>)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries as Array<Record<string, unknown>>) {
      const name = String(entry.name ?? '');
      const license = typeof entry.license === 'string' && entry.license ? entry.license : group;
      const versions = Array.isArray(entry.versions) ? entry.versions.map(String) : [];
      const key = `${name}|${license}`;
      const prev = out.get(key);
      out.set(key, {
        name,
        license,
        versions: [...new Set([...(prev?.versions ?? []), ...versions])].sort(),
      });
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

type Expr = { kind: 'id'; id: string } | { kind: 'and' | 'or'; left: Expr; right: Expr };

/** Tiny SPDX expression parser: AND binds tighter than OR; WITH stays part of the id. */
export function parseSpdx(input: string): Expr {
  const tokens = input
    .replace(/[()]/g, (m) => ` ${m} `)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  let pos = 0;
  const peek = (): string | undefined => tokens[pos];
  const next = (): string => {
    const t = tokens[pos++];
    if (t === undefined) throw new Error(`unexpected end of license expression "${input}"`);
    return t;
  };
  const primary = (): Expr => {
    const t = next();
    if (t === '(') {
      const e = orExpr();
      if (next() !== ')') throw new Error(`unbalanced parentheses in "${input}"`);
      return e;
    }
    let id = t;
    if (peek()?.toUpperCase() === 'WITH') {
      next();
      id = `${id} WITH ${next()}`;
    }
    return { kind: 'id', id };
  };
  const andExpr = (): Expr => {
    let left = primary();
    while (peek()?.toUpperCase() === 'AND') {
      next();
      left = { kind: 'and', left, right: primary() };
    }
    return left;
  };
  const orExpr = (): Expr => {
    let left = andExpr();
    while (peek()?.toUpperCase() === 'OR') {
      next();
      left = { kind: 'or', left, right: andExpr() };
    }
    return left;
  };
  const expr = orExpr();
  if (pos !== tokens.length) throw new Error(`cannot parse license expression "${input}"`);
  return expr;
}

function satisfied(expr: Expr, allowed: Set<string>): boolean {
  if (expr.kind === 'id') return allowed.has(expr.id.replace(/\+$/, ''));
  if (expr.kind === 'and') return satisfied(expr.left, allowed) && satisfied(expr.right, allowed);
  return satisfied(expr.left, allowed) || satisfied(expr.right, allowed);
}

export function evaluate(
  pkgs: PackageLicense[],
  policy: LicensePolicy,
  today: string,
): { findings: LicenseFinding[]; problems: string[] } {
  const allowed = new Set(policy.allowed);
  const problems: string[] = [];
  const findings = pkgs.map((pkg): LicenseFinding => {
    const exception = policy.exceptions.find(
      (e) => e.package === pkg.name && e.license === pkg.license,
    );
    let verdict: Verdict;
    let ok = false;
    let reason = '';
    if (!pkg.license || /^(unknown|unlicensed|see license in .*)$/i.test(pkg.license)) {
      reason = `no usable license declared ("${pkg.license || 'missing'}")`;
    } else {
      try {
        ok = satisfied(parseSpdx(pkg.license), allowed);
        if (!ok) {
          reason = policy.denied.some((d) => pkg.license.includes(d))
            ? `license ${pkg.license} is explicitly denied`
            : `license ${pkg.license} is not on the allowlist`;
        }
      } catch (error) {
        reason = (error as Error).message;
      }
    }
    if (ok) verdict = { status: 'allowed' };
    else if (exception && exception.expires >= today) verdict = { status: 'excepted', exception };
    else if (exception)
      verdict = {
        status: 'denied',
        reason: `${reason}; exception expired on ${exception.expires}`,
      };
    else verdict = { status: 'denied', reason };
    return { ...pkg, verdict };
  });
  for (const e of policy.exceptions) {
    if (!pkgs.some((p) => p.name === e.package && p.license === e.license)) {
      problems.push(`unused license exception for ${e.package} (${e.license}) — remove it`);
    }
  }
  return { findings, problems };
}

export function validatePolicy(raw: unknown): LicensePolicy {
  const p = raw as Partial<LicensePolicy> | null;
  if (!p || p.version !== 1 || !Array.isArray(p.allowed) || !Array.isArray(p.denied)) {
    throw new Error(
      'license policy: expected { version: 1, allowed: [], denied: [], exceptions: [] }',
    );
  }
  const exceptions = (p.exceptions ?? []).map((e, i) => {
    for (const key of ['package', 'license', 'reason', 'approvedBy', 'expires'] as const) {
      if (typeof e?.[key] !== 'string' || e[key] === '') {
        throw new Error(`license policy: exceptions[${i}].${key} is required`);
      }
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.expires))
      throw new Error(`license policy: exceptions[${i}].expires must be YYYY-MM-DD`);
    return e;
  });
  return { version: 1, allowed: p.allowed, denied: p.denied, exceptions };
}
