#!/usr/bin/env node
/**
 * starter-ci — CI/CD supply-chain helper CLI.
 *
 *   status <aws|ai-review|release> --out <dir>  truthful status report: 0 = reported (incl. "not
 *                                               configured"), 78 = opted in but incomplete / opt-out
 *                                               (warning), 1 = opted in and misconfigured
 *   codequality eslint <eslint.json> <out.json> ESLint JSON -> GitLab Code Quality
 *   licenses --policy <yaml> --out <dir>        license allowlist + expiring exceptions
 *   supply-chain-lint --out <dir>               image/Dockerfile pinning + exception expiry
 *   provenance --image-json <file> --out <dir>  in-toto/SLSA provenance statement (unsigned)
 *   protected-secrets --out <dir>               no COSIGN_/AWS_ variable name, no runner-scoped
 *                                               secret mount in this (shared-runner) job
 *   chain-report --component <id> --out <dir>   every release-chain job ran on a protected
 *                                               runner from a fresh clone (job-token API)
 *   stale-report --out <dir>                    report-only stale branches/MRs/artifacts/tags (exit 79
 *                                               = findings, an allowed warning)
 *   gate-policy <state|init|approve|sync|render|check> …
 *                                               gate integrity (ADR 0410): offline file operations
 *                                               (sync --adopt-default-paths --git-dir D --expect-sha S:
 *                                               the list committed at --sha, which must equal the
 *                                               reviewed S; state via state --paths-from-rev; drops
 *                                               approvals; --allow-path-removal)
 *   gate-admin <install|approve|sync|status|exceptions> …
 *                                               the GitLab API driver of gate-policy for a Maintainer
 *                                               (GITLAB_URL, GITLAB_TOKEN_FILE; src/gate-admin.ts)
 *
 * Only Node builtins are imported statically: `status`, `codequality`, `provenance`,
 * `protected-secrets`, `chain-report` and `stale-report` run on a bare Node image without
 * `pnpm install`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { eslintToCodeQuality, summarize } from './codequality.ts';
import { type JunitCase, renderJunit } from './junit.ts';
import { buildStatement, provenanceStatus, validateMetadata } from './provenance.ts';
import {
  aiReviewStatus,
  awsStatus,
  NOT_CONFIGURED_EXIT,
  releaseStatus,
  renderStatusMarkdown,
} from './status.ts';
import { checkSecretsAbsent, renderSecretsBindingMarkdown } from './secrets-binding.ts';
import {
  type CloneEvidence,
  evaluateChain,
  type PipelineJob,
  protectedRunnerTags,
  renderChainMarkdown,
} from './chain-report.ts';
import { apiFromEnv, apiGet, apiGetAll } from './gitlab-api.ts';
import {
  DEFAULT_THRESHOLDS,
  evaluateStale,
  type BranchInfo,
  type JobInfo,
  type MergeRequestInfo,
  type RegistryTagInfo,
  renderStaleMarkdown,
} from './stale.ts';

import {
  approve as approveGate,
  assertReviewedHead,
  assertStateForPaths,
  changedLines,
  DEFAULT_GATE_PATHS,
  newPolicy,
  parsePolicy,
  renderChildConfig,
  renderEntryConfig,
  slugOf,
  syncPolicy,
  type GateState,
  verdict,
} from './gate-policy.ts';
import { gatePathsAt, stateAt } from './gate-policy-git.ts';

/** Exit code of a report-only job with findings: an allowed warning, never a pass. */
export const FINDINGS_EXIT = 79;

const today = (): string => new Date().toISOString().slice(0, 10);

function repoRoot(): string {
  let dir = resolve(process.env.CI_PROJECT_DIR ?? process.cwd());
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(process.cwd());
    dir = parent;
  }
}

function write(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function cmdStatus(feature: string | undefined, out: string): number {
  const status =
    feature === 'aws'
      ? awsStatus(process.env)
      : feature === 'ai-review'
        ? aiReviewStatus(process.env)
        : feature === 'release'
          ? releaseStatus(process.env)
          : undefined;
  if (!status) {
    console.error('usage: status <aws|ai-review|release> --out <dir>');
    return 2;
  }
  write(join(out, `${status.feature}.json`), `${JSON.stringify(status, null, 2)}\n`);
  write(join(out, `${status.feature}.md`), renderStatusMarkdown(status));
  for (const line of status.lines ?? []) console.log(line);
  console.log('');
  console.log(renderStatusMarkdown(status));
  if (status.exitCode === NOT_CONFIGURED_EXIT)
    console.log(`Exiting ${NOT_CONFIGURED_EXIT}: an allowed warning, not a pass.`);
  else if (status.exitCode !== 0)
    console.error(`Exiting ${status.exitCode}: an opted-in capability is misconfigured.`);
  return status.exitCode;
}

function cmdCodequality(
  kind: string | undefined,
  input: string | undefined,
  output: string | undefined,
): number {
  if (kind !== 'eslint' || !input || !output) {
    console.error('usage: codequality eslint <eslint.json> <out.json>');
    return 2;
  }
  if (!existsSync(input)) {
    console.error(`${input} not found (ESLint crashed before writing its report?)`);
    write(output, '[]\n');
    return 1;
  }
  const issues = eslintToCodeQuality(JSON.parse(readFileSync(input, 'utf8')), repoRoot());
  write(output, `${JSON.stringify(issues, null, 2)}\n`);
  console.log(summarize(issues));
  return 0;
}

async function loadYaml(file: string): Promise<unknown> {
  const { parseDocument } = await import('yaml');
  const doc = parseDocument(readFileSync(file, 'utf8'), {
    customTags: [
      {
        tag: '!reference',
        collection: 'seq',
        default: false,
        resolve: (value: unknown) => ({ __reference: (value as { toJSON(): unknown }).toJSON() }),
      } as never,
    ],
  });
  if (doc.errors.length > 0)
    throw new Error(`${file}: ${doc.errors.map((e) => e.message).join('; ')}`);
  return doc.toJS();
}

async function cmdLicenses(policyFile: string, out: string, asOf: string): Promise<number> {
  const { evaluate, fromPnpmJson, validatePolicy } = await import('./licenses.ts');
  const policy = validatePolicy(await loadYaml(policyFile));
  const r = spawnSync('pnpm', ['licenses', 'list', '--json', '--recursive'], {
    cwd: repoRoot(),
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status !== 0) {
    console.error(`pnpm licenses list failed (${r.status}): ${r.stderr}`);
    return 1;
  }
  const pkgs = fromPnpmJson(JSON.parse(r.stdout));
  const { findings, problems } = evaluate(pkgs, policy, asOf);
  const denied = findings.filter((f) => f.verdict.status === 'denied');
  const excepted = findings.filter((f) => f.verdict.status === 'excepted');
  const cases: JunitCase[] = findings.map((f) => ({
    classname: 'licenses',
    name: `${f.name}@${f.versions.join(',')} (${f.license})`,
    ...(f.verdict.status === 'denied' ? { failure: f.verdict.reason } : {}),
  }));
  write(join(out, 'junit.xml'), renderJunit('license-compliance', cases));
  write(join(out, 'licenses.json'), `${JSON.stringify({ asOf, findings, problems }, null, 2)}\n`);
  const byLicense = new Map<string, number>();
  for (const f of findings) byLicense.set(f.license, (byLicense.get(f.license) ?? 0) + 1);
  const md = [
    '# License compliance',
    '',
    `Packages: ${findings.length} — denied: ${denied.length}, excepted: ${excepted.length}`,
    '',
    '| License | Packages |',
    '| --- | --- |',
    ...[...byLicense.entries()].sort().map(([l, n]) => `| ${l} | ${n} |`),
    '',
    ...(denied.length
      ? [
          '## Denied',
          '',
          ...denied.map(
            (f) =>
              `- \`${f.name}\` (${f.license}): ${f.verdict.status === 'denied' ? f.verdict.reason : ''}`,
          ),
          '',
        ]
      : []),
    ...(excepted.length
      ? [
          '## Excepted',
          '',
          ...excepted.map(
            (f) =>
              `- \`${f.name}\` (${f.license}) until ${f.verdict.status === 'excepted' ? f.verdict.exception.expires : ''}`,
          ),
          '',
        ]
      : []),
    ...(problems.length ? ['## Warnings', '', ...problems.map((p) => `- ${p}`), ''] : []),
  ].join('\n');
  write(join(out, 'licenses.md'), md);
  console.log(md);
  return denied.length > 0 ? 1 : 0;
}

function walk(
  root: string,
  match: (rel: string) => boolean,
  skip = /(^|\/)(node_modules|\.git|dist|cdk\.out|\.pnpm-store|\.cache|reports|coverage)(\/|$)/,
): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const rel = relative(root, abs).split('\\').join('/');
      if (skip.test(rel)) continue;
      if (entry.isDirectory()) visit(abs);
      else if (match(rel)) out.push(rel);
    }
  };
  visit(root);
  return out.sort();
}

async function cmdSupplyChainLint(out: string, asOf: string): Promise<number> {
  const sc = await import('./supply-chain.ts');
  const root = repoRoot();
  const ciFiles = [
    '.gitlab-ci.yml',
    ...walk(root, (rel) => rel.startsWith('.gitlab/ci/') && /\.ya?ml$/.test(rel)),
  ].filter((f) => existsSync(join(root, f)));
  const docs = await Promise.all(
    ciFiles.map(async (file) => ({
      file,
      doc: ((await loadYaml(join(root, file))) ?? {}) as Record<string, unknown>,
    })),
  );
  const vars: Record<string, string> = {};
  for (const { doc } of docs) {
    const v = doc.variables;
    if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (typeof val === 'string') vars[k] = val;
        else if (
          val &&
          typeof val === 'object' &&
          typeof (val as { value?: unknown }).value === 'string'
        ) {
          vars[k] = (val as { value: string }).value;
        }
      }
    }
  }
  const findings = [
    ...sc.checkImageVariables(vars),
    ...sc.checkImageRefs(sc.collectImageRefs(docs), vars),
  ];

  // Dockerfiles: deliverables declared in components.yaml must be pinned (error); others warn.
  const manifest = (await loadYaml(join(root, 'components.yaml'))) as {
    components?: Array<{ build?: { artifact?: { dockerfile?: string } } }>;
  };
  const deliverables = new Set(
    (manifest.components ?? []).map((c) => c.build?.artifact?.dockerfile).filter(Boolean),
  );
  for (const file of walk(
    root,
    (rel) =>
      /(^|\/)(Dockerfile|Containerfile)([.-][^/]*)?$/.test(rel) && !rel.endsWith('.dockerignore'),
  )) {
    for (const f of sc.checkDockerfile(file, readFileSync(join(root, file), 'utf8'))) {
      findings.push(
        deliverables.has(file)
          ? f
          : { ...f, level: 'warning', message: `${f.message} (not a components.yaml deliverable)` },
      );
    }
  }
  for (const d of deliverables) {
    if (d && !existsSync(join(root, d)))
      findings.push({
        check: 'dockerfile-pin',
        subject: d,
        level: 'error',
        message: 'declared in components.yaml but missing',
      });
  }

  // Exceptions hygiene.
  const trivyIgnore = '.gitlab/security/trivyignore.yaml';
  const exceptionEntries = existsSync(join(root, trivyIgnore))
    ? sc.trivyIgnoreEntries(trivyIgnore, await loadYaml(join(root, trivyIgnore)))
    : [];
  const licensePolicy = '.gitlab/security/license-policy.yaml';
  if (existsSync(join(root, licensePolicy))) {
    const policy = (await loadYaml(join(root, licensePolicy))) as {
      exceptions?: Array<Record<string, unknown>>;
    };
    for (const e of policy.exceptions ?? []) {
      exceptionEntries.push({
        source: licensePolicy,
        id: String(e.package),
        expires: e.expires,
        justification: e.reason,
      });
    }
  }
  const sastExceptions = '.gitlab/security/sast-exceptions.json';
  if (existsSync(join(root, sastExceptions))) {
    const doc = JSON.parse(readFileSync(join(root, sastExceptions), 'utf8')) as {
      exceptions?: Array<Record<string, unknown>>;
    };
    for (const e of doc.exceptions ?? []) {
      exceptionEntries.push({
        source: sastExceptions,
        id: `${String(e.rule)} @ ${String(e.path)}`,
        expires: e.expires,
        justification: e.reason,
      });
    }
    findings.push(...sc.checkSastExceptionScope(sastExceptions, doc.exceptions ?? []));
  }
  const imageAge = '.gitlab/security/image-age-exceptions.yaml';
  if (existsSync(join(root, imageAge))) {
    const r = sc.imageAgeExceptionEntries(
      imageAge,
      await loadYaml(join(root, imageAge)),
      vars,
      asOf,
    );
    exceptionEntries.push(...r.entries);
    findings.push(...r.findings);
  }
  findings.push(...sc.checkExceptions(exceptionEntries, asOf));

  const errors = findings.filter((f) => f.level === 'error');
  const cases: JunitCase[] = [
    ...findings.map((f) => ({
      classname: f.check,
      name: `${f.subject}: ${f.message}`,
      ...(f.level === 'error' ? { failure: f.message } : { skipped: `warning: ${f.message}` }),
    })),
    {
      classname: 'summary',
      name: `checked ${ciFiles.length} CI files, ${exceptionEntries.length} exception(s)`,
    },
  ];
  write(join(out, 'junit.xml'), renderJunit('supply-chain-lint', cases));
  write(join(out, 'supply-chain-lint.json'), `${JSON.stringify({ asOf, findings }, null, 2)}\n`);
  for (const f of findings)
    console.log(`[${f.level.toUpperCase()}] ${f.check} ${f.subject}: ${f.message}`);
  console.log(
    `supply-chain-lint: ${errors.length} error(s), ${findings.length - errors.length} warning(s); ${ciFiles.length} CI files, ${exceptionEntries.length} exception(s)`,
  );
  return errors.length > 0 ? 1 : 0;
}

function cmdProvenance(imageJson: string, out: string): number {
  const meta = validateMetadata(JSON.parse(readFileSync(imageJson, 'utf8')));
  const registry = process.env.CI_REGISTRY_IMAGE;
  const subject = registry
    ? `${registry}/${meta.image.split('/').pop()}`
    : `localhost/${meta.image}`;
  const statement = buildStatement(meta, subject);
  const env = process.env;
  const status = provenanceStatus(
    env.CI_COMMIT_REF_PROTECTED === 'true' &&
      (Boolean(env.CI_COMMIT_TAG) || env.CI_COMMIT_BRANCH === env.CI_DEFAULT_BRANCH),
    env.STARTER_RELEASE_SIGNING === 'true',
  );
  write(join(out, `${meta.component}.intoto.json`), `${JSON.stringify(statement, null, 2)}\n`);
  // Predicate alone, for `cosign attest --type slsaprovenance1 --predicate`.
  write(
    join(out, `${meta.component}.predicate.json`),
    `${JSON.stringify(statement.predicate, null, 2)}\n`,
  );
  write(join(out, `${meta.component}.status.json`), `${JSON.stringify(status, null, 2)}\n`);
  console.log(`provenance: ${subject}@${meta.digest}`);
  console.log(
    `  materials: commit ${meta.git.commit}, ${meta.baseImages.length} base image(s), lockfile ${meta.lockfileSha256 ? 'sha256:' + meta.lockfileSha256 : 'n/a'}`,
  );
  console.log(`  ${String(status.signing)}`);
  return 0;
}

function cmdProtectedSecrets(out: string): number {
  const result = checkSecretsAbsent(process.env, (p) => existsSync(p));
  const md = renderSecretsBindingMarkdown(result, {
    runner: process.env.CI_RUNNER_DESCRIPTION,
    ref: process.env.CI_COMMIT_REF_NAME,
    protectedRef: process.env.CI_COMMIT_REF_PROTECTED,
  });
  write(join(out, 'secrets-binding.json'), `${JSON.stringify(result, null, 2)}\n`);
  write(join(out, 'secrets-binding.md'), md);
  console.log(md);
  return result.ok ? 0 : 1;
}

async function cmdChainReport(component: string | undefined, out: string): Promise<number> {
  if (!component) {
    console.error('usage: chain-report --component <id> --out <dir>');
    return 2;
  }
  const api = apiFromEnv(process.env);
  const project = process.env.CI_PROJECT_ID;
  const pipeline = process.env.CI_PIPELINE_ID;
  const jobs = await apiGetAll<PipelineJob>(
    api,
    `/projects/${project}/pipelines/${pipeline}/jobs?include_retried=true`,
  );
  // Clone evidence artifacts (tools/ci/scripts/clone-evidence.sh): the job token can download
  // artifacts of its project, but not job logs (HTTP 401).
  const evidence = new Map<number, CloneEvidence | undefined>();
  for (const job of jobs.filter(
    (j) => j.name.startsWith('container:') && j.name.endsWith(`:${component}`),
  )) {
    const r = await apiGet(
      api,
      `/projects/${project}/jobs/${job.id}/artifacts/reports/chain/clone-${job.id}.json`,
    );
    evidence.set(job.id, r.status === 200 ? (JSON.parse(r.text) as CloneEvidence) : undefined);
  }
  const allowed = protectedRunnerTags(process.env);
  const result = evaluateChain(component, jobs, evidence, allowed);
  const md = renderChainMarkdown(result, process.env.CI_PIPELINE_URL);
  write(join(out, `${component}.chain.json`), `${JSON.stringify(result, null, 2)}\n`);
  write(join(out, `${component}.chain.md`), md);
  console.log(md);
  return result.ok ? 0 : 1;
}

async function cmdStaleReport(out: string): Promise<number> {
  const api = apiFromEnv(process.env);
  const project = process.env.CI_PROJECT_ID;
  const days = (name: string, fallback: number): number => {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  const thresholds = {
    branchDays: days('STALE_BRANCH_DAYS', DEFAULT_THRESHOLDS.branchDays),
    mergeRequestDays: days('STALE_MR_DAYS', DEFAULT_THRESHOLDS.mergeRequestDays),
    artifactDays: days('STALE_ARTIFACT_DAYS', DEFAULT_THRESHOLDS.artifactDays),
    registryTagDays: days('STALE_TAG_DAYS', DEFAULT_THRESHOLDS.registryTagDays),
  };
  const branches = await apiGetAll<BranchInfo>(api, `/projects/${project}/repository/branches`);
  const mergeRequests = await apiGetAll<MergeRequestInfo>(
    api,
    `/projects/${project}/merge_requests?state=opened`,
  );
  const jobs = await apiGetAll<JobInfo>(
    api,
    `/projects/${project}/jobs?scope[]=success&scope[]=failed`,
    5,
  );
  const registryTags: RegistryTagInfo[] = [];
  const repos = await apiGetAll<{ id: number; path: string }>(
    api,
    `/projects/${project}/registry/repositories`,
  );
  for (const repo of repos) {
    const tags = await apiGetAll<{ name: string }>(
      api,
      `/projects/${project}/registry/repositories/${repo.id}/tags`,
    );
    for (const tag of tags.slice(0, 200)) {
      const r = await apiGet(
        api,
        `/projects/${project}/registry/repositories/${repo.id}/tags/${encodeURIComponent(tag.name)}`,
      );
      const detail =
        r.status === 200
          ? (JSON.parse(r.text) as { created_at?: string; total_size?: number })
          : {};
      registryTags.push({
        repository: repo.path,
        name: tag.name,
        created_at: detail.created_at ?? null,
        total_size: detail.total_size ?? null,
      });
    }
  }
  const defaultBranch = process.env.CI_DEFAULT_BRANCH ?? 'main';
  const report = evaluateStale(
    {
      defaultBranch,
      branches,
      mergeRequests,
      jobs,
      registryTags,
      keepTags: [defaultBranch, 'latest'],
    },
    new Date(),
    thresholds,
  );
  const md = renderStaleMarkdown(report);
  write(join(out, 'stale.json'), `${JSON.stringify(report, null, 2)}\n`);
  write(join(out, 'stale.md'), md);
  console.log(md);
  if (report.findings.length > 0) {
    console.log(
      `Exiting ${FINDINGS_EXIT}: findings are reported as a warning (report only, nothing deleted).`,
    );
    return FINDINGS_EXIT;
  }
  return 0;
}

function cmdGatePolicy(
  sub: string | undefined,
  v: Record<string, string | boolean | undefined>,
): number {
  const need = (k: string): string => {
    const x = v[k];
    if (typeof x !== 'string' || x.length === 0)
      throw new Error(`gate-policy ${sub}: --${k} is required`);
    return x;
  };
  const readState = (): GateState => JSON.parse(readFileSync(need('state'), 'utf8')) as GateState;
  const save = (policy: unknown): void =>
    write(need('out'), `${JSON.stringify(policy, null, 2)}\n`);
  switch (sub) {
    case 'state': {
      const gitDir = need('git-dir');
      const rev = need('rev');
      // --paths-from-rev: the default list as committed at <rev> (adoption, install), never the
      // list of this working tree.
      const paths =
        typeof v.policy === 'string'
          ? parsePolicy(readFileSync(v.policy, 'utf8')).paths
          : v['paths-from-rev'] === true
            ? gatePathsAt(gitDir, rev)
            : DEFAULT_GATE_PATHS;
      const state = stateAt(gitDir, rev, paths);
      const out = `${JSON.stringify(state, null, 2)}\n`;
      if (typeof v.out === 'string') write(v.out, out);
      else process.stdout.write(out);
      return 0;
    }
    case 'init': {
      // With --git-dir the path list is the one committed at --sha.
      const paths =
        typeof v['git-dir'] === 'string' ? gatePathsAt(v['git-dir'], need('sha')) : undefined;
      const referenceState = readState();
      if (paths) assertStateForPaths(referenceState, paths);
      save(
        newPolicy({
          project: need('project'),
          defaultBranch: need('default-branch'),
          policyProject: need('policy-project'),
          image: need('image'),
          ...(typeof v['runner-tag'] === 'string' ? { runnerTag: v['runner-tag'] } : {}),
          ...(paths ? { paths } : {}),
          referenceSha: need('sha'),
          referenceState,
          now: new Date(),
        }),
      );
      return 0;
    }
    case 'approve': {
      const policy = parsePolicy(readFileSync(need('policy'), 'utf8'));
      const state = readState();
      assertStateForPaths(state, policy.paths);
      const mr = typeof v.mr === 'string' ? Number(v.mr) : null;
      const next = approveGate(policy, {
        stateId: state.id,
        mr: mr !== null && Number.isInteger(mr) ? mr : null,
        sha: need('sha'),
        approvedBy: need('by'),
        approvedAt: new Date().toISOString(),
        reason: typeof v.reason === 'string' ? v.reason : '',
        changed: changedLines(policy.reference.state, state),
      });
      save(next);
      console.log(
        state.id === policy.reference.state.id
          ? `state ${state.id} equals the reference: nothing to approve`
          : `approved state ${state.id}${mr ? ` for !${mr}` : ''}; changed entries:\n${changedLines(
              policy.reference.state,
              state,
            )
              .map((l) => `  ${l}`)
              .join('\n')}`,
      );
      return 0;
    }
    case 'sync': {
      const policy = parsePolicy(readFileSync(need('policy'), 'utf8'));
      const open =
        typeof v['open-mrs'] === 'string' && v['open-mrs'].length > 0
          ? v['open-mrs'].split(',').map(Number).filter(Number.isInteger)
          : [];
      const state = readState();
      const sha = need('sha');
      const adopt =
        v['adopt-default-paths'] === true
          ? {
              // Checked first: adopting a path list is a review decision about one commit.
              expectSha: typeof v['expect-sha'] === 'string' ? v['expect-sha'] : undefined,
              allowPathRemoval: v['allow-path-removal'] === true,
            }
          : undefined;
      if (adopt) assertReviewedHead(sha, adopt.expectSha); // before reading anything at `sha`
      const result = syncPolicy({
        policy,
        state,
        sha,
        openMrs: open,
        now: new Date(),
        // The list committed at the synced head, never this working tree's.
        ...(adopt ? { adopt: { ...adopt, paths: gatePathsAt(need('git-dir'), sha) } } : {}),
      });
      save(result.policy);
      for (const line of result.report) console.log(line);
      return 0;
    }
    case 'render': {
      const policy = parsePolicy(readFileSync(need('policy'), 'utf8'));
      const dir = need('out-dir');
      write(join(dir, 'gate-policy.yml'), renderEntryConfig(policy));
      write(join(dir, 'gate-integrity.yml'), renderChildConfig(policy));
      console.log(
        `rendered projects/${slugOf(policy.project)}/{gate-policy.yml,gate-integrity.yml}`,
      );
      return 0;
    }
    case 'check': {
      const policy = parsePolicy(readFileSync(need('policy'), 'utf8'));
      const state = readState();
      assertStateForPaths(state, policy.paths);
      const r = verdict(policy, state.id);
      console.log(`${r.pass ? 'PASS' : 'BLOCKED'}: ${state.id} ${r.reason}`);
      return r.pass ? 0 : 1;
    }
    default:
      console.error(
        'usage: gate-policy <state|init|approve|sync|render|check> … (see tools/ci/src/gate-policy.ts)',
      );
      return 2;
  }
}

export async function main(argv: string[]): Promise<number> {
  if (argv[0] === 'gate-admin') {
    // Own option set; never in CI (a Maintainer's token, read from GITLAB_TOKEN_FILE).
    const { gateAdmin } = await import('./gate-admin.ts');
    return gateAdmin(argv.slice(1), {
      env: process.env,
      log: (line) => console.error(line),
      out: (line) => console.log(line),
    });
  }
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      policy: { type: 'string' },
      today: { type: 'string' },
      'image-json': { type: 'string' },
      component: { type: 'string' },
      // gate-policy (also uses --policy)
      'git-dir': { type: 'string' },
      rev: { type: 'string' },
      state: { type: 'string' },
      project: { type: 'string' },
      'default-branch': { type: 'string' },
      'policy-project': { type: 'string' },
      image: { type: 'string' },
      sha: { type: 'string' },
      mr: { type: 'string' },
      by: { type: 'string' },
      reason: { type: 'string' },
      'open-mrs': { type: 'string' },
      'adopt-default-paths': { type: 'boolean' },
      'paths-from-rev': { type: 'boolean' },
      'allow-path-removal': { type: 'boolean' },
      'expect-sha': { type: 'string' },
      'out-dir': { type: 'string' },
      'runner-tag': { type: 'string' },
    },
  });
  const [command, ...rest] = positionals;
  const out = resolve(values.out ?? 'reports');
  switch (command) {
    case 'status':
      return cmdStatus(rest[0], out);
    case 'codequality':
      return cmdCodequality(rest[0], rest[1], rest[2]);
    case 'licenses':
      return cmdLicenses(
        values.policy ?? '.gitlab/security/license-policy.yaml',
        out,
        values.today ?? today(),
      );
    case 'supply-chain-lint':
      return cmdSupplyChainLint(out, values.today ?? today());
    case 'provenance':
      if (!values['image-json']) break;
      return cmdProvenance(values['image-json'], out);
    case 'protected-secrets':
      return cmdProtectedSecrets(out);
    case 'chain-report':
      return cmdChainReport(values.component, out);
    case 'stale-report':
      return cmdStaleReport(out);
    case 'gate-policy':
      return cmdGatePolicy(rest[0], { ...values, out: values.out });
    default:
      break;
  }
  console.error(
    'usage: starter-ci <status|codequality|licenses|supply-chain-lint|provenance|protected-secrets|chain-report|stale-report|gate-policy|gate-admin> … (see src/cli.ts)',
  );
  return 2;
}

if (process.argv[1]?.endsWith('/cli.ts')) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
      process.exit(1);
    },
  );
}
