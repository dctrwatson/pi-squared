import {
  test,
  assert,
  execFileSync,
  spawnSync,
  chmod,
  mkdir,
  utimes,
  writeFile,
  hostname,
  join,
  resolve,
  WorkspaceService,
  GitRepository,
  NodeProcessRunner,
  resolveLaunch,
  picker,
  git,
  gitSucceeds,
  repository,
  removeRepository,
  FakeSessions,
  switcher,
  mapWorkspace,
} from "./workspace-test-support.mjs";

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

test("piw --list reports local workspace status without starting Pi", async () => {
  const root = await repository();
  try {
    git(root, "checkout", "-b", "feature/list");
    const sessions = new FakeSessions(root);
    const service = new WorkspaceService(root, { sessions });
    const mapped = await mapWorkspace(service, sessions, "feature/list", root, {
      number: 42,
      url: "https://github.com/a/b/pull/42",
      baseRepository: "a/b",
      headRepository: "a/b",
      headRef: "feature/list",
    });
    await mapped.state.acquireLease(mapped.record);

    const plan = await resolveLaunch(["--list"], root);
    assert.equal(plan.action, "list");
    assert.match(plan.output, /^BRANCH\s+PR\s+PLACEMENT\s+STATE\s+RECENT\s+PATH/m);
    assert.match(plan.output, /feature\/list\s+#42\s+primary\s+active \(PID \d+\)\s+now/);
    assert.ok(plan.output.includes(root));

    const output = execFileSync(resolve(process.cwd(), "bin/piw"), ["--list"], { cwd: root, encoding: "utf8" });
    assert.match(output, /feature\/list\s+#42\s+primary\s+active \(PID \d+\)\s+now/);
    assert.ok(output.includes(root));
    assert.equal(git(root, "branch", "--show-current"), "feature/list");
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
