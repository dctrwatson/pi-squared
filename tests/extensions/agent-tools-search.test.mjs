import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { accessSync, constants } from "node:fs";
import { spawnSync } from "node:child_process";
import { validateToolArguments } from "@earendil-works/pi-ai";

import {
  createAgentFindTool,
  createAgentGrepTool,
  isComposableFindPathRecord,
  toSessionReadPath,
} from "../../extensions/agent-tools/search.ts";


function nativeExecutable(names) {
  for (const entry of (process.env.PATH ?? "").split(delimiter)) {
    for (const name of names) {
      const executable = join(entry || ".", name);
      try {
        accessSync(executable, constants.X_OK);
        return executable;
      } catch { /* Check the next PATH entry. */ }
    }
  }
}

const nativeRg = nativeExecutable(["rg"]);
const nativeFd = nativeExecutable(["fd", "fdfind"]);

function grepTool(options = {}) {
  return createAgentGrepTool({ executable: nativeRg ?? "/missing/offline-rg", ...options });
}

function nativeTest(name, callback) {
  return test(name, { skip: !nativeRg && "rg is not installed" }, callback);
}

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
  const directory = await mkdtemp(join(tmpdir(), "pi-agent-search-test-"));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function findTool(results, onArtifactCreated) {
  return createAgentFindTool({
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
      assert.match(result.content[0].text, /^normal\.ts\n\n\[find: results=1\/1; preview=complete; capture=incomplete; counts=lower_bounds; artifact=/);
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

nativeTest("grep normalizes directory, file, and outside paths", async () => {
  await withDirectory(async (directory) => {
    const nested = join(directory, "nested");
    await mkdir(nested);
    await writeFile(join(nested, "source.ts"), "before\nneedle\nafter\n", "utf8");
    const tool = grepTool();

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

nativeTest("grep preview groups matches under one heading per file", async () => {
  await withDirectory(async (directory) => {
    await mkdir(join(directory, "nested"));
    await writeFile(join(directory, "nested", "a.ts"), "needle one\nneedle two\n", "utf8");
    await writeFile(join(directory, "nested", "b.ts"), "needle three\n", "utf8");
    const result = await execute(
      grepTool(),
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

nativeTest("small complete grep output deletes its pre-created artifact", async () => {
  await withDirectory(async (directory) => {
    await writeFile(join(directory, "source.ts"), "needle\n", "utf8");
    let artifact;
    const tool = grepTool({ onArtifactCreated: (created) => { artifact = created; } });
    const result = await execute(tool, { pattern: "needle", literal: true }, directory);
    assert.equal(result.content[0].text, "source.ts\n1: needle");
    assert.deepEqual(result.details.read_paths, ["source.ts"]);
    assert.equal(result.details.artifact, undefined);
    await assert.rejects(stat(artifact.directory), { code: "ENOENT" });
  });
});

test("grep requests native content output from rg", async () => {
  await withDirectory(async (directory) => {
    const executable = await writeExecutable(
      directory,
      "args-rg",
      "printf '%s\\n' \"$@\" > \"$(dirname \"$0\")/rg-args\"\nexit 1\n",
    );
    const result = await execute(grepTool({ executable }), { pattern: "needle" }, directory);
    assert.equal(result.content[0].text, "No matches found");
    const args = (await readFile(join(directory, "rg-args"), "utf8")).split("\n");
    assert.ok(args.includes("--json"));
    assert.ok(args.includes("--line-number"));
    assert.ok(args.includes("--no-config"));
    assert.ok(!args.includes("--heading"));
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
      grepTool({ executable }),
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

nativeTest("grep match limits retain omitted matches in a complete artifact", async () => {
  await withDirectory(async (directory) => {
    await mkdir(join(directory, "nested"));
    await writeFile(join(directory, "nested", "source.ts"), "needle one\nneedle two\n", "utf8");
    const result = await execute(
      grepTool(),
      { pattern: "needle", path: "nested", literal: true, limit: 1 },
      directory,
    );
    try {
      assert.match(result.content[0].text, /^nested\/source\.ts\n1: needle one\n\n\[grep: mode=content; matches=1\/2; preview=truncated; capture=complete; artifact=/);
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

nativeTest("grep long-line truncation exposes the complete line artifact", async () => {
  await withDirectory(async (directory) => {
    const longLine = `needle ${"x".repeat(700)}`;
    await writeFile(join(directory, "source.ts"), `${longLine}\n`, "utf8");
    const result = await execute(grepTool(), { pattern: "needle", literal: true }, directory);
    try {
      assert.match(result.content[0].text, /\[grep: mode=content; matches=1\/1; preview=truncated; lines_truncated=true; capture=complete; artifact=.*\/stdout\]$/);
      assert.equal(result.details.lines_truncated, true);
      assert.equal(result.details.artifact.capture, "complete");
      assert.equal(await readFile(result.details.artifact.path, "utf8"), `source.ts:1: ${longLine}`);
    } finally {
      await removeArtifact(result.details);
    }
  });
});

nativeTest("grep byte truncation retains every captured match", async () => {
  await withDirectory(async (directory) => {
    const lines = Array.from({ length: 200 }, (_, index) => `needle-${String(index).padStart(3, "0")}-${"x".repeat(350)}`);
    await writeFile(join(directory, "source.ts"), `${lines.join("\n")}\n`, "utf8");
    const result = await execute(
      grepTool(),
      { pattern: "needle", literal: true, limit: 500 },
      directory,
    );
    try {
      assert.ok(Buffer.byteLength(result.content[0].text) <= 50 * 1024);
      assert.match(result.content[0].text, /\[grep: mode=content; matches=\d+\/200; preview=truncated; limit=50KiB; capture=complete; artifact=.*\/stdout\]$/);
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
    const result = await execute(createAgentFindTool({ executable }), { pattern: "*" }, directory);
    try {
      assert.match(result.content[0].text, /^one\.ts\n\n\[find: results=1\/1; preview=complete; capture=incomplete; counts=lower_bounds; artifact=/);
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
    const result = await execute(grepTool({ executable }), { pattern: "needle" }, directory);
    try {
      assert.match(result.content[0].text, /^source\.ts\n1: needle\n\n\[grep: mode=content; matches=1\/1; preview=complete; capture=incomplete; counts=lower_bounds; artifact=/);
      assert.equal(result.details.capture, "incomplete");
      assert.equal(await readFile(result.details.artifact.path, "utf8"), "source.ts:1: needle");
      const metadata = JSON.parse(await readFile(result.details.artifact.metadata_path, "utf8"));
      assert.match(metadata.capture_error, /read failed/);
    } finally {
      await removeArtifact(result.details);
    }
  });
});

test("grep rejects malformed protocol without useful records", async () => {
  await withDirectory(async (directory) => {
    let artifact;
    const executable = await writeExecutable(directory, "bad-rg", "printf 'null\\n'\n");
    const result = await execute(grepTool({ executable, onArtifactCreated: (created) => { artifact = created; } }), { pattern: "needle" }, directory);
    assert.equal(result.details.ok, false);
    assert.equal(result.details.error.code, "SEARCH_FAILED");
    assert.match(result.details.error.message, /Malformed search protocol/);
    await assert.rejects(stat(artifact.directory), { code: "ENOENT" });
  });
});

test("grep cancellation waits for the child and removes its artifact", async () => {
  await withDirectory(async (directory) => {
    const executable = await writeExecutable(directory, "slow-rg", "trap 'exit 0' TERM\nsleep 10\n");
    const controller = new AbortController();
    let artifact;
    const tool = grepTool({
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
  const find = createAgentFindTool();
  const grep = grepTool();

  assert.equal(find.name, "find");
  assert.equal(grep.name, "grep");
  assert.equal(find.parameters.properties.limit.description, "Preview limit (default: 100)");
  assert.equal(grep.parameters.properties.limit.description, "Preview limit (content: 50; files/count: 100); not valid for exists");
  assert.equal(grep.parameters.properties.ignore_case.type, "boolean");
  assert.equal("ignoreCase" in grep.parameters.properties, false);
  assert.equal(typeof find.renderCall, "function");
  assert.equal(typeof find.renderResult, "function");
  assert.equal(typeof grep.renderCall, "function");
  assert.equal(typeof grep.renderResult, "function");
  assert.match(find.description, /Regular-file results work with read/);
  assert.match(find.description, /plain-text artifact/);
  assert.match(grep.description, /paths usable by read/);
  assert.match(grep.description, /plain-text artifact/);
  assert.match(find.description, /Preview cap: 50 KiB/);
  assert.match(grep.description, /Preview cap: 50 KiB; line cap: 500 characters/);
  assert.match(grep.promptSnippet, /regex or literal/);
});

test("search renderers retain truncation warnings from snake_case details", () => {
  const theme = { fg: (_color, text) => text, bold: (text) => text };
  const context = { lastComponent: undefined, showImages: false };
  const find = createAgentFindTool();
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

  const grep = grepTool();
  const grepResult = grep.renderResult(
    {
      content: [{ type: "text", text: "source.ts\n1: needle" }],
      details: {
        ok: true,
        tool: "grep",
        mode: "content",
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

nativeTest("grep modes count matching lines and keep compact file output", async () => {
  await withDirectory(async (directory) => {
    await writeFile(join(directory, "a.ts"), "target target\nother\ntarget\n");
    await writeFile(join(directory, "b.ts"), "target\n");
    await writeFile(join(directory, "c.ts"), "other\n");
    const tool = grepTool();
    const content = await execute(tool, { pattern: "target" }, directory);
    assert.equal(content.details.mode, "content");
    assert.equal(content.details.result_count, 3);
    assert.equal(content.details.shown_count, 3);
    assert.deepEqual([...content.details.read_paths].sort(), ["a.ts", "b.ts"]);
    const files = await execute(tool, { pattern: "target", mode: "files" }, directory);
    assert.equal(files.content[0].text, "a.ts\nb.ts");
    assert.equal(files.details.result_count, 2);
    assert.equal(files.details.artifact, undefined);
    const count = await execute(tool, { pattern: "target", mode: "count" }, directory);
    assert.equal(count.content[0].text, "2\ta.ts\n1\tb.ts\n\n[grep: mode=count; files=2/2; matching_lines=3; preview=complete; capture=complete]");
    assert.deepEqual(count.details.counts, [{ path: "a.ts", matching_lines: 2 }, { path: "b.ts", matching_lines: 1 }]);
    assert.equal(count.details.total_matching_lines, 3);
    assert.equal(count.details.captured_matching_lines, 3);
    assert.equal(count.details.artifact, undefined);
    const exists = await execute(tool, { pattern: "target", mode: "exists" }, directory);
    assert.equal(exists.content[0].text, "[grep: mode=exists; exists=true; termination=match; capture=complete]");
    assert.equal(exists.details.result_count, 1);
    assert.equal(exists.details.exists, true);
    assert.deepEqual(exists.details.read_paths, []);
    for (const mode of ["content", "files", "count", "exists"]) {
      const missing = await execute(tool, { pattern: "absent", mode }, directory);
      assert.equal(missing.details.ok, true);
      assert.equal(missing.details.mode, mode);
      assert.equal(missing.details.result_count, 0);
      if (mode === "count") {
        assert.equal(missing.details.total_matching_lines, 0);
        assert.deepEqual(missing.details.counts, []);
        assert.equal(missing.content[0].text, "[grep: mode=count; files=0/0; matching_lines=0; preview=complete; capture=complete]");
      } else if (mode === "exists") {
        assert.equal(missing.details.exists, false);
        assert.equal(missing.content[0].text, "[grep: mode=exists; exists=false; termination=eof; capture=complete]");
      } else assert.equal(missing.content[0].text, "No matches found");
    }
    const empty = await execute(tool, { pattern: "", mode: "count" }, directory);
    assert.equal(empty.details.total_matching_lines, 5);
  });
});

test("grep files/count use native flags, root-relative targets, and complete artifacts", async () => {
  await withDirectory(async (directory) => {
    await mkdir(join(directory, "nested"));
    await writeFile(join(directory, "nested", "explicit.ts"), "target\n");
    for (const mode of ["files", "count"]) {
      const wire = mode === "files" ? "b.ts\\x00a.ts\\x00./a.ts\\x00" : "b.ts\\x001\\na.ts\\x002\\n";
      const executable = await writeExecutable(directory, `args-${mode}`, `printf '%s\\n' "$PWD" > "$(dirname "$0")/cwd-${mode}"\nprintf '%s\\n' "$@" > "$(dirname "$0")/args-${mode}.txt"\nprintf '${wire}'\n`);
      const result = await execute(grepTool({ executable }), { pattern: "target", mode, path: "nested", glob: "*.ts", literal: true, ignore_case: true, limit: 1 }, directory);
      try {
        assert.equal(result.details.result_count, 2);
        assert.equal(result.details.shown_count, 1);
        assert.equal(result.details.capture, "complete");
        assert.equal(result.details.preview, "truncated");
        assert.deepEqual(result.details.read_paths, ["nested/a.ts"]);
        assert.match(result.content[0].text, new RegExp(`mode=${mode}; files=1/2;`));
        assert.equal(await readFile(result.details.artifact.path, "utf8"), mode === "files" ? "nested/a.ts\nnested/b.ts" : "2\tnested/a.ts\n1\tnested/b.ts");
        if (mode === "count") {
          assert.equal(result.details.total_matching_lines, 3);
          assert.deepEqual(result.details.counts, [{ path: "nested/a.ts", matching_lines: 2 }]);
        }
        const args = (await readFile(join(directory, `args-${mode}.txt`), "utf8")).trimEnd().split("\n");
        assert.ok(args.includes(mode === "files" ? "--files-with-matches" : "--count"));
        assert.ok(args.includes("--null"));
        assert.ok(args.includes("--with-filename"));
        assert.ok(args.includes("--no-config"));
        assert.ok(args.includes("--ignore-case"));
        assert.ok(args.includes("--fixed-strings"));
        assert.ok(!args.includes("--json"));
        assert.ok(!args.includes("--max-count"));
        assert.deepEqual(args.slice(args.indexOf("--glob"), args.indexOf("--")), ["--glob", "*.ts", "--glob", "!**/.git/**", "--glob", "!**/node_modules/**"]);
        assert.deepEqual(args.slice(-3), ["--", "target", "."]);
        assert.equal((await readFile(join(directory, `cwd-${mode}`), "utf8")).trimEnd(), await realpath(join(directory, "nested")));
      } finally { await removeArtifact(result.details); }
      const explicit = await execute(grepTool({ executable }), { pattern: "target", mode, path: "nested/explicit.ts", include_ignored: true }, directory);
      try {
        const args = (await readFile(join(directory, `args-${mode}.txt`), "utf8")).trimEnd().split("\n");
        assert.ok(!args.includes("--glob"));
        assert.ok(args.includes("--no-ignore"));
        assert.deepEqual(args.slice(-3), ["--", "target", "explicit.ts"]);
      } finally { await removeArtifact(explicit.details); }
    }
  });
});

test("count parses split NUL records and colons in paths", async () => {
  await withDirectory(async (directory) => {
    const executable = await writeExecutable(directory, "split-count", "printf 'a:part.ts\\x00'\nsleep 0.03\nprintf '2\\n'\nprintf 'a.ts\\x00'\nsleep 0.03\nprintf '1\\n'\n");
    const result = await execute(grepTool({ executable }), { pattern: "target", mode: "count" }, directory);
    assert.equal(result.details.total_matching_lines, 3);
    assert.deepEqual(result.details.counts, [{ path: "a.ts", matching_lines: 1 }, { path: "a:part.ts", matching_lines: 2 }]);
    assert.match(result.content[0].text, /^1\ta\.ts\n2\ta:part\.ts\n/);
  });
});

test("files parse split UTF-8 paths and deduplicate normalized paths", async () => {
  await withDirectory(async (directory) => {
    const executable = await writeExecutable(directory, "split-files", "printf 'z.ts\\x00caf\\303'\nsleep 0.03\nprintf '\\251.ts\\x00./z.ts\\x00'\n");
    const result = await execute(grepTool({ executable }), { pattern: "target", mode: "files" }, directory);
    assert.equal(result.details.result_count, 2);
    assert.equal(result.content[0].text, "café.ts\nz.ts");
  });
});

test("count rejects malformed numeric and duplicate records without exact totals", async () => {
  await withDirectory(async (directory) => {
    for (const bad of ["x", "-1", "1.2", "9007199254740992", "", "0", "1\\r", "\\262"]) {
      for (const useful of [false, true]) {
        const prefix = useful ? "printf 'good.ts\\x002\\n'\n" : "";
        const executable = await writeExecutable(directory, "bad-count", `${prefix}printf 'bad.ts\\x00${bad}\\n'\n`);
        const result = await execute(grepTool({ executable }), { pattern: "target", mode: "count" }, directory);
        try {
          if (!useful) {
            assert.equal(result.details.ok, false, bad);
            assert.equal(result.details.error.code, "SEARCH_FAILED");
          } else {
            assert.equal(result.details.ok, true, bad);
            assert.equal(result.details.capture, "incomplete");
            assert.equal(result.details.total_matching_lines, null);
            assert.equal(result.details.captured_matching_lines, 2);
            assert.match(result.content[0].text, /matching_lines=unknown; captured_matching_lines=2;/);
            assert.match(result.content[0].text, /counts=lower_bounds;/);
            assert.match(result.content[0].text, /search_error=Malformed search protocol:/);
            assert.equal(await readFile(result.details.artifact.path, "utf8"), "2\tgood.ts");
          }
        } finally { await removeArtifact(result.details); }
      }
    }
    for (const wire of ["a.ts\\x002\\n./a.ts\\x003\\n", "a.ts\\x009007199254740991\\nb.ts\\x001\\n"]) {
      const executable = await writeExecutable(directory, "duplicate-count", `printf '${wire}'\n`);
      const result = await execute(grepTool({ executable }), { pattern: "target", mode: "count" }, directory);
      try {
        assert.equal(result.details.capture, "incomplete");
        assert.equal(result.details.result_count, 1);
        assert.equal(result.details.total_matching_lines, null);
        const metadata = JSON.parse(await readFile(result.details.artifact.metadata_path, "utf8"));
        assert.equal(metadata.malformed_records, 1);
      } finally { await removeArtifact(result.details); }
    }
  });
});

test("grep modes keep useful records after native errors and expose search_error", async () => {
  await withDirectory(async (directory) => {
    const event = JSON.stringify({ type: "match", data: { path: { text: "a.ts" }, lines: { text: "target\n" }, line_number: 1 } });
    for (const mode of ["content", "files", "count"]) {
      const output = mode === "content" ? `printf '%s\\n' '${event}'` : `printf '${mode === "files" ? "a.ts\\x00" : "a.ts\\x002\\n"}'`;
      const executable = await writeExecutable(directory, `partial-${mode}`, `${output}\nprintf 'read failed\\n' >&2\nexit 2\n`);
      const result = await execute(grepTool({ executable }), { pattern: "target", mode }, directory);
      try {
        assert.equal(result.details.ok, true);
        assert.equal(result.details.capture, "incomplete");
        assert.equal(result.details.result_count, 1);
        assert.match(result.content[0].text, /search_error=read failed/);
        assert.match(result.content[0].text, /counts=lower_bounds/);
        const metadata = JSON.parse(await readFile(result.details.artifact.metadata_path, "utf8"));
        assert.equal(metadata.capture_error, "read failed");
        if (mode === "count") {
          assert.equal(result.details.total_matching_lines, null);
          assert.equal(result.details.captured_matching_lines, 2);
        }
      } finally { await removeArtifact(result.details); }
    }
  });
});

test("exists reports only native 0/1 witnesses and never creates an artifact", async () => {
  await withDirectory(async (directory) => {
    for (const ending of ["exit 0", "exit 1", "exit 2", "kill -TERM $$"]) {
      let created = 0;
      const executable = await writeExecutable(directory, "quiet-rg", `printf '%s\\n' "$@" > "$(dirname "$0")/quiet-args"\nprintf 'not a protocol record\\n'\nprintf 'native diagnostic\\n' >&2\n${ending}\n`);
      const result = await execute(grepTool({ executable, onArtifactCreated: () => { created += 1; } }), { pattern: "target", mode: "exists" }, directory);
      assert.equal(created, 0);
      assert.equal(result.details.artifact, undefined);
      const args = (await readFile(join(directory, "quiet-args"), "utf8")).split("\n");
      assert.ok(args.includes("--quiet"));
      for (const flag of ["--json", "--count", "--files-with-matches", "--null"]) assert.ok(!args.includes(flag));
      if (ending === "exit 0" || ending === "exit 1") {
        assert.equal(result.details.ok, true);
        assert.equal(result.details.exists, ending === "exit 0");
        assert.equal(result.details.termination, ending === "exit 0" ? "match" : "eof");
        assert.deepEqual(result.details.read_paths, []);
      } else {
        assert.equal(result.details.ok, false);
        assert.equal(result.details.error.code, "SEARCH_FAILED");
        assert.equal(result.details.exists, undefined);
      }
    }
    const failedSpawn = await execute(grepTool({ executable: join(directory, "absent-rg") }), { pattern: "target", mode: "exists" }, directory);
    assert.equal(failedSpawn.details.ok, false);
    assert.equal(failedSpawn.details.error.code, "SEARCH_FAILED");
    assert.equal(failedSpawn.details.exists, undefined);
  });
});

test("search validates modes, limits, context, unknown inputs, and optional nulls", async () => {
  await withDirectory(async (directory) => {
    const executable = await writeExecutable(directory, "no-match-rg", "exit 1\n");
    const grep = grepTool({ executable });
    const find = findTool([]);
    for (const [tool, invalid] of [
      [grep, { mode: "other" }], [grep, { mode: 1 }], [grep, { include_ignored: 1 }],
      [find, { include_ignored: "true" }], [grep, { surprise: null }], [find, { surprise: null }],
      [grep, { limit: 1.5 }], [find, { limit: 1.5 }], [grep, { context: 0.5 }],
      [grep, { mode: "exists", limit: 1 }],
      ...["files", "count", "exists"].map((mode) => [grep, { mode, context: 1 }]),
    ]) {
      const input = { pattern: "target", ...invalid };
      const original = structuredClone(input);
      assert.throws(() => tool.prepareArguments(input));
      const result = await execute(tool, input, directory);
      assert.equal(result.details.ok, false, JSON.stringify(input));
      assert.equal(result.details.error.code, "INVALID_INPUT");
      assert.deepEqual(input, original);
    }
    const nullable = { pattern: "target", mode: null, path: null, glob: null, literal: null, ignore_case: null, context: null, limit: null, include_ignored: null };
    const original = structuredClone(nullable);
    const prepared = grep.prepareArguments(nullable);
    assert.deepEqual(validateToolArguments(grep, { name: "grep", arguments: prepared }), { pattern: "target" });
    const result = await execute(grep, nullable, directory);
    assert.equal(result.details.ok, true);
    assert.equal(result.details.mode, "content");
    assert.deepEqual(nullable, original);
    for (const mode of ["files", "count", "exists"]) {
      const result = await execute(grep, { pattern: "target", mode, context: 0, limit: mode === "exists" ? null : undefined }, directory);
      assert.equal(result.details.ok, true);
    }
    for (const tool of [grep, createAgentFindTool({ executable: nativeFd ?? executable })]) {
      const result = await execute(tool, { pattern: "target", path: "absent" }, directory);
      assert.equal(result.details.ok, false);
      assert.equal(result.details.error.code, "SEARCH_FAILED");
    }
  });
});

nativeTest("grep preserves regex, literal, ignore_case, and glob semantics in every mode", async () => {
  await withDirectory(async (directory) => {
    await writeFile(join(directory, "a.ts"), "TARGET.foo\n");
    await writeFile(join(directory, "b.txt"), "targetXfoo\n");
    for (const mode of ["content", "files", "count", "exists"]) {
      const regex = await execute(grepTool(), { pattern: "target.foo", mode, ignore_case: true }, directory);
      assert.equal(regex.details.result_count, mode === "exists" ? 1 : 2);
      const literal = await execute(grepTool(), { pattern: "target.foo", mode, ignore_case: true, literal: true }, directory);
      assert.equal(literal.details.result_count, 1);
      const glob = await execute(grepTool(), { pattern: "target.foo", mode, ignore_case: true, glob: "*.ts" }, directory);
      assert.equal(glob.details.result_count, 1);
      const invalid = await execute(grepTool(), { pattern: "(", mode }, directory);
      assert.equal(invalid.details.ok, false);
      assert.equal(invalid.details.error.code, "INVALID_INPUT");
      const validLiteral = await execute(grepTool(), { pattern: "(", mode, literal: true }, directory);
      assert.equal(validLiteral.details.ok, true);
    }
  });
});

test("injected find receives exhaustive limits and the shared exclusion table", async () => {
  await withDirectory(async (directory) => {
    for (const include_ignored of [false, true]) {
      let captured;
      const tool = createAgentFindTool({ operations: {
        exists: () => true,
        glob: async (_pattern, _root, options) => { captured = options; return []; },
      } });
      const result = await execute(tool, { pattern: "*", include_ignored, limit: 1 }, directory);
      assert.equal(result.details.ok, true);
      assert.deepEqual(captured, { ignore: ["**/.git/**", ...(include_ignored ? [] : ["**/node_modules/**"])], limit: Number.MAX_SAFE_INTEGER });
    }
    const result = await execute(findTool(Array.from({ length: 101 }, (_, index) => `f${index}.ts`)), { pattern: "*" }, directory);
    try {
      assert.equal(result.details.result_count, 101);
      assert.equal(result.details.shown_count, 100);
      assert.equal(result.details.result_limit, 100);
      assert.equal((await readFile(result.details.artifact.path, "utf8")).split("\n").length, 101);
    } finally { await removeArtifact(result.details); }
  });
});

nativeTest("grep uses fixed 50-content and 100-files/count defaults", async () => {
  await withDirectory(async (directory) => {
    await Promise.all(Array.from({ length: 101 }, (_, index) => writeFile(join(directory, `f${String(index).padStart(3, "0")}.ts`), "target\n")));
    for (const mode of ["content", "files", "count"]) {
      const result = await execute(grepTool(), { pattern: "target", mode }, directory);
      try {
        assert.equal(result.details.result_count, 101);
        assert.equal(result.details.shown_count, mode === "content" ? 50 : 100);
        assert.equal(result.details.capture, "complete");
        assert.equal((await readFile(result.details.artifact.path, "utf8")).split("\n").length, 101);
        if (mode === "count") assert.equal(result.details.total_matching_lines, 101);
      } finally { await removeArtifact(result.details); }
    }
  });
});
async function withEnvironment(values, callback) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("real fd and every rg mode follow the ignore-rule table", { skip: (!nativeRg || !nativeFd) && "fd and rg must be installed" }, async () => {
  await withDirectory(async (directory) => {
    const root = join(directory, "repo");
    const home = join(directory, "home");
    const xdg = join(directory, "config");
    await mkdir(root);
    await mkdir(home);
    await mkdir(xdg);
    const globalIgnore = join(home, "global-ignore");
    await writeFile(globalIgnore, "global.txt\n");
    const gitConfig = join(home, ".gitconfig");
    await writeFile(gitConfig, `[core]\n\texcludesFile = ${globalIgnore}\n`);
    const rgConfig = join(home, "rgconfig");
    await writeFile(rgConfig, "--files-with-matches\n--max-count=1\n--glob=!*.txt\n");
    await withEnvironment({
      HOME: home, XDG_CONFIG_HOME: xdg,
      GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_SYSTEM: join(home, "no-system-config"),
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "0", GIT_CONFIG_PARAMETERS: undefined,
      RIPGREP_CONFIG_PATH: rgConfig,
    }, async () => {
      const initialized = spawnSync("git", ["init", "--quiet", root], { encoding: "utf8" });
      assert.equal(initialized.status, 0, initialized.stderr);
      const names = ["plain.txt", ".hidden/h.txt", "ignored.txt", ".hidden/ignored.txt", "ignore-rule.txt", "rg-only.txt", "fd-only.txt", "global.txt", "node_modules/n.txt", ".git/meta.txt", "nested/node_modules/n.txt", "nested/.git/meta.txt"];
      for (const name of names) {
        await mkdir(dirname(join(root, name)), { recursive: true });
        await writeFile(join(root, name), `marker witness:${name}\n`);
      }
      await writeFile(join(root, ".gitignore"), "ignored.txt\nnode_modules/\n");
      await writeFile(join(root, ".ignore"), "ignore-rule.txt\n");
      await writeFile(join(root, ".rgignore"), "rg-only.txt\n");
      await writeFile(join(root, ".fdignore"), "fd-only.txt\n");
      for (const include_ignored of [false, true]) {
        const allExpected = names.filter((name) => !name.includes(".git/"));
        const expectedGrep = (include_ignored ? allExpected : ["plain.txt", ".hidden/h.txt", "fd-only.txt"]).sort();
        const expectedFind = (include_ignored ? allExpected : ["plain.txt", ".hidden/h.txt", "rg-only.txt"]).sort();
        const find = await execute(createAgentFindTool({ executable: nativeFd }), { pattern: "*.txt", include_ignored }, root);
        assert.equal(find.details.ok, true, find.content[0].text);
        assert.deepEqual([...find.details.read_paths].sort(), expectedFind);
        for (const mode of ["content", "files", "count", "exists"]) {
          const result = await execute(grepTool(), { pattern: "marker", mode, include_ignored }, root);
          assert.equal(result.details.ok, true, result.content[0].text);
          if (mode !== "exists") {
            assert.deepEqual([...result.details.read_paths].sort(), expectedGrep, `${mode}, include_ignored=${include_ignored}`);
            assert.equal(result.details.result_count, expectedGrep.length);
            if (mode === "count") assert.equal(result.details.total_matching_lines, expectedGrep.length);
          } else {
            for (const name of names) {
              const witness = await execute(grepTool(), { pattern: `witness:${name}`, literal: true, mode, include_ignored }, root);
              assert.equal(witness.details.exists, expectedGrep.includes(name), `exists ${name}, include_ignored=${include_ignored}`);
            }
          }
        }
        const positiveGlobExpected = allExpected.filter((name) => include_ignored || !name.includes("node_modules/")).sort();
        for (const mode of ["content", "files", "count", "exists"]) {
          const positiveGlob = await execute(grepTool(), { pattern: mode === "exists" ? "witness:.git/meta.txt" : "marker", literal: true, mode, include_ignored, glob: "*.txt" }, root);
          assert.equal(positiveGlob.details.ok, true, positiveGlob.content[0].text);
          if (mode === "exists") assert.equal(positiveGlob.details.exists, false);
          else assert.deepEqual([...positiveGlob.details.read_paths].sort(), positiveGlobExpected);
        }
        for (const explicitRoot of [".git", "node_modules", "nested/.git", "nested/node_modules"]) {
          const expected = [`${explicitRoot}/${explicitRoot.endsWith(".git") ? "meta.txt" : "n.txt"}`];
          const findRoot = await execute(createAgentFindTool({ executable: nativeFd }), { pattern: "*.txt", path: explicitRoot, include_ignored }, root);
          assert.equal(findRoot.details.ok, true, findRoot.content[0].text);
          assert.deepEqual(findRoot.details.read_paths, expected);
          for (const mode of ["content", "files", "count", "exists"]) {
            const grepRoot = await execute(grepTool(), { pattern: "marker", path: explicitRoot, mode, include_ignored }, root);
            assert.equal(grepRoot.details.ok, true, grepRoot.content[0].text);
            if (mode === "exists") assert.equal(grepRoot.details.exists, true);
            else assert.deepEqual(grepRoot.details.read_paths, expected, `${mode}, ${explicitRoot}, include_ignored=${include_ignored}`);
          }
        }
        for (const name of ["ignored.txt", ".git/meta.txt", "node_modules/n.txt", "global.txt"]) {
          for (const mode of ["content", "files", "count", "exists"]) {
            const file = await execute(grepTool(), { pattern: "marker", path: name, mode, include_ignored }, root);
            assert.equal(file.details.ok, true, file.content[0].text);
            assert.equal(file.details.result_count, 1, `${mode}, explicit ${name}`);
            if (mode !== "exists") assert.deepEqual(file.details.read_paths, [name]);
          }
        }
      }
      const outside = join(directory, "outside");
      await mkdir(outside);
      await writeFile(join(outside, ".gitignore"), "ignored.txt\n");
      await writeFile(join(outside, "ignored.txt"), "marker\n");
      await writeFile(join(outside, "plain.txt"), "marker\n");
      const find = await execute(createAgentFindTool({ executable: nativeFd }), { pattern: "*.txt" }, outside);
      assert.deepEqual(find.details.read_paths, ["plain.txt"]);
    });
  });
});

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function nodeExecutable(directory, name, source) {
  const script = join(directory, `${name}.mjs`);
  await writeFile(script, source);
  return writeExecutable(directory, name, `exec ${shellQuote(process.execPath)} ${shellQuote(script)}\n`);
}

test("unsupported native and normalized paths are omitted in all record modes", async () => {
  await withDirectory(async (directory) => {
    for (const mode of ["content", "files", "count"]) {
      for (const useful of [false, true]) {
        const paths = ["line\nfeed.ts", "carriage\rreturn.ts", " trailing ", "./ leading.ts", Buffer.from([255, 46, 116, 115])];
        if (useful) paths.unshift("good.ts");
        const output = paths.map((name) => {
          const bytes = Buffer.isBuffer(name) ? name : Buffer.from(name);
          if (mode === "content") return Buffer.from(JSON.stringify({ type: "match", data: { path: { bytes: bytes.toString("base64") }, lines: { text: "target\n" }, line_number: 1 } }) + "\n");
          return Buffer.concat([bytes, Buffer.from(mode === "count" ? "\0" + "2\n" : "\0")]);
        });
        const executable = await nodeExecutable(directory, "unsupported-rg", `process.stdout.write(Buffer.from(${JSON.stringify(Buffer.concat(output).toString("base64"))}, "base64"));\n`);
        const result = await execute(grepTool({ executable }), { pattern: "target", mode }, directory);
        try {
          assert.equal(result.details.ok, true, result.content[0].text);
          assert.equal(result.details.capture, "incomplete");
          assert.equal(result.details.result_count, useful ? 1 : 0);
          assert.equal(result.details.shown_count, useful ? 1 : 0);
          assert.equal(result.details.preview, "complete");
          assert.deepEqual(result.details.read_paths, useful ? ["good.ts"] : []);
          assert.match(result.content[0].text, /capture=incomplete; counts=lower_bounds;/);
          assert.notEqual(result.content[0].text, "No matches found");
          const metadata = JSON.parse(await readFile(result.details.artifact.metadata_path, "utf8"));
          assert.equal(metadata.unsupported_records, 5);
          assert.equal(await readFile(result.details.artifact.path, "utf8"), useful ? mode === "content" ? "good.ts:1: target" : mode === "count" ? "2\tgood.ts" : "good.ts" : "");
          if (mode === "count") {
            assert.equal(result.details.total_matching_lines, null);
            assert.equal(result.details.captured_matching_lines, useful ? 2 : 0);
            assert.match(result.content[0].text, /matching_lines=unknown;/);
          }
        } finally { await removeArtifact(result.details); }
      }
    }
    const executable = await nodeExecutable(directory, "unsupported-fd", 'process.stdout.write(Buffer.from("good.ts\\0line\\nfeed.ts\\0./ leading.ts\\0"));\n');
    const result = await execute(createAgentFindTool({ executable }), { pattern: "*" }, directory);
    try {
      assert.deepEqual(result.details.read_paths, ["good.ts"]);
      assert.equal(result.details.capture, "incomplete");
      assert.match(result.content[0].text, /counts=lower_bounds/);
    } finally { await removeArtifact(result.details); }
  });
});

test("files/count preserve whole records under the 51200-byte preview cap", async () => {
  await withDirectory(async (directory) => {
    const paths = Array.from({ length: 180 }, (_, index) => `${String(index).padStart(3, "0")}-${"é".repeat(180)}.ts`);
    for (const mode of ["files", "count"]) {
      const output = paths.map((name) => mode === "files" ? name + "\0" : name + "\0" + "2\n").join("");
      const executable = await nodeExecutable(directory, "byte-cap-rg", `process.stdout.write(Buffer.from(${JSON.stringify(Buffer.from(output).toString("base64"))}, "base64"));\n`);
      const result = await execute(grepTool({ executable }), { pattern: "target", mode, limit: 1_000 }, directory);
      try {
        assert.equal(result.details.result_count, 180);
        assert.ok(result.details.shown_count > 0 && result.details.shown_count < 180);
        assert.ok(Buffer.byteLength(result.content[0].text) <= 51_200);
        assert.equal(result.details.truncation.lastLinePartial, false);
        assert.equal(result.details.capture, "complete");
        assert.equal(await readFile(result.details.artifact.path, "utf8"), paths.map((name) => mode === "count" ? `2\t${name}` : name).join("\n"));
        if (mode === "count") {
          assert.equal(result.details.total_matching_lines, 360);
          assert.equal(result.details.counts.length, result.details.shown_count);
        }
      } finally { await removeArtifact(result.details); }
      const huge = "a".repeat(52_000);
      const wire = huge + (mode === "files" ? "\0" : "\0" + "2\n");
      const hugeExecutable = await nodeExecutable(directory, "huge-record-rg", `process.stdout.write(Buffer.from(${JSON.stringify(Buffer.from(wire).toString("base64"))}, "base64"));\n`);
      const hugeResult = await execute(grepTool({ executable: hugeExecutable }), { pattern: "target", mode }, directory);
      try {
        assert.equal(hugeResult.details.result_count, 1);
        assert.equal(hugeResult.details.shown_count, 0);
        assert.deepEqual(hugeResult.details.read_paths, []);
        assert.ok(Buffer.byteLength(hugeResult.content[0].text) <= 51_200);
        assert.equal(await readFile(hugeResult.details.artifact.path, "utf8"), mode === "files" ? huge : `2\t${huge}`);
      } finally { await removeArtifact(hugeResult.details); }
    }
  });
});

test("all byte protocols stop at the 64-MiB capture bound, including pending data", async () => {
  await withDirectory(async (directory) => {
    for (const mode of ["find", "content", "files", "count"]) {
      const first = mode === "content" ? JSON.stringify({ type: "match", data: { path: { text: "good.ts" }, lines: { text: "target\n" }, line_number: 1 } }) + "\n"
        : mode === "count" ? "good.ts\0" + "2\n" : "good.ts\0";
      const executable = await nodeExecutable(directory, "capture-cap", `process.stdout.on("error", () => process.exit(0));\nprocess.stdout.write(Buffer.from(${JSON.stringify(first)}));\nconst chunk = Buffer.alloc(1024 * 1024, 120);\nfor (let index = 0; index < 66; index += 1) {\n  if (!process.stdout.write(chunk)) await new Promise((resolve) => process.stdout.once("drain", resolve));\n}\n`);
      const tool = mode === "find" ? createAgentFindTool({ executable }) : grepTool({ executable });
      const result = await execute(tool, { pattern: "target", ...(mode === "find" ? {} : { mode }) }, directory);
      try {
        assert.equal(result.details.ok, true, result.content[0].text);
        assert.equal(result.details.capture, "incomplete");
        assert.equal(result.details.result_count, 1);
        assert.ok(Buffer.byteLength(result.content[0].text) <= 51_200);
        assert.ok(result.details.artifact.captured_bytes <= 64 * 1024 * 1024);
        const metadata = JSON.parse(await readFile(result.details.artifact.metadata_path, "utf8"));
        assert.equal(metadata.capture_limit_reached, true);
        if (mode === "count") assert.equal(result.details.total_matching_lines, null);
      } finally { await removeArtifact(result.details); }
    }
  });
});

test("malformed unfinished protocols fail empty captures and retain useful records", async () => {
  await withDirectory(async (directory) => {
    for (const mode of ["content", "files", "count"]) {
      const first = mode === "content" ? JSON.stringify({ type: "match", data: { path: { text: "good.ts" }, lines: { text: "target\n" }, line_number: 1 } }) + "\n"
        : mode === "count" ? "good.ts\0" + "2\n" : "good.ts\0";
      for (const useful of [false, true]) {
        const wire = (useful ? first : "") + (mode === "count" ? "bad.ts\0" : "unfinished");
        const executable = await nodeExecutable(directory, "unfinished-rg", `process.stdout.write(Buffer.from(${JSON.stringify(wire)}));\n`);
        const result = await execute(grepTool({ executable }), { pattern: "target", mode }, directory);
        try {
          assert.equal(result.details.ok, useful);
          if (useful) {
            assert.equal(result.details.capture, "incomplete");
            assert.match(result.content[0].text, /search_error=Malformed search protocol: unfinished record/);
          } else assert.equal(result.details.error.code, "SEARCH_FAILED");
        } finally { await removeArtifact(result.details); }
      }
    }
  });
});

test("search cancellation after spawn waits for cleanup in all modes", async () => {
  await withDirectory(async (directory) => {
    for (const mode of ["find", "content", "files", "count", "exists"]) {
      const ready = join(directory, `ready-${mode}`);
      const executable = await nodeExecutable(directory, "cancel-search", `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(ready)}, "ready");\nsetInterval(() => {}, 1000);\n`);
      const controller = new AbortController();
      let artifact;
      const options = { executable, onArtifactCreated: (created) => { artifact = created; } };
      const tool = mode === "find" ? createAgentFindTool(options) : grepTool(options);
      const pending = tool.execute("call", { pattern: "target", ...(mode === "find" ? {} : { mode }) }, controller.signal, undefined, context(directory));
      try {
        const deadline = Date.now() + 5_000;
        while (true) {
          try { await stat(ready); break; } catch { /* Wait for the child marker. */ }
          if (Date.now() > deadline) throw new Error("Search child did not start");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      } finally { controller.abort(); }
      const result = await pending;
      assert.equal(result.details.ok, false);
      assert.equal(result.details.error.code, "CANCELLED");
      if (mode === "exists") assert.equal(artifact, undefined);
      else await assert.rejects(stat(artifact.directory), { code: "ENOENT" });
    }
  });
});

test("search artifact errors fail and remove temporary artifacts", async () => {
  await withDirectory(async (directory) => {
    for (const mode of ["content", "files", "count"]) {
      for (const creationFailure of [false, true]) {
        let artifact;
        const executable = await writeExecutable(directory, "artifact-rg", "exit 1\n");
        const tool = grepTool({ executable, onArtifactCreated: (created) => {
          artifact = created;
          if (creationFailure) throw new Error("artifact callback failed");
          created.stdout_path = created.directory;
        } });
        const result = await execute(tool, { pattern: "target", mode }, directory);
        assert.equal(result.details.ok, false);
        assert.equal(result.details.error.code, "ARTIFACT_FAILED");
        await assert.rejects(stat(artifact.directory), { code: "ENOENT" });
      }
    }
  });
});

test("files/count/exists use short text result renderers", () => {
  const theme = { fg: (_color, text) => text, bold: (text) => text };
  const ctx = { lastComponent: undefined, showImages: false };
  for (const mode of ["files", "count", "exists"]) {
    const text = mode === "files" ? "a.ts\nb.ts" : mode === "count" ? "2\ta.ts\n[grep: mode=count]" : "[grep: mode=exists; exists=true; termination=match; capture=complete]";
    const rendered = grepTool().renderResult({ content: [{ type: "text", text }], details: { ok: true, tool: "grep", mode } }, { expanded: false, isPartial: false }, theme, ctx).render(200).join("\n");
    assert.ok(rendered.includes(mode === "files" ? "a.ts" : `[grep: mode=${mode}`));
    assert.doesNotMatch(rendered, /matches limit|some lines truncated/);
  }
});

nativeTest("native unsupported names remain omitted while exists retains its witness", async () => {
  await withDirectory(async (directory) => {
    const names = ["line\nfeed.ts", "carriage\rreturn.ts", " leading.ts", "trailing.ts ", "\ufeffbom.ts"];
    for (const name of names) await writeFile(join(directory, name), "target\n");
    try {
      await writeFile(Buffer.concat([Buffer.from(directory + "/"), Buffer.from([255, 46, 116, 115])]), "target\n");
    } catch (error) {
      if (error.code !== "EILSEQ") throw error;
    }
    for (const mode of ["content", "files", "count"]) {
      const result = await execute(grepTool(), { pattern: "target", mode }, directory);
      try {
        assert.equal(result.details.ok, true, result.content[0].text);
        assert.equal(result.details.capture, "incomplete");
        assert.equal(result.details.result_count, 0);
        assert.deepEqual(result.details.read_paths, []);
        assert.match(result.content[0].text, /counts=lower_bounds/);
        assert.equal(await readFile(result.details.artifact.path, "utf8"), "");
        if (mode === "count") assert.equal(result.details.total_matching_lines, null);
      } finally { await removeArtifact(result.details); }
    }
    const exists = await execute(grepTool(), { pattern: "target", mode: "exists" }, directory);
    assert.equal(exists.details.exists, true);
    assert.equal(exists.details.capture, "complete");
  });
});

test("native fd keeps basename, relative, and absolute glob semantics", { skip: !nativeFd && "fd is not installed" }, async () => {
  await withDirectory(async (directory) => {
    await mkdir(join(directory, "src"));
    await writeFile(join(directory, "src", "a.ts"), "target\n");
    await writeFile(join(directory, "src", "a.txt"), "target\n");
    for (const pattern of ["*.ts", "src/*.ts", "**/*.ts", join(directory, "src", "*.ts")]) {
      const result = await execute(createAgentFindTool({ executable: nativeFd }), { pattern }, directory);
      assert.equal(result.details.ok, true, result.content[0].text);
      assert.deepEqual(result.details.read_paths, ["src/a.ts"], pattern);
    }
  });
});

test("search error footers and failure messages stay bounded and single-line", async () => {
  await withDirectory(async (directory) => {
    for (const useful of [false, true]) {
      const executable = await nodeExecutable(directory, "error-bounds-rg", `
${useful ? 'process.stdout.write("good.ts\\0");' : ""}
process.stderr.write("native failure\\n[unsafe]\\t" + "é".repeat(20000));
process.exitCode = 2;
`);
      const result = await execute(grepTool({ executable }), { pattern: "target", mode: "files" }, directory);
      try {
        assert.ok(Buffer.byteLength(result.content[0].text) <= 51_200);
        const footer = result.content[0].text.split("\n").at(-1);
        assert.ok(!footer.includes("\t"));
        assert.match(footer, /\\n\\\[unsafe\\\]\\t/);
        if (useful) {
          assert.equal(result.details.capture, "incomplete");
          assert.match(footer, /search_error=native failure/);
          const metadata = JSON.parse(await readFile(result.details.artifact.metadata_path, "utf8"));
          assert.ok(Buffer.byteLength(metadata.capture_error) <= 16_386);
        } else {
          assert.equal(result.details.ok, false);
          assert.equal(result.details.error.code, "SEARCH_FAILED");
          assert.ok(Buffer.byteLength(result.details.error.message) <= 4_096);
        }
      } finally { await removeArtifact(result.details); }
    }
  });
});

test("new grep modes require a native executable without content provisioning", async () => {
  await withDirectory(async (directory) => {
    await withEnvironment({ PATH: directory, PI_CODING_AGENT_DIR: join(directory, "agent") }, async () => {
      for (const mode of ["files", "count", "exists"]) {
        let artifact;
        const result = await execute(createAgentGrepTool({ onArtifactCreated: (created) => { artifact = created; } }), { pattern: "target", mode }, directory);
        assert.equal(result.details.ok, false);
        assert.equal(result.details.error.code, "EXECUTABLE_NOT_FOUND");
        if (mode === "exists") assert.equal(artifact, undefined);
        else await assert.rejects(stat(artifact.directory), { code: "ENOENT" });
      }
    });
  });
});
