#!/usr/bin/env bash
# Finds and outputs the PR template for the current git repo, if one exists.
# Accepts an optional selector (basename or path suffix) when multiple templates exist.
set -euo pipefail

root=$(git rev-parse --show-toplevel)
selector="${1:-}"
candidates=()

add_named_templates() {
  local dir="$1"
  if [ ! -d "$dir" ]; then
    return
  fi

  while IFS= read -r file; do
    if [ -n "$file" ]; then
      candidates+=("$file")
    fi
  done < <(find "$dir" -maxdepth 1 -type f -iname 'pull_request_template.md' | LC_ALL=C sort)
}

add_directory_templates() {
  local parent="$1"
  if [ ! -d "$parent" ]; then
    return
  fi

  while IFS= read -r dir; do
    while IFS= read -r file; do
      if [ -n "$file" ]; then
        candidates+=("$file")
      fi
    done < <(find "$dir" -type f \( -iname '*.md' -o -iname '*.markdown' \) | LC_ALL=C sort)
  done < <(find "$parent" -maxdepth 1 -type d -iname 'pull_request_template' | LC_ALL=C sort)
}

add_named_templates "$root/.github"
add_named_templates "$root/docs"
add_named_templates "$root"
add_directory_templates "$root/.github"

if [ "${#candidates[@]}" -eq 0 ]; then
  echo "NO TEMPLATE"
  exit 0
fi

print_template() {
  local file="$1"
  echo "TEMPLATE: $file"
  cat "$file"
}

if [ -n "$selector" ]; then
  matches=()
  for file in "${candidates[@]}"; do
    rel="${file#"$root"/}"
    base=$(basename "$file")
    matched=0

    if [ "$base" = "$selector" ]; then
      matched=1
    elif [[ "$rel" == *"$selector" ]]; then
      matched=1
    elif [[ "$file" == *"$selector" ]]; then
      matched=1
    fi

    if [ "$matched" -eq 1 ]; then
      matches+=("$file")
    fi
  done

  if [ "${#matches[@]}" -eq 0 ]; then
    echo "ERROR: No template matched selector: $selector" >&2
    printf 'AVAILABLE TEMPLATE: %s\n' "${candidates[@]}" >&2
    exit 1
  fi

  if [ "${#matches[@]}" -gt 1 ]; then
    echo "MULTIPLE_TEMPLATES"
    printf '%s\n' "${matches[@]}"
    exit 0
  fi

  print_template "${matches[0]}"
  exit 0
fi

if [ "${#candidates[@]}" -gt 1 ]; then
  echo "MULTIPLE_TEMPLATES"
  printf '%s\n' "${candidates[@]}"
  exit 0
fi

print_template "${candidates[0]}"
