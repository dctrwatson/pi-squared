import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bundleLoader from "../../extensions/bundle-loader.ts";
import { getBundleState, shutdownSession, startSession } from "../../extensions/bundle-loader/state.ts";

const freshState = () => ({ selections: new Map(), activeTools: [] });

test("selection stays process-local and reload requires the same session identity", () => {
  for (const reason of ["startup", "new", "resume", "fork", "reload"]) {
    const state = freshState();
    startSession(state, "source", "startup");
    state.selections.set("sample", { manifestPath: "/sample.json", status: "loaded" });
    shutdownSession(state, "source", "reload", ["read"]);
    startSession(state, reason === "reload" ? "other" : "source", reason);
    assert.equal(state.selections.size, 0, `${reason} clears the selection`);
  }
  const state = freshState();
  startSession(state, "source", "startup");
  state.selections.set("sample", { manifestPath: "/sample.json", status: "loaded" });
  shutdownSession(state, "unrelated", "new", []);
  assert.equal(state.selections.size, 1, "an unrelated session cannot clear this selection");
  shutdownSession(state, "source", "reload", ["read", "late"]);
  startSession(state, "source", "reload");
  assert.equal(state.selections.size, 1);
  assert.deepEqual(state.activeTools, ["read", "late"]);
  for (const reason of ["new", "resume", "fork", "quit"]) {
    state.sessionIdentity = "source";
    state.selections.set("sample", { status: "loaded" });
    shutdownSession(state, "source", reason, []);
    assert.equal(state.selections.size, 0, `${reason} clears before replacement`);
    assert.equal(state.sessionIdentity, undefined);
  }
});

async function fixture(t, { registrationFailure = false, quarantineFailure = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-bundle-state-"));
  const agent = join(root, "agent");
  await mkdir(agent);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    getBundleState().selections.clear();
    await rm(root, { recursive: true, force: true });
  });
  const adapter = join(root, "adapter.ts");
  await writeFile(adapter, `export async function createBundle() { return { tools: ["one", "two"].map(name => ({
    name, label: name, description: "Test tool", parameters: {type: "object", properties: {}},
    execute: async () => ({content: [], details: undefined})
  })) }; }`);
  const manifest = join(root, "manifest.json");
  await writeFile(manifest, JSON.stringify({ version: 1, adapter }));
  await writeFile(join(agent, "bundle-loader.json"), JSON.stringify({ bundles: { sample: manifest } }));
  const handlers = new Map();
  const commands = new Map();
  const tools = new Map([["read", { name: "read", exposure: "direct" }], ["tool_search", { name: "tool_search", exposure: "model-only" }]]);
  const attempts = [];
  let activeTools = ["read"];
  let id = "session";
  let shutdown = false;
  const notifications = [];
  const ctx = {
    sessionManager: { getSessionId: () => id, getSessionFile: () => undefined },
    hasUI: false,
    ui: { notify: (...args) => notifications.push(args) },
    shutdown: () => { shutdown = true; },
    waitForIdle: async () => {},
    reload: async () => {},
  };
  const pi = {
    on: (event, handler) => handlers.set(event, handler),
    registerCommand: (name, command) => commands.set(name, command),
    getCommands: () => [],
    getAllTools: () => [...tools.values()],
    getActiveTools: () => [...activeTools],
    setActiveTools: (names) => { activeTools = names.filter((name) => tools.has(name) && tools.get(name).exposure !== "hidden"); },
    registerTool(tool) {
      tools.set(tool.name, tool);
      attempts.push(tool);
      activeTools = activeTools.filter((name) => tools.get(name)?.exposure !== "hidden");
      if ((registrationFailure && tool.name === "two" && tool.exposure !== "hidden") || (quarantineFailure && tool.exposure === "hidden")) {
        throw new Error("synthetic registration failure after mutation");
      }
    },
  };
  bundleLoader(pi);
  await handlers.get("session_start")({ reason: "startup" }, ctx);
  return { root, ctx, handlers, commands, tools, attempts, notifications, setId: (value) => { id = value; }, isShutdown: () => shutdown };
}

test("the command waits for idle and does not reuse the context after reload", async (t) => {
  const f = await fixture(t);
  const command = f.commands.get("bundle");
  assert.deepEqual(command.getArgumentCompletions("s"), [{ value: "sample", label: "sample" }]);
  await command.handler("unknown", f.ctx);
  assert.match(f.notifications.at(-1)[0], /Unknown bundle/);
  assert.equal(f.attempts.length, 0);
  let idle = false;
  let reloaded = false;
  f.ctx.waitForIdle = async () => { idle = true; };
  f.ctx.reload = async () => {
    assert.equal(idle, true);
    assert.equal(getBundleState().selections.get("sample").status, "pending");
    reloaded = true;
    Object.defineProperty(f.ctx, "ui", { get() { throw new Error("stale context"); } });
  };
  await command.handler("sample", f.ctx);
  assert.equal(reloaded, true);
});

test("session identity guards pending activation across the idle wait", async (t) => {
  const f = await fixture(t);
  let reloaded = false;
  f.ctx.waitForIdle = async () => { f.setId("replacement"); };
  f.ctx.reload = async () => { reloaded = true; };
  await f.commands.get("bundle").handler("sample", f.ctx);
  assert.equal(reloaded, false);
  assert.equal(getBundleState().selections.size, 0);
});

test("an unexpected partial registration is gated, hidden, failed, and retriable", async (t) => {
  const f = await fixture(t, { registrationFailure: true });
  const command = f.commands.get("bundle");
  await command.handler("sample", f.ctx);
  await f.handlers.get("session_start")({ reason: "reload" }, f.ctx);
  assert.equal(getBundleState().selections.get("sample").status, "failed");
  assert.match(f.notifications.at(-1)[0], /failed at registration/);
  assert.deepEqual(await f.handlers.get("resources_discover")({}, f.ctx), { skillPaths: [] });
  assert.equal(f.tools.get("one").exposure, "hidden");
  assert.equal(f.tools.get("two").exposure, "hidden");
  const original = f.attempts.find((tool) => tool.name === "one" && tool.exposure !== "hidden");
  await assert.rejects(original.execute("id", {}, undefined, undefined, f.ctx), /not active/);
  assert.equal(f.handlers.get("tool_call")({ toolName: "one" }).block, true);
  assert.equal(f.handlers.get("tool_call")({ toolName: "read" }), undefined);
  assert.equal(f.isShutdown(), false);
  await command.handler("", f.ctx);
  assert.match(f.notifications.at(-1)[0], /sample · failed/);
  await command.handler("sample", f.ctx);
  assert.equal(getBundleState().selections.get("sample").status, "pending");
});

test("quarantine failure requests shutdown and keeps execution gates closed", async (t) => {
  const f = await fixture(t, { registrationFailure: true, quarantineFailure: true });
  await f.commands.get("bundle").handler("sample", f.ctx);
  await f.handlers.get("session_start")({ reason: "reload" }, f.ctx);
  assert.equal(f.isShutdown(), true);
  assert.equal(getBundleState().selections.get("sample").status, "failed");
  const original = f.attempts.find((tool) => tool.name === "two" && tool.exposure !== "hidden");
  await assert.rejects(original.execute("id", {}, undefined, undefined, f.ctx), /not active/);
});
