#!/usr/bin/env bash
# Finds and outputs the PR template for the current git repo, if one exists.
set -euo pipefail

root=$(git rev-parse --show-toplevel)
for f in \
  "$root/.github/PULL_REQUEST_TEMPLATE.md" \
  "$root/.github/pull_request_template.md" \
  "$root/PULL_REQUEST_TEMPLATE.md" \
  "$root/pull_request_template.md"; do
  if [ -f "$f" ]; then
    echo "TEMPLATE: $f"
    cat "$f"
    exit 0
  fi
done

if [ -d "$root/.github/PULL_REQUEST_TEMPLATE" ]; then
  f=$(find "$root/.github/PULL_REQUEST_TEMPLATE" -name '*.md' | head -1)
  if [ -n "$f" ]; then
    echo "TEMPLATE: $f"
    cat "$f"
    exit 0
  fi
fi

echo "NO TEMPLATE"
