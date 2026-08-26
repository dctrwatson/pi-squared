import {
  test,
  assert,
  execFileSync,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
  tmpdir,
  dirname,
  join,
  resolve,
  WorkspaceService,
  parseCommandWords,
  parseNewWorkspace,
  parseWorkspaceMerge,
  parseWorkspaceTarget,
  GitRepository,
  NodeProcessRunner,
  stableHash,
  parseLauncherArguments,
  formatWorkspaceList,
  workspaceExtension,
  WORKSPACE_MERGE_FINALIZE_TOOL,
  handleWorkspace,
  WORKSPACE_HELP_TEXT,
  git,
  gitSucceeds,
  repository,
  removeRepository,
  FakeSessions,
  switcher,
  mapWorkspace,
} from "./workspace-test-support.mjs";

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
  assert.deepEqual(parseLauncherArguments(["--list"]), {
    parallel: false,
    list: true,
    piArgs: [],
  });
  assert.throws(() => parseLauncherArguments(["prune", "feature/test"]), /piw prune accepts no arguments/);
  assert.throws(() => parseLauncherArguments(["--list", "feature/test"]), /piw --list accepts no arguments/);
  assert.throws(() => parseLauncherArguments(["--list", "--worktree"]), /piw --list accepts no arguments/);
  assert.throws(() => parseLauncherArguments(["new"]), /piw new requires a branch name/);
  assert.throws(() => parseNewWorkspace(["feature/test", "--parallel"]), /Unknown workspace option/);
  assert.throws(() => parseLauncherArguments(["--parallel"]), /Unknown piw option/);
  assert.throws(() => parseLauncherArguments(["--here"]), /Unknown piw option/);
});

test("workspace list formatting handles an empty list", () => {
  assert.equal(formatWorkspaceList([]), "No workspaces.\n");
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
