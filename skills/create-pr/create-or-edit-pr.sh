#!/usr/bin/env bash
# Creates or updates a GitHub PR using files for title/body to avoid shell quoting issues.
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage:
  bash create-or-edit-pr.sh --base <base> --title-file <title_file> --body-file <body_file> [--draft]
  bash create-or-edit-pr.sh --pr-number <number> --title-file <title_file> --body-file <body_file>

Options:
  --base <base>            Base branch for PR creation.
  --pr-number <number>     Update an existing PR instead of creating one.
  --title-file <file>      File containing the PR title.
  --body-file <file>       File containing the PR body markdown.
  --draft                  Create the PR as a draft. Only valid with --base.
EOF
}

base=""
pr_number=""
title_file=""
body_file=""
draft=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --base)
      [ "$#" -ge 2 ] || { usage; exit 1; }
      base="$2"
      shift 2
      ;;
    --pr-number)
      [ "$#" -ge 2 ] || { usage; exit 1; }
      pr_number="$2"
      shift 2
      ;;
    --title-file)
      [ "$#" -ge 2 ] || { usage; exit 1; }
      title_file="$2"
      shift 2
      ;;
    --body-file)
      [ "$#" -ge 2 ] || { usage; exit 1; }
      body_file="$2"
      shift 2
      ;;
    --draft)
      draft=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if ! command -v git >/dev/null 2>&1; then
  echo "ERROR: git is required." >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "ERROR: GitHub CLI (gh) is required." >&2
  exit 1
fi

if ! git rev-parse --show-toplevel >/dev/null 2>&1; then
  echo "ERROR: Current directory is not a git repository." >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "ERROR: gh is not authenticated. Run 'gh auth login' first." >&2
  exit 1
fi

if [ -z "$title_file" ] || [ -z "$body_file" ]; then
  echo "ERROR: --title-file and --body-file are required." >&2
  usage
  exit 1
fi

if [ ! -f "$title_file" ]; then
  echo "ERROR: Title file not found: $title_file" >&2
  exit 1
fi

if [ ! -f "$body_file" ]; then
  echo "ERROR: Body file not found: $body_file" >&2
  exit 1
fi

if [ -n "$base" ] && [ -n "$pr_number" ]; then
  echo "ERROR: Use either --base (create) or --pr-number (edit), not both." >&2
  exit 1
fi

if [ -z "$base" ] && [ -z "$pr_number" ]; then
  echo "ERROR: One of --base or --pr-number is required." >&2
  exit 1
fi

if [ "$draft" -eq 1 ] && [ -n "$pr_number" ]; then
  echo "ERROR: --draft can only be used when creating a PR." >&2
  exit 1
fi

mapfile -t title_lines < "$title_file"
if [ "${#title_lines[@]}" -eq 0 ] || [ -z "${title_lines[0]}" ]; then
  echo "ERROR: Title file is empty." >&2
  exit 1
fi

if [ "${#title_lines[@]}" -gt 1 ]; then
  echo "ERROR: Title file must contain exactly one line." >&2
  exit 1
fi

title=${title_lines[0]%$'\r'}
if [ -z "$title" ]; then
  echo "ERROR: Title file is empty." >&2
  exit 1
fi

if [ -n "$pr_number" ]; then
  gh pr edit "$pr_number" --title "$title" --body-file "$body_file" >/dev/null
  url=$(gh pr view "$pr_number" --json url --jq '.url')
  number=$(gh pr view "$pr_number" --json number --jq '.number')
  echo "ACTION: updated"
  echo "NUMBER: $number"
  echo "URL: $url"
  exit 0
fi

create_args=(pr create --base "$base" --title "$title" --body-file "$body_file")
if [ "$draft" -eq 1 ]; then
  create_args+=(--draft)
fi

create_output=$(gh "${create_args[@]}")
url=$(printf '%s\n' "$create_output" | tail -n 1)
number=$(gh pr view "$url" --json number --jq '.number')

echo "ACTION: created"
echo "NUMBER: $number"
echo "URL: $url"
