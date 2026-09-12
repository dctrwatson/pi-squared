export const SUBAGENT_COMPLETION_GUIDANCE = `## Completion
Answer only the current request within persona limits. Report fields do not authorize extra work. Preserve required finding order, citations, and exact output formats without an extra wrapper. Keep scratch work, routine progress, and tool logs private.
Default: a short task/status line, the requested result, and relevant evidence. Include supplied worker/task/run identity; never invent IDs or use a persona name as an instance ID. Omit absent IDs and empty or irrelevant fields. State unknown or not run when that gap affects the result; omission is not evidence of none or passed.
SUCCESS means the assigned objective and required checks are complete; a completed review can find defects. FAILURE means an attempted objective or required check failed. BLOCKED means a prerequisite prevents completion. Never label unrun checks as passed.
Preserve exact paths/line ranges, symbols, before/after values, units, versions, flags, environment variable names, errors, and supplied SHA length when relevant. Distinguish edits, commits, merges, and deployment; reported evidence from verification; symptoms from causes. Exclude secret values.
Validation: give commands, relevant environment, results, exit/signal/timeout, and capture limits. State required checks not run and why; read omitted output before relying on it.
Negative Knowledge: retain FAILED, RULED_OUT, INCONCLUSIVE, or REJECTED approaches even after success, with scope, result, evidence, and retry condition (or unknown). Say none observed when that fact matters. No reproduction is not proof of no bug. Do not repeat an unchanged failed approach without an authorized discriminating retest.
For follow-ups, return the requested section or new evidence, changes, and validation, not the full previous report. Keep identity and task scope clear; include constraints and evidence limits that affect this request.
If blocked, stop retrying. The first two nonblank lines must be BLOCKED: <reason> and NEEDS: <minimum requirement>.
For extensive results, give an overview and numbered section index. Keep decisive findings, negatives, constraints, and validation limits in the overview; supply requested detail without repeating completed work. If sections remain, put DETAILS_AVAILABLE: <numbered section index> first, after BLOCKED/NEEDS if blocked. Omit this marker when no sections remain or an exact output format forbids it. Length alone is not a blocker; do not create artifacts solely to shorten a report.`;

// Keep the follow-up reminder self-contained without repeating the report template.
export const SUBAGENT_COMPLETION_REMINDER = `Stay within persona and request limits; preserve exact output formats and citations. Return only requested sections or changes, with task scope and supplied identity; omit empty fields and absent IDs. Keep decisive findings, exact literals, validation results/limits, unrun required checks, and relevant negatives/retry conditions, even after success. Never invent IDs, causes, or verification; exclude secrets. SUCCESS requires completed work and required checks; FAILURE means an attempted objective/check failed. If blocked, stop retrying; put BLOCKED: <reason> then NEEDS: <minimum requirement> on the first two nonblank lines. For extensive results, give an overview and numbered index; put DETAILS_AVAILABLE: <section index> first (after BLOCKED/NEEDS) if more sections remain, unless an exact output format forbids it. Length alone is not a blocker. Do not repeat the full report or completed work.`;

/** Only a leading report marker requests follow-up retention. */
export function hasSubagentDetailsAvailable(text: string): boolean {
    const header = text.replace(/\r\n?/g, "\n").trimStart();
    const afterBlocker = header.replace(/^BLOCKED:[^\n]+\n\s*NEEDS:[^\n]+\n\s*/i, "");
    return /^DETAILS_AVAILABLE:[^\S\n]*\S[^\n]*(?:\n|$)/.test(afterBlocker);
}
