/**
 * TEST-ONLY: the live-validation sandbox's EXAMPLE registers (policies/exceptions/examples/sandbox)
 * adopted IN MEMORY — `status` removed, dated today with a 30-day window, owner as shipped, no
 * approver — next to the repository registers. Tests that build the opt-in `Sandbox` stage use it,
 * because the shipped registers deliberately contain no sandbox entry. Nothing is written to the
 * repository, and no CDK app or CI job uses this: a project adopts the entries it accepts in
 * policies/exceptions/*.yaml (docs/policy-as-code.md, "Adopting an entry").
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_EXCEPTIONS_FILE,
  DEFAULT_SUPPRESSIONS_FILE,
  SANDBOX_EXAMPLE_EXCEPTIONS_FILE,
  SANDBOX_EXAMPLE_SUPPRESSIONS_FILE,
  checkSuppressions,
  rawEntries,
  todayUtc,
  type SuppressionRegister,
} from '@starter/policies';
import { useSuppressionRegister } from '../lib/policy-hook.js';

const ADOPTION_WINDOW_DAYS = 30;

function plusDays(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function adopted(file: string, key: 'exceptions' | 'suppressions', today: string): unknown[] {
  const until = plusDays(today, ADOPTION_WINDOW_DAYS);
  return rawEntries(file, key).map(({ raw }) => {
    const { status: _status, ...entry } = raw as Record<string, unknown>;
    return key === 'exceptions'
      ? { ...entry, createdAt: today, expiresAt: until }
      : { ...entry, createdAt: today, reviewedAt: today, reviewBy: until };
  });
}

const shipped = (file: string, key: 'exceptions' | 'suppressions'): unknown[] =>
  rawEntries(file, key).map(({ raw }) => raw);

export interface SandboxAdoptedRegisters {
  /** Repository register + sandbox entries adopted in memory. */
  register: SuppressionRegister;
  /** Temp file: repository exceptions + sandbox exceptions adopted in memory. */
  exceptionsFile: string;
}

export function sandboxAdoptedRegisters(today = todayUtc()): SandboxAdoptedRegisters {
  const register = checkSuppressions(
    {
      schemaVersion: 1,
      suppressions: [
        ...shipped(DEFAULT_SUPPRESSIONS_FILE, 'suppressions'),
        ...adopted(SANDBOX_EXAMPLE_SUPPRESSIONS_FILE, 'suppressions', today),
      ],
    },
    { today },
  );
  const exceptionsFile = join(
    mkdtempSync(join(tmpdir(), 'starter-sandbox-registers-')),
    'exceptions.yaml',
  );
  // JSON is valid YAML.
  writeFileSync(
    exceptionsFile,
    JSON.stringify({
      schemaVersion: 1,
      exceptions: [
        ...shipped(DEFAULT_EXCEPTIONS_FILE, 'exceptions'),
        ...adopted(SANDBOX_EXAMPLE_EXCEPTIONS_FILE, 'exceptions', today),
      ],
    }),
  );
  return { register, exceptionsFile };
}

/**
 * Resolves acknowledgements in this test file against the sandbox-adopted register; returns the
 * matching exceptions file for `applyBaselinePolicies` / `applyPolicyChecks`.
 */
export function useSandboxAdoptedRegisters(): string {
  const { register, exceptionsFile } = sandboxAdoptedRegisters();
  useSuppressionRegister(register);
  return exceptionsFile;
}
