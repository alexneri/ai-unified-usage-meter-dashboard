#!/usr/bin/env bash
# vault.sh — age encrypt/decrypt helpers for the collector's secret vault.
# Architecture §9, Story 1.6. Plaintext is NEVER written to disk by decrypt (it
# goes to stdout so config.ts can read it into memory).
#
# Usage:
#   scripts/vault.sh encrypt [infile=.env]      [outfile=.env.age]
#   scripts/vault.sh decrypt [infile=.env.age]                      # prints plaintext to stdout
#
# Requires the `age` binary (https://github.com/FiloSottile/age). If age is not
# installed the script exits non-zero with a clear message and the collector
# falls back to process.env / .env (graceful — the build never fails on this).
#
# Env:
#   AGE_IDENTITY    identity file for decrypt (default: ~/.config/age/keys.txt)
#   AGE_RECIPIENTS  comma-separated age recipients for encrypt (public keys)
#
# Generate an identity once (interactive, not done by this script):
#   mkdir -p ~/.config/age && age-keygen -o ~/.config/age/keys.txt
#   # the printed "Public key: age1..." goes into AGE_RECIPIENTS

set -euo pipefail

cmd="${1:-}"

require_age() {
  if ! command -v age >/dev/null 2>&1; then
    echo "vault.sh: 'age' is not installed — install it (brew install age) or use a plain .env for dev." >&2
    exit 3
  fi
}

case "$cmd" in
  encrypt)
    require_age
    infile="${2:-.env}"
    outfile="${3:-.env.age}"
    if [ ! -f "$infile" ]; then
      echo "vault.sh: input '$infile' not found" >&2
      exit 2
    fi
    recipients="${AGE_RECIPIENTS:-}"
    if [ -z "$recipients" ]; then
      echo "vault.sh: set AGE_RECIPIENTS (comma-separated age public keys) to encrypt" >&2
      exit 2
    fi
    # Build -r args from the comma-separated recipient list.
    args=()
    IFS=',' read -ra recips <<< "$recipients"
    for r in "${recips[@]}"; do
      r_trimmed="$(echo "$r" | xargs)"
      [ -n "$r_trimmed" ] && args+=("-r" "$r_trimmed")
    done
    age "${args[@]}" -o "$outfile" "$infile"
    echo "vault.sh: encrypted '$infile' -> '$outfile'" >&2
    ;;

  decrypt)
    require_age
    infile="${2:-.env.age}"
    identity="${AGE_IDENTITY:-$HOME/.config/age/keys.txt}"
    if [ ! -f "$infile" ]; then
      echo "vault.sh: vault '$infile' not found" >&2
      exit 2
    fi
    if [ ! -f "$identity" ]; then
      echo "vault.sh: age identity '$identity' not found (set AGE_IDENTITY)" >&2
      exit 2
    fi
    # Plaintext to stdout only — never written to disk here.
    age -d -i "$identity" "$infile"
    ;;

  *)
    echo "usage: scripts/vault.sh {encrypt|decrypt} [infile] [outfile]" >&2
    exit 1
    ;;
esac
