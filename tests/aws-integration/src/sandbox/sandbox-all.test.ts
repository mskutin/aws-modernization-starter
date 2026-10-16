/**
 * Self-test of the Phase 2 sandbox lifecycle WITHOUT AWS, end to end through all.sh and up.sh
 * (fixtures/world.ts): order (bootstrap → stacks in contract order → image → tasks → … → teardown
 * in reverse), every AWS mutation inside a guard bracket, the deploy inputs, teardown after a
 * failure and after a guard refusal, no secret in any output or run-directory file, the image
 * source fallback.
 */
import { chmod, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONTRACT_ORDER,
  OPERATOR_ARN,
  calls,
  deployOrder,
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

useWorld({ template: false });

describe(
  'Phase 2 sandbox lifecycle: all.sh and up.sh (fake AWS world)',
  { timeout: 240_000 },
  () => {
    it('all.sh: bootstrap → up → test → rollback → down → verified clean; every mutation guarded; no secret printed', async () => {
      const r = await runScript('all.sh');
      expect(r.code, r.output).toBe(0);
      const lines = await calls();
      expect(unguardedMutations(lines)).toEqual([]);
      // the operator's permission set: no call outside it, and nothing of anybody else touched
      expect(lines.filter((l) => l.startsWith('DENIED'))).toEqual([]);
      const world = await state();
      expect(world.foreignTouched).toEqual([]);
      expect(Object.keys(world.foreign.stacks)).toEqual([
        'CDKToolkit',
        'Sandbox-Reports',
        'OtherTeam-Api',
      ]);
      expect(world.foreign.logGroups).toHaveLength(4);
      for (const c of lines.filter((l) => /exec cdk (deploy|destroy) /.test(l))) {
        expect(c).toContain(`-c operatorPrincipalArn=${OPERATOR_ARN}`);
      }
      const bootstrap = lines.find((l) => l.includes('exec cdk bootstrap')) ?? '';
      expect(bootstrap).not.toMatch(/--tags|--bootstrap-customer-key|--bootstrap-kms-key-id/);
      expect(bootstrap).toContain('--toolkit-stack-name starter-cdk-toolkit');
      expect(lines.find((l) => l.includes('exec cdk deploy Sandbox/Api'))).toContain(
        '-c sandbox.originPrefixListId=pl-31a34658',
      );
      // The two log groups created outside CloudFormation are deleted by name
      for (const g of [
        '/aws/ecs/containerinsights/starter-sbx-cluster/performance',
        '/aws/lambda/starter-sbx-rds-rotation',
      ]) {
        expect(lines.some((l) => l.endsWith(`logs delete-log-group --log-group-name ${g}`))).toBe(
          true,
        );
      }
      // Every teardown verification is strict
      const verifies = lines.filter((l) => l.startsWith('CALL finops verify-clean'));
      expect(verifies.length).toBeGreaterThanOrEqual(3);
      for (const v of verifies) {
        expect(v).toContain('--strict');
        expect(v).not.toContain('--lenient');
      }
      // After the deployment, verify-clean gets the run's inventory
      const [baselineVerify, ...teardownVerifies] = verifies;
      expect(baselineVerify).not.toContain('--inventory');
      for (const v of teardownVerifies)
        expect(v).toMatch(/--inventory \S+\/sbx-[0-9a-f]{6}\/inventory\.json/);

      // order: bootstrap first, stacks in contract order, tasks between Migrations and Api, SPA last
      const idx = (re: RegExp) => lines.findIndex((l) => re.test(l));
      expect(idx(/exec cdk bootstrap aws:\/\/111122223333\/ap-southeast-1/)).toBeGreaterThanOrEqual(
        0,
      );
      expect(idx(/exec cdk bootstrap/)).toBeLessThan(idx(/exec cdk deploy Sandbox\/Foundation/));
      // the experiment's FIRST AWS mutation is the bootstrap (no real-AWS Phase 1 runs before it;
      // Phase 1 runs against the local MiniStack emulator)
      expect(lines.find(isMutation)).toMatch(/^CALL pnpm exec cdk bootstrap /);
      expect(deployOrder(lines)).toEqual(CONTRACT_ORDER);
      expect(idx(/started-by sbx-[0-9a-f]{6}-db-bootstrap/)).toBeGreaterThan(
        idx(/exec cdk deploy Sandbox\/Migrations/),
      );
      expect(idx(/started-by sbx-[0-9a-f]{6}-db-migrate/)).toBeGreaterThan(
        idx(/started-by sbx-[0-9a-f]{6}-db-bootstrap/),
      );
      expect(idx(/exec cdk deploy Sandbox\/Api/)).toBeGreaterThan(
        idx(/started-by sbx-[0-9a-f]{6}-db-migrate/),
      );
      expect(
        idx(
          /s3 cp \S+openid-configuration s3:\/\/issuer-bucket\/\.well-known\/openid-configuration --content-type application\/json/,
        ),
      ).toBeGreaterThan(idx(/exec cdk deploy Sandbox\/TestIssuer/));
      expect(idx(/TOOL issuer-check/)).toBeGreaterThan(idx(/IDP start/));
      expect(idx(/skopeo copy --preserve-digests/)).toBeLessThan(
        idx(/exec cdk deploy Sandbox\/Migrations/),
      );
      expect(
        idx(/s3 sync \S+ s3:\/\/web-bucket\/ --delete --exclude index.html --exclude config.json/),
      ).toBeGreaterThan(idx(/exec cdk deploy Sandbox\/Frontend/));
      expect(destroyOrder(lines)).toEqual([...CONTRACT_ORDER].reverse());
      expect(idx(/cloudformation delete-stack --stack-name starter-cdk-toolkit/)).toBeGreaterThan(
        idx(/exec cdk destroy Sandbox\/Foundation/),
      );

      // context: account, run id, image digest from the CI image (Cosign-verified, digest preserved)
      const deploy = lines.find((l) => l.includes('exec cdk deploy Sandbox/Api')) ?? '';
      expect(deploy).toMatch(
        /-c account\.sandbox=111122223333 -c region\.sandbox=ap-southeast-1 -c runId=sbx-[0-9a-f]{6}/,
      );
      expect(deploy).toContain(`-c apiImageDigest=sha256:${'c'.repeat(64)}`);
      expect(deploy).toContain('--toolkit-stack-name starter-cdk-toolkit');
      // every deploy: the infra app's deploy guard on, the secret from the 0600 file (never argv)
      for (const d of lines.filter((l) => l.includes('exec cdk deploy'))) {
        expect(d).toContain('-c requireDeployInputs=true');
        expect(d).toMatch(/-c originVerifySecretFile=\S+\/origin-verify /);
        expect(d).not.toContain('originVerifySecret=');
      }
      for (const d of lines.filter((l) => l.includes('exec cdk destroy'))) {
        expect(d).not.toContain('requireDeployInputs');
      }
      // the bootstrap task runs in its own security group, the migration task in the task group
      const tasks = Object.values((await state()).tasks);
      expect(tasks.find((t) => t.name === 'db-bootstrap')?.sg).toBe('sg-bootstrap');
      expect(tasks.find((t) => t.name === 'db-migrate')?.sg).toBe('sg-task');
      expect(lines.some((l) => /^CALL cosign verify --key \S+cosign\.pub/.test(l))).toBe(true);
      expect(lines.filter((l) => l.startsWith('IDP start'))).toEqual(
        expect.arrayContaining([
          expect.stringMatching(
            /runtime=local issuer=https:\/\/issuer\.sbx\.example redirect=https:\/\/sandbox-spa\.invalid\//,
          ),
          expect.stringMatching(
            /redirect=https:\/\/dweb\.cloudfront\.example\/ aud=starter-jobs-api-sandbox client=starter-web-sandbox test=true/,
          ),
        ]),
      );
      const sectest = lines.find((l) => l.startsWith('ENV SECTEST')) ?? '';
      expect(sectest).toContain('WEB_BASE_URL=https://dweb.cloudfront.example');
      expect(sectest).toContain('API_BASE_URL= ');
      expect(sectest).toContain(`TEST_IDP_URL=http://127.0.0.1:${w.idpPort}`);
      expect(sectest).toContain('SECTEST_DYNAMODB_AWS=true');
      expect(sectest).toMatch(/SECTEST_LOG_FILES=\S+api-log\.jsonl/);
      expect(lines.find((l) => l.startsWith('ENV E2E'))).toMatch(
        /E2E_AUTH_MODE=aws-test-issuer E2E_ISSUER=https:\/\/issuer\.sbx\.example/,
      );

      // results: every check recorded, the summary green
      const run = await runDir();
      const testResults = await results(join(run, 'test-latest', 'results.jsonl'));
      const checks = new Set(testResults.map((t) => t.check));
      for (const c of [
        'spa',
        'health',
        'origin-protection',
        'smoke',
        'canary',
        'security',
        'rate-limit',
        'e2e',
        'db-probe',
        'leak-scan',
        'lambda-failure-path',
        'step-functions',
      ]) {
        expect(checks.has(c), c).toBe(true);
      }
      expect(
        testResults.filter(
          (t) => t.status === 'failed' || t.status === 'error' || t.status === 'not-run',
        ),
      ).toEqual([]);
      expect(testResults.filter((t) => t.status === 'skipped').map((t) => t.name)).toEqual([
        'jwks rotation [skipped: self-started harness only]',
        'rate limits failed authentications',
      ]);
      const rollback = await results(join(run, 'rollback-latest', 'results.jsonl'));
      expect(rollback.find((t) => /circuit breaker/.test(t.name))?.status).toBe('passed');
      expect(rollback.every((t) => t.status === 'passed')).toBe(true);

      // teardown: nothing left in the fake account, local secrets gone, verify-clean ran
      const s = await state();
      expect(s.stacks).toEqual({});
      expect(s.toolkit).toBeNull();
      expect(s.retainedBucket).toBeNull();
      expect(s.logGroups).toEqual([]);
      expect(s.taskDefs).toEqual({});
      expect(Object.values(s.keys).every((k) => k === 'PendingDeletion')).toBe(true);
      await expect(stat(join(run, 'origin-verify'))).rejects.toThrow();
      await expect(stat(join(run, 'issuer-key.jwk'))).rejects.toThrow();
      expect(lines.some((l) => /^CALL finops verify-clean --run-id sbx-[0-9a-f]{6}/.test(l))).toBe(
        true,
      );
      const finalVerify = lines.findLastIndex((l) => l.startsWith('CALL finops verify-clean'));
      expect(lines[finalVerify]).toContain('--include-bootstrap');
      expect(finalVerify).toBeGreaterThan(
        lines.findIndex((l) =>
          l.includes('cloudformation delete-stack --stack-name starter-cdk-toolkit'),
        ),
      );
      await expectNoSecretLeak(r.output, s.secret ?? 'unset');
      expect(s.secret?.length).toBeGreaterThanOrEqual(43);
    });

    it('finops exit 5 (clean-with-unverifiable): categories printed with evidence, the bootstrap still goes, all.sh exits 5', async () => {
      const r = await runScript('all.sh', { FAKE_FINOPS_UNVERIFIABLE: '1' });
      expect(r.code, r.output).toBe(5);
      expect(r.output).toContain('UNVERIFIABLE kms-keys (unverifiable-with-this-role)');
      expect(r.output).toContain(
        'UNVERIFIABLE secretsmanager-secrets (unverifiable-with-this-role)',
      );
      expect(r.output).toMatch(
        /evidence: kms:ListKeys denied; .*arn:aws:kms:ap-southeast-1:\*{8}3333:key\/k1/,
      );
      expect(r.output).not.toContain('111122223333');
      const s = await state();
      expect(s.stacks).toEqual({});
      expect(s.toolkit).toBeNull();
      const run = await runDir();
      expect(JSON.parse(await readFile(join(run, 'all.json'), 'utf8'))).toMatchObject({
        up: 0,
        test: 0,
        rollback: 0,
        down: 5,
        bootstrapDestroy: 5,
      });
    });

    it('all.sh tears down after a failed deployment: what was deployed is destroyed, exit is non-zero', async () => {
      const r = await runScript('all.sh', { FAKE_FAIL_DEPLOY: 'Data' });
      expect(r.code, r.output).not.toBe(0);
      const lines = await calls();
      expect(deployOrder(lines)).toEqual(['Foundation', 'TestIssuer', 'Platform', 'Data']);
      expect(lines.some((l) => l.includes('run test:') || l.includes('exec vitest'))).toBe(false);
      expect(destroyOrder(lines)).toEqual(['Platform', 'TestIssuer', 'Foundation']);
      expect(unguardedMutations(lines)).toEqual([]);
      const s = await state();
      expect(s.stacks).toEqual({});
      expect(s.toolkit).toBeNull();
      const steps = (await readFile(join(await runDir(), 'steps.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { step: string; status: string });
      expect(steps.find((x) => x.status === 'failed')).toMatchObject({ step: 'deploy-data' });
    });

    it('a guard refusal stops the mutation: nothing deployed, and the teardown still runs', async () => {
      const r = await runScript('all.sh', { FAKE_GUARD_REFUSE: 'cdk deploy Sandbox-Foundation' });
      expect(r.code, r.output).not.toBe(0);
      const lines = await calls();
      expect(deployOrder(lines)).toEqual([]);
      expect(
        lines.some((l) => /^GUARD cdk deploy Sandbox-Foundation \[sbx-[0-9a-f]{6}\]/.test(l)),
      ).toBe(true);
      expect(lines.some((l) => l.startsWith('CALL finops verify-clean'))).toBe(true);
      expect((await state()).stacks).toEqual({});
    });

    it('a failing migration task fails up.sh before the API is deployed', async () => {
      const r = await runScript('all.sh', { FAKE_TASK_EXIT_DB_MIGRATE: '1' });
      expect(r.code, r.output).not.toBe(0);
      expect(r.output).toMatch(/the db-migrate task exited 1/);
      expect(deployOrder(await calls())).not.toContain('Api');
      expect((await state()).stacks).toEqual({});
    });

    it('image source: an unusable CI image falls back to a local build (recorded); SBX_IMAGE_SOURCE=ci refuses', async () => {
      expect((await runScript('bootstrap.sh')).code).toBe(0);
      const strict = await runScript('up.sh', { FAKE_CI_IMAGE: 'missing', SBX_IMAGE_SOURCE: 'ci' });
      expect(strict.code, strict.output).not.toBe(0);
      expect(strict.output).toMatch(
        /SBX_IMAGE_SOURCE=ci but the CI image is unusable: cannot inspect/,
      );
      const run = await runDir();
      const runId = run.split('/').pop() as string;
      const resumed = await runScript('up.sh', { FAKE_CI_IMAGE: 'missing', SBX_RUN_ID: runId });
      expect(resumed.code, resumed.output).toBe(0);
      const image = JSON.parse(await readFile(join(run, 'image', 'image.json'), 'utf8')) as {
        source: string;
        digest: string;
        provenance: string;
      };
      expect(image).toMatchObject({ source: 'local-build', digest: `sha256:${'b'.repeat(64)}` });
      expect(image.provenance).toMatch(/CI image not used: cannot inspect/);
      expect(
        (await calls()).some((l) => /^CALL podman .*build --platform linux\/arm64/.test(l)),
      ).toBe(true);
      expect((await runScript('down.sh', { SBX_RUN_ID: runId })).code).toBe(0);
    });

    it('up.sh refuses (exit 4, nothing mutated) without a private operator-role-arn file in the expected account', async () => {
      const file = join(w.home, 'operator-role-arn');
      await rm(file);
      const missing = await runScript('up.sh');
      expect(missing.code, missing.output).toBe(4);
      expect(missing.output).toMatch(/operator-role-arn is missing/);
      await writeFile(file, `${OPERATOR_ARN}\n`, { mode: 0o644 });
      await chmod(file, 0o644);
      expect((await runScript('up.sh')).code).toBe(4);
      await writeFile(file, 'arn:aws:iam::999988887777:role/someone-else\n');
      await chmod(file, 0o600);
      const foreign = await runScript('up.sh');
      expect(foreign.code, foreign.output).toBe(4);
      expect(foreign.output).not.toContain('999988887777');
      expect((await calls()).filter(isMutation)).toEqual([]);
    });
  },
);
