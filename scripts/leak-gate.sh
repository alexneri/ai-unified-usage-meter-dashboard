#!/usr/bin/env bash
# leak-gate.sh — the public mirror's hard safety gate. Run before every commit/push.
#
# Two checks, both over TRACKED files only (git grep — never sees node_modules or .env):
#   1. secret-scan.sh  — real-looking provider key material.
#   2. identifier scan — personal / infra identifiers from the private lab that must
#      NEVER appear in this public mirror (host names, absolute paths, internal names).
#
# Wire-up: `npm run leak-gate`; runs in CI and as a pre-push hook. Exit 0 = clean, 1 = leak.
# This is the single source of truth for "what must never leak into public" — extend
# IDENTIFIERS when a new personal/infra token needs guarding.

set -euo pipefail
cd "$(dirname "$0")/.."

# 1) provider key material (delegates to the existing scanner)
bash scripts/secret-scan.sh

# 2) personal / infra identifiers — the private lab's fingerprints
IDENTIFIERS='hyacine|tailb8750d\.ts\.net|ideahub|com\.ideahub|ideahub-dashboard|/Users/aneri|aneri@|kujata\.jp'

if ! command -v git >/dev/null 2>&1; then
  echo "leak-gate: git not available; skipping identifier scan." >&2
  exit 0
fi

# git grep exits 1 when there are no matches (that's the healthy case).
matches="$(git grep -nIE "$IDENTIFIERS" -- ':(exclude)scripts/leak-gate.sh' 2>/dev/null || true)"

if [ -n "$matches" ]; then
  echo "leak-gate: FAIL — personal/infra identifiers found in tracked files:" >&2
  echo "$matches" >&2
  echo "These must not exist in the public mirror. Scrub them before committing." >&2
  exit 1
fi

echo "leak-gate: OK — no personal/infra identifiers in tracked files."
exit 0
