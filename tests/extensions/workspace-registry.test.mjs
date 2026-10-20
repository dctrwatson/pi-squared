import { chmod, readdir, symlink } from "node:fs/promises";
import {
  test, assert, execFileSync, mkdtemp, tmpdir, mkdir, readFile, realpath, writeFile, rm, join, resolve,
  WorkspaceService, repository, removeRepository, FakeSessions, mapWorkspace, git, switcher, resolveLaunch, formatWorkspaceList,
} from "./workspace-test-support.mjs";
import { readWorkspaceRepositories, rememberWorkspaceRepository } from "../../extensions/workspace/registry.ts";

async function isolatedRegistry(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-workspace-registry-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

function piw(cwd, ...args) {
  return execFileSync(resolve(process.cwd(), "bin/piw"), args, { cwd, encoding: "utf8" });
}

test("bare piw and --list outside a repository show an empty global list", async (t) => {
  const outside = await isolatedRegistry(t);
  assert.deepEqual(await readWorkspaceRepositories(), []);
  for (const args of [[], ["--list"], ["--global"], ["--list", "--global"]]) {
    assert.equal(piw(outside, ...args), "No workspaces.\n");
  }
  assert.throws(() => piw(outside, "--local"), /--local requires a Git worktree/);
});

test("global repository labels omit only the final .git directory", () => {
  for (const [repository, label] of [
    ["/projects/repo/.git", "/projects/repo"],
    ["/projects/repo.git/.git", "/projects/repo.git"],
    ["/projects/.git/repo/.git", "/projects/.git/repo"],
    ["/projects/common.git", "/projects/common.git"],
    ["/.git", "/"],
  ]) {
    const status = {
      record: {
        version: 2, repository, branch: "main", cwd: "/projects/repo",
        session: "/sessions/main.jsonl", updatedAt: new Date().toISOString(),
      },
      placement: "primary", recency: undefined, dirty: false, stale: false, active: false,
    };
    const row = formatWorkspaceList([status], true).split("\n")[1];
    assert.equal(row.split(/\s{2,}/)[0], label);
    assert.equal(status.record.repository, repository);
  }
});

test("piw selects local or global scope and global rows identify each repository", async (t) => {
  const outside = await isolatedRegistry(t);
  const roots = await Promise.all([repository(), repository()]);
  t.after(() => Promise.all(roots.map(removeRepository)));
  const mappings = [];
  for (const root of roots) {
    git(root, "checkout", "-b", "shared-branch");
    const sessions = new FakeSessions(root);
    mappings.push(await mapWorkspace(new WorkspaceService(root, { sessions }), sessions, "shared-branch", root));
  }
  assert.equal((await readWorkspaceRepositories()).length, 2);
  const nested = join(roots[0], "nested");
  await mkdir(nested);
  for (const args of [[], ["--list"], ["--local"], ["--list", "--local"]]) {
    const output = piw(nested, ...args);
    assert.match(output, /^BRANCH\s+PR/m);
    assert.ok(output.includes(roots[0]));
    assert.ok(!output.includes(roots[1]));
  }
  for (const [cwd, args] of [[outside, []], [outside, ["--list"]], [nested, ["--global"]]]) {
    const output = piw(cwd, ...args);
    assert.match(output, /^REPOSITORY\s+BRANCH\s+PR/m);
    assert.equal(output.match(/shared-branch/g)?.length, 2);
    assert.ok(output.includes(roots[0]));
    assert.ok(output.includes(roots[1]));
    const repositories = output.trimEnd().split("\n").slice(1).map((row) => row.split(/\s{2,}/)[0]);
    assert.deepEqual(repositories.sort(), (await Promise.all(roots.map((root) => realpath(root)))).sort());
  }
  for (const { state, record } of mappings) {
    assert.equal(await state.readLease(record.session), undefined);
    assert.equal(git(record.cwd, "branch", "--show-current"), "shared-branch");
  }
});

test("local listing adds old bindings and linked worktrees share one registry entry", async (t) => {
  const outside = await isolatedRegistry(t);
  const root = await repository();
  t.after(() => removeRepository(root));
  git(root, "branch", "old-branch");
  const sessions = new FakeSessions(root);
  const service = new WorkspaceService(root, { sessions });
  const mapped = await mapWorkspace(service, sessions, "old-branch", root);
  await rm(join(process.env.PI_CODING_AGENT_DIR, "workspace-repositories"), { recursive: true });
  assert.equal(piw(outside), "No workspaces.\n");
  assert.ok(piw(root).includes("old-branch"));
  assert.ok(piw(outside).includes("old-branch"));

  const managed = await service.create({ branch: "managed", parallel: true }, {
    parallel: true, switchSession: switcher([]),
  });
  await mapped.state.releaseLease(managed.record);
  assert.ok(piw(managed.record.cwd).includes("managed"));
  const alias = join(outside, "alias");
  await symlink(root, alias);
  assert.ok(piw(alias).includes("old-branch"));
  const entries = await readWorkspaceRepositories();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].commonDir, (await service.git.paths()).commonDir);
  const output = piw(outside);
  assert.match(output, /managed\s+-\s+worktree\s+inactive/);
  assert.equal(output.match(/old-branch/g)?.length, 1);
  for (const row of output.trimEnd().split("\n").slice(1)) {
    assert.equal(row.split(/\s{2,}/)[0], await realpath(root));
  }
});

test("global lists use live bindings, leases, and session state without network calls", async (t) => {
  const outside = await isolatedRegistry(t);
  const root = await repository();
  t.after(() => removeRepository(root));
  git(root, "checkout", "-b", "before-rename");
  const sessions = new FakeSessions(root);
  const service = new WorkspaceService(root, { sessions });
  const { state, record } = await mapWorkspace(service, sessions, "before-rename", root);
  await state.acquireLease(record);
  git(root, "branch", "-m", "after-rename");
  await writeFile(join(root, "dirty.txt"), "dirty\n");
  const fakeBin = join(outside, "bin");
  await mkdir(fakeBin);
  await writeFile(join(fakeBin, "gh"), "#!/usr/bin/env bash\necho gh-called >&2\nexit 91\n");
  await chmod(join(fakeBin, "gh"), 0o755);
  const output = execFileSync(resolve(process.cwd(), "bin/piw"), [], {
    cwd: outside, encoding: "utf8", env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
  });
  assert.ok(!output.includes("before-rename"));
  assert.match(output, /after-rename\s+-\s+primary\s+active \(PID \d+\), dirty/);
  await rm(record.session);
  assert.match(piw(outside), /after-rename.*stale/);
  await state.removeWorkspace("after-rename");
  assert.equal(piw(outside), "No workspaces.\n");
});

test("missing repositories and invalid index entries do not block global listing", async (t) => {
  const outside = await isolatedRegistry(t);
  const roots = await Promise.all([repository(), repository()]);
  t.after(() => Promise.all(roots.map(removeRepository)));
  for (const [index, root] of roots.entries()) {
    git(root, "checkout", "-b", `branch-${index}`);
    const sessions = new FakeSessions(root);
    await mapWorkspace(new WorkspaceService(root, { sessions }), sessions, `branch-${index}`, root);
  }
  const entries = await readWorkspaceRepositories();
  const registry = join(process.env.PI_CODING_AGENT_DIR, "workspace-repositories");
  await writeFile(join(registry, `${"0".repeat(64)}.json`), "invalid JSON");
  await writeFile(join(registry, `${"1".repeat(64)}.json`), "null");
  await writeFile(join(registry, `${"2".repeat(64)}.json`), JSON.stringify(entries[0]));
  assert.equal((await readWorkspaceRepositories()).length, 2);
  await removeRepository(roots[1]);
  const output = piw(outside);
  assert.ok(output.includes("branch-0"));
  assert.ok(!output.includes("branch-1"));
  assert.ok(!output.includes("Skipped"));
  await rm(join(roots[0], ".git"), { recursive: true });
  const failed = piw(outside);
  assert.match(failed, /No workspaces/);
  assert.ok(failed.includes(`Skipped ${await realpath(roots[0])}:`));
});

test("a local repository error does not block the other global rows", async (t) => {
  await isolatedRegistry(t);
  const roots = await Promise.all([repository(), repository()]);
  t.after(() => Promise.all(roots.map(removeRepository)));
  for (const [index, root] of roots.entries()) {
    git(root, "checkout", "-b", `branch-${index}`);
    const sessions = new FakeSessions(root);
    await mapWorkspace(new WorkspaceService(root, { sessions }), sessions, `branch-${index}`, root);
  }
  const originalList = WorkspaceService.prototype.list;
  WorkspaceService.prototype.list = async function () {
    if (this.git.cwd === roots[0]) throw new Error("Local list failed");
    return originalList.call(this);
  };
  t.after(() => { WorkspaceService.prototype.list = originalList; });
  const plan = await resolveLaunch(["--global"], roots[0]);
  assert.match(plan.output, /branch-1/);
  assert.ok(!plan.output.includes("branch-0"));
  assert.ok(plan.output.includes(`Skipped ${roots[0]}: Local list failed.`));
});

test("atomic registry writes preserve concurrent repository entries", async (t) => {
  const outside = await isolatedRegistry(t);
  const commonDirs = Array.from({ length: 8 }, (_, index) => join(outside, `repo-${index}`, ".git"));
  await Promise.all(commonDirs.flatMap((commonDir) => [
    rememberWorkspaceRepository(commonDir, resolve(commonDir, "..")),
    rememberWorkspaceRepository(commonDir, resolve(commonDir, "..")),
  ]));
  const entries = await readWorkspaceRepositories();
  assert.deepEqual(entries.map((entry) => entry.commonDir).sort(), commonDirs.sort());
  const registry = join(process.env.PI_CODING_AGENT_DIR, "workspace-repositories");
  const names = await readdir(registry);
  assert.equal(names.length, 8);
  for (const name of names) assert.equal(JSON.parse(await readFile(join(registry, name), "utf8")).version, 1);
});

test("an index write failure does not prevent a workspace binding or a local list", async (t) => {
  const outside = await isolatedRegistry(t);
  await mkdir(process.env.PI_CODING_AGENT_DIR);
  await writeFile(join(process.env.PI_CODING_AGENT_DIR, "workspace-repositories"), "not a directory\n");
  const root = await repository();
  t.after(() => removeRepository(root));
  git(root, "checkout", "-b", "feature");
  const sessions = new FakeSessions(root);
  const service = new WorkspaceService(root, { sessions });
  const { state, record } = await mapWorkspace(service, sessions, "feature", root);
  assert.equal((await state.getWorkspace("feature"))?.session, record.session);
  assert.ok(piw(root).includes("feature"));
  assert.throws(() => piw(outside), /ENOTDIR/);
});
