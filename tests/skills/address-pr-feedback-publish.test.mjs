import {
  test,
  assert,
  readFile,
  writeFile,
  join,
  scripts,
  run,
  git,
  commitFile,
  parseOutput,
  createFixture,
  prepare,
} from "./address-pr-feedback-test-support.mjs";

test("feedback publication strips prefixes without squashing and uses only a normal push", async (t) => {
  const fixture = await createFixture(t);
  const prepared = prepare(fixture, "--mode", "execute");
  commitFile(fixture.work, "a.txt", "a\n", "pi: fix parser validation", "Preserve this body.");
  commitFile(fixture.work, "b.txt", "b\n", "pi: test parser validation", "Preserve the second body.");
  await writeFile(join(fixture.root, "git.log"), "");
  const published = run("bash", [join(scripts, "publish-feedback-commits.sh"), "--state", prepared.output.STATE], { cwd: fixture.work, env: fixture.env });
  const output = parseOutput(published.stdout);
  const subjects = git(fixture.work, "log", "--reverse", "--format=%s", `${JSON.parse(await readFile(prepared.output.STATE, "utf8")).remote_head_sha}..HEAD`).split("\n");
  assert.deepEqual(subjects, ["fix parser validation", "test parser validation"]);
  assert.match(git(fixture.work, "log", "-2", "--format=%b"), /Preserve this body/);
  assert.equal(JSON.parse(await readFile(output.STATE, "utf8")).published_commits.length, 2);
  const pushLog = await readFile(join(fixture.root, "git.log"), "utf8");
  assert.match(pushLog, /push -u origin HEAD:refs\/heads\/feature/);
  assert.doesNotMatch(pushLog, /force/);
});

test("publication rebases only new local commits and requires validation before retry", async (t) => {
  const fixture = await createFixture(t);
  const prepared = prepare(fixture, "--mode", "execute");
  commitFile(fixture.work, "local.txt", "local\n", "pi: fix local behavior");
  const other = join(fixture.root, "other");
  git(fixture.root, "clone", fixture.origin, other);
  git(other, "config", "user.name", "Other User");
  git(other, "config", "user.email", "other@example.com");
  git(other, "checkout", "feature");
  commitFile(other, "remote.txt", "remote\n", "remote update");
  git(other, "push", "origin", "feature");
  const remoteAfter = git(fixture.origin, "rev-parse", "refs/heads/feature");

  const rebased = run("bash", [join(scripts, "publish-feedback-commits.sh"), "--state", prepared.output.STATE], { cwd: fixture.work, env: fixture.env });
  const rebasedOutput = parseOutput(rebased.stdout);
  assert.match(rebased.stdout, /VALIDATION_REQUIRED=1/);
  assert.equal(git(fixture.origin, "rev-parse", "refs/heads/feature"), remoteAfter);
  const refused = run("bash", [join(scripts, "publish-feedback-commits.sh"), "--state", rebasedOutput.STATE], { cwd: fixture.work, env: fixture.env, allowFailure: true });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /require validation/);
  const head = git(fixture.work, "rev-parse", "HEAD");
  const published = run("bash", [join(scripts, "publish-feedback-commits.sh"), "--state", rebasedOutput.STATE, "--validated-head", head], { cwd: fixture.work, env: fixture.env });
  assert.match(published.stdout, /PUBLISHED_HEAD=/);
  assert.equal(git(fixture.origin, "rev-parse", "refs/heads/feature"), git(fixture.work, "rev-parse", "HEAD"));
  assert.doesNotMatch(await readFile(join(fixture.root, "git.log"), "utf8"), /force/);
});

test("publication recovers when a clean prepared commit was already pushed", async (t) => {
  const fixture = await createFixture(t);
  const prepared = prepare(fixture, "--mode", "execute");
  commitFile(fixture.work, "clean-published.txt", "published\n", "fix: clean published commit");
  git(fixture.work, "push", "origin", "feature");
  const result = run("bash", [join(scripts, "publish-feedback-commits.sh"), "--state", prepared.output.STATE], { cwd: fixture.work, env: fixture.env });
  const state = JSON.parse(await readFile(parseOutput(result.stdout).STATE, "utf8"));
  assert.equal(state.published_head, git(fixture.work, "rev-parse", "HEAD"));
  assert.equal(state.published_commits.length, 1);
});
