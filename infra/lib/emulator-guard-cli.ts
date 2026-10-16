/**
 * Shell entry point of the emulator guard (`emulator-guard.ts`), so the emulator scripts apply the
 * same rules as the CDK app and the test harness:
 *
 *   node infra/dist/lib/emulator-guard-cli.js --phase incoming|effective
 *
 * Exit 0 and one JSON line `{"mode":…,"endpoint":…}` on stdout when the environment is safe;
 * exit 5 (`EMULATOR_REFUSAL_EXIT_CODE`) with one `refusing: …` line per finding on stderr
 * otherwise; exit 2 on a usage error. Reads nothing but `process.env`, calls nothing.
 */
import path from 'node:path';
import {
  EMULATOR_REFUSAL_EXIT_CODE,
  checkEmulatorEnvironment,
  type GuardPhase,
} from './emulator-guard.js';

export function main(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  io: { out: (line: string) => void; err: (line: string) => void },
): number {
  const i = argv.indexOf('--phase');
  const phase = i >= 0 ? argv[i + 1] : 'effective';
  if (phase !== 'incoming' && phase !== 'effective') {
    io.err('usage: emulator-guard-cli --phase incoming|effective');
    return 2;
  }
  const result = checkEmulatorEnvironment(env, phase as GuardPhase);
  if (!result.ok) {
    for (const refusal of result.refusals) io.err(`[emulator-guard] refusing: ${refusal}`);
    return EMULATOR_REFUSAL_EXIT_CODE;
  }
  io.out(JSON.stringify({ mode: result.mode, endpoint: result.endpoint }));
  return 0;
}

if (process.argv[1] && path.basename(process.argv[1]).startsWith('emulator-guard-cli')) {
  process.exitCode = main(process.argv.slice(2), process.env, {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => console.error(line),
  });
}
