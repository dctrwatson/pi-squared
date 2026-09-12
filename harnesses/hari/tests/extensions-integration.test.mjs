import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { InMemoryCredentialStore, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  loadSkills,
} from "@earendil-works/pi-coding-agent";

import hariExtension from "../src/index.ts";
import { prepareManagerLaunch, resourceArguments } from "../src/cli.ts";
import {
  addManager,
  createProject,
  initializeCoordination,
  integrationResources,
  readProject,
  replaceIndexItems,
  replaceProjectItems,
} from "../src/coordination.ts";
import { initializeCoordinationRepository } from "../src/coordination-git.ts";

const harnessRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(harnessRoot, "..", "..");
const bundledWorkspaceLauncher = join(repositoryRoot, "extensions", "workspace", "launcher.ts");
const workspaceCreateEntry = join(harnessRoot, "src", "workspace-create.ts");
const hariEntry = join(harnessRoot, "src", "index.ts");

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function sessionEntries(session) {
  try {
    return readFileSync(session, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function extensionPi(session) {
  const handlers = new Map();
  const tools = new Map([
    ["read", { name: "read" }],
    ["bash", { name: "bash" }],
    ["edit", { name: "edit" }],
    ["write", { name: "write" }],
    ["grep", { name: "grep" }],
    ["find", { name: "find" }],
    ["ls", { name: "ls" }],
  ]);
  const active = [];
  const appended = [];
  const emitted = [];
  const commands = new Map();
  const shortcuts = new Map();

  const append = (entry) => {
    appended.push(entry);
    if (session) appendFileSync(session, `${JSON.stringify(entry)}\n`);
  };
  const api = {
    events: { emit(name, data) { emitted.push({ name, data }); } },
    on(name, handler) {
      const registered = handlers.get(name) ?? [];
      registered.push(handler);
      handlers.set(name, registered);
    },
    registerTool(definition) { tools.set(definition.name, definition); },
    registerCommand(name, definition) { commands.set(name, definition); },
    registerShortcut(name, definition) { shortcuts.set(name, definition); },
    appendEntry(customType, data) { append({ type: "custom", customType, data }); },
    setSessionName(name) { append({ type: "session_info", name }); },
    getAllTools() { return [...tools.values()]; },
    getActiveTools() { return [...active]; },
    setActiveTools(names) { active.splice(0, active.length, ...names); },
    getThinkingLevel() { return "off"; },
    async exec() { return { code: 0, stdout: "", stderr: "" }; },
    sendUserMessage() {},
  };

  return {
    api,
    handlers,
    active,
    appended,
    emitted,
    tools,
    commands,
    shortcuts,
    async emit(name, event, ctx) {
      let current = event;
      const outputs = [];
      for (const handler of handlers.get(name) ?? []) {
        const output = await handler(current, ctx);
        outputs.push(output);
        if (name === "tool_call" && output?.block) return { event: current, outputs, blocked: output };
        if (name === "before_agent_start" && output && typeof output === "object") {
          current = Object.assign(current, output);
        }
      }
      return { event: current, outputs };
    },
  };
}

function extensionContext(cwd, session, notices = []) {
  return {
    cwd,
    mode: "tui",
    hasUI: true,
    model: undefined,
    scopedModels: [],
    isIdle: () => true,
    sessionManager: {
      getSessionFile: () => session,
      getSessionId: () => "integration-manager-session",
      getSessionName: () => undefined,
      getEntries: () => sessionEntries(session),
      getBranch: () => sessionEntries(session),
    },
    ui: {
      setStatus() {},
      notify(message, level) { notices.push({ message, level }); },
      confirm: async () => true,
      select: async () => undefined,
      input: async () => undefined,
      setEditorText() {},
    },
    shutdown() {},
  };
}

function fakeSubagentBackend(calls) {
  let sequence = 0;
  return (options) => {
    const run = { id: `integration-run-${++sequence}`, runtime: "pi" };
    const complete = (text) => {
      options.onEvent({ type: "run_started", run });
      options.onEvent({
        type: "message_completed",
        run,
        message: { role: "assistant", text: `Fake child result ${calls.length}`, thinking: "", stopReason: "stop" },
      });
      options.onEvent({ type: "run_settled", run });
      return { run };
    };
    return {
      runtime: "pi",
      displayName: "Fake Pi",
      capabilities: {
        extensionUi: false,
        steering: true,
        queuedFollowUp: true,
        settledFollowUp: true,
        modelControls: false,
        thinkingControls: false,
        sessionHistory: false,
        sessionFile: false,
        usage: false,
        toolOutput: false,
      },
      async start() {},
      async stop() {},
      getDiagnostics() { return ""; },
      async prompt(text) {
        calls.push({ cwd: options.cwd, args: [...options.args], text });
        return complete(text);
      },
      async steer() {},
      async followUp(text) {
        calls.push({ cwd: options.cwd, args: [...options.args], text });
        return complete(text);
      },
      async abort() {},
      async getState() {
        return {
          connection: { id: "integration-fake-pi", runtime: "pi" },
          thinkingLevel: "off",
          isStreaming: false,
          isCompacting: false,
        };
      },
      async getHistory() { return []; },
      async getSessionStats() { return {}; },
      async getAvailableModels() { return []; },
      async setModel() { throw new Error("unsupported in integration fake"); },
      async cycleModel() { return null; },
      async setThinkingLevel() {},
      async cycleThinkingLevel() { return null; },
      respondToExtensionUI() {},
    };
  };
}

test("ordinary Pi package discovery loads only bundled generic resources", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-squared-package-discovery-"));
  const home = join(root, "home");
  const cwd = join(root, "ordinary-pi");
  const agentDir = join(home, ".pi", "agent");
  const previousEnvironment = { ...process.env };
  const manifest = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
    packages: [repositoryRoot],
  });
  let session;
  t.after(async () => {
    session?.dispose();
    process.env = previousEnvironment;
    await rm(root, { recursive: true, force: true });
  });

  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE = "1";
  delete process.env.HARI_ROLE;
  delete process.env.HARI_COORDINATION_DIR;
  delete process.env.HARI_PROJECT_ID;
  delete process.env.HARI_MANAGER_ID;
  await Promise.all([mkdir(cwd, { recursive: true }), mkdir(agentDir, { recursive: true })]);
  execFileSync("git", ["init", "-q", "-b", "main", cwd]);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
  });
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });

  assert.deepEqual(manifest.pi, { extensions: ["./extensions"], skills: ["./skills"] });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const discovered = resourceLoader.getExtensions().extensions.map((extension) => extension.path);
  assert.ok(discovered.length > 0);
  assert.ok(discovered.every((path) => path.startsWith(join(repositoryRoot, "extensions"))));
  assert.ok(!discovered.some((path) => path.includes(join("harnesses", "hari"))));
  assert.ok(!discovered.includes(hariEntry));
  assert.ok(!discovered.includes(workspaceCreateEntry));

  ({ session } = await createAgentSession({
    cwd,
    agentDir,
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
    modelRuntime,
    noTools: "builtin",
  }));
  await session.bindExtensions({ mode: "print" });
  const configured = session.getAllTools().map((tool) => tool.name);
  for (const name of ["hari_projects", "hari_git", "hari_manager_launch", "manager_context", "manager_report"]) {
    assert.ok(!configured.includes(name), `ordinary Pi must not load Hari tool ${name}`);
  }
  assert.doesNotMatch(session.systemPrompt, /# Hari(?: manager)?\n/);
});

test("Hari loads real Pi SDK extensions offline without a launcher or subagents", async (t) => {
  const launcher = bundledWorkspaceLauncher;
  const workspaceDirectory = dirname(launcher);
  const piExtensions = dirname(workspaceDirectory);
  const root = await mkdtemp(join(tmpdir(), "hari-real-sdk-smoke-"));
  const home = join(root, "home");
  const cwd = join(root, "fixture");
  const agentDir = join(home, ".pi", "agent");
  const coordination = join(home, "Projects", "primeradiant");
  const previousEnvironment = { ...process.env };
  let session;
  t.after(async () => { await rm(root, { recursive: true, force: true }); });

  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE = "1";
  process.env.HARI_ROLE = "hari";
  delete process.env.HARI_COORDINATION_DIR;
  delete process.env.HARI_PROJECT_ID;
  delete process.env.HARI_MANAGER_ID;
  try {
    await Promise.all([mkdir(cwd, { recursive: true }), mkdir(agentDir, { recursive: true })]);
    await initializeCoordination(coordination, {
      version: 1,
      workspaceLauncher: launcher,
    });

    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: "",
      appendSystemPrompt: [],
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    assert.deepEqual(resourceLoader.getExtensions().extensions.map((extension) => extension.path), [
      workspaceCreateEntry,
      hariEntry,
    ]);

    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    ({ session } = await createAgentSession({
      cwd,
      agentDir,
      resourceLoader,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager,
      modelRuntime,
      noTools: "builtin",
    }));
    assert.deepEqual(await modelRuntime.listCredentials(), []);
    await session.bindExtensions({ mode: "print" });

    const active = session.getActiveToolNames();
    assert.ok(active.includes("create_workspace"));
    assert.ok(active.includes("hari_projects"));
    assert.ok(active.includes("hari_manager_launch"));
    const configured = session.getAllTools().map((tool) => tool.name);
    assert.ok(!configured.includes("launch_pi"));
    assert.ok(!configured.includes("subagent"));
  } finally {
    session?.dispose();
    process.env = previousEnvironment;
  }
});

test("Hari composes real workspace and subagent extensions in isolated role sessions", async (t) => {
  const launcher = bundledWorkspaceLauncher;
  const workspaceDirectory = dirname(launcher);
  const piExtensions = dirname(workspaceDirectory);
  const workspaceEntry = join(workspaceDirectory, "index.ts");
  const subagentsEntry = join(piExtensions, "subagents", "index.ts");
  const coordinatorWorkspaceEntry = workspaceCreateEntry;
  const root = await mkdtemp(join(tmpdir(), "hari-extensions-integration-"));
  const home = join(root, "home");
  const coordination = join(home, "Projects", "primeradiant");
  const projectRepository = join(root, "project-repository");
  const previousEnvironment = { ...process.env };
  t.after(async () => { await rm(root, { recursive: true, force: true }); });

  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  process.env.PI_CODING_AGENT_DIR = join(home, ".pi", "agent");
  delete process.env.HARI_COORDINATION_DIR;
  try {
    await mkdir(home, { recursive: true });
    await mkdir(projectRepository);
    execFileSync("git", ["init", "-q", "-b", "main", projectRepository]);
    git(projectRepository, "config", "user.email", "hari-integration@example.invalid");
    git(projectRepository, "config", "user.name", "Hari integration test");
    await writeFile(join(projectRepository, "AGENTS.md"), "# Isolated project guidance\n- Keep the assigned change focused.\n");
    await writeFile(join(projectRepository, "README.md"), "isolated extension integration fixture\n");
    git(projectRepository, "add", "AGENTS.md", "README.md");
    git(projectRepository, "commit", "-qm", "initial fixture");

    const config = {
      version: 1,
      workspaceLauncher: launcher,
    };
    assert.deepEqual(integrationResources(config), {
      workspaceExtension: workspaceEntry,
      subagentExtension: subagentsEntry,
    });
    const hariResources = resourceArguments(config);
    const managerResources = resourceArguments(config, "manager");
    const extensionValues = (args) => args.flatMap((value, index) => args[index - 1] === "-e" ? [value] : []);
    for (const resources of [hariResources, managerResources]) {
      assert.ok(resources.includes("--no-extensions"));
      assert.ok(resources.includes("--no-skills"));
      assert.ok(resources.includes("--no-context-files"));
    }
    assert.equal(managerResources[managerResources.indexOf("--system-prompt") + 1], "");
    assert.equal(managerResources[managerResources.indexOf("--append-system-prompt") + 1], "");

    await initializeCoordinationRepository(coordination);
    await initializeCoordination(coordination, config);
    const project = await createProject(coordination, { name: "Extension integration" });
    await replaceProjectItems(coordination, project.id, "decisions", ["Keep coordination records single-writer."]);
    await replaceIndexItems(coordination, "decisions", ["Do not share checkout writes between agents."]);

    process.env.HARI_ROLE = "hari";
    delete process.env.HARI_PROJECT_ID;
    delete process.env.HARI_MANAGER_ID;
    const coordinator = extensionPi(join(coordination, "hari.jsonl"));
    const { default: workspaceExtension } = await import(pathToFileURL(workspaceEntry).href);
    const { default: workspaceCreation } = await import(pathToFileURL(coordinatorWorkspaceEntry).href);
    await workspaceCreation(coordinator.api);
    hariExtension(coordinator.api);
    const coordinatorContext = extensionContext(coordination, join(coordination, "hari.jsonl"));
    await coordinator.emit("session_start", {}, coordinatorContext);
    assert.ok(coordinator.active.includes("create_workspace"));
    assert.ok(!coordinator.active.includes("launch_pi"));
    assert.ok(!coordinator.active.includes("workspace_merge_finalize"));
    assert.equal(coordinator.tools.has("launch_pi"), false);
    assert.equal(coordinator.tools.has("workspace_merge_finalize"), false);
    assert.equal(coordinator.commands.has("workspace"), false);
    assert.equal(coordinator.commands.has("ws"), false);
    assert.equal(coordinator.handlers.has("resources_discover"), false, "the coordinator has no workspace resource lifecycle hook");
    assert.equal(coordinator.handlers.get("session_start")?.length, 1, "only Hari registers the coordinator session-start hook");
    assert.equal(coordinator.handlers.get("session_shutdown")?.length, 1, "only Hari registers the coordinator session-shutdown hook");

    const missingCwd = await coordinator.emit("tool_call", {
      toolName: "create_workspace",
      input: { branch: "feature/missing-cwd" },
    }, coordinatorContext);
    assert.equal(missingCwd.blocked?.block, true);
    const coordinationCwd = await coordinator.emit("tool_call", {
      toolName: "create_workspace",
      input: { branch: "feature/coordination-cwd", cwd: coordination },
    }, coordinatorContext);
    assert.equal(coordinationCwd.blocked?.block, true);

    const createCall = {
      toolName: "create_workspace",
      input: { branch: "feature/integration", cwd: projectRepository },
    };
    const allowedCreate = await coordinator.emit("tool_call", createCall, coordinatorContext);
    assert.equal(allowedCreate.blocked, undefined);
    const created = await coordinator.tools.get("create_workspace").execute("create-workspace", createCall.input, undefined, undefined, coordinatorContext);
    assert.equal(git(created.details.cwd, "branch", "--show-current"), "feature/integration");

    const { WorkspaceService } = await import(pathToFileURL(join(workspaceDirectory, "core.ts")).href);
    const projectService = new WorkspaceService(projectRepository);
    const workspaceState = await projectService.state();
    const invalidCreate = {
      toolName: "create_workspace",
      input: { branch: "invalid branch", cwd: projectRepository },
    };
    const invalidGate = await coordinator.emit("tool_call", invalidCreate, coordinatorContext);
    assert.equal(invalidGate.blocked, undefined);
    await assert.rejects(
      coordinator.tools.get("create_workspace").execute("invalid-create-workspace", invalidCreate.input, undefined, undefined, coordinatorContext),
    );
    assert.equal(await workspaceState.getWorkspace("invalid branch"), undefined, "a failed create_workspace call leaves no activation record");
    const workspace = await workspaceState.getWorkspace("feature/integration");
    assert.ok(workspace);
    assert.equal(workspace.cwd, created.details.cwd);
    assert.equal(await workspaceState.readLease(workspace.session), undefined, "create_workspace leaves the target inactive");
    const coordinatorState = await new WorkspaceService(coordination).state();
    assert.deepEqual(await coordinatorState.listWorkspaces(), [], "the global coordinator did not acquire a project workspace binding");

    await addManager(coordination, project.id, {
      id: "extension-manager",
      assignment: "Implement the isolated extension integration fixture.",
      acceptanceCriteria: ["Exercise the workspace and subagent integration seam."],
      constraints: ["Do not write shared Hari records directly."],
      checkout: workspace.cwd,
      branch: workspace.branch,
    });
    const managerLaunch = await prepareManagerLaunch(coordination, project.id, "extension-manager", "start");
    assert.equal(managerLaunch.cwd, workspace.cwd);
    assert.equal(managerLaunch.session, workspace.session);
    assert.ok(managerLaunch.args.includes(subagentsEntry), "manager launch keeps the real subagent resource in its explicit profile");
    assert.ok(await workspaceState.readLease(workspace.session), "manager preflight activated the exact prepared workspace session");

    process.env.HARI_ROLE = "manager";
    process.env.HARI_PROJECT_ID = project.id;
    process.env.HARI_MANAGER_ID = "extension-manager";
    const managerAgentDir = join(home, ".pi", "agent");
    await Promise.all([
      mkdir(managerAgentDir, { recursive: true }),
      writeFile(join(managerAgentDir, "SYSTEM.md"), "AMBIENT MANAGER SYSTEM MUST NOT SURVIVE\n"),
      writeFile(join(managerAgentDir, "APPEND_SYSTEM.md"), "AMBIENT MANAGER APPEND MUST NOT SURVIVE\n"),
      writeFile(join(managerAgentDir, "AGENTS.md"), "AMBIENT MANAGER AGENTS MUST NOT SURVIVE\n"),
    ]);
    const managerSettings = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const managerSystemPrompt = managerResources[managerResources.indexOf("--system-prompt") + 1];
    const managerAppendSystemPrompt = managerResources[managerResources.indexOf("--append-system-prompt") + 1];
    const managerResourcesLoader = new DefaultResourceLoader({
      cwd: workspace.cwd,
      agentDir: managerAgentDir,
      settingsManager: managerSettings,
      noExtensions: managerResources.includes("--no-extensions"),
      noSkills: managerResources.includes("--no-skills"),
      noPromptTemplates: managerResources.includes("--no-prompt-templates"),
      noThemes: managerResources.includes("--no-themes"),
      noContextFiles: managerResources.includes("--no-context-files"),
      systemPrompt: managerSystemPrompt,
      appendSystemPrompt: [managerAppendSystemPrompt],
    });
    await managerResourcesLoader.reload();
    assert.equal(managerResourcesLoader.getSystemPrompt(), undefined);
    assert.deepEqual(managerResourcesLoader.getAppendSystemPrompt(), []);
    assert.deepEqual(managerResourcesLoader.getAgentsFiles().agentsFiles, []);
    const managerFaux = fauxProvider({ provider: "hari-manager-sdk" });
    let managerRequestPrompt;
    managerFaux.setResponses([async (context) => {
      managerRequestPrompt = context.systemPrompt;
      return fauxAssistantMessage("local manager SDK response");
    }]);
    const managerRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    managerRuntime.registerNativeProvider(managerFaux.provider);
    let managerSession;
    try {
      ({ session: managerSession } = await createAgentSession({
        cwd: workspace.cwd,
        agentDir: managerAgentDir,
        resourceLoader: managerResourcesLoader,
        sessionManager: SessionManager.open(workspace.session),
        settingsManager: managerSettings,
        modelRuntime: managerRuntime,
        model: managerFaux.getModel(),
        noTools: "builtin",
      }));
      await managerSession.bindExtensions({ mode: "print" });
      assert.match(managerSession.systemPrompt, /You are an expert coding assistant operating inside pi/);
      assert.doesNotMatch(managerSession.systemPrompt, /AMBIENT MANAGER/);
      await managerSession.prompt("Verify the manager prompt composition.");
      assert.equal(managerFaux.state.callCount, 1, "the test uses one local faux request");
      assert.match(managerRequestPrompt, /You are an expert coding assistant operating inside pi/);
      assert.match(managerRequestPrompt, /## Workspace coding guidance/);
      assert.match(managerRequestPrompt, /Active workspace PM: `\.\.\/pm`/);
      assert.equal([...managerRequestPrompt.matchAll(/# Hari manager/g)].length, 1);
      assert.doesNotMatch(managerRequestPrompt, /AMBIENT MANAGER/);
      assert.doesNotMatch(managerRequestPrompt, /# Isolated project guidance/);
    } finally {
      managerSession?.dispose();
    }
    const childCalls = [];
    const manager = extensionPi(workspace.session);
    const subagents = await import(pathToFileURL(subagentsEntry).href);
    workspaceExtension(manager.api);
    subagents.default(manager.api, { backendFactory: fakeSubagentBackend(childCalls) });
    hariExtension(manager.api);
    const managerContext = extensionContext(workspace.cwd, workspace.session);
    await manager.emit("session_start", {}, managerContext);
    assert.ok(manager.active.includes("subagent"));
    assert.ok(!manager.active.includes("launch_pi"));
    assert.ok(!manager.active.includes("workspace_merge_finalize"));
    assert.ok(manager.appended.some((entry) => entry.customType === "hari-manager-identity"));
    assert.ok((await readProject(coordination, project.id)).managers[0].sessionIdentityConfirmedAt);

    const resources = await manager.emit("resources_discover", {}, managerContext);
    const skillPaths = resources.outputs.flatMap((output) => output?.skillPaths ?? []);
    assert.ok(skillPaths.some((path) => path.endsWith("workspace-pm/SKILL.md")));
    const loadedSkills = loadSkills({
      cwd: workspace.cwd,
      agentDir: join(home, ".pi", "agent"),
      skillPaths,
      includeDefaults: false,
    });
    assert.deepEqual(loadedSkills.diagnostics, []);
    assert.ok(loadedSkills.skills.some((skill) => skill.name === "workspace-pm"));
    const selectedTools = [...manager.active];
    const promptGuidelines = selectedTools.flatMap((name) => manager.tools.get(name)?.promptGuidelines ?? []);
    const builtinTools = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
    const customTools = selectedTools
      .filter((name) => !builtinTools.has(name))
      .map((name) => manager.tools.get(name));
    assert.ok(customTools.every((tool) => tool?.parameters && typeof tool.execute === "function"));
    assert.ok(customTools.some((tool) => tool.name === "subagent" && tool.promptGuidelines?.some((guideline) => /Before subagent create/.test(guideline))));
    const nativeSettings = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const nativeResources = new DefaultResourceLoader({
      cwd: workspace.cwd,
      agentDir: join(home, ".pi", "agent"),
      settingsManager: nativeSettings,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: "",
      appendSystemPrompt: [],
      skillsOverride: () => ({ skills: loadedSkills.skills, diagnostics: [] }),
    });
    await nativeResources.reload();
    assert.ok(nativeResources.getSkills().skills.some((skill) => skill.name === "workspace-pm"));
    const nativeRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    let nativeSession;
    let nativeBase;
    try {
      ({ session: nativeSession } = await createAgentSession({
        cwd: workspace.cwd,
        agentDir: join(home, ".pi", "agent"),
        resourceLoader: nativeResources,
        sessionManager: SessionManager.inMemory(workspace.cwd),
        settingsManager: nativeSettings,
        modelRuntime: nativeRuntime,
        tools: selectedTools,
        customTools,
      }));
      assert.deepEqual(nativeSession.getActiveToolNames(), selectedTools);
      nativeBase = nativeSession.systemPrompt;
    } finally {
      nativeSession?.dispose();
    }
    const beforeAgent = await manager.emit("before_agent_start", {
      type: "before_agent_start",
      prompt: "Start the manager fixture.",
      systemPrompt: nativeBase,
      systemPromptOptions: {
        cwd: workspace.cwd,
        selectedTools,
        promptGuidelines,
        skills: loadedSkills.skills,
      },
    }, managerContext);
    const workspacePm = loadedSkills.skills.find((skill) => skill.name === "workspace-pm");
    assert.ok(workspacePm);
    assert.ok(beforeAgent.event.systemPrompt.startsWith(nativeBase), "Pi's native coding base is preserved before extension additions");
    assert.match(beforeAgent.event.systemPrompt, /You are an expert coding assistant operating inside pi/);
    assert.match(beforeAgent.event.systemPrompt, /Before subagent create, check retained agents/);
    assert.match(beforeAgent.event.systemPrompt, /## Workspace coding guidance/);
    assert.match(beforeAgent.event.systemPrompt, /Active workspace PM: `\.\.\/pm`/);
    assert.ok(beforeAgent.event.systemPrompt.includes(workspacePm.filePath));
    assert.ok(beforeAgent.event.systemPrompt.includes(workspacePm.description));
    assert.equal([...beforeAgent.event.systemPrompt.matchAll(/# Hari manager/g)].length, 1);
    assert.doesNotMatch(beforeAgent.event.systemPrompt, /Implement the isolated extension integration fixture/);
    assert.doesNotMatch(beforeAgent.event.systemPrompt, /# Isolated project guidance/);

    await writeFile(join(workspace.cwd, "source-change.txt"), "uncommitted source change\n");
    const dormantInput = {
      action: "create",
      name: "dormant-worker",
      persona: "worker",
      purpose: "Retain a dormant worker for this fixture",
    };
    const dormantGate = await manager.emit("tool_call", { toolName: "subagent", input: dormantInput }, managerContext);
    assert.equal(dormantGate.blocked, undefined, "dormant creation does not require a refreshed manager view");
    const dormant = await manager.tools.get("subagent").execute("dormant-worker", dormantInput, undefined, undefined, managerContext);
    assert.equal(dormant.details.ok, true);
    const listGate = await manager.emit("tool_call", { toolName: "subagent", input: { action: "list" } }, managerContext);
    assert.equal(listGate.blocked, undefined);
    const statusGate = await manager.emit("tool_call", { toolName: "subagent", input: { action: "status", id: dormant.details.subagent.id } }, managerContext);
    assert.equal(statusGate.blocked, undefined);
    const stopGate = await manager.emit("tool_call", { toolName: "subagent", input: { action: "stop", id: dormant.details.subagent.id } }, managerContext);
    assert.equal(stopGate.blocked, undefined);
    const stopped = await manager.tools.get("subagent").execute("stop-dormant-worker", { action: "stop", id: dormant.details.subagent.id }, undefined, undefined, managerContext);
    assert.equal(stopped.details.subagent.status, "stopped");

    const oversizedInput = {
      action: "create",
      name: "too-large-worker",
      persona: "worker",
      purpose: "Reject an oversized parent context",
      prompt: "Do not run this fake child.",
      context: "x".repeat(8_000),
    };
    const missingVisibleContext = await manager.emit("tool_call", { toolName: "subagent", input: { ...oversizedInput } }, managerContext);
    assert.match(missingVisibleContext.blocked?.reason ?? "", /manager_context/);
    const refreshed = await manager.tools.get("manager_context").execute("refresh-manager-context", {});
    assert.match(refreshed.content[0].text, /Implement the isolated extension integration fixture/);
    assert.doesNotMatch(refreshed.content[0].text, /# Hari manager/);
    await manager.emit("context", {
      messages: [{
        role: "toolResult",
        toolName: "manager_context",
        details: refreshed.details,
        content: refreshed.content,
        isError: false,
      }],
    }, managerContext);
    const oversized = await manager.emit("tool_call", { toolName: "subagent", input: oversizedInput }, managerContext);
    assert.equal(oversized.blocked?.block, true);
    assert.match(oversized.blocked?.reason ?? "", /8000/);

    const createChild = {
      action: "create",
      name: "integration-worker",
      persona: "worker",
      purpose: "Return an isolated fixture result",
      prompt: "Return the fixture result.",
      context: "Caller-supplied context survives Hari injection.",
    };
    const createGate = await manager.emit("tool_call", { toolName: "subagent", input: createChild }, managerContext);
    assert.equal(createGate.blocked, undefined);
    assert.match(createChild.context, /Caller-supplied context survives Hari injection/);
    assert.match(createChild.context, /Implement the isolated extension integration fixture/);
    assert.match(createChild.context, /Keep coordination records single-writer/);
    assert.match(createChild.context, new RegExp(workspace.cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(createChild.context, /Do not write shared Hari records directly/);
    const child = await manager.tools.get("subagent").execute("create-integration-worker", createChild, undefined, undefined, managerContext);
    assert.equal(child.details.ok, true, child.content[0].text);
    assert.match(child.content[0].text, /Fake child result/);

    const promptChild = {
      action: "prompt",
      id: child.details.subagent.id,
      prompt: "Return a follow-up fixture result.",
      context: "Caller follow-up context survives too.",
    };
    const promptGate = await manager.emit("tool_call", { toolName: "subagent", input: promptChild }, managerContext);
    assert.equal(promptGate.blocked, undefined);
    assert.match(promptChild.context, /Caller follow-up context survives too/);
    const followUp = await manager.tools.get("subagent").execute("prompt-integration-worker", promptChild, undefined, undefined, managerContext);
    assert.equal(followUp.details.ok, true, followUp.content[0].text);
    assert.match(followUp.content[0].text, /Fake child result/);
    assert.equal(childCalls.length, 2);
    for (const call of childCalls) {
      assert.equal(call.cwd, workspace.cwd);
      assert.ok(call.args.includes("--no-extensions"));
      assert.ok(!call.args.includes(hariEntry), "a fresh child is not a manager resource clone");
      assert.ok(!call.args.includes(workspaceEntry), "a fresh child does not inherit workspace resources");
      assert.match(call.text, /^## Parent-provided context/);
      assert.match(call.text, /Prepared checkout/);
      assert.match(call.text, /Caller/);
    }

    await manager.emit("session_shutdown", { reason: "reload" }, managerContext);
    assert.ok(await workspaceState.readLease(workspace.session), "workspace reload retains its same-process lease");
    const reloaded = extensionPi(workspace.session);
    workspaceExtension(reloaded.api);
    subagents.default(reloaded.api, { backendFactory: fakeSubagentBackend([]) });
    hariExtension(reloaded.api);
    const reloadedContext = extensionContext(workspace.cwd, workspace.session);
    await reloaded.emit("session_start", {}, reloadedContext);
    assert.ok(reloaded.appended.some((entry) => entry.customType === "hari-manager-identity"), "the exact persisted identity permits reload");
    await reloaded.emit("session_shutdown", { reason: "exit" }, reloadedContext);
    assert.equal(await workspaceState.readLease(workspace.session), undefined, "normal shutdown releases the workspace lease");
  } finally {
    process.env = previousEnvironment;
  }
});
