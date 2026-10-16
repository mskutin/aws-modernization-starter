/**
 * The Phase 2 lifecycle scripts under the REAL account guard (tools/aws-preflight: the
 * sandbox-guard.sh helper and the guard CLI's current sources) instead of the offline stand-in:
 * every guarded command shape the scripts use must pass the guard's own executable, wrapper,
 * inline-code and option checks, and each mutation must come right after the guard's STS call.
 * Offline: the guard's `aws` is the fake world's (first on PATH; `--version` 2.35.11 and one
 * `sts get-caller-identity` per check), HOME is the world's private directory with an IAM
 * Identity Center profile, and nothing reads the operator's ~/.aws.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { calls, isMutation, runScript, state, useWorld, w } from './fixtures/world.js';

useWorld({ template: false, realGuard: true });

const STS =
  /^CALL aws sts get-caller-identity --profile starter-sandbox-developer --region ap-southeast-1 /;

/** `pnpm exec cdk deploy`, `aws ecs run-task`, `skopeo copy`, … — the shape of a mutation line. */
function shape(line: string): string {
  const words = line.replace(/^CALL /, '').split(' ');
  const tool = words[0] ?? '';
  if (tool === 'pnpm') return words.slice(0, 4).join(' ');
  if (tool === 'skopeo') return 'skopeo copy';
  const positional = words
    .slice(1)
    .filter(
      (x, i, all) => !x.startsWith('--') && !['--profile', '--region'].includes(all[i - 1] ?? ''),
    );
  return [tool, ...positional.slice(0, 2)].join(' ');
}

/** Every guard.log the scripts wrote (the run directory's, and SANDBOX_HOME's before a run). */
async function guardLogs(): Promise<string[]> {
  const entries = await readdir(w.home, { recursive: true });
  const files = entries.filter((e) => e === 'guard.log' || e.endsWith('/guard.log'));
  const lines: string[] = [];
  for (const f of files) {
    lines.push(...(await readFile(join(w.home, f), 'utf8')).split('\n').filter(Boolean));
  }
  return lines;
}

describe(
  'Phase 2 lifecycle scripts under the REAL account guard (fake AWS world)',
  { timeout: 240_000 },
  () => {
    it('all.sh: every guarded command shape passes the real guard; its STS check comes right before each mutation', async () => {
      const r = await runScript('all.sh');
      expect(r.code, r.output).toBe(0);
      expect(r.output).not.toMatch(/sandbox-guard: (REFUSED|STOP)/);

      const lines = await calls();
      const mutations = lines.flatMap((l, i) => (isMutation(l) ? [i] : []));
      const shapes = new Set(mutations.map((i) => shape(lines[i] ?? '')));
      for (const expected of [
        'pnpm exec cdk bootstrap',
        'pnpm exec cdk deploy',
        'pnpm exec cdk destroy',
        'skopeo copy',
        'aws ecs run-task',
        'aws ecs register-task-definition',
        'aws ecs update-service',
        'aws s3 cp',
        'aws cloudfront create-invalidation',
        'aws logs delete-log-group',
        'aws cloudformation delete-stack',
      ]) {
        expect([...shapes], expected).toContain(expected);
      }
      for (const i of mutations) {
        const previous = lines
          .slice(0, i)
          .reverse()
          .find((l) => l.startsWith('CALL '));
        expect(previous, `guard STS call right before: ${lines[i]}`).toMatch(STS);
      }

      // The guard's own log: one verified, masked record per check (at least one per mutation).
      const records = (await guardLogs()).map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(records.length).toBeGreaterThanOrEqual(mutations.length);
      for (const rec of records) {
        expect(rec['result']).toBe('verified');
        expect(rec['account']).toBe('********3333');
        expect(rec['executionProfile']).toBe('personal-sandbox');
      }
      expect(JSON.stringify(records)).not.toContain('111122223333');
      expect(JSON.stringify(records)).not.toContain('jane.doe');
      expect((await state()).foreignTouched).toEqual([]);
    });

    it('an account mismatch stops every script at the guard: nothing mutated, account ids masked', async () => {
      await writeFile(join(w.dir, 'sts-account'), '444455556666\n');
      const r = await runScript('all.sh');
      expect(r.code, r.output).toBe(3); // the guard's ACCOUNT_MISMATCH exit
      expect(r.output).toMatch(/ACCOUNT MISMATCH/);
      expect(r.output).not.toContain('444455556666');
      expect(r.output).not.toContain('111122223333');
      const lines = await calls();
      expect(lines.filter(isMutation)).toEqual([]);
      // the scripts got no further than the guard: only its own AWS CLI calls were made
      expect(
        lines.filter((l) => !/^CALL aws (--version|sts get-caller-identity )/.test(l)),
      ).toEqual([]);
    });

    it('a ~/.aws/credentials file (a fallback identity) is refused (exit 15) before any mutation', async () => {
      await writeFile(join(w.dir, '.aws', 'credentials'), '[other]\nregion = ap-southeast-1\n', {
        mode: 0o600,
      });
      const r = await runScript('bootstrap.sh');
      expect(r.code, r.output).toBe(15);
      expect((await calls()).filter(isMutation)).toEqual([]);
    });
  },
);
