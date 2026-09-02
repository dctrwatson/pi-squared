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
} from "./create-pr-test-support.mjs";

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
