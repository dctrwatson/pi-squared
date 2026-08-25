import {
  test,
  assert,
  readFile,
  writeFile,
  join,
  skillDir,
  run,
  git,
  createFixture,
  commitFile,
  parseOutput,
  prepare,
  writePlan,
} from "./create-pr-test-support.mjs";

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
