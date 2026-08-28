import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const subagentsModule = await import("../../extensions/subagents/index.ts");
const { PersistentSubagentRegistry } = await import("../../extensions/subagents/registry.ts");

const CAPABILITIES = {
  extensionUi: false,
  steering: true,
  queuedFollowUp: true,
  modelControls: false,
  thinkingControls: false,
  sessionHistory: false,
  sessionFile: false,
  usage: false,
  toolOutput: false,
};

function fakeLifetimeBackendFactory(log, responseFor) {
  return (options) => {
    const runtime = options.cursor ? "cursor-cloud" : "pi";
    let runNumber = 0;
    const completions = new Map();
    return {
      runtime,
      displayName: runtime === "pi" ? "Fake Pi" : "Fake Cursor",
      capabilities: CAPABILITIES,
      async start() {},
      async stop() { log.push(`${runtime}:stop`); },
      getDiagnostics() { return ""; },
      async prompt(prompt) {
        const run = { id: `run-${runtime}-${++runNumber}`, runtime };
        const response = responseFor(prompt);
        const text = typeof response === "string" ? response : response.text;
        const stopReason = typeof response === "string" ? "stop" : response.stopReason;
        if (options.cursor) {
          const stored = options.cursor.readStored?.() ?? options.cursor.stored;
          options.cursor.persist({
            ...stored,
            remoteCreated: true,
            currentRunId: run.id,
            remoteLifecycle: "idle",
            pendingOperations: [],
            pendingResult: { state: "available", runId: run.id },
          });
          completions.set(run.id, {
            text,
            responseProduced: Boolean(text.trim()),
            stopReason,
          });
          log.push(`${runtime}:pending`);
        }
        options.onEvent({ type: "run_started", run });
        options.onEvent({
          type: "message_completed",
          run,
          message: { role: "assistant", text, thinking: "", stopReason },
        });
        log.push(`${runtime}:result`);
        options.onEvent({ type: "run_settled", run });
        return { run };
      },
      async steer() {},
      async followUp(prompt) { return await this.prompt(prompt); },
      async abort() {},
      async getState() {
        const stored = options.cursor?.readStored?.() ?? options.cursor?.stored;
        const pending = stored?.pendingResult?.state === "available"
          ? { id: stored.pendingResult.runId, runtime: "cursor-cloud", parentOwned: true }
          : undefined;
        return {
          connection: { id: `${runtime}-fake`, runtime },
          ...(pending ? { pendingResult: pending } : {}),
          thinkingLevel: "off",
          isStreaming: false,
          isCompacting: false,
        };
      },
      async getRunCompletion(run) { return completions.get(run.id); },
      async markRunCompletionDelivered(run) {
        if (!options.cursor) return;
        const stored = options.cursor.readStored?.() ?? options.cursor.stored;
        if (stored.pendingResult?.runId !== run.id) return;
        log.push(`${runtime}:acknowledge`);
        options.cursor.persist({ ...stored, pendingResult: { state: "none" } });
      },
      async getHistory() { return []; },
      async getSessionStats() { return {}; },
      async getAvailableModels() { return []; },
      async setModel() { throw new Error("Unsupported"); },
      async cycleModel() { return null; },
      async setThinkingLevel() {},
      async cycleThinkingLevel() { return null; },
      respondToExtensionUI() {},
    };
  };
}

async function createTool(t, runtime, log, responseFor, stopOutcome = "stopped") {
  const root = await mkdtemp(join(tmpdir(), `pi-subagent-lifetime-${runtime}-`));
  const lifecycleStops = [];
  const stopOutcomes = Array.isArray(stopOutcome) ? [...stopOutcome] : [stopOutcome];
  const finalStopOutcome = stopOutcomes.at(-1) ?? "stopped";
  t.after(() => rm(root, { recursive: true, force: true }));
  const tools = new Map();
  const events = new Map();
  const pi = {
    getThinkingLevel() { return "off"; },
    appendEntry() {},
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand() {},
    registerShortcut() {},
    on(name, listener) { events.set(name, listener); },
  };
  subagentsModule.default(pi, {
    personaDirectory: join(root, "missing-personas"),
    backendFactory: fakeLifetimeBackendFactory(log, responseFor),
    cursorLifecycle: {
      async reconcile(stored) { return { remoteLifecycle: stored.remoteLifecycle, currentRunId: stored.currentRunId }; },
      async stop(stored) {
        lifecycleStops.push(structuredClone(stored));
        log.push(`${runtime}:archive`);
        return { state: stopOutcomes.shift() ?? finalStopOutcome };
      },
    },
  });
  const context = {
    cwd: root,
    mode: "tui",
    hasUI: true,
    model: undefined,
    scopedModels: [],
    sessionManager: {
      getSessionId: () => `lifetime-${runtime}`,
      getSessionFile: () => join(root, "parent.jsonl"),
      getBranch: () => [],
    },
    ui: {},
  };
  events.get("session_start")({}, context);
  return { tool: tools.get("subagent"), context, events, lifecycleStops };
}

function toolResultMessage(result) {
  return { role: "toolResult", toolName: "subagent", details: result.details };
}

async function messageEnd(events, result, context) {
  const handler = events.get("message_end");
  if (handler) await handler({ message: toolResultMessage(result) }, context);
}

async function endToolResult(events, result, context) {
  await events.get("turn_end")({
    message: { role: "assistant", content: [] },
    toolResults: [toolResultMessage(result)],
  }, context);
}

test("shared lifetime contract keeps Pi and Cursor results, promotions, and follow-ups aligned", async (t) => {
  for (const runtime of ["pi", "cursor-cloud"]) {
    const log = [];
    const { tool, context, events } = await createTool(t, runtime, log, (prompt) =>
      prompt.includes("BLOCK")
        ? "BLOCKED: Missing test evidence\nNEEDS: Targeted test output"
        : prompt.includes("LONG")
          ? "result\n".repeat(8_000)
          : `Complete ${prompt}`,
    );

    const oneShot = await tool.execute(`${runtime}-one-shot`, {
      action: "create",
      runtime,
      name: `${runtime}-one-shot`,
      purpose: "Return one complete result",
      lifetime: "one-shot",
      prompt: "one result",
    }, undefined, undefined, context);
    assert.match(oneShot.content[0].text, /^Completed one-shot /, runtime);
    if (runtime === "cursor-cloud") {
      assert.equal(oneShot.details.subagent.status, "idle", runtime);
      assert.match(oneShot.content[0].text, /cleanup starts after this result is recorded/i);
      assert.equal(oneShot.details.cursorDeliveryReceipt.runId, "run-cursor-cloud-1");
      assert.equal(log.includes("cursor-cloud:acknowledge"), false, "execute returns before Cursor acknowledgement");
      assert.equal(events.has("message_end"), false, "receipt handling does not run in the pre-persistence message_end event");
      await messageEnd(events, oneShot, context);
      assert.equal(log.includes("cursor-cloud:acknowledge"), false, "the durable result survives message_end before persistence");
      const beforeTurnEnd = await tool.execute(`${runtime}-one-shot-before-turn-end`, {
        action: "status", id: oneShot.details.subagent.id,
      }, undefined, undefined, context);
      assert.equal(beforeTurnEnd.details.runtime.remote.pendingResult, "available", "the result remains durable through message_end");
    }
    await endToolResult(events, oneShot, context);
    if (runtime === "cursor-cloud") {
      assert.ok(log.indexOf(`${runtime}:acknowledge`) < log.indexOf(`${runtime}:archive`), "Cursor archives only after turn_end acknowledgement");
      const archives = log.filter((entry) => entry === "cursor-cloud:archive").length;
      await endToolResult(events, oneShot, context);
      assert.equal(log.filter((entry) => entry === "cursor-cloud:archive").length, archives, "a repeated turn_end does not repeat cleanup");
    }
    assert.ok(log.indexOf(`${runtime}:result`) < log.indexOf(`${runtime}:stop`), `${runtime} stops only after the full result exists`);

    const task = await tool.execute(`${runtime}-task`, {
      action: "create",
      runtime,
      name: `${runtime}-task`,
      purpose: "Validate continuity",
      lifetime: "task",
      prompt: "first task result",
    }, undefined, undefined, context);
    assert.equal(task.details.subagent.status, "idle", runtime);
    await endToolResult(events, task, context);
    const followUp = await tool.execute(`${runtime}-follow-up`, {
      action: "prompt",
      id: task.details.subagent.id,
      prompt: "second task result",
    }, undefined, undefined, context);
    assert.match(followUp.content[0].text, /Complete second task result/, runtime);
    assert.equal(followUp.details.subagent.status, "idle", runtime);
    await endToolResult(events, followUp, context);

    const persistent = await tool.execute(`${runtime}-persistent`, {
      action: "create",
      runtime,
      name: `${runtime}-persistent`,
      purpose: "Keep related work",
      lifetime: "persistent",
      prompt: "first persistent result",
    }, undefined, undefined, context);
    await endToolResult(events, persistent, context);
    const persistentFollowUp = await tool.execute(`${runtime}-persistent-follow-up`, {
      action: "prompt",
      id: persistent.details.subagent.id,
      prompt: "second persistent result",
    }, undefined, undefined, context);
    assert.equal(persistentFollowUp.details.subagent.status, "idle", runtime);
    assert.match(persistentFollowUp.content[0].text, /Complete second persistent result/, runtime);
    await endToolResult(events, persistentFollowUp, context);

    const blocked = await tool.execute(`${runtime}-blocked`, {
      action: "create",
      runtime,
      name: `${runtime}-blocked`,
      purpose: "Request missing evidence",
      lifetime: "one-shot",
      prompt: "BLOCK",
    }, undefined, undefined, context);
    assert.equal(blocked.details.subagent.lifetime, "task", runtime);
    assert.equal(blocked.details.subagent.status, "blocked", runtime);
    await endToolResult(events, blocked, context);

    const truncated = await tool.execute(`${runtime}-truncated`, {
      action: "create",
      runtime,
      name: `${runtime}-truncated`,
      purpose: "Keep a truncated answer",
      lifetime: "one-shot",
      prompt: "LONG",
    }, undefined, undefined, context);
    assert.equal(truncated.details.subagent.lifetime, "task", runtime);
    assert.match(truncated.content[0].text, /^Retained .* as a task because its response was truncated\./, runtime);
    await endToolResult(events, truncated, context);
  }
});

test("one-shot Cursor output reserves complete cleanup text at byte and line boundaries", async (t) => {
  const log = [];
  const { tool, context, events } = await createTool(t, "cursor-cloud", log, (prompt) => responses.get(prompt));
  const { MAX_SUBAGENT_RESPONSE_BYTES, MAX_SUBAGENT_RESPONSE_LINES } = subagentsModule;
  const byteName = "cursor-byte-boundary";
  const bytePrefix = `Completed one-shot ${byteName}. Cursor cleanup starts after this result is recorded.\n\n`;
  const byteExact = "x".repeat(MAX_SUBAGENT_RESPONSE_BYTES - Buffer.byteLength(bytePrefix, "utf8"));
  const lineName = "cursor-line-boundary";
  const lineExact = Array.from({ length: MAX_SUBAGENT_RESPONSE_LINES - 2 }, () => "line").join("\n");
  const responses = new Map([
    ["byte-exact", byteExact],
    ["byte-near", `${byteExact}x`],
    ["line-exact", lineExact],
    ["line-near", `${lineExact}\nline`],
  ]);
  const execute = async (name, prompt) => await tool.execute(`cursor-boundary-${prompt}`, {
    action: "create", runtime: "cursor-cloud", name, purpose: `Validate ${prompt} cleanup bounds`, lifetime: "one-shot", prompt,
  }, undefined, undefined, context);
  const exactByte = await execute(byteName, "byte-exact");
  assert.equal(exactByte.details.subagent.lifetime, "one-shot");
  assert.equal(Buffer.byteLength(exactByte.content[0].text, "utf8"), MAX_SUBAGENT_RESPONSE_BYTES);
  await endToolResult(events, exactByte, context);
  const archivesAfterByteExact = log.filter((entry) => entry === "cursor-cloud:archive").length;

  const nearByte = await execute("cursor-byte-near-boundary", "byte-near");
  assert.equal(nearByte.details.subagent.lifetime, "task", "adding cleanup text past the byte limit retains the result");
  assert.ok(Buffer.byteLength(nearByte.content[0].text, "utf8") <= MAX_SUBAGENT_RESPONSE_BYTES);
  await endToolResult(events, nearByte, context);
  assert.equal(log.filter((entry) => entry === "cursor-cloud:archive").length, archivesAfterByteExact, "a retained byte-boundary result does not archive");

  const exactLine = await execute(lineName, "line-exact");
  assert.equal(exactLine.details.subagent.lifetime, "one-shot");
  assert.equal(exactLine.content[0].text.split("\n").length, MAX_SUBAGENT_RESPONSE_LINES);
  await endToolResult(events, exactLine, context);
  const archivesAfterLineExact = log.filter((entry) => entry === "cursor-cloud:archive").length;

  const nearLine = await execute("cursor-line-near-boundary", "line-near");
  assert.equal(nearLine.details.subagent.lifetime, "task", "adding cleanup text past the line limit retains the result");
  assert.ok(nearLine.content[0].text.split("\n").length <= MAX_SUBAGENT_RESPONSE_LINES);
  await endToolResult(events, nearLine, context);
  assert.equal(log.filter((entry) => entry === "cursor-cloud:archive").length, archivesAfterLineExact, "a retained line-boundary result does not archive");
});

test("model pre-ack lifetime failure retains the durable Cursor result", async (t) => {
  const log = [];
  const originalSetLifetime = PersistentSubagentRegistry.prototype.setLifetime;
  PersistentSubagentRegistry.prototype.setLifetime = async function () {
    throw new Error("retention decision failed before acknowledgement");
  };
  t.after(() => { PersistentSubagentRegistry.prototype.setLifetime = originalSetLifetime; });
  const { tool, context } = await createTool(t, "cursor-cloud", log, () => "result\n".repeat(8_000));
  const result = await tool.execute("cursor-pre-ack-failure", {
    action: "create",
    runtime: "cursor-cloud",
    name: "cursor-pre-ack-failure",
    purpose: "Retain the pending result if delivery preparation fails",
    lifetime: "one-shot",
    prompt: "LONG",
  }, undefined, undefined, context);
  assert.equal(result.details.ok, false);
  assert.ok(log.includes("cursor-cloud:pending"));
  assert.equal(log.includes("cursor-cloud:acknowledge"), false);
  assert.equal(log.includes("cursor-cloud:archive"), false);
  assert.equal(log.includes("cursor-cloud:stop"), false);
});

test("terminal Cursor errors receive post-persistence receipts for one-shot and task reuse", async (t) => {
  const log = [];
  const { tool, context, events } = await createTool(t, "cursor-cloud", log, (prompt) =>
    prompt.includes("fail")
      ? { text: "", stopReason: "error" }
      : `Recovered ${prompt}`,
  );
  const oneShot = await tool.execute("cursor-terminal-one-shot", {
    action: "create", runtime: "cursor-cloud", name: "cursor-terminal-one-shot",
    purpose: "Deliver a terminal error after persistence", lifetime: "one-shot", prompt: "fail one-shot",
  }, undefined, undefined, context);
  assert.equal(oneShot.details.ok, false);
  assert.equal(oneShot.details.cursorDeliveryReceipt.runId, "run-cursor-cloud-1");
  assert.doesNotMatch(oneShot.content[0].text, /Stopped /);
  assert.equal(log.includes("cursor-cloud:acknowledge"), false);
  await endToolResult(events, oneShot, context);
  assert.equal(log.includes("cursor-cloud:acknowledge"), true);
  assert.equal(log.includes("cursor-cloud:archive"), true, "one-shot archival starts only after terminal-error delivery");
  const archivesAfterOneShot = log.filter((entry) => entry === "cursor-cloud:archive").length;

  const task = await tool.execute("cursor-terminal-task", {
    action: "create", runtime: "cursor-cloud", name: "cursor-terminal-task",
    purpose: "Reuse after a terminal error", lifetime: "task", prompt: "fail task",
  }, undefined, undefined, context);
  assert.equal(task.details.ok, false);
  assert.equal(task.details.cursorDeliveryReceipt.runId, "run-cursor-cloud-1");
  await endToolResult(events, task, context);
  assert.equal(log.filter((entry) => entry === "cursor-cloud:archive").length, archivesAfterOneShot, "task terminal errors remain reusable");
  const followUp = await tool.execute("cursor-terminal-task-follow-up", {
    action: "prompt", id: task.details.subagent.id, prompt: "recover task",
  }, undefined, undefined, context);
  assert.equal(followUp.details.ok, true);
  assert.match(followUp.content[0].text, /Recovered recover task/);
  await endToolResult(events, followUp, context);
});

test("Pi retries one-shot cleanup when finalization stop rejects", async (t) => {
  const log = [];
  const originalStop = PersistentSubagentRegistry.prototype.stop;
  let stopCalls = 0;
  PersistentSubagentRegistry.prototype.stop = async function (target) {
    stopCalls++;
    if (stopCalls === 1) throw new Error("first Pi cleanup attempt failed");
    return await originalStop.call(this, target);
  };
  t.after(() => { PersistentSubagentRegistry.prototype.stop = originalStop; });
  const { tool, context } = await createTool(t, "pi", log, () => "Complete Pi result");
  const result = await tool.execute("pi-one-shot-stop-retry", {
    action: "create", runtime: "pi", name: "pi-one-shot-stop-retry",
    purpose: "Retry one-shot cleanup after a local stop failure", lifetime: "one-shot", prompt: "return one result",
  }, undefined, undefined, context);
  assert.equal(result.details.ok, false);
  assert.equal(stopCalls, 2, "the failure path retries Pi one-shot cleanup");
  assert.equal(log.filter((entry) => entry === "pi:stop").length, 1);
});

test("one-shot cleanup failure does not claim that a Cursor agent stopped", async (t) => {
  const log = [];
  const { tool, context, events, lifecycleStops } = await createTool(
    t,
    "cursor-cloud",
    log,
    () => "Complete response before archive retry",
    ["archive-pending", "stopped"],
  );
  const result = await tool.execute("cursor-one-shot-archive-pending", {
    action: "create",
    runtime: "cursor-cloud",
    name: "cursor-one-shot-archive-pending",
    purpose: "Report archive recovery accurately",
    lifetime: "one-shot",
    prompt: "Complete then archive",
  }, undefined, undefined, context);
  assert.equal(result.details.ok, true);
  assert.equal(result.details.subagent.status, "idle");
  await endToolResult(events, result, context);
  assert.equal(log.includes("cursor-cloud:acknowledge"), true);
  assert.match(result.content[0].text, /cleanup starts after this result is recorded/i);
  assert.doesNotMatch(result.content[0].text, /^Stopped /);
  assert.equal(log.includes("cursor-cloud:archive"), true);
  const status = await tool.execute("cursor-one-shot-archive-status", {
    action: "status", id: result.details.subagent.id,
  }, undefined, undefined, context);
  assert.ok(["archive-pending", "remote-state-unknown"].includes(status.details.subagent.status));
  assert.notEqual(status.details.subagent.status, "stopped", "a failed archive is never reported as stopped");
  const retried = await tool.execute("cursor-one-shot-archive-retry", {
    action: "stop", id: result.details.subagent.id,
  }, undefined, undefined, context);
  assert.equal(retried.details.subagent.status, "stopped");
  assert.equal(lifecycleStops.length, 2);
  assert.equal(lifecycleStops[0].pendingOperations[0].kind, "cancel-run");
  assert.equal(lifecycleStops[1].pendingOperations[0].kind, "archive", "the retry archives without a second cancellation");
});
