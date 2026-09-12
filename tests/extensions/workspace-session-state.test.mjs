import {
  test,
  assert,
  execFileSync,
  spawn,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
  hostname,
  join,
  resolve,
  WorkspaceService,
  GitRepository,
  NodeProcessRunner,
  PiSessionStore,
  workspaceMetadata,
  resolveLaunch,
  validateForwardedPiArguments,
  workspaceExtension,
  WORKSPACE_PM_SKILL_PATH,
  picker,
  git,
  gitSucceeds,
  repository,
  removeRepository,
  FakeSessions,
  switcher,
  mapWorkspace,
} from "./workspace-test-support.mjs";

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
    let beforeAgentStart;
    const appended = [];
    const modeEvents = [];
    workspaceExtension({
      registerCommand() {},
      on(event, handler) {
        if (event === "session_start") sessionStart = handler;
        if (event === "session_shutdown") sessionShutdown = handler;
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
    assert.equal(beforeAgentStart({ systemPrompt: "Base prompt" }), undefined);
    assert.deepEqual(modeEvents, []);
    assert.deepEqual(notifications, []);
  } finally {
    await removeRepository(root);
  }
});

test("session start warns when a known workspace session does not own its lease", async () => {
  const root = await repository();
  try {
    const sessions = new FakeSessions(root);
    const service = new WorkspaceService(root, { sessions });
    const { record } = await mapWorkspace(service, sessions, "main", root);
    let sessionStart;
    let beforeAgentStart;
    const modeEvents = [];
    const notifications = [];
    workspaceExtension({
      registerCommand() {},
      on(event, handler) {
        if (event === "session_start") sessionStart = handler;
        if (event === "before_agent_start") beforeAgentStart = handler;
      },
      events: {
        emit(name, payload) {
          modeEvents.push({ name, payload });
        },
      },
      appendEntry() {},
      setSessionName() {},
    });
    const ctx = {
      cwd: root,
      sessionManager: {
        getSessionFile: () => record.session,
        getEntries: () => [{ type: "custom", customType: "pi-workspace", data: { branch: "main" } }],
      },
      ui: { notify: (...args) => notifications.push(args) },
      shutdown() {
        throw new Error("a missing workspace lease must not shut down Pi");
      },
    };

    await sessionStart({}, ctx);

    assert.deepEqual(modeEvents, []);
    assert.equal(beforeAgentStart({ systemPrompt: "Base prompt" }), undefined);
    assert.deepEqual(notifications, [[
      "Workspace activation skipped: this Pi process does not own the workspace lease. Run piw to activate workspace features.",
      "warning",
    ]]);
  } finally {
    await removeRepository(root);
  }
});

test("an active managed workspace appends stable guidance and exposes PM", async () => {
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
        getSessionId: () => "workspace-session",
        getEntries: () => appended.map((entry) => entry.type === "session_info"
          ? { type: "session_info", name: entry.data }
          : { type: "custom", customType: entry.type, data: entry.data }),
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
    assert.deepEqual(beforeAgentStart({ systemPrompt: "Pi base\n\nUser addendum" }, ctx), {
      systemPrompt: "Pi base\n\nUser addendum\n\n## Workspace coding guidance\n\n- Work only in the agreed repositories, checkouts, and scope. A prepared workspace or tool access does not expand authority.\n- Read repository guidance and inspect Git status before you edit.\n- Preserve unrelated and concurrent changes. Do not overwrite, revert, or reformat them.\n- Use targeted reads and searches. Read more context only when needed.\n- Run validation that meets repository requirements and fits the change. Report verified results, checks not run, and limits.\n\nActive workspace PM: `../pm`. Load `workspace-pm` for durable project records.",
    });
    assert.deepEqual(appended.at(-1)?.data, { sessionId: "workspace-session", source: "workspace", mode: "active" });
    assert.deepEqual(modeEvents, [{
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
      sessionManager: {
        getCwd: () => root,
        getSessionFile: () => session,
        getSessionId: () => "workspace-session",
        getEntries: () => appended.map((entry) => entry.type === "session_info"
          ? { type: "session_info", name: entry.data }
          : { type: "custom", customType: entry.type, data: entry.data }),
        getSessionName: () => undefined,
      },
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

    assert.equal(appended.length, 4);
    assert.deepEqual(appended[0], { type: "session_info", data: "main" });
    assert.deepEqual(appended[1], { type: "pi-workspace-session-name", data: { branch: "main" } });
    assert.equal(appended[2].type, "pi-workspace");
    assert.equal(appended[2].data.branch, "main");
    assert.equal((await state.getWorkspace("main"))?.session, session);
    assert.deepEqual(modeEvents, [{
      payload: { mode: "active", source: "workspace" },
    }]);
    assert.deepEqual(resourcesDiscover({}, ctx), { skillPaths: [] });
    assert.deepEqual(beforeAgentStart({ systemPrompt: "Base prompt" }, ctx), {
      systemPrompt: "Base prompt\n\n## Workspace coding guidance\n\n- Work only in the agreed repositories, checkouts, and scope. A prepared workspace or tool access does not expand authority.\n- Read repository guidance and inspect Git status before you edit.\n- Preserve unrelated and concurrent changes. Do not overwrite, revert, or reformat them.\n- Use targeted reads and searches. Read more context only when needed.\n- Run validation that meets repository requirements and fits the change. Report verified results, checks not run, and limits.",
    });
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
    assert.doesNotThrow(() => validateForwardedPiArguments([
      "--no-extensions", "-e", "/opt/hari/extension", "--no-skills",
      "--no-prompt-templates", "--no-themes", "--no-context-files",
    ], "hari"));
    for (const option of ["--session=value", "--fork=value", "--continue", "--resume", "--no-session"]) {
      assert.throws(() => validateForwardedPiArguments([option], "hari"), /piw manages/);
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

test("expected session validates the explicit local binding before activation", async () => {
  const root = await repository();
  try {
    git(root, "branch", "feature");
    const sessions = new FakeSessions(root);
    const service = new WorkspaceService(root, { sessions });
    const { state, record } = await mapWorkspace(service, sessions, "feature", root);
    const equivalentPath = resolve(record.session, "..", "1.jsonl");

    await assert.rejects(
      resolveLaunch(["--expect-session", record.session, "new", "new-manager"], root),
      /cannot be used with piw new/,
    );
    assert.equal(gitSucceeds(root, "rev-parse", "--verify", "new-manager"), false);
    await assert.rejects(
      service.activate({ type: "pr", number: 42 }, {
        parallel: false,
        expectedSession: record.session,
        switchSession: switcher([]),
      }),
      /explicit local branch target/,
    );
    assert.equal(git(root, "branch", "--show-current"), "main");

    const plan = await resolveLaunch(["--expect-session", equivalentPath, "feature"], root);
    assert.equal(plan.action, "launch");
    assert.equal(plan.session, record.session);
    await state.releaseLease(record);
    git(root, "checkout", "main");

    const unexpected = await sessions.create({ repository: record.repository, branch: "feature", cwd: record.cwd });
    await assert.rejects(
      service.activate({ type: "branch", branch: "feature" }, {
        parallel: false,
        expectedSession: unexpected,
        switchSession: switcher([]),
      }),
      /does not match the local feature workspace binding/,
    );
    assert.equal(git(root, "branch", "--show-current"), "main");
    assert.equal((await state.getWorkspace("feature"))?.session, record.session);
    assert.equal(await state.readLease(record.session), undefined);
    assert.equal(sessions.binds.length, 0);
    assert.equal(sessions.forks.length, 0);

    sessions.entries.delete(record.session);
    await assert.rejects(
      service.activate({ type: "branch", branch: "feature" }, {
        parallel: false,
        expectedSession: record.session,
        switchSession: switcher([]),
      }),
      /is not valid for the local feature workspace binding/,
    );
    assert.equal(git(root, "branch", "--show-current"), "main");
    assert.equal((await state.getWorkspace("feature"))?.session, record.session);
    assert.equal(await state.readLease(record.session), undefined);
    assert.equal(sessions.binds.length, 0);
    assert.equal(sessions.forks.length, 0);
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
