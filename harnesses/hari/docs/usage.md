# Using Hari

## Setup

From the pi-squared root:

```bash
npm ci
export PATH="$PWD/bin:$PATH"
hari init
hari
```

Requires Node 22.19 or newer, Git, and `pi` on `PATH`; GitHub reads also need `gh`.
`hari init` creates or adopts `~/Projects/primeradiant`, the **Prime Radiant**.
Repeated init preserves records, history, and pending changes. Bare `hari` opens
Hari there. Ordinary Pi launches do not load Hari.

Workspace and subagent resources come from this checkout. Resource overrides are
`hari init --pi-squared <checkout>`, `--pi`, and `--workspace-launcher`. Saved
settings remain in use; they do not change the Prime Radiant location.

## Start with your projects

One Hari coordinates all your projects from the same Prime Radiant. Start with a
compact view of projects, repositories, commitments, dependencies, blockers, and
pending decisions. Use existing records and add missing projects. For example:

> Help me organize all my projects. Read the current project index and inbox,
> help me add missing projects, and show commitments, blockers, and decisions
> that need my attention. Let's agree priorities and next actions. Do not launch
> or resume managers until I ask.

Ask Hari to capture notes, track issues, update project state, and record decisions.
He retrieves project details as needed. You choose priorities across projects and
which work to assign next.

## GitHub work, following, and notifications

Hari reads your authored and assigned issues and PRs across GitHub, plus review
requests. Following records interest separately from assigned work. For example:

> Show my open issues and PRs, including assignments and review requests.

> Follow `<issue-or-PR-URL>` because I care about the new cache API.

> Digest my unread notifications. Separate things needing my attention, updates
> to items I follow, and other things I may be interested in.

> Digest these notifications, but leave them in my GitHub inbox.

Follows and optional interest notes are saved locally in `FOLLOWING.md`. They do
not create projects, assignments, or GitHub subscriptions. Ask to stop following
an item when it is no longer relevant. Hari can refresh followed items even when
they have no notification.

Digests include links and relevance reasons. Hari can inspect selected threads
and issue/PR details. After presenting a digest, Hari marks the included
notifications **Done**, removing them from your GitHub notifications inbox unless
you ask to keep them there. He finishes page reads before marking anything and
leaves notifications not covered by the digest unchanged. The issues, PRs, and
local follows remain unchanged. Suggested follows remain your choice. Reads are
on demand, with no background polling.

Use issue/PR URLs for follows and PR references. Issue lookup also accepts
`owner/repository#123`; bare issue numbers need an explicit or recorded repository.

## Prepare and run a manager

1. Agree the outcome, acceptance criteria, constraints, checkout, branch, and
   authority.
2. `create_workspace` prepares an inactive workspace in the selected source
   repository, outside the Prime Radiant.
3. `hari_manager_create` records the assignment without launching it.
4. When you ask, `hari_manager_launch` starts or resumes the manager.

Managers continue through Hari with their recorded checkout and native session.
Hari supports native `/new` and `/resume`. Managers can use workspace PM support
and bounded helper subagents while retaining assignment ownership.

Managers read live assignment and source facts through `manager_context`.
If the view is missing or state changes, guarded work requires a fresh view.
An applicable visible result can be reused.

See [Pi integration](../design/harness-pi-integration.md#manager-launch) for session
checks and the manual Linux launch command.

## Learn from work

Ask about a selected manager's session when you have a useful question:

> Inspect project `<project>` manager `<manager>` for a missing reproduction
> command in Hari's blocked-work handoff. Return observations and source references.

Hari uses the read-only `hari-session-observer` Pi persona through `subagent`.
The observer examines Hari's assignments, context, guidance, and harness behavior,
not implementation correctness. It does not resume the manager or replace reports.
Hari can reuse an observer, check its status, and stop it on request.

### Keep and deliver guidance

Hari keeps useful candidates in project-linked inbox notes with
`hari_capture_inbox` or `hari_update_inbox`. A note can use this format:

> Candidate: Include the exact failing command in a blocked-work handoff.
> Evidence: project/manager, session reference, and entry IDs.
> Applies when: another manager must reproduce that local failure.
> Expected benefit: fewer requests for the missing command.
> Review: the next applicable handoff. Disposition: not yet reviewed.

Before a related assignment, Hari reads relevant notes and corrects his own
preparation first. Execution-relevant advice goes under `Applicable learned
guidance` in the assignment, with usable text, scope, limits, and source.
The manager receives it through `manager_context` without old conversations.

Note edits do not alter existing assignments. Use `hari_manager_amend` for an
agreed assignment change; it requires a fresh manager view. Keep hypotheses and
practices to test separate from authoritative decisions.

### Review an adaptation

At a relevant opportunity, ask Hari to review the note against a later manager's
session and the expected benefit. Check separately:

| Question | Evidence |
| --- | --- |
| Delivered | Usable guidance was in the manager's received context. |
| Applicable | The situation where it should help occurred. |
| Used | The session supports that the manager followed it. |
| Outcome | Expected benefit, adverse effects, and alternative causes. |

Hari records `retain`, `revise`, `remove`, or `inconclusive` in the same note,
with a reason and source. Remove superseded guidance from future assignments.
Your explicit preferences remain instructions, not experiments.

## Records and checkpoints

```text
~/Projects/primeradiant/
├── PROJECTS.md
├── INBOX.md
├── FOLLOWING.md
├── projects/<project>/PROJECT.md
├── projects/<project>/reports/<manager>.md
└── .hari/
```

Use record-update tools for generated record views. Updates save immediately;
ask Hari for a local checkpoint when useful. `hari_git` handles recognized records
and manager reports, not runtime files or arbitrary company guidance. Existing
staged changes stop a checkpoint for inspection. Prime Radiant Git has no remote
operations.

Managers own their reports. Source and manager sessions remain in prepared
workspaces; coordinator sessions live under `.hari/sessions`. Keep private
coordination knowledge in the Prime Radiant and generic harness resources under
`harnesses/hari`. Company guidance is not loaded or checkpointed automatically.

For large records, `hari_record_page` starts at offset 0; follow `nextOffset`
until `eof=true`. Session evidence uses `hari_session_evidence` with the returned
`nextOffset` and same `view`. Changed evidence requires a restart from offset 0.
See [Pi integration](../design/harness-pi-integration.md#session-observation) for
evidence format and size limits.
