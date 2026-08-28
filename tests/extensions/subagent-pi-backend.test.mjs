import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const {
  PiRpcBackend,
  PI_PROMPT_RECONCILIATION_DELAY_MS,
  MAX_NORMALIZED_DELTA_CHARS,
  MAX_NORMALIZED_ERROR_CHARS,
  MAX_NORMALIZED_EXTENSION_UI_ITEMS,
  MAX_NORMALIZED_EXTENSION_UI_TOTAL_CHARS,
  MAX_NORMALIZED_ID_CHARS,
  MAX_NORMALIZED_MESSAGE_TEXT_CHARS,
  MAX_NORMALIZED_THINKING_CHARS,
  MAX_NORMALIZED_TOOL_OUTPUT_CHARS,
  MAX_RETAINED_RUN_COMPLETIONS,
  MAX_RETAINED_RUN_COMPLETION_BYTES,
  RUN_COMPLETION_TRUNCATION_NOTICE,
} = await import("../../extensions/subagents/pi-backend.ts");
const { SubagentSessionController } = await import("../../extensions/subagents/controller.ts");

function makePiBackend({
  state = {
    model: { provider: "test", id: "model" },
    thinkingLevel: "high",
    isStreaming: true,
    isCompacting: false,
    sessionFile: "/tmp/fake.jsonl",
  },
  messages = [
    { role: "user", content: "Inspect the backend" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Check the adapter." },
        { type: "text", text: "The adapter is normalized." },
      ],
      stopReason: "stop",
    },
  ],
  onPrompt,
} = {}) {
  const events = [];
  const extensionUiResponses = [];
  let abortCalls = 0;
  let rpcOptions;
  const emit = (event) => rpcOptions.onOutput(event);
  const rpc = {
    async start() {},
    async stop() {},
    getStderr() { return ""; },
    async prompt(message, signal) { await onPrompt?.(message, emit, state, signal); },
    async steer() {},
    async followUp() {},
    async abort() { abortCalls++; },
    async getState() { return state; },
    async getMessages() { return { messages }; },
    async getSessionStats() { return { contextUsage: { tokens: 4, contextWindow: 16 } }; },
    async getAvailableModels() { return { models: [{ provider: "test", id: "model" }] }; },
    async setModel() { return { provider: "test", id: "model" }; },
    async cycleModel() { return null; },
    async setThinkingLevel() {},
    async cycleThinkingLevel() { return null; },
    respondToExtensionUI(response) { extensionUiResponses.push(response); },
  };
  const backend = new PiRpcBackend({
    cwd: "/tmp",
    args: [],
    onEvent(event) { events.push(event); },
    onExit() {},
  }, (options) => {
    rpcOptions = options;
    return rpc;
  });
  return { backend, events, emit, extensionUiResponses, abortCalls: () => abortCalls };
}

test("PiRpcBackend normalizes Pi RPC output with the active run", async () => {
  const { backend, events, emit } = makePiBackend();
  emit({ type: "agent_start" });
  emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "partial" } });
  emit({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "read", args: { path: "README.md" } });
  emit({ type: "tool_execution_end", toolCallId: "tool-1", result: { content: [{ type: "text", text: "done" }] }, isError: false });

  const run = events[0].run;
  assert.deepEqual(events.slice(1), [
    { type: "message_delta", run, textDelta: "partial" },
    { type: "tool_started", run, toolCallId: "tool-1", name: "read", args: "README.md" },
    { type: "tool_completed", run, toolCallId: "tool-1", output: "done", isError: false },
  ]);
  emit({ type: "turn_end" });
  emit({ type: "compaction_start", reason: "automatic" });
  emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 2, delayMs: 50, errorMessage: "retry" });
  emit({ type: "summarization_retry_scheduled", errorMessage: "summary retry" });
  emit({ type: "summarization_retry_attempt_start" });
  emit({ type: "summarization_retry_finished" });
  assert.ok(events.slice(1).every((event) => event.run === run));
  assert.deepEqual(await backend.getHistory(), [
    { role: "user", text: "Inspect the backend" },
    {
      role: "assistant",
      text: "The adapter is normalized.",
      thinking: "Check the adapter.",
      stopReason: "stop",
    },
  ]);
  assert.deepEqual(await backend.getAvailableModels(), [{ provider: "test", id: "model" }]);
  assert.deepEqual(await backend.getSessionStats(), { contextUsage: { tokens: 4, contextWindow: 16 } });
  const backendState = await backend.getState();
  assert.equal(backendState.connection.runtime, "pi");
  assert.match(backendState.connection.id, /^pi-connection-/);
  assert.match(backendState.run?.id ?? "", /^pi-run-1-/);
});

test("PiRpcBackend reconciles Pi delayed starts and keeps extension-handled prompts without agent runs", async () => {
  const delayedState = { thinkingLevel: "off", isStreaming: false, isCompacting: false };
  const delayed = makePiBackend({
    state: delayedState,
    onPrompt(_message, emit, state) {
      setTimeout(() => {
        state.isStreaming = true;
        emit({ type: "agent_start" });
      }, Math.max(1, Math.floor(PI_PROMPT_RECONCILIATION_DELAY_MS / 2)));
    },
  });
  const delayedResult = await delayed.backend.prompt("ordinary prompt");
  assert.ok("run" in delayedResult);
  assert.equal(delayed.events[0]?.type, "run_started");
  assert.equal(delayed.events[0]?.run.id, delayedResult.run.id);

  const handled = makePiBackend({ state: { thinkingLevel: "off", isStreaming: false, isCompacting: false } });
  assert.deepEqual(await handled.backend.prompt("/extension-command"), { handledWithoutRun: true });
});

test("PiRpcBackend assigns one synthetic identity to each settled Pi run", () => {
  const { events, emit } = makePiBackend({ state: { thinkingLevel: "off", isStreaming: false, isCompacting: false } });
  emit({ type: "agent_start" });
  emit({ type: "agent_start" });
  emit({ type: "agent_settled" });
  emit({ type: "agent_start" });
  emit({ type: "agent_settled" });

  const starts = events.filter((event) => event.type === "run_started");
  const settlements = events.filter((event) => event.type === "run_settled");
  assert.equal(starts.length, 3);
  assert.equal(settlements.length, 2);
  assert.equal(starts[0].run.id, starts[1].run.id);
  assert.equal(starts[0].run.id, settlements[0].run.id);
  assert.notEqual(starts[0].run.id, starts[2].run.id);
  assert.equal(starts[2].run.id, settlements[1].run.id);
});

test("PiRpcBackend bounds normalized events and fingerprints full delivered user text", async () => {
  const longPrompt = "prompt-".repeat(20_000);
  const longResponse = "response-".repeat(20_000);
  const longThinking = "thinking-".repeat(10_000);
  const longToolOutput = "tool-output-".repeat(20_000);
  const longId = "id-".repeat(1_000);
  const practicalOptions = Array.from({ length: 250 }, (_value, index) => `option-${index}`);
  practicalOptions[200] = "option-".repeat(1_000);
  const practicalWidgetLines = Array.from({ length: 250 }, (_value, index) => `widget-${index}`);
  practicalWidgetLines[200] = "widget-".repeat(20_000);
  const oversizedOptions = Array.from({ length: MAX_NORMALIZED_EXTENSION_UI_ITEMS + 100 }, () => "x".repeat(1_000));
  const { backend, events, emit } = makePiBackend({
    state: { thinkingLevel: "off", isStreaming: false, isCompacting: false },
    messages: [
      { role: "user", content: longPrompt },
      { role: "assistant", content: [{ type: "text", text: longResponse }], stopReason: "stop" },
    ],
  });

  const history = await backend.getHistory();
  assert.equal(history[0]?.text, longPrompt);
  assert.equal(history[1]?.role, "assistant");
  assert.equal(history[1]?.text, longResponse);

  emit({ type: "agent_start" });
  const run = events[0].run;
  emit({ type: "message_start", message: { role: "user", content: longPrompt } });
  emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: longResponse } });
  emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: longThinking } });
  emit({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: longResponse }, { type: "thinking", thinking: longThinking }],
      stopReason: longId,
      errorMessage: longResponse,
    },
  });
  emit({ type: "tool_execution_end", toolCallId: longId, result: { content: [{ type: "text", text: longToolOutput }] }, isError: true });
  emit({ type: "extension_ui_request", method: "select", id: "select-id", title: "Select", options: practicalOptions });
  emit({ type: "extension_ui_request", method: "setWidget", widgetKey: "widget", widgetLines: practicalWidgetLines });
  emit({ type: "extension_ui_request", method: "select", id: longId, title: "Oversized", options: oversizedOptions });

  const user = events[1];
  assert.equal(user.type, "message_started");
  assert.equal(user.run, run);
  assert.equal(user.message.role, "user");
  assert.equal(user.message.text.length, MAX_NORMALIZED_MESSAGE_TEXT_CHARS);
  assert.equal(user.message.fullTextFingerprint, createHash("sha256").update(longPrompt).digest("hex"));
  assert.equal(user.message.truncated, true);

  const textDelta = events[2];
  const thinkingDelta = events[3];
  const assistant = events[4];
  const tool = events[5];
  assert.equal(textDelta.textDelta.length, MAX_NORMALIZED_DELTA_CHARS);
  assert.equal(thinkingDelta.thinkingDelta.length, MAX_NORMALIZED_DELTA_CHARS);
  assert.equal(assistant.message.text.length, MAX_NORMALIZED_MESSAGE_TEXT_CHARS);
  assert.equal(assistant.message.thinking.length, MAX_NORMALIZED_THINKING_CHARS);
  assert.equal(assistant.message.stopReason.length, MAX_NORMALIZED_ID_CHARS);
  assert.equal(assistant.message.errorMessage.length, MAX_NORMALIZED_ERROR_CHARS);
  assert.ok(tool.toolCallId.length <= MAX_NORMALIZED_ID_CHARS);
  assert.notEqual(tool.toolCallId, longId);
  assert.equal(tool.output.length, MAX_NORMALIZED_TOOL_OUTPUT_CHARS);

  const practicalSelect = events[6];
  const practicalWidget = events[7];
  const oversizedSelect = events[8];
  assert.deepEqual(practicalSelect.request.options, practicalOptions);
  assert.deepEqual(practicalWidget.request.widgetLines, practicalWidgetLines);
  assert.equal(oversizedSelect.request.options.length, MAX_NORMALIZED_EXTENSION_UI_ITEMS);
  const uiTotal = oversizedSelect.request.id.length
    + oversizedSelect.request.title.length
    + oversizedSelect.request.options.reduce((total, option) => total + option.length, 0);
  assert.ok(uiTotal <= MAX_NORMALIZED_EXTENSION_UI_TOTAL_CHARS);
  assert.equal(oversizedSelect.request.truncated, true);
});

test("PiRpcBackend correlates opaque extension UI IDs and keeps long identities distinct", () => {
  const longA = `request-a-${"a".repeat(2_000)}`;
  const longB = `request-b-${"b".repeat(2_000)}`;
  const { backend, events, emit, extensionUiResponses } = makePiBackend({
    state: { thinkingLevel: "off", isStreaming: false, isCompacting: false },
  });
  emit({ type: "agent_start" });
  emit({ type: "extension_ui_request", method: "select", id: longA, title: "First", options: ["one"] });
  emit({ type: "extension_ui_request", method: "confirm", id: longB, title: "Second", message: "Continue?" });
  emit({ type: "tool_execution_start", toolCallId: longA, toolName: "read", args: {} });
  emit({ type: "tool_execution_start", toolCallId: longB, toolName: "read", args: {} });
  emit({ type: "tool_execution_update", toolCallId: longA, partialResult: { content: [] } });
  emit({ type: "tool_execution_end", toolCallId: longB, result: { content: [] }, isError: false });
  emit({ type: "extension_ui_request", method: "setStatus", statusKey: longA, statusText: "First" });
  emit({ type: "extension_ui_request", method: "setStatus", statusKey: longB, statusText: "Second" });
  emit({ type: "extension_ui_request", method: "setWidget", widgetKey: longA, widgetLines: ["First"] });
  emit({ type: "extension_ui_request", method: "setWidget", widgetKey: longB, widgetLines: ["Second"] });

  const requests = events.filter((event) => event.type === "extension_ui_request");
  const select = requests[0].request;
  const confirm = requests[1].request;
  assert.notEqual(select.id, longA);
  assert.notEqual(confirm.id, longB);
  assert.notEqual(select.id, confirm.id);
  assert.ok(select.id.length <= MAX_NORMALIZED_ID_CHARS);
  backend.respondToExtensionUI({ id: select.id, value: "one" });
  backend.respondToExtensionUI({ id: confirm.id, cancelled: true });
  assert.deepEqual(extensionUiResponses, [
    { type: "extension_ui_response", id: longA, value: "one" },
    { type: "extension_ui_response", id: longB, cancelled: true },
  ]);

  const tools = events.filter((event) => event.type === "tool_started");
  const toolUpdate = events.find((event) => event.type === "tool_updated");
  const toolCompleted = events.find((event) => event.type === "tool_completed");
  assert.notEqual(tools[0].toolCallId, tools[1].toolCallId);
  assert.equal(toolUpdate.toolCallId, tools[0].toolCallId);
  assert.equal(toolCompleted.toolCallId, tools[1].toolCallId);
  assert.ok(tools.every((event) => event.toolCallId.length <= MAX_NORMALIZED_ID_CHARS));
  const statusRequests = requests.filter((event) => event.request.method === "setStatus");
  const widgetRequests = requests.filter((event) => event.request.method === "setWidget");
  assert.notEqual(statusRequests[0].request.statusKey, statusRequests[1].request.statusKey);
  assert.notEqual(widgetRequests[0].request.widgetKey, widgetRequests[1].request.widgetKey);
});

test("PiRpcBackend cancels pending extension UI with original IDs during prompt cancellation", async () => {
  const originalId = `request-${"x".repeat(2_000)}`;
  const abort = new AbortController();
  const { backend, events, emit, extensionUiResponses, abortCalls } = makePiBackend({
    state: { thinkingLevel: "off", isStreaming: false, isCompacting: false },
    onPrompt(_message, _emit, _state, signal) {
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  });
  const pending = backend.prompt("Wait for extension input", abort.signal);
  emit({ type: "extension_ui_request", method: "input", id: originalId, title: "Input" });
  const request = events[0].request;
  assert.notEqual(request.id, originalId);
  abort.abort(new Error("Parent prompt cancelled"));
  await assert.rejects(pending, /Parent prompt cancelled/);
  assert.deepEqual(extensionUiResponses, [
    { type: "extension_ui_response", id: originalId, cancelled: true },
  ]);
  assert.equal(abortCalls(), 1);
});

test("controller rejects cancellation when Pi prompt acceptance never responds", async () => {
  const state = { thinkingLevel: "off", isStreaming: false, isCompacting: false };
  let rpcOptions;
  let promptCalls = 0;
  let notifyPromptStarted;
  const promptStarted = new Promise((resolve) => { notifyPromptStarted = resolve; });
  const rpc = {
    async start() {},
    async stop() {},
    getStderr() { return ""; },
    async prompt() {
      promptCalls++;
      if (promptCalls > 1) return;
      notifyPromptStarted();
      await new Promise(() => {});
    },
    async steer() {},
    async followUp() {},
    async abort() {},
    async getState() { return state; },
    async getMessages() { return { messages: [] }; },
    async getSessionStats() { return {}; },
    async getAvailableModels() { return { models: [] }; },
    async setModel() { throw new Error("Unsupported"); },
    async cycleModel() { return null; },
    async setThinkingLevel() {},
    async cycleThinkingLevel() { return null; },
    respondToExtensionUI() {},
  };
  const backendFactory = (options) => new PiRpcBackend(options, (optionsForRpc) => {
    rpcOptions = optionsForRpc;
    return rpc;
  });
  const controller = new SubagentSessionController({ ui: {} }, {
    args: [],
    cwd: "/tmp",
    mode: "fresh",
    initialPrompt: "",
    scopedModels: [],
  }, backendFactory);
  const abort = new AbortController();
  const pending = controller.promptAndWait("Wait forever", abort.signal);
  await promptStarted;
  abort.abort(new Error("Parent prompt cancelled"));
  await assert.rejects(pending, /Parent prompt cancelled/);
  assert.equal(controller.state.busy, false);
  assert.equal(await controller.submit("Retry from panel"), true);
  assert.equal(promptCalls, 2);
  await controller.stop();
});

test("PiRpcBackend bounds retained full completions and clears them on stop", async () => {
  const { backend, events, emit } = makePiBackend({ state: { thinkingLevel: "off", isStreaming: false, isCompacting: false } });
  for (let index = 0; index <= MAX_RETAINED_RUN_COMPLETIONS; index++) {
    emit({ type: "agent_start" });
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `full completion ${index}` }],
        stopReason: "stop",
      },
    });
    emit({ type: "agent_settled" });
  }
  const runs = events.filter((event) => event.type === "run_started").map((event) => event.run);
  assert.equal(runs.length, MAX_RETAINED_RUN_COMPLETIONS + 1);
  assert.equal(await backend.getRunCompletion(runs[0]), undefined);
  assert.equal((await backend.getRunCompletion(runs.at(-1))).text, `full completion ${MAX_RETAINED_RUN_COMPLETIONS}`);
  await backend.stop();
  assert.equal(await backend.getRunCompletion(runs.at(-1)), undefined);
});

test("PiRpcBackend caps retained full completion bytes with a session notice", async () => {
  const response = "x".repeat(MAX_RETAINED_RUN_COMPLETION_BYTES + 10_000);
  const { backend, events, emit } = makePiBackend({ state: { thinkingLevel: "off", isStreaming: false, isCompacting: false } });
  emit({ type: "agent_start" });
  const run = events[0].run;
  emit({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: response }], stopReason: "stop" },
  });
  const completion = await backend.getRunCompletion(run);
  assert.equal(completion?.truncated, true);
  assert.ok(Buffer.byteLength(completion?.text ?? "", "utf8") <= MAX_RETAINED_RUN_COMPLETION_BYTES);
  assert.ok(completion?.text.endsWith(RUN_COMPLETION_TRUNCATION_NOTICE));
  await backend.stop();
});

test("PiRpcBackend returns a full final response through the controller completion lookup", async () => {
  const fullResponse = "full-response-".repeat(10_000);
  const state = { thinkingLevel: "off", isStreaming: false, isCompacting: false };
  let rpcOptions;
  const rpc = {
    async start() {},
    async stop() {},
    getStderr() { return ""; },
    async prompt() {
      state.isStreaming = true;
      rpcOptions.onOutput({ type: "agent_start" });
      rpcOptions.onOutput({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: fullResponse }],
          stopReason: "stop",
        },
      });
      state.isStreaming = false;
      rpcOptions.onOutput({ type: "agent_settled" });
    },
    async steer() {},
    async followUp() {},
    async abort() {},
    async getState() { return state; },
    async getMessages() { return { messages: [] }; },
    async getSessionStats() { return {}; },
    async getAvailableModels() { return { models: [] }; },
    async setModel() { throw new Error("Unsupported"); },
    async cycleModel() { return null; },
    async setThinkingLevel() {},
    async cycleThinkingLevel() { return null; },
    respondToExtensionUI() {},
  };
  const backendFactory = (options) => new PiRpcBackend(options, (optionsForRpc) => {
    rpcOptions = optionsForRpc;
    return rpc;
  });
  const controller = new SubagentSessionController({ ui: {} }, {
    args: [],
    cwd: "/tmp",
    mode: "fresh",
    initialPrompt: "",
    scopedModels: [],
  }, backendFactory);

  const completion = await controller.promptAndWait("Return a complete response");
  assert.equal(completion.text, fullResponse);
  assert.equal(controller.latestSettledAssistantText, fullResponse);
  assert.equal(controller.returnText(), fullResponse);
  const panelItem = controller.state.items.find((item) => item.kind === "assistant");
  assert.equal(panelItem?.kind, "assistant");
  assert.ok(panelItem.text.length <= MAX_NORMALIZED_MESSAGE_TEXT_CHARS);
  assert.ok(panelItem.text.length < fullResponse.length);
  assert.equal(controller.state.lastCompletedAssistantText, fullResponse);
  await controller.stop();
});
