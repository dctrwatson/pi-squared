---
name: create-pr
description: Creates a GitHub pull request by summarizing the current branch's changes. Detects and follows repo-specific PR templates. Use when the user wants to create, draft, or open a PR.
---

# Create Pull Request

## 1. Gather context

Run the helper script (pass optional base branch as arg):

```bash
bash <skill_dir>/gather-context.sh [base_branch]
```

This outputs structured sections: BRANCHES, EXISTING PR, COMMITS, DIFF STAT, DIFF, PR TEMPLATE, and RECENT PR TITLES.

- If the script errors with "Current branch IS the base branch", stop and tell the user.
- If EXISTING PR is not "none", ask the user if they want to update the existing PR body instead.

## 2. Generate PR title and body

**Title:** Concise and descriptive. Match the convention from RECENT PR TITLES if one is apparent (e.g. `feat: ...`, `fix: ...`). Otherwise use a clear imperative sentence.

**Body — if a PR TEMPLATE was found:** Fill in each section from the template using the diff/commits. Keep checkboxes and required sections. Replace placeholder text with real content.

**Body — if no template:** Use this structure:

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
