# shellcheck shell=sh
# Registry TLS policy for the release scripts (sourced, POSIX sh). The registry is the project's
# GitLab container registry (predefined CI_REGISTRY, CI_REGISTRY_IMAGE, CI_REGISTRY_USER,
# CI_REGISTRY_PASSWORD). TLS is verified by default; plain HTTP or an unverified certificate only
# when a Maintainer opts in with REGISTRY_TLS_VERIFY=false (a lab registry). Any other value is an
# error, never a silent downgrade.

# Prints "true" or "false"; returns 2 on an invalid value.
registry_tls_verify() {
  case "${REGISTRY_TLS_VERIFY:-true}" in
    true) echo true ;;
    false)
      echo "WARNING: registry TLS verification is OFF (REGISTRY_TLS_VERIFY=false, explicit opt-in)" >&2
      echo false
      ;;
    *)
      echo "ERROR: REGISTRY_TLS_VERIFY must be \"true\" or \"false\"" >&2
      return 2
      ;;
  esac
}

# cosign flags for the policy (empty when TLS is verified).
registry_cosign_flags() {
  tls="$(registry_tls_verify)" || return 2
  if [ "$tls" = false ]; then echo "--allow-insecure-registry --allow-http-registry"; fi
}
