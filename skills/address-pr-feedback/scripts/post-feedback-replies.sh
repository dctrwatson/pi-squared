#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "$script_dir/lib.sh"

usage() {
  echo "Usage: post-feedback-replies.sh --state state.json --manifest replies.json [--results path] [--dry-run]" >&2
}
state_file=""
manifest_file=""
results_file=""
dry_run=false
temporary_body=""
cleanup() {
  if [ -n "$temporary_body" ]; then rm -f "$temporary_body"; fi
}
trap cleanup EXIT
while [ "$#" -gt 0 ]; do
  case "$1" in
    --state)
      [ "$#" -ge 2 ] || { usage; exit 1; }
      state_file="$2"
      shift 2
      ;;
    --manifest)
      [ "$#" -ge 2 ] || { usage; exit 1; }
      manifest_file="$2"
      shift 2
      ;;
    --results)
      [ "$#" -ge 2 ] || { usage; exit 1; }
      results_file="$2"
      shift 2
      ;;
    --dry-run)
      dry_run=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *) feedback_die "Unknown argument: $1" ;;
  esac
done
[ -n "$state_file" ] && [ -n "$manifest_file" ] || { usage; exit 1; }
for command in gh jq mktemp; do feedback_require_command "$command"; done
gh auth status >/dev/null 2>&1 || feedback_die "gh is not authenticated. Run 'gh auth login' first"
state_file=$(feedback_existing_path "$state_file")
manifest_file=$(feedback_existing_path "$manifest_file")
[ "$(feedback_json_value "$manifest_file" '.version')" = "1" ] || feedback_die "Unsupported reply manifest version"
reply_count=$(jq '.replies | length' "$manifest_file")
unique_count=$(jq '[.replies[].item_id] | unique | length' "$manifest_file")
[ "$reply_count" -eq "$unique_count" ] || feedback_die "Reply manifest contains duplicate item IDs"

repo=$(feedback_json_value "$state_file" '.repo')
pr_number=$(feedback_json_value "$state_file" '.pr.number')
viewer=$(feedback_json_value "$state_file" '.viewer')
published_head=$(jq -er '.published_head // empty | select(type == "string" and length > 0)' "$state_file" 2>/dev/null || true)
if [ "$dry_run" = true ]; then
  expected_head=${published_head:-$(feedback_json_value "$state_file" '.remote_head_sha')}
else
  [ -n "$published_head" ] || feedback_die "Real reply posting requires published state. Use --dry-run with preparation state"
  expected_head=$published_head
fi
manifest_head=$(feedback_json_value "$manifest_file" '.expected_head')
[ "$manifest_head" = "$expected_head" ] || feedback_die "Reply manifest expected_head does not match the selected state head"
normalized=$(feedback_json_value "$state_file" '.artifacts.normalized')
[ -r "$normalized" ] || feedback_die "Normalized feedback is not readable: $normalized"
manifest_dir=$(dirname "$manifest_file")
if [ -z "$results_file" ]; then results_file="$(feedback_json_value "$state_file" '.workdir')/reply-results.json"; fi
results_file=$(feedback_absolute_path "$results_file")

verify_head() {
  local current
  current=$(gh pr view "$pr_number" --repo "$repo" --json state,headRefOid,headRefName,url)
  [ "$(jq -r '.state' <<<"$current")" = "OPEN" ] || feedback_die "PR #$pr_number is not open"
  [ "$(jq -r '.headRefOid' <<<"$current")" = "$expected_head" ] || feedback_die "GitHub PR head changed. Prepare feedback again before previewing or posting replies"
}
verify_head

if [ -e "$results_file" ]; then
  [ "$(jq -r '.version' "$results_file")" = "1" ] || feedback_die "Unsupported reply results version"
  [ "$(jq -r '.repo' "$results_file")" = "$repo" ] || feedback_die "Reply results belong to a different repository"
  [ "$(jq -r '.pr_number' "$results_file")" = "$pr_number" ] || feedback_die "Reply results belong to a different PR"
  [ "$(jq -r '.expected_head' "$results_file")" = "$expected_head" ] || feedback_die "Reply results belong to a different PR head"
else
  mkdir -p "$(dirname "$results_file")"
  jq -n --arg repo "$repo" --argjson pr_number "$pr_number" --arg expected_head "$expected_head" \
    '{version:1,repo:$repo,pr_number:$pr_number,expected_head:$expected_head,posted:[]}' > "$results_file"
fi

manifest_item() {
  jq -c --argjson index "$1" '.replies[$index]' "$manifest_file"
}
item_data() {
  local item_id="$1"
  local kind=${item_id%%:*}
  local value=${item_id#*:}
  case "$kind" in
    thread) jq -c --arg value "$value" 'first(.review_threads[]? | select(.thread_id == $value)) // empty' "$normalized" ;;
    issue-comment) jq -c --arg value "$value" 'first(.issue_comments[]? | select((.id | tostring) == $value)) // empty' "$normalized" ;;
    review) jq -c --arg value "$value" 'first(.reviews[]? | select((.id | tostring) == $value)) // empty' "$normalized" ;;
    *) feedback_die "Unsupported feedback item ID: $item_id" ;;
  esac
}

for ((index = 0; index < reply_count; index++)); do
  entry=$(manifest_item "$index")
  item_id=$(jq -er '.item_id' <<<"$entry")
  body_path=$(jq -er '.body_file' <<<"$entry")
  if [[ "$body_path" != /* ]]; then body_path="$manifest_dir/$body_path"; fi
  body_path=$(feedback_existing_path "$body_path")
  [ -r "$body_path" ] || feedback_die "Reply body is not readable: $body_path"
  data=$(item_data "$item_id")
  [ -n "$data" ] || feedback_die "Feedback item was not found: $item_id"
  if jq -e --arg id "$item_id" '.posted[]? | select(.item_id == $id)' "$results_file" >/dev/null; then
    printf 'SKIP_POSTED=%s\n' "$item_id"
    continue
  fi
  kind=${item_id%%:*}
  if [ "$kind" != "thread" ] && jq -e --arg id "$item_id" '.handled_item_ids | index($id)' "$normalized" >/dev/null; then
    printf 'SKIP_HANDLED=%s\n' "$item_id"
    continue
  fi
  if [ "$kind" = "thread" ] && [ "$(jq -r '.latest_author // empty' <<<"$data")" = "$viewer" ]; then
    printf 'SKIP_AWAITING_REVIEWER=%s\n' "$item_id"
    continue
  fi

  send_body=$(mktemp)
  temporary_body="$send_body"
  cat "$body_path" > "$send_body"
  endpoint=""
  case "$kind" in
    thread)
      root_comment=$(jq -er '.root_comment_id' <<<"$data")
      endpoint="repos/$repo/pulls/$pr_number/comments/$root_comment/replies"
      ;;
    issue-comment|review)
      marker="<!-- pi-feedback:handled $item_id -->"
      if ! grep -Fq "$marker" "$send_body"; then
        [ ! -s "$send_body" ] || printf '\n' >> "$send_body"
        printf '%s\n' "$marker" >> "$send_body"
      fi
      endpoint="repos/$repo/issues/$pr_number/comments"
      ;;
  esac

  if [ "$dry_run" = true ]; then
    printf 'DRY_RUN_ITEM=%s\n' "$item_id"
    printf 'ENDPOINT=%s\n' "$endpoint"
    printf '%s\n' "--- BODY $item_id ---"
    cat "$send_body"
    printf '%s\n' "--- END BODY $item_id ---"
    rm -f "$send_body"
    temporary_body=""
    continue
  fi

  verify_head
  response=$(jq -Rs '{body:.}' < "$send_body" | gh api -X POST "$endpoint" --input -)
  rm -f "$send_body"
  temporary_body=""
  url=$(jq -r '.html_url // .url // empty' <<<"$response")
  temporary=$(mktemp)
  jq --arg item_id "$item_id" --arg kind "$kind" --arg url "$url" \
    '.posted += [{item_id:$item_id,kind:$kind,url:(if $url == "" then null else $url end)}]' \
    "$results_file" > "$temporary"
  mv "$temporary" "$results_file"
  printf 'POSTED=%s\n' "$item_id"
  if [ -n "$url" ]; then printf 'URL=%s\n' "$url"; fi
done
printf 'RESULTS=%s\n' "$results_file"
