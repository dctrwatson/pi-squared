import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { AgentToolAvailability, OPTIONAL_AGENT_TOOL_NAMES } from "../../extensions/agent-tools/availability.ts";
import { findGh, createAgentGhTool } from "../../extensions/agent-tools/gh.ts";
import { createAskUserTool } from "../../extensions/agent-tools/ask-user.ts";
import { selectWebSearchModel } from "../../extensions/agent-tools/web-search.ts";
import agentTools, { AGENT_TOOL_NAMES } from "../../extensions/agent-tools/index.ts";

const codex = (id = "gpt-6-luna") => ({ provider: "openai-codex", id, api: "openai-codex-responses", compat: { supportsAdditionalTools: true } });
const context = (cwd = process.cwd(), mode = "print", model, available = []) => ({
  cwd, mode, model, modelRegistry: { getAvailable: () => available },
  sessionManager: { getSessionId: () => "availability" },
});
function selection(names = ["write", "unrelated", ...OPTIONAL_AGENT_TOOL_NAMES]) {
  let active = [...names];
  const applied = [];
  return {
    applied,
    api: { getActiveTools: () => [...active], setActiveTools: (names) => { applied.push([...names]); active = [...names]; } },
    disable: (name) => { active = active.filter((entry) => entry !== name); },
  };
}
function preservePath(t) {
  const path = process.env.PATH;
  t.after(() => { if (path === undefined) delete process.env.PATH; else process.env.PATH = path; });
}
async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-availability-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("optional registration starts hidden and never changes active membership", () => {
  const tools = new Map();
  const handlers = new Map();
  const state = selection(["write", "unrelated"]);
  agentTools({ ...state.api, registerTool: (tool) => tools.set(tool.name, tool), on: (event, handler) => handlers.set(event, handler) });
  assert.equal(state.applied.length, 0);
  assert.deepEqual([...tools.keys()].sort(), [...AGENT_TOOL_NAMES].sort());
  for (const name of OPTIONAL_AGENT_TOOL_NAMES) {
    const tool = tools.get(name);
    assert.equal(tool.defaultActive, true);
    assert.equal(tool.exposure, name === "ask_user" ? "model-only" : "direct");
    assert.deepEqual(tool.prepareLoadout({}), { hiddenDeclarations: [name] });
  }
  for (const name of ["read", "find", "grep", "bash", "git"]) assert.equal(tools.get(name).prepareLoadout, undefined);
  assert.equal(createAskUserTool().exposure, "model-only");
  assert.ok(handlers.has("model_select"));
  assert.ok(handlers.has("before_agent_start"));
  assert.ok(AGENT_TOOL_NAMES.includes("bash_job"));
});

test("findGh accepts only regular executable PATH candidates without running them", async (t) => {
  const root = await directory(t);
  const bad = join(root, "bad");
  const good = join(root, "good");
  await mkdir(bad);
  await mkdir(good);
  const file = join(good, "gh");
  await writeFile(file, "#!/bin/sh\nprintf should-not-run > executed\n", { mode: 0o600 });
  await assert.rejects(findGh({ PATH: good }, root), (error) => error.code === "EXECUTABLE_NOT_FOUND");
  await chmod(file, 0o700);
  await mkdir(join(bad, "gh"));
  assert.equal(await findGh({ PATH: [bad, good].join(delimiter) }, root), file);
  assert.equal(await findGh({ PATH: "good" }, root), file);
  assert.equal(await findGh({ PATH: `${delimiter}missing` }, good), file);
  await symlink(file, join(bad, "gh-link"));
  await rm(join(bad, "gh"), { recursive: true });
  await symlink(file, join(bad, "gh"));
  assert.equal(await findGh({ PATH: bad }, root), join(bad, "gh"));
  for (const PATH of [undefined, ""]) await assert.rejects(findGh({ PATH }, root), (error) => error.code === "EXECUTABLE_NOT_FOUND");
  const { access } = await import("node:fs/promises");
  await assert.rejects(access(join(root, "executed")));
});

test("gh cache retains positive, negative, and pending checks by exact PATH and cwd", async (t) => {
  preservePath(t);
  const state = selection();
  const calls = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const cache = new AgentToolAvailability(state.api, () => 0, async (env, cwd) => {
    calls.push([env.PATH, cwd]);
    if (env.PATH === "pending") await gate;
    if (env.PATH === "missing" || env.PATH === undefined || env.PATH === "") throw new Error("not found");
    return "/fixture/gh";
  });
  process.env.PATH = "pending";
  const first = cache.refresh(context("/one"));
  const second = cache.refresh(context("/one"));
  await Promise.resolve();
  assert.deepEqual(calls, [["pending", "/one"]]);
  release();
  await Promise.all([first, second]);
  assert.equal(cache.isAvailable("gh"), true);
  await cache.refresh(context("/one"));
  assert.equal(calls.length, 1);
  process.env.PATH = "missing";
  await cache.refresh(context("/one"));
  await cache.refresh(context("/one"));
  assert.equal(cache.isAvailable("gh"), false);
  assert.equal(calls.length, 2);
  await cache.refresh(context("/two"));
  assert.equal(calls.length, 3);
  delete process.env.PATH;
  await cache.refresh(context("/two"));
  process.env.PATH = "";
  await cache.refresh(context("/two"));
  assert.deepEqual(calls.slice(-2), [[undefined, "/two"], ["", "/two"]]);
  assert.ok(state.applied.every((names) => names.join() === state.api.getActiveTools().join()));
});

test("cached gh availability cannot bypass the execution-time executable check", async (t) => {
  preservePath(t);
  const root = await directory(t);
  const path = join(root, "gh");
  await writeFile(path, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  process.env.PATH = root;
  const cache = new AgentToolAvailability(selection().api, () => 0);
  await cache.refresh(context(root));
  assert.equal(cache.isAvailable("gh"), true);
  await rm(path);
  await mkdir(path);
  await cache.refresh(context(root));
  assert.equal(cache.isAvailable("gh"), true);
  const result = await createAgentGhTool().execute("stale", { args: ["--version"] }, undefined, undefined, context(root));
  assert.equal(result.isError, true);
  assert.equal(result.details.error.code, "EXECUTABLE_NOT_FOUND");
});

test("mode and available-model refreshes use the execution selector and preserve disabled names", async () => {
  const state = selection(["write", "unrelated"]);
  const cache = new AgentToolAvailability(state.api, () => 0, async () => { throw new Error("absent"); });
  const fallback = codex("gpt-5.6-luna");
  const active = { ...codex("custom"), marker: "stale" };
  const availableActive = { ...active, marker: "available" };
  for (const mode of ["tui", "print", "json", "rpc"]) {
    await cache.refresh(context(process.cwd(), mode, active, [availableActive]));
    assert.equal(cache.isAvailable("ask_user"), mode === "tui");
    assert.equal(cache.isAvailable("web_search"), true);
    assert.strictEqual(selectWebSearchModel(context(process.cwd(), mode, active, [availableActive])), availableActive);
  }
  for (const [model, available, enabled] of [
    [active, [], false], [active, [fallback], true], [{ provider: "anthropic", id: "other" }, [fallback], true],
    [codex(), [{ ...codex(), compat: {} }], false], [undefined, [], false],
  ]) {
    await cache.refresh(context(process.cwd(), "print", model, available));
    assert.equal(cache.isAvailable("web_search"), enabled);
  }
  assert.ok(state.applied.every((names) => names.join() === "write,unrelated"));
});

test("registry count callbacks are synchronous and independent of pending lifecycle checks", async (t) => {
  preservePath(t);
  const state = selection();
  let count = 0;
  let release;
  let modelReads = 0;
  const calls = [];
  const gate = new Promise((resolve) => { release = resolve; });
  const cache = new AgentToolAvailability(state.api, () => count, async (env) => {
    calls.push(env.PATH);
    if (env.PATH === "first") await gate;
    return "/fixture/gh";
  });
  const firstContext = context();
  firstContext.modelRegistry.getAvailable = () => { modelReads++; return []; };
  process.env.PATH = "first";
  const first = cache.refresh(firstContext);
  process.env.PATH = "second";
  const second = cache.refresh(context(process.cwd(), "tui", codex(), [codex()]));
  await Promise.resolve();
  for (const value of [0, 1, 2, 1, 0]) {
    count = value;
    assert.equal(cache.onRetainedCountChange(count), undefined);
  }
  assert.equal(state.applied.length, 2);
  assert.equal(modelReads, 0);
  assert.deepEqual(calls, ["first"]);
  for (const name of OPTIONAL_AGENT_TOOL_NAMES) assert.equal(cache.isAvailable(name), false);
  count = 1;
  cache.onRetainedCountChange(count);
  state.disable("gh");
  release();
  await first;
  assert.equal(cache.isAvailable("bash_job"), true);
  await second;
  assert.equal(cache.isAvailable("ask_user"), true);
  assert.equal(cache.isAvailable("web_search"), true);
  assert.deepEqual(calls, ["first", "second"]);
  assert.ok(state.applied.slice(3).every((names) => !names.includes("gh")));
  assert.deepEqual(state.api.getActiveTools(), ["write", "unrelated", "ask_user", "web_search", "bash_job"]);
});

test("unavailable metadata uses empty tombstones without changing other run fields", async () => {
  const state = selection();
  const cache = new AgentToolAvailability(state.api, () => 0, async () => { throw new Error("absent"); });
  await cache.refresh(context());
  const options = {
    selectedTools: ["unrelated", ...OPTIONAL_AGENT_TOOL_NAMES],
    toolSnippets: Object.fromEntries(["unrelated", ...OPTIONAL_AGENT_TOOL_NAMES].map((name) => [name, `${name}-snippet`])),
    toolGuidelines: Object.fromEntries(["unrelated", ...OPTIONAL_AGENT_TOOL_NAMES].map((name) => [name, [`${name}-guideline`]])),
    promptGuidelines: ["earlier"], sections: { earlier: "section" }, appendSystemPrompt: "append",
  };
  const event = { systemPromptOptions: options };
  cache.suppressUnavailablePromptMetadata(event);
  assert.strictEqual(event.systemPromptOptions, options);
  assert.deepEqual(options.selectedTools, ["unrelated", ...OPTIONAL_AGENT_TOOL_NAMES]);
  for (const name of ["ask_user", "gh", "web_search", "bash_job"]) {
    assert.equal(options.toolSnippets[name], "");
    assert.deepEqual(options.toolGuidelines[name], []);
    assert.ok(Object.hasOwn(options.toolSnippets, name));
  }
  assert.equal(options.toolSnippets.unrelated, "unrelated-snippet");
  assert.deepEqual(options.toolGuidelines.unrelated, ["unrelated-guideline"]);
  assert.deepEqual(options.promptGuidelines, ["earlier"]);
  assert.deepEqual(options.sections, { earlier: "section" });
  assert.equal(options.appendSystemPrompt, "append");
});
