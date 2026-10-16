#!/bin/sh
# CDK_DOCKER of every emulator `cdk` call (emulator_cli_isolation). Asset bundling must stay local
# (NodejsFunction's esbuild): a container engine would pull images from a registry and is never
# available to the emulator jobs. Any call is refused and recorded as an egress violation, so the
# `egress audit` step fails the run. NOT AWS — see _emulator.sh.
if [ -n "${STARTER_EMULATOR_EGRESS_LOG:-}" ]; then
  printf '{"at":"%s","pid":%s,"proc":"no-container-engine","kind":"container-engine","target":"%s","allowed":false}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$$" "$(printf '%s' "${1:-}" | tr -cd 'a-z-')" >>"$STARTER_EMULATOR_EGRESS_LOG"
fi
echo "[emulator] refusing: a container engine was requested (CDK_DOCKER ${1:-}); emulator runs bundle locally" >&2
exit 1
