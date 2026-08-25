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

An existing open PR supplies its actual base. Its GitHub head must match `origin/<branch>`. A conflicting `--base` is rejected. Multiple open PRs for one branch require `--pr-number`.

## External writing

Before drafting a title, body, or other GitHub text, load and follow the `writing-style` skill when it is available.

Use the selected template without removing its required headings or checkboxes. Do not claim tests or work that did not occur. Without a template, use:

```markdown
## Summary
<Motivation and outcome>

## Changes
<Logical reviewer-facing changes>

## Notes
<Tests, migration, risks, or "None">
```

Use explicit GitHub Markdown links from preparation artifacts. Use a closing keyword only when the user explicitly asks to close an issue.

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

`--reviewer`, `--label`, and `--assignee` are repeatable. The helper rechecks the worktree, branch, head, merge base, remote base, remote branch, and outgoing subjects before it pushes. It uses a normal push for a new or fast-forward branch. It uses an explicit force-with-lease only when the captured remote branch was an ancestor before the approved commit-plan rewrite.

The result contains ready-to-use PR and commit Markdown links. If `gh pr create` succeeds but returns no URL, the helper reports successful mutation with unavailable metadata instead of issuing a second mutation or reporting that creation failed.

## Authorization and retries

A request to create or update a PR authorizes only the push and GitHub mutation for that request. It does not authorize later pushes. A title/body-only request authorizes no mutation.

Any new commit, worktree change, base update, or remote branch update invalidates prepared state. Run preparation again. Never bypass a helper refusal with direct `git push`.
