#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "$script_dir/lib.sh"

usage() {
  cat <<'EOF'
Usage:
  publish-pr.sh --state file --create --title-file file --body-file file [options]
  publish-pr.sh --state file --push-only number
  publish-pr.sh --state file --edit number [--title-file file] [--body-file file]
  publish-pr.sh --state file --update number [--title-file file] [--body-file file] [options]

Options:
  --draft                 Create a draft PR.
  --reviewer login        Add a reviewer. Repeatable; create or update only.
  --label label           Add a label. Repeatable; create or update only.
  --assignee login        Add an assignee. Repeatable; create or update only.
EOF
}

state_file=""
title_file=""
body_file=""
action=""
update_number=""
draft=false
reviewers=()
labels=()
assignees=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    --state|--title-file|--body-file|--reviewer|--label|--assignee)
      [ "$#" -ge 2 ] || { usage >&2; exit 1; }
      case "$1" in
        --state) state_file="$2" ;;
        --title-file) title_file="$2" ;;
        --body-file) body_file="$2" ;;
        --reviewer) reviewers+=("$2") ;;
        --label) labels+=("$2") ;;
        --assignee) assignees+=("$2") ;;
      esac
      shift 2
      ;;
    --create)
      [ -z "$action" ] || pr_die "Use only one publication action"
      action="create"
      shift
      ;;
    --update|--push-only|--edit)
      [ "$#" -ge 2 ] || { usage >&2; exit 1; }
      [ -z "$action" ] || pr_die "Use only one publication action"
      action="${1#--}"
      update_number="$2"
      shift 2
      ;;
    --draft)
      draft=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *) pr_die "Unknown argument: $1" ;;
  esac
done

[ -n "$state_file" ] && [ -n "$action" ] || { usage >&2; exit 1; }
if [ "$action" != "create" ] && [[ ! "$update_number" =~ ^[0-9]+$ ]]; then pr_die "PR number must be numeric"; fi
if [ "$action" != "create" ] && [ "$draft" = true ]; then pr_die "--draft is valid only with --create"; fi
case "$action" in
  create) [ -n "$title_file" ] && [ -n "$body_file" ] || pr_die "Creation requires title and body files" ;;
  update|edit) [ -n "$title_file" ] || [ -n "$body_file" ] || pr_die "Text updates require a title or body file" ;;
  push-only) [ -z "$title_file" ] && [ -z "$body_file" ] || pr_die "--push-only does not accept title or body files" ;;
esac
if [ "$action" = "push-only" ] || [ "$action" = "edit" ]; then
  [ "${#reviewers[@]}" -eq 0 ] && [ "${#labels[@]}" -eq 0 ] && [ "${#assignees[@]}" -eq 0 ] || pr_die "--$action does not accept metadata options"
fi
for command in git gh jq; do pr_require_command "$command"; done
pr_require_repo
gh auth status >/dev/null 2>&1 || pr_die "gh is not authenticated. Run 'gh auth login' first"

state_file=$(pr_canonical_existing_path "$state_file")
title=""
if [ -n "$title_file" ]; then
  title_file=$(pr_canonical_existing_path "$title_file")
  title=$(pr_validate_title_file "$title_file")
fi
if [ -n "$body_file" ]; then
  body_file=$(pr_canonical_existing_path "$body_file")
  [ -r "$body_file" ] || pr_die "Body file is not readable: $body_file"
fi

mode=$(pr_json_value "$state_file" '.mode')
if [ "$action" = "edit" ]; then
  [ "$mode" = "edit" ] || pr_die "Text-only edits require state prepared with --mode edit"
else
  [ "$mode" = "publish" ] || { [ "$mode" = "push" ] && [ "$action" = "push-only" ]; } || pr_die "Publication requires state prepared with --mode publish or push"
  pr_require_clean_tree
fi
root=$(pr_json_value "$state_file" '.root')
[ "$(git rev-parse --show-toplevel)" = "$root" ] || pr_die "Prepared state belongs to a different repository"
cd "$root"
branch=$(pr_json_value "$state_file" '.branch')
[ "$(git branch --show-current)" = "$branch" ] || pr_die "Current branch does not match prepared branch '$branch'"
repo=$(pr_json_value "$state_file" '.repo')
repo_url=$(pr_json_value "$state_file" '.repo_url')
base=$(pr_json_value "$state_file" '.base')
existing_number=$(jq -r '.existing_pr.number // empty' "$state_file")
if [ "$action" = "create" ]; then
  [ -z "$existing_number" ] || pr_die "Prepared branch already has PR #$existing_number. Use an existing-PR action"
else
  [ -n "$existing_number" ] || pr_die "Prepared state does not contain an existing PR"
  [ "$existing_number" = "$update_number" ] || pr_die "Update PR #$update_number does not match prepared PR #$existing_number"
fi

merge_base=""
if [ "$action" = "edit" ]; then
  [ "$(gh repo view --json nameWithOwner | jq -er '.nameWithOwner')" = "$repo" ] || pr_die "Current GitHub repository does not match prepared state"
  current_pr=$(gh pr view "$update_number" --repo "$repo" --json number,state,baseRefName,headRefName,headRefOid,headRepository,isCrossRepository,title,body)
  jq -e --slurpfile prepared "$state_file" '
    . as $current | $prepared[0].existing_pr as $expected |
    $current.state == "OPEN" and ($current.isCrossRepository // false) == false and
    ([ $current.number, $current.baseRefName, $current.headRefName, $current.headRefOid, $current.headRepository.nameWithOwner, $current.title, $current.body ] ==
     [ $expected.number, $expected.baseRefName, $expected.headRefName, $expected.headRefOid, $expected.headRepository.nameWithOwner, $expected.title, $expected.body ])
  ' <<<"$current_pr" >/dev/null || pr_die "Existing PR changed. Prepare the PR again"
else
  expected_head=$(pr_json_value "$state_file" '.head')
  [ "$(git rev-parse HEAD)" = "$expected_head" ] || pr_die "HEAD changed after commit preparation. Prepare the PR again"
  base_sha=$(pr_json_value "$state_file" '.base_sha')
  remote_base_sha=$(pr_remote_head origin "$base")
  [ "$remote_base_sha" = "$base_sha" ] || pr_die "Remote base origin/$base changed. Prepare the PR again"
  base_ref=$(pr_json_value "$state_file" '.base_ref')
  merge_base=$(pr_json_value "$state_file" '.merge_base')
  [ "$(git merge-base "$base_ref" HEAD)" = "$merge_base" ] || pr_die "Merge base changed. Prepare the PR again"
  expected_remote_sha=$(jq -r '.remote_branch_sha // empty' "$state_file")
  current_remote_sha=$(pr_remote_head origin "$branch")
  [ "$current_remote_sha" = "$expected_remote_sha" ] || pr_die "Remote branch origin/$branch changed. Prepare the PR again"
  remaining_pi=$(git log "$merge_base..HEAD" --format='%s' | grep '^pi:' || true)
  [ -z "$remaining_pi" ] || pr_die "Outgoing pi: commits remain. Apply and validate a logical commit plan before publishing"
  if [ "$action" != "create" ]; then
    prepared_pr_head=$(jq -r '.existing_pr.headRefOid // empty' "$state_file")
    [ -n "$prepared_pr_head" ] && [ "$prepared_pr_head" = "$expected_remote_sha" ] || pr_die "Prepared PR head does not match the captured remote branch"
  fi

  push_args=(-u origin "HEAD:refs/heads/$branch")
  if [ -n "$expected_remote_sha" ] && ! git merge-base --is-ancestor "$expected_remote_sha" HEAD; then
    if [ "$action" = "create" ]; then
      history_rewritten=$(jq -r '.history_rewritten // false' "$state_file")
      prepared_head=$(jq -r '.prepared_head // empty' "$state_file")
      backup_ref=$(jq -r '.backup_ref // empty' "$state_file")
      [ "$history_rewritten" = true ] && [ -n "$prepared_head" ] && [ -n "$backup_ref" ] || pr_die "Branch is not a fast-forward and prepared state does not authorize published-history cleanup"
      [ "$(git rev-parse "$backup_ref" 2>/dev/null || true)" = "$prepared_head" ] || pr_die "Commit-plan backup ref is missing or does not match prepared history"
      git merge-base --is-ancestor "$expected_remote_sha" "$prepared_head" || pr_die "Remote branch was not an ancestor before commit-plan cleanup"
    fi
    push_args=("--force-with-lease=refs/heads/$branch:$expected_remote_sha" -u origin "HEAD:refs/heads/$branch")
  fi
  git push "${push_args[@]}"
fi

pr_url=""
result_number=""
metadata_available=true
if [ "$action" = "create" ]; then
  create_args=(pr create --repo "$repo" --base "$base" --head "$branch" --title "$title" --body-file "$body_file")
  if [ "$draft" = true ]; then create_args+=(--draft); fi
  for reviewer in "${reviewers[@]}"; do create_args+=(--reviewer "$reviewer"); done
  for label in "${labels[@]}"; do create_args+=(--label "$label"); done
  for assignee in "${assignees[@]}"; do create_args+=(--assignee "$assignee"); done
  create_output=$(gh "${create_args[@]}")
  pr_url=$(grep -Eo 'https://github\.com/[^[:space:]]+/pull/[0-9]+' <<<"$create_output" | tail -n 1 || true)
  if [ -n "$pr_url" ]; then result_number=${pr_url##*/}; else metadata_available=false; fi
else
  if [ "$action" != "push-only" ]; then
    edit_args=(pr edit "$update_number" --repo "$repo")
    if [ -n "$title_file" ]; then edit_args+=(--title "$title"); fi
    if [ -n "$body_file" ]; then edit_args+=(--body-file "$body_file"); fi
    for reviewer in "${reviewers[@]}"; do edit_args+=(--add-reviewer "$reviewer"); done
    for label in "${labels[@]}"; do edit_args+=(--add-label "$label"); done
    for assignee in "${assignees[@]}"; do edit_args+=(--add-assignee "$assignee"); done
    gh "${edit_args[@]}" >/dev/null
  fi
  result_number="$update_number"
  pr_url=$(jq -r '.existing_pr.url // empty' "$state_file")
  [ -n "$pr_url" ] || pr_url="$repo_url/pull/$update_number"
fi

if [ -n "$pr_url" ] && [ -n "$result_number" ]; then
  pr_markdown="[#$result_number]($pr_url)"
else
  pr_markdown="pull request metadata unavailable"
fi
workdir=$(pr_json_value "$state_file" '.workdir')
result_file="$workdir/publish-result.json"
commit_file=$(mktemp)
if [ "$action" = "edit" ]; then
  printf '[]\n' > "$commit_file"
  result_head=$(jq -r '.existing_pr.headRefOid' "$state_file")
else
  pr_write_commit_json "$merge_base..HEAD" "$repo_url" "$commit_file"
  result_head=$(git rev-parse HEAD)
fi
jq -n \
  --arg action "$action" \
  --arg number "$result_number" \
  --arg url "$pr_url" \
  --arg markdown "$pr_markdown" \
  --arg branch "$branch" \
  --arg head "$result_head" \
  --argjson metadata_available "$metadata_available" \
  --slurpfile commits "$commit_file" \
  '{action:$action,number:(if $number == "" then null else ($number | tonumber) end),url:(if $url == "" then null else $url end),markdown:$markdown,metadata_available:$metadata_available,branch:$branch,head:$head,commits:$commits[0]}' > "$result_file"
rm -f "$commit_file"

printf 'ACTION=%s\n' "$action"
printf 'PR=%s\n' "$pr_markdown"
printf 'RESULT=%s\n' "$result_file"
if [ "$metadata_available" = false ]; then
  echo 'NOTE=GitHub mutation succeeded, but gh returned no PR URL metadata.'
fi
