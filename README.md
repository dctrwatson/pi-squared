# π²

Repository for maintaining skills and extensions that I use with [Pi](https://buildwithpi.ai/)

## Skills

- [**create-pr**](skills/create-pr/SKILL.md) — Creates a GitHub pull request by analyzing branch changes, cleaning up `pi:` auto-commits into a polished commit, and following repo PR templates when available.

## Extensions

- [**gh-todo**](extensions/gh-todo/) — Manage GitHub issues labeled `pi-todo` as a todo list, with an interactive TUI and LLM tool for planning, tracking, and creating PRs.
- [**qa**](extensions/qa.ts) — Extracts questions from assistant responses and presents an interactive wizard for answering them.
- [**auto-commit**](extensions/auto-commit.ts) — Auto-commits after every interaction with AI-generated commit messages, and provides an `/undo` command to revert the last auto-commit.
