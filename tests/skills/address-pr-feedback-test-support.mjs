import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

function fixtureAt(root) {
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  const fakeBin = join(root, "bin");
  const ghData = join(root, "gh-data");
  const posts = join(ghData, "posts");
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

async function initializeFixture(root) {
  const { origin, work, ghData, posts } = fixtureAt(root);
  const fakeBin = join(root, "bin");
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

}

const fixtureTemplate = await mkdtemp(join(tmpdir(), "address-feedback-template-"));
await initializeFixture(fixtureTemplate);
test.after(() => rm(fixtureTemplate, { recursive: true, force: true }));

async function createFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "address-feedback-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(fixtureTemplate, root, { recursive: true });
  const fixture = fixtureAt(root);
  git(fixture.work, "remote", "set-url", "origin", fixture.origin);
  return fixture;
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

export {
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
  commitFile,
  parseOutput,
  readdir,
  replyManifest,
};
