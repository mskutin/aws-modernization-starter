#!/usr/bin/env bash
# Portable file-mode helper (sourced by scripts/_common.sh and sandbox/_lib.sh, not executed).
# Written for bash 3.2 (macOS /bin/bash) and GNU bash alike.

# file_mode <file> — prints the permission bits of <file> in octal (e.g. 600) on GNU coreutils
# (Linux CI images) and BSD/macOS stat alike; returns 1 and prints nothing when they cannot be read.
#
# GNU stat is tried first: on GNU, `stat -f` means --file-system, so the BSD form `stat -f '%Lp' f`
# prints the file system's details to stdout before it fails on the '%Lp' operand — a
# `stat -f … || stat -c …` chain therefore yields garbage there. BSD stat rejects `-c` without output.
# The result is validated as octal so a caller's mode comparison never sees anything else.
file_mode() {
  local out
  if out="$(stat -c '%a' -- "$1" 2>/dev/null)" && [[ "$out" =~ ^[0-7]{3,4}$ ]]; then
    printf '%s\n' "$out"
  elif out="$(stat -f '%Lp' -- "$1" 2>/dev/null)" && [[ "$out" =~ ^[0-7]{3,4}$ ]]; then
    printf '%s\n' "$out"
  else
    return 1
  fi
}
