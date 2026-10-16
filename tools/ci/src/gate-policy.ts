/**
 * Gate integrity (ADR 0410) — the CE mechanism.
 *
 * Optional. A project's CI/CD configuration file is `projects/<slug>/gate-policy.yml@<policy project>`,
 * a file in a Maintainer-only project (e.g. `<group>/ci-policy`). It includes the project's own `.gitlab-ci.yml` from the commit under
 * test (so the MR still runs its pipeline) and adds one bridge job, `policy:gate-integrity`, whose
 * child pipeline is compiled ONLY from the policy project: the MR cannot alter it (its overrides of the
 * bridge job's keys do not reach the child; proven in the sandbox).
 *
 * The child job hashes the git entries (mode, type, object id) of every gate-defining path of the
 * commit under test into a state id and passes only if that id is the default branch's reference
 * state or a state a Maintainer approved for an open MR — both embedded in the child config, so the
 * verdict depends on no network answer and no file the MR controls. A Maintainer approves with
 * `gate-admin approve --mr <iid>` (tools/ci/src/gate-admin.ts, run outside the MR with the
 * Maintainer's own token); `gate-admin sync` re-pins the reference after a merge and drops approvals
 * of merged or closed MRs.
 *
 * This module is the single implementation of the state hash used by the Maintainer tooling (TS) and by the
 * child job (POSIX sh, rendered below); a test asserts both agree.
 */
import { createHash } from 'node:crypto';

export const POLICY_SCHEMA_VERSION = 1;

/**
 * Paths whose content defines the pipeline's gates. Order matters (it is part of the hash input).
 * Each entry is ONE tree entry (a file or a directory, never a glob): `git ls-tree` must return
 * exactly one line for it, or it is recorded `absent`.
 *
 * A live policy keeps the path list it was installed with (`policy.paths`); a change here reaches it
 * only through `gate-admin sync --adopt-default-paths --expect-head <sha>`, which reads this list FROM THE SYNCED
 * DEFAULT-BRANCH COMMIT (`gatePathsFromSource` of `git show <sha>:tools/ci/src/gate-policy.ts`),
 * never from the operator's working tree (docs/ci-cd.md §4a).
 */
export const DEFAULT_GATE_PATHS: readonly string[] = [
  '.gitlab-ci.yml',
  '.gitlab',
  'components.yaml',
  'tools/impact',
  'tools/ci',
  '.gitleaks.toml',
  '.hadolint.yaml',
  'policies',
  'infra/lib/policy-hook.ts',
  'infra/lib/policy-options.ts',
  'tools/finops/thresholds.yaml',
  'tests/security',
  'package.json',
  'pnpm-workspace.yaml',
  '.npmrc',
  'eslint.config.js',
  '.prettierignore',
  'tsconfig.base.json',
  // The MiniStack emulator layer's blocking jobs: the endpoint/credential
  // guard, the job scripts with the egress audit and the not-applicable baseline, and the code that
  // decides reconciliation, governance and the CI verdicts.
  'infra/lib/emulator-guard.ts',
  'infra/lib/emulator-guard-cli.ts',
  'tests/aws-integration/emulator',
  'tests/aws-integration/src/emulator-ci.ts',
  'tests/aws-integration/src/emulator-gaps.ts',
  'tests/aws-integration/src/emulator-reconcile.ts',
  'tests/aws-integration/src/emulator-results.ts',
  // What decides which emulator tests run and how the guard resolves: the live
  // harness (gap skips and not-applicable records), the AWS gate (run or skip), the suite's
  // package/build/vitest configuration, the CDK app entry that applies the guard, and the infra
  // package's `./emulator-guard` export and build configuration.
  'tests/aws-integration/src/live-harness.ts',
  'tests/aws-integration/src/aws-gate.ts',
  'tests/aws-integration/package.json',
  'tests/aws-integration/tsconfig.build.json',
  'tests/aws-integration/vitest.config.ts',
  'infra/bin/integration.ts',
  'infra/package.json',
  'infra/tsconfig.json',
];

/** The file that holds DEFAULT_GATE_PATHS (read at a commit by `--adopt-default-paths`). */
export const GATE_POLICY_SOURCE = 'tools/ci/src/gate-policy.ts';

/**
 * DEFAULT_GATE_PATHS as written in a version of `GATE_POLICY_SOURCE`. Strict: the array may hold
 * only single-quoted plain paths, commas and `//` comments — anything else (a spread, a variable, a
 * template) is refused rather than guessed.
 */
export function gatePathsFromSource(text: string): string[] {
  const m = /export const DEFAULT_GATE_PATHS: readonly string\[\] = \[([\s\S]*?)\n\];/.exec(text);
  if (!m?.[1]) throw new Error('DEFAULT_GATE_PATHS not found in the gate policy source');
  const body = m[1].replace(/\/\/[^\n]*/g, '');
  const paths: string[] = [];
  const rest = body.replace(/'([^'\\\n]*)'/g, (_all, p: string) => {
    paths.push(p);
    return '';
  });
  if (rest.replace(/[\s,]/g, '') !== '') {
    throw new Error('DEFAULT_GATE_PATHS is not a plain list of string literals');
  }
  if (paths.length === 0) throw new Error('DEFAULT_GATE_PATHS is empty');
  for (const p of paths) {
    if (!/^[\w./-]+$/.test(p)) throw new Error(`not a plain repository path: ${p}`);
  }
  if (new Set(paths).size !== paths.length) throw new Error('DEFAULT_GATE_PATHS has duplicates');
  return paths;
}

export interface GateState {
  /** sha256 of `lines.join('\n') + '\n'` */
  id: string;
  /** One line per gate path: `git ls-tree --full-tree` output, or `absent\t<path>`. */
  lines: string[];
}

export interface GateApproval {
  stateId: string;
  mr: number | null;
  sha: string;
  approvedBy: string;
  approvedAt: string;
  reason: string;
  /** Gate-path lines that differ from the reference state at approval time (review aid). */
  changed: string[];
}

export interface GatePolicy {
  schemaVersion: number;
  project: string;
  defaultBranch: string;
  policyProject: string;
  /** Pinned image of the child job (needs git, sha256sum, grep). */
  image: string;
  /**
   * Runner tag the child job runs on: the project's default runner (MR pipelines have no other).
   * Empty = untagged (any runner that accepts untagged jobs).
   */
  runnerTag: string;
  paths: string[];
  reference: { sha: string; syncedAt: string; state: GateState };
  approved: GateApproval[];
}

export function slugOf(projectPath: string): string {
  return projectPath.replace(/[^A-Za-z0-9._-]+/g, '--');
}

export function stateFromLines(lines: string[]): GateState {
  const text = `${lines.join('\n')}\n`;
  return { id: createHash('sha256').update(text).digest('hex'), lines: [...lines] };
}

/** Lines from `ls-tree` outputs per path (undefined/empty output = absent). */
export function stateFromLsTree(
  paths: readonly string[],
  lsTree: (path: string) => string,
): GateState {
  return stateFromLines(
    paths.map((p) => {
      const out = lsTree(p).replace(/\n+$/, '');
      if (out.includes('\n')) throw new Error(`ls-tree returned several entries for ${p}`);
      return out.length > 0 ? out : `absent\t${p}`;
    }),
  );
}

/**
 * Whether `state` was computed over exactly `paths`, in order (each line ends with `\t<path>`). A
 * state of another path list must never be compared with, approved for or pinned in a policy.
 */
export function stateMatchesPaths(state: GateState, paths: readonly string[]): boolean {
  return (
    state.lines.length === paths.length &&
    state.lines.every((line, i) => line.endsWith(`\t${paths[i] ?? ''}`))
  );
}

export function assertStateForPaths(state: GateState, paths: readonly string[]): void {
  if (!stateMatchesPaths(state, paths)) {
    throw new Error(
      'the gate state was not computed over the policy paths (compute it with the same path list)',
    );
  }
}

/**
 * A new path list for a live policy (Maintainer, after a merged change of DEFAULT_GATE_PATHS): the
 * reference is re-pinned to `reference` (computed over `paths`) and EVERY approval is dropped — an
 * approved state id is a hash over the old path list and can never match again.
 */
export function adoptPaths(
  policy: GatePolicy,
  paths: readonly string[],
  reference: { sha: string; state: GateState; now: Date },
): GatePolicy {
  assertStateForPaths(reference.state, paths);
  return {
    ...policy,
    paths: [...paths],
    reference: {
      sha: reference.sha,
      syncedAt: reference.now.toISOString(),
      state: reference.state,
    },
    approved: [],
  };
}

/** What a re-pin must satisfy when it also adopts a new path list (`--adopt-default-paths`). */
export interface AdoptOptions {
  /** DEFAULT_GATE_PATHS as committed at the synced head (never a working tree's list). */
  paths: readonly string[];
  /** The default-branch commit a Maintainer reviewed. REQUIRED. */
  expectSha: string | undefined;
  /** Removing a gate path weakens the gate: only with explicit consent. */
  allowPathRemoval: boolean;
}

/**
 * Adopting a path list is a review decision about exactly one default-branch commit: refuse without
 * the reviewed commit, and when the branch moved past it.
 */
export function assertReviewedHead(sha: string, expectSha: string | undefined): void {
  if (!expectSha) {
    throw new Error(
      'adopting the default gate paths requires the reviewed default-branch commit (--expect-sha / --expect-head)',
    );
  }
  if (expectSha !== sha) {
    throw new Error(
      `the default branch is at ${sha}, not at the reviewed ${expectSha}: review the new commits first`,
    );
  }
}

/**
 * Re-pin the reference to `sha` (its `state`) and drop approvals of MRs that are no longer open. With
 * `adopt`, also switch to the path list committed at `sha` — refused unless `sha` is exactly the
 * reviewed commit, and, when a path would be removed, unless that removal was explicitly allowed —
 * and drop every approval (their state ids hash the old list).
 */
export function syncPolicy(args: {
  policy: GatePolicy;
  state: GateState;
  sha: string;
  openMrs: number[] | null;
  now: Date;
  adopt?: AdoptOptions;
}): { policy: GatePolicy; report: string[] } {
  const { policy, state, sha, now, adopt } = args;
  if (adopt) {
    assertReviewedHead(sha, adopt.expectSha);
    const added = adopt.paths.filter((p) => !policy.paths.includes(p));
    const removed = policy.paths.filter((p) => !adopt.paths.includes(p));
    if (removed.length > 0 && !adopt.allowPathRemoval) {
      throw new Error(
        `adopting would remove gate path(s) ${removed.join(', ')}; pass --allow-path-removal if that was reviewed`,
      );
    }
    // The state must have been computed over that same list (state --paths-from-rev).
    const adopted = adoptPaths(policy, adopt.paths, { sha, state, now });
    const local = DEFAULT_GATE_PATHS.join('\n') === adopt.paths.join('\n');
    return {
      policy: adopted,
      report: [
        `adopted ${adopted.paths.length} gate paths from ${sha} (added: ${added.join(', ') || 'none'}; ` +
          `removed: ${removed.join(', ') || 'none'}); reference ${adopted.reference.state.id}; ` +
          `all ${policy.approved.length} approval(s) dropped` +
          (local ? '' : '; NOTE: this working tree has a different list, which was ignored'),
        // What the newly protected paths hold right now (review aid).
        ...state.lines.filter((l) => added.some((p) => l.endsWith(`\t${p}`))).map((l) => `  ${l}`),
      ],
    };
  }
  assertStateForPaths(state, policy.paths);
  const synced = prune(
    { ...policy, reference: { sha, syncedAt: now.toISOString(), state } },
    args.openMrs,
  );
  return {
    policy: synced,
    report: [
      `reference ${synced.reference.state.id} @ ${synced.reference.sha}; approvals kept: ${synced.approved.length}`,
    ],
  };
}

export function changedLines(reference: GateState, state: GateState): string[] {
  const ref = new Set(reference.lines);
  return state.lines.filter((l) => !ref.has(l));
}

export function verdict(policy: GatePolicy, stateId: string): { pass: boolean; reason: string } {
  if (stateId === policy.reference.state.id)
    return { pass: true, reason: `equals the ${policy.defaultBranch} reference state` };
  const a = policy.approved.find((x) => x.stateId === stateId);
  return a
    ? { pass: true, reason: `Maintainer-approved for ${a.mr ? `!${a.mr}` : a.sha.slice(0, 12)}` }
    : { pass: false, reason: 'not an approved gate state' };
}

/** Record an approval (idempotent per state id) and drop approvals equal to the reference. */
export function approve(policy: GatePolicy, approval: GateApproval): GatePolicy {
  const others = policy.approved.filter((a) => a.stateId !== approval.stateId);
  return prune({ ...policy, approved: [...others, approval] }, null);
}

/**
 * Keep only approvals still needed: not equal to the reference state and, when the open MR list is
 * known, belonging to an open MR. A merged gate change becomes the reference at the next `sync`.
 */
export function prune(policy: GatePolicy, openMrs: number[] | null): GatePolicy {
  const open = openMrs ? new Set(openMrs) : null;
  return {
    ...policy,
    approved: policy.approved.filter(
      (a) =>
        a.stateId !== policy.reference.state.id &&
        (open === null || (a.mr !== null && open.has(a.mr))),
    ),
  };
}

const header = (policy: GatePolicy, what: string): string =>
  [
    `# GENERATED by gate-policy (tools/ci/src/gate-policy.ts) — ${what}.`,
    `# Project ${policy.project}; Maintainer-only policy project ${policy.policyProject}. Do not edit by hand:`,
    `#   gate-admin approve|sync --project ${policy.project} --policy-project ${policy.policyProject}`,
    `# Reference: ${policy.defaultBranch} @ ${policy.reference.sha} (synced ${policy.reference.syncedAt}).`,
    '',
  ].join('\n');

/** Branch of the policy project that holds every rendered file (entry config and child config). */
export const POLICY_REF = 'main';

/** The project's CI/CD configuration file (`ci_config_path`). */
export function renderEntryConfig(policy: GatePolicy): string {
  const slug = slugOf(policy.project);
  return `${header(policy, 'CI/CD configuration entry point (ci_config_path)')}
# The project's own pipeline, from the commit under test (MR pipelines run the MR's jobs)…
include:
  - project: $CI_PROJECT_PATH
    ref: $CI_COMMIT_SHA
    file: .gitlab-ci.yml

# …plus a child pipeline compiled only from ${policy.policyProject}. Every key the MR could use to
# weaken this bridge is pinned here; its variables are not forwarded to the child.
'policy:gate-integrity':
  stage: .pre
  needs: []
  rules:
    - when: always
  allow_failure: false
  interruptible: true
  inherit:
    default: false
    variables: false
  trigger:
    include:
      - project: ${policy.policyProject}
        ref: ${POLICY_REF}
        file: projects/${slug}/gate-integrity.yml
    strategy: depend
    forward:
      yaml_variables: false
      pipeline_variables: false
`;
}

/** POSIX sh run by the child job with an empty environment (env -i): pure function of the checkout. */
export function renderCheckScript(policy: GatePolicy): string {
  const approved = policy.approved.map((a) => a.stateId).join(' ');
  const ref = policy.reference.state;
  return `# Gate integrity check — ${policy.project}. Runs with env -i: nothing but the checkout counts.
set -eu
paths='${policy.paths.join(' ')}'
reference_id='${ref.id}'
approved='${approved}'
fail() { echo "GATE INTEGRITY: $*" >&2; exit 1; }
[ "$(git rev-parse --is-inside-work-tree 2>/dev/null)" = true ] || fail "no git checkout"
[ "$(git rev-parse --show-toplevel)" = "$(pwd -P)" ] || fail "unexpected working directory"
[ "$(git rev-parse --is-bare-repository)" = false ] || fail "bare repository"
head=$(git rev-parse --verify 'HEAD^{commit}')
state=$(mktemp)
reference=$(mktemp)
for p in $paths; do
  e=$(git ls-tree --full-tree HEAD -- "$p")
  if [ -n "$e" ]; then printf '%s\\n' "$e" >> "$state"; else printf 'absent\\t%s\\n' "$p" >> "$state"; fi
done
id=$(sha256sum "$state" | cut -c1-64)
echo "commit $head gate state $id"
if [ "$id" = "$reference_id" ]; then
  echo "PASS: gate-defining paths equal the ${policy.defaultBranch} reference state (${policy.reference.sha})"
  exit 0
fi
for a in $approved; do
  if [ "$id" = "$a" ]; then echo "PASS: Maintainer-approved gate state $a"; exit 0; fi
done
cat > "$reference" <<'GATE_REFERENCE'
${ref.lines.join('\n')}
GATE_REFERENCE
echo "BLOCKED: gate-defining paths differ from every Maintainer-approved state."
echo "Changed entries (mode type object path) compared with the ${policy.defaultBranch} reference:"
grep -vxF -f "$reference" "$state" | sed 's/^/  /' || true
echo "A Maintainer reviews the change and approves it outside this merge request, then re-runs it:"
echo "  gate-admin approve --project \${PROJECT} --policy-project ${policy.policyProject} --mr \${MR_IID:-<iid>} --rerun"
exit 1
`;
}

/** The child pipeline (policy project, projects/<slug>/gate-integrity.yml). */
export function renderChildConfig(policy: GatePolicy): string {
  const script = renderCheckScript(policy)
    .split('\n')
    .map((l) => (l.length > 0 ? `      ${l}` : ''))
    .join('\n');
  return `${header(policy, 'gate-integrity child pipeline')}
workflow:
  rules:
    - when: always

'gate:integrity':
  image: ${policy.image}
${policy.runnerTag ? `  tags: [${policy.runnerTag}]\n` : ''}  rules:
    - when: always
  interruptible: true
  timeout: 10 minutes
  variables:
    GIT_STRATEGY: clone
    GIT_DEPTH: '1'
    GIT_CHECKOUT: 'true'
    GIT_SUBMODULE_STRATEGY: none
    GIT_LFS_SKIP_SMUDGE: '1'
  script:
    - |
      cat > /tmp/gate-integrity.sh <<'GATE_INTEGRITY'
${script}
      GATE_INTEGRITY
    - >-
      env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/tmp LC_ALL=C
      GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0
      PROJECT="$CI_PROJECT_PATH" MR_IID="\${CI_MERGE_REQUEST_IID:-}"
      sh -eu /tmp/gate-integrity.sh
`;
}

/** A runner tag rendered into the child YAML: empty, or letters, digits, `.`, `_`, `-`, `:` only. */
export const RUNNER_TAG = /^(?:[\w.:-]{1,64})?$/;

export function newPolicy(args: {
  project: string;
  defaultBranch: string;
  policyProject: string;
  image: string;
  runnerTag?: string;
  paths?: readonly string[];
  referenceSha: string;
  referenceState: GateState;
  now: Date;
}): GatePolicy {
  return {
    schemaVersion: POLICY_SCHEMA_VERSION,
    project: args.project,
    defaultBranch: args.defaultBranch,
    policyProject: args.policyProject,
    image: args.image,
    runnerTag: (() => {
      const tag = args.runnerTag ?? '';
      if (!RUNNER_TAG.test(tag)) throw new Error('runnerTag must be empty or a plain runner tag');
      return tag;
    })(),
    paths: [...(args.paths ?? DEFAULT_GATE_PATHS)],
    reference: {
      sha: args.referenceSha,
      syncedAt: args.now.toISOString(),
      state: args.referenceState,
    },
    approved: [],
  };
}

export function parsePolicy(json: string): GatePolicy {
  const p = JSON.parse(json) as GatePolicy;
  if (p.schemaVersion !== POLICY_SCHEMA_VERSION)
    throw new Error(`unsupported policy schema ${String(p.schemaVersion)}`);
  if (!/^[\w.-]+\/[\w./-]+$/.test(p.project))
    throw new Error('policy.project is not a project path');
  if (!/@sha256:[a-f0-9]{64}$/.test(p.image))
    throw new Error('policy.image must be pinned by digest');
  if (!Array.isArray(p.paths) || p.paths.some((x) => !/^[\w./-]+$/.test(x)))
    throw new Error('policy.paths must be plain repository paths');
  if (typeof p.runnerTag !== 'string' || !RUNNER_TAG.test(p.runnerTag))
    throw new Error('policy.runnerTag must be empty or a plain runner tag');
  return p;
}
