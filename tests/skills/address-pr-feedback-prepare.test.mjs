import {
  test,
  assert,
  readFile,
  writeFile,
  join,
  scripts,
  run,
  git,
  writeJson,
  createFixture,
  prepare,
} from "./address-pr-feedback-test-support.mjs";

test("preparation verifies the PR and builds a compact actionable worklist from paginated feedback", async (t) => {
  const fixture = await createFixture(t);
  const { result, output } = prepare(fixture, "--mode", "execute", "https://github.com/octo/example/pull/17");
  const state = JSON.parse(await readFile(output.STATE, "utf8"));
  const worklist = JSON.parse(await readFile(output.WORKLIST_JSON, "utf8"));
  const markdown = await readFile(output.WORKLIST, "utf8");
  const ids = worklist.all_actionable.map((item) => item.item_id);
  assert.equal(state.pr.head_sha, git(fixture.work, "rev-parse", "HEAD"));
  assert.deepEqual(ids.sort(), ["issue-comment:101", "review:202", "thread:PRRT_301"].sort());
  assert.equal(worklist.reference_threads[0].item_id, "thread:PRRT_401");
  assert.doesNotMatch(markdown, /END-FULL-BODY/);
  assert.match(markdown, /untrusted review input/i);
  assert.equal(result.stdout.includes("ACTIONABLE=3"), true);
  const rendered = run("bash", [join(scripts, "render-feedback-item.sh"), output.NORMALIZED, "issue-comment:101"], { cwd: fixture.work, env: fixture.env });
  assert.match(rendered.stdout, /END-FULL-BODY/);
});

test("preparation rejects cross-repository URLs and unsupported fork heads", async (t) => {
  const fixture = await createFixture(t);
  const crossRepo = run("bash", [join(scripts, "prepare-feedback.sh"), "https://github.com/other/repo/pull/17"], {
    cwd: fixture.work,
    env: fixture.env,
    allowFailure: true,
  });
  assert.notEqual(crossRepo.status, 0);
  assert.match(crossRepo.stderr, /checkout is 'octo\/example'/);

  const pr = JSON.parse(await readFile(join(fixture.ghData, "pr.json"), "utf8"));
  pr.isCrossRepository = true;
  pr.headRepository = { nameWithOwner: "fork/example" };
  await writeJson(join(fixture.ghData, "pr.json"), pr);
  const fork = run("bash", [join(scripts, "prepare-feedback.sh"), "17"], { cwd: fixture.work, env: fixture.env, allowFailure: true });
  assert.notEqual(fork.status, 0);
  assert.match(fork.stderr, /Fork PR layouts are not supported/);
});

test("preparation rejects a GitHub head that does not match origin", async (t) => {
  const fixture = await createFixture(t);
  await writeFile(join(fixture.ghData, "head-override"), "0000000000000000000000000000000000000000\n");
  const result = run("bash", [join(scripts, "prepare-feedback.sh"), "17"], {
    cwd: fixture.work,
    env: fixture.env,
    allowFailure: true,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /GitHub PR head does not match origin\/feature/);
});

test("GraphQL failure keeps REST threads complete and marks their state unknown", async (t) => {
  const fixture = await createFixture(t);
  await writeFile(join(fixture.ghData, "graphql-fail"), "1");
  const { result, output } = prepare(fixture, "--mode", "execute");
  const normalized = JSON.parse(await readFile(output.NORMALIZED, "utf8"));
  assert.equal(normalized.graphql_thread_error, "GraphQL unavailable");
  assert.equal(normalized.review_threads.every((thread) => thread.status === "unknown"), true);
  assert.equal(normalized.review_threads.find((thread) => thread.root_comment_id === 301).comments.length, 2);
  assert.match(result.stdout, /thread state failed/i);
});
