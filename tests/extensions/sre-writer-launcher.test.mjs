import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const wrapperSource = fileURLToPath(new URL("../../bin/pi-sre-writer", import.meta.url));
const promptSource = fileURLToPath(new URL("../../system-prompts/sre-writer.md", import.meta.url));

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-sre-writer-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = join(root, "installed package");
  const fakeBin = join(root, "fake bin");
  const cwd = join(root, "document directory");
  await Promise.all([
    mkdir(join(packageRoot, "bin"), { recursive: true }),
    mkdir(join(packageRoot, "system-prompts"), { recursive: true }),
    mkdir(fakeBin),
    mkdir(cwd),
  ]);
  const wrapper = join(packageRoot, "bin", "pi-sre-writer");
  const prompt = join(packageRoot, "system-prompts", "sre-writer.md");
  assert.ok((await stat(wrapperSource)).mode & 0o111, "the wrapper must be executable");
  await copyFile(wrapperSource, wrapper);
  await chmod(wrapper, 0o755);
  await copyFile(promptSource, prompt);
  const fakePi = join(fakeBin, "pi");
  await writeFile(fakePi, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\0' "$$" "$PWD" "$@"
printf '%s' "\${PI_WRITER_TEST_STDERR:-}" >&2
exit "\${PI_WRITER_TEST_STATUS:-0}"
`);
  await chmod(fakePi, 0o755);
  return { root, wrapper, prompt, cwd, fakeBin };
}

function launch(f, command = f.wrapper, args = [], overrides = {}) {
  const result = spawnSync(command, args, {
    cwd: f.cwd,
    env: {
      ...process.env,
      PATH: `${f.fakeBin}${delimiter}${process.env.PATH ?? ""}`,
      PI_WRITER_TEST_STDERR: "",
      PI_WRITER_TEST_STATUS: "0",
      ...overrides,
    },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  const [pid, cwd, contextFilesFlag, flag, prompt, ...forwarded] = result.stdout.split("\0").slice(0, -1);
  assert.equal(Number(pid), result.pid, "the wrapper must replace itself with Pi");
  assert.equal(cwd, f.cwd);
  assert.equal(contextFilesFlag, "--no-context-files");
  assert.equal(flag, "--system-prompt");
  assert.equal(resolve(prompt), f.prompt);
  assert.deepEqual(forwarded, args);
  return result;
}

test("pi-sre-writer launches its bundled prompt without changing directory", async (t) => {
  const f = await fixture(t);
  assert.equal(launch(f).status, 0);
});

test("pi-sre-writer preserves Pi options and prompt arguments", async (t) => {
  const f = await fixture(t);
  const args = ["--model", "test model", "@draft with spaces.md", "Write a draft.\nKeep it short.", "", "--", "-literal"];
  assert.equal(launch(f, f.wrapper, args).status, 0);
});

test("pi-sre-writer resolves absolute and relative symlink targets", async (t) => {
  const f = await fixture(t);
  const linkDirectory = join(f.root, "command links");
  await mkdir(linkDirectory);
  const relativeLink = join(linkDirectory, "writer");
  await symlink(relative(linkDirectory, f.wrapper), relativeLink);
  const absoluteLink = join(f.root, "pi-sre-writer");
  await symlink(relativeLink, absoluteLink);
  assert.equal(launch(f, absoluteLink, ["--print", "Review this runbook."]).status, 0);
});

test("pi-sre-writer preserves Pi exit status and stderr", async (t) => {
  const f = await fixture(t);
  const result = launch(f, f.wrapper, [], {
    PI_WRITER_TEST_STATUS: "23",
    PI_WRITER_TEST_STDERR: "test Pi failure\n",
  });
  assert.equal(result.status, 23);
  assert.equal(result.stderr, "test Pi failure\n");
});

test("npm manifests register pi-sre-writer", async () => {
  const manifest = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(await readFile(new URL("../../package-lock.json", import.meta.url), "utf8"));
  assert.equal(manifest.bin["pi-sre-writer"], "./bin/pi-sre-writer");
  assert.equal(lock.packages[""].bin["pi-sre-writer"], "bin/pi-sre-writer");
});
