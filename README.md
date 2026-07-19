# π²

Repository for maintaining skills and extensions that I use with [Pi](https://buildwithpi.ai/).

Requires Node.js 22.19.0 or newer.

## Skills

- [**address-pr-feedback**](skills/address-pr-feedback/SKILL.md) — Handles GitHub PR feedback end-to-end: reviews comments and inline threads, makes or plans the appropriate changes, and posts replies on GitHub.
- [**buildkite-pr-check-review**](skills/buildkite-pr-check-review/SKILL.md) — Investigates GitHub PR status checks that map to Buildkite builds/jobs, fetches Buildkite logs with the CLI, and summarizes failures.
- [**create-pr**](skills/create-pr/SKILL.md) — Creates or drafts a GitHub pull request from the current branch, analyzes changes, cleans up `pi:` auto-commits, and follows repo PR templates.

## Extensions

- [**qa**](extensions/qa.ts) — Extracts questions from assistant responses and presents an interactive wizard for answering them.
- [**bash-tool-interceptor**](extensions/bash-tool-interceptor/) — Prepends steering wrappers to the model Bash `PATH` so Python tooling uses `uv` without unsafe command rewrites.
- [**skill-loader**](extensions/skill-loader.ts) — `/skill-loader` interactively chooses skills from roots in `~/.pi/agent/skill-loader.json` without changing Pi settings or persisting the selection.
- [**prevent-idle**](extensions/prevent-idle.ts) — On macOS, holds a `kIOPMAssertionTypePreventUserIdleSystemSleep` assertion through `osascript` while Pi is working, then releases it when the agent settles.
