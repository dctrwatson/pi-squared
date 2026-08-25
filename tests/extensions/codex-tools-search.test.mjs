import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  createCodexFindTool,
  createCodexGrepTool,
  isComposableFindPathRecord,
  toSessionReadPath,
} from "../../extensions/codex-tools/search.ts";

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

async function execute(tool, input, cwd) {
  return tool.execute("tool-call", input, undefined, undefined, context(cwd));
}

async function withDirectory(callback) {
  const directory = await mkdtemp(join(tmpdir(), "pi-codex-search-test-"));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function findTool(results, onArtifactCreated) {
  return createCodexFindTool({
    onArtifactCreated,
    operations: {
      exists: () => true,
      glob: async (_pattern, searchRoot) => typeof results === "function" ? results(searchRoot) : results,
    },
  });
}

async function removeArtifact(details) {
  if (details?.artifact) await rm(dirname(details.artifact.path), { recursive: true, force: true });
}

async function writeExecutable(directory, name, source) {
  const executable = join(directory, name);
  await writeFile(executable, `#!/usr/bin/env bash\n${source}`, "utf8");
  await chmod(executable, 0o700);
  return executable;
}

test("search paths normalize to direct read inputs", async () => {
  await withDirectory(async (directory) => {
    const nested = join(directory, "nested");
    await mkdir(nested);
    const tool = findTool((searchRoot) => [join(searchRoot, "same.ts"), `${join(searchRoot, "folder")}/`]);

    const nestedResult = await execute(tool, { pattern: "*", path: "nested", limit: 10 }, directory);
    assert.equal(nestedResult.content[0].text, "nested/same.ts\nnested/folder/");

    const atResult = await execute(tool, { pattern: "*", path: "@nested", limit: 10 }, directory);
    assert.equal(atResult.content[0].text, "nested/same.ts\nnested/folder/");

    const rootResult = await execute(tool, { pattern: "*", limit: 10 }, directory);
    assert.equal(rootResult.content[0].text, "same.ts\nfolder/");
    assert.equal(toSessionReadPath(join(directory, "@source.ts"), directory, directory), "./@source.ts");
  });
});

test("find keeps outside results absolute", async () => {
  await withDirectory(async (directory) => {
    await withDirectory(async (outside) => {
      const tool = findTool((searchRoot) => [join(searchRoot, "result.ts")]);
      const result = await execute(tool, { pattern: "*", path: outside, limit: 10 }, directory);
      assert.equal(result.content[0].text, join(outside, "result.ts"));
    });
  });
});

test("small complete find output deletes its pre-created artifact", async () => {
  await withDirectory(async (directory) => {
    let artifact;
    const result = await execute(
      findTool(["one.ts"], (created) => { artifact = created; }),
      { pattern: "*", limit: 1 },
      directory,
    );
    assert.equal(result.content[0].text, "one.ts");
    assert.deepEqual(result.details, {
      ok: true,
      tool: "find",
      result_count: 1,
      shown_count: 1,
      preview: "complete",
      capture: "complete",
      read_paths: ["one.ts"],
    });
    await assert.rejects(stat(artifact.directory), { code: "ENOENT" });
  });
});

test("find result limits retain complete plain-text artifacts", async () => {
  await withDirectory(async (directory) => {
    const result = await execute(
      findTool(["one.ts", "two.ts"]),
      { pattern: "*", limit: 1 },
      directory,
    );
    try {
      assert.match(result.content[0].text, /^one\.ts\n\n\[find: results=1\/2; preview=truncated; capture=complete; artifact=/);
      assert.equal(result.details.result_limit, 1);
      assert.equal(result.details.artifact.capture, "complete");
      assert.equal(result.details.artifact.format, "text");
      assert.equal(await readFile(result.details.artifact.path, "utf8"), "one.ts\ntwo.ts");
      const metadata = JSON.parse(await readFile(result.details.artifact.metadata_path, "utf8"));
      assert.equal(metadata.capture, "complete");
      assert.equal(metadata.captured_records, 2);
      assert.equal((await stat(dirname(result.details.artifact.path))).mode & 0o777, 0o700);
      assert.equal((await stat(result.details.artifact.path)).mode & 0o777, 0o600);
    } finally {
      await removeArtifact(result.details);
    }
  });
});

test("find byte truncation retains every captured result", async () => {
  await withDirectory(async (directory) => {
    const nested = "n".repeat(200);
    const results = Array.from({ length: 1_000 }, (_, index) => `file-${String(index).padStart(4, "0")}.ts`);
    const result = await execute(findTool(results), { pattern: "*", path: nested, limit: 2_000 }, directory);
    try {
      assert.ok(Buffer.byteLength(result.content[0].text) <= 50 * 1024);
      assert.match(result.content[0].text, /\[find: results=\d+\/1000; preview=truncated; limit=50KiB; capture=complete; artifact=.*\/stdout\]$/);
      assert.equal(result.details.truncation.truncated, true);
      assert.equal(result.details.truncation.truncatedBy, "bytes");
      const artifactText = await readFile(result.details.artifact.path, "utf8");
      assert.match(artifactText, /file-0999\.ts$/);
      assert.equal(artifactText.split("\n").length, 1_000);
    } finally {
      await removeArtifact(result.details);
    }
  });
});

test("find marks line-protocol filename omissions as incomplete", async () => {
  await withDirectory(async (directory) => {
    const result = await execute(findTool(["normal.ts", " trailing "]), { pattern: "*" }, directory);
    try {
      assert.match(result.content[0].text, /^normal\.ts\n\n\[find: results=1\/1; preview=complete; capture=incomplete; artifact=/);
      assert.equal(result.details.capture, "incomplete");
      assert.equal(result.details.artifact.capture, "incomplete");
      assert.equal(await readFile(result.details.artifact.path, "utf8"), "normal.ts");
    } finally {
      await removeArtifact(result.details);
    }
  });
});

test("find rejects invalid paths and documents plain-line boundaries", async () => {
  await withDirectory(async (directory) => {
    const tool = findTool([]);
    for (const inputPath of ["", "@", "bad\0path", 12]) {
      const result = await execute(tool, { pattern: "*", path: inputPath }, directory);
      assert.equal(result.details.ok, false);
      assert.equal(result.details.tool, "find");
      assert.equal(result.details.error.code, "INVALID_INPUT");
      assert.match(result.details.error.message, /path must/);
    }
  });
  assert.equal(isComposableFindPathRecord("normal name.ts"), true);
  assert.equal(isComposableFindPathRecord("line\nfeed"), false);
  assert.equal(isComposableFindPathRecord(" leading"), false);
  assert.equal(isComposableFindPathRecord("trailing "), false);
  assert.equal(isComposableFindPathRecord("trailing\r"), false);
});

test("grep normalizes directory, file, and outside paths", async () => {
  await withDirectory(async (directory) => {
    const nested = join(directory, "nested");
    await mkdir(nested);
    await writeFile(join(nested, "source.ts"), "before\nneedle\nafter\n", "utf8");
    const tool = createCodexGrepTool();

    const directoryResult = await execute(
      tool,
      { pattern: "needle", path: "nested", literal: true, context: 1 },
      directory,
    );
    assert.equal(directoryResult.content[0].text, [
      "nested/source.ts",
      "1- before",
      "2: needle",
      "3- after",
    ].join("\n"));
    assert.deepEqual(directoryResult.details.read_paths, ["nested/source.ts"]);

    const fileResult = await execute(
      tool,
      { pattern: "needle", path: "nested/source.ts", literal: true },
      directory,
    );
    assert.equal(fileResult.content[0].text, "nested/source.ts\n2: needle");
    assert.deepEqual(fileResult.details.read_paths, ["nested/source.ts"]);

    await withDirectory(async (outside) => {
      const outsideFile = join(outside, "outside.ts");
      await writeFile(outsideFile, "needle\n", "utf8");
      const outsideResult = await execute(tool, { pattern: "needle", path: outsideFile }, directory);
      assert.equal(outsideResult.content[0].text, `${outsideFile}\n1: needle`);
      assert.deepEqual(outsideResult.details.read_paths, [outsideFile]);
    });
  });
});

test("grep preview groups matches under one heading per file", async () => {
  await withDirectory(async (directory) => {
    await mkdir(join(directory, "nested"));
    await writeFile(join(directory, "nested", "a.ts"), "needle one\nneedle two\n", "utf8");
    await writeFile(join(directory, "nested", "b.ts"), "needle three\n", "utf8");
    const result = await execute(
      createCodexGrepTool(),
      { pattern: "needle", path: "nested", literal: true, limit: 10 },
      directory,
    );
    assert.deepEqual(result.content[0].text.split("\n\n").sort(), [
      ["nested/a.ts", "1: needle one", "2: needle two"].join("\n"),
      ["nested/b.ts", "1: needle three"].join("\n"),
    ]);
    assert.equal(result.content[0].text.match(/nested\/a\.ts/g)?.length, 1);
    assert.equal(result.content[0].text.match(/nested\/b\.ts/g)?.length, 1);
    assert.deepEqual([...result.details.read_paths].sort(), ["nested/a.ts", "nested/b.ts"]);
  });
});

test("small complete grep output deletes its pre-created artifact", async () => {
  await withDirectory(async (directory) => {
    await writeFile(join(directory, "source.ts"), "needle\n", "utf8");
    let artifact;
    const tool = createCodexGrepTool({ onArtifactCreated: (created) => { artifact = created; } });
    const result = await execute(tool, { pattern: "needle", literal: true }, directory);
    assert.equal(result.content[0].text, "source.ts\n1: needle");
    assert.deepEqual(result.details.read_paths, ["source.ts"]);
    assert.equal(result.details.artifact, undefined);
    await assert.rejects(stat(artifact.directory), { code: "ENOENT" });
  });
});

test("grep requests heading-style output from rg", async () => {
  await withDirectory(async (directory) => {
    const executable = await writeExecutable(
      directory,
      "args-rg",
      "printf '%s\\n' \"$@\" > \"$(dirname \"$0\")/rg-args\"\nexit 1\n",
    );
    const result = await execute(createCodexGrepTool({ executable }), { pattern: "needle" }, directory);
    assert.equal(result.content[0].text, "No matches found");
    const args = (await readFile(join(directory, "rg-args"), "utf8")).split("\n");
    assert.ok(args.includes("--json"));
    assert.ok(args.includes("--heading"));
  });
});

test("grep reports invalid regular expressions with literal-search guidance", async () => {
  await withDirectory(async (directory) => {
    const executable = await writeExecutable(
      directory,
      "invalid-regex-rg",
      "printf '%s\\n' 'rg: regex parse error:' >&2\nprintf '%s\\n' '    (?:prepareArguments()' >&2\nprintf '%s\\n' '    ^' >&2\nprintf '%s\\n' 'error: unclosed group' >&2\nexit 2\n",
    );
    const result = await execute(
      createCodexGrepTool({ executable }),
      { pattern: "(?:prepareArguments()" },
      directory,
    );
    assert.equal(result.details.ok, false);
    assert.equal(result.details.tool, "grep");
    assert.equal(result.details.error.code, "INVALID_INPUT");
    assert.equal(
      result.details.error.message,
      "Invalid regular expression: unclosed group. Set literal to true to search exact text.",
    );
    assert.equal(
      result.content[0].text,
      "[grep error: INVALID_INPUT; Invalid regular expression: unclosed group. Set literal to true to search exact text.]",
    );
  });
});

test("grep match limits retain omitted matches in a complete artifact", async () => {
  await withDirectory(async (directory) => {
    await mkdir(join(directory, "nested"));
    await writeFile(join(directory, "nested", "source.ts"), "needle one\nneedle two\n", "utf8");
    const result = await execute(
      createCodexGrepTool(),
      { pattern: "needle", path: "nested", literal: true, limit: 1 },
      directory,
    );
    try {
      assert.match(result.content[0].text, /^nested\/source\.ts\n1: needle one\n\n\[grep: matches=1\/2; preview=truncated; capture=complete; artifact=/);
      assert.equal(result.content[0].text.match(/nested\/source\.ts/g)?.length, 1);
      assert.equal(result.details.match_limit, 1);
      assert.equal(result.details.artifact.capture, "complete");
      assert.equal(
        await readFile(result.details.artifact.path, "utf8"),
        "nested/source.ts:1: needle one\nnested/source.ts:2: needle two",
      );
    } finally {
      await removeArtifact(result.details);
    }
  });
});

test("grep long-line truncation exposes the complete line artifact", async () => {
  await withDirectory(async (directory) => {
    const longLine = `needle ${"x".repeat(700)}`;
    await writeFile(join(directory, "source.ts"), `${longLine}\n`, "utf8");
    const result = await execute(createCodexGrepTool(), { pattern: "needle", literal: true }, directory);
    try {
      assert.match(result.content[0].text, /\[grep: matches=1\/1; preview=truncated; lines_truncated=true; capture=complete; artifact=.*\/stdout\]$/);
      assert.equal(result.details.lines_truncated, true);
      assert.equal(result.details.artifact.capture, "complete");
      assert.equal(await readFile(result.details.artifact.path, "utf8"), `source.ts:1: ${longLine}`);
    } finally {
      await removeArtifact(result.details);
    }
  });
});

test("grep byte truncation retains every captured match", async () => {
  await withDirectory(async (directory) => {
    const lines = Array.from({ length: 200 }, (_, index) => `needle-${String(index).padStart(3, "0")}-${"x".repeat(350)}`);
    await writeFile(join(directory, "source.ts"), `${lines.join("\n")}\n`, "utf8");
    const result = await execute(
      createCodexGrepTool(),
      { pattern: "needle", literal: true, limit: 500 },
      directory,
    );
    try {
      assert.ok(Buffer.byteLength(result.content[0].text) <= 50 * 1024);
      assert.match(result.content[0].text, /\[grep: matches=\d+\/200; preview=truncated; limit=50KiB; capture=complete; artifact=.*\/stdout\]$/);
      assert.equal(result.details.truncation.truncatedBy, "bytes");
      const artifactText = await readFile(result.details.artifact.path, "utf8");
      assert.match(artifactText, /source\.ts:200: needle-199-/);
      assert.equal(artifactText.split("\n").length, 200);
    } finally {
      await removeArtifact(result.details);
    }
  });
});

test("find retains records captured before an fd failure", async () => {
  await withDirectory(async (directory) => {
    const executable = await writeExecutable(directory, "fake-fd", "printf 'one.ts\\0'\nprintf 'walk failed' >&2\nexit 2\n");
    const result = await execute(createCodexFindTool({ executable }), { pattern: "*" }, directory);
    try {
      assert.match(result.content[0].text, /^one\.ts\n\n\[find: results=1\/1; preview=complete; capture=incomplete; artifact=/);
      assert.equal(result.details.capture, "incomplete");
      assert.equal(await readFile(result.details.artifact.path, "utf8"), "one.ts");
      const metadata = JSON.parse(await readFile(result.details.artifact.metadata_path, "utf8"));
      assert.match(metadata.capture_error, /walk failed/);
    } finally {
      await removeArtifact(result.details);
    }
  });
});

test("grep retains matches captured before an rg failure", async () => {
  await withDirectory(async (directory) => {
    const event = JSON.stringify({
      type: "match",
      data: { path: { text: "source.ts" }, lines: { text: "needle\n" }, line_number: 1 },
    });
    const executable = await writeExecutable(
      directory,
      "fake-rg",
      `printf '%s\\n' '${event}'\nprintf 'read failed' >&2\nexit 2\n`,
    );
    const result = await execute(createCodexGrepTool({ executable }), { pattern: "needle" }, directory);
    try {
      assert.match(result.content[0].text, /^source\.ts\n1: needle\n\n\[grep: matches=1\/1; preview=complete; capture=incomplete; artifact=/);
      assert.equal(result.details.capture, "incomplete");
      assert.equal(await readFile(result.details.artifact.path, "utf8"), "source.ts:1: needle");
      const metadata = JSON.parse(await readFile(result.details.artifact.metadata_path, "utf8"));
      assert.match(metadata.capture_error, /read failed/);
    } finally {
      await removeArtifact(result.details);
    }
  });
});

test("grep marks malformed protocol output as incomplete", async () => {
  await withDirectory(async (directory) => {
    const executable = await writeExecutable(directory, "bad-rg", "printf 'null\\n'\n");
    const result = await execute(createCodexGrepTool({ executable }), { pattern: "needle" }, directory);
    try {
      assert.match(result.content[0].text, /^\[grep: matches=0\/0; preview=complete; capture=incomplete; artifact=/);
      assert.equal(result.details.capture, "incomplete");
      const metadata = JSON.parse(await readFile(result.details.artifact.metadata_path, "utf8"));
      assert.equal(metadata.malformed_records, 1);
    } finally {
      await removeArtifact(result.details);
    }
  });
});

test("grep cancellation waits for the child and removes its artifact", async () => {
  await withDirectory(async (directory) => {
    const executable = await writeExecutable(directory, "slow-rg", "trap 'exit 0' TERM\nsleep 10\n");
    const controller = new AbortController();
    let artifact;
    const tool = createCodexGrepTool({
      executable,
      onArtifactCreated: (created) => {
        artifact = created;
        controller.abort();
      },
    });
    const result = await tool.execute("tool-call", { pattern: "needle" }, controller.signal, undefined, context(directory));
    assert.equal(result.details.ok, false);
    assert.equal(result.details.tool, "grep");
    assert.equal(result.details.error.code, "CANCELLED");
    await assert.rejects(stat(artifact.directory), { code: "ENOENT" });
  });
});

test("search wrappers expose snake_case schemas and rendering hooks", () => {
  const find = createCodexFindTool();
  const grep = createCodexGrepTool();

  assert.equal(find.name, "find");
  assert.equal(grep.name, "grep");
  assert.equal(find.parameters.properties.limit.description, "Maximum number of results; default: 1000");
  assert.equal(grep.parameters.properties.limit.description, "Maximum number of matches to return; default: 100");
  assert.equal(grep.parameters.properties.ignore_case.type, "boolean");
  assert.equal("ignoreCase" in grep.parameters.properties, false);
  assert.equal(typeof find.renderCall, "function");
  assert.equal(typeof find.renderResult, "function");
  assert.equal(typeof grep.renderCall, "function");
  assert.equal(typeof grep.renderResult, "function");
  assert.match(find.description, /directly reusable by read/);
  assert.match(find.description, /plain-text artifact/);
  assert.match(grep.description, /passed directly to read/);
  assert.match(grep.description, /plain-text artifact/);
  assert.match(grep.description, /capped at 500 characters/);
  assert.match(grep.promptSnippet, /grouped under paths/);
});

test("search renderers retain truncation warnings from snake_case details", () => {
  const theme = { fg: (_color, text) => text, bold: (text) => text };
  const context = { lastComponent: undefined, showImages: false };
  const find = createCodexFindTool();
  const findResult = find.renderResult(
    {
      content: [{ type: "text", text: "one.ts" }],
      details: {
        ok: true,
        tool: "find",
        result_count: 2,
        shown_count: 1,
        preview: "truncated",
        capture: "complete",
        read_paths: ["one.ts"],
        result_limit: 1,
      },
    },
    { expanded: false, isPartial: false },
    theme,
    context,
  ).render(200).join("\n");
  assert.match(findResult, /Truncated: 1 results limit/);

  const grep = createCodexGrepTool();
  const grepResult = grep.renderResult(
    {
      content: [{ type: "text", text: "source.ts\n1: needle" }],
      details: {
        ok: true,
        tool: "grep",
        result_count: 2,
        shown_count: 1,
        preview: "truncated",
        capture: "complete",
        read_paths: ["source.ts"],
        match_limit: 1,
        lines_truncated: true,
      },
    },
    { expanded: false, isPartial: false },
    theme,
    context,
  ).render(200).join("\n");
  assert.match(grepResult, /Truncated: 1 matches limit, some lines truncated/);
});
