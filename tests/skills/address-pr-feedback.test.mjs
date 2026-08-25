import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../..");
const skillDir = join(repoRoot, "skills/address-pr-feedback");
const scripts = join(skillDir, "scripts");
const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
  });
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result;
}

function git(cwd, ...args) {
  return execFileSync(realGit, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value)}\n`);
}

function commitFile(work, path, content, subject, body = "") {
  const absolute = join(work, path);
  execFileSync("mkdir", ["-p", resolve(absolute, "..")]);
  execFileSync("bash", ["-c", `printf '%s' "$1" > "$2"`, "_", content, absolute]);
  git(work, "add", path);
  const args = ["commit", "-m", subject];
  if (body) args.push("-m", body);
  git(work, ...args);
  return git(work, "rev-parse", "HEAD");
}

function parseOutput(output) {
  return Object.fromEntries(output.trim().split("\n").filter((line) => line.includes("=")).map((line) => {
    const index = line.indexOf("=");
    return [line.slice(0, index), line.slice(index + 1)];
  }));
}

async function createFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "address-feedback-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  const fakeBin = join(root, "bin");
  const ghData = join(root, "gh-data");
  const posts = join(ghData, "posts");
  await mkdir(fakeBin);
  await mkdir(ghData);
  await mkdir(posts);
  git(root, "init", "--bare", origin);
  git(root, "init", work);
  git(work, "config", "user.name", "Test User");
  git(work, "config", "user.email", "test@example.com");
  git(work, "remote", "add", "origin", origin);
  await writeFile(join(work, "README.md"), "base\n");
  git(work, "add", "README.md");
  git(work, "commit", "-m", "initial");
  git(work, "branch", "-M", "main");
  git(work, "push", "-u", "origin", "main");
  git(work, "checkout", "-b", "feature");
  commitFile(work, "feature.txt", "feature\n", "feat: initial feature");
  git(work, "push", "-u", "origin", "feature");
  const head = git(work, "rev-parse", "HEAD");

  await writeJson(join(ghData, "repo.json"), { nameWithOwner: "octo/example", url: "https://github.com/octo/example" });
  await writeJson(join(ghData, "pr.json"), {
    number: 17,
    title: "Feature",
    url: "https://github.com/octo/example/pull/17",
    state: "OPEN",
    baseRefName: "main",
    baseRefOid: git(work, "rev-parse", "origin/main"),
    headRefName: "feature",
    headRefOid: head,
    headRepository: { nameWithOwner: "octo/example" },
    headRepositoryOwner: { login: "octo" },
    isCrossRepository: false,
    reviewDecision: "CHANGES_REQUESTED",
    isDraft: false,
    author: { login: "author" },
  });
  await writeFile(join(ghData, "issue-pages.jsonl"), `${JSON.stringify([
    { id: 101, user: { login: "alice" }, body: `Please add validation. ${"detail ".repeat(40)}END-FULL-BODY`, created_at: "2026-01-01T01:00:00Z", updated_at: "2026-01-01T01:00:00Z", html_url: "https://github.com/octo/example/pull/17#issuecomment-101" },
    { id: 102, user: { login: "me" }, body: "My own note", created_at: "2026-01-01T02:00:00Z", updated_at: "2026-01-01T02:00:00Z" },
  ])}\n${JSON.stringify([
    { id: 103, user: { login: "bob" }, body: "Previously handled", created_at: "2026-01-01T03:00:00Z", updated_at: "2026-01-01T03:00:00Z" },
    { id: 900, user: { login: "me" }, body: "Done.\n<!-- pi-feedback:handled issue-comment:103 -->", created_at: "2026-01-01T04:00:00Z", updated_at: "2026-01-01T04:00:00Z" },
  ])}\n`);
  await writeFile(join(ghData, "review-pages.jsonl"), `${JSON.stringify([
    { id: 201, user: { login: "alice" }, state: "APPROVED", body: "", submitted_at: "2026-01-01T01:00:00Z", html_url: "https://github.com/octo/example/pull/17#pullrequestreview-201" },
    { id: 202, user: { login: "bob" }, state: "CHANGES_REQUESTED", body: "Please cover the edge case.", submitted_at: "2026-01-01T02:00:00Z", html_url: "https://github.com/octo/example/pull/17#pullrequestreview-202" },
  ])}\n`);
  await writeFile(join(ghData, "review-comment-pages.jsonl"), `${JSON.stringify([
    { id: 301, in_reply_to_id: null, user: { login: "alice" }, body: "Handle nil input.", path: "src/parser.go", line: 42, original_line: 42, created_at: "2026-01-01T01:00:00Z", html_url: "https://github.com/octo/example/pull/17#discussion_r301" },
    { id: 401, in_reply_to_id: null, user: { login: "bob" }, body: "Resolved naming note.", path: "src/name.go", line: 9, original_line: 9, created_at: "2026-01-01T01:00:00Z", html_url: "https://github.com/octo/example/pull/17#discussion_r401" },
    { id: 501, in_reply_to_id: null, user: { login: "alice" }, body: "Waiting thread.", path: "src/wait.go", line: 5, original_line: 5, created_at: "2026-01-01T01:00:00Z", html_url: "https://github.com/octo/example/pull/17#discussion_r501" },
  ])}\n${JSON.stringify([
    { id: 302, in_reply_to_id: 301, user: { login: "carol" }, body: "This still reproduces.", path: "src/parser.go", line: 42, original_line: 42, created_at: "2026-01-01T02:00:00Z", html_url: "https://github.com/octo/example/pull/17#discussion_r302" },
    { id: 502, in_reply_to_id: 501, user: { login: "me" }, body: "I am checking this.", path: "src/wait.go", line: 5, original_line: 5, created_at: "2026-01-01T02:00:00Z", html_url: "https://github.com/octo/example/pull/17#discussion_r502" },
  ])}\n`);
  await writeFile(join(ghData, "thread-pages.jsonl"), `${JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [
    { id: "PRRT_301", isResolved: false, isOutdated: false, path: "src/parser.go", line: 42, originalLine: 42, comments: { nodes: [{ databaseId: 301 }] } },
    { id: "PRRT_401", isResolved: true, isOutdated: false, path: "src/name.go", line: 9, originalLine: 9, comments: { nodes: [{ databaseId: 401 }] } },
    { id: "PRRT_501", isResolved: false, isOutdated: false, path: "src/wait.go", line: 5, originalLine: 5, comments: { nodes: [{ databaseId: 501 }] } },
  ] } } } } })}\n`);
  await writeFile(join(ghData, "gh.log"), "");
  await writeFile(join(root, "git.log"), "");

  const ghScript = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_GH_DIR/gh.log"
if [[ "$1 $2" == "auth status" ]]; then exit 0; fi
if [[ "$1 $2" == "repo view" ]]; then cat "$FAKE_GH_DIR/repo.json"; exit 0; fi
if [[ "$1 $2" == "api user" ]]; then printf 'me\\n'; exit 0; fi
if [[ "$1 $2" == "pr view" ]]; then
  head=$("$REAL_GIT" --git-dir="$ORIGIN_REPO" rev-parse refs/heads/feature)
  if [[ -s "$FAKE_GH_DIR/head-override" ]]; then head=$(cat "$FAKE_GH_DIR/head-override"); fi
  jq --arg head "$head" '.headRefOid=$head' "$FAKE_GH_DIR/pr.json"
  exit 0
fi
if [[ "$1" == "api" && " $* " == *" graphql "* ]]; then
  if [[ -e "$FAKE_GH_DIR/graphql-fail" ]]; then echo 'GraphQL unavailable' >&2; exit 1; fi
  cat "$FAKE_GH_DIR/thread-pages.jsonl"
  exit 0
fi
if [[ "$1" == "api" && " $* " == *" --paginate "* ]]; then
  if [[ "$*" == *"/issues/"*"/comments?"* ]]; then cat "$FAKE_GH_DIR/issue-pages.jsonl"; exit 0; fi
  if [[ "$*" == *"/reviews?"* ]]; then cat "$FAKE_GH_DIR/review-pages.jsonl"; exit 0; fi
  if [[ "$*" == *"/pulls/"*"/comments?"* ]]; then cat "$FAKE_GH_DIR/review-comment-pages.jsonl"; exit 0; fi
fi
if [[ "$1 $2" == "api -X" && "$3" == "POST" ]]; then
  endpoint="$4"
  count=$(find "$FAKE_GH_DIR/posts" -type f | wc -l | tr -d ' ')
  body_file="$FAKE_GH_DIR/posts/$((count + 1)).json"
  cat > "$body_file"
  printf '%s\\n' "$endpoint" > "$body_file.endpoint"
  if [[ -s "$FAKE_GH_DIR/fail-once" ]] && [[ "$endpoint" == *"$(cat "$FAKE_GH_DIR/fail-once")"* ]] && [[ ! -e "$FAKE_GH_DIR/failed" ]]; then
    touch "$FAKE_GH_DIR/failed"
    echo 'post failed' >&2
    exit 1
  fi
  printf '{"html_url":"https://github.com/octo/example/pull/17#reply-%s"}\\n' "$((count + 1))"
  exit 0
fi
echo "unexpected gh invocation: $*" >&2
exit 1
`;
  await writeFile(join(fakeBin, "gh"), ghScript);
  await chmod(join(fakeBin, "gh"), 0o755);

  const gitScript = `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "remote" && "\${2:-}" == "get-url" && "\${3:-}" == "origin" ]]; then
  printf 'https://github.com/octo/example.git\\n'
  exit 0
fi
if [[ "\${1:-}" == "push" ]]; then printf '%s\\n' "$*" >> "$GIT_LOG"; fi
exec "$REAL_GIT" "$@"
`;
  await writeFile(join(fakeBin, "git"), gitScript);
  await chmod(join(fakeBin, "git"), 0o755);

  const env = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH}`,
    FAKE_GH_DIR: ghData,
    REAL_GIT: realGit,
    ORIGIN_REPO: origin,
    GIT_LOG: join(root, "git.log"),
    GIT_AUTHOR_NAME: "Test User",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test User",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
  return { root, origin, work, ghData, posts, env };
}

function prepare(fixture, ...args) {
  const result = run("bash", [join(scripts, "prepare-feedback.sh"), ...args], { cwd: fixture.work, env: fixture.env });
  return { result, output: parseOutput(result.stdout) };
}

async function replyManifest(root, head, replies) {
  const path = join(root, `replies-${Math.random().toString(16).slice(2)}.json`);
  await writeJson(path, { version: 1, expected_head: head, replies });
  return path;
}

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
