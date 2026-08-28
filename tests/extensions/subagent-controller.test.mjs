import test from "node:test";
import assert from "node:assert/strict";

const {
  CURSOR_CONTROL_AVAILABILITY_RETRY_MS,
  MAX_SUBAGENT_TRANSCRIPT_ITEM_CHARS,
  MAX_SUBAGENT_TRANSCRIPT_TOTAL_CHARS,
  SubagentSessionController,
  promptFingerprint,
} = await import("../../extensions/subagents/controller.ts");
const {
  AUTHORITATIVE_COMPLETION_TRUNCATION_NOTICE,
  MAX_AUTHORITATIVE_COMPLETION_BYTES,
  MAX_SUBAGENT_RUN_DURATION_MS,
  normalizeSubagentRunDurationMs,
} = await import("../../extensions/subagents/backend.ts");
const { SubagentPanel, renderSubagentPanelDetails, renderSubagentPanelOptions } = await import("../../extensions/subagents/ui.ts");

const FULL_CAPABILITIES = {
  extensionUi: true,
  steering: true,
  queuedFollowUp: true,
  settledFollowUp: false,
  modelControls: true,
  thinkingControls: true,
  sessionHistory: true,
  sessionFile: true,
  usage: true,
  toolOutput: true,
};

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for the fake backend");
}

function makeControllerHarness({
  runtime = "pi",
  displayName = runtime === "cursor-cloud" ? "Cursor Cloud" : "Pi",
  capabilities = {},
  history = [],
  models = [],
  promptRuns = [],
  promptAttributions = [],
  scopedModels = [],
  startOnPrompt = true,
  followUpStartsRun = false,
  settleSynchronouslyOnPrompt = false,
  pendingResult,
  controlAvailability,
  panelDetails,
  supportsObservationDisposal = runtime === "cursor-cloud",
  promptAcceptance,
  getRunCompletion,
  select = async () => undefined,
} = {}) {
  const calls = {
    prompt: [],
    steer: [],
    followUp: [],
    history: 0,
    stats: 0,
    models: 0,
    setModel: 0,
    setThinking: 0,
    cycleModel: 0,
    cycleThinking: 0,
    extensionResponses: 0,
  };
  let stateReads = 0;
  const connection = { id: "fake-connection", runtime };
  const selectedCapabilities = { ...FULL_CAPABILITIES, ...capabilities };
  let callbacks;
  let streaming = false;
  let promptIndex = 0;
  let currentRun;
  const nextRun = () => promptRuns[promptIndex++] ?? { id: `fake-run-${promptIndex}`, runtime };
  const emit = (event) => callbacks.onEvent(event);
  const startRun = (run = nextRun()) => {
    currentRun = run;
    streaming = true;
    emit({ type: "run_started", run });
    return run;
  };
  const backendFactory = (options) => {
    callbacks = options;
    return {
      runtime,
      displayName,
      capabilities: selectedCapabilities,
      async start() {},
      async stop() { streaming = false; },
      ...(supportsObservationDisposal ? { async disposeObservation() {} } : {}),
      getDiagnostics() { return ""; },
      async prompt(text, signal) {
        calls.prompt.push(text);
        const run = nextRun();
        if (promptAcceptance) return await promptAcceptance(text, signal, run, startRun);
        if (startOnPrompt) startRun(run);
        if (settleSynchronouslyOnPrompt) {
          emit({
            type: "message_completed",
            run,
            message: { role: "assistant", text: `Synchronous result for ${text}`, thinking: "", stopReason: "stop" },
          });
          streaming = false;
          emit({ type: "run_settled", run });
        }
        return { run };
      },
      async steer(text) { calls.steer.push(text); },
      async followUp(text) {
        calls.followUp.push(text);
        return { run: followUpStartsRun ? startRun(nextRun()) : currentRun };
      },
      async abort() { streaming = false; },
      ...(getRunCompletion ? { getRunCompletion } : {}),
      async getState() {
        stateReads++;
        const details = typeof panelDetails === "function" ? panelDetails() : panelDetails;
        return {
          connection,
          ...(streaming && currentRun ? { run: currentRun } : {}),
          ...(pendingResult ? { pendingResult: { id: "retained-result", runtime, parentOwned: true } } : {}),
          ...(controlAvailability ? { controlAvailability } : {}),
          ...(details ? { details } : {}),
          thinkingLevel: "low",
          isStreaming: streaming,
          isCompacting: false,
        };
      },
      async getHistory() { calls.history++; return history; },
      async getSessionStats() { calls.stats++; return {}; },
      async getAvailableModels() { calls.models++; return models; },
      async setModel(provider, id) {
        calls.setModel++;
        return models.find((model) => model.provider === provider && model.id === id) ?? { provider, id };
      },
      async cycleModel() { calls.cycleModel++; return null; },
      async setThinkingLevel() { calls.setThinking++; },
      async cycleThinkingLevel() { calls.cycleThinking++; return null; },
      respondToExtensionUI() { calls.extensionResponses++; },
    };
  };
  const controller = new SubagentSessionController({ ui: { select } }, {
    args: [],
    cwd: "/tmp",
    mode: "fresh",
    initialPrompt: "",
    scopedModels,
    promptAttributions,
  }, backendFactory);
  return {
    controller,
    calls,
    stateReads: () => stateReads,
    emit,
    startRun,
    currentRun: () => currentRun,
    settle(run) {
      streaming = false;
      emit({ type: "run_settled", run });
    },
    complete(run, text, stopReason = "stop") {
      emit({
        type: "message_completed",
        run,
        message: { role: "assistant", text, thinking: "", stopReason },
      });
      streaming = false;
      emit({ type: "run_settled", run });
    },
  };
}

test("controller uses normalized fake-backend events for a parent prompt and follow-up", async () => {
  const harness = makeControllerHarness();
  const result = harness.controller.promptAndWait("Inspect the boundary");
  await waitFor(() => harness.calls.prompt.length === 1);
  assert.equal(await harness.controller.submit("Focus on normalized events"), true);
  assert.equal(await harness.controller.submit("Then summarize", "followUp"), true);
  assert.deepEqual(harness.calls.prompt, ["Inspect the boundary"]);
  assert.deepEqual(harness.calls.steer, ["Focus on normalized events"]);
  assert.deepEqual(harness.calls.followUp, ["Then summarize"]);

  harness.complete(harness.currentRun(), "The backend seam is preserved.");
  const completion = await result;
  assert.equal(completion.text, "The backend seam is preserved.");
  assert.deepEqual(completion.usage, {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }, "Pi retains complete zero-valued tool usage when no usage event arrives");
  assert.equal(harness.controller.state.usage.turns, 0, "Pi does not invent a missing-usage turn");
  assert.equal(harness.controller.latestSettledAssistantText, "The backend seam is preserved.");
  await harness.controller.stop();
});

test("controller rejects a parent cancellation during prompt acceptance and clears the command", async () => {
  let attempts = 0;
  const harness = makeControllerHarness({
    promptAcceptance(_text, signal) {
      attempts++;
      if (attempts > 1) return Promise.resolve({ handledWithoutRun: true });
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  });
  const abort = new AbortController();
  const pending = harness.controller.promptAndWait("Wait for acceptance", abort.signal);
  await waitFor(() => harness.calls.prompt.length === 1);
  abort.abort(new Error("Parent prompt cancelled"));
  await assert.rejects(pending, /Parent prompt cancelled/);
  assert.equal(harness.controller.state.busy, false);
  assert.equal(await harness.controller.submit("Retry from panel"), true);
  assert.equal(harness.calls.prompt.length, 2);
  await harness.controller.stop();
});

test("controller keeps a canceled active run busy until it settles", async () => {
  const runA = { id: "run-a", runtime: "pi" };
  const runB = { id: "run-b", runtime: "pi" };
  const harness = makeControllerHarness({
    promptRuns: [runA, runB],
    promptAcceptance(_text, signal, run, startRun) {
      startRun(run);
      if (run.id !== runA.id) return { run };
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  });
  const abort = new AbortController();
  const canceled = harness.controller.promptAndWait("Start then cancel", abort.signal);
  await waitFor(() => harness.controller.state.run?.id === runA.id);
  assert.equal(harness.controller.state.busy, true);

  abort.abort(new Error("Parent prompt cancelled"));
  await assert.rejects(canceled, /Parent prompt cancelled/);
  assert.equal(harness.controller.state.busy, true);
  assert.equal(harness.controller.state.run?.id, runA.id);
  assert.equal(harness.controller.state.phase, "Aborting…");
  assert.equal(await harness.controller.submit("Second ordinary prompt", "prompt"), false);
  assert.equal(harness.controller.state.phase, "Aborting…");
  assert.deepEqual(harness.calls.prompt, ["Start then cancel"]);

  harness.settle(runA);
  await waitFor(() => !harness.controller.state.busy && harness.controller.state.run === undefined);
  const next = harness.controller.promptAndWait("Complete after settlement");
  await waitFor(() => harness.calls.prompt.length === 2);
  harness.complete(runB, "Completed after settlement");
  assert.equal((await next).text, "Completed after settlement");
  await harness.controller.stop();
});

test("Cursor parent cancellation keeps a non-aborted authoritative result pending without a receipt", async () => {
  const run = { id: "cursor-cancel-race", runtime: "cursor-cloud" };
  let callbacks;
  let pending = false;
  let completion;
  let acknowledgements = 0;
  const controller = new SubagentSessionController({ ui: {} }, {
    args: [], cwd: "/tmp", mode: "fresh", initialPrompt: "", scopedModels: [],
  }, (options) => {
    callbacks = options;
    return {
      runtime: "cursor-cloud",
      displayName: "Cursor cancellation race",
      capabilities: {
        extensionUi: false, steering: false, queuedFollowUp: false, modelControls: false,
        thinkingControls: false, sessionHistory: false, sessionFile: false, usage: false, toolOutput: false,
      },
      async start() {}, async stop() {}, getDiagnostics() { return ""; },
      async prompt() { pending = true; return { run }; }, async steer() {}, async followUp() { return { run }; }, async abort() {},
      async getState() {
        return {
          connection: { id: "cursor-cancel-race", runtime: "cursor-cloud" },
          ...(pending ? { pendingResult: { ...run, parentOwned: true } } : {}),
          thinkingLevel: "off", isStreaming: false, isCompacting: false,
        };
      },
      async getRunCompletion() { return completion; },
      async markRunCompletionDelivered() { acknowledgements++; pending = false; },
      async getHistory() { return []; }, async getSessionStats() { return {}; }, async getAvailableModels() { return []; },
      async setModel() { throw new Error("Unsupported"); }, async cycleModel() { return null; },
      async setThinkingLevel() {}, async cycleThinkingLevel() { return null; }, respondToExtensionUI() {},
    };
  });
  const abort = new AbortController();
  const request = controller.promptAndWait("Cancel before completion", abort.signal);
  await waitFor(() => pending);
  abort.abort(new Error("Parent cancellation won"));
  await assert.rejects(request, /Parent cancellation won/);

  completion = { text: "Completed after cancellation", responseProduced: true, stopReason: "stop" };
  callbacks.onEvent({ type: "message_completed", run, message: { role: "assistant", text: completion.text, thinking: "", stopReason: "stop" } });
  callbacks.onEvent({ type: "run_settled", run });
  await waitFor(() => !controller.state.busy);
  await controller.synchronizeCursorState();
  assert.equal(controller.cursorDeliveryForOutcome(), undefined, "a non-aborted completion was not exposed to the cancelled parent outcome");
  assert.equal(acknowledgements, 0, "only an authoritative aborted completion can be discarded after cancellation");
  await controller.stop();
});

test("controller does not reactivate a synchronously settled prompt run", async () => {
  const harness = makeControllerHarness({ settleSynchronouslyOnPrompt: true });
  const first = await harness.controller.promptAndWait("First request");
  assert.equal(first.text, "Synchronous result for First request");
  assert.equal(harness.controller.state.run, undefined);
  assert.equal(harness.controller.state.busy, false);

  const second = await harness.controller.promptAndWait("Second request");
  assert.equal(second.text, "Synchronous result for Second request");
  assert.equal(harness.controller.state.run, undefined);
  assert.equal(harness.controller.state.busy, false);
  assert.deepEqual(harness.calls.prompt, ["First request", "Second request"]);
  await harness.controller.stop();
});

test("controller waits for an accepted delayed run and ignores a stale settlement", async () => {
  const runA = { id: "run-a", runtime: "pi" };
  const runB = { id: "run-b", runtime: "pi" };
  const harness = makeControllerHarness({ startOnPrompt: false, promptRuns: [runA, runB] });
  const first = harness.controller.promptAndWait("First request");
  await waitFor(() => harness.calls.prompt.length === 1);
  harness.startRun(runA);
  harness.complete(runA, "First response");
  assert.equal((await first).text, "First response");

  let settled = false;
  const second = harness.controller.promptAndWait("Second request").then((value) => {
    settled = true;
    return value;
  });
  await waitFor(() => harness.calls.prompt.length === 2);
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(settled, false);

  harness.startRun(runB);
  harness.emit({ type: "run_settled", run: runA });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(settled, false);

  harness.complete(runB, "Second response");
  assert.equal((await second).text, "Second response");
  await harness.controller.stop();
});

test("controller keeps a newer run active while an older completion lookup resolves", async () => {
  const runA = { id: "run-a", runtime: "pi" };
  const runB = { id: "run-b", runtime: "pi" };
  let resolveCompletion;
  const completion = new Promise((resolve) => { resolveCompletion = resolve; });
  const harness = makeControllerHarness({
    promptRuns: [runA, runB],
    getRunCompletion(run) { return run.id === runA.id ? completion : Promise.resolve(undefined); },
  });
  const first = harness.controller.promptAndWait("First request");
  await waitFor(() => harness.calls.prompt.length === 1);
  harness.complete(runA, "Bounded first response");
  harness.startRun(runB);
  resolveCompletion({ text: "Full first response", responseProduced: true, stopReason: "stop" });

  assert.equal((await first).text, "Full first response");
  assert.equal(harness.controller.state.run?.id, runB.id);
  assert.equal(harness.controller.state.busy, true);
  await harness.controller.stop();
});

test("controller ignores a stale message after a newer run starts", async () => {
  const runA = { id: "run-a", runtime: "pi" };
  const runB = { id: "run-b", runtime: "pi" };
  const harness = makeControllerHarness({ promptRuns: [runA, runB] });
  const first = harness.controller.promptAndWait("First request");
  await waitFor(() => harness.calls.prompt.length === 1);
  harness.complete(runA, "First response");
  assert.equal((await first).text, "First response");

  const second = harness.controller.promptAndWait("Second request");
  await waitFor(() => harness.calls.prompt.length === 2);
  const itemCount = harness.controller.state.items.length;
  harness.emit({
    type: "message_completed",
    run: runA,
    message: { role: "assistant", text: "Stale response", thinking: "", stopReason: "stop" },
  });
  assert.equal(harness.controller.state.items.length, itemCount);
  assert.equal(harness.controller.latestSettledAssistantText, "First response");

  harness.complete(runB, "Second response");
  assert.equal((await second).text, "Second response");
  await harness.controller.stop();
});

test("controller caps authoritative completion text from any backend", async () => {
  const fullResponse = "response-".repeat(Math.ceil(MAX_AUTHORITATIVE_COMPLETION_BYTES / 4));
  const harness = makeControllerHarness({
    getRunCompletion() {
      return Promise.resolve({ text: fullResponse, responseProduced: true, stopReason: "stop" });
    },
  });
  const pending = harness.controller.promptAndWait("Return a large response");
  await waitFor(() => harness.calls.prompt.length === 1);
  harness.complete(harness.currentRun(), "Bounded event response");
  const completion = await pending;
  assert.equal(completion.truncated, true);
  assert.ok(Buffer.byteLength(completion.text, "utf8") <= MAX_AUTHORITATIVE_COMPLETION_BYTES);
  assert.ok(completion.text.endsWith(AUTHORITATIVE_COMPLETION_TRUNCATION_NOTICE));
  assert.equal(harness.controller.latestSettledAssistantText, completion.text);
  await harness.controller.stop();
});

test("controller skips unsupported history, usage, model, and thinking operations", async () => {
  const harness = makeControllerHarness({
    capabilities: {
      sessionHistory: false,
      usage: false,
      modelControls: false,
      thinkingControls: false,
    },
  });
  await harness.controller.start();
  await harness.controller.selectModel();
  await harness.controller.cycleModel();
  await harness.controller.cycleThinking();
  assert.deepEqual(harness.calls, {
    prompt: [],
    steer: [],
    followUp: [],
    history: 0,
    stats: 0,
    models: 0,
    setModel: 0,
    setThinking: 0,
    cycleModel: 0,
    cycleThinking: 0,
    extensionResponses: 0,
  });
  await harness.controller.stop();
});

test("controller does not set scoped thinking when the backend cannot change thinking", async () => {
  const model = { provider: "test", id: "model" };
  const harness = makeControllerHarness({
    capabilities: { sessionHistory: false, usage: false, thinkingControls: false },
    models: [model],
    scopedModels: [{ provider: "test", id: "model", thinkingLevel: "high" }],
    select: async () => "test/model",
  });
  await harness.controller.start();
  await harness.controller.selectModel();
  assert.equal(harness.calls.models, 1);
  assert.equal(harness.calls.setModel, 1);
  assert.equal(harness.calls.setThinking, 0);
  await harness.controller.stop();
});

test("controller fingerprints full history and returns full completed text while bounding the panel", async () => {
  const longPrompt = "prompt-".repeat(20_000);
  const longResponse = "response-".repeat(20_000);
  const harness = makeControllerHarness({
    history: [{ role: "user", text: longPrompt }],
    promptAttributions: [{ source: "parent", fingerprint: promptFingerprint(longPrompt) }],
  });
  await harness.controller.start();
  const historyItem = harness.controller.state.items[0];
  assert.equal(historyItem?.kind, "user");
  assert.equal(historyItem?.source, "parent");
  assert.ok(historyItem.text.length < longPrompt.length);

  const result = harness.controller.promptAndWait("Return a long response");
  await waitFor(() => harness.calls.prompt.length === 1);
  harness.complete(harness.currentRun(), longResponse);
  const completion = await result;
  assert.equal(completion.text, longResponse);
  assert.equal(harness.controller.latestSettledAssistantText, longResponse);
  const assistant = harness.controller.state.items.at(-1);
  assert.equal(assistant?.kind, "assistant");
  assert.ok(assistant.text.length < longResponse.length);
  await harness.controller.stop();
});

test("capability guards prevent unsupported active controls and extension UI calls", async () => {
  const harness = makeControllerHarness({
    capabilities: {
      extensionUi: false,
      steering: false,
      queuedFollowUp: false,
      modelControls: false,
      thinkingControls: false,
    },
  });
  await harness.controller.start();
  const run = harness.startRun();
  assert.equal(await harness.controller.submit("Do not steer"), false);
  assert.equal(await harness.controller.submit("Do not queue", "followUp"), false);
  harness.emit({ type: "extension_ui_request", run, request: { method: "confirm", id: "unsupported", title: "No", message: "No" } });
  assert.deepEqual({
    steer: harness.calls.steer,
    followUp: harness.calls.followUp,
    extensionResponses: harness.calls.extensionResponses,
  }, { steer: [], followUp: [], extensionResponses: 0 });
  await harness.controller.stop();
});

test("controller does not invoke model or thinking controls while a Cursor run is busy", async () => {
  const harness = makeControllerHarness({
    runtime: "cursor-cloud",
    capabilities: { steering: false, queuedFollowUp: false, settledFollowUp: true },
  });
  await harness.controller.start();
  harness.startRun();
  await harness.controller.selectModel();
  await harness.controller.cycleModel();
  await harness.controller.cycleThinking();
  assert.deepEqual({
    models: harness.calls.models,
    setModel: harness.calls.setModel,
    setThinking: harness.calls.setThinking,
    cycleModel: harness.calls.cycleModel,
    cycleThinking: harness.calls.cycleThinking,
  }, { models: 0, setModel: 0, setThinking: 0, cycleModel: 0, cycleThinking: 0 });
  await harness.controller.stop();
});

test("Cursor uses a normal follow-up after its observed run settles", async () => {
  const runA = { id: "cursor-settled-a", runtime: "cursor-cloud" };
  const harness = makeControllerHarness({
    runtime: "cursor-cloud",
    promptRuns: [runA],
    capabilities: { steering: false, queuedFollowUp: false, settledFollowUp: true },
  });
  await harness.controller.start();
  assert.equal(await harness.controller.submit("Initial Cursor request"), true);
  harness.complete(runA, "Initial Cursor result");
  await waitFor(() => harness.controller.state.canFollowUp);
  assert.equal(await harness.controller.submit("Continue after settlement"), true);
  assert.deepEqual(harness.calls.prompt, ["Initial Cursor request"]);
  assert.deepEqual(harness.calls.followUp, ["Continue after settlement"]);
  await harness.controller.stop();
});

test("Pi and Cursor controllers show runtime-specific starting phases", () => {
  const pi = makeControllerHarness({ runtime: "pi", displayName: "Pi" });
  const cursor = makeControllerHarness({ runtime: "cursor-cloud", displayName: "Cursor Cloud" });
  assert.equal(pi.controller.state.phase, "Starting Pi subagent…");
  assert.equal(cursor.controller.state.phase, "Starting Cursor Cloud subagent…");
});

test("Cursor delivery acknowledgement clears only a matching retained result and permits reuse", async () => {
  const retainedRun = { id: "retained-read-only-run", runtime: "cursor-cloud", parentOwned: true };
  let pendingResult = retainedRun;
  let failDelivery = false;
  let disposed = 0;
  let aborts = 0;
  const prompts = [];
  const marks = [];
  const controller = new SubagentSessionController({ ui: {} }, {
    args: [], cwd: "/tmp", mode: "fresh", initialPrompt: "", scopedModels: [],
  }, (options) => ({
    runtime: "cursor-cloud",
    displayName: "Cursor Cloud",
    capabilities: { ...FULL_CAPABILITIES, steering: false, queuedFollowUp: false, settledFollowUp: true },
    async start() {}, async stop() {}, async disposeObservation() { disposed++; },
    getDiagnostics() { return ""; },
    async prompt(text) { prompts.push(text); return { run: { id: "reused-read-only-run", runtime: "cursor-cloud" } }; },
    async steer() {}, async followUp() { return { run: retainedRun }; }, async abort() { aborts++; },
    async markRunCompletionDelivered(run) {
      marks.push(run.id);
      if (failDelivery) throw new Error("delivery persistence failed");
      if (run.id === retainedRun.id) pendingResult = undefined;
    },
    async getState() {
      return {
        connection: { id: "read-only-agent", runtime: "cursor-cloud" },
        ...(pendingResult ? { pendingResult } : {}),
        controlAvailability: { model: true, thinking: true },
        thinkingLevel: "low", isStreaming: false, isCompacting: false,
      };
    },
    async getHistory() { return []; }, async getSessionStats() { return {}; }, async getAvailableModels() { return []; },
    async setModel() { return { provider: "test", id: "model" }; }, async cycleModel() { return null; },
    async setThinkingLevel() {}, async cycleThinkingLevel() { return null; }, respondToExtensionUI() {},
  }));
  await controller.start();
  assert.equal(controller.state.readOnly, true);
  assert.deepEqual(controller.state.controls, { model: false, thinking: false });

  await controller.markCursorRunCompletionDelivered({ id: "stale-delivery", runtime: "cursor-cloud", parentOwned: true });
  assert.equal(controller.state.readOnly, true, "a stale delivery does not unlock the retained result");
  failDelivery = true;
  await assert.rejects(controller.markCursorRunCompletionDelivered(retainedRun), /delivery persistence failed/);
  assert.equal(controller.state.readOnly, true, "a failed delivery does not unlock the retained result");

  failDelivery = false;
  pendingResult = undefined;
  await controller.synchronizeCursorState();
  assert.equal(controller.state.readOnly, false, "an authoritative state without a retained result unlocks the controller");
  pendingResult = retainedRun;
  await controller.synchronizeCursorState();
  assert.equal(controller.state.readOnly, true);
  await controller.markCursorRunCompletionDelivered(retainedRun);
  assert.equal(controller.state.readOnly, false);
  assert.deepEqual(controller.state.controls, { model: true, thinking: true });
  assert.deepEqual(marks, ["stale-delivery", retainedRun.id, retainedRun.id]);

  await controller.disposeObservation();
  assert.equal(disposed, 1);
  await controller.start();
  assert.equal(controller.state.readOnly, false);
  assert.deepEqual(controller.state.controls, { model: true, thinking: true });
  assert.equal(await controller.submit("Reuse after delivery", "prompt"), true);
  assert.deepEqual(prompts, ["Reuse after delivery"]);
  assert.equal(aborts, 0);
  await controller.stop();
});

test("controller clears a Cursor duration when a settled follow-up starts", async () => {
  const runA = { id: "cursor-duration-a", runtime: "cursor-cloud" };
  const runB = { id: "cursor-duration-b", runtime: "cursor-cloud" };
  const harness = makeControllerHarness({
    runtime: "cursor-cloud",
    promptRuns: [runA, runB],
    followUpStartsRun: true,
    capabilities: { steering: false, queuedFollowUp: false, settledFollowUp: true },
    getRunCompletion(run) {
      return Promise.resolve({
        text: `Result for ${run.id}`,
        responseProduced: true,
        stopReason: "stop",
        ...(run.id === runA.id ? { durationMs: 4_321 } : {}),
      });
    },
  });
  await harness.controller.start();
  assert.equal(await harness.controller.submit("Initial Cursor request"), true);
  harness.complete(runA, "Initial Cursor result");
  await waitFor(() => !harness.controller.state.busy);
  assert.equal(harness.controller.state.durationMs, 4_321);

  assert.equal(await harness.controller.submit("Continue after settlement"), true);
  await waitFor(() => harness.controller.state.run?.id === runB.id);
  assert.equal(harness.controller.state.durationMs, undefined);
  await harness.controller.stop();
});

test("Cursor omits an unreported Cloud duration instead of using observer time", async () => {
  const run = { id: "cursor-no-duration", runtime: "cursor-cloud" };
  const harness = makeControllerHarness({
    runtime: "cursor-cloud",
    promptRuns: [run],
    capabilities: { steering: false, queuedFollowUp: false, settledFollowUp: true },
  });
  await harness.controller.start();
  assert.equal(await harness.controller.submit("Inspect duration"), true);
  harness.complete(run, "No Cloud duration");
  await waitFor(() => !harness.controller.state.busy);
  assert.equal(harness.controller.state.durationMs, undefined);
  const details = renderSubagentPanelDetails(harness.controller.state, 80, {
    fg(_color, text) { return text; }, bold(text) { return text; },
  }).join("\n");
  assert.doesNotMatch(details, /Duration:/);
  await harness.controller.stop();
});

test("duration normalization accepts only finite bounded values", () => {
  assert.equal(normalizeSubagentRunDurationMs(0), 0);
  assert.equal(normalizeSubagentRunDurationMs(4_321), 4_321);
  assert.equal(normalizeSubagentRunDurationMs(-1), undefined);
  assert.equal(normalizeSubagentRunDurationMs(Number.POSITIVE_INFINITY), undefined);
  assert.equal(normalizeSubagentRunDurationMs(MAX_SUBAGENT_RUN_DURATION_MS + 1), undefined);
});

test("panel keypresses do not call unavailable, busy, or read-only model controls", async () => {
  const keybindings = {
    matches(data, action) {
      return data === action;
    },
  };
  const panelFor = (controller) => new SubagentPanel(
    { requestRender() {} },
    { fg(_color, text) { return text; }, bold(text) { return text; } },
    keybindings,
    controller,
    "Controls",
    () => {},
    () => {},
  );

  const pi = makeControllerHarness();
  await pi.controller.start();
  assert.deepEqual(pi.controller.state.controls, { model: true, thinking: true });
  const piPanel = panelFor(pi.controller);
  const hint = (_action, label) => label;
  assert.match(renderSubagentPanelOptions(pi.controller.state, hint), /model.*thinking/);
  assert.doesNotMatch(renderSubagentPanelOptions(pi.controller.state, (action) => action), /app\.mode\./);
  const piRun = pi.startRun();
  piPanel.handleInput("app.model.select");
  piPanel.handleInput("app.thinking.cycle");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual({ models: pi.calls.models, cycleModel: pi.calls.cycleModel, cycleThinking: pi.calls.cycleThinking }, {
    models: 0, cycleModel: 0, cycleThinking: 0,
  });
  pi.settle(piRun);
  await pi.controller.stop();

  const unsupported = makeControllerHarness({
    capabilities: { modelControls: false, thinkingControls: false },
  });
  await unsupported.controller.start();
  const unsupportedPanel = panelFor(unsupported.controller);
  unsupportedPanel.handleInput("app.model.select");
  unsupportedPanel.handleInput("app.thinking.cycle");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual({ models: unsupported.calls.models, cycleModel: unsupported.calls.cycleModel, cycleThinking: unsupported.calls.cycleThinking }, {
    models: 0, cycleModel: 0, cycleThinking: 0,
  });
  await unsupported.controller.stop();

  const noThinking = makeControllerHarness({
    runtime: "cursor-cloud",
    capabilities: { steering: false, queuedFollowUp: false, settledFollowUp: true },
    controlAvailability: { model: true, thinking: false },
  });
  await noThinking.controller.start();
  assert.deepEqual(noThinking.controller.state.controls, { model: true, thinking: false });
  const noThinkingPanel = panelFor(noThinking.controller);
  assert.match(renderSubagentPanelOptions(noThinking.controller.state, hint), /model/);
  assert.doesNotMatch(renderSubagentPanelOptions(noThinking.controller.state, hint), /thinking/);
  noThinkingPanel.handleInput("app.thinking.cycle");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(noThinking.calls.cycleThinking, 0);
  await noThinking.controller.stop();

  for (const catalogState of ["empty catalog", "catalog error"]) {
    const unavailable = makeControllerHarness({
      runtime: "cursor-cloud",
      capabilities: { steering: false, queuedFollowUp: false, settledFollowUp: true },
      controlAvailability: { model: false, thinking: false },
    });
    await unavailable.controller.start();
    assert.deepEqual(unavailable.controller.state.controls, { model: false, thinking: false }, catalogState);
    const unavailablePanel = panelFor(unavailable.controller);
    assert.doesNotMatch(renderSubagentPanelOptions(unavailable.controller.state, hint), /model|thinking/, catalogState);
    unavailablePanel.handleInput("app.model.select");
    unavailablePanel.handleInput("app.model.cycleForward");
    unavailablePanel.handleInput("app.thinking.cycle");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual({
      models: unavailable.calls.models,
      cycleModel: unavailable.calls.cycleModel,
      cycleThinking: unavailable.calls.cycleThinking,
    }, { models: 0, cycleModel: 0, cycleThinking: 0 }, catalogState);
    await unavailable.controller.stop();
  }

  const recoveredAvailability = { model: false, thinking: false };
  const recovered = makeControllerHarness({
    runtime: "cursor-cloud",
    capabilities: { steering: false, queuedFollowUp: false, settledFollowUp: true },
    controlAvailability: recoveredAvailability,
  });
  await recovered.controller.start();
  recoveredAvailability.model = true;
  recoveredAvailability.thinking = true;
  await recovered.controller.synchronizeCursorState();
  assert.deepEqual(recovered.controller.state.controls, { model: true, thinking: true });
  const recoveredPanel = panelFor(recovered.controller);
  assert.match(renderSubagentPanelOptions(recovered.controller.state, hint), /model.*thinking/);
  recoveredPanel.handleInput("app.model.cycleForward");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(recovered.calls.cycleModel, 1);
  await recovered.controller.stop();

  const cursor = makeControllerHarness({
    runtime: "cursor-cloud",
    capabilities: { steering: false, queuedFollowUp: false, settledFollowUp: true },
    pendingResult: true,
  });
  await cursor.controller.start();
  assert.deepEqual(cursor.controller.state.controls, { model: false, thinking: false });
  const cursorPanel = panelFor(cursor.controller);
  const renderedOptions = renderSubagentPanelOptions(cursor.controller.state, hint);
  assert.doesNotMatch(renderedOptions, /model|thinking/);
  cursorPanel.handleInput("app.model.select");
  cursorPanel.handleInput("app.thinking.cycle");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual({ models: cursor.calls.models, cycleModel: cursor.calls.cycleModel, cycleThinking: cursor.calls.cycleThinking }, {
    models: 0, cycleModel: 0, cycleThinking: 0,
  });
  await cursor.controller.selectModel();
  assert.match(cursor.controller.state.phase, /read-only.*model/);
  assert.doesNotMatch(cursor.controller.state.phase, /\$\{label\}/);
  await cursor.controller.stop();
});

test("an open idle Cursor panel passively recovers unavailable controls and cancels on disposal", async (t) => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = [];
  globalThis.setTimeout = (callback, delay, ...args) => {
    const timer = { callback: () => callback(...args), delay, cancelled: false };
    timers.push(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => { timer.cancelled = true; };
  t.after(() => {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  });

  const availability = { model: false, thinking: false };
  const harness = makeControllerHarness({
    runtime: "cursor-cloud",
    capabilities: { steering: false, queuedFollowUp: false, settledFollowUp: true },
    controlAvailability: availability,
  });
  let renders = 0;
  const detach = harness.controller.attach({ ui: {} }, () => { renders++; }, () => {});
  await harness.controller.start();
  const retry = timers.find((timer) => timer.delay === CURSOR_CONTROL_AVAILABILITY_RETRY_MS);
  assert.ok(retry, "an open idle panel schedules one bounded recovery attempt");
  availability.model = true;
  availability.thinking = true;
  retry.callback();
  await new Promise((resolve) => originalSetTimeout(resolve, 0));
  assert.deepEqual(harness.controller.state.controls, { model: true, thinking: true });
  assert.ok(renders > 0, "recovery refreshes the existing panel");

  availability.model = false;
  availability.thinking = false;
  await harness.controller.synchronizeCursorState();
  const disposalRetry = timers.at(-1);
  assert.equal(disposalRetry?.delay, CURSOR_CONTROL_AVAILABILITY_RETRY_MS);
  harness.startRun({ id: "busy-control-retry", runtime: "cursor-cloud" });
  assert.equal(disposalRetry?.cancelled, true, "starting work cancels catalog recovery");
  await harness.controller.disposeObservation();
  assert.equal(disposalRetry?.cancelled, true);
  const rendersAfterDisposal = renders;
  availability.model = true;
  availability.thinking = true;
  disposalRetry?.callback();
  await new Promise((resolve) => originalSetTimeout(resolve, 0));
  assert.equal(harness.controller.state.connected, false);
  assert.equal(renders, rendersAfterDisposal, "a cancelled recovery cannot refresh after disposal");
  detach();
});

test("Cursor catalog recovery requires an attached panel instead of a registry subscriber", async (t) => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = [];
  globalThis.setTimeout = (callback, delay, ...args) => {
    const timer = { callback: () => callback(...args), delay, cancelled: false };
    timers.push(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => { timer.cancelled = true; };
  t.after(() => {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  });

  const harness = makeControllerHarness({
    runtime: "cursor-cloud",
    capabilities: { steering: false, queuedFollowUp: false, settledFollowUp: true },
    controlAvailability: { model: false, thinking: false },
  });
  let persistenceUpdates = 0;
  const unsubscribe = harness.controller.subscribe(() => { persistenceUpdates++; });
  await harness.controller.start();
  const stateReadsWithoutPanel = harness.stateReads();
  const updatesWithoutPanel = persistenceUpdates;
  assert.equal(timers.filter((timer) => timer.delay === CURSOR_CONTROL_AVAILABILITY_RETRY_MS).length, 0);

  const detach = harness.controller.attach({ ui: {} }, () => {}, () => {});
  const retries = timers.filter((timer) => timer.delay === CURSOR_CONTROL_AVAILABILITY_RETRY_MS);
  assert.equal(retries.length, 1, "one attached panel schedules one bounded retry");
  const retry = retries[0];
  assert.ok(retry && !retry.cancelled);
  detach();
  assert.equal(retry?.cancelled, true, "the last panel detach cancels the retry immediately");
  retry?.callback();
  await new Promise((resolve) => originalSetTimeout(resolve, 0));
  assert.equal(harness.stateReads(), stateReadsWithoutPanel, "a late cancelled retry cannot read the catalog");
  assert.equal(persistenceUpdates, updatesWithoutPanel, "a registry subscriber receives no late recovery update");
  assert.equal(timers.filter((timer) => timer.delay === CURSOR_CONTROL_AVAILABILITY_RETRY_MS).length, 1);
  unsubscribe();
  await harness.controller.stop();
});

test("Cursor details replace prior run metadata during a follow-up and after settlement", async () => {
  const runA = { id: "details-run-a", runtime: "cursor-cloud" };
  const runB = { id: "details-run-b", runtime: "cursor-cloud" };
  const repository = { url: "https://github.com/example/project", startingRef: "a".repeat(40) };
  let backendDetails = {
    agent: { id: "agent-details" }, run: { id: "previous-run" }, lifecycle: "idle",
    repositories: [repository], artifacts: [{ id: "previous-artifact", name: "previous" }],
    runtimeWarnings: ["Safe runtime warning"], policyWarnings: ["Previous policy warning"],
  };
  const completionFor = (run) => ({
    text: `Result for ${run.id}`,
    responseProduced: true,
    stopReason: "stop",
    durationMs: run.id === runA.id ? 1_234 : 2_345,
    artifacts: [{ id: `${run.id}-artifact`, name: `${run.id} artifact` }],
    runtimeWarnings: [`${run.id} runtime warning`],
    policyWarnings: [`${run.id} policy warning`],
  });
  const harness = makeControllerHarness({
    runtime: "cursor-cloud",
    capabilities: { steering: false, queuedFollowUp: false, settledFollowUp: true },
    panelDetails: () => backendDetails,
    getRunCompletion(run) { return Promise.resolve(completionFor(run)); },
  });
  await harness.controller.start();
  harness.startRun(runA);
  assert.deepEqual(harness.controller.state.details, {
    agent: { id: "agent-details" }, run: { id: runA.id }, lifecycle: "running",
    repositories: [repository], runtimeWarnings: ["Safe runtime warning"],
  });
  assert.equal(harness.controller.state.durationMs, undefined);

  backendDetails = {
    agent: { id: "agent-details" }, run: { id: runA.id }, lifecycle: "idle", repositories: [repository],
    artifacts: [{ id: `${runA.id}-artifact`, name: `${runA.id} artifact` }],
    runtimeWarnings: [`${runA.id} runtime warning`], policyWarnings: [`${runA.id} policy warning`],
  };
  harness.complete(runA, "Result for A");
  await waitFor(() => !harness.controller.state.busy);
  assert.equal(harness.controller.state.details?.lifecycle, "idle");
  assert.deepEqual(harness.controller.state.details?.artifacts, backendDetails.artifacts);
  assert.deepEqual(harness.controller.state.details?.policyWarnings, backendDetails.policyWarnings);

  backendDetails = {
    agent: { id: "agent-details" }, run: { id: runB.id }, lifecycle: "running", repositories: [repository],
    runtimeWarnings: [`${runA.id} runtime warning`],
  };
  harness.startRun(runB);
  assert.deepEqual(harness.controller.state.details, {
    agent: { id: "agent-details" }, run: { id: runB.id }, lifecycle: "running",
    repositories: [repository], runtimeWarnings: [`${runA.id} runtime warning`],
  });
  assert.equal(harness.controller.state.durationMs, undefined);

  backendDetails = {
    agent: { id: "agent-details" }, run: { id: runB.id }, lifecycle: "idle", repositories: [repository],
    artifacts: [{ id: `${runB.id}-artifact`, name: `${runB.id} artifact` }],
    runtimeWarnings: [`${runB.id} runtime warning`], policyWarnings: [`${runB.id} policy warning`],
  };
  harness.complete(runB, "Result for B");
  await waitFor(() => !harness.controller.state.busy);
  assert.equal(harness.controller.state.details?.lifecycle, "idle");
  assert.deepEqual(harness.controller.state.details?.artifacts, backendDetails.artifacts);
  assert.deepEqual(harness.controller.state.details?.policyWarnings, backendDetails.policyWarnings);
  assert.deepEqual(harness.controller.state.details?.runtimeWarnings, backendDetails.runtimeWarnings);
  await harness.controller.stop();
});

test("streaming trim protects an active assistant before later tool and status items", async () => {
  const harness = makeControllerHarness();
  const chunk = (prefix, length) => `${prefix}${"x".repeat(length - prefix.length)}`;
  const transcriptChars = () => harness.controller.state.items.reduce((sum, item) => sum + (
    item.kind === "assistant" ? item.text.length + item.thinking.length + (item.errorMessage?.length ?? 0)
      : item.kind === "tool" ? item.args.length + item.output.length
        : item.text.length
  ), 0);
  await harness.controller.start();
  const run = harness.startRun();
  for (let index = 1; index <= 4; index++) {
    const text = chunk(`completed-${index}:`, MAX_SUBAGENT_TRANSCRIPT_ITEM_CHARS);
    harness.emit({ type: "message_started", run, message: { role: "assistant", text: "", thinking: "" } });
    harness.emit({ type: "message_completed", run, message: { role: "assistant", text, thinking: "", stopReason: "stop" } });
  }
  const activeText = chunk("active:", 90_000);
  harness.emit({ type: "message_started", run, message: { role: "assistant", text: "", thinking: "" } });
  harness.emit({ type: "message_delta", run, textDelta: activeText });
  const active = harness.controller.state.items.at(-1);
  harness.emit({ type: "tool_started", run, toolCallId: "later-tool", name: "later", args: "a".repeat(20_000) });
  harness.emit({ type: "runtime_warning", run, warning: "w".repeat(MAX_SUBAGENT_TRANSCRIPT_ITEM_CHARS) });
  assert.equal(harness.controller.state.omittedItems, 2);
  assert.ok(harness.controller.state.items.includes(active));
  assert.ok(harness.controller.state.items.indexOf(active) > 0 && harness.controller.state.items.indexOf(active) < harness.controller.state.items.length - 1);
  harness.emit({ type: "message_delta", run, textDelta: "-later-delta" });
  assert.ok(harness.controller.state.items.includes(active));
  assert.equal(active?.kind === "assistant" ? active.text.endsWith("-later-delta") : false, true);
  assert.ok(transcriptChars() <= MAX_SUBAGENT_TRANSCRIPT_TOTAL_CHARS);
  for (const item of harness.controller.state.items) {
    if (item.kind !== "assistant") continue;
    assert.ok(item.text.length <= MAX_SUBAGENT_TRANSCRIPT_ITEM_CHARS);
    assert.ok(item.thinking.length <= MAX_SUBAGENT_TRANSCRIPT_ITEM_CHARS);
  }
  await harness.controller.stop();
});

test("streaming transcript trims multiple items while retaining the active bounded item", async () => {
  const harness = makeControllerHarness();
  const transcriptChars = () => harness.controller.state.items.reduce((sum, item) => sum + (
    item.kind === "assistant" ? item.text.length + item.thinking.length + (item.errorMessage?.length ?? 0)
      : item.kind === "tool" ? item.args.length + item.output.length
        : item.text.length
  ), 0);
  const chunk = (index) => {
    const prefix = `chunk-${index}:`;
    return `${prefix}${"x".repeat(MAX_SUBAGENT_TRANSCRIPT_ITEM_CHARS - prefix.length)}`;
  };
  await harness.controller.start();
  const run = harness.startRun();
  for (let index = 1; index <= 5; index++) {
    const text = chunk(index);
    harness.emit({ type: "message_started", run, message: { role: "assistant", text: "", thinking: "" } });
    harness.emit({ type: "message_delta", run, textDelta: text });
    harness.emit({ type: "message_completed", run, message: { role: "assistant", text, thinking: "", stopReason: "stop" } });
  }
  const currentText = chunk(6);
  harness.emit({ type: "message_started", run, message: { role: "assistant", text: "", thinking: "" } });
  harness.emit({ type: "message_delta", run, textDelta: currentText });
  const current = harness.controller.state.items.at(-1);
  assert.equal(current?.kind, "assistant");
  assert.equal(current?.streaming, true);
  assert.equal(harness.controller.state.omittedItems, 1);
  assert.equal(harness.controller.state.items.length, 5);
  assert.match(harness.controller.state.items[0]?.kind === "assistant" ? harness.controller.state.items[0].text : "", /^chunk-2:/);
  assert.equal(transcriptChars(), MAX_SUBAGENT_TRANSCRIPT_TOTAL_CHARS);

  harness.emit({ type: "message_delta", run, thinkingDelta: "t".repeat(MAX_SUBAGENT_TRANSCRIPT_ITEM_CHARS) });
  assert.equal(harness.controller.state.omittedItems, 2);
  assert.equal(harness.controller.state.items.length, 4);
  assert.ok(harness.controller.state.items.includes(current));
  assert.equal(current?.kind === "assistant" ? current.thinking.length : 0, MAX_SUBAGENT_TRANSCRIPT_ITEM_CHARS);
  assert.match(harness.controller.state.items[0]?.kind === "assistant" ? harness.controller.state.items[0].text : "", /^chunk-3:/);
  assert.equal(transcriptChars(), MAX_SUBAGENT_TRANSCRIPT_TOTAL_CHARS);
  for (const item of harness.controller.state.items) {
    if (item.kind !== "assistant") continue;
    assert.ok(item.text.length <= MAX_SUBAGENT_TRANSCRIPT_ITEM_CHARS);
    assert.ok(item.thinking.length <= MAX_SUBAGENT_TRANSCRIPT_ITEM_CHARS);
  }
  await harness.controller.stop();
});
