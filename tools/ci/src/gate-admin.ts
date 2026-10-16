/**
 * gate-admin — the GitLab API driver of the optional gate-integrity policy (ADR 0410), run by a
 * Maintainer on their own machine, never in CI.
 *
 *   gate-admin <command> --project <path> --policy-project <path> [options]
 *
 *   install [--set-ci-config-path] [--runner-tag TAG]
 *       write projects/<slug>/{policy.json,gate-policy.yml,gate-integrity.yml} into the policy project
 *       for the default branch's current state (an existing policy is re-synced instead);
 *       --set-ci-config-path also points the project's CI/CD configuration file at it.
 *   approve --mr IID [--reason TEXT] [--rerun]
 *       approve the gate state of the MR's head commit AFTER reviewing its gate-path diff; --rerun
 *       starts a new MR pipeline (a retried job keeps the policy it was created with).
 *   sync [--adopt-default-paths --expect-head SHA [--allow-path-removal]]
 *       re-pin the reference to the default branch (after a merge) and drop approvals of merged or
 *       closed MRs. --adopt-default-paths also switches the stored path list to DEFAULT_GATE_PATHS AS
 *       COMMITTED AT THE DEFAULT-BRANCH HEAD (never this checkout) and drops ALL approvals; it REQUIRES
 *       --expect-head (the reviewed commit) and refuses if the branch moved; removing a path needs
 *       --allow-path-removal.
 *   status
 *       reference, approvals and the project's ci_config_path.
 *   exceptions --file APPROVALS.yaml
 *       store Maintainer-approved exception digests in the policy project and in the project's file
 *       variable STARTER_EXCEPTION_APPROVALS (read by policy:<infra>).
 *
 * Configuration (environment; no defaults that name a host):
 *   GITLAB_URL            e.g. https://gitlab.example.com (plain http only for a loopback address or
 *                         with GATE_ADMIN_ALLOW_HTTP=true)
 *   GITLAB_TOKEN_FILE     a file holding the Maintainer's token (api scope); mode 0600 or stricter.
 *                         The token is read from the file, sent only as a request header (API) or
 *                         through GIT_ASKPASS (git), and never printed or put on a command line.
 *   GATE_ADMIN_CACHE_DIR  bare object cache of the target projects
 *                         (default ${XDG_CACHE_HOME:-~/.cache}/starter-gate-admin)
 */
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  approve,
  assertReviewedHead,
  changedLines,
  type GatePolicy,
  newPolicy,
  parsePolicy,
  POLICY_REF,
  prune,
  renderChildConfig,
  renderEntryConfig,
  RUNNER_TAG,
  slugOf,
  syncPolicy,
} from './gate-policy.ts';
import { cleanGitEnv, gatePathsAt, stateAt } from './gate-policy-git.ts';

export const EXCEPTION_APPROVALS_VARIABLE = 'STARTER_EXCEPTION_APPROVALS';

const USAGE =
  'usage: gate-admin <install|approve|sync|status|exceptions> --project PATH --policy-project PATH [options] (see tools/ci/src/gate-admin.ts)';

export interface AdminIo {
  env: NodeJS.ProcessEnv;
  /** Progress and diagnostics (stderr). */
  log: (line: string) => void;
  /** Results (stdout). */
  out: (line: string) => void;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Repository root that holds .gitlab/ci/images.yml (the pinned child-job image). */
  repoRoot?: string;
}

class UsageError extends Error {}

/** Resolved, validated configuration. The token value itself is held only in memory. */
interface Config {
  apiBase: string;
  webBase: string;
  token: string;
  tokenFile: string;
  cacheDir: string;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function readConfig(env: NodeJS.ProcessEnv): Config {
  const raw = env.GITLAB_URL ?? '';
  if (!raw) throw new UsageError('GITLAB_URL is required (e.g. https://gitlab.example.com)');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageError('GITLAB_URL is not a URL');
  }
  if (url.username || url.password) throw new UsageError('GITLAB_URL must not contain credentials');
  if (url.protocol !== 'https:') {
    const allowed =
      url.protocol === 'http:' &&
      (LOOPBACK.has(url.hostname) || env.GATE_ADMIN_ALLOW_HTTP === 'true');
    if (!allowed)
      throw new UsageError(
        'GITLAB_URL must be https:// (plain http only for a loopback address or with GATE_ADMIN_ALLOW_HTTP=true)',
      );
  }
  const tokenFile = env.GITLAB_TOKEN_FILE ?? '';
  if (!tokenFile) throw new UsageError('GITLAB_TOKEN_FILE is required (a file holding the token)');
  if (!existsSync(tokenFile)) throw new UsageError('GITLAB_TOKEN_FILE does not exist');
  if (process.platform !== 'win32' && (statSync(tokenFile).mode & 0o077) !== 0)
    throw new UsageError('GITLAB_TOKEN_FILE is readable by group or others: chmod 600 it');
  const token = (readFileSync(tokenFile, 'utf8').split('\n')[0] ?? '').trim();
  if (!token) throw new UsageError('GITLAB_TOKEN_FILE is empty');
  const webBase = `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  const cacheDir =
    env.GATE_ADMIN_CACHE_DIR ??
    join(env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'starter-gate-admin');
  return { apiBase: `${webBase}/api/v4`, webBase, token, tokenFile, cacheDir };
}

interface Reply {
  status: number;
  text: string;
  nextPage: string | null;
}

class GitLab {
  private readonly cfg: Config;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: Config, fetchImpl: typeof fetch) {
    this.cfg = cfg;
    this.fetchImpl = fetchImpl;
  }

  async call(method: string, path: string, body?: unknown): Promise<Reply> {
    const res = await this.fetchImpl(`${this.cfg.apiBase}${path}`, {
      method,
      headers: {
        'PRIVATE-TOKEN': this.cfg.token,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
    });
    return {
      status: res.status,
      text: await res.text(),
      nextPage: res.headers.get('x-next-page') || null,
    };
  }

  /** JSON of a 2xx answer; anything else throws with method, path and status (never headers). */
  async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await this.call(method, path, body);
    if (r.status < 200 || r.status > 299) {
      const detail = r.text.length > 300 ? `${r.text.slice(0, 300)}…` : r.text;
      throw new Error(`${method} ${path.split('?')[0]} -> HTTP ${r.status} ${detail}`);
    }
    return JSON.parse(r.text) as T;
  }

  async all<T>(path: string, maxPages = 20): Promise<T[]> {
    const out: T[] = [];
    let page: string | null = '1';
    for (let i = 0; page && i < maxPages; i += 1) {
      const sep = path.includes('?') ? '&' : '?';
      const r = await this.call('GET', `${path}${sep}per_page=100&page=${page}`);
      if (r.status !== 200) throw new Error(`GET ${path.split('?')[0]} -> HTTP ${r.status}`);
      out.push(...(JSON.parse(r.text) as T[]));
      page = r.nextPage;
    }
    return out;
  }
}

const enc = encodeURIComponent;

/** IMG_NODE (version + digest) from the repository's pinned image list. */
export function pinnedNodeImage(repoRoot: string): string {
  const text = readFileSync(join(repoRoot, '.gitlab/ci/images.yml'), 'utf8');
  const image = /^\s*IMG_NODE:\s*(\S+)\s*$/m.exec(text)?.[1] ?? '';
  if (!/@sha256:[a-f0-9]{64}$/.test(image))
    throw new Error('IMG_NODE (digest-pinned) not found in .gitlab/ci/images.yml');
  return image;
}

const execFileAsync = promisify(execFile);

/** Fetch one ref of `project` into the bare cache; returns the fetched commit id. */
async function gitFetch(
  cfg: Config,
  cache: string,
  project: string,
  refspec: string,
): Promise<string> {
  if (!existsSync(cache)) {
    mkdirSync(dirname(cache), { recursive: true });
    const init = spawnSync('git', ['init', '-q', '--bare', cache], {
      env: cleanGitEnv(),
      encoding: 'utf8',
    });
    if (init.status !== 0) throw new Error(`git init ${cache}: ${init.stderr}`);
  }
  // The token reaches git only through GIT_ASKPASS reading the token file: never argv, never a URL,
  // never a credential helper (credential.helper is emptied).
  const dir = mkdtempSync(join(tmpdir(), 'gate-admin-'));
  try {
    const askpass = join(dir, 'askpass.sh');
    writeFileSync(
      askpass,
      '#!/bin/sh\ncase "$1" in\n  Username*) printf \'%s\\n\' oauth2 ;;\n  *) head -n 1 "$GATE_ADMIN_TOKEN_FILE" ;;\nesac\n',
    );
    chmodSync(askpass, 0o700);
    await execFileAsync(
      'git',
      [
        '--git-dir',
        cache,
        '-c',
        'credential.helper=',
        '-c',
        'http.sslVerify=true',
        'fetch',
        '-q',
        '--no-tags',
        '--depth',
        '1',
        `${cfg.webBase}/${project}.git`,
        refspec,
      ],
      {
        encoding: 'utf8',
        env: {
          ...cleanGitEnv(),
          GIT_ASKPASS: askpass,
          GATE_ADMIN_TOKEN_FILE: cfg.tokenFile,
          GIT_TERMINAL_PROMPT: '0',
          GIT_CONFIG_NOSYSTEM: '1',
        },
      },
    ).catch((error: unknown) => {
      const stderr = String((error as { stderr?: unknown }).stderr ?? '').trim();
      throw new Error(`git fetch ${project} ${refspec} failed: ${stderr}`);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const head = spawnSync('git', ['--git-dir', cache, 'rev-parse', 'FETCH_HEAD'], {
    encoding: 'utf8',
    env: cleanGitEnv(),
  });
  if (head.status !== 0) throw new Error(`git rev-parse FETCH_HEAD: ${head.stderr}`);
  return head.stdout.trim();
}

interface Options {
  command: string;
  project: string;
  policyProject: string;
  mr?: number;
  reason?: string;
  rerun: boolean;
  setCiConfigPath: boolean;
  adoptDefaultPaths: boolean;
  expectHead?: string;
  allowPathRemoval: boolean;
  file?: string;
  runnerTag?: string;
}

const PROJECT_PATH = /^[\w.-]+(?:\/[\w.-]+)+$/;

function parseArgsStrict(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      project: { type: 'string' },
      'policy-project': { type: 'string' },
      mr: { type: 'string' },
      reason: { type: 'string' },
      rerun: { type: 'boolean' },
      'set-ci-config-path': { type: 'boolean' },
      'adopt-default-paths': { type: 'boolean' },
      'expect-head': { type: 'string' },
      'allow-path-removal': { type: 'boolean' },
      file: { type: 'string' },
      'runner-tag': { type: 'string' },
    },
  });
}

export function parseAdminArgs(argv: string[]): Options {
  let parsed: ReturnType<typeof parseArgsStrict>;
  try {
    parsed = parseArgsStrict(argv);
  } catch (error) {
    throw new UsageError(`${(error as Error).message}\n${USAGE}`);
  }
  const { values, positionals } = parsed;
  const command = positionals[0] ?? '';
  if (!['install', 'approve', 'sync', 'status', 'exceptions'].includes(command))
    throw new UsageError(USAGE);
  const project = values.project ?? '';
  const policyProject = values['policy-project'] ?? '';
  if (!PROJECT_PATH.test(project)) throw new UsageError('--project <group/project> is required');
  if (!PROJECT_PATH.test(policyProject))
    throw new UsageError(
      '--policy-project <group/project> is required (the Maintainer-only policy project)',
    );
  if (project === policyProject)
    throw new UsageError('--policy-project must differ from --project');
  const o: Options = {
    command,
    project,
    policyProject,
    rerun: values.rerun === true,
    setCiConfigPath: values['set-ci-config-path'] === true,
    adoptDefaultPaths: values['adopt-default-paths'] === true,
    allowPathRemoval: values['allow-path-removal'] === true,
  };
  if (values.mr !== undefined) {
    if (!/^\d+$/.test(values.mr)) throw new UsageError('--mr must be an MR IID');
    o.mr = Number(values.mr);
  }
  if (values.reason !== undefined) o.reason = values.reason;
  if (values.file !== undefined) o.file = values.file;
  if (values['runner-tag'] !== undefined) {
    if (!RUNNER_TAG.test(values['runner-tag']))
      throw new UsageError('--runner-tag is not a plain runner tag');
    o.runnerTag = values['runner-tag'];
  }
  if (values['expect-head'] !== undefined) {
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(values['expect-head']))
      throw new UsageError('--expect-head must be a full commit id');
    o.expectHead = values['expect-head'];
  }
  if (command === 'approve' && o.mr === undefined)
    throw new UsageError('approve: --mr IID is required');
  if (command === 'exceptions' && !o.file)
    throw new UsageError('exceptions: --file APPROVALS.yaml is required');
  // Adopting a new path list is a review decision about one commit.
  if (o.adoptDefaultPaths && !o.expectHead)
    throw new UsageError(
      'sync --adopt-default-paths requires --expect-head <reviewed default-branch sha>',
    );
  if (!o.adoptDefaultPaths && (o.expectHead || o.allowPathRemoval))
    throw new UsageError(
      '--expect-head and --allow-path-removal only apply to sync --adopt-default-paths',
    );
  return o;
}

export async function gateAdmin(argv: string[], io: AdminIo): Promise<number> {
  let o: Options;
  let cfg: Config;
  try {
    o = parseAdminArgs(argv);
    cfg = readConfig(io.env);
  } catch (error) {
    if (error instanceof UsageError) {
      io.log(`gate-admin: ${error.message}`);
      return 2;
    }
    throw error;
  }
  const now = io.now ?? (() => new Date());
  const api = new GitLab(cfg, io.fetchImpl ?? fetch);
  const slug = slugOf(o.project);
  const dir = `projects/${slug}`;
  const cache = join(cfg.cacheDir, `${slug}.git`);

  const project = await api.json<{
    id: number;
    default_branch: string | null;
    ci_config_path?: string | null;
  }>('GET', `/projects/${enc(o.project)}`);
  const policyProject = await api.json<{ id: number }>('GET', `/projects/${enc(o.policyProject)}`);
  const defaultBranch = project.default_branch ?? '';
  if (!defaultBranch) throw new Error(`${o.project} has no default branch`);
  const pid = project.id;
  const ppid = policyProject.id;

  const fileUrl = (name: string): string =>
    `/projects/${ppid}/repository/files/${enc(`${dir}/${name}`)}`;
  const fileExists = async (name: string): Promise<boolean> =>
    (await api.call('GET', `${fileUrl(name)}?ref=${enc(POLICY_REF)}`)).status === 200;
  const readPolicy = async (): Promise<GatePolicy> => {
    const r = await api.call('GET', `${fileUrl('policy.json')}/raw?ref=${enc(POLICY_REF)}`);
    if (r.status === 404)
      throw new Error(
        `no gate policy for ${o.project} in ${o.policyProject} (run: gate-admin install)`,
      );
    if (r.status !== 200) throw new Error(`reading ${dir}/policy.json -> HTTP ${r.status}`);
    return parsePolicy(r.text);
  };
  const commitFiles = async (message: string, files: Record<string, string>): Promise<void> => {
    const actions = [];
    for (const [name, content] of Object.entries(files)) {
      actions.push({
        action: (await fileExists(name)) ? 'update' : 'create',
        file_path: `${dir}/${name}`,
        content,
      });
    }
    const c = await api.json<{ short_id: string; title: string }>(
      'POST',
      `/projects/${ppid}/repository/commits`,
      { branch: POLICY_REF, commit_message: message, actions },
    );
    io.log(`committed ${c.short_id} to ${o.policyProject}: ${c.title}`);
  };
  const renderAndCommit = async (policy: GatePolicy, message: string): Promise<void> => {
    await commitFiles(message, {
      'policy.json': `${JSON.stringify(policy, null, 2)}\n`,
      'gate-policy.yml': renderEntryConfig(policy),
      'gate-integrity.yml': renderChildConfig(policy),
    });
  };
  const openMrs = async (): Promise<number[]> =>
    (await api.all<{ iid: number }>(`/projects/${pid}/merge_requests?state=opened`)).map(
      (m) => m.iid,
    );
  /** Head of the default branch, fetched by name and checked against the API. */
  const defaultHead = async (): Promise<string> => {
    const branch = await api.json<{ commit: { id: string } }>(
      'GET',
      `/projects/${pid}/repository/branches/${enc(defaultBranch)}`,
    );
    const fetched = await gitFetch(cfg, cache, o.project, `refs/heads/${defaultBranch}`);
    if (fetched !== branch.commit.id)
      throw new Error(`${defaultBranch} moved while fetching; retry`);
    return fetched;
  };
  const ciConfigPath = `${dir}/gate-policy.yml@${o.policyProject}`;

  switch (o.command) {
    case 'install': {
      const head = await defaultHead();
      let policy: GatePolicy;
      if (await fileExists('policy.json')) {
        io.log(
          `${o.policyProject} already holds a policy for ${o.project}: re-syncing it (its stored paths)`,
        );
        const stored = await readPolicy();
        const withTag = o.runnerTag === undefined ? stored : { ...stored, runnerTag: o.runnerTag };
        const r = syncPolicy({
          policy: withTag,
          state: stateAt(cache, head, withTag.paths),
          sha: head,
          openMrs: await openMrs(),
          now: now(),
        });
        r.report.forEach(io.log);
        policy = r.policy;
      } else {
        // A new policy takes the default path list committed at the head, never this checkout's.
        const paths = gatePathsAt(cache, head);
        policy = newPolicy({
          project: o.project,
          defaultBranch,
          policyProject: o.policyProject,
          image: pinnedNodeImage(io.repoRoot ?? join(import.meta.dirname, '../../..')),
          ...(o.runnerTag !== undefined ? { runnerTag: o.runnerTag } : {}),
          paths,
          referenceSha: head,
          referenceState: stateAt(cache, head, paths),
          now: now(),
        });
      }
      await renderAndCommit(
        policy,
        `gate policy for ${o.project}: reference ${defaultBranch} @ ${head.slice(0, 12)}`,
      );
      if (o.setCiConfigPath) {
        const p = await api.json<{ path_with_namespace: string; ci_config_path: string }>(
          'PUT',
          `/projects/${pid}`,
          { ci_config_path: ciConfigPath },
        );
        io.out(
          JSON.stringify({ project: p.path_with_namespace, ci_config_path: p.ci_config_path }),
        );
      } else {
        io.log(
          `not yet active: set the CI/CD configuration file of ${o.project} to ${ciConfigPath}`,
        );
        io.log('  (gate-admin install … --set-ci-config-path)');
      }
      return 0;
    }
    case 'approve': {
      const iid = o.mr as number;
      const mr = await api.json<{ state: string; sha: string }>(
        'GET',
        `/projects/${pid}/merge_requests/${iid}`,
      );
      if (mr.state !== 'opened') throw new Error(`MR !${iid} is not open`);
      const policy = await readPolicy();
      const fetched = await gitFetch(cfg, cache, o.project, `refs/merge-requests/${iid}/head`);
      if (fetched !== mr.sha)
        throw new Error(`fetched head differs from the MR's head ${mr.sha}; retry`);
      const state = stateAt(cache, mr.sha, policy.paths);
      const user = await api.json<{ username: string }>('GET', '/user');
      const changed = changedLines(policy.reference.state, state);
      const approved = prune(
        approve(policy, {
          stateId: state.id,
          mr: iid,
          sha: mr.sha,
          approvedBy: user.username,
          approvedAt: now().toISOString(),
          reason: o.reason ?? 'reviewed by a Maintainer',
          changed,
        }),
        await openMrs(),
      );
      io.log(
        state.id === policy.reference.state.id
          ? `state ${state.id} equals the reference: nothing to approve`
          : `approved state ${state.id} for !${iid}; changed entries:\n${changed.map((l) => `  ${l}`).join('\n')}`,
      );
      await renderAndCommit(
        approved,
        `approve gate state of ${o.project}!${iid} (${mr.sha.slice(0, 12)})`,
      );
      if (o.rerun) {
        const p = await api.json<{ id: number }>(
          'POST',
          `/projects/${pid}/merge_requests/${iid}/pipelines`,
        );
        io.log(`new MR pipeline ${p.id} for !${iid}`);
      }
      return 0;
    }
    case 'sync': {
      const head = await defaultHead();
      // Refuse before anything is read at `head` when it is not the reviewed commit.
      if (o.adoptDefaultPaths) assertReviewedHead(head, o.expectHead);
      const policy = await readPolicy();
      const open = await openMrs();
      const r = o.adoptDefaultPaths
        ? (() => {
            // The list committed at the synced head (never this checkout), and the state over it.
            const paths = gatePathsAt(cache, head);
            return syncPolicy({
              policy,
              state: stateAt(cache, head, paths),
              sha: head,
              openMrs: open,
              now: now(),
              adopt: { paths, expectSha: o.expectHead, allowPathRemoval: o.allowPathRemoval },
            });
          })()
        : syncPolicy({
            policy,
            state: stateAt(cache, head, policy.paths),
            sha: head,
            openMrs: open,
            now: now(),
          });
      r.report.forEach(io.log);
      await renderAndCommit(
        r.policy,
        `${o.adoptDefaultPaths ? 'adopt default gate paths and sync' : 'sync'} gate policy of ${o.project} to ${defaultBranch} @ ${head.slice(0, 12)}`,
      );
      return 0;
    }
    case 'status': {
      const policy = await readPolicy();
      io.out(
        JSON.stringify(
          {
            project: policy.project,
            policyProject: policy.policyProject,
            runnerTag: policy.runnerTag,
            paths: policy.paths.length,
            reference: {
              sha: policy.reference.sha,
              syncedAt: policy.reference.syncedAt,
              state: policy.reference.state.id,
            },
            approved: policy.approved.map(
              ({ stateId, mr, sha, approvedBy, approvedAt, reason }) => ({
                stateId,
                mr,
                sha,
                approvedBy,
                approvedAt,
                reason,
              }),
            ),
            ciConfigPath: project.ci_config_path ?? null,
            active: project.ci_config_path === ciConfigPath,
          },
          null,
          2,
        ),
      );
      return 0;
    }
    case 'exceptions': {
      const content = readFileSync(o.file as string, 'utf8');
      if (!content.trim())
        throw new Error(
          '--file is empty (generate it with: pnpm -C policies run approval-digests)',
        );
      await commitFiles(`exception approvals for ${o.project}`, {
        'exception-approvals.yaml': content,
      });
      // A File variable read by policy:<infra> (check-exceptions --approvals). Not a secret, and it
      // must reach MR pipelines, so it is neither protected nor masked; only Maintainers can change it.
      const body = {
        key: EXCEPTION_APPROVALS_VARIABLE,
        value: content,
        variable_type: 'file',
        raw: true,
        protected: false,
        masked: false,
      };
      const exists =
        (await api.call('GET', `/projects/${pid}/variables/${EXCEPTION_APPROVALS_VARIABLE}`))
          .status === 200;
      if (exists)
        await api.json('PUT', `/projects/${pid}/variables/${EXCEPTION_APPROVALS_VARIABLE}`, body);
      else await api.json('POST', `/projects/${pid}/variables`, body);
      io.log(
        `${EXCEPTION_APPROVALS_VARIABLE} set on ${o.project} from ${o.policyProject}:${dir}/exception-approvals.yaml`,
      );
      return 0;
    }
    default:
      io.log(USAGE);
      return 2;
  }
}
