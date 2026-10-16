/**
 * Discovery: every `discovery` probe of the allowlist, strictly sequentially, in allowlist order.
 * AccessDenied / not-found / errors / timeouts are recorded and the run continues; expired
 * credentials or an interrupt stop the run (the caller writes partial evidence marked incomplete).
 */
import { recordOf, runCall, skippedRecord, type RunContext } from './calls.ts';
import { maskedCommand, type ProbeRecord } from './evidence.ts';
import type { PlaceholderValues, ProbeDef } from './policy.ts';
import { CDK_DEFAULT_QUALIFIER, MAX_BUDGET_NOTIFICATION_CALLS, PROBES } from './probes.ts';
import type { Sanitizer } from './sanitize.ts';
import { isRecord, type Region } from './types.ts';
import { PATTERNS } from './validate.ts';

export interface DiscoveryInputs {
  readonly qualifier: string;
  readonly vpcId?: string | undefined;
  readonly kmsKeyRefs: readonly string[];
  readonly boundaryPolicyArn?: string | undefined;
  readonly dbEngineVersion: string;
}

export interface DiscoveryResult {
  readonly records: ProbeRecord[];
  /** Set when the run stopped early. */
  readonly stopped?: { readonly reason: 'credentials' | 'interrupted'; readonly code: string };
}

interface Variant {
  readonly suffix: string;
  readonly values: PlaceholderValues;
}

/** Valid budget names from a describe-budgets response (first MAX_BUDGET_NOTIFICATION_CALLS). */
export function budgetNamesOf(data: unknown): { valid: string[]; invalid: number; more: number } {
  const budgets = isRecord(data) && Array.isArray(data['Budgets']) ? data['Budgets'] : [];
  const names = budgets
    .map((b) => (isRecord(b) ? b['BudgetName'] : undefined))
    .filter((n): n is string => typeof n === 'string');
  const first = names.slice(0, MAX_BUDGET_NOTIFICATION_CALLS);
  const valid = first.filter((n) => PATTERNS.budgetName.test(n));
  return { valid, invalid: first.length - valid.length, more: names.length - first.length };
}

export async function runDiscovery(
  ctx: RunContext,
  s: Sanitizer,
  account: string,
  inputs: DiscoveryInputs,
  log: (line: string) => void,
): Promise<DiscoveryResult> {
  const records: ProbeRecord[] = [];
  const base: PlaceholderValues = {
    account,
    dbEngineVersion: inputs.dbEngineVersion,
    ...(inputs.vpcId ? { vpcId: inputs.vpcId } : {}),
    ...(inputs.boundaryPolicyArn ? { boundaryPolicyArn: inputs.boundaryPolicyArn } : {}),
  };
  const qualifiers = [...new Set([inputs.qualifier, CDK_DEFAULT_QUALIFIER])];
  let budgetNames: string[] | undefined;
  let budgetSkipReason = 'describe-budgets did not succeed';

  const variantsOf = (def: ProbeDef): Variant[] | string => {
    if (def.requires === 'boundaryPolicyArn' && !inputs.boundaryPolicyArn) {
      return 'not requested (no --boundary-policy-arn)';
    }
    if (def.requires === 'kmsKeyRef' && inputs.kmsKeyRefs.length === 0) {
      return 'not requested (no --kms-key)';
    }
    switch (def.repeat) {
      case 'qualifier':
        return qualifiers.map((q) => ({ suffix: `[${q}]`, values: { ...base, qualifier: q } }));
      case 'kmsKeyRef':
        return inputs.kmsKeyRefs.map((k, i) => ({
          suffix: `#${i + 1}`,
          values: { ...base, kmsKeyRef: k },
        }));
      case 'budgetName':
        if (budgetNames === undefined) return budgetSkipReason;
        if (budgetNames.length === 0) return 'no budgets with a usable name';
        return budgetNames.map((b, i) => ({
          suffix: `#${i + 1}`,
          values: { ...base, budgetName: b },
        }));
      default:
        return [{ suffix: '', values: base }];
    }
  };

  for (const def of PROBES.filter((p) => p.phase === 'discovery')) {
    const variants = variantsOf(def);
    if (typeof variants === 'string') {
      for (const region of def.regions) {
        const rec = skippedRecord(
          def,
          `${def.id}@${region}`,
          region,
          maskedCommand(def, base, region, s),
          variants,
        );
        records.push(rec);
        // Call ids are static probe ids + validated values: printed as they are.
        log(`  skipped        ${rec.id} — ${variants}`);
      }
      continue;
    }
    for (const variant of variants) {
      for (const region of def.regions as readonly Region[]) {
        if (ctx.signal?.aborted)
          return { records, stopped: { reason: 'interrupted', code: 'Interrupted' } };
        const callId = `${def.id}${variant.suffix}@${region}`;
        const outcome = await runCall(ctx, callId, {
          probeId: def.id,
          region,
          values: variant.values,
        });
        const c = outcome.classified;
        if (c.kind === 'credentials') {
          log(`  CREDENTIALS    ${callId} (${s.text(c.code, { domains: false })})`);
          return { records, stopped: { reason: 'credentials', code: c.code } };
        }
        if (c.kind === 'interrupted')
          return { records, stopped: { reason: 'interrupted', code: c.code } };
        const rec = recordOf(outcome, s);
        records.push(rec);
        // rec.errorCode is already sanitized (recordOf).
        log(
          `  ${rec.status.padEnd(14)} ${callId}${rec.errorCode ? ` (${rec.errorCode})` : ''}${rec.truncated ? ' [truncated]' : ''}`,
        );
        if (def.id === 'd.budgets.budgets') {
          if (c.kind === 'ok') {
            const names = budgetNamesOf(c.data);
            budgetNames = names.valid;
            if (names.invalid > 0) {
              log(`  note: ${names.invalid} budget name(s) failed validation and are not queried`);
            }
            if (names.more > 0) {
              log(
                `  note: ${names.more} more budget(s) beyond the first ${MAX_BUDGET_NOTIFICATION_CALLS} are not queried`,
              );
            }
          } else {
            budgetSkipReason = `describe-budgets was ${rec.status}`;
          }
        }
      }
    }
  }
  return { records };
}
