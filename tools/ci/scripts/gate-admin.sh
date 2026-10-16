#!/bin/sh
# Maintainer tooling for the optional gate-integrity policy (ADR 0410, docs/ci-cd.md §4a).
# Thin wrapper: the implementation is `gate-admin` in tools/ci/src/gate-admin.ts (Node 24, git).
#
#   GITLAB_URL=https://gitlab.example.com GITLAB_TOKEN_FILE=~/.config/gitlab/maintainer-token \
#     tools/ci/scripts/gate-admin.sh install --project group/app --policy-project group/ci-policy
#
# The token is read from GITLAB_TOKEN_FILE (mode 0600) and never printed or passed on a command line.
set -eu
exec node "$(dirname "$0")/../src/cli.ts" gate-admin "$@"
