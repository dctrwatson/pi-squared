import {
  test, assert, execFileSync, mkdir, chmod, mkdtemp, tmpdir, readFile, writeFile, rm, join, resolve,
  WorkspaceService, FakeSessions, repository, removeRepository, mapWorkspace,
  parseCommandWords, parseNewWorkspace, parseLauncherArguments, resolveLaunch, formatWorkspaceList,
  git, gitSucceeds, switcher,
} from "./workspace-test-support.mjs";
import { parseWorkspaceDescribe } from "../../extensions/workspace/core.ts";
import { readWorkspaceSession } from "../../extensions/workspace/sessions.ts";

async function labeledFixture(t) {
  const root = await repository();
  t.after(() => removeRepository(root));
  git(root, "checkout", "-b", "feature/auth");
  const sessions = new FakeSessions(root);
  const service = new WorkspaceService(root, { sessions });
  const { state, record } = await mapWorkspace(service, sessions, "feature/auth", root);
  return { root, sessions, service, state, record };
}

const labels = { name: "Auth review", description: "Review sign-in changes" };

function assertLabels(record) {
  assert.equal(record.name, labels.name);
  assert.equal(record.description, labels.description);
}

test("workspace label parsers preserve quoted values and empty label updates", () => {
  assert.deepEqual(parseCommandWords('describe --name "" --description \'\''), ["describe", "--name", "", "--description", ""]);
  assert.deepEqual(parseCommandWords('a""b " " c\\ d'), ["ab", " ", "c d"]);
  assert.deepEqual(parseWorkspaceDescribe(parseCommandWords('feature/auth --name " Auth review " --description "Review sign-in changes"')), {
    branch: "feature/auth", ...labels,
  });
  assert.deepEqual(parseWorkspaceDescribe(["--name", ""]), { name: "" });
  assert.deepEqual(parseWorkspaceDescribe(["--description", "purpose", "branch:123"]), { branch: "123", description: "purpose" });
  assert.deepEqual(parseNewWorkspace(["feature/auth", "--name", labels.name, "--description", labels.description, "--worktree"]), {
    branch: "feature/auth", ...labels, parallel: true,
  });
  assert.deepEqual(parseLauncherArguments(["describe", "feature/auth", "--name", "new"]), {
    parallel: false, describe: { branch: "feature/auth", name: "new" }, piArgs: [],
  });
  assert.deepEqual(parseLauncherArguments(["new", "feature/auth", "--description", "new"]), {
    parallel: true, create: { branch: "feature/auth", description: "new", parallel: true }, piArgs: [],
  });
  for (const flag of ["--name", "--description"]) {
    assert.throws(() => parseWorkspaceDescribe([flag]), /requires a value/);
    assert.throws(() => parseWorkspaceDescribe([flag, "--worktree"]), /requires a value/);
    assert.throws(() => parseWorkspaceDescribe([flag, "a", flag, "b"]), /accepts one value/);
    assert.throws(() => parseNewWorkspace(["feature/auth", flag, "a", flag, "b"]), /accepts one value/);
    for (const value of ["line\nline", "tab\ttext", "escape\u001btext", "separator\u2028text"]) {
      assert.throws(() => parseWorkspaceDescribe([flag, value]), /single-line text without control characters/);
    }
  }
  assert.throws(() => parseWorkspaceDescribe([]), /requires --name or --description/);
  assert.throws(() => parseWorkspaceDescribe(["#42", "--description", "purpose"]), /requires a local branch/);
  assert.throws(() => parseWorkspaceDescribe(["a", "b", "--description", "purpose"]), /accepts one local branch/);
  for (const args of [
    ["--worktree", "describe", "--name", "label"],
    ["--profile", "custom", "describe", "--name", "label"],
    ["--expect-session", "/session", "describe", "--name", "label"],
    ["describe", "--name", "label", "--", "prompt"],
  ]) assert.throws(() => parseLauncherArguments(args), /piw describe accepts only/);
  assert.throws(() => parseLauncherArguments(["--current", "describe", "--name", "label"]), /another workspace target/);
  assert.throws(() => parseLauncherArguments(["--global", "describe", "--name", "label"]), /piw --list accepts/);
});

test("new workspaces store labels without changing session validation metadata", async (t) => {
  const root = await repository();
  t.after(() => removeRepository(root));
  const sessions = new FakeSessions(root);
  const service = new WorkspaceService(root, { sessions });
  const created = await service.create({ branch: "feature/auth", name: ` ${labels.name} `, description: labels.description, parallel: true }, {
    parallel: true, switchSession: switcher([]),
  });
  assertLabels(created.record);
  const state = await service.state();
  assertLabels(await state.getWorkspace("feature/auth"));
  assert.equal(git(root, "config", "--local", "--get", state.nameKey("feature/auth")), labels.name);
  assert.equal(git(root, "config", "--local", "--get", state.descriptionKey("feature/auth")), labels.description);
  const stored = await readWorkspaceSession(created.record.session);
  assert.equal(stored.metadata.name, undefined);
  assert.equal(stored.metadata.description, undefined);
  assert.equal(stored.metadata.branch, "feature/auth");
  await state.releaseLease(created.record);
});

test("piw describe changes labels on an active dirty workspace without starting Pi", async (t) => {
  const { root, service, state, record } = await labeledFixture(t);
  await writeFile(record.session, `${JSON.stringify({ type: "session_info", name: "User session name" })}\n`, { flag: "a" });
  await state.acquireLease(record);
  await writeFile(join(root, "dirty.txt"), "dirty\n");
  const leaseBefore = await readFile(state.leasePath(record.session), "utf8");
  const sessionBefore = await readFile(record.session, "utf8");
  const headBefore = git(root, "rev-parse", "HEAD");
  const fakeBin = join(root, ".git", "label-bin");
  await mkdir(fakeBin);
  await writeFile(join(fakeBin, "pi"), "#!/usr/bin/env bash\necho pi-called >&2\nexit 91\n");
  await chmod(join(fakeBin, "pi"), 0o755);
  const output = execFileSync(resolve(process.cwd(), "bin/piw"), [
    "describe", "--name", labels.name, "--description", labels.description,
  ], { cwd: root, encoding: "utf8", env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` } });
  assert.equal(output, "Updated workspace feature/auth.\n");
  assertLabels(await state.getWorkspace(record.branch));
  assert.equal(await readFile(state.leasePath(record.session), "utf8"), leaseBefore);
  assert.equal(await readFile(record.session, "utf8"), sessionBefore);
  assert.equal(git(root, "rev-parse", "HEAD"), headBefore);
  assert.equal(git(root, "branch", "--show-current"), record.branch);
  assert.equal(await state.getLast(), record.branch);
  assert.equal((await service.list())[0].dirty, true);
});

test("description updates preserve other labels and empty values clear them", async (t) => {
  const { service, state, record } = await labeledFixture(t);
  assertLabels(await service.describe(labels));
  const renamed = await service.describe({ name: "New name" });
  assert.equal(renamed.name, "New name");
  assert.equal(renamed.description, labels.description);
  const noName = await service.describe({ name: "   " });
  assert.equal(noName.name, undefined);
  assert.equal(noName.description, labels.description);
  assert.equal(gitSucceeds(service.git.cwd, "config", "--local", "--get", state.nameKey(record.branch)), false);
  const empty = await service.describe({ description: "" });
  assert.equal(empty.description, undefined);
  assert.equal(gitSucceeds(service.git.cwd, "config", "--local", "--get", state.descriptionKey(record.branch)), false);
});

test("labels appear in local and global lists and follow a Git branch rename", async (t) => {
  const { root, service, state, record } = await labeledFixture(t);
  const outside = await mkdtemp(join(tmpdir(), "pi-workspace-label-list-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await service.describe(labels);
  git(root, "branch", "-m", record.branch, "feature/renamed");
  assertLabels(await state.getWorkspace("feature/renamed"));
  assert.equal(await state.getWorkspaceLabels(record.branch).then((value) => Object.keys(value).length), 0);
  for (const [cwd, args] of [[root, []], [root, ["--global"]], [outside, []]]) {
    const plan = await resolveLaunch(args, cwd);
    assert.equal(plan.action, "list");
    assert.match(plan.output, /BRANCH\s+NAME\s+PR/);
    assert.match(plan.output, /PATH\s+DESCRIPTION/);
    assert.ok(plan.output.includes("feature/renamed"));
    assert.ok(plan.output.includes(labels.name));
    assert.ok(plan.output.includes(labels.description));
    assert.ok(!plan.output.includes(record.branch));
  }
  const statuses = await service.list();
  const unnamed = { ...statuses[0], record: { ...statuses[0].record, branch: "unlabeled", name: undefined, description: undefined } };
  const mixed = formatWorkspaceList([statuses[0], unnamed]);
  assert.match(mixed, /unlabeled\s+-\s+-\s+primary/);
  assert.ok(!formatWorkspaceList([unnamed]).includes("DESCRIPTION"));
});

test("labels survive activation, session replacement, promotion, repair, and registration", async (t) => {
  const { root, sessions, service, state, record } = await labeledFixture(t);
  await service.describe(labels);
  const other = await service.activate({ type: "branch", branch: "main" }, { parallel: false, switchSession: switcher([]) });
  await state.releaseLease(other.record);
  const resumed = await service.activate({ type: "branch", branch: record.branch }, { parallel: false, switchSession: switcher([]) });
  assertLabels(resumed.record);
  const replaced = await service.replaceCurrentSession({ switchSession: switcher([]) });
  assertLabels(replaced.record);
  assert.notEqual(replaced.record.session, record.session);
  const promoted = await service.activate({ type: "branch", branch: record.branch }, { parallel: true, switchSession: switcher([]) });
  assertLabels(promoted.record);
  await state.releaseLease(promoted.record);
  sessions.entries.delete(promoted.record.session);
  const repaired = await service.repair(record.branch);
  assertLabels(repaired);
  const managed = new WorkspaceService(promoted.record.cwd, { sessions });
  assertLabels(await managed.registerCurrent(repaired.session, true));
  await state.releaseLease(repaired);
  assertLabels(await state.getWorkspace(record.branch));
  assert.equal(git(root, "branch", "--show-current"), "main");
});

test("labels that start with a dash are stored as text, not Git options", async (t) => {
  const { service, state, record } = await labeledFixture(t);
  const updated = await service.describe(parseWorkspaceDescribe(["--name", "-fix", "--description", "-purpose"]));
  assert.equal(updated.name, "-fix");
  assert.equal(updated.description, "-purpose");
  const created = await service.create({ branch: "dash-label", name: "--option", parallel: true }, {
    parallel: true, switchSession: switcher([]),
  });
  assert.equal(created.record.name, "--option");
  assert.equal((await state.getWorkspace(record.branch)).name, "-fix");
  await state.releaseLease(created.record);
});

test("invalid or unknown workspace updates do not create bindings", async (t) => {
  const { root, service, sessions, state, record } = await labeledFixture(t);
  const before = sessions.sequence;
  await assert.rejects(service.describe({ branch: "unknown", ...labels }), /No workspace state exists/);
  await assert.rejects(service.describe({ name: "invalid\nname" }), /single-line/);
  await assert.rejects(service.describe({}), /requires a name or description/);
  await assert.rejects(service.create({ branch: "invalid-label", description: "invalid\u001btext", parallel: true }, {
    parallel: true, switchSession: switcher([]),
  }), /single-line/);
  await assert.rejects(resolveLaunch(["describe", "--name", "rejected"], root, { beforeActivate: async () => {} }), /explicit existing local branch/);
  assert.equal(sessions.sequence, before);
  assert.equal(gitSucceeds(root, "rev-parse", "--verify", "refs/heads/invalid-label"), false);
  assert.deepEqual(await state.getWorkspaceLabels(record.branch), {});
});

test("failed label updates restore both fields and obey the repository mutation lock", async (t) => {
  const { service, state, record } = await labeledFixture(t);
  await service.describe(labels);
  service.state = async () => state;
  const setConfig = state.setConfig.bind(state);
  let failed = false;
  state.setConfig = async (key, value) => {
    if (!failed && key === state.descriptionKey(record.branch)) {
      failed = true;
      throw new Error("Description write failed");
    }
    await setConfig(key, value);
  };
  await assert.rejects(service.describe({ name: "Changed", description: "Changed" }), /Description write failed/);
  assertLabels(await state.getWorkspace(record.branch));
  await state.withMutationLock(async () => {
    await assert.rejects(service.describe({ name: "Locked" }), /Another workspace operation is in progress/);
  });
  assertLabels(await state.getWorkspace(record.branch));
});

test("raw Git label values cannot insert control characters into list output", async (t) => {
  const { root, service, state, record } = await labeledFixture(t);
  git(root, "config", "--local", state.nameKey(record.branch), "Unsafe\u001b[31mname");
  git(root, "config", "--local", state.descriptionKey(record.branch), "First\nSecond\tline");
  const output = formatWorkspaceList(await service.list());
  assert.ok(!output.includes("\u001b"));
  assert.ok(!output.includes("First\nSecond"));
  assert.ok(!output.includes("\t"));
  assert.ok(output.includes("First Second line"));
});

test("workspace removal and failed creation remove label config", async (t) => {
  const { root, service, state, record } = await labeledFixture(t);
  await service.describe(labels);
  await state.removeWorkspace(record.branch);
  assert.deepEqual(await state.getWorkspaceLabels(record.branch), {});
  await assert.rejects(service.create({ branch: "cancelled", ...labels, parallel: true }, {
    parallel: true, switchSession: switcher([], true),
  }), /Workspace switch was cancelled/);
  assert.equal(await state.getWorkspace("cancelled"), undefined);
  assert.deepEqual(await state.getWorkspaceLabels("cancelled"), {});
  assert.equal(gitSucceeds(root, "rev-parse", "--verify", "refs/heads/cancelled"), false);
});
