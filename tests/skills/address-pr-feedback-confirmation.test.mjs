import {
  test,
  assert,
  readFile,
  readdir,
  rm,
  writeFile,
  join,
  scripts,
  run,
  git,
  commitFile,
  parseOutput,
  createPreparedFixture,
  replyManifest,
} from "./address-pr-feedback-test-support.mjs";

function publish(fixture, state, ...args) {
  return run("bash", [join(scripts, "publish-feedback-commits.sh"), "--state", state, ...args], {
    cwd: fixture.work,
    env: fixture.env,
    allowFailure: true,
  });
}

async function pushedState(output) {
  const path = parseOutput(output).PENDING_STATE;
  assert.ok(path, "publication output must identify its pending state");
  return { path, state: JSON.parse(await readFile(path, "utf8")) };
}

async function pushLog(fixture) {
  return (await readFile(join(fixture.root, "git.log"), "utf8")).trim().split("\n").filter(Boolean);
}

test("transient stale PR heads use bounded fake backoff and confirm after one push", async (t) => {
  const { fixture, prepared } = await createPreparedFixture(t);
  const oldHead = JSON.parse(await readFile(prepared.output.STATE, "utf8")).remote_head_sha;
  commitFile(fixture.work, "feedback.txt", "fixed\n", "fix: address feedback");
  const expectedHead = git(fixture.work, "rev-parse", "HEAD");
  await writeFile(join(fixture.ghData, "pr-head-sequence"), `${oldHead}\n${oldHead}\n${expectedHead}\n`);

  const result = publish(fixture, prepared.output.STATE);
  assert.equal(result.status, 0, result.stderr);
  const output = parseOutput(result.stdout);
  assert.equal(output.PUBLISHED_HEAD, expectedHead);
  const published = JSON.parse(await readFile(output.STATE, "utf8"));
  assert.equal(published.publication_pending, false);
  assert.equal(published.published_head, expectedHead);
  assert.equal(published.pending_head, undefined);
  assert.deepEqual((await readFile(join(fixture.root, "sleep.log"), "utf8")).trim().split("\n"), ["1", "2"]);
  assert.equal((await pushLog(fixture)).length, 1);
});

test("an immediate healthy PR-head confirmation does not sleep", async (t) => {
  const { fixture, prepared } = await createPreparedFixture(t);
  commitFile(fixture.work, "feedback.txt", "fixed\n", "fix: address feedback");
  const expectedHead = git(fixture.work, "rev-parse", "HEAD");

  const result = publish(fixture, prepared.output.STATE);
  assert.equal(result.status, 0, result.stderr);
  const output = parseOutput(result.stdout);
  assert.equal(output.PUBLISHED_HEAD, expectedHead);
  const published = JSON.parse(await readFile(output.STATE, "utf8"));
  assert.equal(published.published_head, expectedHead);
  assert.equal((await readFile(join(fixture.root, "sleep.log"), "utf8")), "");
  assert.equal((await pushLog(fixture)).length, 1);
});

test("persistent stale PR head keeps pending state, blocks replies, then confirms without a second push", async (t) => {
  const { fixture, prepared } = await createPreparedFixture(t);
  const oldHead = JSON.parse(await readFile(prepared.output.STATE, "utf8")).remote_head_sha;
  commitFile(fixture.work, "feedback.txt", "fixed\n", "fix: address feedback");
  await writeFile(join(fixture.ghData, "confirmation-head-override"), `${oldHead}\n`);

  const refused = publish(fixture, prepared.output.STATE);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /GitHub PR head did not match/);
  const { path, state: pending } = await pushedState(refused.stdout);
  assert.equal(pending.publication_pending, true);
  assert.equal(pending.published_head, undefined);
  assert.equal(pending.pending_head, git(fixture.work, "rev-parse", "HEAD"));
  assert.doesNotMatch(refused.stdout, /(?:^|\n)(?:PUBLISHED_HEAD|STATE)=/);
  assert.deepEqual((await readFile(join(fixture.root, "sleep.log"), "utf8")).trim().split("\n"), ["1", "2", "4", "8", "8"]);
  assert.equal((await pushLog(fixture)).length, 1);

  const body = join(fixture.root, "reply.md");
  await writeFile(body, "I fixed the feedback.\n");
  const manifest = await replyManifest(fixture.root, pending.pending_head, [
    { item_id: "issue-comment:101", body_file: body },
  ]);
  const post = run("bash", [join(scripts, "post-feedback-replies.sh"), "--state", path, "--manifest", manifest], {
    cwd: fixture.work,
    env: fixture.env,
    allowFailure: true,
  });
  assert.notEqual(post.status, 0);
  assert.match(post.stderr, /requires published state/);
  assert.equal((await readdir(fixture.posts)).length, 0);

  await writeFile(join(fixture.ghData, "confirmation-head-override"), "");
  const retry = publish(fixture, path);
  assert.equal(retry.status, 0, retry.stderr);
  const output = parseOutput(retry.stdout);
  assert.equal(output.PUBLISHED_HEAD, pending.pending_head);
  const published = JSON.parse(await readFile(output.STATE, "utf8"));
  assert.equal(published.publication_pending, false);
  assert.equal(published.published_head, pending.pending_head);
  assert.equal(published.pending_head, undefined);
  assert.equal((await pushLog(fixture)).length, 1);
  assert.match(refused.stderr, /Retry confirmation without a push/);
});

test("custom publication output survives failed confirmation and retry", async (t) => {
  const { fixture, prepared } = await createPreparedFixture(t);
  const oldHead = JSON.parse(await readFile(prepared.output.STATE, "utf8")).remote_head_sha;
  commitFile(fixture.work, "feedback.txt", "fixed\n", "fix: address feedback");
  const customOutput = join(fixture.root, "custom-published-state.json");
  await writeFile(join(fixture.ghData, "confirmation-head-override"), `${oldHead}\n`);

  const refused = publish(fixture, prepared.output.STATE, "--output", customOutput);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /GitHub PR head did not match/);
  const { path, state } = await pushedState(refused.stdout);
  assert.equal(state.publication_pending, true);
  assert.equal(state.publication_output, customOutput);

  await writeFile(join(fixture.ghData, "confirmation-head-override"), "");
  const retry = publish(fixture, path);
  assert.equal(retry.status, 0, retry.stderr);
  const output = parseOutput(retry.stdout);
  assert.equal(output.STATE, customOutput);
  const published = JSON.parse(await readFile(customOutput, "utf8"));
  assert.equal(published.published_head, state.pending_head);
  assert.equal(published.publication_pending, false);
  assert.equal((await readdir(state.workdir)).includes("published-state.json"), false);
  assert.equal((await pushLog(fixture)).length, 1);
});

test("failed push keeps pending state and recovery directs the user to the preparation state", async (t) => {
  const { fixture, prepared } = await createPreparedFixture(t);
  const sourceHead = JSON.parse(await readFile(prepared.output.STATE, "utf8")).remote_head_sha;
  commitFile(fixture.work, "feedback.txt", "fixed\n", "fix: address feedback");
  await writeFile(join(fixture.ghData, "fail-before-push"), "fail\n");

  const failed = publish(fixture, prepared.output.STATE);
  assert.equal(failed.status, 74);
  assert.match(failed.stderr, /Push command failed/);
  assert.match(failed.stderr, /Check origin\/feature/);
  assert.match(failed.stderr, /inspect the failure, validate HEAD, and retry with preparation state/);
  assert.match(failed.stderr, new RegExp(prepared.output.STATE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const { path, state } = await pushedState(failed.stdout);
  assert.equal(state.publication_pending, true);
  assert.equal(state.pending_head, git(fixture.work, "rev-parse", "HEAD"));
  assert.equal(git(fixture.origin, "rev-parse", "refs/heads/feature"), sourceHead);
  assert.equal((await pushLog(fixture)).length, 1);

  const retry = publish(fixture, path);
  assert.notEqual(retry.status, 0);
  assert.match(retry.stderr, /origin\/feature does not match the publication head/);
  assert.match(retry.stderr, /Inspect the remote and push result/);
  assert.match(retry.stderr, /If the push did not reach origin.*retry with preparation state/);
  assert.match(retry.stderr, new RegExp(prepared.output.STATE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(retry.stderr, /Retry confirmation without a push/);
  assert.doesNotMatch(retry.stdout, /(?:^|\n)(?:PUBLISHED_HEAD|STATE)=/);
  assert.equal(git(fixture.origin, "rev-parse", "refs/heads/feature"), sourceHead);
  assert.equal((await pushLog(fixture)).length, 1);
});

test("validated force-push recovery confirms the same pending rewrite and keeps backups", async (t) => {
  const { fixture, prepared } = await createPreparedFixture(t);
  const preparedState = JSON.parse(await readFile(prepared.output.STATE, "utf8"));
  const oldHead = preparedState.remote_head_sha;

  git(fixture.work, "checkout", "main");
  commitFile(fixture.work, "base.txt", "new base\n", "feat: update base");
  git(fixture.work, "push", "origin", "main");
  git(fixture.work, "checkout", "feature");
  git(fixture.work, "rebase", "main");
  commitFile(fixture.work, "feedback.txt", "fixed\n", "pi: address feedback");
  const validatedHead = git(fixture.work, "rev-parse", "HEAD");
  await writeFile(join(fixture.ghData, "confirmation-head-override"), `${oldHead}\n`);

  const refused = publish(fixture, prepared.output.STATE, "--validated-head", validatedHead);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /GitHub PR head did not match/);
  const { path, state: pending } = await pushedState(refused.stdout);
  assert.equal(pending.history_rewritten, true);
  assert.match(pending.published_history_backup, /^refs\/address-pr-feedback\/backups\/published-/);
  assert.equal(git(fixture.work, "rev-parse", pending.published_history_backup), oldHead);
  const expectedHead = pending.pending_head;
  assert.equal(git(fixture.origin, "rev-parse", "refs/heads/feature"), expectedHead);
  assert.equal((await pushLog(fixture)).length, 1);

  await writeFile(join(fixture.ghData, "confirmation-head-override"), "");
  const retry = publish(fixture, path);
  assert.equal(retry.status, 0, retry.stderr);
  const output = parseOutput(retry.stdout);
  const published = JSON.parse(await readFile(output.STATE, "utf8"));
  assert.equal(output.PUBLISHED_HEAD, expectedHead);
  assert.equal(published.published_head, expectedHead);
  assert.equal(published.history_rewritten, true);
  assert.equal(published.published_history_backup, pending.published_history_backup);
  assert.equal(git(fixture.work, "rev-parse", published.published_history_backup), oldHead);
  assert.equal(git(fixture.origin, "rev-parse", "refs/heads/feature"), expectedHead);
  assert.equal((await pushLog(fixture)).length, 1);
});

test("PR view API failure leaves a retryable pending state", async (t) => {
  const { fixture, prepared } = await createPreparedFixture(t);
  commitFile(fixture.work, "feedback.txt", "fixed\n", "fix: address feedback");
  await writeFile(join(fixture.ghData, "pr-view-fail"), "fail\n");

  const refused = publish(fixture, prepared.output.STATE);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Could not read PR #17 during head confirmation/);
  const { path, state } = await pushedState(refused.stdout);
  assert.equal(state.publication_pending, true);
  assert.doesNotMatch(refused.stdout, /(?:^|\n)(?:PUBLISHED_HEAD|STATE)=/);
  assert.equal(await readFile(join(fixture.root, "sleep.log"), "utf8"), "");
  assert.match(refused.stderr, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal((await pushLog(fixture)).length, 1);
});

test("changed or closed PR identity refuses publication confirmation", async (t) => {
  const overrides = [
    { headRefName: "different" },
    { baseRefName: "release" },
    { isCrossRepository: true },
    { headRepository: { nameWithOwner: "other/project" } },
    { state: "CLOSED" },
  ];
  for (const override of overrides) {
    const { fixture, prepared } = await createPreparedFixture(t);
    commitFile(fixture.work, "feedback.txt", "fixed\n", "fix: address feedback");
    await writeFile(join(fixture.ghData, "pr-overrides.json"), `${JSON.stringify(override)}\n`);

    const refused = publish(fixture, prepared.output.STATE);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /not open or its repository, head branch, or base changed/);
    const { state } = await pushedState(refused.stdout);
    assert.equal(state.publication_pending, true);
    assert.doesNotMatch(refused.stdout, /(?:^|\n)(?:PUBLISHED_HEAD|STATE)=/);
    assert.equal((await pushLog(fixture)).length, 1);
  }
});

test("a remote change during a matching PR query is detected before confirmation", async (t) => {
  const { fixture, prepared } = await createPreparedFixture(t);
  const oldHead = JSON.parse(await readFile(prepared.output.STATE, "utf8")).remote_head_sha;
  commitFile(fixture.work, "feedback.txt", "fixed\n", "fix: address feedback");
  const expectedHead = git(fixture.work, "rev-parse", "HEAD");
  await writeFile(join(fixture.ghData, "remote-change-on-pr-view"), `${oldHead}\n`);

  const refused = publish(fixture, prepared.output.STATE);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /origin\/feature does not match the publication head/);
  assert.equal(git(fixture.origin, "rev-parse", "refs/heads/feature"), oldHead);
  const { state } = await pushedState(refused.stdout);
  assert.equal(state.pending_head, expectedHead);
  assert.equal(state.publication_pending, true);
  assert.equal((await readFile(join(fixture.root, "sleep.log"), "utf8")), "");
  assert.equal((await pushLog(fixture)).length, 1);
});

test("a remote change during backoff is detected before the next PR query", async (t) => {
  const { fixture, prepared } = await createPreparedFixture(t);
  const oldHead = JSON.parse(await readFile(prepared.output.STATE, "utf8")).remote_head_sha;
  commitFile(fixture.work, "feedback.txt", "fixed\n", "fix: address feedback");
  await writeFile(join(fixture.ghData, "confirmation-head-override"), `${oldHead}\n`);
  await writeFile(join(fixture.ghData, "change-remote-on-sleep"), `${oldHead}\n`);

  const refused = publish(fixture, prepared.output.STATE);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /origin\/feature does not match the publication head/);
  assert.equal(git(fixture.origin, "rev-parse", "refs/heads/feature"), oldHead);
  const { state } = await pushedState(refused.stdout);
  assert.equal(state.publication_pending, true);
  assert.equal((await readFile(join(fixture.root, "sleep.log"), "utf8")).trim(), "1");
  assert.equal((await pushLog(fixture)).length, 1);
});

test("interruption immediately after push retains the pending state", async (t) => {
  const { fixture, prepared } = await createPreparedFixture(t);
  commitFile(fixture.work, "feedback.txt", "fixed\n", "fix: address feedback");
  await writeFile(join(fixture.ghData, "interrupt-after-push"), "interrupt\n");

  const interrupted = publish(fixture, prepared.output.STATE);
  assert.equal(interrupted.status, 77);
  const { state } = await pushedState(interrupted.stdout);
  assert.equal(state.publication_pending, true);
  assert.equal(state.published_head, undefined);
  assert.equal(state.pending_head, git(fixture.origin, "rev-parse", "refs/heads/feature"));
  assert.equal(state.local_head, state.pending_head);
  assert.doesNotMatch(interrupted.stdout, /(?:^|\n)(?:PUBLISHED_HEAD|STATE)=/);
  const pendingCommits = state.published_commits;
  assert.equal(pendingCommits.length, 1);
  assert.equal((await pushLog(fixture)).length, 1);

  await rm(join(fixture.ghData, "interrupt-after-push"));
  const retry = publish(fixture, parseOutput(interrupted.stdout).PENDING_STATE);
  assert.equal(retry.status, 0, retry.stderr);
  const output = parseOutput(retry.stdout);
  const published = JSON.parse(await readFile(output.STATE, "utf8"));
  assert.equal(output.PUBLISHED_HEAD, state.pending_head);
  assert.equal(published.published_head, state.pending_head);
  assert.equal(published.local_head, state.local_head);
  assert.deepEqual(published.published_commits, pendingCommits);
  assert.equal((await pushLog(fixture)).length, 1);
  assert.match(interrupted.stderr, /Push command failed.*Check origin\/feature/);
  assert.match(interrupted.stderr, /If it matches .*retry confirmation with/);
});

test("pending recovery rejects a changed local HEAD without pushing", async (t) => {
  const { fixture, prepared } = await createPreparedFixture(t);
  const oldHead = JSON.parse(await readFile(prepared.output.STATE, "utf8")).remote_head_sha;
  commitFile(fixture.work, "feedback.txt", "fixed\n", "fix: address feedback");
  await writeFile(join(fixture.ghData, "confirmation-head-override"), `${oldHead}\n`);

  const refused = publish(fixture, prepared.output.STATE);
  assert.notEqual(refused.status, 0);
  const { path, state } = await pushedState(refused.stdout);
  assert.equal(state.publication_pending, true);
  await writeFile(join(fixture.ghData, "confirmation-head-override"), "");
  run("git", ["reset", "--hard", "HEAD^"], { cwd: fixture.work, env: fixture.env });
  const ghLogBefore = await readFile(join(fixture.ghData, "gh.log"), "utf8");

  const changed = publish(fixture, path);
  assert.notEqual(changed.status, 0);
  assert.match(changed.stderr, /HEAD changed after publication preparation/);
  const ghLogAfter = await readFile(join(fixture.ghData, "gh.log"), "utf8");
  assert.equal(ghLogAfter.split("\n").filter((line) => line.startsWith("pr view ")).length,
    ghLogBefore.split("\n").filter((line) => line.startsWith("pr view ")).length);
  assert.equal((await pushLog(fixture)).length, 1);
});
