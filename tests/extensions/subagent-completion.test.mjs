import test from "node:test";
import assert from "node:assert/strict";

const completionModule = await import("../../extensions/subagents/completion.ts");
const personasModule = await import("../../extensions/subagents/personas.ts");
const cursorContextModule = await import("../../extensions/subagents/cursor-context.ts");
const blockersModule = await import("../../extensions/subagents/blockers.ts");

const {
  SUBAGENT_COMPLETION_GUIDANCE,
  SUBAGENT_COMPLETION_REMINDER,
  hasSubagentDetailsAvailable,
} = completionModule;
const {
  buildSubagentProcessArgs,
  formatSubagentContinuityPrompt,
} = personasModule;
const {
  MAX_CURSOR_BOOTSTRAP_BYTES,
  MAX_CURSOR_FOLLOW_UP_BYTES,
  buildCursorCloudBootstrap,
  buildCursorCloudFollowUp,
} = cursorContextModule;
const { parseSubagentBlockerResponse } = blockersModule;

function appendedSystemPrompt(args) {
  const index = args.lastIndexOf("--append-system-prompt");
  assert.ok(index >= 0, "Pi arguments include appended system guidance");
  return args[index + 1];
}

function systemPrompt(args) {
  const index = args.indexOf("--system-prompt");
  assert.ok(index >= 0, "Pi arguments include the persona system prompt");
  return args[index + 1];
}

function forkHandoff(summary = "Continue the bounded investigation.") {
  return {
    summary,
    metadata: {
      mode: "fork",
      inheritedEntryIds: [],
      latestUserEntryId: "parent-request",
      summarySha256: "a".repeat(64),
      summaryBytes: Buffer.byteLength(summary, "utf8"),
    },
  };
}

function occurrences(text, value) {
  return text.split(value).length - 1;
}

function assertCompletionProtocolOnce(prompt) {
  for (const marker of ["BLOCKED:", "NEEDS:", "DETAILS_AVAILABLE:"]) {
    assert.equal(occurrences(prompt, marker), 1, `${marker} appears once`);
  }
}

test("lean completion guidance retains required evidence and follow-up rules", () => {
  const fullBytes = Buffer.byteLength(SUBAGENT_COMPLETION_GUIDANCE, "utf8");
  const reminderBytes = Buffer.byteLength(SUBAGENT_COMPLETION_REMINDER, "utf8");
  const wrapper = formatSubagentContinuityPrompt("completion-instance", "Inspect completion assembly", "task");
  // These byte limits constrain static instructions, not report length.
  assert.ok(fullBytes <= 2_600, `full guidance is ${fullBytes} bytes`);
  assert.ok(reminderBytes <= 1_000, `reminder is ${reminderBytes} bytes`);
  assert.ok(reminderBytes < fullBytes, "the reminder is smaller than full guidance");
  assert.equal(occurrences(wrapper, SUBAGENT_COMPLETION_GUIDANCE), 1);
  assert.ok(Buffer.byteLength(wrapper, "utf8") - fullBytes <= 250, "Pi lifetime wrapper has bounded overhead");

  assert.match(SUBAGENT_COMPLETION_GUIDANCE, /short task\/status line.*requested result.*relevant evidence.*supplied worker\/task\/run identity.*Omit absent IDs.*unknown or not run/s);
  assert.match(SUBAGENT_COMPLETION_GUIDANCE, /SUCCESS.*required checks.*completed review can find defects.*Never label unrun checks as passed/s);
  assert.match(SUBAGENT_COMPLETION_GUIDANCE, /exact paths\/line ranges.*SHA length.*Exclude secret values/s);
  assert.match(SUBAGENT_COMPLETION_GUIDANCE, /Negative Knowledge.*FAILED, RULED_OUT, INCONCLUSIVE, or REJECTED.*even after success.*none observed when that fact matters/s);
  assert.match(SUBAGENT_COMPLETION_GUIDANCE, /follow-ups.*requested section or new evidence, changes, and validation, not the full previous report.*identity and task scope.*constraints and evidence limits/s);
  assert.match(SUBAGENT_COMPLETION_GUIDANCE, /exact output formats without an extra wrapper.*BLOCKED: <reason> and NEEDS: <minimum requirement>.*DETAILS_AVAILABLE: <numbered section index>.*Length alone is not a blocker/s);

  assert.match(SUBAGENT_COMPLETION_REMINDER, /requested sections or changes.*task scope and supplied identity.*omit empty fields and absent IDs.*decisive findings.*validation results\/limits.*unrun required checks.*negatives\/retry conditions, even after success/s);
  assert.match(SUBAGENT_COMPLETION_REMINDER, /exact output formats.*BLOCKED: <reason> then NEEDS: <minimum requirement>.*DETAILS_AVAILABLE: <section index>.*Length alone is not a blocker.*Do not repeat the full report or completed work/s);
  for (const prompt of [SUBAGENT_COMPLETION_GUIDANCE, SUBAGENT_COMPLETION_REMINDER]) {
    assert.doesNotMatch(prompt, /Concrete Artifacts & Diffs|Discovered Constraints \/ Blockers|Handoff:/);
    assert.doesNotMatch(prompt, /(?:16 KiB|400 lines|250[–-]600 tokens)/);
  }
});

test("details marker parser accepts only a leading available-section index", () => {
  for (const text of [
    "DETAILS_AVAILABLE: 1. Validation\n2. Negative knowledge",
    " \t\r\nDETAILS_AVAILABLE: 1. Overview\r\n2. Validation",
    "BLOCKED: Repository access is unavailable\r\nNEEDS: Read access to the repository\r\n\r\nDETAILS_AVAILABLE: 1. Deferred evidence\r\n2. Retry steps",
  ]) {
    assert.equal(hasSubagentDetailsAvailable(text), true);
  }

  for (const text of [
    "DETAILS_AVAILABLE:   \n1. Validation",
    "```text\nDETAILS_AVAILABLE: 1. Quoted evidence\n```",
    "## Completion\nDETAILS_AVAILABLE: 1. Mid-body evidence",
    "Overview\n> DETAILS_AVAILABLE: 1. Quoted evidence",
    '{"DETAILS_AVAILABLE":"1. JSON field"}',
  ]) {
    assert.equal(hasSubagentDetailsAvailable(text), false);
  }
});

test("Pi assembly applies full completion guidance to each lifetime and preserves persona prompts", () => {
  const persona = {
    name: "completion-scout",
    description: "Inspect completion assembly",
    runtime: "pi",
    systemPrompt: "Keep this persona instruction exactly.\nUse a precise local format.",
    extensions: [],
    skills: [],
    filePath: "/personas/completion-scout.md",
  };
  const purpose = "Inspect only completion assembly";
  const cases = [
    {
      name: "fresh",
      lifetime: "one-shot",
      options: { mode: "fresh", sessionName: "fresh-instance" },
    },
    {
      name: "fork",
      lifetime: "task",
      options: { mode: "fork", parentSessionFile: "/sessions/parent.jsonl", sessionName: "fork-instance" },
    },
    {
      name: "restored",
      lifetime: "persistent",
      options: { mode: "fresh", sessionFile: "/sessions/restored.jsonl", sessionName: "restored-instance" },
    },
  ];

  for (const current of cases) {
    const args = buildSubagentProcessArgs({
      ...current.options,
      persona,
      purpose,
      lifetime: current.lifetime,
    });
    const expected = formatSubagentContinuityPrompt(current.options.sessionName, purpose, current.lifetime);
    assert.equal(appendedSystemPrompt(args), expected, `${current.name} uses its assembled continuity prompt`);
    assert.equal(occurrences(appendedSystemPrompt(args), SUBAGENT_COMPLETION_GUIDANCE), 1);
    assertCompletionProtocolOnce(appendedSystemPrompt(args));
    assert.equal(systemPrompt(args), `${persona.systemPrompt}\n`, `${current.name} does not change the persona prompt`);
  }

  const noPurpose = buildSubagentProcessArgs({ mode: "fresh", persona, sessionName: "name-only" });
  assert.equal(appendedSystemPrompt(noPurpose), SUBAGENT_COMPLETION_GUIDANCE);
  assertCompletionProtocolOnce(appendedSystemPrompt(noPurpose));
  assert.equal(systemPrompt(noPurpose), `${persona.systemPrompt}\n`);

  const noPersona = buildSubagentProcessArgs({
    mode: "fresh",
    sessionName: "persona-less-instance",
    purpose,
    lifetime: "task",
  });
  assert.equal(noPersona.includes("--system-prompt"), false);
  assert.equal(occurrences(appendedSystemPrompt(noPersona), SUBAGENT_COMPLETION_GUIDANCE), 1);
  assertCompletionProtocolOnce(appendedSystemPrompt(noPersona));
});

test("Cursor bootstrap and follow-up retain completion guidance for fresh and fork lifetimes", () => {
  const safeRequest = "Inspect /workspace/auth.ts with --trace and report the exact result.";
  const secret = "CURSOR_API_KEY=cloud-completion-secret";
  const request = `${safeRequest}\n${secret}`;
  const persona = {
    name: "cloud-completion-scout",
    systemPrompt: "Inspect the requested Cloud scope.",
    cursorMcps: ["repository"],
  };

  for (const lifetime of ["one-shot", "task", "persistent"]) {
    for (const mode of ["fresh", "fork"]) {
      const bootstrap = buildCursorCloudBootstrap({
        mode,
        persona,
        purpose: "Inspect completion assembly",
        lifetime,
        request,
        ...(mode === "fork" ? { forkHandoff: forkHandoff() } : {}),
      });
      assert.equal(occurrences(bootstrap, SUBAGENT_COMPLETION_GUIDANCE), 1, `${mode}/${lifetime} bootstrap retains full guidance once`);
      assertCompletionProtocolOnce(bootstrap);
      assert.match(bootstrap, /^Persona: cloud-completion-scout$/m);
      assert.doesNotMatch(bootstrap, /^Name:/m);
      assert.match(bootstrap, /Inspect and plan only\. Do not edit, commit, push, create branches, create pull requests, or use mutating MCP operations\./);
      assert.ok(bootstrap.includes(safeRequest));
      assert.ok(bootstrap.includes("CURSOR_API_KEY=[redacted]"));
      assert.doesNotMatch(bootstrap, /cloud-completion-secret/);
    }

    const followUp = buildCursorCloudFollowUp(request, lifetime);
    assert.equal(occurrences(followUp, SUBAGENT_COMPLETION_REMINDER), 1, `${lifetime} follow-up retains the concise reminder once`);
    assert.equal(occurrences(followUp, SUBAGENT_COMPLETION_GUIDANCE), 0);
    assertCompletionProtocolOnce(followUp);
    assert.match(followUp, /Inspect and plan only\. Do not edit, commit, push, create branches, create pull requests, or use mutating MCP operations\./);
    assert.ok(followUp.includes(safeRequest));
    assert.ok(followUp.includes("CURSOR_API_KEY=[redacted]"));
    assert.doesNotMatch(followUp, /cloud-completion-secret/);
  }
});

test("Cursor completion prompts retain a UTF-8 request at the follow-up limit and reject bootstrap overflow", () => {
  const requestMarker = "REQUEST-MARKER: inspect /workspace/é.ts before the UTF-8 boundary.";
  const followUp = buildCursorCloudFollowUp(`${requestMarker}\n${"🙂".repeat(10_000)}`, "task");
  const followUpBytes = Buffer.byteLength(followUp, "utf8");
  assert.equal(MAX_CURSOR_FOLLOW_UP_BYTES, 6 * 1024);
  assert.ok(followUpBytes <= MAX_CURSOR_FOLLOW_UP_BYTES);
  assert.ok(followUpBytes >= MAX_CURSOR_FOLLOW_UP_BYTES - 16, `follow-up uses the request budget: ${followUpBytes} bytes`);
  assert.ok(followUp.includes(requestMarker));
  assert.match(followUp, /\[Content limited\]$/);
  assert.doesNotMatch(followUp, /�/);

  assert.equal(MAX_CURSOR_BOOTSTRAP_BYTES, 24 * 1024);
  assert.throws(() => buildCursorCloudBootstrap({
    mode: "fork",
    persona: {
      name: "over-budget",
      systemPrompt: "p".repeat(16 * 1024),
      cursorMcps: [],
    },
    purpose: "q".repeat(1024),
    lifetime: "persistent",
    parentContext: "c".repeat(8 * 1024),
    forkHandoff: forkHandoff("h".repeat(16 * 1024)),
    request: "r".repeat(16 * 1024),
  }), (error) => {
    assert.equal(error.code, "BACKEND_FAILED");
    assert.match(error.message, /bootstrap exceeds its context limit/);
    return true;
  });
});

test("blocker parser accepts required leading lines but not completion status labels", () => {
  const blockerBeforeCompletion = `
BLOCKED: The required repository is not available
NEEDS: Access to the requested repository

## Completion
Worker ID: not supplied; Task ID: not supplied; Run ID: not supplied
Status: BLOCKED — Repository access is unavailable`;
  assert.deepEqual(parseSubagentBlockerResponse(blockerBeforeCompletion), {
    reason: "The required repository is not available",
    need: "Access to the requested repository",
  });

  assert.equal(parseSubagentBlockerResponse(`## Completion
Status: BLOCKED — Repository access is unavailable`), undefined);
  assert.equal(parseSubagentBlockerResponse(`## Completion
Status: SUCCESS — Review completed`), undefined);
  assert.equal(parseSubagentBlockerResponse(`## Completion
Status: FAILURE — Required test failed`), undefined);
});
