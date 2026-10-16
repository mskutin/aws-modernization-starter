#!/usr/bin/env node
/**
 * CLI entry: `BASE_URL=http://127.0.0.1:8080 node tests/smoke/dist/cli.js`
 * Exit codes: 0 = all steps passed, 1 = a step failed, 2 = bad configuration.
 * Set SMOKE_JUNIT=reports/junit/smoke.xml to also write a JUnit report.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { configFromEnv, runSmoke, toJUnit } from './smoke.js';

async function main(): Promise<number> {
  let cfg;
  try {
    cfg = configFromEnv(process.env);
  } catch (err) {
    console.error(`smoke: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  console.log(`smoke: target ${cfg.baseUrl}`);
  const result = await runSmoke({ ...cfg, log: (l) => console.log(l) });
  const junitPath = process.env.SMOKE_JUNIT;
  if (junitPath) {
    await mkdir(dirname(junitPath), { recursive: true });
    await writeFile(junitPath, toJUnit(result));
  }
  const passed = result.steps.filter((s) => s.ok).length;
  console.log(`smoke: ${result.ok ? 'PASSED' : 'FAILED'} (${passed}/6 steps passed)`);
  return result.ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
