/**
 * Evaluations of read-only AWS CLI output for test.sh (no AWS calls here):
 *
 *  - listenerCheck   the ALB listener answers 403 by default and forwards only when
 *                    X-Origin-Verify equals the run's secret (compared, never printed);
 *  - albSecurityGroupCheck  the ALB's security groups admit only prefix lists (CloudFront's
 *                    origin-facing list), no CIDR ranges;
 *  - smokeSteps      the smoke CLI's `ok   - <step>` / `FAIL - <step>` lines → results (steps the
 *                    smoke never reached are not-run, not passed);
 *  - stepFunctionsSummary  every execution this test run started is terminal, none timed out or
 *                    was aborted.
 */
import type { CheckOutcome } from './http-checks.js';
import type { ResultStatus } from './results.js';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const list = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? (v as unknown[]).filter(isRecord) : [];

/** `elbv2 describe-rules --output json` of the API listener. */
export function listenerCheck(rules: unknown, secret: string): CheckOutcome[] {
  const all = list(isRecord(rules) ? rules.Rules : undefined);
  const def = all.find((r) => r.IsDefault === true);
  const defAction = list(def?.Actions)[0];
  const fixed = isRecord(defAction?.FixedResponseConfig) ? defAction.FixedResponseConfig : {};
  const out: CheckOutcome[] = [
    {
      name: 'ALB listener: the default action is a fixed 403',
      ok: defAction?.Type === 'fixed-response' && String(fixed.StatusCode) === '403',
      detail:
        `default action ${String(defAction?.Type ?? 'none')} ${String(fixed.StatusCode ?? '')}`.trim(),
    },
  ];
  const forwarding = all.filter(
    (r) => r.IsDefault !== true && list(r.Actions).some((a) => a.Type === 'forward'),
  );
  const headerOf = (r: Record<string, unknown>) =>
    list(r.Conditions).find(
      (c) =>
        c.Field === 'http-header' &&
        isRecord(c.HttpHeaderConfig) &&
        String(c.HttpHeaderConfig.HttpHeaderName).toLowerCase() === 'x-origin-verify',
    );
  const guarded = forwarding.filter((r) => {
    const h = headerOf(r);
    const values =
      isRecord(h?.HttpHeaderConfig) && Array.isArray(h.HttpHeaderConfig.Values)
        ? (h.HttpHeaderConfig.Values as unknown[])
        : [];
    return values.length > 0 && values.every((v) => v === secret);
  });
  out.push({
    name: "ALB listener: every forwarding rule requires X-Origin-Verify = the run's secret",
    ok: forwarding.length > 0 && guarded.length === forwarding.length,
    detail: `${guarded.length}/${forwarding.length} forwarding rule(s) carry the header condition with the run's value (value not shown)`,
  });
  return out;
}

/**
 * `describe-rules` output safe to keep as evidence: the X-Origin-Verify values are replaced by a
 * statement of whether they equal the run's secret.
 */
export function redactRules(rules: unknown, secret: string): unknown {
  const copy = JSON.parse(JSON.stringify(rules ?? null)) as unknown;
  for (const r of list(isRecord(copy) ? copy.Rules : undefined)) {
    for (const c of list(r.Conditions)) {
      const h = isRecord(c.HttpHeaderConfig) ? c.HttpHeaderConfig : undefined;
      if (
        h &&
        String(h.HttpHeaderName).toLowerCase() === 'x-origin-verify' &&
        Array.isArray(h.Values)
      ) {
        h.Values = (h.Values as unknown[]).map((v) =>
          v === secret
            ? '<redacted: equals the run origin-verify value>'
            : '<redacted: another value>',
        );
      }
    }
  }
  return copy;
}

/** `ec2 describe-security-groups --output json` of the ALB's groups. */
export function albSecurityGroupCheck(groups: unknown): CheckOutcome[] {
  const sgs = list(isRecord(groups) ? groups.SecurityGroups : undefined);
  let prefixLists = 0;
  const cidrs: string[] = [];
  for (const sg of sgs) {
    for (const p of list(sg.IpPermissions)) {
      prefixLists += list(p.PrefixListIds).length;
      for (const r of list(p.IpRanges)) cidrs.push(String(r.CidrIp));
      for (const r of list(p.Ipv6Ranges)) cidrs.push(String(r.CidrIpv6));
      if (list(p.UserIdGroupPairs).length > 0) cidrs.push('security-group reference');
    }
  }
  return [
    {
      name: 'ALB security group: ingress only from a prefix list (CloudFront origin-facing), no CIDR ranges',
      ok: sgs.length > 0 && prefixLists > 0 && cidrs.length === 0,
      detail: `${sgs.length} group(s); ${prefixLists} prefix-list rule(s); other sources: ${cidrs.length ? cidrs.join(', ') : 'none'}`,
    },
  ];
}

export const SMOKE_STEP_COUNT = 6;

export function smokeSteps(log: string): { name: string; status: ResultStatus; detail: string }[] {
  const out: { name: string; status: ResultStatus; detail: string }[] = [];
  for (const line of log.split('\n')) {
    // smoke.ts prints `ok   - <name> (<n>ms) <detail>` / `FAIL - <name> (<n>ms) <detail>`
    const m = /^(ok {3}|FAIL )- (.+?) \((\d+)ms\)\s?(.*)$/.exec(line);
    if (!m) continue;
    out.push({
      name: `smoke: ${m[2] as string}`,
      status: m[1] === 'FAIL ' ? 'failed' : 'passed',
      detail: `${m[3] as string}ms ${m[4] ?? ''}`.trim(),
    });
  }
  const missing = SMOKE_STEP_COUNT - out.length;
  if (missing > 0) {
    out.push({
      name: `smoke: ${missing} of ${SMOKE_STEP_COUNT} steps did not run`,
      status: 'not-run',
      detail: 'the smoke stops at the first failing step (or did not start)',
    });
  }
  return out;
}

/** `stepfunctions list-executions --output json`; executions started at/after `since`. */
export function stepFunctionsSummary(listed: unknown, since: Date): CheckOutcome[] {
  const execs = list(isRecord(listed) ? listed.executions : undefined).filter((e) => {
    const t = Date.parse(String(e.startDate ?? ''));
    return Number.isFinite(t) && t >= since.getTime();
  });
  const counts: Record<string, number> = {};
  for (const e of execs) counts[String(e.status)] = (counts[String(e.status)] ?? 0) + 1;
  const running = counts.RUNNING ?? 0;
  const bad = (counts.TIMED_OUT ?? 0) + (counts.ABORTED ?? 0);
  return [
    {
      name: 'Step Functions: executions ran for this test run and all reached a terminal state (none timed out or aborted)',
      ok: execs.length > 0 && running === 0 && bad === 0,
      detail: `${execs.length} execution(s) since ${since.toISOString()}: ${JSON.stringify(counts)}`,
    },
  ];
}
