#!/usr/bin/env node
// Runs `vitest related` for staged TypeScript files, grouped by workspace package.
// Fast feedback only; CI runs every affected test suite. Unit tests only: a package takes part only
// if it has a vitest `test:unit` (else `test`) script, and the vitest projects that script selects
// (`--project unit`) are passed on, so suites that need the local stack or containers (integration,
// outage, e2e) never run in a commit hook.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join, relative, resolve } from 'node:path';

const root = resolve(process.cwd());
const byPackage = new Map();
for (const file of process.argv.slice(2)) {
  if (!/\.(ts|tsx)$/.test(file) || !existsSync(file)) continue;
  let dir = dirname(resolve(file));
  while (dir.startsWith(root) && dir !== root && !existsSync(join(dir, 'package.json')))
    dir = dirname(dir);
  if (dir === root || !dir.startsWith(root)) continue;
  const hasVitest =
    ['vitest.config.ts', 'vitest.config.mts', 'vite.config.ts'].some((f) =>
      existsSync(join(dir, f)),
    ) || /vitest/.test(readFileSync(join(dir, 'package.json'), 'utf8'));
  if (!hasVitest) continue;
  if (!byPackage.has(dir)) byPackage.set(dir, []);
  byPackage.get(dir).push(relative(dir, resolve(file)));
}

/**
 * `--project <name>` arguments of the package's unit-test script (`test:unit`, else `test`), or null
 * when the package has no vitest unit-test script.
 */
function unitProjects(dir) {
  const scripts = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).scripts ?? {};
  const unit = scripts['test:unit'] ?? scripts.test;
  if (typeof unit !== 'string' || !/\bvitest\b/.test(unit)) return null;
  return [...unit.matchAll(/--project[= ](\S+)/g)].flatMap((m) => ['--project', m[1]]);
}
// Git exports GIT_DIR, GIT_INDEX_FILE & co. to hooks. A test that runs `git` in a fixture with the
// inherited environment would write into THIS repository (it once committed fixtures onto a branch
// and set core.bare=true). Tests never get any GIT_* variable from the hook.
const testEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
);
let status = 0;
for (const [dir, files] of byPackage) {
  const projects = unitProjects(dir);
  if (projects === null) {
    console.log(`vitest related (${relative(root, dir)}): skipped — no vitest unit-test script`);
    continue;
  }
  console.log(`vitest related (${relative(root, dir)}): ${files.length} file(s)`);
  // Root devDependency binary: no pnpm needed on PATH.
  // Like `pnpm run`: the package's and the root's node_modules/.bin come first on PATH (CDK bundling
  // runs `pnpm exec esbuild`, which resolves esbuild through PATH).
  const path = [join(dir, 'node_modules/.bin'), join(root, 'node_modules/.bin'), testEnv.PATH ?? '']
    .filter(Boolean)
    .join(delimiter);
  const r = spawnSync(
    join(root, 'node_modules/.bin/vitest'),
    ['related', '--run', '--passWithNoTests', ...projects, ...files],
    {
      cwd: dir,
      env: { ...testEnv, PATH: path },
      stdio: 'inherit',
    },
  );
  if (r.status !== 0) status = r.status ?? 1;
}
process.exit(status);
