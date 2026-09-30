import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import hariExtension, { openManagerTerminal } from "../src/index.ts";
import { addManager, bindManagerSession, createProject, initializeCoordination, readInbox, readProject, replaceProjectItems } from "../src/coordination.ts";
import { initializeCoordinationRepository } from "../src/coordination-git.ts";
import { managerSystemPrompt } from "../src/context.ts";

function fakePi() {
  const handlers = new Map();
  const tools = new Map(["create_workspace", "launch_pi", "subagent"].map((name) => [name, { name }]));
  const active = [];
  const entries = [];
  const calls = [];
  return {
    handlers,
    tools,
    active,
    entries,
    calls,
    events: { emit() {} },
    on(name, handler) { handlers.set(name, handler); },
    registerTool(definition) { tools.set(definition.name, definition); },
    registerCommand() {},
    appendEntry(type, data) { entries.push({ type, data }); },
    getAllTools() { return [...tools.values()]; },
    setActiveTools(names) { active.splice(0, active.length, ...names); },
    exec: async (command, args) => { calls.push({ command, args }); return { code: 0, stdout: "", stderr: "" }; },
  };
}

function sessionContext(checkout, session) {
  return {
    cwd: checkout,
    sessionManager: { getSessionFile: () => session },
    ui: { setStatus() {}, notify() {}, confirm: async () => true },
  };
}

async function setupManager() {
  const home = await mkdtemp(join(tmpdir(), "hari-manager-extension-"));
  const coordination = join(home, "Projects", "primeradiant");
  const checkout = await mkdtemp(join(tmpdir(), "hari-manager-checkout-"));
  const session = join(checkout, "manager.jsonl");
  execFileSync("git", ["init", "-q", checkout]);
  await writeFile(join(checkout, "AGENTS.md"), "# Manager checkout\n- Preserve focused checks.\n");
  await writeFile(session, "{}\n");
  await initializeCoordination(coordination, {
    version: 1,
    workspaceLauncher: "/resources/workspace/launcher.ts",
  });
  const project = await createProject(coordination, { name: "Managed" });
  await addManager(coordination, project.id, {
    id: "manager",
    assignment: "Write a concise report",
    acceptanceCriteria: ["Report exists"],
    constraints: [],
    checkout,
    branch: "feature/managed",
  });
  await bindManagerSession(coordination, project.id, "manager", session);
  return { home, coordination, checkout, session, project };
}

async function managerHarness(t) {
  const fixture = await setupManager();
  const previous = { ...process.env };
  t.after(async () => {
    process.env = previous;
    await Promise.all([fixture.home, fixture.checkout].map((path) => rm(path, { recursive: true, force: true })));
  });
  Object.assign(process.env, { HOME: fixture.home, HARI_ROLE: "manager", HARI_PROJECT_ID: fixture.project.id, HARI_MANAGER_ID: "manager" });
  execFileSync("git", ["-C", fixture.checkout, "add", "."]);
  execFileSync("git", ["-C", fixture.checkout, "-c", "core.hooksPath=/dev/null", "-c", "user.name=Hari test", "-c", "user.email=hari@example.invalid", "-c", "commit.gpgSign=false", "commit", "-qm", "fixture"]);
  const pi = fakePi();
  hariExtension(pi);
  const ctx = sessionContext(fixture.checkout, fixture.session);
  await pi.handlers.get("session_start")({}, ctx);
  await pi.handlers.get("before_agent_start")({}, ctx);
  return { ...fixture, pi, ctx };
}

function managerContextToolResult(response, overrides = {}) {
  return {
    role: "toolResult",
    toolName: "manager_context",
    isError: false,
    details: response.details,
    content: response.content,
    ...overrides,
  };
}

async function makeManagerContextVisible(pi, ctx, response) {
  const event = { messages: [managerContextToolResult(response)] };
  const before = structuredClone(event);
  const outcome = await pi.handlers.get("context")(event, ctx);
  assert.equal(outcome, undefined, "Hari inspects context without returning a replacement");
  assert.deepEqual(event, before, "Hari inspects context without rewriting messages");
}

async function refreshManagerContext(pi, ctx) {
  const response = await pi.tools.get("manager_context").execute("refresh", {});
  await makeManagerContextVisible(pi, ctx, response);
  return response;
}

test("Hari role exposes narrow file-backed tools and makes the inbox writer durable", async () => {
  const home = await mkdtemp(join(tmpdir(), "hari-extension-"));
  const coordination = join(home, "Projects", "primeradiant");
  await initializeCoordination(coordination, {
    version: 1,
    workspaceLauncher: "/resources/workspace/launcher.ts",
  });
  await initializeCoordinationRepository(coordination);
  const previous = { ...process.env };
  process.env.HARI_ROLE = "hari";
  process.env.HOME = home;
  delete process.env.HARI_COORDINATION_DIR;
  try {
    const pi = fakePi();
    pi.tools.set("extra_tool", { name: "extra_tool" });
    hariExtension(pi);
    await pi.handlers.get("session_start")({}, { ui: { setStatus() {} } });
    assert.ok(pi.active.includes("hari_capture_inbox"));
    assert.ok(!pi.active.includes("extra_tool"), "Hari does not enable unrelated tools");
    assert.ok(!pi.active.includes("bash"));
    await pi.tools.get("hari_capture_inbox").execute("call", { text: "Remember this" });
    assert.equal((await readInbox(coordination)).items[0].text, "Remember this");
    assert.ok(pi.active.includes("hari_git"));
    const status = await pi.tools.get("hari_git").execute("status", { action: "status" });
    assert.match(status.content[0].text, /INBOX.md/);
    const checkpoint = await pi.tools.get("hari_git").execute("checkpoint", { action: "commit", message: "remember the note" });
    assert.match(checkpoint.content[0].text, /Created local coordination checkpoint/);
    assert.match(execFileSync("git", ["-C", coordination, "show", "HEAD:INBOX.md"], { encoding: "utf8" }), /Remember this/);
    const project = await createProject(coordination, { name: "Global manager" });
    await addManager(coordination, project.id, { id: "manager", assignment: "Use this store", acceptanceCriteria: ["Report"], constraints: [], checkout: home, branch: "feature/manager" });
    const launch = await pi.tools.get("hari_manager_launch").execute("launch", { project: project.id, manager: "manager" });
    assert.equal(launch.details.launched, false, "fixture has no Ghostty resource");
    assert.match(launch.details.command, /internal manager start/);
    assert.doesNotMatch(launch.details.command, /--coordination/);
  } finally {
    process.env = previous;
  }
});

test("Hari keeps a stable prompt while tools retrieve current coordination facts on demand", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "hari-stable-extension-"));
  const coordination = join(home, "Projects", "primeradiant");
  const previous = { ...process.env };
  t.after(async () => {
    process.env = previous;
    await rm(home, { recursive: true, force: true });
  });
  Object.assign(process.env, { HOME: home, HARI_ROLE: "hari" });
  await initializeCoordination(coordination, {
    version: 1,
    workspaceLauncher: "/resources/workspace/launcher.ts",
  });
  const pi = fakePi();
  hariExtension(pi);
  const ctx = sessionContext(coordination);
  await pi.handlers.get("session_start")({}, ctx);
  const event = {
    systemPrompt: "AMBIENT BASE MUST NOT SURVIVE",
    systemPromptOptions: {
      customPrompt: "AMBIENT CUSTOM PROMPT",
      appendSystemPrompt: ["AMBIENT APPENDED PROMPT"],
      contextFiles: [{ path: "/ambient/AGENTS.md", content: "AMBIENT CHECKOUT GUIDANCE" }],
      promptGuidelines: ["Use hari_projects for targeted record retrieval."],
      skills: [{ name: "coordination-reference", description: "Explicit coordination reference", filePath: "/explicit/coordination-reference/SKILL.md", baseDir: "/explicit/coordination-reference", source: "extension", disableModelInvocation: false }],
    },
  };
  const initial = await pi.handlers.get("before_agent_start")(event, ctx);
  assert.deepEqual(Object.keys(initial), ["systemPrompt"], "Hari does not inject a snapshot message");
  assert.doesNotMatch(initial.systemPrompt, /AMBIENT/);
  assert.match(initial.systemPrompt, /Use hari_projects for targeted record retrieval/);
  assert.match(initial.systemPrompt, /\/explicit\/coordination-reference\/SKILL.md/);

  const created = await pi.tools.get("hari_create_project").execute("create", { name: "Retrieved project", goal: "Retrieved project detail" });
  await pi.tools.get("hari_replace_index_items").execute("decision", { field: "decisions", items: ["First retrieved decision"] });
  const currentIndex = async () => JSON.parse((await pi.tools.get("hari_projects").execute("index", {})).content[0].text);
  const firstRead = await currentIndex();
  assert.equal(firstRead.projects[0].id, created.details.project.id);
  assert.deepEqual(firstRead.decisions, ["First retrieved decision"]);
  const project = await pi.tools.get("hari_projects").execute("project", { project: created.details.project.id });
  assert.equal(JSON.parse(project.content[0].text).goal, "Retrieved project detail");

  await pi.tools.get("hari_replace_index_items").execute("revision", { field: "decisions", items: ["Revised retrieved decision"] });
  const next = await pi.handlers.get("before_agent_start")(event, ctx);
  assert.deepEqual(next, initial);
  assert.doesNotMatch(next.systemPrompt, /Retrieved project|retrieved decision/);
  assert.deepEqual((await currentIndex()).decisions, ["Revised retrieved decision"]);
  assert.deepEqual(pi.entries, []);

  await writeFile(join(coordination, "PROJECTS.md"), "Invalid coordination record\n");
  assert.deepEqual(await pi.handlers.get("before_agent_start")(event, ctx), initial);
  await assert.rejects(currentIndex, "record errors surface on retrieval, not as a stale cached result");
});

test("Hari record pages expose provenance and continuation in model-visible content", async (t) => {
  const f = await managerHarness(t);
  process.env.HARI_ROLE = "hari";
  const pi = fakePi();
  hariExtension(pi);
  await pi.tools.get("hari_replace_index_items").execute("large-index", { field: "decisions", items: ["x".repeat(17_000)] });
  const index = await pi.tools.get("hari_projects").execute("index", {});
  assert.match(index.content[0].text, /first 16000 of \d+ characters shown/);
  assert.match(index.content[0].text, /hari_record_page\(kind: index, offset: 0\)/);

  const pageTool = pi.tools.get("hari_record_page");
  const path = join(f.coordination, "PROJECTS.md");
  const source = await readFile(path, "utf8");
  const chunks = [];
  let offset = 0;
  while (true) {
    const response = await pageTool.execute("page", { kind: "index", offset });
    const visible = response.content[0].text;
    const footerStart = visible.lastIndexOf("\n\n[");
    assert.ok(footerStart >= 0);
    const chunk = visible.slice(0, footerStart);
    assert.ok(chunk.length <= 16_000);
    chunks.push(chunk);
    const footer = visible.slice(footerStart);
    assert.ok(footer.includes(path));
    assert.ok(footer.includes(`offset=${offset}; chars=${chunk.length}; total=${source.length}`));
    const continuation = footer.match(/nextOffset=(\d+)/);
    if (!continuation) {
      assert.match(footer, /eof=true/);
      assert.equal(response.details.nextOffset, undefined);
      break;
    }
    offset = Number(continuation[1]);
    assert.equal(offset, response.details.nextOffset);
    assert.ok(offset < source.length);
  }
  assert.equal(chunks.join(""), source, "visible offsets recover the complete source, not the JSON preview");

  const beyond = await pageTool.execute("beyond", { kind: "index", offset: source.length + 1, limit: 5 });
  assert.match(beyond.content[0].text, /chars=0;.*eof=true/);
});

test("manager identity blocks native switching and gates changed authority until full manager_context delivery", async () => {
  const { home, coordination, checkout, session, project } = await setupManager();
  const previous = { ...process.env };
  process.env.HARI_ROLE = "manager";
  process.env.HOME = home;
  delete process.env.HARI_COORDINATION_DIR;
  process.env.HARI_PROJECT_ID = project.id;
  process.env.HARI_MANAGER_ID = "manager";
  try {
    const pi = fakePi();
    pi.tools.set("extra_tool", { name: "extra_tool" });
    hariExtension(pi);
    const ctx = sessionContext(checkout, session);
    await pi.handlers.get("session_start")({}, ctx);
    const started = await pi.handlers.get("before_agent_start")({}, ctx);
    assert.match(started.systemPrompt, /# Hari manager/);
    assert.ok(pi.active.includes("manager_report"));
    assert.ok(!pi.active.includes("extra_tool"), "manager does not enable unrelated tools");
    assert.ok(!pi.active.includes("hari_projects"));
    assert.ok(!pi.tools.has("hari_git"), "only Hari checkpoints the shared coordination repository");
    assert.equal(pi.entries.filter((entry) => entry.type === "hari-manager-identity").length, 1);
    assert.deepEqual(await pi.handlers.get("session_before_switch")({ reason: "new" }, ctx), { cancel: true });
    assert.deepEqual(await pi.handlers.get("session_before_fork")({ entryId: "entry", position: "at" }, ctx), { cancel: true });

    const initialBlock = await pi.handlers.get("tool_call")({ toolName: "bash", input: { command: "git status" } }, ctx);
    assert.equal(initialBlock.block, true);
    assert.match(initialBlock.reason, /Retrieve the full manager_context/);
    const initial = await pi.tools.get("manager_context").execute("call", {});
    await makeManagerContextVisible(pi, ctx, initial);
    assert.equal(await pi.handlers.get("tool_call")({ toolName: "bash", input: { command: "git status" } }, ctx), undefined);

    await replaceProjectItems(coordination, project.id, "blockers", ["New authority blocker"]);
    const blocked = await pi.handlers.get("tool_call")({ toolName: "bash", input: { command: "git status" } }, ctx);
    assert.equal(blocked.block, true);
    assert.match(blocked.reason, /Retrieve the full manager_context/);
    await assert.rejects(
      pi.tools.get("manager_report").execute("call", { result: "This cannot bypass refresh" }),
      /Retrieve the full manager_context/,
    );

    const refreshed = await pi.tools.get("manager_context").execute("call", {});
    assert.match(refreshed.content[0].text, /New authority blocker/);
    assert.doesNotMatch(refreshed.content[0].text, /paged here/);
    await makeManagerContextVisible(pi, ctx, refreshed);
    assert.equal(await pi.handlers.get("tool_call")({ toolName: "bash", input: { command: "git status" } }, ctx), undefined);
    const response = await pi.tools.get("manager_report").execute("call", { result: "Ready for manager review" });
    const path = response.details.path;
    assert.match(await readFile(path, "utf8"), /Ready for manager review/);
    assert.equal((await readProject(coordination, project.id)).managers[0].sessionIdentityConfirmedAt !== undefined, true);
  } finally {
    process.env = previous;
  }
});

test("manager reload rejects a mismatched native session before appending Hari identity", async () => {
  const { home, coordination, checkout, project } = await setupManager();
  const previous = { ...process.env };
  process.env.HARI_ROLE = "manager";
  process.env.HOME = home;
  delete process.env.HARI_COORDINATION_DIR;
  process.env.HARI_PROJECT_ID = project.id;
  process.env.HARI_MANAGER_ID = "manager";
  try {
    const pi = fakePi();
    hariExtension(pi);
    const wrongSession = join(checkout, "other.jsonl");
    await writeFile(wrongSession, "{}\n");
    const ctx = sessionContext(checkout, wrongSession);
    await pi.handlers.get("session_start")({ reason: "reload" }, ctx);
    assert.deepEqual(pi.entries, []);
    assert.deepEqual(pi.active, ["manager_context"]);
    const start = await pi.handlers.get("before_agent_start")({}, ctx);
    assert.match(start.systemPrompt, /runtime blocked/);
  } finally {
    process.env = previous;
  }
});

test("workspace creation requires an explicit project cwd outside global coordination", async (t) => {
  const f = await managerHarness(t);
  process.env.HARI_ROLE = "hari";
  const pi = fakePi();
  hariExtension(pi);
  const ctx = sessionContext(f.coordination, f.session);
  await pi.handlers.get("session_start")({}, ctx);
  await pi.handlers.get("before_agent_start")({}, ctx);
  assert.ok(pi.active.includes("create_workspace"));
  assert.ok(!pi.active.includes("launch_pi"));
  assert.ok(pi.active.includes("subagent"), "Hari keeps the observer tool in its explicit profile");
  const nested = join(f.coordination, "..hidden");
  await mkdir(nested);
  await mkdir(`${f.coordination} `);
  const link = join(f.home, "coordination-link");
  await symlink(f.coordination, link);
  const call = (cwd) => pi.handlers.get("tool_call")({ toolName: "create_workspace", input: { branch: "feature/new", ...(cwd ? { cwd } : {}) } }, ctx);
  for (const cwd of [undefined, ".", f.coordination, `${f.coordination} `, nested, link]) assert.equal((await call(cwd)).block, true, String(cwd));
  assert.equal(await call(f.checkout), undefined);
  const genericLaunch = await pi.handlers.get("tool_call")({ toolName: "launch_pi", input: { cwd: f.checkout } }, ctx);
  assert.match(genericLaunch.reason, /hari_manager_launch/);
  const nativeResult = { toolName: "create_workspace", content: [{ type: "text", text: "Native creation result" }], isError: false };
  const adapted = await pi.handlers.get("tool_result")(nativeResult, ctx);
  assert.deepEqual(adapted.content[0], nativeResult.content[0]);
  assert.match(adapted.content[1].text, /hari_manager_create.*Nothing has been launched/);
});

test("Hari PR discovery without a selected repository does not invoke GitHub", async (t) => {
  const f = await managerHarness(t);
  process.env.HARI_ROLE = "hari";
  const bin = join(f.home, "bin");
  const marker = join(f.home, "unexpected-gh");
  await mkdir(bin);
  const command = join(bin, "gh");
  await writeFile(command, `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "unexpected invocation");\nprocess.exit(1);\n`);
  await chmod(command, 0o755);
  process.env.PATH = [bin, process.env.PATH].join(delimiter);
  const pi = fakePi();
  hariExtension(pi);
  const result = await pi.tools.get("hari_discover_prs").execute("discovery", {});
  assert.deepEqual(result.details.discovery.items, []);
  assert.ok(result.details.discovery.warnings.some((warning) => /No repositories or tracked issues were selected/.test(warning)));
  await assert.rejects(readFile(marker), { code: "ENOENT" });
});

test("missing integration tools block either role instead of silently degrading", async (t) => {
  const f = await managerHarness(t);
  for (const role of ["hari", "manager"]) {
    process.env.HARI_ROLE = role;
    const pi = fakePi();
    pi.tools.delete(role === "hari" ? "create_workspace" : "subagent");
    hariExtension(pi);
    await pi.handlers.get("session_start")({}, f.ctx);
    assert.deepEqual(pi.active, role === "hari" ? [] : ["manager_context"]);
    assert.deepEqual(pi.entries, []);
    const prompt = await pi.handlers.get("before_agent_start")({}, f.ctx);
    assert.match(prompt.systemPrompt, /resource profile is incomplete/);
    assert.equal((await pi.handlers.get("tool_call")({ toolName: "read", input: { path: "README.md" } }, f.ctx)).block, true);
  }
});

test("helper dispatches carry fresh authority; lifecycle calls and returned source edits keep their boundaries", async (t) => {
  const f = await managerHarness(t);
  const gate = (input) => f.pi.handlers.get("tool_call")({ toolName: "subagent", input }, f.ctx);
  const dispatch = () => ({ action: "create", persona: "worker", prompt: "Update only source.txt", context: "Own source.txt; return focused test evidence." });
  assert.ok(f.pi.active.includes("subagent"));
  assert.ok(!f.pi.active.includes("create_workspace"));
  await replaceProjectItems(f.coordination, f.project.id, "decisions", ["New applicable decision"]);
  for (const input of [{ action: "create" }, { action: "list" }, { action: "status", id: "worker" }, { action: "stop", id: "worker" }]) {
    assert.equal(await gate(input), undefined);
    assert.equal(input.context, undefined);
  }
  const stale = dispatch();
  assert.match((await gate(stale)).reason, /manager_context/);
  assert.equal(stale.context, dispatch().context, "a blocked dispatch never mutates the input");
  await refreshManagerContext(f.pi, f.ctx);
  const ready = dispatch();
  assert.equal(await gate(ready), undefined);
  assert.match(ready.context, /New applicable decision/);
  assert.match(ready.context, /Own source.txt/);
  assert.match(ready.context, /not the issue manager/);
  assert.match(ready.context, /AGENTS.md/);
  assert.ok(ready.context.length <= 8000);
  const oversized = { ...dispatch(), context: "x".repeat(8000) };
  assert.match((await gate(oversized)).reason, /limit 8000/);
  assert.equal(oversized.context.length, 8000);

  const result = (input, ok = true) => f.pi.handlers.get("tool_result")({ toolName: "subagent", input, isError: false, details: { ok } }, f.ctx);
  await writeFile(join(f.checkout, "source.txt"), "child edit\n");
  await result(ready);
  assert.equal(await gate({ action: "prompt", id: "worker", prompt: "Inspect the returned edit" }), undefined);
  await replaceProjectItems(f.coordination, f.project.id, "decisions", ["Decision changed during child execution"]);
  await result(ready);
  assert.match((await gate(dispatch())).reason, /manager_context/);
  await refreshManagerContext(f.pi, f.ctx);
  await writeFile(join(f.checkout, "external.txt"), "external edit\n");
  await result({ action: "list" });
  assert.match((await gate(dispatch())).reason, /manager_context/, "a lifecycle query cannot accept source changes");
  await refreshManagerContext(f.pi, f.ctx);
  await writeFile(join(f.checkout, "failed.txt"), "failed child edit\n");
  await result(ready, false);
  assert.match((await gate(dispatch())).reason, /manager_context/, "a failed child requires explicit refresh after partial edits");
});

test("manager appends stable prompt text once and accepts only a complete visible manager_context result", async (t) => {
  const f = await managerHarness(t);
  const base = "Native coding base\nWorkspace extension prompt";
  const started = await f.pi.handlers.get("before_agent_start")({ systemPrompt: base }, f.ctx);
  assert.equal(started.systemPrompt, managerSystemPrompt(base));
  assert.match(started.systemPrompt, /^Native coding base\nWorkspace extension prompt\n\n# Hari manager/);
  assert.equal([...started.systemPrompt.matchAll(/# Hari manager/g)].length, 1);
  assert.doesNotMatch(started.systemPrompt, /Write a concise report/);
  assert.doesNotMatch(started.systemPrompt, /AGENTS\.md/);

  const gate = () => f.pi.handlers.get("tool_call")({ toolName: "bash", input: { command: "git status" } }, f.ctx);
  assert.match((await gate()).reason, /Retrieve the full manager_context/);
  const response = await f.pi.tools.get("manager_context").execute("refresh", {});
  assert.match(response.content[0].text, /Write a concise report/);
  assert.doesNotMatch(response.content[0].text, /# Hari manager/);
  assert.match((await gate()).reason, /Retrieve the full manager_context/, "a tool result is not delivered until it is visible in context");

  await makeManagerContextVisible(f.pi, f.ctx, response);
  assert.equal(await gate(), undefined);
  const invalid = [
    ["context loss", () => []],
    ["failed result", (accepted) => [managerContextToolResult(accepted, { isError: true })]],
    ["blocked result", (accepted) => [managerContextToolResult(accepted, { details: { ...accepted.details, blocked: "blocked" } })]],
    ["truncated result", (accepted) => [managerContextToolResult(accepted, { content: [{ type: "text", text: accepted.content[0].text.slice(0, -1) }] })]],
    ["mismatched signature", (accepted) => [managerContextToolResult(accepted, { details: { ...accepted.details, signature: "mismatched" } })]],
  ];
  for (const [label, messages] of invalid) {
    await f.pi.handlers.get("context")({ messages: messages(response) }, f.ctx);
    assert.match((await gate()).reason, /Retrieve the full manager_context/, `${label} invalidates an accepted view`);
    await makeManagerContextVisible(f.pi, f.ctx, response);
    assert.equal(await gate(), undefined, `${label} can be revalidated by the unchanged genuine result`);
  }

  await writeFile(join(f.checkout, "own-source-progress.txt"), "own source progress\n");
  await f.pi.handlers.get("tool_result")({ toolName: "bash", input: { command: "git status" }, isError: false, details: {}, content: [{ type: "text", text: "ok" }] }, f.ctx);
  await makeManagerContextVisible(f.pi, f.ctx, response);
  const afterProgress = await f.pi.handlers.get("before_agent_start")({ systemPrompt: base }, f.ctx);
  assert.deepEqual(afterProgress, started, "ordinary prompts retain only the stable manager text");
  assert.equal(await gate(), undefined, "unchanged visible context and own-source progress do not require a repeated refresh");
});

test("oversized raw manager base blocks dependent work and reports but permits manager cleanup", async (t) => {
  const f = await managerHarness(t);
  const blocked = await f.pi.handlers.get("before_agent_start")({ systemPrompt: "x".repeat(60_001) }, f.ctx);
  assert.match(blocked.systemPrompt, /manager prompt blocked/);
  assert.match((await f.pi.handlers.get("tool_call")({ toolName: "bash", input: { command: "git status" } }, f.ctx)).reason, /Required Hari context is .*limit 60000/);
  await assert.rejects(
    f.pi.tools.get("manager_report").execute("report", { result: "Must not write" }),
    /Required Hari context is .*limit 60000/,
  );
  assert.equal(await f.pi.handlers.get("tool_call")({ toolName: "manager_context", input: {} }, f.ctx), undefined);
  for (const input of [{ action: "list" }, { action: "status", id: "worker" }, { action: "stop", id: "worker" }]) {
    assert.equal(await f.pi.handlers.get("tool_call")({ toolName: "subagent", input }, f.ctx), undefined, `${input.action} remains available for helper cleanup`);
  }
});

test("the reusable terminal backend launches only after explicit confirmation and reports unavailable platforms", async () => {
  const calls = [];
  const launched = await openManagerTerminal({
    platform: "darwin",
    confirm: async () => true,
    exec: async (command, args) => { calls.push({ command, args }); return { code: 0, stdout: "", stderr: "" }; },
  }, { checkout: "/tmp/prepared", command: "hari internal manager start project manager", ghosttyScript: "script" });
  assert.deepEqual(launched, { launched: true });
  assert.deepEqual(calls[0], {
    command: "/usr/bin/osascript",
    args: ["-e", "script", "--", "/tmp/prepared", "hari internal manager start project manager\n"],
  });
  const unavailable = await openManagerTerminal({ platform: "linux", confirm: async () => true, exec: async () => ({ code: 0, stdout: "", stderr: "" }) }, {
    checkout: "/tmp/prepared", command: "hari", ghosttyScript: "script",
  });
  assert.equal(unavailable.launched, false);
  assert.match(unavailable.unavailable ?? "", /did not start a manager/);
});
