#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "$script_dir/lib.sh"

usage() {
  cat <<'EOF'
Usage: publish-feedback-commits.sh --state state.json [--validated-head sha] [--output path]

The helper publishes new commits or a validated PR branch rewrite. A successful
automatic rebase does not push and requires validation before a later invocation.
EOF
}

state_file=""
validated_head=""
output_file=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --state)
      [ "$#" -ge 2 ] || { usage >&2; exit 1; }
      state_file="$2"
      shift 2
      ;;
    --validated-head)
      [ "$#" -ge 2 ] || { usage >&2; exit 1; }
      validated_head="$2"
      shift 2
      ;;
    --output)
      [ "$#" -ge 2 ] || { usage >&2; exit 1; }
      output_file="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *) feedback_die "Unknown argument: $1" ;;
  esac
done
[ -n "$state_file" ] || { usage >&2; exit 1; }
for command in git gh jq mktemp; do feedback_require_command "$command"; done
feedback_require_repo
feedback_require_clean_tree
gh auth status >/dev/null 2>&1 || feedback_die "gh is not authenticated. Run 'gh auth login' first"

state_file=$(feedback_existing_path "$state_file")
[ "$(feedback_json_value "$state_file" '.mode')" = "execute" ] || feedback_die "Commit publication requires execute-mode state"
root=$(feedback_json_value "$state_file" '.root')
[ "$(git rev-parse --show-toplevel)" = "$root" ] || feedback_die "Prepared state belongs to a different repository"
cd "$root"
branch=$(feedback_json_value "$state_file" '.branch')
[ "$(git branch --show-current)" = "$branch" ] || feedback_die "Current branch does not match prepared branch '$branch'"
repo=$(feedback_json_value "$state_file" '.repo')
repo_url=$(feedback_json_value "$state_file" '.repo_url')
pr_number=$(feedback_json_value "$state_file" '.pr.number')
baseline=$(feedback_json_value "$state_file" '.remote_head_sha')
local_head=$(git rev-parse HEAD)
git cat-file -e "$baseline^{commit}" 2>/dev/null || feedback_die "Prepared PR head is not available locally"
history_rewritten=false
if ! git merge-base --is-ancestor "$baseline" "$local_head"; then history_rewritten=true; fi
rebase_in_progress=$(jq -r '.rebase_in_progress // false' "$state_file")
if [ "$rebase_in_progress" = "true" ] && [ "$history_rewritten" = true ]; then
  source_state=$(jq -r '.rebase_source_state // empty' "$state_file")
  feedback_die "The recorded rebase was aborted or replaced. Retry with the original preparation state: $source_state"
fi

current_remote=$(feedback_remote_head origin "$branch")
[ -n "$current_remote" ] || feedback_die "Remote branch origin/$branch does not exist"
git fetch --quiet origin "+refs/heads/$branch:refs/remotes/origin/$branch" || feedback_die "Could not fetch origin/$branch"
pr_now=$(gh pr view "$pr_number" --repo "$repo" --json number,state,baseRefName,headRefName,headRefOid,url)
[ "$(jq -r '.state' <<<"$pr_now")" = "OPEN" ] || feedback_die "PR #$pr_number is not open"
[ "$(jq -r '.headRefName' <<<"$pr_now")" = "$branch" ] || feedback_die "PR head branch changed"
[ "$(jq -r '.headRefOid' <<<"$pr_now")" = "$current_remote" ] || feedback_die "GitHub PR head does not match origin/$branch"
base_branch=$(feedback_json_value "$state_file" '.base_branch')
[ "$(jq -r '.baseRefName' <<<"$pr_now")" = "$base_branch" ] || feedback_die "PR base branch changed. Prepare feedback again"

publication_base="$baseline"
force_push=false
published_history_backup=""
already_published=false
if [ "$history_rewritten" = true ]; then
  [ "$current_remote" = "$baseline" ] || feedback_die "Remote PR head changed after preparation. Do not overwrite it with rebased history"
  base_ref="refs/remotes/origin/$base_branch"
  git fetch --quiet origin "+refs/heads/$base_branch:$base_ref" || feedback_die "Could not fetch origin/$base_branch"
  publication_base=$(git merge-base "$base_ref" "$local_head") || feedback_die "Cannot find a merge base with origin/$base_branch"
  [ "$publication_base" != "$local_head" ] || feedback_die "The rewritten branch has no commits for PR #$pr_number"
  published_history_backup="refs/address-pr-feedback/backups/published-$(date +%s)-$$"
  git update-ref "$published_history_backup" "$baseline"
  force_push=true
elif git rev-list --min-parents=2 "$baseline..$local_head" | grep -q .; then
  feedback_die "Merge commits exist in the new local range. Rewrite them manually"
elif [ "$current_remote" != "$baseline" ] && [ "$current_remote" = "$local_head" ]; then
  published_pi=$(git log "$baseline..$local_head" --format='%s' | grep '^pi:' || true)
  [ -z "$published_pi" ] || feedback_die "A pi: commit from the prepared local range is already published. Refusing to rewrite published commits"
  already_published=true
elif [ "$current_remote" != "$baseline" ]; then
  git merge-base --is-ancestor "$baseline" "$current_remote" || feedback_die "Remote PR history diverged from the prepared head. Prepare feedback again"
  common=$(git merge-base "$current_remote" "$local_head")
  if [ -z "$output_file" ]; then output_file="$(feedback_json_value "$state_file" '.workdir')/rebased-state.json"; fi
  output_file=$(feedback_absolute_path "$output_file")
  if [ "$local_head" = "$baseline" ]; then
    git merge --ff-only "$current_remote" >/dev/null
    rebased_head=$(git rev-parse HEAD)
  else
    [ "$common" = "$baseline" ] || feedback_die "Some prepared local commits are already published. Prepare feedback again"
    backup_ref="refs/address-pr-feedback/backups/$(date +%s)-$$"
    git update-ref "$backup_ref" "$local_head"
    jq \
      --arg baseline "$current_remote" \
      --arg local_head "$local_head" \
      --arg backup_ref "$backup_ref" \
      --arg source_state "$state_file" \
      '.remote_head_sha=$baseline | .pr.head_sha=$baseline | .local_head=$local_head | .validation_required=true | .rebased=true | .rebase_in_progress=true | .rebase_backup=$backup_ref | .rebase_source_state=$source_state' \
      "$state_file" > "$output_file"
    if ! GIT_SEQUENCE_EDITOR=: git rebase --onto "$current_remote" "$baseline"; then
      feedback_die "Rebase stopped for conflicts. Resolve clear conflicts and continue, or run 'git rebase --abort'. After continuation, retry with state $output_file. Backup: $backup_ref"
    fi
    rebased_head=$(git rev-parse HEAD)
  fi
  jq \
    --arg baseline "$current_remote" \
    --arg local_head "$rebased_head" \
    '.remote_head_sha=$baseline | .pr.head_sha=$baseline | .local_head=$local_head | .validation_required=true | .rebased=true | .rebase_in_progress=false' \
    "$state_file" > "$output_file"
  printf 'REBASED_LOCAL_COMMITS\n'
  printf 'HEAD=%s\n' "$rebased_head"
  printf 'STATE=%s\n' "$output_file"
  printf 'VALIDATION_REQUIRED=1\n'
  exit 0
fi

if git rev-list --min-parents=2 "$publication_base..$local_head" | grep -q .; then
  feedback_die "Merge commits exist in the publication range. Rewrite them manually"
fi
validation_required=$(jq -r '.validation_required // false' "$state_file")
if [ "$history_rewritten" = true ] || [ "$validation_required" = "true" ]; then
  [ -n "$validated_head" ] || feedback_die "Rebased commits require validation. Retry with --validated-head after tests pass"
  [ "$validated_head" = "$local_head" ] || feedback_die "--validated-head does not match current HEAD"
fi

mapfile -t before_commits < <(git rev-list --reverse "$publication_base..$local_head")
before_count=${#before_commits[@]}
before_tree=$(git rev-parse "$local_head^{tree}")
backup_ref=""
pi_count=0
for sha in "${before_commits[@]}"; do
  if [[ "$(git show -s --format='%s' "$sha")" == pi:* ]]; then pi_count=$((pi_count + 1)); fi
done
if [ "$already_published" = false ] && [ "$pi_count" -gt 0 ]; then
  backup_ref="refs/address-pr-feedback/backups/$(date +%s)-$$"
  git update-ref "$backup_ref" "$local_head"
  todo=$(mktemp)
  editor=$(mktemp)
  reword=$(mktemp)
  cleanup() { rm -f "$todo" "$editor" "$reword"; }
  trap cleanup EXIT
  cat > "$reword" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
subject=$(git show -s --format='%s' HEAD)
if [[ "$subject" != pi:* ]]; then exit 0; fi
clean=${subject#pi:}
clean=${clean# }
[ -n "$clean" ] || { echo 'ERROR: Removing pi: would leave an empty commit subject' >&2; exit 1; }
body=$(git show -s --format='%b' HEAD)
message=$(mktemp)
trap 'rm -f "$message"' EXIT
printf '%s\n' "$clean" > "$message"
if [ -n "$body" ]; then printf '\n%s\n' "$body" >> "$message"; fi
git commit --amend --file "$message" >/dev/null
EOF
  chmod +x "$reword"
  for sha in "${before_commits[@]}"; do
    printf 'pick %s\n' "$sha" >> "$todo"
    if [[ "$(git show -s --format='%s' "$sha")" == pi:* ]]; then
      printf 'exec %q\n' "$reword" >> "$todo"
    fi
  done
  cat > "$editor" <<EOF
#!/usr/bin/env bash
cat $(printf '%q' "$todo") > "\$1"
EOF
  chmod +x "$editor"
  if ! GIT_SEQUENCE_EDITOR="$editor" git rebase -i "$publication_base"; then
    feedback_die "Commit rewording failed. Resolve it or run 'git rebase --abort'. Backup: $backup_ref"
  fi
fi

head=$(git rev-parse HEAD)
mapfile -t after_commits < <(git rev-list --reverse "$publication_base..$head")
[ "${#after_commits[@]}" -eq "$before_count" ] || feedback_die "Commit count changed during prefix cleanup. Backup: $backup_ref"
[ "$(git rev-parse "$head^{tree}")" = "$before_tree" ] || feedback_die "Tree changed during prefix cleanup. Backup: $backup_ref"
remaining=$(git log "$publication_base..$head" --format='%s' | grep '^pi:' || true)
[ -z "$remaining" ] || feedback_die "pi: commits remain after cleanup. Backup: $backup_ref"

if [ "$already_published" = false ] && [ "$before_count" -gt 0 ]; then
  if [ "$force_push" = true ]; then
    git push "--force-with-lease=refs/heads/$branch:$baseline" -u origin "HEAD:refs/heads/$branch"
  else
    git push -u origin "HEAD:refs/heads/$branch"
  fi
fi
pushed_remote=$(feedback_remote_head origin "$branch")
[ "$pushed_remote" = "$head" ] || feedback_die "origin/$branch does not match the local feedback head after push"
pr_after=$(gh pr view "$pr_number" --repo "$repo" --json number,state,headRefName,headRefOid,url)
[ "$(jq -r '.headRefOid' <<<"$pr_after")" = "$head" ] || feedback_die "GitHub PR head does not match the pushed feedback head. Do not post replies"

if [ -z "$output_file" ]; then output_file="$(feedback_json_value "$state_file" '.workdir')/published-state.json"; fi
output_file=$(feedback_absolute_path "$output_file")
commits_file=$(mktemp)
feedback_write_commit_json "$publication_base..$head" "$repo_url" "$commits_file"
jq \
  --arg head "$head" \
  --arg publication_base "$publication_base" \
  --arg backup_ref "$backup_ref" \
  --arg published_history_backup "$published_history_backup" \
  --argjson history_rewritten "$history_rewritten" \
  --slurpfile commits "$commits_file" \
  '.local_head=$head | .published_head=$head | .publication_base_sha=$publication_base | .history_rewritten=$history_rewritten | .validation_required=false | .rebase_in_progress=false | .prefix_cleanup_backup=(if $backup_ref == "" then null else $backup_ref end) | .published_history_backup=(if $published_history_backup == "" then null else $published_history_backup end) | .published_commits=$commits[0]' \
  "$state_file" > "$output_file"
rm -f "$commits_file"
printf 'PUBLISHED_HEAD=%s\n' "$head"
printf 'STATE=%s\n' "$output_file"
printf 'PR=%s\n' "$(jq -r '"[#" + (.pr.number | tostring) + "](" + .pr.url + ")"' "$state_file")"
