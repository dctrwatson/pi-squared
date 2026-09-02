import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

const bashModule = await import("../../extensions/codex-tools/bash.ts");
const readModule = await import("../../extensions/codex-tools/read.ts");

function context(cwd) {
  return {
    cwd,
    model: { provider: "openai-codex", id: "test-model" },
    thinkingLevel: "off",
    sessionManager: {
      getSessionId: () => "session-id",
      getSessionFile: () => undefined,
    },
  };
}

async function executeTool(tool, input, cwd, signal, onUpdate) {
  return tool.execute("tool-call", input, signal, onUpdate, context(cwd));
}

async function execute(tool, input, cwd, signal, onUpdate) {
  const toolResult = await executeTool(tool, input, cwd, signal, onUpdate);
  return { text: toolResult.content[0].text, ...toolResult.details };
}

async function withDirectory(callback) {
  const directory = await mkdtemp(join(tmpdir(), "pi-codex-bash-test-"));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function removeArtifact(result) {
  if (result.ok && result.artifact) {
    await rm(result.artifact.directory, { recursive: true, force: true });
  }
}

test("bash registers concrete parameter types", () => {
  const tool = bashModule.createCodexBashTool();
  const schema = tool.parameters;
  assert.equal(tool.promptGuidelines, undefined);
  assert.equal(schema.properties.command.type, "string");
  assert.equal(schema.properties.cwd.type, "string");
  assert.equal(schema.properties.timeout_seconds.type, "number");
  assert.match(schema.properties.timeout_seconds.description, /default: 120/);
  assert.equal(typeof tool.renderCall, "function");
  assert.equal(typeof tool.renderResult, "function");
});

test("bash normalizes timeout boundaries", () => {
  assert.equal(bashModule.normalizeInput({ command: "true" }).timeoutSeconds, 120);
  assert.equal(bashModule.normalizeInput({ command: "true", timeout_seconds: 0.1 }).timeoutSeconds, 0.1);
  assert.equal(bashModule.normalizeInput({ command: "true", timeout_seconds: 3_600 }).timeoutSeconds, 3_600);
  assert.throws(() => bashModule.normalizeInput({ command: "true", timeout_seconds: 0.09 }), (error) => error.code === "INVALID_INPUT");
  assert.throws(() => bashModule.normalizeInput({ command: "true", timeout_seconds: 3_601 }), (error) => error.code === "INVALID_INPUT");
  assert.throws(
    () => bashModule.normalizeInput({ command: "true", timeout: 1 }),
    (error) => error.code === "INVALID_INPUT" && /timeout/.test(error.message),
  );
});

test("bash renderer strips terminal sequences", () => {
  const tool = bashModule.createCodexBashTool();
  const plainTheme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text };
  const call = tool.renderCall(
    { command: "printf safe\u009d52;clipboard\u0007", cwd: "bad\u001bpath", timeout_seconds: "1\u009d" },
    plainTheme,
    {},
  ).render(200).join("\n");
  assert.doesNotMatch(call, /[\u0007\u001b\u009d]/);
  assert.match(call, /\\u009d/);

  const rendered = tool.renderResult(
    {
      content: [{
        type: "text",
        text: [
          "safe\u0000\u0001\r\ufff9\ufffa\ufffb",
          "\u001b]52;clipboard\u0007",
          "\u001b[31mred\u001b[0m",
          "\u001b[?25lmessage\u001b[?25h",
          "\u001b]8;;https://example.com/(x)\u001b\\link\u001b]8;;\u001b\\",
          "\u001b_hidden\u001b\\",
          "\u001bXsos\u0007data\u001b\\",
          " partial \u001b[",
        ].join(""),
      }],
      details: undefined,
    },
    { expanded: true, isPartial: false },
    plainTheme,
    { isError: false },
  ).render(200).join("\n");
  assert.doesNotMatch(rendered, /[\u0007\u001b\u009b]/);
  assert.equal(rendered.trimEnd(), "saferedmessagelink partial [");

  const incompleteString = tool.renderResult(
    { content: [{ type: "text", text: "safe\u001b]0;unfinished" }], details: undefined },
    { expanded: true, isPartial: true },
    plainTheme,
    { isError: false },
  ).render(200).join("\n");
  assert.equal(incompleteString.trimEnd(), "safe");
});

test("bash renderer leaves nonzero result text to the tool-error shell", () => {
  const tool = bashModule.createCodexBashTool();
  const colorTheme = { fg: (color, text) => `${color}:${text}`, bold: (text) => text };
  const rendered = tool.renderResult(
    {
      content: [{ type: "text", text: "[bash: exit_code=1; signal=none; timed_out=false; duration_ms=5652]" }],
      details: { ok: true, exit_code: 1, signal: null, timed_out: false },
    },
    { expanded: true, isPartial: false },
    colorTheme,
    { isError: false },
  ).render(200).join("\n");

  assert.match(rendered, /^toolOutput:/);
});

test("bash renderer truncates a multiline invocation to one terminal-width line", () => {
  const tool = bashModule.createCodexBashTool();
  const backgrounds = [];
  const plainTheme = {
    fg: (_color, text) => text,
    bg: (color, text) => {
      backgrounds.push(color);
      return `\u001b[48;5;52m${text}\u001b[49m`;
    },
    bold: (text) => text,
  };
  const lines = tool.renderCall(
    { command: `printf start
rm -rf a path that does not fit the tool row` },
    plainTheme,
    { isPartial: false, isError: true },
  ).render(24);

  assert.equal(lines.length, 1);
  assert.deepEqual(backgrounds, ["toolErrorBg"]);
  assert.equal(visibleWidth(lines[0]), 24);
  assert.match(stripTerminalSequences(lines[0]).trimEnd(), /\.\.\.$/);
  assert.match(lines[0], /\u001b\[48;5;52m\.\.\.\u001b\[49m/);
  assert.match(lines[0], /\\n/);
});

test("bash formats empty and separate streams", async () => {
  await withDirectory(async (directory) => {
    const tool = bashModule.createCodexBashTool();
    const empty = await execute(tool, { command: "true" }, directory);
    const stdout = await execute(tool, { command: "printf 'out\\n'" }, directory);
    const stderr = await execute(tool, { command: "printf 'err\\n' >&2" }, directory);
    const both = await execute(tool, { command: "printf 'out\\n'; printf 'err\\n' >&2; exit 3" }, directory);

    try {
      assert.match(empty.text, /^\[bash: ok; duration_ms=\d+\]$/);
      assert.match(stdout.text, /^\[bash: ok; duration_ms=\d+\]\n\[stdout: preview_bytes=4\]\nout\n$/);
      assert.doesNotMatch(stdout.text, /stderr:/);
      assert.match(stderr.text, /\n\[stderr: preview_bytes=4\]\nerr\n$/);
      assert.doesNotMatch(stderr.text, /stdout:/);
      assert.match(both.text, /exit_code=3/);
      assert.match(both.text, /\n\[stdout:.*\]\nout\n\n\[stderr:.*\]\nerr\n$/);
      assert.equal(both.ok, true);
      assert.equal(both.exit_code, 3);
      assert.equal(both.stdout.capture, "complete");
      assert.equal(both.stderr.capture, "complete");
      assert.equal(JSON.stringify(both.stdout).includes("out"), false);
      assert.ok(Buffer.byteLength(both.text) < 48 * 1024);
    } finally {
      await Promise.all([empty, stdout, stderr, both].map(removeArtifact));
    }
  });
});

test("bash keeps terminal sequences in the tool result", async () => {
  await withDirectory(async (directory) => {
    const result = await execute(
      bashModule.createCodexBashTool(),
      { command: "printf '\\033[31mred\\033[0m\\n'" },
      directory,
    );
    try {
      assert.match(result.text, /\u001b\[31mred\u001b\[0m\n$/);
    } finally {
      await removeArtifact(result);
    }
  });
});

test("bash retains owner-only exact artifacts but hides small paths from model content", async () => {
  await withDirectory(async (directory) => {
    const result = await execute(
      bashModule.createCodexBashTool(),
      { command: "printf 'out\\n'; printf 'err\\n' >&2" },
      directory,
    );
    try {
      assert.doesNotMatch(result.text, new RegExp(result.artifact.directory));
      assert.equal((await stat(result.artifact.directory)).mode & 0o777, 0o700);
      assert.equal((await stat(result.artifact.stdout_path)).mode & 0o777, 0o600);
      assert.equal(await readFile(result.artifact.stdout_path, "utf8"), "out\n");
      assert.equal(await readFile(result.artifact.stderr_path, "utf8"), "err\n");
      const metadata = JSON.parse(await readFile(result.artifact.metadata_path, "utf8"));
      assert.equal(metadata.streams_complete, true);
      assert.equal(metadata.stdout.bytes, 4);
      assert.equal(metadata.stderr.bytes, 4);
      assert.equal("command" in metadata, false);

      const page = await executeTool(
        readModule.createCodexReadTool(),
        { path: result.artifact.stdout_path },
        directory,
      );
      assert.equal(page.content[0].text, "out\n\n[lines 1-1; next_start_line=null; eof=true]");
    } finally {
      await removeArtifact(result);
    }
  });
});

test("bash keeps raw decoded text unescaped and length-delimited", async () => {
  await withDirectory(async (directory) => {
    const source = "quote=\" slash=\\ tab=\t\n[stderr: capture=complete; preview=complete; captured_raw_bytes=0]\n";
    const encoded = Buffer.from(source).toString("base64");
    const result = await execute(
      bashModule.createCodexBashTool(),
      { command: `node -e 'process.stdout.write(Buffer.from("${encoded}", "base64"))'` },
      directory,
    );
    try {
      assert.ok(result.text.includes(source));
      assert.doesNotMatch(result.text, /quote=\\\"/);
      assert.equal(result.stdout.captured_raw_bytes, Buffer.byteLength(source));
      assert.equal(result.stdout.preview_bytes, Buffer.byteLength(source));
      assert.equal(result.stdout.captured_lines, 2);
      assert.equal(result.stderr.captured_raw_bytes, 0);
    } finally {
      await removeArtifact(result);
    }
  });
});

test("bash preserves head and tail with a bounded artifact-backed preview", async () => {
  await withDirectory(async (directory) => {
    const command = "printf 'HEAD\\n'; i=0; while [ $i -lt 5000 ]; do printf 'middle-%s\\n' $i; i=$((i+1)); done; printf 'TAIL\\n'";
    const result = await execute(bashModule.createCodexBashTool(), { command }, directory);
    try {
      assert.equal(result.stdout.preview, "truncated");
      assert.equal(result.stdout.capture, "complete");
      assert.ok(result.stdout.omitted_captured_raw_bytes > 0);
      assert.match(result.text, /HEAD\n/);
      assert.match(result.text, /\[process preview omitted: \d+ captured raw bytes\]/);
      assert.match(result.text, /TAIL\n$/);
      assert.match(result.text, new RegExp(`artifact=${result.artifact.stdout_path}`));
      assert.match(result.text, new RegExp(`preview_bytes=${result.stdout.preview_bytes}`));
      assert.match(result.text, new RegExp(`head_preview_bytes=${result.stdout.head_preview_bytes}`));
      assert.match(result.text, new RegExp(`tail_preview_bytes=${result.stdout.tail_preview_bytes}`));
      assert.ok(Buffer.byteLength(result.text) < 48 * 1024);
      const exact = await readFile(result.artifact.stdout_path, "utf8");
      assert.match(exact, /^HEAD\n/);
      assert.match(exact, /TAIL\n$/);
    } finally {
      await removeArtifact(result);
    }
  });
});

test("bash passes session and noninteractive pager environment", async () => {
  await withDirectory(async (directory) => {
    const result = await execute(bashModule.createCodexBashTool(), {
      command: "printf '%s\\n' \"$PI_PROVIDER\" \"$PAGER\" \"$GIT_PAGER\" \"$GH_PAGER\"",
    }, directory);
    try {
      assert.match(result.text, /openai-codex\ncat\ncat\ncat\n$/);
    } finally {
      await removeArtifact(result);
    }
  });
});

test("bash streams bounded incomplete progress updates", async () => {
  await withDirectory(async (directory) => {
    const updates = [];
    const toolResult = await executeTool(
      bashModule.createCodexBashTool(),
      { command: "printf 'start\\n'; sleep 0.2; printf 'end\\n'" },
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
      await rm(toolResult.details.artifact.directory, { recursive: true, force: true });
    }
  });
});

test("bash cleans descendants after the direct shell exits", async () => {
  await withDirectory(async (directory) => {
    const result = await execute(
      bashModule.createCodexBashTool(),
      { command: "sleep 10 & printf 'done\\n'" },
      directory,
    );
    try {
      assert.equal(result.exit_code, 0);
      assert.equal(result.timed_out, false);
      assert.match(result.text, /done\n$/);
    } finally {
      await removeArtifact(result);
    }
  });
});

test("bash keeps signals as normal process results", async () => {
  await withDirectory(async (directory) => {
    const result = await execute(
      bashModule.createCodexBashTool(),
      { command: "kill -TERM $$" },
      directory,
    );
    try {
      assert.equal(result.ok, true);
      assert.equal(result.exit_code, null);
      assert.equal(result.signal, "SIGTERM");
      assert.equal(result.timed_out, false);
      assert.match(result.text, /^\[bash: exit_code=null; signal=SIGTERM; timed_out=false;/);
    } finally {
      await removeArtifact(result);
    }
  });
});

test("bash keeps timeout enforcement and captured grace-period output", async () => {
  await withDirectory(async (directory) => {
    const result = await execute(bashModule.createCodexBashTool(), {
      command: "trap 'printf \"TERM\\n\"; exit 0' TERM; while :; do printf 'tick\\n'; sleep 0.01; done",
      timeout_seconds: 0.1,
    }, directory);
    try {
      assert.equal(result.ok, true);
      assert.equal(result.timed_out, true);
      assert.equal(result.exit_code, null);
      assert.match(result.text, /^\[bash: exit_code=null; signal=/);
      const exact = await readFile(result.artifact.stdout_path, "utf8");
      assert.match(exact, /tick\n/);
      assert.match(exact, /TERM\n/);
    } finally {
      await removeArtifact(result);
    }
  });
});

test("bash reports final incomplete capture per stream", async () => {
  await withDirectory(async (directory) => {
    const command = "perl -e 'setpgrp(0,0); open(my $fh, \">\", \"escaped.pid\") or die $!; print $fh \"$$\\n\"; close($fh); sleep 10' 2>/dev/null & while [ ! -s escaped.pid ]; do sleep 0.01; done";
    const result = await execute(
      bashModule.createCodexBashTool({ cleanupLimitMs: 500 }),
      { command, timeout_seconds: 0.1 },
      directory,
    );
    try {
      assert.equal(result.ok, true);
      assert.equal(result.stdout.capture, "incomplete");
      assert.equal(result.stderr.capture, "complete");
      assert.equal(result.stdout.artifact, result.artifact.stdout_path);
      assert.equal(result.stderr.artifact, undefined);
      assert.match(result.text, /\[stdout: capture=incomplete; preview=complete; captured_raw_bytes=0; captured_lines=0; preview_bytes=0; artifact=/);
      assert.doesNotMatch(result.text, /\[stderr:/);
      assert.equal((await readFile(result.artifact.stdout_path)).length, 0);
    } finally {
      const pid = Number.parseInt(await readFile(join(directory, "escaped.pid"), "utf8"), 10);
      if (Number.isSafeInteger(pid)) {
        try { process.kill(pid, "SIGKILL"); } catch {}
      }
      await removeArtifact(result);
    }
  });
});

test("bash does not start after cancellation during artifact setup", async () => {
  await withDirectory(async (directory) => {
    const controller = new AbortController();
    let artifact;
    const tool = bashModule.createCodexBashTool({
      onArtifactCreated: (created) => {
        artifact = created;
        controller.abort();
      },
    });
    const result = await execute(tool, { command: "touch process-started" }, directory, controller.signal);
    assert.equal(result.error.code, "CANCELLED");
    await assert.rejects(stat(join(directory, "process-started")), { code: "ENOENT" });
    await assert.rejects(stat(artifact.directory), { code: "ENOENT" });
  });
});

test("bash returns stable failures for cancellation and validation", async () => {
  await withDirectory(async (directory) => {
    const tool = bashModule.createCodexBashTool();
    const controller = new AbortController();
    const pending = execute(tool, { command: "sleep 10" }, directory, controller.signal);
    setTimeout(() => controller.abort(), 25);
    const cancelled = await pending;
    assert.deepEqual(cancelled.error, { code: "CANCELLED", message: "Bash command was cancelled" });
    assert.equal(cancelled.text, "[bash error: CANCELLED; Bash command was cancelled]");

    for (const [input, code] of [
      [{ command: "   " }, "INVALID_INPUT"],
      [{ command: "true", unknown: true }, "INVALID_INPUT"],
      [{ command: "true", cwd: "missing" }, "INVALID_CWD"],
    ]) {
      const failure = await execute(tool, input, directory);
      assert.equal(failure.ok, false);
      assert.equal(failure.error.code, code);
      assert.match(failure.text, new RegExp(`^\\[bash error: ${code};`));
    }
  });
});

test("bash enforces owner modes under a restrictive umask", async () => {
  await withDirectory(async (directory) => {
    const previous = process.umask(0o777);
    let result;
    try {
      result = await execute(bashModule.createCodexBashTool(), { command: "true" }, directory);
      assert.equal((await stat(result.artifact.directory)).mode & 0o777, 0o700);
      assert.equal((await stat(result.artifact.stdout_path)).mode & 0o777, 0o600);
      assert.equal((await stat(result.artifact.stderr_path)).mode & 0o777, 0o600);
      assert.equal((await stat(result.artifact.metadata_path)).mode & 0o777, 0o600);
    } finally {
      process.umask(previous);
      if (result) await removeArtifact(result);
    }
  });
});

test("bash clears cleanup timers after a fast command", () => {
  const moduleUrl = new URL("../../extensions/codex-tools/bash.ts", import.meta.url).href;
  const script = `
    import { rm } from "node:fs/promises";
    const { createCodexBashTool } = await import(${JSON.stringify(moduleUrl)});
    const result = await createCodexBashTool().execute(
      "timer-test",
      { command: "true" },
      undefined,
      undefined,
      {
        cwd: process.cwd(),
        model: { provider: "openai-codex", id: "test-model" },
        thinkingLevel: "off",
        sessionManager: { getSessionId: () => "timer-test", getSessionFile: () => undefined },
      },
    );
    await rm(result.details.artifact.directory, { recursive: true, force: true });
  `;
  const child = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "--eval", script],
    { cwd: process.cwd(), encoding: "utf8", timeout: 2_000 },
  );
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  assert.equal(child.error, undefined);
});

test("bash stops at the full-capture limit", async () => {
  await withDirectory(async (directory) => {
    const result = await execute(
      bashModule.createCodexBashTool(),
      { command: "head -c 67108865 /dev/zero" },
      directory,
    );
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "OUTPUT_LIMIT");
    assert.match(result.text, /^\[bash error: OUTPUT_LIMIT;/);
  });
});
