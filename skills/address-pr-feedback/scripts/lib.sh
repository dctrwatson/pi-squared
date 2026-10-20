#!/usr/bin/env bash
set -euo pipefail

feedback_die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

feedback_require_command() {
  command -v "$1" >/dev/null 2>&1 || feedback_die "Missing required command: $1"
}

feedback_require_repo() {
  git rev-parse --show-toplevel >/dev/null 2>&1 || feedback_die "Current directory is not a Git repository"
}

feedback_require_clean_tree() {
  [ -z "$(git status --porcelain)" ] || feedback_die "Working tree is dirty. Commit or stash changes before continuing"
}

feedback_absolute_path() {
  local input="$1"
  local directory
  directory=$(cd "$(dirname "$input")" && pwd)
  printf '%s/%s\n' "$directory" "$(basename "$input")"
}

feedback_existing_path() {
  [ -e "$1" ] || feedback_die "Path does not exist: $1"
  feedback_absolute_path "$1"
}

feedback_json_value() {
  jq -er "$2" "$1"
}

feedback_remote_head() {
  git ls-remote --heads "$1" "refs/heads/$2" | awk 'NR == 1 { print $1 }'
}

feedback_wait_for_pr_head() {
  local repo="$1" number="$2" branch="$3" base="$4" expected="$5"
  local current observed remote attempt
  local delays=(1 2 4 8 8)
  for ((attempt = 0; attempt <= ${#delays[@]}; attempt++)); do
    remote=$(feedback_remote_head origin "$branch") || feedback_die "Could not read origin/$branch during PR head confirmation"
    [ "$remote" = "$expected" ] || feedback_die "origin/$branch does not match the publication head. Expected $expected; found ${remote:-<missing>}"
    current=$(gh pr view "$number" --repo "$repo" --json number,state,baseRefName,headRefName,headRefOid,headRepository,isCrossRepository,url) || feedback_die "Could not read PR #$number during head confirmation"
    jq -e --arg repo "$repo" --arg branch "$branch" --arg base "$base" --argjson number "$number" '
      .number == $number and .state == "OPEN" and .headRefName == $branch and
      .baseRefName == $base and .isCrossRepository == false and .headRepository.nameWithOwner == $repo
    ' <<<"$current" >/dev/null || feedback_die "PR #$number is not open or its repository, head branch, or base changed"
    observed=$(jq -er '.headRefOid | select(type == "string" and length > 0)' <<<"$current") || feedback_die "PR #$number returned no valid head SHA"
    remote=$(feedback_remote_head origin "$branch") || feedback_die "Could not read origin/$branch after PR head confirmation"
    [ "$remote" = "$expected" ] || feedback_die "origin/$branch does not match the publication head. Expected $expected; found ${remote:-<missing>}"
    if [ "$observed" = "$expected" ]; then return 0; fi
    if [ "$attempt" -lt "${#delays[@]}" ]; then
      if [ "$attempt" -eq 0 ]; then
        printf 'NOTE: origin/%s matches %s. Wait for the GitHub PR head to update.\n' "$branch" "$expected" >&2
      fi
      sleep "${delays[$attempt]}" || feedback_die "PR head confirmation wait failed"
    fi
  done
  feedback_die "GitHub PR head did not match after $((attempt)) checks. Expected $expected; found $observed. origin/$branch still matches"
}

feedback_origin_repo() {
  local url="$1"
  local repo=""
  case "$url" in
    git@github.com:*) repo=${url#git@github.com:} ;;
    ssh://git@github.com/*) repo=${url#ssh://git@github.com/} ;;
    https://github.com/*) repo=${url#https://github.com/} ;;
    http://github.com/*) repo=${url#http://github.com/} ;;
  esac
  repo=${repo%.git}
  repo=${repo%/}
  printf '%s\n' "$repo"
}

feedback_write_commit_json() {
  local range="$1"
  local repo_url="$2"
  local output="$3"
  local records
  records=$(mktemp)
  : > "$records"
  local sha short subject body url markdown
  while IFS= read -r sha; do
    [ -n "$sha" ] || continue
    short=${sha:0:7}
    subject=$(git show -s --format='%s' "$sha")
    body=$(git show -s --format='%b' "$sha")
    url="$repo_url/commit/$sha"
    markdown="[\`$short\`]($url)"
    jq -cn \
      --arg sha "$sha" \
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
