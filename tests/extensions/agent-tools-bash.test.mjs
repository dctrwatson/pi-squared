import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

const bashModule = await import("../../extensions/agent-tools/bash.ts");
const readModule = await import("../../extensions/agent-tools/read.ts");

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
  const directory = await mkdtemp(join(tmpdir(), "pi-agent-bash-test-"));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function removeArtifact(result) {
  if ((result.process ?? result).artifact) {
    await rm((result.process ?? result).artifact.directory, { recursive: true, force: true });
  }
}

test("bash registers concrete parameter types", () => {
  const tool = bashModule.createAgentBashTool();
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

test("bash treats null optional fields as defaults without changing the caller's input", async () => {
  const tool = bashModule.createAgentBashTool();
  const input = { command: "printf ok", cwd: null, timeout_seconds: null };
  assert.deepEqual(tool.prepareArguments(input), { command: "printf ok" });
  assert.deepEqual(validateToolArguments(tool, { id: "call", name: "bash", arguments: tool.prepareArguments(input) }), { command: "printf ok" });
  assert.equal(input.cwd, null);
  assert.deepEqual(bashModule.normalizeInput(input), { command: "printf ok", timeoutSeconds: 120, maxOutputBytes: 8192, background: false });
  const result = await execute(tool, input, process.cwd());
  assert.equal(result.ok, true);
  assert.match(result.text, /ok/);
  assert.throws(() => bashModule.normalizeInput({ command: null, cwd: null }), (error) => error.code === "INVALID_INPUT");
});

test("bash renderer strips terminal sequences", () => {
  const tool = bashModule.createAgentBashTool();
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
  const tool = bashModule.createAgentBashTool();
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
  const tool = bashModule.createAgentBashTool();
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
    const tool = bashModule.createAgentBashTool();
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
      assert.ok(Buffer.byteLength(both.text) <= 8192);
    } finally {
      await Promise.all([empty, stdout, stderr, both].map(removeArtifact));
    }
  });
});

test("bash keeps terminal sequences in the tool result", async () => {
  await withDirectory(async (directory) => {
    const result = await execute(
      bashModule.createAgentBashTool(),
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

test("bash removes small complete artifacts", async () => {
  await withDirectory(async (directory) => {
    let artifact;
    const result = await execute(bashModule.createAgentBashTool({ onArtifactCreated: (created) => { artifact = created; } }),
      { command: "printf 'out\n'; printf 'err\n' >&2" }, directory);
    assert.equal(result.artifact, undefined);
    assert.equal(result.stdout.artifact, undefined);
    assert.equal(result.stop_reason, null);
    assert.equal(result.cleanup, "complete");
    await assert.rejects(stat(artifact.directory), { code: "ENOENT" });
  });
});

test("bash keeps raw decoded text unescaped and length-delimited", async () => {
  await withDirectory(async (directory) => {
    const source = "quote=\" slash=\\ tab=\t\n[stderr: capture=complete; preview=complete; captured_raw_bytes=0]\n";
    const encoded = Buffer.from(source).toString("base64");
    const result = await execute(
      bashModule.createAgentBashTool(),
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
    const result = await execute(bashModule.createAgentBashTool(), { command }, directory);
    try {
      assert.equal(result.stdout.preview, "truncated");
      assert.equal(result.stdout.capture, "complete");
      assert.ok(result.stdout.omitted_captured_raw_bytes > 0);
      assert.match(result.text, /HEAD\n/);
      assert.match(result.text, /\[process preview omitted: \d+ captured raw bytes\]/);
      assert.match(result.text, /TAIL\n$/);
      assert.match(result.text, new RegExp(`artifact=${result.artifact.stdout_path}`));
      assert.doesNotMatch(result.text, /head_preview_bytes=|tail_preview_bytes=|captured_lines=/);
      assert.ok(result.stdout.head_preview_bytes > 0);
      assert.ok(result.stdout.tail_preview_bytes > 0);
      assert.ok(Buffer.byteLength(result.text) <= 8192);
      const exact = await readFile(result.artifact.stdout_path, "utf8");
      assert.match(exact, /^HEAD\n/);
      assert.match(exact, /TAIL\n$/);
      const metadata = JSON.parse(await readFile(result.artifact.metadata_path, "utf8"));
      assert.equal(metadata.streams_complete, true);
      assert.equal(metadata.stdout.bytes, Buffer.byteLength(exact));
      assert.equal(metadata.expires_at, result.artifact.expires_at);
      assert.equal("command" in metadata, false);
      const page = await executeTool(readModule.createAgentReadTool(), {
        path: result.artifact.stdout_path, max_lines: 1, show_line_numbers: false,
      }, directory);
      assert.match(page.content[0].text, /^HEAD\n/);
    } finally {
      await removeArtifact(result);
    }
  });
});

test("bash passes session and noninteractive pager environment", async () => {
  await withDirectory(async (directory) => {
    const result = await execute(bashModule.createAgentBashTool(), {
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
      bashModule.createAgentBashTool(),
      { command: "printf 'start\\n'; sleep 0.2; printf 'end\\n'" },
      directory,
      undefined,
      (update) => updates.push(update),
    );
    try {
      assert.ok(updates.length >= 2);
      assert.ok(updates.every((update) => Buffer.byteLength(update.content[0].text) <= 8192));
      assert.equal(updates[0].details.stdout.capture, "incomplete");
      assert.ok(updates.some((update) => /start\n/.test(update.content[0].text)));
      assert.equal(toolResult.details.stdout.capture, "complete");
      assert.match(toolResult.content[0].text, /start\nend\n$/);
    } finally {
      await removeArtifact(toolResult.details);
    }
  });
});

test("bash cleans descendants after the direct shell exits", async () => {
  await withDirectory(async (directory) => {
    const result = await execute(
      bashModule.createAgentBashTool(),
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
      bashModule.createAgentBashTool(),
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
    const result = await execute(bashModule.createAgentBashTool(), {
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
      bashModule.createAgentBashTool({ cleanupLimitMs: 500 }),
      { command, timeout_seconds: 0.1 },
      directory,
    );
    try {
      assert.equal(result.ok, true);
      assert.equal(result.stdout.capture, "incomplete");
      assert.equal(result.stderr.capture, "complete");
      assert.equal(result.stdout.artifact, result.artifact.stdout_path);
      assert.equal(result.stderr.artifact, undefined);
      assert.match(result.text, /\[stdout: capture=incomplete; preview=complete; captured_raw_bytes=0; artifact=/);
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
    const tool = bashModule.createAgentBashTool({
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
    const tool = bashModule.createAgentBashTool();
    const controller = new AbortController();
    const pending = execute(tool, { command: "sleep 10" }, directory, controller.signal);
    setTimeout(() => controller.abort(), 25);
    const cancelled = await pending;
    assert.deepEqual(cancelled.error, { code: "CANCELLED", message: "Bash command was cancelled" });
    assert.match(cancelled.text, /^\[bash error: CANCELLED; Bash command was cancelled\]\n\[bash:/);
    assert.equal(cancelled.process.stop_reason, "cancelled");
    assert.equal(cancelled.process.cleanup, "complete");

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
      result = await execute(bashModule.createAgentBashTool(), { command: "head -c 20000 /dev/zero" }, directory);
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
  const moduleUrl = new URL("../../extensions/agent-tools/bash.ts", import.meta.url).href;
  const script = `
    import assert from "node:assert/strict";
    const { createAgentBashTool } = await import(${JSON.stringify(moduleUrl)});
    const result = await createAgentBashTool().execute(
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
    assert.equal(result.details.artifact, undefined);
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
      bashModule.createAgentBashTool(),
      { command: "head -c 67108865 /dev/zero" },
      directory,
    );
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "OUTPUT_LIMIT");
    assert.match(result.text, /^\[bash error: OUTPUT_LIMIT;/);
    await removeArtifact(result);
  });
});

test("bash retains the output-limit result when SIGTERM races a finished group", async () => {
  await withDirectory(async (directory) => {
    const originalKill = process.kill;
    let injected = false;
    process.kill = (pid, signal) => {
      if (!injected && typeof pid === "number" && pid < 0 && signal === "SIGTERM") {
        injected = true;
        const error = new Error("synthetic group-exit race");
        error.code = "EPERM";
        throw error;
      }
      return originalKill(pid, signal);
    };
    try {
      const result = await execute(
        bashModule.createAgentBashTool(),
        { command: "head -c 67108865 /dev/zero; sleep 0.1" },
        directory,
      );
      assert.equal(injected, true);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, "OUTPUT_LIMIT");
      await removeArtifact(result);
    } finally {
      process.kill = originalKill;
    }
  });
});

test("bash retains process-control failure when SIGTERM cannot stop a live group", async () => {
  await withDirectory(async (directory) => {
    const originalKill = process.kill;
    let groupId;
    let primaryError;
    const groupGone = async () => {
      const deadline = Date.now() + 1_000;
      while (true) {
        try {
          originalKill(-groupId, 0);
        } catch (error) {
          if (error.code === "ESRCH") return true;
          if (error.code !== "EPERM") throw error;
        }
        if (Date.now() >= deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };
    process.kill = (pid, signal) => {
      if (groupId === undefined && typeof pid === "number" && pid < 0 && signal === "SIGTERM") {
        groupId = -pid;
        const error = new Error("synthetic persistent group-control failure");
        error.code = "EPERM";
        throw error;
      }
      return originalKill(pid, signal);
    };
    try {
      const result = await execute(
        bashModule.createAgentBashTool({ cleanupLimitMs: 200 }),
        { command: "head -c 67108865 /dev/zero; sleep 30" },
        directory,
      );
      assert.equal(Number.isSafeInteger(groupId), true);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, "PROCESS_CONTROL_FAILED");
      assert.doesNotThrow(() => originalKill(-groupId, 0));
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      process.kill = originalKill;
      try {
        if (groupId !== undefined) {
          try { originalKill(-groupId, "SIGKILL"); } catch (error) {
            if (error.code !== "ESRCH") throw error;
          }
          assert.equal(await groupGone(), true, "Synthetic process group did not exit after SIGKILL");
        }
      } catch (error) {
        if (primaryError === undefined) throw error;
      }
    }
  });
});
