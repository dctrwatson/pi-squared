import {
  test,
  assert,
  readFile,
  writeFile,
  join,
  skillDir,
  run,
  git,
  writeJson,
  createFixture,
  commitFile,
  parseOutput,
  prepare,
  writePlan,
} from "./create-pr-test-support.mjs";

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

test("rebased existing PR update uses an exact force-with-lease", async (t) => {
  const fixture = await createFixture(t);
  git(fixture.work, "checkout", "-b", "feature");
  commitFile(fixture.work, "a.txt", "a\n", "feat: add a");
  git(fixture.work, "push", "-u", "origin", "feature");
  const remotePrHead = git(fixture.work, "rev-parse", "HEAD");
  await writeJson(join(fixture.ghData, "pr-list.json"), [{
    number: 21,
    title: "Feature",
    url: "https://github.com/octo/example/pull/21",
    state: "OPEN",
    baseRefName: "main",
    headRefName: "feature",
    headRefOid: remotePrHead,
    isDraft: false,
  }]);

  git(fixture.work, "checkout", "main");
  commitFile(fixture.work, "base.txt", "base\n", "feat: update base");
  git(fixture.work, "push", "origin", "main");
  git(fixture.work, "checkout", "feature");
  git(fixture.work, "rebase", "main");
  const rebasedHead = git(fixture.work, "rev-parse", "HEAD");
  assert.notEqual(rebasedHead, remotePrHead);

  const { output } = prepare(fixture, "--mode", "publish");
  const prepared = JSON.parse(await readFile(output.STATE, "utf8"));
  assert.equal(prepared.remote_branch_sha, remotePrHead);
  assert.equal(prepared.existing_pr.headRefOid, remotePrHead);
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

  const pushLog = await readFile(fixture.env.GIT_LOG, "utf8");
  assert.match(pushLog, new RegExp(`--force-with-lease=refs/heads/feature:${remotePrHead}`));
  assert.doesNotMatch(pushLog, /(?:^|\s)--force(?:\s|$)/);
  assert.match(published.stdout, /PR=\[#21\]\(https:\/\/github\.com\/octo\/example\/pull\/21\)/);
  assert.equal(git(fixture.origin, "rev-parse", "refs/heads/feature"), rebasedHead);
});

test("rebased existing PR update rejects a remote branch change before mutation", async (t) => {
  const fixture = await createFixture(t);
  git(fixture.work, "checkout", "-b", "feature");
  commitFile(fixture.work, "a.txt", "a\n", "feat: add a");
  git(fixture.work, "push", "-u", "origin", "feature");
  const remotePrHead = git(fixture.work, "rev-parse", "HEAD");
  await writeJson(join(fixture.ghData, "pr-list.json"), [{
    number: 21,
    title: "Feature",
    url: "https://github.com/octo/example/pull/21",
    state: "OPEN",
    baseRefName: "main",
    headRefName: "feature",
    headRefOid: remotePrHead,
    isDraft: false,
  }]);

  git(fixture.work, "checkout", "main");
  commitFile(fixture.work, "base.txt", "base\n", "feat: update base");
  git(fixture.work, "push", "origin", "main");
  git(fixture.work, "checkout", "feature");
  git(fixture.work, "rebase", "main");
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
  await writeFile(fixture.env.GIT_LOG, "");

  const title = join(fixture.root, "title.txt");
  const body = join(fixture.root, "body.md");
  await writeFile(title, "feat: add a\n");
  await writeFile(body, "## Summary\nAdd a.\n");
  const result = run("bash", [join(skillDir, "publish-pr.sh"), "--state", state, "--title-file", title, "--body-file", body, "--update", "21"], {
    cwd: fixture.work,
    env: fixture.env,
    allowFailure: true,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Remote branch origin\/feature changed/);
  assert.equal(await readFile(fixture.env.GIT_LOG, "utf8"), "");
  assert.doesNotMatch(await readFile(join(fixture.ghData, "gh.log"), "utf8"), /pr edit/);
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
