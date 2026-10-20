# Publish PR workflow reference

## Preparation command

Use one preparation call for deterministic Git and GitHub reads:

```bash
bash <skill_dir>/scripts/prepare-pr.sh \
  --mode <draft|publish|push|edit> \
  [--base <branch>] \
  [--pr-number <number>] \
  [--reference <issue-or-pr>]... \
  [--template <basename-or-path-suffix>]
```

The command prints paths to `context.md`, `state.json`, and on-demand artifacts. Read `context.md` first. Read the diff stat, changed-file list, individual file diffs, full diff, template, or reference artifacts only when needed. Do not paste a full diff into the conversation.

`draft` permits a dirty worktree and excludes worktree changes from its diff. `publish` requires a clean worktree and captures Git state for a push. `push` uses the same checks, requires an existing PR, and skips templates and recent PR titles. `edit` requires an existing PR, permits a dirty worktree, and does not require local branch commits. It captures current PR text without fetching branches or writing commit and diff artifacts.

An existing open PR supplies its actual base. Its head must use the same repository and local branch; fork layouts stop with an error. For a push, the GitHub head must match `origin/<branch>`. A conflicting `--base` is rejected. Multiple open PRs for one branch require `--pr-number`. If a text-writing mode finds multiple templates, select one with the user only when a template is needed for the requested body.

## Manual rebases and stacked pull requests

An authorized existing-PR update can include an intentional manual rebase or other history rewrite. If you rebase after preparation, use the prepared base and complete the rebase. If it stops for conflicts, inspect each conflict. When the intended result is clear, edit the files, run `git add <resolved-path>...`, and run `git rebase --continue`. Otherwise, run `git rebase --abort` and ask the user. Run the relevant validation, then prepare again before commit planning or publication.

For a stacked PR, use the existing PR's actual base. It is usually the parent branch. When the parent PR is squash merged, its commits are replaced by a new squash commit. Do not assume a rebase of the child onto `main` is clean or correct. Inspect the child diff and rebase or recreate only the required child commits. Resolve conflicts manually, then prepare again after the branch is complete.

## External writing

Before drafting a title, body, or other GitHub text, load and follow the `writing-style` skill when it is available.

For a typical PR body, use 40 to 120 words of original prose and at least two substantive sentences. Do not count required template boilerplate. Use short paragraphs. Use more text only when reviewers need extra scope, risk, migration, or rollout context. Do not add filler.

Use prepared issue or PR references, the user's request, and the session context to explain the motivation. Treat a reference as broader task context when its scope exceeds the current PR. Explain the part that this PR addresses, and do not imply full completion when follow-up PRs are necessary. Mention follow-up work only when it clarifies the current scope. Do not make the body only a summary of the diff.

Use the selected template without removing its required headings or checkboxes. Omit routine check results and statements about validation that was not done, unless the user or template requires them. If required, use one short accurate line. Do not list commands, test tiers, or validation mechanics. Do not claim tests or work that did not occur. Without a template, use:

```markdown
## Summary
<Motivation and outcome>

## Changes
<Logical reviewer-facing changes>

## Notes
<Migration or material risks>
```

Omit `## Notes` when there is no migration or material risk to explain.

For each GitHub PR, issue, comment, review, or commit reference, use a Markdown link with a full `https://github.com/owner/repo/...` URL from the preparation artifacts. Do not rely on bare `#123`, `owner/repo#123`, relative links, or unlinked commit SHAs. Use a closing keyword only when the user explicitly asks to close an issue.

## Logical commit plan

The agent decides semantic commit boundaries. Each commit must be a coherent review unit. Do not combine all checkpoints only because they belong to one PR.

The plan is JSON:

```json
{
  "version": 1,
  "expected_head": "<prepared HEAD>",
  "groups": [
    {
      "commits": ["<oldest checkpoint SHA>", "<next checkpoint SHA>"],
      "message_file": "commit-1.txt"
    },
    {
      "commits": ["<checkpoint SHA>"],
      "message_file": "commit-2.txt"
    }
  ]
}
```

Run:

```bash
bash <skill_dir>/scripts/apply-commit-plan.sh <state.json> <plan.json>
```

The helper accepts `publish` or `push` preparation state. Each group must contain contiguous `pi:` commits. It preserves clean commits between groups. It rejects missing checkpoints, overlap, reordering, clean commits in a group, merge commits, stale state, and final subjects that still start with `pi:`. It writes `publish-state.json` and a backup ref before rewriting.

If one checkpoint contains more than one semantic change, do not make the JSON plan simulate a split. Reconstruct the unpushed changes with normal Git staging, create the required logical commits, and run preparation again. A new preparation with no `pi:` commits accepts an empty `groups` array and validates the result without rewriting it.

## Publication command

Create a PR:

```bash
bash <skill_dir>/scripts/publish-pr.sh \
  --state <publish-state.json> \
  --title-file <title-file> \
  --body-file <body-file> \
  --create [--draft]
```

Creation stops before a push if preparation found an existing PR for the branch.

Publish code without changing PR text or metadata:

```bash
bash <skill_dir>/scripts/publish-pr.sh --state <publish-state.json> --push-only <number>
```

Change only requested PR text, without a push or commit rewrite:

```bash
bash <skill_dir>/scripts/publish-pr.sh --state <edit-state.json> --edit <number> \
  [--title-file <title-file>] [--body-file <body-file>]
```

For an explicit code-and-text update, use `--update <number>` with commit-plan state and one or both text files. Omitted fields stay unchanged. `--edit` and `--update` require at least one text file. `--push-only` rejects all text and metadata options. `--edit` rejects metadata options and checks the current PR identity, open state, head, base, and text against prepared state before editing; it does not check or change local history.

`--reviewer`, `--label`, and `--assignee` are repeatable for `--create` or `--update` only. Use them only when requested. Before a push, the helper rechecks the worktree, branch, head, merge base, remote base, remote branch, and outgoing subjects. It uses a normal push for a new or fast-forward branch. For a non-fast-forward existing-PR branch update, it uses exactly `--force-with-lease=refs/heads/<branch>:<captured-remote-PR-head>` only when preparation captured that exact PR head. It rejects a remote branch change and never uses plain `--force`. When no prepared existing-PR update is available, approved commit-plan cleanup requires its matching backup ref and remote-ancestor check before it uses the same lease.

The result contains ready-to-use PR and commit Markdown links. If `gh pr create` succeeds but returns no URL, the helper reports successful mutation with unavailable metadata instead of issuing a second mutation or reporting that creation failed.

## Authorization and retries

A create request authorizes its push and PR creation. A branch update authorizes its push, not PR text or metadata changes. An explicit GitHub text update authorizes only the requested edits, not a push or commit rewrite. A draft request authorizes no mutation. None is permission for later publication.

For a push, new commits, worktree changes, or base and remote branch updates invalidate prepared state. For a text-only edit, PR identity or text changes invalidate state; local edits do not. Prepare again after a refusal. Never bypass the helper with direct `git push`.
