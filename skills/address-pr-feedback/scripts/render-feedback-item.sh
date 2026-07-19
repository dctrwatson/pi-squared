#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: render-feedback-item.sh [--kind thread|issue-comment|review] [--unresolved] normalized-feedback.json [item-id...]
EOF
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: Missing required command: $1" >&2
    exit 1
  fi
}

kind=""
unresolved_only=0
normalized_json=""
item_ids=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    --kind)
      kind="${2:-}"
      shift 2
      ;;
    --unresolved)
      unresolved_only=1
      shift
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
      if [ -z "$normalized_json" ]; then
        normalized_json="$1"
      else
        item_ids+=("$1")
      fi
      shift
      ;;
  esac
done

if [ -z "$normalized_json" ]; then
  usage >&2
  exit 1
fi

case "$kind" in
  ""|thread|inline_thread|issue-comment|issue|comment|review|review_summary)
    ;;
  *)
    echo "ERROR: Unsupported --kind value: $kind" >&2
    exit 1
    ;;
esac

require_cmd jq

requested_json='[]'
if [ "${#item_ids[@]}" -gt 0 ]; then
  requested_json=$(printf '%s\n' "${item_ids[@]}" | jq -Rsc 'split("\n") | map(select(length > 0))')
fi

jq -r \
  --arg kind "$kind" \
  --argjson requested "$requested_json" \
  --argjson unresolved "$unresolved_only" '
  def kind_alias($raw):
    if $raw == "" then ""
    elif ($raw == "thread" or $raw == "inline_thread") then "thread"
    elif ($raw == "issue" or $raw == "issue-comment" or $raw == "comment") then "issue-comment"
    elif ($raw == "review" or $raw == "review_summary") then "review"
    else $raw
    end;

  def parse_item_id($raw):
    ($raw | capture("^(?<kind>[^:]+):(?<value>.+)$")) as $parts
    | {kind: kind_alias($parts.kind), value: $parts.value};

  def all_items:
    [
      (.review_threads // [] | map({id: ("thread:" + (.thread_id | tostring)), kind: "thread", data: .})[]),
      (.issue_comments // [] | map({id: ("issue-comment:" + (.id | tostring)), kind: "issue-comment", data: .})[]),
      (.reviews // [] | map({id: ("review:" + (.id | tostring)), kind: "review", data: .})[])
    ];

  def chosen_items:
    all_items as $all
    | if ($requested | length) == 0 then $all
      else ($requested | map(parse_item_id(.)) ) as $want
      | [
          $want[] as $target
          | ($all[] | select(.kind == $target.kind and (.id | endswith(":" + $target.value))))
        ]
      end
    | if (kind_alias($kind)) == "" then . else map(select(.kind == kind_alias($kind))) end
    | if $unresolved == 1 then map(select(.kind != "thread" or .data.status == "unresolved")) else . end;

  def render_thread($item):
    "## \($item.id)\n\n" +
    "- Kind: inline thread\n" +
    "- Status: \($item.data.status)\n" +
    "- Location: `\($item.data.path // "unknown-path"):\($item.data.line // $item.data.original_line // "?")`\n" +
    "- Thread id: \($item.data.thread_id)\n" +
    "- Resolved: \($item.data.is_resolved)\n" +
    "- Outdated: \($item.data.is_outdated)\n\n" +
    "### Conversation\n\n" +
    (($item.data.comments // []) | map(
      "- Comment \(.id) by @\(.author // "unknown") at \(.created_at // "unknown")" +
      (if .reply_to_id != null then "\n  - Reply to: \(.reply_to_id)" else "" end) +
      (if .url != null then "\n  - URL: \(.url)" else "" end) +
      "\n  " + (((.body // "") | if . == "" then "_No body_" else . end) | gsub("\n"; "\n  ")) + "\n"
    ) | join("\n"));

  def render_issue($item):
    "## \($item.id)\n\n" +
    "- Kind: general PR comment\n" +
    "- Author: @\($item.data.author // "unknown")\n" +
    "- Created: \($item.data.created_at // "unknown")\n" +
    "- Updated: \($item.data.updated_at // "unknown")\n" +
    "- URL: \($item.data.url // "unknown")\n\n" +
    "### Body\n\n" +
    (($item.data.body // "") | if . == "" then "_No body_" else . end) + "\n";

  def render_review($item):
    "## \($item.id)\n\n" +
    "- Kind: review summary\n" +
    "- State: \($item.data.state // "unknown")\n" +
    "- Author: @\($item.data.author // "unknown")\n" +
    "- Submitted: \($item.data.submitted_at // "unknown")\n" +
    "- URL: \($item.data.url // "unknown")\n\n" +
    "### Body\n\n" +
    (($item.data.body // "") | if . == "" then "_No body_" else . end) + "\n";

  . as $root
  | (chosen_items) as $items
  | if ($items | length) == 0 then "No matching items."
    else "# Feedback item context\n\n- PR: #\($root.pr.number) \($root.pr.title)\n- URL: \($root.pr.url)\n\n" +
      ($items | map(
        if .kind == "thread" then render_thread(.)
        elif .kind == "issue-comment" then render_issue(.)
        else render_review(.)
        end
      ) | join("\n"))
    end
' "$normalized_json"
