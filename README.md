# π²

Repository for maintaining skills and extensions that I use with [Pi](https://buildwithpi.ai/).

Requires Node.js 22.19.0 or newer.

## Skills

- [**address-pr-feedback**](skills/address-pr-feedback/SKILL.md) — Handles GitHub PR feedback end-to-end: reviews comments and inline threads, makes or plans the appropriate changes, and posts replies on GitHub.
- [**buildkite-pr-check-review**](skills/buildkite-pr-check-review/SKILL.md) — Investigates GitHub PR status checks that map to Buildkite builds/jobs, fetches Buildkite logs with the CLI, and summarizes failures.
- [**create-pr**](skills/create-pr/SKILL.md) — Creates or updates a GitHub pull request, analyzes changes, and cleans up `pi:` auto-commits before every push.

## Manual skills

These skills are not in the package skill list. Load them explicitly or attach them to a persona.

- [**go-code-review**](manual-skills/go-code-review/SKILL.md) — Adds Go-specific concurrency, domain-type, compatibility, and style guidance to the reviewer persona.

## Subagent personas

- [**reviewer**](extensions/subagents/personas/reviewer.md) — Reviews implementation changes for correctness and regressions.
- [**codebase-explorer**](extensions/subagents/personas/codebase-explorer.md) — Maps subsystems, follows declared Go dependencies, and retains architectural context.
- [**test-analyst**](extensions/subagents/personas/test-analyst.md) — Analyzes behavior and test coverage, running focused tests when useful.
- [**doc-auditor**](extensions/subagents/personas/doc-auditor.md) — Audits documentation against code and changes.

## Extensions

- [**subagents**](extensions/subagents/README.md) — Runs isolated child Pi sessions with normal Pi tool access, selectable lifetimes, explicit blocker handoffs, and human controls.
- [**qa**](extensions/qa.ts) — Extracts questions from assistant responses and presents an interactive wizard for answering them.
- [**handoff**](extensions/handoff.ts) — Starts a fresh linked session with the latest complete assistant response, or `/handoff generate` creates a compact handoff draft from active context.
- [**bash-tool-interceptor**](extensions/bash-tool-interceptor/) — Prepends steering wrappers to the model Bash `PATH` so Python tooling uses `uv` without unsafe command rewrites.
- [**skill-loader**](extensions/skill-loader.ts) — `/skill-loader` chooses temporary skills from roots in `~/.pi/agent/skill-loader.json` and limits selected model-visible metadata to 16,000 characters.
- [**prevent-idle**](extensions/prevent-idle.ts) — On macOS, holds a `kIOPMAssertionTypePreventUserIdleSystemSleep` assertion through `osascript` while Pi is working, then releases it when the agent settles.
- [**interactive-shell**](extensions/interactive-shell.ts) — Runs every `!!command` with direct terminal access while Pi's TUI is suspended; plain `!command` retains normal captured-output behavior.
