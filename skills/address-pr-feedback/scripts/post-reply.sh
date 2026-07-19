#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: post-reply.sh [--dry-run] [--repo owner/repo] <normalized-feedback.json> <item-id> <body-file>

- <item-id> is one of the ids produced by build-feedback-worklist.sh:
    thread:<graphql-node-id>       -> inline review comment reply
    issue-comment:<numeric-id>     -> general PR comment reply (new issue comment)
    review:<numeric-id>            -> reply to a review summary as a general PR comment
- <body-file> is a path to a file containing the reply body (Markdown). Use "-" for stdin.
- --dry-run prints the gh command(s) it would run and exits 0 without posting.
- --repo overrides repo detection; otherwise read it from normalized-feedback.json (.repo).
EOF
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: Missing required command: $1" >&2
    exit 1
  fi
}

dry_run=0
repo=""
normalized_json=""
item_id=""
body_arg=""
temp_body=""

cleanup() {
  if [ -n "$temp_body" ] && [ -e "$temp_body" ]; then
    rm -f "$temp_body"
  fi
}
trap cleanup EXIT

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)
      dry_run=1
      shift
      ;;
    --repo)
      repo="${2:-}"
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
      if [ -z "$normalized_json" ]; then
        normalized_json="$1"
      elif [ -z "$item_id" ]; then
        item_id="$1"
      elif [ -z "$body_arg" ]; then
        body_arg="$1"
      else
        echo "ERROR: Unexpected extra argument: $1" >&2
        usage >&2
        exit 1
      fi
      shift
      ;;
  esac
done

if [ -z "$normalized_json" ] || [ -z "$item_id" ] || [ -z "$body_arg" ]; then
  usage >&2
  exit 1
fi

require_cmd gh
require_cmd jq

if [ ! -r "$normalized_json" ]; then
  echo "ERROR: normalized feedback JSON is not readable: $normalized_json" >&2
  exit 1
fi

if [ "$body_arg" = "-" ]; then
  require_cmd mktemp
  temp_body=$(mktemp /tmp/post-reply-body-XXXXXX.md)
  cat > "$temp_body"
  body_file="$temp_body"
else
  body_file="$body_arg"
  if [ ! -r "$body_file" ]; then
    echo "ERROR: reply body file is not readable: $body_file" >&2
    exit 1
  fi
fi

if [ -z "$repo" ]; then
  repo=$(jq -r '.repo // empty' "$normalized_json")
fi
if [ -z "$repo" ] || [ "$repo" = "null" ]; then
  echo "ERROR: Could not resolve repo from --repo or .repo in $normalized_json" >&2
  exit 1
fi

pr_number=$(jq -r '.pr.number // empty' "$normalized_json")
if [ -z "$pr_number" ] || [ "$pr_number" = "null" ]; then
  echo "ERROR: Could not resolve PR number from .pr.number in $normalized_json" >&2
  exit 1
fi

owner=${repo%%/*}
repo_name=${repo#*/}
if [ -z "$owner" ] || [ -z "$repo_name" ] || [ "$owner" = "$repo_name" ]; then
  echo "ERROR: Repo must be in owner/repo form: $repo" >&2
  exit 1
fi

kind=${item_id%%:*}
item_value=${item_id#*:}
if [ "$kind" = "$item_id" ] || [ -z "$item_value" ]; then
  echo "ERROR: Item id must look like <kind>:<id>; got: $item_id" >&2
  exit 1
fi

print_dry_run() {
  printf 'DRY_RUN=1\n'
  printf 'KIND=%s\n' "$1"
  printf 'ITEM=%s\n' "$item_id"
  printf 'REPO=%s\n' "$repo"
  printf 'PR=%s\n' "$pr_number"
  printf 'BODY_FILE=%s\n' "$body_file"
  if [ -n "${2:-}" ]; then
    printf 'ENDPOINT=%s\n' "$2"
  fi
  if [ -n "${3:-}" ]; then
    printf 'COMMAND=%s\n' "$3"
  fi
}

case "$kind" in
  thread)
    root_comment_id=$(jq -r --arg id "$item_value" 'first(.review_threads[]? | select(.thread_id == $id) | .root_comment_id) // empty' "$normalized_json")
    if [ -z "$root_comment_id" ]; then
      echo "ERROR: Could not find thread item in $normalized_json: $item_id" >&2
      exit 1
    fi

    endpoint="POST /repos/$owner/$repo_name/pulls/$pr_number/comments/$root_comment_id/replies"
    if [ "$dry_run" -eq 1 ]; then
      print_dry_run "thread" "$endpoint" "gh api -X POST repos/$owner/$repo_name/pulls/$pr_number/comments/$root_comment_id/replies --input -"
      exit 0
    fi

    response=$(jq -Rs '{body: .}' < "$body_file" | gh api -X POST "repos/$owner/$repo_name/pulls/$pr_number/comments/$root_comment_id/replies" --input -)
    url=$(printf '%s' "$response" | jq -r '.html_url // .url // empty')
    printf 'POSTED=thread item=%s\n' "$item_id"
    printf 'URL=%s\n' "${url:-unknown}"
    ;;
  issue-comment)
    item_exists=$(jq -r --arg id "$item_value" 'first(.issue_comments[]? | select((.id | tostring) == $id) | .id) // empty' "$normalized_json")
    if [ -z "$item_exists" ]; then
      echo "ERROR: Could not find issue-comment item in $normalized_json: $item_id" >&2
      exit 1
    fi

    if [ "$dry_run" -eq 1 ]; then
      print_dry_run "issue-comment" "POST general PR comment" "gh pr comment $pr_number --repo $repo --body-file $body_file"
      exit 0
    fi

    comment_output=$(gh pr comment "$pr_number" --repo "$repo" --body-file "$body_file" 2>&1)
    url=$(printf '%s\n' "$comment_output" | grep -Eo 'https://[^[:space:]]+' | tail -n 1 || true)
    printf 'POSTED=issue-comment item=%s\n' "$item_id"
    printf 'URL=%s\n' "${url:-unknown}"
    ;;
  review)
    item_exists=$(jq -r --arg id "$item_value" 'first(.reviews[]? | select((.id | tostring) == $id) | .id) // empty' "$normalized_json")
    if [ -z "$item_exists" ]; then
      echo "ERROR: Could not find review item in $normalized_json: $item_id" >&2
      exit 1
    fi

    if [ "$dry_run" -eq 1 ]; then
      print_dry_run "review" "POST general PR comment" "gh pr comment $pr_number --repo $repo --body-file $body_file"
      exit 0
    fi

    comment_output=$(gh pr comment "$pr_number" --repo "$repo" --body-file "$body_file" 2>&1)
    url=$(printf '%s\n' "$comment_output" | grep -Eo 'https://[^[:space:]]+' | tail -n 1 || true)
    printf 'POSTED=review item=%s\n' "$item_id"
    printf 'URL=%s\n' "${url:-unknown}"
    ;;
  *)
    echo "ERROR: Unrecognized item kind prefix in $item_id" >&2
    exit 1
    ;;
esac
