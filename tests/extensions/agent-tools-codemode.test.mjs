import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InMemoryCredentialStore, fauxProvider, fauxAssistantMessage, fauxToolCall,
  getCurrentSystemMessage,
} from "@earendil-works/pi-ai";
import {
  DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession,
} from "@earendil-works/pi-coding-agent";
import { createCodemodeExtension } from "../../node_modules/@earendil-works/pi-coding-agent/dist/extensions/codemode/index.js";
import agentTools from "../../extensions/agent-tools/index.ts";
import { createAgentFindTool, createAgentGrepTool } from "../../extensions/agent-tools/search.ts";
import { removeProcessArtifact } from "../../extensions/agent-tools/process-artifacts.ts";

let fixtureId = 0;
async function fixture(t, { loadCodemode = true, activateCodemode = true, mode = "print" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-search-codemode-"));
  const artifacts = new Set();
  const errors = [];
  const shutdown = [];
  let lifecycleContext;
  let session;
  t.after(async () => {
    try {
      if (lifecycleContext) {
        for (const handler of shutdown) await handler({ type: "session_shutdown", reason: "quit" }, lifecycleContext);
      }
    } finally {
      session?.dispose();
      for (const directory of artifacts) await removeProcessArtifact(directory);
      await rm(root, { recursive: true, force: true });
    }
    assert.deepEqual(errors, []);
  });
  await mkdir(join(root, "bin"));
  const executable = join(root, "bin", "rg");
  const records = [
    ["context", "alpha.ts", 1, "before"],
    ["match", "alpha.ts", 2, "needle first"],
    ["context", "alpha.ts", 3, "after"],
    ["match", "beta.ts", 1, "needle second"],
  ];
  const protocol = records.map(([type, path, line_number, text]) => JSON.stringify({
    type, data: { path: { text: path }, lines: { text: `${text}\n` }, line_number },
  })).join("\n");
  await writeFile(executable, `#!/usr/bin/env bash\nprintf '%s\\n' '${protocol}'\n`, { mode: 0o700 });
  const onArtifactCreated = (artifact) => artifacts.add(artifact.directory);
  const find = createAgentFindTool({
    onArtifactCreated,
    operations: { exists: () => true, glob: async () => ["alpha.ts", "beta.ts"] },
  });
  const grep = createAgentGrepTool({ executable, onArtifactCreated });
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false }, retry: { enabled: false },
    ...(activateCodemode ? { defaultTools: ["+codemode"] } : {}),
    codemode: { mode: "only" },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: root, agentDir: join(root, "agent"), settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: "", appendSystemPrompt: [],
    additionalExtensionPaths: loadCodemode ? ["builtin:codemode"] : [],
    extensionFactories: [
      { name: "codemode", builtin: true, factory: createCodemodeExtension({ models: false }) },
      (pi) => {
        pi.on("session_start", (_event, ctx) => { lifecycleContext = ctx; });
        agentTools({ ...pi,
          registerTool(tool) {
            pi.registerTool(tool.name === "find" ? find : tool.name === "grep" ? grep : tool);
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
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const provider = fauxProvider({ provider: `search-codemode-${++fixtureId}` });
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null,
    allowModelNetwork: false, refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(provider.provider);
  ({ session } = await createAgentSession({
    cwd: root, agentDir: join(root, "agent"), resourceLoader, settingsManager, modelRuntime,
    sessionManager: SessionManager.inMemory(root), model: provider.getModel(),
  }));
  await session.bindExtensions({ mode, onError: (error) => errors.push(error) });
  const declarations = [];
  async function run(code) {
    provider.setResponses([
      (context) => {
        declarations.push(getCurrentSystemMessage(context.messages).toolsAdded?.map((tool) => tool.name) ?? []);
        return fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" });
      },
      fauxAssistantMessage("done"),
    ]);
    await session.prompt("Run the offline search script");
    const result = session.messages.findLast((message) => message.role === "toolResult" && message.toolName === "codemode");
    assert.ok(result);
    assert.equal(result.isError, false, JSON.stringify(result.content));
    return result;
  }
  return { session, run, declarations };
}

test("real codemode filters structured find and grep results without printing the full preview", async (t) => {
  const f = await fixture(t, { mode: "tui" });
  const result = await f.run(`
    if ("ask_user" in tools) throw new Error("model-only tool is callable");
    const [found, matched] = await Promise.all([
      tools.find({ pattern: "*.ts", limit: 1 }),
      tools.grep({ pattern: "needle", literal: true, context: 1 }),
    ]);
    if (typeof found !== "object" || typeof matched !== "object") throw new Error("search returned text");
    if (!found.ok || !matched.ok) throw new Error("search failed");
    if (found.preview !== "truncated" || !found.artifact) throw new Error("missing recovery data");
    text({ paths: found.records.map((record) => record.path),
      matches: matched.records.filter((record) => record.match).slice(0, 1) });
  `);
  const output = result.content.map((item) => item.text ?? "").join("\n");
  assert.ok(output.includes(JSON.stringify({
    paths: ["alpha.ts"],
    matches: [{ path: "alpha.ts", line_number: 2, text: "needle first", match: true }],
  })), output);
  assert.doesNotMatch(output, /needle second|before|after|beta\.ts/);
  assert.deepEqual(result.details.calls.map(({ name, status }) => ({ name, status })).sort((a, b) => a.name.localeCompare(b.name)), [
    { name: "find", status: "ok" }, { name: "grep", status: "ok" },
  ]);
  assert.ok(f.declarations[0].includes("codemode"));
  assert.ok(f.declarations[0].includes("ask_user"));
  assert.ok(!f.declarations[0].includes("find"));
  assert.ok(!f.declarations[0].includes("grep"));
});

test("real codemode receives structured search errors and records the nested failure", async (t) => {
  const f = await fixture(t);
  const result = await f.run(`
    const failure = await tools.grep({ pattern: "needle", path: "missing" });
    if (typeof failure !== "object" || failure.ok !== false) throw new Error("missing structured error");
    text({ ok: failure.ok, code: failure.error.code });
  `);
  const output = result.content.map((item) => item.text ?? "").join("\n");
  assert.ok(output.includes(JSON.stringify({ ok: false, code: "SEARCH_FAILED" })), output);
  assert.equal(result.details.calls[0].name, "grep");
  assert.equal(result.details.calls[0].status, "error");
  assert.match(result.details.calls[0].error, /Path not found/);
});

test("codemode needs an explicit built-in resource and normal tool activation", async (t) => {
  const absent = await fixture(t, { loadCodemode: false });
  assert.equal(absent.session.getToolDefinition("codemode"), undefined);
  assert.ok(!absent.session.getActiveToolNames().includes("codemode"));
  const inactive = await fixture(t, { activateCodemode: false });
  assert.ok(inactive.session.getToolDefinition("codemode"));
  assert.ok(!inactive.session.getActiveToolNames().includes("codemode"));
  const active = await fixture(t);
  assert.ok(active.session.getActiveToolNames().includes("codemode"));
});
