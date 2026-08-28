import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const subagentsModule = await import("../../extensions/subagents/index.ts");
const {
  SubagentPanel,
  renderSubagentPanelControls,
  renderSubagentPanelDetails,
  runSubagentDialog,
} = await import("../../extensions/subagents/ui.ts");
const { visibleWidth } = await import("@earendil-works/pi-tui");
const { initTheme } = await import("@earendil-works/pi-coding-agent");
const {
  SubagentSessionController,
  MAX_SUBAGENT_PANEL_DETAILS_CHARS,
  MAX_SUBAGENT_TRANSCRIPT_ITEMS,
  promptFingerprint,
} = await import("../../extensions/subagents/controller.ts");
const { SubagentRpcClient } = await import("../../extensions/subagents/rpc.ts");
const { CursorCloudBackend, createCursorSubagentLifecyclePort } = await import("../../extensions/subagents/cursor-backend.ts");
const { PiRpcBackend } = await import("../../extensions/subagents/pi-backend.ts");
const { CursorModelCatalog } = await import("../../extensions/subagents/cursor-models.ts");
const { normalizePersonaDescription } = await import("../../extensions/subagents/personas.ts");
const {
  BUNDLED_PERSONA_DIRECTORY,
  boundedSubagentResponse,
  buildSubagentProcessArgs,
  formatSubagentModelScope,
  formatPersonaForModel,
  formatSubagentContinuityPrompt,
  formatSubagentRequest,
  getSubagentPanelWidths,
  resolveSelectedSubagentSkills,
  createActiveTurnForkSnapshot,
  loadSubagentPersonas,
  loadSubagentPersonasFromDirectories,
  MAX_CONCURRENT_SUBAGENTS,
  MAX_RETAINED_SUBAGENTS,
  MAX_RETAINED_STOPPED_SUBAGENTS,
  MAX_SUBAGENT_RESPONSE_BYTES,
  MAX_SUBAGENT_RESPONSE_LINES,
  parseSubagentCommandArgs,
  parseSubagentBlockerResponse,
  parseSubagentsCommandArgs,
  PersistentSubagentRegistry,
  SUBAGENT_COMMAND_HELP_TEXT,
  SUBAGENT_EXECUTION_PROFILES,
  SUBAGENT_EXTENSION_PATHS,
  SUBAGENT_REGISTRY_TOOL_DETAILS_KEY,
} = subagentsModule;
const SUBAGENTS_HELP_TEXT = `Usage: /subagents [name-or-id]
       /subagents --stop [name-or-id]
       /subagents --enable | --disable

name-or-id: Open an active subagent.
--stop: Stop an active subagent.
--enable, --disable: Enable or disable the model subagent tool.
--help, -h: Show this help.`;

function makeControllerHarness({
  mode = "fresh",
  messages = [],
  promptAttributions = [],
  promptStartsAgent = true,
  promptError,
  panelDetails,
} = {}) {
  let streaming = false;
  let callbacks;
  let runSequence = 0;
  let run;
  const connection = { id: "fake-connection", runtime: "pi" };
  const startRun = () => {
    run = { id: `fake-run-${++runSequence}`, runtime: "pi" };
    streaming = true;
    callbacks.onEvent({ type: "run_started", run });
    return run;
  };
  const calls = { prompt: [], steer: [], followUp: [], abort: 0, stop: 0 };
  const acceptedAttributions = [];
  const messageText = (message) => typeof message.content === "string"
    ? message.content
    : Array.isArray(message.content)
      ? message.content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("")
      : "";
  const history = () => messages.flatMap((message) => {
    if (message?.role === "user") return [{ role: "user", text: messageText(message) }];
    if (message?.role !== "assistant") return [];
    const thinking = Array.isArray(message.content)
      ? message.content.filter((part) => part?.type === "thinking" && typeof part.thinking === "string").map((part) => part.thinking).join("\n")
      : "";
    return [{
      role: "assistant",
      text: messageText(message),
      thinking,
      ...(message.stopReason ? { stopReason: message.stopReason } : {}),
      ...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
    }];
  });
  const backendFactory = (options) => {
    callbacks = options;
    return {
      runtime: "pi",
      displayName: "Pi",
      capabilities: {
        extensionUi: true,
        steering: true,
        queuedFollowUp: true,
        modelControls: true,
        thinkingControls: true,
        sessionHistory: true,
        sessionFile: true,
        usage: true,
        toolOutput: true,
      },
      run,
      async start() {},
      async stop() { calls.stop++; streaming = false; },
      async getState() {
        return {
          connection,
          ...(streaming ? { run } : {}),
          ...(panelDetails ? { details: panelDetails } : {}),
          thinkingLevel: "low",
          isStreaming: streaming,
          isCompacting: false,
          sessionFile: "/tmp/fake-subagent.jsonl",
        };
      },
      async getHistory() { return history(); },
      async getSessionStats() { return {}; },
      getDiagnostics() { return ""; },
      async prompt(text) {
        calls.prompt.push(text);
        if (promptError) throw new Error(promptError);
        if (promptStartsAgent) return { run: startRun() };
        return { handledWithoutRun: true };
      },
      async steer(text) { calls.steer.push(text); },
      async followUp(text) { calls.followUp.push(text); return { run }; },
      async abort() { calls.abort++; streaming = false; },
      async getAvailableModels() { return []; },
      async setModel() { throw new Error("No fake models"); },
      async cycleModel() { return null; },
      async setThinkingLevel() {},
      async cycleThinkingLevel() { return null; },
      respondToExtensionUI() {},
    };
  };
  const context = { ui: {} };
  const controller = new SubagentSessionController(context, {
    args: [],
    cwd: "/tmp",
    mode,
    initialPrompt: "",
    scopedModels: [],
    promptAttributions,
    onPromptAccepted(attribution) { acceptedAttributions.push(attribution); },
  }, backendFactory);
  return {
    controller,
    calls,
    acceptedAttributions,
    message(text, stopReason = "stop") {
      callbacks.onEvent({
        type: "message_completed",
        run,
        message: { role: "assistant", text, thinking: "", stopReason },
      });
    },
    startFollowUp() {
      callbacks.onEvent({ type: "run_started", run });
    },
    startCompaction() {
      callbacks.onEvent({ type: "compaction_started", run, reason: "automatic" });
    },
    exit(diagnostics) {
      streaming = false;
      callbacks.onExit({ description: "Subagent process", code: 1, signal: null, diagnostics, intentional: false });
    },
    settle(text, stopReason = "stop") {
      this.message(text, stopReason);
      streaming = false;
      callbacks.onEvent({ type: "run_settled", run });
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
    if (entry.data.version !== 2 && entry.data.version !== 3) continue;
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
  const shortcuts = [];
  const events = [];
  subagentsModule.default({
    registerTool(tool) {
      tools.push(tool);
    },
    registerCommand(name) {
      commands.push(name);
    },
    registerShortcut(shortcut, options) {
      shortcuts.push({ shortcut, description: options.description });
    },
    on(name) {
      events.push(name);
    },
  });

  assert.deepEqual(tools.map(({ name }) => name), ["subagent"]);
  assert.deepEqual(tools[0].parameters.properties.action.enum, ["create", "list", "prompt", "status", "stop"]);
  assert.deepEqual(Object.keys(tools[0].parameters.properties), [
    "action", "id", "name", "purpose", "persona", "profile", "runtime", "lifetime", "mode", "skills", "prompt", "context", "kind", "offset", "limit",
  ]);
  assert.equal(tools[0].parameters.properties.purpose.description, "Task domain");
  assert.equal(tools[0].parameters.properties.purpose.maxLength, 240);
  assert.match(tools[0].parameters.properties.persona.description, /required for Pi.*optional for Cursor Cloud/i);
  assert.deepEqual(tools[0].parameters.properties.profile.enum, ["fast", "balanced", "deep"]);
  assert.match(tools[0].parameters.properties.profile.description, /fast=Luna.*balanced=Terra default.*deep=Sol escalation/i);
  assert.match(tools[0].parameters.properties.runtime.description, /Pi default.*persona-less requires explicit Cursor Cloud/i);
  assert.deepEqual(tools[0].parameters.properties.lifetime.enum, ["one-shot", "task", "persistent"]);
  assert.match(tools[0].parameters.properties.lifetime.description, /task default.*one-shot needs prompt/i);
  assert.deepEqual(tools[0].parameters.properties.mode.enum, ["fresh", "fork"]);
  assert.match(tools[0].parameters.properties.mode.description, /fresh default.*fork parent history/i);
  assert.equal(tools[0].parameters.properties.skills.items.maxLength, 64);
  assert.equal(tools[0].parameters.properties.skills.description, "Exact parent skill names");
  assert.equal(tools[0].parameters.properties.context.maxLength, 8_000);
  assert.equal(tools[0].parameters.properties.context.description, "Concise background; required for the first worker prompt");
  assert.deepEqual(tools[0].promptGuidelines, [
    "Before subagent create, list unknown options and provide context. For a worker's first prompt, always supply context; use its listed context requirements. Use worker for general Pi execution; persona-less create is Cursor Cloud only. Keep persona profile defaults; otherwise use balanced, fast for bounded lookup, deep only after cheaper failure or unsafe ambiguity.",
    "Default to task subagents. Use one-shot only when continuity cannot help; use persistent for open-ended work. Run at most 4; idle subagents do not count. Satisfy NEEDS; stop complete subagents.",
    "Give subagent objective, scope, and output; avoid adjacent work.",
    "Delegate substantive isolated work to subagents; keep only coordination and necessary integration in the parent context.",
    "Prefer fresh context. Fork only when parent history is material. Inspect only enough to partition work by shared context and specialty, then delegate. Avoid duplicate investigation. Reuse subagents for related work. Parallelize only separate contexts or specialties.",
  ]);
  assert.equal(tools[0].description, "Retain up to 20; run up to 4 subagents at once. Pi shares local authority; Cursor Cloud inspects pushed repositories with MCPs.");
  assert.match(`${tools[0].description}\n${tools[0].promptSnippet}`, /isolat/i);
  assert.ok(tools[0].promptGuidelines.every((guideline) => guideline.includes("subagent")));
  const modelFacingDefinition = JSON.stringify({
    description: tools[0].description,
    promptSnippet: tools[0].promptSnippet,
    promptGuidelines: tools[0].promptGuidelines,
    parameters: tools[0].parameters,
  });
  const modelFacingBytes = Buffer.byteLength(modelFacingDefinition, "utf8");
  assert.ok(modelFacingBytes <= 3_200, `model-facing subagent definition is ${modelFacingBytes} bytes`);
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
  assert.deepEqual(commands.filter((name) => ["subagent", "subagents"].includes(name)), [
    "subagent", "subagents",
  ]);
  assert.deepEqual(shortcuts, [{ shortcut: "ctrl+shift+a", description: "Show subagents" }]);
  assert.equal(commands.includes("child"), false);
  assert.equal(commands.includes("children"), false);
  assert.equal(commands.some((name) => name.startsWith("child:")), false);
  assert.equal(commands.includes("subagent-blockers"), false);
  assert.deepEqual(events, ["before_agent_start", "turn_end", "session_start", "session_tree", "session_shutdown"]);
  const controlHeavyField = "\u0000".repeat(1_000);
  const boundedError = await tools[0].execute("bounded-subagent-error", {
    action: "list",
    [controlHeavyField]: true,
  });
  assert.ok(Buffer.byteLength(boundedError.content[0].text, "utf8") <= 2_000);
});

test("subagent command accepts only a leading complete --fork option", () => {
  assert.deepEqual(parseSubagentCommandArgs(""), { mode: "fresh", prompt: "" });
  assert.deepEqual(parseSubagentCommandArgs("review the diff"), { mode: "fresh", prompt: "review the diff" });
  assert.deepEqual(parseSubagentCommandArgs(" --fork review the diff "), { mode: "fork", prompt: "review the diff" });
  assert.deepEqual(parseSubagentCommandArgs("--fork"), { mode: "fork", prompt: "" });
  assert.deepEqual(parseSubagentCommandArgs("--forked review"), {
    mode: "fresh",
    prompt: "",
    error: "Unknown subagent option: --forked",
  });
});

test("subagent creation commands share help and complete only before prompts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-command-help-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const personaDirectory = join(root, "personas");
  await mkdir(personaDirectory);
  await writeFile(join(personaDirectory, "help-scout.md"), `---
name: help-scout
description: Inspect a focused area
---
Inspect only the requested area.
`);

  const commands = new Map();
  let registryEntries = 0;
  subagentsModule.default({
    appendEntry() { registryEntries++; },
    getThinkingLevel() { return "off"; },
    on() {},
    registerCommand(name, command) { commands.set(name, command); },
    registerShortcut() {},
    registerTool() {},
  }, { personaDirectory });

  const baseCommand = commands.get("subagent");
  const personaCommand = commands.get("subagent:help-scout");
  assert.ok(baseCommand);
  assert.ok(personaCommand);

  let created = 0;
  let opened = 0;
  const originalCreate = PersistentSubagentRegistry.prototype.create;
  const originalOpen = PersistentSubagentRegistry.prototype.open;
  PersistentSubagentRegistry.prototype.create = function () {
    created++;
    throw new Error("Help must not create a registry entry");
  };
  PersistentSubagentRegistry.prototype.open = async function () {
    opened++;
    throw new Error("Help must not start a subagent process");
  };
  t.after(() => {
    PersistentSubagentRegistry.prototype.create = originalCreate;
    PersistentSubagentRegistry.prototype.open = originalOpen;
  });

  const notifications = [];
  const helpContext = {
    get mode() {
      throw new Error("Help must run before the TUI check");
    },
    ui: {
      notify: (...args) => notifications.push(args),
    },
  };
  await baseCommand.handler("--help", helpContext);
  await personaCommand.handler("-h", helpContext);

  assert.deepEqual(notifications, [
    [SUBAGENT_COMMAND_HELP_TEXT, "info"],
    [SUBAGENT_COMMAND_HELP_TEXT, "info"],
  ]);
  assert.equal(created, 0);
  assert.equal(opened, 0);
  assert.equal(registryEntries, 0);

  const values = async (command, prefix) => {
    const completions = await command.getArgumentCompletions(prefix);
    return completions ? completions.map((item) => item.value) : null;
  };
  for (const command of [baseCommand, personaCommand]) {
    assert.deepEqual(await values(command, ""), ["--help", "-h", "--fork"]);
    assert.deepEqual(await values(command, "--"), ["--help", "--fork"]);
    assert.deepEqual(await values(command, "-h"), ["-h"]);
    assert.deepEqual(await values(command, "--f"), ["--fork"]);
    assert.equal(await values(command, "--forked"), null);
    assert.equal(await values(command, "review this area"), null);
    assert.equal(await values(command, "--fork review this area"), null);
  }
});

test("human subagent commands remain persistent", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-human-subagent-lifetime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const personaDirectory = join(root, "personas");
  await mkdir(personaDirectory);
  await writeFile(join(personaDirectory, "human-scout.md"), `---
name: human-scout
description: Inspect one human-selected scope
---
Inspect the requested scope.
`);
  const commands = new Map();
  subagentsModule.default({
    appendEntry() {},
    getThinkingLevel() { return "off"; },
    on() {},
    registerCommand(name, command) { commands.set(name, command); },
    registerShortcut() {},
    registerTool() {},
  }, { personaDirectory });
  const observed = [];
  const originalOpen = PersistentSubagentRegistry.prototype.open;
  PersistentSubagentRegistry.prototype.open = async function (_ctx, target) {
    observed.push(this.summaryFor(target));
    return { action: "cancel" };
  };
  t.after(() => { PersistentSubagentRegistry.prototype.open = originalOpen; });
  const context = {
    cwd: root,
    mode: "tui",
    hasUI: true,
    model: undefined,
    scopedModels: [],
    isIdle: () => true,
    sessionManager: {
      getSessionId: () => "human-lifetime-parent",
      getSessionFile: () => join(root, "parent.jsonl"),
    },
    ui: { notify() {} },
  };

  await commands.get("subagent").handler("Inspect authentication", context);
  await commands.get("subagent:human-scout").handler("Inspect billing", context);
  assert.deepEqual(observed.map(({ lifetime }) => lifetime), ["persistent", "persistent"]);
});

test("subagents help is side-effect free and completion uses active targets", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagents-command-help-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const personaDirectory = join(root, "personas");
  await mkdir(personaDirectory);
  await writeFile(join(personaDirectory, "target-scout.md"), `---
name: target-scout
description: Inspect a target area
---
Inspect only the requested target area.
`);

  const commands = new Map();
  const tools = new Map();
  const persistedEntries = [];
  const toolToggles = [];
  let activeTools = ["read", "subagent"];
  const pi = {
    appendEntry(...args) { persistedEntries.push(args); },
    getActiveTools() { return [...activeTools]; },
    getThinkingLevel() { return "off"; },
    on() {},
    registerCommand(name, command) { commands.set(name, command); },
    registerShortcut() {},
    registerTool(tool) { tools.set(tool.name, tool); },
    setActiveTools(next) {
      toolToggles.push(next);
      activeTools = [...next];
    },
  };
  subagentsModule.default(pi, { personaDirectory });
  const command = commands.get("subagents");
  assert.ok(command);

  let opened = 0;
  let stopped = 0;
  const originalOpen = PersistentSubagentRegistry.prototype.open;
  const originalStop = PersistentSubagentRegistry.prototype.stop;
  PersistentSubagentRegistry.prototype.open = async function () {
    opened++;
    throw new Error("Help must not open a subagent");
  };
  PersistentSubagentRegistry.prototype.stop = async function () {
    stopped++;
    throw new Error("Help must not stop a subagent");
  };
  const notifications = [];
  try {
    const helpContext = {
      get mode() {
        throw new Error("Help must run before the TUI check");
      },
      ui: {
        notify: (...args) => notifications.push(args),
      },
    };
    await command.handler("--help", helpContext);
    await command.handler("-h", helpContext);
  } finally {
    PersistentSubagentRegistry.prototype.open = originalOpen;
    PersistentSubagentRegistry.prototype.stop = originalStop;
  }

  assert.deepEqual(notifications, [
    [SUBAGENTS_HELP_TEXT, "info"],
    [SUBAGENTS_HELP_TEXT, "info"],
  ]);
  assert.equal(opened, 0);
  assert.equal(stopped, 0);
  assert.deepEqual(toolToggles, []);
  assert.deepEqual(persistedEntries, []);

  const values = async (prefix) => {
    const completions = await command.getArgumentCompletions(prefix);
    return completions ? completions.map((item) => item.value) : null;
  };
  assert.deepEqual(await values(""), ["--help", "-h", "--stop", "--enable", "--disable"]);
  assert.deepEqual(await values("--"), ["--help", "--stop", "--enable", "--disable"]);
  assert.deepEqual(await values("-h"), ["-h"]);
  assert.deepEqual(await values("--e"), ["--enable"]);
  assert.equal(await values("--stop "), null);

  const commandContext = {
    cwd: root,
    model: undefined,
    scopedModels: [],
    sessionManager: {
      getSessionId: () => "subagents-completion-parent",
      getSessionFile: () => undefined,
    },
  };
  const subagentTool = tools.get("subagent");
  const signal = new AbortController().signal;
  const createTarget = async (name, purpose) => {
    const result = await subagentTool.execute(`create-${name}`, {
      action: "create",
      name,
      persona: "target-scout",
      purpose,
    }, signal, undefined, commandContext);
    assert.equal(result.details.ok, true);
    return result.details.subagent;
  };

  const archived = await createTarget("archived-scout", "Inspect archived records");
  await subagentTool.execute("stop-archived", {
    action: "stop",
    id: archived.id,
  }, signal, undefined, commandContext);
  const active = await Promise.all([
    createTarget("active-auth", "Inspect authentication flow"),
    createTarget("active-billing", "Inspect billing flow"),
    createTarget("active-cache", "Inspect cache flow"),
    createTarget("active-deploy", "Inspect deployment flow"),
  ]);

  const openByName = await command.getArgumentCompletions("active-auth");
  assert.deepEqual(openByName, [{
    value: "active-auth",
    label: "active-auth",
    description: "dormant: Inspect authentication flow",
  }]);
  const openById = await command.getArgumentCompletions(active[0].id);
  assert.deepEqual(openById, [{
    value: active[0].id,
    label: `active-auth (${active[0].id})`,
    description: "dormant: Inspect authentication flow",
  }]);

  const stopTargets = await command.getArgumentCompletions("--stop ");
  assert.equal(stopTargets.length, active.length);
  assert.ok(stopTargets.every((item) => item.value.startsWith("--stop active-")));
  assert.ok(stopTargets.every((item) => item.description?.startsWith("dormant: Inspect")));
  assert.deepEqual(await values("--stop active-auth"), ["--stop active-auth"]);
  assert.deepEqual(await values(`--stop ${active[0].id}`), [`--stop ${active[0].id}`]);
  assert.equal(await values("archived-scout"), null);
  assert.equal(await values("--stop archived-scout"), null);
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

test("panel handoff acknowledges Cursor results only after editor delivery and retains incomplete one-shots", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-panel-delivery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const commands = new Map();
  const events = new Map();
  const pi = {
    appendEntry() {}, getThinkingLevel() { return "off"; }, getActiveTools() { return ["subagent"]; }, setActiveTools() {},
    registerCommand(name, command) { commands.set(name, command); }, registerShortcut() {}, registerTool() {}, on(name, handler) { events.set(name, handler); },
  };
  subagentsModule.default(pi, { personaDirectory: join(root, "missing-personas") });
  const summary = {
    id: "sa-panel-delivery", name: "panel-delivery", runtime: "cursor-cloud", purpose: "Return a durable result",
    lifetime: "task", status: "idle", createdAt: 1, lastActiveAt: 1,
  };
  const originalOpen = PersistentSubagentRegistry.prototype.open;
  const originalSetLifetime = PersistentSubagentRegistry.prototype.setLifetime;
  const originalStop = PersistentSubagentRegistry.prototype.stop;
  const order = [];
  let phase = "editor-failure";
  PersistentSubagentRegistry.prototype.open = async function () {
    const truncated = phase === "incomplete";
    const limited = phase === "length";
    return {
      action: "return",
      text: truncated ? "Capped result" : limited ? "Output-limited result" : "Complete result",
      summary,
      delivery: {
        runId: "run-panel-delivery",
        archiveAfterDelivery: true,
        completion: {
          text: truncated ? "Capped result" : limited ? "Output-limited result" : "Complete result",
          responseProduced: true,
          stopReason: limited ? "length" : "stop",
          ...(truncated ? { truncated: true } : {}),
        },
        async acknowledge() { order.push("acknowledge"); return { acknowledged: true, archiveAfterDelivery: true, summary }; },
      },
    };
  };
  PersistentSubagentRegistry.prototype.setLifetime = async function () {
    order.push("lifetime");
    return summary;
  };
  PersistentSubagentRegistry.prototype.stop = async function () {
    order.push("archive");
    return { ...summary, status: "stopped" };
  };
  t.after(() => {
    PersistentSubagentRegistry.prototype.open = originalOpen;
    PersistentSubagentRegistry.prototype.setLifetime = originalSetLifetime;
    PersistentSubagentRegistry.prototype.stop = originalStop;
  });
  const notifications = [];
  const context = {
    cwd: root, mode: "tui", hasUI: true, model: undefined, scopedModels: [],
    sessionManager: { getSessionId: () => "panel-delivery", getSessionFile: () => join(root, "parent.jsonl"), getBranch: () => [] },
    ui: {
      setEditorText() {
        order.push("editor");
        if (phase === "editor-failure") throw new Error("editor handoff failed");
      },
      notify(message, level) { notifications.push({ message, level }); }, async select() { return undefined; }, async confirm() { return true; },
    },
  };
  events.get("session_start")({}, context);
  const command = commands.get("subagents");
  await command.handler(summary.id, context);
  assert.deepEqual(order, ["editor"], "a failed editor handoff leaves the result unacknowledged and unarchived");

  phase = "incomplete";
  order.length = 0;
  await command.handler(summary.id, context);
  assert.deepEqual(order, ["editor", "lifetime", "acknowledge"], "a capped one-shot is retained before acknowledgement and never archived");

  phase = "length";
  order.length = 0;
  await command.handler(summary.id, context);
  assert.deepEqual(order, ["editor", "lifetime", "acknowledge"], "a non-stop panel result is retained before acknowledgement and never archived");

  phase = "complete";
  order.length = 0;
  await command.handler(summary.id, context);
  assert.deepEqual(order, ["editor", "acknowledge", "archive"], "a complete one-shot archives only after acknowledgement");
  assert.ok(notifications.some(({ message }) => /Could not open subagent: editor handoff failed/.test(message)));
});

test("fresh subagent args load bundled extensions, disable ambient resources, and persist sessions", () => {
  const args = buildSubagentProcessArgs({
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
    "--extension", SUBAGENT_EXTENSION_PATHS[0],
    "--extension", SUBAGENT_EXTENSION_PATHS[1],
    "--session-dir", "/sessions/subagents",
    "--name", "auth-scout",
    "--model", "anthropic/claude-sonnet-4-6",
    "--thinking", "high",
  ]);
  assert.deepEqual(SUBAGENT_EXTENSION_PATHS, [
    join(BUNDLED_PERSONA_DIRECTORY, "..", "..", "codex-tools", "index.ts"),
    join(BUNDLED_PERSONA_DIRECTORY, "..", "..", "prevent-idle.ts"),
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

  const args = buildSubagentProcessArgs({
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

test("selected subagent skills use exact parent names and canonical paths", () => {
  const discovered = [
    { name: "create-pr", filePath: "/skills/create-pr/SKILL.md" },
    { name: "writing-style", filePath: "/skills/writing-style/SKILL.md" },
  ];
  assert.deepEqual(
    resolveSelectedSubagentSkills(["create-pr", "writing-style", "create-pr"], discovered),
    ["/skills/create-pr/SKILL.md", "/skills/writing-style/SKILL.md"],
  );
  assert.throws(
    () => resolveSelectedSubagentSkills(["Create-PR"], discovered),
    /Unknown subagent skill "Create-PR"; use an exact parent skill name/,
  );
  assert.throws(
    () => resolveSelectedSubagentSkills(["/tmp/untrusted/SKILL.md"], discovered),
    /Unknown subagent skill.*exact parent skill name/,
  );
  assert.throws(
    () => resolveSelectedSubagentSkills(["create-pr"], [...discovered, {
      name: "create-pr",
      filePath: "/other/create-pr/SKILL.md",
    }]),
    /Ambiguous subagent skill "create-pr"; use a unique exact parent skill name/,
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

test("subagent panel sizing never exceeds the supplied terminal width", () => {
  assert.equal(getSubagentPanelWidths(1), undefined);
  assert.equal(getSubagentPanelWidths(2), undefined);
  assert.deepEqual(getSubagentPanelWidths(40), { dialogWidth: 40, innerWidth: 38 });
  assert.deepEqual(getSubagentPanelWidths(72), { dialogWidth: 72, innerWidth: 70 });
});

test("expanded panel details render real Pi controller state without backend metadata", async () => {
  let emit;
  const rpc = {
    async start() {}, async stop() {}, getStderr() { return ""; },
    async prompt() {}, async steer() {}, async followUp() {}, async abort() {},
    async getState() { return { thinkingLevel: "low", isStreaming: false, isCompacting: false }; },
    async getMessages() { return []; }, async getSessionStats() { return {}; }, async getAvailableModels() { return []; },
    async setModel() { return { provider: "test", id: "model" }; }, async cycleModel() { return null; },
    async setThinkingLevel() {}, async cycleThinkingLevel() { return null; }, respondToExtensionUI() {},
  };
  const controller = new SubagentSessionController({ ui: {} }, {
    args: [], cwd: "/tmp", mode: "fresh", initialPrompt: "", scopedModels: [],
  }, (options) => new PiRpcBackend(options, (rpcOptions) => {
    emit = rpcOptions.onOutput;
    return rpc;
  }));
  const theme = { fg(_color, text) { return text; }, bold(text) { return text; } };
  await controller.start();
  assert.equal(controller.state.details, undefined);
  emit({ type: "agent_start" });
  const active = renderSubagentPanelDetails(controller.state, 80, theme).join("\n");
  assert.match(active, /Connection: pi\/pi-connection-/);
  assert.match(active, /Active run ID: pi-run-/);
  assert.doesNotMatch(active, /(?:Lifecycle|Usage):/);

  emit({ type: "agent_settled" });
  await waitFor(() => !controller.state.busy);
  const settled = renderSubagentPanelDetails(controller.state, 80, theme).join("\n");
  assert.match(settled, /Last run ID: pi-run-/);
  assert.doesNotMatch(settled, /(?:Lifecycle|Usage):/);
  await controller.stop();
});

test("empty Cursor panel details stay hidden", () => {
  const theme = { fg(_color, text) { return text; }, bold(text) { return text; } };
  assert.deepEqual(renderSubagentPanelDetails({
    connection: { runtime: "cursor-cloud", id: "cursor-local" },
    details: {},
    usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} },
  }, 80, theme), []);
});

test("expanded panel details omit Cursor status summaries and render delivery metadata", async () => {
  const harness = makeControllerHarness({
    panelDetails: {
      agent: { id: "bc-agent-complete" },
      run: { id: "run-complete" },
      repositories: [{ url: "https://github.com/example/complete", startingRef: "f".repeat(40) }],
      artifacts: [{
        id: "artifact-complete", name: "complete-report", path: "reports/complete.md",
        url: "https://cursor.example/artifacts/complete", sizeBytes: 42, updatedAt: "2025-01-02T03:04:05Z",
      }],
      runtimeWarnings: ["The worktree has local changes."],
      policyWarnings: ["Cloud branch policy applies."],
    },
  });
  await harness.controller.start();
  harness.controller.state.durationMs = 1_234;
  harness.controller.state.usage = {
    turns: 2, input: 1_000, output: 500, cacheRead: 0, cacheWrite: 0, totalTokens: 1_500,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.1234 },
  };
  const theme = { fg(_color, text) { return text; }, bold(text) { return text; } };
  const rendered = renderSubagentPanelDetails(harness.controller.state, 240, theme).join("\n");
  assert.doesNotMatch(rendered, /(?:Connection|Lifecycle|Usage):/);
  assert.match(rendered, /Cursor: .*https:\/\/cursor\.com\/agents\/bc-agent-complete/);
  assert.ok(rendered.includes("\u001b]8;;https://cursor.com/agents/bc-agent-complete\u001b\\"));
  assert.match(rendered, /Run ID: run-complete/);
  assert.match(rendered, /Duration: 1\.2 s/);
  assert.match(rendered, /Repository: https:\/\/github\.com\/example\/complete @ f{40}/);
  assert.match(rendered, /Artifact: complete-report \(path reports\/complete\.md, URL https:\/\/cursor\.example\/artifacts\/complete, 42 bytes, updated 2025-01-02T03:04:05Z, ID artifact-complete\)/);
  assert.match(rendered, /Runtime warning: The worktree has local changes\./);
  assert.match(rendered, /Policy warning: Cloud branch policy applies\./);
  await harness.controller.stop();
});

test("expanded panel details share a repository URL prefix", () => {
  const theme = { fg(_color, text) { return text; }, bold(text) { return text; } };
  const lines = renderSubagentPanelDetails({
    details: {
      repositories: [
        { url: "https://github.com/acme/api", startingRef: "main" },
        { url: "https://github.com/acme/web", startingRef: "release" },
        { url: "https://github.com/acme/worker" },
      ],
    },
    usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} },
  }, 240, theme);
  assert.equal(lines[1], "Repositories: https://github.com/acme/api @ main");
  assert.equal(lines[2], `${" ".repeat("Repositories".length + 2)}web @ release`);
  assert.equal(lines[3], `${" ".repeat("Repositories".length + 2)}worker`);
  assert.doesNotMatch(lines.join("\n"), /https:\/\/github\.com\/acme\/(?:web|worker)/);
});

test("expanded panel details bound Cursor metadata", async () => {
  const sha = "a".repeat(40);
  const harness = makeControllerHarness({
    panelDetails: {
      agent: { id: "agent-bounded" },
      run: { id: "run-bounded" },
      repositories: [
        { url: "https://github.com/example/project", startingRef: sha },
        ...Array.from({ length: 80 }, (_, index) => ({ url: `https://github.com/example/${index}-${"r".repeat(2_000)}`, startingRef: sha })),
      ],
      artifacts: Array.from({ length: 80 }, (_, index) => ({
        id: `artifact-${index}-${"i".repeat(2_000)}`,
        name: `report-${index}-${"n".repeat(2_000)}`,
        path: `reports/${"p".repeat(2_000)}`,
      })),
      runtimeWarnings: ["The worktree has local changes. Cursor Cloud sees only the committed HEAD state."],
      policyWarnings: ["Cursor Cloud reported branch metadata."],
    },
  });
  await harness.controller.start();
  const details = harness.controller.state.details;
  const detailChars = (value) => {
    if (typeof value === "string") return value.length;
    if (Array.isArray(value)) return value.reduce((total, item) => total + detailChars(item), 0);
    if (value && typeof value === "object") return Object.values(value).reduce((total, item) => total + detailChars(item), 0);
    return 0;
  };
  assert.ok(detailChars(details) <= MAX_SUBAGENT_PANEL_DETAILS_CHARS);
  const theme = { fg(_color, text) { return text; }, bold(text) { return text; } };
  const lines = renderSubagentPanelDetails(harness.controller.state, 80, theme);
  const rendered = lines.join("\n");
  assert.match(rendered, /Repositories: https:\/\/github\.com\/example\/project @/);
  assert.match(rendered, new RegExp(sha));
  assert.match(rendered, /Runtime warning: The worktree has local changes/);
  assert.match(rendered, /Policy warning: Cursor Cloud reported branch metadata/);
  await harness.controller.stop();
});

test("busy subagent panel controls use runtime capabilities without duplicate separators", () => {
  const hint = (action, label) => `${action}:${label}`;
  const pi = renderSubagentPanelControls(
    { busy: true },
    { steering: true, queuedFollowUp: true },
    hint,
  );
  assert.equal(pi, "tui.input.submit:steer · app.message.followUp:follow-up · app.interrupt:abort · app.exit:detach · app.message.copy:return");
  assert.doesNotMatch(pi, /· ·/);
  const cursor = renderSubagentPanelControls(
    { busy: true },
    { steering: false, queuedFollowUp: false },
    hint,
  );
  assert.equal(cursor, "app.interrupt:abort · app.exit:detach · app.message.copy:return");
  assert.doesNotMatch(cursor, /steer|follow-up|· ·/);
  const reconnecting = renderSubagentPanelControls(
    { connected: false, busy: false },
    { steering: true, queuedFollowUp: true },
    hint,
  );
  assert.equal(reconnecting, "app.interrupt:close");
});

test("SubagentPanel renders safely within widths from zero through narrow panels", () => {
  initTheme("dark");
  const theme = { fg(_color, text) { return text; }, bold(text) { return text; } };
  const controller = {
    state: {
      revision: 0, connected: true, busy: false, lifecycle: "ready", phase: "Ready", readOnly: false, canFollowUp: false,
      controls: { model: false, thinking: false }, thinking: "off", items: [], omittedItems: 0,
      usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      extensionUi: false, extensionStatuses: new Map(), extensionWidgets: new Map(),
    },
    capabilities: { steering: false, queuedFollowUp: false },
  };
  const panel = new SubagentPanel(
    { requestRender() {} }, theme, { matches() { return false; } }, controller, "Narrow", () => {}, () => {},
  );
  for (const width of [0, 1, 2, 3, 12]) {
    const lines = panel.render(width);
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `width ${width}: ${JSON.stringify(line)}`);
  }
});

test("supported Pi extension UI renders in the panel transcript", async () => {
  initTheme("dark");
  const harness = makeControllerHarness();
  await harness.controller.start();
  harness.controller.state.extensionStatuses.set("review", "ready");
  harness.controller.state.extensionWidgets.set("checks", ["type check passed"]);
  const panel = new SubagentPanel(
    { requestRender() {} }, { fg(_color, text) { return text; }, bold(text) { return text; } },
    { matches() { return false; } }, harness.controller, "Pi extension UI", () => {}, () => {},
  );
  const rendered = panel.render(80).join("\n");
  assert.match(rendered, /Subagent extension UI/);
  assert.match(rendered, /review: ready/);
  assert.match(rendered, /checks:/);
  assert.match(rendered, /type check passed/);
  await harness.controller.stop();
});

test("busy subagent panels can detach without interrupting the subagent", () => {
  let detached = 0;
  let interrupted = 0;
  const panel = new SubagentPanel(
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

test("Cursor panel opens while preflight reconnects and disables input", async () => {
  let resolvePreflight;
  const preflight = new Promise((resolve) => { resolvePreflight = resolve; });
  let starts = 0;
  let panel;
  const controller = new SubagentSessionController({ ui: {} }, {
    args: [], cwd: "/tmp", mode: "fresh", initialPrompt: "", scopedModels: [],
  }, () => ({
    runtime: "cursor-cloud", displayName: "Cursor Cloud",
    capabilities: {
      extensionUi: false, steering: false, queuedFollowUp: false, settledFollowUp: true,
      modelControls: true, thinkingControls: true, sessionHistory: false, sessionFile: false, usage: false, toolOutput: false,
    },
    async start() { starts++; }, async stop() {}, async disposeObservation() {}, getDiagnostics() { return ""; },
    async prompt() { throw new Error("must not prompt while reconnecting"); }, async steer() {}, async followUp() { throw new Error("must not follow up while reconnecting"); }, async abort() {},
    async getState() {
      return {
        connection: { id: "reconnecting-agent", runtime: "cursor-cloud" },
        thinkingLevel: "low", isStreaming: false, isCompacting: false,
      };
    },
    async getHistory() { return []; }, async getSessionStats() { return {}; }, async getAvailableModels() { return []; },
    async setModel() { return { provider: "test", id: "model" }; }, async cycleModel() { return null; },
    async setThinkingLevel() {}, async cycleThinkingLevel() { return null; }, respondToExtensionUI() {},
  }));
  const context = {
    ui: {
      custom(factory) {
        return new Promise((resolve) => {
          panel = factory(
            { requestRender() {} }, { fg(_color, text) { return text; }, bold(text) { return text; } },
            { matches(data, action) { return data === "close" && action === "app.exit"; } }, resolve,
          );
        });
      },
    },
  };

  const opening = runSubagentDialog(context, controller, "Reconnect Cursor", "", async () => await preflight);
  await waitFor(() => panel !== undefined);
  assert.equal(controller.state.connected, false);
  assert.equal(starts, 0);
  assert.match(panel.render(80).join("\n"), /Connecting to subagent/);
  panel.handleInput("ignored prompt");

  resolvePreflight();
  await waitFor(() => controller.state.connected);
  assert.equal(starts, 1);
  panel.handleInput("close");
  assert.deepEqual(await opening, { action: "cancel" });
});

test("Ctrl+D detaches an active Cursor dialog without aborting remote work", async () => {
  const run = { id: "dialog-detach-run", runtime: "cursor-cloud" };
  let disposed = 0;
  let aborts = 0;
  let cancelRuns = 0;
  const controller = new SubagentSessionController({ ui: {} }, {
    args: [], cwd: "/tmp", mode: "fresh", initialPrompt: "", scopedModels: [],
  }, (options) => ({
    runtime: "cursor-cloud",
    displayName: "Cursor Cloud",
    capabilities: {
      extensionUi: false, steering: false, queuedFollowUp: false, settledFollowUp: true,
      modelControls: true, thinkingControls: true, sessionHistory: false, sessionFile: false, usage: false, toolOutput: false,
    },
    async start() { options.onEvent({ type: "run_started", run }); }, async stop() {},
    async disposeObservation() { disposed++; }, getDiagnostics() { return ""; },
    async prompt() { return { run }; }, async steer() {}, async followUp() { return { run }; }, async abort() { aborts++; },
    async cancelRun() { cancelRuns++; },
    async getState() {
      return {
        connection: { id: "dialog-detach-agent", runtime: "cursor-cloud" }, run,
        thinkingLevel: "low", isStreaming: true, isCompacting: false,
      };
    },
    async getHistory() { return []; }, async getSessionStats() { return {}; }, async getAvailableModels() { return []; },
    async setModel() { return { provider: "test", id: "model" }; }, async cycleModel() { return null; },
    async setThinkingLevel() {}, async cycleThinkingLevel() { return null; }, respondToExtensionUI() {},
  }));
  const context = {
    ui: {
      async custom(factory) {
        let finish;
        const result = new Promise((resolve) => { finish = resolve; });
        const panel = factory(
          { requestRender() {} }, { fg(_color, text) { return text; }, bold(text) { return text; } },
          { matches(data, action) { return data === "ctrl+d" && action === "app.exit"; } }, finish,
        );
        await waitFor(() => controller.state.busy);
        panel.handleInput("ctrl+d");
        return await result;
      },
    },
  };
  assert.deepEqual(await runSubagentDialog(context, controller, "Detach Cursor"), { action: "cancel" });
  assert.equal(disposed, 1);
  assert.equal(aborts, 0);
  assert.equal(cancelRuns, 0);
  assert.equal(controller.state.connected, false);
});

test("closing one of two Cursor dialogs keeps the other observation connected", async () => {
  let disposals = 0;
  let aborts = 0;
  let cancelRuns = 0;
  let followUps = 0;
  const controller = new SubagentSessionController({ ui: {} }, {
    args: [], cwd: "/tmp", mode: "fresh", initialPrompt: "", scopedModels: [],
  }, () => ({
    runtime: "cursor-cloud", displayName: "Cursor Cloud",
    capabilities: {
      extensionUi: false, steering: false, queuedFollowUp: false, settledFollowUp: true,
      modelControls: true, thinkingControls: true, sessionHistory: false, sessionFile: false, usage: false, toolOutput: false,
    },
    async start() {}, async stop() {}, async disposeObservation() { disposals++; }, getDiagnostics() { return ""; },
    async prompt() { return { run: { id: "unused", runtime: "cursor-cloud" } }; }, async steer() {},
    async followUp() { followUps++; return { run: { id: `follow-up-${followUps}`, runtime: "cursor-cloud" } }; },
    async abort() { aborts++; }, async cancelRun() { cancelRuns++; },
    async getState() {
      return {
        connection: { id: "two-panel-agent", runtime: "cursor-cloud" },
        thinkingLevel: "low", isStreaming: false, isCompacting: false,
      };
    },
    async getHistory() { return []; }, async getSessionStats() { return {}; }, async getAvailableModels() { return []; },
    async setModel() { return { provider: "test", id: "model" }; }, async cycleModel() { return null; },
    async setThinkingLevel() {}, async cycleThinkingLevel() { return null; }, respondToExtensionUI() {},
  }));
  const dialogs = [];
  const context = {
    ui: {
      custom(factory) {
        return new Promise((resolve) => {
          const panel = factory(
            { requestRender() {} }, {},
            { matches(data, action) { return data === "ctrl+d" && action === "app.exit"; } }, resolve,
          );
          dialogs.push(panel);
        });
      },
    },
  };
  const first = runSubagentDialog(context, controller, "First Cursor panel");
  const second = runSubagentDialog(context, controller, "Second Cursor panel");
  await waitFor(() => dialogs.length === 2 && controller.state.connected);
  controller.state.canFollowUp = true;
  dialogs[0].handleInput("ctrl+d");
  assert.deepEqual(await first, { action: "cancel" });
  assert.equal(controller.state.connected, true);
  assert.equal(controller.state.readOnly, false);
  assert.equal(await controller.submit("Continue from the remaining panel", "followUp"), true);
  assert.equal(followUps, 1);
  assert.equal(disposals, 0);

  dialogs[1].handleInput("ctrl+d");
  assert.deepEqual(await second, { action: "cancel" });
  assert.equal(disposals, 1);
  assert.equal(aborts, 0);
  assert.equal(cancelRuns, 0);
  assert.equal(controller.state.connected, false);
  await controller.stop();
});

test("controller stop remains forced while a Cursor panel is attached", async () => {
  let backendStops = 0;
  let observerDisposals = 0;
  const controller = new SubagentSessionController({ ui: {} }, {
    args: [], cwd: "/tmp", mode: "fresh", initialPrompt: "", scopedModels: [],
  }, () => ({
    runtime: "cursor-cloud", displayName: "Cursor Cloud",
    capabilities: {
      extensionUi: false, steering: false, queuedFollowUp: false, settledFollowUp: true,
      modelControls: true, thinkingControls: true, sessionHistory: false, sessionFile: false, usage: false, toolOutput: false,
    },
    async start() {}, async stop() { backendStops++; observerDisposals++; }, async disposeObservation() { observerDisposals++; },
    getDiagnostics() { return ""; }, async prompt() { return { run: { id: "unused", runtime: "cursor-cloud" } }; },
    async steer() {}, async followUp() { return { run: { id: "unused", runtime: "cursor-cloud" } }; }, async abort() {},
    async getState() { return { connection: { id: "forced-stop-agent", runtime: "cursor-cloud" }, thinkingLevel: "low", isStreaming: false, isCompacting: false }; },
    async getHistory() { return []; }, async getSessionStats() { return {}; }, async getAvailableModels() { return []; },
    async setModel() { return { provider: "test", id: "model" }; }, async cycleModel() { return null; },
    async setThinkingLevel() {}, async cycleThinkingLevel() { return null; }, respondToExtensionUI() {},
  }));
  const detach = controller.attach({ ui: {} }, () => {}, () => {});
  await controller.start();
  await controller.stop();
  assert.equal(backendStops, 1);
  assert.equal(observerDisposals, 1, "backend stop disposes even while a panel is attached");
  assert.equal(controller.state.connected, false);
  detach();
});

test("a new Cursor panel start waits for an in-flight last-panel observer disposal", async () => {
  let starts = 0;
  let disposals = 0;
  let followUps = 0;
  let signalDisposal;
  let releaseDisposal;
  const disposalStarted = new Promise((resolve) => { signalDisposal = resolve; });
  const disposalGate = new Promise((resolve) => { releaseDisposal = resolve; });
  const controller = new SubagentSessionController({ ui: {} }, {
    args: [], cwd: "/tmp", mode: "fresh", initialPrompt: "", scopedModels: [],
  }, () => ({
    runtime: "cursor-cloud", displayName: "Cursor Cloud",
    capabilities: {
      extensionUi: false, steering: false, queuedFollowUp: false, settledFollowUp: true,
      modelControls: true, thinkingControls: true, sessionHistory: false, sessionFile: false, usage: false, toolOutput: false,
    },
    async start() { starts++; }, async stop() {}, async disposeObservation() {
      disposals++;
      signalDisposal();
      await disposalGate;
    },
    getDiagnostics() { return ""; }, async prompt() { return { run: { id: "unused", runtime: "cursor-cloud" } }; },
    async steer() {}, async followUp() { followUps++; return { run: { id: `restart-follow-up-${followUps}`, runtime: "cursor-cloud" } }; }, async abort() {},
    async getState() { return { connection: { id: "dispose-race-agent", runtime: "cursor-cloud" }, thinkingLevel: "low", isStreaming: false, isCompacting: false }; },
    async getHistory() { return []; }, async getSessionStats() { return {}; }, async getAvailableModels() { return []; },
    async setModel() { return { provider: "test", id: "model" }; }, async cycleModel() { return null; },
    async setThinkingLevel() {}, async cycleThinkingLevel() { return null; }, respondToExtensionUI() {},
  }));
  const firstDetach = controller.attach({ ui: {} }, () => {}, () => {});
  await controller.start();
  firstDetach();
  const disposing = controller.disposePanelObservation();
  await disposalStarted;

  const secondDetach = controller.attach({ ui: {} }, () => {}, () => {});
  let restarted = false;
  const restarting = controller.start().then(() => { restarted = true; });
  await Promise.resolve();
  assert.equal(restarted, false, "start waits until the stale observer has detached");
  releaseDisposal();
  await disposing;
  await restarting;
  assert.equal(starts, 2);
  assert.equal(controller.state.connected, true);
  controller.state.canFollowUp = true;
  assert.equal(await controller.submit("Continue after observer restart", "followUp"), true);
  assert.equal(followUps, 1);
  secondDetach();
  await controller.disposePanelObservation();
  assert.equal(disposals, 2);
  await controller.stop();
});

test("a parent prompt waits through the last-panel disposal grace window", async () => {
  let callbacks;
  let starts = 0;
  let disposals = 0;
  let prompts = 0;
  let run;
  const controller = new SubagentSessionController({ ui: {} }, {
    args: [], cwd: "/tmp", mode: "fresh", initialPrompt: "", scopedModels: [],
  }, (options) => {
    callbacks = options;
    return {
      runtime: "cursor-cloud", displayName: "Cursor Cloud",
      capabilities: {
        extensionUi: false, steering: false, queuedFollowUp: false, settledFollowUp: true,
        modelControls: true, thinkingControls: true, sessionHistory: false, sessionFile: false, usage: false, toolOutput: false,
      },
      async start() { starts++; }, async stop() {}, async disposeObservation() { disposals++; }, getDiagnostics() { return ""; },
      async prompt() {
        prompts++;
        run = { id: `grace-parent-${prompts}`, runtime: "cursor-cloud" };
        callbacks.onEvent({ type: "run_started", run });
        return { run };
      },
      async steer() {}, async followUp() { return { run }; }, async abort() {},
      async getState() { return { connection: { id: "grace-parent-agent", runtime: "cursor-cloud" }, thinkingLevel: "low", isStreaming: false, isCompacting: false }; },
      async getHistory() { return []; }, async getSessionStats() { return {}; }, async getAvailableModels() { return []; },
      async setModel() { return { provider: "test", id: "model" }; }, async cycleModel() { return null; },
      async setThinkingLevel() {}, async cycleThinkingLevel() { return null; }, respondToExtensionUI() {},
    };
  });
  const detach = controller.attach({ ui: {} }, () => {}, () => {});
  await controller.start();
  detach();
  const disposing = controller.disposePanelObservation();
  const parent = controller.promptAndWait("Continue after the panel closes");
  await disposing;
  await waitFor(() => prompts === 1);
  assert.equal(disposals, 1);
  assert.equal(starts, 2, "the parent prompt restarts after the published disposal");
  callbacks.onEvent({ type: "message_completed", run, message: { role: "assistant", text: "Continued", thinking: "", stopReason: "stop" } });
  callbacks.onEvent({ type: "run_settled", run });
  assert.equal((await parent).text, "Continued");
  await controller.stop();
});

test("stop during a panel-observation wait does not restart the backend", async () => {
  let starts = 0;
  let signalDisposal;
  let releaseDisposal;
  const disposalStarted = new Promise((resolve) => { signalDisposal = resolve; });
  const disposalGate = new Promise((resolve) => { releaseDisposal = resolve; });
  const controller = new SubagentSessionController({ ui: {} }, {
    args: [], cwd: "/tmp", mode: "fresh", initialPrompt: "", scopedModels: [],
  }, () => ({
    runtime: "cursor-cloud", displayName: "Cursor Cloud",
    capabilities: {
      extensionUi: false, steering: false, queuedFollowUp: false, settledFollowUp: true,
      modelControls: true, thinkingControls: true, sessionHistory: false, sessionFile: false, usage: false, toolOutput: false,
    },
    async start() { starts++; }, async stop() {}, async disposeObservation() {
      signalDisposal();
      await disposalGate;
    },
    getDiagnostics() { return ""; }, async prompt() { return { run: { id: "unused", runtime: "cursor-cloud" } }; },
    async steer() {}, async followUp() { return { run: { id: "unused", runtime: "cursor-cloud" } }; }, async abort() {},
    async getState() { return { connection: { id: "stop-wait-agent", runtime: "cursor-cloud" }, thinkingLevel: "low", isStreaming: false, isCompacting: false }; },
    async getHistory() { return []; }, async getSessionStats() { return {}; }, async getAvailableModels() { return []; },
    async setModel() { return { provider: "test", id: "model" }; }, async cycleModel() { return null; },
    async setThinkingLevel() {}, async cycleThinkingLevel() { return null; }, respondToExtensionUI() {},
  }));
  const detach = controller.attach({ ui: {} }, () => {}, () => {});
  await controller.start();
  detach();
  const disposing = controller.disposePanelObservation();
  await disposalStarted;
  const restarting = controller.start();
  const stopping = controller.stop();
  releaseDisposal();
  await Promise.all([disposing, restarting, stopping]);
  assert.equal(starts, 1);
  assert.equal(controller.state.connected, false);
  assert.equal(controller.state.lifecycle, "stopped");
});

test("Pi panel attachments restore the previous live extension UI target", async () => {
  let callbacks;
  const responses = [];
  const baseInputs = [];
  const olderInputs = [];
  const newerInputs = [];
  let baseSelects = 0;
  let olderSelects = 0;
  let newerSelects = 0;
  const controller = new SubagentSessionController({
    ui: {
      async select() { baseSelects++; return "base choice"; },
      setEditorText(text) { baseInputs.push(text); },
    },
  }, {
    args: [], cwd: "/tmp", mode: "fresh", initialPrompt: "", scopedModels: [],
  }, (options) => {
    callbacks = options;
    return {
      runtime: "pi", displayName: "Pi",
      capabilities: {
        extensionUi: true, steering: true, queuedFollowUp: true, settledFollowUp: false,
        modelControls: true, thinkingControls: true, sessionHistory: false, sessionFile: false, usage: false, toolOutput: false,
      },
      async start() {}, async stop() {}, getDiagnostics() { return ""; },
      async prompt() { return { handledWithoutRun: true }; }, async steer() {}, async followUp() { return { handledWithoutRun: true }; }, async abort() {},
      async getState() { return { connection: { id: "pi-panel-target", runtime: "pi" }, thinkingLevel: "low", isStreaming: false, isCompacting: false }; },
      async getHistory() { return []; }, async getSessionStats() { return {}; }, async getAvailableModels() { return []; },
      async setModel() { return { provider: "test", id: "model" }; }, async cycleModel() { return null; },
      async setThinkingLevel() {}, async cycleThinkingLevel() { return null; },
      respondToExtensionUI(response) { responses.push(response); },
    };
  });
  await controller.start();
  const olderDetach = controller.attach({
    ui: { async select() { olderSelects++; return "older choice"; } },
  }, () => {}, (text) => olderInputs.push(text));
  const newerDetach = controller.attach({
    ui: { async select() { newerSelects++; return "newer choice"; } },
  }, () => {}, (text) => newerInputs.push(text));
  newerDetach();
  callbacks.onEvent({ type: "extension_ui_request", request: { method: "set_editor_text", text: "to older" } });
  callbacks.onEvent({ type: "extension_ui_request", request: { method: "select", id: "older-select", title: "Choose", options: ["older choice"] } });
  await waitFor(() => responses.length === 1);
  assert.deepEqual(olderInputs, ["to older"]);
  assert.deepEqual(newerInputs, []);
  assert.equal(olderSelects, 1);
  assert.equal(newerSelects, 0);
  assert.deepEqual(responses[0], { id: "older-select", value: "older choice" });

  olderDetach();
  callbacks.onEvent({ type: "extension_ui_request", request: { method: "set_editor_text", text: "to base context" } });
  callbacks.onEvent({ type: "extension_ui_request", request: { method: "select", id: "base-select", title: "Choose", options: ["base choice"] } });
  await waitFor(() => responses.length === 2);
  assert.deepEqual(olderInputs, ["to older"]);
  assert.deepEqual(newerInputs, []);
  assert.deepEqual(baseInputs, ["to base context"]);
  assert.equal(baseSelects, 1);
  assert.deepEqual(responses[1], { id: "base-select", value: "base choice" });
  await controller.stop();
});

test("a no-panel Pi model prompt uses the base extension UI", async () => {
  let callbacks;
  let run;
  const responses = [];
  const editorTexts = [];
  const controller = new SubagentSessionController({
    ui: {
      async select() { return "selected"; },
      async confirm() { return true; },
      async input() { return "entered"; },
      async editor() { return "edited"; },
      setEditorText(text) { editorTexts.push(text); },
    },
  }, {
    args: [], cwd: "/tmp", mode: "fresh", initialPrompt: "", scopedModels: [],
  }, (options) => {
    callbacks = options;
    return {
      runtime: "pi", displayName: "Pi",
      capabilities: {
        extensionUi: true, steering: true, queuedFollowUp: true, settledFollowUp: false,
        modelControls: true, thinkingControls: true, sessionHistory: false, sessionFile: false, usage: false, toolOutput: false,
      },
      async start() {}, async stop() {}, getDiagnostics() { return ""; },
      async prompt() {
        run = { id: "base-ui-run", runtime: "pi" };
        callbacks.onEvent({ type: "run_started", run });
        callbacks.onEvent({ type: "extension_ui_request", request: { method: "select", id: "select", title: "Select", options: ["selected"] } });
        callbacks.onEvent({ type: "extension_ui_request", request: { method: "confirm", id: "confirm", title: "Confirm", message: "Continue?" } });
        callbacks.onEvent({ type: "extension_ui_request", request: { method: "input", id: "input", title: "Input", placeholder: "Value" } });
        callbacks.onEvent({ type: "extension_ui_request", request: { method: "editor", id: "editor", title: "Editor", prefill: "Draft" } });
        callbacks.onEvent({ type: "extension_ui_request", request: { method: "set_editor_text", text: "Base editor text" } });
        return { run };
      },
      async steer() {}, async followUp() { return { run }; }, async abort() {},
      async getState() { return { connection: { id: "base-ui-agent", runtime: "pi" }, thinkingLevel: "low", isStreaming: false, isCompacting: false }; },
      async getHistory() { return []; }, async getSessionStats() { return {}; }, async getAvailableModels() { return []; },
      async setModel() { return { provider: "test", id: "model" }; }, async cycleModel() { return null; },
      async setThinkingLevel() {}, async cycleThinkingLevel() { return null; },
      respondToExtensionUI(response) { responses.push(response); },
    };
  });
  const pending = controller.promptAndWait("Use the model extension UI");
  await waitFor(() => responses.length === 4);
  assert.deepEqual(responses, [
    { id: "select", value: "selected" },
    { id: "confirm", confirmed: true },
    { id: "input", value: "entered" },
    { id: "editor", value: "edited" },
  ]);
  assert.deepEqual(editorTexts, ["Base editor text"]);
  callbacks.onEvent({ type: "message_completed", run, message: { role: "assistant", text: "Done", thinking: "", stopReason: "stop" } });
  callbacks.onEvent({ type: "run_settled", run });
  assert.equal((await pending).text, "Done");
  await controller.stop();
});

test("subagent RPC commands reject unsuccessful protocol responses", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-rpc-protocol-"));
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
  const client = new SubagentRpcClient({
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

test("subagent RPC prompt acceptance rejects promptly on cancellation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-rpc-cancel-"));
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
    if (command.type === "prompt") {
      process.stdout.write(JSON.stringify({ type: "prompt_received" }) + "\\n");
      continue;
    }
    process.stdout.write(JSON.stringify({
      type: "response",
      id: command.id,
      command: command.type,
      success: true,
      data: command.type === "get_state" ? { thinkingLevel: "off", isStreaming: false, isCompacting: false } : undefined,
    }) + "\\n");
  }
});
`);
  const output = [];
  const client = new SubagentRpcClient({
    cwd: root,
    args: [],
    invocation: { command: process.execPath, args: [server] },
    onOutput(event) { output.push(event); },
    onExit() {},
  });
  await client.start();
  const abort = new AbortController();
  const pending = client.prompt("Wait indefinitely", abort.signal);
  await waitFor(() => output.some((event) => event.type === "prompt_received"));
  abort.abort(new Error("Parent prompt cancelled"));
  await assert.rejects(pending, /Parent prompt cancelled/);
  await client.abort();
  await client.stop();
});

test("handled subagent prompts settle without an agent run", async () => {
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

test("subagent prompt rejection preserves the RPC error", async () => {
  const harness = makeControllerHarness({ promptError: "No credentials for subagent model" });
  await assert.rejects(
    harness.controller.promptAndWait("Inspect authentication"),
    /No credentials for subagent model/,
  );
  await harness.controller.stop();
});

test("queued subagent prompts remain serialized when an intermediate request is aborted", async () => {
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

test("parent prompts return before automatic compaction and can queue a follow-up", async () => {
  const harness = makeControllerHarness();
  const pending = harness.controller.promptAndWait("Inspect authentication");
  await waitFor(() => harness.calls.prompt.length === 1);
  harness.message("Authentication summary");
  harness.startCompaction();

  const result = await pending;
  assert.equal(result.text, "Authentication summary");
  assert.equal(harness.controller.state.busy, true);

  const followUp = harness.controller.promptAndWait("Check the session refresh flow");
  await waitFor(() => harness.calls.followUp.length === 1);
  harness.settle("Session refresh summary");
  assert.equal((await followUp).text, "Session refresh summary");
  await harness.controller.stop();
});

test("parent prompts return when a response completes after automatic compaction starts", async () => {
  const harness = makeControllerHarness();
  const pending = harness.controller.promptAndWait("Inspect authentication");
  await waitFor(() => harness.calls.prompt.length === 1);
  harness.startCompaction();

  let returned = false;
  void pending.then(() => { returned = true; });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(returned, false);

  harness.message("Authentication summary");
  const result = await pending;
  assert.equal(result.text, "Authentication summary");
  assert.equal(harness.controller.state.busy, true);
  await harness.controller.stop();
});

test("subagent prompt completions preserve non-success stop reasons", async () => {
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

test("subagent panel transcript memory is bounded", async () => {
  const harness = makeControllerHarness();
  for (let index = 0; index < MAX_SUBAGENT_TRANSCRIPT_ITEMS + 25; index++) {
    harness.controller.setTransientStatus(`error ${index}`, "error");
  }
  assert.equal(harness.controller.state.items.length, MAX_SUBAGENT_TRANSCRIPT_ITEMS);
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

test("active-turn fork snapshots end at the latest parent user request", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-active-fork-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const parentSession = join(root, "parent.jsonl");
  const header = {
    type: "session",
    version: 3,
    id: "7dca2c28-8505-4549-aa8c-fd6032d575bf",
    timestamp: "2026-03-12T00:00:00.000Z",
    cwd: root,
  };
  await writeFile(parentSession, `${JSON.stringify(header)}\n`);
  const branch = [
    {
      type: "message",
      id: "user-1",
      parentId: null,
      timestamp: "2026-03-12T00:00:01.000Z",
      message: { role: "user", content: "Earlier request", timestamp: 1 },
    },
    {
      type: "message",
      id: "assistant-1",
      parentId: "user-1",
      timestamp: "2026-03-12T00:00:02.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "Earlier response" }], stopReason: "stop", timestamp: 2 },
    },
    {
      type: "message",
      id: "user-2",
      parentId: "assistant-1",
      timestamp: "2026-03-12T00:00:03.000Z",
      message: { role: "user", content: "Create the pull request", timestamp: 3 },
    },
    {
      type: "message",
      id: "assistant-current",
      parentId: "user-2",
      timestamp: "2026-03-12T00:00:04.000Z",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_subagent", name: "subagent", arguments: { action: "create" } }],
        stopReason: "toolUse",
        timestamp: 4,
      },
    },
    {
      type: "message",
      id: "tool-current",
      parentId: "assistant-current",
      timestamp: "2026-03-12T00:00:05.000Z",
      message: { role: "toolResult", toolCallId: "call_subagent", toolName: "subagent", content: [], isError: false, timestamp: 5 },
    },
  ];
  const originalBranch = structuredClone(branch);
  const sessionManager = {
    getSessionFile: () => parentSession,
    getHeader: () => header,
    getBranch: () => branch,
    getLeafId: () => "assistant-current",
  };
  const snapshot = createActiveTurnForkSnapshot(sessionManager, join(root, "snapshots"));
  assert.equal(snapshot.mode, "fork");
  assert.equal(sessionManager.getLeafId(), "assistant-current");
  assert.deepEqual(branch, originalBranch);
  const entries = (await readFile(snapshot.parentSessionFile, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(entries[0].parentSession, parentSession);
  assert.deepEqual(entries.slice(1).map(({ id }) => id), ["user-1", "assistant-1", "user-2"]);
  assert.match(JSON.stringify(entries), /Create the pull request/);
  assert.doesNotMatch(JSON.stringify(entries), /call_subagent|assistant-current|tool-current/);

  const ephemeral = createActiveTurnForkSnapshot({
    ...sessionManager,
    getSessionFile: () => undefined,
  }, join(root, "unused"));
  assert.deepEqual(ephemeral, { mode: "fresh", fallback: "parent-session-not-persisted" });
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
  assert.equal(entries[0].data.version, 3);
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
    skills: ["/parent/skills/create-pr/SKILL.md", "/parent/skills/create-pr/SKILL.md", "/parent/skills/writing-style/SKILL.md"],
    persona: {
      name: "product-manager",
      description: "Explore product decisions",
      systemPrompt: "Analyze product requirements.",
      contextRequirements: "Provide the goal, constraints, Git base, and relevant scope.",
      preferredProfile: "fast",
      extensions: ["/personas/extensions/unsafe.ts"],
      skills: ["/personas/skills/product/SKILL.md"],
      filePath: "/personas/product-manager.md",
    },
  });
  let storedSkilled = latestStoredSubagent(entries, "parent-session-id", skilled.id);
  const storedPersona = storedSkilled.persona;
  assert.deepEqual(storedSkilled.selectedSkillPaths, [
    "/parent/skills/create-pr/SKILL.md",
    "/parent/skills/writing-style/SKILL.md",
  ]);
  assert.deepEqual(storedPersona.skills, ["/personas/skills/product/SKILL.md"]);
  assert.deepEqual(storedPersona.extensions, ["/personas/extensions/unsafe.ts"]);
  assert.equal(storedPersona.contextRequirements, "Provide the goal, constraints, Git base, and relevant scope.");
  assert.equal(storedPersona.preferredProfile, "fast");
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
  assert.deepEqual(restoredSkills.resolve(skilled.id).stored.selectedSkillPaths, [
    "/parent/skills/create-pr/SKILL.md",
    "/parent/skills/writing-style/SKILL.md",
  ]);
  await restoredSkills.stop(skilled.id);
  storedSkilled = latestStoredSubagent(entries, "parent-session-id", skilled.id);
  assert.equal(storedSkilled.activeBlocker, undefined);
  const restoredPersona = storedSkilled.persona;
  assert.deepEqual(restoredPersona.skills, ["/personas/skills/product/SKILL.md"]);
  assert.deepEqual(restoredPersona.extensions, ["/personas/extensions/unsafe.ts"]);
  assert.equal(restoredPersona.contextRequirements, "Provide the goal, constraints, Git base, and relevant scope.");
  assert.equal(restoredPersona.preferredProfile, "fast");
  assert.equal(storedSkilled.lifetime, "task");
  assert.equal(storedSkilled.parentContextProvided, true);
  assert.deepEqual(storedSkilled.selectedSkillPaths, [
    "/parent/skills/create-pr/SKILL.md",
    "/parent/skills/writing-style/SKILL.md",
  ]);

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
  assert.ok(entries.every(({ data }) => data.version === 3));
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

test("model creation requires Pi personas and supports worker skills and active-turn forks", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-controlled-create-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const personaDirectory = join(root, "personas");
  const personaSkillDirectory = join(root, "persona-skills", "create-pr");
  await mkdir(personaDirectory);
  await mkdir(personaSkillDirectory, { recursive: true });
  await writeFile(join(personaSkillDirectory, "SKILL.md"), `---
name: create-pr
description: Create pull requests with persona-specific policy.
---
Preserve the persona-specific pull request policy.
`);
  await writeFile(join(personaDirectory, "implementer.md"), `---
name: implementer
description: Implement a bounded change
context-requirements: Provide the objective, scope, and constraints.
skills:
  - ../persona-skills/create-pr/SKILL.md
---
Implement the requested change.
`);
  await writeFile(join(personaDirectory, "worker.md"), `---
name: worker
description: Execute a bounded production task
preferred-profile: balanced
---
Execute the assigned work.
`);
  const parentSession = join(root, "parent.jsonl");
  const header = {
    type: "session",
    version: 3,
    id: "3e4a8b1f-863f-41b4-8849-a6d9f9e22c24",
    timestamp: "2026-03-12T00:00:00.000Z",
    cwd: root,
  };
  await writeFile(parentSession, `${JSON.stringify(header)}\n`);
  const branch = [
    {
      type: "message",
      id: "user-request",
      parentId: null,
      timestamp: "2026-03-12T00:00:01.000Z",
      message: { role: "user", content: "Create the requested pull request", timestamp: 1 },
    },
    {
      type: "message",
      id: "assistant-tool-call",
      parentId: "user-request",
      timestamp: "2026-03-12T00:00:02.000Z",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "subagent-call", name: "subagent", arguments: { action: "create" } }],
        stopReason: "toolUse",
        timestamp: 2,
      },
    },
  ];
  const entries = [];
  let parentLeaf = "assistant-tool-call";
  const tools = new Map();
  const events = new Map();
  const pi = {
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand() {},
    registerShortcut() {},
    on(name, handler) { events.set(name, handler); },
    getThinkingLevel() { return "low"; },
    appendEntry(customType, data) {
      entries.push({ type: "custom", customType, data });
      parentLeaf = `custom-${entries.length}`;
    },
  };
  let parentPersisted = true;
  const context = {
    cwd: root,
    model: undefined,
    scopedModels: [],
    sessionManager: {
      getSessionId: () => "controlled-create-parent",
      getSessionFile: () => parentPersisted ? parentSession : join(root, "ephemeral-parent.jsonl"),
      getHeader: () => header,
      getBranch: () => branch,
      getLeafId: () => parentLeaf,
    },
  };
  subagentsModule.default(pi, { personaDirectory });
  events.get("session_start")({}, context);
  events.get("before_agent_start")({
    systemPromptOptions: {
      skills: [
        { name: "create-pr", filePath: "/parent/skills/create-pr/SKILL.md", disableModelInvocation: false },
        { name: "writing-style", filePath: "/parent/skills/writing-style/SKILL.md", disableModelInvocation: false },
        { name: "command-only", filePath: "/parent/skills/command-only/SKILL.md", disableModelInvocation: true },
      ],
    },
  }, context);
  const tool = tools.get("subagent");
  const signal = new AbortController().signal;

  for (const [id, input, expected] of [
    ["persona-less-default-pi", { action: "create", purpose: "Create a pull request" }, /Persona-less Pi create is not valid.*worker/i],
    ["persona-less-explicit-pi", { action: "create", runtime: "pi", purpose: "Create a pull request" }, /Persona-less Pi create is not valid.*worker/i],
    ["command-only-skill", { action: "create", persona: "worker", purpose: "Create a pull request", skills: ["command-only"] }, /Unknown subagent skill.*exact parent skill name/],
  ]) {
    const result = await tool.execute(id, input, signal, undefined, context);
    assert.equal(result.details.ok, false, id);
    assert.equal(result.details.error.code, "INVALID_INPUT", id);
    assert.match(result.details.error.message, expected, id);
  }

  const withoutSkills = await tool.execute("worker-without-skills", {
    action: "create",
    mode: "fresh",
    name: "workflow-without-skills",
    persona: "worker",
    purpose: "Inspect the requested pull request",
  }, signal, undefined, context);
  assert.equal(withoutSkills.content[0].text, "Created workflow-without-skills.");
  assert.equal(withoutSkills.details.subagent.persona, "worker");
  assert.equal(withoutSkills.details.subagent.lifetime, "task");
  assert.equal(withoutSkills.details.subagent.model, "openai-codex/gpt-5.6-terra");
  assert.deepEqual(latestStoredSubagent(entries, "controlled-create-parent", withoutSkills.details.subagent.id).selectedSkillPaths, []);
  await tool.execute("stop-worker-without-skills", {
    action: "stop",
    id: "workflow-without-skills",
  }, signal, undefined, context);

  const fresh = await tool.execute("worker-fresh", {
    action: "create",
    mode: "fresh",
    name: "workflow-fresh",
    persona: "worker",
    purpose: "Create the requested pull request",
    lifetime: "task",
    skills: ["create-pr", "writing-style", "create-pr"],
  }, signal, undefined, context);
  assert.equal(fresh.content[0].text, "Created workflow-fresh.");
  assert.equal(fresh.details.subagent.persona, "worker");
  assert.equal(fresh.details.subagent.model, "openai-codex/gpt-5.6-terra");
  assert.deepEqual(latestStoredSubagent(entries, "controlled-create-parent", fresh.details.subagent.id).selectedSkillPaths, [
    "/parent/skills/create-pr/SKILL.md",
    "/parent/skills/writing-style/SKILL.md",
  ]);

  const additive = await tool.execute("persona-with-selected-skills", {
    action: "create",
    name: "workflow-persona",
    persona: "implementer",
    purpose: "Create and validate the pull request",
    lifetime: "task",
    skills: ["writing-style"],
  }, signal, undefined, context);
  assert.equal(additive.details.subagent.persona, "implementer");
  assert.deepEqual(latestStoredSubagent(entries, "controlled-create-parent", additive.details.subagent.id).selectedSkillPaths, [
    "/parent/skills/writing-style/SKILL.md",
  ]);

  const conflict = await tool.execute("persona-with-conflicting-skill", {
    action: "create",
    name: "workflow-persona-conflict",
    persona: "implementer",
    purpose: "Create a pull request with conflicting policy",
    lifetime: "task",
    skills: ["create-pr"],
  }, signal, undefined, context);
  assert.equal(conflict.details.ok, false);
  assert.equal(conflict.details.error.code, "INVALID_INPUT");
  assert.match(conflict.details.error.message, /selected skill.*conflicts with persona.*different path/i);

  parentLeaf = "assistant-tool-call";
  const persistedEntriesBeforeFork = entries.length;
  const fork = await tool.execute("worker-fork", {
    action: "create",
    mode: "fork",
    name: "workflow-fork",
    persona: "worker",
    purpose: "Create the requested pull request from parent context",
    lifetime: "task",
    skills: ["create-pr"],
  }, signal, undefined, context);
  const storedFork = fork.details[SUBAGENT_REGISTRY_TOOL_DETAILS_KEY].upserts[0];
  assert.equal(fork.content[0].text, "Created workflow-fork.");
  assert.ok(storedFork.parentSessionFile.startsWith(join(root, "persistent-subagents", "controlled-create-parent", "fork-snapshots")));
  assert.deepEqual(storedFork.selectedSkillPaths, ["/parent/skills/create-pr/SKILL.md"]);
  assert.equal(entries.length, persistedEntriesBeforeFork);
  assert.equal(context.sessionManager.getLeafId(), "assistant-tool-call");
  assert.doesNotMatch(await readFile(storedFork.parentSessionFile, "utf8"), /assistant-tool-call|subagent-call/);
  const restoredFork = new PersistentSubagentRegistry(pi);
  restoredFork.restore({
    ...context,
    sessionManager: {
      ...context.sessionManager,
      getBranch: () => [...branch, {
        type: "message",
        id: "fork-tool-result",
        parentId: "assistant-tool-call",
        timestamp: "2026-03-12T00:00:03.000Z",
        message: {
          role: "toolResult",
          toolCallId: "subagent-call",
          toolName: "subagent",
          content: [],
          isError: false,
          details: { [SUBAGENT_REGISTRY_TOOL_DETAILS_KEY]: fork.details[SUBAGENT_REGISTRY_TOOL_DETAILS_KEY] },
          timestamp: 3,
        },
      }],
    },
  });
  assert.deepEqual(restoredFork.resolve("workflow-fork").stored.selectedSkillPaths, [
    "/parent/skills/create-pr/SKILL.md",
  ]);

  parentPersisted = false;
  const fallback = await tool.execute("ephemeral-parent-fallback", {
    action: "create",
    mode: "fork",
    name: "workflow-fallback",
    persona: "worker",
    purpose: "Create the requested pull request with a fresh fallback",
    lifetime: "task",
    skills: ["create-pr"],
  }, signal, undefined, context);
  assert.match(fallback.content[0].text, /^Parent session was not persisted; created with fresh context\./);
  assert.deepEqual(fallback.details.fork, {
    requested: "fork",
    mode: "fresh",
    fallback: "parent-session-not-persisted",
  });
  const storedFallback = fallback.details[SUBAGENT_REGISTRY_TOOL_DETAILS_KEY].upserts[0];
  assert.equal(storedFallback.mode, "fresh");
  assert.equal(storedFallback.parentSessionFile, undefined);

  await tool.execute("stop-persona-before-fork-prompt", {
    action: "stop",
    id: "workflow-persona",
  }, signal, undefined, context);
  const originalPrompt = PersistentSubagentRegistry.prototype.prompt;
  PersistentSubagentRegistry.prototype.prompt = async function (_ctx, target) {
    return {
      summary: this.summaryFor(target),
      text: "Inherited context accepted",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      responseProduced: true,
      handledWithoutAgent: false,
      stopReason: "stop",
    };
  };
  t.after(() => { PersistentSubagentRegistry.prototype.prompt = originalPrompt; });
  parentPersisted = true;
  const personaFork = await tool.execute("persona-fork-inherits-required-context", {
    action: "create",
    mode: "fork",
    name: "workflow-persona-fork",
    persona: "implementer",
    purpose: "Create the requested pull request with inherited context",
    lifetime: "task",
    skills: ["writing-style"],
    prompt: "Create the pull request from inherited context.",
  }, signal, undefined, context);
  assert.match(personaFork.content[0].text, /^Saved as workflow-persona-fork\./);
  assert.equal(personaFork.details.subagent.persona, "implementer");
  assert.equal(personaFork.details[SUBAGENT_REGISTRY_TOOL_DETAILS_KEY].upserts[0].parentContextProvided, true);

  const status = await tool.execute("status-without-skill-metadata", {
    action: "status",
    id: "workflow-fresh",
  }, signal, undefined, context);
  const listed = await tool.execute("list-without-skill-metadata", { action: "list" }, signal, undefined, context);
  for (const result of [fresh, status, listed]) {
    assert.doesNotMatch(result.content[0].text, /SKILL\.md|writing-style|selectedSkillPaths/);
  }
  assert.equal(status.details.subagent.selectedSkillPaths, undefined);
  await events.get("session_shutdown")({}, context);
});

test("persona-based model creation remains unavailable when no personas are configured", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-no-subagent-personas-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tools = new Map();
  subagentsModule.default({
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand() {},
    registerShortcut() {},
    on() {},
  }, { personaDirectory: join(root, "missing") });

  const result = await tools.get("subagent").execute("create-without-personas", {
    action: "create",
    persona: "reviewer",
    purpose: "Attempt generic delegation",
  }, undefined, undefined, {});
  assert.equal(result.details.ok, false);
  assert.equal(result.details.tool, "subagent");
  assert.match(result.details.error.message, /No subagent personas are configured; create requires an existing persona/i);
});

test("model-created subagents default to task and honor explicit lifetimes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-lifetimes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const personaDirectory = join(root, "personas");
  await mkdir(personaDirectory);
  await writeFile(join(personaDirectory, "bounded-analyst.md"), `---
name: bounded-analyst
description: Complete bounded analysis
preferred-profile: fast
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
    registerShortcut() {},
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
  assert.match(personas.content[0].text, /bounded-analyst \[pi\]: Complete bounded analysis \[prefers fast profile\]/);
  assert.equal(personas.details.personas[0].preferredProfile, "fast");
  assert.equal(Object.hasOwn(personas.details.personas[0], "preferredLifetime"), false);
  const invalidOneShot = await tool.execute("explicit-one-shot-without-prompt", {
    action: "create",
    name: "invalid-explicit-one-shot",
    persona: "bounded-analyst",
    purpose: "Invalid dormant explicit one-shot",
    lifetime: "one-shot",
  }, signal, undefined, context);
  assert.equal(invalidOneShot.details.ok, false);
  assert.equal(invalidOneShot.details.error.code, "INVALID_INPUT");
  assert.match(invalidOneShot.details.error.message, /one-shot subagents require an initial prompt/i);

  const oneShot = await tool.execute("one-shot", {
    action: "create",
    name: "one-shot-default",
    persona: "bounded-analyst",
    purpose: "Return one bounded result",
    lifetime: "one-shot",
    prompt: "Complete this bounded request",
  }, signal, undefined, context);
  assert.equal(oneShot.details.subagent.lifetime, "one-shot");
  assert.equal(oneShot.details.subagent.model, "openai-codex/gpt-5.6-luna");
  assert.equal(oneShot.details.subagent.thinking, "high");
  assert.equal(oneShot.details.subagent.status, "stopped");
  assert.equal(oneShot.content[0].text, "Completed one-shot one-shot-default.\n\nBounded result");

  const blockedOneShot = await tool.execute("blocked-one-shot", {
    action: "create",
    name: "blocked-one-shot",
    persona: "bounded-analyst",
    purpose: "Request bounded work without enough context",
    lifetime: "one-shot",
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

  const task = await tool.execute("task-default", {
    action: "create",
    name: "task-default",
    persona: "bounded-analyst",
    purpose: "Retain a bounded analyst through validation",
    prompt: "Begin an iterative task",
  }, signal, undefined, context);
  assert.equal(task.details.subagent.lifetime, "task");
  assert.notEqual(task.details.subagent.status, "stopped");
  assert.match(task.content[0].text, /^Saved as task-default\./);

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
    lifetime: "one-shot",
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
    lifetime: "one-shot",
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
    lifetime: "one-shot",
    prompt: "EMPTY",
  }, signal, undefined, context);
  assert.equal(empty.details.subagent.lifetime, "task");
  assert.match(empty.content[0].text, /^Retained empty-one-shot as a task because the subagent produced no visible response\./);
  await tool.execute("stop-empty-one-shot", {
    action: "stop",
    id: "empty-one-shot",
  }, signal, undefined, context);

  const failedOneShot = await tool.execute("failed-one-shot", {
    action: "create",
    name: "failed-one-shot",
    persona: "bounded-analyst",
    purpose: "Fail one bounded request",
    lifetime: "one-shot",
    prompt: "FAIL",
  }, signal, undefined, context);
  assert.equal(failedOneShot.details.ok, false);
  assert.equal(failedOneShot.details.error.code, "SUBAGENT_FAILED");
  assert.match(failedOneShot.details.error.message, /Synthetic one-shot failure/);
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
    lifetime: "one-shot",
    prompt: "CANCEL",
  }, cancellation.signal, undefined, context);
  cancellation.abort(new Error("Parent canceled one-shot"));
  const canceledResult = await canceledPrompt;
  assert.equal(canceledResult.details.ok, false);
  assert.equal(canceledResult.details.error.code, "CANCELLED");
  assert.match(canceledResult.details.error.message, /Parent canceled one-shot/);
  const canceled = await tool.execute("canceled-status", {
    action: "status",
    id: "canceled-one-shot",
  }, signal, undefined, context);
  assert.equal(canceled.details.subagent.status, "stopped");
  assert.equal(canceled.details.subagent.lifetime, "one-shot");

  await events.get("session_shutdown")({}, context);
});

test("retained-subagent limit is enforced and human stop frees capacity", async (t) => {
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
    registerShortcut() {},
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
  await commands.get("subagents").handler("--enable", context);
  assert.deepEqual(activeTools, ["read", "subagent"]);
  assert.ok(notifications.some(({ message }) => message === "Model subagent tool enabled."));

  const invalidCalls = [
    ["create-unknown-persona", { action: "create", persona: "unknown", purpose: "Attempt unknown delegation" }, /Unknown subagent persona "unknown".*list personas/i],
    ["context-without-prompt", { action: "create", name: "context-only", purpose: "Context without an accompanying request", persona: "test-scout", context: "Goal: inspect the project" }, /context requires an accompanying prompt/i],
    ["context-on-list", { action: "list", context: "Not valid for list" }, /context is only valid with create or prompt/i],
    ["oversized-context", { action: "list", context: "x".repeat(8_001) }, /context exceeds 8000 characters/i],
    ["profile-on-list", { action: "list", profile: "fast" }, /profile is only valid with create/i],
    ["lifetime-on-list", { action: "list", lifetime: "task" }, /lifetime is only valid with create/i],
    ["persona-on-list", { action: "list", persona: "test-scout" }, /persona is not valid for subagent action "list"/i],
    ["offset-on-subagent-list", { action: "list", offset: 1 }, /offset and limit are only valid for persona lists/i],
    ["kind-on-create", { action: "create", kind: "personas", persona: "test-scout", purpose: "Invalid create field" }, /kind is not valid for subagent action "create"/i],
    ["purpose-on-status", { action: "status", id: "missing", purpose: "Invalid status field" }, /purpose is not valid for subagent action "status"/i],
    ["unknown-field", { action: "list", unexpected: true }, /unexpected is not valid for subagent action "list"/i],
    ["one-shot-without-prompt", { action: "create", persona: "test-scout", purpose: "Invalid dormant one-shot", lifetime: "one-shot" }, /one-shot subagents require an initial prompt/i],
  ];
  for (const [id, input, message] of invalidCalls) {
    const result = await subagentTool.execute(id, input, signal, undefined, context);
    assert.equal(result.details.ok, false, id);
    assert.equal(result.details.tool, "subagent", id);
    assert.equal(result.details.error.code, "INVALID_INPUT", id);
    assert.match(result.details.error.message, message, id);
  }

  const profileNames = ["fast", "balanced", "deep"];
  const createdWithProfiles = [];
  for (let index = 1; index <= MAX_CONCURRENT_SUBAGENTS; index++) {
    createdWithProfiles.push(await subagentTool.execute(`create-${index}`, {
      action: "create",
      name: `agent-${index}`,
      persona: "test-scout",
      purpose: `Retain context for project area ${index}`,
      ...(profileNames[index - 1] ? { profile: profileNames[index - 1] } : {}),
    }, signal, undefined, context));
  }
  assert.deepEqual(
    createdWithProfiles.map(({ details }) => ({
      model: details.subagent.model,
      thinking: details.subagent.thinking,
    })),
    [
      { model: "openai-codex/gpt-5.6-luna", thinking: "high" },
      { model: "openai-codex/gpt-5.6-terra", thinking: "xhigh" },
      { model: "openai-codex/gpt-5.6-sol", thinking: "xhigh" },
      { model: "openai-codex/gpt-5.6-terra", thinking: "xhigh" },
    ],
  );
  const duplicate = await subagentTool.execute("create-duplicate-purpose", {
    action: "create",
    name: "duplicate-area",
    persona: "test-scout",
    purpose: "retain context for project area 1",
  }, signal, undefined, context);
  assert.equal(duplicate.details.ok, false);
  assert.equal(duplicate.details.error.code, "SUBAGENT_FAILED");
  assert.match(duplicate.details.error.message, /agent-1 .*already retains context.*action "prompt"/i);
  for (let index = MAX_CONCURRENT_SUBAGENTS + 1; index <= MAX_RETAINED_SUBAGENTS; index++) {
    const retained = await subagentTool.execute(`create-${index}`, {
      action: "create",
      name: `agent-${index}`,
      persona: "test-scout",
      purpose: `Retain context for project area ${index}`,
    }, signal, undefined, context);
    assert.equal(retained.details.ok, true);
  }
  const overLimit = await subagentTool.execute("create-over-limit", {
    action: "create",
    name: "agent-over-limit",
    persona: "test-scout",
    purpose: "This purpose should be rejected by the retained limit",
  }, signal, undefined, context);
  assert.equal(overLimit.details.ok, false);
  assert.equal(overLimit.details.error.code, "SUBAGENT_FAILED");
  assert.match(overLimit.details.error.message, /Retained subagent limit reached \(20\)/i);

  await commands.get("subagents").handler("--stop agent-1", context);
  assert.equal(confirmations.length, 1);
  assert.match(confirmations[0].message, /cannot be prompted again/i);
  assert.ok(notifications.some(({ message }) => /Stopped agent-1/.test(message)));
  const stopped = await subagentTool.execute("status-stopped", {
    action: "status",
    id: "agent-1",
  }, signal, undefined, context);
  assert.equal(stopped.details.subagent.status, "stopped");
  assert.equal(stopped.content[0].text, "agent-1 [stopped, task]: Retain context for project area 1");
  assert.doesNotMatch(stopped.content[0].text, /sa_[a-f0-9]+/);

  const replacement = await subagentTool.execute("create-replacement", {
    action: "create",
    name: "agent-replacement",
    persona: "test-scout",
    purpose: "Retain context for the replacement project area",
  }, signal, undefined, context);
  assert.equal(replacement.details.subagent.status, "dormant");
  assert.equal(replacement.details.subagent.purpose, "Retain context for the replacement project area");
  assert.equal(replacement.content[0].text, "Created agent-replacement.");
  assert.doesNotMatch(replacement.content[0].text, /sa_[a-f0-9]+/);
  const listed = await subagentTool.execute("list-with-purposes", {
    action: "list",
  }, signal, undefined, context);
  assert.match(listed.content[0].text, /agent-replacement \[pi, dormant, task\]: Retain context for the replacement project area/);
  assert.doesNotMatch(listed.content[0].text, /(?:^|\n)agent-1 \[|sa_[a-f0-9]+|thinking|\/gpt|\/claude/);
  await events.get("session_shutdown")({}, context);
});

test("subagent args preserve the parent's scoped model cycle", () => {
  const scopedModels = [
    { provider: "anthropic", id: "claude-sonnet-4-6", thinkingLevel: "high" },
    { provider: "openai", id: "gpt-5.4" },
  ];
  assert.equal(
    formatSubagentModelScope(scopedModels),
    "anthropic/claude-sonnet-4-6:high,openai/gpt-5.4",
  );

  const args = buildSubagentProcessArgs({ mode: "fresh", scopedModels });
  assert.deepEqual(args.slice(args.indexOf("--models"), args.indexOf("--models") + 2), [
    "--models",
    "anthropic/claude-sonnet-4-6:high,openai/gpt-5.4",
  ]);
});

test("forked persona args load bundled and declared resources with Pi's normal tool selection", () => {
  const persona = {
    name: "reviewer",
    description: "Review changes",
    systemPrompt: "You are a reviewer.",
    extensions: [SUBAGENT_EXTENSION_PATHS[0], "/personas/extensions/review.ts"],
    skills: ["/personas/skills/review/SKILL.md"],
    filePath: "/personas/reviewer.md",
  };
  const args = buildSubagentProcessArgs({
    mode: "fork",
    parentSessionFile: "/sessions/parent.jsonl",
    persona,
    model: "openai/gpt-5.4",
    thinking: "medium",
    skills: ["/parent/skills/create-pr/SKILL.md", "/personas/skills/review/SKILL.md"],
  });

  assert.deepEqual(args, [
    "--mode", "rpc",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--extension", SUBAGENT_EXTENSION_PATHS[0],
    "--extension", SUBAGENT_EXTENSION_PATHS[1],
    "--model", "openai/gpt-5.4",
    "--thinking", "medium",
    "--system-prompt", "You are a reviewer.\n",
    "--extension", "/personas/extensions/review.ts",
    "--skill", "/personas/skills/review/SKILL.md",
    "--skill", "/parent/skills/create-pr/SKILL.md",
    "--fork", "/sessions/parent.jsonl",
  ]);
  assert.equal(args.includes("--tools"), false);
  assert.equal(args.includes("--no-extensions"), true);
  assert.equal(args.includes("--no-skills"), true);
  assert.equal(args.filter((value) => value === "--extension").length, 3);
  assert.deepEqual(args.filter((value) => value === "--skill"), ["--skill", "--skill"]);
  assert.equal(args.includes(join(BUNDLED_PERSONA_DIRECTORY, "..", "index.ts")), false);
});

test("restored subagent args use its session model history", () => {
  const persona = {
    name: "explorer",
    description: "Explorer",
    systemPrompt: "Read the project.",
    extensions: [],
    skills: [],
    filePath: "/personas/explorer.md",
  };
  const args = buildSubagentProcessArgs({
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
  assert.throws(() => buildSubagentProcessArgs({ mode: "fork" }), /persisted parent session/i);
  assert.throws(
    () => buildSubagentProcessArgs({ mode: "fork", parentSessionFile: "/parent.jsonl", sessionFile: "/subagent.jsonl" }),
    /cannot restore/i,
  );
});

test("bundled personas provide focused defaults and user personas override by name", async (t) => {
  const bundled = loadSubagentPersonas(BUNDLED_PERSONA_DIRECTORY);
  assert.deepEqual(bundled.diagnostics, []);
  assert.deepEqual(bundled.personas.map(({ name }) => name), [
    "doc-auditor",
    "explorer",
    "reviewer",
    "test-analyst",
    "worker",
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
      { name: "doc-auditor", role: "You are a repository documentation auditor. Verify that documentation about the repository or implemented code matches actual behavior and gives its intended audience enough information to use the documented functionality correctly." },
      { name: "explorer", role: "You are an explorer for the primary agent. Investigate the requested scope and return concise, evidence-based summaries and direct answers to its questions." },
      { name: "reviewer", role: "You are a code reviewer, not an implementation agent." },
      { name: "test-analyst", role: "You are a test analyst, not an implementation agent. Assess testability, test coverage, and regression cases for a defined change. Do not define product requirements, determine feature scope, or make design decisions. For a design document, assess only whether its stated behavior is precise and observable enough to derive tests." },
      { name: "worker", role: "You are a worker for the primary agent. Execute the assigned implementation or production task within its explicit ownership boundary." },
    ],
  );
  const bundledPrompts = Object.fromEntries(
    bundled.personas.map(({ name, systemPrompt }) => [name, systemPrompt]),
  );
  assert.match(bundledPrompts.explorer, /available evidence.*source code, documentation, configuration, tests, history, project records, artifacts, and declared third-party dependencies/);
  assert.match(bundledPrompts.explorer, /Lead with direct answers and a concise summary/);
  assert.match(bundledPrompts.explorer, /Do not edit or write project files.*use Bash to inspect.*dependencies/s);
  assert.match(bundledPrompts["doc-auditor"], /Do not audit plans, design documents, proposals, requirements.*intended or future work/s);
  assert.match(bundledPrompts["doc-auditor"], /Do not provide a generic document critique.*outside this scope.*stop/s);
  assert.match(bundledPrompts["doc-auditor"], /Report only actionable findings.*documentation and implementation evidence/s);
  assert.match(bundledPrompts["doc-auditor"], /Do not draft replacement prose.*or edit files/s);
  assert.match(
    bundledPrompts.reviewer,
    /stated review focus as a hard boundary.*specific guideline.*report only findings that directly answer it.*Do not expand.*general review/s,
  );
  assert.match(bundledPrompts.reviewer, /Report only actionable findings.*only within the review scope.*failure scenario and impact/s);
  assert.match(bundledPrompts.reviewer, /Do not suggest fixes, remediation, replacement code, or implementation directions/);
  assert.match(bundledPrompts.reviewer, /Do not edit files or run tests.*Base the review on the changes and repository evidence/s);
  assert.match(bundledPrompts["test-analyst"], /recommend focused tests.*setup, action, and assertions/s);
  assert.match(bundledPrompts["test-analyst"], /Do not edit files.*Run focused tests when useful.*commands and outcomes you actually observed/s);
  assert.match(bundledPrompts.worker, /You are not alone in the worktree.*Do not revert, overwrite, or reformat unrelated work/s);
  assert.match(bundledPrompts.worker, /ownership overlaps.*stop and return `BLOCKED` and `NEEDS`.*minimum boundary change/s);
  assert.match(bundledPrompts.worker, /Run focused validation.*Do not commit, change branches, rewrite Git state, or remove files/s);
  assert.equal(
    bundled.personas.find(({ name }) => name === "explorer").contextRequirements,
    "Provide the objective, questions, relevant scope, and constraints.",
  );
  assert.equal(
    bundled.personas.find(({ name }) => name === "worker").contextRequirements,
    "Provide the objective, acceptance criteria, owned files or responsibilities, constraints, concurrent work, and required validation.",
  );
  assert.deepEqual(
    bundled.personas.map(({ name, preferredProfile }) => ({ name, preferredProfile })),
    [
      { name: "doc-auditor", preferredProfile: "fast" },
      { name: "explorer", preferredProfile: "fast" },
      { name: "reviewer", preferredProfile: "balanced" },
      { name: "test-analyst", preferredProfile: "balanced" },
      { name: "worker", preferredProfile: "balanced" },
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
  const merged = loadSubagentPersonasFromDirectories([BUNDLED_PERSONA_DIRECTORY, root]);
  assert.deepEqual(merged.diagnostics, []);
  assert.equal(merged.personas.find(({ name }) => name === "reviewer").description, "Custom reviewer");
  assert.equal(merged.personas.find(({ name }) => name === "reviewer").preferredProfile, undefined);
  assert.equal(merged.personas.find(({ name }) => name === "reviewer").filePath, join(root, "reviewer.md"));
});

test("persona descriptions truncate at a Unicode code-point boundary", () => {
  const description = normalizePersonaDescription(`${"a".repeat(238)}😀 trailing text`);
  assert.equal(description, `${"a".repeat(238)}…`);
  assert.doesNotMatch(description, /�/u);
});

test("subagent personas load markdown prompts and resolve explicit resource paths", async (t) => {
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
preferred-profile: deep
extensions:
  - ../extensions/context.ts
skill: ../skills/research/SKILL.md
skills:
  - ../skills/research/SKILL.md
  - ../skills/product/SKILL.md
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
description: Unsupported persona lifetime preference
preferred-lifetime: task
---
This persona should be rejected.
`);
  await writeFile(join(personaDir, "model.md"), `---
name: model
description: Invalid model selection
model: anthropic/claude-sonnet-4-6
---
This persona should be rejected.
`);
  await writeFile(join(personaDir, "thinking.md"), `---
name: thinking
description: Invalid thinking selection
thinking: low
---
This persona should be rejected.
`);

  const discovery = loadSubagentPersonas(personaDir);
  assert.equal(discovery.personas.length, 1);
  assert.equal(
    formatPersonaForModel(discovery.personas[0]),
    "product-manager [pi]: Explore product decisions [prefers deep profile] [context required: Provide the goal, expected behavior, constraints, Git base revision, and relevant scope. Do not include patch text.]",
  );
  assert.deepEqual(discovery.personas[0], {
    name: "product-manager",
    description: "Explore product decisions",
    systemPrompt: "You are a product manager, not a coding agent.",
    runtime: "pi",
    contextRequirements: "Provide the goal, expected behavior, constraints, Git base revision, and relevant scope. Do not include patch text.",
    preferredProfile: "deep",
    extensions: [join(root, "extensions", "context.ts")],
    skills: [
      join(root, "skills", "research", "SKILL.md"),
      join(root, "skills", "product", "SKILL.md"),
    ],
    filePath: join(personaDir, "a-product.md"),
  });
  assert.equal(discovery.diagnostics.length, 10);
  assert.ok(discovery.diagnostics.some((diagnostic) => /duplicate subagent persona/i.test(diagnostic)));
  assert.ok(discovery.diagnostics.some((diagnostic) => /invalid name/i.test(diagnostic)));
  assert.ok(discovery.diagnostics.some((diagnostic) => /invalid name.*at most 64/i.test(diagnostic)));
  assert.ok(discovery.diagnostics.some((diagnostic) => /system prompt body is empty/i.test(diagnostic)));
  assert.ok(discovery.diagnostics.some((diagnostic) => /extension path does not exist/i.test(diagnostic)));
  assert.ok(discovery.diagnostics.some((diagnostic) => /skill path does not exist/i.test(diagnostic)));
  assert.ok(discovery.diagnostics.some((diagnostic) => /context-requirements exceeds 240 characters/i.test(diagnostic)));
  assert.ok(discovery.diagnostics.some((diagnostic) => /preferred-lifetime is not valid in a persona.*select lifetime/i.test(diagnostic)));
  assert.ok(discovery.diagnostics.some((diagnostic) => /model is not valid in a persona.*creation profile/i.test(diagnostic)));
  assert.ok(discovery.diagnostics.some((diagnostic) => /thinking is not valid in a persona.*creation profile/i.test(diagnostic)));
});

test("public stop output reports pending and uncertain Cursor cleanup", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-stop-output-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tools = new Map();
  const commands = new Map();
  const notifications = [];
  const originalStop = PersistentSubagentRegistry.prototype.stop;
  const originalSummaryFor = PersistentSubagentRegistry.prototype.summaryFor;
  t.after(() => {
    PersistentSubagentRegistry.prototype.stop = originalStop;
    PersistentSubagentRegistry.prototype.summaryFor = originalSummaryFor;
  });
  let status = "archive-pending";
  const summary = () => ({
    id: "sa_cursor",
    name: "cursor-agent",
    runtime: "cursor-cloud",
    purpose: "Inspect Cloud cleanup state",
    lifetime: "task",
    status,
    createdAt: 1,
    lastActiveAt: 1,
  });
  PersistentSubagentRegistry.prototype.stop = async () => summary();
  PersistentSubagentRegistry.prototype.summaryFor = () => summary();
  subagentsModule.default({
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand(name, command) { commands.set(name, command); },
    registerShortcut() {},
    on() {},
  }, { personaDirectory: join(root, "missing-personas") });
  const context = {
    cwd: root,
    mode: "tui",
    hasUI: true,
    model: undefined,
    scopedModels: [],
    sessionManager: {
      getSessionId: () => "stop-output-parent",
      getSessionFile: () => join(root, "parent.jsonl"),
      getBranch: () => [],
    },
    ui: {
      notify(message, level) { notifications.push({ message, level }); },
      async confirm() { return true; },
      async select() { return undefined; },
    },
  };

  const tool = tools.get("subagent");
  const archivePending = await tool.execute("archive-pending", {
    action: "stop",
    id: "cursor-agent",
  }, undefined, undefined, context);
  assert.match(archivePending.content[0].text, /archival is pending.*Retry action "stop"/i);
  assert.doesNotMatch(archivePending.content[0].text, /^Stopped /);
  assert.equal(archivePending.details.ok, false);
  await commands.get("subagents").handler("--stop cursor-agent", context);
  assert.match(notifications.at(-1).message, /archival is pending.*Retry action "stop"/i);
  assert.doesNotMatch(notifications.at(-1).message, /^Stopped /);

  status = "remote-state-unknown";
  const unknown = await tool.execute("remote-unknown", {
    action: "stop",
    id: "cursor-agent",
  }, undefined, undefined, context);
  assert.match(unknown.content[0].text, /not confirmed.*remote state is unknown.*action "status"/i);
  assert.doesNotMatch(unknown.content[0].text, /^Stopped /);
  assert.equal(unknown.details.ok, false);
  await commands.get("subagents").handler("--stop cursor-agent", context);
  assert.match(notifications.at(-1).message, /not confirmed.*remote state is unknown.*action "status"/i);
  assert.doesNotMatch(notifications.at(-1).message, /^Stopped /);

  status = "stopping";
  const stopping = await tool.execute("stopping", {
    action: "stop",
    id: "cursor-agent",
  }, undefined, undefined, context);
  assert.match(stopping.content[0].text, /^Stopping cursor-agent.*action "status"/i);
  assert.equal(stopping.details.ok, false);

  status = "stopped";
  const stopped = await tool.execute("stopped", {
    action: "stop",
    id: "cursor-agent",
  }, undefined, undefined, context);
  assert.equal(stopped.content[0].text, "Stopped cursor-agent.");
  assert.equal(stopped.details.ok, true);
});

test("public status tool awaits reconciliation and returns reconciled details", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-status-output-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tools = new Map();
  const originalStatus = PersistentSubagentRegistry.prototype.status;
  t.after(() => { PersistentSubagentRegistry.prototype.status = originalStatus; });
  const summary = {
    id: "sa_reconciled",
    name: "reconciled-agent",
    runtime: "cursor-cloud",
    purpose: "Inspect reconciled remote state",
    lifetime: "task",
    status: "idle",
    createdAt: 1,
    lastActiveAt: 2,
  };
  let entered;
  const statusEntered = new Promise((resolve) => { entered = resolve; });
  let resolveSummary;
  PersistentSubagentRegistry.prototype.status = async () => {
    entered();
    return await new Promise((resolve) => { resolveSummary = resolve; });
  };
  subagentsModule.default({
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand() {},
    registerShortcut() {},
    on() {},
  }, { personaDirectory: join(root, "missing-personas") });
  const context = {
    cwd: root,
    mode: "tui",
    hasUI: true,
    model: undefined,
    scopedModels: [],
    sessionManager: {
      getSessionId: () => "status-output-parent",
      getSessionFile: () => join(root, "parent.jsonl"),
      getBranch: () => [],
    },
    ui: {},
  };

  const resultPromise = tools.get("subagent").execute("reconciled-status", {
    action: "status",
    id: "reconciled-agent",
  }, undefined, undefined, context);
  await statusEntered;
  let settled = false;
  void resultPromise.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  resolveSummary(summary);
  const result = await resultPromise;
  assert.equal(result.content[0].text, "reconciled-agent [idle, task]: Inspect reconciled remote state");
  assert.deepEqual(result.details.subagent, summary);
});

test("model-facing subagent results retain policy, dirty-worktree, artifact, and partial-usage details", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-policy-output-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tools = new Map();
  const originalPrompt = PersistentSubagentRegistry.prototype.prompt;
  const originalSummaryFor = PersistentSubagentRegistry.prototype.summaryFor;
  t.after(() => {
    PersistentSubagentRegistry.prototype.prompt = originalPrompt;
    PersistentSubagentRegistry.prototype.summaryFor = originalSummaryFor;
  });
  const summary = {
    id: "sa_policy_result", name: "policy-result", runtime: "cursor-cloud", purpose: "Inspect policy metadata", lifetime: "task", status: "idle", createdAt: 1, lastActiveAt: 1,
  };
  let reportedUsage = { input: 0, totalTokens: 0, reasoningTokens: 0, cost: { total: 0 } };
  PersistentSubagentRegistry.prototype.summaryFor = () => summary;
  PersistentSubagentRegistry.prototype.prompt = async () => ({
    summary,
    text: "Safe response content",
    usage: reportedUsage,
    responseProduced: true,
    handledWithoutAgent: false,
    stopReason: "stop",
    policyWarnings: ["Cursor Cloud reported branch metadata."],
    runtimeWarnings: ["The worktree has local changes. Cursor Cloud sees only the committed HEAD state."],
    artifacts: [{ id: "artifact-1", name: "report.md", path: "report.md", sizeBytes: 12 }],
  });
  subagentsModule.default({
    registerTool(tool) { tools.set(tool.name, tool); }, registerCommand() {}, registerShortcut() {}, on() {},
  }, { personaDirectory: join(root, "missing-personas") });
  const context = {
    cwd: root, mode: "tui", hasUI: true, model: undefined, scopedModels: [],
    sessionManager: { getSessionId: () => "policy-output-parent", getSessionFile: () => join(root, "parent.jsonl"), getBranch: () => [] }, ui: {},
  };
  const result = await tools.get("subagent").execute("policy-result", { action: "prompt", id: summary.id, prompt: "Read saved result" }, undefined, undefined, context);
  assert.match(result.content[0].text, /^Policy warning: Cursor Cloud reported branch metadata\.\nRuntime warning: The worktree has local changes\. Cursor Cloud sees only the committed HEAD state\.\n\nSafe response content$/);
  assert.deepEqual(result.details.policyWarnings, ["Cursor Cloud reported branch metadata."]);
  assert.deepEqual(result.details.runtimeWarnings, ["The worktree has local changes. Cursor Cloud sees only the committed HEAD state."]);
  assert.deepEqual(result.details.artifacts, [{ id: "artifact-1", name: "report.md", path: "report.md", sizeBytes: 12 }]);
  assert.deepEqual(result.details.usage, { input: 0, totalTokens: 0, reasoningTokens: 0, cost: { total: 0 } });
  assert.equal(result.usage, undefined, "partial Cursor usage remains structured details, not incomplete Pi accounting");

  summary.runtime = "pi";
  reportedUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const piResult = await tools.get("subagent").execute("pi-usage-result", { action: "prompt", id: summary.id, prompt: "Read Pi usage" }, undefined, undefined, context);
  assert.deepEqual(piResult.usage, reportedUsage);
  assert.equal(Object.hasOwn(piResult.details, "usage"), false, "Pi usage stays only in the complete tool usage payload");
});

test("public Pi tool retains complete zero usage when no usage event arrives", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-public-pi-zero-usage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tools = new Map();
  const events = new Map();
  const personaDirectory = join(root, "personas");
  await mkdir(personaDirectory);
  await writeFile(join(personaDirectory, "worker.md"), `---
name: worker
description: Execute a bounded task
---
Execute the assigned work.
`);
  const backendFactory = (options) => {
    const run = { id: "run-pi-zero-usage", runtime: "pi" };
    return {
      runtime: "pi", displayName: "Pi", getDiagnostics() { return ""; },
      capabilities: { extensionUi: false, steering: true, queuedFollowUp: true, modelControls: false, thinkingControls: false, sessionHistory: false, sessionFile: false, usage: false, toolOutput: false },
      async start() {}, async stop() {},
      async prompt() {
        options.onEvent({ type: "run_started", run });
        options.onEvent({ type: "message_completed", run, message: { role: "assistant", text: "Pi result without usage event", thinking: "", stopReason: "stop" } });
        options.onEvent({ type: "run_settled", run });
        return { run };
      },
      async steer() {}, async followUp() { return { run }; }, async abort() {},
      async getState() { return { connection: { id: "pi-zero-usage", runtime: "pi" }, thinkingLevel: "off", isStreaming: false, isCompacting: false }; },
      async getHistory() { return []; }, async getSessionStats() { return {}; }, async getAvailableModels() { return []; },
      async setModel() { throw new Error("unsupported"); }, async cycleModel() { return null; }, async setThinkingLevel() {}, async cycleThinkingLevel() { return null; }, respondToExtensionUI() {},
    };
  };
  const pi = {
    getThinkingLevel() { return "off"; }, appendEntry() {}, registerTool(tool) { tools.set(tool.name, tool); }, registerCommand() {}, registerShortcut() {}, on(name, listener) { events.set(name, listener); },
  };
  const context = {
    cwd: root, mode: "tui", hasUI: true, model: undefined, scopedModels: [],
    sessionManager: { getSessionId: () => "public-pi-zero-usage", getSessionFile: () => join(root, "parent.jsonl"), getBranch: () => [] }, ui: {},
  };
  subagentsModule.default(pi, { personaDirectory, backendFactory });
  events.get("session_start")({}, context);
  const result = await tools.get("subagent").execute("pi-zero-usage", {
    action: "create", name: "pi-zero-usage", persona: "worker", purpose: "Verify Pi zero usage", lifetime: "task", mode: "fresh", prompt: "Respond without usage",
  }, undefined, undefined, context);
  assert.deepEqual(result.usage, {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });
  assert.equal(Object.hasOwn(result.details, "usage"), false);
});

test("public Cursor one-shot oversized results retain a task and dispatch a new follow-up", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-public-cursor-oversized-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tools = new Map();
  const events = new Map();
  const runs = new Map();
  const sends = [];
  let archives = 0;
  const sha = "b".repeat(40);
  const makeRun = (id, result) => ({
    id, requestId: `request-${id}`, agentId: agent.agentId, status: "finished", result, createdAt: sends.length,
    supports(operation) { return operation === "wait"; }, unsupportedReason() { return undefined; }, async *stream() {},
    async wait() { return { id, requestId: `request-${id}`, status: "finished", result }; }, async cancel() {}, onDidChangeStatus() { return () => {}; },
  });
  const agent = {
    agentId: "",
    async send(message, options) {
      sends.push({ message, options });
      const id = `run-oversized-${sends.length}`;
      const result = sends.length === 1 ? "x".repeat(MAX_SUBAGENT_RESPONSE_BYTES + 1_000) : "New follow-up result";
      const run = makeRun(id, result);
      runs.set(id, run);
      return run;
    },
    close() {}, async listArtifacts() { return []; }, async getUsage() { return {}; },
  };
  const sdk = {
    async createAgent(options) { agent.agentId = options.agentId; return agent; }, async resumeAgent(agentId) { agent.agentId = agentId; return agent; },
    async getAgent() { return { status: "finished" }; }, async listRuns() { return { runs: [...runs.values()], complete: true }; },
    async getRun(id) { return runs.get(id); }, async cancelRun() { throw new Error("terminal results must not cancel"); },
    async archiveAgent() { archives++; },
    async listModels() {
      return [{ id: "gpt-5.6-terra", displayName: "GPT-5.6 Terra", parameters: [{ id: "reasoning_effort", values: [{ value: "xhigh", displayName: "Extra high" }] }] }];
    }, async listRepositories() { return []; },
  };
  const catalog = new CursorModelCatalog(sdk);
  const git = {
    async run(_cwd, args) {
      const key = args.join(" ");
      const stdout = key === "rev-parse --show-toplevel" ? root
        : key === "rev-parse --verify HEAD^{commit}" ? sha
        : key === "symbolic-ref --quiet --short HEAD" ? "main"
        : key === "config --get branch.main.remote" ? "origin"
        : key === "remote get-url origin" ? "https://github.com/example/project.git"
        : key === "rev-parse --verify --quiet @{upstream}" ? sha
        : key === "config --get branch.main.merge" ? "refs/heads/main"
        : key === "rev-list --count @{upstream}..HEAD" ? "0"
        : key === "status --porcelain=v1 -z" ? ""
        : "";
      return { exitCode: stdout || key === "status --porcelain=v1 -z" ? 0 : 1, stdout, stderr: "" };
    },
  };
  const backendFactory = (options) => options.cursor
    ? new CursorCloudBackend({ ...options, cursor: { ...options.cursor, sdk, catalog, git } })
    : (() => { throw new Error("Pi backend is not part of this Cursor test"); })();
  const pi = {
    getThinkingLevel() { return "off"; }, appendEntry() {}, registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand() {}, registerShortcut() {}, on(name, listener) { events.set(name, listener); },
  };
  const context = {
    cwd: root, mode: "tui", hasUI: true, model: undefined, scopedModels: [],
    sessionManager: { getSessionId: () => "public-cursor-oversized", getSessionFile: () => join(root, "parent.jsonl"), getBranch: () => [] }, ui: {},
  };
  subagentsModule.default(pi, {
    personaDirectory: join(root, "missing-personas"), backendFactory, cursorLifecycle: createCursorSubagentLifecyclePort(sdk),
  });
  events.get("session_start")({}, context);
  const tool = tools.get("subagent");
  const oversized = await tool.execute("cursor-oversized", {
    action: "create", name: "cursor-oversized", runtime: "cursor-cloud", purpose: "Retain an oversized Cloud result", lifetime: "one-shot", mode: "fresh", prompt: "Return a large result",
  }, undefined, undefined, context);
  assert.equal(oversized.details.ok, true, oversized.content[0].text);
  const id = oversized.details.subagent.id;
  assert.equal(oversized.details.subagent.lifetime, "task");
  assert.match(oversized.content[0].text, /^Retained .* as a task because its response was truncated\./);
  assert.equal(archives, 0, "no one-shot archive starts before the retained ToolResult reaches turn_end");
  await events.get("turn_end")({
    message: { role: "assistant", content: [] },
    toolResults: [{ role: "toolResult", toolName: "subagent", details: oversized.details }],
  }, context);
  assert.equal(archives, 0, "promoted oversized results remain reusable after acknowledgement");
  const followUp = await tool.execute("cursor-oversized-follow-up", {
    action: "prompt", id, prompt: "Continue with a compact result",
  }, undefined, undefined, context);
  assert.equal(followUp.content[0].text, "New follow-up result");
  assert.equal(sends.length, 2, "the follow-up sends a new run instead of replaying the oversized result");
  await events.get("turn_end")({
    message: { role: "assistant", content: [] },
    toolResults: [{ role: "toolResult", toolName: "subagent", details: followUp.details }],
  }, context);
});

test("public Cursor tool actions use the injected real backend without a loader or network", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-public-cursor-actions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tools = new Map();
  const events = new Map();
  const persisted = [];
  const sends = [];
  const backendEvents = [];
  const runs = new Map();
  let creates = 0;
  let cancels = 0;
  let archives = 0;
  let loaderCalls = 0;
  const sha = "a".repeat(40);
  const makeRun = (id, result) => ({
    id,
    requestId: `request-${id}`,
    agentId: agent.agentId,
    createdAt: runs.size + 1,
    status: "finished",
    result,
    usage: { inputTokens: 3, reasoningTokens: 1, totalTokens: 3 },
    git: { branches: [{ repoUrl: "https://github.com/example/project", prUrl: "https://github.com/example/project/pull/7" }] },
    supports(operation) { return operation === "wait"; }, unsupportedReason() { return undefined; }, async *stream() {},
    async wait() { return { id, requestId: `request-${id}`, status: "finished", result, usage: { inputTokens: 3, reasoningTokens: 1, totalTokens: 3 }, git: { branches: [{ repoUrl: "https://github.com/example/project", prUrl: "https://github.com/example/project/pull/7" }] } }; },
    async cancel() {}, onDidChangeStatus() { return () => {}; },
  });
  const agent = {
    agentId: "",
    async send(message, options) {
      const saved = persisted.flatMap((entry) => entry.upserts ?? []).at(-1);
      assert.equal(saved.agentId, agent.agentId, "agent identity persists before send");
      assert.ok(saved.pendingOperations.some((operation) => operation.kind === "start-run" || operation.kind === "follow-up"), "send key persists before send");
      sends.push({ message, options });
      const run = makeRun(`run-public-${sends.length}`, sends.length === 1 ? "Initial public result" : "Follow-up public result");
      runs.set(run.id, run);
      return run;
    },
    close() {},
    async listArtifacts() { return [{ path: "report.md", sizeBytes: 12 }, { path: "logs/summary.txt", sizeBytes: 8 }]; },
    async getUsage() { return {}; },
  };
  const sdk = {
    get load() { loaderCalls++; throw new Error("production SDK loader must not run"); },
    async createAgent(options) {
      creates++;
      agent.agentId = options.agentId;
      const saved = persisted.flatMap((entry) => entry.upserts ?? []).at(-1);
      assert.equal(saved.agentId, options.agentId, "lazy agent identity persists before Agent.create");
      assert.equal(Object.hasOwn(options, "mcpServers"), false);
      assert.equal(Object.hasOwn(options.cloud, "mcpServers"), false);
      assert.deepEqual(options.cloud.metadata, { "pi-subagent-id": saved.id, "pi-subagent-lifetime": "task" });
      return agent;
    },
    async resumeAgent(agentId) { agent.agentId = agentId; return agent; },
    async getAgent() { return { status: "finished" }; },
    async listRuns() { return { runs: [...runs.values()], complete: true }; },
    async getRun(id) { return runs.get(id); },
    async cancelRun() { cancels++; },
    async archiveAgent() { archives++; },
    async listModels() { return [{ id: "gpt-5.6-terra", displayName: "GPT-5.6 Terra", parameters: [{ id: "reasoning_effort", values: [{ value: "xhigh", displayName: "Extra high" }] }] }]; },
    async listRepositories() { return []; },
  };
  const catalog = new CursorModelCatalog(sdk);
  const git = {
    async run(_cwd, args) {
      const key = args.join(" ");
      const stdout = key === "rev-parse --show-toplevel" ? root
        : key === "rev-parse --verify HEAD^{commit}" ? sha
        : key === "symbolic-ref --quiet --short HEAD" ? "main"
        : key === "config --get branch.main.remote" ? "origin"
        : key === "remote get-url origin" ? "https://github.com/example/project.git"
        : key === "rev-parse --verify --quiet @{upstream}" ? sha
        : key === "config --get branch.main.merge" ? "refs/heads/main"
        : key === "rev-list --count @{upstream}..HEAD" ? "0"
        : key === "status --porcelain=v1 -z" ? "M src/local-only.ts\0"
        : "";
      return { exitCode: stdout || key === "status --porcelain=v1 -z" ? 0 : 1, stdout, stderr: "" };
    },
  };
  const backendFactory = (options) => {
    if (!options.cursor) throw new Error("Pi backend is not part of this Cursor test");
    return new CursorCloudBackend({
      ...options,
      cursor: { ...options.cursor, sdk, catalog, git },
      onEvent(event) { backendEvents.push(event); options.onEvent(event); },
    });
  };
  const pi = {
    getThinkingLevel() { return "off"; },
    appendEntry(_type, data) { persisted.push(structuredClone(data)); },
    registerTool(tool) { tools.set(tool.name, tool); }, registerCommand() {}, registerShortcut() {},
    on(name, listener) { events.set(name, listener); },
  };
  const context = {
    cwd: root, mode: "tui", hasUI: true, model: undefined, scopedModels: [],
    sessionManager: { getSessionId: () => "public-cursor-parent", getSessionFile: () => join(root, "parent.jsonl"), getBranch: () => [] },
    ui: {},
  };
  subagentsModule.default(pi, {
    personaDirectory: join(root, "missing-personas"),
    backendFactory,
    cursorLifecycle: createCursorSubagentLifecyclePort(sdk),
  });
  events.get("session_start")({}, context);
  const tool = tools.get("subagent");
  const created = await tool.execute("cursor-create", {
    action: "create", name: "public-cursor", runtime: "cursor-cloud", purpose: "Validate all public Cursor actions", lifetime: "task", mode: "fresh", prompt: "Inspect the repository",
  }, undefined, undefined, context);
  const id = created.details.subagent.id;
  assert.equal(created.details.action, "create");
  assert.equal(creates, 1);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].options.mode, "plan");
  assert.match(sends[0].message, /Inspect the repository/);
  assert.equal(created.usage, undefined, "partial Cursor usage is not converted to Pi tool accounting");
  assert.deepEqual(created.details.usage, { input: 3, totalTokens: 3, reasoningTokens: 1 });
  assert.equal(created.details.artifacts.length, 2);
  assert.deepEqual(created.details.policyWarnings, ["Cursor Cloud reported branch or pull-request metadata despite the no-change policy."]);
  assert.deepEqual(created.details.runtimeWarnings, ["The worktree has local changes. Cursor Cloud sees only the committed HEAD state."]);
  assert.equal(created.details.runtime.kind, "cursor-cloud");
  assert.equal(created.details.runtime.remote.agentId, agent.agentId);
  assert.equal(created.details.runtime.remote.runId, "run-public-1");
  assert.equal(created.details.runtime.remote.requestId, "request-run-public-1");
  assert.deepEqual(created.details.cursorDeliveryReceipt, {
    version: 1, subagentId: id, runId: "run-public-1",
  });
  assert.equal(archives, 0, "tool execute returns before Cursor receipt cleanup");
  assert.doesNotMatch(created.content[0].text, new RegExp(agent.agentId));
  await events.get("turn_end")({
    message: { role: "assistant", content: [] },
    toolResults: [{ role: "toolResult", toolName: "subagent", details: created.details }],
  }, context);

  const listed = await tool.execute("cursor-list", { action: "list" }, undefined, undefined, context);
  assert.equal(listed.details.action, "list");
  assert.equal(listed.details.subagents.some((summary) => summary.id === id), true);
  const status = await tool.execute("cursor-status", { action: "status", id }, undefined, undefined, context);
  const repeatedStatus = await tool.execute("cursor-status-repeat", { action: "status", id }, undefined, undefined, context);
  assert.equal(status.details.subagent.status, "idle");
  assert.equal(repeatedStatus.details.subagent.status, "idle");
  assert.equal(backendEvents.filter((event) => event.type === "message_completed").length, 1);
  assert.equal(backendEvents.filter((event) => event.type === "run_settled").length, 1);
  assert.equal(backendEvents.filter((event) => event.type === "usage_update").length, 1);
  const followUp = await tool.execute("cursor-follow-up", { action: "prompt", id, prompt: "Continue the inspection" }, undefined, undefined, context);
  assert.equal(followUp.details.action, "prompt");
  await events.get("turn_end")({
    message: { role: "assistant", content: [] },
    toolResults: [{ role: "toolResult", toolName: "subagent", details: followUp.details }],
  }, context);
  assert.equal(sends.length, 2);
  assert.equal(sends[1].options.mode, "plan");
  const stopped = await tool.execute("cursor-stop", { action: "stop", id }, undefined, undefined, context);
  assert.equal(stopped.details.subagent.status, "stopped");
  assert.equal(cancels, 0, "terminal public runs route directly to archive");
  assert.equal(archives, 1);
  assert.equal(loaderCalls, 0, "the injected SDK never invokes the production loader");
});
