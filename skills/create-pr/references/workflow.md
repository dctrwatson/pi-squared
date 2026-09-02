# Create PR workflow reference

## Preparation command

Use one preparation call for deterministic Git and GitHub reads:

```bash
bash <skill_dir>/scripts/prepare-pr.sh \
  --mode <draft|publish> \
  [--base <branch>] \
  [--pr-number <number>] \
  [--reference <issue-or-pr>]... \
  [--template <basename-or-path-suffix>]
```

The command prints paths to `context.md`, `state.json`, and on-demand artifacts. Read `context.md` first. Read the diff stat, changed-file list, individual file diffs, full diff, template, or reference artifacts only when needed. Do not paste a full diff into the conversation.

`draft` permits a dirty worktree because it does not authorize mutation. Its committed branch diff excludes worktree changes. `publish` requires a clean worktree and captures the local head, remote base, and remote branch state used by later safety checks.

An existing open PR supplies its actual base. Its GitHub head must be in the same repository and must match `origin/<branch>`. Fork PR layouts stop with an error. A conflicting `--base` is rejected. Multiple open PRs for one branch require `--pr-number`.

## Manual rebases and stacked pull requests

An authorized existing-PR update can include an intentional manual rebase or other history rewrite. If you rebase after preparation, use the prepared base and complete the rebase. If it stops for conflicts, inspect each conflict. When the intended result is clear, edit the files, run `git add <resolved-path>...`, and run `git rebase --continue`. Otherwise, run `git rebase --abort` and ask the user. Run the relevant validation, then prepare again before commit planning or publication.

For a stacked PR, use the existing PR's actual base. It is usually the parent branch. When the parent PR is squash merged, its commits are replaced by a new squash commit. Do not assume a rebase of the child onto `main` is clean or correct. Inspect the child diff and rebase or recreate only the required child commits. Resolve conflicts manually, then prepare again after the branch is complete.

## External writing

Before drafting a title, body, or other GitHub text, load and follow the `writing-style` skill when it is available.

For a typical PR body, use 40 to 120 words of original prose and at least two substantive sentences. Do not count required template boilerplate. Use short paragraphs. Use more text only when reviewers need extra scope, risk, migration, or rollout context. Do not add filler.

Use prepared issue or PR references, the user's request, and the session context to explain the motivation. Treat a reference as broader task context when its scope exceeds the current PR. Explain the part that this PR addresses, and do not imply full completion when follow-up PRs are necessary. Mention follow-up work only when it clarifies the current scope. Do not make the body only a summary of the diff.

Use the selected template without removing its required headings or checkboxes. Do not claim tests or work that did not occur. Keep required validation text to one short accurate line. Do not use bullets or prose to list commands, test tiers, or validation mechanics. Without a template, use:

```markdown
## Summary
<Motivation and outcome>

## Changes
<Logical reviewer-facing changes>

## Notes
<Tests, migration, risks, or "None">
```

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

The helper requires each group to contain contiguous `pi:` commits. It preserves clean commits between groups. It rejects missing checkpoints, overlap, reordering, clean commits in a group, merge commits, stale state, and final subjects that still start with `pi:`. It writes `publish-state.json` and a backup ref before rewriting.

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

Update the prepared existing PR:

```bash
bash <skill_dir>/scripts/publish-pr.sh \
  --state <publish-state.json> \
  --title-file <title-file> \
  --body-file <body-file> \
  --update <number>
```

`--reviewer`, `--label`, and `--assignee` are repeatable. The helper rechecks the worktree, branch, head, merge base, remote base, remote branch, and outgoing subjects before it pushes. It uses a normal push for a new or fast-forward branch. For a non-fast-forward existing-PR update, it uses exactly `--force-with-lease=refs/heads/<branch>:<captured-remote-PR-head>` only when preparation captured that exact PR head. It rejects a remote branch change and never uses plain `--force`. When no prepared existing-PR update is available, approved commit-plan cleanup requires its matching backup ref and remote-ancestor check before it uses the same lease.

The result contains ready-to-use PR and commit Markdown links. If `gh pr create` succeeds but returns no URL, the helper reports successful mutation with unavailable metadata instead of issuing a second mutation or reporting that creation failed.

## Authorization and retries

A request to create or update a PR authorizes only the push and GitHub mutation for that request. It does not authorize later pushes. A title/body-only request authorizes no mutation.

Any new commit, worktree change, base update, or remote branch update invalidates prepared state. Run preparation again. Never bypass a helper refusal with direct `git push`.
