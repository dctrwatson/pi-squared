# Using Hari

Use `hari init` once, then bare `hari` to meet Hari in his global durable home,
the **Prime Radiant**. Tracking, inbox capture, manager control, and local
checkpoints happen through conversation. Hari has initiative within agreed
authority, but he does not run a background watcher.

## Install and requirements

From the pi-squared root:

```bash
npm ci
export PATH="$PWD/bin:$PATH"
```

The root `bin` directory contains `hari` and `piw`. Add it to shell configuration
if useful. No global npm installation is required. An ordinary Pi launch does not
load or activate Hari.

The Hari harness needs:

- Node 22.19 or newer, Git, and `pi` on `PATH`
- Root dependencies installed with `npm ci`
- `gh` access only for requested GitHub observations

by default. Setup validates them before use. It does not use `piw` on `PATH` or
sibling-checkout discovery. The workspace launcher must provide the required public
pre-activation capability. Missing required resources or tools block the affected
role rather than falling back to an ambient Pi configuration.

## Set up the Prime Radiant

```bash
hari init
hari
```

Hari's durable home is always the Prime Radiant at `~/Projects/primeradiant`.
`hari init` creates or adopts it and keeps runtime files under `.hari/` out of Git.
Repeated init preserves existing coordination history and pending changes. Setup
refuses unrelated nonempty content, source repositories, nested Git repositories,
and linked worktrees rather than overwriting them.

Use `hari init --pi-squared <checkout>` only to explicitly override bundled
also advanced resource settings. Existing saved resource settings remain in use.
Init does not silently replace or migrate them. None selects another Prime Radiant
location.

There is no coordination-directory option. `--coordination` is unrecognized and
`HARI_COORDINATION_DIR` is ignored. Old coordination locations and saved
coordination selections are not read.

The Hari harness creates no Prime Radiant remote and does not fetch, pull, or push.

## Records and local checkpoints

```text
~/Projects/primeradiant/
├── PROJECTS.md
├── INBOX.md
├── projects/<project>/PROJECT.md
├── projects/<project>/reports/<manager>.md
└── .hari/
```

The Prime Radiant holds Hari's coordinator conversations and their
knowledge and local checkpoints. The index and project records hold authoritative
JSON metadata and a checked generated Markdown view. Use the update tools rather
than editing that view by hand. Manual edits are detected, not silently
overwritten. Managers own their reports at `projects/<project>/reports/<manager>.md`.

Project source remains in its own repository. Managers retain their native
workspace sessions and mechanics at their prepared source workspaces. The Prime
Radiant does not relocate credentials, source repositories, external evidence, or
all manager sessions into one Git repository.

The Hari harness Git tool can inspect and checkpoint recognized structured
records. It does not automatically load, write, or checkpoint company-specific
skills, glossary material, or other guidance stored in the Prime Radiant. Keep
generic Hari harness code, docs, skills, and glossary material under
`harnesses/hari` in pi-squared. These harness resources are not Hari's private
memory. Keep company-specific knowledge, conventions, skills, and glossary material
in the Prime Radiant. These locations guide authorship. They are not an automatic
loading or publishing mechanism.

Update tools immediately save their record-file changes. Hari decides when
meaningful coordination work warrants a local checkpoint. Existing staged changes
or uncertain Git results stop for inspection. The harness does not reset the index
or rewrite history.

## Coordinate work

Ask Hari in ordinary language to capture an inbox item, track an issue, catch up
on a project, inspect local record changes, or save a checkpoint. Hari uses
judgment within agreed authority to retrieve relevant records, weigh coordination
consequences, and make recommendations without making the user relay context
between sessions. The harness does not paste live coordination state into Hari's
system prompt or automatically inject it as a snapshot each turn. Hari uses
`hari_projects` for the current index or a selected project when needed, and
retrieves other detail on demand. Missing, stale, or uncertain facts need
retrieval before dependent coordination actions. Hari's memory does not override
current records. Large record previews name `hari_record_page` as the recovery
path. Start that record at offset 0, then use the `nextOffset` in each page's
visible footer with the same record arguments until `eof=true`.

GitHub reads are on demand and read-only. A full issue URL or `owner/repository#123`
identifies its repository. A bare `#123` or `123` needs an explicit repository or a
project repository preference recorded in the Prime Radiant. Hari has no default
tracking repository. PR discovery considers only explicit project repositories and
tracked issue links. He returns a bounded snapshot, not a continuous scan or a
review obligation.

## Prepare and run a manager

Before manager launch, agree the outcome, non-empty acceptance criteria,
constraints, prepared checkout, branch, and applicable authority. Hari can use
`create_workspace` with an explicit absolute project repository path outside the
Prime Radiant. The returned workspace is inactive.

Record the assignment with `hari_manager_create`. It does not launch anything.
On the user's later request, `hari_manager_launch` starts or resumes the manager.
Generic `launch_pi` is blocked for Hari roles. A terminal request is not proof
that the manager started.

The manager launch checks the recorded checkout, branch, native workspace session,
and manager identity before activation. It does not silently repair a missing
session or take another manager's session. Native manager session switching,
forking, and replacement are blocked. A valid reload retains the workspace lease
and normal exit releases it.

Managers keep Pi's coding prompt and stable workspace guidance, with manager
responsibilities from the Hari harness appended separately. Ambient system and
context files remain disabled. Live assignment facts and checkout guidance are not
in this system prompt. Managers read them through `manager_context` before
dependent work.
The full successful result must be visible in model context, not just in memory.
A missing view or changed coordination/source state requires a valid current view
before guarded source actions, helper dispatch, or reports. Still-visible,
applicable results can be reused without another snapshot each turn.

Managers retain the native workspace PM skill and active tool guidance from their
explicit workspace resource. They may use the existing optional `subagent` tool
for bounded help. Helpers share the prepared checkout and are not a second manager
or a sandbox. The manager retains acceptance responsibility and must avoid
overlapping writes.

The Hari harness role extension adds compact current authority and a bounded source
summary to prompted helper dispatches while preserving the caller's task context.
Oversized required handoffs block rather than silently truncate. Cursor also
checks its smaller byte limits after credential redaction, before dispatch.
A rejected request needs a narrower task or context, not an unchanged retry.
Dormant helper
controls do not require a full context refresh. Fresh helpers use the existing
helper profile, not a cloned Hari manager role profile.

## Current limits

- The public CLI workflows are only `hari init` and bare `hari`.
- Native `/new` and `/resume` remain available in Hari. Managers continue through
  Hari so their recorded identity remains intact.
- Manager resumption and waking are user-controlled. No timer, notification, or
  record change starts work.
- GitHub mutation, source push, merge, deployment, and live-system actions need
  separate authority and are not Hari defaults.
- Authority checks and ownership boundaries are advisory. Shell access is not a
  permission grant or sandbox.
- A commit, CI result, merge, deployment, operational validation, and acceptance
  remain separate facts. Follow applicable repository and assignment evidence
  obligations.
- Concurrent shared-record writers, automatic repair, strict memory projection,
  exceptional child reassociation, multi-checkout orchestration, and Linux terminal
  launching are not current guarantees.

See [Pi integration](../design/harness-pi-integration.md) for the implemented
resource and session boundaries and [future options](../design/future.md) for
narrow deferred ideas.
