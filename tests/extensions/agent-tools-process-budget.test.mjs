import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtemp, chmod, readFile, rm, stat, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { createAgentBashTool } from "../../extensions/agent-tools/bash.ts";
import { createAgentGitTool } from "../../extensions/agent-tools/git.ts";
import { createAgentGhTool } from "../../extensions/agent-tools/gh.ts";
import { removeProcessArtifact } from "../../extensions/agent-tools/process-artifacts.ts";

const factories = { bash: createAgentBashTool, git: createAgentGitTool, gh: createAgentGhTool };
const context = (cwd) => ({ cwd, sessionManager: { getSessionId: () => "budget", getSessionFile: () => undefined } });

async function withProcess(name, source, callback, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "pi-process-budget-"));
  const savedPath = process.env.PATH;
  let artifact;
  try {
    const script = join(directory, "command.cjs");
    await writeFile(script, source);
    if (name !== "bash") {
      await writeFile(join(directory, name), `#!${process.execPath}\n${source}`);
      await chmod(join(directory, name), 0o755);
      process.env.PATH = `${directory}${delimiter}${savedPath ?? ""}`;
    }
    const tool = factories[name]({ onArtifactCreated: (created) => { artifact = created; options.onArtifactCreated?.(created); } });
    const input = name === "bash" ? { command: `"${process.execPath}" "${script}"` } : { args: ["budget"] };
    await callback({ tool, input, directory, artifact: () => artifact });
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    if (artifact) await removeProcessArtifact(artifact.directory);
    await rm(directory, { recursive: true, force: true });
  }
}

for (const [name, create] of Object.entries(factories)) {
  test(`${name} validates an integer whole-result budget without conversion or input mutation`, async () => {
    let allocations = 0;
    const tool = create({ onArtifactCreated: () => { allocations += 1; } });
    const required = name === "bash" ? { command: "true" } : { args: ["--version"] };
    const schema = tool.parameters.properties.max_output_bytes;
    assert.equal(schema.type, "integer");
    assert.equal(schema.minimum, 2048);
    assert.equal(schema.maximum, 40960);
    assert.match(schema.description, /default: 8192/);
    for (const value of [undefined, null]) {
      const input = { ...required, max_output_bytes: value };
      assert.deepEqual(tool.prepareArguments(input), required);
      assert.equal(input.max_output_bytes, value);
    }
    for (const value of [2048, 8192, 40960]) {
      const input = { ...required, max_output_bytes: value };
      assert.deepEqual(validateToolArguments(tool, {
        id: "budget", name, arguments: tool.prepareArguments(input),
      }), input);
      assert.equal(input.max_output_bytes, value);
    }
    for (const value of [2047, 40961, 2048.5, "8192", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      const input = { ...required, max_output_bytes: value };
      assert.throws(() => tool.prepareArguments(input), (error) => error.code === "INVALID_INPUT");
      const result = await tool.execute("invalid-budget", input, undefined, undefined, context(process.cwd()));
      assert.equal(result.isError, true);
      assert.equal(result.details.error.code, "INVALID_INPUT");
      assert.equal(result.details.process, undefined);
      assert.ok(Buffer.byteLength(result.content[0].text) <= 8192);
      assert.equal(input.max_output_bytes, value);
    }
    assert.equal(allocations, 0);
  });

  for (const budget of [2048, 8192, 40960]) {
    test(`${name} applies ${budget} bytes to progress and final text without changing raw capture`, async () => {
      const stdout = Buffer.from(`OUT_HEAD\n${"A".repeat(60000)}\nOUT_TAIL\n`);
      const stderr = Buffer.from(`ERR_HEAD\n${"B".repeat(60000)}\nERR_TAIL\n`);
      const source = `
const fs = require("node:fs");
fs.appendFileSync("executions", "once\\n");
fs.writeSync(1, Buffer.from(${JSON.stringify(stdout.toString("base64"))}, "base64"));
fs.writeSync(2, Buffer.from(${JSON.stringify(stderr.toString("base64"))}, "base64"));
process.exitCode = 1;
`;
      await withProcess(name, source, async ({ tool, input, directory }) => {
        const updates = [];
        const result = await tool.execute("whole-budget", { ...input, max_output_bytes: budget }, undefined,
          (update) => updates.push(update), context(directory));
        assert.equal(result.details.ok, true);
        assert.equal(result.details.exit_code, 1);
        assert.equal(result.details.cleanup, "complete");
        assert.equal(result.details.stdout.captured_raw_bytes, stdout.length);
        assert.equal(result.details.stderr.captured_raw_bytes, stderr.length);
        assert.ok(Buffer.byteLength(result.content[0].text) <= budget);
        assert.ok(updates.length > 0);
        assert.ok(updates.every((update) => Buffer.byteLength(update.content[0].text) <= budget));
        assert.match(result.content[0].text, /OUT_HEAD/);
        assert.match(result.content[0].text, /OUT_TAIL/);
        assert.match(result.content[0].text, /ERR_HEAD/);
        assert.match(result.content[0].text, /ERR_TAIL/);
        assert.ok(result.details.stdout.tail_preview_bytes >= 2 * result.details.stdout.head_preview_bytes);
        assert.ok(result.details.stderr.tail_preview_bytes >= 2 * result.details.stderr.head_preview_bytes);
        assert.deepEqual(await readFile(result.details.stdout.artifact), stdout);
        assert.deepEqual(await readFile(result.details.stderr.artifact), stderr);
        assert.equal(await readFile(join(directory, "executions"), "utf8"), "once\n");
      });
    });
  }

  test(`${name} retains exact malformed stream bytes in readable artifacts`, async () => {
    const stdout = Buffer.concat([Buffer.from("OUT_HEAD\n"), Buffer.alloc(30000, 0xff), Buffer.from("\nOUT_TAIL\n")]);
    const stderr = Buffer.concat([Buffer.from("ERR_HEAD\n"), Buffer.alloc(30000, 0xfe), Buffer.from("\nERR_TAIL\n")]);
    const source = `require("node:fs").writeSync(1, Buffer.from(${JSON.stringify(stdout.toString("base64"))}, "base64")); require("node:fs").writeSync(2, Buffer.from(${JSON.stringify(stderr.toString("base64"))}, "base64"));`;
    await withProcess(name, source, async ({ tool, input, directory }) => {
      const result = await tool.execute("binary-budget", { ...input, max_output_bytes: 2048 }, undefined, undefined, context(directory));
      assert.equal(result.details.exit_code, 0);
      assert.ok(Buffer.byteLength(result.content[0].text) <= 2048);
      assert.match(result.content[0].text, /�/);
      assert.deepEqual(await readFile(result.details.stdout.artifact), stdout);
      assert.deepEqual(await readFile(result.details.stderr.artifact), stderr);
    });
  });

  test(`${name} defaults null output budgets to 8192`, async () => {
    await withProcess(name, 'process.stdout.write("START\\n" + "x".repeat(50000) + "\\nFINAL_FAILURE\\n"); process.exitCode = 1;', async ({ tool, input, directory }) => {
      const result = await tool.execute("default-budget", { ...input, max_output_bytes: null }, undefined, undefined, context(directory));
      assert.equal(result.details.exit_code, 1);
      assert.match(result.content[0].text, /START/);
      assert.match(result.content[0].text, /FINAL_FAILURE/);
      assert.ok(Buffer.byteLength(result.content[0].text) <= 8192);
      assert.equal(await readFile(result.details.stdout.artifact, "utf8"), `START\n${"x".repeat(50000)}\nFINAL_FAILURE\n`);
    });
  });

  test(`${name} rejects long actual paths before opening streams or spawning`, async (t) => {
    const spawn = childProcess.spawn;
    let spawns = 0;
    t.mock.method(childProcess, "spawn", (...args) => { spawns += 1; return spawn(...args); });
    syncBuiltinESMExports();
    try {
      await withProcess(name, 'require("node:fs").writeFileSync("executed", "yes");', async ({ tool, input, directory, artifact }) => {
        const result = await tool.execute("preflight", { ...input, max_output_bytes: 2048 }, undefined, undefined, context(directory));
        assert.equal(result.isError, true);
        assert.equal(result.details.error.code, "RESULT_BUDGET_TOO_SMALL");
        assert.equal(result.details.process, undefined);
        assert.match(result.content[0].text, /the process did not run/);
        assert.ok(Buffer.byteLength(result.content[0].text) <= 2048);
        assert.equal(spawns, 0);
        await assert.rejects(stat(join(directory, "executed")), { code: "ENOENT" });
        await assert.rejects(stat(artifact().directory), { code: "ENOENT" });
      }, { onArtifactCreated: (created) => {
        created.stdout_path += "x".repeat(2048);
        created.stderr_path += "y".repeat(2048);
      } });
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });

  test(`${name} keeps readable evidence after an unexpected post-spawn formatter overflow`, async (t) => {
    const spawn = childProcess.spawn;
    let child;
    let spawns = 0;
    t.mock.method(childProcess, "spawn", (...args) => { spawns += 1; child = spawn(...args); return child; });
    syncBuiltinESMExports();
    try {
      await withProcess(name, 'require("node:fs").appendFileSync("executions", "once\\n"); process.stdout.write("READY\\n"); setInterval(() => {}, 1000);', async ({ tool, input, directory }) => {
        const abort = new AbortController();
        let injected = false;
        const result = await tool.execute("invariant", { ...input, max_output_bytes: 2048 }, abort.signal, (update) => {
          if (!injected && update.content[0].text.includes("READY")) {
            injected = true;
            child.emit("exit", null, "S".repeat(3000));
            abort.abort();
          }
        }, context(directory));
        assert.equal(injected, true);
        assert.equal(result.isError, true);
        assert.equal(result.details.error.code, "RESULT_BUDGET_TOO_SMALL");
        assert.match(result.content[0].text, /The process did run/);
        assert.ok(Buffer.byteLength(result.content[0].text) <= 2048);
        assert.equal(result.details.process.cleanup, "complete");
        assert.equal(result.details.process.stdout.captured_raw_bytes, 6);
        assert.equal(await readFile(result.details.process.stdout.artifact, "utf8"), "READY\n");
        assert.equal(await readFile(join(directory, "executions"), "utf8"), "once\n");
        assert.equal(spawns, 1);
        assert.throws(() => process.kill(-child.pid, 0), { code: "ESRCH" });
      });
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      if (child?.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
    }
  });
}
