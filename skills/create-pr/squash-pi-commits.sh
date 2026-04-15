#!/usr/bin/env bash
# Rewrites a single contiguous run of `pi:` auto-commits into one clean commit,
# preserving surrounding non-`pi:` commits. Expects a prepared commit message file.
set -euo pipefail

usage() {
  echo "Usage: bash squash-pi-commits.sh <base_branch> <commit_message_file>" >&2
}

if [ "$#" -ne 2 ]; then
  usage
  exit 1
fi

base="$1"
message_file_input="$2"

if [ ! -f "$message_file_input" ]; then
  echo "ERROR: Commit message file not found: $message_file_input" >&2
  exit 1
fi

message_file_dir=$(cd "$(dirname "$message_file_input")" && pwd)
message_file="$message_file_dir/$(basename "$message_file_input")"
message_file_escaped=$(printf '%q' "$message_file")

if [ -n "$(git status --porcelain)" ]; then
  echo "ERROR: Working tree is dirty. Commit or stash changes before rewriting history." >&2
  exit 1
fi

if ! git rev-parse --verify HEAD >/dev/null 2>&1; then
  echo "ERROR: Repository has no commits." >&2
  exit 1
fi

if ! git rev-parse --verify "$base" >/dev/null 2>&1; then
  echo "ERROR: Base ref not found: $base" >&2
  exit 1
fi

merge_base=$(git merge-base "$base" HEAD)
if [ -z "$merge_base" ]; then
  echo "ERROR: Could not determine merge base with $base." >&2
  exit 1
fi

head=$(git rev-parse HEAD)
if [ "$merge_base" = "$head" ]; then
  echo "ERROR: No branch commits to rewrite." >&2
  exit 1
fi

if git rev-list --min-parents=2 "$merge_base"..HEAD | grep -q .; then
  echo "ERROR: Merge commits detected in branch history. Clean up pi commits manually." >&2
  exit 1
fi

mapfile -t commits < <(git log --reverse --format='%H%x09%s' "$merge_base"..HEAD)

if [ "${#commits[@]}" -eq 0 ]; then
  echo "ERROR: No branch commits to rewrite." >&2
  exit 1
fi

pi_group_count=0
current_group_end=-1
selected_group_start=-1
selected_group_end=-1
in_pi_group=0

for i in "${!commits[@]}"; do
  subject=${commits[$i]#*$'\t'}

  if [[ "$subject" == pi:* ]]; then
    if [ "$in_pi_group" -eq 0 ]; then
      in_pi_group=1
      current_group_end=$i
      pi_group_count=$((pi_group_count + 1))
      if [ "$pi_group_count" -eq 1 ]; then
        selected_group_start=$i
      fi
    else
      current_group_end=$i
    fi
  else
    if [ "$in_pi_group" -eq 1 ]; then
      in_pi_group=0
      if [ "$pi_group_count" -eq 1 ]; then
        selected_group_end=$current_group_end
      fi
    fi
  fi
done

if [ "$in_pi_group" -eq 1 ] && [ "$pi_group_count" -eq 1 ]; then
  selected_group_end=$current_group_end
fi

if [ "$pi_group_count" -eq 0 ]; then
  echo "NO_PI_COMMITS"
  exit 0
fi

if [ "$pi_group_count" -gt 1 ]; then
  echo "ERROR: Multiple separate pi commit groups found. Clean up history manually to preserve non-pi commits." >&2
  exit 1
fi

if [ "$selected_group_start" -lt 0 ] || [ "$selected_group_end" -lt "$selected_group_start" ]; then
  echo "ERROR: Failed to determine pi commit group." >&2
  exit 1
fi

todo_file=$(mktemp)
editor_script=$(mktemp)
cleanup() {
  rm -f "$todo_file" "$editor_script"
}
trap cleanup EXIT

for i in "${!commits[@]}"; do
  hash=${commits[$i]%%$'\t'*}

  if [ "$i" -lt "$selected_group_start" ] || [ "$i" -gt "$selected_group_end" ]; then
    printf 'pick %s\n' "$hash" >> "$todo_file"
    continue
  fi

  if [ "$i" -eq "$selected_group_start" ]; then
    printf 'pick %s\n' "$hash" >> "$todo_file"
  else
    printf 'fixup %s\n' "$hash" >> "$todo_file"
  fi

  if [ "$i" -eq "$selected_group_end" ]; then
    printf 'exec git commit --amend --file %s\n' "$message_file_escaped" >> "$todo_file"
  fi
done

cat > "$editor_script" <<EOF
#!/usr/bin/env bash
cat "$todo_file" > "\$1"
EOF
chmod +x "$editor_script"

if ! GIT_SEQUENCE_EDITOR="$editor_script" git rebase -i "$merge_base"; then
  echo "ERROR: Failed to rewrite pi commits. Resolve the rebase manually or abort it with 'git rebase --abort'." >&2
  exit 1
fi

echo "REWROTE_PI_COMMITS"
branch=$(git branch --show-current)
if [ -n "$branch" ] && git show-ref --verify --quiet "refs/remotes/origin/$branch"; then
  echo "PUSH: git push --force-with-lease -u origin HEAD"
else
  echo "PUSH: git push -u origin HEAD"
fi
