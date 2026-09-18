# Pi integration

## Status

The Hari harness is TypeScript software under `harnesses/hari` in pi-squared. It
is hosted by native Pi. Hari is the named agent who uses this harness. The harness
reuses Pi and pi-squared seams rather than forking Pi or duplicating workspace
lifecycle code. `bin/hari` activates it. An ordinary Pi launch does not. This
describes implemented role boundaries, not a promise that every native or external
path has been exercised interactively.

## Roles and resources

The Hari harness configures explicit resources and disables ambient extension,
skill, prompt-template, theme, and context-file discovery.

| Role | Explicit resource order | Active responsibility |
| --- | --- | --- |

The global adapter invokes the native workspace extension factory but passes
through only the unchanged `create_workspace` tool. The adapter drops the
workspace extension's other tool, command, shortcut, and event registrations.
The harness therefore omits `/ws` and workspace lifecycle hooks from Hari's
conversation.

Managers retain the native workspace lifecycle, including session and lease
handling. Their profile selects Pi's native coding prompt with explicit empty
system and append overrides, so ambient `SYSTEM.md` and `APPEND_SYSTEM.md` files
are not loaded. The workspace extension adds stable workspace guidance and its
conditional PM hint. The Hari harness then appends stable manager
responsibilities. Explicit tool guidance and skill listings remain in Pi's prompt.
Fresh helpers use their own profile, not a copy of the manager profile.

Init and launch validate bundled entry files and explicit overrides. A role with
missing expected registered tools fails closed. By default, the harness derives
workspace and subagent resources from the pi-squared checkout that contains it. It
does not require `piw` on `PATH` or sibling-checkout discovery. Explicit advanced
and saved resource settings remain supported without automatic migration.

## Workspace and manager launch

The Hari harness exposes `create_workspace` only for an explicit absolute project
repository path outside the Prime Radiant at `~/Projects/primeradiant`. The tool
returns an inactive prepared workspace. Hari then records the agreed checkout and
branch with `hari_manager_create`. `hari_manager_launch` starts or resumes only
after the user asks.

Generic `launch_pi` is blocked in Hari roles because it bypasses the harness
profile and exact-session checks. A sent terminal command is not evidence that Pi
started or that a manager reconciled current work. Terminal launching uses the
available macOS integration. No Linux-terminal support is added. The harness can
generate the internal fallback `hari internal manager <start|resume> <project>
<manager>` for a manual Linux invocation. It is not a public coordination workflow
or terminal launcher.

Before activation, the native workspace seam validates the explicit checkout,
branch, and expected session. The Hari harness also verifies the recorded project
and manager identity. A manager does not silently replace a missing session or take
another manager's identity. Native manager session switching, forking, and
replacement are rejected. Reload keeps the valid workspace lease. Normal exit
releases it.

## Context and helpers

Hari's harness supplies his stable role prompt with explicit tool and skill
guidance. Its `before_agent_start` hook replaces Pi's prompt, but does not read or
embed the live project index, priorities, or decisions. Existing tools such as
`hari_projects` retrieve current facts on demand. The harness adds no recurring
snapshot message. Coordination changes therefore leave its stable system prefix
concerns.

Manager system instructions contain no live assignment or source snapshot.
`manager_context` returns the full current assignment, criteria, constraints,
decisions, checkout guidance, and source observation as a tool result instead.
The tool result does not repeat the system prompt or skill listings.

Before guarded source actions, helper dispatch, or a report, the Hari harness
requires a complete successful tool result in model context and checks current
coordination and source state. The final `context` hook checks the result's
signature and full text. The hook does not change messages, add snapshots, or alter
memory. If the view is absent after compaction or context changes, dependent work
blocks until a valid full view is available again. Historical memory is not a
substitute.

Changed assignment, decisions, guidance, or externally changed source require
`manager_context` again. A still-visible, applicable view can be reused across
requests. The manager's own successful source progress advances the source check
without forcing another read. There are no background notifications or automatic
manager wakes.

Managers may use the existing subagent extension. The Hari harness role extension
preserves caller task context and adds a bounded current handoff. It does not create
a helper registry, spawner, or alternate persona system. Fresh helpers use the
extension's own minimal resources. Sharing a checkout is an advisory ownership
boundary, not a sandbox. Required caller context is not truncated: the Hari
character limit and the Cursor byte limits can each reject an oversized dispatch.
The caller must narrow the task or context before retrying.

## Data boundaries

The **Prime Radiant** at `~/Projects/primeradiant` is Hari's durable home. The
global Hari-harness launch runs there, with Hari's coordinator sessions under
Radiant also holds his structured coordination knowledge and manager reports under
`projects/.../reports`.

Pi owns native session mechanics. The workspace extension owns manager workspace
session and lease mechanics at prepared source workspaces. Project source,
credentials, external evidence, and manager sessions are not relocated into the
diagnostic logs can also remain outside it. Those logs are diagnostics, not Hari's
durable memory, and no relocation is implied. Generic Hari harness code, docs, and
skills under `harnesses/hari` are software resources, not Hari's private memory.
Company-specific guidance belongs in the Prime Radiant and is not automatically
loaded, written, or checkpointed by the harness. The current Git tool handles
recognized structured coordination records, not arbitrary company guidance.

The operating principles are in [the operating model](harness-operating-model.md).
Deferred work is in [future.md](future.md).
