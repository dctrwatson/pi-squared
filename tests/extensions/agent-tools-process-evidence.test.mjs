import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { WriteStream, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { createAgentBashTool } from "../../extensions/agent-tools/bash.ts";
import { createAgentGitTool } from "../../extensions/agent-tools/git.ts";
import { createAgentGhTool } from "../../extensions/agent-tools/gh.ts";
import {
  ARTIFACT_RETENTION_MS,
  completeProcessArtifact,
  createProcessArtifact,
  pinProcessArtifact,
  removeExpiredArtifacts,
  removeProcessArtifact,
  unpinProcessArtifact,
  writeProcessArtifactMetadata,
} from "../../extensions/agent-tools/process-artifacts.ts";
import { hasUnsuccessfulProcessStatus } from "../../extensions/agent-tools/tool-render.ts";

const factories = { bash: createAgentBashTool, git: createAgentGitTool, gh: createAgentGhTool };
const context = (cwd) => ({
  cwd,
  sessionManager: { getSessionId: () => "evidence", getSessionFile: () => undefined },
});

async function withProcess(name, source, callback) {
  const cwd = await fs.mkdtemp(join(tmpdir(), "pi-process-evidence-"));
  const script = join(cwd, "command.cjs");
  const oldPath = process.env.PATH;
  let artifact;
  try {
    await fs.writeFile(script, source);
    if (name !== "bash") {
      await fs.writeFile(join(cwd, name), `#!${process.execPath}\n${source}`);
      await fs.chmod(join(cwd, name), 0o755);
      process.env.PATH = `${cwd}${delimiter}${oldPath ?? ""}`;
    }
    const tool = factories[name]({ onArtifactCreated: (created) => { artifact = created; }, cleanupLimitMs: 500 });
    const input = name === "bash" ? { command: `"${process.execPath}" "${script}"` } : { args: ["evidence"] };
    await callback({ cwd, tool, input, artifact: () => artifact });
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (artifact) {
      unpinProcessArtifact(artifact.directory);
      await removeProcessArtifact(artifact.directory);
    }
    await fs.rm(cwd, { recursive: true, force: true });
  }
}

for (const name of Object.keys(factories)) {
  test(`${name} returns plain cancellation before spawn and allocates no artifact`, async () => {
    await withProcess(name, 'process.stdout.write("NOT_RUN");', async ({ cwd, tool, input, artifact }) => {
      const abort = new AbortController();
      abort.abort();
      const result = await tool.execute("before-spawn", input, abort.signal, undefined, context(cwd));
      assert.equal(result.isError, true);
      assert.equal(result.details.error.code, "CANCELLED");
      assert.equal(result.details.process, undefined);
      assert.equal(artifact(), undefined);
    });
  });

  for (const stream of ["stdout", "stderr"]) {
    test(`${name} retains ${stream} evidence at the capture ceiling without a second execution`, async () => {
      await withProcess(name, `
const fs = require("node:fs");
fs.appendFileSync("executions", "once\\n");
fs.writeSync(${stream === "stdout" ? 1 : 2}, "BEFORE_STOP\\n");
const data = Buffer.alloc(65536, 65);
for (let i = 0; i < 1025; i++) fs.writeSync(${stream === "stdout" ? 1 : 2}, data);
`, async ({ cwd, tool, input }) => {
        const result = await tool.execute("limit", input, undefined, undefined, context(cwd));
        assert.equal(result.isError, true);
        assert.equal(result.details.ok, false);
        assert.equal(result.details.error.code, "OUTPUT_LIMIT");
        const process = result.details.process;
        assert.equal(process.stop_reason, "output_limit");
        assert.equal(process.cleanup, "complete");
        assert.equal(process[stream].capture, "incomplete");
        assert.equal(process[stream].captured_raw_bytes, 67_108_864);
        assert.equal((await fs.stat(process[stream].artifact)).size, 67_108_864);
        const file = await fs.open(process[stream].artifact, "r");
        try {
          const prefix = Buffer.alloc(12);
          await file.read(prefix, 0, 12, 0);
          assert.equal(prefix.toString(), "BEFORE_STOP\n");
        } finally { await file.close(); }
        assert.match(result.content[0].text, /BEFORE_STOP/);
        assert.equal(await fs.readFile(join(cwd, "executions"), "utf8"), "once\n");
        assert.equal("ok" in process, false);
        assert.equal("tool" in process, false);
        assert.equal(hasUnsuccessfulProcessStatus(result.details), true);
        assert.ok(Buffer.byteLength(result.content[0].text) <= 8192);
      });
    });
  }

  test(`${name} retains output after cancellation and publishes only live stream paths`, async () => {
    await withProcess(name, 'process.stdout.write("BEFORE_CANCEL\\n"); setInterval(() => {}, 1000);', async ({ cwd, tool, input }) => {
      const abort = new AbortController();
      const updates = [];
      const result = await tool.execute("cancel", input, abort.signal, (update) => {
        updates.push(update);
        if (update.content[0].text.includes("BEFORE_CANCEL")) abort.abort();
      }, context(cwd));
      assert.equal(result.isError, true);
      assert.equal(result.details.error.code, "CANCELLED");
      assert.equal(result.details.process.stop_reason, "cancelled");
      assert.equal(result.details.process.cleanup, "complete");
      assert.equal(result.details.process.stdout.capture, "incomplete");
      assert.equal(await fs.readFile(result.details.process.stdout.artifact, "utf8"), "BEFORE_CANCEL\n");
      assert.match(result.content[0].text, /BEFORE_CANCEL/);
      assert.ok(updates.length > 0);
      for (const update of updates) {
        assert.equal(update.details.artifact, undefined);
        assert.equal(update.details.cleanup, "pending");
        assert.equal(update.details.exit_code, null);
        assert.equal(typeof update.details.stdout.artifact, "string");
        await fs.stat(update.details.stdout.artifact);
      }
    });
  });

  test(`${name} reports saved-byte mismatch after a file-write failure`, async (t) => {
    await withProcess(name, 'process.stdout.write("BEFORE_WRITE\\n"); setTimeout(() => process.stdout.write("X".repeat(20000)), 80);', async ({ cwd, tool, input }) => {
      const write = WriteStream.prototype.write;
      t.mock.method(WriteStream.prototype, "write", function (data, ...args) {
        if (String(this.path).endsWith("/stdout") && data.includes(88)) throw new Error("injected file-write failure");
        return write.call(this, data, ...args);
      });
      const result = await tool.execute("write", input, undefined, undefined, context(cwd));
      assert.equal(result.isError, true);
      assert.equal(result.details.error.code, "ARTIFACT_FAILED");
      const process = result.details.process;
      assert.equal(process.stop_reason, "artifact_failed");
      assert.equal(process.cleanup, "complete");
      assert.equal(process.stdout.capture, "incomplete");
      assert.equal(process.stdout.saved_raw_bytes, 13);
      assert.ok(process.stdout.captured_raw_bytes > process.stdout.saved_raw_bytes);
      assert.equal(await fs.readFile(process.stdout.artifact, "utf8"), "BEFORE_WRITE\n");
      assert.match(result.content[0].text, /saved_raw_bytes=13/);
      assert.match(result.content[0].text, /BEFORE_WRITE/);
    });
  });

  test(`${name} omits an unreadable file path but keeps its memory preview`, async (t) => {
    await withProcess(name, 'process.stdout.write("BEFORE_WRITE\\n"); setTimeout(() => process.stdout.write("X".repeat(20000)), 80);', async ({ cwd, tool, input }) => {
      const write = WriteStream.prototype.write;
      t.mock.method(WriteStream.prototype, "write", function (data, ...args) {
        if (String(this.path).endsWith("/stdout") && data.includes(88)) {
          this.destroy();
          throw new Error("injected file loss");
        }
        return write.call(this, data, ...args);
      });
      const open = fs.open;
      t.mock.method(fs, "open", (path, ...args) => {
        if (String(path).endsWith("/stdout")) throw new Error("injected unreadable file");
        return open(path, ...args);
      });
      syncBuiltinESMExports();
      let result;
      try {
        result = await tool.execute("unreadable", input, undefined, undefined, context(cwd));
      } finally {
        t.mock.restoreAll();
        syncBuiltinESMExports();
      }
      assert.equal(result.details.error.code, "ARTIFACT_FAILED");
      assert.equal(result.details.process.cleanup, "complete");
      assert.equal(result.details.process.stdout.artifact, undefined);
      assert.equal(result.details.process.stdout.saved_raw_bytes, undefined);
      assert.equal(result.details.process.stdout.capture, "incomplete");
      assert.equal(result.details.process.artifact, undefined);
      assert.match(result.content[0].text, /BEFORE_WRITE/);
    });
  });

  test(`${name} retains readable paths and complete capture after metadata failure`, async (t) => {
    await withProcess(name, 'process.stdout.write("M".repeat(20000));', async ({ cwd, tool, input, artifact }) => {
      const writeFile = fs.writeFile;
      t.mock.method(fs, "writeFile", (path, ...args) => {
        if (String(path).endsWith("/metadata.json")) throw new Error("injected metadata-write failure");
        return writeFile(path, ...args);
      });
      syncBuiltinESMExports();
      let result;
      try {
        result = await tool.execute("metadata", input, undefined, undefined, context(cwd));
      } finally {
        t.mock.restoreAll();
        syncBuiltinESMExports();
      }
      assert.equal(result.isError, true);
      assert.equal(result.details.error.code, "ARTIFACT_FAILED");
      const process = result.details.process;
      assert.equal(process.cleanup, "complete");
      assert.equal(process.stdout.capture, "complete");
      assert.equal(process.artifact, undefined);
      assert.equal((await fs.stat(process.stdout.artifact)).size, 20000);
      const stat = fs.stat;
      const directory = artifact().directory;
      const oldMtime = Date.now() - ARTIFACT_RETENTION_MS - 1000;
      let oldStatReads = 0;
      t.mock.method(fs, "stat", async (path, ...args) => {
        const info = await stat(path, ...args);
        if (path === directory) {
          oldStatReads += 1;
          info.mtimeMs = oldMtime;
        }
        return info;
      });
      syncBuiltinESMExports();
      try {
        assert.equal((await fs.stat(directory)).mtimeMs, oldMtime);
        await removeExpiredArtifacts();
        assert.equal(oldStatReads, 1);
        await stat(process.stdout.artifact);
        assert.ok((await stat(directory)).mtimeMs > oldMtime);
      } finally {
        t.mock.restoreAll();
        syncBuiltinESMExports();
      }
    });
  });

  test(`${name} retains capture evidence after a pipe failure`, async (t) => {
    const spawn = childProcess.spawn;
    t.mock.method(childProcess, "spawn", (...args) => {
      const child = spawn(...args);
      child.stdout.once("data", () => child.stdout.emit("error", new Error("injected capture failure")));
      return child;
    });
    syncBuiltinESMExports();
    try {
      await withProcess(name, 'process.stdout.write("BEFORE_CAPTURE\\n"); setInterval(() => {}, 1000);', async ({ cwd, tool, input }) => {
        const result = await tool.execute("capture", input, undefined, undefined, context(cwd));
        assert.equal(result.details.error.code, "CAPTURE_FAILED");
        assert.equal(result.details.process.stop_reason, "capture_failed");
        assert.equal(result.details.process.cleanup, "complete");
        assert.equal(result.details.process.stdout.capture, "incomplete");
        assert.match(result.content[0].text, /BEFORE_CAPTURE/);
        assert.equal(await fs.readFile(result.details.process.stdout.artifact, "utf8"), "BEFORE_CAPTURE\n");
      });
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });

  test(`${name} does not claim complete cleanup after a process-group signal failure`, async (t) => {
    const kill = process.kill;
    let group;
    t.mock.method(process, "kill", (pid, signal) => {
      if (pid < 0 && (signal === "SIGTERM" || signal === "SIGKILL")) {
        group = -pid;
        throw Object.assign(new Error("injected group signal failure"), { code: "EPERM" });
      }
      return kill(pid, signal);
    });
    try {
      await withProcess(name, 'process.stdout.write("BEFORE_CANCEL\\n"); setInterval(() => {}, 1000);', async ({ cwd, tool, input }) => {
        const abort = new AbortController();
        const result = await tool.execute("control", input, abort.signal, (update) => {
          if (update.content[0].text.includes("BEFORE_CANCEL")) abort.abort();
        }, context(cwd));
        assert.equal(result.isError, true);
        assert.equal(result.details.error.code, "PROCESS_CONTROL_FAILED");
        assert.equal(result.details.process.stop_reason, "cancelled");
        assert.equal(result.details.process.cleanup, "failed");
        assert.equal(result.details.process.exit_code, null);
        assert.equal(result.details.process.artifact, undefined);
        assert.match(result.content[0].text, /first stop: CANCELLED/);
        assert.equal(await fs.readFile(result.details.process.stdout.artifact, "utf8"), "BEFORE_CANCEL\n");
        assert.doesNotThrow(() => kill(-group, 0));
      });
    } finally {
      t.mock.restoreAll();
      if (group) { try { kill(-group, "SIGKILL"); } catch {} }
    }
  });
}

test("artifact expiry starts at completion and does not remove live pins", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "pi-artifact-expiry-test-"));
  const artifact = await createProcessArtifact(root);
  pinProcessArtifact(artifact.directory);
  const creationExpiry = artifact.expires_at;
  try {
    const now = Date.now() + 1000;
    const old = new Date(now - ARTIFACT_RETENTION_MS - 1000);
    await fs.utimes(artifact.directory, old, old);
    await removeExpiredArtifacts(now, root);
    await fs.stat(artifact.directory);
    const completed = await completeProcessArtifact(artifact, now, { test: true });
    assert.notEqual(completed, artifact);
    assert.equal(artifact.expires_at, creationExpiry);
    assert.ok(completed.expires_at > creationExpiry);
    assert.equal(completed.expires_at, now + 604_800_000);
    assert.equal(JSON.parse(await fs.readFile(completed.metadata_path, "utf8")).expires_at, completed.expires_at);
    assert.ok(Math.abs((await fs.stat(artifact.directory)).mtimeMs - now) < 1);
    await removeExpiredArtifacts(completed.expires_at - 1, root);
    await fs.stat(artifact.directory);
    const stat = fs.stat;
    t.mock.method(fs, "stat", async (...args) => {
      const info = await stat(...args);
      if (args[0] === artifact.directory) pinProcessArtifact(artifact.directory);
      return info;
    });
    syncBuiltinESMExports();
    await removeExpiredArtifacts(completed.expires_at + 1, root);
    await stat(artifact.directory);
    t.mock.restoreAll();
    syncBuiltinESMExports();
    unpinProcessArtifact(artifact.directory);
    await removeExpiredArtifacts(completed.expires_at + 1, root);
    await assert.rejects(fs.stat(artifact.directory), { code: "ENOENT" });
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    unpinProcessArtifact(artifact.directory);
    await removeProcessArtifact(artifact.directory);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("artifact completion failure keeps its directory pinned", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "pi-artifact-expiry-test-"));
  const artifact = await createProcessArtifact(root);
  try {
    await fs.mkdir(artifact.metadata_path);
    const now = Date.now();
    await assert.rejects(completeProcessArtifact(artifact, now, {}));
    const old = new Date(now - ARTIFACT_RETENTION_MS - 1000);
    await fs.utimes(artifact.directory, old, old);
    await removeExpiredArtifacts(now, root);
    await fs.stat(artifact.directory);
    assert.equal(dirname(artifact.stdout_path), artifact.directory);
  } finally {
    unpinProcessArtifact(artifact.directory);
    await removeProcessArtifact(artifact.directory);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("generic artifacts keep creation-based expiry and expire without a process pin", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "pi-generic-artifact-test-"));
  const before = Date.now();
  const artifact = await createProcessArtifact(root);
  try {
    const after = Date.now();
    assert.ok(artifact.expires_at >= before + ARTIFACT_RETENTION_MS);
    assert.ok(artifact.expires_at <= after + ARTIFACT_RETENTION_MS);
    await fs.writeFile(artifact.stdout_path, "generic evidence\n");
    await writeProcessArtifactMetadata(artifact, { expires_at: artifact.expires_at });
    assert.equal(await fs.readFile(artifact.stdout_path, "utf8"), "generic evidence\n");
    assert.equal(JSON.parse(await fs.readFile(artifact.metadata_path, "utf8")).expires_at, artifact.expires_at);
    await removeExpiredArtifacts(before + ARTIFACT_RETENTION_MS - 1, root);
    await fs.stat(artifact.directory);
    await removeExpiredArtifacts(after + ARTIFACT_RETENTION_MS + 1000, root);
    await assert.rejects(fs.stat(artifact.directory), { code: "ENOENT" });
  } finally {
    await removeProcessArtifact(artifact.directory);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("artifact removal releases its pin only after removal succeeds", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "pi-artifact-removal-test-"));
  const artifact = await createProcessArtifact(root);
  pinProcessArtifact(artifact.directory);
  try {
    t.mock.method(fs, "rm", async () => { throw new Error("injected removal failure"); });
    syncBuiltinESMExports();
    assert.equal(await removeProcessArtifact(artifact.directory), false);
    t.mock.restoreAll();
    syncBuiltinESMExports();
    const now = Date.now();
    const old = new Date(now - ARTIFACT_RETENTION_MS - 1000);
    await fs.utimes(artifact.directory, old, old);
    await removeExpiredArtifacts(now, root);
    await fs.stat(artifact.directory);
    assert.equal(await removeProcessArtifact(artifact.directory), true);
    await fs.mkdir(artifact.directory);
    await fs.utimes(artifact.directory, old, old);
    await removeExpiredArtifacts(now, root);
    await assert.rejects(fs.stat(artifact.directory), { code: "ENOENT" });
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await removeProcessArtifact(artifact.directory);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("stream verification does not wait for a FIFO writer", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "pi-artifact-fifo-test-"));
  const fifo = join(root, "stdout");
  try {
    const created = childProcess.spawnSync("mkfifo", [fifo], { encoding: "utf8", timeout: 2000 });
    assert.equal(created.status, 0, created.stderr || created.error?.message);
    const moduleUrl = new URL("../../extensions/agent-tools/process-artifacts.ts", import.meta.url).href;
    const script = `
      import assert from "node:assert/strict";
      const { verifiedProcessStreamBytes } = await import(${JSON.stringify(moduleUrl)});
      assert.equal(await verifiedProcessStreamBytes(${JSON.stringify(fifo)}), undefined);
    `;
    const result = childProcess.spawnSync(process.execPath,
      ["--experimental-strip-types", "--input-type=module", "--eval", script],
      { encoding: "utf8", timeout: 2000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.equal(result.error, undefined);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

const progressSource = `
require("node:fs").appendFileSync("executions", "once\\n");
process.stdout.write("READY\\n");
setInterval(() => {}, 1000);
`;

async function withObservedProcess(t, name, callback) {
  const spawn = childProcess.spawn;
  let group;
  t.mock.method(childProcess, "spawn", (...args) => {
    const child = spawn(...args);
    child.once("spawn", () => { group = child.pid; });
    return child;
  });
  syncBuiltinESMExports();
  try {
    await withProcess(name, progressSource, (fixture) => callback({ ...fixture, group: () => group }));
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    if (group) {
      try { process.kill(-group, "SIGKILL"); } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
      const deadline = Date.now() + 1000;
      while (true) {
        try { process.kill(-group, 0); } catch (error) {
          if (error.code === "ESRCH") break;
          if (error.code !== "EPERM") throw error;
        }
        assert.ok(Date.now() < deadline, "Fixture process group did not exit");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  }
}

for (const name of Object.keys(factories)) {
  for (const mode of ["throw", "reject"]) {
    test(`${name} stops and retains evidence when its progress callback ${mode}s after READY`, async (t) => {
      await withObservedProcess(t, name, async ({ cwd, tool, input, group }) => {
        let failedUpdates = 0;
        const result = await tool.execute("observer", input, undefined, (update) => {
          if (!update.content[0].text.includes("READY")) return;
          assert.doesNotThrow(() => process.kill(-group(), 0));
          failedUpdates += 1;
          const error = new Error(`injected progress ${mode}`);
          if (mode === "reject") return Promise.reject(error);
          throw error;
        }, context(cwd));
        assert.equal(failedUpdates, 1);
        assert.equal(result.isError, true);
        assert.equal(result.details.error.code, "CAPTURE_FAILED");
        assert.match(result.details.error.message, /Cannot publish .* progress: Error: injected progress/);
        assert.equal(result.details.process.stop_reason, "capture_failed");
        assert.equal(result.details.process.cleanup, "complete");
        assert.equal(result.details.process.stdout.capture, "incomplete");
        assert.equal(await fs.readFile(result.details.process.stdout.artifact, "utf8"), "READY\n");
        assert.match(result.content[0].text, /READY/);
        assert.throws(() => process.kill(-group(), 0), { code: "ESRCH" });
        assert.equal(await fs.readFile(join(cwd, "executions"), "utf8"), "once\n");
        assert.ok(Buffer.byteLength(result.content[0].text) <= 8192);
      });
    });
  }

  test(`${name} keeps the progress cause when group cleanup fails`, async (t) => {
    await withObservedProcess(t, name, async ({ cwd, tool, input, group }) => {
      const kill = process.kill;
      t.mock.method(process, "kill", (pid, signal) => {
        if (pid === -group() && (signal === "SIGTERM" || signal === "SIGKILL")) {
          throw Object.assign(new Error("injected observer cleanup failure"), { code: "EPERM" });
        }
        return kill(pid, signal);
      });
      const result = await tool.execute("observer-control", input, undefined, (update) => {
        if (update.content[0].text.includes("READY")) throw new Error("injected progress cause");
      }, context(cwd));
      assert.equal(result.isError, true);
      assert.equal(result.details.error.code, "PROCESS_CONTROL_FAILED");
      assert.equal(result.details.process.stop_reason, "capture_failed");
      assert.equal(result.details.process.cleanup, "failed");
      assert.equal(result.details.process.exit_code, null);
      assert.equal(result.details.process.artifact, undefined);
      assert.match(result.details.error.message, /first stop: CAPTURE_FAILED: Cannot publish .* progress: Error: injected progress cause/);
      assert.equal(await fs.readFile(result.details.process.stdout.artifact, "utf8"), "READY\n");
      assert.doesNotThrow(() => kill(-group(), 0));
      assert.equal(await fs.readFile(join(cwd, "executions"), "utf8"), "once\n");
    });
  });

  test(`${name} does not wait for a progress promise and contains its late rejection`, async (t) => {
    await withObservedProcess(t, name, async ({ cwd, tool, input, group }) => {
      const abort = new AbortController();
      let rejectObserver;
      const result = await tool.execute("pending-observer", input, abort.signal, (update) => {
        if (!update.content[0].text.includes("READY")) return;
        abort.abort();
        return new Promise((_resolve, reject) => { rejectObserver = reject; });
      }, context(cwd));
      assert.equal(result.isError, true);
      assert.equal(result.details.error.code, "CANCELLED");
      assert.equal(result.details.process.cleanup, "complete");
      assert.throws(() => process.kill(-group(), 0), { code: "ESRCH" });
      assert.equal(typeof rejectObserver, "function");
      rejectObserver(new Error("injected late observer rejection"));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(result.details.error.code, "CANCELLED");
      assert.equal(await fs.readFile(result.details.process.stdout.artifact, "utf8"), "READY\n");
    });
  });

  test(`${name} terminates and reaps after an unexpected post-spawn setup error`, async (t) => {
    await withObservedProcess(t, name, async ({ cwd, tool, input, group }) => {
      const abort = new AbortController();
      t.mock.method(abort.signal, "addEventListener", () => {
        throw new Error("injected post-spawn setup error");
      });
      const result = await tool.execute("unexpected", input, abort.signal, undefined, context(cwd));
      assert.equal(result.isError, true);
      assert.equal(result.details.error.code, "CAPTURE_FAILED");
      assert.match(result.details.error.message, /injected post-spawn setup error/);
      assert.equal(result.details.process.stop_reason, "capture_failed");
      assert.equal(result.details.process.cleanup, "complete");
      assert.throws(() => process.kill(-group(), 0), { code: "ESRCH" });
    });
  });
}

async function withDirectSignalFixture(t, name, stopReason, signal, callback) {
  const cwd = await fs.mkdtemp(join(tmpdir(), "pi-process-signal-evidence-"));
  const oldPath = process.env.PATH;
  const spawn = childProcess.spawn;
  const kill = process.kill;
  let child;
  let artifact;
  try {
    const source = `
const fs = require("node:fs");
fs.appendFileSync("executions", "once\\n");
process.on("SIGTERM", () => {});
fs.writeSync(1, "BEFORE_STOP\\n");
${stopReason === "output_limit" ? 'const data = Buffer.alloc(65536, 65); for (let i = 0; i < 1025; i++) fs.writeSync(1, data);' : ""}
setInterval(() => { if (fs.existsSync("release")) process.exit(0); }, 5);
`;
    await fs.writeFile(join(cwd, name), `#!${process.execPath}\n${source}`);
    await fs.chmod(join(cwd, name), 0o755);
    process.env.PATH = `${cwd}${delimiter}${oldPath ?? ""}`;
    t.mock.method(childProcess, "spawn", (...args) => { child = spawn(...args); return child; });
    syncBuiltinESMExports();
    const tool = factories[name]({
      onArtifactCreated: (created) => { artifact = created; },
      cleanupLimitMs: signal === "SIGKILL" ? 3000 : 500,
    });
    await callback({ cwd, tool, input: { args: ["signal-evidence"] }, group: () => child?.pid, kill });
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (child?.pid) {
      try { kill(-child.pid, "SIGKILL"); } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
      const deadline = Date.now() + 1000;
      while (true) {
        try { kill(-child.pid, 0); } catch (error) {
          if (error.code === "ESRCH") break;
          if (error.code !== "EPERM") throw error;
        }
        assert.ok(Date.now() < deadline, "Fixture process group did not exit");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    if (artifact) await removeProcessArtifact(artifact.directory);
    await fs.rm(cwd, { recursive: true, force: true });
  }
}

for (const name of ["git", "gh"]) {
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    for (const persistent of [false, true]) {
      test(`${name} verifies ${persistent ? "persistent" : "departing"} groups after ${signal} EPERM`, async (t) => {
        const stopReason = signal === "SIGTERM" ? "output_limit" : "cancelled";
        const originalCode = stopReason === "output_limit" ? "OUTPUT_LIMIT" : "CANCELLED";
        await withDirectSignalFixture(t, name, stopReason, signal, async ({ cwd, tool, input, group, kill }) => {
          let injected = 0;
          let checkedAfterError = 0;
          t.mock.method(process, "kill", (pid, requestedSignal) => {
            if (pid === -group() && requestedSignal === signal) {
              assert.doesNotThrow(() => kill(pid, 0));
              injected += 1;
              if (!persistent) writeFileSync(join(cwd, "release"), "yes");
              throw Object.assign(new Error(`injected ${signal} permission failure`), { code: "EPERM" });
            }
            if (injected > 0 && pid === -group() && requestedSignal === 0) checkedAfterError += 1;
            return kill(pid, requestedSignal);
          });
          const abort = new AbortController();
          const result = await tool.execute("signal-race", input, abort.signal, (update) => {
            if (stopReason === "cancelled" && update.content[0].text.includes("BEFORE_STOP")) abort.abort();
          }, context(cwd));
          assert.equal(injected, 1);
          assert.ok(checkedAfterError > 0);
          assert.equal(result.isError, true);
          assert.equal(result.details.error.code, persistent ? "PROCESS_CONTROL_FAILED" : originalCode);
          assert.equal(result.details.process.stop_reason, stopReason);
          assert.equal(result.details.process.cleanup, persistent ? "failed" : "complete");
          assert.match(result.details.error.message, stopReason === "output_limit"
            ? /standard output exceeded the full-capture limit/
            : /command was cancelled/);
          if (persistent) {
            assert.match(result.details.error.message, /injected SIG(?:TERM|KILL) permission failure/);
            assert.match(result.details.error.message, new RegExp(`first stop: ${originalCode}:`));
            assert.equal(result.details.process.exit_code, null);
            assert.equal(result.details.process.artifact, undefined);
            assert.doesNotThrow(() => kill(-group(), 0));
          } else {
            assert.equal(result.details.process.exit_code, 0);
            assert.throws(() => kill(-group(), 0), { code: "ESRCH" });
          }
          const saved = await fs.open(result.details.process.stdout.artifact, "r");
          try {
            const prefix = Buffer.alloc(12);
            await saved.read(prefix, 0, prefix.length, 0);
            assert.equal(prefix.toString(), "BEFORE_STOP\n");
          } finally { await saved.close(); }
          assert.equal(await fs.readFile(join(cwd, "executions"), "utf8"), "once\n");
          assert.ok(Buffer.byteLength(result.content[0].text) <= 8192);
        });
      });
    }
  }
}
