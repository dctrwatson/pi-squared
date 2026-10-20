#!/usr/bin/env bash
set -euo pipefail

pr_die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

pr_require_command() {
  command -v "$1" >/dev/null 2>&1 || pr_die "Missing required command: $1"
}

pr_absolute_path() {
  local input="$1"
  local directory
  directory=$(cd "$(dirname "$input")" && pwd)
  printf '%s/%s\n' "$directory" "$(basename "$input")"
}

pr_remote_head() {
  local remote="$1"
  local branch="$2"
  git ls-remote --heads "$remote" "refs/heads/$branch" | awk 'NR == 1 { print $1 }'
}

pr_canonical_existing_path() {
  local input="$1"
  [ -e "$input" ] || pr_die "Path does not exist: $input"
  pr_absolute_path "$input"
}

pr_require_repo() {
  git rev-parse --show-toplevel >/dev/null 2>&1 || pr_die "Current directory is not a Git repository"
}

pr_require_clean_tree() {
  [ -z "$(git status --porcelain)" ] || pr_die "Working tree is dirty. Commit or stash changes before continuing"
}

pr_json_value() {
  local file="$1"
  local expression="$2"
  jq -er "$expression" "$file"
}

pr_write_commit_json() {
  local range="$1"
  local repo_url="$2"
  local output="$3"
  local records
  records=$(mktemp)
  : > "$records"
  local hash subject body short url markdown
  while IFS= read -r hash; do
    [ -n "$hash" ] || continue
    subject=$(git show -s --format='%s' "$hash")
    body=$(git show -s --format='%b' "$hash")
    short=${hash:0:7}
    url="$repo_url/commit/$hash"
    markdown="[\`$short\`]($url)"
    jq -cn \
      --arg sha "$hash" \
      --arg short "$short" \
      --arg subject "$subject" \
      --arg body "$body" \
      --arg url "$url" \
      --arg markdown "$markdown" \
      '{sha:$sha,short:$short,subject:$subject,body:$body,url:$url,markdown:$markdown}' >> "$records"
  done < <(git rev-list --reverse "$range")
  jq -s '.' "$records" > "$output"
  rm -f "$records"
}

pr_validate_title_file() {
  local file="$1"
  [ -r "$file" ] || pr_die "Title file is not readable: $file"
  local title extra
  IFS= read -r title < "$file" || true
  title=${title%$'\r'}
  [ -n "$title" ] || pr_die "Title file is empty"
  extra=$(tail -n +2 "$file" | tr -d '\r\n')
  [ -z "$extra" ] || pr_die "Title file must contain exactly one line"
  printf '%s\n' "$title"
}
