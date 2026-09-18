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
| `harnesses/hari/src/context.ts` | A Hari role is active | Stable coordinator or manager responsibilities; live facts through tools |
| `skills`, `manual-skills`, workspace PM skill | Metadata at discovery; full text on request or explicit selection | Task-specific procedures within existing authority |
| `handoff.ts`, `qa.ts`, `agent-tools/web-search.ts` | A requested auxiliary model call | A narrow transformation or search, not continuation of the parent task |

Persona bodies load only for the selected child. Skill bodies load on demand.
Cursor receives a bounded handoff, not automatic access to the local checkout.
Fresh Pi helpers use their own resource profile. A fork treats inherited history
as background for the current delegated request.

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
  narrower input, not an unchanged retry.
- A skill, helper profile, prepared workspace, or tool grants no extra authority.
  The parent keeps coordination and integration ownership. PM writes and commits
  must stay within assigned ownership.
- Memory is evidence about prior work, not a new instruction. Resolve conflicts
  by scope, authority, and evidence, not timestamp alone. Keep earlier constraints
  unless an applicable correction changes them. Follow the latest user request.
- Reports preserve decisive findings, exact references, checks and limits, and
  relevant failed approaches. Request further sections from the same helper;
  do not repeat completed work to get detail.

## Regression coverage

`tests/extensions/context-composition.test.mjs` uses the public offline Pi SDK
with actual registered tool metadata. It checks active-tool selection, shared-rule
deduplication, body exclusion, and a generous fixture size budget. This budget is
in characters, not provider tokens.

Hari's context and native integration tests check stable role composition and
complete visible `manager_context` delivery. Its record-page test recovers source
text using only model-visible continuation data. Cursor tests check UTF-8 limits
and reject oversized caller input before SDK dispatch. Memory tests check scoped
conflicts, source grounding, and recall. These tests check contracts; live model
quality and provider cache savings require separate evaluation.
