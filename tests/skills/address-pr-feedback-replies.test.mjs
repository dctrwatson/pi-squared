import {
  test,
  assert,
  readFile,
  readdir,
  writeFile,
  join,
  scripts,
  run,
  git,
  commitFile,
  parseOutput,
  createFixture,
  prepare,
  replyManifest,
} from "./address-pr-feedback-test-support.mjs";

test("publication refuses to rewrite a commit that appeared on the remote", async (t) => {
  const fixture = await createFixture(t);
  const prepared = prepare(fixture, "--mode", "execute");
  commitFile(fixture.work, "published.txt", "published\n", "pi: published outside workflow");
  git(fixture.work, "push", "origin", "feature");
  const result = run("bash", [join(scripts, "publish-feedback-commits.sh"), "--state", prepared.output.STATE], { cwd: fixture.work, env: fixture.env, allowFailure: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /already published/);
  assert.equal(git(fixture.origin, "log", "-1", "--format=%s", "feature"), "pi: published outside workflow");
});

test("dry-run preparation state previews replies without publication or posting", async (t) => {
  const fixture = await createFixture(t);
  const prepared = prepare(fixture, "--mode", "dry-run");
  const state = JSON.parse(await readFile(prepared.output.STATE, "utf8"));
  assert.equal(state.mode, "dry-run");
  assert.equal(state.published_head, undefined);
  const body = join(fixture.root, "dry-run-reply.md");
  await writeFile(body, "I would add validation.\n");
  const manifest = await replyManifest(fixture.root, state.remote_head_sha, [
    { item_id: "issue-comment:101", body_file: body },
  ]);

  const preview = run("bash", [join(scripts, "post-feedback-replies.sh"), "--state", prepared.output.STATE, "--manifest", manifest, "--dry-run"], { cwd: fixture.work, env: fixture.env });
  assert.match(preview.stdout, /--- BODY issue-comment:101 ---\nI would add validation\.\n\n<!-- pi-feedback:handled issue-comment:101 -->\n--- END BODY issue-comment:101 ---/);
  assert.equal((await readdir(fixture.posts)).length, 0);
  assert.equal(await readFile(join(fixture.root, "git.log"), "utf8"), "");
  assert.doesNotMatch(await readFile(join(fixture.ghData, "gh.log"), "utf8"), /api -X POST/);

  const realPost = run("bash", [join(scripts, "post-feedback-replies.sh"), "--state", prepared.output.STATE, "--manifest", manifest], { cwd: fixture.work, env: fixture.env, allowFailure: true });
  assert.notEqual(realPost.status, 0);
  assert.match(realPost.stderr, /requires published state/);
  assert.equal((await readdir(fixture.posts)).length, 0);
});

test("reply batches preview exact bodies, verify heads, and retry without duplicates", async (t) => {
  const fixture = await createFixture(t);
  const prepared = prepare(fixture, "--mode", "execute");
  const publication = run("bash", [join(scripts, "publish-feedback-commits.sh"), "--state", prepared.output.STATE], { cwd: fixture.work, env: fixture.env });
  const publishedState = parseOutput(publication.stdout).STATE;
  const publishedHead = git(fixture.work, "rev-parse", "HEAD");
  const threadBody = join(fixture.root, "thread.md");
  const generalBody = join(fixture.root, "general.md");
  await writeFile(threadBody, "I fixed the nil handling.\n");
  await writeFile(generalBody, "I added validation.\n");
  const manifest = await replyManifest(fixture.root, publishedHead, [
    { item_id: "thread:PRRT_301", body_file: threadBody },
    { item_id: "issue-comment:101", body_file: generalBody },
  ]);
  const results = join(fixture.root, "reply-results.json");
  const preview = run("bash", [join(scripts, "post-feedback-replies.sh"), "--state", publishedState, "--manifest", manifest, "--results", results, "--dry-run"], { cwd: fixture.work, env: fixture.env });
  assert.match(preview.stdout, /I fixed the nil handling/);
  assert.match(preview.stdout, /<!-- pi-feedback:handled issue-comment:101 -->/);
  assert.equal((await readdir(fixture.posts)).length, 0);

  await writeFile(join(fixture.ghData, "fail-once"), "/issues/17/comments");
  const partial = run("bash", [join(scripts, "post-feedback-replies.sh"), "--state", publishedState, "--manifest", manifest, "--results", results], { cwd: fixture.work, env: fixture.env, allowFailure: true });
  assert.notEqual(partial.status, 0);
  assert.deepEqual(JSON.parse(await readFile(results, "utf8")).posted.map((item) => item.item_id), ["thread:PRRT_301"]);
  const retry = run("bash", [join(scripts, "post-feedback-replies.sh"), "--state", publishedState, "--manifest", manifest, "--results", results], { cwd: fixture.work, env: fixture.env });
  assert.match(retry.stdout, /SKIP_POSTED=thread:PRRT_301/);
  assert.equal(JSON.parse(await readFile(results, "utf8")).posted.length, 2);
  const postFilesBefore = (await readdir(fixture.posts)).filter((name) => name.endsWith(".json")).length;
  run("bash", [join(scripts, "post-feedback-replies.sh"), "--state", publishedState, "--manifest", manifest, "--results", results], { cwd: fixture.work, env: fixture.env });
  const postFilesAfter = (await readdir(fixture.posts)).filter((name) => name.endsWith(".json")).length;
  assert.equal(postFilesAfter, postFilesBefore);

  await writeFile(join(fixture.ghData, "head-override"), "0000000000000000000000000000000000000000\n");
  const staleResults = join(fixture.root, "stale-results.json");
  const stale = run("bash", [join(scripts, "post-feedback-replies.sh"), "--state", publishedState, "--manifest", manifest, "--results", staleResults], { cwd: fixture.work, env: fixture.env, allowFailure: true });
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /PR head changed/);
});
