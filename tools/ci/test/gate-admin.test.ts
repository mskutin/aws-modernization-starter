import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { gateAdmin, parseAdminArgs, readConfig } from '../src/gate-admin.ts';
import { GATE_POLICY_SOURCE, parsePolicy, stateFromLsTree, verdict } from '../src/gate-policy.ts';

/**
 * gate-admin against an in-process fake GitLab: the REST endpoints the driver uses plus git smart
 * HTTP served by `git http-backend` (so the real `git fetch --depth 1` path with GIT_ASKPASS runs).
 * Asserts the token only ever travels as the PRIVATE-TOKEN header or HTTP basic auth, never in a
 * URL or in the driver's output.
 */

// A fake token; assembled at runtime so the repository's own secret scan does not fire on it.
const TOKEN = ['glpat', 'fake-gate-admin-test-0000'].join('-');
const PATHS = ['.gitlab-ci.yml', '.gitlab', 'tools/ci'];
const REPO_ROOT = join(import.meta.dirname, '../../..');

const dirs: string[] = [];
const tmp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};

function git(cwd: string, ...args: string[]): string {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
  );
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.invalid',
      GIT_CONFIG_NOSYSTEM: '1',
      HOME: cwd,
    },
  }).trim();
}

const policySource = (paths: string[]): string =>
  `export const DEFAULT_GATE_PATHS: readonly string[] = [\n${paths.map((p) => `  '${p}',`).join('\n')}\n];\n`;

function commit(repo: string, files: Record<string, string | null>): string {
  for (const [rel, content] of Object.entries(files)) {
    const file = join(repo, rel);
    if (content === null) rmSync(file, { force: true });
    else {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'change', '--no-verify');
  return git(repo, 'rev-parse', 'HEAD');
}

interface Fake {
  url: string;
  server: Server;
  gitRoot: string;
  work: string;
  bare: string;
  files: Map<string, string>;
  commits: Array<{ message: string; actions: Array<{ action: string; file_path: string }> }>;
  variables: Map<
    string,
    { value: string; variable_type: string; protected: boolean; masked: boolean }
  >;
  project: { id: number; path: string; default_branch: string; ci_config_path: string | null };
  mr: { iid: number; state: string; sha: string };
  pipelines: number[];
  requests: Array<{
    method: string;
    url: string;
    auth: string | undefined;
    token: string | undefined;
  }>;
  gitAuth: string[];
}

function body(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function gitBackend(fake: Fake, req: IncomingMessage, res: ServerResponse, input: Buffer): void {
  const url = new URL(req.url ?? '/', 'http://x');
  const child = spawn('git', ['http-backend'], {
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      GIT_PROJECT_ROOT: fake.gitRoot,
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: decodeURIComponent(url.pathname),
      QUERY_STRING: url.search.replace(/^\?/, ''),
      REQUEST_METHOD: req.method ?? 'GET',
      CONTENT_TYPE: req.headers['content-type'] ?? '',
      CONTENT_LENGTH: String(input.length),
      REMOTE_USER: 'maintainer',
      REMOTE_ADDR: '127.0.0.1',
      GIT_PROTOCOL: String(req.headers['git-protocol'] ?? ''),
      HTTP_CONTENT_ENCODING: String(req.headers['content-encoding'] ?? ''),
    },
  });
  const out: Buffer[] = [];
  child.stdout.on('data', (c: Buffer) => out.push(c));
  child.on('close', () => {
    const buf = Buffer.concat(out);
    let sep = buf.indexOf('\r\n\r\n');
    let skip = 4;
    if (sep < 0) {
      sep = buf.indexOf('\n\n');
      skip = 2;
    }
    const head = buf.subarray(0, sep).toString('utf8');
    let status = 200;
    const headers: Record<string, string> = {};
    for (const line of head.split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim();
      if (k.toLowerCase() === 'status') status = Number(v.split(' ')[0]);
      else headers[k] = v;
    }
    res.writeHead(status, headers);
    res.end(buf.subarray(sep + skip));
  });
  child.stdin.end(input);
}

async function startFake(): Promise<Fake> {
  const work = tmp('gate-admin-work-');
  git(work, 'init', '-q', '-b', 'main');
  commit(work, {
    '.gitlab-ci.yml': 'include: [{ local: .gitlab/ci/security.yml }]\n',
    '.gitlab/ci/security.yml': 'secrets:gitleaks:\n  script: [gitleaks]\n',
    [GATE_POLICY_SOURCE]: policySource(PATHS),
    'apps/api/src/app.ts': 'export const a = 1;\n',
  });
  const gitRoot = tmp('gate-admin-git-');
  const bare = join(gitRoot, 'group/app.git');
  mkdirSync(dirname(bare), { recursive: true });
  git(gitRoot, 'clone', '-q', '--bare', work, bare);
  // An open MR that changes a gate-defining file.
  git(work, 'checkout', '-q', '-b', 'mr7');
  const mrSha = commit(work, {
    '.gitlab/ci/security.yml': 'secrets:gitleaks:\n  script: [gitleaks, --strict]\n',
  });
  git(work, 'push', '-q', bare, 'HEAD:refs/merge-requests/7/head');
  git(work, 'checkout', '-q', 'main');

  const fake: Fake = {
    url: '',
    server: undefined as unknown as Server,
    gitRoot,
    work,
    bare,
    files: new Map(),
    commits: [],
    variables: new Map(),
    project: { id: 11, path: 'group/app', default_branch: 'main', ci_config_path: null },
    mr: { iid: 7, state: 'opened', sha: mrSha },
    pipelines: [],
    requests: [],
    gitAuth: [],
  };
  const json = (res: ServerResponse, status: number, value: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  fake.server = createServer((req, res) => {
    void (async () => {
      const input = await body(req);
      const url = new URL(req.url ?? '/', 'http://x');
      const auth = req.headers.authorization;
      const token = req.headers['private-token'] as string | undefined;
      fake.requests.push({ method: req.method ?? '', url: req.url ?? '', auth, token });
      // Git smart HTTP: basic auth after a challenge, password = the token.
      if (url.pathname.startsWith('/group/app.git/')) {
        if (!auth) {
          res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="GitLab"' });
          res.end();
          return;
        }
        const decoded = Buffer.from(auth.replace(/^Basic /, ''), 'base64').toString('utf8');
        fake.gitAuth.push(decoded);
        if (decoded.split(':').slice(1).join(':') !== TOKEN) {
          res.writeHead(403);
          res.end();
          return;
        }
        gitBackend(fake, req, res, input);
        return;
      }
      if (token !== TOKEN) return json(res, 401, { message: '401 Unauthorized' });
      const p = url.pathname.replace(/^\/api\/v4/, '');
      const data = input.length
        ? (JSON.parse(input.toString('utf8')) as Record<string, unknown>)
        : {};
      const m = (re: RegExp): RegExpExecArray | null => re.exec(p);
      let r: RegExpExecArray | null;
      if (req.method === 'GET' && p === '/projects/group%2Fapp')
        return json(res, 200, fake.project);
      if (req.method === 'GET' && p === '/projects/group%2Fci-policy')
        return json(res, 200, { id: 12 });
      if (req.method === 'PUT' && p === '/projects/11') {
        fake.project.ci_config_path = String(data.ci_config_path);
        return json(res, 200, {
          path_with_namespace: 'group/app',
          ci_config_path: fake.project.ci_config_path,
        });
      }
      if (req.method === 'GET' && p === '/projects/11/repository/branches/main')
        return json(res, 200, {
          commit: { id: git(fake.gitRoot, '--git-dir', bare, 'rev-parse', 'refs/heads/main') },
        });
      if ((r = m(/^\/projects\/12\/repository\/files\/([^/]+)(\/raw)?$/)) && req.method === 'GET') {
        expect(url.searchParams.get('ref')).toBe('main');
        const content = fake.files.get(decodeURIComponent(r[1] ?? ''));
        if (content === undefined) return json(res, 404, { message: '404 File Not Found' });
        if (r[2]) {
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end(content);
          return;
        }
        return json(res, 200, { file_path: r[1] });
      }
      if (req.method === 'POST' && p === '/projects/12/repository/commits') {
        expect(data.branch).toBe('main');
        const actions = data.actions as Array<{
          action: string;
          file_path: string;
          content: string;
        }>;
        for (const a of actions) {
          // create/update must match reality (GitLab rejects the commit otherwise).
          expect(a.action).toBe(fake.files.has(a.file_path) ? 'update' : 'create');
          fake.files.set(a.file_path, a.content);
        }
        fake.commits.push({ message: String(data.commit_message), actions });
        return json(res, 201, { short_id: 'abc1234', title: data.commit_message });
      }
      if (req.method === 'GET' && p === '/projects/11/merge_requests') {
        return json(res, 200, fake.mr.state === 'opened' ? [{ iid: fake.mr.iid }] : []);
      }
      if (req.method === 'GET' && p === '/projects/11/merge_requests/7')
        return json(res, 200, fake.mr);
      if (req.method === 'POST' && p === '/projects/11/merge_requests/7/pipelines') {
        fake.pipelines.push(fake.pipelines.length + 100);
        return json(res, 201, { id: fake.pipelines.at(-1) });
      }
      if (req.method === 'GET' && p === '/user') return json(res, 200, { username: 'maintainer' });
      if ((r = m(/^\/projects\/11\/variables\/([A-Z_]+)$/))) {
        const key = r[1] ?? '';
        if (req.method === 'GET')
          return fake.variables.has(key)
            ? json(res, 200, { key })
            : json(res, 404, { message: '404' });
        if (req.method === 'PUT') {
          fake.variables.set(key, data as never);
          return json(res, 200, { key });
        }
      }
      if (req.method === 'POST' && p === '/projects/11/variables') {
        fake.variables.set(String(data.key), data as never);
        return json(res, 201, { key: data.key });
      }
      return json(res, 404, { message: `no route ${req.method} ${p}` });
    })();
  });
  await new Promise<void>((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
  fake.url = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
  return fake;
}

let fake: Fake;
let env: NodeJS.ProcessEnv;
beforeEach(async () => {
  fake = await startFake();
  const secrets = tmp('gate-admin-secrets-');
  const tokenFile = join(secrets, 'token');
  writeFileSync(tokenFile, `${TOKEN}\n`);
  chmodSync(tokenFile, 0o600);
  env = {
    PATH: process.env.PATH,
    HOME: secrets,
    GITLAB_URL: fake.url,
    GITLAB_TOKEN_FILE: tokenFile,
    GATE_ADMIN_CACHE_DIR: join(tmp('gate-admin-cache-'), 'cache'),
  };
});
afterEach(async () => {
  await new Promise<void>((resolve) => fake.server.close(() => resolve()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function run(...argv: string[]): Promise<{ code: number; log: string; out: string }> {
  const log: string[] = [];
  const out: string[] = [];
  const code = await gateAdmin(argv, {
    env,
    log: (l) => log.push(l),
    out: (l) => out.push(l),
    repoRoot: REPO_ROOT,
  });
  return { code, log: log.join('\n'), out: out.join('\n') };
}
const base = ['--project', 'group/app', '--policy-project', 'group/ci-policy'];
const policyFile = 'projects/group--app/policy.json';

function assertTokenNeverLeaked(...texts: string[]): void {
  for (const t of texts) expect(t).not.toContain(TOKEN);
  for (const r of fake.requests) expect(r.url).not.toContain(TOKEN);
  for (const content of fake.files.values()) expect(content).not.toContain(TOKEN);
}

describe('gate-admin (API driver of the gate policy)', () => {
  it('install writes the policy, an untagged child job and points the project at it', async () => {
    const r = await run('install', ...base, '--set-ci-config-path');
    expect(r.code, r.log).toBe(0);
    const policy = parsePolicy(fake.files.get(policyFile) ?? '');
    expect(policy.paths).toEqual(PATHS);
    expect(policy.reference.sha).toBe(
      git(fake.gitRoot, '--git-dir', fake.bare, 'rev-parse', 'main'),
    );
    expect(policy.runnerTag).toBe('');
    expect(policy.image).toMatch(/@sha256:[a-f0-9]{64}$/);
    const child = parse(fake.files.get('projects/group--app/gate-integrity.yml') ?? '') as Record<
      string,
      Record<string, unknown>
    >;
    expect(child['gate:integrity']).not.toHaveProperty('tags');
    expect(fake.project.ci_config_path).toBe('projects/group--app/gate-policy.yml@group/ci-policy');
    expect(r.out).toContain(
      '"ci_config_path":"projects/group--app/gate-policy.yml@group/ci-policy"',
    );
    // Auth: the API saw only the header, git only basic auth after a challenge.
    expect(
      fake.requests.filter((q) => !q.url.startsWith('/group/')).every((q) => q.token === TOKEN),
    ).toBe(true);
    expect(fake.gitAuth.length).toBeGreaterThan(0);
    expect(fake.gitAuth.every((a) => a === `oauth2:${TOKEN}`)).toBe(true);
    assertTokenNeverLeaked(r.log, r.out);
  });

  it('install --runner-tag renders the tag; a second install re-syncs the stored policy', async () => {
    expect((await run('install', ...base, '--runner-tag', 'docker')).code).toBe(0);
    const child = parse(fake.files.get('projects/group--app/gate-integrity.yml') ?? '') as Record<
      string,
      Record<string, unknown>
    >;
    expect(child['gate:integrity']?.tags).toEqual(['docker']);
    const again = await run('install', ...base);
    expect(again.code).toBe(0);
    expect(again.log).toMatch(/already holds a policy/);
    expect(fake.commits).toHaveLength(2);
    expect(fake.commits[1]?.actions.every((a) => a.action === 'update')).toBe(true);
  });

  it('approve records the MR head state (the gate then passes for it) and --rerun starts a pipeline', async () => {
    await run('install', ...base);
    const before = parsePolicy(fake.files.get(policyFile) ?? '');
    const r = await run('approve', ...base, '--mr', '7', '--reason', 'reviewed', '--rerun');
    expect(r.code, r.log).toBe(0);
    const policy = parsePolicy(fake.files.get(policyFile) ?? '');
    expect(policy.approved).toHaveLength(1);
    expect(policy.approved[0]).toMatchObject({
      mr: 7,
      sha: fake.mr.sha,
      approvedBy: 'maintainer',
      reason: 'reviewed',
    });
    expect(policy.approved[0]?.changed.join('\n')).toContain('\t.gitlab');
    const mrState = stateFromLsTree(PATHS, (p) =>
      git(fake.gitRoot, '--git-dir', fake.bare, 'ls-tree', '--full-tree', fake.mr.sha, '--', p),
    );
    expect(verdict(before, mrState.id).pass).toBe(false);
    expect(verdict(policy, mrState.id).pass).toBe(true);
    expect(fake.pipelines).toHaveLength(1);
    assertTokenNeverLeaked(r.log, r.out);
  });

  it('approve refuses a closed MR', async () => {
    await run('install', ...base);
    fake.mr.state = 'merged';
    await expect(run('approve', ...base, '--mr', '7')).rejects.toThrow(/not open/);
  });

  it('sync re-pins the reference after a merge and drops approvals of closed MRs', async () => {
    await run('install', ...base);
    await run('approve', ...base, '--mr', '7');
    git(fake.work, 'merge', '-q', '--ff-only', 'mr7');
    git(fake.work, 'push', '-q', fake.bare, 'main');
    fake.mr.state = 'merged';
    const r = await run('sync', ...base);
    expect(r.code, r.log).toBe(0);
    const policy = parsePolicy(fake.files.get(policyFile) ?? '');
    expect(policy.reference.sha).toBe(fake.mr.sha);
    expect(policy.approved).toEqual([]);
  });

  it('sync --adopt-default-paths REQUIRES --expect-head (refused before any API call)', async () => {
    await run('install', ...base);
    const calls = fake.requests.length;
    const r = await run('sync', ...base, '--adopt-default-paths');
    expect(r.code).toBe(2);
    expect(r.log).toMatch(/requires --expect-head/);
    expect(fake.requests.length).toBe(calls);
    expect(fake.commits).toHaveLength(1);
  });

  it('sync --adopt-default-paths refuses when the default branch moved past the reviewed commit', async () => {
    await run('install', ...base);
    const reviewed = git(fake.work, 'rev-parse', 'main');
    commit(fake.work, { [GATE_POLICY_SOURCE]: policySource([...PATHS, 'apps/api']) });
    git(fake.work, 'push', '-q', fake.bare, 'main');
    await expect(
      run('sync', ...base, '--adopt-default-paths', '--expect-head', reviewed),
    ).rejects.toThrow(/not at the reviewed/);
    expect(fake.commits).toHaveLength(1);
  });

  it('sync --adopt-default-paths adopts the committed list, and a removal needs --allow-path-removal', async () => {
    await run('install', ...base);
    await run('approve', ...base, '--mr', '7');
    const added = commit(fake.work, { [GATE_POLICY_SOURCE]: policySource([...PATHS, 'apps/api']) });
    git(fake.work, 'push', '-q', fake.bare, 'main');
    const r = await run('sync', ...base, '--adopt-default-paths', '--expect-head', added);
    expect(r.code, r.log).toBe(0);
    expect(r.log).toMatch(/adopted 4 gate paths .*added: apps\/api/);
    let policy = parsePolicy(fake.files.get(policyFile) ?? '');
    expect(policy.paths).toEqual([...PATHS, 'apps/api']);
    expect(policy.approved).toEqual([]);

    const dropped = commit(fake.work, {
      [GATE_POLICY_SOURCE]: policySource(['.gitlab-ci.yml', 'tools/ci', 'apps/api']),
    });
    git(fake.work, 'push', '-q', fake.bare, 'main');
    await expect(
      run('sync', ...base, '--adopt-default-paths', '--expect-head', dropped),
    ).rejects.toThrow(/would remove gate path\(s\) \.gitlab/);
    const ok = await run(
      'sync',
      ...base,
      '--adopt-default-paths',
      '--expect-head',
      dropped,
      '--allow-path-removal',
    );
    expect(ok.code, ok.log).toBe(0);
    policy = parsePolicy(fake.files.get(policyFile) ?? '');
    expect(policy.paths).toEqual(['.gitlab-ci.yml', 'tools/ci', 'apps/api']);
  });

  it('exceptions stores the approvals file and the unprotected, unmasked File variable', async () => {
    await run('install', ...base);
    const file = join(tmp('gate-admin-ex-'), 'approvals.yaml');
    writeFileSync(file, 'approvals: []\n');
    expect((await run('exceptions', ...base, '--file', file)).code).toBe(0);
    expect(fake.variables.get('STARTER_EXCEPTION_APPROVALS')).toMatchObject({
      value: 'approvals: []\n',
      variable_type: 'file',
      protected: false,
      masked: false,
    });
    writeFileSync(file, 'approvals: [x]\n');
    expect((await run('exceptions', ...base, '--file', file)).code).toBe(0);
    expect(fake.variables.get('STARTER_EXCEPTION_APPROVALS')?.value).toBe('approvals: [x]\n');
    expect(fake.files.get('projects/group--app/exception-approvals.yaml')).toBe('approvals: [x]\n');
  });

  it('status reports the reference and whether the policy is active', async () => {
    await run('install', ...base, '--set-ci-config-path');
    const r = await run('status', ...base);
    const s = JSON.parse(r.out) as { active: boolean; paths: number; runnerTag: string };
    expect(s).toMatchObject({ active: true, paths: PATHS.length, runnerTag: '' });
    assertTokenNeverLeaked(r.log, r.out);
  });
});

describe('gate-admin configuration', () => {
  it('requires GITLAB_URL and a private token file; refuses plain http to a remote host', () => {
    expect(() => readConfig({ ...env, GITLAB_URL: '' })).toThrow(/GITLAB_URL is required/);
    expect(() => readConfig({ ...env, GITLAB_URL: 'http://gitlab.example.com' })).toThrow(/https/);
    expect(
      readConfig({ ...env, GITLAB_URL: 'http://gitlab.example.com', GATE_ADMIN_ALLOW_HTTP: 'true' })
        .apiBase,
    ).toBe('http://gitlab.example.com/api/v4');
    expect(readConfig({ ...env, GITLAB_URL: 'https://example.com/gitlab/' }).apiBase).toBe(
      'https://example.com/gitlab/api/v4',
    );
    expect(() => readConfig({ ...env, GITLAB_URL: 'https://u:p@example.com' })).toThrow(
      /credentials/,
    );
    expect(() => readConfig({ ...env, GITLAB_TOKEN_FILE: '' })).toThrow(/GITLAB_TOKEN_FILE/);
    const loose = join(tmp('gate-admin-loose-'), 'token');
    writeFileSync(loose, TOKEN);
    chmodSync(loose, 0o644);
    expect(() => readConfig({ ...env, GITLAB_TOKEN_FILE: loose })).toThrow(/chmod 600/);
  });

  it('a usage error exits 2 without printing the token', async () => {
    const r = await run('sync', '--project', 'group/app');
    expect(r.code).toBe(2);
    expect(r.log).toMatch(/--policy-project/);
    assertTokenNeverLeaked(r.log, r.out);
  });

  it('parses only plain project paths, full commit ids and plain runner tags', () => {
    expect(() => parseAdminArgs(['status', '--project', 'a', '--policy-project', 'g/p'])).toThrow();
    expect(() =>
      parseAdminArgs(['sync', ...base, '--adopt-default-paths', '--expect-head', 'main']),
    ).toThrow(/full commit id/);
    expect(() => parseAdminArgs(['install', ...base, '--runner-tag', 'a b'])).toThrow(/runner tag/);
    expect(() => parseAdminArgs(['sync', ...base, '--expect-head', 'f'.repeat(40)])).toThrow(
      /only apply to sync --adopt-default-paths/,
    );
    expect(parseAdminArgs(['approve', ...base, '--mr', '7']).mr).toBe(7);
  });
});
