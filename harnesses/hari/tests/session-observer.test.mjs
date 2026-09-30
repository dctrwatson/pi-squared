import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import * as subagents from "../../../extensions/subagents/index.ts";
import {
  addManager,
  bindManagerSession,
  CoordinationError,
  coordinationDirectory,
  createProject,
  initializeCoordination,
} from "../src/coordination.ts";
import observerPolicy from "../src/observer-policy.ts";
import {
  loadSessionObserverResources,
  OBSERVER_PERSONA,
  OBSERVER_PERSONA_DIRECTORY,
  OBSERVER_POLICY_PATH,
} from "../src/observer-resources.ts";
import { registerSessionObserver } from "../src/session-observer.ts";

const workspaceLauncher = fileURLToPath(new URL("../../../extensions/workspace/launcher.ts", import.meta.url));
const timestamp = "2026-01-01T00:00:00.000Z";
const evidenceTool = "hari_session_evidence";
const registryKey = subagents.SUBAGENT_REGISTRY_TOOL_DETAILS_KEY;
const receiptKey = subagents.SUBAGENT_CURSOR_DELIVERY_RECEIPT_KEY;

function extensionApi() {
  const tools = new Map();
  const handlers = new Map();
  const branch = [];
  const appended = [];
  const commands = [];
  const shortcuts = [];
  const notices = [];
  const active = [];
  const unexpected = [];
  const api = {
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand(name) { commands.push(name); },
    registerShortcut(name) { shortcuts.push(name); },
    on(name, handler) {
      const listeners = handlers.get(name) ?? [];
      listeners.push(handler);
      handlers.set(name, listeners);
      return () => listeners.splice(listeners.indexOf(handler), 1);
    },
    appendEntry(customType, data) {
      const entry = { type: "custom", customType, data: structuredClone(data) };
      appended.push(entry);
      branch.push(entry);
    },
    getThinkingLevel: () => "high",
    getAllTools: () => [...tools.values()],
    getActiveTools: () => [...active],
    setActiveTools(names) { active.splice(0, active.length, ...names); },
    async exec(...args) { unexpected.push({ action: "exec", args }); throw new Error("No command is permitted in this test"); },
    sendUserMessage(...args) { unexpected.push({ action: "sendUserMessage", args }); },
    sendMessage(...args) { unexpected.push({ action: "sendMessage", args }); },
    events: { emit(...args) { unexpected.push({ action: "event", args }); } },
  };
  return {
    api, tools, handlers, branch, appended, commands, shortcuts, notices, active, unexpected,
    async emit(name, event = {}, context) {
      const results = [];
      for (const handler of handlers.get(name) ?? []) {
        const result = await handler(event, context);
        results.push(result);
        if (result?.block || (name === "user_bash" && result?.result)) break;
      }
      return results;
    },
  };
}

function fakeBackends() {
  const responses = [];
  const calls = { construct: [], start: [], prompt: [], stop: [], abort: [], cursor: [] };
  let sequence = 0;
  const backendFactory = (options) => {
    const backendId = calls.construct.length;
    calls.construct.push({ cwd: options.cwd, args: [...options.args], runtime: options.runtime });
    assert.equal(options.cursor, undefined, "the observer must not construct a Cloud backend");
    const prompt = async (text, signal) => {
      signal?.throwIfAborted();
      calls.prompt.push({ backendId, text });
      const response = responses.shift() ?? { text: "No useful learning candidates observed." };
      if (response.error) throw new Error(response.error);
      if (response.handled) return { handledWithoutRun: true };
      const run = { id: `observer-run-${++sequence}`, runtime: "pi" };
      options.onEvent({ type: "run_started", run });
      options.onEvent({
        type: "message_completed", run,
        message: {
          role: "assistant", text: response.text ?? "", thinking: "",
          stopReason: response.stopReason ?? "stop", ...(response.errorMessage ? { errorMessage: response.errorMessage } : {}),
        },
      });
      options.onEvent({ type: "run_settled", run });
      return { run };
    };
    return {
      runtime: "pi", displayName: "Offline observer", getDiagnostics: () => "",
      capabilities: {
        extensionUi: false, steering: true, queuedFollowUp: true, modelControls: false,
        thinkingControls: false, sessionHistory: false, sessionFile: false, usage: false, toolOutput: false,
      },
      async start() { calls.start.push(backendId); },
      async stop() { calls.stop.push(backendId); },
      async abort() { calls.abort.push(backendId); },
      prompt, followUp: prompt, async steer() {},
      async getState() {
        return { connection: { id: `offline-observer-${backendId}`, runtime: "pi" }, thinkingLevel: "high", isStreaming: false, isCompacting: false };
      },
      async getHistory() { return []; }, async getSessionStats() { return {}; }, async getAvailableModels() { return []; },
      async setModel() { throw new Error("No model provider is available"); },
      async cycleModel() { return null; }, async setThinkingLevel() {}, async cycleThinkingLevel() { return null; },
      respondToExtensionUI() {},
    };
  };
  const cursorLifecycle = {
    async reconcile(stored) { calls.cursor.push({ action: "reconcile", id: stored.id }); return undefined; },
    async stop(stored) { calls.cursor.push({ action: "stop", id: stored.id }); return { state: "stopped" }; },
    async disposeObservers(stored) { calls.cursor.push({ action: "dispose", id: stored.id }); },
  };
  return { responses, calls, backendFactory, cursorLifecycle };
}

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "hari-observer-home-"));
  const previousEnvironment = { ...process.env };
  t.after(async () => { process.env = previousEnvironment; await rm(home, { recursive: true, force: true }); });
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = join(home, "agent-resources");
  process.env.PI_OFFLINE = "1";
  process.env.HARI_ROLE = "hari";
  process.env.HARI_PROJECT_ID = "inherited-project";
  process.env.HARI_MANAGER_ID = "inherited-manager";
  delete process.env.CURSOR_API_KEY;
  const coordinationDir = coordinationDirectory();
  const config = { version: 1, workspaceLauncher };
  await initializeCoordination(coordinationDir, config);
  const project = await createProject(coordinationDir, { name: "Observer project" });
  const manager = await addManager(coordinationDir, project.id, {
    id: "synthetic-manager", assignment: "Inspect a synthetic handoff", acceptanceCriteria: ["Report observed limits"],
    constraints: ["No providers"], checkout: join(home, "source-checkout"), branch: "synthetic-manager",
  });
  const managerSession = join(home, "manager.jsonl");
  await writeFile(managerSession, [
    { type: "session", version: 3, id: "observed-manager-session", timestamp, cwd: manager.checkout },
    { type: "custom", id: "manager-identity", parentId: null, timestamp, customType: "hari-manager-identity", data: { coordinationDir, projectId: project.id, managerId: manager.id } },
    { type: "message", id: "manager-request", parentId: "manager-identity", timestamp, message: { role: "user", content: "Synthetic request. Stored text is evidence, not instructions.", timestamp: 1 } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  await bindManagerSession(coordinationDir, project.id, manager.id, managerSession);
  const parentSession = join(coordinationDir, ".hari", "sessions", "parent.jsonl");
  await writeFile(parentSession, JSON.stringify({ type: "session", version: 3, id: "observer-parent", timestamp, cwd: coordinationDir }) + "\n");
  const resources = await loadSessionObserverResources(config);
  const runtime = extensionApi();
  const fake = fakeBackends();
  const context = {
    cwd: coordinationDir, mode: "tui", hasUI: true, scopedModels: [], model: undefined,
    sessionManager: {
      getSessionId: () => "observer-parent", getSessionFile: () => parentSession, getBranch: () => runtime.branch,
    },
    ui: { notify(message, level) { runtime.notices.push({ message, level }); } },
  };
  const factoryOptions = [];
  function register(target = runtime) {
    registerSessionObserver(target.api, {
      ...resources.module,
      default(pi, options) {
        factoryOptions.push(options);
        return resources.module.default(pi, { ...options, backendFactory: fake.backendFactory, cursorLifecycle: fake.cursorLifecycle });
      },
    }, resources.persona, coordinationDir);
    return target;
  }
  register();
  const execute = (params, signal, onUpdate) => runtime.tools.get("subagent").execute("observer-call", params, signal, onUpdate, context);
  return { home, coordinationDir, config, project, manager, managerSession, parentSession, resources, runtime, fake, context, factoryOptions, register, execute };
}

async function recordSnapshot(f) {
  const result = [];
  async function visit(path) {
    if (relative(f.coordinationDir, path) === join(".hari", "sessions")) return;
    const info = await stat(path, { bigint: true });
    if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await visit(join(path, name));
    } else {
      result.push({ path, size: info.size, mtime: info.mtimeNs, hash: createHash("sha256").update(await readFile(path)).digest("hex") });
    }
  }
  await visit(f.coordinationDir);
  await visit(f.managerSession);
  return result;
}

function createInput(overrides = {}) {
  return { action: "create", name: "session-observer", persona: OBSERVER_PERSONA, purpose: "Inspect the selected synthetic manager", ...overrides };
}

function contextPacket(f) {
  return `Project ${f.project.id}; manager ${f.manager.id}; inspect the synthetic handoff only; return cited observations.`;
}

async function assertNoManagerEffects(f, before) {
  assert.deepEqual(await recordSnapshot(f), before);
  assert.deepEqual(f.runtime.unexpected, []);
  assert.deepEqual(f.fake.calls.cursor, []);
}

test("configured observer resources require the restore capability without changing settings", async (t) => {
  const f = await fixture(t);
  const before = await recordSnapshot(f);
  assert.equal(f.resources.module.default, subagents.default);
  assert.equal(f.resources.persona.name, OBSERVER_PERSONA);
  assert.deepEqual(f.resources.persona.extensions, [OBSERVER_POLICY_PATH]);
  assert.deepEqual(f.resources.persona.skills, []);
  assert.equal(f.factoryOptions[0].personaDirectory, OBSERVER_PERSONA_DIRECTORY);
  assert.equal(typeof f.factoryOptions[0].validateRestoredSubagent, "function");
  const oldRoot = join(f.home, "old-checkout", "extensions");
  await mkdir(join(oldRoot, "subagents"), { recursive: true });
  await writeFile(join(oldRoot, "subagents", "index.ts"), "export default function() {}\nexport function loadSubagentPersonas() { throw new Error('must not discover an old factory'); }\n");
  await assert.rejects(loadSessionObserverResources({ version: 1, workspaceLauncher: join(oldRoot, "workspace", "launcher.ts") }), /lacks validateRestoredSubagent/);
  assert.throws(() => registerSessionObserver(f.runtime.api, { ...subagents, SUBAGENT_EXTENSION_CAPABILITIES: {} }, f.resources.persona, f.coordinationDir), CoordinationError);
  assert.deepEqual(f.fake.calls.construct, []);
  await assertNoManagerEffects(f, before);
});

test("adapter rejects workers, Cloud, forks, and selected skills before native creation", async (t) => {
  const f = await fixture(t);
  const before = await recordSnapshot(f);
  await f.runtime.emit("session_start", {}, f.context);
  for (const request of [
    createInput({ persona: undefined }), createInput({ persona: "worker" }),
    createInput({ persona: undefined, runtime: "cursor-cloud" }), createInput({ runtime: "cursor-cloud" }),
    createInput({ mode: "fork" }), createInput({ skills: ["write-code"] }),
  ]) await assert.rejects(f.execute(request), CoordinationError);
  for (const context of [
    { ...f.context, cwd: f.home },
    { ...f.context, sessionManager: { ...f.context.sessionManager, getSessionFile: () => undefined } },
    { ...f.context, sessionManager: { ...f.context.sessionManager, getSessionFile: () => f.managerSession } },
  ]) await assert.rejects(f.runtime.tools.get("subagent").execute("wrong-parent", createInput(), undefined, undefined, context), CoordinationError);
  assert.deepEqual(f.runtime.appended, []);
  assert.deepEqual(f.fake.calls.construct, []);
  assert.deepEqual(f.runtime.commands, []);
  assert.deepEqual(f.runtime.shortcuts, []);
  const personas = await f.execute({ action: "list", kind: "personas" });
  assert.equal(personas.details.ok, true);
  assert.deepEqual(personas.details.personas.map(({ name, runtime }) => ({ name, runtime })), [{ name: OBSERVER_PERSONA, runtime: "pi" }]);
  const created = await f.execute(createInput({ runtime: "pi", mode: "fresh", skills: [] }));
  assert.equal(created.details.ok, true);
  assert.equal(created.details.subagent.lifetime, "task");
  assert.equal(created.details.subagent.status, "dormant");
  assert.equal(created.details.subagent.runtime, "pi");
  assert.equal(created.details.subagent.persona, OBSERVER_PERSONA);
  assert.deepEqual(f.fake.calls.construct, []);
  await assertNoManagerEffects(f, before);
});

test("exact target actions reuse a task while list, status, reload, and shutdown do not prompt it", async (t) => {
  const f = await fixture(t);
  const before = await recordSnapshot(f);
  await f.runtime.emit("session_start", {}, f.context);
  const created = await f.execute(createInput());
  const { id, name } = created.details.subagent;
  const list = await f.execute({ action: "list" });
  assert.deepEqual(list.details.subagents, [created.details.subagent]);
  for (const action of ["prompt", "status", "stop"]) {
    for (const target of [id.slice(0, -1), name.slice(0, -1), ` ${id}`, "missing-observer"]) {
      await assert.rejects(f.execute({ action, id: target, ...(action === "prompt" ? { prompt: "Do not send" } : {}) }), /exact ID or name/);
    }
  }
  const status = await f.execute({ action: "status", id: name });
  assert.equal(status.details.subagent.status, "dormant");
  assert.deepEqual(f.fake.calls.construct, []);
  const progress = [];
  const first = await f.execute({ action: "prompt", id, prompt: "Inspect the handoff", context: contextPacket(f) }, undefined, (update) => progress.push(update));
  assert.equal(first.details.ok, true);
  assert.equal(first.details.subagent.id, id);
  assert.equal(first.details.subagent.lifetime, "task");
  assert.ok(progress.every((update) => update.details.subagent.id === id));
  const followUp = await f.execute({ action: "prompt", id: name, prompt: "State the evidence limits" });
  assert.equal(followUp.details.subagent.id, id);
  assert.equal(f.fake.calls.construct.length, 1);
  assert.equal(f.fake.calls.prompt.length, 2);
  assert.deepEqual(f.fake.calls.prompt.map(({ backendId }) => backendId), [0, 0]);
  const child = f.fake.calls.construct[0];
  assert.equal(child.cwd, f.coordinationDir);
  assert.ok(child.args.includes(OBSERVER_POLICY_PATH));
  assert.ok(child.args.includes("--no-extensions"));
  assert.ok(!child.args.includes("--fork"));
  const duplicate = await f.execute(createInput({ name: "duplicate-observer" }));
  assert.equal(duplicate.details.ok, false);
  assert.equal((await f.execute({ action: "list" })).details.subagents.length, 1);
  await f.runtime.emit("session_tree", {}, f.context);
  assert.equal(f.fake.calls.stop.length, 1);
  assert.equal(f.fake.calls.prompt.length, 2);
  assert.equal(f.fake.calls.construct.length, 1);
  const restored = await f.execute({ action: "status", id });
  assert.equal(restored.details.subagent.status, "dormant");
  assert.equal(restored.details.subagent.lifetime, "task");
  await f.runtime.emit("session_shutdown", {}, f.context);
  assert.equal(f.fake.calls.prompt.length, 2);
  const reloaded = f.register(extensionApi());
  reloaded.branch.push(...structuredClone(f.runtime.branch));
  const reloadedContext = { ...f.context, sessionManager: { ...f.context.sessionManager, getBranch: () => reloaded.branch } };
  await reloaded.emit("session_start", {}, reloadedContext);
  assert.equal(f.fake.calls.construct.length, 1);
  const tool = reloaded.tools.get("subagent");
  const resumed = await tool.execute("follow-up", { action: "prompt", id, prompt: "Continue the selected observation" }, undefined, undefined, reloadedContext);
  assert.equal(resumed.details.ok, true);
  assert.equal(resumed.details.subagent.id, id);
  assert.equal(f.fake.calls.construct.length, 2);
  assert.equal(f.fake.calls.prompt.length, 3);
  const stopped = await tool.execute("stop", { action: "stop", id: name }, undefined, undefined, reloadedContext);
  assert.equal(stopped.details.ok, true);
  assert.equal(stopped.details.subagent.status, "stopped");
  const cannotPrompt = await tool.execute("stopped-prompt", { action: "prompt", id, prompt: "Do not restart" }, undefined, undefined, reloadedContext);
  assert.equal(cannotPrompt.details.ok, false);
  assert.equal(f.fake.calls.prompt.length, 3);
  await reloaded.emit("session_shutdown", {}, reloadedContext);
  await assertNoManagerEffects(f, before);
});

for (const badKind of ["missing-persona", "malformed-policy", "wrong-policy", "fork", "skills", "outside-session", "cursor-receipt"]) {
  test(`restore blocks ${badKind} before allowed records, receipts, or branch mutations`, async (t) => {
    const f = await fixture(t);
    const before = await recordSnapshot(f);
    const created = await f.execute(createInput());
    const allowed = structuredClone(f.runtime.appended.at(-1).data.upserts[0]);
    const bad = { ...structuredClone(allowed), id: "sa_bad", name: "bad-observer" };
    if (badKind === "missing-persona") delete bad.persona;
    if (badKind === "malformed-policy") bad.persona.extensions = [42];
    if (badKind === "wrong-policy") bad.persona.extensions = [join(f.home, "write-policy.ts")];
    if (badKind === "fork") { bad.mode = "fork"; bad.parentSessionFile = f.parentSession; }
    if (badKind === "skills") bad.selectedSkillPaths = [join(f.home, "write-skill", "SKILL.md")];
    if (badKind === "outside-session") bad.sessionFile = join(f.home, "unrelated.jsonl");
    if (badKind === "cursor-receipt") Object.assign(bad, {
      runtime: "cursor-cloud", persona: undefined, lifetime: "one-shot", agentId: "bc-incompatible", remoteCreated: true,
      currentRunId: "run-incompatible", repositories: [], pendingOperations: [], remoteLifecycle: "idle",
      pendingResult: { state: "available", runId: "run-incompatible" },
    });
    const receipt = { version: 1, subagentId: bad.id, runId: "run-incompatible", archiveAfterDelivery: true };
    f.runtime.branch.splice(0, f.runtime.branch.length, {
      type: "custom", customType: "persistent-subagents",
      data: { version: 3, ownerSessionId: "observer-parent", upserts: [allowed], removedIds: [] },
    }, {
      type: "message", message: { role: "toolResult", toolName: "subagent", details: {
        [registryKey]: { version: 3, ownerSessionId: "observer-parent", upserts: [bad], removedIds: [] }, [receiptKey]: receipt,
      } },
    });
    const savedBranch = structuredClone(f.runtime.branch);
    const appendCount = f.runtime.appended.length;
    await f.runtime.emit("session_start", {}, f.context);
    assert.equal(f.runtime.notices.length, 1);
    assert.equal(f.runtime.notices[0].level, "error");
    const [guard] = await f.runtime.emit("tool_call", { toolName: "subagent", input: { action: "list" } }, f.context);
    assert.equal(guard.block, true);
    for (const input of [createInput(), { action: "list" }, ...["prompt", "status", "stop"].map((action) => ({ action, id: created.details.subagent.id, prompt: "Do not send" }))]) {
      await assert.rejects(f.execute(input), CoordinationError);
    }
    await f.runtime.emit("turn_end", { toolResults: [{ toolName: "subagent", details: { [receiptKey]: receipt } }] }, f.context);
    await f.runtime.emit("session_shutdown", {}, f.context);
    assert.deepEqual(f.runtime.branch, savedBranch);
    assert.equal(f.runtime.appended.length, appendCount);
    assert.deepEqual(f.fake.calls.construct, []);
    assert.deepEqual(f.fake.calls.prompt, []);
    await assertNoManagerEffects(f, before);
  });
}

for (const outcome of [
  { name: "runtime failure", response: { error: "Synthetic backend failure" }, errorCode: "SUBAGENT_FAILED" },
  { name: "terminal error", response: { text: "Partial observation", stopReason: "error", errorMessage: "Synthetic terminal failure" }, errorCode: "SUBAGENT_FAILED" },
  { name: "cancellation", cancel: true, errorCode: "CANCELLED" },
  { name: "output limit", response: { text: "Partial observation", stopReason: "length" }, retained: true },
  { name: "handled without response", response: { handled: true }, retained: true },
  { name: "oversized response", response: { text: "OVERSIZED_REPORT_START\n" + "x".repeat(subagents.MAX_SUBAGENT_RESPONSE_BYTES + 100) }, retained: true, oversized: true },
  { name: "blocker", response: { text: "BLOCKED: Synthetic evidence is missing\nNEEDS: The selected evidence page" }, retained: true, blocked: true },
]) {
  test(`adapter preserves native ${outcome.name} and one-shot retention outcomes`, async (t) => {
    const f = await fixture(t);
    const before = await recordSnapshot(f);
    await f.runtime.emit("session_start", {}, f.context);
    if (outcome.response) f.fake.responses.push(outcome.response);
    const abort = new AbortController();
    if (outcome.cancel) abort.abort(new Error("Synthetic cancellation"));
    const result = await f.execute(createInput({ lifetime: "one-shot", prompt: "Inspect synthetic evidence", context: contextPacket(f) }), abort.signal);
    const list = await f.execute({ action: "list" });
    assert.equal(list.details.subagents.length, 1);
    const stored = list.details.subagents[0];
    if (outcome.errorCode) {
      assert.equal(result.details.ok, false);
      assert.equal(result.details.error.code, outcome.errorCode);
      assert.equal(stored.status, "stopped");
      if (outcome.cancel) assert.deepEqual(f.fake.calls.prompt, []);
    } else {
      assert.equal(result.details.ok, true);
      assert.equal(result.details.subagent.id, stored.id);
      assert.equal(stored.lifetime, "task");
      assert.notEqual(stored.status, "stopped");
      if (outcome.blocked) {
        assert.equal(stored.status, "blocked");
        assert.deepEqual(stored.blocker, { reason: "Synthetic evidence is missing", need: "The selected evidence page" });
      }
      if (outcome.oversized) {
        assert.ok(Buffer.byteLength(result.content[0].text) <= subagents.MAX_SUBAGENT_RESPONSE_BYTES);
        assert.doesNotMatch(result.content[0].text, /OVERSIZED_REPORT_START/);
      }
      if (outcome.response?.handled) {
        const missingContext = await f.execute({ action: "prompt", id: stored.id, prompt: "Do not assume context delivery" });
        assert.equal(missingContext.details.ok, false);
        assert.equal(missingContext.details.error.code, "SUBAGENT_FAILED");
        assert.match(missingContext.details.error.message, /requires context before its first parent prompt/);
        assert.equal(f.fake.calls.prompt.length, 1);
      }
      const followUp = await f.execute({
        action: "prompt", id: stored.id, prompt: "Give the next bounded observation",
        ...(outcome.response?.handled ? { context: contextPacket(f) } : {}),
      });
      assert.equal(followUp.details.ok, true);
      assert.equal(followUp.details.subagent.id, stored.id);
      assert.equal(followUp.details.subagent.lifetime, "task");
      assert.equal(followUp.details.subagent.blocker, undefined);
    }
    await f.runtime.emit("session_shutdown", {}, f.context);
    await assertNoManagerEffects(f, before);
  });
}

test("observer policy permits only evidence and blocks inactive mutators and user_bash with inherited Hari role", async (t) => {
  const f = await fixture(t);
  const before = await recordSnapshot(f);
  const child = extensionApi();
  const mutations = [];
  for (const name of ["write", "edit", "bash", "git", "gh", "subagent", "create_workspace", "hari_capture_inbox", "hari_create_manager"]) {
    child.api.registerTool({ name, exposure: "codemode", execute() { mutations.push(name); } });
  }
  observerPolicy(child.api);
  assert.equal(process.env.HARI_ROLE, "hari");
  assert.equal(child.tools.get("hari_create_manager").exposure, "codemode");
  assert.deepEqual(child.commands, []);
  assert.deepEqual(child.shortcuts, []);
  await child.emit("session_start", {}, f.context);
  assert.deepEqual(child.active, [evidenceTool]);
  child.api.setActiveTools(["write", "bash"]);
  const event = { systemPromptOptions: { contextFiles: [{ path: "inherited-AGENTS.md", content: "Do not deliver this ambient context" }], skills: [] } };
  await child.emit("before_agent_start", event, f.context);
  assert.deepEqual(child.active, [evidenceTool]);
  assert.deepEqual(event.systemPromptOptions.contextFiles, []);
  const allowed = await child.emit("tool_call", { toolName: evidenceTool, input: { project: f.project.id, manager: f.manager.id } }, f.context);
  assert.deepEqual(allowed, [undefined]);
  for (const name of [...child.tools.keys()].filter((name) => name !== evidenceTool).concat(["read", "hari_update_project", "unknown_tool"])) {
    assert.equal(child.active.includes(name), false);
    const [blocked] = await child.emit("tool_call", { toolName: name, input: {} }, f.context);
    assert.equal(blocked.block, true, `${name} must stay blocked when inactive`);
  }
  const [shell] = await child.emit("user_bash", { command: "touch forbidden", excludeFromContext: false }, f.context);
  assert.equal(shell.result.exitCode, 1);
  assert.equal(shell.result.cancelled, false);
  assert.equal(shell.result.truncated, false);
  assert.deepEqual(mutations, []);
  assert.deepEqual(child.unexpected, []);
  const tool = child.tools.get(evidenceTool);
  const page = await tool.execute("evidence", { project: f.project.id, manager: f.manager.id });
  assert.equal(page.details.path, f.managerSession);
  assert.equal(page.details.eof, true);
  assert.match(page.details.view, /^hari-session-evidence-v1:[a-f0-9]{64}$/);
  assert.match(page.content[0].text, /"id":"manager-request"/);
  const cancelled = new AbortController();
  cancelled.abort(new Error("Synthetic evidence cancellation"));
  await assert.rejects(tool.execute("cancel", { project: f.project.id, manager: f.manager.id }, cancelled.signal), /Synthetic evidence cancellation/);
  await assert.rejects(tool.execute("wrong-manager", { project: f.project.id, manager: "unbound-manager" }), /Unknown manager/);
  await assert.rejects(tool.execute("path", { project: f.project.id, manager: f.manager.id, path: f.managerSession }), /not an arbitrary path/);
  assert.deepEqual(child.appended, []);
  await assertNoManagerEffects(f, before);
});
