# shellcheck shell=bash
# Region helpers of the shell scripts (sourced by sandbox-guard.sh and the AWS lifecycle scripts
# under tests/aws-integration). The same default and rules as `@starter/config/region` (the single
# source of truth): DEFAULT_AWS_REGION and validateAwsRegion. Tests run both on the same inputs
# (tools/aws-preflight/test/region.test.ts) and pin the default.
# shellcheck disable=SC2034  # used by the sourcing scripts

STARTER_DEFAULT_REGION=ap-southeast-1

# starter_region_ok <value>: status 0 when the value is a region name of the aws partition
# (<area>-<direction>-<n>; not cn-*, *-gov-*, *-iso*-*).
starter_region_ok() {
  [[ "${1:-}" =~ ^[a-z]{2}-[a-z]+-[0-9]{1,2}$ ]] && ! [[ "$1" =~ ^(cn-|[a-z]{2}-(gov|iso[a-z]?)-) ]]
}
