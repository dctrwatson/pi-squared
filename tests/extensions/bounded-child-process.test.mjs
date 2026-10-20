import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { BoundedChildCleanupError, startBoundedChildProcess } from "../../extensions/agent-tools/bounded-child-process.ts";

async function script(t, source) {
  const root = await mkdtemp(join(tmpdir(), "pi-bounded-child-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "child.mjs");
  await writeFile(path, `#!${process.execPath}\n${source}\n`);
  await chmod(path, 0o700);
  return path;
}

async function waitForFile(path, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return await readFile(path, "utf8"); }
    catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  assert.fail(`Timed out waiting for ${path}.`);
}

test("zero cleanup timeout is rejected before the child is spawned", async (t) => {
  const marker = join(tmpdir(), `pi-bounded-child-started-${process.pid}-${Date.now()}`);
  const executable = await script(t, `
    import { writeFileSync } from 'node:fs';
    writeFileSync(${JSON.stringify(marker)}, 'started');
  `);
  let child;
  try {
    assert.throws(() => {
      child = startBoundedChildProcess(executable, [], { cleanupTimeoutMs: 0 });
    }, /cleanupTimeoutMs must be a positive safe integer/);
    assert.equal(child, undefined);
    await assert.rejects(access(marker), (error) => error.code === "ENOENT");
  } finally {
    if (child) await child.stop();
  }
});

test("bounded child reports spawn errors after close without fabricating an exit", async () => {
  const child = startBoundedChildProcess(join(tmpdir(), "missing-bounded-child"), [], { stdoutLimitBytes: 16 });
  const result = await child.waitForClose();
  assert.equal(result.failed, true);
  assert.equal(result.code, null);
  assert.equal(result.signal, null);
  assert.equal(result.error?.code, "ENOENT");
  await child.stop();
});

test("bounded child caps stdout and stderr captures without retaining overflow", async (t) => {
  const executable = await script(t, `
    process.stdout.write('x'.repeat(256));
    process.stderr.write('y'.repeat(256));
  `);
  const child = startBoundedChildProcess(executable, [], {
    stdoutLimitBytes: 32, stderrLimitBytes: 16, totalOutputLimitBytes: 40,
  });
  const result = await child.waitForClose();
  assert.equal(result.code, 0);
  assert.equal(child.stdout.overflow, true);
  assert.equal(child.stderr.overflow, true);
  assert.equal(child.totalOutputOverflow, true);
  assert.ok(Buffer.byteLength(Buffer.concat(child.stdout.chunks)) <= 32);
  assert.ok(Buffer.byteLength(Buffer.concat(child.stderr.chunks)) <= 16);
  await child.stop();
});

test("bounded child stops on capture overflow", async (t) => {
  const executable = await script(t, `
    process.stdout.write('x'.repeat(256));
    setInterval(() => {}, 1000);
  `);
  const child = startBoundedChildProcess(executable, [], { stdoutLimitBytes: 32, stopOnLimit: true });
  const result = await child.waitForClose();
  assert.equal(result.signal, "SIGTERM");
  assert.equal(child.stdout.overflow, true);
  assert.ok(Buffer.byteLength(Buffer.concat(child.stdout.chunks)) <= 32);
  await child.stop();
});

test("bounded child cancellation sends TERM, escalates to KILL, and reaps", async (t) => {
  const executable = await script(t, `
    process.on('SIGTERM', () => {});
    process.stdout.write('ready\\n');
    setInterval(() => {}, 1000);
  `);
  const controller = new AbortController();
  const child = startBoundedChildProcess(executable, [], {
    signal: controller.signal, stdoutLimitBytes: 64, cleanupTimeoutMs: 50,
  });
  await new Promise((resolve) => child.child.stdout.once("data", resolve));
  const reason = new Error("fixture cancellation");
  controller.abort(reason);
  await assert.rejects(child.waitForClose(controller.signal), (error) => error === reason);
  const result = await child.stop();
  assert.equal(result.signal, "SIGKILL");
  assert.equal(child.child.signalCode, "SIGKILL");
});

test("stop bounds close after child exit when a descendant retains inherited pipes", async (t) => {
  let readyPath;
  let donePath;
  let pid;
  const executable = await script(t, "");
  const root = dirname(executable);
  const pidPath = join(root, "descendant.pid");
  readyPath = join(root, "descendant.ready");
  donePath = join(root, "descendant.done");
  const descendantSource = `
    const fs = require('node:fs');
    process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(donePath)}, 'done'); process.exit(0); });
    fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready');
    setInterval(() => {}, 1000);
  `;
  await writeFile(executable, `#!${process.execPath}\nimport { spawn } from 'node:child_process';\nimport { writeFileSync } from 'node:fs';\nconst descendant = spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}], { stdio: ['ignore', 'inherit', 'inherit'] });\nwriteFileSync(${JSON.stringify(pidPath)}, String(descendant.pid));\ndescendant.unref();\n`);

  const child = startBoundedChildProcess(executable, [], { stdoutLimitBytes: 64, cleanupTimeoutMs: 50 });
  try {
    await new Promise((resolve) => child.child.once("exit", resolve));
    pid = Number(await readFile(pidPath, "utf8"));
    assert.ok(pid > 0);
    await waitForFile(readyPath);
    let deadline;
    try {
      await assert.rejects(Promise.race([
        child.stop(),
        new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("stop did not bound inherited pipes")), 1000); }),
      ]), (error) => error instanceof BoundedChildCleanupError && /close was not observed/.test(error.message));
    } finally { clearTimeout(deadline); }
  } finally {
    if (!pid) pid = Number(await readFile(pidPath, "utf8").catch(() => "0"));
    if (pid > 0) {
      try { process.kill(pid, "SIGTERM"); } catch { /* The descendant may already have exited. */ }
      await waitForFile(donePath);
      const status = await child.closed;
      assert.equal(status.code, 0);
      assert.deepEqual(await child.stop(), status, "a later stop reports close observed after the first cleanup error");
    }
  }
});
