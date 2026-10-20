---
name: publish-pr
description: Create a GitHub PR, publish changes to an existing PR branch, update its title or body, or draft PR text. Use for requests such as "do this work and update the PR branch". Branch updates leave PR text and metadata unchanged unless requested.
compatibility: Requires Bash 5.3+, git, jq, GitHub CLI (`gh`), and a same-repository GitHub checkout on macOS or Linux.
---

# Publish Pull Request

## Choose the action

| Request | Preparation mode | Publication action |
|---|---|---|
| Create a PR | `publish` | `--create [--draft]` |
| Publish code to an existing PR | `push` | `--push-only <number>` |
| Change PR title or body on GitHub | `edit` | `--edit <number>` |
| Publish code and change PR text | `publish` | `--update <number>` |
| Draft text without publication | `draft` | None |

An existing PR is not permission to push. A code update does not authorize text or metadata edits. A text-only update does not authorize a push or commit rewrite. Ask only when the requested action is unclear. Never use direct `git push`; use the helper below.

## Prepare

Complete requested code changes, validation, and local `pi:` commits first. Then run:

```bash
bash <skill_dir>/scripts/prepare-pr.sh --mode <mode> [options]
```

Pass explicit PR numbers, bases, references, and template selectors. Read the returned `context.md` first; read focused artifacts only as needed. `push` skips templates and recent PR titles. `edit` skips branch diffs and permits local changes. Use the existing PR's actual base. For rebases, templates, commit plans, and recovery, read [references/workflow.md](references/workflow.md).

## Clean commits for a push

Skip this step for `draft` and `edit`. Plan coherent review units from the prepared commits and diff. Combine related `pi:` checkpoints, not independent changes. Preserve clean commits. Use final messages without `pi:`. Write the plan and message files, then run:

```bash
bash <skill_dir>/scripts/apply-commit-plan.sh <state.json> <plan.json>
```

Split mixed checkpoints with explicit staging, then prepare again. Complete and validate intentional rebases before planning. Do not create another checkpoint after publication unless there are new changes.

## Write text only when requested

Load `writing-style` when available. Use verified context, concise reviewer-focused prose, required template text, and full GitHub Markdown links. Draft only the requested fields; preserve all others. Read the writing guidance in the reference. For draft-only work, return the text and stop.

## Publish

Use the state returned by commit cleanup for a push, or preparation state for `edit`:

```bash
bash <skill_dir>/scripts/publish-pr.sh --state <state.json> <action> [--title-file <file>] [--body-file <file>]
```

Creation requires both files. Text updates require at least one. Branch-only publication accepts neither text nor metadata options. The helper rejects stale state and outgoing `pi:` commits. History rewrites use an exact force-with-lease, never plain `--force`. Do not bypass a refusal; prepare again.

After creation, call `workspace_link_pr` with the returned URL when the tool and URL are available. If linking fails, report it; do not repeat PR creation.

Return the linked PR and new commit links. State when PR text was left unchanged. Mention validation only for failures, omissions, or material risk. Keep the response concise.
