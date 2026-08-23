import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const subagentsModule = await import("../../extensions/subagents/index.ts");
const {
  ChildPanel,
  ChildSessionController,
  MAX_CHILD_TRANSCRIPT_ITEMS,
  promptFingerprint,
} = await import("../../extensions/subagents/ui.ts");
const { ChildRpcClient } = await import("../../extensions/subagents/rpc.ts");
const { normalizePersonaDescription } = await import("../../extensions/subagents/personas.ts");
const {
  BUNDLED_PERSONA_DIRECTORY,
  boundedSubagentResponse,
  buildChildProcessArgs,
  formatChildModelScope,
  formatPersonaForModel,
  formatSubagentContinuityPrompt,
  formatSubagentRequest,
  getChildPanelWidths,
  loadChildPersonas,
  loadChildPersonasFromDirectories,
  MAX_PERSISTENT_SUBAGENTS,
  MAX_RETAINED_STOPPED_SUBAGENTS,
  MAX_SUBAGENT_RESPONSE_BYTES,
  MAX_SUBAGENT_RESPONSE_LINES,
  parseChildCommandArgs,
  parseSubagentBlockerResponse,
  parseSubagentsCommandArgs,
  PersistentSubagentRegistry,
  SUBAGENT_EXECUTION_PROFILES,
} = subagentsModule;

function makeControllerHarness({
  mode = "fresh",
  messages = [],
  promptAttributions = [],
  promptStartsAgent = true,
  promptError,
} = {}) {
  let streaming = false;
  let callbacks;
  const calls = { prompt: [], steer: [], followUp: [], abort: 0, stop: 0 };
  const acceptedAttributions = [];
  const rpcFactory = (options) => {
    callbacks = options;
    return {
      async start() {},
      async stop() { calls.stop++; streaming = false; },
      async getState() {
        return {
          thinkingLevel: "low",
          isStreaming: streaming,
          isCompacting: false,
          sessionFile: "/tmp/fake-subagent.jsonl",
        };
      },
      async getMessages() { return messages; },
      async getSessionStats() { return {}; },
      getStderr() { return ""; },
      async prompt(text) {
        calls.prompt.push(text);
        if (promptError) throw new Error(promptError);
        if (promptStartsAgent) {
          streaming = true;
          callbacks.onOutput({ type: "agent_start" });
        }
      },
      async steer(text) { calls.steer.push(text); },
      async followUp(text) { calls.followUp.push(text); },
      async abort() { calls.abort++; streaming = false; },
    };
  };
  const context = { ui: {} };
  const controller = new ChildSessionController(context, {
    args: [],
    cwd: "/tmp",
    mode,
    initialPrompt: "",
    scopedModels: [],
    promptAttributions,
    onPromptAccepted(attribution) { acceptedAttributions.push(attribution); },
  }, rpcFactory);
  return {
    controller,
    calls,
    acceptedAttributions,
    message(text, stopReason = "stop") {
      callbacks.onOutput({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text }],
          stopReason,
        },
      });
    },
    startFollowUp() {
      callbacks.onOutput({ type: "agent_start" });
    },
    exit(stderr) {
      streaming = false;
      callbacks.onExit({ code: 1, signal: null, stderr, intentional: false });
    },
    settle(text, stopReason = "stop") {
      this.message(text, stopReason);
      streaming = false;
      callbacks.onOutput({ type: "agent_settled" });
    },
  };
}

function restoredRegistryState(entries, ownerSessionId) {
  const records = new Map();
  for (const entry of entries) {
    if (entry.customType !== "persistent-subagents" || entry.data?.ownerSessionId !== ownerSessionId) continue;
    if (entry.data.version === 1 && Array.isArray(entry.data.subagents)) {
      records.clear();
      for (const stored of entry.data.subagents) records.set(stored.id, structuredClone(stored));
      continue;
    }
    if (entry.data.version !== 2) continue;
    for (const id of entry.data.removedIds ?? []) records.delete(id);
    for (const stored of entry.data.upserts ?? []) records.set(stored.id, structuredClone(stored));
  }
  return records;
}

function latestStoredSubagent(entries, ownerSessionId, id) {
  return restoredRegistryState(entries, ownerSessionId).get(id);
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for test condition");
}

test("extension exposes one concise subagent tool and persistent-session commands", async () => {
  const tools = [];
  const commands = [];
  const events = [];
  subagentsModule.default({
    registerTool(tool) {
      tools.push(tool);
    },
    registerCommand(name) {
      commands.push(name);
    },
    on(name) {
      events.push(name);
    },
  });

  assert.deepEqual(tools.map(({ name }) => name), ["subagent"]);
  assert.deepEqual(tools[0].parameters.properties.action.enum, ["create", "list", "prompt", "status", "stop"]);
  assert.deepEqual(Object.keys(tools[0].parameters.properties), [
    "action", "id", "name", "purpose", "persona", "profile", "lifetime", "prompt", "context", "kind", "offset", "limit",
  ]);
  assert.equal(tools[0].parameters.properties.purpose.description, "Stable context domain for create");
  assert.equal(tools[0].parameters.properties.purpose.maxLength, 240);
  assert.match(tools[0].parameters.properties.persona.description, /existing persona required.*list personas/i);
  assert.deepEqual(tools[0].parameters.properties.profile.enum, ["fast", "balanced", "deep"]);
  assert.match(tools[0].parameters.properties.profile.description, /fast=Luna.*balanced=Terra.*deep=Sol/);
  assert.deepEqual(tools[0].parameters.properties.lifetime.enum, ["one-shot", "task", "persistent"]);
  assert.match(tools[0].parameters.properties.lifetime.description, /one-shot needs prompt.*overrides persona default/i);
  assert.equal(tools[0].parameters.properties.context.maxLength, 8_000);
  assert.match(tools[0].parameters.properties.context.description, /do not paste source or diffs/i);
  assert.deepEqual(tools[0].promptGuidelines, [
    "Before subagent create, list personas or reusable subagents when options are unknown and provide required context; choose the cheapest sufficient profile, and reserve deep for high-risk work, ambiguous work that needs cross-system analysis, or when a cheaper profile was insufficient.",
    "Use subagent one-shot for one-response work, task through validation, and persistent across objectives; satisfy a blocked subagent's NEEDS before reprompting, and stop completed ones.",
    "Give each subagent the exact objective, scope, and requested output; do not add adjacent work.",
  ]);
  assert.ok(tools[0].promptGuidelines.every((guideline) => guideline.includes("subagent")));
  const modelFacingDefinition = JSON.stringify({
    description: tools[0].description,
    promptSnippet: tools[0].promptSnippet,
    promptGuidelines: tools[0].promptGuidelines,
    parameters: tools[0].parameters,
  });
  assert.ok(Buffer.byteLength(modelFacingDefinition, "utf8") <= 2_050);
  const personaPage = await tools[0].execute(
    "list-personas",
    { action: "list", kind: "personas", offset: 0, limit: 1 },
  );
  assert.equal(personaPage.details.personas.length, 1);
  assert.ok(personaPage.details.omitted >= 3);
  assert.match(personaPage.content[0].text, /repeat list with offset 1/);
  const emptyPersonaPage = await tools[0].execute(
    "list-personas-out-of-range",
    { action: "list", kind: "personas", offset: 10_000, limit: 1 },
  );
  assert.match(emptyPersonaPage.content[0].text, /No subagent personas at this offset/);
  assert.deepEqual(SUBAGENT_EXECUTION_PROFILES, {
    fast: { model: "openai-codex/gpt-5.6-luna", thinking: "high" },
    balanced: { model: "openai-codex/gpt-5.6-terra", thinking: "xhigh" },
    deep: { model: "openai-codex/gpt-5.6-sol", thinking: "xhigh" },
  });
  assert.deepEqual(commands.filter((name) => ["child", "subagents", "children"].includes(name)), [
    "child", "subagents", "children",
  ]);
  assert.equal(commands.includes("subagent-blockers"), false);
  assert.deepEqual(events, ["session_start", "session_tree", "session_shutdown"]);
});

test("child command accepts only a leading complete --fork option", () => {
  assert.deepEqual(parseChildCommandArgs(""), { mode: "fresh", prompt: "" });
  assert.deepEqual(parseChildCommandArgs("review the diff"), { mode: "fresh", prompt: "review the diff" });
  assert.deepEqual(parseChildCommandArgs(" --fork review the diff "), { mode: "fork", prompt: "review the diff" });
  assert.deepEqual(parseChildCommandArgs("--fork"), { mode: "fork", prompt: "" });
  assert.deepEqual(parseChildCommandArgs("--forked review"), {
    mode: "fresh",
    prompt: "",
    error: "Unknown child option: --forked",
  });
});

test("subagents command accepts direct open and explicit stop actions", () => {
  assert.deepEqual(parseSubagentsCommandArgs(""), { action: "open", target: "" });
  assert.deepEqual(parseSubagentsCommandArgs("auth-scout"), { action: "open", target: "auth-scout" });
  assert.deepEqual(parseSubagentsCommandArgs(" --stop auth-scout "), { action: "stop", target: "auth-scout" });
  assert.deepEqual(parseSubagentsCommandArgs("--stop"), { action: "stop", target: "" });
  assert.deepEqual(parseSubagentsCommandArgs("--disable"), { action: "disable", target: "" });
  assert.deepEqual(parseSubagentsCommandArgs("--enable"), { action: "enable", target: "" });
  assert.deepEqual(parseSubagentsCommandArgs("--disable reviewer"), {
    action: "open",
    target: "",
    error: "--disable does not accept a target",
  });
  assert.deepEqual(parseSubagentsCommandArgs("--delete auth-scout"), {
    action: "open",
    target: "",
    error: "Unknown subagents option: --delete",
  });
});

test("fresh subagent args use Pi tool defaults, disable ambient resources, and persist sessions", () => {
  const args = buildChildProcessArgs({
    mode: "fresh",
    model: "anthropic/claude-sonnet-4-6",
    thinking: "high",
    sessionDir: "/sessions/subagents",
    sessionName: "auth-scout",
  });

  assert.deepEqual(args, [
    "--mode", "rpc",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--session-dir", "/sessions/subagents",
    "--name", "auth-scout",
    "--model", "anthropic/claude-sonnet-4-6",
    "--thinking", "high",
  ]);
  assert.equal(args.includes("--tools"), false);
  assert.equal(args.includes("--no-session"), false);
  assert.equal(args.includes("--no-context-files"), false);
});

test("subagents receive purpose-aware progressive-disclosure guidance", () => {
  const guidance = formatSubagentContinuityPrompt(
    "auth-scout",
    "Authentication architecture and token lifecycle",
  );
  assert.match(guidance, /persistent subagent "auth-scout"/);
  assert.match(guidance, /Purpose: Authentication architecture and token lifecycle/);
  assert.match(guidance, /each response decision-complete/i);
  assert.match(guidance, /all required findings or deliverables/i);
  assert.match(guidance, /numbered section index and provide those sections on follow-up/i);
  assert.match(guidance, /file paths and line ranges/i);
  assert.match(guidance, /BLOCKED: <reason>/);
  assert.match(guidance, /NEEDS: <minimum requirement>/);
  assert.doesNotMatch(guidance, /PROGRESS:|BLOCKED\[/);
  assert.match(guidance, /Do not bypass explicit task, project, or user constraints/i);
  assert.match(
    guidance,
    /hard scope boundary.*supporting context as needed.*do not add adjacent objectives, analysis, or findings/i,
  );

  const oneShotGuidance = formatSubagentContinuityPrompt(
    "bounded-review",
    "Review one bounded change",
    "one-shot",
  );
  assert.match(oneShotGuidance, /one-shot subagent/);
  assert.match(oneShotGuidance, /complete, concise answer in this response/i);
  assert.match(oneShotGuidance, /do not defer details to a follow-up/i);
  assert.match(oneShotGuidance, /hard scope boundary/i);
  assert.doesNotMatch(oneShotGuidance, /progressive disclosure/i);

  const taskGuidance = formatSubagentContinuityPrompt("reviewer", "Review and validate fixes", "task");
  assert.match(taskGuidance, /task-scoped subagent/);
  assert.match(taskGuidance, /follow-up and validation prompts/i);
  assert.match(taskGuidance, /hard scope boundary/i);

  const args = buildChildProcessArgs({
    mode: "fresh",
    sessionName: "auth-scout",
    purpose: "Authentication architecture and token lifecycle",
    lifetime: "persistent",
  });
  const appendIndex = args.indexOf("--append-system-prompt");
  assert.ok(appendIndex > 0);
  assert.equal(args[appendIndex + 1], guidance);
});

test("explicit blocker responses are parsed conservatively", () => {
  assert.deepEqual(
    parseSubagentBlockerResponse(`BLOCKED: Cannot execute targeted tests
NEEDS: Test results for package foo`),
    {
      reason: "Cannot execute targeted tests",
      need: "Test results for package foo",
    },
  );
  assert.equal(parseSubagentBlockerResponse("The subagent seems blocked"), undefined);
  assert.equal(parseSubagentBlockerResponse("BLOCKED[missing-context]: reason\nNEEDS: access"), undefined);
  assert.equal(parseSubagentBlockerResponse("BLOCKED: reason"), undefined);
  assert.equal(parseSubagentBlockerResponse("BLOCKED: \u0000\nNEEDS: access"), undefined);
  assert.equal(parseSubagentBlockerResponse("BLOCKED: reason\nNEEDS: \u0000"), undefined);
  const bounded = parseSubagentBlockerResponse(`BLOCKED: ${"x".repeat(300)}\r\nNEEDS: ${"y".repeat(300)}`);
  assert.equal(bounded.reason.length, 240);
  assert.equal(bounded.need.length, 240);
  assert.match(bounded.reason, /…$/);
  assert.match(bounded.need, /…$/);
});

test("parent context is labeled separately from the subagent request", () => {
  assert.equal(formatSubagentRequest(" Inspect the implementation "), "Inspect the implementation");
  assert.equal(
    formatSubagentRequest(
      " Review the current branch ",
      " Goal: preserve session isolation\nGit base: origin/main ",
    ),
    "## Parent-provided context\n\nGoal: preserve session isolation\nGit base: origin/main\n\n## Request\n\nReview the current branch",
  );
});

test("truncated responses direct the parent back to the persistent subagent", () => {
  assert.equal(boundedSubagentResponse("Short answer", "auth-scout"), "Short answer");
  const longAnswer = Array.from({ length: 3_000 }, (_, index) => `section line ${index + 1}`).join("\n");
  const bounded = boundedSubagentResponse(longAnswer, "auth-scout");
  assert.ok(Buffer.byteLength(bounded, "utf8") <= MAX_SUBAGENT_RESPONSE_BYTES);
  assert.ok(bounded.split("\n").length <= MAX_SUBAGENT_RESPONSE_LINES);
  assert.match(bounded, /^section line 1\n/);
  assert.match(
    bounded,
    /Full response retained by auth-scout; use action "prompt" to request a numbered section or continuation\.\]$/,
  );

  const oneLine = boundedSubagentResponse("a".repeat(MAX_SUBAGENT_RESPONSE_BYTES * 2), "auth-scout");
  assert.match(oneLine, /^a+/);
  assert.ok(Buffer.byteLength(oneLine, "utf8") <= MAX_SUBAGENT_RESPONSE_BYTES);
  const multibyte = boundedSubagentResponse("😀".repeat(MAX_SUBAGENT_RESPONSE_BYTES), "auth-scout");
  assert.match(multibyte, /^😀/u);
  assert.doesNotMatch(multibyte, /�/u);
  assert.ok(Buffer.byteLength(multibyte, "utf8") <= MAX_SUBAGENT_RESPONSE_BYTES);
});

test("child panel sizing never exceeds the supplied terminal width", () => {
  assert.equal(getChildPanelWidths(1), undefined);
  assert.equal(getChildPanelWidths(2), undefined);
  assert.deepEqual(getChildPanelWidths(40), { dialogWidth: 40, innerWidth: 38 });
  assert.deepEqual(getChildPanelWidths(72), { dialogWidth: 72, innerWidth: 70 });
});

test("busy subagent panels can detach without interrupting the child", () => {
  let detached = 0;
  let interrupted = 0;
  const panel = new ChildPanel(
    { requestRender() {} },
    {},
    {
      matches(data, action) {
        return data === "ctrl+d" && action === "app.exit";
      },
    },
    {
      state: { busy: true },
      async interrupt() { interrupted++; },
    },
    "Busy subagent",
    () => {},
    () => { detached++; },
  );

  panel.handleInput("ctrl+d");
  assert.equal(detached, 1);
  assert.equal(interrupted, 0);
});

test("child RPC commands reject unsuccessful protocol responses", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-child-rpc-protocol-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const server = join(root, "rpc-server.mjs");
  await writeFile(server, `
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (buffer.includes("\\n")) {
    const newline = buffer.indexOf("\\n");
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const command = JSON.parse(line);
    const response = command.type === "get_state"
      ? {
          type: "response",
          id: command.id,
          command: command.type,
          success: true,
          data: { thinkingLevel: "off", isStreaming: false, isCompacting: false },
        }
      : {
          type: "response",
          id: command.id,
          command: command.type,
          success: false,
          error: "Rejected " + command.type,
        };
    process.stdout.write(JSON.stringify(response) + "\\n");
  }
});
`);
  const client = new ChildRpcClient({
    cwd: root,
    args: [],
    invocation: { command: process.execPath, args: [server] },
    onOutput() {},
    onExit() {},
  });
  await client.start();

  await assert.rejects(client.prompt("hello"), /Rejected prompt/);
  await assert.rejects(client.steer("hello"), /Rejected steer/);
  await assert.rejects(client.followUp("hello"), /Rejected follow_up/);
  await assert.rejects(client.abort(), /Rejected abort/);
  await assert.rejects(client.setThinkingLevel("high"), /Rejected set_thinking_level/);
  await client.stop();
});

test("handled child prompts settle without an agent run", async () => {
  const harness = makeControllerHarness({ promptStartsAgent: false });
  const result = await harness.controller.promptAndWait("/local-command");
  assert.deepEqual({
    text: result.text,
    responseProduced: result.responseProduced,
    handledWithoutAgent: result.handledWithoutAgent,
  }, {
    text: "",
    responseProduced: false,
    handledWithoutAgent: true,
  });
  assert.equal(harness.controller.settlementRevision, 1);
  await harness.controller.stop();
});

test("child prompt rejection preserves the RPC error", async () => {
  const harness = makeControllerHarness({ promptError: "No credentials for child model" });
  await assert.rejects(
    harness.controller.promptAndWait("Inspect authentication"),
    /No credentials for child model/,
  );
  await harness.controller.stop();
});

test("queued child prompts remain serialized when an intermediate request is aborted", async () => {
  const harness = makeControllerHarness();
  const first = harness.controller.promptAndWait("First request");
  await waitFor(() => harness.calls.prompt.length === 1);

  const abort = new AbortController();
  const second = harness.controller.promptAndWait("Canceled request", abort.signal);
  abort.abort(new Error("Canceled while queued"));
  await assert.rejects(second, /Canceled while queued/);

  const third = harness.controller.promptAndWait("Third request");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(harness.calls.prompt, ["First request"]);

  harness.settle("First result");
  await first;
  await waitFor(() => harness.calls.prompt.length === 2);
  harness.settle("Third result");
  assert.equal((await third).text, "Third result");
  await harness.controller.stop();
});

test("child prompt completions preserve non-success stop reasons", async () => {
  const harness = makeControllerHarness();
  const pending = harness.controller.promptAndWait("Produce a long response");
  await waitFor(() => harness.calls.prompt.length === 1);
  harness.settle("Partial response", "length");
  const result = await pending;
  assert.equal(result.text, "Partial response");
  assert.equal(result.responseProduced, true);
  assert.equal(result.stopReason, "length");
  await harness.controller.stop();
});

test("child panel transcript memory is bounded", async () => {
  const harness = makeControllerHarness();
  for (let index = 0; index < MAX_CHILD_TRANSCRIPT_ITEMS + 25; index++) {
    harness.controller.setTransientStatus(`error ${index}`, "error");
  }
  assert.equal(harness.controller.state.items.length, MAX_CHILD_TRANSCRIPT_ITEMS);
  assert.equal(harness.controller.state.omittedItems, 25);
  await harness.controller.stop();
});

test("parent prompts stay open through human steering and follow-ups", async () => {
  const harness = makeControllerHarness();
  assert.equal(harness.controller.settlementRevision, 0);
  const pending = harness.controller.promptAndWait("Inspect authentication");
  await waitFor(() => harness.calls.prompt.length === 1);

  assert.equal(await harness.controller.submit("Focus on token refresh"), true);
  assert.equal(await harness.controller.submit("Then summarize risks", "followUp"), true);
  assert.equal(harness.controller.returnText(), undefined);
  assert.deepEqual(harness.calls, {
    prompt: ["Inspect authentication"],
    steer: ["Focus on token refresh"],
    followUp: ["Then summarize risks"],
    abort: 0,
    stop: 0,
  });

  let settled = false;
  void pending.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  harness.message("Intermediate response before queued follow-up");
  await new Promise((resolve) => queueMicrotask(resolve));
  assert.equal(settled, false);
  harness.startFollowUp();
  harness.settle("Final authentication summary");
  const result = await pending;
  assert.equal(result.text, "Final authentication summary");
  assert.equal(harness.controller.settlementRevision, 1);
  assert.equal(harness.controller.latestSettledAssistantText, "Final authentication summary");
  assert.deepEqual(
    harness.controller.state.items.filter(({ kind }) => kind === "user").map(({ source, mode }) => ({ source, mode })),
    [
      { source: "parent", mode: "prompt" },
      { source: "human", mode: "steer" },
      { source: "human", mode: "followUp" },
    ],
  );
  assert.deepEqual(harness.acceptedAttributions.map(({ source }) => source), ["parent", "human", "human"]);
  await harness.controller.stop();
});

test("parent-facing subagent process failures are bounded", async () => {
  const harness = makeControllerHarness();
  const pending = harness.controller.promptAndWait("Trigger a bounded failure");
  await waitFor(() => harness.calls.prompt.length === 1);
  harness.exit(`${"diagnostic ".repeat(1_000)}FINAL_ERROR`);
  await assert.rejects(pending, (error) => {
    assert.ok(error.message.length <= 2_000);
    assert.match(error.message, /FINAL_ERROR$/);
    return true;
  });
  await harness.controller.stop();
});

test("restored transcripts retain parent, human, and fork-context attribution", async () => {
  const harness = makeControllerHarness({
    mode: "fork",
    messages: [
      { role: "user", content: "Original parent-session question" },
      { role: "assistant", content: [{ type: "text", text: "Original answer" }], stopReason: "stop" },
      { role: "user", content: "Human follow-up" },
      { role: "assistant", content: [{ type: "text", text: "Human answer" }], stopReason: "stop" },
      { role: "user", content: "Parent-agent follow-up" },
    ],
    promptAttributions: [
      { source: "human", fingerprint: promptFingerprint("Human follow-up") },
      { source: "parent", fingerprint: promptFingerprint("Parent-agent follow-up") },
    ],
  });

  await harness.controller.start();
  assert.deepEqual(
    harness.controller.state.items.filter(({ kind }) => kind === "user").map(({ text, source }) => ({ text, source })),
    [
      { text: "Original parent-session question", source: "context" },
      { text: "Human follow-up", source: "human" },
      { text: "Parent-agent follow-up", source: "parent" },
    ],
  );
  await harness.controller.stop();
});

test("persistent subagent registry stores branch-local mutations and restores dormant instances", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-persistent-subagents-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const parentSession = join(root, "parent.jsonl");
  await writeFile(parentSession, "{}\n");

  const entries = [];
  const pi = {
    getThinkingLevel: () => "high",
    appendEntry(customType, data) {
      entries.push({ type: "custom", customType, data });
    },
  };
  const context = {
    cwd: root,
    model: { provider: "anthropic", id: "claude-sonnet-4-6" },
    scopedModels: [],
    sessionManager: {
      getSessionId: () => "parent-session-id",
      getSessionFile: () => parentSession,
      getBranch: () => [],
    },
  };

  const registry = new PersistentSubagentRegistry(pi);
  registry.restore(context);
  const created = registry.create(context, {
    mode: "fresh",
    name: "auth-scout",
    purpose: "Authentication architecture\nand token lifecycle",
  });
  assert.equal(created.name, "auth-scout");
  assert.equal(created.purpose, "Authentication architecture and token lifecycle");
  assert.equal(created.status, "dormant");
  assert.equal(created.lifetime, "persistent");
  assert.match(created.id, /^sa_[a-f0-9]{10}$/);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].customType, "persistent-subagents");
  assert.equal(entries[0].data.version, 2);
  assert.deepEqual(entries[0].data.removedIds, []);
  assert.equal(entries[0].data.upserts.length, 1);

  const restoredContext = {
    ...context,
    sessionManager: {
      ...context.sessionManager,
      getBranch: () => entries,
    },
  };
  const restored = new PersistentSubagentRegistry(pi);
  restored.restore(restoredContext);
  assert.deepEqual(restored.list().map(({ id, name, purpose, status }) => ({ id, name, purpose, status })), [
    {
      id: created.id,
      name: "auth-scout",
      purpose: "Authentication architecture and token lifecycle",
      status: "dormant",
    },
  ]);

  const legacyStored = structuredClone(latestStoredSubagent(entries, "parent-session-id", created.id));
  delete legacyStored.purpose;
  delete legacyStored.lifetime;
  legacyStored.activeBlocker = {
    id: "blk_legacy",
    createdAt: Date.now(),
    kind: "missing-context",
    reason: "The expected behavior is not available",
    need: "Expected behavior from the parent",
  };
  const legacyEntries = [{
    type: "custom",
    customType: "persistent-subagents",
    data: {
      version: 1,
      ownerSessionId: "parent-session-id",
      subagents: [legacyStored],
    },
  }];
  const legacy = new PersistentSubagentRegistry(pi);
  legacy.restore({
    ...context,
    sessionManager: {
      ...context.sessionManager,
      getBranch: () => legacyEntries,
    },
  });
  assert.equal(
    legacy.list()[0].purpose,
    "Existing subagent auth-scout; purpose was not recorded",
  );
  assert.equal(legacy.list()[0].lifetime, "persistent");
  assert.equal(legacy.list()[0].status, "blocked");
  assert.deepEqual(legacy.list()[0].blocker, {
    reason: "The expected behavior is not available",
    need: "Expected behavior from the parent",
  });

  const interruptedStored = structuredClone(latestStoredSubagent(entries, "parent-session-id", created.id));
  interruptedStored.lifetime = "one-shot";
  interruptedStored.activeBlocker = {
    id: "blk_interrupted",
    createdAt: Date.now(),
    kind: "missing-context",
    reason: "The parent request did not include an expected result",
    need: "An expected result from the parent",
  };
  const recoveryEntries = [];
  const recoveryPi = {
    ...pi,
    appendEntry(customType, data) {
      recoveryEntries.push({ type: "custom", customType, data });
    },
  };
  const recovered = new PersistentSubagentRegistry(recoveryPi);
  recovered.restore({
    ...context,
    sessionManager: {
      ...context.sessionManager,
      getBranch: () => [{
        type: "custom",
        customType: "persistent-subagents",
        data: {
          version: 2,
          ownerSessionId: "parent-session-id",
          upserts: [interruptedStored],
          removedIds: [],
        },
      }],
    },
  });
  assert.equal(recovered.summaryFor(created.id).lifetime, "task");
  assert.equal(recovered.summaryFor(created.id).status, "blocked");
  assert.deepEqual(recovered.summaryFor(created.id).blocker, {
    reason: "The parent request did not include an expected result",
    need: "An expected result from the parent",
  });
  assert.equal(latestStoredSubagent(recoveryEntries, "parent-session-id", created.id).lifetime, "task");

  const skilled = registry.create(context, {
    mode: "fresh",
    name: "product-scout",
    purpose: "Product requirements and tradeoffs",
    lifetime: "task",
    persona: {
      name: "product-manager",
      description: "Explore product decisions",
      systemPrompt: "Analyze product requirements.",
      contextRequirements: "Provide the goal, constraints, Git base, and relevant scope.",
      preferredLifetime: "task",
      extensions: ["/personas/extensions/unsafe.ts"],
      skills: ["/personas/skills/product/SKILL.md"],
      filePath: "/personas/product-manager.md",
    },
  });
  let storedSkilled = latestStoredSubagent(entries, "parent-session-id", skilled.id);
  const storedPersona = storedSkilled.persona;
  assert.deepEqual(storedPersona.skills, ["/personas/skills/product/SKILL.md"]);
  assert.deepEqual(storedPersona.extensions, ["/personas/extensions/unsafe.ts"]);
  assert.equal(storedPersona.contextRequirements, "Provide the goal, constraints, Git base, and relevant scope.");
  assert.equal(storedPersona.preferredLifetime, "task");
  assert.equal(storedSkilled.lifetime, "task");
  assert.equal(storedSkilled.parentContextProvided, undefined);

  await assert.rejects(
    registry.prompt(context, skilled.id, "Review the work"),
    /product-manager requires context.*goal, constraints, Git base, and relevant scope.*Retry with context/i,
  );
  const acceptedPrompts = [];
  let controllerResponse = "Review complete";
  registry.ensureController = () => ({
    state: { connected: true, busy: false, thinking: "high" },
    subscribe() { return () => {}; },
    async promptAndWait(prompt) {
      acceptedPrompts.push(prompt);
      return {
        text: controllerResponse,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
    },
  });
  const reviewed = await registry.prompt(context, skilled.id, "Context packet and request", {
    parentContextProvided: true,
  });
  assert.equal(reviewed.text, "Review complete");
  assert.deepEqual(acceptedPrompts, ["Context packet and request"]);
  storedSkilled = latestStoredSubagent(entries, "parent-session-id", skilled.id);
  assert.equal(storedSkilled.parentContextProvided, true);
  assert.doesNotMatch(JSON.stringify(entries.at(-1)), /Context packet and request/);
  await registry.prompt(context, skilled.id, "Follow-up without repeated context");
  assert.deepEqual(acceptedPrompts, ["Context packet and request", "Follow-up without repeated context"]);

  controllerResponse = `BLOCKED: Cannot execute targeted tests
NEEDS: Test results for package foo`;
  const blocked = await registry.prompt(context, skilled.id, "Validate with tests");
  assert.equal(blocked.summary.status, "blocked");
  assert.deepEqual(blocked.summary.blocker, {
    reason: "Cannot execute targeted tests",
    need: "Test results for package foo",
  });
  storedSkilled = latestStoredSubagent(entries, "parent-session-id", skilled.id);
  assert.deepEqual(storedSkilled.activeBlocker, blocked.summary.blocker);
  const restoredBlocked = new PersistentSubagentRegistry(pi);
  restoredBlocked.restore({
    ...context,
    sessionManager: { ...context.sessionManager, getBranch: () => entries },
  });
  assert.equal(restoredBlocked.summaryFor(skilled.id).status, "blocked");
  assert.equal(restoredBlocked.summaryFor(skilled.id).blocker.need, "Test results for package foo");

  controllerResponse = `BLOCKED: The targeted test run failed
NEEDS: Failure output for package foo`;
  const replaced = await registry.prompt(context, skilled.id, "The tests failed");
  assert.deepEqual(replaced.summary.blocker, {
    reason: "The targeted test run failed",
    need: "Failure output for package foo",
  });

  controllerResponse = "Validation complete with the supplied test results";
  const unblocked = await registry.prompt(context, skilled.id, "Tests passed; finish validation");
  assert.equal(unblocked.summary.blocker, undefined);
  storedSkilled = latestStoredSubagent(entries, "parent-session-id", skilled.id);
  assert.equal(storedSkilled.activeBlocker, undefined);
  const restoredCleared = new PersistentSubagentRegistry(pi);
  restoredCleared.restore({
    ...context,
    sessionManager: { ...context.sessionManager, getBranch: () => entries },
  });
  assert.equal(restoredCleared.summaryFor(skilled.id).blocker, undefined);

  controllerResponse = `BLOCKED: Final validation needs a decision
NEEDS: A release decision from the parent`;
  await registry.prompt(context, skilled.id, "Perform final validation");
  const restoredSkills = new PersistentSubagentRegistry(pi);
  restoredSkills.restore({
    ...context,
    sessionManager: {
      ...context.sessionManager,
      getBranch: () => entries,
    },
  });
  assert.equal(restoredSkills.summaryFor(skilled.id).status, "blocked");
  await restoredSkills.stop(skilled.id);
  storedSkilled = latestStoredSubagent(entries, "parent-session-id", skilled.id);
  assert.equal(storedSkilled.activeBlocker, undefined);
  const restoredPersona = storedSkilled.persona;
  assert.deepEqual(restoredPersona.skills, ["/personas/skills/product/SKILL.md"]);
  assert.deepEqual(restoredPersona.extensions, ["/personas/extensions/unsafe.ts"]);
  assert.equal(restoredPersona.contextRequirements, "Provide the goal, constraints, Git base, and relevant scope.");
  assert.equal(restoredPersona.preferredLifetime, "task");
  assert.equal(storedSkilled.lifetime, "task");
  assert.equal(storedSkilled.parentContextProvided, true);

  const otherParent = new PersistentSubagentRegistry(pi);
  otherParent.restore({
    ...restoredContext,
    sessionManager: {
      ...restoredContext.sessionManager,
      getSessionId: () => "forked-parent-id",
    },
  });
  assert.deepEqual(otherParent.list(), []);
});

test("registry persistence is incremental and bounds stopped metadata", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-registry-bound-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entries = [];
  const pi = {
    getThinkingLevel: () => "low",
    appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
  };
  const context = {
    cwd: root,
    model: undefined,
    scopedModels: [],
    sessionManager: {
      getSessionId: () => "bounded-registry-parent",
      getSessionFile: () => join(root, "parent.jsonl"),
      getBranch: () => [],
    },
  };
  const registry = new PersistentSubagentRegistry(pi);
  registry.restore(context);

  for (let index = 0; index < MAX_RETAINED_STOPPED_SUBAGENTS + 5; index++) {
    const summary = registry.create(context, {
      mode: "fresh",
      name: `bounded-${index}`,
      purpose: `Bounded registry instance ${index}`,
    });
    await registry.stop(summary.id);
  }

  assert.equal(registry.list().length, MAX_RETAINED_STOPPED_SUBAGENTS);
  assert.ok(registry.list().every(({ status }) => status === "stopped"));
  assert.throws(() => registry.summaryFor("bounded-0"), /Unknown subagent/);
  assert.equal(registry.summaryFor(`bounded-${MAX_RETAINED_STOPPED_SUBAGENTS + 4}`).status, "stopped");
  assert.ok(entries.every(({ data }) => data.version === 2));
  assert.ok(entries.every(({ data }) => data.upserts.length <= 1));
  assert.ok(entries.some(({ data }) => data.removedIds.length === 1));
  assert.ok(entries.every(({ data }) => data.subagents === undefined));

  const restored = new PersistentSubagentRegistry(pi);
  restored.restore({
    ...context,
    sessionManager: { ...context.sessionManager, getBranch: () => entries },
  });
  assert.equal(restored.list().length, MAX_RETAINED_STOPPED_SUBAGENTS);
});

test("lifetime promotion restarts a live controller before follow-up", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-lifetime-restart-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pi = { getThinkingLevel: () => "low", appendEntry() {} };
  const context = {
    cwd: root,
    model: undefined,
    scopedModels: [],
    sessionManager: {
      getSessionId: () => "lifetime-restart-parent",
      getSessionFile: () => join(root, "parent.jsonl"),
      getBranch: () => [],
    },
  };
  const registry = new PersistentSubagentRegistry(pi);
  registry.restore(context);
  const created = registry.create(context, {
    mode: "fresh",
    name: "promoted-agent",
    purpose: "Validate lifetime restart behavior",
    lifetime: "one-shot",
  });
  const record = registry.resolve(created.id);
  let stopped = 0;
  record.controller = {
    state: { connected: false, thinking: "low" },
    async stop() { stopped++; },
  };
  record.unsubscribe = () => {};

  const promoted = await registry.setLifetime(created.id, "task");
  assert.equal(stopped, 1);
  assert.equal(record.controller, undefined);
  assert.equal(promoted.lifetime, "task");
  assert.equal(promoted.status, "dormant");
});

test("model creation is unavailable when no personas are configured", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-no-subagent-personas-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tools = new Map();
  subagentsModule.default({
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand() {},
    on() {},
  }, { personaDirectory: join(root, "missing") });

  await assert.rejects(
    tools.get("subagent").execute("create-without-personas", {
      action: "create",
      purpose: "Attempt generic delegation",
    }, undefined, undefined, {}),
    /No subagent personas are configured; create requires an existing persona/i,
  );
});

test("model-created subagents honor persona lifetime preferences and explicit overrides", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-lifetimes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const personaDirectory = join(root, "personas");
  await mkdir(personaDirectory);
  await writeFile(join(personaDirectory, "bounded-analyst.md"), `---
name: bounded-analyst
description: Complete bounded analysis
preferred-lifetime: one-shot
---
Return a complete analysis.
`);

  const originalPrompt = PersistentSubagentRegistry.prototype.prompt;
  t.after(() => { PersistentSubagentRegistry.prototype.prompt = originalPrompt; });
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  PersistentSubagentRegistry.prototype.prompt = async function (_ctx, target, prompt, options = {}) {
    const summary = this.summaryFor(target);
    if (prompt.includes("FAIL")) throw new Error("Synthetic one-shot failure");
    if (prompt.includes("CANCEL")) {
      await new Promise((_, reject) => {
        const abort = () => reject(options.signal?.reason ?? new Error("Synthetic cancellation"));
        if (options.signal?.aborted) abort();
        else options.signal?.addEventListener("abort", abort, { once: true });
      });
    }
    if (prompt.includes("BLOCKED-RESULT")) {
      const text = `BLOCKED: A required expected result is missing
NEEDS: The expected behavior from the parent`;
      this.updateBlocker(this.resolve(target), text);
      return {
        summary: this.summaryFor(target),
        text,
        usage,
        responseProduced: true,
        handledWithoutAgent: false,
        stopReason: "stop",
      };
    }
    const text = prompt.includes("LONG")
      ? Array.from({ length: 3_000 }, (_, index) => `long result ${index + 1}`).join("\n")
      : prompt.includes("EMPTY")
        ? ""
        : prompt.includes("LENGTH")
          ? "Partial bounded result"
          : "Bounded result";
    return {
      summary,
      text,
      usage,
      responseProduced: Boolean(text),
      handledWithoutAgent: false,
      stopReason: prompt.includes("LENGTH") ? "length" : "stop",
    };
  };

  const tools = new Map();
  const events = new Map();
  const pi = {
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand() {},
    on(name, handler) { events.set(name, handler); },
    getThinkingLevel() { return "low"; },
    appendEntry() {},
  };
  subagentsModule.default(pi, { personaDirectory });
  const context = {
    cwd: root,
    model: undefined,
    scopedModels: [],
    sessionManager: {
      getSessionId: () => "lifetime-parent",
      getSessionFile: () => join(root, "parent.jsonl"),
      getBranch: () => [],
    },
  };
  events.get("session_start")({}, context);
  const tool = tools.get("subagent");
  const signal = new AbortController().signal;

  const personas = await tool.execute("list-personas", {
    action: "list",
    kind: "personas",
  }, signal, undefined, context);
  assert.match(personas.content[0].text, /bounded-analyst: Complete bounded analysis \[prefers one-shot\]/);
  assert.equal(personas.details.personas[0].preferredLifetime, "one-shot");
  await assert.rejects(
    tool.execute("preferred-one-shot-without-prompt", {
      action: "create",
      name: "invalid-preferred-one-shot",
      persona: "bounded-analyst",
      purpose: "Invalid dormant preferred one-shot",
    }, signal, undefined, context),
    /one-shot subagents require an initial prompt/i,
  );

  const oneShot = await tool.execute("one-shot", {
    action: "create",
    name: "one-shot-default",
    persona: "bounded-analyst",
    purpose: "Return one bounded result",
    prompt: "Complete this bounded request",
  }, signal, undefined, context);
  assert.equal(oneShot.details.subagent.lifetime, "one-shot");
  assert.equal(oneShot.details.subagent.status, "stopped");
  assert.equal(oneShot.content[0].text, "Completed one-shot one-shot-default.\n\nBounded result");

  const blockedOneShot = await tool.execute("blocked-one-shot", {
    action: "create",
    name: "blocked-one-shot",
    persona: "bounded-analyst",
    purpose: "Request bounded work without enough context",
    prompt: "BLOCKED-RESULT",
  }, signal, undefined, context);
  assert.equal(blockedOneShot.details.subagent.lifetime, "task");
  assert.equal(blockedOneShot.details.subagent.status, "blocked");
  assert.match(blockedOneShot.content[0].text, /^Retained blocked-one-shot as a task because it is blocked\./);
  assert.match(blockedOneShot.content[0].text, /NEEDS: The expected behavior from the parent/);
  const stoppedBlocked = await tool.execute("stop-blocked-one-shot", {
    action: "stop",
    id: "blocked-one-shot",
  }, signal, undefined, context);
  assert.equal(stoppedBlocked.details.subagent.blocker, undefined);

  const task = await tool.execute("task-override", {
    action: "create",
    name: "task-override",
    persona: "bounded-analyst",
    purpose: "Retain a bounded analyst through validation",
    lifetime: "task",
    prompt: "Begin an iterative task",
  }, signal, undefined, context);
  assert.equal(task.details.subagent.lifetime, "task");
  assert.notEqual(task.details.subagent.status, "stopped");
  assert.match(task.content[0].text, /^Saved as task-override\./);

  const persistent = await tool.execute("persistent-override", {
    action: "create",
    name: "persistent-override",
    persona: "bounded-analyst",
    purpose: "Retain reusable bounded-analysis context",
    lifetime: "persistent",
  }, signal, undefined, context);
  assert.equal(persistent.details.subagent.lifetime, "persistent");
  assert.equal(persistent.content[0].text, "Created persistent-override.");

  const retained = await tool.execute("truncated-one-shot", {
    action: "create",
    name: "truncated-one-shot",
    persona: "bounded-analyst",
    purpose: "Produce a result requiring continuation",
    prompt: "LONG",
  }, signal, undefined, context);
  assert.equal(retained.details.subagent.lifetime, "task");
  assert.notEqual(retained.details.subagent.status, "stopped");
  assert.match(retained.content[0].text, /^Retained truncated-one-shot as a task because its response was truncated\./);
  assert.match(retained.content[0].text, /Full response retained by truncated-one-shot/);

  const incomplete = await tool.execute("incomplete-one-shot", {
    action: "create",
    name: "incomplete-one-shot",
    persona: "bounded-analyst",
    purpose: "Retain an answer that hit the model output limit",
    prompt: "LENGTH",
  }, signal, undefined, context);
  assert.equal(incomplete.details.subagent.lifetime, "task");
  assert.notEqual(incomplete.details.subagent.status, "stopped");
  assert.match(incomplete.content[0].text, /^Retained incomplete-one-shot as a task because the model reached its output limit\./);
  assert.match(incomplete.content[0].text, /Partial bounded result/);
  await tool.execute("stop-incomplete-one-shot", {
    action: "stop",
    id: "incomplete-one-shot",
  }, signal, undefined, context);

  const empty = await tool.execute("empty-one-shot", {
    action: "create",
    name: "empty-one-shot",
    persona: "bounded-analyst",
    purpose: "Retain a request with no visible response",
    prompt: "EMPTY",
  }, signal, undefined, context);
  assert.equal(empty.details.subagent.lifetime, "task");
  assert.match(empty.content[0].text, /^Retained empty-one-shot as a task because the subagent produced no visible response\./);
  await tool.execute("stop-empty-one-shot", {
    action: "stop",
    id: "empty-one-shot",
  }, signal, undefined, context);

  await assert.rejects(
    tool.execute("failed-one-shot", {
      action: "create",
      name: "failed-one-shot",
      persona: "bounded-analyst",
      purpose: "Fail one bounded request",
      prompt: "FAIL",
    }, signal, undefined, context),
    /Synthetic one-shot failure/,
  );
  const failed = await tool.execute("failed-status", {
    action: "status",
    id: "failed-one-shot",
  }, signal, undefined, context);
  assert.equal(failed.details.subagent.status, "stopped");
  assert.equal(failed.details.subagent.lifetime, "one-shot");

  const cancellation = new AbortController();
  const canceledPrompt = tool.execute("canceled-one-shot", {
    action: "create",
    name: "canceled-one-shot",
    persona: "bounded-analyst",
    purpose: "Cancel one bounded request",
    prompt: "CANCEL",
  }, cancellation.signal, undefined, context);
  cancellation.abort(new Error("Parent canceled one-shot"));
  await assert.rejects(canceledPrompt, /Parent canceled one-shot/);
  const canceled = await tool.execute("canceled-status", {
    action: "status",
    id: "canceled-one-shot",
  }, signal, undefined, context);
  assert.equal(canceled.details.subagent.status, "stopped");
  assert.equal(canceled.details.subagent.lifetime, "one-shot");

  await events.get("session_shutdown")({}, context);
});

test("four-subagent limit is enforced and human stop frees a slot", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-limit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const personaDirectory = join(root, "personas");
  await mkdir(personaDirectory);
  await writeFile(join(personaDirectory, "test-scout.md"), `---
name: test-scout
description: Test persistent subagent limits
---
Inspect the project without changing it.
`);
  const tools = new Map();
  const commands = new Map();
  const events = new Map();
  const notifications = [];
  const confirmations = [];
  let activeTools = ["read", "subagent"];
  const pi = {
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand(name, command) { commands.set(name, command); },
    on(name, handler) { events.set(name, handler); },
    getActiveTools() { return [...activeTools]; },
    setActiveTools(next) { activeTools = [...next]; },
    getThinkingLevel() { return "low"; },
    appendEntry() {},
  };
  subagentsModule.default(pi, { personaDirectory });
  const context = {
    cwd: root,
    mode: "tui",
    hasUI: true,
    model: undefined,
    scopedModels: [],
    isIdle: () => true,
    sessionManager: {
      getSessionId: () => "limit-parent",
      getSessionFile: () => join(root, "parent.jsonl"),
      getBranch: () => [],
    },
    ui: {
      notify(message, level) { notifications.push({ message, level }); },
      async confirm(title, message) {
        confirmations.push({ title, message });
        return true;
      },
      async select() { return undefined; },
      setEditorText() {},
    },
  };
  events.get("session_start")({}, context);
  const subagentTool = tools.get("subagent");
  const signal = new AbortController().signal;

  await commands.get("subagents").handler("--disable", context);
  assert.deepEqual(activeTools, ["read"]);
  assert.ok(notifications.some(({ message }) => message === "Model subagent tool disabled."));
  await commands.get("children").handler("--enable", context);
  assert.deepEqual(activeTools, ["read", "subagent"]);
  assert.ok(notifications.some(({ message }) => message === "Model subagent tool enabled."));

  await assert.rejects(
    subagentTool.execute("create-without-persona", {
      action: "create",
      name: "persona-less",
      purpose: "Attempt persona-less delegation",
    }, signal, undefined, context),
    /persona is required for create.*list personas/i,
  );
  await assert.rejects(
    subagentTool.execute("create-unknown-persona", {
      action: "create",
      persona: "unknown",
      purpose: "Attempt unknown delegation",
    }, signal, undefined, context),
    /Unknown subagent persona "unknown".*list personas/i,
  );
  await assert.rejects(
    subagentTool.execute("context-without-prompt", {
      action: "create",
      name: "context-only",
      purpose: "Context without an accompanying request",
      persona: "test-scout",
      context: "Goal: inspect the project",
    }, signal, undefined, context),
    /context requires an accompanying prompt/i,
  );
  await assert.rejects(
    subagentTool.execute("context-on-list", {
      action: "list",
      context: "Not valid for list",
    }, signal, undefined, context),
    /context is only valid with create or prompt/i,
  );
  await assert.rejects(
    subagentTool.execute("oversized-context", {
      action: "list",
      context: "x".repeat(8_001),
    }, signal, undefined, context),
    /context exceeds 8000 characters/i,
  );
  await assert.rejects(
    subagentTool.execute("profile-on-list", {
      action: "list",
      profile: "fast",
    }, signal, undefined, context),
    /profile is only valid with create/i,
  );
  await assert.rejects(
    subagentTool.execute("lifetime-on-list", {
      action: "list",
      lifetime: "task",
    }, signal, undefined, context),
    /lifetime is only valid with create/i,
  );
  await assert.rejects(
    subagentTool.execute("persona-on-list", {
      action: "list",
      persona: "test-scout",
    }, signal, undefined, context),
    /persona is not valid for subagent action "list"/i,
  );
  await assert.rejects(
    subagentTool.execute("offset-on-subagent-list", {
      action: "list",
      offset: 1,
    }, signal, undefined, context),
    /offset and limit are only valid for persona lists/i,
  );
  await assert.rejects(
    subagentTool.execute("kind-on-create", {
      action: "create",
      kind: "personas",
      persona: "test-scout",
      purpose: "Invalid create field",
    }, signal, undefined, context),
    /kind is not valid for subagent action "create"/i,
  );
  await assert.rejects(
    subagentTool.execute("purpose-on-status", {
      action: "status",
      id: "missing",
      purpose: "Invalid status field",
    }, signal, undefined, context),
    /purpose is not valid for subagent action "status"/i,
  );
  await assert.rejects(
    subagentTool.execute("unknown-field", {
      action: "list",
      unexpected: true,
    }, signal, undefined, context),
    /unexpected is not valid for subagent action "list"/i,
  );
  await assert.rejects(
    subagentTool.execute("one-shot-without-prompt", {
      action: "create",
      persona: "test-scout",
      purpose: "Invalid dormant one-shot",
      lifetime: "one-shot",
    }, signal, undefined, context),
    /one-shot subagents require an initial prompt/i,
  );

  const profileNames = ["fast", "balanced", "deep"];
  const createdWithProfiles = [];
  for (let index = 1; index <= MAX_PERSISTENT_SUBAGENTS; index++) {
    createdWithProfiles.push(await subagentTool.execute(`create-${index}`, {
      action: "create",
      name: `agent-${index}`,
      persona: "test-scout",
      purpose: `Retain context for project area ${index}`,
      ...(profileNames[index - 1] ? { profile: profileNames[index - 1] } : {}),
    }, signal, undefined, context));
  }
  assert.deepEqual(
    createdWithProfiles.slice(0, 3).map(({ details }) => ({
      model: details.subagent.model,
      thinking: details.subagent.thinking,
    })),
    [
      { model: "openai-codex/gpt-5.6-luna", thinking: "high" },
      { model: "openai-codex/gpt-5.6-terra", thinking: "xhigh" },
      { model: "openai-codex/gpt-5.6-sol", thinking: "xhigh" },
    ],
  );
  await assert.rejects(
    subagentTool.execute("create-duplicate-purpose", {
      action: "create",
      name: "duplicate-area",
      persona: "test-scout",
      purpose: "retain context for project area 1",
    }, signal, undefined, context),
    /agent-1 .*already retains context.*action "prompt"/i,
  );
  await assert.rejects(
    subagentTool.execute("create-over-limit", {
      action: "create",
      name: "agent-over-limit",
      persona: "test-scout",
      purpose: "This purpose should be rejected by the limit",
    }, signal, undefined, context),
    /limit reached \(4\)/i,
  );

  await commands.get("subagents").handler("--stop agent-1", context);
  assert.equal(confirmations.length, 1);
  assert.match(confirmations[0].message, /cannot be prompted again/i);
  assert.ok(notifications.some(({ message }) => /Stopped agent-1/.test(message)));
  const stopped = await subagentTool.execute("status-stopped", {
    action: "status",
    id: "agent-1",
  }, signal, undefined, context);
  assert.equal(stopped.details.subagent.status, "stopped");
  assert.equal(stopped.content[0].text, "agent-1 [stopped, persistent]: Retain context for project area 1");
  assert.doesNotMatch(stopped.content[0].text, /sa_[a-f0-9]+/);

  const replacement = await subagentTool.execute("create-replacement", {
    action: "create",
    name: "agent-9",
    persona: "test-scout",
    purpose: "Retain context for the replacement project area",
  }, signal, undefined, context);
  assert.equal(replacement.details.subagent.status, "dormant");
  assert.equal(replacement.details.subagent.purpose, "Retain context for the replacement project area");
  assert.equal(replacement.content[0].text, "Created agent-9.");
  assert.doesNotMatch(replacement.content[0].text, /sa_[a-f0-9]+/);
  const listed = await subagentTool.execute("list-with-purposes", {
    action: "list",
  }, signal, undefined, context);
  assert.match(listed.content[0].text, /agent-9 \[dormant, persistent\]: Retain context for the replacement project area/);
  assert.doesNotMatch(listed.content[0].text, /agent-1|sa_[a-f0-9]+|thinking|\/gpt|\/claude/);
  await events.get("session_shutdown")({}, context);
});

test("child args preserve the parent's scoped model cycle", () => {
  const scopedModels = [
    { provider: "anthropic", id: "claude-sonnet-4-6", thinkingLevel: "high" },
    { provider: "openai", id: "gpt-5.4" },
  ];
  assert.equal(
    formatChildModelScope(scopedModels),
    "anthropic/claude-sonnet-4-6:high,openai/gpt-5.4",
  );

  const args = buildChildProcessArgs({ mode: "fresh", scopedModels });
  assert.deepEqual(args.slice(args.indexOf("--models"), args.indexOf("--models") + 2), [
    "--models",
    "anthropic/claude-sonnet-4-6:high,openai/gpt-5.4",
  ]);
});

test("forked persona args load declared resources with Pi's normal tool selection", () => {
  const persona = {
    name: "reviewer",
    description: "Review changes",
    systemPrompt: "You are a reviewer.",
    extensions: ["/personas/extensions/review.ts"],
    skills: ["/personas/skills/review/SKILL.md"],
    model: "openai/gpt-5.4",
    thinking: "medium",
    filePath: "/personas/reviewer.md",
  };
  const args = buildChildProcessArgs({
    mode: "fork",
    parentSessionFile: "/sessions/parent.jsonl",
    persona,
    model: "anthropic/ignored",
    thinking: "off",
  });

  assert.deepEqual(args, [
    "--mode", "rpc",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--model", "openai/gpt-5.4",
    "--thinking", "medium",
    "--system-prompt", "You are a reviewer.\n",
    "--extension", "/personas/extensions/review.ts",
    "--skill", "/personas/skills/review/SKILL.md",
    "--fork", "/sessions/parent.jsonl",
  ]);
  assert.equal(args.includes("--tools"), false);
  assert.equal(args.includes("--no-extensions"), true);
  assert.equal(args.includes("--no-skills"), true);
  assert.deepEqual(args.filter((value) => value === "--extension"), ["--extension"]);
  assert.deepEqual(args.filter((value) => value === "--skill"), ["--skill"]);
});

test("restored subagent args use its session model history", () => {
  const persona = {
    name: "codebase-explorer",
    description: "Codebase explorer",
    systemPrompt: "Read the project.",
    extensions: [],
    skills: [],
    model: "anthropic/should-not-override",
    thinking: "max",
    filePath: "/personas/codebase-explorer.md",
  };
  const args = buildChildProcessArgs({
    mode: "fresh",
    sessionFile: "/sessions/subagent.jsonl",
    sessionDir: "/sessions",
    sessionName: "auth-scout",
    persona,
    model: "openai/also-ignored",
    thinking: "high",
  });

  assert.deepEqual(args.slice(-4), [
    "--system-prompt", "Read the project.\n",
    "--session", "/sessions/subagent.jsonl",
  ]);
  assert.equal(args.includes("--tools"), false);
  assert.equal(args.includes("--model"), false);
  assert.equal(args.includes("--thinking"), false);
});

test("fork args require a persisted parent session", () => {
  assert.throws(() => buildChildProcessArgs({ mode: "fork" }), /persisted parent session/i);
  assert.throws(
    () => buildChildProcessArgs({ mode: "fork", parentSessionFile: "/parent.jsonl", sessionFile: "/child.jsonl" }),
    /cannot restore/i,
  );
});

test("bundled personas provide focused defaults and user personas override by name", async (t) => {
  const bundled = loadChildPersonas(BUNDLED_PERSONA_DIRECTORY);
  assert.deepEqual(bundled.diagnostics, []);
  assert.deepEqual(bundled.personas.map(({ name }) => name), [
    "codebase-explorer",
    "doc-auditor",
    "reviewer",
    "test-analyst",
  ]);
  assert.deepEqual(
    bundled.personas.find(({ name }) => name === "reviewer").skills,
    [join(BUNDLED_PERSONA_DIRECTORY, "../../../manual-skills/go-code-review/SKILL.md")],
  );
  assert.equal(
    bundled.personas.filter(({ name }) => name !== "reviewer").every(({ skills }) => skills.length === 0),
    true,
  );
  assert.deepEqual(
    bundled.personas.map(({ name, systemPrompt }) => ({
      name,
      role: systemPrompt.split("\n", 1)[0],
    })),
    [
      { name: "codebase-explorer", role: "You are a codebase explorer and architecture analyst. Build an evidence-based map of the requested subsystem so the caller can reason about it without rereading the entire codebase." },
      { name: "doc-auditor", role: "You are a documentation auditor. Verify that documentation matches actual behavior and gives its intended audience enough information to use the documented functionality correctly." },
      { name: "reviewer", role: "You are a code reviewer, not an implementation agent." },
      { name: "test-analyst", role: "You are a test analyst, not an implementation agent. Determine whether the required behavior is adequately tested and identify likely regression modes." },
    ],
  );
  const bundledPrompts = Object.fromEntries(
    bundled.personas.map(({ name, systemPrompt }) => [name, systemPrompt]),
  );
  assert.match(bundledPrompts["codebase-explorer"], /Trace entry points, control flow, data flow, dependencies, and tests/);
  assert.match(bundledPrompts["codebase-explorer"], /Do not edit or write project files.*use Bash to inspect.*explore dependencies/s);
  assert.match(bundledPrompts["doc-auditor"], /Report only actionable findings.*documentation and implementation evidence/s);
  assert.match(bundledPrompts["doc-auditor"], /Do not edit files/);
  assert.match(
    bundledPrompts.reviewer,
    /stated review focus as a hard boundary.*specific guideline.*report only findings that directly answer it.*Do not expand.*general review/s,
  );
  assert.match(bundledPrompts.reviewer, /Report only actionable findings.*only within the review scope.*failure scenario and impact/s);
  assert.match(bundledPrompts.reviewer, /Do not suggest fixes, remediation, replacement code, or implementation directions/);
  assert.match(bundledPrompts.reviewer, /Do not edit files or run tests.*Base the review on the changes and repository evidence/s);
  assert.match(bundledPrompts["test-analyst"], /recommend focused tests.*setup, action, and assertions/s);
  assert.match(bundledPrompts["test-analyst"], /Do not edit files.*Run focused tests when useful.*commands and outcomes you actually observed/s);
  assert.equal(
    bundled.personas.find(({ name }) => name === "codebase-explorer").contextRequirements,
    "Provide the objective, subsystem or scope, key questions, and relevant constraints.",
  );
  assert.deepEqual(
    bundled.personas.map(({ name, model, thinking, preferredLifetime }) => ({
      name,
      model,
      thinking,
      preferredLifetime,
    })),
    [
      { name: "codebase-explorer", model: "openai-codex/gpt-5.6-luna", thinking: "high", preferredLifetime: "persistent" },
      { name: "doc-auditor", model: "openai-codex/gpt-5.6-luna", thinking: "high", preferredLifetime: "one-shot" },
      { name: "reviewer", model: "openai-codex/gpt-5.6-terra", thinking: "xhigh", preferredLifetime: "task" },
      { name: "test-analyst", model: "openai-codex/gpt-5.6-terra", thinking: "xhigh", preferredLifetime: "one-shot" },
    ],
  );
  assert.match(
    bundled.personas.find(({ name }) => name === "reviewer").contextRequirements,
    /review focus or question.*objective.*scope.*Git comparison scope\/base.*if applicable/i,
  );

  const root = await mkdtemp(join(tmpdir(), "pi-persona-override-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "reviewer.md"), `---
name: reviewer
description: Custom reviewer
---
Review using local conventions.
`);
  const merged = loadChildPersonasFromDirectories([BUNDLED_PERSONA_DIRECTORY, root]);
  assert.deepEqual(merged.diagnostics, []);
  assert.equal(merged.personas.find(({ name }) => name === "reviewer").description, "Custom reviewer");
  assert.equal(merged.personas.find(({ name }) => name === "reviewer").preferredLifetime, undefined);
  assert.equal(merged.personas.find(({ name }) => name === "reviewer").filePath, join(root, "reviewer.md"));
});

test("persona descriptions truncate at a Unicode code-point boundary", () => {
  const description = normalizePersonaDescription(`${"a".repeat(238)}😀 trailing text`);
  assert.equal(description, `${"a".repeat(238)}…`);
  assert.doesNotMatch(description, /�/u);
});

test("child personas load markdown prompts and resolve explicit resource paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-personas-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const personaDir = join(root, "personas");
  await mkdir(personaDir);
  await mkdir(join(root, "extensions"), { recursive: true });
  await mkdir(join(root, "skills", "research"), { recursive: true });
  await mkdir(join(root, "skills", "product"), { recursive: true });
  await writeFile(join(root, "extensions", "context.ts"), "export default function () {}\n");
  await writeFile(join(root, "skills", "research", "SKILL.md"), "---\nname: research\ndescription: Research a topic.\n---\n");
  await writeFile(join(root, "skills", "product", "SKILL.md"), "---\nname: product\ndescription: Analyze product decisions.\n---\n");
  await writeFile(join(personaDir, "a-product.md"), `---
name: product-manager
description: Explore product decisions
context-requirements: >
  Provide the goal, expected behavior, constraints, Git base revision,
  and relevant scope. Do not include patch text.
preferred-lifetime: task
extensions:
  - ../extensions/context.ts
skill: ../skills/research/SKILL.md
skills:
  - ../skills/research/SKILL.md
  - ../skills/product/SKILL.md
model: anthropic/claude-sonnet-4-6
thinking: low
---
You are a product manager, not a coding agent.
`);
  await writeFile(join(personaDir, "z-duplicate.md"), `---
name: product-manager
description: Duplicate
---
Duplicate body.
`);
  await writeFile(join(personaDir, "invalid.md"), `---
name: Invalid Name
---
Invalid body.
`);
  await writeFile(join(personaDir, "empty.md"), "---\nname: empty\n---\n");
  await writeFile(join(personaDir, "missing-extension.md"), `---
name: missing-extension
description: Invalid extension path
extensions: ../extensions/missing.ts
---
This persona should be rejected.
`);
  await writeFile(join(personaDir, "missing-skill.md"), `---
name: missing-skill
description: Invalid skill path
skills: ../skills/missing/SKILL.md
---
This persona should be rejected.
`);
  await writeFile(join(personaDir, "long-context.md"), `---
name: long-context
description: Invalid context requirements
context-requirements: ${"requirement ".repeat(30)}
---
This persona should be rejected.
`);
  await writeFile(join(personaDir, "long-name.md"), `---
name: ${"a".repeat(65)}
description: Invalid long name
---
This persona should be rejected.
`);
  await writeFile(join(personaDir, "invalid-lifetime.md"), `---
name: invalid-lifetime
description: Invalid lifetime preference
preferred-lifetime: temporary
---
This persona should be rejected.
`);

  const discovery = loadChildPersonas(personaDir);
  assert.equal(discovery.personas.length, 1);
  assert.equal(
    formatPersonaForModel(discovery.personas[0]),
    "product-manager: Explore product decisions [prefers task] [context required: Provide the goal, expected behavior, constraints, Git base revision, and relevant scope. Do not include patch text.]",
  );
  assert.deepEqual(discovery.personas[0], {
    name: "product-manager",
    description: "Explore product decisions",
    systemPrompt: "You are a product manager, not a coding agent.",
    contextRequirements: "Provide the goal, expected behavior, constraints, Git base revision, and relevant scope. Do not include patch text.",
    preferredLifetime: "task",
    extensions: [join(root, "extensions", "context.ts")],
    skills: [
      join(root, "skills", "research", "SKILL.md"),
      join(root, "skills", "product", "SKILL.md"),
    ],
    model: "anthropic/claude-sonnet-4-6",
    thinking: "low",
    filePath: join(personaDir, "a-product.md"),
  });
  assert.equal(discovery.diagnostics.length, 8);
  assert.ok(discovery.diagnostics.some((diagnostic) => /duplicate child persona/i.test(diagnostic)));
  assert.ok(discovery.diagnostics.some((diagnostic) => /invalid name/i.test(diagnostic)));
  assert.ok(discovery.diagnostics.some((diagnostic) => /invalid name.*at most 64/i.test(diagnostic)));
  assert.ok(discovery.diagnostics.some((diagnostic) => /system prompt body is empty/i.test(diagnostic)));
  assert.ok(discovery.diagnostics.some((diagnostic) => /extension path does not exist/i.test(diagnostic)));
  assert.ok(discovery.diagnostics.some((diagnostic) => /skill path does not exist/i.test(diagnostic)));
  assert.ok(discovery.diagnostics.some((diagnostic) => /context-requirements exceeds 240 characters/i.test(diagnostic)));
  assert.ok(discovery.diagnostics.some((diagnostic) => /invalid preferred-lifetime.*temporary/i.test(diagnostic)));
});
