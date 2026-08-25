#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "$script_dir/lib.sh"

usage() {
  echo "Usage: apply-commit-plan.sh <state.json> <plan.json> [output-state.json]" >&2
}

[ "$#" -ge 2 ] && [ "$#" -le 3 ] || { usage; exit 1; }
for command in git jq mktemp; do pr_require_command "$command"; done
pr_require_repo
pr_require_clean_tree

state_file=$(pr_canonical_existing_path "$1")
plan_file=$(pr_canonical_existing_path "$2")
root=$(pr_json_value "$state_file" '.root')
[ "$(git rev-parse --show-toplevel)" = "$root" ] || pr_die "Prepared state belongs to a different repository"
cd "$root"

mode=$(pr_json_value "$state_file" '.mode')
[ "$mode" = "publish" ] || pr_die "Commit plans require state prepared with --mode publish"
branch=$(pr_json_value "$state_file" '.branch')
[ "$(git branch --show-current)" = "$branch" ] || pr_die "Current branch does not match prepared branch '$branch'"
prepared_head=$(pr_json_value "$state_file" '.head')
[ "$(git rev-parse HEAD)" = "$prepared_head" ] || pr_die "HEAD changed after preparation. Prepare the PR again"
plan_head=$(pr_json_value "$plan_file" '.expected_head')
[ "$plan_head" = "$prepared_head" ] || pr_die "Commit plan expected_head does not match prepared HEAD"
[ "$(pr_json_value "$plan_file" '.version')" = "1" ] || pr_die "Unsupported commit plan version"

merge_base=$(pr_json_value "$state_file" '.merge_base')
current_merge_base=$(git merge-base "$(pr_json_value "$state_file" '.base_ref')" HEAD)
[ "$current_merge_base" = "$merge_base" ] || pr_die "Merge base changed after preparation. Prepare the PR again"
if git rev-list --min-parents=2 "$merge_base..HEAD" | grep -q .; then
  pr_die "Merge commits exist in the planned range. Rewrite them manually, then prepare again"
fi

mapfile -t commits < <(git rev-list --reverse "$merge_base..HEAD")
[ "${#commits[@]}" -gt 0 ] || pr_die "No branch commits exist"
declare -A position=()
declare -A subject=()
declare -A used=()
declare -A action=()
declare -A message_at_end=()
pi_commits=()
for index in "${!commits[@]}"; do
  hash=${commits[$index]}
  position["$hash"]=$index
  subject["$hash"]=$(git show -s --format='%s' "$hash")
  if [[ "${subject[$hash]}" == pi:* ]]; then pi_commits+=("$hash"); fi
done

group_count=$(jq '.groups | length' "$plan_file")
if [ "${#pi_commits[@]}" -eq 0 ]; then
  [ "$group_count" -eq 0 ] || pr_die "Plan has groups, but no pi: commits require cleanup"
else
  [ "$group_count" -gt 0 ] || pr_die "Plan must account for every pi: commit"
fi

last_group_end=-1
plan_dir=$(dirname "$plan_file")
for ((group_index = 0; group_index < group_count; group_index++)); do
  mapfile -t group_commits < <(jq -er ".groups[$group_index].commits[]" "$plan_file")
  [ "${#group_commits[@]}" -gt 0 ] || pr_die "Commit group $group_index is empty"
  message_file=$(jq -er ".groups[$group_index].message_file" "$plan_file")
  if [[ "$message_file" != /* ]]; then message_file="$plan_dir/$message_file"; fi
  message_file=$(pr_canonical_existing_path "$message_file")
  first_line=""
  IFS= read -r first_line < "$message_file" || true
  first_line=${first_line%$'\r'}
  [ -n "$first_line" ] || pr_die "Commit message for group $group_index is empty"
  [[ "$first_line" != pi:* ]] || pr_die "Commit message for group $group_index still starts with pi:"

  group_start=-1
  previous=-1
  for hash in "${group_commits[@]}"; do
    [ -n "${position[$hash]+set}" ] || pr_die "Group $group_index contains a commit outside the prepared range: $hash"
    [[ "${subject[$hash]}" == pi:* ]] || pr_die "Group $group_index contains unaffected clean commit $hash"
    [ -z "${used[$hash]+set}" ] || pr_die "Commit $hash appears in more than one group"
    current=${position[$hash]}
    if [ "$group_start" -lt 0 ]; then group_start=$current; fi
    if [ "$previous" -ge 0 ] && [ "$current" -ne $((previous + 1)) ]; then
      pr_die "Group $group_index is not contiguous"
    fi
    used["$hash"]=1
    previous=$current
  done
  [ "$group_start" -gt "$last_group_end" ] || pr_die "Commit groups overlap or are out of order"
  last_group_end=$previous

  for member_index in "${!group_commits[@]}"; do
    hash=${group_commits[$member_index]}
    if [ "$member_index" -eq 0 ]; then action["$hash"]="pick"; else action["$hash"]="fixup"; fi
  done
  message_at_end["${group_commits[-1]}"]="$message_file"
done

for hash in "${pi_commits[@]}"; do
  [ -n "${used[$hash]+set}" ] || pr_die "Plan does not account for pi: commit $hash"
done

output_state="${3:-$(pr_json_value "$state_file" '.workdir')/publish-state.json}"
output_directory=$(dirname "$output_state")
mkdir -p "$output_directory"
output_state=$(pr_absolute_path "$output_state")

if [ "${#pi_commits[@]}" -eq 0 ]; then
  jq '. + {prepared_head:.head,history_rewritten:false,requires_force:false,backup_ref:null}' "$state_file" > "$output_state"
  printf 'NO_REWRITE_NEEDED\n'
  printf 'STATE=%s\n' "$output_state"
  exit 0
fi

backup_ref="refs/create-pr/backups/$(date +%s)-$$"
git update-ref "$backup_ref" HEAD

todo_file=$(mktemp)
editor_script=$(mktemp)
cleanup() {
  rm -f "$todo_file" "$editor_script"
}
trap cleanup EXIT

for hash in "${commits[@]}"; do
  if [ -n "${action[$hash]+set}" ]; then
    printf '%s %s\n' "${action[$hash]}" "$hash" >> "$todo_file"
  else
    printf 'pick %s\n' "$hash" >> "$todo_file"
  fi
  if [ -n "${message_at_end[$hash]+set}" ]; then
    printf 'exec git commit --amend --file %q\n' "${message_at_end[$hash]}" >> "$todo_file"
  fi
done

cat > "$editor_script" <<EOF
#!/usr/bin/env bash
cat $(printf '%q' "$todo_file") > "\$1"
EOF
chmod +x "$editor_script"

if ! GIT_SEQUENCE_EDITOR="$editor_script" git rebase -i "$merge_base"; then
  pr_die "Commit-plan rebase failed. Resolve it or run 'git rebase --abort'. Backup: $backup_ref"
fi

new_head=$(git rev-parse HEAD)
remaining_pi=$(git log "$merge_base..HEAD" --format='%s' | grep '^pi:' || true)
[ -z "$remaining_pi" ] || pr_die "pi: commits remain after applying the plan. Backup: $backup_ref"

remote_branch_sha=$(jq -r '.remote_branch_sha // empty' "$state_file")
requires_force=false
if [ -n "$remote_branch_sha" ] && ! git merge-base --is-ancestor "$remote_branch_sha" "$new_head"; then
  requires_force=true
fi
jq \
  --arg prepared_head "$prepared_head" \
  --arg head "$new_head" \
  --arg backup_ref "$backup_ref" \
  --arg plan "$plan_file" \
  --argjson requires_force "$requires_force" \
  '. + {prepared_head:$prepared_head,head:$head,history_rewritten:true,requires_force:$requires_force,backup_ref:$backup_ref,commit_plan:$plan}' \
  "$state_file" > "$output_state"

printf 'REWROTE_COMMITS\n'
printf 'HEAD=%s\n' "$new_head"
printf 'BACKUP_REF=%s\n' "$backup_ref"
printf 'STATE=%s\n' "$output_state"
