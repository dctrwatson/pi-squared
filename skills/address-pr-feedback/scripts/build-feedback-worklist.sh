#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: build-feedback-worklist.sh [--json-out path] [--md-out path] normalized-feedback.json
EOF
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: Missing required command: $1" >&2
    exit 1
  fi
}

json_out=""
md_out=""
normalized_json=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --json-out)
      json_out="${2:-}"
      shift 2
      ;;
    --md-out)
      md_out="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      echo "ERROR: Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
    *)
      if [ -n "$normalized_json" ]; then
        echo "ERROR: Unexpected extra argument: $1" >&2
        usage >&2
        exit 1
      fi
      normalized_json="$1"
      shift
      ;;
  esac
done

if [ -z "$normalized_json" ]; then
  usage >&2
  exit 1
fi

require_cmd jq

if [ -z "$json_out" ]; then
  json_out="$(dirname "$normalized_json")/feedback-worklist.json"
fi
if [ -z "$md_out" ]; then
  md_out="$(dirname "$normalized_json")/feedback-worklist.md"
fi

jq '
  def clip($text):
    (($text // "") | gsub("\\s+"; " ")) as $clean
    | if ($clean | length) > 160 then ($clean[:159] + "…") else $clean end;

  def thread_item:
    . as $thread
    | ($thread.comments // []) as $comments
    | ($comments[-1] // {}) as $latest
    | {
        item_id: ("thread:" + ($thread.thread_id | tostring)),
        kind: "inline_thread",
        sort_bucket: (if $thread.status == "unresolved" then 0 else 1 end),
        status: ($thread.status // "unknown"),
        author: ($thread.root_author // "unknown"),
        path: $thread.path,
        line: ($thread.line // $thread.original_line),
        location: (($thread.path // "unknown-path") + ":" + (($thread.line // $thread.original_line // "?") | tostring)),
        comment_count: ($comments | length),
        participants: ($comments | map(.author) | map(select(. != null)) | unique),
        latest_author: ($latest.author // null),
        latest_at: ($latest.created_at // null),
        url: ($comments | map(.url) | map(select(. != null)) | .[0] // null),
        summary: clip($thread.root_body)
      };

  def issue_item:
    {
      item_id: ("issue-comment:" + (.id | tostring)),
      kind: "general_comment",
      sort_bucket: 3,
      status: "open",
      author: (.author // "unknown"),
      path: null,
      line: null,
      location: null,
      comment_count: 1,
      participants: ([.author] | map(select(. != null))),
      latest_author: (.author // null),
      latest_at: (.updated_at // .created_at // null),
      url: (.url // null),
      summary: clip(.body)
    };

  def review_item:
    {
      item_id: ("review:" + (.id | tostring)),
      kind: "review_summary",
      sort_bucket: (if ((.state // "") | ascii_downcase) == "changes_requested" then 2 else 4 end),
      status: ((.state // "COMMENTED") | ascii_downcase),
      author: (.author // "unknown"),
      path: null,
      line: null,
      location: null,
      comment_count: 1,
      participants: ([.author] | map(select(. != null))),
      latest_author: (.author // null),
      latest_at: (.submitted_at // null),
      url: (.url // null),
      summary: clip(.body)
    };

  . as $root
  | {
      repo: .repo,
      pr: .pr,
      counts: (.counts // {}),
      section_order: [
        "unresolved_inline_threads",
        "resolved_or_outdated_inline_threads",
        "change_request_reviews",
        "general_pr_comments",
        "other_review_summaries"
      ],
      sections: {
        unresolved_inline_threads: (($root.review_threads // []) | map(select(.status == "unresolved") | thread_item) | sort_by(.sort_bucket, .path // "", .line // -1, .latest_at // "", .item_id)),
        resolved_or_outdated_inline_threads: (($root.review_threads // []) | map(select(.status != "unresolved") | thread_item) | sort_by(.sort_bucket, .path // "", .line // -1, .latest_at // "", .item_id)),
        change_request_reviews: (($root.reviews // []) | map(select(((.state // "") | ascii_downcase) == "changes_requested") | review_item) | sort_by(.sort_bucket, .latest_at // "", .item_id)),
        general_pr_comments: (($root.issue_comments // []) | map(issue_item) | sort_by(.sort_bucket, .latest_at // "", .item_id)),
        other_review_summaries: (($root.reviews // []) | map(select(((.state // "") | ascii_downcase) != "changes_requested") | review_item) | sort_by(.sort_bucket, .latest_at // "", .item_id))
      }
    }
  | .all_items = [
      .sections.unresolved_inline_threads[],
      .sections.resolved_or_outdated_inline_threads[],
      .sections.change_request_reviews[],
      .sections.general_pr_comments[],
      .sections.other_review_summaries[]
    ]
' "$normalized_json" > "$json_out"

{
  jq -r '
    "# PR feedback worklist\n\n" +
    "- PR: #\(.pr.number) \(.pr.title)\n" +
    "- URL: \(.pr.url)\n\n" +
    "Use this as a planning worksheet. Decide for each item whether it is reply-only, a code change, or needs clarification.\n"
  ' "$json_out"

  while IFS='|' read -r key title; do
    echo
    echo "## $title"
    echo
    count=$(jq --arg key "$key" '.sections[$key] | length' "$json_out")
    if [ "$count" -eq 0 ]; then
      echo '_None._'
      continue
    fi
    jq -r --arg key "$key" '
      .sections[$key][] |
      "- [ ] `\(.item_id)`" +
      (if .location != null then " `\(.location)`" else "" end) +
      " by @\(.author // "unknown")" +
      (if .status != null then " [\(.status)]" else "" end) +
      "\n  - Summary: " + (if (.summary // "") == "" then "_No body_" else .summary end) +
      (if .comment_count != null then "\n  - Comment count: \(.comment_count)" else "" end) +
      (if (.participants | length) > 0 then "\n  - Participants: " + (.participants | map("@" + .) | join(", ")) else "" end) +
      (if (.latest_author != null or .latest_at != null) then "\n  - Latest activity: @\(.latest_author // "unknown") at \(.latest_at // "unknown")" else "" end) +
      (if .url != null then "\n  - URL: \(.url)" else "" end) +
      "\n  - Action: \n  - Notes: \n"
    ' "$json_out"
  done <<'EOF'
unresolved_inline_threads|Unresolved inline threads
resolved_or_outdated_inline_threads|Resolved or outdated inline threads
change_request_reviews|Review summaries with requested changes
general_pr_comments|General PR comments
other_review_summaries|Other review summaries
EOF
} > "$md_out"

printf 'JSON=%s\n' "$json_out"
printf 'MARKDOWN=%s\n' "$md_out"
printf 'ITEMS=%s\n' "$(jq '.all_items | length' "$json_out")"
