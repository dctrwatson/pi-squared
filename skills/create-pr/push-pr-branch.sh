#!/usr/bin/env bash
# Cleans `pi:` auto-commits from the current PR branch and only then pushes it.
set -euo pipefail

usage() {
  echo "Usage: bash push-pr-branch.sh <base_branch> <commit_message_file>" >&2
}

if [ "$#" -ne 2 ]; then
  usage
  exit 1
fi

base="$1"
message_file="$2"
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

cleanup_output=""
if ! cleanup_output=$(bash "$script_dir/squash-pi-commits.sh" "$base" "$message_file"); then
  exit 1
fi
printf '%s\n' "$cleanup_output"

rewrote=0
if printf '%s\n' "$cleanup_output" | grep -Fxq 'REWROTE_PI_COMMITS'; then
  rewrote=1
elif ! printf '%s\n' "$cleanup_output" | grep -Fxq 'NO_PI_COMMITS'; then
  echo "ERROR: Commit cleanup returned no recognized result. Refusing to push." >&2
  exit 1
fi

merge_base=$(git merge-base "$base" HEAD)
remaining_pi=$(git log "$merge_base"..HEAD --format='%s' | grep '^pi:' || true)
if [ -n "$remaining_pi" ]; then
  echo "ERROR: pi: commits remain after cleanup. Refusing to push." >&2
  printf '%s\n' "$remaining_pi" >&2
  exit 1
fi

push_args=(-u origin HEAD)
if [ "$rewrote" -eq 1 ]; then
  if printf '%s\n' "$cleanup_output" | grep -Fxq 'PUSH: git push --force-with-lease -u origin HEAD'; then
    push_args=(--force-with-lease -u origin HEAD)
  elif ! printf '%s\n' "$cleanup_output" | grep -Fxq 'PUSH: git push -u origin HEAD'; then
    echo "ERROR: Commit cleanup returned no recognized push command. Refusing to push." >&2
    exit 1
  fi
else
  echo "PUSH: git push -u origin HEAD"
fi

git push "${push_args[@]}"
echo "PUSHED"
