# Named Subagents

Run named Pi subagents with one-shot, task-scoped, or persistent lifetimes without adding their full conversations to the parent model context. Subagents use Pi's normal configured tools and the bundled `codex-tools` and `prevent-idle` extensions.

A persona is reusable configuration for a stable role. Multiple subagents can use the same persona while retaining separate processes, sessions, and conversation histories. Every instance has a stable purpose that defines its work or retained context. A model can also create a subagent without a persona when it supplies a purpose, lifetime, and selected skills. Subagents do not load this delegation extension by default.

## Commands

The subagent list is also available with `Ctrl+Shift+A`.

```text
/subagent [prompt]
/subagent --fork [prompt]
/subagent:<persona> [prompt]
/subagent:<persona> --fork [prompt]
/subagents [name-or-id]
/subagents --stop [name-or-id]
/subagents --disable
/subagents --enable
```

- `/subagent` creates and opens a persistent subagent.
- `/subagents` lists existing subagents and opens the selected one.
- `/subagents --stop` selects and permanently stops a subagent after confirmation; its session file is retained.
- `/subagents --disable` removes the `subagent` tool from the parent model; `/subagents --enable` restores it. Toggling affects future model calls and does not interrupt a request already running.
- Closing an idle panel with `app.interrupt` (default `Esc`), or detaching at any time with `app.exit` (default `Ctrl+D`) while its input is empty, leaves the subagent running.
- At most four non-stopped subagents can exist at once. Stopping one frees a slot. The registry keeps metadata for the 20 most recently stopped instances; all subagent session files remain on disk.
- `/subagents` and fresh `/subagent` commands can be used while the parent agent is running.
- Human `/subagent --fork` creation requires an idle, persisted parent session so the fork never captures an incomplete tool call.
- Fresh subagents have no parent conversation. Forked subagents begin from the parent session branch.

The panel remains interactive after a response settles. Its configured Return binding places the newest normally completed response in the parent editor without submitting it. Prompts are labeled as coming from you, the parent agent, inherited fork context, or an unattributed older session.

## Parent-agent tool

The parent model receives one `subagent` tool with five actions:

```ts
subagent({
  action: "create",
  mode: "fresh",
  profile: "balanced",
  lifetime: "task",
  name: "create-pr",
  purpose: "Create the requested pull request",
  skills: ["create-pr", "writing-style"],
  context: "Goal: create a pull request for the current branch",
  prompt: "Execute the requested PR workflow.",
})
subagent({ action: "list" })
subagent({ action: "prompt", id: "auth-explorer", prompt: "Now inspect token refresh" })
subagent({ action: "status", id: "auth-explorer" })
subagent({ action: "stop", id: "auth-explorer" })
```

Use `subagent({ action: "list", kind: "personas" })` to discover up to 20 persona templates and their context requirements without putting all persona definitions in the parent system prompt. If more personas exist, the result gives the next `offset`; `limit` can select 1–50 entries. A persona name must match exactly.

Model-facing `create` can omit `persona` only with an explicit `purpose`, explicit `lifetime`, and one or more `skills`. A persona-based create keeps its current defaults. Selected skills are additive to persona skills. A selected skill that has the same name as a different persona skill is rejected. Skill names must match skills that Pi already discovered in the parent session. Unknown or ambiguous names fail with retry guidance. Paths are not accepted from the model.

`mode` is `fresh` by default. A fresh subagent can receive concise `context`. A model can use `mode: "fork"` during an active parent turn. The extension writes a retained fork source through the current user request, then excludes the in-progress assistant message and tool call. It does not move the parent leaf. The child uses normal fork attribution and can resume from its own session. If the parent session is ephemeral, fork falls back to fresh context. The tool result reports this fallback.

When options are unknown, the parent agent lists reusable instances or personas before creation. It matches work to a purpose, chooses a lifetime and profile, and provides required context. For each delegation, it gives the subagent the exact objective, scope, and requested output. `list` and `status` include each instance's purpose and lifetime. Model-facing creation rejects an exact purpose match and points the parent to the existing instance. A persona-based create can omit `purpose`; it then uses the initial prompt or persona description.

A parent-initiated prompt remains open until the subagent settles. Human steering or follow-ups sent through that subagent's panel become part of the same run, and the newest final response returns as the parent tool result. Normal steering in the parent editor does not route to a subagent.

Human-initiated conversations remain private to the subagent unless explicitly returned to the parent editor or later requested through the tool.

- Create a subagent only when isolation from large intermediate context or retained continuity materially helps; do not delegate simple work.
- Prefer fresh context. Fork only when parent history is material and a concise handoff is insufficient. Use one task subagent for the complete objective and reuse it.

## Lifetimes

Persona-based model-created subagents may select an optional `lifetime`; an explicit selection overrides the persona's `preferred-lifetime`, and an instance with neither defaults to `persistent`. Persona-less model creation requires an explicit lifetime.

- `one-shot` is for bounded independent work expected to fit one response. It requires an initial prompt, asks the subagent for a complete concise answer, and stops automatically after success, cancellation, or failure. If its response reaches either the model or parent tool-output limit, or produces no visible agent response, the instance is retained as `task` so the parent can continue it.
- `task` retains context through follow-up and validation prompts. The parent stops it when the objective is complete.
- `persistent` retains context across related objectives and remains available until explicitly stopped.

Prompting a dormant task or persistent instance restarts it lazily. All non-stopped instances count toward the four-subagent limit; stopping is permanent, retains the session file for history, and frees a slot. Human `/subagent` sessions are always persistent and ignore persona lifetime preferences.

Bundled preferences are `persistent` for `codebase-explorer`, `task` for `reviewer`, and `one-shot` for `test-analyst` and `doc-auditor`. These are defaults rather than constraints.

## Blocked subagents

Every subagent is instructed to stop retrying when missing context, capability, access, or data prevents completion and lead its response with:

```text
BLOCKED: <reason>
NEEDS: <minimum requirement>
```

The extension recognizes only this explicit protocol. It does not infer a blocker from prose. A blocked instance has status `blocked`. Model-visible `list` and `status` text includes its normalized reason and need. Each field is limited to 240 characters. `list` tool details expose them as `details.subagents[].blocker.reason` and `details.subagents[].blocker.need`. Other actions use `details.subagent.blocker.reason` and `details.subagent.blocker.need`. Its next non-blocked response clears the state. Stopping the instance also clears the state.

The parent is instructed to supply missing semantic context or results, clarify constraints, and then reprompt the same task. A blocked one-shot is retained as a task instead of being discarded. The parent can then unblock it and continue validation.

The blocker is part of the parent session registry. The extension does not write or analyze a separate blocker history.

## Execution profiles

Model-created subagents may select an optional creation profile. Profiles choose the initial model and thinking level:

- `fast`: Luna with `high` thinking.
- `balanced`: Terra with `xhigh` thinking.
- `deep`: Sol with `xhigh` thinking.

Persona-less creation defaults to `balanced`. The parent uses `fast` for bounded lookup and uses `deep` only after a cheaper attempt fails or unresolved ambiguity makes that attempt unsafe. Bundled `codebase-explorer` and `doc-auditor` personas default to `fast`; `reviewer` and `test-analyst` default to `balanced`. Supplying `profile` overrides that persona default for the new instance. Model selection remains fixed across ordinary follow-ups and is restored from the subagent session.

## Persona context handoffs

A persona may declare a concise `context-requirements` contract. Its first parent-owned prompt must then include the tool's `context` field. Dormant creation remains allowed, but the first later `prompt` is rejected without context and returns the persona's requirement as retry guidance. Once accepted, the persistent subagent transcript retains that handoff, so follow-ups do not repeat it; later prompts may provide context updates when goals, constraints, or a Git base change.

Context is delivered in the same subagent user turn under separate `Parent-provided context` and `Request` headings. It is capped at 8,000 characters and should contain semantic intent—not source files or patch text the subagent can inspect from the shared worktree. The registry persists only whether required parent context has been provided, never the context text itself. Forked personas already inherit parent-session context.

## Progressive disclosure

Each subagent receives its stable name, purpose, and resolved lifetime in its system prompt. It treats the current request as a hard scope boundary. It can inspect supporting context as needed, but it must not add adjacent objectives, analysis, or findings. Task and persistent instances make each response decision-complete for the current request with concise conclusions and required deliverables. They can index and defer only long supplemental sections. One-shot instances return a complete bounded answer without deferred sections. File paths and line ranges let the parent inspect source material directly instead of copying it through the subagent response.

If a response reaches the parent-response limit, the result names the subagent and tells the parent to use another `prompt` action for a numbered section or continuation. No pagination action or additional tool definition is needed.

## Persistence

Each subagent writes a normal Pi session file. Its RPC process stays alive while the parent runtime is active. On parent shutdown or reload, processes stop but session files remain. Resumed parent sessions restore their subagent registry as dormant instances and restart a subagent lazily when it is opened or prompted. Registry persistence uses per-instance mutations rather than repeatedly appending the full registry.

Subagents belong to the exact parent session. Starting or forking a different parent session does not silently share them.

## Tools and shared authority

Every subagent starts with:

```text
--no-extensions --no-skills --no-prompt-templates --no-themes
--extension <bundled-codex-tools-path>
--extension <bundled-prevent-idle-path>
```

The subagent always loads `codex-tools` and `prevent-idle` explicitly. For an `openai-codex` model, `codex-tools` overrides `read`, `find`, `grep`, `bash`, `git`, and `gh`, and corrects the built-in `write` byte count. On macOS, `prevent-idle` prevents system sleep while the subagent works.

The extension intentionally leaves `--tools` unset. Each subagent therefore receives Pi's normal configured tool set instead of a subagent-specific allowlist; Pi's built-in default is `read`, `bash`, `edit`, and `write`. Persona extensions may register additional active tools normally. There is no separate read-only Git or dependency-source tool chest to maintain.

Ambient extension, skill, prompt-template, and theme discovery remain disabled so a subagent does not recursively load the subagent extension or unrelated startup code. The two bundled extensions, persona resources, and selected parent skills are added explicitly with repeatable `--extension <path>` and `--skill <path>` arguments. The extension resolves selected skills to canonical parent-discovered paths before it starts the child. Context files remain enabled.

> **Trust boundary:** Separate conversation context and subagent processes do not sandbox tools or the filesystem. Subagents share the parent worktree and host authority, so they can run commands and change the same files as the parent or another subagent. Explicit persona extensions also run arbitrary code at subagent startup. Attach only trusted resources, avoid recursive delegation, and coordinate concurrent edits when multiple agents are active.

## Personas

The extension bundles `reviewer`, `codebase-explorer`, `test-analyst`, and `doc-auditor` personas under `extensions/subagents/personas/`. Additional Markdown personas in `~/.pi/agent/personas/` load after the bundled defaults and override a bundled persona with the same name. Run `/reload` after changing persona files.

```markdown
---
name: product-manager
description: Explore product requirements and tradeoffs
context-requirements: >
  Provide the desired outcome, users, constraints, and relevant product scope.
preferred-lifetime: task
extensions:
  - ../extensions/product-context.ts
skills:
  - ../skills/product-research/SKILL.md
model: anthropic/claude-sonnet-4-6
thinking: medium
---

You are a product manager. Clarify outcomes, users, constraints, risks, and tradeoffs.
```

Supported frontmatter:

- `name`: command suffix; defaults to the filename.
- `description`: command and tool-list description, normalized to one line and limited to 240 characters.
- `context-requirements`: optional parent-facing handoff contract, normalized to one line and limited to 240 characters; when present, context is required for the first parent prompt.
- `preferred-lifetime`: optional `one-shot`, `task`, or `persistent` default for model-created instances; an explicit tool choice overrides it, and human `/subagent` sessions ignore it.
- `extensions` (or `extension`): trusted extension files or directories, resolved relative to the persona file; lists and comma-separated strings are supported.
- `skills` (or `skill`): skill files or directories, resolved relative to the persona file; lists and comma-separated strings are supported.
- `model`: initial model for new sessions.
- `thinking`: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.

Skills use Pi's normal progressive disclosure: descriptions enter only the subagent context and full `SKILL.md` instructions load on demand. Persona resources and selected skill paths are captured when a subagent is created, so they persist when a task or persistent subagent becomes dormant and resumes.

## Context discipline

- The parent receives one compact `subagent` tool rather than persona- or action-specific tools.
- Full subagent transcripts, thinking, and tool activity remain outside parent context. The interactive panel keeps a bounded tail of at most 200 transcript items in memory; omitted history remains in the subagent session file.
- Supplied context appears only in the parent's own tool call and the subagent transcript; it is not echoed in results or registry snapshots.
- Only the newest useful response is returned to the parent model. It is limited to 400 lines or 16 KiB.
- Subagent process and provider errors exposed to the parent are capped at 2,000 characters.
- Model-visible `list` output contains only reusable names, statuses, lifetimes, purposes, and concise active blocker metadata; stopped instances are omitted.
- Model-visible `status` output contains only the requested name, status, lifetime, purpose, and concise active blocker metadata. Selected skill paths and metadata stay out of these outputs.
- IDs, model settings, session paths, timestamps, and other runtime metadata stay in tool result details.
- Registry snapshots use custom session entries, which do not participate in model context.
