import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../..");
const skillDir = join(repoRoot, "skills/create-pr/scripts");
const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
  });
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result;
}

function git(cwd, ...args) {
  return execFileSync(realGit, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value)}\n`);
}

async function createFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "create-pr-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  const fakeBin = join(root, "bin");
  const ghData = join(root, "gh-data");
  await mkdir(fakeBin);
  await mkdir(ghData);
  git(root, "init", "--bare", origin);
  git(root, "init", work);
  git(work, "config", "user.name", "Test User");
  git(work, "config", "user.email", "test@example.com");
  git(work, "remote", "add", "origin", origin);
  await writeFile(join(work, "README.md"), "base\n");
  git(work, "add", "README.md");
  git(work, "commit", "-m", "initial");
  git(work, "branch", "-M", "main");
  git(work, "push", "-u", "origin", "main");

  await writeJson(join(ghData, "repo.json"), {
    nameWithOwner: "octo/example",
    url: "https://github.com/octo/example",
    defaultBranchRef: { name: "main" },
  });
  await writeJson(join(ghData, "pr-list.json"), []);
  await writeJson(join(ghData, "recent.json"), [{ number: 9, title: "fix: recent", url: "https://github.com/octo/example/pull/9" }]);
  await writeJson(join(ghData, "pr-view.json"), {});
  await writeJson(join(ghData, "issue-view.json"), {
    number: 12,
    title: "Referenced issue",
    url: "https://github.com/octo/example/issues/12",
    state: "OPEN",
    body: "Issue details",
    comments: [],
  });
  await writeFile(join(ghData, "create-output.txt"), "https://github.com/octo/example/pull/44\n");

  const ghScript = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_GH_DIR/gh.log"
if [[ "$1 $2" == "auth status" ]]; then exit 0; fi
if [[ "$1 $2" == "repo view" ]]; then cat "$FAKE_GH_DIR/repo.json"; exit 0; fi
if [[ "$1 $2" == "pr list" ]]; then
  if [[ " $* " == *" --state merged "* ]]; then cat "$FAKE_GH_DIR/recent.json"; else cat "$FAKE_GH_DIR/pr-list.json"; fi
  exit 0
fi
if [[ "$1 $2" == "pr view" ]]; then cat "$FAKE_GH_DIR/pr-view.json"; exit 0; fi
if [[ "$1 $2" == "issue view" ]]; then cat "$FAKE_GH_DIR/issue-view.json"; exit 0; fi
if [[ "$1 $2" == "pr create" ]]; then cat "$FAKE_GH_DIR/create-output.txt"; exit 0; fi
if [[ "$1 $2" == "pr edit" ]]; then exit 0; fi
echo "unexpected gh invocation: $*" >&2
exit 1
`;
  await writeFile(join(fakeBin, "gh"), ghScript);
  await chmod(join(fakeBin, "gh"), 0o755);

  const gitScript = `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "push" ]]; then printf '%s\\n' "$*" >> "$GIT_LOG"; fi
exec "$REAL_GIT" "$@"
`;
  await writeFile(join(fakeBin, "git"), gitScript);
  await chmod(join(fakeBin, "git"), 0o755);

  const env = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH}`,
    FAKE_GH_DIR: ghData,
    REAL_GIT: realGit,
    GIT_LOG: join(root, "git.log"),
    GIT_AUTHOR_NAME: "Test User",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test User",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
  await writeFile(env.GIT_LOG, "");
  await writeFile(join(ghData, "gh.log"), "");
  return { root, origin, work, fakeBin, ghData, env };
}

function commitFile(work, path, content, subject) {
  const absolute = join(work, path);
  execFileSync("mkdir", ["-p", resolve(absolute, "..")]);
  execFileSync("bash", ["-c", `printf '%s' "$1" > "$2"`, "_", content, absolute]);
  git(work, "add", path);
  git(work, "commit", "-m", subject);
  return git(work, "rev-parse", "HEAD");
}

function parseOutput(output) {
  return Object.fromEntries(output.trim().split("\n").filter((line) => line.includes("=")).map((line) => {
    const index = line.indexOf("=");
    return [line.slice(0, index), line.slice(index + 1)];
  }));
}

function prepare(fixture, ...args) {
  const result = run("bash", [join(skillDir, "prepare-pr.sh"), ...args], {
    cwd: fixture.work,
    env: fixture.env,
  });
  return { result, output: parseOutput(result.stdout) };
}

async function writePlan(root, state, groups) {
  const plan = join(root, `plan-${Math.random().toString(16).slice(2)}.json`);
  await writeJson(plan, { version: 1, expected_head: JSON.parse(await readFile(state, "utf8")).head, groups });
  return plan;
}

test("prepare uses an existing PR base, base template, references, and artifact paths", async (t) => {
  const fixture = await createFixture(t);
  git(fixture.work, "checkout", "-b", "release");
  await mkdir(join(fixture.work, ".github", "PULL_REQUEST_TEMPLATE"), { recursive: true });
  await writeFile(join(fixture.work, ".github", "PULL_REQUEST_TEMPLATE", "release.md"), "## Release template\n");
  git(fixture.work, "add", ".github");
  git(fixture.work, "commit", "-m", "add release template");
  git(fixture.work, "push", "-u", "origin", "release");
  git(fixture.work, "checkout", "-b", "feature");
  commitFile(fixture.work, "feature.txt", "feature\n", "pi: add feature");
  git(fixture.work, "push", "-u", "origin", "feature");
  const head = git(fixture.work, "rev-parse", "HEAD");
  await writeJson(join(fixture.ghData, "pr-list.json"), [{
    number: 21,
    title: "Feature",
    url: "https://github.com/octo/example/pull/21",
    state: "OPEN",
    baseRefName: "release",
    headRefName: "feature",
    headRefOid: head,
    isDraft: false,
  }]);

  const { result, output } = prepare(fixture, "--mode", "publish", "--reference", "https://github.com/octo/example/issues/12");
  const state = JSON.parse(await readFile(output.STATE, "utf8"));
  const context = await readFile(output.CONTEXT, "utf8");
  assert.equal(state.base, "release");
  assert.equal(state.existing_pr.number, 21);
  assert.equal(state.selected_template.path, ".github/PULL_REQUEST_TEMPLATE/release.md");
  assert.match(context, /\[octo\/example#12\]\(https:\/\/github\.com\/octo\/example\/issues\/12\)/);
  assert.match(context, /release\.md/);
  assert.doesNotMatch(result.stdout, /diff --git|feature\.txt.*\+/s);
  assert.equal(await readFile(output.DIFF, "utf8").then((text) => text.includes("diff --git")), true);
});

test("preparation rejects an existing PR whose GitHub head differs from origin", async (t) => {
  const fixture = await createFixture(t);
  git(fixture.work, "checkout", "-b", "feature");
  commitFile(fixture.work, "feature.txt", "feature\n", "feat: add feature");
  git(fixture.work, "push", "-u", "origin", "feature");
  await writeJson(join(fixture.ghData, "pr-list.json"), [{
    number: 21,
    title: "Feature",
    url: "https://github.com/octo/example/pull/21",
    state: "OPEN",
    baseRefName: "main",
    headRefName: "feature",
    headRefOid: "0000000000000000000000000000000000000000",
    isDraft: false,
  }]);

  const result = run("bash", [join(skillDir, "prepare-pr.sh"), "--mode", "publish"], {
    cwd: fixture.work,
    env: fixture.env,
    allowFailure: true,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Existing PR head does not match origin\/feature/);
});

test("logical plans support multiple groups and preserve clean commits", async (t) => {
  const fixture = await createFixture(t);
  git(fixture.work, "checkout", "-b", "feature");
  const first = commitFile(fixture.work, "a.txt", "a\n", "pi: checkpoint a");
  const second = commitFile(fixture.work, "b.txt", "b\n", "pi: checkpoint b");
  commitFile(fixture.work, "clean.txt", "clean\n", "docs: preserve clean commit");
  const third = commitFile(fixture.work, "c.txt", "c\n", "pi: checkpoint c");
  const { output } = prepare(fixture, "--mode", "publish");

  const messageOne = join(fixture.root, "message-one.txt");
  const messageTwo = join(fixture.root, "message-two.txt");
  await writeFile(messageOne, "feat: add a and b\n\nGroup related files.\n");
  await writeFile(messageTwo, "test: add c fixture\n");
  const incomplete = await writePlan(fixture.root, output.STATE, [{ commits: [first, second], message_file: messageOne }]);
  const rejected = run("bash", [join(skillDir, "apply-commit-plan.sh"), output.STATE, incomplete], {
    cwd: fixture.work,
    env: fixture.env,
    allowFailure: true,
  });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /does not account for pi: commit/);

  const overlap = await writePlan(fixture.root, output.STATE, [
    { commits: [first, second], message_file: messageOne },
    { commits: [second, third], message_file: messageTwo },
  ]);
  const overlapRejected = run("bash", [join(skillDir, "apply-commit-plan.sh"), output.STATE, overlap], {
    cwd: fixture.work,
    env: fixture.env,
    allowFailure: true,
  });
  assert.notEqual(overlapRejected.status, 0);
  assert.match(overlapRejected.stderr, /more than one group/);
  assert.equal(git(fixture.work, "rev-parse", "HEAD"), JSON.parse(await readFile(output.STATE, "utf8")).head);

  const plan = await writePlan(fixture.root, output.STATE, [
    { commits: [first, second], message_file: messageOne },
    { commits: [third], message_file: messageTwo },
  ]);
  const applied = run("bash", [join(skillDir, "apply-commit-plan.sh"), output.STATE, plan], {
    cwd: fixture.work,
    env: fixture.env,
  });
  const publishState = parseOutput(applied.stdout).STATE;
  assert.deepEqual(git(fixture.work, "log", "--reverse", "--format=%s", "origin/main..HEAD").split("\n"), [
    "feat: add a and b",
    "docs: preserve clean commit",
    "test: add c fixture",
  ]);
  assert.equal(git(fixture.work, "show", "HEAD:a.txt"), "a");
  assert.equal(git(fixture.work, "show", "HEAD:clean.txt"), "clean");
  assert.equal(JSON.parse(await readFile(publishState, "utf8")).history_rewritten, true);
});

test("commit planning rejects stale state and merge commits", async (t) => {
  const staleFixture = await createFixture(t);
  git(staleFixture.work, "checkout", "-b", "feature");
  const checkpoint = commitFile(staleFixture.work, "a.txt", "a\n", "pi: checkpoint");
  const { output } = prepare(staleFixture, "--mode", "publish");
  const message = join(staleFixture.root, "message.txt");
  await writeFile(message, "feat: add a\n");
  const plan = await writePlan(staleFixture.root, output.STATE, [{ commits: [checkpoint], message_file: message }]);
  commitFile(staleFixture.work, "later.txt", "later\n", "pi: later checkpoint");
  const stale = run("bash", [join(skillDir, "apply-commit-plan.sh"), output.STATE, plan], {
    cwd: staleFixture.work,
    env: staleFixture.env,
    allowFailure: true,
  });
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /HEAD changed after preparation/);

  const mergeFixture = await createFixture(t);
  git(mergeFixture.work, "checkout", "-b", "feature");
  const mergeCheckpoint = commitFile(mergeFixture.work, "base.txt", "base\n", "pi: base checkpoint");
  git(mergeFixture.work, "checkout", "-b", "side");
  commitFile(mergeFixture.work, "side.txt", "side\n", "side change");
  git(mergeFixture.work, "checkout", "feature");
  git(mergeFixture.work, "merge", "--no-ff", "side", "-m", "merge side");
  const prepared = prepare(mergeFixture, "--mode", "publish");
  const mergeMessage = join(mergeFixture.root, "message.txt");
  await writeFile(mergeMessage, "feat: preserve merge\n");
  const mergePlan = await writePlan(mergeFixture.root, prepared.output.STATE, [{ commits: [mergeCheckpoint], message_file: mergeMessage }]);
  const merged = run("bash", [join(skillDir, "apply-commit-plan.sh"), prepared.output.STATE, mergePlan], {
    cwd: mergeFixture.work,
    env: mergeFixture.env,
    allowFailure: true,
  });
  assert.notEqual(merged.status, 0);
  assert.match(merged.stderr, /Merge commits exist/);
});

test("draft state cannot publish and causes no remote mutation", async (t) => {
  const fixture = await createFixture(t);
  git(fixture.work, "checkout", "-b", "feature");
  commitFile(fixture.work, "a.txt", "a\n", "feat: add a");
  const { output } = prepare(fixture, "--mode", "draft");
  const title = join(fixture.root, "title.txt");
  const body = join(fixture.root, "body.md");
  await writeFile(title, "feat: add a\n");
  await writeFile(body, "## Summary\nAdd a.\n");
  const result = run("bash", [join(skillDir, "publish-pr.sh"), "--state", output.STATE, "--title-file", title, "--body-file", body, "--create"], {
    cwd: fixture.work,
    env: fixture.env,
    allowFailure: true,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires state prepared with --mode publish/);
  assert.equal(await readFile(fixture.env.GIT_LOG, "utf8"), "");
  assert.doesNotMatch(await readFile(join(fixture.ghData, "gh.log"), "utf8"), /pr create|pr edit/);
});

test("publication uses normal push for new branches and reports Markdown links", async (t) => {
  const fixture = await createFixture(t);
  git(fixture.work, "checkout", "-b", "feature");
  commitFile(fixture.work, "a.txt", "a\n", "feat: add a");
  const { output } = prepare(fixture, "--mode", "publish");
  const plan = await writePlan(fixture.root, output.STATE, []);
  const applied = run("bash", [join(skillDir, "apply-commit-plan.sh"), output.STATE, plan], { cwd: fixture.work, env: fixture.env });
  const state = parseOutput(applied.stdout).STATE;
  const title = join(fixture.root, "title.txt");
  const body = join(fixture.root, "body.md");
  await writeFile(title, "feat: add a\n");
  await writeFile(body, "## Summary\nAdd a.\n");
  const published = run("bash", [join(skillDir, "publish-pr.sh"), "--state", state, "--title-file", title, "--body-file", body, "--create"], {
    cwd: fixture.work,
    env: fixture.env,
  });
  assert.match(published.stdout, /PR=\[#44\]\(https:\/\/github\.com\/octo\/example\/pull\/44\)/);
  assert.doesNotMatch(await readFile(fixture.env.GIT_LOG, "utf8"), /force-with-lease/);
  const result = JSON.parse(await readFile(parseOutput(published.stdout).RESULT, "utf8"));
  assert.match(result.commits[0].markdown, /^\[`[a-f0-9]{7}`\]\(https:\/\/github\.com\/octo\/example\/commit\//);
  assert.equal(git(fixture.origin, "rev-parse", "refs/heads/feature"), git(fixture.work, "rev-parse", "HEAD"));
});

test("publication updates the prepared PR without a metadata lookup", async (t) => {
  const fixture = await createFixture(t);
  git(fixture.work, "checkout", "-b", "feature");
  commitFile(fixture.work, "a.txt", "a\n", "feat: add a");
  git(fixture.work, "push", "-u", "origin", "feature");
  const head = git(fixture.work, "rev-parse", "HEAD");
  await writeJson(join(fixture.ghData, "pr-list.json"), [{
    number: 21,
    title: "Feature",
    url: "https://github.com/octo/example/pull/21",
    state: "OPEN",
    baseRefName: "main",
    headRefName: "feature",
    headRefOid: head,
    isDraft: false,
  }]);
  const { output } = prepare(fixture, "--mode", "publish");
  const plan = await writePlan(fixture.root, output.STATE, []);
  const applied = run("bash", [join(skillDir, "apply-commit-plan.sh"), output.STATE, plan], { cwd: fixture.work, env: fixture.env });
  const state = parseOutput(applied.stdout).STATE;
  const title = join(fixture.root, "title.txt");
  const body = join(fixture.root, "body.md");
  await writeFile(title, "feat: add a\n");
  await writeFile(body, "## Summary\nAdd a.\n");
  const published = run("bash", [join(skillDir, "publish-pr.sh"), "--state", state, "--title-file", title, "--body-file", body, "--update", "21"], {
    cwd: fixture.work,
    env: fixture.env,
  });
  assert.match(published.stdout, /PR=\[#21\]\(https:\/\/github\.com\/octo\/example\/pull\/21\)/);
  const ghLog = await readFile(join(fixture.ghData, "gh.log"), "utf8");
  assert.match(ghLog, /pr edit 21 .*--title feat: add a/);
  assert.equal((ghLog.match(/pr view/g) ?? []).length, 0);
});

test("published checkpoint cleanup uses explicit force-with-lease and tolerates missing create metadata", async (t) => {
  const fixture = await createFixture(t);
  git(fixture.work, "checkout", "-b", "feature");
  const checkpoint = commitFile(fixture.work, "a.txt", "a\n", "pi: checkpoint a");
  git(fixture.work, "push", "-u", "origin", "feature");
  await writeFile(fixture.env.GIT_LOG, "");
  const remoteBefore = git(fixture.work, "rev-parse", "HEAD");
  const { output } = prepare(fixture, "--mode", "publish");
  const message = join(fixture.root, "message.txt");
  await writeFile(message, "feat: add a\n");
  const plan = await writePlan(fixture.root, output.STATE, [{ commits: [checkpoint], message_file: message }]);
  const applied = run("bash", [join(skillDir, "apply-commit-plan.sh"), output.STATE, plan], { cwd: fixture.work, env: fixture.env });
  const state = parseOutput(applied.stdout).STATE;
  await writeFile(join(fixture.ghData, "create-output.txt"), "");
  const title = join(fixture.root, "title.txt");
  const body = join(fixture.root, "body.md");
  await writeFile(title, "feat: add a\n");
  await writeFile(body, "## Summary\nAdd a.\n");
  const published = run("bash", [join(skillDir, "publish-pr.sh"), "--state", state, "--title-file", title, "--body-file", body, "--create"], {
    cwd: fixture.work,
    env: fixture.env,
  });
  const pushLog = await readFile(fixture.env.GIT_LOG, "utf8");
  assert.match(pushLog, new RegExp(`--force-with-lease=refs/heads/feature:${remoteBefore}`));
  assert.match(published.stdout, /NOTE=GitHub mutation succeeded, but gh returned no PR URL metadata/);
  const result = JSON.parse(await readFile(parseOutput(published.stdout).RESULT, "utf8"));
  assert.equal(result.metadata_available, false);
  assert.equal(result.number, null);
});

test("publication rejects a remote branch that changed after preparation", async (t) => {
  const fixture = await createFixture(t);
  git(fixture.work, "checkout", "-b", "feature");
  commitFile(fixture.work, "a.txt", "a\n", "feat: add a");
  git(fixture.work, "push", "-u", "origin", "feature");
  const { output } = prepare(fixture, "--mode", "publish");
  const plan = await writePlan(fixture.root, output.STATE, []);
  const applied = run("bash", [join(skillDir, "apply-commit-plan.sh"), output.STATE, plan], { cwd: fixture.work, env: fixture.env });
  const state = parseOutput(applied.stdout).STATE;

  const other = join(fixture.root, "other");
  git(fixture.root, "clone", fixture.origin, other);
  git(other, "config", "user.name", "Other User");
  git(other, "config", "user.email", "other@example.com");
  git(other, "checkout", "feature");
  commitFile(other, "remote.txt", "remote\n", "remote update");
  git(other, "push", "origin", "feature");

  const title = join(fixture.root, "title.txt");
  const body = join(fixture.root, "body.md");
  await writeFile(title, "feat: add a\n");
  await writeFile(body, "## Summary\nAdd a.\n");
  const result = run("bash", [join(skillDir, "publish-pr.sh"), "--state", state, "--title-file", title, "--body-file", body, "--create"], {
    cwd: fixture.work,
    env: fixture.env,
    allowFailure: true,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Remote branch origin\/feature changed/);
});
