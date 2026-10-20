import {
  test,
  assert,
  readFile,
  writeFile,
  writeJson,
  join,
  skillDir,
  run,
  git,
  createFixture,
  commitFile,
  parseOutput,
  prepare,
  writePlan,
  setExistingPR,
} from "./publish-pr-test-support.mjs";

test("update pushes and edits only the supplied title or body", async (t) => {
  for (const textField of ["title", "body"]) {
    const fixture = await createFixture(t);
    git(fixture.work, "checkout", "-b", "feature");
    commitFile(fixture.work, "first.txt", "first\n", "feat: start feature");
    git(fixture.work, "push", "-u", "origin", "feature");
    await setExistingPR(fixture);
    commitFile(fixture.work, "second.txt", "second\n", "feat: extend feature");

    const { output } = prepare(fixture, "--mode", "publish");
    const textFile = join(fixture.root, `${textField}.txt`);
    const text = textField === "title" ? "feat: title only\n" : "Body only\n";
    await writeFile(textFile, text);
    const textArgs = [textField === "title" ? "--title-file" : "--body-file", textFile];
    run("bash", [join(skillDir, "publish-pr.sh"), "--state", output.STATE, "--update", "21", ...textArgs], {
      cwd: fixture.work,
      env: fixture.env,
    });

    const ghLog = await readFile(join(fixture.ghData, "gh.log"), "utf8");
    const edit = ghLog.split("\n").find((line) => line.startsWith("pr edit 21 "));
    assert.ok(edit, `${textField} update edits the PR`);
    assert.match(edit, textField === "title" ? /--title feat: title only/ : /--body-file/);
    assert.doesNotMatch(edit, textField === "title" ? /--body-file/ : /--title/);
    assert.match(await readFile(fixture.env.GIT_LOG, "utf8"), /push -u origin HEAD:refs\/heads\/feature/);
    assert.equal(git(fixture.origin, "rev-parse", "refs/heads/feature"), git(fixture.work, "rev-parse", "HEAD"));
  }
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

test("push-only fast-forwards an existing PR branch without PR mutation", async (t) => {
  const fixture = await createFixture(t);
  git(fixture.work, "checkout", "-b", "feature");
  commitFile(fixture.work, "existing.txt", "existing\n", "feat: start feature");
  git(fixture.work, "push", "-u", "origin", "feature");
  await setExistingPR(fixture);
  commitFile(fixture.work, "next.txt", "next\n", "feat: extend feature");

  const { output } = prepare(fixture, "--mode", "push");
  run("bash", [join(skillDir, "publish-pr.sh"), "--state", output.STATE, "--push-only", "21"], {
    cwd: fixture.work,
    env: fixture.env,
  });
  const pushLog = await readFile(fixture.env.GIT_LOG, "utf8");
  assert.match(pushLog, /push -u origin HEAD:refs\/heads\/feature/);
  assert.doesNotMatch(pushLog, /force-with-lease/);
  assert.equal(git(fixture.origin, "rev-parse", "refs/heads/feature"), git(fixture.work, "rev-parse", "HEAD"));
  assert.doesNotMatch(await readFile(join(fixture.ghData, "gh.log"), "utf8"), /pr create|pr edit/);
});

test("push-only cleanup preserves prior commits and uses an exact lease without PR mutation", async (t) => {
  const fixture = await createFixture(t);
  git(fixture.work, "checkout", "-b", "feature");
  commitFile(fixture.work, "prior.txt", "prior\n", "docs: preserve prior commit");
  const checkpoint = commitFile(fixture.work, "feature.txt", "feature\n", "pi: checkpoint feature");
  git(fixture.work, "push", "-u", "origin", "feature");
  const remoteBefore = git(fixture.work, "rev-parse", "HEAD");
  await setExistingPR(fixture);

  const { output } = prepare(fixture, "--mode", "push");
  const message = join(fixture.root, "message.txt");
  await writeFile(message, "feat: add feature\n");
  const plan = await writePlan(fixture.root, output.STATE, [{ commits: [checkpoint], message_file: message }]);
  const applied = run("bash", [join(skillDir, "apply-commit-plan.sh"), output.STATE, plan], { cwd: fixture.work, env: fixture.env });
  const state = parseOutput(applied.stdout).STATE;
  const cleanedHead = git(fixture.work, "rev-parse", "HEAD");
  await writeFile(fixture.env.GIT_LOG, "");

  run("bash", [join(skillDir, "publish-pr.sh"), "--state", state, "--push-only", "21"], {
    cwd: fixture.work,
    env: fixture.env,
  });
  const pushLog = await readFile(fixture.env.GIT_LOG, "utf8");
  const subjects = git(fixture.work, "log", "--reverse", "--format=%s", "origin/main..HEAD").split("\n");
  assert.deepEqual(subjects, ["docs: preserve prior commit", "feat: add feature"]);
  assert.equal(git(fixture.work, "show", "HEAD:prior.txt"), "prior");
  assert.equal(git(fixture.origin, "rev-parse", "refs/heads/feature"), cleanedHead);
  assert.match(pushLog, new RegExp(`--force-with-lease=refs/heads/feature:${remoteBefore}`));
  assert.doesNotMatch(await readFile(join(fixture.ghData, "gh.log"), "utf8"), /pr create|pr edit/);
});

test("push-only refuses uncleaned checkpoints without mutation", async (t) => {
  const fixture = await createFixture(t);
  git(fixture.work, "checkout", "-b", "feature");
  commitFile(fixture.work, "feature.txt", "feature\n", "pi: checkpoint feature");
  git(fixture.work, "push", "-u", "origin", "feature");
  await setExistingPR(fixture);
  const { output } = prepare(fixture, "--mode", "push");
  const beforeHead = git(fixture.work, "rev-parse", "HEAD");
  const checkpoint = run("bash", [join(skillDir, "publish-pr.sh"), "--state", output.STATE, "--push-only", "21"], {
    cwd: fixture.work,
    env: fixture.env,
    allowFailure: true,
  });
  assert.notEqual(checkpoint.status, 0);
  assert.match(checkpoint.stderr, /pi: commits remain|commit plan/i);
  assert.equal(git(fixture.work, "rev-parse", "HEAD"), beforeHead);
  assert.equal(await readFile(fixture.env.GIT_LOG, "utf8"), "");
  assert.doesNotMatch(await readFile(join(fixture.ghData, "gh.log"), "utf8"), /pr create|pr edit/);
});

test("push-only rejects text and metadata flags and a wrong PR", async (t) => {
  const fixture = await createFixture(t);
  git(fixture.work, "checkout", "-b", "feature");
  commitFile(fixture.work, "feature.txt", "feature\n", "feat: add feature");
  git(fixture.work, "push", "-u", "origin", "feature");
  await setExistingPR(fixture);
  const { output } = prepare(fixture, "--mode", "push");
  const args = ["--state", output.STATE, "--push-only", "21"];

  for (const flags of [
    ["--title-file", join(fixture.root, "title.txt")],
    ["--body-file", join(fixture.root, "body.md")],
    ["--draft"],
    ["--reviewer", "reviewer"],
    ["--label", "label"],
    ["--assignee", "assignee"],
  ]) {
    const rejected = run("bash", [join(skillDir, "publish-pr.sh"), ...args, ...flags], {
      cwd: fixture.work,
      env: fixture.env,
      allowFailure: true,
    });
    assert.notEqual(rejected.status, 0, `accepted ${flags.join(" ")}`);
  }
  const wrongPR = run("bash", [join(skillDir, "publish-pr.sh"), "--state", output.STATE, "--push-only", "22"], {
    cwd: fixture.work,
    env: fixture.env,
    allowFailure: true,
  });
  assert.notEqual(wrongPR.status, 0);
  assert.equal(await readFile(fixture.env.GIT_LOG, "utf8"), "");
  assert.doesNotMatch(await readFile(join(fixture.ghData, "gh.log"), "utf8"), /pr create|pr edit/);
});

test("push-only refuses a stale branch and does not use a stale lease", async (t) => {
  const fixture = await createFixture(t);
  git(fixture.work, "checkout", "-b", "feature");
  const checkpoint = commitFile(fixture.work, "feature.txt", "feature\n", "pi: checkpoint feature");
  git(fixture.work, "push", "-u", "origin", "feature");
  await setExistingPR(fixture);
  const { output } = prepare(fixture, "--mode", "push");
  const message = join(fixture.root, "message.txt");
  await writeFile(message, "feat: add feature\n");
  const plan = await writePlan(fixture.root, output.STATE, [{ commits: [checkpoint], message_file: message }]);
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

  const result = run("bash", [join(skillDir, "publish-pr.sh"), "--state", state, "--push-only", "21"], {
    cwd: fixture.work,
    env: fixture.env,
    allowFailure: true,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Remote branch origin\/feature changed/);
  assert.equal(await readFile(fixture.env.GIT_LOG, "utf8"), "");
  assert.doesNotMatch(await readFile(join(fixture.ghData, "gh.log"), "utf8"), /pr create|pr edit/);
});

test("edit changes only supplied text while allowing dirty work and a changed local HEAD", async (t) => {
  const titleFixture = await createFixture(t);
  git(titleFixture.work, "checkout", "-b", "feature");
  git(titleFixture.work, "push", "-u", "origin", "feature");
  await setExistingPR(titleFixture);
  await writeFile(join(titleFixture.work, "README.md"), "dirty edit work\n");
  const titlePrepared = prepare(titleFixture, "--mode", "edit", "--pr-number", "21");
  const titleFile = join(titleFixture.root, "title.txt");
  await writeFile(titleFile, "feat: title only\n");
  const titleHead = git(titleFixture.work, "rev-parse", "HEAD");
  const titleEdit = run("bash", [join(skillDir, "publish-pr.sh"), "--state", titlePrepared.output.STATE, "--edit", "21", "--title-file", titleFile], {
    cwd: titleFixture.work,
    env: titleFixture.env,
  });
  const titleGhLog = await readFile(join(titleFixture.ghData, "gh.log"), "utf8");
  assert.match(titleGhLog, /pr view 21/);
  assert.match(titleGhLog, /pr edit 21 .*--title feat: title only/);
  assert.doesNotMatch(titleGhLog, /pr edit 21 .*--body-file/);
  assert.equal(await readFile(titleFixture.env.GIT_LOG, "utf8"), "");
  assert.equal(git(titleFixture.work, "rev-parse", "HEAD"), titleHead);
  assert.match(titleEdit.stdout, /ACTION=edit/);

  const bodyFixture = await createFixture(t);
  git(bodyFixture.work, "checkout", "-b", "feature");
  git(bodyFixture.work, "push", "-u", "origin", "feature");
  await setExistingPR(bodyFixture);
  const bodyPrepared = prepare(bodyFixture, "--mode", "edit", "--pr-number", "21");
  commitFile(bodyFixture.work, "later.txt", "later\n", "docs: local change after preparation");
  await writeFile(join(bodyFixture.work, "README.md"), "dirty edit work\n");
  const other = join(bodyFixture.root, "other");
  git(bodyFixture.root, "clone", bodyFixture.origin, other);
  git(other, "config", "user.name", "Other User");
  git(other, "config", "user.email", "other@example.com");
  commitFile(other, "base-update.txt", "base update\n", "docs: update base after preparation");
  git(other, "push", "origin", "main");
  const bodyFile = join(bodyFixture.root, "body.md");
  await writeFile(bodyFile, "Updated body only\n");
  const bodyHead = git(bodyFixture.work, "rev-parse", "HEAD");
  run("bash", [join(skillDir, "publish-pr.sh"), "--state", bodyPrepared.output.STATE, "--edit", "21", "--body-file", bodyFile], {
    cwd: bodyFixture.work,
    env: bodyFixture.env,
  });
  const bodyGhLog = await readFile(join(bodyFixture.ghData, "gh.log"), "utf8");
  assert.match(bodyGhLog, /pr edit 21 .*--body-file/);
  assert.doesNotMatch(bodyGhLog, /pr edit 21 .*--title/);
  assert.equal(await readFile(bodyFile, "utf8"), "Updated body only\n");
  assert.equal(await readFile(bodyFixture.env.GIT_LOG, "utf8"), "");
  assert.equal(git(bodyFixture.work, "rev-parse", "HEAD"), bodyHead);
});

test("edit rejects stale PR identity before mutation", async (t) => {
  const staleCases = [
    ["changed PR number", { number: 22 }],
    ["closed PR", { state: "CLOSED" }],
    ["changed base", { baseRefName: "release" }],
    ["changed head", { headRefName: "other" }],
    ["changed head commit", { headRefOid: "0000000000000000000000000000000000000000" }],
    ["changed title", { title: "Changed title" }],
    ["changed body", { body: "Changed body" }],
    ["fork head", { headRepository: { nameWithOwner: "fork/example" }, isCrossRepository: true }],
  ];
  for (const [name, changedFields] of staleCases) {
    const fixture = await createFixture(t);
    git(fixture.work, "checkout", "-b", "feature");
    git(fixture.work, "push", "-u", "origin", "feature");
    const originalPR = await setExistingPR(fixture);
    const { output } = prepare(fixture, "--mode", "edit", "--pr-number", "21");
    await writeJson(join(fixture.ghData, "pr-view.json"), { ...originalPR, ...changedFields });
    const title = join(fixture.root, "title.txt");
    await writeFile(title, "feat: title\n");
    const headBefore = git(fixture.work, "rev-parse", "HEAD");
    const result = run("bash", [join(skillDir, "publish-pr.sh"), "--state", output.STATE, "--edit", "21", "--title-file", title], {
      cwd: fixture.work,
      env: fixture.env,
      allowFailure: true,
    });
    assert.notEqual(result.status, 0, name);
    assert.equal(git(fixture.work, "rev-parse", "HEAD"), headBefore, name);
    assert.equal(await readFile(fixture.env.GIT_LOG, "utf8"), "", name);
    const ghLog = await readFile(join(fixture.ghData, "gh.log"), "utf8");
    assert.match(ghLog, /pr view 21/, name);
    assert.doesNotMatch(ghLog, /pr edit|pr create/, name);
  }
});

test("edit rejects a different current branch or repository", async (t) => {
  const branchFixture = await createFixture(t);
  git(branchFixture.work, "checkout", "-b", "feature");
  git(branchFixture.work, "push", "-u", "origin", "feature");
  await setExistingPR(branchFixture);
  const branchPrepared = prepare(branchFixture, "--mode", "edit", "--pr-number", "21");
  const title = join(branchFixture.root, "title.txt");
  await writeFile(title, "feat: title\n");
  git(branchFixture.work, "checkout", "main");
  const branchResult = run("bash", [join(skillDir, "publish-pr.sh"), "--state", branchPrepared.output.STATE, "--edit", "21", "--title-file", title], {
    cwd: branchFixture.work,
    env: branchFixture.env,
    allowFailure: true,
  });
  assert.notEqual(branchResult.status, 0);
  assert.doesNotMatch(await readFile(join(branchFixture.ghData, "gh.log"), "utf8"), /pr edit|pr create/);
  assert.equal(await readFile(branchFixture.env.GIT_LOG, "utf8"), "");

  const repoFixture = await createFixture(t);
  git(repoFixture.work, "checkout", "-b", "feature");
  git(repoFixture.work, "push", "-u", "origin", "feature");
  await setExistingPR(repoFixture);
  const repoPrepared = prepare(repoFixture, "--mode", "edit", "--pr-number", "21");
  const repoTitle = join(repoFixture.root, "title.txt");
  await writeFile(repoTitle, "feat: title\n");
  await writeJson(join(repoFixture.ghData, "repo.json"), {
    nameWithOwner: "other/example",
    url: "https://github.com/other/example",
    defaultBranchRef: { name: "main" },
  });
  const repoResult = run("bash", [join(skillDir, "publish-pr.sh"), "--state", repoPrepared.output.STATE, "--edit", "21", "--title-file", repoTitle], {
    cwd: repoFixture.work,
    env: repoFixture.env,
    allowFailure: true,
  });
  assert.notEqual(repoResult.status, 0);
  assert.doesNotMatch(await readFile(join(repoFixture.ghData, "gh.log"), "utf8"), /pr edit|pr create/);
  assert.equal(await readFile(repoFixture.env.GIT_LOG, "utf8"), "");
});

test("edit requires text and rejects metadata flags", async (t) => {
  const fixture = await createFixture(t);
  git(fixture.work, "checkout", "-b", "feature");
  git(fixture.work, "push", "-u", "origin", "feature");
  await setExistingPR(fixture);
  const { output } = prepare(fixture, "--mode", "edit", "--pr-number", "21");
  const title = join(fixture.root, "title.txt");
  await writeFile(title, "feat: title\n");
  for (const flags of [
    [],
    ["--title-file", title, "--draft"],
    ["--title-file", title, "--reviewer", "reviewer"],
    ["--title-file", title, "--label", "label"],
    ["--title-file", title, "--assignee", "assignee"],
  ]) {
    const result = run("bash", [join(skillDir, "publish-pr.sh"), "--state", output.STATE, "--edit", "21", ...flags], {
      cwd: fixture.work,
      env: fixture.env,
      allowFailure: true,
    });
    assert.notEqual(result.status, 0, flags.join(" "));
  }
  assert.equal(await readFile(fixture.env.GIT_LOG, "utf8"), "");
  assert.doesNotMatch(await readFile(join(fixture.ghData, "gh.log"), "utf8"), /pr edit|pr create/);
});

test("create rejects prepared state with an existing PR before pushing or mutating GitHub", async (t) => {
  const fixture = await createFixture(t);
  git(fixture.work, "checkout", "-b", "feature");
  commitFile(fixture.work, "first.txt", "first\n", "feat: start feature");
  git(fixture.work, "push", "-u", "origin", "feature");
  await setExistingPR(fixture);
  const remoteBefore = git(fixture.origin, "rev-parse", "refs/heads/feature");
  commitFile(fixture.work, "second.txt", "second\n", "feat: extend feature");
  const headBefore = git(fixture.work, "rev-parse", "HEAD");

  const { output } = prepare(fixture, "--mode", "publish");
  const title = join(fixture.root, "title.txt");
  const body = join(fixture.root, "body.md");
  await writeFile(title, "feat: feature\n");
  await writeFile(body, "Feature details\n");
  const result = run("bash", [join(skillDir, "publish-pr.sh"), "--state", output.STATE, "--title-file", title, "--body-file", body, "--create"], {
    cwd: fixture.work,
    env: fixture.env,
    allowFailure: true,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /already has PR|existing PR/i);
  assert.equal(await readFile(fixture.env.GIT_LOG, "utf8"), "");
  assert.equal(git(fixture.origin, "rev-parse", "refs/heads/feature"), remoteBefore);
  assert.equal(git(fixture.work, "rev-parse", "HEAD"), headBefore);
  assert.doesNotMatch(await readFile(join(fixture.ghData, "gh.log"), "utf8"), /pr create|pr edit/);
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
