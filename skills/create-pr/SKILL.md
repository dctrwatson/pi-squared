---
name: create-pr
description: Creates or updates a GitHub pull request from the current branch. Use when the user asks to open, draft, file, or update a PR, or to write a PR title/body based on the branch changes.
compatibility: Requires git, GitHub CLI (`gh`), push access to the repo, and a GitHub checkout.
---

# Create Pull Request

## 1. Gather context

This skill is for GitHub repos. If `git`/`gh` fails because the directory is not a GitHub checkout or `gh` is not authenticated, stop and tell the user what needs to be fixed.

Run the context script first (pass optional base branch as arg):

```bash
bash <skill_dir>/gather-context.sh [base_branch]
```

The script outputs: BRANCHES, EXISTING PR, COMMITS, and RECENT PR TITLES. Note the resolved `base:` value from BRANCHES, then pass it to the diff script to avoid a redundant API call:

```bash
bash <skill_dir>/gather-diff.sh <resolved_base>
```

The diff script outputs: DIFF STAT and DIFF. They are run separately to avoid large diffs truncating the metadata.

- If the diff is very large (truncated output), rely on DIFF STAT for an overview and inspect individual files with `git diff <base>...HEAD -- <path>`.

- If the first script errors with `Current branch IS the base branch` or `No commits between`, stop and tell the user.
- If the user did not specify a base branch and the branch appears to be stacked or targeted at a non-default base, confirm the base branch before continuing.
- If EXISTING PR is not `none`, ask whether they want to update that PR or create a new one from the same branch.

## 2. Generate PR title and body

**Title:** Concise and descriptive. Match the convention from RECENT PR TITLES if one is apparent (e.g. `feat: ...`, `fix: ...`). Otherwise use a clear imperative sentence. If commits share a common prefix/path (e.g. `vm-stack/eks: do something`), preserve it as a scope in the conventional commit format: `type(vm-stack/eks): do something`. Do NOT drop or rewrite the user's prefix.

**Body:** First, check for a PR template:

```bash
bash <skill_dir>/find-template.sh [template_name_or_path_suffix]
```

- If the script prints `MULTIPLE_TEMPLATES`, ask the user which template to use, then rerun the script with the chosen basename or path suffix.
- If a template is found, use it as the PR body structure. Copy the template exactly, then fill in each section with real content derived from the diff and commits. Keep all headings, checkboxes, and required sections intact.
- Preserve required sections and checkbox structure, but do not claim testing or follow-up work that did not actually happen. If the template includes instructional comments, remove or replace them in the final body.

Only if none of the above files exist, use this fallback structure:

```
## Summary
<1-3 sentences: why, then what>

## Changes
<Bulleted list of changes, grouped logically>

## Notes
<Migration steps, breaking changes, testing notes, or "None">
```

**Guidelines:** Be concise. Lead with "why". Synthesize commits, don't just list them. Call out breaking changes or new dependencies. If the user provided extra context, incorporate it into the summary and notes.

## 3. Clean up `pi:` auto-commits

If any commit subject in `COMMITS` starts with `pi:`, rewrite only the `pi:` commit run into one clean commit before pushing, while preserving non-`pi:` commits.

- Reuse the generated PR title as the cleaned-up commit subject.
- Write a short commit body (1 short paragraph or 2-4 bullets) that accurately summarizes the changes represented by the squashed `pi:` commit(s). Do **not** paste the PR template or checkbox lists into the commit message.
- Create a temporary commit message file and run:

```bash
tmp=$(mktemp)
cat > "$tmp" <<'COMMIT_MSG_EOF'
<title>

<commit summary>
COMMIT_MSG_EOF
bash <skill_dir>/squash-pi-commits.sh <base> "$tmp"
rm -f "$tmp"
```

- If the script prints `NO_PI_COMMITS`, leave the existing commit history alone.
- If the script prints `REWROTE_PI_COMMITS`, continue with the updated history.
- If the script errors because the working tree is dirty, stop and ask the user whether to commit or stash the extra changes first.
- If the script errors because there are multiple separate `pi:` commit groups or merge commits, stop and ask the user how they want to clean up the history; preserving non-`pi:` commits would require a more manual rewrite.
- If the script prints a `PUSH:` command, use that exact command in the next step.

## 4. Push and create or update

If step 3 did not print a `PUSH:` command, use:

```bash
git push -u origin HEAD
```

Use the helper script so title/body markdown is passed safely and the final output is structured.

Write the title and PR body to temporary files:

```bash
title_file=$(mktemp)
body_file=$(mktemp)
cat > "$title_file" <<'EOF'
<title>
EOF
cat > "$body_file" <<'EOF'
<body>
EOF
```

If the user chose to update an existing PR, run:

```bash
bash <skill_dir>/create-or-edit-pr.sh --pr-number <number> --title-file "$title_file" --body-file "$body_file"
```

Otherwise create the PR:

```bash
bash <skill_dir>/create-or-edit-pr.sh --base <base> --title-file "$title_file" --body-file "$body_file"
```

Add `--draft` only when creating a PR and the user requested a draft. Remove the temp files afterward. The helper prints `ACTION:`, `NUMBER:`, and `URL:` lines; show the PR URL to the user when done.

If the user requested reviewers, labels, or assignees, apply them after the PR is created or updated:

```bash
gh pr edit <number> --add-reviewer <users> --add-label <labels> --add-assignee <users>
```
