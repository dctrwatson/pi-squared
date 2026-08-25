import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createExtensionRuntime, ExtensionRunner } from "@earendil-works/pi-coding-agent";

const readModule = await import("../../extensions/codex-tools/read.ts");
const codexModule = await import("../../extensions/codex-tools/index.ts");

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

async function execute(tool, input, cwd, signal) {
  return tool.execute("tool-call", input, signal, undefined, context(cwd));
}

function output(result) {
  return result.content[0].text;
}

async function withDirectory(callback) {
  const directory = await mkdtemp(join(tmpdir(), "pi-codex-read-test-"));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("codex-tools register only after a Codex model is selected", async () => {
  for (const provider of ["openai", "anthropic", undefined]) {
    const handlers = new Map();
    const tools = [];
    codexModule.default({
      on(event, handler) {
        handlers.set(event, handler);
      },
      registerTool(tool) {
        tools.push(tool);
      },
    });

    await handlers.get("session_start")({}, { model: provider ? { provider } : undefined });
    assert.deepEqual(tools, []);
    assert.equal(await handlers.get("tool_result")({
      toolName: "write",
      input: { path: "before.txt", content: "é" },
      isError: false,
      content: [{ type: "text", text: "Successfully wrote 1 bytes to before.txt" }],
    }), undefined);
  }

  const handlers = new Map();
  const tools = [];
  let activeTools = ["read", "bash", "edit", "write"];
  codexModule.default({
    on(event, handler) {
      handlers.set(event, handler);
    },
    registerTool(tool) {
      tools.push(tool);
    },
    getActiveTools() {
      return activeTools;
    },
    setActiveTools(names) {
      activeTools = names;
    },
  });
  const ctx = { model: { provider: "openai-codex" } };
  await handlers.get("session_start")({}, ctx);
  await handlers.get("session_start")({}, ctx);
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["bash", "find", "gh", "git", "grep", "read", "web_search"]);
  assert.equal(tools.some((tool) => tool.name === "apply_diff" || tool.name === "patch"), false);
  assert.equal(tools.some((tool) => tool.name === "edit" || tool.name === "write"), false);
  assert.deepEqual(activeTools.sort(), ["bash", "edit", "find", "gh", "git", "grep", "read", "web_search", "write"]);

  const writeResult = (path, content, isError = false) => ({
    toolName: "write",
    input: { path, content },
    isError,
    content: [
      { type: "text", text: `Successfully wrote ${content.length} bytes to ${path}` },
      { type: "image", data: "image-data", mimeType: "image/png" },
    ],
    details: { retained: true },
    usage: { input: 1, output: 2 },
  });
  const asciiWrite = writeResult("ascii.txt", "abc");
  const asciiCorrection = await handlers.get("tool_result")(asciiWrite, ctx);
  assert.equal(asciiCorrection.content[0].text, "Successfully wrote 3 bytes to ascii.txt");
  assert.strictEqual(asciiCorrection.content[1], asciiWrite.content[1]);
  assert.deepEqual(asciiWrite.details, { retained: true });
  assert.deepEqual(asciiWrite.usage, { input: 1, output: 2 });

  const utf8Correction = await handlers.get("tool_result")(writeResult("utf8.txt", "é😀"), ctx);
  assert.equal(utf8Correction.content[0].text, "Successfully wrote 6 bytes to utf8.txt");
  assert.equal(await handlers.get("tool_result")({
    ...writeResult("custom.txt", "é"),
    content: [{ type: "text", text: "Custom write completed with a revision" }],
  }, ctx), undefined);
  assert.equal(await handlers.get("tool_result")(writeResult("failed.txt", "é", true), ctx), undefined);

  const processResult = (toolName, exitCode, stderr = "") => ({
    toolName,
    isError: false,
    content: [
      { type: "text", text: `[${toolName}: exit_code=${exitCode}; signal=none; timed_out=false; duration_ms=1]` },
      ...(stderr ? [{ type: "text", text: `[stderr: capture=complete; preview=complete]\n${stderr}` }] : []),
    ],
    details: { ok: true, tool: toolName, exit_code: exitCode, signal: null, timed_out: false },
  });
  assert.deepEqual(await handlers.get("tool_result")(processResult("bash", 1), ctx), { isError: true });
  assert.equal(await handlers.get("tool_result")(processResult("bash", 0), ctx), undefined);
  assert.deepEqual(await handlers.get("tool_result")(processResult("gh", 1), ctx), { isError: true });
  assert.equal(await handlers.get("tool_result")(processResult("git", 1), ctx), undefined);
  assert.deepEqual(await handlers.get("tool_result")(processResult("git", 1, "fatal: bad revision\n"), ctx), { isError: true });
  assert.deepEqual(await handlers.get("tool_result")(processResult("git", 128, "fatal: pathspec 'tests/extensions/child.test.mjs' did not match any files\n"), ctx), { isError: true });
  for (const toolName of ["bash", "read", "git", "gh"]) {
    assert.deepEqual(await handlers.get("tool_result")({
      toolName,
      isError: false,
      content: [{ type: "text", text: `[${toolName} error: CANCELLED; cancelled]` }],
      details: { ok: false, tool: toolName, error: { code: "CANCELLED", message: "cancelled" } },
    }, ctx), { isError: true });
  }

  const notifications = [];
  await handlers.get("model_select")(
    { model: { provider: "openai" } },
    { ...ctx, hasUI: true, ui: { notify: (...args) => notifications.push(args) } },
  );
  assert.match(notifications[0][0], /stay active/);

  await handlers.get("model_select")({ model: { provider: "openai" } }, ctx);
  const afterSwitch = await handlers.get("tool_result")(writeResult("later.txt", "é"), ctx);
  assert.equal(afterSwitch.content[0].text, "Successfully wrote 2 bytes to later.txt");
  await handlers.get("model_select")({ model: { provider: "openai-codex" } }, ctx);
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["bash", "find", "gh", "git", "grep", "read", "web_search"]);
});

test("tool-result middleware preserves content, details, and usage", async () => {
  const handlers = new Map();
  codexModule.default({
    on(event, handler) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
    registerTool() {},
    getActiveTools: () => ["read", "bash", "edit", "write"],
    setActiveTools() {},
  });
  await handlers.get("session_start")[0]({}, { model: { provider: "openai-codex" } });

  const extension = {
    path: "codex-tools-test",
    resolvedPath: "codex-tools-test",
    sourceInfo: { kind: "path", path: "codex-tools-test" },
    handlers,
    tools: new Map(),
    messageRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  };
  const runner = new ExtensionRunner([extension], createExtensionRuntime(), process.cwd(), {}, {});
  const failureContent = [{ type: "text", text: "[read error: NOT_FOUND; missing]" }];
  const failureDetails = { ok: false, tool: "read", error: { code: "NOT_FOUND", message: "missing" } };
  const usage = { retained: true };
  const readResult = await runner.emitToolResult({
    type: "tool_result",
    toolCallId: "read-call",
    toolName: "read",
    input: { path: "missing" },
    content: failureContent,
    details: failureDetails,
    isError: false,
    usage,
  });
  assert.deepEqual(readResult, {
    content: failureContent,
    details: failureDetails,
    isError: true,
    usage,
  });

  const gitContent = [{ type: "text", text: "[git error: CANCELLED; cancelled]" }];
  const gitDetails = { ok: false, tool: "git", error: { code: "CANCELLED", message: "cancelled" } };
  const gitResult = await runner.emitToolResult({
    type: "tool_result",
    toolCallId: "git-call",
    toolName: "git",
    input: { args: ["status"] },
    content: gitContent,
    details: gitDetails,
    isError: false,
    usage,
  });
  assert.deepEqual(gitResult, {
    content: gitContent,
    details: gitDetails,
    isError: true,
    usage,
  });

  const writeDetails = { retained: true };
  const writeUsage = { retained: "usage" };
  const image = { type: "image", data: "image-data", mimeType: "image/png" };
  const writeResult = await runner.emitToolResult({
    type: "tool_result",
    toolCallId: "write-call",
    toolName: "write",
    input: { path: "utf8.txt", content: "é" },
    content: [{ type: "text", text: "Successfully wrote 1 bytes to utf8.txt" }, image],
    details: writeDetails,
    isError: false,
    usage: writeUsage,
  });
  assert.equal(writeResult.content[0].text, "Successfully wrote 2 bytes to utf8.txt");
  assert.strictEqual(writeResult.content[1], image);
  assert.strictEqual(writeResult.details, writeDetails);
  assert.strictEqual(writeResult.usage, writeUsage);
  assert.equal(writeResult.isError, false);

  assert.equal(await runner.emitToolResult({
    type: "tool_result",
    toolCallId: "already-error",
    toolName: "read",
    input: { path: "missing" },
    content: failureContent,
    details: failureDetails,
    isError: true,
  }), undefined);
  const nonzeroContent = [{ type: "text", text: "[bash: exit_code=1; signal=none; timed_out=false; duration_ms=1]" }];
  const nonzeroDetails = { ok: true, tool: "bash", exit_code: 1 };
  assert.deepEqual(await runner.emitToolResult({
    type: "tool_result",
    toolCallId: "normal-process",
    toolName: "bash",
    input: { command: "exit 1" },
    content: nonzeroContent,
    details: nonzeroDetails,
    isError: false,
  }), {
    content: nonzeroContent,
    details: nonzeroDetails,
    isError: true,
    usage: undefined,
  });
});

test("read returns raw complete and continuation line pages", async () => {
  await withDirectory(async (directory) => {
    await writeFile(join(directory, "source.ts"), "alpha\nβeta\nlast", "utf8");
    const tool = readModule.createCodexReadTool();

    const first = await execute(tool, { path: "source.ts", max_lines: 2, max_bytes: 100 }, directory);
    const firstText = "alpha\nβeta\n\n[lines 1-2; next_start_line=3; eof=false]";
    assert.equal(output(first), firstText);
    assert.deepEqual(first.details, {
      ok: true,
      tool: "read",
      mode: "lines",
      path: await realpath(join(directory, "source.ts")),
      total_bytes: 16,
      total_lines: 3,
      start_line: 1,
      end_line: 2,
      next_start_line: 3,
      limited_by: "lines",
      show_line_numbers: false,
      source_bytes: 12,
      formatted_bytes: Buffer.byteLength(firstText),
    });
    assert.equal(JSON.stringify(first.details).includes("alpha"), false);
    assert.equal("revision" in first.details, false);

    const second = await execute(tool, { path: "source.ts", start_line: 3 }, directory);
    assert.equal(output(second), "last\n\n[lines 3-3; next_start_line=null; eof=true]");

    const pastEnd = await execute(tool, { path: "source.ts", start_line: 99 }, directory);
    assert.equal(output(pastEnd), "[lines none; next_start_line=null; eof=true]");
    assert.equal(pastEnd.details.start_line, null);
  });
});

test("read adds stable actual line-number gutters on request", async () => {
  await withDirectory(async (directory) => {
    const lines = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
    await writeFile(join(directory, "source"), `${lines.join("\n")}\n`, "utf8");
    const result = await execute(readModule.createCodexReadTool(), {
      path: "source",
      start_line: 8,
      max_lines: 3,
      show_line_numbers: true,
    }, directory);
    const expected = [
      " 8 │ line 8",
      " 9 │ line 9",
      "10 │ line 10",
      "",
      "[lines 8-10; next_start_line=11; eof=false]",
    ].join("\n");
    assert.equal(output(result), expected);
    assert.equal(result.details.show_line_numbers, true);
    assert.equal(result.details.source_bytes, Buffer.byteLength("line 8\nline 9\nline 10\n"));
    assert.equal(result.details.formatted_bytes, Buffer.byteLength(expected));
  });
});

test("read reduces numbered pages at the formatted-output limit", async () => {
  await withDirectory(async (directory) => {
    const sourceLine = `${"x".repeat(19)}\n`;
    await writeFile(join(directory, "large-lines"), sourceLine.repeat(2_000), "utf8");
    const tool = readModule.createCodexReadTool();
    const clean = await execute(tool, {
      path: "large-lines",
      max_lines: 2_000,
      max_bytes: 40_960,
    }, directory);
    assert.equal(clean.details.end_line, 2_000);
    assert.equal(clean.details.limited_by, "none");
    assert.match(output(clean), /\[lines 1-2000; next_start_line=null; eof=true\]$/);

    const numbered = await execute(tool, {
      path: "large-lines",
      max_lines: 2_000,
      max_bytes: 40_960,
      show_line_numbers: true,
    }, directory);
    assert.equal(numbered.details.limited_by, "formatted_bytes");
    assert.ok(numbered.details.end_line < 2_000);
    assert.equal(numbered.details.next_start_line, numbered.details.end_line + 1);
    assert.equal(numbered.details.source_bytes, numbered.details.end_line * 20);
    assert.ok(Buffer.byteLength(output(numbered)) < 48 * 1024);
    assert.match(output(numbered), /eof=false\]$/);

    const remainder = await execute(tool, {
      path: "large-lines",
      start_line: numbered.details.next_start_line,
      max_lines: 2_000,
      max_bytes: 40_960,
      show_line_numbers: true,
    }, directory);
    assert.equal(remainder.details.start_line, numbered.details.next_start_line);
    assert.equal(remainder.details.end_line, 2_000);
    assert.equal(remainder.details.limited_by, "none");
    assert.match(output(remainder), /next_start_line=null; eof=true\]$/);
  });
});

test("read counts empty and newline-terminated files correctly", async () => {
  await withDirectory(async (directory) => {
    const tool = readModule.createCodexReadTool();
    const cases = [
      ["empty", "", 0, "[lines none; next_start_line=null; eof=true]"],
      ["one-empty-line", "\n", 1, "[lines 1-1; next_start_line=null; eof=true]"],
      ["one-line", "a\n", 1, "[lines 1-1; next_start_line=null; eof=true]"],
      ["two-lines", "a\n\n", 2, "[lines 1-2; next_start_line=null; eof=true]"],
      ["final-line", "a\nb", 2, "[lines 1-2; next_start_line=null; eof=true]"],
    ];

    for (const [name, content, totalLines, footer] of cases) {
      await writeFile(join(directory, name), content, "utf8");
      const result = await execute(tool, { path: name }, directory);
      assert.equal(result.details.total_lines, totalLines, name);
      assert.equal(output(result).split("\n").at(-1), footer, name);
    }

    const exactLimits = await execute(tool, {
      path: "two-lines",
      max_lines: 2,
      max_bytes: 3,
    }, directory);
    assert.equal(exactLimits.details.limited_by, "none");
    assert.equal(exactLimits.details.next_start_line, null);
    assert.match(output(exactLimits), /next_start_line=null; eof=true\]$/);
  });
});

test("read stops at the line byte limit without splitting a line", async () => {
  await withDirectory(async (directory) => {
    await writeFile(join(directory, "source"), "one\ntwo\nthree", "utf8");
    const result = await execute(readModule.createCodexReadTool(), { path: "source", max_bytes: 7 }, directory);

    assert.equal(output(result), "one\n\n[lines 1-1; next_start_line=2; eof=false]");
    assert.equal(result.details.end_line, 1);
    assert.equal(result.details.next_start_line, 2);
  });
});

test("read reports exact byte offsets for long lines", async () => {
  await withDirectory(async (directory) => {
    const tool = readModule.createCodexReadTool();
    await writeFile(join(directory, "first"), "12345\n", "utf8");
    const first = await execute(tool, { path: "first", max_bytes: 5 }, directory);
    assert.equal(output(first), "[read error: LINE_TOO_LONG; The first requested line exceeds max_bytes; line=1; byte_offset=0]");
    assert.equal(first.details.error.byte_offset, 0);

    await writeFile(join(directory, "later"), "é\n12345", "utf8");
    const later = await execute(tool, { path: "later", start_line: 2, max_bytes: 4 }, directory);
    assert.equal(output(later), "[read error: LINE_TOO_LONG; The first requested line exceeds max_bytes; line=2; byte_offset=3]");
    assert.equal(later.details.error.byte_offset, 3);
    assert.equal(later.details.error.path, await realpath(join(directory, "later")));

    const recovery = await execute(tool, { path: "later", mode: "bytes", start_byte: 3, max_bytes: 5 }, directory);
    assert.equal(output(recovery), "12345\n\n[bytes 3,8); next_start_byte=null; eof=true]");
  });
});

test("read applies the long-line boundary to exact source bytes", async () => {
  await withDirectory(async (directory) => {
    const tool = readModule.createCodexReadTool();
    await writeFile(join(directory, "exact"), "1234", "utf8");
    const exact = await execute(tool, { path: "exact", max_bytes: 4 }, directory);
    assert.match(output(exact), /^1234\n\n\[lines/);

    await writeFile(join(directory, "over"), "12345", "utf8");
    const over = await execute(tool, { path: "over", max_bytes: 4 }, directory);
    assert.equal(over.details.error.byte_offset, 0);
    assert.match(output(over), /byte_offset=0\]$/);
  });
});

test("read supports UTF-8 byte pages at code-point boundaries", async () => {
  await withDirectory(async (directory) => {
    const content = "Aé😀B";
    await writeFile(join(directory, "utf8"), content, "utf8");
    const tool = readModule.createCodexReadTool();

    const first = await execute(tool, { path: "utf8", mode: "bytes", max_bytes: 3 }, directory);
    assert.equal(output(first), "Aé\n\n[bytes 0,3); next_start_byte=3; eof=false]");

    const second = await execute(tool, { path: "utf8", mode: "bytes", start_byte: 3, max_bytes: 4 }, directory);
    assert.equal(output(second), "😀\n\n[bytes 3,7); next_start_byte=7; eof=false]");

    const invalidStart = await execute(tool, { path: "utf8", mode: "bytes", start_byte: 2 }, directory);
    assert.equal(invalidStart.details.error.code, "INVALID_BYTE_BOUNDARY");

    const tooSmall = await execute(tool, { path: "utf8", mode: "bytes", start_byte: 1, max_bytes: 1 }, directory);
    assert.equal(tooSmall.details.error.code, "BYTE_PAGE_TOO_SMALL");

    const pastEnd = await execute(tool, { path: "utf8", mode: "bytes", start_byte: 99 }, directory);
    assert.equal(output(pastEnd), "[bytes none; next_start_byte=null; eof=true]");
  });
});

test("read returns exact Base64 pages", async () => {
  await withDirectory(async (directory) => {
    await writeFile(join(directory, "binary"), Buffer.from([0xff, 0x00, 0x01]));
    const result = await execute(readModule.createCodexReadTool(), {
      path: "binary",
      mode: "bytes",
      encoding: "base64",
      max_bytes: 2,
    }, directory);

    assert.equal(output(result), "/wA=\n\n[bytes 0,2); next_start_byte=2; eof=false]");
    assert.equal(result.details.encoding, "base64");
  });
});

test("read preserves UTF-8 source text without JSON escaping", async () => {
  await withDirectory(async (directory) => {
    const source = "\uFEFF\"quote\"\\slash\tend\n[read: source-shaped line]\n";
    await writeFile(join(directory, "source"), source, "utf8");
    const result = await execute(readModule.createCodexReadTool(), { path: "source" }, directory);
    const text = output(result);

    assert.ok(text.startsWith(`${source}\n`));
    assert.equal(text.slice(0, source.length), source);
    assert.equal(text.match(/\[read: source-shaped line\]/g)?.length, 1);
    assert.equal(text.split("\n").at(-1), "[lines 1-2; next_start_line=null; eof=true]");
    assert.ok(Buffer.byteLength(text) < 48 * 1024);
  });
});

test("read rejects invalid UTF-8 in text modes", async () => {
  await withDirectory(async (directory) => {
    await writeFile(join(directory, "binary"), Buffer.from([0xff]));
    const tool = readModule.createCodexReadTool();

    for (const input of [{ path: "binary" }, { path: "binary", mode: "bytes" }]) {
      const result = await execute(tool, input, directory);
      assert.equal(output(result), "[read error: INVALID_ENCODING; The file is not valid UTF-8]");
      assert.equal(result.details.error.code, "INVALID_ENCODING");
    }
  });
});

test("read treats revision input as an unknown field", async () => {
  await withDirectory(async (directory) => {
    await writeFile(join(directory, "source"), "ok", "utf8");
    const result = await execute(readModule.createCodexReadTool(), {
      path: "source",
      expected_revision: `sha256:${"0".repeat(64)}`,
    }, directory);
    assert.equal(result.details.error.code, "INVALID_INPUT");
    assert.match(output(result), /Unknown input field: expected_revision/);
  });
});

test("read returns INVALID_INPUT for invalid fields", async () => {
  await withDirectory(async (directory) => {
    await writeFile(join(directory, "source"), "ok", "utf8");
    const tool = readModule.createCodexReadTool();
    const cases = [
      { path: 12 },
      { path: "source", unknown: true },
      { path: "source", mode: "lines", encoding: "utf8" },
      { path: "source", mode: "bytes", max_lines: 1 },
      { path: "source", mode: "bytes", show_line_numbers: true },
      { path: "source", show_line_numbers: "yes" },
      { path: "source", max_lines: null },
    ];
    for (const input of cases) {
      const result = await execute(tool, input, directory);
      assert.equal(result.details.error.code, "INVALID_INPUT", JSON.stringify(input));
      assert.match(output(result), /^\[read error: INVALID_INPUT;/);
    }
  });
});

test("read keeps caller-controlled failures in one control line", async () => {
  await withDirectory(async (directory) => {
    const result = await execute(readModule.createCodexReadTool(), {
      path: "missing",
      ["bad\n[read: false]"]: true,
    }, directory);
    assert.equal(output(result).includes("\n"), false);
    assert.match(output(result), /bad\\n\\\[read: false\\\]/);
    assert.equal(result.details.error.message.includes("\n"), true);
  });
});

test("read resolves one leading @ and rejects an @-only path", async () => {
  await withDirectory(async (directory) => {
    await writeFile(join(directory, "source"), "ok", "utf8");
    const tool = readModule.createCodexReadTool();
    const result = await execute(tool, { path: "@source" }, directory);
    assert.match(output(result), /^ok\n\n\[lines/);

    const invalid = await execute(tool, { path: "@" }, directory);
    assert.equal(invalid.details.error.code, "INVALID_INPUT");
  });
});

test("read rejects files larger than the file limit", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "large");
    await writeFile(path, "", "utf8");
    await truncate(path, 67_108_865);
    const result = await execute(readModule.createCodexReadTool(), { path: "large" }, directory);
    assert.equal(result.details.error.code, "RESOURCE_LIMIT");
  });
});

test("read reports unsupported and missing paths", async () => {
  await withDirectory(async (directory) => {
    await mkdir(join(directory, "folder"));
    const tool = readModule.createCodexReadTool();
    const folder = await execute(tool, { path: "folder" }, directory);
    const missing = await execute(tool, { path: "missing" }, directory);
    assert.equal(folder.details.error.code, "UNSUPPORTED_FILE_TYPE");
    assert.equal(missing.details.error.code, "NOT_FOUND");
    assert.match(output(missing), /^\[read error: NOT_FOUND;/);
  });
});

test("read returns cancellation before file access", async () => {
  await withDirectory(async (directory) => {
    await writeFile(join(directory, "source"), "ok", "utf8");
    const controller = new AbortController();
    controller.abort();
    const result = await execute(readModule.createCodexReadTool(), { path: "source" }, directory, controller.signal);
    assert.equal(output(result), "[read error: CANCELLED; Read was cancelled]");
    assert.equal(result.details.error.code, "CANCELLED");
  });
});

test("read measures the raw model-visible result", async () => {
  await withDirectory(async (directory) => {
    const source = '"'.repeat(40_960);
    await writeFile(join(directory, "quotes"), source, "utf8");
    const result = await execute(
      readModule.createCodexReadTool(),
      { path: "quotes", max_bytes: 40_960 },
      directory,
    );
    assert.ok(output(result).startsWith(`${source}\n\n[lines`));
    assert.ok(Buffer.byteLength(output(result)) < 48 * 1024);
    assert.equal(result.details.ok, true);
  });
});

test("read bounds generated model-visible errors", async () => {
  await withDirectory(async (directory) => {
    const result = await execute(readModule.createCodexReadTool(), {
      path: "missing",
      ["x".repeat(50_000)]: true,
    }, directory);
    assert.equal(output(result), "[read error: RESOURCE_LIMIT; The read result exceeds the 48-KiB result limit]");
    assert.equal(result.details.error.code, "RESOURCE_LIMIT");
  });
});

test("read metadata omits revisions", () => {
  const tool = readModule.createCodexReadTool();
  assert.equal("expected_revision" in tool.parameters.properties, false);
  assert.equal("show_line_numbers" in tool.parameters.properties, true);
  assert.doesNotMatch(tool.description, /revision/i);
  assert.doesNotMatch(JSON.stringify(tool.promptGuidelines), /revision/i);
  assert.match(tool.description, /bounded/);
  assert.match(tool.description, /Line ranges are inclusive/);
  assert.match(tool.description, /byte ranges are zero-based and half-open/);
  assert.match(JSON.stringify(tool.promptGuidelines), /show_line_numbers=true/);
  assert.match(JSON.stringify(tool.promptGuidelines), /cat -n/);
  assert.match(JSON.stringify(tool.promptGuidelines), /error\.byte_offset/);
});

test("read module resolves from the expected extension path", async () => {
  const path = fileURLToPath(new URL("../../extensions/codex-tools/read.ts", import.meta.url));
  const source = await readFile(path, "utf8");
  assert.match(source, /name: "read"/);
  assert.doesNotMatch(source, /createHash|REVISION_MISMATCH/);
});
