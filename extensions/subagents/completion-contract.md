# Subagent completion contract

Pi and Cursor Cloud subagents use the shared guidance in [completion.ts](completion.ts). This page gives more details for reference. It is not loaded into each subagent context. Pi receives the full guidance at process start, including restored sessions. Cursor receives it at bootstrap and receives a shorter reminder on each follow-up.

The contract helps subagents give evidence to the parent. Persona restrictions, permissions, exact output contracts, and lifetime behavior remain in effect.

## Execution and evidence

- Treat each request as bounded work, even when the subagent retains context for later requests. Read the objective, acceptance criteria, ownership, dependencies, and known failed approaches before work.
- Keep exploratory reasoning, scratch work, routine progress, and tool logs inside the subagent context. Return evidence and conclusions, not a transcript.
- Check command exit status, signal, timeout, and capture completeness. Read omitted output before relying on it. Do not describe not run, aborted, timed out, or not captured as passed.
- Preserve exact paths, symbols, before/after values, units, versions, flags, environment variable names, errors, and supplied SHA length. Exclude secret values. Preserve whether another actor reported a result or the subagent verified it.
- Distinguish local edits, commits, merges, and deployment. Do not claim another worker's changes or infer a root cause from a symptom.
- Do not repeat an unchanged known failed approach unless the caller authorizes a discriminating retest. Preserve failed alternatives even when another approach succeeds.
- Report fields do not authorize extra work. A reviewer must not suggest fixes or run tests to fill a field. An explorer must not create files to supply an artifact. Cursor Cloud remains in Plan mode with its existing no-change instructions.

## Identity and scope

Copy supplied instance, task, and run identifiers exactly. Omit absent IDs; do not invent them or use a persona name as an instance ID. The prompt does not supply missing registry or run IDs automatically.

State the task briefly so the report stands alone without the original request. Include workspace, branch, revision, platform, and versions when they affect the result. State `unknown` or `not run` when that gap affects the result; do not fill irrelevant fields with placeholders. Omission means not reported, not `none` or `passed`.

## Status

| Status | Meaning |
| --- | --- |
| `SUCCESS` | The assigned objective and required checks are complete. A completed review or investigation can succeed without edits. Findings about defective code do not make a completed review a failure. |
| `FAILURE` | An attempted objective or required check failed. |
| `BLOCKED` | A missing prerequisite prevents completion. Include partial work and the requirement needed to continue. |

Do not use `SUCCESS` for unrun required checks. Select the status for the assigned scope, not for the whole project. Preserve both a failed check and a current blocker when both apply.

These are report labels, not new registry states. The existing blocker parser still requires the first two nonblank lines to be:

```text
BLOCKED: <reason>
NEEDS: <minimum requirement>
```

Put these lines before any report heading. `Status: BLOCKED` inside a report is not sufficient. The parser and blocked one-shot retention behavior are unchanged.

## Negative Knowledge

Retain relevant negatives even after success. Use `none observed` when that fact matters and no negative was found. Do not add an empty field to every reply. Do not turn a check that was not run into negative evidence.

| Kind | Meaning |
| --- | --- |
| `FAILED` | An approach failed under the stated conditions. |
| `RULED_OUT` | A discriminating test rejected a hypothesis within that test's scope. |
| `INCONCLUSIVE` | There was no reproduction or insufficient evidence; the hypothesis remains open. |
| `REJECTED` | An authorized decision rejected an approach for a stated reason, not necessarily because it fails technically. |

For each independent negative, retain the approach, exact conditions, result or error, evidence, and supported retry condition. If the retry condition is unknown, say so. Mark suspected causes as suspected. Exit 137 alone does not establish OOM. Zero reproductions on macOS/arm64 do not resolve a Linux/amd64 failure.

## Default report

Lead with a short task/status line and the requested result. Include supplied identity and relevant evidence. Use labels or bullets when they help; there is no mandatory field checklist. Omit empty or irrelevant sections, not decisive facts, failed approaches, or validation gaps.

Preserve required finding order and citations. If the persona or caller requires an exact output format, such as JSON, honor it without an extra Markdown wrapper. Report fields do not authorize extra work.

For example, an investigation can end with this blocked report:

```text
BLOCKED: CI kernel log is unavailable.
NEEDS: Kernel log for the Linux/amd64 run with exit 137.

mem-3 (name-only); BUG-91 — Identify the Linux/amd64 CI exit 137 cause: BLOCKED.
Exit 137 is observed; OOM remains unconfirmed. Revision unknown.
Validation: npm run repro -- --seed=42 on macOS/arm64 exited 0 in all 5 attempts; complete local output.
Negative Knowledge: INCONCLUSIVE — the local result does not resolve the Linux/amd64 failure; retry condition unknown.
```

On follow-up, return the requested section or new evidence, changes, and validation. Do not repeat the full report or completed investigation. Keep supplied identity and task scope clear, with any constraints or evidence limits that affect the new request. A successful detail request does not resolve an earlier blocker unless new evidence establishes that change.

## Progressive discovery and delivery

Use concise reports without an arbitrary word or token quota. For extensive results, return an overview with a numbered section index. Keep decisive findings, constraints, negative knowledge, and validation limits in the overview. Supply supplemental evidence in requested sections without repeating completed work. Report length alone is not a blocker. Do not create artifacts solely to shorten a report.

When further sections are available, put this marker on the first nonblank line, after the `BLOCKED`/`NEEDS` preamble when blocked:

```text
DETAILS_AVAILABLE: 1. Findings; 2. Validation evidence; 3. Failed alternatives
```

Then give the overview in the required report format. Omit the marker when no sections remain or an exact output contract forbids it. A one-shot that offers further sections becomes a task so the Manager can request them.

The tool delivers a whole response inline if the response and delivery metadata fit within 16 KiB and 400 lines. For a larger result, it returns a continuation notice without a cut-off report body. It preserves blocker and warning metadata and keeps one-shots available as tasks. The Manager uses `action: "prompt"` with the same subagent to request a concise overview and numbered section index, then the required sections. If a section is still too large, request a narrower section. A continuation notice is not evidence that the Manager has received the report.

These are inline delivery thresholds, not report-generation limits. Backend capture retains its existing 1 MiB safety cap; incomplete results are identified. Keep the subagent until required evidence is in the parent conversation. Stopping it can remove the follow-up path. The parent does not receive worker-private transcripts.

Cursor follow-up reminders share the existing 6 KiB request budget. The full contract is not repeated on each follow-up. Tests bound fixed prompt overhead and check that the shared blocker and continuation rules are added once per request; these checks are not report-length quotas. This change does not validate model-generated report semantics or archive private transcripts.
