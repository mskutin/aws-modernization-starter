/**
 * Self-test of the Phase 2 sandbox lifecycle WITHOUT AWS, starting from a deployed fake run
 * (fixtures/world.ts): idempotent re-runs, the run-mixing refusal, teardown from names/tags without
 * the run directory, never a pass for a check that did not run, the rollback restore path and
 * verify.sh without a finops report.
 */
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONTRACT_ORDER,
  OPERATOR_ARN,
  calls,
  deployedWorld,
  destroyOrder,
  expectNoSecretLeak,
  isMutation,
  results,
  runDir,
  runScript,
  state,
  unguardedMutations,
  useWorld,
  w,
} from './fixtures/world.js';

useWorld({ template: true });

describe(
  'Phase 2 sandbox lifecycle scripts from a deployed run (fake AWS world)',
  { timeout: 240_000 },
  () => {
    it('every sandbox deploy carries requireDeployInputs, the secret FILE and the operator principal', () => {
      const deploys = w.templateCalls.filter((l) => l.includes('exec cdk deploy'));
      expect(deploys).toHaveLength(9);
      const missing = deploys.filter(
        (l) =>
          !l.includes('-c requireDeployInputs=true') ||
          !/-c originVerifySecretFile=\S+\/origin-verify /.test(l) ||
          !l.includes(`-c operatorPrincipalArn=${OPERATOR_ARN}`) ||
          !/-c apiImageDigest=sha256:[a-f0-9]{64} /.test(l) ||
          !l.includes('-c sandbox.masterSecretRotation=on') ||
          l.includes('originVerifySecret='),
      );
      expect(missing).toEqual([]);
      expect(w.templateCalls.filter((l) => l.startsWith('DENIED'))).toEqual([]);
    });

    it('SBX_MASTER_SECRET_ROTATION=off is passed through to every deploy; other values are refused', async () => {
      expect((await runScript('bootstrap.sh')).code).toBe(0);
      await writeFile(w.log, '');
      const bad = await runScript('up.sh', { SBX_MASTER_SECRET_ROTATION: 'maybe' });
      expect(bad.code, bad.output).toBe(2);
      expect((await calls()).filter(isMutation)).toEqual([]);
      const off = await runScript('up.sh', { SBX_MASTER_SECRET_ROTATION: 'off' });
      expect(off.code, off.output).toBe(0);
      const deploys = (await calls()).filter((l) => l.includes('exec cdk deploy'));
      expect(deploys).toHaveLength(9);
      for (const d of deploys) expect(d).toContain('-c sandbox.masterSecretRotation=off');
      expect((await runScript('down.sh')).code).toBe(0);
    });

    it('up.sh is idempotent: a re-run with the same run id deploys nothing again and keeps the run state', async () => {
      const run = await deployedWorld();
      const runId = run.split('/').pop() as string;
      const secretBefore = await readFile(join(run, 'origin-verify'), 'utf8');
      expect((await stat(join(run, 'origin-verify'))).mode & 0o777).toBe(0o600);
      expect((await stat(run)).mode & 0o777).toBe(0o700);
      const again = await runScript('up.sh', { SBX_RUN_ID: runId });
      expect(again.code, again.output).toBe(0);
      const lines = await calls();
      expect(lines.filter(isMutation)).toEqual([]);
      expect(await readFile(join(run, 'origin-verify'), 'utf8')).toBe(secretBefore);
      expect(again.output).toMatch(/step deploy-data: done earlier/);
      // a second bootstrap leaves the existing (experiment-created) toolkit alone
      await writeFile(w.log, '');
      expect((await runScript('bootstrap.sh')).code).toBe(0);
      expect((await calls()).filter(isMutation)).toEqual([]);
      await expectNoSecretLeak(again.output, secretBefore);
      // tear down to stop the IdP and leave the world clean
      expect((await runScript('down.sh', { SBX_RUN_ID: runId })).code).toBe(0);
    });

    it('up.sh refuses to mix runs (exit 4) while another run is deployed', async () => {
      const first = (await deployedWorld()).split('/').pop() as string;
      const other = await runScript('up.sh', { SBX_RUN_ID: 'sbx-000000' });
      expect(other.code, other.output).toBe(4);
      expect(other.output).toContain(`another run is deployed (${first})`);
      expect((await calls()).filter(isMutation)).toEqual([]);
      expect((await runScript('down.sh', { SBX_RUN_ID: first })).code).toBe(0);
    });

    it('down.sh works from names and tags when the run directory is gone (delete-stack, reverse order); twice is harmless', async () => {
      const run = await deployedWorld();
      const runId = run.split('/').pop() as string;
      await rm(run, { recursive: true, force: true });
      await rm(join(w.home, 'runs', 'current'), { force: true });
      const down = await runScript('down.sh', { SBX_RUN_ID: runId });
      expect(down.code, down.output).toBe(0);
      const lines = await calls();
      expect(lines.some((l) => l.includes('exec cdk destroy'))).toBe(false);
      expect(destroyOrder(lines)).toEqual([...CONTRACT_ORDER].reverse());
      expect(unguardedMutations(lines)).toEqual([]);
      const s = await state();
      expect(s.stacks).toEqual({});
      expect(s.logGroups).toEqual([]);
      expect(s.foreignTouched).toEqual([]);
      expect((await calls()).filter((l) => l.startsWith('DENIED'))).toEqual([]);
      await writeFile(w.log, '');
      const again = await runScript('down.sh', { SBX_RUN_ID: runId });
      expect(again.code, again.output).toBe(0);
      expect((await calls()).filter(isMutation)).toEqual([]);
    });

    it('e2e preflight: the offline aws-auth check runs first; when it fails the live E2E is not-run and test.sh fails', async () => {
      await deployedWorld();
      const ok = await runScript('test.sh', { SBX_TESTS: 'e2e' });
      expect(ok.code, ok.output).toBe(0);
      const lines = await calls();
      const offline = lines.findIndex((l) => l.includes('run test:aws-auth-offline'));
      expect(offline).toBeGreaterThanOrEqual(0);
      expect(offline).toBeLessThan(lines.findIndex((l) => l.includes('exec playwright test')));

      await writeFile(w.log, '');
      const failed = await runScript('test.sh', { SBX_TESTS: 'e2e', FAKE_E2E_OFFLINE: 'fail' });
      expect(failed.code, failed.output).toBe(1);
      expect((await calls()).some((l) => l.includes('exec playwright test'))).toBe(false);
      const r = await results(join(await runDir(), 'test-latest', 'results.jsonl'));
      expect(r.filter((x) => x.check === 'e2e').map((x) => x.status)).toEqual([
        'failed',
        'not-run',
      ]);
      expect((await runScript('down.sh')).code).toBe(0);
    });

    it('verify-clean exit 5: down.sh prints the unverifiable categories and exits 5 (neither clean nor "not verified")', async () => {
      await deployedWorld();
      const d = await runScript('down.sh', { FAKE_FINOPS_UNVERIFIABLE: '1' });
      expect(d.code, d.output).toBe(5);
      expect(d.output).toMatch(/could NOT be listed with this role/);
      expect(d.output).toContain('UNVERIFIABLE kms-keys (unverifiable-with-this-role)');
      expect(d.output).not.toContain('111122223333');
      // the report it relied on is kept with the teardown evidence
      const run = await runDir();
      expect((await calls()).find((l) => l.startsWith('CALL finops verify-clean'))).toContain(
        `--inventory ${join(run, 'inventory.json')}`,
      );
    });

    it('never a pass for what did not run: no aws-auth module → e2e not-run and test.sh fails', async () => {
      await deployedWorld();
      const t = await runScript('test.sh', {
        SBX_E2E_AUTH_MODULE: join(w.dir, 'missing.ts'),
        SBX_TESTS: 'smoke,e2e',
      });
      expect(t.code, t.output).toBe(1);
      const run = await runDir();
      const r = await results(join(run, 'test-latest', 'results.jsonl'));
      expect(r.filter((x) => x.check === 'e2e')).toEqual([
        expect.objectContaining({ status: 'not-run' }),
      ]);
      expect(r.filter((x) => x.check === 'smoke' && x.status === 'passed')).toHaveLength(6);
      const summary = JSON.parse(
        await readFile(join(run, 'test-latest', 'summary.json'), 'utf8'),
      ) as { ok: boolean };
      expect(summary.ok).toBe(false);
      expect((await runScript('down.sh')).code).toBe(0);
    });

    it('rollback.sh: without an automatic rollback it restores the baseline itself and FAILS', async () => {
      await deployedWorld();
      const r = await runScript('rollback.sh', {
        FAKE_ROLLBACK: 'none',
        SBX_ROLLBACK_DEADLINE_SECONDS: '0',
      });
      expect(r.code, r.output).toBe(1);
      const lines = await calls();
      const updates = lines.filter((l) => l.includes('ecs update-service'));
      expect(updates).toHaveLength(2);
      expect(updates[1]).toMatch(/--task-definition \S+starter-sbx-api:1 /);
      expect(unguardedMutations(lines)).toEqual([]);
      const s = await state();
      expect(s.service?.taskDefinition).toBe(s.service?.baseline);
      const rb = await results(join(await runDir(), 'rollback-latest', 'results.jsonl'));
      expect(rb.find((x) => /circuit breaker/.test(x.name))?.status).toBe('failed');
      expect((await runScript('down.sh')).code).toBe(0);
      // the unhealthy revision rollback.sh registered is gone too
      expect((await state()).taskDefs).toEqual({});
    });

    it('verify.sh never says clean without the finops report (an entry point that does nothing → exit 3)', async () => {
      const run = await deployedWorld();
      const runId = run.split('/').pop() as string;
      await writeFile(
        join(w.dir, 'noop.js'),
        '// exports only, like tools/aws-sandbox/dist/cli.js\n',
      );
      await writeFile(
        join(w.dir, 'state.json'),
        JSON.stringify({ ...(await state()), stacks: {} }),
      );
      const r = await runScript('verify.sh', {
        SBX_RUN_ID: runId,
        SBX_FINOPS_CLI: join(w.dir, 'noop.js'),
      });
      expect(r.code, r.output).toBe(3);
      expect(r.output).toMatch(/verify-clean exit 0, no report: NOT verified/);
      const missing = await runScript('verify.sh', {
        SBX_RUN_ID: runId,
        SBX_FINOPS_CLI: join(w.dir, 'absent.js'),
      });
      expect(missing.code, missing.output).toBe(3);
    });
  },
);
