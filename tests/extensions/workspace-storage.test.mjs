import { lstat } from "node:fs/promises";

import {
  test,
  assert,
  execFileSync,
  spawnSync,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
  tmpdir,
  dirname,
  join,
  WorkspaceService,
  stableHash,
  git,
  gitSucceeds,
  repository,
  removeRepository,
  FakeSessions,
  switcher,
  mapWorkspace,
} from "./workspace-test-support.mjs";

test("managed workspaces preserve excludes and survive Git clean from the primary checkout", async () => {
  const root = await repository();
  try {
    const sessions = new FakeSessions(root);
    const service = new WorkspaceService(root, { sessions });
    const state = await service.state();
    const excludePath = join(state.commonDir, "info", "exclude");
    const excludes = `${await readFile(excludePath, "utf8")}\n/.ws/\n/custom-local-file\n`;
    await writeFile(excludePath, excludes);
    const created = await service.create({ branch: "feature/clean", parallel: true }, { parallel: true, switchSession: switcher([]) });
    const sourceFile = join(created.record.cwd, "source-only.txt");
    const pmFile = join(dirname(created.record.cwd), "pm", "pm-only.txt");
    await writeFile(sourceFile, "source\n");
    await writeFile(pmFile, "records\n");

    assert.equal(state.root, join(state.commonDir, "pi-workspaces"));
    assert.equal(state.stateRoot, join(state.root, ".state"));
    assert.equal(await readFile(excludePath, "utf8"), excludes);
    await assert.rejects(lstat(join(root, ".ws")), { code: "ENOENT" });
    assert.equal(git(root, "status", "--porcelain", "--untracked-files=all"), "");
    assert.equal(git(root, "clean", "-ffdx"), "");
    assert.equal(await readFile(sourceFile, "utf8"), "source\n");
    assert.equal(await readFile(pmFile, "utf8"), "records\n");
    assert.equal((await state.getWorkspace(created.record.branch))?.session, created.record.session);
    assert.equal((await state.readLease(created.record.session))?.session, created.record.session);
  } finally {
    await removeRepository(root);
  }
});

test("root searches skip managed workspaces by default", async (t) => {
  if (spawnSync("rg", ["--version"]).status !== 0) {
    t.skip("ripgrep is not installed");
    return;
  }
  const root = await repository();
  try {
    const service = new WorkspaceService(root, { sessions: new FakeSessions(root) });
    const created = await service.create({ branch: "feature/search", parallel: true }, { parallel: true, switchSession: switcher([]) });
    const pm = join(dirname(created.record.cwd), "pm");
    await writeFile(join(created.record.cwd, "source-only.txt"), "source\n");
    await writeFile(join(pm, "pm-only.txt"), "records\n");
    const files = (cwd) => execFileSync("rg", ["--files"], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, RIPGREP_CONFIG_PATH: "" },
    }).trim().split("\n").sort();

    assert.deepEqual(files(root), ["README.md"]);
    assert.deepEqual(files(created.record.cwd), ["README.md", "source-only.txt"]);
    assert.deepEqual(files(pm), ["pm-only.txt"]);
  } finally {
    await removeRepository(root);
  }
});

test("linked checkouts use an external Git common directory for managed storage", async () => {
  const root = await repository();
  const external = await mkdtemp(join(tmpdir(), "pi-workspace-common-"));
  try {
    const commonDir = join(await realpath(external), "common.git");
    git(root, "init", "--quiet", "--separate-git-dir", commonDir);
    const linked = join(await realpath(external), "linked");
    git(root, "worktree", "add", "-b", "linked", linked);
    const sessions = new FakeSessions(root);
    sessions.root = join(commonDir, "test-sessions");
    const service = new WorkspaceService(linked, { sessions });
    const state = await service.state();
    const created = await service.create({ branch: "feature/external", parallel: true }, { parallel: true, switchSession: switcher([]) });
    const expected = join(commonDir, "pi-workspaces", stableHash("feature/external"), "src");
    const managedService = new WorkspaceService(created.record.cwd, { sessions });
    const managedState = await managedService.state();

    assert.equal(state.commonDir, commonDir);
    assert.equal(created.record.cwd, expected);
    assert.equal(managedState.root, state.root);
    assert.equal(managedState.stateRoot, state.stateRoot);
    assert.equal((await managedState.getWorkspace("feature/external"))?.session, created.record.session);
    assert.equal(await service.git.isManagedWorktree(expected), true);
    assert.equal(await managedService.git.isManagedWorktree(expected), true);
    assert.equal(git(join(dirname(expected), "pm"), "rev-parse", "--is-inside-work-tree"), "true");
    assert.equal(git(root, "status", "--porcelain"), "");
    assert.equal(git(linked, "status", "--porcelain"), "");
  } finally {
    await removeRepository(root);
    await rm(external, { recursive: true, force: true });
  }
});

test("managed path checks exclude lease state, Git worktree metadata, and unrelated checkouts", async () => {
  const root = await repository();
  try {
    const service = new WorkspaceService(root);
    const state = await service.state();
    const hash = stableHash("feature/check");
    const primary = await realpath(root);

    assert.equal(await service.git.isManagedWorktree(join(state.root, hash, "src")), true);
    assert.equal(await service.git.isManagedWorktree(join(primary, ".ws", hash, "src")), true);
    for (const path of [
      join(state.root, ".state", "src"),
      join(state.root, ".merge-operation", "src"),
      join(state.root, "unrelated", "src"),
      join(state.root, hash, "pm"),
      join(state.root, hash, "src", "nested"),
      join(state.commonDir, "worktrees", hash, "src"),
      join(primary, "other", hash, "src"),
    ]) {
      assert.equal(await service.git.isManagedWorktree(path), false, path);
    }
  } finally {
    await removeRepository(root);
  }
});

test("legacy .ws workspaces keep their sessions and support prune and merge cleanup", async (t) => {
  for (const operation of ["prune", "merge"]) {
    await t.test(operation, async () => {
      const root = await repository();
      try {
        const sessions = new FakeSessions(root);
        const service = new WorkspaceService(root, { sessions });
        const branch = `feature/legacy-${operation}`;
        const workspace = join(await realpath(root), ".ws", stableHash(branch));
        const source = join(workspace, "src");
        const baseOid = git(root, "rev-parse", "main");
        git(root, "worktree", "add", "-b", branch, source);
        await service.git.initializeWorkspacePm(join(workspace, "pm"));
        const { state, record } = await mapWorkspace(service, sessions, branch, source);
        const excludePath = join(state.commonDir, "info", "exclude");
        const excludes = `${await readFile(excludePath, "utf8")}\n/.ws/\n`;
        await writeFile(excludePath, excludes);
        await state.putWorkspace({ ...record, baseBranch: "main", baseOid });
        const sessionContents = await readFile(record.session, "utf8");
        const created = await service.activate({ type: "branch", branch }, { parallel: true, switchSession: switcher([]) });

        assert.equal(created.record.cwd, source);
        assert.equal(created.record.session, record.session);
        assert.equal(created.createdSession, false);
        assert.equal(created.createdWorktree, undefined);
        assert.deepEqual(sessions.forks, []);
        assert.equal(await service.git.isManagedWorktree(source), true);
        await assert.rejects(lstat(state.workspacePath(branch)), { code: "ENOENT" });
        assert.equal(await readFile(excludePath, "utf8"), excludes);
        await writeFile(join(source, "legacy.txt"), "legacy\n");
        git(source, "add", "legacy.txt");
        git(source, "commit", "-m", "legacy work");

        if (operation === "prune") {
          git(root, "merge", "--ff-only", branch);
          await state.releaseLease(created.record);
          assert.deepEqual((await service.prune()).pruned, [branch]);
          assert.equal(gitSucceeds(root, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`), true);
        } else {
          const sourceService = new WorkspaceService(source, { sessions });
          const plan = await sourceService.prepareMerge({ base: "main", mode: "ff" }, record.session);
          const cleanup = await sourceService.mergeWorkspace(plan);
          await sourceService.cleanupMergedWorkspace(cleanup);
          assert.equal(gitSucceeds(root, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`), false);
        }
        assert.equal(await state.getWorkspace(branch), undefined);
        await assert.rejects(lstat(workspace), { code: "ENOENT" });
        assert.equal(await readFile(join(root, "legacy.txt"), "utf8"), "legacy\n");
        assert.equal(await readFile(record.session, "utf8"), sessionContents);
      } finally {
        await removeRepository(root);
      }
    });
  }
});
