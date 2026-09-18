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
  MAX_CURSOR_CORRELATION_MARKER_BYTES,
  MAX_CURSOR_FOLLOW_UP_BYTES,
  MAX_CURSOR_PARENT_REQUEST_BYTES,
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

function utf8Text(bytes) {
  return "🙂".repeat(Math.floor(bytes / 4)) + "a".repeat(bytes % 4);
}

function cursorFollowUpRequestBudget(lifetime) {
  const guidance = [
    "## Follow-up",
    `Lifetime: ${lifetime}`,
    "Inspect and plan only. Do not edit, commit, push, create branches, create pull requests, or use mutating MCP operations.",
    SUBAGENT_COMPLETION_REMINDER,
    "## Request",
  ].join("\n");
  return MAX_CURSOR_FOLLOW_UP_BYTES - Buffer.byteLength(guidance, "utf8") - 1 - MAX_CURSOR_CORRELATION_MARKER_BYTES;
}

test("lean completion guidance retains required evidence and follow-up rules", () => {
  const fullBytes = Buffer.byteLength(SUBAGENT_COMPLETION_GUIDANCE, "utf8");
  const reminderBytes = Buffer.byteLength(SUBAGENT_COMPLETION_REMINDER, "utf8");
  const wrapper = formatSubagentContinuityPrompt("completion-instance", "Inspect completion assembly", "task");
  // These byte limits constrain static instructions, not report length.
  assert.ok(fullBytes <= 2_200, `full guidance is ${fullBytes} bytes`);
  assert.ok(reminderBytes <= 1_050, `reminder is ${reminderBytes} bytes`);
  assert.ok(reminderBytes < fullBytes, "the reminder is smaller than full guidance");
  assert.equal(occurrences(wrapper, SUBAGENT_COMPLETION_GUIDANCE), 1);
  assert.ok(Buffer.byteLength(wrapper, "utf8") - fullBytes <= 250, "Pi lifetime wrapper has bounded overhead");

  assert.match(SUBAGENT_COMPLETION_GUIDANCE, /exact formats.*exact format overrides this default wrapper.*Otherwise: short task\/status line.*supplied worker, task, run, or instance IDs.*Do not infer instance IDs from persona labels.*consequential unknown or unrun work, and "none observed" when this matters/s);
  assert.match(SUBAGENT_COMPLETION_GUIDANCE, /SUCCESS requires.*assigned objective and required checks.*completed review can find defects.*Never call an unrun check passed/s);
  assert.match(SUBAGENT_COMPLETION_GUIDANCE, /paths and line ranges.*before\/after values.*environment variables.*SHA length.*Exclude secrets/s);
  assert.match(SUBAGENT_COMPLETION_GUIDANCE, /Read omitted output before relying on it.*Negative Knowledge.*FAILED, RULED_OUT, INCONCLUSIVE, or REJECTED.*after success.*scope, evidence, and retry condition.*No reproduction does not show no bug.*Do not repeat unchanged failed work without an authorized discriminating retest/s);
  assert.match(SUBAGENT_COMPLETION_GUIDANCE, /On follow-up.*requested section or new evidence, changes, and validation.*task scope and material limits/s);
  assert.match(SUBAGENT_COMPLETION_GUIDANCE, /BLOCKED: <reason> and NEEDS: <minimum requirement>.*DETAILS_AVAILABLE: <numbered section index>.*Length alone is not a blocker/s);

  assert.match(SUBAGENT_COMPLETION_REMINDER, /exact format overrides default status wrapper.*"none observed" when this matters.*supplied instance IDs only.*do not infer them from persona labels.*Read omitted validation output before relying on it.*REJECTED results after success.*no reproduction does not show no bug.*Do not repeat unchanged failed work without an authorized discriminating retest/s);
  assert.match(SUBAGENT_COMPLETION_REMINDER, /BLOCKED: <reason>, then NEEDS: <minimum requirement>.*DETAILS_AVAILABLE: <section index>.*Do not repeat completed work/s);
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
    const expected = formatSubagentContinuityPrompt(current.options.sessionName, purpose, current.lifetime, current.options.mode);
    assert.equal(appendedSystemPrompt(args), expected, `${current.name} uses its assembled continuity prompt`);
    assert.equal(occurrences(appendedSystemPrompt(args), SUBAGENT_COMPLETION_GUIDANCE), 1);
    assertCompletionProtocolOnce(appendedSystemPrompt(args));
    assert.equal(systemPrompt(args), `${persona.systemPrompt}\n`, `${current.name} does not change the persona prompt`);
    if (current.options.mode === "fork") {
      assert.match(appendedSystemPrompt(args), /Inherited parent history is background/);
    }
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

test("Cursor bootstrap retains the local parent-context packet without parsing Markdown headers", () => {
  const packet = "## Parent-provided context\n\nGit base: ba7aa1e\n\n## Request\n\nThis parent context has an unescaped request header.\n\n## Request\n\nReview extensions/subagents only.";
  const bootstrap = buildCursorCloudBootstrap({
    mode: "fresh",
    purpose: "Review delegated context",
    lifetime: "task",
    request: packet,
  });
  assert.ok(bootstrap.endsWith(`## Request\n\n${packet}`));
  assert.equal((bootstrap.match(/## Parent-provided context/g) ?? []).length, 1);
  assert.equal((bootstrap.match(/## Request/g) ?? []).length, 3);

  const contextAtLimit = "é".repeat(2_048);
  const requestAtLimit = "🙂".repeat(512);
  assert.equal(Buffer.byteLength(contextAtLimit, "utf8"), 4 * 1024);
  assert.equal(Buffer.byteLength(requestAtLimit, "utf8"), 2 * 1024);
  const bounded = buildCursorCloudBootstrap({
    mode: "fresh",
    purpose: "Bound the handoff",
    lifetime: "task",
    parentContext: contextAtLimit,
    request: requestAtLimit,
  });
  assert.ok(bounded.includes(contextAtLimit));
  assert.ok(bounded.endsWith(`## Request\n\n${requestAtLimit}`));
  assert.equal(Buffer.byteLength(contextAtLimit, "utf8") + Buffer.byteLength(requestAtLimit, "utf8"), MAX_CURSOR_PARENT_REQUEST_BYTES);

  for (const { name, options, field } of [
    {
      name: "parent context",
      options: { parentContext: `${contextAtLimit}a`, request: "Inspect the scope." },
      field: "parent context",
    },
    {
      name: "combined bootstrap request",
      options: { parentContext: contextAtLimit, request: `${requestAtLimit}a` },
      field: "initial request",
    },
    {
      name: "single formatted packet",
      options: { request: "🙂".repeat(1_537) },
      field: "initial request",
    },
  ]) {
    assert.throws(() => buildCursorCloudBootstrap({
      mode: "fresh",
      purpose: "Reject lost authority",
      lifetime: "task",
      ...options,
    }), (error) => {
      assert.equal(error.code, "BACKEND_FAILED", name);
      assert.match(error.message, new RegExp(`Cursor Cloud ${field} is \\d+ UTF-8 bytes after redaction; limit is \\d+\\. Reduce it before dispatch\\.`));
      return true;
    });
  }
});

test("Cursor completion prompts accept exact UTF-8 limits and reject oversized caller input", () => {
  const followUpBudget = cursorFollowUpRequestBudget("task");
  const requestAtLimit = utf8Text(followUpBudget);
  const followUp = buildCursorCloudFollowUp(requestAtLimit, "task");
  assert.equal(MAX_CURSOR_FOLLOW_UP_BYTES, 6 * 1024);
  assert.equal(Buffer.byteLength(followUp, "utf8"), MAX_CURSOR_FOLLOW_UP_BYTES - MAX_CURSOR_CORRELATION_MARKER_BYTES);
  assert.ok(followUp.endsWith(requestAtLimit));
  assert.doesNotMatch(followUp, /�/);
  assert.throws(() => buildCursorCloudFollowUp(`${requestAtLimit}a`, "task"), (error) => {
    assert.equal(error.code, "BACKEND_FAILED");
    assert.match(error.message, new RegExp(`Cursor Cloud follow-up request is ${followUpBudget + 1} UTF-8 bytes after redaction; limit is ${followUpBudget}\\. Reduce it before dispatch\\.`));
    return true;
  });

  assert.equal(MAX_CURSOR_BOOTSTRAP_BYTES, 24 * 1024);
  const boundedBootstrap = buildCursorCloudBootstrap({
    mode: "fork",
    persona: {
      name: "over-budget",
      systemPrompt: "p".repeat(16 * 1024),
      cursorMcps: [],
    },
    purpose: "q".repeat(1024),
    lifetime: "persistent",
    parentContext: "context",
    forkHandoff: forkHandoff("h".repeat(16 * 1024)),
    request: "request",
  });
  assert.ok(Buffer.byteLength(boundedBootstrap, "utf8") <= MAX_CURSOR_BOOTSTRAP_BYTES);
  assert.match(boundedBootstrap, /\[Content limited\]/);
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
