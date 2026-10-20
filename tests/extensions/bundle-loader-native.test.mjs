import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  InMemoryCredentialStore,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getCurrentSystemMessage,
  getSystemMessageText,
} from "@earendil-works/pi-ai";
import {
  AgentSessionRuntime,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
} from "@earendil-works/pi-coding-agent";

const BUNDLE_EXTENSION = fileURLToPath(new URL("../../extensions/bundle-loader.ts", import.meta.url));
const PROBE = Symbol.for("pi-squared.bundle-native-test.probe");
let fixtureId = 0;

function toolSource({ name, exposure, description = `${name} test tool.`, prepareLoadout, namespace, reachesTools }) {
  return `{
    name: ${JSON.stringify(name)},
    label: ${JSON.stringify(name)},
    description: ${JSON.stringify(description)},
    parameters: Type.Object({}),
    exposure: ${JSON.stringify(exposure)},
    ${prepareLoadout ? `prepareLoadout: ${prepareLoadout},` : ""}
    ${namespace ? `namespace: ${JSON.stringify(namespace)},` : ""}
    ${reachesTools ? `reachesTools: ${reachesTools},` : ""}
    async execute() {
      if (probe) probe.executions[${JSON.stringify(name)}] = (probe.executions[${JSON.stringify(name)}] ?? 0) + 1;
      return { content: [{ type: "text", text: "synthetic result" }], details: undefined };
    },
  }`;
}

function adapterSource(tools) {
  return `import { Type } from "typebox";
const probe = globalThis[Symbol.for("pi-squared.bundle-native-test.probe")];
if (probe) probe.imports += 1;
export async function createBundle() {
  if (probe) probe.factories += 1;
  return { tools: [${tools.join(",\n")}] };
}
`;
}

function fullAdapterSource() {
  return adapterSource([
    toolSource({ name: "bundle_direct", exposure: "direct", description: "Run a native bundle catalog action." }),
    toolSource({ name: "bundle_model_only", exposure: "model-only", description: "A model-only bundle action." }),
    toolSource({ name: "bundle_deferred", exposure: "deferred", description: "Search native bundle catalog entries." }),
  ]);
}

function invalidResultAdapterSource() {
  return `import { Type } from "typebox";
const probe = globalThis[Symbol.for("pi-squared.bundle-native-test.probe")];
if (probe) probe.imports += 1;
export async function createBundle() {
  if (probe) probe.factories += 1;
  return { unexpected: true };
}
`;
}

function importErrorAdapterSource() {
  return `const probe = globalThis[Symbol.for("pi-squared.bundle-native-test.probe")];
if (probe) probe.imports += 1;
throw new Error("synthetic adapter import failure");
`;
}

function partialRegistrationAdapterSource({ throws = true } = {}) {
  const prepareLoadout = throws
    ? `() => { if (probe) probe.prepareLoadoutCalls += 1; throw new Error("synthetic prepareLoadout failure"); }`
    : `() => undefined`;
  return adapterSource([
    toolSource({ name: "partial_staged_tool", exposure: "direct" }),
    toolSource({ name: "partial_activation_failure", exposure: "direct", prepareLoadout }),
    toolSource({ name: "partial_deferred_tool", exposure: "deferred", description: "PARTIAL_DEFERRED_PRIVATE_DESCRIPTION_95" }),
  ]);
}

function lateHostExtensionSource() {
  return `import { Type } from "typebox";
export default function lateHost(pi) {
  pi.on("session_start", (event) => {
    pi.registerTool({
      name: "late_host_deferred",
      label: "Late host tool",
      description: "A host tool registered during session startup.",
      parameters: Type.Object({}),
      exposure: "deferred",
      defaultActive: false,
      async execute() { return { content: [{ type: "text", text: "late host result" }], details: undefined }; },
    });
    if (event.reason === "startup") pi.setActiveTools([...pi.getActiveTools(), "late_host_deferred"]);
  });
}
`;
}

async function writeBundleFiles(root, name, { adapter, skill, skills: skillSpecs, adapterless = false } = {}) {
  let adapterPath;
  if (!adapterless) {
    adapterPath = join(root, "adapters", `${name}.ts`);
    await mkdir(dirname(adapterPath), { recursive: true });
    await writeFile(adapterPath, adapter ?? fullAdapterSource());
  }

  const skillPaths = [];
  for (const [index, spec] of (skillSpecs ?? (skill ? [skill] : [])).entries()) {
    if (spec.filePath) {
      skillPaths.push(spec.filePath);
      continue;
    }
    const skillPath = join(root, "skills", name, `${index + 1}-${spec.name}`, "SKILL.md");
    await mkdir(dirname(skillPath), { recursive: true });
    await writeFile(skillPath, `---\nname: ${spec.name}\ndescription: "${spec.description}"\n---\n\n${spec.body ?? "Synthetic skill body."}\n`);
    skillPaths.push(skillPath);
  }

  const manifestPath = join(root, "manifests", `${name}.json`);
  await mkdir(dirname(manifestPath), { recursive: true });
  const manifest = {
    version: 1,
    ...(!adapterless ? { adapter: adapterPath } : {}),
    ...(skillPaths.length > 0 ? { skills: skillPaths } : {}),
  };
  await writeFile(manifestPath, JSON.stringify(manifest));
  return { adapterPath, manifestPath, manifest, skillPaths };
}

function createUI(captures) {
  return {
    async select(title, options) {
      captures.selections.push({ title, options: [...options] });
      return undefined;
    },
    async confirm() { return false; },
    async input() { return undefined; },
    notify(message, type = "info") { captures.notifications.push({ message, type }); },
    onTerminalInput() { return () => {}; },
    setStatus() {},
    setWorkingMessage() {},
    setWorkingVisible() {},
    setWorkingIndicator() {},
    setHiddenThinkingLabel() {},
    setWidget() {},
    setFooter() {},
    setHeader() {},
    setTitle() {},
    async custom() { return undefined; },
    pasteToEditor() {},
    setEditorText() {},
    getEditorText() { return ""; },
    async editor() { return undefined; },
    addAutocompleteProvider() {},
    setEditorComponent() {},
    getEditorComponent() { return undefined; },
    theme: undefined,
    getAllThemes() { return []; },
    getTheme() { return undefined; },
    setTheme() { return { success: false }; },
    getToolsExpanded() { return false; },
    setToolsExpanded() {},
  };
}

async function createSandbox(t, bundles) {
  const root = await mkdtemp(join(tmpdir(), "pi-bundle-native-"));
  const agentDir = join(root, "agent");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousProbe = globalThis[PROBE];
  const probe = { imports: 0, factories: 0, prepareLoadoutCalls: 0, executions: Object.create(null) };
  const captures = { selections: [], notifications: [] };
  const errors = [];
  const cleanups = [];
  const manifestFiles = new Map();
  globalThis[PROBE] = probe;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  t.after(async () => {
    try {
      for (const cleanup of cleanups.reverse()) await cleanup();
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousProbe === undefined) delete globalThis[PROBE];
      else globalThis[PROBE] = previousProbe;
      await rm(root, { recursive: true, force: true });
    }
  });

  await mkdir(agentDir, { recursive: true });
  const registryBundles = {};
  for (const bundle of bundles) {
    const files = await writeBundleFiles(root, bundle.name, bundle);
    manifestFiles.set(bundle.name, files);
    registryBundles[bundle.name] = files.manifestPath;
  }
  await writeFile(join(agentDir, "bundle-loader.json"), JSON.stringify({ bundles: registryBundles }));

  const provider = fauxProvider({
    provider: `bundle-native-${++fixtureId}`,
    models: [{ id: "native-test" }],
  });
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(provider.provider);
  const uiContext = createUI(captures);

  return {
    root,
    agentDir,
    provider,
    modelRuntime,
    uiContext,
    captures,
    errors,
    cleanups,
    manifestFiles,
    probe,
    async makeSettingsManager() {
      return SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    },
    async makeResourceLoader({ cwd = root, settingsManager, extensionFactories = [], additionalExtensionPaths = [] } = {}) {
      const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager,
        additionalExtensionPaths: [BUNDLE_EXTENSION, ...additionalExtensionPaths],
        extensionFactories,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPrompt: "",
        appendSystemPrompt: [],
      });
      await resourceLoader.reload();
      return resourceLoader;
    },
    async makeSession({ cwd = root, sessionManager = SessionManager.inMemory(root), settingsManager, extensionFactories = [], additionalExtensionPaths = [] } = {}) {
      const effectiveSettings = settingsManager ?? await this.makeSettingsManager();
      const resourceLoader = await this.makeResourceLoader({ cwd, settingsManager: effectiveSettings, extensionFactories, additionalExtensionPaths });
      const { session } = await createAgentSession({
        cwd,
        agentDir,
        resourceLoader,
        settingsManager: effectiveSettings,
        modelRuntime,
        sessionManager,
        model: provider.getModel(),
      });
      cleanups.push(async () => session.dispose());
      await session.bindExtensions({ mode: "print", uiContext, commandContextActions: commandActions(session), onError: (error) => errors.push(error) });
      return session;
    },
  };
}

async function activate(session, name) {
  await session.prompt(`/bundle ${name}`);
}

async function listBundles(session, captures) {
  const before = captures.selections.length;
  await session.prompt("/bundle");
  assert.equal(captures.selections.length, before + 1, "bundle command opens its list");
  return captures.selections.at(-1).options;
}

function toolNamesIn(messages) {
  const system = getCurrentSystemMessage(messages);
  return system?.toolsAdded?.map((tool) => tool.name) ?? [];
}

function assertTranscriptHasTool(session, name) {
  const transcript = session.sessionManager.buildSessionContext().messages;
  assert.ok(toolNamesIn(transcript).includes(name), `persisted system transcript declares ${name}`);
}

function assertOneRegistration(session, name) {
  const matching = session.getAllTools().filter((tool) => tool.name === name);
  assert.equal(matching.length, 1, `${name} is registered once`);
}

function assertNativeCommandSource(session) {
  const command = session.extensionRunner.getRegisteredCommands().find((item) => item.name === "bundle");
  assert.ok(command, "native extension registers /bundle");
  assert.equal(command.sourceInfo.path, BUNDLE_EXTENSION, "command source points to the native extension file");
  assert.ok(!command.sourceInfo.path.startsWith("<inline:"), "command source is not an inline extension label");
  return command;
}

function settingsSnapshot(settingsManager) {
  return {
    settings: settingsManager.getSettings(),
    global: settingsManager.getGlobalSettings(),
    project: settingsManager.getProjectSettings(),
    defaultProvider: settingsManager.getDefaultProvider(),
    defaultModel: settingsManager.getDefaultModel(),
  };
}

function commandActions(session, runtime) {
  return {
    waitForIdle: () => session.waitForIdle(),
    newSession: (options) => runtime?.newSession(options) ?? Promise.resolve({ cancelled: false }),
    fork: (entryId, options) => runtime?.fork(entryId, options) ?? Promise.resolve({ cancelled: false }),
    navigateTree: (targetId, options) => session.navigateTree(targetId, options),
    switchSession: (sessionPath, options) => runtime?.switchSession(sessionPath, options) ?? Promise.resolve({ cancelled: false }),
    reload: () => session.reload(),
  };
}

test("native bundle tools preserve namespace aliases and reachability through registration and reload", async (t) => {
  const namespace = { name: "bundle", aliases: ["records", "bundle_records"] };
  const sandbox = await createSandbox(t, [{
    name: "reachability",
    adapter: adapterSource([toolSource({
      name: "bundle_router",
      exposure: "model-only",
      namespace,
      reachesTools: '(input) => input.all ? "all" : [input.name]',
    })]),
  }]);
  const session = await sandbox.makeSession();
  await activate(session, "reachability");
  for (let iteration = 0; iteration < 2; iteration++) {
    const tool = session.getToolDefinition("bundle_router");
    const info = session.getAllTools().find((entry) => entry.name === "bundle_router");
    assert.deepEqual(tool.namespace, namespace);
    assert.deepEqual(info.namespace, namespace);
    assert.equal(info.reachesTools, tool.reachesTools);
    assert.equal(info.reachesTools({ all: true }), "all");
    assert.deepEqual(info.reachesTools({ name: "read" }), ["read"]);
    if (iteration === 0) await session.reload();
  }
  assert.deepEqual(sandbox.errors, []);
});

test("native bundle activation is offline, lazy, searchable, idempotent, and reload-safe", async (t) => {
  const privateSkillDescription = "PRIVATE_BUNDLE_SKILL_DESCRIPTION_71A";
  const privateSkillBody = "PRIVATE_BUNDLE_SKILL_BODY_71B";
  const privateAdapterMetadata = "PRIVATE_BUNDLE_ADAPTER_METADATA_71C";
  const sandbox = await createSandbox(t, [{
    name: "demo",
    adapter: fullAdapterSource().replace("Search native bundle catalog entries.", `Search native bundle catalog entries. ${privateAdapterMetadata}`),
    skill: { name: "bundle-demo-skill", description: privateSkillDescription, body: privateSkillBody },
  }]);
  const settingsPath = join(sandbox.agentDir, "settings.json");
  const settingsBytes = `${JSON.stringify({
    defaultProvider: sandbox.provider.provider,
    defaultModel: "native-test",
    defaultTools: ["read", "bash"],
    compaction: { enabled: false },
    retry: { enabled: false },
    enableAnalytics: false,
  }, null, 2)}\n`;
  await writeFile(settingsPath, settingsBytes);
  const settingsManager = SettingsManager.create(sandbox.root, sandbox.agentDir);
  const settingsBeforeActivation = settingsSnapshot(settingsManager);
  const session = await sandbox.makeSession({ settingsManager });
  assertNativeCommandSource(session);

  const initialTools = session.getActiveToolNames();
  assert.ok(initialTools.includes("read"), "the SDK's existing read tool starts active");
  assert.equal(session.getToolDefinition("tool_search"), undefined, "the SDK did not preload tool_search");
  assert.equal(session.getToolDefinition("bundle_direct"), undefined);
  assert.equal(session.getToolDefinition("bundle_deferred"), undefined);
  assert.equal(sandbox.probe.imports, 0, "startup does not import an adapter");
  assert.equal(sandbox.provider.state.callCount, 0, "startup does not call the model");
  for (const privateValue of [privateSkillDescription, privateSkillBody, privateAdapterMetadata, "bundle_deferred"]) {
    assert.ok(!session.systemPrompt.includes(privateValue), `${privateValue} stays out of the startup prompt`);
  }

  const list = await listBundles(session, sandbox.captures);
  assert.deepEqual(list, ["demo · not loaded"]);
  const listOutput = JSON.stringify({ list, notifications: sandbox.captures.notifications });
  for (const privateValue of [privateSkillDescription, privateSkillBody, privateAdapterMetadata, "bundle_deferred"]) {
    assert.ok(!listOutput.includes(privateValue), `${privateValue} stays private in the bundle list`);
  }
  assert.equal(sandbox.probe.imports, 0, "listing does not import an adapter");
  assert.equal(sandbox.provider.state.callCount, 0, "listing does not call the model");

  await activate(session, "demo");
  assert.equal(sandbox.provider.state.callCount, 0, "slash activation does not call the model");
  await settingsManager.flush();
  assert.equal(await readFile(settingsPath, "utf8"), settingsBytes, "activation does not write user settings");
  assert.deepEqual(settingsSnapshot(settingsManager), settingsBeforeActivation, "activation does not change in-memory user settings");
  assert.equal(sandbox.probe.imports, 1, "activation imports the selected adapter");
  assert.equal(sandbox.probe.factories, 1, "activation creates the adapter tools once");
  assert.deepEqual(sandbox.errors, []);

  const activeAfterActivation = session.getActiveToolNames();
  for (const name of initialTools) assert.ok(activeAfterActivation.includes(name), `${name} stays active`);
  for (const name of ["bundle_direct", "bundle_model_only", "tool_search"]) {
    assert.ok(activeAfterActivation.includes(name), `${name} is active after selection`);
  }
  assert.ok(!activeAfterActivation.includes("bundle_deferred"), "deferred tools stay undeclared before search");
  assert.equal(session.getToolDefinition("tool_search")?.exposure, "model-only", "the public SDK factory registered tool_search");
  assert.equal(session.getToolDefinition("bundle_deferred")?.exposure, "deferred");
  assert.equal(session.getToolDefinition("bundle_model_only")?.exposure, "model-only");
  assert.ok(session.systemPrompt.includes("bundle-demo-skill"), "the selected skill name appears in the prompt");
  const selectedSkill = session.resourceLoader.getSkills().skills.find((skill) => skill.name === "bundle-demo-skill");
  assert.equal(selectedSkill?.sourceInfo.source, "extension:bundle-loader", "native startup skills retain the bundle extension source label");
  assert.ok(session.systemPrompt.includes(privateSkillDescription), "the selected skill description appears in the prompt");
  assert.ok(!session.systemPrompt.includes(privateSkillBody), "the skill body stays out of prompt metadata");
  assert.ok(!session.systemPrompt.includes(privateAdapterMetadata), "adapter metadata stays out of the prompt");

  const nestedContext = session.extensionRunner.createToolContext("native-nested-test", undefined);
  assert.ok(!nestedContext.tools.some((tool) => tool.name === "bundle_model_only"), "model-only tools are not nested-callable");
  const nestedResult = await nestedContext.executeTool("bundle_model_only", {});
  assert.equal(nestedResult.isError, true, "the nested tool API rejects model-only tools");
  assert.equal(sandbox.probe.executions.bundle_model_only, undefined, "a rejected nested call does not execute the tool");

  const requests = [];
  sandbox.provider.setResponses([
    (context) => {
      requests.push({ names: toolNamesIn(context.messages), text: getSystemMessageText(getCurrentSystemMessage(context.messages)) });
      return fauxAssistantMessage(fauxToolCall("tool_search", { query: "native bundle catalog entries" }), { stopReason: "toolUse" });
    },
    (context) => {
      requests.push({ names: toolNamesIn(context.messages), text: getSystemMessageText(getCurrentSystemMessage(context.messages)) });
      return fauxAssistantMessage("bundle search completed");
    },
  ]);
  await session.prompt("Find a native bundle catalog action.");
  assert.equal(sandbox.provider.state.callCount, 2, "the faux provider served two offline requests");
  assert.equal(requests.length, 2);
  assert.ok(!requests[0].names.includes("bundle_deferred"), "the deferred tool is absent before native tool_search executes");
  assert.ok(requests[0].names.includes("tool_search"), "tool_search is declared for model discovery");
  assert.ok(requests[1].names.includes("bundle_deferred"), "tool_search declares the matching tool on the next request");
  assert.ok(requests[1].text.includes(privateSkillDescription));
  assert.ok(!requests[1].text.includes(privateSkillBody));
  assert.ok(session.getActiveToolNames().includes("bundle_deferred"));
  assertTranscriptHasTool(session, "bundle_deferred");

  const explicitlyDisabled = session.getActiveToolNames().filter((name) => name !== "read" && name !== "bundle_direct");
  session.setActiveToolsByName(explicitlyDisabled);
  assert.ok(!session.getActiveToolNames().includes("read"), "the existing SDK tool is explicitly disabled");
  assert.ok(!session.getActiveToolNames().includes("bundle_direct"), "the bundle direct tool is explicitly disabled");

  const beforeRepeat = session.getActiveToolNames().sort();
  const factoryCount = sandbox.probe.factories;
  await activate(session, "demo");
  assert.equal(sandbox.provider.state.callCount, 2, "repeat activation does not call the model");
  assert.equal(sandbox.probe.factories, factoryCount, "repeat activation does not re-import or recreate the adapter");
  assert.deepEqual(session.getActiveToolNames().sort(), beforeRepeat, "repeat activation does not change the selection");
  for (const name of ["bundle_direct", "bundle_model_only", "bundle_deferred", "tool_search"]) assertOneRegistration(session, name);

  await session.reload();
  assert.deepEqual(session.getActiveToolNames().sort(), beforeRepeat, "ordinary reload preserves the selected tool names");
  for (const name of ["bundle_direct", "bundle_model_only", "bundle_deferred", "tool_search"]) assertOneRegistration(session, name);
  assert.equal(sandbox.probe.factories, factoryCount + 1, "ordinary reload recreates one adapter contribution");
  assert.equal(sandbox.provider.state.callCount, 2, "ordinary reload does not call the model");
  const loadedList = await listBundles(session, sandbox.captures);
  assert.deepEqual(loadedList, ["demo · loaded"]);
  assert.deepEqual(sandbox.errors, []);
});

test("native bundle completions are bounded and do not import adapters", async (t) => {
  const names = Array.from({ length: 45 }, (_, index) => `bundle-${String(index + 1).padStart(2, "0")}`);
  const sandbox = await createSandbox(t, names.map((name) => ({ name })));
  const session = await sandbox.makeSession();
  const command = assertNativeCommandSource(session);

  assert.deepEqual(await command.getArgumentCompletions("unknown"), [], "an unknown prefix has no completions");
  const all = await command.getArgumentCompletions("");
  assert.equal(all.length, 40, "completion results honor the registry cap");
  assert.deepEqual(all.map((item) => item.value), names.slice(0, 40));
  assert.equal(sandbox.probe.imports, 0, "completion does not import adapters");
  assert.equal(sandbox.provider.state.callCount, 0, "completion does not call the model");
});

test("fresh SDK startup reusing the same session manager resets bundle selection", async (t) => {
  const sandbox = await createSandbox(t, [{ name: "demo", adapter: fullAdapterSource() }]);
  const sessionManager = SessionManager.inMemory(sandbox.root);
  const firstSession = await sandbox.makeSession({ sessionManager });
  const identity = [sessionManager.getSessionId(), sessionManager.getSessionFile()];

  await activate(firstSession, "demo");
  assert.ok((await listBundles(firstSession, sandbox.captures)).includes("demo · loaded"));
  assert.equal(sandbox.probe.factories, 1);

  const freshSession = await sandbox.makeSession({ sessionManager });
  assert.deepEqual([sessionManager.getSessionId(), sessionManager.getSessionFile()], identity, "the fresh session uses the same manager identity");
  assert.equal(freshSession.getToolDefinition("bundle_direct"), undefined, "fresh startup does not restore the old contribution");
  assert.ok((await listBundles(freshSession, sandbox.captures)).includes("demo · not loaded"));
  assert.equal(sandbox.probe.factories, 1, "fresh startup does not import the old selection");
});

test("native activation failures leave the session usable and each bundle can be retried", async (t) => {
  const sandbox = await createSandbox(t, [
    { name: "import_failure", adapter: importErrorAdapterSource() },
    { name: "result_failure", adapter: invalidResultAdapterSource() },
    { name: "conflict_failure", adapter: adapterSource([toolSource({ name: "read", exposure: "direct" })]) },
  ]);
  const session = await sandbox.makeSession();
  assertNativeCommandSource(session);
  assert.equal(sandbox.probe.imports, 0, "unselected failed adapters are not imported at startup");

  const failures = [
    ["import_failure", "adapter"],
    ["result_failure", "adapter"],
    ["conflict_failure", "tools"],
  ];
  for (const [name, stage] of failures) {
    const activeBeforeFailure = session.getActiveToolNames().sort();
    await activate(session, name);
    const failure = sandbox.captures.notifications.at(-1);
    assert.ok(failure, `activation reports ${name}`);
    assert.equal(failure.type, "error");
    assert.match(failure.message, new RegExp(`Bundle ${name} failed at ${stage}:`));
    assert.deepEqual(session.getActiveToolNames().sort(), activeBeforeFailure, `${name} failure preserves existing tools`);
    assert.equal(session.getToolDefinition(`recovered_${name}`), undefined);
    const failedList = await listBundles(session, sandbox.captures);
    assert.ok(failedList.some((row) => row.startsWith(`${name} · failed`)), `failed selection is listed; observed ${JSON.stringify(failedList)}`);
    assert.equal(sandbox.provider.state.callCount, 0, `${name} failure does not call the model`);

    const files = sandbox.manifestFiles.get(name);
    const originalAdapterPath = files.adapterPath;
    await writeFile(originalAdapterPath, adapterSource([toolSource({ name: `recovered_${name}`, exposure: "direct" })]));
    assert.equal(files.manifest.adapter, originalAdapterPath, "retry repairs the configured adapter in place");

    await activate(session, name);
    assert.equal(session.getToolDefinition(`recovered_${name}`)?.name, `recovered_${name}`, `${name} retry registers its repaired tool`);
    assert.ok(session.getActiveToolNames().includes(`recovered_${name}`), `${name} retry activates its tool`);
    assert.ok((await listBundles(session, sandbox.captures)).includes(`${name} · loaded`));
  }

  sandbox.provider.setResponses([fauxAssistantMessage("session remained usable")]);
  await session.prompt("Check that the harness remains usable after bundle failures.");
  assert.equal(sandbox.provider.state.callCount, 1, "the harness accepts an offline request after failures and retries");
  assert.deepEqual(sandbox.errors, []);
});

test("loaded bundles keep their tool names when a previously failed bundle retries into a conflict", async (t) => {
  const sandbox = await createSandbox(t, [
    { name: "a-failed", adapter: importErrorAdapterSource() },
    { name: "b-loaded", adapter: adapterSource([toolSource({
      name: "shared_bundle_tool",
      exposure: "direct",
      description: "Tool owned by loaded bundle B.",
    })]) },
  ]);
  const session = await sandbox.makeSession();

  await activate(session, "a-failed");
  assert.match(sandbox.captures.notifications.at(-1).message, /Bundle a-failed failed at adapter:/);
  assert.ok((await listBundles(session, sandbox.captures)).some((row) => row.startsWith("a-failed · failed")));

  await activate(session, "b-loaded");
  assert.equal(session.getToolDefinition("shared_bundle_tool")?.description, "Tool owned by loaded bundle B.");
  assert.ok(session.getActiveToolNames().includes("shared_bundle_tool"));
  assert.ok((await listBundles(session, sandbox.captures)).includes("b-loaded · loaded"));
  const activeBeforeRetry = session.getActiveToolNames().sort();

  const failedBundle = sandbox.manifestFiles.get("a-failed");
  await writeFile(failedBundle.adapterPath, adapterSource([toolSource({
    name: "shared_bundle_tool",
    exposure: "direct",
    description: "Conflicting tool from bundle A.",
  })]));
  assert.equal(failedBundle.manifest.adapter, failedBundle.adapterPath);
  await activate(session, "a-failed");

  assert.match(sandbox.captures.notifications.at(-1).message, /Bundle a-failed failed at tools:.*already registered/);
  assert.equal(session.getToolDefinition("shared_bundle_tool")?.description, "Tool owned by loaded bundle B.");
  assert.deepEqual(session.getActiveToolNames().sort(), activeBeforeRetry);
  assertOneRegistration(session, "shared_bundle_tool");
  const status = await listBundles(session, sandbox.captures);
  assert.ok(status.some((row) => row.startsWith("a-failed · failed")));
  assert.ok(status.includes("b-loaded · loaded"));
  assert.deepEqual(sandbox.errors, []);
});

test("skills-only bundles add canonical skills and failed skill validation keeps existing metadata", async (t) => {
  const baseSkills = Array.from({ length: 8 }, (_, index) => ({
    name: `base-skill-${String(index + 1).padStart(2, "0")}`,
    description: `BASE_SKILL_DESCRIPTION_${String(index + 1).padStart(2, "0")}_${"b".repeat(990)}`,
  }));
  const baseDescription = baseSkills[0].description;
  const failedCollisionDescription = "FAILED_COLLISION_DESCRIPTION_93";
  const failedCollisionBody = "FAILED_COLLISION_BODY_93";
  const capSkills = Array.from({ length: 8 }, (_, index) => ({
    name: `cap-skill-${String(index + 1).padStart(2, "0")}`,
    description: `CAP_SKILL_METADATA_${String(index + 1).padStart(2, "0")}_${"c".repeat(990)}`,
    body: `CAP_SKILL_BODY_${String(index + 1).padStart(2, "0")}`,
  }));
  const sandbox = await createSandbox(t, [
    { name: "base", adapterless: true, skills: baseSkills },
    { name: "addition", adapterless: true, skill: { name: "addition-skill", description: "ADDITIVE_SKILL_DESCRIPTION_92" } },
    { name: "skill-collision", adapterless: true, skill: { name: "base-skill-01", description: failedCollisionDescription, body: failedCollisionBody } },
    { name: "skill-cap", adapterless: true, skills: capSkills },
  ]);
  const baseFiles = sandbox.manifestFiles.get("base");
  const additionFiles = sandbox.manifestFiles.get("addition");
  additionFiles.manifest.skills = [baseFiles.skillPaths[0], additionFiles.skillPaths[0]];
  await writeFile(additionFiles.manifestPath, JSON.stringify(additionFiles.manifest));

  const session = await sandbox.makeSession();
  await activate(session, "base");
  assert.ok(session.systemPrompt.includes(baseDescription), `base skill metadata is loaded; observed ${JSON.stringify({ notifications: sandbox.captures.notifications, skillNames: session.resourceLoader.getSkills().skills.map((skill) => skill.name), promptLength: session.systemPrompt.length })}`);
  assert.deepEqual(session.resourceLoader.getSkills().skills.map((skill) => skill.name).sort(), baseSkills.map((skill) => skill.name).sort());
  await activate(session, "addition");
  assert.ok(session.systemPrompt.includes("ADDITIVE_SKILL_DESCRIPTION_92"));
  const loadedSkillNames = [...baseSkills.map((skill) => skill.name), "addition-skill"].sort();
  assert.deepEqual(session.resourceLoader.getSkills().skills.map((skill) => skill.name).sort(), loadedSkillNames);
  assert.equal(session.resourceLoader.getSkills().skills.filter((skill) => skill.name === "base-skill-01").length, 1, "the shared canonical skill path is loaded once");
  assert.equal(sandbox.probe.imports, 0, "skills-only activation imports no adapters");
  const beforeFailedSkills = session.systemPrompt;

  await activate(session, "skill-collision");
  assert.match(sandbox.captures.notifications.at(-1).message, /Bundle skill-collision failed at skills:.*name collision.*base-skill-01/);
  assert.ok(session.systemPrompt.includes(baseDescription), "the existing skill metadata remains");
  assert.ok(session.systemPrompt.includes("ADDITIVE_SKILL_DESCRIPTION_92"), "the second bundle metadata remains");
  assert.ok(!session.systemPrompt.includes(failedCollisionDescription));
  assert.ok(!session.systemPrompt.includes(failedCollisionBody));
  assert.deepEqual(session.resourceLoader.getSkills().skills.map((skill) => skill.name).sort(), loadedSkillNames);
  assert.ok((await listBundles(session, sandbox.captures)).includes("base · loaded"));
  assert.ok((await listBundles(session, sandbox.captures)).includes("addition · loaded"));

  await activate(session, "skill-cap");
  assert.match(sandbox.captures.notifications.at(-1).message, /Bundle skill-cap failed at skills:.*limit is 16000/);
  assert.ok(session.systemPrompt.includes(baseDescription), "metadata-cap failure preserves the existing bundle");
  assert.ok(session.systemPrompt.includes("ADDITIVE_SKILL_DESCRIPTION_92"));
  assert.ok(!session.systemPrompt.includes("CAP_SKILL_METADATA_01"), "failed skills add no metadata");
  assert.deepEqual(session.resourceLoader.getSkills().skills.map((skill) => skill.name).sort(), loadedSkillNames);
  const afterFailedSkills = session.systemPrompt;
  assert.equal(afterFailedSkills, beforeFailedSkills, "failed skill bundles do not change the prompt");
  assert.equal(sandbox.provider.state.callCount, 0, "skill validation and listings do not call the model");
  assert.ok((await listBundles(session, sandbox.captures)).some((row) => row.startsWith("skill-cap · failed")));
  assert.deepEqual(sandbox.errors, []);
});

test("partial native tool registration is quarantined without losing late host activations and retries in place", async (t) => {
  const partialSkillDescription = "PARTIAL_FAILURE_SKILL_METADATA_94";
  const partialSkillBody = "PARTIAL_FAILURE_SKILL_BODY_94";
  const partialDeferredDescription = "PARTIAL_DEFERRED_PRIVATE_DESCRIPTION_95";
  const sandbox = await createSandbox(t, [{
    name: "partial",
    adapter: partialRegistrationAdapterSource(),
    skill: { name: "partial-skill", description: partialSkillDescription, body: partialSkillBody },
  }]);
  const lateHostPath = join(sandbox.root, "late-host-extension.ts");
  await writeFile(lateHostPath, lateHostExtensionSource());
  const session = await sandbox.makeSession({ additionalExtensionPaths: [lateHostPath] });
  assertNativeCommandSource(session);
  assert.ok(session.getToolDefinition("late_host_deferred"), "the late host tool registers at startup");
  assert.ok(session.getActiveToolNames().includes("late_host_deferred"), "the late host tool is active before bundle reload");
  const activeBeforeFailure = session.getActiveToolNames().sort();
  assert.equal(session.getToolDefinition("tool_search"), undefined, "the SDK starts without native tool_search");

  await activate(session, "partial");
  const failure = sandbox.captures.notifications.at(-1);
  const afterFailureList = await listBundles(session, sandbox.captures);
  const afterFailureSkills = session.resourceLoader.getSkills().skills.map((skill) => skill.name);
  assert.ok(failure, `partial registration failure is reported; observed ${JSON.stringify({ notifications: sandbox.captures.notifications, errors: sandbox.errors.map(({ event, error }) => ({ event, error })), activeBeforeFailure, active: session.getActiveToolNames(), tools: session.getAllTools().map((tool) => ({ name: tool.name, exposure: tool.exposure })), list: afterFailureList, skills: afterFailureSkills, promptHasSkill: session.systemPrompt.includes(partialSkillDescription), prepareLoadoutCalls: sandbox.probe.prepareLoadoutCalls })}`);
  assert.match(failure.message, /Bundle partial failed at registration:.*synthetic prepareLoadout failure/);
  assert.ok(sandbox.probe.prepareLoadoutCalls > 0, "Pi reached prepareLoadout after registration staged the tools");
  assert.deepEqual(session.getActiveToolNames().sort(), activeBeforeFailure, "failed activation restores the exact prior active tools");
  assert.ok(session.getToolDefinition("tool_search"), "failed deferred activation leaves native tool_search registered");
  assert.ok(!session.getActiveToolNames().includes("tool_search"), "failed activation does not enable tool_search");
  for (const name of ["partial_staged_tool", "partial_activation_failure", "partial_deferred_tool"]) {
    assert.equal(session.getToolDefinition(name)?.exposure, "hidden", `${name} is quarantined`);
    assert.ok(!session.getActiveToolNames().includes(name), `${name} is not active after quarantine`);
  }
  assert.ok(session.getActiveToolNames().includes("late_host_deferred"), "quarantine preserves the pending late host activation");
  assert.ok(!session.systemPrompt.includes(partialSkillDescription), "failed activation adds no skill metadata");
  assert.ok(!session.systemPrompt.includes(partialSkillBody));
  assert.ok(!session.systemPrompt.includes(partialDeferredDescription), "failed deferred tool metadata stays private");
  assert.ok(!session.resourceLoader.getSkills().skills.some((skill) => skill.name === "partial-skill"));
  const failedList = await listBundles(session, sandbox.captures);
  assert.ok(failedList.some((row) => row.startsWith("partial · failed — registration:")));
  const files = sandbox.manifestFiles.get("partial");
  assert.equal(files.manifest.adapter, files.adapterPath);

  sandbox.provider.setResponses([fauxAssistantMessage("native harness remains usable")]);
  await session.prompt("Check the native harness after partial registration failure.");
  assert.equal(sandbox.provider.state.callCount, 1, "the native harness still serves an offline model request");

  await writeFile(files.adapterPath, partialRegistrationAdapterSource({ throws: false }));
  assert.equal(files.manifest.adapter, files.adapterPath, "retry repairs the same adapter file");
  await activate(session, "partial");
  assert.equal(session.getToolDefinition("partial_staged_tool")?.exposure, "direct");
  assert.equal(session.getToolDefinition("partial_activation_failure")?.exposure, "direct");
  assert.equal(session.getToolDefinition("partial_deferred_tool")?.exposure, "deferred");
  assert.ok(session.getActiveToolNames().includes("partial_staged_tool"));
  assert.ok(session.getActiveToolNames().includes("partial_activation_failure"));
  assert.ok(session.getActiveToolNames().includes("tool_search"), "successful retry enables native tool_search");
  assert.ok(!session.getActiveToolNames().includes("partial_deferred_tool"), "successful retry keeps deferred tools inactive until searched");
  assert.ok(session.getActiveToolNames().includes("late_host_deferred"));
  assert.ok(session.systemPrompt.includes(partialSkillDescription), "successful retry adds the skill metadata");
  assert.ok(!session.systemPrompt.includes(partialSkillBody));
  assert.ok(session.resourceLoader.getSkills().skills.some((skill) => skill.name === "partial-skill"));
  assert.ok((await listBundles(session, sandbox.captures)).includes("partial · loaded"));
  assert.equal(sandbox.probe.factories, 2, "same-file retry evaluates the repaired adapter");
  assert.equal(sandbox.provider.state.callCount, 1, "retry activation does not call the model");
  const retryRequests = [];
  sandbox.provider.setResponses([(context) => {
    retryRequests.push(toolNamesIn(context.messages));
    return fauxAssistantMessage("deferred tools remain undisclosed before search");
  }]);
  await session.prompt("Check tool availability after the repaired activation.");
  assert.equal(retryRequests.length, 1);
  assert.ok(retryRequests[0].includes("tool_search"));
  assert.ok(!retryRequests[0].includes("partial_deferred_tool"), "native tool_search does not declare deferred tools before search");
  assert.equal(sandbox.provider.state.callCount, 2);
});

test("AgentSessionRuntime new, resume, and fork do not restore a process-local bundle selection", async (t) => {
  const sandbox = await createSandbox(t, [{ name: "demo", adapter: fullAdapterSource() }]);
  const lifecycleReasons = [];
  const extensionFactories = [
    (pi) => pi.on("session_start", (event) => lifecycleReasons.push(event.reason)),
  ];
  const cwd = sandbox.root;
  const sessionDir = join(sandbox.root, "sessions");
  const createRuntime = async ({ cwd: targetCwd, agentDir, sessionManager, sessionStartEvent }) => {
    const settingsManager = await sandbox.makeSettingsManager();
    const services = await createAgentSessionServices({
      cwd: targetCwd,
      agentDir,
      settingsManager,
      modelRuntime: sandbox.modelRuntime,
      resourceLoaderOptions: {
        additionalExtensionPaths: [BUNDLE_EXTENSION],
        extensionFactories,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPrompt: "",
        appendSystemPrompt: [],
      },
    });
    const created = await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
      model: sandbox.provider.getModel(),
    });
    return { ...created, services, diagnostics: services.diagnostics };
  };

  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd,
    agentDir: sandbox.agentDir,
    sessionManager: SessionManager.create(cwd, sessionDir),
  });
  assert.ok(runtime instanceof AgentSessionRuntime);
  sandbox.cleanups.push(async () => runtime.dispose());
  runtime.setRebindSession(async (session) => {
    await session.bindExtensions({ mode: "print", uiContext: sandbox.uiContext, commandContextActions: commandActions(session, runtime), onError: (error) => sandbox.errors.push(error) });
  });
  await runtime.session.bindExtensions({ mode: "print", uiContext: sandbox.uiContext, commandContextActions: commandActions(runtime.session, runtime), onError: (error) => sandbox.errors.push(error) });
  assertNativeCommandSource(runtime.session);
  assert.deepEqual(lifecycleReasons, ["startup"]);

  await activate(runtime.session, "demo");
  const requests = [];
  sandbox.provider.setResponses([
    (context) => {
      requests.push(context.messages);
      return fauxAssistantMessage(fauxToolCall("tool_search", { query: "native bundle catalog entries" }), { stopReason: "toolUse" });
    },
    (context) => {
      requests.push(context.messages);
      return fauxAssistantMessage("the old session recorded the deferred tool");
    },
  ]);
  await runtime.session.prompt("Record the selected bundle loadout in this session.");
  assert.equal(requests.length, 2);
  assertTranscriptHasTool(runtime.session, "bundle_deferred");
  const originalSessionFile = runtime.session.sessionFile;
  assert.ok(originalSessionFile, "the recorded runtime session has a file");
  const originalTranscript = await readFile(originalSessionFile, "utf8");
  assert.ok(originalTranscript.includes("bundle_deferred"), "the old session file retains its tool declaration");
  assert.equal(sandbox.probe.factories, 1);

  const created = await runtime.newSession();
  assert.equal(created.cancelled, false);
  assert.ok(lifecycleReasons.includes("new"), "AgentSessionRuntime emits a new-session lifecycle event");
  assert.equal(runtime.session.getToolDefinition("bundle_deferred"), undefined);
  assert.ok((await listBundles(runtime.session, sandbox.captures)).includes("demo · not loaded"));
  assert.equal(sandbox.probe.factories, 1, "newSession does not inherit or import the old bundle selection");

  const resumed = await runtime.switchSession(originalSessionFile);
  assert.equal(resumed.cancelled, false);
  assert.ok(lifecycleReasons.includes("resume"), "AgentSessionRuntime emits a resume lifecycle event");
  assertTranscriptHasTool(runtime.session, "bundle_deferred");
  assert.equal(runtime.session.getToolDefinition("bundle_deferred"), undefined, "resume does not reload the process-local contribution");
  assert.ok((await listBundles(runtime.session, sandbox.captures)).includes("demo · not loaded"));
  assert.equal(sandbox.probe.factories, 1, "resume does not import the old bundle selection");

  const leafId = runtime.session.sessionManager.getLeafId();
  assert.ok(leafId, "the resumed transcript has a forkable leaf");
  const forked = await runtime.fork(leafId, { position: "at" });
  assert.equal(forked.cancelled, false);
  assert.ok(lifecycleReasons.includes("fork"), "AgentSessionRuntime emits a fork lifecycle event");
  assertTranscriptHasTool(runtime.session, "bundle_deferred");
  assert.equal(runtime.session.getToolDefinition("bundle_deferred"), undefined, "fork does not reload the process-local contribution");
  assert.ok((await listBundles(runtime.session, sandbox.captures)).includes("demo · not loaded"));
  assert.equal(sandbox.probe.factories, 1, "fork does not import the old bundle selection");
  assert.equal(sandbox.provider.state.callCount, 2, "runtime replacement and listing make no model calls");
  assert.deepEqual(sandbox.errors, []);
});
