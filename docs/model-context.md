# Model context

This map covers repository-owned context. Pi's base prompt, host instructions,
user-global resources, provider serialization, and external MCP descriptions are
separate inputs. Do not assume that a source-string check measures the complete
provider request or proves model behavior.

## Context sources

| Source | When it enters context | Responsibility |
| --- | --- | --- |
| Repository `AGENTS.md` | Context-file discovery or an explicit read | Repository constraints and required checks |
| `extensions/agent-tools` | While each tool is active | Call contracts, bounded output, error and artifact recovery |
| `extensions/subagents` | Active tool metadata; selected child profile; dispatch and completion | Scope, ownership, continuity, and concise evidence reports |
| `extensions/workspace` | A session owns its workspace | Stable coding guidance and the conditional PM skill hint |
| `extensions/bundle-loader.ts` | Registry at extension load; manifests and adapters only after `/bundle name`; skills use native discovery, deferred tools use native `tool_search` | Explicit, temporary resources; `/bundle` only shows bounded read-only UI state; no bootstrap or model-callable loader |
| `skills`, `manual-skills`, workspace PM skill, selected bundle skills | Metadata at native discovery; full text on request or explicit selection | Task-specific procedures within existing authority |
| `handoff.ts`, `qa.ts`, `agent-tools/web-search.ts` | A requested auxiliary model call | A narrow transformation or search, not continuation of the parent task |

Persona bodies load only for the selected child. Native skill discovery adds metadata,
not skill bodies; Pi loads bodies on demand. `/bundle` displays bounded read-only
state; only `/bundle name` adds resources after explicit user action. Selection does
not change settings, install extensions, or run installers. Adapter code is trusted,
not sandboxed. It runs only after selection and must not register commands, mutate
prompts or session state, or start long-lived resources at import or creation. The
loader sets omitted tool exposure to `deferred`, uses native `tool_search`, and
preserves explicit exposure such as `model-only`. Selection is additive and
idempotent. Reload preserves it only when the session identity stays the same. A
new, resumed, forked, or restarted session has no prior selection.

Cursor receives a bounded handoff, not automatic access to the local checkout. Fresh
Pi helpers use their own resource profile. A fork treats inherited history as
background for the current delegated request. Generated handoffs state that bundle
activation does not carry into the destination and must not auto-activate bundles,
even when the source has no skill metadata. Relevant bundle skills can be named for
on-demand reading.

## Composition rules

- Give each layer one job. Tool snippets identify capabilities; descriptions and
  schemas explain calls. Flat `promptGuidelines` must name the relevant tool.
  Identical shared guidelines allow Pi to remove duplicates.
- Keep assignments, branch state, timestamps, and retrieved records out of stable
  role text. Retrieve needed facts on demand and reuse applicable visible results.
- Put provenance, continuation offsets, errors, and evidence limits in tool
  `content`. Pi uses `details` for state and rendering; it is not normal model
  context. TUI collapse does not shorten model-visible content.
- Bound source output and provide a recovery path. Do not silently truncate
  required authority or caller instructions. A rejected oversized handoff needs
  narrower input, not an unchanged retry. Bundle lists show at most 40 entries and
  keep diagnostics in the UI; skill metadata has a 16,000-character limit. Skill and
  tool name collisions are rejected.
- A skill, helper profile, prepared workspace, or tool grants no extra authority.
  The parent keeps coordination and integration ownership. PM writes and commits
  must stay within assigned ownership.
- Prior work is evidence, not a new instruction. Resolve conflicts by scope,
  authority, and evidence, not timestamp alone. Keep earlier constraints unless
  an applicable correction changes them. Follow the latest user request.
- Reports preserve decisive findings, exact references, checks and limits, and
  relevant failed approaches. Request further sections from the same helper;
  do not repeat completed work to get detail.

## Regression coverage

`tests/extensions/context-composition.test.mjs` uses the public offline Pi SDK
with actual registered tool metadata. It checks active-tool selection, shared-rule
deduplication, body exclusion, and a generous fixture size budget. This budget is
in characters, not provider tokens.

Cursor tests check UTF-8 limits and reject oversized caller input before SDK
dispatch. These tests check contracts; live model quality and provider cache
savings require separate evaluation.
