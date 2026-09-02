---
name: create-pr
description: Creates or updates a GitHub pull request from the current branch. Use when the user asks to open, draft, file, or update a PR, or to write a PR title or body from branch changes.
compatibility: Requires Bash 5.3+, git, jq, GitHub CLI (`gh`), push access for publication, and a GitHub checkout on macOS or Linux.
---

# Create Pull Request

Use this skill for GitHub PR preparation, creation, and updates. Follow [the workflow reference](references/workflow.md) for command options, commit-plan format, and recovery details.

## 1. Determine authority

Classify the request before mutation:

- **Draft only:** Write or revise a title or body. Do not rewrite commits, push, create a PR, or update a PR.
- **Publish:** Create or update a PR. This authorizes only the push and GitHub mutation needed for this request.

An existing PR is not standing permission for a later push. Never invoke `git push` directly. Every authorized push must use `scripts/publish-pr.sh`.

## 2. Prepare once

Run the deterministic preparation entry point. Pass all user-supplied GitHub references and any explicit base, PR number, or template selector.

```bash
bash <skill_dir>/scripts/prepare-pr.sh --mode <draft|publish> [options]
```

Read the returned `context.md` first. Read bounded artifacts only as needed. Do not load the full diff when the stat, changed paths, or focused file diffs are sufficient.

Use an existing PR's prepared base. If preparation finds an existing PR and the request does not clearly choose update or new creation, ask before continuing. If preparation reports multiple templates, ask the user to select one and rerun with `--template`.

An authorized update can include an intentional rebase or other history rewrite. Complete it before commit planning. Resolve conflicts when the intended result is clear. Abort and ask the user when it is ambiguous. Validate the rewritten `HEAD`, then prepare again.

## 3. Draft GitHub text

Before writing external GitHub text, load and follow the `writing-style` skill when it is available.

Write a concise reviewer-focused title and body. For a typical PR body, use 40 to 120 words of original prose and at least two substantive sentences. Do not count required template boilerplate. Use short paragraphs. Go beyond this range only when reviewers need more scope, risk, migration, or rollout context. Do not add filler to meet the target. Give reviewers enough context to understand why the change is needed, then explain its outcome, logical changes, and material risks. Derive the motivation from the user's request, session context, and relevant referenced issues or PRs. A reference can describe a broader task than this PR. State which part this PR addresses and do not imply that it completes the full task unless it does. Mention planned follow-up work only when it helps reviewers understand the scope. Preserve required template sections. For each GitHub PR, issue, comment, review, or commit reference, use a Markdown link with a full `https://github.com/owner/repo/...` URL from the preparation artifacts. Do not use bare shorthand such as `#123`, `owner/repo#123`, a relative link, or an unlinked commit SHA.

Keep validation text minimal. If a template requires it, use one short accurate line with the main result. Do not use bullets or prose to list commands, test tiers, or validation mechanics.

For a draft-only request, return the title and body now. Do not continue to commit cleanup or publication.

## 4. Create logical commits

For publication, inspect the prepared commits and diff. Plan one or more coherent review units. Do not squash all `pi:` checkpoints into one commit unless they represent one logical change.

Write the declarative plan and one commit-message file per group. Then run:

```bash
bash <skill_dir>/scripts/apply-commit-plan.sh <state.json> <plan.json>
```

The plan must account for every outgoing `pi:` commit and must preserve unaffected clean commits. If a checkpoint needs semantic patch splitting, perform that staging explicitly, create logical commits, and prepare again. Do not ask the helper to infer semantic boundaries.

## 5. Publish

Use the state returned by commit-plan application. Write the final title and body to files, then run exactly one publication action:

```bash
bash <skill_dir>/scripts/publish-pr.sh --state <publish-state.json> --title-file <file> --body-file <file> --create [--draft]
```

```bash
bash <skill_dir>/scripts/publish-pr.sh --state <publish-state.json> --title-file <file> --body-file <file> --update <number>
```

The helper refuses stale or unsafe state, verifies that no outgoing subject starts with `pi:`, pushes with the required lease protection, and creates or updates the PR. For a non-fast-forward existing-PR update, it uses exactly `--force-with-lease=refs/heads/<branch>:<captured-remote-PR-head>`, never plain `--force`. Do not bypass a refusal. If state changed, prepare again.

Return the PR and commit Markdown links with full GitHub URL targets. Mention validation only when it failed, was not run, or creates a material risk. Do not list routine validation. Keep the response concise.
