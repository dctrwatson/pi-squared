import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../..");
const skillDir = join(repoRoot, "skills/create-pr/scripts");
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

function fixtureAt(root) {
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  const fakeBin = join(root, "bin");
  const ghData = join(root, "gh-data");
  const env = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH}`,
    FAKE_GH_DIR: ghData,
    REAL_GIT: realGit,
    GIT_LOG: join(root, "git.log"),
    GIT_AUTHOR_NAME: "Test User",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test User",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
  return { root, origin, work, fakeBin, ghData, env };
}

async function initializeFixture(root) {
  const { origin, work, fakeBin, ghData, env } = fixtureAt(root);
  await mkdir(fakeBin);
  await mkdir(ghData);
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

  await writeJson(join(ghData, "repo.json"), {
    nameWithOwner: "octo/example",
    url: "https://github.com/octo/example",
    defaultBranchRef: { name: "main" },
  });
  await writeJson(join(ghData, "pr-list.json"), []);
  await writeJson(join(ghData, "recent.json"), [{ number: 9, title: "fix: recent", url: "https://github.com/octo/example/pull/9" }]);
  await writeJson(join(ghData, "pr-view.json"), {});
  await writeJson(join(ghData, "issue-view.json"), {
    number: 12,
    title: "Referenced issue",
    url: "https://github.com/octo/example/issues/12",
    state: "OPEN",
    body: "Issue details",
    comments: [],
  });
  await writeFile(join(ghData, "create-output.txt"), "https://github.com/octo/example/pull/44\n");

  const ghScript = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_GH_DIR/gh.log"
if [[ "$1 $2" == "auth status" ]]; then exit 0; fi
if [[ "$1 $2" == "repo view" ]]; then cat "$FAKE_GH_DIR/repo.json"; exit 0; fi
if [[ "$1 $2" == "pr list" ]]; then
  if [[ " $* " == *" --state merged "* ]]; then cat "$FAKE_GH_DIR/recent.json"; else cat "$FAKE_GH_DIR/pr-list.json"; fi
  exit 0
fi
if [[ "$1 $2" == "pr view" ]]; then cat "$FAKE_GH_DIR/pr-view.json"; exit 0; fi
if [[ "$1 $2" == "issue view" ]]; then cat "$FAKE_GH_DIR/issue-view.json"; exit 0; fi
if [[ "$1 $2" == "pr create" ]]; then cat "$FAKE_GH_DIR/create-output.txt"; exit 0; fi
if [[ "$1 $2" == "pr edit" ]]; then exit 0; fi
echo "unexpected gh invocation: $*" >&2
exit 1
`;
  await writeFile(join(fakeBin, "gh"), ghScript);
  await chmod(join(fakeBin, "gh"), 0o755);

  const gitScript = `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "push" ]]; then printf '%s\\n' "$*" >> "$GIT_LOG"; fi
exec "$REAL_GIT" "$@"
`;
  await writeFile(join(fakeBin, "git"), gitScript);
  await chmod(join(fakeBin, "git"), 0o755);

  await writeFile(env.GIT_LOG, "");
  await writeFile(join(ghData, "gh.log"), "");
}

const fixtureTemplate = await mkdtemp(join(tmpdir(), "create-pr-template-"));
await initializeFixture(fixtureTemplate);
test.after(() => rm(fixtureTemplate, { recursive: true, force: true }));

async function createFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "create-pr-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(fixtureTemplate, root, { recursive: true });
  const fixture = fixtureAt(root);
  git(fixture.work, "remote", "set-url", "origin", fixture.origin);
  return fixture;
}

function commitFile(work, path, content, subject) {
  const absolute = join(work, path);
  execFileSync("mkdir", ["-p", resolve(absolute, "..")]);
  execFileSync("bash", ["-c", `printf '%s' "$1" > "$2"`, "_", content, absolute]);
  git(work, "add", path);
  git(work, "commit", "-m", subject);
  return git(work, "rev-parse", "HEAD");
}

function parseOutput(output) {
  return Object.fromEntries(output.trim().split("\n").filter((line) => line.includes("=")).map((line) => {
    const index = line.indexOf("=");
    return [line.slice(0, index), line.slice(index + 1)];
  }));
}

function prepare(fixture, ...args) {
  const result = run("bash", [join(skillDir, "prepare-pr.sh"), ...args], {
    cwd: fixture.work,
    env: fixture.env,
  });
  return { result, output: parseOutput(result.stdout) };
}

async function writePlan(root, state, groups) {
  const plan = join(root, `plan-${Math.random().toString(16).slice(2)}.json`);
  await writeJson(plan, { version: 1, expected_head: JSON.parse(await readFile(state, "utf8")).head, groups });
  return plan;
}

export {
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
  mkdir,
  writeJson,
};
