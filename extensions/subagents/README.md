# Named Subagents

Run named subagents without placing their full conversations in the parent model context. A persona is reusable configuration for a stable role. Each instance has its own name, purpose, lifetime, and state.

The extension supports macOS and Linux. It has two runtimes:

| Runtime | Execution and authority |
| --- | --- |
| `pi` | Runs an isolated Pi RPC process. The process shares the local worktree, host authority, and Pi tool configuration. |
| `cursor-cloud` | Runs a remote Cursor Cloud agent through `@cursor/sdk`. The agent inspects a pushed repository commit and configured Cloud MCPs. It does not use local Cursor ACP. |

Pi is the default runtime. Model-tool Pi creation requires an explicit persona. Use `worker` for general execution work. Persona-less model-tool creation requires an explicit `cursor-cloud` runtime. A persona selects its runtime. An explicit model-tool `runtime` must match the persona runtime.

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
/subagent --help
/subagent:<persona> --help
/subagents --help
```

All commands accept exact `--help` or `-h`. Help does not run the command. Argument completion offers `--fork` before a prompt. It also offers `--stop`, `--enable`, `--disable`, and active names or IDs for `/subagents`. A creation command does not offer options after prompt text starts.

- `/subagent` creates and opens a persistent Pi subagent.
- `/subagent:<persona>` uses the persona runtime.
- `/subagents` lists existing subagents and opens the selected one.
- `/subagents --stop` stops a subagent after confirmation. A stopped Pi session file remains on disk.
- `/subagents --disable` removes the parent `subagent` tool. `/subagents --enable` restores it. The change affects future model calls only.
- `/subagents` and a new `/subagent` command can run while the parent agent works.

A human slash-command fork requires an idle and persisted parent session for both runtimes. The command rejects a fork that can capture an incomplete parent tool call. This rule does not apply to a model-tool fork during an active parent turn. The model tool creates a bounded active-turn handoff. It excludes the in-progress assistant message and subagent tool call.

Use `app.message.copy`, shown as `return` in the panel, to place the newest normally completed visible response in the parent editor. This action does not submit the editor. It does not return an active, aborted, failed, or response-less result.

## Parent-agent tool

The parent model receives one `subagent` tool with five actions:

```ts
subagent({
  action: "create",
  mode: "fresh",
  persona: "worker",
  profile: "balanced",
  name: "create-pr",
  purpose: "Create the requested pull request",
  skills: ["create-pr", "writing-style"],
  context: "Own the PR workflow. Preserve concurrent changes. Validate the created pull request.",
  prompt: "Execute the requested PR workflow.",
})
subagent({
  action: "create",
  runtime: "cursor-cloud",
  name: "incident-investigator",
  purpose: "Investigate the reported production incident",
  prompt: "Inspect the evidence and recommend a local fix.",
})
subagent({ action: "list" })
subagent({ action: "prompt", id: "incident-investigator", prompt: "Check the latest error pattern." })
subagent({ action: "status", id: "incident-investigator" })
subagent({ action: "stop", id: "incident-investigator" })
```

Use `subagent({ action: "list", kind: "personas" })` to find up to 20 persona templates. The result includes each persona runtime. If more personas exist, use the returned `offset`. `limit` selects 1 through 50 entries. A persona name must match exactly.

A model-tool `create` defaults to a `task` lifetime. Pi creation requires a persona. Use `worker` for general implementation or production work when no specialist fits. Persona-less creation is available only with an explicit `cursor-cloud` runtime and purpose. The `skills` input is valid only for Pi. Cursor Cloud rejects skills. It does not ignore them.

Selected Pi skills add to persona skills. The extension rejects a selected skill with the same name as a different persona skill. Each skill name must match a skill that Pi discovered in the parent session. The model tool accepts skill names, not paths.

`mode` is `fresh` by default. A fresh subagent can receive concise `context`. `context` is not a standalone input. A model-tool call that includes `context` must include a non-empty `prompt` in the same call. To create a dormant task or persistent subagent, omit both fields.

- A Pi fork starts from a parent-session branch.
- A Cursor Cloud fork sends a bounded, sanitized summary of the effective parent branch.
- A fork does not move or change the parent branch.
- A Cursor registry record does not contain the raw fork source.

A Pi model-tool fork can fall back to fresh context when the parent session is ephemeral. The tool reports that fallback. A Cursor fork summary failure returns an error. It does not change the request to fresh mode.

Give each subagent an exact objective, scope, and requested output. For a worker, also give acceptance criteria, explicit file or responsibility ownership, concurrent-work constraints, and required validation. Use `list` and `status` before you create a new instance. Model-facing creation rejects an exact active purpose match in the same runtime. It directs the parent to the retained instance. A persona-based create can omit `purpose`. The extension then uses the initial prompt or persona description.

A parent `create` with an initial prompt and a parent `prompt` wait for the subagent result. A human can steer or continue Pi work from the subagent panel. A human can continue Cursor work after settlement.

Subagent conversation stays private from the parent model context. `app.message.copy` places a response in the parent editor. A parent-tool result returns a response to the parent. Cursor runtime prompts are sent to Cursor Cloud.

- Delegate substantive isolated work. Keep only coordination and necessary integration in the parent context.
- Inspect only enough to partition work by shared context and specialty.
- Reuse subagents for related work. Avoid duplicate investigation.
- Parallelize only separate contexts or specialties. Give concurrent workers non-overlapping ownership.
- Prefer fresh context when a concise handoff is sufficient.

## Context requirements and forks

A persona can declare `context-requirements`. The first parent-owned model-tool prompt for that persona must include `context`. The extension allows dormant creation without context. It rejects the first later parent-owned prompt without context. The error includes the requirement as retry guidance.

A successful fork satisfies the requirement because it has parent context. A Pi fork that falls back to fresh context does not satisfy it. Later prompts can include context updates when the goal, constraints, or Git base changes. The registry records only that required context was delivered. It does not record the context text.

The model-tool `context` field is limited to 8,000 characters. The Cursor runtime formats parent context and request as one input. The extension redacts recognized credential fields in this input. It caps the combined value at 6 KiB. Redaction is mitigation. It is not a complete data-loss boundary. Give semantic intent. Do not give repository source or patch text that Cursor can inspect.

## Lifetimes

A model-tool create defaults to `task`. An explicit `lifetime` overrides this default. Human `/subagent` sessions are always `persistent`.

- `one-shot` is for bounded independent work when continuity cannot help. A model-tool one-shot requires an explicit lifetime and an initial prompt. A Pi one-shot stops after success, cancellation, or failure. A Cursor one-shot archives only after result delivery.
- `task` retains context for follow-up and validation.
- `persistent` retains context for related work until you stop it.

A blocked, truncated, incomplete, or response-less one-shot becomes a task. A Cursor one-shot that completes while Pi is offline also becomes a task until delivery. Prompting a dormant task or persistent instance starts it lazily.

One parent session can retain up to 20 non-stopped subagents. At most four subagents can work concurrently. Dormant and idle subagents do not use concurrent work slots. A new prompt fails when four other subagents are working. Stopping an instance frees retained capacity. The registry also keeps metadata for the 20 most recently stopped instances.

The bundled personas use these profile defaults:

| Persona | Profile |
| --- | --- |
| `explorer` | `fast` |
| `reviewer` | `balanced` |
| `test-analyst` | `balanced` |
| `worker` | `balanced` |
| `doc-auditor` | `fast` |

## Blocked subagents

Each subagent receives this blocker protocol:

```text
BLOCKED: <reason>
NEEDS: <minimum requirement>
```

The labels are case-insensitive. The first nonblank line must start with `BLOCKED:`. The next nonblank line must start with `NEEDS:`. The extension does not infer a blocker from other prose. It limits each normalized blocker field to 240 characters.

A blocked instance has status `blocked`. `list` and `status` include its reason and need. Tool-result details include the same blocker data. A non-blocked response clears the status. Stopping the instance also clears it.

Supply the missing context or capability. Then prompt the same task again. A blocked one-shot remains available as a task.

## Execution profiles and settings

A creation profile selects the initial model and thinking target:

| Profile | Target model | Target thinking | Cursor context | Cursor speed |
| --- | --- | --- | --- | --- |
| `fast` | GPT-5.6 Luna | `high` | `272k` | Standard |
| `balanced` | GPT-5.6 Terra | `xhigh` | `272k` | Standard |
| `deep` | GPT-5.6 Sol | `xhigh` | `272k` | Standard |

For Pi, a profile selects the configured Pi model and thinking level. For Cursor Cloud, the extension resolves the complete standard-speed (`fast=false`) variant through the account model catalog. It accepts a model catalog that exposes only the target thinking parameter. It refreshes the catalog once after a miss. It returns an error when no exact model and supported parameter set exist. It does not substitute another model.

Personas do not select models or thinking values. They can select a preferred profile. An explicit model-tool profile overrides this preference. A create with neither value uses `balanced`. Exact Cursor model IDs and thinking parameters depend on the account catalog.

The `profile` input is valid only for creation.

The Pi panel can change a model or thinking setting only while Pi is idle. The change applies to the Pi session.

The Cursor panel can change a model or thinking setting only while Cursor is idle. Cursor saves the setting for the next run. It cannot change an active run.

Cursor thinking controls appear only when the selected model has at least two usable thinking choices. Cursor mode selection is unavailable. Every Cursor initial prompt and follow-up uses Plan mode.

## Personas

The extension bundles `worker`, `reviewer`, `explorer`, `test-analyst`, and `doc-auditor` in `extensions/subagents/personas/`. Additional Markdown personas in `~/.pi/agent/personas/` load after bundled personas. A user persona with the same name overrides a bundled persona. Run `/reload` after you change a persona file.

### Pi persona example

```markdown
---
name: product-manager
description: Explore product requirements and tradeoffs
runtime: pi
context-requirements: >
  Provide the desired outcome, users, constraints, and relevant product scope.
preferred-profile: balanced
extensions:
  - ../extensions/product-context.ts
skills:
  - ../skills/product-research/SKILL.md
---

You are a product manager. Clarify outcomes, users, constraints, risks, and tradeoffs.
```

### Cursor Cloud persona example

```markdown
---
name: incident-investigator
description: Investigate production incidents
runtime: cursor-cloud
context-requirements: Provide the incident impact, time range, and affected service.
cursor-mcps:
  - datadog
  - sentry
cursor-repos:
  - url: https://github.com/example/runbooks
    starting-ref: main
---

Inspect the incident evidence. Return causes, evidence, and safe local next steps.
```

### Runtime-specific frontmatter

Both runtimes support these fields:

- `name`: Command suffix. It defaults to the file name.
- `description`: Persona list description. The extension normalizes it to one line and limits it to 240 characters.
- `runtime`: `pi` is the default. Use `cursor-cloud` for a Cursor Cloud persona.
- `context-requirements`: Optional first-parent-prompt contract. The extension normalizes it to one line and limits it to 240 characters.
- `preferred-profile`: Optional `fast`, `balanced`, or `deep` default. An explicit model-tool profile overrides it.

Persona frontmatter rejects `preferred-lifetime`, `model`, and `thinking`. Select lifetime when you create a model subagent. Use the model-tool `profile` input for initial model selection.

Pi-only fields are:

- `extensions` or `extension`: Trusted extension files or directories. Paths are relative to the persona file. Lists and comma-separated strings are supported.
- `skills` or `skill`: Skill files or directories. Paths are relative to the persona file. Lists and comma-separated strings are supported.

Cursor-only fields are:

- `cursor-mcps`: A list of logical expected MCP server names. The list can contain at most eight names after deduplication.
- `cursor-repos`: A list of supporting GitHub repositories. Each item has `url` and optional `starting-ref`.

A Cursor persona rejects `extensions`, `extension`, `skills`, `skill`, and unknown frontmatter fields. A Pi persona rejects Cursor-only fields.

A Cursor repository URL must be credential-free GitHub SSH or HTTPS. It cannot contain a query or fragment. The extension normalizes and deduplicates URLs. It rejects duplicate entries with different refs.

A supporting repository `starting-ref` is optional. It accepts a syntactically safe Git ref. This can be a branch, tag-style ref, or commit SHA. If it is omitted, Cursor and the deployment determine the default behavior.

The primary repository always uses the exact current `HEAD` SHA. If `cursor-repos` repeats the primary URL, the extension removes that entry and retains the primary `HEAD` SHA. The final list includes the primary repository. It can contain at most 20 repositories after deduplication.

Pi uses progressive disclosure for skills. Pi adds a skill description to the subagent context. Pi loads full `SKILL.md` instructions on demand.

## Cursor Cloud repositories, MCPs, and policy

### Local creation and repository visibility

A Cursor model-tool create without a prompt is local and `dormant`. The registry stores a client-generated agent ID. This action does not create a remote agent. It does not require `CURSOR_API_KEY`. It does not inspect Git provenance.

The first Cursor Cloud setup checks `CURSOR_API_KEY`. It resolves model and repository data. Opening or prompting a dormant Cursor panel can start this setup. Opening can also call `Agent.create` to set up a lazy local SDK handle. `Agent.create` does not create a remote agent. The first Cursor `send()` creates the remote agent and its initial run. Git preconditions can block Cloud setup or a run. They do not block local dormant creation.

For Cloud setup, the extension derives the primary repository from the current working directory. It requires a Git repository, a supported credential-free GitHub remote, and an exact local `HEAD` commit SHA. It uses the current branch remote when configured. Otherwise, it uses `origin`.

The extension sends the primary repository first. It uses the exact `HEAD` SHA as `startingRef`. Cursor must be able to see that pushed commit. The extension checks local upstream or remote-tracking data when available. If it finds commits ahead of that reference, Cloud setup fails. The error asks you to push `HEAD`. Cursor run creation remains authoritative for repository access and commit visibility.

A dirty worktree does not block local creation or Cloud setup. The panel warns that Cursor repository access sees only committed `HEAD` state. The parent result includes the same warning. Repository access does not automatically expose uncommitted or local-only worktree state to Cursor. Prompts, context, and bounded fork summaries transfer to Cursor Cloud. Explicitly supplied text can describe or contain local changes.

The extension does not fetch, push, check out, merge, or create a local branch. It does not download Cursor repository changes. It does not apply repository changes to the local worktree. An unpushed-`HEAD` error does not cause the extension to push. Push with your own Git workflow, then retry. A repository-access error asks you to confirm access. The extension does not change repository access or apply work.

### MCP servers and OAuth

`cursor-mcps` is metadata only. It tells the Cloud agent which configured capabilities it expects. It does not configure, enable, validate, restrict, or authorize an MCP server.

The extension does not pass this field to the SDK `mcpServers` option. Inline MCP definitions and MCP credentials are not supported.

Cursor documentation states that Team MCP servers configured in **Dashboard → Integrations & MCP** are available to Team Cloud agents. Persona metadata does not control this availability. This environment did not validate this account-dependent behavior.

Cursor documentation states that an OAuth MCP server authenticates for the principal associated with the supplied Cursor credential. OAuth availability depends on the account and service. This environment did not validate OAuth behavior. The extension bootstrap tells the agent to return `BLOCKED` and `NEEDS` when an expected capability prevents completion.

Cursor documentation describes agent ownership in terms of the principal authenticated by the supplied `CURSOR_API_KEY`. If the credential is a user key, that principal is its Cursor user. The extension does not classify key types. It does not share agents automatically. This environment did not validate account ownership.

Cursor Cloud uses Plan mode as a best-effort no-change policy. The extension sets `workOnCurrentBranch: false` and `autoCreatePR: false`. It sends `mode: "plan"` for every run. It does not expose a mode change. It does not create a pull request automatically.

The initial prompt and each follow-up tell the agent not to edit, commit, push, create branches or pull requests, or use mutating MCP operations.

Plan mode and prompt instructions are not a strict read-only boundary. Effective authority comes from Cursor repository access, Team configuration, and OAuth permissions. Use read-only repository and MCP permissions when you need strict no-change behavior. If Cursor reports branch or pull-request metadata, the extension shows a policy warning. It does not apply those changes locally.

### Authentication

A remote Cursor operation requires an explicit `CURSOR_API_KEY` environment variable. Pi-only use does not require this variable. Local dormant Cursor creation does not require it.

The extension passes the environment key explicitly. It does not use stored browser-login credentials. It does not identify or distinguish key type. Service-account use is outside product validation.

The extension does not store the key in prompts, results, logs, panel details, or registry entries.

If the variable is absent, the error is:

```text
Cursor Cloud requires CURSOR_API_KEY for remote operations.
```

If Cursor rejects the key, the error tells you to set a valid `CURSOR_API_KEY` and retry. The error does not display the key.

## Cursor Cloud lifecycle and recovery

Cursor permits one active run per agent. A second prompt during an active run returns a busy error. Cursor does not queue the prompt. Cursor rejects active-run steering and active-run follow-up queueing.

The registry persists Cursor runtime state and agent and run IDs. It also persists idempotency state, lifetime, model selection, repository refs, status, and delivery state.

The registry does not persist API keys, MCP credentials, MCP definitions, raw fork input, or full Cloud transcripts.

After restore, the extension uses saved IDs and authoritative Cursor run state. The final run result is the normal recovery result. When that result has no text and `Run.conversation()` is supported, the extension reads only the latest assistant response. It does not restore full conversation history. It does not replay streaming telemetry. The supported SDK has no public event replay cursor.

Cursor keeps a completed parent-owned result for durable delivery. A result found after restore, archival, or detach opens read-only. Return that result before a new prompt. A result observed in the same live panel can continue after settlement.

`stop` cancels an active Cursor run and then archives the remote agent. It does not delete the agent. If cancellation is not confirmed, status is `remote-state-unknown`. The extension does not report a successful stop or free the concurrent work slot. If cancellation succeeds and archival fails, status is `archive-pending`. Retry `stop` to retry archival. Return an undelivered result before you stop its subagent.

## Panel controls and artifacts

The panel status line shows the model, thinking level, activity state, and usage. Panel details show connection or agent and run IDs, duration, repository refs, warnings, and artifacts. Repository lists with a shared URL prefix show it once. A Cursor agent shows its Cloud Agents URL. A Cursor panel opens while the extension reconnects remote state. It disables prompts and returns until the connection is ready. Use the details control to expand bounded repository, artifact, and warning data.

| Control | Pi | Cursor Cloud |
| --- | --- | --- |
| `Esc` while busy | Interrupts active work. | Requests cancellation of the active remote run. |
| `Esc` while idle | Closes the panel. | Closes the panel. |
| `Ctrl+D` with empty input or panel close | Detaches the panel. | Detaches the local observer. It does not cancel the Cloud run. |
| Active-run steering and queued follow-up | Available. | Unavailable. Wait for settlement. |
| Normal prompt after settlement | Available. | Available after the same live panel observes settlement. A restored or detached retained result must be returned first. |
| Model and thinking controls | Available only while idle. | Available only while idle. The selected setting applies to the next run. |
| Mode control | Not applicable. | Unavailable. Plan mode stays fixed. |

The Cursor panel hides model and thinking controls when the catalog is unavailable. An open idle panel retries the catalog lookup at a bounded interval. Detach stops this retry. Pi extension UI appears only for the Pi runtime.

Panel close and `Ctrl+D` remove the local Cursor observer only after the last attached panel closes. Pi shutdown also removes the local observer. These actions do not cancel or archive remote Cloud work. Use `Esc` to request cancellation. Use `stop` to cancel and archive.

Cursor can report agent-scoped artifact metadata. The extension lists bounded metadata in panel and tool-result details. It lists at most 50 artifacts. It does not download artifact content. It does not treat an artifact as a repository change. It does not apply an artifact locally.

Artifact availability is account-dependent. It was not validated in this environment.

## Pi continuity, tools, and shared authority

A Pi subagent writes a normal Pi session file after it starts. A dormant registry record can have no session file. Its RPC process stays alive while the parent runtime stays active.

On parent shutdown or reload, Pi stops the process and keeps the session file. A resumed parent session restores registry records as dormant. Pi starts a dormant process only when the user opens it or the parent prompts it.

A subagent belongs to one exact parent session. Starting or forking another parent session does not share the subagent. Pi captures persona extensions, persona skills, and selected parent skill paths at creation. A dormant Pi subagent uses these captured resources when it restarts.

A Pi subagent starts with:

```text
--no-extensions --no-skills --no-prompt-templates --no-themes
--extension <bundled-codex-tools-path>
--extension <bundled-prevent-idle-path>
```

Pi loads `codex-tools` and `prevent-idle` explicitly. For an `openai-codex` model, `codex-tools` overrides `read`, `find`, `grep`, `bash`, `git`, and `gh`. It also corrects the built-in `write` byte count. On macOS, `prevent-idle` prevents system sleep while the Pi subagent works.

The Pi runtime leaves `--tools` unset. A Pi subagent receives Pi's normal configured tool set. Pi's built-in default is `read`, `bash`, `edit`, and `write`. A Pi persona extension can register additional active tools.

Pi disables ambient extension, skill, prompt-template, and theme discovery. Pi adds the bundled extensions, persona resources, and selected skills explicitly. This prevents recursive subagent loading and unrelated startup code.

> **Trust boundary:** Separate Pi processes and conversation context do not sandbox tools or the filesystem. Pi subagents share the parent worktree and host authority. Give concurrent workers non-overlapping file, module, or responsibility ownership. A worker must preserve unrelated changes and stop when ownership overlaps. Attach only trusted Pi persona extensions. Cursor Cloud uses remote repository and configured MCP permissions. Cursor does not receive Pi extensions or Pi skills. Repository access does not automatically expose uncommitted or local-only worktree state. Parent prompts, context, and bounded fork summaries transfer to Cursor Cloud. Explicitly supplied text can describe or contain local changes. Credential redaction is a mitigation, not a complete data-loss boundary.

## Context, results, and limits

Full subagent conversations, thinking, and tool activity stay outside the parent model context. The parent receives the newest useful response.

Parent `list` and `status` text includes reusable names, runtimes, statuses, lifetimes, purposes, and active blocker data. Tool-result details can include IDs, model settings, repository refs, timestamps, warnings, artifacts, and runtime metadata.

The following limits apply:

- Parent `context` input: 8,000 characters.
- Cursor formatted context and request: 6 KiB after redaction, as one input.
- Cursor initial bootstrap: 24 KiB.
- Cursor follow-up: 6 KiB.
- Panel transcript item: 100,000 characters.
- Panel transcript: 200 items and 500,000 aggregate characters.
- Panel details: 24,000 characters.
- Parent-visible subagent response: 400 lines or 16 KiB.
- Parent-visible subagent error: 2,000 bytes.
- Cursor expected MCP names: 8 after deduplication.
- Cursor repositories: 20 after deduplication, including the primary repository.
- Cursor artifacts: 50 metadata records.
- Cursor active runs: 1 per agent.
- Parent-session concurrent subagent work: 4 instances.
- Parent-session retained subagents: 20 non-stopped instances.

The supported SDK sources do not document an account or Team concurrency limit. This document does not state one.
