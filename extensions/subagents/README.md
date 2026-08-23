# Named Subagents

Run named Pi subagents with one-shot, task-scoped, or persistent lifetimes without adding their full conversations to the parent model context. Children use Pi's normal configured tools.

A persona is reusable configuration. Multiple direct subagents can use the same persona while retaining separate processes, sessions, and conversation histories. Every instance also has a stable purpose describing its work or retained context. Subagents do not load this delegation extension by default.

## Commands

```text
/child [prompt]
/child --fork [prompt]
/child:<persona> [prompt]
/child:<persona> --fork [prompt]
/subagents [name-or-id]
/subagents --stop [name-or-id]
/subagents --disable
/subagents --enable
/children [name-or-id]
/children --stop [name-or-id]
```

- `/child` creates and opens a persistent subagent.
- `/subagents` lists existing subagents and opens the selected one.
- `/subagents --stop` selects and permanently stops a subagent after confirmation; its session file is retained.
- `/subagents --disable` removes the `subagent` tool from the parent model; `/subagents --enable` restores it. Toggling affects future model calls and does not interrupt a request already running.
- `/children` is an alias for `/subagents`, including enable, disable, and stop options.
- Closing an idle panel with `app.interrupt` (default `Esc`), or detaching at any time with `app.exit` (default `Ctrl+D`) while its input is empty, leaves the subagent running.
- At most four non-stopped subagents can exist at once. Stopping one frees a slot. The registry keeps metadata for the 20 most recently stopped instances; all child session files remain on disk.
- `/subagents`, `/children`, and fresh `/child` commands can be used while the parent agent is running.
- Forked `/child --fork` creation requires an idle, persisted parent session so the fork never captures an incomplete tool call.
- Fresh subagents have no parent conversation. Forked subagents begin from the parent session branch.

The panel remains interactive after a response settles. Its configured Return binding places the newest normally completed response in the parent editor without submitting it. Prompts are labeled as coming from you, the parent agent, inherited fork context, or an unattributed older session.

## Parent-agent tool

The parent model receives one `subagent` tool with five actions:

```ts
subagent({
  action: "create",
  persona: "codebase-explorer",
  profile: "balanced",
  lifetime: "persistent",
  name: "auth-explorer",
  purpose: "Authentication architecture, token lifecycle, and authorization boundaries",
  context: "Goal: assess the current authentication design\nConstraints: preserve existing token compatibility",
  prompt: "Map authentication",
})
subagent({ action: "list" })
subagent({ action: "prompt", id: "auth-explorer", prompt: "Now inspect token refresh" })
subagent({ action: "status", id: "auth-explorer" })
subagent({ action: "stop", id: "auth-explorer" })
```

Use `subagent({ action: "list", kind: "personas" })` to discover up to 20 persona templates and their context requirements without placing all persona definitions in the parent system prompt. If more personas exist, the result gives the next `offset`; `limit` can select 1–50 entries. Model-facing `create` requires the exact name of an existing persona; when no personas are configured, the parent model cannot create subagents. Human `/child` commands remain available for ad hoc persona-less sessions.

When the current options are unknown, the parent agent is instructed to list reusable instances or personas before creation. It then matches work to a purpose, chooses a persona, lifetime, and execution profile, and satisfies the context contract. For each delegation, it gives the child the exact objective, scope, and requested output without adding adjacent work. `list` and `status` include each instance's purpose and lifetime. Model-facing creation rejects an exact purpose match and points the parent back to the existing instance. An omitted `purpose` falls back to the initial prompt or persona description.

A parent-initiated prompt remains open until the subagent settles. Human steering or follow-ups sent through that subagent's panel become part of the same run, and the newest final response returns as the parent tool result. Normal steering in the parent editor does not route to a subagent.

Human-initiated conversations remain private to the subagent unless explicitly returned to the parent editor or later requested through the tool.

## Lifetimes

Model-created subagents may select an optional `lifetime`; an explicit selection overrides the persona's `preferred-lifetime`, and an instance with neither defaults to `persistent`.

- `one-shot` is for bounded independent work expected to fit one response. It requires an initial prompt, asks the child for a complete concise answer, and stops automatically after success, cancellation, or failure. If its response reaches either the model or parent tool-output limit, or produces no visible agent response, the instance is retained as `task` so the parent can continue it.
- `task` retains context through follow-up and validation prompts. The parent stops it when the objective is complete.
- `persistent` retains context across related objectives and remains available until explicitly stopped.

Prompting a dormant task or persistent instance restarts it lazily. All non-stopped instances count toward the four-subagent limit; stopping is permanent, retains the session file for history, and frees a slot. Human `/child` sessions are always persistent and ignore persona lifetime preferences.

Bundled preferences are `persistent` for `codebase-explorer`, `task` for `reviewer`, and `one-shot` for `test-analyst` and `doc-auditor`. These are defaults rather than constraints.

## Blocked subagents

Every child is instructed to stop retrying when missing context, capability, access, or data prevents completion and lead its response with:

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

The parent is instructed to use the cheapest sufficient profile. It reserves `deep` for high-risk work, ambiguous work that needs cross-system analysis, or when a cheaper profile was insufficient. Bundled `codebase-explorer` and `doc-auditor` personas default to `fast`; `reviewer` and `test-analyst` default to `balanced`. Supplying `profile` overrides that persona default for the new instance. Model selection remains fixed across ordinary follow-ups and is restored from the child session; `deep` is an explicit escalation rather than a default.

## Persona context handoffs

A persona may declare a concise `context-requirements` contract. Its first parent-owned prompt must then include the tool's `context` field. Dormant creation remains allowed, but the first later `prompt` is rejected without context and returns the persona's requirement as retry guidance. Once accepted, the persistent child transcript retains that handoff, so follow-ups do not repeat it; later prompts may provide context updates when goals, constraints, or a Git base change.

Context is delivered in the same child user turn under separate `Parent-provided context` and `Request` headings. It is capped at 8,000 characters and should contain semantic intent—not source files or patch text the child can inspect from the shared worktree. The registry persists only whether required parent context has been provided, never the context text itself. Forked personas already inherit parent-session context.

## Progressive disclosure

Each subagent receives its stable name, purpose, and resolved lifetime in its system prompt. It treats the current request as a hard scope boundary. It can inspect supporting context as needed, but it must not add adjacent objectives, analysis, or findings. Task and persistent instances make each response decision-complete for the current request with concise conclusions and required deliverables. They can index and defer only long supplemental sections. One-shot instances return a complete bounded answer without deferred sections. File paths and line ranges let the parent inspect source material directly instead of copying it through the subagent response.

If a response reaches the parent-response limit, the result names the subagent and tells the parent to use another `prompt` action for a numbered section or continuation. No pagination action or additional tool definition is needed.

## Persistence

Each subagent writes a normal Pi session file. Its RPC process stays alive while the parent runtime is active. On parent shutdown or reload, processes stop but session files remain. Resumed parent sessions restore their subagent registry as dormant instances and restart a subagent lazily when it is opened or prompted. Registry persistence uses per-instance mutations rather than repeatedly appending the full registry.

Subagents belong to the exact parent session. Starting or forking a different parent session does not silently share them.

## Tools and resource isolation

Every subagent starts with:

```text
--no-extensions --no-skills --no-prompt-templates --no-themes
```

The extension intentionally leaves `--tools` unset. Each child therefore receives Pi's normal configured tool set instead of a subagent-specific allowlist; Pi's built-in default is `read`, `bash`, `edit`, and `write`. Persona extensions may register additional active tools normally. There is no separate read-only Git or dependency-source tool chest to maintain.

Ambient extension, skill, prompt-template, and theme discovery remain disabled so a child does not recursively load the subagent extension or unrelated startup code. A persona's explicitly declared extensions and skills are added with repeatable `--extension <path>` and `--skill <path>` arguments. Context files remain enabled.

> **Trust boundary:** Process and session isolation do not sandbox tools or the filesystem. Subagents run with the Pi process's OS permissions and share the parent's current working tree, so they can execute commands and mutate the same files as the parent or another subagent. Explicit persona extensions also execute arbitrary code at child startup. Attach only trusted resources, avoid recursive delegation, and coordinate concurrent edits when multiple agents are active.

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
- `preferred-lifetime`: optional `one-shot`, `task`, or `persistent` default for model-created instances; an explicit tool choice overrides it, and human `/child` sessions ignore it.
- `extensions` (or `extension`): trusted extension files or directories, resolved relative to the persona file; lists and comma-separated strings are supported.
- `skills` (or `skill`): skill files or directories, resolved relative to the persona file; lists and comma-separated strings are supported.
- `model`: initial model for new sessions.
- `thinking`: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.

Skills use Pi's normal progressive disclosure: descriptions enter only the child context and full `SKILL.md` instructions load on demand. Extension and skill paths are captured when a subagent is created, so persona changes apply to new instances.

## Context discipline

- The parent receives one compact `subagent` tool rather than persona- or action-specific tools.
- Full subagent transcripts, thinking, and tool activity remain outside parent context. The interactive panel keeps a bounded tail of at most 200 transcript items in memory; omitted history remains in the child session file.
- Supplied context appears only in the parent's own tool call and the child transcript; it is not echoed in results or registry snapshots.
- Only the newest useful response is returned to the parent model. It is limited to 400 lines or 16 KiB.
- Child process and provider errors exposed to the parent are capped at 2,000 characters.
- Model-visible `list` output contains only reusable names, statuses, lifetimes, purposes, and concise active blocker metadata; stopped instances are omitted.
- Model-visible `status` output contains only the requested name, status, lifetime, purpose, and concise active blocker metadata.
- IDs, model settings, session paths, timestamps, and other runtime metadata stay in tool result details.
- Registry snapshots use custom session entries, which do not participate in model context.
