import test from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const ghModule = await import("../../extensions/codex-tools/gh.ts");
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
  const directory = await mkdtemp(join(tmpdir(), "pi-codex-gh-test-"));
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

async function withFakeGh(callback, executableSource) {
  await withDirectory(async (directory) => {
    const executable = join(directory, "gh");
    await writeFile(executable, executableSource ?? `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
const mode = args[0];
const readInput = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
};
if (mode === "inspect") {
  readInput().then((stdin) => {
    process.stdout.write(JSON.stringify({
      args: args.slice(1), stdin, cwd: process.cwd(),
      prompt: process.env.GH_PROMPT_DISABLED,
      pager: process.env.GH_PAGER,
      generalPager: process.env.PAGER,
      editor: process.env.GH_EDITOR,
      generalEditor: process.env.EDITOR,
      visual: process.env.VISUAL,
      browser: process.env.GH_BROWSER,
      generalBrowser: process.env.BROWSER,
      forceTty: process.env.GH_FORCE_TTY ?? null,
      token: process.env.GH_TOKEN ?? null,
      configDir: process.env.GH_CONFIG_DIR ?? null,
      config: process.env.GH_CONFIG_DIR && existsSync(process.env.GH_CONFIG_DIR + "/config.yml")
        ? readFileSync(process.env.GH_CONFIG_DIR + "/config.yml", "utf8")
        : null,
      extensionAvailable: Boolean(process.env.GH_CONFIG_DIR && existsSync(process.env.GH_CONFIG_DIR + "/extensions/gh-demo/gh-demo")),
      inherited: process.env.PI_GH_TEST_SENTINEL ?? null,
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
} else if (mode === "auth") {
  process.stderr.write("authentication failed\\n");
  process.exit(4);
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
    writeFileSync("escaped-gh.pid", String(child.pid));
    setTimeout(() => process.exit(0), 500);
  });
} else if (mode === "close-stdin") {
  process.stdin.destroy();
  process.stdout.write("closed\\n");
} else if (mode === "touch") {
  writeFileSync("process-started", "yes");
} else {
  process.exit(91);
}
`, "utf8");
    await chmod(executable, 0o755);
    const configDirectory = join(directory, "gh-config");
    const extensionDirectory = join(configDirectory, "extensions", "gh-demo");
    await mkdir(extensionDirectory, { recursive: true });
    await writeFile(join(configDirectory, "config.yml"), "aliases:\n  mine: issue list\n", "utf8");
    await writeFile(join(extensionDirectory, "gh-demo"), "extension", "utf8");

    const saved = {
      PATH: process.env.PATH,
      GH_FORCE_TTY: process.env.GH_FORCE_TTY,
      GH_TOKEN: process.env.GH_TOKEN,
      GH_CONFIG_DIR: process.env.GH_CONFIG_DIR,
      PI_GH_TEST_SENTINEL: process.env.PI_GH_TEST_SENTINEL,
    };
    process.env.PATH = `${directory}${delimiter}${saved.PATH ?? ""}`;
    process.env.GH_FORCE_TTY = "100";
    process.env.GH_TOKEN = "retained-token";
    process.env.GH_CONFIG_DIR = configDirectory;
    process.env.PI_GH_TEST_SENTINEL = "retained";
    try {
      await callback(directory);
    } finally {
      restoreEnvironment("PATH", saved.PATH);
      restoreEnvironment("GH_FORCE_TTY", saved.GH_FORCE_TTY);
      restoreEnvironment("GH_TOKEN", saved.GH_TOKEN);
      restoreEnvironment("GH_CONFIG_DIR", saved.GH_CONFIG_DIR);
      restoreEnvironment("PI_GH_TEST_SENTINEL", saved.PI_GH_TEST_SENTINEL);
    }
  });
}

async function removeArtifact(result) {
  if (result.artifact) await rm(result.artifact.directory, { recursive: true, force: true });
}

test("gh exposes typed snake_case inputs and host-behavior guidance", () => {
  const tool = ghModule.createCodexGhTool();
  assert.equal(tool.parameters.properties.args.type, "array");
  assert.equal(tool.parameters.properties.args.items.type, "string");
  assert.equal(tool.parameters.properties.cwd.type, "string");
  assert.equal(tool.parameters.properties.stdin.type, "string");
  assert.equal(tool.parameters.properties.timeout_seconds.type, "number");
  assert.equal("timeout" in tool.parameters.properties, false);
  assert.equal(typeof tool.prepareArguments, "function");
  assert.deepEqual(tool.promptGuidelines, [
    "Check exit_code, signal, timed_out, and capture state before use. Read artifacts before reruns with omitted output.",
    "No TTY: pager=cat; prompts, editors, and browser are disabled. Avoid auth login, browse, --web, --editor, and incomplete create commands; use arguments or stdin.",
    "Authentication failures are normal nonzero results. Normal aliases, extensions, configuration, and credentials apply.",
  ]);
});

test("gh returns stable validation and asynchronous spawn failures", async () => {
  await withFakeGh(async (directory) => {
    const tool = ghModule.createCodexGhTool();
    for (const input of [
      {}, { args: [] }, { args: ["ok", 1] }, { args: ["bad\0"] },
      { args: ["inspect"], stdin: 1 }, { args: ["inspect"], timeout_seconds: 0.09 },
      { args: ["inspect"], timeout_seconds: Infinity }, { args: ["inspect"], unknown: true },
    ]) {
      const result = await execute(tool, input, directory);
      assert.equal(result.error.code, "INVALID_INPUT", JSON.stringify(input));
      assert.match(result.text, /^\[gh error: INVALID_INPUT;/);
    }

    await writeFile(join(directory, "file"), "not a directory", "utf8");
    for (const cwd of ["missing", "file"]) {
      const result = await execute(tool, { args: ["inspect"], cwd }, directory);
      assert.equal(result.error.code, "INVALID_CWD");
    }

    let artifact;
    const observed = ghModule.createCodexGhTool({ onArtifactCreated: (created) => { artifact = created; } });
    await writeFile(join(directory, "gh"), "#!/missing/pi-gh-interpreter\n", "utf8");
    await chmod(join(directory, "gh"), 0o755);
    const spawnFailure = await execute(observed, { args: ["status"] }, directory);
    assert.equal(spawnFailure.error.code, "SPAWN_FAILED");
    await assert.rejects(stat(artifact.directory), { code: "ENOENT" });
  });
});

test("gh passes direct arguments, input, credentials, and environment", async () => {
  await withFakeGh(async (directory) => {
    const sentinel = join(directory, "must-not-exist");
    const result = await execute(ghModule.createCodexGhTool(), {
      args: ["inspect", "", `; touch ${sentinel}`, "$(echo no)"],
      stdin: "input\u0000β",
    }, directory);

    const inspected = JSON.parse(streamPreview(result, "stdout"));
    assert.deepEqual(inspected.args, ["", `; touch ${sentinel}`, "$(echo no)"]);
    assert.equal(inspected.stdin, "input\u0000β");
    assert.equal(inspected.cwd, await realpath(directory));
    assert.equal(inspected.prompt, "1");
    assert.equal(inspected.pager, "cat");
    assert.equal(inspected.generalPager, "cat");
    assert.equal(inspected.editor, ":");
    assert.equal(inspected.generalEditor, ":");
    assert.equal(inspected.visual, ":");
    assert.equal(inspected.browser, ":");
    assert.equal(inspected.generalBrowser, ":");
    assert.equal(inspected.forceTty, null);
    assert.equal(inspected.token, "retained-token");
    assert.equal(inspected.configDir, join(directory, "gh-config"));
    assert.match(inspected.config, /mine: issue list/);
    assert.equal(inspected.extensionAvailable, true);
    assert.equal(inspected.inherited, "retained");
    assert.equal(inspected.stdinTty, false);
    assert.equal(inspected.stdoutTty, false);
    assert.equal(inspected.stderrTty, false);
    assert.equal(streamPreview(result, "stderr"), "stderr stream\n");
    assert.equal(result.artifact, undefined);
    await assert.rejects(lstat(sentinel), { code: "ENOENT" });
  });
});

test("gh streams bounded incomplete progress updates", async () => {
  await withFakeGh(async (directory) => {
    const updates = [];
    const toolResult = await executeTool(
      ghModule.createCodexGhTool(),
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

test("gh resolves relative, absolute, and symlink working directories", async () => {
  await withFakeGh(async (directory) => {
    const tool = ghModule.createCodexGhTool();
    const child = join(directory, "child");
    const outside = await mkdtemp(join(tmpdir(), "pi-codex-gh-outside-"));
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

test("gh keeps zero, nonzero, authentication, and signal outcomes normal", async () => {
  await withFakeGh(async (directory) => {
    const tool = ghModule.createCodexGhTool();
    for (const status of [0, 7]) {
      const result = await execute(tool, { args: ["exit", String(status)] }, directory);
      assert.equal(result.ok, true);
      assert.equal(result.exit_code, status);
      assert.equal(streamPreview(result, "stdout"), "stdout stream\n");
      assert.equal(streamPreview(result, "stderr"), "stderr stream\n");
      assert.equal(result.artifact, undefined);
    }

    const auth = await execute(tool, { args: ["auth"] }, directory);
    assert.equal(auth.ok, true);
    assert.equal(auth.exit_code, 4);
    assert.equal(streamPreview(auth, "stderr"), "authentication failed\n");

    const signalled = await execute(tool, { args: ["signal", "SIGTERM"] }, directory);
    assert.equal(signalled.ok, true);
    assert.equal(signalled.exit_code, null);
    assert.equal(signalled.signal, "SIGTERM");
  });
});

test("gh formats empty, stderr-only, and early-input-close results", async () => {
  await withFakeGh(async (directory) => {
    const tool = ghModule.createCodexGhTool();
    const empty = await execute(tool, { args: ["output", "0", "0"] }, directory);
    assert.match(empty.text, /^\[gh: ok; duration_ms=\d+\]$/);

    const stderr = await execute(tool, { args: ["output", "0", "4"] }, directory);
    assert.equal(streamPreview(stderr, "stderr"), "BBBB");
    assert.doesNotMatch(stderr.text, /\[stdout:/);

    const closed = await execute(tool, { args: ["close-stdin"], stdin: "racing input" }, directory);
    assert.equal(closed.ok, true);
    assert.equal(streamPreview(closed, "stdout"), "closed\n");
  });
});

test("gh creates and deletes artifacts at the preview boundary", async () => {
  await withFakeGh(async (directory) => {
    const artifacts = [];
    const tool = ghModule.createCodexGhTool({ onArtifactCreated: (artifact) => artifacts.push(artifact) });
    const exact = await execute(tool, { args: ["output", "18432", "0"] }, directory);
    assert.equal(exact.stdout.preview, "complete");
    assert.equal(exact.artifact, undefined);
    await assert.rejects(stat(artifacts[0].directory), { code: "ENOENT" });

    const truncated = await execute(tool, { args: ["output", "18433", "0"] }, directory);
    try {
      assert.equal(truncated.stdout.preview, "truncated");
      assert.equal(truncated.stdout.artifact, truncated.artifact.stdout_path);
      assert.match(truncated.text, /\[process preview omitted: \d+ captured raw bytes\]/);
      assert.equal((await stat(truncated.artifact.directory)).mode & 0o777, 0o700);
      assert.equal((await stat(truncated.artifact.stdout_path)).mode & 0o777, 0o600);
      assert.equal((await readFile(truncated.artifact.stdout_path)).length, 18_433);
    } finally {
      await removeArtifact(truncated);
    }
  });
});

test("gh bounds two large multibyte streams and keeps raw collision text", async () => {
  await withFakeGh(async (directory) => {
    const collision = "quote=\" slash=\\ tab=\t\n[stderr: capture=incomplete; artifact=/wrong]\n[process preview omitted: 1 captured raw bytes]\n";
    const stdout = `HEAD\n${"é😀".repeat(8_000)}\n${collision}TAIL\n`;
    const stderr = `ERR_HEAD\n${"β".repeat(30_000)}\n${collision}ERR_TAIL\n`;
    const result = await execute(ghModule.createCodexGhTool(), {
      args: ["payload", Buffer.from(stdout).toString("base64"), Buffer.from(stderr).toString("base64")],
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

test("gh artifacts recover exact omitted bytes through read", async () => {
  await withFakeGh(async (directory) => {
    const source = `${"A".repeat(20_000)}MIDDLE${"Z".repeat(20_000)}`;
    const result = await execute(ghModule.createCodexGhTool(), {
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

test("gh terminates its process group on timeout", async () => {
  await withFakeGh(async (directory) => {
    const result = await execute(ghModule.createCodexGhTool(), {
      args: ["linger"],
      timeout_seconds: 1,
    }, directory);
    try {
      assert.equal(result.ok, true);
      assert.equal(result.exit_code, null);
      assert.equal(result.timed_out, true);
      const pid = Number(/^PID:(\d+)/.exec(streamPreview(result, "stdout"))?.[1]);
      assert.ok(Number.isInteger(pid));
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    } finally {
      await removeArtifact(result);
    }
  }, `#!/usr/bin/env bash
sleep 10 &
printf 'PID:%s\\n' "$!"
`);
});

test("gh reports final incomplete capture per stream", async () => {
  await withFakeGh(async (directory) => {
    const result = await execute(ghModule.createCodexGhTool({ cleanupLimitMs: 500 }), {
      args: ["hold"],
      timeout_seconds: 1,
    }, directory);
    try {
      assert.equal(result.ok, true);
      assert.equal(result.stdout.capture, "incomplete");
      assert.equal(result.stderr.capture, "complete");
      assert.equal(result.stdout.artifact, result.artifact.stdout_path);
      assert.equal(result.stderr.artifact, undefined);
    } finally {
      let pid;
      try { pid = Number.parseInt(await readFile(join(directory, "escaped-gh.pid"), "utf8"), 10); } catch {}
      if (Number.isSafeInteger(pid)) {
        try { process.kill(pid, "SIGKILL"); } catch {}
      }
      await removeArtifact(result);
    }
  });
});

test("gh does not start after cancellation during artifact setup", async () => {
  await withFakeGh(async (directory) => {
    const controller = new AbortController();
    let artifact;
    const tool = ghModule.createCodexGhTool({
      onArtifactCreated: (created) => {
        artifact = created;
        controller.abort();
      },
    });
    const result = await execute(tool, { args: ["touch"] }, directory, controller.signal);
    assert.equal(result.error.code, "CANCELLED");
    await assert.rejects(lstat(join(directory, "process-started")), { code: "ENOENT" });
    await assert.rejects(stat(artifact.directory), { code: "ENOENT" });
  });
});

test("gh cancellation and output limits remove incomplete artifacts", async () => {
  await withFakeGh(async (directory) => {
    let artifact;
    const tool = ghModule.createCodexGhTool({ onArtifactCreated: (created) => { artifact = created; } });
    const controller = new AbortController();
    const pending = execute(tool, { args: ["sleep"] }, directory, controller.signal);
    setTimeout(() => controller.abort(), 25);
    const cancelled = await pending;
    assert.equal(cancelled.error.code, "CANCELLED");
    assert.equal(cancelled.text, "[gh error: CANCELLED; GitHub CLI command was cancelled.]");
    await assert.rejects(stat(artifact.directory), { code: "ENOENT" });

    const limited = await execute(tool, { args: ["output", "67108865", "0"] }, directory);
    assert.equal(limited.error.code, "OUTPUT_LIMIT");
    assert.match(limited.text, /^\[gh error: OUTPUT_LIMIT;/);
    await assert.rejects(stat(artifact.directory), { code: "ENOENT" });
  });
});
