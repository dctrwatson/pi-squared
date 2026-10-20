import {
  test,
  assert,
  mkdir,
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
  setExistingPR,
} from "./publish-pr-test-support.mjs";

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

for (const { name, reference, kind, number, views } of [
  { name: "an issue URL", reference: "https://github.com/octo/example/issues/12", kind: "issue", number: 12, views: ["issue view 12"] },
  { name: "a PR URL", reference: "https://github.com/octo/example/pull/21", kind: "pr", number: 21, views: ["pr view 21"] },
  { name: "a PR shorthand", reference: "octo/example#21", kind: "pr", number: 21, views: ["pr view 21"] },
  { name: "an issue shorthand", reference: "#12", kind: "issue", number: 12, views: ["pr view 12", "issue view 12"] },
]) {
  test(`prepare reads comments from ${name} as JSON`, async (t) => {
    const fixture = await createFixture(t);
    git(fixture.work, "checkout", "-b", "feature");
    commitFile(fixture.work, "feature.txt", "feature\n", "pi: add feature");
    const record = {
      number,
      title: "Referenced discussion",
      url: `https://github.com/octo/example/${kind === "pr" ? "pull" : "issues"}/${number}`,
      state: "OPEN",
      body: "Reference details",
      comments: [{ body: "Reference comment" }],
    };
    await writeJson(join(fixture.ghData, `${kind}-view.json`), record);

    const { output } = prepare(fixture, "--mode", "publish", "--reference", reference);
    const references = JSON.parse(await readFile(output.REFERENCES, "utf8"));
    assert.equal(references.length, 1);
    assert.equal(references[0].kind, kind);
    assert.equal(references[0].number, number);
    assert.equal(references[0].url, record.url);
    const artifact = JSON.parse(await readFile(references[0].artifact, "utf8"));
    assert.equal(artifact.body, record.body);
    assert.deepEqual(artifact.comments, record.comments);

    const ghLog = await readFile(join(fixture.ghData, "gh.log"), "utf8");
    const referenceViews = ghLog.trim().split("\n").filter((line) => /^(issue|pr) view /.test(line));
    assert.deepEqual(referenceViews.map((line) => line.split(" ").slice(0, 3).join(" ")), views);
    for (const view of referenceViews) {
      assert.match(view, /--json number,title,url,state,body,comments(?: |$)/);
      assert.doesNotMatch(view, /(?:^| )--comments(?: |$)/);
    }
  });
}

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

test("preparation rejects an existing PR from a fork head repository", async (t) => {
  const fixture = await createFixture(t);
  git(fixture.work, "checkout", "-b", "feature");
  commitFile(fixture.work, "feature.txt", "feature\n", "feat: add feature");
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
    headRepository: { nameWithOwner: "contributor/example" },
    isCrossRepository: true,
    isDraft: false,
  }]);

  const result = run("bash", [join(skillDir, "prepare-pr.sh"), "--mode", "publish"], {
    cwd: fixture.work,
    env: fixture.env,
    allowFailure: true,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Fork PR layouts are not supported/);
});

test("push preparation requires an existing PR and skips recent titles and templates", async (t) => {
  const fixture = await createFixture(t);
  await mkdir(join(fixture.work, ".github", "PULL_REQUEST_TEMPLATE"), { recursive: true });
  await writeFile(join(fixture.work, ".github", "PULL_REQUEST_TEMPLATE", "feature.md"), "## Feature\n");
  git(fixture.work, "add", ".github");
  git(fixture.work, "commit", "-m", "docs: add PR template");
  git(fixture.work, "push", "origin", "main");
  git(fixture.work, "checkout", "-b", "feature");
  commitFile(fixture.work, "feature.txt", "feature\n", "feat: add feature");
  git(fixture.work, "push", "-u", "origin", "feature");
  await setExistingPR(fixture);

  const { output } = prepare(fixture, "--mode", "push");
  const state = JSON.parse(await readFile(output.STATE, "utf8"));
  const context = await readFile(output.CONTEXT, "utf8");
  const ghLog = await readFile(join(fixture.ghData, "gh.log"), "utf8");
  assert.equal(state.mode, "push");
  assert.equal(state.existing_pr.number, 21);
  assert.equal(state.artifacts?.recent_prs, undefined);
  assert.equal(state.artifacts?.templates, undefined);
  assert.doesNotMatch(ghLog, /--state merged/);
  assert.doesNotMatch(context, /Recent PR titles|Templates|feature\.md/);
});

test("push preparation rejects a branch without an existing PR", async (t) => {
  const fixture = await createFixture(t);
  git(fixture.work, "checkout", "-b", "feature");
  commitFile(fixture.work, "feature.txt", "feature\n", "feat: add feature");
  git(fixture.work, "push", "-u", "origin", "feature");

  const result = run("bash", [join(skillDir, "prepare-pr.sh"), "--mode", "push"], {
    cwd: fixture.work,
    env: fixture.env,
    allowFailure: true,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /existing PR/i);
  assert.doesNotMatch(await readFile(join(fixture.ghData, "gh.log"), "utf8"), /--state merged/);
});

test("edit preparation accepts a dirty branch with no local commits and saves PR body", async (t) => {
  const fixture = await createFixture(t);
  git(fixture.work, "checkout", "-b", "feature");
  git(fixture.work, "push", "-u", "origin", "feature");
  const pr = await setExistingPR(fixture);
  await writeFile(join(fixture.work, "README.md"), "dirty work\n");

  const { output } = prepare(fixture, "--mode", "edit", "--pr-number", String(pr.number));
  const state = JSON.parse(await readFile(output.STATE, "utf8"));
  const context = await readFile(output.CONTEXT, "utf8");
  const ghLog = await readFile(join(fixture.ghData, "gh.log"), "utf8");
  assert.equal(state.mode, "edit");
  assert.equal(state.dirty, true);
  assert.equal(state.existing_pr.body, "Existing PR body");
  assert.equal(state.existing_pr.number, pr.number);
  for (const name of ["commits", "changed_files", "diff_stat", "diff", "recent_prs", "templates"]) {
    assert.equal(state.artifacts?.[name], undefined, `${name} artifact is not needed for edit`);
  }
  assert.doesNotMatch(ghLog, /--state merged/);
  assert.doesNotMatch(context, /## Commits|Recent PR titles|Templates|Full diff/);
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
