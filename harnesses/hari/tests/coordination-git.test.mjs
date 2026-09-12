import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { addManager, captureInbox, createProject, initializeCoordination, readInbox, writeManagerReport } from "../src/coordination.ts";
import { checkpointCoordination, initializeCoordinationRepository, inspectCoordinationGit, preflightCoordinationRepository, requireCoordinationRepository } from "../src/coordination-git.ts";

const git = (root, ...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), "hari-local-git-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function initialize(root) {
  const needsCommit = await initializeCoordinationRepository(root);
  await initializeCoordination(root, resources);
  if (needsCommit) await checkpointCoordination(root, "initialize coordination records");
}

test("local init creates history, ignores runtime, and never configures a remote", async t => {
  const root = await directory(t);
  await initialize(root);
  assert.equal(await requireCoordinationRepository(root), await realpath(root));
  assert.deepEqual(git(root, "ls-files").split("\n"), [".gitignore", "INBOX.md", "PROJECTS.md"]);
  assert.equal(git(root, "remote", "-v"), "");
  assert.equal(git(root, "log", "-1", "--format=%an <%ae>: %s"), "Hari <hari@localhost>: hari: initialize coordination records");
  await writeFile(join(root, ".hari", "session.jsonl"), "private runtime data\n");
  assert.equal(git(root, "status", "--porcelain"), "");
  const head = git(root, "rev-parse", "HEAD");
  await initialize(root);
  assert.equal(git(root, "rev-parse", "HEAD"), head);
});

test("existing first-cut records become a local repo without losing their contents", async t => {
  const root = await directory(t);
  await initializeCoordination(root, resources);
  await captureInbox(root, "Preserve this note");
  const before = await readFile(join(root, "INBOX.md"), "utf8");
  await initialize(root);
  assert.equal(await readFile(join(root, "INBOX.md"), "utf8"), before);
  assert.equal(git(root, "show", "HEAD:INBOX.md"), before.trim());
});

test("checkpoints include known records and manager reports, not unrelated files or hooks", async t => {
  const root = await directory(t);
  await initialize(root);
  const project = await createProject(root, { name: "Local work" });
  await addManager(root, project.id, { id: "manager", assignment: "Report", acceptanceCriteria: ["Report exists"], constraints: [], checkout: "/prepared/checkout", branch: "feature/work" });
  await writeManagerReport(root, project.id, "manager", { result: "Ready", evidenceReferences: ["local evidence"] });
  await captureInbox(root, "Keep it local");
  await writeFile(join(root, "unrelated.txt"), "not a coordination record\n");
  await writeFile(join(root, "projects", project.id, "reports", "unknown.md"), "not an assigned manager report\n");
  const hook = join(root, ".git", "hooks", "pre-commit");
  await writeFile(hook, "#!/usr/bin/env bash\nprintf hook-ran > hook-marker\nexit 1\n");
  await chmod(hook, 0o755);
  const result = await checkpointCoordination(root, "capture notes and manager outcome");
  assert.equal(result.changed, true);
  assert.equal(result.commit, git(root, "rev-parse", "HEAD"));
  const tracked = git(root, "ls-files");
  assert.match(tracked, /projects\/local-work\/reports\/manager\.md/);
  assert.doesNotMatch(tracked, /unrelated|unknown|\.hari\//);
  await assert.rejects(readFile(join(root, "hook-marker")), /ENOENT/);
  assert.deepEqual(await checkpointCoordination(root, "no duplicate"), { changed: false });
  assert.equal(git(root, "rev-list", "--count", "HEAD"), "2");
  await rm(join(root, "projects", project.id, "reports", "manager.md"));
  assert.equal((await checkpointCoordination(root, "remove obsolete report")).changed, true);
  assert.doesNotMatch(git(root, "ls-files"), /reports\/manager\.md/);
});

test("pre-existing staged work is preserved and is never folded into a checkpoint", async t => {
  const root = await directory(t);
  await initialize(root);
  await writeFile(join(root, "unrelated.txt"), "staged human work\n");
  git(root, "add", "unrelated.txt");
  const staged = git(root, "diff", "--cached");
  const head = git(root, "rev-parse", "HEAD");
  await captureInbox(root, "Uncommitted note");
  await assert.rejects(checkpointCoordination(root, "do not sweep"), /staged changes/);
  assert.equal(git(root, "diff", "--cached"), staged);
  assert.equal(git(root, "rev-parse", "HEAD"), head);
  assert.equal((await readInbox(root)).items.length, 1);
});

test("init rejects source repositories, nested targets, and symlinked record/runtime paths", async t => {
  const root = await directory(t);
  const source = join(root, "source");
  await mkdir(source);
  git(source, "init", "--quiet");
  await writeFile(join(source, "package.json"), "{}\n");
  await assert.rejects(preflightCoordinationRepository(source), /unrelated files/);
  git(source, "add", "package.json");
  await assert.rejects(preflightCoordinationRepository(source), /unrelated files|non-coordination tracked files/);
  const nested = join(source, "coordination");
  await assert.rejects(preflightCoordinationRepository(nested), /inside/);
  await assert.rejects(readFile(join(source, "PROJECTS.md")), /ENOENT/);
  const coordination = join(root, "coordination");
  await mkdir(coordination);
  await symlink(source, join(coordination, ".hari"));
  await assert.rejects(preflightCoordinationRepository(coordination), /real directory/);
});

test("parent Git routing cannot redirect initialization or checkpoints", async t => {
  const root = await directory(t);
  const unrelated = join(root, "unrelated");
  const coordination = join(root, "coordination");
  await mkdir(unrelated);
  git(unrelated, "init", "--quiet");
  const previous = { ...process.env };
  try {
    process.env.GIT_DIR = join(unrelated, ".git");
    process.env.GIT_WORK_TREE = unrelated;
    process.env.GIT_INDEX_FILE = join(root, "foreign-index");
    process.env.GIT_AUTHOR_NAME = "Unrelated author";
    process.env.GIT_AUTHOR_EMAIL = "unrelated@example.invalid";
    await initialize(coordination);
    await captureInbox(coordination, "Correct repository");
    await checkpointCoordination(coordination, "scoped command");
  } finally { process.env = previous; }
  assert.equal(git(unrelated, "ls-files"), "");
  await assert.rejects(readFile(join(root, "foreign-index")), /ENOENT/);
  assert.equal(git(coordination, "rev-list", "--count", "HEAD"), "2");
  assert.equal(git(coordination, "log", "-1", "--format=%an <%ae>"), "Hari <hari@localhost>");
});

test("local diff/history views are bounded and paged; aborted checkpoints do not stage", async t => {
  const root = await directory(t);
  await initialize(root);
  await captureInbox(root, "Long note ".repeat(3000));
  const page = await inspectCoordinationGit(root, "diff");
  assert.equal(page.text.length, 16000);
  assert.equal(page.nextOffset, 16000);
  assert.ok((await inspectCoordinationGit(root, "diff", page.nextOffset)).text.length > 0);
  assert.match((await inspectCoordinationGit(root, "history")).text, /initialize coordination records/);
  await assert.rejects(checkpointCoordination(root, "cancelled", AbortSignal.abort()));
  assert.equal(git(root, "diff", "--cached"), "");
});

test("tracked runtime data is surfaced rather than silently committed or untracked", async t => {
  const root = await directory(t);
  await initialize(root);
  git(root, "add", "-f", ".hari/launcher.json");
  await assert.rejects(requireCoordinationRepository(root), /already tracked/);
  assert.match(git(root, "ls-files"), /\.hari\/launcher.json/);
});
