---
name: workspace-pm
description: Maintain durable workspace project records such as plans, tasks, decisions, requirements, research, and handoffs. Use when work depends on or changes these records.
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
