#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "$script_dir/lib.sh"

usage() {
  cat <<'EOF'
Usage: prepare-pr.sh [options]

Options:
  --mode draft|publish       Preparation intent. Default: draft.
  --base branch              Requested base branch.
  --pr-number number         Existing PR to update.
  --reference reference      GitHub issue or PR reference. Repeatable.
  --template selector        Template basename or path suffix.
  --workdir path             Artifact directory. Default: a temporary directory.
EOF
}

mode="draft"
base_arg=""
pr_number=""
template_selector=""
workdir=""
references=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    --mode)
      [ "$#" -ge 2 ] || { usage >&2; exit 1; }
      mode="$2"
      shift 2
      ;;
    --base)
      [ "$#" -ge 2 ] || { usage >&2; exit 1; }
      base_arg="$2"
      shift 2
      ;;
    --pr-number)
      [ "$#" -ge 2 ] || { usage >&2; exit 1; }
      pr_number="$2"
      shift 2
      ;;
    --reference)
      [ "$#" -ge 2 ] || { usage >&2; exit 1; }
      references+=("$2")
      shift 2
      ;;
    --template)
      [ "$#" -ge 2 ] || { usage >&2; exit 1; }
      template_selector="$2"
      shift 2
      ;;
    --workdir)
      [ "$#" -ge 2 ] || { usage >&2; exit 1; }
      workdir="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      pr_die "Unknown argument: $1"
      ;;
  esac
done

case "$mode" in
  draft|publish) ;;
  *) pr_die "Mode must be draft or publish" ;;
esac
[ "${#references[@]}" -le 20 ] || pr_die "At most 20 GitHub references are supported"
if [ -n "$pr_number" ] && [[ ! "$pr_number" =~ ^[0-9]+$ ]]; then
  pr_die "PR number must be numeric"
fi

for command in git gh jq mktemp; do pr_require_command "$command"; done
pr_require_repo
gh auth status >/dev/null 2>&1 || pr_die "gh is not authenticated. Run 'gh auth login' first"

root=$(git rev-parse --show-toplevel)
cd "$root"
branch=$(git branch --show-current)
[ -n "$branch" ] || pr_die "HEAD is detached. Check out a branch before preparing a PR"
if [ "$mode" = "publish" ]; then pr_require_clean_tree; fi

if [ -z "$workdir" ]; then
  workdir=$(mktemp -d "${TMPDIR:-/tmp}/create-pr-XXXXXX")
else
  mkdir -p "$workdir"
  workdir=$(pr_absolute_path "$workdir")
fi
mkdir -p "$workdir/templates" "$workdir/references"

repo_json=$(gh repo view --json nameWithOwner,defaultBranchRef,url)
repo=$(jq -er '.nameWithOwner' <<<"$repo_json")
default_branch=$(jq -er '.defaultBranchRef.name' <<<"$repo_json")
repo_url=$(jq -r '.url // empty' <<<"$repo_json")
[ -n "$repo_url" ] || repo_url="https://github.com/$repo"

pr_fields='number,title,url,state,baseRefName,headRefName,headRefOid,isDraft'
existing_pr='null'
if [ -n "$pr_number" ]; then
  existing_pr=$(gh pr view "$pr_number" --repo "$repo" --json "$pr_fields")
  [ "$(jq -r '.state' <<<"$existing_pr")" = "OPEN" ] || pr_die "PR #$pr_number is not open"
else
  open_prs=$(gh pr list --repo "$repo" --head "$branch" --state open --limit 10 --json "$pr_fields")
  open_count=$(jq 'length' <<<"$open_prs")
  if [ "$open_count" -gt 1 ]; then
    pr_die "Multiple open PRs use branch '$branch'. Retry with --pr-number"
  elif [ "$open_count" -eq 1 ]; then
    existing_pr=$(jq '.[0]' <<<"$open_prs")
  fi
fi

if [ "$existing_pr" != "null" ]; then
  existing_head=$(jq -r '.headRefName' <<<"$existing_pr")
  [ "$existing_head" = "$branch" ] || pr_die "Existing PR head '$existing_head' does not match current branch '$branch'"
  existing_base=$(jq -r '.baseRefName' <<<"$existing_pr")
  if [ -n "$base_arg" ] && [ "$base_arg" != "$existing_base" ]; then
    pr_die "Requested base '$base_arg' does not match existing PR base '$existing_base'"
  fi
  base="$existing_base"
else
  base="${base_arg:-$default_branch}"
fi
[ "$branch" != "$base" ] || pr_die "Current branch is the base branch '$base'"

base_ref="refs/remotes/origin/$base"
git fetch --quiet origin "+refs/heads/$base:$base_ref" || pr_die "Could not fetch base branch origin/$base"
base_sha=$(git rev-parse "$base_ref")
merge_base=$(git merge-base "$base_ref" HEAD) || pr_die "Cannot find a merge base with origin/$base"
head=$(git rev-parse HEAD)
[ "$merge_base" != "$head" ] || pr_die "No commits exist between origin/$base and HEAD"

remote_branch_sha=$(pr_remote_head origin "$branch")
remote_was_ancestor=false
if [ -n "$remote_branch_sha" ]; then
  git fetch --quiet origin "+refs/heads/$branch:refs/remotes/origin/$branch" || pr_die "Could not fetch origin/$branch"
  if git merge-base --is-ancestor "$remote_branch_sha" "$head"; then
    remote_was_ancestor=true
  fi
fi
if [ "$existing_pr" != "null" ]; then
  existing_head_oid=$(jq -er '.headRefOid' <<<"$existing_pr")
  [ "$remote_branch_sha" = "$existing_head_oid" ] || pr_die "Existing PR head does not match origin/$branch"
fi

status_file="$workdir/status.txt"
git status --short > "$status_file"
dirty=false
if [ -s "$status_file" ]; then dirty=true; fi

commits_file="$workdir/commits.json"
pr_write_commit_json "$merge_base..$head" "$repo_url" "$commits_file"
changed_files="$workdir/changed-files.txt"
diff_stat="$workdir/diff-stat.txt"
diff_file="$workdir/diff.patch"
git diff --name-only "$merge_base...$head" > "$changed_files"
git diff --stat "$merge_base...$head" > "$diff_stat"
git diff "$merge_base...$head" > "$diff_file"

recent_file="$workdir/recent-prs.json"
if ! gh pr list --repo "$repo" --state merged --limit 5 --json number,title,url > "$recent_file"; then
  printf '[]\n' > "$recent_file"
fi

is_template_path() {
  local candidate=${1,,}
  case "$candidate" in
    pull_request_template.md|pull_request_template|.github/pull_request_template.md|.github/pull_request_template|docs/pull_request_template.md|docs/pull_request_template)
      return 0
      ;;
    pull_request_template/*.md|pull_request_template/*.markdown|.github/pull_request_template/*.md|.github/pull_request_template/*.markdown|docs/pull_request_template/*.md|docs/pull_request_template/*.markdown)
      return 0
      ;;
  esac
  return 1
}

template_records=$(mktemp)
: > "$template_records"
template_index=0
while IFS= read -r template_path; do
  is_template_path "$template_path" || continue
  template_index=$((template_index + 1))
  artifact="$workdir/templates/$template_index-$(basename "$template_path")"
  git show "$base_ref:$template_path" > "$artifact"
  jq -cn --arg path "$template_path" --arg artifact "$artifact" '{path:$path,artifact:$artifact}' >> "$template_records"
done < <(git ls-tree -r --name-only "$base_ref")
templates_file="$workdir/templates.json"
jq -s '.' "$template_records" > "$templates_file"
rm -f "$template_records"

template_count=$(jq 'length' "$templates_file")
selected_template='null'
if [ -n "$template_selector" ]; then
  selected_template=$(jq --arg selector "$template_selector" '[.[] | select(.path == $selector or (.path | endswith("/" + $selector)) or (.path | endswith($selector)))]' "$templates_file")
  selected_count=$(jq 'length' <<<"$selected_template")
  [ "$selected_count" -gt 0 ] || pr_die "No PR template matched '$template_selector'"
  [ "$selected_count" -eq 1 ] || pr_die "Multiple PR templates matched '$template_selector'"
  selected_template=$(jq '.[0]' <<<"$selected_template")
elif [ "$template_count" -eq 1 ]; then
  selected_template=$(jq '.[0]' "$templates_file")
fi

reference_records=$(mktemp)
: > "$reference_records"
reference_index=0
for reference in "${references[@]}"; do
  reference_index=$((reference_index + 1))
  target_repo="$repo"
  target_number=""
  target_kind=""
  if [[ "$reference" =~ ^https://github\.com/([^/]+)/([^/]+)/(issues|pull)/([0-9]+) ]]; then
    target_repo="${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"
    target_number="${BASH_REMATCH[4]}"
    if [ "${BASH_REMATCH[3]}" = "pull" ]; then target_kind="pr"; else target_kind="issue"; fi
  elif [[ "$reference" =~ ^([^/[:space:]]+/[^#[:space:]]+)#([0-9]+)$ ]]; then
    target_repo="${BASH_REMATCH[1]}"
    target_number="${BASH_REMATCH[2]}"
  elif [[ "$reference" =~ ^#?([0-9]+)$ ]]; then
    target_number="${BASH_REMATCH[1]}"
  else
    pr_die "Unsupported GitHub reference: $reference"
  fi

  artifact="$workdir/references/$reference_index.json"
  if [ "$target_kind" = "pr" ]; then
    gh pr view "$target_number" --repo "$target_repo" --comments --json number,title,url,state,body,comments > "$artifact"
  elif [ "$target_kind" = "issue" ]; then
    gh issue view "$target_number" --repo "$target_repo" --comments --json number,title,url,state,body,comments > "$artifact"
  elif gh pr view "$target_number" --repo "$target_repo" --comments --json number,title,url,state,body,comments > "$artifact" 2>/dev/null; then
    target_kind="pr"
  else
    target_kind="issue"
    gh issue view "$target_number" --repo "$target_repo" --comments --json number,title,url,state,body,comments > "$artifact"
  fi
  canonical_number=$(jq -er '.number' "$artifact")
  title=$(jq -er '.title' "$artifact")
  url=$(jq -er '.url' "$artifact")
  if [ "$target_kind" = "pr" ] && [ "$target_repo" = "$repo" ]; then
    label="#$canonical_number"
  else
    label="$target_repo#$canonical_number"
  fi
  markdown="[$label]($url)"
  jq -cn \
    --arg input "$reference" \
    --arg kind "$target_kind" \
    --arg repo "$target_repo" \
    --argjson number "$canonical_number" \
    --arg title "$title" \
    --arg url "$url" \
    --arg markdown "$markdown" \
    --arg artifact "$artifact" \
    '{input:$input,kind:$kind,repo:$repo,number:$number,title:$title,url:$url,markdown:$markdown,artifact:$artifact}' >> "$reference_records"
done
references_file="$workdir/references.json"
jq -s '.' "$reference_records" > "$references_file"
rm -f "$reference_records"

state_file="$workdir/state.json"
jq -n \
  --argjson version 1 \
  --arg mode "$mode" \
  --arg root "$root" \
  --arg repo "$repo" \
  --arg repo_url "$repo_url" \
  --arg branch "$branch" \
  --arg head "$head" \
  --arg default_branch "$default_branch" \
  --arg base "$base" \
  --arg base_ref "$base_ref" \
  --arg base_sha "$base_sha" \
  --arg merge_base "$merge_base" \
  --arg remote_branch_sha "$remote_branch_sha" \
  --argjson remote_was_ancestor "$remote_was_ancestor" \
  --argjson dirty "$dirty" \
  --arg workdir "$workdir" \
  --arg commits_file "$commits_file" \
  --arg changed_files "$changed_files" \
  --arg diff_stat "$diff_stat" \
  --arg diff_file "$diff_file" \
  --arg recent_file "$recent_file" \
  --arg templates_file "$templates_file" \
  --arg references_file "$references_file" \
  --argjson existing_pr "$existing_pr" \
  --argjson selected_template "$selected_template" \
  '{
    version:$version, mode:$mode, root:$root, repo:$repo, repo_url:$repo_url,
    branch:$branch, head:$head, default_branch:$default_branch,
    base:$base, base_ref:$base_ref, base_sha:$base_sha, merge_base:$merge_base,
    remote_branch_sha:(if $remote_branch_sha == "" then null else $remote_branch_sha end),
    remote_was_ancestor:$remote_was_ancestor, dirty:$dirty, workdir:$workdir,
    existing_pr:$existing_pr, selected_template:$selected_template,
    artifacts:{commits:$commits_file,changed_files:$changed_files,diff_stat:$diff_stat,diff:$diff_file,recent_prs:$recent_file,templates:$templates_file,references:$references_file,status:$workdir + "/status.txt"}
  }' > "$state_file"

context_file="$workdir/context.md"
{
  echo '# Pull request preparation'
  echo
  printf -- '- Intent: `%s`\n' "$mode"
  printf -- '- Repository: `%s`\n' "$repo"
  printf -- '- Branch: `%s` at `%s`\n' "$branch" "${head:0:12}"
  printf -- '- Base: `%s` at `%s`\n' "$base" "${base_sha:0:12}"
  if [ "$existing_pr" != "null" ]; then
    existing_number=$(jq -r '.number' <<<"$existing_pr")
    existing_url=$(jq -r '.url' <<<"$existing_pr")
    printf -- '- Existing PR: [#%s](%s)\n' "$existing_number" "$existing_url"
  else
    echo '- Existing PR: none'
  fi
  if [ "$dirty" = true ]; then echo '- Working tree: dirty (see status artifact)'; else echo '- Working tree: clean'; fi
  if [ -n "$remote_branch_sha" ]; then
    printf -- '- Remote branch: `%s`\n' "${remote_branch_sha:0:12}"
  else
    echo '- Remote branch: not found'
  fi
  echo
  echo '## Commits'
  commit_count=$(jq 'length' "$commits_file")
  jq -r '.[0:20][] | "- " + .markdown + " " + .subject' "$commits_file"
  if [ "$commit_count" -gt 20 ]; then printf -- '- ... %s more commit(s); read `%s`\n' "$((commit_count - 20))" "$commits_file"; fi
  echo
  echo '## Recent PR titles'
  if [ "$(jq 'length' "$recent_file")" -eq 0 ]; then
    echo '- None'
  else
    jq -r '.[] | "- " + .title' "$recent_file"
  fi
  echo
  echo '## Templates'
  if [ "$template_count" -eq 0 ]; then
    echo '- None'
  else
    jq -r '.[0:20][] | "- `" + .path + "` -> `" + .artifact + "`"' "$templates_file"
    if [ "$template_count" -gt 20 ]; then printf -- '- ... %s more template(s); read `%s`\n' "$((template_count - 20))" "$templates_file"; fi
    if [ "$selected_template" = "null" ] && [ "$template_count" -gt 1 ]; then echo '- Select one template and rerun preparation with `--template`.'; fi
  fi
  echo
  echo '## References'
  if [ "$(jq 'length' "$references_file")" -eq 0 ]; then
    echo '- None'
  else
    jq -r '.[] | "- " + .markdown + " " + .title + " -> `" + .artifact + "`"' "$references_file"
  fi
  echo
  echo '## Artifacts'
  printf -- '- Diff stat: `%s`\n' "$diff_stat"
  printf -- '- Changed files: `%s`\n' "$changed_files"
  printf -- '- Full diff: `%s`\n' "$diff_file"
  printf -- '- State: `%s`\n' "$state_file"
} > "$context_file"

printf 'WORKDIR=%s\n' "$workdir"
printf 'STATE=%s\n' "$state_file"
printf 'CONTEXT=%s\n' "$context_file"
printf 'DIFF=%s\n' "$diff_file"
printf 'COMMITS=%s\n' "$commits_file"
printf 'REFERENCES=%s\n' "$references_file"
printf 'TEMPLATES=%s\n' "$templates_file"
