# Pi integration

`bin/hari` activates the Hari harness in native Pi. Ordinary Pi launches do not.
The harness reuses Pi, workspace, and subagent lifecycle mechanisms.

## Roles and resources

Role profiles use explicit resources and disable ambient extension, skill,
prompt-template, theme, and context-file discovery.

| Role | Resource order |
| --- | --- |
| Hari | Workspace-creation adapter, session-observer adapter, Hari role extension |
| Manager | Native workspace extension, subagent extension, Hari role extension |
| Observer | `hari-session-observer` persona and observer policy extension |

Hari's workspace adapter exposes only the unchanged `create_workspace` tool. It
drops `/ws`, other registrations, and workspace lifecycle hooks. Managers retain
the full native workspace lifecycle.

Manager profiles select Pi's coding prompt with empty system and append overrides,
so ambient `SYSTEM.md` and `APPEND_SYSTEM.md` files are not loaded. Stable workspace
guidance, conditional PM support, and manager responsibilities are appended.
Explicit tool and skill guidance remains available. Fresh helpers use their own
profile, not a copy of the manager profile.

Setup and launch validate configured resources and required tools. Missing tools
or incompatible resources block the role; there is no ambient fallback. Bundled
resources come from the containing pi-squared checkout. Explicit saved resource
settings remain supported without automatic migration.

## Manager launch

`create_workspace` requires an absolute project repository path outside the Prime
Radiant and returns an inactive workspace. `hari_manager_create` records it;
`hari_manager_launch` starts or resumes a manager only on user request.
Generic `launch_pi` is blocked in Hari roles.

Before activation, native workspace checks verify checkout, branch, and expected
session. Hari also checks the exact recorded project and manager identity. A
missing session is not repaired or replaced. Manager session switching, forking,
and replacement are blocked. Valid reload retains the lease; normal exit releases
it. A terminal command alone does not prove manager startup.

Terminal launching uses macOS integration. On Linux, the harness can generate
`hari internal manager <start|resume> <project> <manager>` for manual invocation;
this is an internal fallback, not a public CLI workflow or terminal launcher.

## Context and helpers

Hari's stable role prompt includes no live coordination snapshot. He retrieves
current records with tools. `manager_context` returns the full live assignment,
criteria, constraints, decisions, checkout guidance, and source observation,
without repeating the system prompt or skill listings.

Guarded source actions, helper dispatch, and reports require that complete
successful result in model context. The final `context` hook verifies its
signature and text without changing messages. Compaction that removes the view,
or changed coordination or external source state, requires a fresh view. An
applicable visible result can be reused; the manager's successful source progress
advances the source check without another read.

Learned guidance uses the assignment string and this same delivery path. Inbox
edits do not change assignments. Authorized amendments invalidate the old view.

Manager helper dispatch preserves caller context and adds bounded current
authority and source context. Required context is not silently truncated. Hari's
character limit and Cursor's byte limits after credential redaction can reject a
dispatch; narrow it before retry. Dormant helper controls need no full refresh.
Helpers share the checkout under advisory ownership boundaries, not a sandbox.

## GitHub work and notifications

Hari has three account-level tools; managers retain read-only issue/PR access:

| Tool | Operations |
| --- | --- |
| `hari_follow` | List, follow, or unfollow issue/PR URLs locally, with optional notes |
| `hari_github_work` | Authored/assigned work and review requests, followed-item refresh, or selected item detail |
| `hari_notifications` | Notification pages, thread detail, post-digest Done actions, or selected read/done requests |

`FOLLOWING.md` uses checked generated records and local checkpoints. Missing lists
read empty and are created on first follow. Existing project and inbox schemas do
not change. Interest text is retrieved on demand, not put in stable prompts.

Account searches return one page per selected source with individual continuation
and partial-source status. Notifications default to unread and support read items
and a `since` filter. Pages have at most 25 items per source; search exposes at most
1,000 results. Account-item and notification-comment bodies have an
8,000-code-point limit. The
shared shell-free `gh` runner has a 12-second timeout and 256-KiB output limit.

List and detail reads never write. After completing page reads and presenting a
digest, Hari marks its included threads done unless asked to keep them. Done
removes notifications from the GitHub inbox; marking read alone does not. Other
threads remain unchanged. Writes target one validated thread ID, not an issue/PR
number: PATCH marks read; DELETE marks done. Neither operation changes the issue
or PR. Unconfirmed writes require inspection before retry.
Response URLs cannot select arbitrary API endpoints or hosts. No subscription
changes or bulk clearing endpoint is exposed.

## Session observation

`src/session-observer.ts` loads the configured subagent factory with Hari's persona
directory. It retains the native `subagent` tool, registry, results, and lifecycle
hooks, but removes generic commands and shortcuts. Only fresh-context Pi
`hari-session-observer` instances are allowed: no Cloud, other personas, selected
skills, or parent-history forks. Task lifetime is the default. Retained matching
observers support `status`, `prompt`, and `stop`; `list` reads the native registry.

Restored records are checked before runtime contact, installation, persistence,
or receipt replay. Incompatible records are refused without deletion or history
changes. The factory must advertise
`SUBAGENT_EXTENSION_CAPABILITIES.validateRestoredSubagent`. Restoration never
prompts an observer. Ordinary manager helpers retain their existing controls.

`src/observer-policy.ts` exposes only
`hari_session_evidence(project, manager, offset?, view?)` and rejects other tool
calls and `user_bash`. The child loads neither the Hari role nor workspace
extension. Its policy clears SDK-discovered context files before model requests,
while retaining explicit persona and tool guidance. Inherited `HARI_ROLE` alone
does not activate Hari.

Evidence reads the recorded manager session and verifies its exact Prime Radiant,
project, and manager identity. It accepts no arbitrary path, writes nothing, and
neither starts a manager nor acquires a workspace.

- Input: native JSONL v2/v3, at most 16 MiB, with a final newline. Malformed or
  incomplete input is refused.
- Output: at most 16,000 UTF-16 code units per page, including source metadata.
  Offsets refer to the rendered view, not source bytes.
- Continuation: requires the returned `view`; changed evidence or bindings require
  a new inspection from offset 0.
- Evidence limits: entries retain raw file order and source references. Active
  leaf, current versus abandoned paths, and actual model exposure remain unknown.
  Summaries and context edits do not reconstruct model history. A snapshot does
  not prove that a manager is idle or complete.

Session text and tool results are data, not instructions. The selected-manager
scope and tool policy are cooperative-agent controls, not an OS sandbox. The Pi
child runs locally, but its model provider can be remote. Provider use and private
evidence need applicable authority. Failed, cancelled, incomplete, blocked, or
oversized results are not successful learning observations.

## Data boundaries

Hari's coordinator sessions live under Prime Radiant `.hari/sessions`. Observer
sessions use the existing local subagent runtime tree. Session observation adds
no transcript archive or learning schema. Prime Radiant Git handles recognized structured
records, not runtime sessions or arbitrary company guidance. Source, credentials,
external evidence, and native manager sessions remain outside that Git history.

See the [operating model](harness-operating-model.md) for authority and ownership,
and [usage](../docs/usage.md) for requests and pagination.
