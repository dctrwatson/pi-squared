#!/usr/bin/env bash
# Gathers PR metadata: branches, existing PR, commits, template, title conventions.
# Diff is handled separately by gather-diff.sh to avoid truncation.
set -euo pipefail

# --- Branches ---
current_branch=$(git branch --show-current)
default_branch=$(gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name')
base="${1:-$default_branch}"

echo "=== BRANCHES ==="
echo "current: $current_branch"
echo "default: $default_branch"
echo "base: $base"

if [ "$current_branch" = "$base" ]; then
  echo "ERROR: Current branch IS the base branch. Cannot create PR."
  exit 1
fi

# --- Existing PR ---
echo ""
echo "=== EXISTING PR ==="
if pr_info=$(gh pr view --json number,title,url,state 2>/dev/null) && echo "$pr_info" | grep -q '"state":"OPEN"'; then
  echo "$pr_info"
else
  echo "none"
fi

# --- Commits ---
echo ""
echo "=== COMMITS ==="
git log "$base"..HEAD --oneline

# --- PR title convention ---
echo ""
echo "=== RECENT PR TITLES ==="
gh pr list --state merged --limit 5 --json title --jq '.[].title' 2>/dev/null || echo "none"
