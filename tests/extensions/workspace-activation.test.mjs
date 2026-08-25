import {
  test,
  assert,
  execFileSync,
  chmod,
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
  workspaceMetadata,
  resolveLaunch,
  staleWorkspaceTarget,
  git,
  gitSucceeds,
  repository,
  removeRepository,
  FakeSessions,
  switcher,
  mapWorkspace,
} from "./workspace-test-support.mjs";

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
