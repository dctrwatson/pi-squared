import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  InMemoryCredentialStore, fauxProvider, fauxAssistantMessage, fauxToolCall,
  getCurrentSystemMessage, getSystemMessageText,
} from "@earendil-works/pi-ai";
import { DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import agentTools, { AGENT_TOOL_NAMES } from "../../extensions/agent-tools/index.ts";
import { removeProcessArtifact } from "../../extensions/agent-tools/process-artifacts.ts";

let fixtureId = 0;
async function fixture(t, { mode = "print", tools, extraTools = [], beforeRefresh } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-at08-composition-"));
  const bin = join(root, "bin");
  await mkdir(bin);
  await symlink("/bin/bash", join(bin, "bash"));
  const originalPath = process.env.PATH;
  process.env.PATH = bin;
  const shutdown = [];
  const errors = [];
  let lifecycleContext;
  let api;
  let eventOptions;
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({
    cwd: root, agentDir: join(root, "agent"), settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: "", appendSystemPrompt: [],
    extensionFactories: [
      (pi) => {
        pi.registerTool({ name: "noop", label: "No-op", description: "Do nothing", parameters: Type.Object({}),
          promptSnippet: "NOOP_SNIPPET", promptGuidelines: ["NOOP_RULE"],
          async execute() { return { content: [{ type: "text", text: "done" }], details: undefined }; } });
        for (const tool of extraTools) pi.registerTool(tool);
        pi.on("session_start", (_event, ctx) => { lifecycleContext = ctx; });
        pi.on("before_agent_start", (event) => {
          beforeRefresh?.();
          event.systemPromptOptions.sections.keep = "KEEP_SECTION";
          event.systemPromptOptions.promptGuidelines.push("KEEP_GLOBAL_RULE");
          event.systemPromptOptions.toolSnippets.noop = "MUTATED_NOOP_SNIPPET";
          event.systemPromptOptions.toolGuidelines.noop = ["MUTATED_NOOP_RULE"];
          eventOptions = event.systemPromptOptions;
        });
      },
      (pi) => {
        api = pi;
        agentTools({ ...pi,
          registerTool(tool) {
            pi.registerTool(tool.name === "bash_job" ? { ...tool, promptGuidelines: ["JOB_RULE_FIXTURE"] } : tool);
          },
          on(event, handler) {
            if (event === "session_shutdown") shutdown.push(handler);
            return pi.on(event, handler);
          },
        });
      },
    ],
  });
  await resourceLoader.reload();
  const provider = fauxProvider({ provider: `at08-composition-${++fixtureId}`, models: [{ id: "first" }, { id: "second" }] });
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(provider.provider);
  const { session } = await createAgentSession({
    cwd: root, agentDir: join(root, "agent"), resourceLoader, settingsManager, modelRuntime,
    sessionManager: SessionManager.inMemory(root), model: provider.getModel(), ...(tools ? { tools } : {}),
  });
  t.after(async () => {
    try {
      for (const handler of shutdown) await handler({ type: "session_shutdown", reason: "quit" }, lifecycleContext);
      const directories = new Set();
      for (const message of session.messages) {
        const process = message.details?.job?.process;
        for (const stream of [process?.stdout, process?.stderr]) if (stream?.artifact) directories.add(dirname(stream.artifact));
      }
      for (const directory of directories) await removeProcessArtifact(directory);
      assert.deepEqual(errors, []);
    } finally {
      session.dispose();
      if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
      await rm(root, { recursive: true, force: true });
    }
  });
  await session.bindExtensions({ mode, onError: (error) => errors.push(error) });
  const captures = [];
  function response(message) {
    return (context) => {
      const current = getCurrentSystemMessage(context.messages);
      captures.push({ names: current.toolsAdded?.map((tool) => tool.name) ?? [], text: getSystemMessageText(current), current });
      return message;
    };
  }
  return { root, bin, session, provider, modelRuntime, api, captures, response, get eventOptions() { return eventOptions; } };
}
function hasDeclaration(capture, name, expected) {
  assert.equal(capture.names.includes(name), expected, `${name} declaration`);
}
function hasMetadata(capture, tool, expected) {
  assert.equal(capture.text.includes(`- ${tool.name}: ${tool.promptSnippet}`), expected, `${tool.name} snippet`);
}

test("real default registration declares only available tools and retains requested names", async (t) => {
  const f = await fixture(t);
  const active = f.session.getActiveToolNames();
  for (const name of AGENT_TOOL_NAMES) assert.ok(active.includes(name), `${name} requested by default`);
  f.provider.setResponses([f.response(fauxAssistantMessage("done"))]);
  await f.session.prompt("check defaults");
  for (const name of ["read", "find", "grep", "bash", "git", "noop"]) hasDeclaration(f.captures[0], name, true);
  for (const name of ["ask_user", "gh", "web_search", "bash_job"]) hasDeclaration(f.captures[0], name, false);
  for (const name of ["web_fetch", "web_read"]) {
    assert.ok(!active.includes(name));
    assert.equal(f.session.getToolDefinition(name), undefined);
    hasDeclaration(f.captures[0], name, false);
    assert.ok(!f.captures[0].text.includes(name));
  }
  assert.deepEqual(f.session.getActiveToolNames(), active);
});

test("real two-request contexts retain tombstones and later enable, hide, and preserve user disables", async (t) => {
  const f = await fixture(t);
  const active = f.session.getActiveToolNames();
  f.provider.setResponses([
    f.response(fauxAssistantMessage(fauxToolCall("noop", {}), { stopReason: "toolUse" })),
    f.response(fauxAssistantMessage("done")),
  ]);
  await f.session.prompt("two requests");
  assert.equal(f.captures.length, 2);
  for (const capture of f.captures) {
    for (const name of ["ask_user", "gh", "web_search", "bash_job"]) {
      hasDeclaration(capture, name, false);
      hasMetadata(capture, f.session.getToolDefinition(name), false);
      assert.equal(f.eventOptions.toolSnippets[name], "");
      assert.deepEqual(f.eventOptions.toolGuidelines[name], []);
    }
    assert.ok(capture.text.includes("KEEP_SECTION"));
    assert.ok(capture.text.includes("KEEP_GLOBAL_RULE"));
    assert.ok(capture.text.includes("MUTATED_NOOP_SNIPPET"));
    assert.ok(capture.text.includes("MUTATED_NOOP_RULE"));
    assert.ok(!capture.text.includes("Use ask_user only"));
    assert.ok(!capture.text.includes("Use web_search for current"));
    assert.ok(!capture.text.includes("gh has no TTY"));
  }
  assert.deepEqual(f.session.getActiveToolNames(), active);
  const enabledBin = join(f.root, "enabled");
  await mkdir(enabledBin);
  await writeFile(join(enabledBin, "gh"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  process.env.PATH = enabledBin;
  await f.session.bindExtensions({ mode: "tui" });
  f.provider.setResponses([f.response(fauxAssistantMessage("enabled"))]);
  await f.session.prompt("enabled");
  for (const name of ["gh", "ask_user"]) {
    hasDeclaration(f.captures.at(-1), name, true);
    hasMetadata(f.captures.at(-1), f.session.getToolDefinition(name), true);
  }
  const disabled = active.filter((name) => !["gh", "ask_user", "find", "bash_job"].includes(name));
  f.api.setActiveTools(disabled);
  await f.session.setModel(f.provider.getModel("second"));
  f.provider.setResponses([f.response(fauxAssistantMessage("disabled"))]);
  await f.session.prompt("keep disabled");
  assert.deepEqual(f.session.getActiveToolNames(), disabled);
  for (const name of ["gh", "ask_user", "find", "bash_job"]) hasDeclaration(f.captures.at(-1), name, false);
  f.api.setActiveTools(active);
  process.env.PATH = f.bin;
  await f.session.bindExtensions({ mode: "json" });
  f.provider.setResponses([f.response(fauxAssistantMessage("hidden again"))]);
  await f.session.prompt("hide again");
  for (const name of ["gh", "ask_user"]) {
    hasDeclaration(f.captures.at(-1), name, false);
    hasMetadata(f.captures.at(-1), f.session.getToolDefinition(name), false);
  }
  assert.deepEqual(f.session.getActiveToolNames(), active);
});

test("real TUI, print, JSON, and RPC contexts use mode rather than hasUI", async (t) => {
  const f = await fixture(t);
  const active = f.session.getActiveToolNames();
  for (const mode of ["tui", "print", "json", "rpc"]) {
    await f.session.bindExtensions({ mode });
    f.provider.setResponses([f.response(fauxAssistantMessage(mode))]);
    await f.session.prompt(mode);
    hasDeclaration(f.captures.at(-1), "ask_user", mode === "tui");
    hasMetadata(f.captures.at(-1), f.session.getToolDefinition("ask_user"), mode === "tui");
    assert.deepEqual(f.session.getActiveToolNames(), active);
  }
});

test("real model switches retain available Codex fallbacks and hide an unavailable compatible selection", async (t) => {
  const f = await fixture(t);
  const active = f.session.getActiveToolNames();
  const backend = fauxProvider({ provider: "openai-codex", api: "openai-codex-responses",
    models: [{ id: "gpt-6-luna" }, { id: "gpt-5.6-luna" }, { id: "custom" }] });
  for (const model of backend.models) model.compat = { supportsAdditionalTools: true };
  f.modelRuntime.registerNativeProvider(backend.provider);
  await f.modelRuntime.refresh({ allowNetwork: false });
  await f.session.setModel(f.provider.getModel("second"));
  f.provider.setResponses([f.response(fauxAssistantMessage("fallback"))]);
  await f.session.prompt("selected model has a Codex fallback");
  hasDeclaration(f.captures.at(-1), "web_search", true);
  hasMetadata(f.captures.at(-1), f.session.getToolDefinition("web_search"), true);
  assert.ok(f.captures.at(-1).text.includes("Use web_search for current"));
  assert.ok(f.captures.at(-1).text.includes("A search summary is not source text."));
  assert.ok(!f.captures.at(-1).text.includes("web_read"));
  await f.session.setModel(backend.getModel("custom"));
  backend.setResponses([f.response(fauxAssistantMessage("compatible"))]);
  await f.session.prompt("compatible active model");
  hasDeclaration(f.captures.at(-1), "web_search", true);
  backend.provider.filterModels = () => [];
  f.modelRuntime.registerNativeProvider(backend.provider);
  await f.modelRuntime.refresh({ allowNetwork: false });
  assert.equal(f.modelRuntime.getAvailableSnapshot().some((model) => model.provider === "openai-codex"), false);
  backend.setResponses([f.response(fauxAssistantMessage("unavailable"))]);
  await f.session.prompt("compatible selection is not available");
  hasDeclaration(f.captures.at(-1), "web_search", false);
  hasMetadata(f.captures.at(-1), f.session.getToolDefinition("web_search"), false);
  assert.ok(!f.captures.at(-1).text.includes("Use web_search for current"));
  assert.deepEqual(f.session.getActiveToolNames(), active);
});

test("real setter during before_agent_start preserves earlier request-local metadata", async (t) => {
  let path;
  const f = await fixture(t, { beforeRefresh: () => { process.env.PATH = path; } });
  const enabledBin = join(f.root, "enabled");
  await mkdir(enabledBin);
  await writeFile(join(enabledBin, "gh"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  path = enabledBin;
  const active = f.session.getActiveToolNames();
  f.provider.setResponses([f.response(fauxAssistantMessage("done"))]);
  await f.session.prompt("refresh changes the signature");
  hasDeclaration(f.captures[0], "gh", true);
  for (const value of ["KEEP_SECTION", "KEEP_GLOBAL_RULE", "MUTATED_NOOP_SNIPPET", "MUTATED_NOOP_RULE"]) assert.ok(f.captures[0].text.includes(value));
  assert.equal(f.eventOptions.toolSnippets.ask_user, "");
  assert.deepEqual(f.eventOptions.toolGuidelines.ask_user, []);
  assert.deepEqual(f.eventOptions.selectedTools, active);
  assert.deepEqual(f.session.getActiveToolNames(), active);
});

test("real late job controls declare immediately but restore prompt metadata only on the next run", async (t) => {
  const f = await fixture(t);
  const active = f.session.getActiveToolNames();
  const jobTool = f.session.getToolDefinition("bash_job");
  f.provider.setResponses([
    f.response(fauxAssistantMessage(fauxToolCall("bash", { command: "printf 'saved\\n'", background: true }), { stopReason: "toolUse" })),
    f.response(fauxAssistantMessage("job started")),
  ]);
  await f.session.prompt("start a job");
  hasDeclaration(f.captures[0], "bash_job", false);
  hasDeclaration(f.captures[1], "bash_job", true);
  for (const capture of f.captures) {
    hasMetadata(capture, jobTool, false);
    assert.ok(!capture.text.includes("JOB_RULE_FIXTURE"));
  }
  assert.deepEqual(f.session.getActiveToolNames(), active);
  f.provider.setResponses([f.response(fauxAssistantMessage("next run"))]);
  await f.session.prompt("inspect retained job");
  hasDeclaration(f.captures[2], "bash_job", true);
  hasMetadata(f.captures[2], jobTool, true);
  assert.ok(f.captures[2].text.includes("JOB_RULE_FIXTURE"));
  const disabled = active.filter((name) => name !== "bash_job");
  f.api.setActiveTools(disabled);
  f.provider.setResponses([f.response(fauxAssistantMessage("disabled"))]);
  await f.session.prompt("keep controls disabled");
  hasDeclaration(f.captures.at(-1), "bash_job", false);
  assert.deepEqual(f.session.getActiveToolNames(), disabled);
});

test("real explicit CLI selections stay unchanged and background controls fail before allocation", async (t) => {
  const f = await fixture(t, { tools: ["bash", "noop", "write"] });
  const active = f.session.getActiveToolNames();
  assert.deepEqual(active, ["bash", "noop", "write"]);
  f.provider.setResponses([
    f.response(fauxAssistantMessage(fauxToolCall("bash", { command: "printf should-not-run > unexpected", background: true }), { stopReason: "toolUse" })),
    f.response(fauxAssistantMessage("rejected")),
  ]);
  await f.session.prompt("controls were not selected");
  const result = f.session.messages.find((message) => message.role === "toolResult" && message.toolName === "bash");
  assert.equal(result.isError, true);
  assert.equal(result.details.error.code, "CONTROL_UNAVAILABLE");
  assert.equal(result.details.job, undefined);
  assert.deepEqual(f.session.getActiveToolNames(), active);
  const { access } = await import("node:fs/promises");
  await assert.rejects(access(join(f.root, "unexpected")));
});

test("real nested calls guard hidden gh and web_search and reject model-only ask_user", async (t) => {
  let results;
  const nested = { name: "nested", label: "Nested", description: "Exercise nested guards", parameters: Type.Object({}),
    async execute(_id, _input, _signal, _update, ctx) {
      const names = ctx.tools.map((tool) => tool.name);
      assert.ok(names.includes("gh"));
      assert.ok(names.includes("web_search"));
      assert.ok(!names.includes("ask_user"));
      results = {
        gh: await ctx.executeTool("gh", { args: ["--version"] }),
        web: await ctx.executeTool("web_search", { query: "fixture" }),
        ask: await ctx.executeTool("ask_user", { prompt: "Must not open" }),
      };
      return { content: [{ type: "text", text: "nested guards checked" }], details: undefined };
    } };
  const f = await fixture(t, { mode: "tui", extraTools: [nested] });
  f.provider.setResponses([
    f.response(fauxAssistantMessage(fauxToolCall("nested", {}), { stopReason: "toolUse" })),
    f.response(fauxAssistantMessage("done")),
  ]);
  await f.session.prompt("check nested guards");
  hasDeclaration(f.captures[0], "gh", false);
  hasDeclaration(f.captures[0], "web_search", false);
  hasDeclaration(f.captures[0], "ask_user", true);
  assert.equal(results.gh.isError, true);
  assert.equal(results.gh.result.details.error.code, "EXECUTABLE_NOT_FOUND");
  assert.equal(results.web.isError, true);
  assert.equal(results.web.result.details.error.code, "MODEL_UNAVAILABLE");
  assert.equal(results.ask.isError, true);
  assert.match(results.ask.result.content[0].text, /ask_user|not.*call|unknown/i);
});
