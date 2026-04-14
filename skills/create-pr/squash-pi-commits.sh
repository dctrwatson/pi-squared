#!/usr/bin/env bash
# Rewrites the current branch into a single clean commit when `pi:` auto-commits
# are present in the branch range. Expects a prepared commit message file.
set -euo pipefail

usage() {
  echo "Usage: bash squash-pi-commits.sh <base_branch> <commit_message_file>" >&2
}

if [ "$#" -ne 2 ]; then
  usage
  exit 1
fi

base="$1"
message_file="$2"

if [ ! -f "$message_file" ]; then
  echo "ERROR: Commit message file not found: $message_file" >&2
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "ERROR: Working tree is dirty. Commit or stash changes before rewriting history." >&2
  exit 1
fi

if ! git rev-parse --verify HEAD >/dev/null 2>&1; then
  echo "ERROR: Repository has no commits." >&2
  exit 1
fi

if ! git rev-parse --verify "$base" >/dev/null 2>&1; then
  echo "ERROR: Base ref not found: $base" >&2
  exit 1
fi

if ! git log "$base"..HEAD --format='%s' | grep -q '^pi:'; then
  echo "NO_PI_COMMITS"
  exit 0
fi

merge_base=$(git merge-base "$base" HEAD)
if [ -z "$merge_base" ]; then
  echo "ERROR: Could not determine merge base with $base." >&2
  exit 1
fi

head=$(git rev-parse HEAD)
if [ "$merge_base" = "$head" ]; then
  echo "ERROR: No branch commits to rewrite." >&2
  exit 1
fi

git reset --soft "$merge_base"
git commit --file "$message_file"

echo "REWROTE_PI_COMMITS"
branch=$(git branch --show-current)
if [ -n "$branch" ] && git show-ref --verify --quiet "refs/remotes/origin/$branch"; then
  echo "PUSH: git push --force-with-lease -u origin HEAD"
else
  echo "PUSH: git push -u origin HEAD"
fi
