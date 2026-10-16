# ADR 0404 — Advisory AI review with PR-Agent

- Status: Accepted (amended: off by default, no job unless enabled)

## Context

An optional LLM review of MR diffs is useful on a self-managed GitLab, provided the model gets no
authority and no endpoint is assumed. Options considered:
**PR-Agent** (The-PR-Agent/pr-agent; community-maintained; MIT for the pinned release,
see `THIRD_PARTY.md`; frequent releases, GitLab support, one-shot CLI, image
`pragent/pr-agent` with linux/arm64, LiteLLM model routing → any OpenAI-compatible
endpoint); `ai-review` (Apache-2.0, single maintainer, GitLab CLI — runner-up);
Kodus (AGPL, multi-service platform); AI-Codereview-Gitlab (webhook server only);
Shippie (GitHub-first).

## Decision

- PR-Agent **0.46.0** pinned by digest (the newest release at least 2 weeks old when pinned). Job `review:ai`: MR pipelines only, after integration (stage order),
  `allow_failure: true`, runs `python -m pr_agent.cli --pr_url … review`.
- **Off by default** (`AI_REVIEW_ENABLED: 'false'` in `.gitlab-ci.yml`): neither `review:ai` nor
  `review:ai-status` exists in a pipeline until a Maintainer sets `AI_REVIEW_ENABLED=true`.
- Runs only if `AI_REVIEW_ENABLED=true` **and** `AI_REVIEW_API_BASE`, `AI_REVIEW_MODEL`,
  `AI_REVIEW_GITLAB_TOKEN` exist; enabled but incomplete, `review:ai-status` names the missing
  variables and ends as an allowed warning.
- Token: project access token, Reporter, `api` scope (the minimum that can post notes; `api` also
  grants Reporter read access to the project API); labels/description updates disabled. The token
  and the optional `AI_REVIEW_API_KEY` are unprotected project variables and therefore readable by
  MR pipeline code (`docs/security.md` §10).
- Repo settings in `.pr_agent.toml`; model/endpoint only from CI variables (env wins).

## Consequences

- No LLM traffic unless explicitly configured; deterministic gates stay authoritative.
- Needs egress to the model endpoint and to tiktoken's encoding host (or a derived
  image with a pre-seeded `TIKTOKEN_CACHE_DIR`).
