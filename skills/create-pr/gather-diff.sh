#!/usr/bin/env bash
# Gathers diff stat and diff for a PR. Run separately from gather-context.sh
# to avoid truncation of metadata.
set -euo pipefail

default_branch=$(gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name')
base="${1:-$default_branch}"

echo "=== DIFF STAT ==="
git diff "$base"...HEAD --stat

echo ""
echo "=== DIFF ==="
git diff "$base"...HEAD
