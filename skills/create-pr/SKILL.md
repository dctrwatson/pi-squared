---
name: create-pr
description: Creates a GitHub pull request by summarizing the current branch's changes. Detects and follows repo-specific PR templates. Use when the user wants to create, draft, or open a PR.
---

# Create Pull Request

Create a GitHub PR for the current branch by analyzing changes and generating a summary. Follows repo PR templates when available.

## Prerequisites

- `gh` CLI must be installed and authenticated
- Current branch must have commits ahead of the base branch
- Branch must be pushed (or will be pushed automatically)

## Steps

### 1. Gather context

```bash
# Identify the current and default branch
git branch --show-current
gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name'
```

Store the default branch as the base. If the current branch IS the default branch, stop and tell the user.

### 2. Check if a PR already exists

```bash
gh pr view --json number,title,url 2>/dev/null
```

If a PR already exists, inform the user and ask whether they want to update the existing PR body instead.

### 3. Analyze changes

```bash
# Commit messages (for high-level intent)
git log <base>..HEAD --oneline

# Full diff (for detailed understanding)
git diff <base>...HEAD
```

If the diff is very large, also use `git diff <base>...HEAD --stat` for an overview and read the most important changed files individually.

### 4. Check for a PR template

Look for a PR template in this order:

1. `.github/PULL_REQUEST_TEMPLATE.md`
2. `.github/pull_request_template.md`
3. `PULL_REQUEST_TEMPLATE.md`
4. `pull_request_template.md`
5. `.github/PULL_REQUEST_TEMPLATE/` directory (if it exists, list files and let the user pick, or use the first one)

If a template is found, read it and use its structure. Fill in each section based on the changes. Keep any checkboxes or required sections. Remove placeholder/instruction text and replace it with actual content.

### 5. Generate the PR content

**If a template was found:** Fill in the template sections faithfully.

**If no template was found:** Use this default structure:

```
## Summary

<1-3 sentence high-level description of what this PR does and why>

## Changes

<Bulleted list of specific changes, grouped logically>

## Notes

<Any additional context: migration steps, breaking changes, testing notes, or "None">
```

**Guidelines for the summary:**
- Be concise but informative
- Lead with the "why", then the "what"
- Mention key files/areas changed if helpful
- Don't just repeat commit messages — synthesize them
- Call out breaking changes, new dependencies, or migration steps prominently

### 6. Generate the PR title

Create a concise, descriptive title. Follow conventional style if the repo's recent PRs use one:

```bash
gh pr list --state merged --limit 5 --json title --jq '.[].title'
```

Match the convention (e.g., `feat: ...`, `fix: ...`, imperative mood, etc.). If no convention is apparent, use a clear imperative sentence.

### 7. Push and create the PR

```bash
# Ensure branch is pushed
git push -u origin HEAD

# Create the PR (use --draft if the user asked for a draft)
gh pr create --base <base> --title "<title>" --body "<body>"
```

Show the user the PR URL when done.

## User arguments

- If the user specifies a base branch, use that instead of the default branch.
- If the user says "draft", add `--draft` to `gh pr create`.
- If the user provides extra context (e.g., "this fixes the login bug"), incorporate it into the summary.
