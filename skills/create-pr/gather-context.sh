#!/usr/bin/env bash
# Gathers all context needed to create a PR. Output is structured for the agent.
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
if pr_info=$(gh pr view --json number,title,url 2>/dev/null); then
  echo "$pr_info"
else
  echo "none"
fi

# --- Commits ---
echo ""
echo "=== COMMITS ==="
git log "$base"..HEAD --oneline

# --- Diff stat ---
echo ""
echo "=== DIFF STAT ==="
git diff "$base"...HEAD --stat

# --- Diff (truncated to ~8000 lines to stay manageable) ---
echo ""
echo "=== DIFF ==="
git diff "$base"...HEAD | head -8000
diff_lines=$(git diff "$base"...HEAD | wc -l)
if [ "$diff_lines" -gt 8000 ]; then
  echo ""
  echo "[TRUNCATED: diff has $diff_lines lines total, showing first 8000]"
fi

# --- PR template ---
echo ""
echo "=== PR TEMPLATE ==="
template=""
for candidate in \
  .github/PULL_REQUEST_TEMPLATE.md \
  .github/pull_request_template.md \
  PULL_REQUEST_TEMPLATE.md \
  pull_request_template.md; do
  if [ -f "$candidate" ]; then
    template="$candidate"
    break
  fi
done
# Check template directory
if [ -z "$template" ] && [ -d ".github/PULL_REQUEST_TEMPLATE" ]; then
  template=$(find .github/PULL_REQUEST_TEMPLATE -name '*.md' | head -1)
fi

if [ -n "$template" ]; then
  echo "found: $template"
  echo "--- TEMPLATE CONTENT ---"
  cat "$template"
  echo "--- END TEMPLATE ---"
else
  echo "none"
fi

# --- PR title convention ---
echo ""
echo "=== RECENT PR TITLES ==="
gh pr list --state merged --limit 5 --json title --jq '.[].title' 2>/dev/null || echo "none"
