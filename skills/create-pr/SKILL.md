---
name: create-pr
description: Creates a GitHub pull request by summarizing the current branch's changes. Detects and follows repo-specific PR templates. Use when the user wants to create, draft, or open a PR.
---

# Create Pull Request

## 1. Gather context

Run both helper scripts (pass optional base branch as arg):

```bash
bash <skill_dir>/gather-context.sh [base_branch]
```

```bash
bash <skill_dir>/gather-diff.sh [base_branch]
```

The first script outputs: BRANCHES, EXISTING PR, COMMITS, and RECENT PR TITLES.
The second script outputs: DIFF STAT and DIFF. They are separate to avoid large diffs truncating the metadata.

- If the first script errors with "Current branch IS the base branch", stop and tell the user.
- If EXISTING PR is not "none", ask the user if they want to update the existing PR body instead.

## 2. Generate PR title and body

**Title:** Concise and descriptive. Match the convention from RECENT PR TITLES if one is apparent (e.g. `feat: ...`, `fix: ...`). Otherwise use a clear imperative sentence.

**Body:** First, check for a PR template by reading the first match from this list:

1. `.github/PULL_REQUEST_TEMPLATE.md`
2. `.github/pull_request_template.md`
3. `PULL_REQUEST_TEMPLATE.md`
4. `pull_request_template.md`
5. First `*.md` file in `.github/PULL_REQUEST_TEMPLATE/` directory

If a template file exists, read it and use it as the PR body structure. Copy the template exactly, then fill in each section with real content derived from the diff and commits. Keep all headings, checkboxes, and required sections intact.

Only if none of the above files exist, use this fallback structure:

```
## Summary
<1-3 sentences: why, then what>

## Changes
<Bulleted list of changes, grouped logically>

## Notes
<Migration steps, breaking changes, testing notes, or "None">
```

**Guidelines:** Be concise. Lead with "why". Synthesize commits, don't just list them. Call out breaking changes or new dependencies.

## 3. Push and create

```bash
git push -u origin HEAD
gh pr create --base <base> --title "<title>" --body "<body>"
```

Add `--draft` if the user requested a draft. If the user provided extra context, incorporate it into the summary. Show the PR URL when done.
