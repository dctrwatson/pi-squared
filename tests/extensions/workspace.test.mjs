import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  WorkspaceService,
  parseCommandWords,
  parseNewWorkspace,
  parseWorkspaceMerge,
  parseWorkspaceTarget,
} from "../../extensions/workspace/core.ts";
import { GitRepository } from "../../extensions/workspace/git.ts";
import { NodeProcessRunner } from "../../extensions/workspace/process.ts";
import { stableHash } from "../../extensions/workspace/state.ts";
import { PiSessionStore, workspaceMetadata } from "../../extensions/workspace/sessions.ts";
import { parseLauncherArguments, resolveLaunch, validateForwardedPiArguments } from "../../extensions/workspace/launcher.ts";
import workspaceExtension, { WORKSPACE_MERGE_FINALIZE_TOOL, WORKSPACE_PM_SKILL_PATH, handleWorkspace, picker, staleWorkspaceTarget } from "../../extensions/workspace/index.ts";

const WORKSPACE_HELP_TEXT = `Usage: /workspace or /ws [target] [--worktree]
       /workspace or /ws new
       /workspace or /ws new <branch> [--from <ref|current>] [--worktree]
       /workspace or /ws merge <base-branch> [--squash]
       /workspace or /ws prune

No argument: Open the workspace picker.
target: Local branch, pull request number, or GitHub pull request URL.
branch:<name>: Force a local branch target.
new: Start a fresh session for the current branch, or create a branch workspace.
--from: Select the new branch base; current uses the current commit.
--worktree: Use a managed worktree.
merge: Prepare, merge, and remove the current managed workspace.
--squash: Create one commit on the base branch.
prune: Remove inactive managed workspaces.
--help, -h: Show this help.`;

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function gitSucceeds(cwd, ...args) {
  return spawnSync("git", args, { cwd, encoding: "utf8" }).status === 0;
}

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "pi-workspace-"));
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "tests@example.invalid");
  git(root, "config", "user.name", "Workspace Tests");
  await writeFile(join(root, "README.md"), "base\n");
  git(root, "add", "README.md");
  git(root, "commit", "-m", "base");
  return root;
}

async function removeRepository(root) {
  await rm(root, { recursive: true, force: true });
}

function samePr(left, right) {
  if (!left || !right) return left === right;
  return left.number === right.number
    && left.url.toLowerCase() === right.url.toLowerCase()
    && left.baseRepository.toLowerCase() === right.baseRepository.toLowerCase()
    && left.headRepository.toLowerCase() === right.headRepository.toLowerCase()
    && left.headRef === right.headRef;
}

class FakeSessions {
  constructor(root) {
    this.root = join(root, ".git", "test-sessions");
    this.entries = new Map();
    this.forks = [];
    this.binds = [];
    this.sequence = 0;
  }

  async create(metadata) {
    const path = join(this.root, "sessions", `${++this.sequence}.jsonl`);
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, [
      JSON.stringify({ type: "session", version: 3, id: `test-${this.sequence}`, timestamp: new Date().toISOString(), cwd: metadata.cwd }),
      JSON.stringify({ type: "custom", id: `metadata-${this.sequence}`, parentId: null, timestamp: new Date().toISOString(), customType: "pi-workspace", data: metadata }),
      "",
    ].join("\n"));
    this.entries.set(path, metadata);
    return path;
  }

  async createLegacy(metadata) {
    const path = join(this.root, "sessions", `${++this.sequence}.jsonl`);
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, `${JSON.stringify({ type: "session", version: 3, id: `test-${this.sequence}`, timestamp: new Date().toISOString(), cwd: metadata.cwd })}\n`);
    this.entries.set(path, undefined);
    return path;
  }

  async fork(source, metadata) {
    this.forks.push({ source, metadata });
    return this.create(metadata);
  }

  async bind(path, metadata) {
    this.binds.push({ path, metadata });
    if (!this.entries.has(path)) return false;
    this.entries.set(path, metadata);
    await writeFile(path, `${JSON.stringify({ type: "custom", id: `metadata-${++this.sequence}`, parentId: null, timestamp: new Date().toISOString(), customType: "pi-workspace", data: metadata })}\n`, { flag: "a" });
    return this.validate(path, metadata);
  }

  async rebind(path, metadata) {
    if (!this.entries.has(path)) return false;
    this.entries.set(path, metadata);
    await writeFile(path, `${JSON.stringify({ type: "custom", id: `metadata-${++this.sequence}`, parentId: null, timestamp: new Date().toISOString(), customType: "pi-workspace", data: metadata })}\n`, { flag: "a" });
    return this.validate(path, metadata);
  }

  async validate(path, metadata) {
    const entry = this.entries.get(path);
    return entry?.repository === metadata.repository
      && entry.branch === metadata.branch
      && resolve(entry.cwd) === resolve(metadata.cwd)
      && samePr(entry.pr, metadata.pr);
  }
}

function switcher(calls, cancelled = false) {
  return async (session) => {
    calls.push(session);
    return { cancelled };
  };
}

async function mapWorkspace(service, sessions, branch, cwd, pr) {
  const state = await service.state();
  const paths = await service.git.paths();
  const mappedCwd = await realpath(cwd);
  const session = await sessions.create({ repository: paths.commonDir, branch, cwd: mappedCwd, ...(pr ? { pr } : {}) });
  const record = {
    version: 2,
    repository: paths.commonDir,
    branch,
    session,
    cwd: mappedCwd,
    ...(pr ? { pr } : {}),
    updatedAt: new Date().toISOString(),
  };
  await state.putWorkspace(record);
  await state.putLast(record);
  return { state, record };
}

test("workspace parsers distinguish branch and pull request identifiers", () => {
  assert.deepEqual(parseWorkspaceTarget("123"), { type: "pr", number: 123 });
  assert.deepEqual(parseWorkspaceTarget("#123"), { type: "pr", number: 123 });
  assert.deepEqual(parseWorkspaceTarget("https://github.com/a/b/pull/123"), {
    type: "pr",
    number: 123,
    url: "https://github.com/a/b/pull/123",
  });
  for (const path of ["files", "commits", "checks", "conversation"]) {
    assert.deepEqual(parseWorkspaceTarget(`https://github.com/a/b/pull/123/${path}?plain=1`), {
      type: "pr",
      number: 123,
      url: "https://github.com/a/b/pull/123",
    });
  }
  assert.deepEqual(parseWorkspaceTarget("https://github.com/a/b/pull/123/unknown"), {
    type: "branch",
    branch: "https://github.com/a/b/pull/123/unknown",
  });
  assert.deepEqual(parseWorkspaceTarget("branch:123"), { type: "branch", branch: "123" });
  assert.deepEqual(parseWorkspaceTarget("branch:#123"), { type: "branch", branch: "#123" });
  assert.deepEqual(parseWorkspaceTarget("branch:branch:legacy"), { type: "branch", branch: "branch:legacy" });
  assert.deepEqual(parseCommandWords("new 'feature/test name' --from current"), ["new", "feature/test name", "--from", "current"]);
  assert.deepEqual(parseNewWorkspace(["feature/test", "--from", "current", "--worktree"]), {
    branch: "feature/test",
    from: "current",
    parallel: true,
  });
  assert.deepEqual(parseWorkspaceMerge(["main"]), { base: "main", mode: "ff" });
  assert.deepEqual(parseWorkspaceMerge(["--squash", "branch:merge"]), { base: "merge", mode: "squash" });
  assert.throws(() => parseWorkspaceMerge([]), /requires a base branch/);
  assert.deepEqual(parseLauncherArguments(["--worktree", "feature/test"]), {
    parallel: true,
    target: "feature/test",
    piArgs: [],
  });
  assert.deepEqual(parseLauncherArguments(["new", "feature/test", "--from", "current", "--worktree"]), {
    parallel: true,
    create: { branch: "feature/test", from: "current", parallel: true },
    piArgs: [],
  });
  assert.deepEqual(parseLauncherArguments(["--worktree", "new", "feature/test"]), {
    parallel: true,
    create: { branch: "feature/test", parallel: true },
    piArgs: [],
  });
  assert.deepEqual(parseLauncherArguments(["prune"]), {
    parallel: false,
    prune: true,
    piArgs: [],
  });
  assert.throws(() => parseLauncherArguments(["prune", "feature/test"]), /piw prune accepts no arguments/);
  assert.throws(() => parseLauncherArguments(["new"]), /piw new requires a branch name/);
  assert.throws(() => parseNewWorkspace(["feature/test", "--parallel"]), /Unknown workspace option/);
  assert.throws(() => parseLauncherArguments(["--parallel"]), /Unknown piw option/);
  assert.throws(() => parseLauncherArguments(["--here"]), /Unknown piw option/);
});

test("workspace aliases share local completion discovery and side-effect-free help", async (t) => {
  const root = await repository();
  t.after(() => removeRepository(root));
  git(root, "branch", "feature/auth");
  git(root, "tag", "v1.0");
  const sessions = new FakeSessions(root);
  const nodeRunner = new NodeProcessRunner();
  let gitCalls = 0;
  const networkCalls = [];
  const runner = {
    async run(command, args, options) {
      if (command === "gh" || ["fetch", "ls-remote"].includes(args[0])) {
        networkCalls.push({ command, args });
        throw new Error("workspace completion must not use the network");
      }
      gitCalls++;
      return nodeRunner.run(command, args, options);
    },
  };
  const createService = (cwd) => new WorkspaceService(cwd, {
    git: new GitRepository(cwd, runner),
    sessions,
  });
  const service = createService(root);
  await mapWorkspace(service, sessions, "feature/auth", root, {
    number: 42,
    url: "https://github.com/example/project/pull/42",
    baseRepository: "example/project",
    headRepository: "example/project",
    headRef: "feature/auth",
  });

  const commands = new Map();
  let serviceCreations = 0;
  workspaceExtension({
    on() {},
    registerCommand(name, command) { commands.set(name, command); },
  }, {
    completionCwd: () => root,
    createService(cwd) {
      serviceCreations++;
      return createService(cwd);
    },
  });
  const workspaceCommand = commands.get("workspace");
  const wsCommand = commands.get("ws");
  assert.ok(workspaceCommand);
  assert.ok(wsCommand);

  const notifications = [];
  const helpContext = {
    get mode() {
      throw new Error("Help must run before the TUI check");
    },
    ui: {
      notify: (...args) => notifications.push(args),
    },
  };
  await workspaceCommand.handler("--help", helpContext);
  await wsCommand.handler("-h", helpContext);
  assert.deepEqual(notifications, [
    [WORKSPACE_HELP_TEXT, "info"],
    [WORKSPACE_HELP_TEXT, "info"],
  ]);
  assert.equal(serviceCreations, 0);

  const values = async (command, prefix) => {
    const completions = await command.getArgumentCompletions(prefix);
    return completions ? completions.map((item) => item.value) : null;
  };
  assert.deepEqual(await values(workspaceCommand, ""), [
    "--help", "-h", "new", "merge", "prune", "--worktree", "feature/auth", "main", "#42",
  ]);
  const discoveryGitCalls = gitCalls;
  assert.ok(discoveryGitCalls > 0);
  assert.deepEqual(networkCalls, []);
  assert.equal(serviceCreations, 1);
  assert.deepEqual(await values(wsCommand, "4"), ["#42"]);
  assert.deepEqual(await values(wsCommand, "--worktree 4"), ["--worktree #42"]);
  assert.equal(gitCalls, discoveryGitCalls);
  assert.equal(serviceCreations, 1);

  assert.deepEqual(await workspaceCommand.getArgumentCompletions("feature/auth"), [{
    value: "feature/auth",
    label: "feature/auth",
    description: "Local branch",
  }]);
  assert.deepEqual(await values(wsCommand, "feature/auth "), ["feature/auth --worktree"]);
  assert.deepEqual(await values(wsCommand, "#42 "), ["#42 --worktree"]);
  assert.deepEqual(await values(workspaceCommand, "new "), ["new --from", "new --worktree"]);
  assert.deepEqual(await values(wsCommand, "new feature/new "), [
    "new feature/new --from",
    "new feature/new --worktree",
  ]);
  assert.deepEqual(await values(workspaceCommand, "new feature/new --from "), [
    "new feature/new --from current",
    "new feature/new --from feature/auth",
    "new feature/new --from main",
    "new feature/new --from v1.0",
  ]);
  assert.deepEqual(await values(wsCommand, "new --worktree "), ["new --worktree --from"]);
  assert.deepEqual(await values(workspaceCommand, "new feature/new --from main "), [
    "new feature/new --from main --worktree",
  ]);
  assert.equal(await values(wsCommand, "new feature/new --from main --worktree "), null);
  assert.deepEqual(await values(workspaceCommand, "merge "), [
    "merge feature/auth", "merge main", "merge --squash",
  ]);
  assert.deepEqual(await values(workspaceCommand, "merge main "), ["merge main --squash"]);
  assert.deepEqual(await values(workspaceCommand, "merge --squash "), [
    "merge --squash feature/auth", "merge --squash main",
  ]);

  const failedCommands = new Map();
  let failureDiscoveries = 0;
  workspaceExtension({
    on() {},
    registerCommand(name, command) { failedCommands.set(name, command); },
  }, {
    completionCwd: () => root,
    createService() {
      failureDiscoveries++;
      return {
        state: async () => {
          throw new Error("local discovery failed");
        },
        git: {
          localBranches: async () => [],
          localRefs: async () => [],
        },
      };
    },
  });
  const failedCommand = failedCommands.get("workspace");
  assert.equal(await values(failedCommand, ""), null);
  assert.equal(await values(failedCommand, "new "), null);
  assert.equal(failureDiscoveries, 1);
});

test("/ws merge starts an agent commit workflow and enables its guarded finalizer", async () => {
  const root = await repository();
  try {
    const sessions = new FakeSessions(root);
    const rootService = new WorkspaceService(root, { sessions });
    const created = await rootService.create({ branch: "feature/merge", parallel: true }, { parallel: true, switchSession: switcher([]) });
    const commands = new Map();
    const tools = new Map();
    const messages = [];
    let activeTools = ["read", "bash"];
    workspaceExtension({
      on() {},
      appendEntry() {},
      registerCommand(name, command) { commands.set(name, command); },
      registerTool(tool) { tools.set(tool.name, tool); },
      getActiveTools() { return activeTools; },
      setActiveTools(next) { activeTools = next; },
      sendUserMessage(message) { messages.push(message); },
    }, {
      createService: (cwd) => new WorkspaceService(cwd, { sessions }),
    });
    const notifications = [];
    const context = {
      mode: "tui",
      cwd: created.record.cwd,
      sessionManager: { getSessionFile: () => created.record.session },
      ui: { notify: (...args) => notifications.push(args) },
    };

    await commands.get("ws").handler("merge main", context);

    assert.deepEqual(notifications, []);
    assert.equal(messages.length, 1);
    assert.match(messages[0], /Group the work into logical commits/);
    assert.match(messages[0], /fast-forward merge into main/);
    assert.ok(activeTools.includes(WORKSPACE_MERGE_FINALIZE_TOOL));
    const finalizer = tools.get(WORKSPACE_MERGE_FINALIZE_TOOL);
    assert.ok(finalizer);
    const cancelled = await finalizer.execute("call", {}, undefined, undefined, {
      sessionManager: { getSessionFile: () => created.record.session },
      ui: { confirm: async () => false },
    });
    assert.equal(cancelled.details.cancelled, true);
    assert.equal(activeTools.includes(WORKSPACE_MERGE_FINALIZE_TOOL), false);
    assert.equal(git(root, "for-each-ref", "--format=%(refname)", "refs/pi-workspace/recovery"), "");
  } finally {
    await removeRepository(root);
  }
});

test("workspace finalizer defers destructive cleanup until Pi shuts down", async () => {
  const root = await repository();
  const originalCwd = process.cwd();
  try {
    const sessions = new FakeSessions(root);
    const rootService = new WorkspaceService(root, { sessions });
    const created = await rootService.create({ branch: "feature/deferred", parallel: true }, { parallel: true, switchSession: switcher([]) });
    await writeFile(join(created.record.cwd, "feature.txt"), "feature\n");
    git(created.record.cwd, "add", "feature.txt");
    git(created.record.cwd, "commit", "-m", "feature");
    const commands = new Map();
    const tools = new Map();
    let sessionShutdown;
    let activeTools = ["read", "bash"];
    workspaceExtension({
      on(event, handler) {
        if (event === "session_shutdown") sessionShutdown = handler;
      },
      appendEntry() {},
      registerCommand(name, command) { commands.set(name, command); },
      registerTool(tool) { tools.set(tool.name, tool); },
      getActiveTools() { return activeTools; },
      setActiveTools(next) { activeTools = next; },
      sendUserMessage() {},
    }, {
      createService: (cwd) => new WorkspaceService(cwd, { sessions }),
    });
    const commandContext = {
      mode: "tui",
      cwd: created.record.cwd,
      sessionManager: { getSessionFile: () => created.record.session },
      ui: { notify() {} },
    };
    await commands.get("ws").handler("merge main", commandContext);
    let shutdownRequested = false;

    await tools.get(WORKSPACE_MERGE_FINALIZE_TOOL).execute("call", {}, undefined, undefined, {
      sessionManager: { getSessionFile: () => created.record.session },
      ui: { confirm: async () => true },
      shutdown() { shutdownRequested = true; },
    });

    assert.equal(shutdownRequested, true);
    assert.equal(await realpath(created.record.cwd), created.record.cwd);
    assert.equal(gitSucceeds(root, "show-ref", "--verify", "--quiet", "refs/heads/feature/deferred"), true);
    assert.equal(await readFile(join(root, "feature.txt"), "utf8"), "feature\n");
    const pendingCleanup = await (await rootService.state()).getMergeCleanup("feature/deferred");
    assert.equal(pendingCleanup?.phase, "merged");
    assert.equal(pendingCleanup?.base, "main");

    await sessionShutdown({}, { ui: { notify() {} } });

    process.chdir(originalCwd);
    await assert.rejects(realpath(created.record.cwd));
    assert.equal(gitSucceeds(root, "show-ref", "--verify", "--quiet", "refs/heads/feature/deferred"), false);
    assert.equal(await (await rootService.state()).getMergeCleanup("feature/deferred"), undefined);
    assert.ok((await readFile(created.record.session, "utf8")).length > 0);
  } finally {
    process.chdir(originalCwd);
    await removeRepository(root);
  }
});

test("a prepared merge cleanup resumes the base update before deletion", async () => {
  const root = await repository();
  try {
    const sessions = new FakeSessions(root);
    const rootService = new WorkspaceService(root, { sessions });
    const created = await rootService.create({ branch: "feature/resume", parallel: true }, { parallel: true, switchSession: switcher([]) });
    await writeFile(join(created.record.cwd, "feature.txt"), "feature\n");
    git(created.record.cwd, "add", "feature.txt");
    git(created.record.cwd, "commit", "-m", "feature");
    const service = new WorkspaceService(created.record.cwd, { sessions });
    const plan = await service.prepareMerge({ base: "main", mode: "ff" }, created.record.session);
    const merged = await service.mergeWorkspace(plan);
    git(root, "reset", "--hard", merged.preMergeBaseOid);
    await (await rootService.state()).putMergeCleanup({ ...merged, phase: "prepared" });

    const pending = await service.pendingMergeCleanup("main", created.record.session);
    const resumed = await service.resumeMergeCleanup(pending);

    assert.equal(resumed.phase, "merged");
    assert.equal(git(root, "rev-parse", "main"), resumed.baseOid);
    await service.cleanupMergedWorkspace(resumed);
    assert.equal(gitSucceeds(root, "show-ref", "--verify", "--quiet", "refs/heads/feature/resume"), false);
  } finally {
    await removeRepository(root);
  }
});

test("workspace completions escape ambiguous branch targets", async () => {
  const commands = new Map();
  workspaceExtension({
    on() {},
    registerCommand(name, command) { commands.set(name, command); },
  }, {
    createService() {
      return {
        state: async () => ({ listWorkspaces: async () => [] }),
        git: {
          localBranches: async () => ["#7", "42", "branch:legacy", "feature/auth", "new", "prune"],
          localRefs: async () => [],
        },
      };
    },
  });
  const command = commands.get("workspace");
  assert.ok(command);
  const values = async (prefix) => {
    const completions = await command.getArgumentCompletions(prefix);
    return completions ? completions.map((item) => item.value) : null;
  };

  const completions = await command.getArgumentCompletions("");
  assert.deepEqual(completions?.filter((item) => item.description === "Local branch"), [
    { value: "branch:#7", label: "#7", description: "Local branch" },
    { value: "branch:42", label: "42", description: "Local branch" },
    { value: "branch:branch:legacy", label: "branch:legacy", description: "Local branch" },
    { value: "feature/auth", label: "feature/auth", description: "Local branch" },
    { value: "branch:new", label: "new", description: "Local branch" },
    { value: "branch:prune", label: "prune", description: "Local branch" },
  ]);
  assert.deepEqual(await values("branch:n"), ["branch:new"]);
  assert.deepEqual(await values("branch:feat"), ["branch:feature/auth"]);
  assert.deepEqual(await values("branch:new "), ["branch:new --worktree"]);
  assert.deepEqual(await values("branch:feature/auth "), ["branch:feature/auth --worktree"]);
  assert.deepEqual(await values("--worktree branch:n"), ["--worktree branch:new"]);
  assert.deepEqual(await values("--worktree branch:feat"), ["--worktree branch:feature/auth"]);
  assert.deepEqual(await values("--worktree "), [
    "--worktree branch:#7",
    "--worktree branch:42",
    "--worktree branch:branch:legacy",
    "--worktree feature/auth",
    "--worktree branch:new",
    "--worktree branch:prune",
  ]);
});

test("workspace routing uses the primary checkout when called from another checkout", async () => {
  const root = await repository();
  try {
    git(root, "branch", "feature");
    const secondary = join(root, "secondary");
    git(root, "worktree", "add", secondary, "feature");
    const sessions = new FakeSessions(root);
    const service = new WorkspaceService(secondary, { sessions });
    const calls = [];

    const result = await service.activate({ type: "branch", branch: "main" }, { parallel: false, switchSession: switcher(calls) });

    assert.equal(result.record.cwd, await realpath(root));
    assert.equal(git(root, "branch", "--show-current"), "main");
    assert.equal(calls[0], result.record.session);
  } finally {
    await removeRepository(root);
  }
});

test("/ws new bases a branch on local main, not the current branch", async () => {
  const root = await repository();
  try {
    git(root, "checkout", "-b", "other");
    await writeFile(join(root, "other.txt"), "other\n");
    git(root, "add", "other.txt");
    git(root, "commit", "-m", "other");
    const mainHead = git(root, "rev-parse", "main");
    const sessions = new FakeSessions(root);
    const service = new WorkspaceService(root, { sessions });
    const calls = [];

    await service.create({ branch: "feature", parallel: false }, { parallel: false, switchSession: switcher(calls) });

    assert.equal(git(root, "rev-parse", "feature"), mainHead);
    assert.equal(git(root, "branch", "--show-current"), "feature");
  } finally {
    await removeRepository(root);
  }
});

test("/ws new creates a branch in a managed worktree", async () => {
  const root = await repository();
  try {
    const sessions = new FakeSessions(root);
    const service = new WorkspaceService(root, { sessions });
    const calls = [];

    await handleWorkspace("new feature --worktree", {
      mode: "tui",
      cwd: root,
      ui: { notify() {} },
      switchSession: switcher(calls),
    }, service);

    const record = await (await service.state()).getWorkspace("feature");
    assert.ok(record);
    assert.equal(git(root, "branch", "--show-current"), "main");
    assert.equal(git(root, "-C", record.cwd, "branch", "--show-current"), "feature");
    assert.equal(calls[0], record.session);
  } finally {
    await removeRepository(root);
  }
});

test("/ws new replaces the current branch session without creating a branch", async () => {
  const root = await repository();
  try {
    const sessions = new FakeSessions(root);
    const service = new WorkspaceService(root, { sessions });
    const original = await mapWorkspace(service, sessions, "main", root);
    await original.state.acquireLease(original.record);
    const calls = [];

    await handleWorkspace("new", {
      mode: "tui",
      cwd: root,
      ui: { notify() {} },
      switchSession: async (session) => {
        calls.push(session);
        return { cancelled: false };
      },
    }, service);
    const stored = await original.state.getWorkspace("main");

    assert.ok(stored);
    assert.notEqual(stored.session, original.record.session);
    assert.equal(git(root, "branch", "--show-current"), "main");
    assert.deepEqual(calls, [stored.session]);
    assert.equal(await sessions.validate(stored.session, {
      repository: stored.repository,
      branch: "main",
      cwd: stored.cwd,
    }), true);
  } finally {
    await removeRepository(root);
  }
});

test("/ws new binds a fresh session when the current branch has no workspace", async () => {
  const root = await repository();
  try {
    const sessions = new FakeSessions(root);
    const service = new WorkspaceService(root, { sessions });
    const state = await service.state();
    const calls = [];

    assert.equal(await state.getWorkspace("main"), undefined);
    const replacement = await service.replaceCurrentSession({ switchSession: switcher(calls) });

    assert.equal((await state.getWorkspace("main"))?.session, replacement.record.session);
    assert.equal(replacement.record.branch, "main");
    assert.deepEqual(calls, [replacement.record.session]);
  } finally {
    await removeRepository(root);
  }
});

test("managed worktrees use opaque workspace paths and initialize PM repositories", async () => {
  const root = await repository();
  try {
    const sessions = new FakeSessions(root);
    const service = new WorkspaceService(root, { sessions });
    const state = await service.state();
    const calls = [];
    const created = await service.create({ branch: "feature/a", parallel: true }, { parallel: true, switchSession: switcher(calls) });
    const workspace = join(await realpath(root), ".ws", stableHash("feature/a"));
    const expected = join(workspace, "src");

    assert.equal(created.record.cwd, expected);
    assert.equal(created.record.baseBranch, "main");
    assert.equal(created.record.baseOid, git(root, "rev-parse", "main"));
    assert.equal((await state.getWorkspace("feature/a"))?.baseBranch, "main");
    assert.equal(git(root, "-C", expected, "branch", "--show-current"), "feature/a");
    assert.equal(git(root, "-C", join(workspace, "pm"), "rev-parse", "--is-inside-work-tree"), "true");
    assert.equal(git(root, "status", "--porcelain"), "");
    assert.match(await readFile(join(root, ".git", "info", "exclude"), "utf8"), /^\/\.ws\/$/m);

    const collision = state.workspacePath("feature/collision");
    await mkdir(collision, { recursive: true });
    await assert.rejects(
      service.create({ branch: "feature/collision", parallel: true }, { parallel: true, switchSession: switcher([]) }),
      /Managed workspace path already exists/,
    );
    assert.equal(gitSucceeds(root, "rev-parse", "--verify", "feature/collision"), false);
  } finally {
    await removeRepository(root);
  }
});

test("piw prune removes an inactive workspace after its remote branch is deleted", async () => {
  const root = await repository();
  const remote = await mkdtemp(join(tmpdir(), "pi-workspace-remote-"));
  try {
    git(remote, "init", "--bare");
    git(root, "remote", "add", "origin", remote);
    git(root, "push", "-u", "origin", "main");
    const sessions = new FakeSessions(root);
    const service = new WorkspaceService(root, { sessions });
    const created = await service.create({ branch: "feature/prune", parallel: true }, { parallel: true, switchSession: switcher([]) });
    const state = await service.state();
    await state.releaseLease(created.record);
    git(root, "push", "-u", "origin", "feature/prune");

    const retained = await service.prune();
    assert.deepEqual(retained.pruned, []);
    assert.match(retained.skipped.find((entry) => entry.branch === "feature/prune")?.reason ?? "", /remote branch exists/);
    const notifications = [];
    await handleWorkspace("prune", {
      mode: "tui",
      cwd: root,
      ui: { notify: (...args) => notifications.push(args) },
    }, service);
    assert.match(notifications.at(-1)?.[0] ?? "", /Skipped: feature\/prune \(remote branch exists/);
    assert.equal(await realpath(created.record.cwd), created.record.cwd);

    git(root, "push", "origin", "--delete", "feature/prune");
    const pendingPm = join(dirname(created.record.cwd), "pm", "pending.txt");
    await writeFile(pendingPm, "pending\n");
    const dirty = await service.prune();
    assert.match(dirty.skipped.find((entry) => entry.branch === "feature/prune")?.reason ?? "", /Refusing to change a checkout/);
    assert.equal(await realpath(created.record.cwd), created.record.cwd);
    await rm(pendingPm);
    const output = execFileSync(resolve(process.cwd(), "bin/piw"), ["prune"], { cwd: root, encoding: "utf8" });

    assert.match(output, /Pruned feature\/prune\./);
    assert.equal(await state.getWorkspace("feature/prune"), undefined);
    assert.equal(gitSucceeds(root, "show-ref", "--verify", "--quiet", "refs/heads/feature/prune"), true);
    await assert.rejects(realpath(created.record.cwd));
  } finally {
    await removeRepository(root);
    await rm(remote, { recursive: true, force: true });
  }
});

test("prune removes normally merged and squash-merged local workspaces", async (t) => {
  for (const mode of ["ff", "squash"]) {
    await t.test(mode, async () => {
      const root = await repository();
      try {
        const sessions = new FakeSessions(root);
        const service = new WorkspaceService(root, { sessions });
        const created = await service.create({ branch: `feature/${mode}`, parallel: true }, { parallel: true, switchSession: switcher([]) });
        await writeFile(join(created.record.cwd, `${mode}.txt`), `${mode}\n`);
        git(created.record.cwd, "add", `${mode}.txt`);
        git(created.record.cwd, "commit", "-m", `${mode} work`);
        if (mode === "ff") {
          git(root, "merge", "--ff-only", `feature/${mode}`);
        } else {
          git(root, "merge", "--squash", `feature/${mode}`);
          git(root, "commit", "-m", `squash ${mode}`);
        }
        const state = await service.state();
        await state.releaseLease(created.record);

        const result = await service.prune();

        assert.deepEqual(result.pruned, [`feature/${mode}`]);
        assert.equal(await state.getWorkspace(`feature/${mode}`), undefined);
        assert.equal(gitSucceeds(root, "show-ref", "--verify", "--quiet", `refs/heads/feature/${mode}`), true);
        await assert.rejects(realpath(created.record.cwd));
      } finally {
        await removeRepository(root);
      }
    });
  }
});

test("prune never removes its current managed checkout", async () => {
  const root = await repository();
  try {
    const sessions = new FakeSessions(root);
    const rootService = new WorkspaceService(root, { sessions });
    const created = await rootService.create({ branch: "feature/current", parallel: true }, { parallel: true, switchSession: switcher([]) });
    await writeFile(join(created.record.cwd, "feature.txt"), "feature\n");
    git(created.record.cwd, "add", "feature.txt");
    git(created.record.cwd, "commit", "-m", "feature");
    git(root, "merge", "--ff-only", "feature/current");
    await (await rootService.state()).releaseLease(created.record);

    const result = await new WorkspaceService(created.record.cwd, { sessions }).prune();

    assert.match(result.skipped.find((entry) => entry.branch === "feature/current")?.reason ?? "", /current checkout/);
    assert.equal(await realpath(created.record.cwd), created.record.cwd);
  } finally {
    await removeRepository(root);
  }
});

test("prune keeps a workspace when its matching squash commit was reverted", async () => {
  const root = await repository();
  try {
    const sessions = new FakeSessions(root);
    const service = new WorkspaceService(root, { sessions });
    const created = await service.create({ branch: "feature/reverted", parallel: true }, { parallel: true, switchSession: switcher([]) });
    await writeFile(join(created.record.cwd, "feature.txt"), "feature\n");
    git(created.record.cwd, "add", "feature.txt");
    git(created.record.cwd, "commit", "-m", "feature");
    git(root, "merge", "--squash", "feature/reverted");
    git(root, "commit", "-m", "squash feature");
    git(root, "revert", "--no-edit", "HEAD");
    await (await service.state()).releaseLease(created.record);

    const result = await service.prune();

    assert.deepEqual(result.pruned, []);
    assert.equal(await realpath(created.record.cwd), created.record.cwd);
  } finally {
    await removeRepository(root);
  }
});

test("workspace merge finalization fast-forwards or creates a squash commit and removes the source", async (t) => {
  for (const mode of ["ff", "squash"]) {
    await t.test(mode, async () => {
      const root = await repository();
      try {
        const sessions = new FakeSessions(root);
        const rootService = new WorkspaceService(root, { sessions });
        const created = await rootService.create({ branch: `feature/${mode}`, parallel: true }, { parallel: true, switchSession: switcher([]) });
        if (mode === "squash") {
          await writeFile(join(root, "base.txt"), "base advance\n");
          git(root, "add", "base.txt");
          git(root, "commit", "-m", "advance base");
        }
        await writeFile(join(created.record.cwd, "feature.txt"), `${mode}\n`);
        git(created.record.cwd, "add", "feature.txt");
        git(created.record.cwd, "commit", "-m", "feature work");
        const sourceOid = git(created.record.cwd, "rev-parse", "HEAD");
        const service = new WorkspaceService(created.record.cwd, { sessions });
        const plan = await service.prepareMerge({ base: "main", mode }, created.record.session);

        const result = await service.finalizeMerge(plan);

        assert.equal(result.source, `feature/${mode}`);
        assert.equal(git(root, "branch", "--show-current"), "main");
        assert.equal(await readFile(join(root, "feature.txt"), "utf8"), `${mode}\n`);
        assert.equal(gitSucceeds(root, "show-ref", "--verify", "--quiet", `refs/heads/feature/${mode}`), false);
        assert.equal(gitSucceeds(root, "config", "--local", "--get-regexp", `^branch\\.feature/${mode}\\.`), false);
        assert.equal(await (await rootService.state()).getWorkspace(`feature/${mode}`), undefined);
        assert.equal(git(root, "for-each-ref", "--format=%(refname)", "refs/pi-workspace/recovery"), "");
        assert.ok((await readFile(created.record.session, "utf8")).length > 0);
        await assert.rejects(realpath(created.record.cwd));
        if (mode === "ff") assert.equal(git(root, "rev-parse", "main"), sourceOid);
        else assert.notEqual(git(root, "rev-parse", "main"), sourceOid);
      } finally {
        await removeRepository(root);
      }
    });
  }
});

test("workspace fast-forward finalization refuses a source that is not based on the current base tip", async () => {
  const root = await repository();
  try {
    const sessions = new FakeSessions(root);
    const rootService = new WorkspaceService(root, { sessions });
    const created = await rootService.create({ branch: "feature/diverged", parallel: true }, { parallel: true, switchSession: switcher([]) });
    await writeFile(join(root, "base.txt"), "base\n");
    git(root, "add", "base.txt");
    git(root, "commit", "-m", "advance base");
    await writeFile(join(created.record.cwd, "feature.txt"), "feature\n");
    git(created.record.cwd, "add", "feature.txt");
    git(created.record.cwd, "commit", "-m", "feature");
    const service = new WorkspaceService(created.record.cwd, { sessions });
    const plan = await service.prepareMerge({ base: "main", mode: "ff" }, created.record.session);

    await assert.rejects(service.finalizeMerge(plan), /must be rebased onto main/);

    assert.equal(await realpath(created.record.cwd), created.record.cwd);
    assert.equal(gitSucceeds(root, "show-ref", "--verify", "--quiet", "refs/heads/feature/diverged"), true);
    assert.equal(git(root, "for-each-ref", "--format=%(refname)", "refs/pi-workspace/recovery"), plan.recoveryRef);
    await service.cancelMerge(plan);
    assert.equal(git(root, "for-each-ref", "--format=%(refname)", "refs/pi-workspace/recovery"), "");
  } finally {
    await removeRepository(root);
  }
});

test("workspace mappings and the repository-wide last pointer use shared local config", async () => {
  const root = await repository();
  try {
    git(root, "branch", "feature");
    const sessions = new FakeSessions(root);
    const service = new WorkspaceService(root, { sessions });
    const result = await service.activate({ type: "branch", branch: "feature" }, { parallel: false, switchSession: switcher([]) });
    const state = await service.state();
    const mapped = await state.getWorkspace("feature");
    const last = await state.getLast();

    assert.equal(mapped?.session, result.record.session);
    assert.equal(mapped?.cwd, await realpath(root));
    assert.equal(last, "feature");
    assert.equal(git(root, "config", "--local", "--get", state.sessionKey("feature")), result.record.session);
    assert.equal(git(root, "config", "--local", "--get", state.lastKey), "feature");
  } finally {
    await removeRepository(root);
  }
});

test("piw new creates a branch in a managed worktree", async () => {
  const root = await repository();
  let session;
  try {
    git(root, "checkout", "-b", "other");
    await writeFile(join(root, "other.txt"), "other\n");
    git(root, "add", "other.txt");
    git(root, "commit", "-m", "other");
    const mainHead = git(root, "rev-parse", "main");

    const plan = await resolveLaunch(["new", "feature", "--worktree"], root);
    assert.equal(plan.action, "launch");
    session = plan.session;

    assert.equal(git(root, "branch", "--show-current"), "other");
    assert.equal(git(root, "rev-parse", "feature"), mainHead);
    assert.equal(git(root, "-C", plan.cwd, "branch", "--show-current"), "feature");
  } finally {
    if (session) await rm(session, { force: true });
    await removeRepository(root);
  }
});

test("the launcher uses the primary checkout branch by default", async () => {
  const root = await repository();
  try {
    git(root, "branch", "feature");
    const sessions = new FakeSessions(root);
    const service = new WorkspaceService(root, { sessions });
    const { record } = await mapWorkspace(service, sessions, "main", root);
    await service.activate({ type: "branch", branch: "feature" }, { parallel: true, switchSession: switcher([]) });
    await (await service.state()).releaseLease(record);
    const plan = await resolveLaunch([], root);

    assert.equal(plan.cwd, await realpath(root));
    assert.equal(plan.session, record.session);
    assert.equal(git(root, "branch", "--show-current"), "main");
  } finally {
    await removeRepository(root);
  }
});

test("an explicit branch launcher reuses a trusted pull request workspace locally without gh", async () => {
  const root = await repository();
  try {
    const pullRequestHead = git(root, "rev-parse", "main");
    git(root, "checkout", "-b", "pr-branch");
    await writeFile(join(root, "local.txt"), "local\n");
    git(root, "add", "local.txt");
    git(root, "commit", "-m", "local");
    const localHead = git(root, "rev-parse", "HEAD");
    git(root, "checkout", "main");
    const sessions = new FakeSessions(root);
    const service = new WorkspaceService(root, { sessions });
    const pr = {
      number: 42,
      url: "https://github.com/a/b/pull/42",
      baseRepository: "a/b",
      headRepository: "forker/project",
      headRef: "pr-branch",
      headOid: pullRequestHead,
    };
    const { record } = await mapWorkspace(service, sessions, "pr-branch", root, pr);
    const fakeBin = join(root, ".git", "fake-bin");
    await mkdir(fakeBin, { recursive: true });
    await writeFile(join(fakeBin, "gh"), "#!/bin/sh\necho gh-called >&2\nexit 91\n");
    await chmod(join(fakeBin, "gh"), 0o755);

    const plan = JSON.parse(execFileSync(process.execPath, [
      "--experimental-strip-types",
      resolve(process.cwd(), "extensions/workspace/launcher.ts"),
      "pr-branch",
    ], {
      cwd: root,
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
      encoding: "utf8",
    }));

    assert.equal(git(root, "branch", "--show-current"), "pr-branch");
    assert.equal(git(root, "rev-parse", "HEAD"), localHead);
    assert.equal(plan.session, record.session);
  } finally {
    await removeRepository(root);
  }
});

test("the launcher uses the current secondary checkout branch by default", async () => {
  const root = await repository();
  try {
    git(root, "branch", "feature");
    const secondary = join(root, "secondary");
    git(root, "worktree", "add", secondary, "feature");
    const sessions = new FakeSessions(root);
    const service = new WorkspaceService(secondary, { sessions });
    const { record } = await mapWorkspace(service, sessions, "feature", secondary);

    const plan = await resolveLaunch([], secondary);

    assert.equal(plan.cwd, await realpath(secondary));
    assert.equal(plan.session, record.session);
  } finally {
    await removeRepository(root);
  }
});

test("piw preserves its Bash lease owner when it execs Pi", async () => {
  const root = await repository();
  try {
    git(root, "branch", "feature");
    const sessions = new FakeSessions(root);
    const service = new WorkspaceService(root, { sessions });
    const created = await service.activate({ type: "branch", branch: "feature" }, { parallel: true, switchSession: switcher([]) });
    const state = await service.state();
    await state.releaseLease(created.record);
    const fakeBin = join(root, "fake-bin");
    const fakePi = join(fakeBin, "pi");
    const resultFile = join(root, "piw-result");
    await mkdir(fakeBin, { recursive: true });
    await writeFile(fakePi, "#!/bin/sh\necho \"$$\" > \"$PIW_RESULT\"\necho \"$PWD\" >> \"$PIW_RESULT\"\nprintf '%s\\n' \"$@\" >> \"$PIW_RESULT\"\n");
    await chmod(fakePi, 0o755);

    execFileSync(resolve(process.cwd(), "bin/piw"), ["feature", "--", "--model", "test"], {
      cwd: root,
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}`, PIW_RESULT: resultFile },
    });

    const lines = (await readFile(resultFile, "utf8")).trim().split("\n");
    const lease = await state.readLease(created.record.session);
    assert.equal(lease?.pid, Number(lines[0]));
    assert.equal(lines[1], created.record.cwd);
    assert.deepEqual(lines.slice(2), ["--session", created.record.session, "--model", "test"]);
  } finally {
    await removeRepository(root);
  }
});

test("an active lease blocks a second live workspace session", async () => {
  const root = await repository();
  try {
    git(root, "checkout", "-b", "feature");
    const sessions = new FakeSessions(root);
    const service = new WorkspaceService(root, { sessions });
    const { state, record } = await mapWorkspace(service, sessions, "feature", root);
    await mkdir(state.leasesRoot, { recursive: true });
    await writeFile(state.leasePath(record.session), JSON.stringify({
      version: 1,
      repository: record.repository,
      branch: "feature",
      session: "another-session",
      pid: process.pid,
      hostname: hostname(),
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));

    await assert.rejects(
      service.activate({ type: "branch", branch: "feature" }, { parallel: false, switchSession: switcher([]) }),
      /active in another Pi session/,
    );
  } finally {
    await removeRepository(root);
  }
});

test("workspace checkout refuses dirty primary state", async () => {
  const root = await repository();
  try {
    git(root, "branch", "feature");
    await writeFile(join(root, "dirty.txt"), "do not move\n");
    const service = new WorkspaceService(root, { sessions: new FakeSessions(root) });

    await assert.rejects(
      service.activate({ type: "branch", branch: "feature" }, { parallel: false, switchSession: switcher([]) }),
      /Refusing to change a checkout with staged, unstaged, or untracked files/,
    );
    assert.equal(git(root, "branch", "--show-current"), "main");
  } finally {
    await removeRepository(root);
  }
});

test("parallel promotion forks the mapped central session into the managed worktree", async () => {
  const root = await repository();
  try {
    git(root, "checkout", "-b", "feature");
    const sessions = new FakeSessions(root);
    const service = new WorkspaceService(root, { sessions });
    const { record } = await mapWorkspace(service, sessions, "feature", root);
    const calls = [];

    const result = await service.activate({ type: "branch", branch: "feature" }, { parallel: true, switchSession: switcher(calls) });

    assert.equal(git(root, "branch", "--show-current"), "main");
    assert.equal(git(root, "-C", result.record.cwd, "branch", "--show-current"), "feature");
    assert.equal(sessions.forks.length, 1);
    assert.equal(sessions.forks[0].source, record.session);
    assert.equal(calls[0], result.record.session);
  } finally {
    await removeRepository(root);
  }
});

test("pull request activation uses gh view and gh checkout without a network", async () => {
  const root = await repository();
  try {
    git(root, "branch", "pr-branch");
    const calls = [];
    const nodeRunner = new NodeProcessRunner();
    const runner = {
      async run(command, args, options) {
        if (command !== "gh") return nodeRunner.run(command, args, options);
        calls.push(args);
        if (args[0] === "repo" && args[1] === "view") {
          return { code: 0, stdout: JSON.stringify({ nameWithOwner: "a/b", url: "https://github.com/a/b" }), stderr: "" };
        }
        if (args[1] === "view") {
          return {
            code: 0,
            stdout: JSON.stringify({
              number: 42,
              headRefName: "pr-branch",
              headRefOid: git(root, "rev-parse", "pr-branch"),
              headRepository: { nameWithOwner: "forker/project" },
              url: "https://github.com/a/b/pull/42",
            }),
            stderr: "",
          };
        }
        if (args[1] === "checkout") {
          assert.equal(args[2], "https://github.com/a/b/pull/42");
          const checkoutCwd = options?.cwd ?? root;
          git(checkoutCwd, "checkout", "pr-branch");
          git(checkoutCwd, "remote", "add", "origin", "https://github.com/a/b.git");
          git(checkoutCwd, "config", "branch.pr-branch.remote", "origin");
          git(checkoutCwd, "config", "branch.pr-branch.merge", "refs/pull/42/head");
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 1, stdout: "", stderr: "unexpected gh command" };
      },
    };
    const service = new WorkspaceService(root, {
      git: new GitRepository(root, runner),
      sessions: new FakeSessions(root),
    });
    const result = await service.activate({ type: "pr", number: 42 }, { parallel: false, switchSession: switcher([]) });

    assert.equal(result.record.branch, "pr-branch");
    assert.equal(result.record.pr?.number, 42);
    assert.equal(result.record.pr?.headRepository, "forker/project");
    const state = await service.state();
    assert.equal(git(root, "config", "--get", state.prKey("pr-branch")), "https://github.com/a/b/pull/42");
    assert.deepEqual(calls[0], ["repo", "view", "--json", "nameWithOwner"]);
    assert.deepEqual(calls[1], ["pr", "view", "42", "--json", "number,url,headRefName,headRefOid,headRepository"]);
    assert.deepEqual(calls[2], ["pr", "checkout", "https://github.com/a/b/pull/42"]);
    assert.equal(git(root, "config", "--get", "branch.pr-branch.remote"), "origin");
    assert.equal(git(root, "config", "--get", "branch.pr-branch.merge"), "refs/pull/42/head");
  } finally {
    await removeRepository(root);
  }
});

test("a stale pull request mapping verifies the checked out commit before it replaces its session", async () => {
  const root = await repository();
  try {
    const pullRequestHead = git(root, "rev-parse", "main");
    git(root, "checkout", "-b", "pr-branch");
    await writeFile(join(root, "unrelated.txt"), "unrelated\n");
    git(root, "add", "unrelated.txt");
    git(root, "commit", "-m", "unrelated");
    git(root, "checkout", "main");
    const sessions = new FakeSessions(root);
    const baseService = new WorkspaceService(root, { sessions });
    const pr = {
      number: 42,
      url: "https://github.com/a/b/pull/42",
      baseRepository: "a/b",
      headRepository: "forker/project",
      headRef: "pr-branch",
      headOid: pullRequestHead,
    };
    const { record } = await mapWorkspace(baseService, sessions, "pr-branch", root, pr);
    sessions.entries.delete(record.session);
    const stale = (await baseService.list()).find((status) => status.record.branch === "pr-branch");
    assert.equal(stale?.stale, true);
    assert.deepEqual(stale && staleWorkspaceTarget(stale), { type: "pr", number: 42, url: "https://github.com/a/b/pull/42" });
    let checkoutCalls = 0;
    const nodeRunner = new NodeProcessRunner();
    const runner = {
      async run(command, args, options) {
        if (command !== "gh") return nodeRunner.run(command, args, options);
        if (args[0] === "repo") return { code: 0, stdout: JSON.stringify({ nameWithOwner: "a/b" }), stderr: "" };
        if (args[1] === "view") {
          return {
            code: 0,
            stdout: JSON.stringify({
              number: 42,
              url: "https://github.com/a/b/pull/42",
              headRefName: "pr-branch",
              headRefOid: pullRequestHead,
              headRepository: { nameWithOwner: "forker/project" },
            }),
            stderr: "",
          };
        }
        if (args[1] === "checkout") {
          checkoutCalls++;
          const checkoutCwd = options?.cwd ?? root;
          git(checkoutCwd, "checkout", "pr-branch");
          git(checkoutCwd, "reset", "--hard", pullRequestHead);
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 1, stdout: "", stderr: "unexpected gh command" };
      },
    };
    const service = new WorkspaceService(root, { git: new GitRepository(root, runner), sessions });

    const result = await service.activate({ type: "pr", number: 42 }, { parallel: false, switchSession: switcher([]) });

    assert.equal(checkoutCalls, 1);
    assert.equal(git(root, "branch", "--show-current"), "pr-branch");
    assert.equal(git(root, "rev-parse", "HEAD"), pullRequestHead);
    assert.notEqual(result.record.session, record.session);
    assert.equal(await sessions.validate(result.record.session, workspaceMetadata((await service.git.paths()).commonDir, "pr-branch", await realpath(root), pr)), true);
  } finally {
    await removeRepository(root);
  }
});

test("a trusted pull request workspace does not reset local commits", async () => {
  const root = await repository();
  try {
    const pullRequestHead = git(root, "rev-parse", "main");
    git(root, "checkout", "-b", "pr-branch");
    const sessions = new FakeSessions(root);
    const baseService = new WorkspaceService(root, { sessions });
    const pr = {
      number: 42,
      url: "https://github.com/a/b/pull/42",
      baseRepository: "a/b",
      headRepository: "forker/project",
      headRef: "pr-branch",
      headOid: pullRequestHead,
    };
    const { record } = await mapWorkspace(baseService, sessions, "pr-branch", root, pr);
    await writeFile(join(root, "local.txt"), "local\n");
    git(root, "add", "local.txt");
    git(root, "commit", "-m", "local");
    const localHead = git(root, "rev-parse", "HEAD");
    const nodeRunner = new NodeProcessRunner();
    const runner = {
      async run(command, args, options) {
        if (command !== "gh") return nodeRunner.run(command, args, options);
        if (args[0] === "repo") return { code: 0, stdout: JSON.stringify({ nameWithOwner: "a/b" }), stderr: "" };
        if (args[1] === "view") {
          return {
            code: 0,
            stdout: JSON.stringify({
              number: 42,
              url: "https://github.com/a/b/pull/42",
              headRefName: "pr-branch",
              headRefOid: pullRequestHead,
              headRepository: { nameWithOwner: "forker/project" },
            }),
            stderr: "",
          };
        }
        if (args[1] === "checkout") throw new Error("trusted pull request must not check out again");
        return { code: 1, stdout: "", stderr: "unexpected gh command" };
      },
    };
    const service = new WorkspaceService(root, { git: new GitRepository(root, runner), sessions });

    const result = await service.activate({ type: "pr", number: 42 }, {
      parallel: false,
      resolvePullRequestDivergence: async () => "keep-local",
      switchSession: switcher([]),
    });

    assert.equal(result.record.session, record.session);
    assert.equal(git(root, "rev-parse", "HEAD"), localHead);
  } finally {
    await removeRepository(root);
  }
});

test("a cancelled switch rolls back a new worktree, branch, session map, and pointer", async () => {
  const root = await repository();
  try {
    const sessions = new FakeSessions(root);
    const service = new WorkspaceService(root, { sessions });
    const state = await service.state();

    await assert.rejects(
      service.create({ branch: "feature", parallel: true }, { parallel: true, switchSession: switcher([], true) }),
      /switch was cancelled/,
    );
    assert.equal(await state.getWorkspace("feature"), undefined);
    assert.equal(await state.getLast(), undefined);
    assert.equal(gitSucceeds(root, "rev-parse", "--verify", "feature"), false);
    assert.equal((await service.git.worktrees()).length, 1);
    await assert.rejects(readFile(join(sessions.root, "sessions", "1.jsonl"), "utf8"));
  } finally {
    await removeRepository(root);
  }
});

test("primary branch round trips resume the mapped central session", async () => {
  const root = await repository();
  try {
    git(root, "branch", "a");
    git(root, "branch", "b");
    const sessions = new FakeSessions(root);
    const service = new WorkspaceService(root, { sessions });

    const first = await service.activate({ type: "branch", branch: "a" }, { parallel: false, switchSession: switcher([]) });
    await service.activate({ type: "branch", branch: "b" }, { parallel: false, switchSession: switcher([]) });
    const resumed = await service.activate({ type: "branch", branch: "a" }, { parallel: false, switchSession: switcher([]) });

    assert.equal(git(root, "branch", "--show-current"), "a");
    assert.equal(resumed.record.session, first.record.session);
    assert.equal(resumed.createdSession, false);
  } finally {
    await removeRepository(root);
  }
});

test("session mappings without custom metadata receive it before reuse", async () => {
  const root = await repository();
  try {
    git(root, "checkout", "-b", "feature");
    const sessions = new FakeSessions(root);
    const service = new WorkspaceService(root, { sessions });
    const state = await service.state();
    const paths = await service.git.paths();
    const cwd = await realpath(root);
    const metadata = { repository: paths.commonDir, branch: "feature", cwd };
    const session = await sessions.createLegacy(metadata);
    const record = { version: 2, repository: paths.commonDir, branch: "feature", session, cwd, updatedAt: new Date().toISOString() };
    await state.putWorkspace(record);

    const result = await service.activate({ type: "branch", branch: "feature" }, { parallel: false, switchSession: switcher([]) });

    assert.equal(result.record.session, session);
    assert.equal(sessions.binds.length, 1);
    assert.equal(await sessions.validate(session, metadata), true);
  } finally {
    await removeRepository(root);
  }
});

test("Pi session metadata binding is required and persisted", async () => {
  const root = await repository();
  try {
    const path = join(root, "session.jsonl");
    const metadata = workspaceMetadata(root, "main", root);
    await writeFile(path, `${JSON.stringify({ type: "session", version: 3, id: "00000000-0000-7000-8000-000000000001", timestamp: new Date().toISOString(), cwd: root })}\n`);
    const sessions = new PiSessionStore();

    assert.equal(await sessions.validate(path, metadata), false);
    assert.equal(await sessions.bind(path, metadata), true);
    assert.equal(await sessions.validate(path, metadata), true);
    assert.match(await readFile(path, "utf8"), /"customType":"pi-workspace"/);
    assert.match(await readFile(path, "utf8"), /"type":"session_info".*"name":"main"/);

    const named = join(root, "named.jsonl");
    await writeFile(named, [
      JSON.stringify({ type: "session", version: 3, id: "00000000-0000-7000-8000-000000000002", timestamp: new Date().toISOString(), cwd: root }),
      JSON.stringify({ type: "session_info", id: "named", parentId: null, timestamp: new Date().toISOString(), name: "User name" }),
      "",
    ].join("\n"));
    assert.equal(await sessions.bind(named, metadata), true);
    assert.match(await readFile(named, "utf8"), /"name":"User name"/);
    assert.doesNotMatch(await readFile(named, "utf8"), /"name":"main"/);

    const storedSessions = new PiSessionStore(join(root, "stored-sessions"));
    const created = await storedSessions.create(metadata);
    const forked = await storedSessions.fork(created, workspaceMetadata(root, "feature", root));
    assert.match(await readFile(created, "utf8"), /"name":"main"/);
    assert.match(await readFile(forked, "utf8"), /"name":"feature"/);
  } finally {
    await removeRepository(root);
  }
});

test("session start leaves plain Pi sessions unbound", async () => {
  const root = await repository();
  try {
    const nested = join(root, "foo");
    await mkdir(nested);
    let sessionStart;
    let sessionShutdown;
    const appended = [];
    const modeEvents = [];
    workspaceExtension({
      registerCommand() {},
      on(event, handler) {
        if (event === "session_start") sessionStart = handler;
        if (event === "session_shutdown") sessionShutdown = handler;
      },
      events: {
        emit(name, payload) {
          modeEvents.push({ name, payload });
        },
      },
      appendEntry(type, data) {
        appended.push({ type, data });
      },
      setSessionName() {},
    });
    const notifications = [];
    for (const cwd of [root, nested]) {
      const ctx = {
        cwd,
        sessionManager: {
          getCwd: () => cwd,
          getSessionFile: () => join(root, `${cwd === root ? "root" : "nested"}-session.jsonl`),
          getSessionName: () => undefined,
        },
        ui: {
          notify: (...args) => notifications.push(args),
        },
        shutdown() {
          throw new Error("plain Pi session must not shut down");
        },
      };
      await sessionStart({}, ctx);
      await sessionShutdown({}, ctx);
    }

    const state = await new WorkspaceService(root).state();
    assert.equal(await state.getWorkspace("main"), undefined);
    assert.deepEqual(appended, []);
    assert.deepEqual(modeEvents, []);
    assert.deepEqual(notifications, []);
  } finally {
    await removeRepository(root);
  }
});

test("an active managed workspace exposes concise PM guidance", async () => {
  const root = await repository();
  try {
    const sessions = new FakeSessions(root);
    const service = new WorkspaceService(root, { sessions });
    const created = await service.create({ branch: "feature", parallel: true }, { parallel: true, switchSession: switcher([]) });
    let sessionStart;
    let sessionShutdown;
    let resourcesDiscover;
    let beforeAgentStart;
    const appended = [];
    const modeEvents = [];
    workspaceExtension({
      registerCommand() {},
      on(event, handler) {
        if (event === "session_start") sessionStart = handler;
        if (event === "session_shutdown") sessionShutdown = handler;
        if (event === "resources_discover") resourcesDiscover = handler;
        if (event === "before_agent_start") beforeAgentStart = handler;
      },
      events: {
        emit(name, payload) {
          modeEvents.push({ name, payload });
        },
      },
      appendEntry(type, data) {
        appended.push({ type, data });
      },
      setSessionName() {},
    });
    const notifications = [];
    const ctx = {
      cwd: created.record.cwd,
      sessionManager: {
        getSessionFile: () => created.record.session,
        getSessionName: () => undefined,
      },
      ui: {
        notify: (...args) => notifications.push(args),
      },
      shutdown() {
        throw new Error("managed workspace session must not shut down");
      },
    };

    await sessionStart({}, ctx);

    assert.deepEqual(resourcesDiscover({}, ctx), { skillPaths: [WORKSPACE_PM_SKILL_PATH] });
    assert.deepEqual(beforeAgentStart({ systemPrompt: "Base prompt" }, ctx), {
      systemPrompt: "Base prompt\n\nActive workspace PM: `../pm`. Load `workspace-pm` for durable project records.",
    });
    assert.equal(appended.at(-1)?.type, "pi-workspace");
    assert.deepEqual(modeEvents, [{
      name: "observational-memory:session-mode",
      payload: { mode: "active", source: "workspace" },
    }]);
    assert.deepEqual(notifications, []);

    await sessionShutdown({}, ctx);

    assert.deepEqual(resourcesDiscover({}, ctx), { skillPaths: [] });
    assert.equal(beforeAgentStart({ systemPrompt: "Base prompt" }, ctx), undefined);
  } finally {
    await removeRepository(root);
  }
});

test("managed workspace reload preserves its lease and activates observational memory", async () => {
  const root = await repository();
  try {
    let sessionStart;
    let sessionShutdown;
    let resourcesDiscover;
    let beforeAgentStart;
    const appended = [];
    const modeEvents = [];
    workspaceExtension({
      registerCommand() {},
      on(event, handler) {
        if (event === "session_start") sessionStart = handler;
        if (event === "session_shutdown") sessionShutdown = handler;
        if (event === "resources_discover") resourcesDiscover = handler;
        if (event === "before_agent_start") beforeAgentStart = handler;
      },
      events: {
        emit(name, payload) {
          modeEvents.push({ name, payload });
        },
      },
      appendEntry(type, data) {
        appended.push({ type, data });
      },
      setSessionName(name) {
        appended.push({ type: "session_info", data: name });
      },
    });
    const session = join(root, "active.jsonl");
    const state = await new WorkspaceService(root).state();
    const paths = await new WorkspaceService(root).git.paths();
    const record = {
      version: 2,
      repository: paths.commonDir,
      branch: "main",
      session,
      cwd: paths.primaryCwd,
      updatedAt: new Date().toISOString(),
    };
    await state.putWorkspace(record);
    await state.acquireLease(record);
    const notifications = [];
    const statuses = [];
    const ctx = {
      cwd: root,
      sessionManager: { getCwd: () => root, getSessionFile: () => session, getSessionName: () => undefined },
      ui: {
        theme: { fg: (_color, text) => text },
        setStatus: (...args) => statuses.push(args),
        notify: (...args) => notifications.push(args),
      },
      shutdown() {
        throw new Error("session start must not shut down");
      },
    };

    await sessionStart({}, ctx);

    assert.equal(appended.length, 3);
    assert.deepEqual(appended[0], { type: "session_info", data: "main" });
    assert.deepEqual(appended[1], { type: "pi-workspace-session-name", data: { branch: "main" } });
    assert.equal(appended[2].type, "pi-workspace");
    assert.equal(appended[2].data.branch, "main");
    assert.equal((await state.getWorkspace("main"))?.session, session);
    assert.deepEqual(modeEvents, [{
      name: "observational-memory:session-mode",
      payload: { mode: "active", source: "workspace" },
    }]);
    assert.deepEqual(resourcesDiscover({}, ctx), { skillPaths: [] });
    assert.equal(beforeAgentStart({ systemPrompt: "Base prompt" }, ctx), undefined);
    assert.deepEqual(notifications, []);
    assert.deepEqual(statuses, []);

    await sessionShutdown({ reason: "reload" }, ctx);
    assert.equal((await state.readLease(session))?.session, session);

    let reloadedSessionStart;
    let reloadedSessionShutdown;
    workspaceExtension({
      registerCommand() {},
      on(event, handler) {
        if (event === "session_start") reloadedSessionStart = handler;
        if (event === "session_shutdown") reloadedSessionShutdown = handler;
      },
      events: {
        emit(name, payload) {
          modeEvents.push({ name, payload });
        },
      },
      appendEntry(type, data) {
        appended.push({ type, data });
      },
      setSessionName(name) {
        appended.push({ type: "session_info", data: name });
      },
    });
    await reloadedSessionStart({}, ctx);
    assert.deepEqual(modeEvents, [
      { name: "observational-memory:session-mode", payload: { mode: "active", source: "workspace" } },
      { name: "observational-memory:session-mode", payload: { mode: "active", source: "workspace" } },
    ]);
    assert.equal((await state.readLease(session))?.session, session);

    await reloadedSessionShutdown({ reason: "quit" }, ctx);
    assert.equal(await state.readLease(session), undefined);
  } finally {
    await removeRepository(root);
  }
});

test("stale claims and Git mutation locks admit one concurrent owner", async () => {
  const root = await repository();
  try {
    const sessions = new FakeSessions(root);
    const service = new WorkspaceService(root, { sessions });
    const state = await service.state();
    const paths = await service.git.paths();
    const cwd = await realpath(root);
    const record = {
      version: 2,
      repository: paths.commonDir,
      branch: "main",
      session: await sessions.create({ repository: paths.commonDir, branch: "main", cwd }),
      cwd,
      updatedAt: new Date().toISOString(),
    };
    await mkdir(state.leasesRoot, { recursive: true });
    await writeFile(state.leasePath(record.session), JSON.stringify({
      version: 1,
      repository: record.repository,
      branch: "main",
      session: "stale",
      pid: 99999999,
      hostname: hostname(),
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
    await state.acquireLease(record, process.pid);
    await assert.rejects(
      state.acquireLease({ ...record, branch: "other" }, process.pid + 1),
      /active in another Pi session/,
    );

    const staleOwner = JSON.stringify({
      version: 1,
      pid: 99999999,
      hostname: hostname(),
      token: "stale-owner",
      startedAt: new Date().toISOString(),
    });
    const staleOid = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: root, input: staleOwner, encoding: "utf8" }).trim();
    git(root, "update-ref", state.mutationLockRef, staleOid, "0".repeat(staleOid.length));
    await state.withMutationLock(async () => undefined);
    assert.equal(await service.git.refOid(state.mutationLockRef), undefined);

    let entered;
    const enteredLock = new Promise((done) => { entered = done; });
    let release;
    const releaseLock = new Promise((done) => { release = done; });
    const first = state.withMutationLock(async () => {
      entered();
      await releaseLock;
    });
    await enteredLock;
    const second = await state.withMutationLock(async () => undefined)
      .then(() => "fulfilled", () => "rejected");
    release();
    await first;
    assert.equal(second, "rejected");
    assert.equal(await service.git.refOid(state.mutationLockRef), undefined);
  } finally {
    await removeRepository(root);
  }
});

test("Git mutation locks reject a separate Node process", async () => {
  const root = await repository();
  const stateUrl = new URL("../../extensions/workspace/state.ts", import.meta.url).href;
  const gitUrl = new URL("../../extensions/workspace/git.ts", import.meta.url).href;
  const setup = `
const { WorkspaceState } = await import(${JSON.stringify(stateUrl)});
const { GitRepository } = await import(${JSON.stringify(gitUrl)});
const git = new GitRepository(process.argv[1]);
const paths = await git.paths();
const state = new WorkspaceState(git, paths.commonDir, paths.primaryCwd);
`;
  const holder = spawn(process.execPath, [
    "--experimental-strip-types",
    "--input-type=module",
    "-e",
    `${setup}
await state.withMutationLock(async () => {
  process.stdout.write("locked\\n");
  process.stdin.resume();
  await new Promise((done) => process.stdin.once("end", done));
});`,
    root,
  ], { stdio: ["pipe", "pipe", "pipe"] });
  try {
    await new Promise((done, fail) => {
      let output = "";
      holder.stdout.on("data", (chunk) => {
        output += chunk.toString();
        if (output.includes("locked\n")) done();
      });
      holder.once("error", fail);
      holder.once("close", (code) => fail(new Error(`lock holder exited with ${code}`)));
    });
    const outcome = execFileSync(process.execPath, [
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      `${setup}
try {
  await state.withMutationLock(async () => undefined);
  process.stdout.write("acquired");
} catch {
  process.stdout.write("blocked");
}`,
      root,
    ], { cwd: root, encoding: "utf8" });
    assert.equal(outcome, "blocked");
  } finally {
    holder.stdin.end();
    await new Promise((done, fail) => {
      holder.once("error", fail);
      holder.once("close", (code) => code === 0 ? done() : fail(new Error(`lock holder exited with ${code}`)));
    });
  }
  assert.equal(gitSucceeds(root, "rev-parse", "--verify", "--quiet", "refs/pi-workspace/mutation-lock"), false);
  await removeRepository(root);
});

test("piw rejects forwarded session and extension bypass options before leasing", async () => {
  const root = await repository();
  try {
    for (const option of ["--session", "--session=value", "--session-id=value", "--fork=value", "--continue", "-c", "--resume", "-r", "--no-session", "--no-extensions", "-ne", "--no-extensions=true"]) {
      assert.throws(() => validateForwardedPiArguments([option]), /piw manages/);
    }
    git(root, "branch", "feature");
    const sessions = new FakeSessions(root);
    const service = new WorkspaceService(root, { sessions });
    const { state, record } = await mapWorkspace(service, sessions, "feature", root);

    await assert.rejects(resolveLaunch(["feature", "--", "--session", "other"], root), /piw manages --session/);
    assert.equal(await state.readLease(record.session), undefined);
  } finally {
    await removeRepository(root);
  }
});

test("pull request identity rejects a same-named unrelated local branch", async () => {
  const root = await repository();
  try {
    git(root, "checkout", "-b", "pr-branch");
    await writeFile(join(root, "unrelated.txt"), "unrelated\n");
    git(root, "add", "unrelated.txt");
    git(root, "commit", "-m", "unrelated");
    git(root, "checkout", "main");
    const nodeRunner = new NodeProcessRunner();
    const runner = {
      async run(command, args, options) {
        if (command !== "gh") return nodeRunner.run(command, args, options);
        if (args[0] === "repo") return { code: 0, stdout: JSON.stringify({ nameWithOwner: "a/b" }), stderr: "" };
        if (args[1] === "view") {
          return {
            code: 0,
            stdout: JSON.stringify({
              number: 42,
              url: "https://github.com/a/b/pull/42",
              headRefName: "pr-branch",
              headRefOid: git(root, "rev-parse", "main"),
              headRepository: { nameWithOwner: "forker/project" },
            }),
            stderr: "",
          };
        }
        if (args[1] === "checkout") {
          const checkoutCwd = options?.cwd ?? root;
          git(checkoutCwd, "checkout", "pr-branch");
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 1, stdout: "", stderr: "unexpected gh command" };
      },
    };
    const service = new WorkspaceService(root, { git: new GitRepository(root, runner), sessions: new FakeSessions(root) });

    await assert.rejects(
      service.activate({ type: "pr", number: 42 }, { parallel: false, switchSession: switcher([]) }),
      /did not select the pull request head commit/,
    );
    assert.equal(git(root, "branch", "--show-current"), "main");
  } finally {
    await removeRepository(root);
  }
});

test("parallel PR promotion verifies an unbound primary branch before it moves", async () => {
  const root = await repository();
  try {
    git(root, "checkout", "-b", "pr-branch");
    await writeFile(join(root, "unrelated.txt"), "unrelated\n");
    git(root, "add", "unrelated.txt");
    git(root, "commit", "-m", "unrelated");
    const nodeRunner = new NodeProcessRunner();
    const runner = {
      async run(command, args, options) {
        if (command !== "gh") return nodeRunner.run(command, args, options);
        if (args[0] === "repo") return { code: 0, stdout: JSON.stringify({ nameWithOwner: "a/b" }), stderr: "" };
        if (args[1] === "view") {
          return {
            code: 0,
            stdout: JSON.stringify({
              number: 42,
              url: "https://github.com/a/b/pull/42",
              headRefName: "pr-branch",
              headRefOid: git(root, "rev-parse", "main"),
              headRepository: { nameWithOwner: "forker/project" },
            }),
            stderr: "",
          };
        }
        if (args[1] === "checkout") {
          const checkoutCwd = options?.cwd ?? root;
          git(checkoutCwd, "checkout", "pr-branch");
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 1, stdout: "", stderr: "unexpected gh command" };
      },
    };
    const service = new WorkspaceService(root, { git: new GitRepository(root, runner), sessions: new FakeSessions(root) });

    await assert.rejects(
      service.activate({ type: "pr", number: 42 }, { parallel: true, switchSession: switcher([]) }),
      /did not select the pull request head commit/,
    );
    assert.equal(git(root, "branch", "--show-current"), "pr-branch");
    assert.equal((await service.git.worktrees()).length, 1);
  } finally {
    await removeRepository(root);
  }
});

test("pull request activation rejects a URL outside the current base repository", async () => {
  const root = await repository();
  try {
    const nodeRunner = new NodeProcessRunner();
    const calls = [];
    const runner = {
      async run(command, args, options) {
        if (command !== "gh") return nodeRunner.run(command, args, options);
        calls.push(args);
        if (args[0] === "repo") return { code: 0, stdout: JSON.stringify({ nameWithOwner: "a/b" }), stderr: "" };
        return {
          code: 0,
          stdout: JSON.stringify({
            number: 42,
            url: "https://github.com/other/base/pull/42",
            headRefName: "feature",
            headRefOid: git(root, "rev-parse", "main"),
            headRepository: { nameWithOwner: "forker/project" },
          }),
          stderr: "",
        };
      },
    };
    const service = new WorkspaceService(root, { git: new GitRepository(root, runner), sessions: new FakeSessions(root) });

    await assert.rejects(
      service.activate({ type: "pr", number: 42 }, { parallel: false, switchSession: switcher([]) }),
      /does not belong to this repository/,
    );
    assert.deepEqual(calls.map((args) => args.slice(0, 2)), [["repo", "view"], ["pr", "view"]]);
  } finally {
    await removeRepository(root);
  }
});

test("a branch mapping for a different pull request is not reused", async () => {
  const root = await repository();
  try {
    git(root, "branch", "pr-branch");
    const sessions = new FakeSessions(root);
    const service = new WorkspaceService(root, { sessions });
    const oldPr = {
      number: 42,
      url: "https://github.com/a/b/pull/42",
      baseRepository: "a/b",
      headRepository: "different/project",
      headRef: "pr-branch",
      headOid: git(root, "rev-parse", "pr-branch"),
    };
    await mapWorkspace(service, sessions, "pr-branch", root, oldPr);
    const nodeRunner = new NodeProcessRunner();
    const runner = {
      async run(command, args, options) {
        if (command !== "gh") return nodeRunner.run(command, args, options);
        if (args[0] === "repo") return { code: 0, stdout: JSON.stringify({ nameWithOwner: "a/b" }), stderr: "" };
        return {
          code: 0,
          stdout: JSON.stringify({
            number: 42,
            url: "https://github.com/a/b/pull/42",
            headRefName: "pr-branch",
            headRefOid: git(root, "rev-parse", "pr-branch"),
            headRepository: { nameWithOwner: "forker/project" },
          }),
          stderr: "",
        };
      },
    };
    const guarded = new WorkspaceService(root, { git: new GitRepository(root, runner), sessions });

    await assert.rejects(
      guarded.activate({ type: "pr", number: 42 }, { parallel: false, switchSession: switcher([]) }),
      /already bound to a different pull request/,
    );
  } finally {
    await removeRepository(root);
  }
});

test("cancelled promotion restores the primary branch, mapping, worktree, and session", async () => {
  const root = await repository();
  try {
    git(root, "checkout", "-b", "feature");
    const sessions = new FakeSessions(root);
    const service = new WorkspaceService(root, { sessions });
    const { state, record } = await mapWorkspace(service, sessions, "feature", root);

    await assert.rejects(
      service.activate({ type: "branch", branch: "feature" }, { parallel: true, switchSession: switcher([], true) }),
      /switch was cancelled/,
    );
    assert.equal(git(root, "branch", "--show-current"), "feature");
    assert.equal((await service.git.worktrees()).length, 1);
    assert.equal((await state.getWorkspace("feature"))?.session, record.session);
    assert.equal(await state.getLast(), "feature");
    await assert.rejects(readFile(join(sessions.root, "sessions", "2.jsonl"), "utf8"));
  } finally {
    await removeRepository(root);
  }
});

test("branch-scoped config keeps slash and dot names through a Git branch rename", async () => {
  const root = await repository();
  try {
    const branch = "feature/old.name";
    const renamed = "feature/new.name";
    git(root, "branch", branch);
    const sessions = new FakeSessions(root);
    const service = new WorkspaceService(root, { sessions });
    const created = await service.activate({ type: "branch", branch }, { parallel: false, switchSession: switcher([]) });
    const state = await service.state();
    await state.releaseLease(created.record);

    git(root, "branch", "-m", branch, renamed);

    assert.equal(git(root, "config", "--get", state.sessionKey(renamed)), created.record.session);
    assert.equal(gitSucceeds(root, "config", "--get", state.sessionKey(branch)), false);
    assert.equal((await state.getWorkspace(renamed))?.session, created.record.session);
    assert.equal((await service.list()).find((status) => status.record.branch === renamed)?.stale, false);

    const resumed = await service.activate({ type: "branch", branch: renamed }, { parallel: false, switchSession: switcher([]) });
    assert.equal(resumed.record.session, created.record.session);
    assert.match(await readFile(created.record.session, "utf8"), new RegExp(`\\"branch\\":\\"${renamed}\\"`));
  } finally {
    await removeRepository(root);
  }
});

test("the local picker excludes active workspaces without calling gh", async () => {
  const root = await repository();
  try {
    git(root, "branch", "feature");
    const sessions = new FakeSessions(root);
    let ghCalls = 0;
    const nodeRunner = new NodeProcessRunner();
    const service = new WorkspaceService(root, {
      git: new GitRepository(root, {
        async run(command, args, options) {
          if (command === "gh") {
            ghCalls++;
            throw new Error("picker called gh");
          }
          return nodeRunner.run(command, args, options);
        },
      }),
      sessions,
    });
    const { state, record } = await mapWorkspace(service, sessions, "feature", root);
    await state.acquireLease(record);
    const notifications = [];
    let choices = [];
    await picker(service, {
      mode: "tui",
      cwd: root,
      ui: {
        select: async (_title, values) => {
          choices = values;
          return undefined;
        },
        notify: (...args) => notifications.push(args),
      },
    });

    assert.equal(ghCalls, 0);
    assert.equal(choices.some((value) => value.startsWith("feature")), false);
    assert.match(notifications[0][0], /feature \(PID .*?, /);
  } finally {
    await removeRepository(root);
  }
});

test("the local picker selects a cached workspace without calling gh", async () => {
  const root = await repository();
  try {
    git(root, "branch", "feature");
    const sessions = new FakeSessions(root);
    let ghCalls = 0;
    const nodeRunner = new NodeProcessRunner();
    const service = new WorkspaceService(root, {
      git: new GitRepository(root, {
        async run(command, args, options) {
          if (command === "gh") {
            ghCalls++;
            throw new Error("picker called gh");
          }
          return nodeRunner.run(command, args, options);
        },
      }),
      sessions,
    });
    const { record } = await mapWorkspace(service, sessions, "feature", root);
    const switched = [];
    await picker(service, {
      mode: "tui",
      cwd: root,
      ui: {
        select: async (_title, values) => values.find((value) => value.startsWith("feature")),
        notify() {},
      },
      switchSession: async (session) => {
        switched.push(session);
        return { cancelled: false };
      },
    });

    assert.equal(ghCalls, 0);
    assert.deepEqual(switched, [record.session]);
  } finally {
    await removeRepository(root);
  }
});

test("the local picker tells users to repair stale PR workspaces explicitly", async () => {
  const root = await repository();
  try {
    git(root, "branch", "pr-branch");
    const sessions = new FakeSessions(root);
    let ghCalls = 0;
    const nodeRunner = new NodeProcessRunner();
    const service = new WorkspaceService(root, {
      git: new GitRepository(root, {
        async run(command, args, options) {
          if (command === "gh") {
            ghCalls++;
            throw new Error("picker called gh");
          }
          return nodeRunner.run(command, args, options);
        },
      }),
      sessions,
    });
    const pr = {
      number: 42,
      url: "https://github.com/a/b/pull/42",
      baseRepository: "a/b",
      headRepository: "forker/project",
      headRef: "pr-branch",
      headOid: git(root, "rev-parse", "pr-branch"),
    };
    const { record } = await mapWorkspace(service, sessions, "pr-branch", root, pr);
    await rm(record.session);
    const notifications = [];
    await picker(service, {
      mode: "tui",
      cwd: root,
      ui: {
        select: async (_title, values) => values.find((value) => value.startsWith("pr-branch")),
        notify: (...args) => notifications.push(args),
      },
    });

    assert.equal(ghCalls, 0);
    assert.match(notifications.at(-1)[0], /Run \/ws #42 to repair/);
  } finally {
    await removeRepository(root);
  }
});

test("bare piw uses the current branch without gh", async () => {
  const root = await repository();
  try {
    git(root, "checkout", "-b", "current");
    git(root, "branch", "newer");
    const sessions = new FakeSessions(root);
    const service = new WorkspaceService(root, { sessions });
    const current = await mapWorkspace(service, sessions, "current", root);
    const newer = await mapWorkspace(service, sessions, "newer", root);
    const future = new Date(Date.now() + 10_000);
    await utimes(newer.record.session, future, future);
    const fakeBin = join(root, ".git", "fake-bin");
    await mkdir(fakeBin, { recursive: true });
    await writeFile(join(fakeBin, "gh"), "#!/bin/sh\necho gh-called >&2\nexit 91\n");
    await chmod(join(fakeBin, "gh"), 0o755);

    const plan = JSON.parse(execFileSync(process.execPath, [
      "--experimental-strip-types",
      resolve(process.cwd(), "extensions/workspace/launcher.ts"),
    ], {
      cwd: root,
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
      encoding: "utf8",
    }));

    assert.equal(plan.session, current.record.session);
    assert.equal(git(root, "branch", "--show-current"), "current");
  } finally {
    await removeRepository(root);
  }
});

test("default piw reports an active current workspace with its PID and cwd", async () => {
  const root = await repository();
  try {
    git(root, "checkout", "-b", "first");
    const sessions = new FakeSessions(root);
    const service = new WorkspaceService(root, { sessions });
    const first = await mapWorkspace(service, sessions, "first", root);
    await first.state.acquireLease(first.record);

    const result = spawnSync(process.execPath, [
      "--experimental-strip-types",
      resolve(process.cwd(), "extensions/workspace/launcher.ts"),
    ], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`Workspace first is active in another Pi session|first \\(PID ${process.pid}, `));
  } finally {
    await removeRepository(root);
  }
});

test("an explicit piw branch opens a dormant serial mapping", async () => {
  const root = await repository();
  try {
    git(root, "branch", "a");
    git(root, "checkout", "-b", "b");
    const sessions = new FakeSessions(root);
    const service = new WorkspaceService(root, { sessions });
    const { record } = await mapWorkspace(service, sessions, "a", root);

    assert.equal((await service.list()).find((status) => status.record.branch === "a")?.stale, false);
    const plan = await resolveLaunch(["a"], root);
    assert.equal(plan.session, record.session);
    assert.equal(git(root, "branch", "--show-current"), "a");
  } finally {
    await removeRepository(root);
  }
});

async function divergenceFixture(localAhead) {
  const root = await repository();
  const base = git(root, "rev-parse", "main");
  git(root, "checkout", "-b", "pr-branch");
  if (localAhead) {
    await writeFile(join(root, "local.txt"), "local\n");
    git(root, "add", "local.txt");
    git(root, "commit", "-m", "local");
  }
  const localOid = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-b", "remote-head", "main");
  await writeFile(join(root, "remote.txt"), "remote\n");
  git(root, "add", "remote.txt");
  git(root, "commit", "-m", "remote");
  const remoteOid = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "pr-branch");
  const sessions = new FakeSessions(root);
  const baseService = new WorkspaceService(root, { sessions });
  const pr = {
    number: 42,
    url: "https://github.com/a/b/pull/42",
    baseRepository: "a/b",
    headRepository: "forker/project",
    headRef: "pr-branch",
    headOid: base,
  };
  await mapWorkspace(baseService, sessions, "pr-branch", root, pr);
  const calls = [];
  const nodeRunner = new NodeProcessRunner();
  const runner = {
    async run(command, args, options) {
      if (command !== "gh") return nodeRunner.run(command, args, options);
      calls.push(args);
      if (args[0] === "repo") return { code: 0, stdout: JSON.stringify({ nameWithOwner: "a/b" }), stderr: "" };
      if (args[0] === "pr" && args[1] === "view") {
        return {
          code: 0,
          stdout: JSON.stringify({
            number: 42,
            url: "https://github.com/a/b/pull/42",
            headRefName: "pr-branch",
            headRefOid: remoteOid,
            headRepository: { nameWithOwner: "forker/project" },
          }),
          stderr: "",
        };
      }
      throw new Error("PR divergence must not use gh checkout");
    },
  };
  return { root, localOid, remoteOid, calls, service: new WorkspaceService(root, { git: new GitRepository(root, runner), sessions }) };
}

test("trusted PR divergence keeps local commits, fast-forwards, resets with recovery, or cancels", async () => {
  const keep = await divergenceFixture(true);
  try {
    await keep.service.activate({ type: "pr", number: 42 }, {
      parallel: false,
      resolvePullRequestDivergence: async (divergence) => {
        assert.equal(divergence.canFastForward, false);
        return "keep-local";
      },
      switchSession: switcher([]),
    });
    assert.equal(git(keep.root, "rev-parse", "HEAD"), keep.localOid);
  } finally {
    await removeRepository(keep.root);
  }

  const fastForward = await divergenceFixture(false);
  try {
    await fastForward.service.activate({ type: "pr", number: 42 }, {
      parallel: false,
      resolvePullRequestDivergence: async (divergence) => {
        assert.equal(divergence.canFastForward, true);
        return "fast-forward";
      },
      switchSession: switcher([]),
    });
    assert.equal(git(fastForward.root, "rev-parse", "HEAD"), fastForward.remoteOid);
  } finally {
    await removeRepository(fastForward.root);
  }

  const reset = await divergenceFixture(true);
  try {
    await reset.service.activate({ type: "pr", number: 42 }, {
      parallel: false,
      resolvePullRequestDivergence: async () => "reset",
      switchSession: switcher([]),
    });
    assert.equal(git(reset.root, "rev-parse", "HEAD"), reset.remoteOid);
    const recovery = git(reset.root, "for-each-ref", "--format=%(refname)", "refs/pi-workspace/recovery").trim();
    assert.match(recovery, /^refs\/pi-workspace\/recovery\//);
    assert.equal(git(reset.root, "rev-parse", recovery), reset.localOid);
  } finally {
    await removeRepository(reset.root);
  }

  const cancel = await divergenceFixture(false);
  try {
    await assert.rejects(cancel.service.activate({ type: "pr", number: 42 }, {
      parallel: false,
      resolvePullRequestDivergence: async () => "cancel",
      switchSession: switcher([]),
    }), /activation was cancelled/);
    assert.equal(git(cancel.root, "rev-parse", "HEAD"), cancel.localOid);
  } finally {
    await removeRepository(cancel.root);
  }
});

test("PR reset requires a clean checkout and leaves no recovery ref on refusal", async () => {
  const fixture = await divergenceFixture(true);
  try {
    await writeFile(join(fixture.root, "dirty.txt"), "dirty\n");
    await assert.rejects(fixture.service.activate({ type: "pr", number: 42 }, {
      parallel: false,
      resolvePullRequestDivergence: async () => "reset",
      switchSession: switcher([]),
    }), /Refusing to change a checkout/);
    assert.equal(git(fixture.root, "rev-parse", "HEAD"), fixture.localOid);
    assert.equal(git(fixture.root, "for-each-ref", "--format=%(refname)", "refs/pi-workspace/recovery"), "");
  } finally {
    await removeRepository(fixture.root);
  }
});

test("noninteractive piw PR activation refuses a divergence without resetting", async () => {
  const fixture = await divergenceFixture(true);
  try {
    const fakeBin = join(fixture.root, ".git", "fake-bin");
    await mkdir(fakeBin, { recursive: true });
    await writeFile(join(fakeBin, "gh"), `#!/bin/sh
if [ "$1" = repo ]; then
  printf '%s\\n' '{"nameWithOwner":"a/b"}'
else
  printf '%s\\n' '{"number":42,"url":"https://github.com/a/b/pull/42","headRefName":"pr-branch","headRefOid":"${fixture.remoteOid}","headRepository":{"nameWithOwner":"forker/project"}}'
fi
`);
    await chmod(join(fakeBin, "gh"), 0o755);
    const result = spawnSync(process.execPath, [
      "--experimental-strip-types",
      resolve(process.cwd(), "extensions/workspace/launcher.ts"),
      "42",
    ], {
      cwd: fixture.root,
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Run \/ws #42 in Pi to choose an update/);
    assert.equal(git(fixture.root, "rev-parse", "HEAD"), fixture.localOid);
  } finally {
    await removeRepository(fixture.root);
  }
});

test("a live primary lease blocks foreign explicit and bare serial activation", async () => {
  const root = await repository();
  try {
    git(root, "branch", "a");
    git(root, "checkout", "-b", "b");
    const sessions = new FakeSessions(root);
    const service = new WorkspaceService(root, { sessions });
    const b = await mapWorkspace(service, sessions, "b", root);
    await mapWorkspace(service, sessions, "a", root);
    await b.state.acquireLease(b.record);
    const foreignPid = process.pid + 100_000;

    await assert.rejects(service.activate({ type: "branch", branch: "a" }, {
      parallel: false,
      leasePid: foreignPid,
      switchSession: switcher([]),
    }), /Workspace b is active in another Pi session/);
    assert.equal(git(root, "branch", "--show-current"), "b");

    for (const args of [[], ["a"]]) {
      const result = spawnSync(process.execPath, [
        "--experimental-strip-types",
        resolve(process.cwd(), "extensions/workspace/launcher.ts"),
        ...args,
      ], {
        cwd: root,
        env: { ...process.env, PIW_LEASE_PID: String(foreignPid) },
        encoding: "utf8",
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Workspace b is active in another Pi session|No inactive workspace\. Active: b/);
      assert.equal(git(root, "branch", "--show-current"), "b");
    }

    await assert.rejects(service.create({ branch: "serial-new", parallel: false }, {
      parallel: false,
      leasePid: foreignPid,
      switchSession: switcher([]),
    }), /Workspace b is active in another Pi session/);
    assert.equal(gitSucceeds(root, "rev-parse", "--verify", "serial-new"), false);
  } finally {
    await removeRepository(root);
  }
});

test("the primary lease owner can switch its serial workspace", async () => {
  const root = await repository();
  try {
    git(root, "branch", "a");
    git(root, "checkout", "-b", "b");
    const sessions = new FakeSessions(root);
    const service = new WorkspaceService(root, { sessions });
    const b = await mapWorkspace(service, sessions, "b", root);
    const a = await mapWorkspace(service, sessions, "a", root);
    await b.state.acquireLease(b.record);

    const result = await service.activate({ type: "branch", branch: "a" }, {
      parallel: false,
      leasePid: process.pid,
      switchSession: switcher([]),
    });
    assert.equal(result.record.session, a.record.session);
    assert.equal(git(root, "branch", "--show-current"), "a");
  } finally {
    await removeRepository(root);
  }
});

test("piw --worktree creates a worktree without changing a live primary checkout", async () => {
  const root = await repository();
  try {
    git(root, "branch", "a");
    git(root, "checkout", "-b", "b");
    const sessions = new FakeSessions(root);
    const service = new WorkspaceService(root, { sessions });
    const b = await mapWorkspace(service, sessions, "b", root);
    const a = await mapWorkspace(service, sessions, "a", root);
    await b.state.acquireLease(b.record);
    const foreignPid = process.pid + 100_000;

    const result = spawnSync(process.execPath, [
      "--experimental-strip-types",
      resolve(process.cwd(), "extensions/workspace/launcher.ts"),
      "--worktree",
      "a",
    ], {
      cwd: root,
      env: { ...process.env, PIW_LEASE_PID: String(foreignPid) },
      encoding: "utf8",
    });
    assert.equal(result.status, 0);
    assert.notEqual(JSON.parse(result.stdout).session, a.record.session);
    assert.equal(git(root, "branch", "--show-current"), "b");
  } finally {
    await removeRepository(root);
  }
});

test("a live lease remains active after its branch is renamed", async () => {
  const root = await repository();
  try {
    git(root, "checkout", "-b", "feature");
    const sessions = new FakeSessions(root);
    const service = new WorkspaceService(root, { sessions });
    const { state, record } = await mapWorkspace(service, sessions, "feature", root);
    await state.acquireLease(record);
    git(root, "branch", "-m", "feature", "renamed");

    const status = (await service.list()).find((candidate) => candidate.record.branch === "renamed");
    assert.equal(status?.active, true);
    await assert.rejects(service.activate({ type: "branch", branch: "renamed" }, {
      parallel: false,
      leasePid: process.pid + 100_000,
      switchSession: switcher([]),
    }), /Workspace renamed is active in another Pi session/);
  } finally {
    await removeRepository(root);
  }
});

test("parallel activation relocates a dormant serial workspace by forking its session", async () => {
  const root = await repository();
  try {
    git(root, "branch", "a");
    git(root, "checkout", "-b", "b");
    const sessions = new FakeSessions(root);
    const service = new WorkspaceService(root, { sessions });
    const a = await mapWorkspace(service, sessions, "a", root);

    const result = await service.activate({ type: "branch", branch: "a" }, {
      parallel: true,
      switchSession: switcher([]),
    });
    assert.equal(git(root, "branch", "--show-current"), "b");
    assert.notEqual(result.record.session, a.record.session);
    assert.equal(sessions.forks.length, 1);
    assert.equal(sessions.forks[0].source, a.record.session);
    assert.equal(git(root, "-C", result.record.cwd, "branch", "--show-current"), "a");
  } finally {
    await removeRepository(root);
  }
});

test("dirty files after a cancelled PR reset prevent rollback from resetting again", async () => {
  const fixture = await divergenceFixture(true);
  try {
    await assert.rejects(fixture.service.activate({ type: "pr", number: 42 }, {
      parallel: false,
      resolvePullRequestDivergence: async () => "reset",
      switchSession: async () => {
        await writeFile(join(fixture.root, "README.md"), "concurrent change\n");
        return { cancelled: true };
      },
    }), /switch was cancelled/);
    assert.equal(git(fixture.root, "rev-parse", "HEAD"), fixture.remoteOid);
    assert.match(git(fixture.root, "status", "--porcelain"), /README.md/);
    const recovery = git(fixture.root, "for-each-ref", "--format=%(refname)", "refs/pi-workspace/recovery").trim();
    assert.equal(git(fixture.root, "rev-parse", recovery), fixture.localOid);
  } finally {
    await removeRepository(fixture.root);
  }
});

test("the local picker omits an inactive serial workspace blocked by another owner", async () => {
  const root = await repository();
  try {
    git(root, "branch", "a");
    git(root, "checkout", "-b", "b");
    const sessions = new FakeSessions(root);
    const service = new WorkspaceService(root, { sessions });
    const b = await mapWorkspace(service, sessions, "b", root);
    await mapWorkspace(service, sessions, "a", root);
    await mkdir(b.state.leasesRoot, { recursive: true });
    await writeFile(b.state.leasePath(b.record.session), JSON.stringify({
      version: 1,
      repository: b.record.repository,
      branch: "b",
      session: b.record.session,
      pid: 12345,
      hostname: "other-host",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
    const notifications = [];
    let choices = [];
    await picker(service, {
      mode: "tui",
      cwd: root,
      ui: {
        select: async (_title, values) => {
          choices = values;
          return undefined;
        },
        notify: (...args) => notifications.push(args),
      },
    });

    assert.equal(choices.some((choice) => choice.startsWith("a")), false);
    assert.match(notifications[0][0], /b \(PID 12345/);
  } finally {
    await removeRepository(root);
  }
});
