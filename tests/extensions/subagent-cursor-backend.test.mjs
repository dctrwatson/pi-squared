import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const backendModule = await import("../../extensions/subagents/cursor-backend.ts");
const { SubagentSessionController } = await import("../../extensions/subagents/controller.ts");
const { SubagentPanel } = await import("../../extensions/subagents/ui.ts");

function storedCursor(overrides = {}) {
  return {
    id: "sa_cursor_fake",
    name: "cursor-fake",
    runtime: "cursor-cloud",
    purpose: "Inspect the Cloud backend",
    lifetime: "task",
    mode: "fresh",
    cwd: "/tmp",
    createdAt: 1,
    lastActiveAt: 1,
    localLifecycle: "available",
    remoteCreated: false,
    repositories: [{ url: "https://github.com/example/project", startingRef: "a".repeat(40) }],
    requestedProfile: "balanced",
    currentModel: { id: "cursor-terra", parameters: [{ id: "reasoning_effort", value: "xhigh" }], resolvedAt: 1 },
    pendingOperations: [],
    remoteLifecycle: "local",
    pendingResult: { state: "none" },
    ...overrides,
  };
}

function asyncMessages(messages = []) {
  return (async function* () { for (const message of messages) yield message; })();
}

function fakeRun({
  id = "run-fake",
  agentId = "bc-fake-agent",
  requestId = "request-fake",
  createdAt = 9_000_000_000_000_000,
  status = "finished",
  result = "Final response",
  error,
  usage,
  durationMs,
  git,
  messages = [],
  wait,
  conversation,
} = {}) {
  return {
    id,
    requestId,
    agentId,
    createdAt,
    status,
    result,
    error,
    usage,
    durationMs,
    git,
    supports(operation) { return operation !== "conversation" || Boolean(conversation); },
    unsupportedReason() { return undefined; },
    stream() {
      return asyncMessages(messages.map((message) => ({ agent_id: agentId, run_id: id, ...message })));
    },
    async wait() { return wait ? await wait() : { id, requestId, status, result, error, usage, durationMs, git }; },
    async cancel() {},
    async conversation() { return conversation ? await conversation() : []; },
    onDidChangeStatus() { return () => {}; },
  };
}

function fakeCursorCatalog({ thinkingValues = ["low", "xhigh"], modelIds = ["cursor-a", "cursor-b"] } = {}) {
  const modelFor = (id) => ({
    id,
    name: id,
    aliases: [],
    parameters: [{ id: "reasoning_effort", name: "Reasoning", values: thinkingValues.map((value) => ({ value, name: value })) }],
    variantsPresent: false,
    variantsComplete: true,
    variants: [],
  });
  const resolve = (id, parameters = []) => ({
    requested: id,
    model: modelFor(id),
    selection: { id, parameters: parameters.length ? parameters : [{ id: "reasoning_effort", value: thinkingValues[0] ?? "off" }] },
    resolvedAt: 1,
  });
  return {
    async resolveCreation() { return resolve(modelIds[0]); },
    async resolveSelection(id, parameters) { return resolve(id, parameters); },
    async panelModels() {
      return modelIds.map((id) => ({
        id,
        name: id,
        thinking: { parameterId: "reasoning_effort", values: thinkingValues.map((value) => ({ value, name: value })) },
      }));
    },
  };
}

function requestHash(text) {
  return createHash("sha256").update(text).digest("hex");
}

function markerForNonce(nonce) {
  return `pi-correlation-${createHash("sha256").update(nonce).digest("hex").slice(0, 32)}`;
}

function markedRequest(text, nonce) {
  return `${text}\n\n[Pi request correlation: ${markerForNonce(nonce)}]`;
}

function userConversation(text) {
  return async () => [{ type: "agentConversationTurn", turn: { userMessage: { text }, steps: [] } }];
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await flush();
  }
  throw new Error("Timed out waiting for the test condition");
}

function backendOptions(cursor, events) {
  return {
    cwd: "/tmp",
    args: [],
    cursor,
    onEvent(event) { events.push(event); },
    onExit() {},
  };
}

test("controller routes only the first Cursor parent prompt through bootstrap and fork preparation", async () => {
  const events = [];
  const sends = [];
  let bootstrapCalls = 0;
  let forkSummaryCalls = 0;
  const agent = {
    agentId: "bc-bootstrap-agent",
    async send(message, options) {
      sends.push({ message, options });
      return fakeRun({
        id: `run-bootstrap-${sends.length}`,
        agentId: "bc-bootstrap-agent",
        result: `result-${sends.length}`,
      });
    },
    close() {},
    async listArtifacts() { return []; },
    async getUsage() { return {}; },
  };
  const cursor = {
    stored: storedCursor({
      agentId: "bc-bootstrap-agent",
      pendingOperations: [{ kind: "create-agent", idempotencyKey: "create-bootstrap", createdAt: 1 }],
    }),
    sdk: {
      async createAgent() { return agent; },
      async resumeAgent() { return agent; },
      async getAgent() { return {}; },
      async listRuns() { return sends.length ? [fakeRun({ id: `run-bootstrap-${sends.length}`, agentId: "bc-bootstrap-agent", createdAt: sends.length })] : []; },
      async getRun(id) { return fakeRun({ id, agentId: "bc-bootstrap-agent", createdAt: sends.length || 1 }); },
      async cancelRun() {},
      async archiveAgent() {},
      async listModels() { return []; },
      async listRepositories() { return []; },
    },
    async buildInitialPrompt(request) {
      bootstrapCalls++;
      forkSummaryCalls++;
      return `BOOTSTRAP-${forkSummaryCalls}:${request}`;
    },
    persist() {},
  };
  const controller = new SubagentSessionController({ ui: {} }, {
    args: [], cwd: "/tmp", mode: "fork", initialPrompt: "", scopedModels: [], cursor,
  }, (options) => new backendModule.CursorCloudBackend({ ...options, cursor: options.cursor, onEvent(event) {
    events.push(event);
    options.onEvent(event);
  } }));

  const first = await controller.promptAndWait("Inspect the fork");
  assert.equal(first.text, "result-1");
  await controller.markCursorRunCompletionDelivered({ id: "run-bootstrap-1", runtime: "cursor-cloud", parentOwned: true });
  assert.equal((await controller.promptAndWait("Continue the inspection")).text, "result-2");
  assert.equal(bootstrapCalls, 1);
  assert.equal(forkSummaryCalls, 1, "fork summary is generated only for the first accepted run");
  assert.match(sends[0].message, /^BOOTSTRAP-1:Inspect the fork\n\n\[Pi request correlation: pi-correlation-[a-f0-9]{32}\]$/);
  assert.match(sends[1].message, /^## Current operating constraints\nLifetime: task\nInspect and plan only\. Do not edit, commit, push, create branches, create pull requests, or use mutating MCP operations\.\n## Follow-up request\nContinue the inspection\n\n\[Pi request correlation: pi-correlation-[a-f0-9]{32}\]$/);
  assert.equal(sends[0].options.mode, "plan");
  assert.equal(sends[1].options.mode, "plan");
  assert.notEqual(sends[0].options.idempotencyKey, sends[1].options.idempotencyKey, "new start and follow-up requests use distinct durable keys");
  assert.equal(controller.state.usage.turns, 2, "completed messages count as turns when usage is omitted");
  await controller.stop();
});

test("a restored Cursor panel uses the authoritative Cloud run duration", async () => {
  const events = [];
  const terminal = fakeRun({
    id: "run-restored-duration",
    agentId: "bc-restored-duration",
    durationMs: 8_765,
    result: "Restored result",
  });
  const agent = {
    agentId: "bc-restored-duration",
    async send() { throw new Error("a restored result must not dispatch"); },
    close() {}, async listArtifacts() { return []; }, async getUsage() { return {}; },
  };
  const cursor = {
    stored: storedCursor({
      agentId: agent.agentId,
      remoteCreated: true,
      remoteLifecycle: "idle",
      currentRunId: terminal.id,
      pendingResult: { state: "available", runId: terminal.id },
    }),
    sdk: {
      async createAgent() { throw new Error("must resume restored agent"); },
      async resumeAgent() { return agent; }, async getAgent() { return {}; }, async listRuns() { return []; },
      async getRun() { return terminal; }, async cancelRun() {}, async archiveAgent() {},
      async listModels() { return []; }, async listRepositories() { return []; },
    },
    catalog: fakeCursorCatalog(),
    persist() {},
  };
  const controller = new SubagentSessionController({ ui: {} }, {
    args: [], cwd: "/tmp", mode: "fresh", initialPrompt: "", scopedModels: [], cursor,
  }, (options) => new backendModule.CursorCloudBackend({ ...options, cursor: options.cursor, onEvent(event) {
    events.push(event);
    options.onEvent(event);
  } }));
  await controller.start();
  await waitFor(() => !controller.state.busy && controller.state.durationMs !== undefined);
  assert.equal(controller.state.durationMs, 8_765);
  assert.equal(events.some((event) => event.type === "run_settled"), true);
  await controller.stop();
});

test("Cursor reports thinking controls only for usable selected-model choices", async () => {
  const controlsFor = async (thinkingValues) => {
    const backend = new backendModule.CursorCloudBackend(backendOptions({
      stored: storedCursor(),
      sdk: {},
      catalog: fakeCursorCatalog({ thinkingValues, modelIds: ["cursor-terra"] }),
      persist() {},
    }, []));
    return (await backend.getState()).controlAvailability;
  };
  assert.deepEqual(await controlsFor(["high"]), { model: true, thinking: false });
  assert.deepEqual(await controlsFor(["unsupported", "high"]), { model: true, thinking: false });
  assert.deepEqual(await controlsFor(["high", "xhigh"]), { model: true, thinking: true });
});

test("Cursor hides controls for empty or failed catalogs and recovers on a later state read", async () => {
  const available = [{
    id: "cursor-terra",
    name: "cursor-terra",
    thinking: {
      parameterId: "reasoning_effort",
      values: [{ value: "high", name: "high" }, { value: "xhigh", name: "xhigh" }],
    },
  }];
  for (const initial of ["empty", "error"]) {
    let state = initial;
    const calls = [];
    const catalog = {
      async panelModels() {
        calls.push("panel");
        if (state === "error") throw new Error("catalog unavailable");
        return state === "empty" ? [] : available;
      },
      async refreshPanelModels() {
        calls.push("refresh");
        state = "available";
        return available;
      },
    };
    const backend = new backendModule.CursorCloudBackend(backendOptions({
      stored: storedCursor(), sdk: {}, catalog, persist() {},
    }, []));
    assert.deepEqual((await backend.getState()).controlAvailability, { model: false, thinking: false }, initial);
    assert.deepEqual((await backend.getState()).controlAvailability, { model: true, thinking: true }, initial);
    assert.deepEqual(calls, ["panel", "refresh"], initial);
  }
});

test("Cursor keeps an unrecoverable run transport failure remote-state-unknown without false settlement", async () => {
  const events = [];
  const persisted = [];
  const run = fakeRun({
    id: "run-unrecoverable",
    agentId: "bc-unrecoverable-agent",
    status: "running",
    wait: async () => { throw new Error("transport lost"); },
  });
  const agent = {
    agentId: "bc-unrecoverable-agent",
    async send() { return run; },
    close() {},
    async listArtifacts() { return []; },
    async getUsage() { return {}; },
  };
  const backend = new backendModule.CursorCloudBackend(backendOptions({
    stored: storedCursor({ agentId: "bc-unrecoverable-agent", remoteCreated: true, remoteLifecycle: "idle" }),
    sdk: {
      async createAgent() { throw new Error("must not create"); },
      async resumeAgent() { return agent; },
      async getAgent() { return {}; },
      async listRuns() { return [fakeRun({ id: "run-unrecoverable-baseline", agentId: "bc-unrecoverable-agent", createdAt: 1 })]; },
      async getRun(id) {
        if (id === "run-unrecoverable-baseline") return fakeRun({ id, agentId: "bc-unrecoverable-agent", createdAt: 1 });
        throw new Error("recovery transport lost");
      },
      async cancelRun() {},
      async archiveAgent() {},
      async listModels() { return []; },
      async listRepositories() { return []; },
    },
    persist(next) { persisted.push(structuredClone(next)); },
  }, events));
  await backend.start();
  const accepted = await backend.prompt("Do not falsely settle this");
  await flush();
  await flush();
  const unknown = persisted.at(-1);
  assert.equal(unknown.remoteLifecycle, "remote-state-unknown");
  assert.equal(unknown.localLifecycle, "unavailable");
  assert.equal(unknown.currentRunId, accepted.run.id);
  assert.equal(events.some((event) => event.type === "run_settled"), false);
  assert.equal(events.some((event) => event.type === "message_completed"), false);
});

test("Cursor retries an initial lost response only after reconciliation finds no accepted run", async () => {
  const events = [];
  const persisted = [];
  const sends = [];
  let listCalls = 0;
  const recovered = fakeRun({ id: "run-initial-retry", agentId: "bc-initial-retry", result: "retried initial" });
  const agent = {
    agentId: "bc-initial-retry",
    async send(message, options) {
      sends.push({ message, options: structuredClone(options) });
      if (sends.length === 1) throw new Error("lost response");
      return recovered;
    },
    close() {},
    async listArtifacts() { return []; },
    async getUsage() { return {}; },
  };
  const backend = new backendModule.CursorCloudBackend(backendOptions({
    stored: storedCursor({
      agentId: "bc-initial-retry",
      pendingOperations: [{ kind: "create-agent", idempotencyKey: "create-retry", createdAt: 1 }],
    }),
    sdk: {
      async createAgent() { return agent; },
      async resumeAgent() { return agent; },
      async getAgent() { return {}; },
      async listRuns() { listCalls++; return { runs: [], complete: true }; },
      async getRun() { throw new Error("no accepted run"); },
      async cancelRun() {},
      async archiveAgent() {},
      async listModels() { return []; },
      async listRepositories() { return []; },
    },
    async buildInitialPrompt(request) { return `BOOT:${request}`; },
    persist(next) { persisted.push(structuredClone(next)); },
  }, events));
  await backend.start();
  const result = await backend.prompt("Initial request");
  await flush();
  assert.equal(result.run.id, "run-initial-retry");
  assert.equal(listCalls, 1);
  assert.equal(sends.length, 2);
  assert.match(sends[0].message, /^BOOT:Initial request\n\n\[Pi request correlation: pi-correlation-[a-f0-9]{32}\]$/);
  assert.equal(sends[1].message, sends[0].message, "the retry reuses exact marked text");
  assert.equal(sends[0].options.idempotencyKey, sends[1].options.idempotencyKey);
  const pending = persisted.find((state) => state.pendingOperations.some((operation) => operation.kind === "start-run" && operation.requestHash));
  assert.equal(pending.pendingOperations.find((operation) => operation.kind === "start-run").requestHash, requestHash(sends[0].message));
});

test("Cursor recovers a uniquely attributable lost follow-up response without bootstrap or a second send", async () => {
  const events = [];
  const predecessor = fakeRun({ id: "run-before-follow-up", agentId: "bc-follow-recovered", createdAt: 10 });
  const persisted = [];
  let delivered;
  const accepted = fakeRun({
    id: "run-follow-recovered", agentId: "bc-follow-recovered", createdAt: 20, result: "recovered follow-up",
    conversation: async () => await userConversation(delivered)(),
  });
  let sends = 0;
  let getAgentCalls = 0;
  let listCalls = 0;
  const agent = {
    agentId: "bc-follow-recovered",
    async send(message) { delivered = message; sends++; throw new Error("lost response"); },
    close() {},
    async listArtifacts() { return []; },
    async getUsage() { return {}; },
  };
  const stored = storedCursor({
    agentId: "bc-follow-recovered",
    remoteCreated: true,
    remoteLifecycle: "idle",
    currentRunId: "run-before-follow-up",
  });
  const backend = new backendModule.CursorCloudBackend(backendOptions({
    stored,
    sdk: {
      async createAgent() { throw new Error("must not create"); },
      async resumeAgent() { return agent; },
      async getAgent() { getAgentCalls++; return {}; },
      async listRuns() { listCalls++; return { runs: sends === 0 ? [predecessor] : [predecessor, accepted], complete: true }; },
      async getRun(runId) {
        if (runId === "run-before-follow-up") return predecessor;
        assert.equal(runId, "run-follow-recovered");
        return accepted;
      },
      async cancelRun() {},
      async archiveAgent() {},
      async listModels() { return []; },
      async listRepositories() { return []; },
    },
    async buildInitialPrompt() { throw new Error("bootstrap must not be rebuilt"); },
    persist(next) { persisted.push(structuredClone(next)); },
  }, events));
  await backend.start();
  const result = await backend.followUp("Continue from durable state");
  await flush();
  assert.equal(result.run.id, "run-follow-recovered");
  assert.equal(sends, 1);
  assert.equal(getAgentCalls, 1);
  assert.equal(listCalls, 2);
  assert.equal((await backend.getRunCompletion(result.run)).text, "recovered follow-up");

  const lifecycle = backendModule.createCursorSubagentLifecyclePort({
    async getAgent() { return {}; },
    async listRuns() { return [accepted]; },
    async getRun(runId) { return runId === "run-before-follow-up" ? predecessor : accepted; },
  });
  const operation = persisted.find((state) => state.pendingOperations.some((entry) => entry.kind === "follow-up" && entry.baselineComplete === true))
    .pendingOperations.find((entry) => entry.kind === "follow-up");
  const restored = await lifecycle.reconcile(storedCursor({
    ...stored,
    remoteLifecycle: "remote-state-unknown",
    pendingOperations: [operation],
  }));
  assert.deepEqual(restored, {
    remoteLifecycle: "idle",
    currentRunId: "run-follow-recovered",
    currentRequestId: "request-fake",
    pendingResult: { state: "available", runId: "run-follow-recovered" },
  });
});

test("Cursor stop archives a uniquely reconciled terminal follow-up without consuming its stream", async () => {
  let state = "finished";
  let cancels = 0;
  let archives = 0;
  const predecessor = fakeRun({ id: "run-before-follow-up", agentId: "bc-stop-uncertain", createdAt: 10 });
  const stopNonce = "send-stop-uncertain";
  const active = () => fakeRun({
    id: "run-uncertain-follow", agentId: "bc-stop-uncertain", createdAt: 20, status: state,
    conversation: userConversation(markedRequest("Stop uncertain follow-up", stopNonce)),
  });
  const lifecycle = backendModule.createCursorSubagentLifecyclePort({
    async getAgent() { return {}; },
    async listRuns() { return [active()]; },
    async getRun(runId) {
      if (runId === "run-before-follow-up") return predecessor;
      assert.equal(runId, "run-uncertain-follow");
      return active();
    },
    async cancelRun(runId) {
      assert.equal(runId, "run-uncertain-follow");
      cancels++;
      state = "cancelled";
    },
    async archiveAgent() { archives++; },
  });
  const outcome = await lifecycle.stop(storedCursor({
    agentId: "bc-stop-uncertain",
    remoteCreated: true,
    remoteLifecycle: "remote-state-unknown",
    currentRunId: "run-before-follow-up",
    pendingOperations: [{ kind: "follow-up", idempotencyKey: "follow-unknown", nonce: stopNonce, requestHash: requestHash(markedRequest("Stop uncertain follow-up", stopNonce)), createdAt: 2, baselineComplete: true, baselineRunId: "run-before-follow-up", baselineCreatedAt: 10 }],
  }), { persistArchiveStarted() {} });
  assert.deepEqual(outcome, { state: "stopped" });
  assert.equal(cancels, 1);
  assert.equal(archives, 1);
});

test("Cursor bounds event telemetry, preserves final usage totals, flags all branch metadata, and sanitizes artifact errors", async () => {
  const events = [];
  const huge = "x".repeat(40_000);
  const run = fakeRun({
    id: "run-bounded",
    agentId: "bc-bounded",
    result: huge,
    usage: { inputTokens: 5, outputTokens: 7, totalTokens: 12 },
    git: { branches: [{ branch: "cursor/also-unexpected" }] },
    wait: async () => {
      await flush();
      return { id: "run-bounded", requestId: "request-fake", status: "finished", result: huge, usage: { inputTokens: 5, outputTokens: 7, totalTokens: 12 }, git: { branches: [{ branch: "cursor/also-unexpected" }] } };
    },
    messages: [
      { type: "assistant", message: { content: [{ type: "text", text: huge }] } },
      { type: "tool_call", call_id: "tool-bounded", name: "tool", status: "completed", result: { huge } },
      { type: "usage", usage: { inputTokens: 3 } },
    ],
  });
  const agent = {
    agentId: "bc-bounded",
    async send() { return run; },
    close() {},
    async listArtifacts() { throw new Error("token=secret-value"); },
    async getUsage() {
      return { runs: [{ runId: "run-bounded", usage: { inputTokens: 5, outputTokens: 7, totalTokens: 12 }, cost: { chargedCents: 25 } }] };
    },
  };
  const backend = new backendModule.CursorCloudBackend(backendOptions({
    stored: storedCursor({ agentId: "bc-bounded", remoteCreated: true, remoteLifecycle: "idle" }),
    sdk: {
      async createAgent() { throw new Error("must not create"); },
      async resumeAgent() { return agent; },
      async getAgent() { return {}; },
      async listRuns() { return [fakeRun({ id: "run-bounded-baseline", agentId: "bc-bounded", createdAt: 1 })]; },
      async getRun(id) { return id === "run-bounded-baseline" ? fakeRun({ id, agentId: "bc-bounded", createdAt: 1 }) : run; },
      async cancelRun() {},
      async archiveAgent() {},
      async listModels() { return []; },
      async listRepositories() { return []; },
    },
    persist() {},
  }, events));
  await backend.start();
  const accepted = await backend.prompt("Bound telemetry");
  await flush();
  const completionEvent = events.find((event) => event.type === "message_completed");
  assert.ok(completionEvent.message.text.length <= backendModule.MAX_CURSOR_EVENT_TEXT_CHARS);
  assert.equal(completionEvent.message.truncated, true);
  assert.equal((await backend.getRunCompletion(accepted.run)).text.length, huge.length);
  for (const event of events.filter((event) => event.type === "message_delta" || event.type === "tool_completed")) {
    const text = event.type === "message_delta" ? event.textDelta : event.output;
    assert.ok(text.length <= backendModule.MAX_CURSOR_EVENT_TOOL_OUTPUT_CHARS);
  }
  assert.equal(events.filter((event) => event.type === "policy_warning").length, 1);
  const usage = events.filter((event) => event.type === "usage_update").map((event) => event.usage);
  assert.deepEqual(usage, [
    { input: 3 },
    { input: 2, output: 7, totalTokens: 12, cost: { total: 0.25 } },
  ]);
  await assert.rejects(backend.getArtifacts(), (error) => {
    assert.equal(error.code, "BACKEND_FAILED");
    assert.doesNotMatch(error.message, /secret-value|token=/i);
    return true;
  });
});

test("Cursor lifecycle persists archive start after terminal cancellation and retries archival", async () => {
  let status = "running";
  let cancels = 0;
  let archives = 0;
  const run = () => fakeRun({ id: "run-archive-retry", agentId: "bc-archive-retry", status, createdAt: 1 });
  const lifecycle = backendModule.createCursorSubagentLifecyclePort({
    async getAgent() { return { status }; },
    async listRuns() { return { runs: [run()], complete: true }; },
    async getRun() { return run(); },
    async cancelRun() { cancels++; status = "cancelled"; },
    async archiveAgent() {
      assert.ok(transitions.includes("archive-started"), "archive state persists before archiveAgent");
      archives++;
      if (archives === 1) throw new Error("archive transport failure");
    },
  });
  const stored = storedCursor({ agentId: "bc-archive-retry", remoteCreated: true, remoteLifecycle: "running", currentRunId: "run-archive-retry" });
  const transitions = [];
  const first = await lifecycle.stop(stored, { persistArchiveStarted() { transitions.push("archive-started"); } });
  assert.deepEqual(first, { state: "archive-pending" });
  assert.equal(cancels, 1, "the active run is confirmed terminal before archival");
  assert.deepEqual(transitions, ["archive-started"], "archive state persists before the first archive call");
  const retry = await lifecycle.stop({ ...stored, remoteLifecycle: "archive-pending" }, { persistArchiveStarted() { transitions.push("archive-retry"); } });
  assert.deepEqual(retry, { state: "stopped" });
  assert.equal(cancels, 1, "archive retry does not cancel again");
  assert.equal(archives, 2);
});

test("Cursor normalizes declaration-shaped stream messages and ignores foreign identities", async () => {
  const events = [];
  let settle;
  const settled = new Promise((resolve) => { settle = resolve; });
  const run = fakeRun({
    id: "run-stream-table",
    agentId: "bc-stream-table",
    result: "Final stream result",
    wait: async () => await settled,
    messages: [
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Assistant text" }] } },
      { type: "thinking", text: "Assistant thinking" },
      { type: "tool_call", call_id: "tool-stream", name: "inspect", status: "running", args: { path: "src" } },
      { type: "tool_call", call_id: "tool-stream", name: "inspect", status: "completed", result: { ok: true } },
      { type: "status", status: "RUNNING", message: "Running safely" },
      { type: "request", request_id: "request-stream-updated" },
      { type: "task", status: "RUNNING", text: "Task update" },
      { type: "usage", usage: { inputTokens: 2, reasoningTokens: 1 } },
      { type: "assistant", agent_id: "bc-foreign", run_id: "run-foreign", message: { role: "assistant", content: [{ type: "text", text: "Foreign text" }] } },
    ],
  });
  const agent = {
    agentId: "bc-stream-table",
    async send() { return run; }, close() {}, async listArtifacts() { return []; }, async getUsage() { return {}; },
  };
  const stored = storedCursor({ agentId: agent.agentId, remoteCreated: true, remoteLifecycle: "idle" });
  const backend = new backendModule.CursorCloudBackend(backendOptions({
    stored,
    sdk: {
      async createAgent() { throw new Error("must not create"); }, async resumeAgent() { return agent; }, async getAgent() { return {}; },
      async listRuns() { return [fakeRun({ id: "run-stream-before", agentId: agent.agentId, createdAt: 1 })]; },
      async getRun(id) { return id === "run-stream-before" ? fakeRun({ id, agentId: agent.agentId, createdAt: 1 }) : run; },
      async cancelRun() {}, async archiveAgent() {}, async listModels() { return []; }, async listRepositories() { return []; },
    },
    persist(next) { Object.assign(stored, next); },
  }, events));
  await backend.start();
  const accepted = await backend.prompt("Normalize this stream");
  for (let index = 0; index < 12; index++) await flush();
  assert.ok(events.some((event) => event.type === "message_delta" && event.textDelta === "Assistant text"));
  assert.ok(events.some((event) => event.type === "message_delta" && event.thinkingDelta === "Assistant thinking"));
  assert.ok(events.some((event) => event.type === "tool_started" && event.toolCallId === "tool-stream"));
  assert.ok(events.some((event) => event.type === "tool_completed" && event.toolCallId === "tool-stream"));
  assert.ok(events.some((event) => event.type === "status_update" && event.status === "Running safely"));
  assert.ok(events.some((event) => event.type === "status_update" && event.status === "Task update"));
  assert.deepEqual(events.filter((event) => event.type === "usage_update").map((event) => event.usage), [{ input: 2, reasoningTokens: 1 }]);
  assert.equal(stored.currentRequestId, "request-stream-updated");
  assert.equal(events.some((event) => event.type === "message_delta" && event.textDelta === "Foreign text"), false);
  settle({ id: accepted.run.id, requestId: "request-stream-updated", status: "finished", result: "Final stream result" });
  for (let index = 0; index < 4; index++) await flush();
  assert.equal(events.filter((event) => event.type === "run_settled").length, 1);
});

test("Cursor treats expired runs as terminal during lifecycle reconciliation and stop", async () => {
  let archives = 0;
  const expired = fakeRun({ id: "run-expired", agentId: "bc-expired", status: "expired" });
  const lifecycle = backendModule.createCursorSubagentLifecyclePort({
    async getAgent() { return {}; },
    async listRuns() { return []; },
    async getRun() { return expired; },
    async cancelRun() { throw new Error("expired runs must not cancel"); },
    async archiveAgent() { archives++; },
  });
  const stored = storedCursor({ agentId: "bc-expired", remoteCreated: true, remoteLifecycle: "running", currentRunId: "run-expired" });
  assert.deepEqual(await lifecycle.reconcile(stored), {
    remoteLifecycle: "idle",
    currentRunId: "run-expired",
    currentRequestId: "request-fake",
  });
  assert.deepEqual(await lifecycle.stop(stored, { persistArchiveStarted() {} }), { state: "stopped" });
  assert.equal(archives, 1);
});

test("direct Cursor follow-up rejects without a confirmed initial run", async () => {
  let sends = 0;
  const agent = {
    agentId: "bc-no-follow-up",
    async send() { sends++; return fakeRun({ agentId: "bc-no-follow-up" }); },
    close() {},
    async listArtifacts() { return []; },
    async getUsage() { return {}; },
  };
  const backend = new backendModule.CursorCloudBackend(backendOptions({
    stored: storedCursor({
      agentId: "bc-no-follow-up",
      pendingOperations: [{ kind: "create-agent", idempotencyKey: "create-no-follow-up", createdAt: 1 }],
    }),
    sdk: {
      async createAgent() { return agent; },
      async resumeAgent() { return agent; },
      async getAgent() { return {}; },
      async listRuns() { return []; },
      async getRun() { throw new Error("must not read a run"); },
      async cancelRun() {}, async archiveAgent() {}, async listModels() { return []; }, async listRepositories() { return []; },
    },
    persist() {},
  }, []));
  await backend.start();
  await assert.rejects(backend.followUp("This has no remote predecessor"), (error) => error.code === "BACKEND_FAILED");
  assert.equal(sends, 0);
});

test("Cursor model and thinking selection persist for Plan sends and reject busy or unsupported changes", async () => {
  const persisted = [];
  const sends = [];
  const stored = storedCursor({
    agentId: "bc-model-controls",
    remoteCreated: true,
    remoteLifecycle: "idle",
    currentRunId: "run-model-before",
    currentModel: { id: "cursor-a", parameters: [{ id: "reasoning_effort", value: "low" }], resolvedAt: 1 },
  });
  const completed = fakeRun({ id: "run-model-completed", agentId: stored.agentId, result: "model result", createdAt: 2 });
  const agent = {
    agentId: stored.agentId,
    async send(message, options) { sends.push({ message, options }); return completed; }, close() {}, async listArtifacts() { return []; }, async getUsage() { return {}; },
  };
  const backend = new backendModule.CursorCloudBackend(backendOptions({
    stored,
    catalog: fakeCursorCatalog(),
    sdk: {
      async createAgent() { throw new Error("must not create"); }, async resumeAgent() { return agent; }, async getAgent() { return {}; },
      async listRuns() { return [fakeRun({ id: "run-model-before", agentId: agent.agentId, createdAt: 1 })]; },
      async getRun(id) { return id === completed.id ? completed : fakeRun({ id, agentId: agent.agentId, createdAt: 1 }); },
      async cancelRun() {}, async archiveAgent() {}, async listModels() { return []; }, async listRepositories() { return []; },
    },
    persist(next) { Object.assign(stored, next); persisted.push(structuredClone(next)); },
  }, []));
  await backend.start();
  await backend.setModel("cursor", "cursor-b");
  await backend.setThinkingLevel("xhigh");
  assert.deepEqual(stored.currentModel, { id: "cursor-b", parameters: [{ id: "reasoning_effort", value: "xhigh" }], resolvedAt: 1 });
  await backend.prompt("Use saved model selection");
  assert.deepEqual(sends[0].options.model, { id: "cursor-b", params: [{ id: "reasoning_effort", value: "xhigh" }] });
  assert.equal(sends[0].options.mode, "plan");

  const busyStored = storedCursor({ agentId: "bc-model-busy", remoteCreated: true, remoteLifecycle: "running", currentRunId: "run-model-busy" });
  const busyPersisted = [];
  const busy = new backendModule.CursorCloudBackend(backendOptions({
    stored: busyStored,
    catalog: fakeCursorCatalog(),
    sdk: { async getRun() { return fakeRun({ id: "run-model-busy", agentId: busyStored.agentId, status: "running" }); } },
    persist(next) { busyPersisted.push(structuredClone(next)); },
  }, []));
  await assert.rejects(busy.setModel("cursor", "cursor-b"), (error) => error.code === "BUSY");
  assert.equal(busyPersisted.length, 0, "a busy model change does not mutate durable selection");

  const unsupported = new backendModule.CursorCloudBackend(backendOptions({
    stored: storedCursor({ agentId: "bc-thinking-unsupported", remoteCreated: true, remoteLifecycle: "idle" }),
    catalog: fakeCursorCatalog({ thinkingValues: ["low"] }),
    sdk: {}, persist() {},
  }, []));
  await assert.rejects(unsupported.setThinkingLevel("xhigh"), (error) => error.code === "MODEL_UNAVAILABLE");
  assert.ok(persisted.length >= 2);
});

test("Cursor leaves an uncertain follow-up unarchived when listRuns cannot identify its run", async () => {
  let archives = 0;
  const lifecycle = backendModule.createCursorSubagentLifecyclePort({
    async getAgent() { return {}; },
    async listRuns() { return []; },
    async getRun() { throw new Error("no run is attributable"); },
    async cancelRun() { throw new Error("must not cancel an unknown run"); },
    async archiveAgent() { archives++; },
  });
  const outcome = await lifecycle.stop(storedCursor({
    agentId: "bc-unidentified-follow",
    remoteCreated: true,
    remoteLifecycle: "remote-state-unknown",
    currentRunId: "run-before-follow-up",
    pendingOperations: [{ kind: "follow-up", idempotencyKey: "unknown-follow", createdAt: 2, baselineRunId: "run-before-follow-up", baselineCreatedAt: 10 }],
  }), { persistArchiveStarted() { throw new Error("must not archive"); } });
  assert.deepEqual(outcome, { state: "remote-state-unknown" });
  assert.equal(archives, 0);
});

test("Cursor controller rejects concurrent parent prompts immediately instead of queueing them", async () => {
  let sendCalls = 0;
  let sendStarted;
  const started = new Promise((resolve) => { sendStarted = resolve; });
  let finish;
  const completed = new Promise((resolve) => { finish = resolve; });
  const active = fakeRun({
    id: "run-controller-busy",
    agentId: "bc-controller-busy",
    status: "running",
    wait: () => completed,
  });
  const agent = {
    agentId: "bc-controller-busy",
    async send() { sendCalls++; sendStarted(); return active; },
    close() {}, async listArtifacts() { return []; }, async getUsage() { return {}; },
  };
  const cursor = {
    stored: storedCursor({
      agentId: "bc-controller-busy",
      pendingOperations: [{ kind: "create-agent", idempotencyKey: "create-controller-busy", createdAt: 1 }],
    }),
    sdk: {
      async createAgent() { return agent; }, async resumeAgent() { return agent; }, async getAgent() { return {}; },
      async listRuns() { return []; }, async getRun() { return active; }, async cancelRun() {}, async archiveAgent() {},
      async listModels() { return []; }, async listRepositories() { return []; },
    },
    persist() {},
  };
  const controller = new SubagentSessionController({ ui: {} }, {
    args: [], cwd: "/tmp", mode: "fresh", initialPrompt: "", scopedModels: [], cursor,
  }, (options) => new backendModule.CursorCloudBackend({ ...options, cursor: options.cursor }));
  const first = controller.promptAndWait("First parent request");
  await started;
  await assert.rejects(controller.promptAndWait("Second parent request"), (error) => error.code === "BUSY");
  assert.equal(sendCalls, 1);
  finish({ id: "run-controller-busy", status: "finished", result: "first result" });
  assert.equal((await first).text, "first result");
  await controller.stop();
});

test("Cursor maps expired or missing agents to a safe lifecycle error", async () => {
  const lifecycle = backendModule.createCursorSubagentLifecyclePort({
    async getAgent() { throw { status: 404, message: "secret-token" }; },
  });
  await assert.rejects(lifecycle.reconcile(storedCursor({ agentId: "bc-missing", remoteCreated: true, remoteLifecycle: "idle" })), (error) => {
    assert.equal(error.code, "REMOTE_NOT_FOUND");
    assert.doesNotMatch(error.message, /secret-token/);
    return true;
  });
  const expired = backendModule.createCursorSubagentLifecyclePort({
    async getAgent() { throw { code: "expired", message: "secret-expired-run" }; },
  });
  await assert.rejects(expired.reconcile(storedCursor({ agentId: "bc-expired-error", remoteCreated: true, remoteLifecycle: "idle" })), (error) => {
    assert.equal(error.code, "BACKEND_FAILED");
    assert.equal(error.message, "Cursor Cloud run expired. Refresh status before retrying.");
    assert.doesNotMatch(error.message, /secret-expired-run/);
    return true;
  });
});

test("restore attributes a pending follow-up after older A/B history by server predecessor order", async () => {
  const runA = fakeRun({ id: "run-a", agentId: "bc-history", createdAt: 10 });
  const runB = fakeRun({ id: "run-b", agentId: "bc-history", createdAt: 20 });
  const historyNonce = "send-history";
  const runC = fakeRun({
    id: "run-c", agentId: "bc-history", createdAt: 30, status: "finished",
    conversation: userConversation(markedRequest("Recovered historical turn", historyNonce)),
  });
  const lifecycle = backendModule.createCursorSubagentLifecyclePort({
    async getAgent() { return {}; },
    async listRuns() { return [runA, runB, runC]; },
    async getRun(id) { return id === "run-b" ? runB : id === "run-c" ? runC : (() => { throw new Error("unknown run"); })(); },
  });
  const restored = await lifecycle.reconcile(storedCursor({
    agentId: "bc-history", remoteCreated: true, remoteLifecycle: "remote-state-unknown", currentRunId: "run-b",
    // This client timestamp is far ahead of server time. Only A/B/C server order matters.
    pendingOperations: [{ kind: "follow-up", idempotencyKey: "follow-after-b", nonce: historyNonce, requestHash: requestHash(markedRequest("Recovered historical turn", historyNonce)), createdAt: 9_000_000_000_000_000, baselineComplete: true, baselineRunId: "run-b", baselineCreatedAt: 20 }],
  }));
  assert.deepEqual(restored, { remoteLifecycle: "idle", currentRunId: "run-c", currentRequestId: "request-fake", pendingResult: { state: "available", runId: "run-c" } });
});

test("restore clears an authoritatively absent pending send and preserves ambiguity or transport failure", async () => {
  const predecessor = fakeRun({ id: "run-b", agentId: "bc-absent-follow", createdAt: 10 });
  const absent = backendModule.createCursorSubagentLifecyclePort({
    async getAgent() { return {}; }, async listRuns() { return []; },
    async getRun(runId) { return runId === "run-b" ? predecessor : (() => { throw new Error("unknown run"); })(); },
  });
  const initial = await absent.reconcile(storedCursor({
    agentId: "bc-absent-initial", remoteCreated: false, remoteLifecycle: "remote-state-unknown",
    pendingOperations: [{ kind: "start-run", idempotencyKey: "initial-absent", createdAt: 100 }],
  }));
  assert.deepEqual(initial, { remoteLifecycle: "local", clearPendingSend: true });
  const follow = await absent.reconcile(storedCursor({
    agentId: "bc-absent-follow", remoteCreated: true, remoteLifecycle: "remote-state-unknown", currentRunId: "run-b",
    pendingOperations: [{ kind: "follow-up", idempotencyKey: "follow-absent", createdAt: 100, baselineRunId: "run-b", baselineCreatedAt: 10 }],
  }));
  assert.deepEqual(follow, { remoteLifecycle: "idle", clearPendingSend: true });

  const ambiguousPredecessor = fakeRun({ id: "run-b", agentId: "bc-ambiguous", createdAt: 100 });
  const ambiguity = backendModule.createCursorSubagentLifecyclePort({
    async getAgent() { return {}; },
    async listRuns() { return [
      fakeRun({ id: "run-c", agentId: "bc-ambiguous", createdAt: 101 }),
      fakeRun({ id: "run-d", agentId: "bc-ambiguous", createdAt: 102 }),
    ]; },
    async getRun(runId) { return runId === "run-b" ? ambiguousPredecessor : (() => { throw new Error("candidate is ambiguous"); })(); },
  });
  const uncertain = storedCursor({
    agentId: "bc-ambiguous", remoteCreated: true, remoteLifecycle: "remote-state-unknown", currentRunId: "run-b",
    pendingOperations: [{ kind: "follow-up", idempotencyKey: "follow-ambiguous", createdAt: 100, baselineRunId: "run-b", baselineCreatedAt: 100 }],
  });
  assert.deepEqual(await ambiguity.reconcile(uncertain), { remoteLifecycle: "remote-state-unknown" });
  const unavailable = backendModule.createCursorSubagentLifecyclePort({
    async getAgent() { throw new Error("transport secret"); },
  });
  await assert.rejects(unavailable.reconcile(uncertain), (error) => {
    assert.equal(error.code, "BACKEND_FAILED");
    assert.doesNotMatch(error.message, /secret/);
    return true;
  });
});

test("Cursor tool normalization exits safely for large and throwing proxy objects", async () => {
  const events = [];
  const throwing = new Proxy({}, { ownKeys() { throw new Error("secret-own-keys"); } });
  const large = {};
  for (let index = 0; index < 10_000; index++) large[`key-${index}`] = index;
  const hugeKey = "k".repeat(1_000_000);
  const hugeKeyObject = {};
  Object.defineProperty(hugeKeyObject, hugeKey, { enumerable: true, get() { throw new Error("secret-huge-key-getter"); } });
  const run = fakeRun({
    id: "run-proxy-tools", agentId: "bc-proxy-tools",
    messages: [
      { type: "tool_call", call_id: "large", name: "large", status: "completed", result: large },
      { type: "tool_call", call_id: "throwing", name: "throwing", status: "completed", result: throwing },
      { type: "tool_call", call_id: "huge-key", name: "huge-key", status: "completed", result: hugeKeyObject },
    ],
    wait: async () => { await flush(); return { id: "run-proxy-tools", status: "finished", result: "done" }; },
  });
  const agent = { agentId: "bc-proxy-tools", async send() { return run; }, close() {}, async listArtifacts() { return []; }, async getUsage() { return {}; } };
  const backend = new backendModule.CursorCloudBackend(backendOptions({
    stored: storedCursor({ agentId: "bc-proxy-tools", remoteCreated: true, remoteLifecycle: "idle" }),
    sdk: {
      async createAgent() { throw new Error("must not create"); }, async resumeAgent() { return agent; }, async getAgent() { return {}; },
      async listRuns() { return [fakeRun({ id: "run-proxy-baseline", agentId: "bc-proxy-tools", createdAt: 1 })]; },
      async getRun(id) { return id === "run-proxy-baseline" ? fakeRun({ id, agentId: "bc-proxy-tools", createdAt: 1 }) : run; }, async cancelRun() {}, async archiveAgent() {},
      async listModels() { return []; }, async listRepositories() { return []; },
    }, persist() {},
  }, events));
  await backend.start();
  await backend.prompt("Normalize tools");
  await flush();
  const tools = events.filter((event) => event.type === "tool_completed");
  assert.equal(tools.length, 3);
  assert.ok(tools[0].output.length <= backendModule.MAX_CURSOR_EVENT_TOOL_OUTPUT_CHARS);
  assert.match(tools[1].output, /Tool data unavailable/);
  assert.doesNotMatch(tools[1].output, /secret-own-keys/);
  assert.ok(tools[2].output.length <= backendModule.MAX_CURSOR_EVENT_TOOL_OUTPUT_CHARS);
  assert.equal(tools[2].truncated, true);
  assert.doesNotMatch(tools[2].output, /secret-huge-key-getter/);
  assert.ok(tools[2].output.length < 1_000);
});

test("Cursor preserves unknown state when a bounded run listing is incomplete", async () => {
  let archives = 0;
  const lifecycle = backendModule.createCursorSubagentLifecyclePort({
    async getAgent() { return {}; },
    async listRuns() { return { runs: [], complete: false }; },
    async archiveAgent() { archives++; },
  });
  const uncertain = storedCursor({
    agentId: "bc-incomplete-list", remoteCreated: false, remoteLifecycle: "remote-state-unknown",
    pendingOperations: [{ kind: "start-run", idempotencyKey: "incomplete-start", createdAt: 1 }],
  });
  assert.deepEqual(await lifecycle.reconcile(uncertain), { remoteLifecycle: "remote-state-unknown" });
  const stopping = storedCursor({ agentId: "bc-incomplete-stop", remoteCreated: true, remoteLifecycle: "idle" });
  assert.deepEqual(await lifecycle.stop(stopping, { persistArchiveStarted() { throw new Error("must not archive"); } }), { state: "remote-state-unknown" });
  assert.equal(archives, 0);
});

test("Cursor keeps missing server timestamps and foreign-agent runs ambiguous", async () => {
  const predecessor = fakeRun({ id: "run-b", agentId: "bc-server-order", createdAt: 20 });
  const missingTime = fakeRun({ id: "run-c", agentId: "bc-server-order", createdAt: Number.NaN });
  const lifecycle = backendModule.createCursorSubagentLifecyclePort({
    async getAgent() { return {}; },
    async listRuns() { return [missingTime]; },
    async getRun() { return predecessor; },
  });
  const follow = storedCursor({
    agentId: "bc-server-order", remoteCreated: true, remoteLifecycle: "remote-state-unknown", currentRunId: "run-b",
    pendingOperations: [{ kind: "follow-up", idempotencyKey: "skewed-client-clock", createdAt: 1, baselineRunId: "run-b", baselineCreatedAt: 20 }],
  });
  assert.deepEqual(await lifecycle.reconcile(follow), { remoteLifecycle: "remote-state-unknown" });

  const minted = backendModule.createCursorSubagentLifecyclePort({
    async getAgent() { return {}; },
    async listRuns() { return [fakeRun({ id: "run-foreign", agentId: "bc-other-agent", createdAt: 1 })]; },
  });
  const initial = storedCursor({
    agentId: "bc-minted-agent", remoteCreated: false, remoteLifecycle: "remote-state-unknown",
    pendingOperations: [{ kind: "start-run", idempotencyKey: "minted-agent", createdAt: 9_000_000_000_000_000 }],
  });
  assert.deepEqual(await minted.reconcile(initial), { remoteLifecycle: "local", clearPendingSend: true });
});

test("connected Cursor controller observes a reconciled run, clears terminal durable state, and accepts the next prompt", async () => {
  const events = [];
  const durable = storedCursor({ agentId: "bc-connected-sync", remoteCreated: true, remoteLifecycle: "idle" });
  let sends = 0;
  const discovered = fakeRun({
    id: "run-discovered", agentId: "bc-connected-sync", createdAt: 10, status: "running",
    wait: async () => await new Promise(() => {}),
  });
  const next = fakeRun({ id: "run-next", agentId: "bc-connected-sync", createdAt: 20, result: "next result" });
  const agent = {
    agentId: "bc-connected-sync",
    async send() { sends++; return next; }, close() {}, async listArtifacts() { return []; }, async getUsage() { return {}; },
  };
  const cursor = {
    stored: durable,
    readStored() { return durable; },
    persist(value) { Object.assign(durable, structuredClone(value)); },
    sdk: {
      async createAgent() { return agent; }, async resumeAgent() { return agent; }, async getAgent() { return {}; },
      async listRuns() { return [discovered]; },
      async getRun(id) { return id === "run-discovered" ? discovered : next; }, async cancelRun() {}, async archiveAgent() {}, async listModels() { return []; }, async listRepositories() { return []; },
    },
  };
  const controller = new SubagentSessionController({ ui: {} }, {
    args: [], cwd: "/tmp", mode: "fresh", initialPrompt: "", scopedModels: [], cursor,
  }, (options) => new backendModule.CursorCloudBackend({ ...options, cursor: options.cursor, onEvent(event) { events.push(event); options.onEvent(event); } }));
  await controller.start();
  Object.assign(durable, { remoteLifecycle: "running", currentRunId: "run-discovered" });
  await assert.rejects(controller.promptAndWait("Must see discovered run"), (error) => error.code === "BUSY");
  assert.equal(events.some((event) => event.type === "run_started" && event.run.id === "run-discovered"), true);
  assert.equal(sends, 0);
  Object.assign(durable, { remoteLifecycle: "idle", currentRunId: "run-discovered" });
  assert.equal((await controller.promptAndWait("Prompt after terminal reconciliation")).text, "next result");
  assert.equal(sends, 1);
  await controller.stop();
});

test("Cursor cancels the persisted run when AbortSignal fires during send acceptance", async () => {
  const events = [];
  const persisted = [];
  let releaseSend;
  const sendReturned = new Promise((resolve) => { releaseSend = resolve; });
  let cancelRunId;
  let archives = 0;
  const accepted = fakeRun({ id: "run-abort-accepted", agentId: "bc-abort-accept", status: "running", wait: async () => await new Promise(() => {}) });
  const agent = {
    agentId: "bc-abort-accept",
    async send() { await sendReturned; return accepted; }, close() {}, async listArtifacts() { return []; }, async getUsage() { return {}; },
  };
  const backend = new backendModule.CursorCloudBackend(backendOptions({
    stored: storedCursor({ agentId: "bc-abort-accept", remoteCreated: true, remoteLifecycle: "idle" }),
    sdk: {
      async createAgent() { throw new Error("must not create"); }, async resumeAgent() { return agent; }, async getAgent() { return {}; },
      async listRuns() { return [fakeRun({ id: "run-abort-baseline", agentId: "bc-abort-accept", createdAt: 1 })]; },
      async getRun(id) { return id === "run-abort-baseline" ? fakeRun({ id, agentId: "bc-abort-accept", createdAt: 1 }) : accepted; }, async cancelRun(runId) { cancelRunId = runId; }, async archiveAgent() { archives++; }, async listModels() { return []; }, async listRepositories() { return []; },
    },
    persist(next) { persisted.push(structuredClone(next)); },
  }, events));
  await backend.start();
  const abort = new AbortController();
  const pending = backend.prompt("Cancel while send accepts", abort.signal);
  await flush();
  abort.abort();
  releaseSend();
  await assert.rejects(pending, (error) => error.code === "CANCELLED");
  assert.equal(cancelRunId, "run-abort-accepted");
  assert.equal(archives, 0);
  assert.equal(persisted.some((stored) => stored.currentRunId === "run-abort-accepted" && stored.currentRequestId === "request-fake"), true);
});

test("Cursor tracks an acceptance-window parent cancellation and permits a distinct follow-up", async () => {
  const durable = storedCursor({
    agentId: "bc-acceptance-window",
    remoteCreated: true,
    remoteLifecycle: "idle",
    currentRunId: "run-acceptance-before",
  });
  let releaseSend;
  const sendReleased = new Promise((resolve) => { releaseSend = resolve; });
  let resolveCancelled;
  const cancelled = new Promise((resolve) => { resolveCancelled = resolve; });
  const accepted = fakeRun({
    id: "run-acceptance-window",
    agentId: "bc-acceptance-window",
    status: "running",
    wait: async () => await cancelled,
  });
  const followUp = fakeRun({
    id: "run-acceptance-follow-up",
    agentId: "bc-acceptance-window",
    result: "Different follow-up result",
  });
  let sends = 0;
  const agent = {
    agentId: "bc-acceptance-window",
    async send() {
      sends++;
      if (sends === 1) {
        await sendReleased;
        return accepted;
      }
      return followUp;
    },
    close() {}, async listArtifacts() { return []; }, async getUsage() { return {}; },
  };
  const cursor = {
    stored: durable,
    readStored() { return durable; },
    persist(next) { Object.assign(durable, structuredClone(next)); },
    sdk: {
      async createAgent() { throw new Error("must not create"); }, async resumeAgent() { return agent; }, async getAgent() { return {}; },
      async listRuns() { return [fakeRun({ id: "run-acceptance-before", agentId: agent.agentId, createdAt: 1 })]; },
      async getRun(id) { return id === accepted.id ? accepted : id === followUp.id ? followUp : fakeRun({ id, agentId: agent.agentId, createdAt: 1 }); },
      async cancelRun(id) { assert.equal(id, accepted.id); resolveCancelled({ id, status: "cancelled" }); },
      async archiveAgent() {}, async listModels() { return []; }, async listRepositories() { return []; },
    },
  };
  const controller = new SubagentSessionController({ ui: {} }, {
    args: [], cwd: "/tmp", mode: "fresh", initialPrompt: "", scopedModels: [], cursor,
  }, (options) => new backendModule.CursorCloudBackend({ ...options, cursor: options.cursor }));
  const abort = new AbortController();
  const first = controller.promptAndWait("Cancel as Agent.send returns", abort.signal);
  await flush();
  abort.abort(new Error("Parent cancelled during acceptance"));
  releaseSend();
  await assert.rejects(first, /cancelled/i);
  for (let attempt = 0; attempt < 10 && durable.pendingResult.state !== "none"; attempt++) await flush();
  assert.deepEqual(durable.pendingResult, { state: "none" }, "only the confirmed aborted completion is cleared");
  const second = await controller.promptAndWait("Use a different follow-up");
  assert.equal(second.text, "Different follow-up result");
  assert.equal(sends, 2, "the cancelled result is not replayed as the next parent prompt");
  await controller.stop();
});

test("Cursor stream usage is incremental and final cumulative usage emits only its remainder", async () => {
  const events = [];
  const run = fakeRun({
    id: "run-usage-increments", agentId: "bc-usage-increments", usage: { inputTokens: 8, outputTokens: 2 },
    messages: [
      { type: "usage", usage: { inputTokens: 2 } },
      { type: "usage", usage: { inputTokens: 3, outputTokens: 1 } },
    ],
    wait: async () => { await flush(); return { id: "run-usage-increments", status: "finished", result: "done", usage: { inputTokens: 8, outputTokens: 2 } }; },
  });
  const agent = { agentId: "bc-usage-increments", async send() { return run; }, close() {}, async listArtifacts() { return []; }, async getUsage() { return {}; } };
  const backend = new backendModule.CursorCloudBackend(backendOptions({
    stored: storedCursor({ agentId: "bc-usage-increments", remoteCreated: true, remoteLifecycle: "idle" }),
    sdk: {
      async createAgent() { throw new Error("must not create"); }, async resumeAgent() { return agent; }, async getAgent() { return {}; },
      async listRuns() { return [fakeRun({ id: "run-usage-baseline", agentId: "bc-usage-increments", createdAt: 1 })]; },
      async getRun(id) { return id === "run-usage-baseline" ? fakeRun({ id, agentId: "bc-usage-increments", createdAt: 1 }) : run; }, async cancelRun() {}, async archiveAgent() {}, async listModels() { return []; }, async listRepositories() { return []; },
    }, persist() {},
  }, events));
  await backend.start();
  const accepted = await backend.prompt("Count increments");
  await flush();
  assert.deepEqual(events.filter((event) => event.type === "usage_update").map((event) => event.usage), [
    { input: 2 }, { input: 3, output: 1 }, { input: 3, output: 1 },
  ]);
  const count = events.filter((event) => event.type === "usage_update").length;
  await backend.emitFinalUsage(accepted.run, { inputTokens: 8, outputTokens: 2 });
  assert.equal(events.filter((event) => event.type === "usage_update").length, count, "repeated final usage adds nothing");
});

test("Cursor keeps each stream usage message when final usage is unavailable", async () => {
  const events = [];
  const run = fakeRun({
    id: "run-no-final-usage", agentId: "bc-no-final-usage",
    messages: [{ type: "usage", usage: { inputTokens: 2 } }, { type: "usage", usage: { inputTokens: 4 } }],
    wait: async () => { await flush(); return { id: "run-no-final-usage", status: "finished", result: "done" }; },
  });
  const agent = { agentId: "bc-no-final-usage", async send() { return run; }, close() {}, async listArtifacts() { return []; }, async getUsage() { return {}; } };
  const backend = new backendModule.CursorCloudBackend(backendOptions({
    stored: storedCursor({ agentId: "bc-no-final-usage", remoteCreated: true, remoteLifecycle: "idle" }),
    sdk: {
      async createAgent() { throw new Error("must not create"); }, async resumeAgent() { return agent; }, async getAgent() { return {}; },
      async listRuns() { return [fakeRun({ id: "run-no-final-baseline", agentId: "bc-no-final-usage", createdAt: 1 })]; },
      async getRun(id) { return id === "run-no-final-baseline" ? fakeRun({ id, agentId: "bc-no-final-usage", createdAt: 1 }) : run; }, async cancelRun() {}, async archiveAgent() {}, async listModels() { return []; }, async listRepositories() { return []; },
    }, persist() {},
  }, events));
  await backend.start();
  await backend.prompt("Keep each usage turn");
  await flush();
  assert.deepEqual(events.filter((event) => event.type === "usage_update").map((event) => event.usage), [{ input: 2 }, { input: 4 }]);
});

test("Cursor retries a lost initial send after Agent.get 404 and returns to local state after a second absence", async () => {
  const persisted = [];
  let sends = 0;
  const sent = [];
  let archives = 0;
  const agent = {
    agentId: "bc-initial-404",
    async send(message, options) { sends++; sent.push({ message, options }); throw new Error("lost response"); }, close() {}, async listArtifacts() { return []; }, async getUsage() { return {}; },
  };
  const backend = new backendModule.CursorCloudBackend(backendOptions({
    stored: storedCursor({
      agentId: "bc-initial-404",
      pendingOperations: [{ kind: "create-agent", idempotencyKey: "create-404", createdAt: 1 }],
    }),
    sdk: {
      async createAgent() { return agent; }, async resumeAgent() { return agent; },
      async getAgent() { throw { status: 404 }; }, async listRuns() { throw new Error("404 must not list runs"); },
      async getRun() { throw new Error("404 must not get runs"); }, async cancelRun() {}, async archiveAgent() { archives++; }, async listModels() { return []; }, async listRepositories() { return []; },
    },
    persist(next) { persisted.push(structuredClone(next)); },
  }, []));
  await backend.start();
  await assert.rejects(backend.prompt("Retry only this initial text"), (error) => error.code === "BACKEND_FAILED");
  assert.equal(sends, 2);
  assert.equal(sent[0].message, sent[1].message);
  assert.equal(sent[0].options.idempotencyKey, sent[1].options.idempotencyKey);
  assert.deepEqual(persisted.at(-1).pendingOperations, []);
  assert.equal(persisted.at(-1).remoteLifecycle, "local");
  assert.equal(persisted.at(-1).localLifecycle, "available");

  const lifecycle = backendModule.createCursorSubagentLifecyclePort({
    async getAgent() { throw { status: 404 }; }, async archiveAgent() { archives++; },
  });
  const uncertain = storedCursor({
    agentId: "bc-initial-404", remoteCreated: false, remoteLifecycle: "remote-state-unknown", localLifecycle: "unavailable",
    pendingOperations: [{ kind: "start-run", idempotencyKey: "initial-404", createdAt: 1 }],
  });
  assert.deepEqual(await lifecycle.reconcile(uncertain), { remoteLifecycle: "local", clearPendingSend: true });
  assert.deepEqual(await lifecycle.stop(uncertain, { persistArchiveStarted() { throw new Error("must not archive"); } }), { state: "stopped" });
  assert.equal(archives, 0);
});

test("Cursor follow-up correlation uses the server baseline after an external run", async () => {
  const persisted = [];
  const runB = fakeRun({ id: "run-b", agentId: "bc-baseline", createdAt: 10 });
  const runC = fakeRun({ id: "run-c", agentId: "bc-baseline", createdAt: 20, conversation: userConversation("External C request") });
  let delivered;
  const runD = fakeRun({ id: "run-d", agentId: "bc-baseline", createdAt: 30, result: "D accepted", conversation: async () => await userConversation(delivered)() });
  let sends = 0;
  const agent = {
    agentId: "bc-baseline",
    async send(message) { delivered = message; sends++; throw new Error("lost response"); }, close() {}, async listArtifacts() { return []; }, async getUsage() { return {}; },
  };
  const backend = new backendModule.CursorCloudBackend(backendOptions({
    stored: storedCursor({ agentId: "bc-baseline", remoteCreated: true, remoteLifecycle: "idle", currentRunId: "run-b" }),
    sdk: {
      async createAgent() { throw new Error("must not create"); }, async resumeAgent() { return agent; }, async getAgent() { return {}; },
      async listRuns() { return sends === 0 ? [runB] : [runB, runC, runD]; },
      async getRun(id) { return id === "run-b" ? runB : id === "run-c" ? runC : runD; }, async cancelRun() {}, async archiveAgent() {}, async listModels() { return []; }, async listRepositories() { return []; },
    },
    persist(next) { persisted.push(structuredClone(next)); },
  }, []));
  await backend.start();
  const result = await backend.followUp("Do not persist this text");
  assert.equal(result.run.id, "run-d");
  assert.equal(sends, 1, "external C was not attributed to pending D");
  const operation = persisted.find((stored) => stored.pendingOperations.some((entry) => entry.kind === "follow-up" && entry.baselineComplete === true))?.pendingOperations.find((entry) => entry.kind === "follow-up");
  assert.deepEqual({ baselineRunId: operation?.baselineRunId, baselineCreatedAt: operation?.baselineCreatedAt }, { baselineRunId: "run-b", baselineCreatedAt: 10 });

  const absent = backendModule.createCursorSubagentLifecyclePort({
    async getAgent() { return {}; }, async listRuns() { return [runB, runC]; },
    async getRun(id) { return id === "run-b" ? runB : runC; },
  });
  const saved = storedCursor({
    agentId: "bc-baseline", remoteCreated: true, remoteLifecycle: "remote-state-unknown", currentRunId: "run-b",
    pendingOperations: [{ kind: "follow-up", idempotencyKey: "follow-d", nonce: "send-d", requestHash: requestHash("D delivered but absent"), createdAt: 1, baselineComplete: true, baselineRunId: "run-c", baselineCreatedAt: 20 }],
  });
  assert.deepEqual(await absent.reconcile(saved), { remoteLifecycle: "idle", clearPendingSend: true });
  const noBaseline = { ...saved, pendingOperations: [{ kind: "follow-up", idempotencyKey: "legacy-follow", createdAt: 1 }] };
  assert.deepEqual(await absent.reconcile(noBaseline), { remoteLifecycle: "remote-state-unknown" });
});

test("Cursor archives incomplete completed history and cancels an incomplete active history", async () => {
  let archives = 0;
  const completed = backendModule.createCursorSubagentLifecyclePort({
    async getAgent() { return { status: "finished" }; },
    async listRuns() { return { runs: [fakeRun({ id: "run-old", agentId: "bc-many-completed", status: "finished" })], complete: false }; },
    async archiveAgent() { archives++; },
  });
  assert.deepEqual(await completed.stop(storedCursor({ agentId: "bc-many-completed", remoteCreated: true, remoteLifecycle: "idle" }), { persistArchiveStarted() {} }), { state: "stopped" });

  let status = "running";
  let cancels = 0;
  const active = fakeRun({ id: "run-late-active", agentId: "bc-many-running", status: "running" });
  const running = backendModule.createCursorSubagentLifecyclePort({
    async getAgent() { return { status }; },
    async listRuns() { return { runs: [active], complete: false }; },
    async getRun() { return fakeRun({ id: "run-late-active", agentId: "bc-many-running", status }); },
    async cancelRun() { cancels++; status = "finished"; }, async archiveAgent() { archives++; },
  });
  assert.deepEqual(await running.stop(storedCursor({ agentId: "bc-many-running", remoteCreated: true, remoteLifecycle: "idle" }), { persistArchiveStarted() {} }), { state: "stopped" });
  assert.equal(cancels, 1);
  assert.equal(archives, 2);
});

test("Cursor concurrent state refreshes attach one observer for one reconciled run", async () => {
  const events = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const active = fakeRun({ id: "run-one-observer", agentId: "bc-one-observer", status: "running", wait: async () => await new Promise(() => {}) });
  const backend = new backendModule.CursorCloudBackend(backendOptions({
    stored: storedCursor({ agentId: "bc-one-observer", remoteCreated: true, remoteLifecycle: "running", currentRunId: "run-one-observer" }),
    sdk: {
      async createAgent() { throw new Error("must not create"); }, async resumeAgent() { throw new Error("must not resume"); },
      async getRun() { await gate; return active; }, async getAgent() { return {}; }, async listRuns() { return []; }, async cancelRun() {}, async archiveAgent() {}, async listModels() { return []; }, async listRepositories() { return []; },
    }, persist() {},
  }, events));
  const states = Promise.all([backend.getState(), backend.getState()]);
  await flush();
  release();
  await states;
  assert.equal(events.filter((event) => event.type === "run_started" && event.run.id === "run-one-observer").length, 1);
});

test("Cursor cancels bootstrap locally and leaves a running lost response unknown without consuming its stream", async () => {
  let bootstrapReady;
  const bootstrap = new Promise((resolve) => { bootstrapReady = resolve; });
  let bootstrapSends = 0;
  const bootstrapBackend = new backendModule.CursorCloudBackend(backendOptions({
    stored: storedCursor({ agentId: "bc-abort-bootstrap", pendingOperations: [{ kind: "create-agent", idempotencyKey: "create-bootstrap", createdAt: 1 }] }),
    sdk: {
      async createAgent() { return { agentId: "bc-abort-bootstrap", async send() { bootstrapSends++; return fakeRun({ agentId: "bc-abort-bootstrap" }); }, close() {}, async listArtifacts() { return []; }, async getUsage() { return {}; } }; },
      async resumeAgent() { throw new Error("must not resume"); }, async getAgent() { return {}; }, async listRuns() { return []; }, async getRun() { throw new Error("must not get run"); }, async cancelRun() {}, async archiveAgent() {}, async listModels() { return []; }, async listRepositories() { return []; },
    },
    async buildInitialPrompt() { await bootstrap; return "bootstrap text is never persisted"; }, persist() {},
  }, []));
  await bootstrapBackend.start();
  const bootstrapAbort = new AbortController();
  const pendingBootstrap = bootstrapBackend.prompt("request", bootstrapAbort.signal);
  await flush();
  bootstrapAbort.abort();
  bootstrapReady();
  await assert.rejects(pendingBootstrap);
  assert.equal(bootstrapSends, 0);

  const runB = fakeRun({ id: "run-abort-b", agentId: "bc-abort-lost", createdAt: 10 });
  let delivered;
  const runD = fakeRun({
    id: "run-abort-d", agentId: "bc-abort-lost", createdAt: 20, status: "running", wait: async () => await new Promise(() => {}),
    conversation: async () => await userConversation(delivered)(),
  });
  let streamReads = 0;
  runD.stream = () => { streamReads++; return asyncMessages([{ type: "user", message: { role: "user", content: [{ type: "text", text: delivered }] } }]); };
  const abort = new AbortController();
  let cancelled;
  const persisted = [];
  let sends = 0;
  const agent = { agentId: "bc-abort-lost", async send(message) { delivered = message; sends++; abort.abort(); throw new Error("lost response"); }, close() {}, async listArtifacts() { return []; }, async getUsage() { return {}; } };
  const backend = new backendModule.CursorCloudBackend(backendOptions({
    stored: storedCursor({ agentId: "bc-abort-lost", remoteCreated: true, remoteLifecycle: "idle", currentRunId: "run-abort-b" }),
    sdk: {
      async createAgent() { throw new Error("must not create"); }, async resumeAgent() { return agent; }, async getAgent() { return {}; },
      async listRuns() { return sends === 0 ? [runB] : [runB, runD]; }, async getRun(id) { return id === "run-abort-b" ? runB : runD; },
      async cancelRun(id) { cancelled = id; }, async archiveAgent() { throw new Error("must not archive"); }, async listModels() { return []; }, async listRepositories() { return []; },
    }, persist(next) { persisted.push(structuredClone(next)); },
  }, []));
  await backend.start();
  await assert.rejects(backend.followUp("lost but attributable", abort.signal), (error) => error.code === "BACKEND_FAILED");
  assert.equal(sends, 1, "an aborted lost response does not retry");
  assert.equal(streamReads, 0, "recovery never consumes the shared SDK stream");
  assert.equal(cancelled, undefined);
  assert.equal(persisted.at(-1).remoteLifecycle, "remote-state-unknown");
});

test("Cursor clears an aborted lost response when complete history proves no request was accepted", async () => {
  const persisted = [];
  const runB = fakeRun({ id: "run-abort-unknown-b", agentId: "bc-abort-unknown", createdAt: 10 });
  const abort = new AbortController();
  let sends = 0;
  const agent = { agentId: "bc-abort-unknown", async send() { sends++; abort.abort(); throw { name: "AbortError" }; }, close() {}, async listArtifacts() { return []; }, async getUsage() { return {}; } };
  const backend = new backendModule.CursorCloudBackend(backendOptions({
    stored: storedCursor({ agentId: "bc-abort-unknown", remoteCreated: true, remoteLifecycle: "idle", currentRunId: "run-abort-unknown-b" }),
    sdk: {
      async createAgent() { throw new Error("must not create"); }, async resumeAgent() { return agent; }, async getAgent() { return {}; },
      async listRuns() { return [runB]; }, async getRun() { return runB; }, async cancelRun() { throw new Error("must not cancel an unknown run"); }, async archiveAgent() { throw new Error("must not archive"); }, async listModels() { return []; }, async listRepositories() { return []; },
    }, persist(next) { persisted.push(structuredClone(next)); },
  }, []));
  await backend.start();
  await assert.rejects(backend.followUp("unattributed abort", abort.signal), (error) => error.code === "CANCELLED");
  assert.equal(sends, 1);
  assert.equal(persisted.at(-1).remoteLifecycle, "idle");
});

test("Cursor panel Escape cancels an accepted delayed send before a controller active run exists", async () => {
  let releaseSend;
  let signalSend;
  const sendGate = new Promise((resolve) => { releaseSend = resolve; });
  let cancelled;
  let archives = 0;
  const active = fakeRun({ id: "run-panel-accept", agentId: "bc-panel-accept", status: "running", wait: async () => await new Promise(() => {}) });
  const agent = {
    agentId: "bc-panel-accept",
    async send() { signalSend(); await sendGate; return active; },
    close() {}, async listArtifacts() { return []; }, async getUsage() { return {}; },
  };
  const sendStarted = new Promise((resolve) => { signalSend = resolve; });
  const cursor = {
    stored: storedCursor({ agentId: "bc-panel-accept", pendingOperations: [{ kind: "create-agent", idempotencyKey: "create-panel-accept", createdAt: 1 }] }),
    sdk: {
      async createAgent() { return agent; }, async resumeAgent() { return agent; }, async getAgent() { return {}; },
      async listRuns() { return []; }, async getRun() { return active; }, async cancelRun(runId) { cancelled = runId; }, async archiveAgent() { archives++; },
      async listModels() { return []; }, async listRepositories() { return []; },
    },
    persist() {},
  };
  const controller = new SubagentSessionController({ ui: {} }, {
    args: [], cwd: "/tmp", mode: "fresh", initialPrompt: "", scopedModels: [], cursor,
  }, (options) => new backendModule.CursorCloudBackend({ ...options, cursor: options.cursor }));
  await controller.start();
  const submitted = controller.submit("Interrupt this delayed acceptance");
  await sendStarted;
  assert.equal(controller.state.busy, true);
  const panel = new SubagentPanel(
    { requestRender() {} }, {},
    { matches(data, action) { return data === "\x1b" && action === "app.interrupt"; } },
    controller, "Cursor acceptance", () => {}, () => {},
  );
  panel.handleInput("\x1b");
  await flush();
  releaseSend();
  assert.equal(await submitted, false);
  assert.equal(cancelled, "run-panel-accept");
  assert.equal(archives, 0);
  await controller.stop();
});

test("Cursor reuses one send key for a retry and creates a new nonce after confirmed absence", async () => {
  const persisted = [];
  const keys = [];
  let sends = 0;
  const accepted = fakeRun({ id: "run-new-logical-send", agentId: "bc-new-logical-send" });
  const agent = {
    agentId: "bc-new-logical-send",
    async send(_text, options) {
      keys.push(options.idempotencyKey);
      sends++;
      if (sends < 3) throw new Error("lost response");
      return accepted;
    },
    close() {}, async listArtifacts() { return []; }, async getUsage() { return {}; },
  };
  const backend = new backendModule.CursorCloudBackend(backendOptions({
    stored: storedCursor({ agentId: "bc-new-logical-send", pendingOperations: [{ kind: "create-agent", idempotencyKey: "create-new-logical", createdAt: 1 }] }),
    sdk: {
      async createAgent() { return agent; }, async resumeAgent() { return agent; }, async getAgent() { throw { status: 404 }; },
      async listRuns() { throw new Error("a lazy 404 must not list runs"); }, async getRun() { throw new Error("must not get runs"); },
      async cancelRun() {}, async archiveAgent() {}, async listModels() { return []; }, async listRepositories() { return []; },
    },
    persist(next) { persisted.push(structuredClone(next)); },
  }, []));
  await backend.start();
  await assert.rejects(backend.prompt("First logical request"));
  const first = persisted.find((state) => state.pendingOperations.some((operation) => operation.kind === "start-run" && operation.requestHash));
  assert.equal(keys[0], keys[1], "a lost-response retry retains its saved key");
  assert.match(first.pendingOperations[0].requestHash, /^[a-f0-9]{64}$/);
  assert.ok(first.pendingOperations[0].nonce);
  assert.doesNotMatch(JSON.stringify(first), /First logical request/);
  await backend.prompt("Second logical request");
  assert.notEqual(keys[2], keys[0], "a new request after absence receives a new key");
  const second = persisted.filter((state) => state.pendingOperations.some((operation) => operation.kind === "start-run" && operation.requestHash)).at(-1);
  assert.notEqual(second.pendingOperations[0].nonce, first.pendingOperations[0].nonce);
});

test("Cursor settles a terminal restored run instead of leaving the durable record busy", async () => {
  const events = [];
  const persisted = [];
  const terminal = fakeRun({ id: "run-terminal-attach", agentId: "bc-terminal-attach", status: "finished", result: "terminal attach result" });
  const backend = new backendModule.CursorCloudBackend(backendOptions({
    stored: storedCursor({ agentId: "bc-terminal-attach", remoteCreated: true, remoteLifecycle: "running", currentRunId: "run-terminal-attach" }),
    sdk: {
      async getRun() { return terminal; }, async getAgent() { return { status: "finished" }; }, async listRuns() { return [terminal]; },
      async createAgent() { throw new Error("must not create"); }, async resumeAgent() { throw new Error("must not resume"); }, async cancelRun() {}, async archiveAgent() {}, async listModels() { return []; }, async listRepositories() { return []; },
    },
    persist(next) { persisted.push(structuredClone(next)); },
  }, events));
  const state = await backend.getState();
  assert.equal(state.isStreaming, false);
  assert.equal(persisted.at(-1).remoteLifecycle, "idle");
  assert.equal(events.filter((event) => event.type === "run_started").length, 1);
  assert.equal(events.filter((event) => event.type === "run_settled").length, 1);
});

test("Cursor settles locally when cancellation fails after the run is already terminal", async () => {
  const events = [];
  const persisted = [];
  const before = fakeRun({ id: "run-cancel-before", agentId: "bc-cancel-terminal", createdAt: 10 });
  const active = fakeRun({ id: "run-cancel-terminal", agentId: "bc-cancel-terminal", createdAt: 20, status: "running", wait: async () => await new Promise(() => {}) });
  const terminal = fakeRun({ id: "run-cancel-terminal", agentId: "bc-cancel-terminal", createdAt: 20, status: "finished", result: "already terminal" });
  const agent = { agentId: "bc-cancel-terminal", async send() { return active; }, close() {}, async listArtifacts() { return []; }, async getUsage() { return {}; } };
  const backend = new backendModule.CursorCloudBackend(backendOptions({
    stored: storedCursor({ agentId: "bc-cancel-terminal", remoteCreated: true, remoteLifecycle: "idle", currentRunId: "run-cancel-before" }),
    sdk: {
      async createAgent() { throw new Error("must not create"); }, async resumeAgent() { return agent; }, async getAgent() { return {}; }, async listRuns() { return [before]; },
      async getRun(id) { return id === "run-cancel-before" ? before : terminal; }, async cancelRun() { throw new Error("lost cancellation response"); }, async archiveAgent() {}, async listModels() { return []; }, async listRepositories() { return []; },
    },
    persist(next) { persisted.push(structuredClone(next)); },
  }, events));
  await backend.start();
  await backend.followUp("Cancel after terminal state");
  await backend.abort();
  assert.equal(persisted.at(-1).remoteLifecycle, "idle");
  assert.equal(persisted.at(-1).pendingOperations.some((operation) => operation.kind === "cancel-run"), false);
  assert.equal(events.filter((event) => event.type === "run_settled").length, 1);
});

test("Cursor lifecycle uses Agent status to reconcile a newer external active run", async () => {
  const old = fakeRun({ id: "run-old-idle", agentId: "bc-newer-active", status: "finished" });
  const active = fakeRun({ id: "run-newer-active", agentId: "bc-newer-active", status: "running" });
  const lifecycle = backendModule.createCursorSubagentLifecyclePort({
    async getAgent() { return { status: "running" }; }, async listRuns() { return [old, active]; },
    async getRun(id) { return id === "run-newer-active" ? active : old; },
  });
  assert.deepEqual(await lifecycle.reconcile(storedCursor({
    agentId: "bc-newer-active", remoteCreated: true, remoteLifecycle: "idle", currentRunId: "run-old-idle",
  })), { remoteLifecycle: "running", currentRunId: "run-newer-active", currentRequestId: "request-fake" });
});

test("Cursor sends a normal follow-up with an incomplete bounded history and saves no raw prompt", async () => {
  const persisted = [];
  let sends = 0;
  const before = fakeRun({ id: "run-many-before", agentId: "bc-many-follow", createdAt: 10 });
  const accepted = fakeRun({ id: "run-many-follow", agentId: "bc-many-follow", createdAt: 11 });
  const agent = { agentId: "bc-many-follow", async send() { sends++; return accepted; }, close() {}, async listArtifacts() { return []; }, async getUsage() { return {}; } };
  const backend = new backendModule.CursorCloudBackend(backendOptions({
    stored: storedCursor({ agentId: "bc-many-follow", remoteCreated: true, remoteLifecycle: "idle", currentRunId: "run-many-before" }),
    sdk: {
      async createAgent() { throw new Error("must not create"); }, async resumeAgent() { return agent; }, async getAgent() { return {}; },
      async listRuns() { return { runs: [before], complete: false }; }, async getRun() { throw new Error("incomplete baseline must not get a run"); }, async cancelRun() {}, async archiveAgent() {}, async listModels() { return []; }, async listRepositories() { return []; },
    },
    persist(next) { persisted.push(structuredClone(next)); },
  }, []));
  await backend.start();
  await backend.followUp("Follow despite more than two thousand runs");
  assert.equal(sends, 1);
  const pending = persisted.find((state) => state.pendingOperations.some((operation) => operation.kind === "follow-up" && operation.baselineComplete === false));
  const operation = pending.pendingOperations.find((entry) => entry.kind === "follow-up");
  assert.equal(operation.baselineComplete, false);
  assert.match(operation.requestHash, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(operation), /Follow despite more than two thousand runs/);
});

test("Cursor keeps an incomplete lost follow-up response unknown when no bounded candidate matches", async () => {
  const persisted = [];
  const before = fakeRun({ id: "run-incomplete-before", agentId: "bc-incomplete-follow", createdAt: 10, conversation: userConversation("Earlier request") });
  const agent = {
    agentId: "bc-incomplete-follow",
    async send() { throw new Error("lost response"); },
    close() {}, async listArtifacts() { return []; }, async getUsage() { return {}; },
  };
  const backend = new backendModule.CursorCloudBackend(backendOptions({
    stored: storedCursor({ agentId: "bc-incomplete-follow", remoteCreated: true, remoteLifecycle: "idle", currentRunId: "run-incomplete-before" }),
    sdk: {
      async createAgent() { throw new Error("must not create"); }, async resumeAgent() { return agent; }, async getAgent() { return {}; },
      async listRuns() { return { runs: [before], complete: false }; }, async getRun() { return before; }, async cancelRun() { throw new Error("must not cancel an unknown run"); }, async archiveAgent() { throw new Error("must not archive"); }, async listModels() { return []; }, async listRepositories() { return []; },
    },
    persist(next) { persisted.push(structuredClone(next)); },
  }, []));
  await backend.start();
  await assert.rejects(backend.followUp("Lost request beyond the scan bound"), (error) => error.code === "BACKEND_FAILED");
  assert.equal(persisted.at(-1).remoteLifecycle, "remote-state-unknown");
});

test("Cursor rechecks cancellation during retry and cancels the persisted retry run", async () => {
  let releaseRetry;
  let retryStarted;
  const retryGate = new Promise((resolve) => { releaseRetry = resolve; });
  const started = new Promise((resolve) => { retryStarted = resolve; });
  let sends = 0;
  let cancelled;
  const accepted = fakeRun({ id: "run-retry-cancelled", agentId: "bc-retry-cancelled", status: "running", wait: async () => await new Promise(() => {}) });
  const agent = {
    agentId: "bc-retry-cancelled",
    async send() {
      sends++;
      if (sends === 1) throw new Error("lost first response");
      retryStarted();
      await retryGate;
      return accepted;
    },
    close() {}, async listArtifacts() { return []; }, async getUsage() { return {}; },
  };
  const backend = new backendModule.CursorCloudBackend(backendOptions({
    stored: storedCursor({ agentId: "bc-retry-cancelled", pendingOperations: [{ kind: "create-agent", idempotencyKey: "create-retry-cancelled", createdAt: 1 }] }),
    sdk: {
      async createAgent() { return agent; }, async resumeAgent() { return agent; }, async getAgent() { return {}; }, async listRuns() { return []; }, async getRun() { throw new Error("no initial run"); },
      async cancelRun(id) { cancelled = id; }, async archiveAgent() {}, async listModels() { return []; }, async listRepositories() { return []; },
    },
    persist() {},
  }, []));
  await backend.start();
  const abort = new AbortController();
  const pending = backend.prompt("Cancel during retry", abort.signal);
  await started;
  abort.abort();
  releaseRetry();
  await assert.rejects(pending, (error) => error.code === "CANCELLED");
  assert.equal(sends, 2);
  assert.equal(cancelled, "run-retry-cancelled");
});

test("Cursor does not dispatch a retry when cancellation is known during recovery", async () => {
  let releaseLookup;
  let lookupStarted;
  const lookupGate = new Promise((resolve) => { releaseLookup = resolve; });
  const lookup = new Promise((resolve) => { lookupStarted = resolve; });
  let sends = 0;
  const agent = {
    agentId: "bc-retry-prevented",
    async send() { sends++; throw new Error("lost response"); },
    close() {}, async listArtifacts() { return []; }, async getUsage() { return {}; },
  };
  const backend = new backendModule.CursorCloudBackend(backendOptions({
    stored: storedCursor({ agentId: "bc-retry-prevented", pendingOperations: [{ kind: "create-agent", idempotencyKey: "create-retry-prevented", createdAt: 1 }] }),
    sdk: {
      async createAgent() { return agent; }, async resumeAgent() { return agent; }, async getAgent() { lookupStarted(); await lookupGate; return {}; }, async listRuns() { return []; }, async getRun() { throw new Error("must not get a run"); },
      async cancelRun() {}, async archiveAgent() {}, async listModels() { return []; }, async listRepositories() { return []; },
    },
    persist() {},
  }, []));
  await backend.start();
  const abort = new AbortController();
  const pending = backend.prompt("Cancel before retry", abort.signal);
  await lookup;
  abort.abort();
  releaseLookup();
  await assert.rejects(pending, (error) => error.code === "CANCELLED");
  assert.equal(sends, 1);
});

test("Cursor correlates identical external prompt text only when its nonce marker matches", async () => {
  const before = fakeRun({ id: "run-identical-before", agentId: "bc-identical", createdAt: 10 });
  const external = fakeRun({
    id: "run-identical-external", agentId: "bc-identical", createdAt: 20,
    conversation: userConversation(markedRequest("Same low-entropy request", "send-external-identical")),
  });
  let delivered;
  const accepted = fakeRun({
    id: "run-identical-accepted", agentId: "bc-identical", createdAt: 30,
    conversation: async () => await userConversation(delivered)(),
  });
  let sends = 0;
  const agent = {
    agentId: "bc-identical",
    async send(message) { delivered = message; sends++; throw new Error("lost response"); },
    close() {}, async listArtifacts() { return []; }, async getUsage() { return {}; },
  };
  const backend = new backendModule.CursorCloudBackend(backendOptions({
    stored: storedCursor({ agentId: "bc-identical", remoteCreated: true, remoteLifecycle: "idle", currentRunId: "run-identical-before" }),
    sdk: {
      async createAgent() { throw new Error("must not create"); }, async resumeAgent() { return agent; }, async getAgent() { return {}; },
      async listRuns() { return sends === 0 ? [before] : [before, external, accepted]; }, async getRun(id) { return id === before.id ? before : id === external.id ? external : accepted; },
      async cancelRun() {}, async archiveAgent() {}, async listModels() { return []; }, async listRepositories() { return []; },
    },
    persist() {},
  }, []));
  await backend.start();
  const result = await backend.followUp("Same low-entropy request");
  assert.equal(result.run.id, accepted.id);
  assert.match(delivered, /\[Pi request correlation: pi-correlation-[a-f0-9]{32}\]$/);
  assert.notEqual(delivered, markedRequest("Same low-entropy request", "send-external-identical"));
});

test("Cursor terminal errors never expose RunError.message through controller completion", async () => {
  const malicious = "CURSOR_API_KEY=secret-run-error and token=leak";
  const failed = fakeRun({ id: "run-malicious-error", agentId: "bc-malicious-error", status: "error", result: "", error: { message: malicious, code: "internal" } });
  const agent = { agentId: "bc-malicious-error", async send() { return failed; }, close() {}, async listArtifacts() { return []; }, async getUsage() { return {}; } };
  const cursor = {
    stored: storedCursor({ agentId: "bc-malicious-error", pendingOperations: [{ kind: "create-agent", idempotencyKey: "create-malicious-error", createdAt: 1 }] }),
    sdk: {
      async createAgent() { return agent; }, async resumeAgent() { return agent; }, async getAgent() { return {}; }, async listRuns() { return []; }, async getRun() { return failed; }, async cancelRun() {}, async archiveAgent() {}, async listModels() { return []; }, async listRepositories() { return []; },
    },
    persist() {},
  };
  const controller = new SubagentSessionController({ ui: {} }, {
    args: [], cwd: "/tmp", mode: "fresh", initialPrompt: "", scopedModels: [], cursor,
  }, (options) => new backendModule.CursorCloudBackend({ ...options, cursor: options.cursor }));
  await assert.rejects(controller.promptAndWait("Produce a safe terminal error"), (error) => {
    assert.doesNotMatch(error.message, /secret-run-error|token=|CURSOR_API_KEY/i);
    assert.match(error.message, /Cursor Cloud run failed/i);
    return true;
  });
  assert.doesNotMatch(JSON.stringify(controller.state.items), /secret-run-error|token=|CURSOR_API_KEY/i);
  await controller.stop();
});

test("Cursor concurrent terminal paths emit one completion, settlement, and usage result", async () => {
  const events = [];
  let releaseWait;
  const waitGate = new Promise((resolve) => { releaseWait = resolve; });
  const before = fakeRun({ id: "run-finish-before", agentId: "bc-finish-race", createdAt: 10 });
  const terminal = fakeRun({ id: "run-finish-race", agentId: "bc-finish-race", createdAt: 20, status: "finished", result: "one final result", usage: { inputTokens: 2 } });
  const active = fakeRun({ id: "run-finish-race", agentId: "bc-finish-race", createdAt: 20, status: "running", wait: async () => await waitGate });
  const agent = { agentId: "bc-finish-race", async send() { return active; }, close() {}, async listArtifacts() { return {}; } , async getUsage() { return {}; } };
  const backend = new backendModule.CursorCloudBackend(backendOptions({
    stored: storedCursor({ agentId: "bc-finish-race", remoteCreated: true, remoteLifecycle: "idle", currentRunId: "run-finish-before" }),
    sdk: {
      async createAgent() { throw new Error("must not create"); }, async resumeAgent() { return agent; }, async getAgent() { return {}; }, async listRuns() { return [before]; },
      async getRun(id) { return id === before.id ? before : terminal; }, async cancelRun() { throw new Error("lost cancel response"); }, async archiveAgent() {}, async listModels() { return []; }, async listRepositories() { return []; },
    },
    persist() {},
  }, events));
  await backend.start();
  await backend.followUp("Race terminal completion");
  const stopping = backend.abort();
  releaseWait({ id: terminal.id, status: "finished", result: terminal.result, usage: terminal.usage });
  await stopping;
  await flush();
  assert.equal(events.filter((event) => event.type === "message_completed").length, 1);
  assert.equal(events.filter((event) => event.type === "run_settled").length, 1);
  assert.equal(events.filter((event) => event.type === "usage_update").length, 1);
});

test("Cursor repeated state reads after completion do not duplicate usage or settlement", async () => {
  const events = [];
  const run = fakeRun({ id: "run-repeat-state", agentId: "bc-repeat-state", result: "repeat result", usage: { inputTokens: 4, totalTokens: 4 } });
  const agent = { agentId: "bc-repeat-state", async send() { return run; }, close() {}, async listArtifacts() { return []; }, async getUsage() { return {}; } };
  const backend = new backendModule.CursorCloudBackend(backendOptions({
    stored: storedCursor({ agentId: agent.agentId, remoteCreated: true, remoteLifecycle: "idle", currentRunId: "run-repeat-before" }),
    sdk: {
      async createAgent() { throw new Error("must not create"); }, async resumeAgent() { return agent; }, async getAgent() { return { status: "finished" }; },
      async listRuns() { return { runs: [fakeRun({ id: "run-repeat-before", agentId: agent.agentId, createdAt: 1 })], complete: true }; },
      async getRun(id) { return id === "run-repeat-before" ? fakeRun({ id, agentId: agent.agentId, createdAt: 1 }) : run; },
      async cancelRun() {}, async archiveAgent() {}, async listModels() { return []; }, async listRepositories() { return []; },
    }, persist() {},
  }, events));
  await backend.start();
  await backend.prompt("Complete once");
  for (let index = 0; index < 4; index++) await flush();
  await backend.getState();
  await backend.getState();
  await backend.getState();
  assert.equal(events.filter((event) => event.type === "message_completed").length, 1);
  assert.equal(events.filter((event) => event.type === "run_settled").length, 1);
  assert.equal(events.filter((event) => event.type === "usage_update").length, 1);
});

test("Cursor detach invalidates a delayed durable observer attachment", async () => {
  const events = [];
  const persisted = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const delayed = fakeRun({ id: "run-delayed-attach", agentId: "bc-delayed-attach", status: "running", wait: async () => await new Promise(() => {}) });
  const backend = new backendModule.CursorCloudBackend(backendOptions({
    stored: storedCursor({ agentId: "bc-delayed-attach", remoteCreated: true, remoteLifecycle: "running", currentRunId: "run-delayed-attach" }),
    sdk: {
      async getRun() { await gate; return delayed; }, async getAgent() { return {}; }, async listRuns() { return []; }, async createAgent() { throw new Error("must not create"); }, async resumeAgent() { throw new Error("must not resume"); }, async cancelRun() {}, async archiveAgent() {}, async listModels() { return []; }, async listRepositories() { return []; },
    },
    persist(next) { persisted.push(structuredClone(next)); },
  }, events));
  const state = backend.getState();
  await flush();
  await backend.disposeObservation();
  release();
  await state;
  assert.deepEqual(events, []);
  assert.deepEqual(persisted, []);
});

test("Cursor bounds recovery candidates before any conversation calls", async () => {
  const before = fakeRun({ id: "run-many-candidates-before", agentId: "bc-many-candidates", createdAt: 10 });
  let conversations = 0;
  const candidates = Array.from({ length: backendModule.MAX_CURSOR_RECOVERY_CANDIDATES + 1 }, (_value, index) => fakeRun({
    id: `run-many-candidate-${index}`, agentId: "bc-many-candidates", createdAt: 20 + index,
    conversation: async () => { conversations++; return []; },
  }));
  let sends = 0;
  let getRunCalls = 0;
  const agent = { agentId: "bc-many-candidates", async send() { sends++; throw new Error("lost response"); }, close() {}, async listArtifacts() { return []; }, async getUsage() { return {}; } };
  const backend = new backendModule.CursorCloudBackend(backendOptions({
    stored: storedCursor({ agentId: "bc-many-candidates", remoteCreated: true, remoteLifecycle: "idle", currentRunId: before.id }),
    sdk: {
      async createAgent() { throw new Error("must not create"); }, async resumeAgent() { return agent; }, async getAgent() { return {}; },
      async listRuns() { return sends === 0 ? [before] : [before, ...candidates]; }, async getRun(id) { getRunCalls++; return id === before.id ? before : candidates.find((run) => run.id === id); }, async cancelRun() {}, async archiveAgent() {}, async listModels() { return []; }, async listRepositories() { return []; },
    },
    persist() {},
  }, []));
  await backend.start();
  await assert.rejects(backend.followUp("Bound conversation recovery"), (error) => error.code === "BACKEND_FAILED");
  assert.equal(conversations, 0);
  assert.ok(getRunCalls <= 2, "only the complete baseline is read before candidate rejection");
});

test("Cursor retries a unique running lost-send candidate without awaiting conversation", async () => {
  const before = fakeRun({ id: "run-running-before", agentId: "bc-running-retry", createdAt: 10 });
  let conversations = 0;
  const running = fakeRun({
    id: "run-running-retry", agentId: "bc-running-retry", createdAt: 20, status: "running",
    wait: async () => await new Promise(() => {}),
    conversation: async () => { conversations++; return await new Promise(() => {}); },
  });
  let sends = 0;
  const agent = {
    agentId: "bc-running-retry",
    async send() { sends++; if (sends === 1) throw new Error("lost response"); return running; },
    close() {}, async listArtifacts() { return []; }, async getUsage() { return {}; },
  };
  const backend = new backendModule.CursorCloudBackend(backendOptions({
    stored: storedCursor({ agentId: "bc-running-retry", remoteCreated: true, remoteLifecycle: "idle", currentRunId: before.id }),
    sdk: {
      async createAgent() { throw new Error("must not create"); }, async resumeAgent() { return agent; }, async getAgent() { return {}; },
      async listRuns() { return sends === 0 ? [before] : [before, running]; }, async getRun(id) { return id === before.id ? before : running; }, async cancelRun() {}, async archiveAgent() {}, async listModels() { return []; }, async listRepositories() { return []; },
    }, persist() {},
  }, []));
  await backend.start();
  const result = await backend.followUp("Retry a running candidate");
  assert.equal(result.run.id, running.id);
  assert.equal(sends, 2, "the same key retry obtains the idempotent running handle");
  assert.equal(conversations, 0, "a running candidate never awaits conversation()");
});

test("Cursor cancellation does not consume marked live user messages from a running lost-send candidate", async () => {
  const persisted = [];
  const before = fakeRun({ id: "run-probe-before", agentId: "bc-live-probe", createdAt: 10 });
  let delivered = "";
  let conversations = 0;
  const running = fakeRun({
    id: "run-probe-running", agentId: "bc-live-probe", createdAt: 20, status: "running",
    wait: async () => await new Promise(() => {}),
    conversation: async () => { conversations++; return await new Promise(() => {}); },
  });
  let streamReads = 0;
  running.stream = () => { streamReads++; return asyncMessages([{ type: "user", message: { role: "user", content: [{ type: "text", text: delivered }] } }]); };
  const abort = new AbortController();
  let sends = 0;
  let cancelled;
  const agent = {
    agentId: "bc-live-probe",
    async send(message) { sends++; delivered = message; abort.abort(); throw new Error("lost response"); },
    close() {}, async listArtifacts() { return []; }, async getUsage() { return {}; },
  };
  const backend = new backendModule.CursorCloudBackend(backendOptions({
    stored: storedCursor({ agentId: "bc-live-probe", remoteCreated: true, remoteLifecycle: "idle", currentRunId: before.id }),
    sdk: {
      async createAgent() { throw new Error("must not create"); }, async resumeAgent() { return agent; }, async getAgent() { return {}; },
      async listRuns() { return sends === 0 ? [before] : [before, running]; }, async getRun(id) { return id === before.id ? before : running; }, async cancelRun(id) { cancelled = id; }, async archiveAgent() {}, async listModels() { return []; }, async listRepositories() { return []; },
    }, persist(next) { persisted.push(structuredClone(next)); },
  }, []));
  await backend.start();
  await assert.rejects(backend.followUp("Cancel a marked live request", abort.signal), (error) => error.code === "BACKEND_FAILED");
  assert.equal(sends, 1);
  assert.equal(conversations, 0);
  assert.equal(streamReads, 0, "the shared live stream stays available to its normal observer");
  assert.equal(cancelled, undefined);
  assert.equal(persisted.at(-1).remoteLifecycle, "remote-state-unknown");
});

test("Cursor preserves unknown state when a running lost-send candidate has no safe terminal attribution", async () => {
  const persisted = [];
  const before = fakeRun({ id: "run-probe-missing-before", agentId: "bc-live-probe-missing", createdAt: 10 });
  const running = fakeRun({ id: "run-probe-missing", agentId: "bc-live-probe-missing", createdAt: 20, status: "running", wait: async () => await new Promise(() => {}) });
  let streamReads = 0;
  running.stream = () => { streamReads++; return asyncMessages([{ type: "user", message: { role: "user", content: [{ type: "text", text: "external request" }] } }]); };
  const abort = new AbortController();
  let sends = 0;
  let cancelled = 0;
  const agent = { agentId: "bc-live-probe-missing", async send() { sends++; abort.abort(); throw new Error("lost response"); }, close() {}, async listArtifacts() { return []; }, async getUsage() { return {}; } };
  const backend = new backendModule.CursorCloudBackend(backendOptions({
    stored: storedCursor({ agentId: "bc-live-probe-missing", remoteCreated: true, remoteLifecycle: "idle", currentRunId: before.id }),
    sdk: {
      async createAgent() { throw new Error("must not create"); }, async resumeAgent() { return agent; }, async getAgent() { return {}; }, async listRuns() { return sends === 0 ? [before] : [before, running]; }, async getRun(id) { return id === before.id ? before : running; }, async cancelRun() { cancelled++; }, async archiveAgent() {}, async listModels() { return []; }, async listRepositories() { return []; },
    }, persist(next) { persisted.push(structuredClone(next)); },
  }, []));
  await backend.start();
  await assert.rejects(backend.followUp("Do not cancel an external run", abort.signal), (error) => error.code === "BACKEND_FAILED");
  assert.equal(cancelled, 0);
  assert.equal(streamReads, 0);
  assert.equal(persisted.at(-1).remoteLifecycle, "remote-state-unknown");
});

test("Cursor finds a latest user turn before more than 128 trailing non-user turns", async () => {
  const nonce = "send-long-conversation";
  const before = fakeRun({ id: "run-long-before", agentId: "bc-long-conversation", createdAt: 10 });
  const terminal = fakeRun({
    id: "run-long-terminal", agentId: "bc-long-conversation", createdAt: 20,
    conversation: async () => [
      { type: "agentConversationTurn", turn: { userMessage: { text: markedRequest("Find the old user turn", nonce) } } },
      ...Array.from({ length: 200 }, () => ({ type: "agentConversationTurn", turn: { steps: [{ type: "assistant", message: { text: "trailing telemetry" } }] } })),
    ],
  });
  const lifecycle = backendModule.createCursorSubagentLifecyclePort({
    async getAgent() { return {}; }, async listRuns() { return [before, terminal]; }, async getRun(id) { return id === before.id ? before : terminal; },
  });
  assert.deepEqual(await lifecycle.reconcile(storedCursor({
    agentId: "bc-long-conversation", remoteCreated: true, remoteLifecycle: "remote-state-unknown", currentRunId: before.id,
    pendingOperations: [{ kind: "follow-up", idempotencyKey: "long-conversation", nonce, requestHash: requestHash(markedRequest("Find the old user turn", nonce)), createdAt: 1, baselineComplete: true, baselineRunId: before.id, baselineCreatedAt: 10 }],
  })), {
    remoteLifecycle: "idle", currentRunId: terminal.id, currentRequestId: "request-fake", pendingResult: { state: "available", runId: terminal.id },
  });
});

test("Cursor authoritative parent completion retains bounded artifacts and policy warnings", async () => {
  const run = fakeRun({ id: "run-parent-artifacts", agentId: "bc-parent-artifacts", result: "Artifact result", git: { branches: [{ branch: "cursor/unexpected" }] } });
  const agent = {
    agentId: "bc-parent-artifacts", async send() { return run; }, close() {},
    async listArtifacts() { return [{ path: "reports/result.md", sizeBytes: 42, updatedAt: "2026-03-24" }]; }, async getUsage() { return {}; },
  };
  const cursor = {
    stored: storedCursor({ agentId: "bc-parent-artifacts", remoteCreated: true, remoteLifecycle: "idle" }),
    sdk: {
      async createAgent() { throw new Error("must not create"); }, async resumeAgent() { return agent; }, async getAgent() { return {}; }, async listRuns() { return [fakeRun({ id: "run-parent-artifacts-before", agentId: "bc-parent-artifacts", createdAt: 1 })]; }, async getRun(id) { return id === "run-parent-artifacts-before" ? fakeRun({ id, agentId: "bc-parent-artifacts", createdAt: 1 }) : run; }, async cancelRun() {}, async archiveAgent() {}, async listModels() { return []; }, async listRepositories() { return []; },
    }, persist() {},
  };
  const controller = new SubagentSessionController({ ui: {} }, { args: [], cwd: "/tmp", mode: "fresh", initialPrompt: "", scopedModels: [], cursor }, (options) => new backendModule.CursorCloudBackend({ ...options, cursor: options.cursor }));
  const result = await controller.promptAndWait("Return artifact metadata");
  assert.deepEqual(result.artifacts, [{ id: result.artifacts[0].id, name: "reports/result.md", path: "reports/result.md", sizeBytes: 42, updatedAt: "2026-03-24" }]);
  assert.deepEqual(result.policyWarnings, ["Cursor Cloud reported branch or pull-request metadata despite the no-change policy."]);
  await controller.stop();
});

test("Cursor retains one restored pending result without reattaching it on repeated state reads or return", async () => {
  const events = [];
  const terminal = fakeRun({ id: "run-retained-once", agentId: "bc-retained-once", status: "finished", result: "Restored once" });
  const agent = { agentId: "bc-retained-once", async send() { throw new Error("must not send"); }, close() {}, async listArtifacts() { return []; }, async getUsage() { return {}; } };
  const backend = new backendModule.CursorCloudBackend(backendOptions({
    stored: storedCursor({
      agentId: "bc-retained-once", remoteCreated: true, remoteLifecycle: "idle", currentRunId: terminal.id,
      pendingResult: { state: "available", runId: terminal.id },
    }),
    sdk: {
      async createAgent() { throw new Error("must not create"); }, async resumeAgent() { return agent; }, async getAgent() { return {}; }, async listRuns() { return []; }, async getRun() { return terminal; }, async cancelRun() {}, async archiveAgent() {}, async listModels() { return []; }, async listRepositories() { return []; },
    }, persist() {},
  }, events));
  await backend.start();
  const first = await backend.getState();
  const second = await backend.getState();
  assert.deepEqual(first.pendingResult, { id: terminal.id, runtime: "cursor-cloud", parentOwned: true });
  assert.deepEqual(second.pendingResult, { id: terminal.id, runtime: "cursor-cloud", parentOwned: true });
  assert.equal(first.run, undefined);
  assert.equal(second.run, undefined);
  assert.equal(events.filter((event) => event.type === "run_started").length, 1);
  assert.equal(events.filter((event) => event.type === "run_settled").length, 1);
  await backend.markRunCompletionDelivered({ id: terminal.id, runtime: "cursor-cloud" });
  const afterReturn = await backend.getState();
  assert.equal(afterReturn.pendingResult, undefined);
  assert.equal(events.filter((event) => event.type === "run_started").length, 1, "return does not reattach a retained completion");
});

test("Cursor terminal settlement times out optional artifacts and bounds aggregate metadata", async () => {
  let rejectArtifacts;
  const stalledArtifacts = new Promise((_resolve, reject) => { rejectArtifacts = reject; });
  const events = [];
  let settle;
  const settled = new Promise((resolve) => { settle = resolve; });
  const terminal = fakeRun({ id: "run-artifact-timeout", agentId: "bc-artifact-timeout", result: "Settles without artifacts" });
  const agent = {
    agentId: "bc-artifact-timeout", async send() { return terminal; }, close() {},
    async listArtifacts() { return await stalledArtifacts; }, async getUsage() { return {}; },
  };
  const backend = new backendModule.CursorCloudBackend({
    ...backendOptions({
      stored: storedCursor({ agentId: "bc-artifact-timeout", remoteCreated: true, remoteLifecycle: "idle" }),
      artifactListTimeoutMs: 1,
      sdk: {
        async createAgent() { throw new Error("must not create"); }, async resumeAgent() { return agent; }, async getAgent() { return {}; }, async listRuns() { return [fakeRun({ id: "run-artifact-timeout-before", agentId: "bc-artifact-timeout", createdAt: 1 })]; }, async getRun(id) { return id === "run-artifact-timeout-before" ? fakeRun({ id, agentId: "bc-artifact-timeout", createdAt: 1 }) : terminal; }, async cancelRun() {}, async archiveAgent() {}, async listModels() { return []; }, async listRepositories() { return []; },
      }, persist() {},
    }, events),
    onEvent(event) { events.push(event); if (event.type === "run_settled") settle(); },
  });
  await backend.start();
  const accepted = await backend.prompt("Settle despite a hung artifact list");
  await Promise.race([settled, new Promise((_, reject) => setTimeout(() => reject(new Error("artifact timeout blocked settlement")), 100))]);
  assert.equal((await backend.getRunCompletion(accepted.run)).artifacts, undefined);
  rejectArtifacts(new Error("token=late-artifact-rejection"));
  await flush();

  const aggregateAgent = {
    agentId: "bc-artifact-aggregate", async send() { throw new Error("must not send"); }, close() {},
    async listArtifacts() { return Array.from({ length: backendModule.MAX_CURSOR_ARTIFACTS }, (_value, index) => ({ path: `${index}-`.padEnd(backendModule.MAX_CURSOR_ARTIFACT_NAME_CHARS, "x"), sizeBytes: index, updatedAt: "2026-03-24" })); }, async getUsage() { return {}; },
  };
  const aggregate = new backendModule.CursorCloudBackend(backendOptions({
    stored: storedCursor({ agentId: "bc-artifact-aggregate", remoteCreated: true, remoteLifecycle: "idle" }),
    sdk: {
      async createAgent() { throw new Error("must not create"); }, async resumeAgent() { return aggregateAgent; }, async getAgent() { return {}; }, async listRuns() { return []; }, async getRun() { throw new Error("must not get run"); }, async cancelRun() {}, async archiveAgent() {}, async listModels() { return []; }, async listRepositories() { return []; },
    }, persist() {},
  }, []));
  await aggregate.start();
  const artifacts = await aggregate.getArtifacts();
  const metadataChars = artifacts.reduce((total, artifact) => total + artifact.id.length + artifact.name.length + (artifact.path?.length ?? 0) + (artifact.updatedAt?.length ?? 0) + (artifact.sizeBytes === undefined ? 0 : String(artifact.sizeBytes).length), 0);
  assert.ok(metadataChars <= backendModule.MAX_CURSOR_ARTIFACT_METADATA_CHARS);
});

test("an attached Cursor panel follows up after its observed durable completion but reopens read-only", async () => {
  const durable = storedCursor({ agentId: "bc-panel-observed", currentModel: { id: "cursor-a", parameters: [{ id: "reasoning_effort", value: "low" }], resolvedAt: 1 } });
  const first = fakeRun({ id: "run-panel-observed", agentId: "bc-panel-observed", result: "First panel result" });
  const second = fakeRun({ id: "run-panel-follow-up", agentId: "bc-panel-observed", result: "Second panel result" });
  const sends = [];
  const agent = {
    agentId: "bc-panel-observed",
    async send(message) { sends.push(message); return sends.length === 1 ? first : second; },
    close() {}, async listArtifacts() { return []; }, async getUsage() { return {}; },
  };
  const cursor = {
    stored: durable,
    sdk: {
      async createAgent() { return agent; }, async resumeAgent() { return agent; }, async getAgent() { return {}; },
      async listRuns() { return [first]; }, async getRun(runId) { return runId === first.id ? first : second; },
      async cancelRun() { throw new Error("panel detachment must not cancel the Cursor run"); }, async archiveAgent() {},
      async listModels() { return []; }, async listRepositories() { return []; },
    },
    catalog: fakeCursorCatalog(),
    persist(next) { Object.assign(durable, structuredClone(next)); },
  };
  const controller = new SubagentSessionController({ ui: {} }, {
    args: [], cwd: "/tmp", mode: "fresh", initialPrompt: "", scopedModels: [], cursor,
  }, (options) => new backendModule.CursorCloudBackend({ ...options, cursor: options.cursor }));
  const detach = controller.attach({ ui: {} }, () => {}, () => {});
  await controller.start();
  assert.equal(await controller.submit("First panel request"), true);
  await waitFor(() => !controller.state.busy && durable.pendingResult.state === "available");
  await controller.synchronizeCursorState();
  assert.equal(durable.pendingResult.runId, first.id);
  assert.equal(controller.state.readOnly, false);
  assert.equal(controller.state.canFollowUp, true);
  assert.equal(await controller.submit("Continue in this panel"), true);
  await waitFor(() => !controller.state.busy && durable.pendingResult.state === "available" && durable.pendingResult.runId === second.id);
  await controller.synchronizeCursorState();
  assert.equal(controller.state.readOnly, false);
  detach();
  await controller.disposeObservation();

  const reopenDetach = controller.attach({ ui: {} }, () => {}, () => {});
  await controller.start();
  await controller.synchronizeCursorState();
  assert.equal(controller.state.readOnly, true);
  assert.equal(controller.state.canFollowUp, false);
  assert.equal(await controller.submit("Must return the detached result first"), false);
  assert.equal(sends.length, 2);
  reopenDetach();
  await controller.stop();
});

test("Cursor blocks a new prompt but allows a normal follow-up after settlement", async () => {
  let sends = 0;
  const terminal = fakeRun({ id: "run-pending-submit", agentId: "bc-pending-submit", result: "Return this first" });
  const next = fakeRun({ id: "run-pending-follow-up", agentId: "bc-pending-submit", result: "Continue after settlement" });
  const agent = { agentId: "bc-pending-submit", async send() { sends++; return next; }, close() {}, async listArtifacts() { return []; }, async getUsage() { return {}; } };
  const backend = new backendModule.CursorCloudBackend(backendOptions({
    stored: storedCursor({
      agentId: "bc-pending-submit", remoteCreated: true, remoteLifecycle: "idle", currentRunId: terminal.id,
      pendingResult: { state: "available", runId: terminal.id },
    }),
    sdk: {
      async createAgent() { throw new Error("must not create"); }, async resumeAgent() { return agent; }, async getAgent() { return {}; }, async listRuns() { return [terminal]; }, async getRun() { return terminal; }, async cancelRun() {}, async archiveAgent() {}, async listModels() { return []; }, async listRepositories() { return []; },
    }, persist() {},
  }, []));
  await backend.start();
  await assert.rejects(backend.prompt("This direct panel submit must wait"), (error) => error.code === "BUSY");
  assert.equal(sends, 0);
  const followUp = await backend.followUp("Continue after settlement");
  assert.equal(followUp.run.id, next.id);
  assert.equal(sends, 1);
  await flush();
  assert.deepEqual((await backend.getState()).pendingResult, { id: next.id, runtime: "cursor-cloud", parentOwned: true });
});

test("Cursor cancellation settles a marked terminal lost-send candidate without consuming telemetry", async () => {
  const persisted = [];
  const before = fakeRun({ id: "run-terminal-cancel-before", agentId: "bc-terminal-cancel", createdAt: 10 });
  let delivered = "";
  let conversations = 0;
  let streamReads = 0;
  const terminal = fakeRun({
    id: "run-terminal-cancel", agentId: "bc-terminal-cancel", createdAt: 20, status: "finished", result: "Saved terminal result",
    conversation: async () => { conversations++; return await userConversation(delivered)(); },
  });
  terminal.stream = () => { streamReads++; return asyncMessages([]); };
  const abort = new AbortController();
  let sends = 0;
  let cancels = 0;
  const agent = { agentId: "bc-terminal-cancel", async send(message) { sends++; delivered = message; abort.abort(); throw new Error("lost response"); }, close() {}, async listArtifacts() { return []; }, async getUsage() { return {}; } };
  const backend = new backendModule.CursorCloudBackend(backendOptions({
    stored: storedCursor({ agentId: "bc-terminal-cancel", remoteCreated: true, remoteLifecycle: "idle", currentRunId: before.id }),
    sdk: {
      async createAgent() { throw new Error("must not create"); }, async resumeAgent() { return agent; }, async getAgent() { return {}; }, async listRuns() { return sends === 0 ? [before] : [before, terminal]; }, async getRun(id) { return id === before.id ? before : terminal; }, async cancelRun() { cancels++; }, async archiveAgent() {}, async listModels() { return []; }, async listRepositories() { return []; },
    }, persist(next) { persisted.push(structuredClone(next)); },
  }, []));
  await backend.start();
  await assert.rejects(backend.followUp("Cancel after a terminal lost response", abort.signal), (error) => error.code === "CANCELLED");
  assert.equal(sends, 1);
  assert.equal(conversations, 1, "terminal attribution uses bounded conversation data");
  assert.equal(streamReads, 0);
  assert.equal(cancels, 0, "a terminal result needs no cancellation request");
  assert.deepEqual(persisted.at(-1).pendingResult, { state: "available", runId: terminal.id });
});

test("Cursor does not replay an externally observed terminal run to a later parent prompt", async () => {
  let resolveExternal;
  const externalWait = new Promise((resolve) => { resolveExternal = resolve; });
  const external = fakeRun({
    id: "run-external-active", agentId: "bc-external-active", status: "running",
    wait: async () => await externalWait,
  });
  const sent = fakeRun({ id: "run-local-after-external", agentId: "bc-external-active", result: "Local follow-up result", createdAt: 20 });
  let sends = 0;
  const agent = {
    agentId: "bc-external-active",
    async send() { sends++; return sent; }, close() {}, async listArtifacts() { return []; }, async getUsage() { return {}; },
  };
  const cursor = {
    stored: storedCursor({
      agentId: "bc-external-active", remoteCreated: true, remoteLifecycle: "running", currentRunId: external.id,
    }),
    sdk: {
      async createAgent() { throw new Error("must not create"); }, async resumeAgent() { return agent; }, async getAgent() { return { status: "running" }; },
      async listRuns() { return [external]; }, async getRun(id) { return id === external.id ? external : sent; },
      async cancelRun() {}, async archiveAgent() {}, async listModels() { return []; }, async listRepositories() { return []; },
    }, persist() {},
  };
  let backend;
  const controller = new SubagentSessionController({ ui: {} }, {
    args: [], cwd: "/tmp", mode: "fresh", initialPrompt: "", scopedModels: [], cursor,
  }, (options) => {
    backend = new backendModule.CursorCloudBackend({ ...options, cursor: options.cursor });
    return backend;
  });
  await controller.start();
  await assert.rejects(controller.promptAndWait("Do not receive external work"), (error) => error.code === "BUSY");
  resolveExternal({ id: external.id, status: "finished", result: "External result" });
  await flush();
  await flush();
  assert.equal(sends, 0);
  assert.equal(await backend.getRunCompletion({ id: external.id, runtime: "cursor-cloud", parentOwned: false }), undefined);
  assert.equal(controller.returnText(), undefined);
  assert.equal(controller.state.lastCompletedAssistantText, undefined);
  assert.equal(controller.state.items.some((item) => item.kind === "assistant" && item.text.includes("External result")), false);
  assert.equal((await controller.promptAndWait("Send local work now")).text, "Local follow-up result");
  assert.equal(sends, 1);
  await controller.stop();
});

test("Cursor bounds final usage lookup and retains result usage when the lookup hangs", async () => {
  let rejectUsage;
  const hungUsage = new Promise((_resolve, reject) => { rejectUsage = reject; });
  const events = [];
  let settled;
  const settledPromise = new Promise((resolve) => { settled = resolve; });
  const run = fakeRun({
    id: "run-usage-timeout", agentId: "bc-usage-timeout", result: "Usage result",
    usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8, cost: { chargedCents: 25 } },
  });
  const agent = {
    agentId: "bc-usage-timeout", async send() { return run; }, close() {}, async listArtifacts() { return []; },
    async getUsage() { return await hungUsage; },
  };
  const backend = new backendModule.CursorCloudBackend({
    ...backendOptions({
      stored: storedCursor({ agentId: "bc-usage-timeout", remoteCreated: true, remoteLifecycle: "idle", currentRunId: "run-usage-before" }),
      usageTimeoutMs: 1,
      sdk: {
        async createAgent() { throw new Error("must not create"); }, async resumeAgent() { return agent; }, async getAgent() { return {}; },
        async listRuns() { return [fakeRun({ id: "run-usage-before", agentId: "bc-usage-timeout", createdAt: 1 })]; },
        async getRun(id) { return id === "run-usage-before" ? fakeRun({ id, agentId: "bc-usage-timeout", createdAt: 1 }) : run; },
        async cancelRun() {}, async archiveAgent() {}, async listModels() { return []; }, async listRepositories() { return []; },
      }, persist() {},
    }, events),
    onEvent(event) { events.push(event); if (event.type === "run_settled") settled(); },
  });
  await backend.start();
  await backend.prompt("Settle despite a hung usage lookup");
  await Promise.race([settledPromise, new Promise((_resolve, reject) => setTimeout(() => reject(new Error("usage lookup blocked settlement")), 100))]);
  assert.deepEqual(events.filter((event) => event.type === "usage_update").map((event) => event.usage), [
    { input: 3, output: 5, totalTokens: 8, cost: { total: 0.25 } },
  ]);
  assert.deepEqual((await backend.getRunCompletion({ id: run.id, runtime: "cursor-cloud" })).usage, {
    input: 3, output: 5, totalTokens: 8, cost: { total: 0.25 },
  });
  rejectUsage(new Error("token=late-usage-rejection"));
  await flush();
});

test("Cursor retains all reported final usage and cost zeros", async () => {
  const run = fakeRun({
    id: "run-zero-usage", agentId: "bc-zero-usage", result: "Zero usage result",
    usage: {
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      totalTokens: 0, reasoningTokens: 0, cost: { chargedCents: 0 },
    },
  });
  const agent = {
    agentId: "bc-zero-usage", async send() { return run; }, close() {}, async listArtifacts() { return []; }, async getUsage() { return {}; },
  };
  const cursor = {
    stored: storedCursor({ agentId: "bc-zero-usage", remoteCreated: true, remoteLifecycle: "idle", currentRunId: "run-zero-usage-before" }),
    sdk: {
      async createAgent() { throw new Error("must not create"); }, async resumeAgent() { return agent; }, async getAgent() { return {}; },
      async listRuns() { return [fakeRun({ id: "run-zero-usage-before", agentId: "bc-zero-usage", createdAt: 1 })]; },
      async getRun(id) { return id === "run-zero-usage-before" ? fakeRun({ id, agentId: "bc-zero-usage", createdAt: 1 }) : run; },
      async cancelRun() {}, async archiveAgent() {}, async listModels() { return []; }, async listRepositories() { return []; },
    }, persist() {},
  };
  const controller = new SubagentSessionController({ ui: {} }, {
    args: [], cwd: "/tmp", mode: "fresh", initialPrompt: "", scopedModels: [], cursor,
  }, (options) => new backendModule.CursorCloudBackend({ ...options, cursor: options.cursor }));
  const result = await controller.promptAndWait("Return authoritative zero usage");
  assert.deepEqual(result.usage, {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, reasoningTokens: 0, cost: { total: 0 },
  });
  await controller.stop();
});

test("Cursor keeps a terminal parent failure durable until explicit delivery acknowledgement",  async () => {
  const persisted = [];
  const before = fakeRun({ id: "run-failure-before", agentId: "bc-failure-delivery", createdAt: 1 });
  const failed = fakeRun({ id: "run-failure", agentId: "bc-failure-delivery", status: "error", error: { code: "failed" } });
  const succeeded = fakeRun({ id: "run-after-failure", agentId: "bc-failure-delivery", result: "Recovered after failure", createdAt: 3 });
  let sends = 0;
  const agent = {
    agentId: "bc-failure-delivery",
    async send() { sends++; return sends === 1 ? failed : succeeded; }, close() {}, async listArtifacts() { return []; }, async getUsage() { return {}; },
  };
  const cursor = {
    stored: storedCursor({ agentId: "bc-failure-delivery", remoteCreated: true, remoteLifecycle: "idle", currentRunId: before.id }),
    sdk: {
      async createAgent() { throw new Error("must not create"); }, async resumeAgent() { return agent; }, async getAgent() { return {}; },
      async listRuns() { return sends < 2 ? [before, failed] : [before, failed, succeeded]; },
      async getRun(id) { return id === before.id ? before : id === failed.id ? failed : succeeded; },
      async cancelRun() {}, async archiveAgent() {}, async listModels() { return []; }, async listRepositories() { return []; },
    }, persist(next) { persisted.push(structuredClone(next)); },
  };
  const controller = new SubagentSessionController({ ui: {} }, {
    args: [], cwd: "/tmp", mode: "fresh", initialPrompt: "", scopedModels: [], cursor,
  }, (options) => new backendModule.CursorCloudBackend({ ...options, cursor: options.cursor }));
  await assert.rejects(controller.promptAndWait("Fail terminally"), /Cursor Cloud run failed/);
  assert.equal(persisted.at(-1).pendingResult.state, "available");
  await controller.markCursorRunCompletionDelivered({ id: failed.id, runtime: "cursor-cloud", parentOwned: true });
  assert.equal(persisted.at(-1).pendingResult.state, "none");
  assert.equal((await controller.promptAndWait("Continue after failure")).text, "Recovered after failure");
  assert.equal(sends, 2);
  await controller.stop();
});

test("Cursor leaves a still-active cancelled parent run pending", async () => {
  let resolveWait;
  const pendingWait = new Promise((resolve) => { resolveWait = resolve; });
  const persisted = [];
  const run = fakeRun({ id: "run-parent-cancel", agentId: "bc-parent-cancel", status: "running", wait: async () => await pendingWait });
  const agent = {
    agentId: "bc-parent-cancel", async send() { return run; }, close() {}, async listArtifacts() { return []; }, async getUsage() { return {}; },
  };
  const cursor = {
    stored: storedCursor({ agentId: "bc-parent-cancel", remoteCreated: true, remoteLifecycle: "idle", currentRunId: "run-parent-cancel-before" }),
    sdk: {
      async createAgent() { throw new Error("must not create"); }, async resumeAgent() { return agent; }, async getAgent() { return {}; },
      async listRuns() { return [fakeRun({ id: "run-parent-cancel-before", agentId: "bc-parent-cancel", createdAt: 1 })]; },
      async getRun(id) { return id === run.id ? run : fakeRun({ id, agentId: "bc-parent-cancel", createdAt: 1 }); },
      async cancelRun() {}, async archiveAgent() {}, async listModels() { return []; }, async listRepositories() { return []; },
    }, persist(next) { persisted.push(structuredClone(next)); },
  };
  const controller = new SubagentSessionController({ ui: {} }, {
    args: [], cwd: "/tmp", mode: "fresh", initialPrompt: "", scopedModels: [], cursor,
  }, (options) => new backendModule.CursorCloudBackend({ ...options, cursor: options.cursor }));
  const abort = new AbortController();
  const prompt = controller.promptAndWait("Cancel while active", abort.signal);
  await flush();
  abort.abort();
  await assert.rejects(prompt, /aborted/i);
  assert.deepEqual(persisted.at(-1).pendingResult, { state: "pending", runId: run.id });
  resolveWait({ id: run.id, status: "cancelled" });
  await controller.stop();
});

test("Cursor confirmed parent cancellation clears its terminal result before a task follow-up", async () => {
  let resolveCancelled;
  const cancelled = new Promise((resolve) => { resolveCancelled = resolve; });
  let sends = 0;
  const active = fakeRun({
    id: "run-parent-cancel-reuse", agentId: "bc-parent-cancel-reuse", status: "running",
    wait: async () => await cancelled,
  });
  const followUp = fakeRun({
    id: "run-parent-cancel-reuse-next", agentId: "bc-parent-cancel-reuse", result: "Reusable after confirmed cancellation",
  });
  const persisted = [];
  const agent = {
    agentId: "bc-parent-cancel-reuse",
    async send() { return ++sends === 1 ? active : followUp; },
    close() {}, async listArtifacts() { return []; }, async getUsage() { return {}; },
  };
  const cursor = {
    stored: storedCursor({
      agentId: agent.agentId, remoteCreated: true, remoteLifecycle: "idle", currentRunId: "run-parent-cancel-reuse-before",
    }),
    sdk: {
      async createAgent() { throw new Error("must not create"); }, async resumeAgent() { return agent; }, async getAgent() { return {}; },
      async listRuns() { return [fakeRun({ id: "run-parent-cancel-reuse-before", agentId: agent.agentId, createdAt: 1 })]; },
      async getRun(id) {
        return id === "run-parent-cancel-reuse-before"
          ? fakeRun({ id, agentId: agent.agentId, createdAt: 1 })
          : id === active.id ? active : followUp;
      },
      async cancelRun() {}, async archiveAgent() {}, async listModels() { return []; }, async listRepositories() { return []; },
    },
    persist(next) { persisted.push(structuredClone(next)); },
  };
  const controller = new SubagentSessionController({ ui: {} }, {
    args: [], cwd: "/tmp", mode: "fresh", initialPrompt: "", scopedModels: [], cursor,
  }, (options) => new backendModule.CursorCloudBackend({ ...options, cursor: options.cursor }));
  const abort = new AbortController();
  const cancelledPrompt = controller.promptAndWait("Cancel this task run", abort.signal);
  await flush();
  abort.abort();
  await assert.rejects(cancelledPrompt, /aborted/i);
  resolveCancelled({ id: active.id, status: "cancelled" });
  for (let index = 0; index < 4; index++) await flush();
  assert.equal(persisted.at(-1).pendingResult.state, "none");
  assert.equal((await controller.promptAndWait("Continue after cancellation")).text, "Reusable after confirmed cancellation");
  assert.equal(sends, 2);
  await controller.stop();
});

test("Cursor recovers the latest assistant step from an SDK conversation wrapper", async () => {
  const latest = "Latest wrapped assistant response";
  const run = fakeRun({
    id: "run-conversation-fallback", agentId: "bc-conversation-fallback", result: "",
    wait: async () => { throw new Error("transport lost"); },
    conversation: async () => [
      { type: "agentConversationTurn", turn: { steps: [{ type: "assistantMessage", message: { text: "Older assistant response" } }] } },
      { type: "agentConversationTurn", turn: { steps: [{ type: "toolCall", message: {} }, { type: "assistantMessage", message: { text: latest } }] } },
    ],
  });
  const agent = {
    agentId: "bc-conversation-fallback", async send() { return run; }, close() {}, async listArtifacts() { return []; }, async getUsage() { return {}; },
  };
  const backend = new backendModule.CursorCloudBackend(backendOptions({
    stored: storedCursor({ agentId: "bc-conversation-fallback", remoteCreated: true, remoteLifecycle: "idle", currentRunId: "run-conversation-before" }),
    sdk: {
      async createAgent() { throw new Error("must not create"); }, async resumeAgent() { return agent; }, async getAgent() { return {}; },
      async listRuns() { return [fakeRun({ id: "run-conversation-before", agentId: "bc-conversation-fallback", createdAt: 1 })]; },
      async getRun(id) { return id === "run-conversation-before" ? fakeRun({ id, agentId: "bc-conversation-fallback", createdAt: 1 }) : run; },
      async cancelRun() {}, async archiveAgent() {}, async listModels() { return []; }, async listRepositories() { return []; },
    }, persist() {},
  }, []));
  await backend.start();
  const accepted = await backend.prompt("Recover wrapped conversation output");
  await flush();
  await flush();
  assert.equal((await backend.getRunCompletion(accepted.run)).text, latest);
});

test("Cursor transport recovery uses a terminal getRun result without conversation support", async () => {
  const active = fakeRun({
    id: "run-terminal-transport", agentId: "bc-terminal-transport", status: "running", result: "",
    wait: async () => { throw new Error("transport lost"); },
  });
  const terminal = fakeRun({ id: active.id, agentId: active.agentId, status: "finished", result: "Terminal getRun fallback" });
  const agent = { agentId: active.agentId, async send() { return active; }, close() {}, async listArtifacts() { return []; }, async getUsage() { return {}; } };
  const backend = new backendModule.CursorCloudBackend(backendOptions({
    stored: storedCursor({ agentId: active.agentId, remoteCreated: true, remoteLifecycle: "idle", currentRunId: "run-terminal-before" }),
    sdk: {
      async createAgent() { throw new Error("must not create"); }, async resumeAgent() { return agent; }, async getAgent() { return {}; },
      async listRuns() { return [fakeRun({ id: "run-terminal-before", agentId: agent.agentId, createdAt: 1 })]; },
      async getRun(id) { return id === "run-terminal-before" ? fakeRun({ id, agentId: agent.agentId, createdAt: 1 }) : terminal; },
      async cancelRun() {}, async archiveAgent() {}, async listModels() { return []; }, async listRepositories() { return []; },
    }, persist() {},
  }, []));
  await backend.start();
  const accepted = await backend.prompt("Recover terminal output");
  for (let index = 0; index < 4; index++) await flush();
  assert.equal((await backend.getRunCompletion(accepted.run)).text, "Terminal getRun fallback");
});

test("Cursor stop refuses a complete run-list conflict with a running Agent status", async () => {
  let archives = 0;
  const terminal = fakeRun({ id: "run-status-conflict", agentId: "bc-status-conflict", status: "finished" });
  const lifecycle = backendModule.createCursorSubagentLifecyclePort({
    async getAgent() { return { status: "running" }; }, async listRuns() { return []; }, async getRun() { return terminal; },
    async cancelRun() { throw new Error("no confirmed active run to cancel"); }, async archiveAgent() { archives++; },
  });
  const stored = storedCursor({ agentId: "bc-status-conflict", remoteCreated: true, remoteLifecycle: "idle", currentRunId: terminal.id });
  assert.deepEqual(await lifecycle.stop(stored, { persistArchiveStarted() {} }), { state: "remote-state-unknown" });
  assert.equal(archives, 0);
});
