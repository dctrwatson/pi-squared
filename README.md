# π²

Repository for maintaining skills and extensions that I use with [Pi](https://buildwithpi.ai/)

## Skills

- [**buildkite-pr-check-review**](skills/buildkite-pr-check-review/SKILL.md) — Investigates GitHub PR status checks that map to Buildkite builds/jobs, fetches Buildkite logs with the CLI, and summarizes failures.
- [**create-pr**](skills/create-pr/SKILL.md) — Creates or drafts a GitHub pull request from the current branch, analyzes changes, cleans up `pi:` auto-commits, and follows repo PR templates.

## Extensions

- [**qa**](extensions/qa.ts) — Extracts questions from assistant responses and presents an interactive wizard for answering them.
- [**auto-commit**](extensions/auto-commit.ts) — Auto-commits after every interaction with AI-generated commit messages, provides `/autocommit` or Ctrl+Alt+A to toggle it on/off, and `/undo` to revert the last auto-commit.
