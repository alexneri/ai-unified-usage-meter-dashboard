#!/usr/bin/env bash
# secret-scan.sh — fail if tracked files contain real-looking provider keys.
# Architecture §9, Story 1.6 (NFR2). Intended for CI + pre-commit.
#
# Strategy: scan TRACKED files only (git — so node_modules/.env are never seen)
# for known key prefixes followed by a long alphanumeric run. Placeholders like
# `sk-or-XXXX` are short and contain XXXX, so they never match. This scan file and
# the .env.example placeholders are excluded from the search.
#
# Exit 0 = clean; exit 1 = a real-looking secret was found.

set -euo pipefail

cd "$(dirname "$0")/.."

# Real keys: a provider prefix + a long base62 run. XXXX placeholders won't match.
PATTERN='(sk-or-v1-|sk-ant-api[0-9]{2}-|sk-ant-admin[0-9]{2}-|sk-admin-|sk-proj-|sk-live-|sk-)[A-Za-z0-9]{20,}|xai-[A-Za-z0-9]{20,}'

# git grep over tracked files; exclude this scanner and the example env.
if ! command -v git >/dev/null 2>&1; then
  echo "secret-scan: git not available; skipping." >&2
  exit 0
fi

matches="$(
  git grep -nIE "$PATTERN" -- \
    ':(exclude)scripts/secret-scan.sh' \
    ':(exclude).env.example' \
    2>/dev/null | grep -viE 'XXXX|EXAMPLE|placeholder' || true
)"

if [ -n "$matches" ]; then
  echo "secret-scan: FAIL — real-looking key material in tracked files:" >&2
  echo "$matches" >&2
  echo "Remove the secret, rotate it, and use the age vault (scripts/vault.sh)." >&2
  exit 1
fi

echo "secret-scan: OK — no real-looking key material in tracked files."
exit 0
