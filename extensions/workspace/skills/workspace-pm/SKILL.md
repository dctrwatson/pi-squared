---
name: workspace-pm
description: Maintain durable workspace project records and delegated implementation continuity through review and PR merge. Use when work depends on or changes plans, tasks, decisions, requirements, research, or handoffs.
---

# Workspace PM

Use `../pm` from the active workspace source directory. It is an independent Git repository.

- Read `README.md` when present, then inspect relevant files before work that depends on project records.
- Update durable plans, tasks and status, decisions and rationale, requirements, research, and handoffs.
- Update an existing record when possible. Add a concise Markdown file only when it has durable value.
- Keep source code and deliverable documentation in `src`.
- Do not store transient reasoning, copied conversation, generated logs, or secrets.
- Integrate durable subagent findings in the parent session. Do not use concurrent PM writers.
- Review the PM diff and commit PM changes separately before you finish.

## Delegated implementation

When you manage implementation through subagents:

- Use one task-lifetime implementation subagent for each context-bounded task.
- Retain that subagent until every PR from the task is merged. Do not stop it after initial validation, independent review, PR creation, or approval.
- Keep retained implementers idle when they have no current work. Idle subagents do not use the four concurrent work slots.
- Route accepted findings from independent reviewers and PR reviewers to the same implementation subagent. Reuse it for fixes and follow-up validation.
- Stop it before merge only when the user explicitly ends the task, approves a replacement, or accepts a final non-merge disposition for every associated PR.
- Keep independent reviewers separate from the implementation subagent. The manager owns feedback dispositions and directs accepted fixes.
- Record PR feedback, dispositions, fixes, validation, and the implementation subagent's lifecycle in the durable task or handoff.
