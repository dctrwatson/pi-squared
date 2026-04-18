#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: gather-pr-feedback.sh [--repo owner/repo] [--workdir path] [pr-selector]

Resolve a PR, fetch comments/reviews/threads with gh, normalize them with jq,
and write a workdir containing both raw payloads and readable summaries.
EOF
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: Missing required command: $1" >&2
    exit 1
  fi
}

repo=""
workdir=""
pr_selector=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo)
      repo="${2:-}"
      shift 2
      ;;
    --workdir)
      workdir="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      break
      ;;
    -*)
      echo "ERROR: Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
    *)
      if [ -n "$pr_selector" ]; then
        echo "ERROR: Unexpected extra argument: $1" >&2
        usage >&2
        exit 1
      fi
      pr_selector="$1"
      shift
      ;;
  esac
done

require_cmd gh
require_cmd jq
require_cmd mktemp
require_cmd git

gh auth status >/dev/null
git rev-parse --is-inside-work-tree >/dev/null

if [ -z "$repo" ]; then
  repo=$(gh repo view --json nameWithOwner -q .nameWithOwner)
fi

pr_fields='number,title,url,baseRefName,headRefName,reviewDecision,isDraft,author'
if [ -n "$pr_selector" ]; then
  gh pr view "$pr_selector" --repo "$repo" --json "$pr_fields" > /tmp/pr-feedback-pr.json.$$ 
else
  gh pr view --repo "$repo" --json "$pr_fields" > /tmp/pr-feedback-pr.json.$$ 
fi

pr_number=$(jq -r '.number' /tmp/pr-feedback-pr.json.$$)
owner=${repo%%/*}
repo_name=${repo#*/}

if [ -z "$workdir" ]; then
  workdir=$(mktemp -d /tmp/pr-feedback-XXXXXX)
else
  mkdir -p "$workdir"
fi

mv /tmp/pr-feedback-pr.json.$$ "$workdir/pr.json"

fetch_rest_array() {
  local endpoint="$1"
  local outfile="$2"
  gh api --paginate "$endpoint?per_page=100" | jq -s 'add // []' > "$outfile"
}

fetch_rest_array "repos/$repo/issues/$pr_number/comments" "$workdir/issue-comments.json"
fetch_rest_array "repos/$repo/pulls/$pr_number/reviews" "$workdir/reviews.json"
fetch_rest_array "repos/$repo/pulls/$pr_number/comments" "$workdir/review-comments.json"

graphql_query=$(cat <<'EOF'
query($owner: String!, $repo: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $endCursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          originalLine
          startLine
          originalStartLine
          diffSide
          startDiffSide
          comments(first: 100) {
            nodes {
              databaseId
              body
              createdAt
              publishedAt
              url
              author {
                login
              }
              replyTo {
                databaseId
              }
            }
          }
        }
      }
    }
  }
}
EOF
)

graphql_note=""
if gh api graphql --paginate \
  -f query="$graphql_query" \
  -F owner="$owner" \
  -F repo="$repo_name" \
  -F number="$pr_number" \
  > "$workdir/review-threads-pages.jsonl" 2> "$workdir/review-threads.stderr"; then
  jq -s '[.[].data.repository.pullRequest.reviewThreads.nodes[]?]' \
    "$workdir/review-threads-pages.jsonl" > "$workdir/review-threads.json"
else
  graphql_note=$(tr '\n' ' ' < "$workdir/review-threads.stderr" | sed 's/[[:space:]]\+/ /g; s/^ //; s/ $//')
  printf '[]\n' > "$workdir/review-threads.json"
fi

jq -n \
  --arg repo "$repo" \
  --arg graphql_note "$graphql_note" \
  --slurpfile pr "$workdir/pr.json" \
  --slurpfile issue_comments "$workdir/issue-comments.json" \
  --slurpfile reviews "$workdir/reviews.json" \
  --slurpfile review_comments "$workdir/review-comments.json" \
  --slurpfile review_threads "$workdir/review-threads.json" '
  def login_of($user):
    if ($user | type) == "object" then ($user.login // "unknown")
    elif ($user | type) == "string" then $user
    else "unknown"
    end;

  def review_root_id($by_id):
    if .in_reply_to_id == null then (.id | tostring)
    else (($by_id[(.in_reply_to_id | tostring)] // null) as $parent
      | if $parent == null then (.id | tostring) else ($parent | review_root_id($by_id)) end)
    end;

  def normalized_reviews:
    ($reviews[0] // [])
    | map({
        id,
        author: login_of(.user),
        state,
        body: (.body // ""),
        submitted_at,
        commit_id,
        url: (.html_url // .url)
      })
    | sort_by(.submitted_at // "", .id // 0);

  def normalized_issue_comments:
    ($issue_comments[0] // [])
    | map({
        id,
        author: login_of(.user),
        body: (.body // ""),
        created_at,
        updated_at,
        url: (.html_url // .url)
      })
    | sort_by(.created_at // "", .id // 0);

  def normalized_threads_from_graphql:
    ($review_threads[0] // [])
    | map(
        . as $thread
        | ((.comments.nodes // [])
          | map({
              id: .databaseId,
              reply_to_id: (.replyTo.databaseId // null),
              author: login_of(.author),
              body: (.body // ""),
              created_at: (.createdAt // .publishedAt),
              url
            })
          | sort_by(.created_at // "", .id // 0)) as $comments
        | ($comments | map(select(.reply_to_id == null)) | .[0] // ($comments[0] // {})) as $root
        | {
            thread_id: $thread.id,
            path: $thread.path,
            line: $thread.line,
            original_line: $thread.originalLine,
            start_line: $thread.startLine,
            original_start_line: $thread.originalStartLine,
            diff_side: $thread.diffSide,
            start_diff_side: $thread.startDiffSide,
            is_resolved: $thread.isResolved,
            is_outdated: $thread.isOutdated,
            status: (if $thread.isResolved then "resolved" elif $thread.isOutdated then "outdated" else "unresolved" end),
            root_comment_id: $root.id,
            root_author: ($root.author // "unknown"),
            root_body: ($root.body // ""),
            comments: $comments
          }
      )
    | sort_by(.path // "", .line // -1, .root_comment_id // 0);

  def normalized_threads_from_rest:
    ($review_comments[0] // []) as $all
    | ($all | map(select(.id != null) | {key: (.id | tostring), value: .}) | from_entries) as $by_id
    | reduce $all[] as $comment ({};
        ($comment | review_root_id($by_id)) as $root_id
        | .[$root_id] = ((.[$root_id] // []) + [$comment])
      )
    | to_entries
    | map(.value | sort_by(.created_at // "", .id // 0))
    | map(
        . as $comments
        | ($comments[0]) as $root
        | {
            thread_id: ("rest-" + (($root.id // "unknown") | tostring)),
            path: $root.path,
            line: ($root.line // $root.original_line),
            original_line: $root.original_line,
            start_line: $root.start_line,
            original_start_line: $root.original_start_line,
            diff_side: $root.side,
            start_diff_side: $root.start_side,
            is_resolved: null,
            is_outdated: null,
            status: "unknown",
            root_comment_id: $root.id,
            root_author: login_of($root.user),
            root_body: ($root.body // ""),
            comments: ($comments | map({
              id,
              reply_to_id: .in_reply_to_id,
              author: login_of(.user),
              body: (.body // ""),
              created_at,
              url: (.html_url // .url)
            }))
          }
      )
    | sort_by(.path // "", .line // -1, .root_comment_id // 0);

  ($pr[0]) as $pr_doc
  | (if (($review_threads[0] // []) | length) > 0 then normalized_threads_from_graphql else normalized_threads_from_rest end) as $normalized_threads
  | {
      repo: $repo,
      pr: $pr_doc,
      counts: {
        review_summaries: ((normalized_reviews) | length),
        general_pr_comments: ((normalized_issue_comments) | length),
        inline_review_threads: ($normalized_threads | length),
        unresolved_inline_threads: ($normalized_threads | map(select(.status == "unresolved")) | length),
        resolved_inline_threads: ($normalized_threads | map(select(.status == "resolved")) | length),
        outdated_inline_threads: ($normalized_threads | map(select(.status == "outdated")) | length)
      },
      graphql_review_threads_error: (if $graphql_note == "" then null else $graphql_note end),
      reviews: normalized_reviews,
      issue_comments: normalized_issue_comments,
      review_threads: $normalized_threads
    }
' > "$workdir/normalized-feedback.json"

summary_file="$workdir/feedback-summary.md"
{
  jq -r '
    def clip($text; $chars; $lines):
      ($text // "") as $raw
      | ($raw | split("\n") | .[:$lines] | join("\n")) as $truncated_lines
      | if ($raw | split("\n") | length) > $lines then ($truncated_lines + "\n… [truncated]")
        elif ($truncated_lines | length) > $chars then (($truncated_lines[:$chars]) + "… [truncated]")
        else $truncated_lines
        end;

    "# PR feedback summary\n\n" +
    "- PR: #\(.pr.number) \(.pr.title)\n" +
    "- URL: \(.pr.url)\n" +
    "- Base: `\(.pr.baseRefName)`\n" +
    "- Head: `\(.pr.headRefName)`\n" +
    "- Review decision: `\(.pr.reviewDecision)`\n" +
    "- Draft: `\(.pr.isDraft)`\n" +
    "- Review summaries: \(.counts.review_summaries)\n" +
    "- General PR comments: \(.counts.general_pr_comments)\n" +
    "- Inline review threads: \(.counts.inline_review_threads)\n" +
    "- Unresolved inline threads: \(.counts.unresolved_inline_threads)\n" +
    "- Resolved inline threads: \(.counts.resolved_inline_threads)\n" +
    "- Outdated inline threads: \(.counts.outdated_inline_threads)\n\n"
  ' "$workdir/normalized-feedback.json"

  echo '## Inline thread index'
  echo
  jq -r '
    def one_line($text): ($text // "") | gsub("\n"; " ") | if length > 160 then .[:159] + "…" else . end;
    if (.review_threads | length) == 0 then "_No inline review threads found._"
    else .review_threads[] | "- [\(.status)] `\(.path // "unknown-path"):\(.line // .original_line // "?")` by @\(.root_author // "unknown") — \((one_line(.root_body) | if . == "" then "_No body_" else . end))"
    end
  ' "$workdir/normalized-feedback.json"
  echo

  echo '## Review summaries'
  echo
  if [ "$(jq '.reviews | length' "$workdir/normalized-feedback.json")" -eq 0 ]; then
    echo '_No review summaries found._'
    echo
  else
    jq -r '
      .reviews[] |
      "### [\(.state)] @\(.author) — review \(.id)\n- Submitted: \(.submitted_at // "unknown")\n- URL: \(.url // "unknown")\n\n    \(((.body // "") | if . == "" then "_No body_" else . end) | gsub("\n"; "\n    "))\n"
    ' "$workdir/normalized-feedback.json"
  fi

  echo '## General PR comments'
  echo
  if [ "$(jq '.issue_comments | length' "$workdir/normalized-feedback.json")" -eq 0 ]; then
    echo '_No general PR comments found._'
    echo
  else
    jq -r '
      .issue_comments[] |
      "### Comment \(.id) by @\(.author)\n- Created: \(.created_at // "unknown")\n- URL: \(.url // "unknown")\n\n    \(((.body // "") | if . == "" then "_No body_" else . end) | gsub("\n"; "\n    "))\n"
    ' "$workdir/normalized-feedback.json"
  fi

  echo '## Inline review threads'
  echo
  if [ "$(jq '.review_threads | length' "$workdir/normalized-feedback.json")" -eq 0 ]; then
    echo '_No inline review threads found._'
    echo
  else
    jq -r '
      .review_threads[] |
      "### Thread: `\(.path // "unknown-path"):\(.line // .original_line // "?")` [\(.status)]\n- Thread id: \(.thread_id)\n- Resolved: \(.is_resolved)\n- Outdated: \(.is_outdated)\n\n" +
      ((.comments // []) | map(
        "- Comment \(.id) by @\(.author // "unknown") at \(.created_at // "unknown")" +
        (if .reply_to_id != null then "\n  - Reply to: \(.reply_to_id)" else "" end) +
        (if .url != null then "\n  - URL: \(.url)" else "" end) +
        "\n  " + (((.body // "") | if . == "" then "_No body_" else . end) | gsub("\n"; "\n  ")) + "\n"
      ) | join("\n"))
    ' "$workdir/normalized-feedback.json"
  fi
} > "$summary_file"

printf 'REPO=%s\n' "$repo"
printf 'PR=%s\n' "$pr_number"
printf 'WORKDIR=%s\n' "$workdir"
printf 'SUMMARY=%s\n' "$summary_file"
printf 'NORMALIZED_JSON=%s\n' "$workdir/normalized-feedback.json"
printf 'COUNTS=general_comments:%s review_summaries:%s inline_threads:%s unresolved_threads:%s\n' \
  "$(jq -r '.counts.general_pr_comments' "$workdir/normalized-feedback.json")" \
  "$(jq -r '.counts.review_summaries' "$workdir/normalized-feedback.json")" \
  "$(jq -r '.counts.inline_review_threads' "$workdir/normalized-feedback.json")" \
  "$(jq -r '.counts.unresolved_inline_threads' "$workdir/normalized-feedback.json")"
if [ -n "$graphql_note" ]; then
  printf 'NOTE=GraphQL review thread lookup failed; used REST comment grouping instead: %s\n' "$graphql_note"
fi
