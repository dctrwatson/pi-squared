---
name: create-pr
description: Creates or updates a GitHub pull request from the current branch. Use when the user asks to open, draft, file, or update a PR, or to write a PR title/body based on the branch changes.
compatibility: Requires git, fd, GitHub CLI (`gh`), push access to the repo, and a GitHub checkout.
---

# Create Pull Request

## 1. Gather context

This skill is for GitHub repos. If `git`/`gh` fails because the directory is not a GitHub checkout or `gh` is not authenticated, stop and tell the user what needs to be fixed.

**Push authorization:** A request to create or update a PR authorizes only the push needed for that operation. An existing PR is not standing permission to push later follow-up work. For each later push the user requests, rerun this workflow.

**Hard invariant:** Never invoke `git push` directly in this workflow. Every PR branch push—including the initial push and later updates—must go through `push-pr-branch.sh`. Cleanup performed for an earlier push is stale as soon as another commit is created.

Run the context script first (pass optional base branch as arg):

```bash
bash <skill_dir>/gather-context.sh [base_branch]
```

The script outputs: BRANCHES, EXISTING PR, COMMITS, and RECENT PR TITLES. Note the resolved `base:` value from BRANCHES, then pass it to the diff script to avoid a redundant API call:

```bash
bash <skill_dir>/gather-diff.sh <resolved_base>
```

The diff script outputs: DIFF STAT and DIFF. They are run separately to avoid large diffs truncating the metadata.

- If the user provides a GitHub issue or PR reference, inspect it before drafting the body to gather its description and discussion, and resolve it to its full URL. Use `gh issue view <reference> --comments` or `gh pr view <reference> --comments` as appropriate; pass a full URL for a reference in another repository. Incorporate relevant context into the body.
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
<Why this is needed and what it changes; include enough context for reviewers>

## Changes
<Bulleted list of changes, grouped logically>

## Notes
<Migration steps, breaking changes, testing notes, or "None">
```

**Guidelines:**

- Write for a reviewer who has not read the diff: explain the motivation, outcome, and material changes to behavior, design, or operations.
- Let the complexity of the change determine the length instead of targeting a fixed sentence count. Include necessary context, but keep the body scannable; omit repetition, commit-by-commit narration, exhaustive code walkthroughs, and incidental implementation detail.
- Lead with "why" and synthesize commits rather than listing them. In the fallback structure, put motivation and outcome in **Summary**, grouped reviewer-relevant work in **Changes**, and actionable caveats, testing, or migration information in **Notes**.
- Call out breaking changes and new dependencies. Incorporate user-provided context when it helps explain the motivation, scope, or notes.
- When the user provides a GitHub issue or PR, always reference it with its full URL after `ref` (for example, `ref https://github.com/owner/repo/issues/123` or `ref https://github.com/owner/repo/pull/456`); never use `ref #<number>`. Use a closing keyword only when the user explicitly asks to close an issue.

## 3. Clean up `pi:` auto-commits and push

Run this step immediately before **every** authorized push. Always invoke the helper against the current `HEAD`; do not skip it based on the earlier `COMMITS` output or because cleanup ran before. The helper rewrites one contiguous `pi:` commit run into one clean commit, preserves surrounding non-`pi:` commits, verifies that no `pi:` subject remains, and only then pushes.

- Reuse the generated PR title as the cleaned-up commit subject.
- Write a short commit body (1 short paragraph or 2-4 bullets) that accurately summarizes the changes represented by the squashed `pi:` commit(s). Do **not** paste the PR template or checkbox lists into the commit message.
- Create a temporary commit message file and run the cleanup-and-push helper:

```bash
tmp=$(mktemp)
cat > "$tmp" <<'COMMIT_MSG_EOF'
<title>

<commit summary>
COMMIT_MSG_EOF
bash <skill_dir>/push-pr-branch.sh <base> "$tmp"
rm -f "$tmp"
```

- `NO_PI_COMMITS` means history was left unchanged and a normal push was used.
- `REWROTE_PI_COMMITS` means the helper cleaned the history and used `--force-with-lease` when the branch already existed on `origin`.
- If cleanup or its final verification fails, the helper does not push. Do not work around it with a direct `git push`.
- If the working tree is dirty, ask the user whether to commit or stash the extra changes first.
- If there are multiple separate `pi:` commit groups or merge commits, ask how the user wants to clean up the history; preserving non-`pi:` commits requires a more manual rewrite.
- If any new commit is created after this helper succeeds, its cleanup result no longer applies; use the helper again for the next user-authorized push.

## 4. Create or update

After step 3 successfully pushes, use the helper script so title/body markdown is passed safely and the final output is structured.

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
