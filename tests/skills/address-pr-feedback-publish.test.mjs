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
  createPreparedFixture,
} from "./address-pr-feedback-test-support.mjs";

test("feedback publication strips prefixes without squashing and uses only a normal push", async (t) => {
  const { fixture, prepared } = await createPreparedFixture(t);
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

test("publication force-pushes a validated rebased PR branch with an exact lease", async (t) => {
  const { fixture, prepared } = await createPreparedFixture(t);
  const preparedState = JSON.parse(await readFile(prepared.output.STATE, "utf8"));
  const remotePrHead = preparedState.remote_head_sha;

  git(fixture.work, "checkout", "main");
  commitFile(fixture.work, "base.txt", "new base\n", "feat: update base");
  git(fixture.work, "push", "origin", "main");
  git(fixture.work, "checkout", "feature");
  git(fixture.work, "rebase", "main");
  commitFile(fixture.work, "feedback.txt", "fixed\n", "pi: address review feedback");
  const validatedHead = git(fixture.work, "rev-parse", "HEAD");
  await writeFile(join(fixture.root, "git.log"), "");

  const refused = run("bash", [join(scripts, "publish-feedback-commits.sh"), "--state", prepared.output.STATE], {
    cwd: fixture.work,
    env: fixture.env,
    allowFailure: true,
  });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /require validation/);
  assert.equal(await readFile(join(fixture.root, "git.log"), "utf8"), "");

  const published = run("bash", [
    join(scripts, "publish-feedback-commits.sh"),
    "--state", prepared.output.STATE,
    "--validated-head", validatedHead,
  ], { cwd: fixture.work, env: fixture.env });
  const state = JSON.parse(await readFile(parseOutput(published.stdout).STATE, "utf8"));
  const pushLog = await readFile(join(fixture.root, "git.log"), "utf8");
  assert.match(pushLog, new RegExp(`--force-with-lease=refs/heads/feature:${remotePrHead}`));
  assert.doesNotMatch(pushLog, /(?:^|\s)--force(?:\s|$)/);
  assert.equal(state.history_rewritten, true);
  assert.match(state.published_history_backup, /^refs\/address-pr-feedback\/backups\/published-/);
  assert.deepEqual(
    git(fixture.work, "log", "--reverse", "--format=%s", "origin/main..HEAD").split("\n"),
    ["feat: initial feature", "address review feedback"],
  );
  assert.equal(git(fixture.origin, "rev-parse", "refs/heads/feature"), git(fixture.work, "rev-parse", "HEAD"));
});

test("rebased publication rejects a remote PR-head change after preparation", async (t) => {
  const { fixture, prepared } = await createPreparedFixture(t);
  const preparedState = JSON.parse(await readFile(prepared.output.STATE, "utf8"));

  git(fixture.work, "checkout", "main");
  commitFile(fixture.work, "base.txt", "new base\n", "feat: update base");
  git(fixture.work, "push", "origin", "main");
  git(fixture.work, "checkout", "feature");
  git(fixture.work, "rebase", "main");
  const validatedHead = git(fixture.work, "rev-parse", "HEAD");

  const other = join(fixture.root, "other-rebased");
  git(fixture.root, "clone", fixture.origin, other);
  git(other, "config", "user.name", "Other User");
  git(other, "config", "user.email", "other@example.com");
  git(other, "checkout", "feature");
  commitFile(other, "remote.txt", "remote\n", "remote update");
  git(other, "push", "origin", "feature");
  await writeFile(join(fixture.root, "git.log"), "");

  const refused = run("bash", [
    join(scripts, "publish-feedback-commits.sh"),
    "--state", prepared.output.STATE,
    "--validated-head", validatedHead,
  ], { cwd: fixture.work, env: fixture.env, allowFailure: true });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Remote PR head changed after preparation/);
  assert.equal(await readFile(join(fixture.root, "git.log"), "utf8"), "");
  assert.equal(git(fixture.origin, "rev-parse", "refs/heads/feature"), git(other, "rev-parse", "HEAD"));
  assert.notEqual(git(fixture.origin, "rev-parse", "refs/heads/feature"), preparedState.remote_head_sha);
});

test("publication rebases only new local commits and requires validation before retry", async (t) => {
  const { fixture, prepared } = await createPreparedFixture(t);
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

test("publication resumes after a manually resolved rebase conflict", async (t) => {
  const { fixture, prepared } = await createPreparedFixture(t);
  const preparedState = JSON.parse(await readFile(prepared.output.STATE, "utf8"));
  commitFile(fixture.work, "feature.txt", "local\n", "pi: update feature locally");

  const other = join(fixture.root, "other-conflict");
  git(fixture.root, "clone", fixture.origin, other);
  git(other, "config", "user.name", "Other User");
  git(other, "config", "user.email", "other@example.com");
  git(other, "checkout", "feature");
  commitFile(other, "feature.txt", "remote\n", "update feature remotely");
  git(other, "push", "origin", "feature");

  const stopped = run("bash", [join(scripts, "publish-feedback-commits.sh"), "--state", prepared.output.STATE], {
    cwd: fixture.work,
    env: fixture.env,
    allowFailure: true,
  });
  assert.notEqual(stopped.status, 0);
  assert.match(stopped.stderr, /Rebase stopped for conflicts/);
  const retryState = join(preparedState.workdir, "rebased-state.json");
  const pending = JSON.parse(await readFile(retryState, "utf8"));
  assert.equal(pending.rebase_in_progress, true);
  assert.equal(pending.remote_head_sha, git(fixture.origin, "rev-parse", "refs/heads/feature"));

  await writeFile(join(fixture.work, "feature.txt"), "resolved\n");
  run("git", ["add", "feature.txt"], { cwd: fixture.work, env: fixture.env });
  run("git", ["rebase", "--continue"], { cwd: fixture.work, env: { ...fixture.env, GIT_EDITOR: "true" } });
  const validatedHead = git(fixture.work, "rev-parse", "HEAD");
  await writeFile(join(fixture.root, "git.log"), "");

  const published = run("bash", [
    join(scripts, "publish-feedback-commits.sh"),
    "--state", retryState,
    "--validated-head", validatedHead,
  ], { cwd: fixture.work, env: fixture.env });
  assert.match(published.stdout, /PUBLISHED_HEAD=/);
  assert.equal(git(fixture.work, "show", "HEAD:feature.txt"), "resolved");
  assert.equal(git(fixture.origin, "rev-parse", "refs/heads/feature"), git(fixture.work, "rev-parse", "HEAD"));
  assert.doesNotMatch(await readFile(join(fixture.root, "git.log"), "utf8"), /force/);
});

test("publication does not force-push from an aborted rebase retry state", async (t) => {
  const { fixture, prepared } = await createPreparedFixture(t);
  const preparedState = JSON.parse(await readFile(prepared.output.STATE, "utf8"));
  commitFile(fixture.work, "local.txt", "local\n", "pi: local conflict change");
  const localHead = git(fixture.work, "rev-parse", "HEAD");

  const other = join(fixture.root, "other-abort");
  git(fixture.root, "clone", fixture.origin, other);
  git(other, "config", "user.name", "Other User");
  git(other, "config", "user.email", "other@example.com");
  git(other, "checkout", "feature");
  commitFile(other, "remote.txt", "remote\n", "remote update");
  git(other, "push", "origin", "feature");
  const remoteHead = git(fixture.origin, "rev-parse", "refs/heads/feature");
  git(fixture.work, "fetch", "origin", "feature");

  const retryState = join(preparedState.workdir, "aborted-rebase-state.json");
  await writeFile(retryState, `${JSON.stringify({
    ...preparedState,
    remote_head_sha: remoteHead,
    pr: { ...preparedState.pr, head_sha: remoteHead },
    local_head: localHead,
    validation_required: true,
    rebased: true,
    rebase_in_progress: true,
    rebase_source_state: prepared.output.STATE,
  })}\n`);
  await writeFile(join(fixture.root, "git.log"), "");

  const refused = run("bash", [
    join(scripts, "publish-feedback-commits.sh"),
    "--state", retryState,
    "--validated-head", localHead,
  ], { cwd: fixture.work, env: fixture.env, allowFailure: true });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /recorded rebase was aborted or replaced/);
  assert.match(refused.stderr, new RegExp(prepared.output.STATE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(await readFile(join(fixture.root, "git.log"), "utf8"), "");
  assert.equal(git(fixture.origin, "rev-parse", "refs/heads/feature"), remoteHead);
});

test("publication rejects a strict local prefix that was already pushed", async (t) => {
  const { fixture, prepared } = await createPreparedFixture(t);
  const first = commitFile(fixture.work, "first.txt", "first\n", "pi: first local change");
  commitFile(fixture.work, "second.txt", "second\n", "pi: second local change");
  git(fixture.work, "push", "origin", `${first}:refs/heads/feature`);
  await writeFile(join(fixture.root, "git.log"), "");

  const refused = run("bash", [join(scripts, "publish-feedback-commits.sh"), "--state", prepared.output.STATE], {
    cwd: fixture.work,
    env: fixture.env,
    allowFailure: true,
  });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Some prepared local commits are already published/);
  assert.equal(await readFile(join(fixture.root, "git.log"), "utf8"), "");
  assert.equal(git(fixture.origin, "rev-parse", "refs/heads/feature"), first);
});

test("publication recovers when a clean prepared commit was already pushed", async (t) => {
  const { fixture, prepared } = await createPreparedFixture(t);
  commitFile(fixture.work, "clean-published.txt", "published\n", "fix: clean published commit");
  git(fixture.work, "push", "origin", "feature");
  const result = run("bash", [join(scripts, "publish-feedback-commits.sh"), "--state", prepared.output.STATE], { cwd: fixture.work, env: fixture.env });
  const state = JSON.parse(await readFile(parseOutput(result.stdout).STATE, "utf8"));
  assert.equal(state.published_head, git(fixture.work, "rev-parse", "HEAD"));
  assert.equal(state.published_commits.length, 1);
});
