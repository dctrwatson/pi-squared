#!/usr/bin/env bash
# Gathers PR metadata: branches, existing PR, commits, template, title conventions.
# Diff is handled separately by gather-diff.sh to avoid truncation.
set -euo pipefail

if ! gh auth status >/dev/null 2>&1; then
  echo "ERROR: gh is not authenticated. Run 'gh auth login' first." >&2
  exit 1
fi

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
if pr_state=$(gh pr view --json state --jq '.state' 2>/dev/null); then
  if [ "$pr_state" = "OPEN" ]; then
    gh pr view --json number,title,url,state,baseRefName
  elif [ "$pr_state" = "MERGED" ]; then
    echo "none (note: a previous PR from this branch was already merged)"
  else
    echo "none (note: a previous PR from this branch was closed)"
  fi
else
  echo "none"
fi

if [ "$(git rev-list --count "$base"..HEAD)" -eq 0 ]; then
  echo ""
  echo "ERROR: No commits between $base and HEAD. Cannot create PR."
  exit 1
fi

# --- Commits ---
echo ""
echo "=== COMMITS ==="
git log "$base"..HEAD --format="--- %h %s ---%n%b"

# --- PR title convention ---
echo ""
echo "=== RECENT PR TITLES ==="
gh pr list --state merged --limit 5 --json title --jq '.[].title' 2>/dev/null || echo "none"
