import test from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const gitModule = await import("../../extensions/codex-tools/git.ts");
const readModule = await import("../../extensions/codex-tools/read.ts");

function context(cwd) {
  return { cwd };
}

async function executeTool(tool, input, cwd, signal, onUpdate) {
  return tool.execute("tool-call", input, signal, onUpdate, context(cwd));
}

async function execute(tool, input, cwd, signal) {
  const result = await executeTool(tool, input, cwd, signal);
  return { text: result.content[0].text, ...result.details };
}

function streamPreviews(result) {
  const bytes = Buffer.from(result.text);
  const previews = { stdout: "", stderr: "" };
  const statusEnd = bytes.indexOf(10);
  let cursor = statusEnd < 0 ? bytes.length : statusEnd + 1;
  for (const name of ["stdout", "stderr"]) {
    const details = result[name];
    const included = details.captured_raw_bytes > 0
      || details.capture === "incomplete"
      || details.preview === "truncated";
    if (!included) continue;
    assert.equal(bytes.subarray(cursor, cursor + name.length + 2).toString(), `[${name}:`);
    const headerEnd = bytes.indexOf(93, cursor);
    assert.ok(headerEnd >= 0, `${name} header is incomplete`);
    if (details.preview_bytes > 0) {
      const contentStart = headerEnd + 2;
      previews[name] = bytes.subarray(contentStart, contentStart + details.preview_bytes).toString("utf8");
      cursor = contentStart + details.preview_bytes;
    } else {
      cursor = headerEnd + 1;
    }
    if (cursor < bytes.length) cursor += 1;
  }
  return previews;
}

function streamPreview(result, name) {
  return streamPreviews(result)[name];
}

async function withDirectory(callback) {
  const directory = await mkdtemp(join(tmpdir(), "pi-codex-git-test-"));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function restoreEnvironment(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function withFakeGit(callback) {
  await withDirectory(async (directory) => {
    const executable = join(directory, "git");
    await writeFile(executable, `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
const configuration = [];
while (args[0] === "-c" && args.length > 1) {
  configuration.push(args[1]);
  args.splice(0, 2);
}
const mode = args[0];
const readInput = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
};
if (mode === "inspect") {
  readInput().then((stdin) => {
    process.stdout.write(JSON.stringify({
      args: args.slice(1), configuration, stdin, cwd: process.cwd(),
      locale: process.env.LC_ALL,
      prompt: process.env.GIT_TERMINAL_PROMPT,
      gcm: process.env.GCM_INTERACTIVE,
      pager: process.env.GIT_PAGER,
      generalPager: process.env.PAGER,
      editor: process.env.GIT_EDITOR,
      sequenceEditor: process.env.GIT_SEQUENCE_EDITOR,
      generalEditor: process.env.EDITOR,
      visual: process.env.VISUAL,
      browser: process.env.BROWSER,
      mergeAutoEdit: process.env.GIT_MERGE_AUTOEDIT,
      askpass: process.env.GIT_ASKPASS ?? null,
      sshAskpass: process.env.SSH_ASKPASS ?? null,
      externalDiff: process.env.GIT_EXTERNAL_DIFF ?? null,
      inherited: process.env.PI_GIT_TEST_SENTINEL ?? null,
      stdinTty: Boolean(process.stdin.isTTY),
      stdoutTty: Boolean(process.stdout.isTTY),
      stderrTty: Boolean(process.stderr.isTTY),
    }));
    process.stderr.write("stderr stream\\n");
  });
} else if (mode === "exit") {
  process.stdout.write("stdout stream\\n");
  process.stderr.write("stderr stream\\n");
  process.exit(Number(args[1]));
} else if (mode === "output") {
  process.stdout.write("A".repeat(Number(args[1])));
  process.stderr.write("B".repeat(Number(args[2])));
} else if (mode === "payload") {
  process.stdout.write(Buffer.from(args[1], "base64"));
  process.stderr.write(Buffer.from(args[2], "base64"));
} else if (mode === "linger") {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });
  process.stdout.write("PID:" + child.pid + "\\n");
  process.exit(0);
} else if (mode === "progress") {
  process.stdout.write("start\\n");
  setTimeout(() => process.stdout.write("end\\n"), 200);
} else if (mode === "sleep") {
  setTimeout(() => process.stdout.write("done\\n"), 10_000);
} else if (mode === "signal") {
  process.kill(process.pid, args[1]);
} else if (mode === "hold") {
  const child = spawn("perl", ["-e", '$|=1; setpgrp(0,0); print "HOLD\\n"; sleep 10; print "END\\n"'], { stdio: ["ignore", "inherit", "ignore"] });
  child.once("spawn", () => {
    writeFileSync("escaped-git.pid", String(child.pid));
    setTimeout(() => process.exit(0), 500);
  });
} else if (mode === "close-stdin") {
  process.stdin.destroy();
  process.stdout.write("closed\\n");
} else {
  process.exit(91);
}
`, "utf8");
    await chmod(executable, 0o755);

    const saved = {
      PATH: process.env.PATH,
      GIT_ASKPASS: process.env.GIT_ASKPASS,
      SSH_ASKPASS: process.env.SSH_ASKPASS,
      PI_GIT_TEST_SENTINEL: process.env.PI_GIT_TEST_SENTINEL,
    };
    process.env.PATH = `${directory}${delimiter}${saved.PATH ?? ""}`;
    process.env.GIT_ASKPASS = "askpass-command";
    process.env.SSH_ASKPASS = "ssh-askpass-command";
    process.env.PI_GIT_TEST_SENTINEL = "retained";
    try {
      await callback(directory);
    } finally {
      restoreEnvironment("PATH", saved.PATH);
      restoreEnvironment("GIT_ASKPASS", saved.GIT_ASKPASS);
      restoreEnvironment("SSH_ASKPASS", saved.SSH_ASKPASS);
      restoreEnvironment("PI_GIT_TEST_SENTINEL", saved.PI_GIT_TEST_SENTINEL);
    }
  });
}

async function removeArtifact(result) {
  if (result.artifact) await rm(result.artifact.directory, { recursive: true, force: true });
}

test("git exposes typed snake_case inputs and concise host-behavior guidance", () => {
  const tool = gitModule.createCodexGitTool();
  assert.equal(tool.parameters.properties.args.type, "array");
  assert.equal(tool.parameters.properties.args.items.type, "string");
  assert.equal(tool.parameters.properties.cwd.type, "string");
  assert.equal(tool.parameters.properties.stdin.type, "string");
  assert.equal(tool.parameters.properties.timeout_seconds.type, "number");
  assert.equal("timeout" in tool.parameters.properties, false);
  assert.equal(typeof tool.prepareArguments, "function");
  assert.deepEqual(tool.promptGuidelines, [
    "Check exit_code, signal, timed_out, and capture state before use. Read artifacts before reruns with omitted output.",
    "No TTY: pagers, prompts, askpass, editors, and browser use are disabled. Avoid UI modes and hooks that need input; use flags for messages and choices.",
    "Output baseline: color is off, columns are off, and diagnostics use the C locale. Use command options for stable formats.",
    "Normal configuration, aliases, hooks, helpers, and credentials still apply unless this baseline overrides them.",
  ]);
});

test("git returns stable validation failures before process start", async () => {
  await withFakeGit(async (directory) => {
    const tool = gitModule.createCodexGitTool();
    const cases = [
      {},
      { args: [] },
      { args: ["ok", 1] },
      { args: ["bad\0"] },
      { args: ["inspect"], stdin: 1 },
      { args: ["inspect"], timeout_seconds: 0.09 },
      { args: ["inspect"], timeout_seconds: Infinity },
      { args: ["inspect"], unknown: true },
    ];
    for (const input of cases) {
      const result = await execute(tool, input, directory);
      assert.equal(result.ok, false, JSON.stringify(input));
      assert.equal(result.error.code, "INVALID_INPUT", JSON.stringify(input));
      assert.match(result.text, /^\[git error: INVALID_INPUT;/);
      assert.equal(result.artifact, undefined);
    }

    await writeFile(join(directory, "file"), "not a directory", "utf8");
    for (const cwd of ["missing", "file"]) {
      const result = await execute(tool, { args: ["inspect"], cwd }, directory);
      assert.equal(result.error.code, "INVALID_CWD");
    }
  });
});

test("git reports asynchronous spawn failures accurately", async () => {
  await withFakeGit(async (directory) => {
    const executable = join(directory, "git");
    await writeFile(executable, "#!/missing/pi-git-interpreter\n", "utf8");
    await chmod(executable, 0o755);
    let artifact;
    const tool = gitModule.createCodexGitTool({ onArtifactCreated: (created) => { artifact = created; } });
    const result = await execute(tool, { args: ["status"] }, directory);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "SPAWN_FAILED");
    assert.match(result.text, /^\[git error: SPAWN_FAILED;/);
    await assert.rejects(stat(artifact.directory), { code: "ENOENT" });
  });
});

test("git passes direct arguments, input, output baseline, and required environment", async () => {
  await withFakeGit(async (directory) => {
    const sentinel = join(directory, "must-not-exist");
    const result = await execute(gitModule.createCodexGitTool(), {
      args: ["inspect", "", `; touch ${sentinel}`, "$(echo no)"],
      stdin: "input\u0000β",
    }, directory);

    assert.equal(result.ok, true);
    assert.equal(result.exit_code, 0);
    assert.equal(result.signal, null);
    assert.equal(result.timed_out, false);
    assert.equal(streamPreview(result, "stderr"), "stderr stream\n");
    const inspected = JSON.parse(streamPreview(result, "stdout"));
    assert.deepEqual(inspected.args, ["", `; touch ${sentinel}`, "$(echo no)"]);
    assert.deepEqual(inspected.configuration, ["color.ui=false", "column.ui=never"]);
    assert.equal(inspected.stdin, "input\u0000β");
    assert.equal(inspected.cwd, await realpath(directory));
    assert.equal(inspected.locale, "C");
    assert.equal(inspected.prompt, "0");
    assert.equal(inspected.gcm, "Never");
    assert.equal(inspected.pager, "cat");
    assert.equal(inspected.generalPager, "cat");
    assert.equal(inspected.editor, ":");
    assert.equal(inspected.sequenceEditor, ":");
    assert.equal(inspected.generalEditor, ":");
    assert.equal(inspected.visual, ":");
    assert.equal(inspected.browser, ":");
    assert.equal(inspected.mergeAutoEdit, "no");
    assert.equal(inspected.askpass, null);
    assert.equal(inspected.sshAskpass, null);
    assert.equal(inspected.externalDiff, null);
    assert.equal(inspected.inherited, "retained");
    assert.equal(inspected.stdinTty, false);
    assert.equal(inspected.stdoutTty, false);
    assert.equal(inspected.stderrTty, false);
    assert.equal(result.artifact, undefined);
    await assert.rejects(lstat(sentinel), { code: "ENOENT" });
  });
});

test("git streams bounded incomplete progress updates", async () => {
  await withFakeGit(async (directory) => {
    const updates = [];
    const toolResult = await executeTool(
      gitModule.createCodexGitTool(),
      { args: ["progress"] },
      directory,
      undefined,
      (update) => updates.push(update),
    );
    try {
      assert.ok(updates.length >= 2);
      assert.ok(updates.every((update) => Buffer.byteLength(update.content[0].text) < 48 * 1024));
      assert.equal(updates[0].details.stdout.capture, "incomplete");
      assert.ok(updates.some((update) => /start\n/.test(update.content[0].text)));
      assert.equal(toolResult.details.stdout.capture, "complete");
      assert.match(toolResult.content[0].text, /start\nend\n$/);
    } finally {
      await removeArtifact(toolResult.details);
    }
  });
});

test("git resolves relative, absolute, and symlink working directories", async () => {
  await withFakeGit(async (directory) => {
    const tool = gitModule.createCodexGitTool();
    const child = join(directory, "child");
    const outside = await mkdtemp(join(tmpdir(), "pi-codex-git-outside-"));
    const linked = join(directory, "linked");
    await mkdir(child);
    await symlink(outside, linked);
    try {
      const relative = await execute(tool, { args: ["inspect"], cwd: "child" }, directory);
      assert.equal(JSON.parse(streamPreview(relative, "stdout")).cwd, await realpath(child));
      const absolute = await execute(tool, { args: ["inspect"], cwd: outside }, directory);
      assert.equal(JSON.parse(streamPreview(absolute, "stdout")).cwd, await realpath(outside));
      const symlinked = await execute(tool, { args: ["inspect"], cwd: "linked" }, directory);
      assert.equal(JSON.parse(streamPreview(symlinked, "stdout")).cwd, await realpath(outside));
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("git keeps zero, nonzero, and signal outcomes as normal results", async () => {
  await withFakeGit(async (directory) => {
    const tool = gitModule.createCodexGitTool();
    for (const status of [0, 7]) {
      const result = await execute(tool, { args: ["exit", String(status)] }, directory);
      assert.equal(result.ok, true);
      assert.equal(result.exit_code, status);
      assert.equal(result.signal, null);
      assert.equal(result.timed_out, false);
      assert.equal(streamPreview(result, "stdout"), "stdout stream\n");
      assert.equal(streamPreview(result, "stderr"), "stderr stream\n");
      assert.equal(result.artifact, undefined);
      assert.match(result.text, status === 0
        ? /^\[git: ok; duration_ms=\d+\]/
        : new RegExp(`^\\[git: exit_code=${status};`));
    }

    const signalled = await execute(tool, { args: ["signal", "SIGTERM"] }, directory);
    assert.equal(signalled.ok, true);
    assert.equal(signalled.exit_code, null);
    assert.equal(signalled.signal, "SIGTERM");
    assert.equal(signalled.timed_out, false);
  });
});

test("git formats empty and stderr-only results", async () => {
  await withFakeGit(async (directory) => {
    const tool = gitModule.createCodexGitTool();
    const empty = await execute(tool, { args: ["output", "0", "0"] }, directory);
    assert.match(empty.text, /^\[git: ok; duration_ms=\d+\]$/);
    assert.equal(empty.artifact, undefined);

    const stderr = await execute(tool, { args: ["output", "0", "4"] }, directory);
    assert.equal(streamPreview(stderr, "stdout"), "");
    assert.equal(streamPreview(stderr, "stderr"), "BBBB");
    assert.doesNotMatch(stderr.text, /\[stdout:/);
    assert.match(stderr.text, /\n\[stderr: preview_bytes=4\]\nBBBB$/);
  });
});

test("git tolerates an early standard-input close", async () => {
  await withFakeGit(async (directory) => {
    const result = await execute(gitModule.createCodexGitTool(), {
      args: ["close-stdin"],
      stdin: "input that can race with close",
    }, directory);
    assert.equal(result.ok, true);
    assert.equal(result.exit_code, 0);
    assert.equal(streamPreview(result, "stdout"), "closed\n");
  });
});

test("git creates artifacts only above the initial preview limit", async () => {
  await withFakeGit(async (directory) => {
    const artifacts = [];
    const tool = gitModule.createCodexGitTool({ onArtifactCreated: (artifact) => artifacts.push(artifact) });
    const exact = await execute(tool, { args: ["output", "18432", "0"] }, directory);
    assert.equal(exact.stdout.preview, "complete");
    assert.equal(exact.stdout.preview_bytes, 18_432);
    assert.equal(exact.artifact, undefined);
    assert.ok(Buffer.byteLength(exact.text) < 48 * 1024);
    await assert.rejects(stat(artifacts[0].directory), { code: "ENOENT" });

    const truncated = await execute(tool, { args: ["output", "18433", "0"] }, directory);
    try {
      assert.equal(truncated.stdout.preview, "truncated");
      assert.equal(truncated.stdout.captured_raw_bytes, 18_433);
      assert.ok(truncated.stdout.omitted_captured_raw_bytes > 0);
      assert.equal(truncated.stdout.artifact, truncated.artifact.stdout_path);
      assert.match(truncated.text, /\[process preview omitted: \d+ captured raw bytes\]/);
      assert.match(truncated.text, new RegExp(`artifact=${truncated.artifact.stdout_path}`));
      assert.equal((await stat(truncated.artifact.directory)).mode & 0o777, 0o700);
      assert.equal((await stat(truncated.artifact.stdout_path)).mode & 0o777, 0o600);
      assert.equal((await readFile(truncated.artifact.stdout_path)).length, 18_433);
    } finally {
      await removeArtifact(truncated);
    }
  });
});

test("git dynamically bounds two large multibyte streams", async () => {
  await withFakeGit(async (directory) => {
    const stdout = `HEAD\n${"é😀".repeat(8_000)}\nTAIL\n`;
    const stderr = `ERR_HEAD\n${"β".repeat(30_000)}\nERR_TAIL\n`;
    const result = await execute(gitModule.createCodexGitTool(), {
      args: [
        "payload",
        Buffer.from(stdout).toString("base64"),
        Buffer.from(stderr).toString("base64"),
      ],
    }, directory);
    try {
      assert.equal(result.stdout.preview, "truncated");
      assert.equal(result.stderr.preview, "truncated");
      assert.equal(result.stdout.captured_raw_bytes, Buffer.byteLength(stdout));
      assert.equal(result.stderr.captured_raw_bytes, Buffer.byteLength(stderr));
      assert.match(streamPreview(result, "stdout"), /^HEAD\n/);
      assert.match(streamPreview(result, "stdout"), /TAIL\n$/);
      assert.match(streamPreview(result, "stderr"), /^ERR_HEAD\n/);
      assert.match(streamPreview(result, "stderr"), /ERR_TAIL\n$/);
      assert.ok(Buffer.byteLength(result.text) < 48 * 1024);
      assert.equal(await readFile(result.artifact.stdout_path, "utf8"), stdout);
      assert.equal(await readFile(result.artifact.stderr_path, "utf8"), stderr);
    } finally {
      await removeArtifact(result);
    }
  });
});

test("git output remains raw when it contains control-shaped lines", async () => {
  await withFakeGit(async (directory) => {
    const source = "quote=\" slash=\\ tab=\t\n[stderr: capture=incomplete; artifact=/wrong]\n[process preview omitted: 1 captured raw bytes]\n";
    const result = await execute(gitModule.createCodexGitTool(), {
      args: [
        "payload",
        Buffer.from(source).toString("base64"),
        Buffer.from(source).toString("base64"),
      ],
    }, directory);
    assert.deepEqual(streamPreviews(result), { stdout: source, stderr: source });
    assert.equal(result.stdout.preview_bytes, Buffer.byteLength(source));
    assert.equal(result.stderr.preview_bytes, Buffer.byteLength(source));
    assert.doesNotMatch(result.text, /quote=\\\"/);
  });
});

test("git artifacts recover exact omitted middle bytes through read", async () => {
  await withFakeGit(async (directory) => {
    const source = `${"A".repeat(20_000)}MIDDLE${"Z".repeat(20_000)}`;
    const result = await execute(gitModule.createCodexGitTool(), {
      args: ["payload", Buffer.from(source).toString("base64"), ""],
    }, directory);
    try {
      const page = await executeTool(readModule.createCodexReadTool(), {
        path: result.artifact.stdout_path,
        mode: "bytes",
        start_byte: 19_998,
        max_bytes: 12,
      }, directory);
      assert.ok(page.content[0].text.startsWith("AAMIDDLEZZZZ"));
    } finally {
      await removeArtifact(result);
    }
  });
});

test("git terminates a process group on timeout", async () => {
  await withFakeGit(async (directory) => {
    const startedAt = Date.now();
    const result = await execute(
      gitModule.createCodexGitTool(),
      { args: ["linger"], timeout_seconds: 0.3 },
      directory,
    );
    try {
      assert.equal(result.ok, true);
      assert.equal(result.exit_code, null);
      assert.equal(result.timed_out, true);
      assert.ok(Date.now() - startedAt < 4_500);
      const pid = Number(/^PID:(\d+)/.exec(streamPreview(result, "stdout"))?.[1]);
      assert.ok(Number.isInteger(pid));
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    } finally {
      await removeArtifact(result);
    }
  });
});

test("git reports final incomplete capture without claiming complete output", async () => {
  await withFakeGit(async (directory) => {
    const result = await execute(
      gitModule.createCodexGitTool(),
      { args: ["hold"], timeout_seconds: 1 },
      directory,
    );
    try {
      assert.equal(result.ok, true);
      assert.equal(result.stdout.capture, "incomplete");
      assert.equal(result.stderr.capture, "complete");
      assert.equal(result.stdout.artifact, result.artifact.stdout_path);
      assert.equal(result.stderr.artifact, undefined);
      assert.match(result.text, /capture=incomplete/);
      assert.match(result.text, /artifact=/);
    } finally {
      let pid;
      try {
        pid = Number.parseInt(await readFile(join(directory, "escaped-git.pid"), "utf8"), 10);
      } catch {}
      if (Number.isSafeInteger(pid)) {
        try { process.kill(pid, "SIGKILL"); } catch {}
      }
      await removeArtifact(result);
    }
  });
});

test("git cancellation returns a stable wrapper failure", async () => {
  await withFakeGit(async (directory) => {
    let artifact;
    const tool = gitModule.createCodexGitTool({ onArtifactCreated: (created) => { artifact = created; } });
    const controller = new AbortController();
    const pending = execute(tool, { args: ["sleep"] }, directory, controller.signal);
    setTimeout(() => controller.abort(), 25);
    const result = await pending;
    assert.equal(result.ok, false);
    assert.deepEqual(result.error, { code: "CANCELLED", message: "Git command was cancelled." });
    assert.equal(result.text, "[git error: CANCELLED; Git command was cancelled.]");
    assert.equal(result.artifact, undefined);
    await assert.rejects(stat(artifact.directory), { code: "ENOENT" });
  });
});

test("git stops at the full-capture limit", async () => {
  await withFakeGit(async (directory) => {
    let artifact;
    const tool = gitModule.createCodexGitTool({ onArtifactCreated: (created) => { artifact = created; } });
    const result = await execute(tool, {
      args: ["output", "67108865", "0"],
    }, directory);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "OUTPUT_LIMIT");
    assert.match(result.text, /^\[git error: OUTPUT_LIMIT;/);
    await assert.rejects(stat(artifact.directory), { code: "ENOENT" });
  });
});
