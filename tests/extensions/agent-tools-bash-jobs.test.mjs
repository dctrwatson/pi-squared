import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentBashTool, normalizeInput } from "../../extensions/agent-tools/bash.ts";
import { BashProcessOwner, startBashProcess } from "../../extensions/agent-tools/bash-process.ts";
import { BashJobRegistry } from "../../extensions/agent-tools/bash-jobs.ts";
import { createAgentBashJobTool, normalizeBashJobInput, readBashJobOutput } from "../../extensions/agent-tools/bash-job.ts";
import { createProcessArtifact, removeProcessArtifact } from "../../extensions/agent-tools/process-artifacts.ts";
import agentTools from "../../extensions/agent-tools/index.ts";
import { hasUnsuccessfulProcessStatus } from "../../extensions/agent-tools/tool-render.ts";

const context = (cwd, id = "jobs") => ({ cwd, mode: "print", modelRegistry: { getAvailable: () => [] },
  sessionManager: { getSessionId: () => id, getSessionFile: () => undefined } });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!await predicate()) { assert.ok(Date.now() < deadline, "Fixture condition did not become true"); await delay(10); }
}
async function fixture(callback, options = {}) {
  const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bash-jobs-test-"));
  const owner = new BashProcessOwner();
  const registry = new BashJobRegistry(owner, "jobs", options);
  const artifacts = [];
  const bash = createAgentBashTool({ owner, registry, controlAvailable: () => true,
    onArtifactCreated: (artifact) => artifacts.push(artifact), ...options.bash });
  const jobs = createAgentBashJobTool(registry);
  const execute = (tool, input, signal) => tool.execute("jobs", input, signal, undefined, context(cwd));
  const start = async (source, extra = {}, signal) => {
    const script = join(cwd, `command-${Math.random()}.cjs`);
    await fs.writeFile(script, source);
    return execute(bash, { command: `"${process.execPath}" "${script}"`, background: true, ...extra }, signal);
  };
  try { await callback({ cwd, owner, registry, bash, jobs, execute, start, artifacts }); }
  finally { registry.closeAdmission(); await owner.shutdown(); registry.clear(); for (const artifact of artifacts) await removeProcessArtifact(artifact.directory); await fs.rm(cwd, { recursive: true, force: true }); }
}
const releasedSource = `
const fs = require("node:fs");
fs.appendFileSync("executions", "once\\n");
console.log("READY");
setInterval(() => { if (fs.existsSync("release")) { console.log("DONE"); process.exit(0); } }, 10);
`;

test("background input is strict, bounded, and requires active controls before allocation", async () => {
  assert.equal(normalizeInput({ command: "true", background: null }).background, false);
  assert.equal(normalizeInput({ command: "true", background: true }).timeoutSeconds, 120);
  assert.equal(normalizeInput({ command: "true", background: true, timeout_seconds: 86400, max_output_bytes: null }).timeoutSeconds, 86400);
  for (const input of [{ background: "true" }, { background: true, max_output_bytes: 8192 }, { background: true, timeout_seconds: 86400.1 }, { timeout_seconds: 3600.1 }]) {
    assert.throws(() => normalizeInput({ command: "true", ...input }), (error) => error.code === "INVALID_INPUT");
  }
  let allocated = 0;
  const tool = createAgentBashTool({ onArtifactCreated: () => { allocated += 1; } });
  const result = await tool.execute("disabled", { command: "true", background: true }, undefined, undefined, context(process.cwd()));
  assert.equal(result.details.error.code, "CONTROL_UNAVAILABLE");
  assert.equal(allocated, 0);
});

test("background returns without source preview; output and final wait recover exact sentinels", async () => {
  await fixture(async ({ start, execute, jobs, cwd, registry }) => {
    const result = await start(releasedSource);
    assert.equal(result.details.ok, true);
    const id = result.details.job.job_id;
    assert.equal(result.details.job.state, "running");
    assert.doesNotMatch(result.content[0].text, /READY/);
    assert.ok(Buffer.byteLength(result.content[0].text) <= 8192);
    let output;
    await until(async () => { output = await execute(jobs, { action: "output", job_id: id, start_byte: 0 }); return output.content[0].text.includes("READY"); });
    assert.equal(output.isError, false);
    assert.equal(output.details.output.next_start_byte, 6);
    await fs.writeFile(join(cwd, "release"), "yes");
    const final = await execute(jobs, { action: "wait", job_id: id, wait_seconds: 3 });
    assert.equal(final.details.job.state, "exited");
    assert.equal(final.details.job.process.exit_code, 0);
    assert.equal(final.details.job.process.cleanup, "complete");
    assert.equal(await fs.readFile(final.details.job.process.stdout.artifact, "utf8"), "READY\nDONE\n");
    assert.equal(await fs.readFile(join(cwd, "executions"), "utf8"), "once\n");
    const copy = registry.status(id);
    copy.process.stdout.captured_raw_bytes = 999;
    assert.equal(registry.status(id).process.stdout.captured_raw_bytes, 11);
    const eof = await execute(jobs, { action: "output", job_id: id, start_byte: 11 });
    assert.equal(eof.details.output.next_start_byte, 11);
    assert.equal(eof.details.output.has_more, false);
    assert.equal(eof.isError, false);
  });
});

test("wait cancellation and turn cancellation leave transferred jobs running; concurrent cancel finishes", async () => {
  await fixture(async ({ start, execute, jobs, registry }) => {
    const turn = new AbortController();
    const started = await start(releasedSource, {}, turn.signal);
    const id = started.details.job.job_id;
    turn.abort();
    const waiter = new AbortController();
    const waiting = execute(jobs, { action: "wait", job_id: id, wait_seconds: 5 }, waiter.signal);
    waiter.abort();
    assert.equal((await waiting).details.error.code, "CANCELLED");
    assert.equal(registry.status(id).state, "running");
    const parallelWait = execute(jobs, { action: "wait", job_id: id, wait_seconds: 5 });
    assert.equal((await execute(jobs, { action: "status", job_id: id })).details.job.state, "running");
    const cancelled = await execute(jobs, { action: "cancel", job_id: id });
    assert.equal(cancelled.details.job.state, "cancelled");
    assert.equal((await parallelWait).details.job.state, "cancelled");
    const again = await execute(jobs, { action: "cancel", job_id: id });
    assert.equal(again.details.job.state, "cancelled");
  });
});

test("cancel invocation abort does not abort its committed cleanup", async () => {
  await fixture(async ({ start, execute, jobs, registry }) => {
    const initial = await start(releasedSource);
    const id = initial.details.job.job_id;
    const abort = new AbortController();
    const cancelling = execute(jobs, { action: "cancel", job_id: id }, abort.signal);
    abort.abort();
    assert.equal((await cancelling).details.error.code, "CANCELLED");
    await until(() => registry.status(id).state === "cancelled");
    assert.equal(registry.status(id).process.cleanup, "complete");
  });
});

test("a later call reaches a local server; cancel closes its socket and owned group", async () => {
  await fixture(async ({ start, execute, jobs }) => {
    const initial = await start('require("node:http").createServer((_req,res) => res.end("OK")).listen(0,"127.0.0.1",function(){ console.log("PORT=" + this.address().port); });');
    const id = initial.details.job.job_id;
    let port;
    await until(async () => {
      const output = await execute(jobs, { action: "output", job_id: id, start_byte: 0 });
      port = /PORT=(\d+)/.exec(output.content[0].text)?.[1];
      return !!port;
    });
    assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), "OK");
    const stopped = await execute(jobs, { action: "cancel", job_id: id });
    assert.equal(stopped.details.job.process.cleanup, "complete");
    await assert.rejects(fetch(`http://127.0.0.1:${port}`));
  });
});

test("abort during allocation frees admission and starts no OS process", async (t) => {
  const spawn = childProcess.spawn;
  let spawns = 0;
  t.mock.method(childProcess, "spawn", (...args) => { spawns += 1; return spawn(...args); });
  syncBuiltinESMExports();
  const abort = new AbortController();
  try {
    await fixture(async ({ bash, execute, registry }) => {
      const result = await execute(bash, { command: "true", background: true }, abort.signal);
      assert.equal(result.details.error.code, "CANCELLED");
      assert.equal(result.details.process, undefined);
      assert.equal(registry.retainedCount, 0);
      assert.equal(spawns, 0);
    }, { bash: { onArtifactCreated: () => abort.abort() } });
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test("abort immediately after spawn stops before transfer and reports the retained job", async (t) => {
  const spawn = childProcess.spawn;
  const abort = new AbortController();
  let group;
  t.mock.method(childProcess, "spawn", (...args) => {
    const child = spawn(...args);
    child.once("spawn", () => { group = child.pid; abort.abort(); });
    return child;
  });
  syncBuiltinESMExports();
  try {
    await fixture(async ({ start, registry }) => {
      const result = await start(releasedSource, {}, abort.signal);
      assert.equal(result.isError, true);
      assert.equal(result.details.error.code, "CANCELLED");
      assert.ok(result.details.job_id);
      assert.equal(result.details.job.state, "cancelled");
      assert.equal(registry.status(result.details.job_id).process.cleanup, "complete");
      assert.throws(() => process.kill(-group, 0), { code: "ESRCH" });
    });
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test("unverified stop remains live; a cancel retry uses the same group and no respawn", async (t) => {
  const kill = process.kill;
  const spawn = childProcess.spawn;
  let spawns = 0;
  let group;
  t.mock.method(childProcess, "spawn", (...args) => { spawns += 1; const child = spawn(...args); group = child.pid; return child; });
  syncBuiltinESMExports();
  try {
    await fixture(async ({ start, execute, jobs, registry }) => {
      const initial = await start(releasedSource);
      const id = initial.details.job.job_id;
      await until(async () => (await execute(jobs, { action: "output", job_id: id })).content[0].text.includes("READY"));
      const mocked = t.mock.method(process, "kill", (pid, signal) => {
        if (pid === -group && (signal === "SIGTERM" || signal === "SIGKILL")) throw Object.assign(new Error("injected stop permission failure"), { code: "EPERM" });
        return kill(pid, signal);
      });
      const failed = await execute(jobs, { action: "cancel", job_id: id });
      assert.equal(failed.details.error.code, "PROCESS_CONTROL_FAILED");
      assert.equal(failed.details.job.state, "stop_failed");
      assert.equal(failed.details.job.registry_expires_at, null);
      assert.doesNotThrow(() => kill(-group, 0));
      assert.equal((await execute(jobs, { action: "wait", job_id: id, wait_seconds: 5 })).details.job.state, "stop_failed");
      mocked.mock.restore();
      const stopped = await execute(jobs, { action: "cancel", job_id: id });
      assert.equal(stopped.details.job.state, "cancelled");
      assert.equal(stopped.details.job.error.code, "CANCELLED");
      assert.equal(stopped.details.job.process.stop_reason, "cancelled");
      assert.equal(stopped.details.job.process.cleanup, "complete");
      assert.equal(spawns, 1);
      assert.equal(registry.owner.controllers.size, 0);
      assert.throws(() => kill(-group, 0), { code: "ESRCH" });
    }, { bash: { cleanupLimitMs: 500 } });
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); if (group) { try { kill(-group, "SIGKILL"); } catch {} } }
});

test("timeout and output ceiling have separate terminal states and retained evidence", { timeout: 30000 }, async (t) => {
  await fixture(async ({ start, execute, jobs, cwd }) => {
    const timeout = await start('console.log("READY"); setInterval(() => {},1000);', { timeout_seconds: 0.3 });
    const timed = await execute(jobs, { action: "wait", job_id: timeout.details.job.job_id, wait_seconds: 3 });
    assert.equal(timed.details.job.state, "timed_out");
    assert.equal(timed.details.job.process.timed_out, true);
    const deadline = performance.now() + 25000;
    const limit = await start('const fs=require("node:fs"); fs.appendFileSync("limit-executions","once\\n"); fs.writeSync(1,"BEFORE_STOP\\n"); const b=Buffer.alloc(65536,65); for(let i=0;i<1025;i++)fs.writeSync(1,b);');
    const id = limit.details.job.job_id;
    let final = await execute(jobs, { action: "wait", job_id: id, wait_seconds: 3 });
    const pending = (state) => ["starting", "running", "stopping"].includes(state);
    if (pending(final.details.job.state)) t.diagnostic(`Output-limit first wait snapshot: ${JSON.stringify(final.details.job)}`);
    while (pending(final.details.job.state)) {
      const remaining = deadline - performance.now();
      assert.ok(remaining > 0, `Output-limit job did not become terminal within 25 seconds: ${JSON.stringify(final.details.job)}`);
      final = await execute(jobs, { action: "wait", job_id: id, wait_seconds: Math.min(5, remaining / 1000) });
    }
    assert.equal(final.details.job.job_id, id);
    assert.equal(final.details.job.state, "failed");
    assert.equal(final.details.job.error.code, "OUTPUT_LIMIT");
    assert.equal(final.details.job.process.stop_reason, "output_limit");
    assert.equal(final.details.job.process.timed_out, false);
    assert.equal(final.details.job.process.cleanup, "complete");
    assert.equal(final.details.job.process.stdout.captured_raw_bytes, 67108864);
    assert.equal((await fs.stat(final.details.job.process.stdout.artifact)).size, 67108864);
    const page = await execute(jobs, { action: "output", job_id: id, start_byte: 0 });
    assert.equal(page.isError, false);
    assert.equal(page.details.output.end_byte, 4096);
    assert.equal(page.details.output.next_start_byte, 4096);
    assert.equal(page.details.output.available_bytes, 67108864);
    const text = page.content[0].text;
    assert.equal(text.slice(text.indexOf("\n") + 1, text.lastIndexOf("\n")), `BEFORE_STOP\n${"A".repeat(4096 - 12)}`);
    assert.equal(await fs.readFile(join(cwd, "limit-executions"), "utf8"), "once\n");
  });
});

function fakeControllers(clock) {
  const controllers = [];
  const start = (owner, options) => {
    let resolveStarted;
    let resolveFinished;
    const started = new Promise((resolve) => { resolveStarted = resolve; });
    const finished = new Promise((resolve) => { resolveFinished = resolve; });
    const data = { controller_id: `fixture-${controllers.length}`, started_at: null, deadline_at: null, finished_at: null, process: null };
    const controller = { id: data.controller_id, started, finished, snapshot: () => structuredClone(data), releaseCaller() {},
      stop() { controller.complete(); return finished; },
      launch() { data.started_at = new Date(clock()).toISOString(); data.deadline_at = new Date(clock()+120000).toISOString();
        data.process = { exit_code: null, signal: null, timed_out: false, duration_ms: 0, stop_reason: null, cleanup: "pending",
          stdout: { capture: "incomplete", preview: "complete", captured_raw_bytes: 0, captured_lines: 0, preview_bytes: 0 },
          stderr: { capture: "incomplete", preview: "complete", captured_raw_bytes: 0, captured_lines: 0, preview_bytes: 0 } }; resolveStarted(); },
      complete() { if (!data.process) controller.launch(); data.process.cleanup = "complete"; data.process.exit_code = 0; data.finished_at = new Date(clock()).toISOString(); resolveFinished({ text: "done", details: { ok: true, tool: "bash", ...data.process }, needsArtifact: false }); owner.controllers.delete(controller); },
      failStop() { data.process.cleanup = "failed"; data.error = { code: "PROCESS_CONTROL_FAILED", message: "fixture failure" }; resolveFinished({ text: "failed", details: { ok: false, tool: "bash", error: data.error, process: data.process } }); },
    };
    owner.controllers.add(controller);
    controllers.push(controller);
    return controller;
  };
  return { controllers, start };
}
const fakeOptions = () => ({ input: normalizeInput({ command: "true", background: true }), sessionCwd: process.cwd(), environment: {} });

test("eight reserved/live slots reject the ninth before controller allocation; stop_failed is live", async () => {
  const owner = new BashProcessOwner();
  const fake = fakeControllers(() => 0);
  const counts = [];
  const registry = new BashJobRegistry(owner, "jobs", { startController: fake.start, onRetainedCountChange: (count) => counts.push([count,registry.retainedCount]) });
  const starts = Array.from({ length: 8 }, () => registry.start(fakeOptions()));
  assert.equal(registry.retainedCount, 8);
  await assert.rejects(registry.start(fakeOptions()), (error) => error.code === "JOB_LIMIT");
  assert.equal(fake.controllers.length, 8);
  fake.controllers.forEach((controller) => controller.launch());
  const jobs = await Promise.all(starts);
  fake.controllers[0].failStop();
  await delay(0);
  assert.equal(registry.status(jobs[0].job_id).state, "stop_failed");
  await assert.rejects(registry.start(fakeOptions()), (error) => error.code === "JOB_LIMIT");
  fake.controllers[1].complete();
  await delay(0);
  const next = registry.start(fakeOptions());
  fake.controllers[8].launch();
  await next;
  assert.ok(counts.every(([count, read]) => count === read));
  registry.closeAdmission(); await owner.shutdown(); registry.clear();
});

test("terminal handles prune at one hour and 64 records; count getter does not prune", async () => {
  let now = 0;
  const fake = fakeControllers(() => now);
  const owner = new BashProcessOwner();
  const counts = [];
  const registry = new BashJobRegistry(owner, "jobs", { now: () => now, startController: fake.start, onRetainedCountChange: (count) => counts.push(count) });
  const ids = [];
  for (let i=0;i<65;i++) {
    const pending = registry.start(fakeOptions());
    fake.controllers[i].launch(); fake.controllers[i].complete();
    ids.push((await pending).job_id); now += 1;
  }
  assert.equal(registry.retainedCount, 64);
  assert.throws(() => registry.status(ids[0]), (error) => error.code === "JOB_NOT_FOUND");
  const before = counts.length;
  now += 3600000;
  assert.equal(registry.retainedCount, 64);
  assert.equal(counts.length, before);
  assert.throws(() => registry.status(ids.at(-1)), (error) => error.code === "JOB_NOT_FOUND");
  assert.equal(registry.retainedCount, 0);
  assert.equal(counts.at(-1), 0);
  registry.closeAdmission(); await owner.shutdown(); registry.clear();
});

test("strict controls reject action-specific fields without mutation", () => {
  const tool = createAgentBashJobTool(new BashJobRegistry(new BashProcessOwner(), "jobs"));
  for (const input of [{ action: "status", wait_seconds: 1 }, { action: "cancel", stream: "stdout" }, { action: "wait", max_bytes: 4096 }, { action: "output", wait_seconds: 0 }, { action: "output", max_bytes: "4096" }, { action: "output", encoding: "base64", max_bytes: 30721 }, { action: "wait", wait_seconds: Infinity }]) {
    assert.throws(() => tool.prepareArguments({ job_id: "job_fake", ...input }), (error) => error.code === "INVALID_INPUT");
  }
  const input = { action: "status", job_id: "job_fake", max_bytes: null };
  assert.deepEqual(tool.prepareArguments(input), { action: "status", job_id: "job_fake" });
  assert.equal(input.max_bytes, null);
  assert.equal(tool.executionMode, "parallel");
  assert.deepEqual(tool.prepareLoadout({}), { hiddenDeclarations: ["bash_job"] });
});

test("saved output uses frozen byte pages, live UTF-8 withholding, tail offsets, and Base64", async () => {
  const cwd = await fs.mkdtemp(join(tmpdir(), "pi-job-pages-"));
  const path = join(cwd, "stdout");
  const job = { job_id: "job_pages", state: "running", process: { stdout: { artifact: path, capture: "incomplete" } } };
  const input = (fields) => normalizeBashJobInput({ action: "output", job_id: "job_pages", ...fields });
  try {
    await fs.writeFile(path, Buffer.from([0xf0,0x9f]));
    const partial = await readBashJobOutput(job, input({ start_byte: 0 }));
    assert.equal(partial.output.end_byte, 0);
    assert.equal(partial.output.next_start_byte, 0);
    assert.equal(partial.output.available_bytes, 2);
    assert.equal(partial.output.has_more, true);
    job.process.stdout.capture = "complete";
    await assert.rejects(readBashJobOutput(job, input({ start_byte: 0 })), (error) => error.code === "INVALID_ENCODING");
    job.process.stdout.capture = "incomplete";
    job.state = "exited";
    await assert.rejects(readBashJobOutput(job, input({ start_byte: 0 })), (error) => error.code === "INVALID_ENCODING");
    job.state = "running";
    await fs.appendFile(path, Buffer.from([0x98,0x80]));
    await assert.rejects(readBashJobOutput(job, input({ start_byte: 1 })), (error) => error.code === "INVALID_BYTE_BOUNDARY");
    await assert.rejects(readBashJobOutput(job, input({ start_byte: 0, max_bytes: 1 })), (error) => error.code === "BYTE_PAGE_TOO_SMALL");
    const full = await readBashJobOutput(job, input({ start_byte: 0, max_bytes: 4 }));
    assert.equal(full.output.next_start_byte, 4);
    assert.match(full.text, /😀/);
    const tail = await readBashJobOutput(job, input({ max_bytes: 3 }));
    assert.equal(tail.output.start_byte, 4);
    assert.equal(tail.output.next_start_byte, 4);
    await fs.writeFile(path, Buffer.from([0xff,0x80,0x00]));
    const binary = await readBashJobOutput(job, input({ start_byte: 0, encoding: "base64" }));
    assert.match(binary.text, /\/4AA/);
    await assert.rejects(readBashJobOutput(job, input({ start_byte: 4 })), (error) => error.code === "INVALID_INPUT");
    await fs.rm(path);
    await assert.rejects(readBashJobOutput(job, input({})), { code: "ENOENT" });
  } finally { await fs.rm(cwd, { recursive: true, force: true }); }
});

test("shutdown owns pending allocations and foreground Bash even without caller abort", async () => {
  const cwd = await fs.mkdtemp(join(tmpdir(), "pi-owner-shutdown-"));
  const owner = new BashProcessOwner();
  let release;
  let entered = false;
  const artifacts = [];
  const gate = new Promise((resolve) => { release = resolve; });
  const pending = startBashProcess(owner, { ...fakeOptions(), sessionCwd: cwd, createArtifact: async () => { entered = true; await gate; const artifact = await createProcessArtifact(); artifacts.push(artifact); return artifact; } });
  const caller = new AbortController();
  let ready = false;
  const running = startBashProcess(owner, { input: normalizeInput({ command: 'printf "READY\\n"; while :; do sleep 1; done' }), sessionCwd: cwd, environment: process.env, signal: caller.signal,
    onArtifactCreated: (created) => { artifacts.push(created); }, onUpdate: (update) => { if (update.content[0].text.includes("READY")) ready = true; } });
  try {
    await until(() => entered && ready);
    assert.equal(owner.controllers.size, 2);
    const closing = owner.shutdown();
    assert.equal(owner.closed, true);
    assert.equal(caller.signal.aborted, false);
    assert.throws(() => startBashProcess(owner, fakeOptions()), (error) => error.code === "CANCELLED");
    release();
    const reports = await closing;
    await assert.rejects(pending.finished, (error) => error.code === "CANCELLED");
    assert.equal((await running.finished).details.process.cleanup, "complete");
    assert.ok(reports.every((report) => report.process === null || report.process.cleanup === "complete"));
    assert.equal(owner.pendingStarts.size, 0);
    assert.equal(owner.controllers.size, 0);
  } finally { release(); await owner.shutdown(); for (const artifact of artifacts) await removeProcessArtifact(artifact.directory); await fs.rm(cwd, { recursive: true, force: true }); }
});

test("index keeps controls selectable, recognizes output separately, and closes old runtimes", async () => {
  const tools = new Map(); const handlers = new Map(); const entries = [];
  let active = ["write"];
  const applied = [];
  const pi = { registerTool: (tool) => tools.set(tool.name,tool), on: (name, handler) => handlers.set(name,handler),
    getActiveTools: () => [...active], setActiveTools: (names) => { applied.push([...names]); active = [...names]; }, appendEntry: (...args) => entries.push(args) };
  agentTools(pi);
  const cwd = await fs.mkdtemp(join(tmpdir(), "pi-job-index-"));
  const ctx = { ...context(cwd), hasUI: false };
  let directory;
  try {
    await handlers.get("session_start")({ reason: "startup" },ctx);
    assert.ok(!active.includes("bash_job"));
    const disabled = await tools.get("bash").execute("disabled", { command: "true", background: true }, undefined, undefined,ctx);
    assert.equal(disabled.details.error.code,"CONTROL_UNAVAILABLE");
    active.push("bash_job");
    const before = [...active];
    const started = await tools.get("bash").execute("start", { command: 'printf "READY\\n"; while :; do sleep 1; done', background: true }, undefined, undefined,ctx);
    const id = started.details.job.job_id;
    directory = join(started.details.job.process.stdout.artifact,"..");
    assert.deepEqual(applied.at(-1),before);
    assert.equal(tools.get("bash_job").prepareLoadout({}),undefined);
    const failed = { ok:true,tool:"bash_job",job:{ state:"exited",process:{exit_code:1,signal:null,timed_out:false} } };
    assert.equal(handlers.get("tool_result")({ toolName:"bash_job",details:failed,isError:false }).isError,true);
    assert.equal(handlers.get("tool_result")({ toolName:"bash_job",details:{...failed,output:{}},isError:false }),undefined);
    assert.equal(hasUnsuccessfulProcessStatus({ ok:true,job:{state:"running",error:{code:"x"}} }),false);
    await handlers.get("session_shutdown")({reason:"reload"},ctx);
    assert.ok(entries.some(([type]) => type === "agent-tools-bash-shutdown"));
    assert.deepEqual(active,before);
    await handlers.get("session_start")({reason:"reload"},ctx);
    const stale = await tools.get("bash_job").execute("old",{action:"status",job_id:id},undefined,undefined,ctx);
    assert.equal(stale.details.error.code,"JOB_NOT_FOUND");
  } finally { await handlers.get("session_shutdown")({reason:"quit"},ctx); if(directory) await removeProcessArtifact(directory); await fs.rm(cwd,{recursive:true,force:true}); }
});

test("cancellation before result transfer is reaped; caller listener is removed at transfer", async (t) => {
  const abort = new AbortController();
  let added = 0; let removed = 0;
  const add = abort.signal.addEventListener.bind(abort.signal);
  const remove = abort.signal.removeEventListener.bind(abort.signal);
  t.mock.method(abort.signal,"addEventListener",(...args) => { if(args[0] === "abort") added += 1; return add(...args); });
  t.mock.method(abort.signal,"removeEventListener",(...args) => { if(args[0] === "abort") removed += 1; return remove(...args); });
  await fixture(async ({ registry, start }) => {
    const original = registry.start.bind(registry);
    t.mock.method(registry,"start",async (...args) => { const job = await original(...args); abort.abort(); return job; });
    const result = await start(releasedSource,{},abort.signal);
    assert.equal(result.details.error.code,"CANCELLED");
    assert.equal(result.details.job.process.cleanup,"complete");
    assert.ok(added > 0);
    assert.ok(removed >= added);
  });
});

test("failed cleanup during start abort returns a job ID and an owned live group", async (t) => {
  const spawn = childProcess.spawn; const kill = process.kill;
  const abort = new AbortController(); let group;
  t.mock.method(childProcess,"spawn",(...args) => { const child = spawn(...args); child.once("spawn",() => { group=child.pid; abort.abort(); }); return child; });
  t.mock.method(process,"kill",(pid,signal) => {
    if(pid === -group && (signal === "SIGTERM" || signal === "SIGKILL")) throw Object.assign(new Error("injected start cleanup failure"),{code:"EPERM"});
    return kill(pid,signal);
  });
  syncBuiltinESMExports();
  try {
    await fixture(async ({ start,registry }) => {
      const result = await start(releasedSource,{},abort.signal);
      assert.equal(result.details.error.code,"PROCESS_CONTROL_FAILED");
      assert.equal(result.details.job.state,"stop_failed");
      assert.equal(result.details.job_id,result.details.job.job_id);
      assert.equal(result.details.job.process.stop_reason,"cancelled");
      assert.match(result.details.error.message,/first stop: CANCELLED/);
      assert.equal(registry.retainedCount,1);
      assert.doesNotThrow(() => kill(-group,0));
      t.mock.restoreAll(); syncBuiltinESMExports();
      await registry.cancel(result.details.job_id);
    }, { bash:{cleanupLimitMs:500} });
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); if(group) { try { kill(-group,"SIGKILL"); } catch {} } }
});

test("control deselection during allocation prevents spawn and releases the slot", async () => {
  let available = true;
  await fixture(async ({ execute,bash,registry }) => {
    const result = await execute(bash,{command:"true",background:true});
    assert.equal(result.details.error.code,"CONTROL_UNAVAILABLE");
    assert.equal(result.details.process,undefined);
    assert.equal(registry.retainedCount,0);
  }, { bash:{controlAvailable:() => available,onArtifactCreated:() => {available=false;} } });
});

test("job preflight rejects long paths without spawn or a retained handle", async (t) => {
  const spawn = childProcess.spawn; let spawns=0;
  t.mock.method(childProcess,"spawn",(...args) => {spawns+=1; return spawn(...args);});
  syncBuiltinESMExports();
  try {
    await fixture(async ({ execute,bash,registry }) => {
      const result = await execute(bash,{command:"true",background:true});
      assert.equal(result.details.error.code,"RESULT_BUDGET_TOO_SMALL");
      assert.equal(result.details.process,undefined);
      assert.equal(registry.retainedCount,0);
      assert.equal(spawns,0);
    }, {bash:{onArtifactCreated:(artifact) => {artifact.stdout_path += "x".repeat(9000);}}});
  } finally {t.mock.restoreAll(); syncBuiltinESMExports();}
});

test("handle eviction does not remove saved logs and foreground jobs do not consume slots", async () => {
  let now=0;
  await fixture(async ({start,execute,jobs,registry,bash}) => {
    const initial = await start('console.log("KEPT");');
    const id=initial.details.job.job_id;
    const final = await execute(jobs,{action:"wait",job_id:id,wait_seconds:3});
    const path=final.details.job.process.stdout.artifact;
    assert.equal(registry.retainedCount,1);
    now=3600000;
    assert.equal((await execute(jobs,{action:"status",job_id:id})).details.error.code,"JOB_NOT_FOUND");
    assert.equal(await fs.readFile(path,"utf8"),"KEPT\n");
    await execute(bash,{command:"printf foreground"});
    assert.equal(registry.retainedCount,0);
  },{now:() => now});
});

test("bounded page reads continue on short reads, ignore growth, and reject shrink/zero reads", async (t) => {
  const cwd=await fs.mkdtemp(join(tmpdir(),"pi-job-short-page-"));
  const path=join(cwd,"stdout");
  const originalOpen=fs.open;
  const job={job_id:"job_short",state:"running",process:{stdout:{artifact:path,capture:"incomplete"}}};
  const input=normalizeBashJobInput({action:"output",job_id:job.job_id,start_byte:0,max_bytes:4});
  try {
    await fs.writeFile(path,"ABCD");
    for(const mode of ["grow","shrink","zero"]) {
      await fs.writeFile(path,"ABCD"); let calls=0;
      t.mock.method(fs,"open",async (...args) => {
        const handle=await originalOpen(...args);
        return {stat:handle.stat.bind(handle),close:handle.close.bind(handle),async read(buffer,offset,length,position) {
          calls+=1;
          if(mode === "zero") return {bytesRead:0};
          const result=await handle.read(buffer,offset,Math.min(1,length),position);
          if(calls === 1) {
            if(mode === "grow") await fs.appendFile(path,"EFGH");
            else await fs.truncate(path,1);
          }
          return result;
        }};
      });
      syncBuiltinESMExports();
      try {
        if(mode === "grow") {
          const page=await readBashJobOutput(job,input);
          assert.equal(page.output.available_bytes,4);
          assert.equal(page.output.next_start_byte,4);
          assert.equal(page.output.has_more,false);
          assert.match(page.text,/\nABCD\n/);
          assert.equal(calls,4);
        } else await assert.rejects(readBashJobOutput(job,input),(error) => error.code === "ARTIFACT_FAILED");
      } finally {t.mock.restoreAll(); syncBuiltinESMExports();}
    }
  } finally {t.mock.restoreAll();syncBuiltinESMExports();await fs.rm(cwd,{recursive:true,force:true});}
});

test("metadata failure keeps complete stream capture and readable logs", async (t) => {
  const write=fs.writeFile;
  await fixture(async ({ start,execute,jobs }) => {
    t.mock.method(fs,"writeFile",(path,...args) => {
      if(String(path).endsWith("metadata.json")) throw new Error("injected job metadata failure");
      return write(path,...args);
    });
    syncBuiltinESMExports();
    try {
      const initial=await start('console.log("SAVED");');
      const final=await execute(jobs,{action:"wait",job_id:initial.details.job.job_id,wait_seconds:3});
      assert.equal(final.details.job.state,"failed");
      assert.equal(final.details.job.error.code,"ARTIFACT_FAILED");
      assert.equal(final.details.job.process.stdout.capture,"complete");
      assert.equal(final.details.job.process.artifact,undefined);
      assert.equal(await fs.readFile(final.details.job.process.stdout.artifact,"utf8"),"SAVED\n");
      assert.equal((await execute(jobs,{action:"output",job_id:final.details.job.job_id})).isError,false);
    } finally {t.mock.restoreAll();syncBuiltinESMExports();}
  });
});

test("shutdown failure is recorded with controller/job IDs without vetoing reload", async (t) => {
  const tools=new Map(); const handlers=new Map();const entries=[];const notices=[];let active=["bash_job"];
  const pi={registerTool:(tool) => tools.set(tool.name,tool),on:(name,handler) => handlers.set(name,handler),getActiveTools:() => [...active],setActiveTools:(names) => {active=[...names];},appendEntry:(...args) => entries.push(args)};
  agentTools(pi);
  const cwd=await fs.mkdtemp(join(tmpdir(),"pi-job-shutdown-fail-"));
  const ctx={...context(cwd),hasUI:true,ui:{notify:(...args) => notices.push(args)}};
  const spawn=childProcess.spawn;const kill=process.kill;let group;let path;
  t.mock.method(childProcess,"spawn",(...args) => {const child=spawn(...args);group=child.pid;return child;});syncBuiltinESMExports();
  try {
    await handlers.get("session_start")({reason:"startup"},ctx);
    const result=await tools.get("bash").execute("live",{command:'printf "READY\\n"; while :; do sleep 1; done',background:true},undefined,undefined,ctx);
    path=result.details.job.process.stdout.artifact;
    t.mock.method(process,"kill",(pid,signal) => {
      if(pid === -group && (signal === "SIGTERM" || signal === "SIGKILL")) throw Object.assign(new Error("injected shutdown failure"),{code:"EPERM"});
      return kill(pid,signal);
    });
    await handlers.get("session_shutdown")({reason:"reload"},ctx);
    const report=entries.find(([type]) => type === "agent-tools-bash-shutdown")[1].controllers[0];
    assert.ok(report.controller_id);
    assert.equal(report.job_id,result.details.job.job_id);
    assert.equal(report.process.cleanup,"failed");
    assert.match(report.error.message,/injected shutdown failure/);
    assert.ok(notices.some(([message]) => message.includes("not verified")));
    assert.doesNotThrow(() => kill(-group,0));
    await handlers.get("session_start")({reason:"reload"},ctx);
    assert.equal((await tools.get("bash_job").execute("old",{action:"status",job_id:report.job_id},undefined,undefined,ctx)).details.error.code,"JOB_NOT_FOUND");
  } finally {
    t.mock.restoreAll();syncBuiltinESMExports();
    if(group) {try {kill(-group,"SIGKILL");}catch{}}
    if(path) await removeProcessArtifact(join(path,".."));
    await handlers.get("session_shutdown")({reason:"quit"},ctx);
    await fs.rm(cwd,{recursive:true,force:true});
  }
});

test("completed controllers remove capture listeners and repeated stop keeps the final outcome", async (t) => {
  const spawn = childProcess.spawn;
  let child;
  t.mock.method(childProcess,"spawn",(...args) => {child=spawn(...args);return child;});
  syncBuiltinESMExports();
  const owner=new BashProcessOwner();
  try {
    const controller=startBashProcess(owner,{input:normalizeInput({command:"printf DONE"}),sessionCwd:process.cwd(),environment:process.env});
    const result=await controller.finished;
    assert.equal(result.details.exit_code,0);
    const before=controller.snapshot();
    await controller.stop("cancelled");
    assert.deepEqual(controller.snapshot(),before);
    assert.equal(child.stdout.listenerCount("data"),0);
    assert.equal(child.stderr.listenerCount("data"),0);
    assert.equal(child.listenerCount("error"),0);
    assert.equal(owner.controllers.size,0);
  } finally {t.mock.restoreAll();syncBuiltinESMExports();await owner.shutdown();}
});

test("terminal ties evict the smallest job ID and terminal-at-start nonzero stays an outcome", async () => {
  const fake=fakeControllers(() => 0);
  const owner=new BashProcessOwner();
  const registry=new BashJobRegistry(owner,"jobs",{now:() => 0,startController:(...args) => {
    const controller=fake.start(...args); controller.launch(); controller.complete(); return controller;
  }});
  const ids=[];
  for(let i=0;i<65;i++) ids.push((await registry.start(fakeOptions())).job_id);
  const sorted=[...ids].sort();
  assert.throws(() => registry.status(sorted[0]),(error) => error.code === "JOB_NOT_FOUND");
  assert.equal(registry.status(sorted[1]).state,"exited");
  const bad=new BashJobRegistry(owner,"jobs",{startController:(...args) => {
    const controller=fake.start(...args); controller.launch(); controller.complete();
    const snapshot=controller.snapshot;
    controller.snapshot=() => {const copy=snapshot();copy.process.exit_code=7;return copy;};
    return controller;
  }});
  const bash=createAgentBashTool({registry:bad,controlAvailable:() => true});
  const result=await bash.execute("nonzero",{command:"true",background:true},undefined,undefined,context(process.cwd()));
  assert.equal(result.details.ok,true);
  assert.equal(result.details.job.state,"exited");
  assert.equal(result.details.job.process.exit_code,7);
  assert.equal(result.isError,true);
  registry.closeAdmission();bad.closeAdmission();await owner.shutdown();registry.clear();bad.clear();
});

test("background formatter overflow keeps its job snapshot and states execution occurred", async () => {
  const {formatBashJobStart}=await import("../../extensions/agent-tools/bash-jobs.ts");
  const snapshot={job_id:"job_overflow",state:"stop_failed",started_at:null,deadline_at:null,finished_at:null,registry_expires_at:null,
    error:{code:"PROCESS_CONTROL_FAILED",message:"original cause"},process:{exit_code:null,signal:"S".repeat(10000),timed_out:false,stop_reason:"cancelled",cleanup:"failed",
      stdout:{captured_raw_bytes:6,artifact:"/saved/stdout"},stderr:{captured_raw_bytes:0}}};
  const result=formatBashJobStart(snapshot);
  assert.equal(result.details.error.code,"RESULT_BUDGET_TOO_SMALL");
  assert.equal(result.details.job_id,snapshot.job_id);
  assert.equal(result.details.job.process.cleanup,"failed");
  assert.match(result.text,/The process did run/);
  assert.ok(Buffer.byteLength(result.text) <= 8192);
});

test("branch leaf changes keep handles; new, resume, and fork invalidate old IDs", async () => {
  const tools=new Map();const handlers=new Map();let active=["bash_job"];
  const pi={registerTool:(tool) => tools.set(tool.name,tool),on:(name,handler) => handlers.set(name,handler),getActiveTools:() => [...active],setActiveTools:(names) => {active=[...names];},appendEntry() {}};
  agentTools(pi);
  const cwd=await fs.mkdtemp(join(tmpdir(),"pi-job-session-test-"));
  const ctx={...context(cwd),hasUI:false};
  const artifacts=[];
  try {
    await handlers.get("session_start")({reason:"startup"},ctx);
    for(const reason of ["new","resume","fork"]) {
      const started=await tools.get("bash").execute("start",{command:"true",background:true},undefined,undefined,ctx);
      const id=started.details.job.job_id;
      if(started.details.job.process?.stdout.artifact) artifacts.push(join(started.details.job.process.stdout.artifact,".."));
      const branch={...ctx,sessionManager:{...ctx.sessionManager,getSessionFile:() => "other-leaf"}};
      assert.equal((await tools.get("bash_job").execute("branch",{action:"status",job_id:id},undefined,undefined,branch)).details.ok,true);
      const foreign={...ctx,sessionManager:{...ctx.sessionManager,getSessionId:() => "foreign"}};
      const rejected=await tools.get("bash_job").execute("foreign",{action:"status",job_id:id},undefined,undefined,foreign);
      assert.equal(rejected.details.error.code,"JOB_NOT_FOUND");
      assert.equal(rejected.details.job,undefined);
      await handlers.get("session_start")({reason},ctx);
      assert.equal((await tools.get("bash_job").execute("stale",{action:"status",job_id:id},undefined,undefined,ctx)).details.error.code,"JOB_NOT_FOUND");
    }
  } finally {
    await handlers.get("session_shutdown")({reason:"quit"},ctx);
    for(const directory of artifacts) await removeProcessArtifact(directory);
    await fs.rm(cwd,{recursive:true,force:true});
  }
});

test("cancel observers share one stop and return within four seconds while cleanup continues", async () => {
  const fake=fakeControllers(() => 0);
  const owner=new BashProcessOwner();
  let stops=0;let requested=false;
  const registry=new BashJobRegistry(owner,"jobs",{startController:(...args) => {
    const controller=fake.start(...args);controller.launch();
    const snapshot=controller.snapshot;
    controller.snapshot=() => {const copy=snapshot();if(requested) copy.process.stop_reason="cancelled";return copy;};
    controller.stop=() => {stops+=1;requested=true;return controller.finished;};
    return controller;
  }});
  const job=await registry.start(fakeOptions());
  const started=performance.now();
  try {
    const results=await Promise.all([registry.cancel(job.job_id),registry.cancel(job.job_id)]);
    assert.ok(performance.now()-started < 4500);
    assert.ok(results.every((snapshot) => snapshot.state === "stopping"));
    assert.equal(stops,1);
    fake.controllers[0].complete();await delay(0);
    assert.equal(registry.status(job.job_id).state,"cancelled");
  } finally {fake.controllers[0].complete();registry.closeAdmission();await owner.shutdown();registry.clear();}
});

test("job call and output rendering escape terminal controls", () => {
  const tool=createAgentBashJobTool(new BashJobRegistry(new BashProcessOwner(),"jobs"));
  const theme={fg:(_color,text) => text,bg:(_color,text) => text,bold:(text) => text};
  const rendered=tool.renderResult({content:[{type:"text",text:"\u001b[31mRED\u0000END"}],details:{}},{expanded:true},theme,{isError:false}).render(100).join("\n");
  assert.match(rendered,/\\u001b\[31mRED\\u0000END/);
  const call=tool.renderCall({action:"output",job_id:"job\n\u001b"},theme,{isPartial:false,isError:false}).render(100).join("\n");
  assert.match(call,/job\\n\\u001b/);
});

test("large Base64 output keeps the requested raw page, tail, and exact continuation", async (t) => {
  const source = Buffer.alloc(42017);
  for (let index = 0; index < source.length; index++) source[index] = (index * 17 + 3) % 256;
  const path = "/saved/large-base64/stdout";
  const reads = [];
  let opens = 0; let closes = 0;
  const owner = new BashProcessOwner();
  const fake = fakeControllers(() => 0);
  const registry = new BashJobRegistry(owner, "jobs", { now: () => 0, startController: (...args) => {
    const controller = fake.start(...args);
    controller.launch(); controller.complete();
    const snapshot = controller.snapshot;
    controller.snapshot = () => {
      const copy = snapshot();
      copy.process.stdout = { ...copy.process.stdout, artifact: path, capture: "complete", captured_raw_bytes: source.length };
      return copy;
    };
    return controller;
  } });
  const job = await registry.start(fakeOptions());
  t.mock.method(fs, "open", async (artifact) => {
    assert.equal(artifact, path); opens += 1;
    return { async stat() { return { size: source.length, isFile: () => true }; },
      async read(buffer, offset, length, position) {
        const bytesRead = source.copy(buffer, offset, position, position + length);
        reads.push({ position, length, bytesRead });
        return { bytesRead };
      }, async close() { closes += 1; } };
  });
  syncBuiltinESMExports();
  const tool = createAgentBashJobTool(registry);
  const page = async (start) => {
    reads.length = 0;
    const input = { action: "output", job_id: job.job_id, encoding: "base64", max_bytes: 30720,
      ...(start === undefined ? {} : { start_byte: start }) };
    const result = await tool.execute("base64-budget", input, undefined, undefined, context(process.cwd()));
    assert.equal(result.details.ok, true);
    assert.equal(result.isError, false);
    const text = result.content[0].text;
    assert.ok(Buffer.byteLength(text) <= Math.min(49152, Math.ceil(input.max_bytes / 3) * 4 + 8192));
    const output = result.details.output;
    const decoded = Buffer.from(text.split("\n")[1], "base64");
    assert.equal(output.available_bytes, source.length);
    assert.equal(output.end_byte - output.start_byte, decoded.length);
    assert.equal(output.next_start_byte, output.end_byte);
    assert.equal(decoded.length, Math.min(input.max_bytes, source.length - output.start_byte));
    assert.deepEqual(decoded, source.subarray(output.start_byte, output.end_byte));
    assert.deepEqual(reads, [{ position: output.start_byte, length: decoded.length, bytesRead: decoded.length }]);
    assert.match(text, new RegExp(`omitted_before=${output.start_byte};`));
    return { output, decoded };
  };
  try {
    const tail = await page();
    assert.equal(tail.decoded.length, 30720);
    assert.equal(tail.output.start_byte, source.length - tail.decoded.length);
    assert.equal(tail.output.end_byte, source.length);
    assert.equal(tail.output.has_more, false);
    const first = await page(0);
    assert.equal(first.output.start_byte, 0);
    assert.equal(first.decoded.length, 30720);
    assert.equal(first.output.has_more, true);
    const next = await page(first.output.next_start_byte);
    assert.equal(next.output.start_byte, first.output.end_byte);
    assert.equal(next.output.end_byte, source.length);
    assert.equal(next.output.has_more, false);
    assert.deepEqual(Buffer.concat([first.decoded, next.decoded]), source);
    assert.equal(opens, 3);
    assert.equal(closes, opens);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); registry.closeAdmission(); await owner.shutdown(); registry.clear(); }
});
