#!/usr/bin/env bash
# Gathers diff stat and diff for a PR. Run separately from gather-context.sh
# to avoid truncation of metadata.
set -euo pipefail

if [ -n "${1:-}" ]; then
  base="$1"
else
  base=$(gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name')
fi

if ! git rev-parse --verify "$base" >/dev/null 2>&1; then
  echo "ERROR: Base ref not found: $base" >&2
  exit 1
fi

if ! git merge-base "$base" HEAD >/dev/null 2>&1; then
  echo "ERROR: Cannot find merge base with '$base'." >&2
  exit 1
fi

echo "=== DIFF STAT ==="
git diff "$base"...HEAD --stat

echo ""
echo "=== DIFF ==="
git diff "$base"...HEAD
