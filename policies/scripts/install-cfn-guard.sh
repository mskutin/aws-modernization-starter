#!/bin/sh
# Installs a pinned, SHA-256-verified CloudFormation Guard release binary into
# policies/.tools/cfn-guard (project-local; no global install).
#
# Usage: sh scripts/install-cfn-guard.sh [install-dir]
# Env:   CFN_GUARD_INSTALL_DIR overrides the install directory.
# Needs: curl, tar, and sha256sum or shasum.
set -eu

VERSION="3.2.1"
BASE_URL="https://github.com/aws-cloudformation/cloudformation-guard/releases/download/${VERSION}"

# SHA-256 of the release archives (GitHub release asset digests, verified 2026-10-13).
SHA_LINUX_ARM64="cd378026dad0f865926ab1d1c082e2faf825f7fd888a9fe6b5c142cdf175c129" # aarch64-linux (static ELF)
SHA_LINUX_X64="8c66efb19c63e6c2bf26b9a41bbcf2f85baa8a937b01d350940194faaf64cf1d"   # x86_64-linux
SHA_MACOS_ARM64="4c1eb10c061731159eaaf0e7dbd465db9fa4b767b82186a4ab489671cc00b7d0" # aarch64-macos
SHA_MACOS_X64="5089dfaa05a766cf118a020518e62f77eddbd43acf3a0b69d36b23175c6c6fda"   # x86_64-macos

SCRIPT_DIR=$(CDPATH="" cd -- "$(dirname -- "$0")" && pwd)
DEST="${1:-${CFN_GUARD_INSTALL_DIR:-$SCRIPT_DIR/../.tools}}"

os=$(uname -s)
arch=$(uname -m)
case "$os/$arch" in
  Linux/aarch64 | Linux/arm64) asset="aarch64-linux"; sha="$SHA_LINUX_ARM64" ;;
  Linux/x86_64 | Linux/amd64) asset="x86_64-linux"; sha="$SHA_LINUX_X64" ;;
  Darwin/arm64) asset="aarch64-macos"; sha="$SHA_MACOS_ARM64" ;;
  Darwin/x86_64) asset="x86_64-macos"; sha="$SHA_MACOS_X64" ;;
  *) echo "install-cfn-guard: unsupported platform $os/$arch" >&2; exit 2 ;;
esac

if [ -x "$DEST/cfn-guard" ] && "$DEST/cfn-guard" --version 2>/dev/null | grep -q "$VERSION"; then
  echo "cfn-guard $VERSION already installed at $DEST/cfn-guard"
  exit 0
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM
archive="$tmp/cfn-guard.tar.gz"
name="cfn-guard-v3-${asset}-latest"
echo "Downloading cfn-guard $VERSION ($asset)"
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  -o "$archive" "$BASE_URL/${name}.tar.gz"

if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$archive" | awk '{print $1}')
else
  actual=$(shasum -a 256 "$archive" | awk '{print $1}')
fi
if [ "$actual" != "$sha" ]; then
  echo "install-cfn-guard: SHA-256 mismatch for $name (expected $sha, got $actual)" >&2
  exit 1
fi

tar -xzf "$archive" -C "$tmp"
mkdir -p "$DEST"
cp "$tmp/$name/cfn-guard" "$DEST/cfn-guard"
chmod 0755 "$DEST/cfn-guard"
"$DEST/cfn-guard" --version
echo "Installed to $DEST/cfn-guard (sha256 verified)"
