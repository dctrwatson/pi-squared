import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createExpectedPackageState,
  evaluateAudit,
  formatAuditSummary,
  main,
  runNpmAudit,
} from "../../scripts/audit-prod.mjs";

const auditText = await readFile(
  new URL("./fixtures/audit-prod/allowed.json", import.meta.url),
  "utf8",
);
const allowedAudit = JSON.parse(auditText);

function evaluate(audit = allowedAudit, packageState = createExpectedPackageState()) {
  return evaluateAudit(structuredClone(audit), structuredClone(packageState));
}

function commandResult({ code = 1, signal = null, stdout = auditText, stderr = "", terminationReason } = {}) {
  return { code, signal, stdout, stderr, terminationReason };
}

async function runMain(result, packageState = createExpectedPackageState()) {
  const logs = [];
  const errors = [];
  const status = await main({
    runAudit: async () => result,
    readState: async () => structuredClone(packageState),
    logger: {
      log: (message) => logs.push(message),
      error: (message) => errors.push(message),
    },
  });
  return { status, logs, errors };
}

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.kills = [];
  }

  kill(signal) {
    this.kills.push(signal);
    return true;
  }

  close(code = 1, signal = null) {
    this.emit("close", code, signal);
  }
}

function createFakeTimers() {
  const timers = [];
  return {
    setTimer(callback, delay) {
      const timer = { callback, delay, cleared: false, fired: false };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) {
      timer.cleared = true;
    },
    fire(delay) {
      const timer = timers.find((item) => item.delay === delay && !item.cleared && !item.fired);
      assert.ok(timer, `missing timer with delay ${delay}`);
      timer.fired = true;
      timer.callback();
    },
    timers,
  };
}

function startFakeAudit({ maxOutputBytes = Buffer.byteLength(auditText) + 1 } = {}) {
  const child = new FakeChild();
  const timers = createFakeTimers();
  const calls = [];
  const promise = runNpmAudit({
    spawnProcess(command, args, options) {
      calls.push({ command, args, options });
      return child;
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    policy: { maxOutputBytes, timeoutMs: 10, killGraceMs: 5 },
  });
  return { child, timers, calls, promise };
}

test("production audit accepts the complete allowed fixture", () => {
  const result = evaluate();

  assert.deepEqual(result, { ok: true, failures: [] });
  assert.equal(
    formatAuditSummary(result),
    "audit:prod allowed: 12 advisory fingerprints on @cursor/sdk@1.0.28 -> @connectrpc/connect-node@1.7.0 -> undici@5.29.0",
  );
});

test("production audit accepts reordered advisory object members", () => {
  const audit = structuredClone(allowedAudit);
  const cvss = audit.vulnerabilities.undici.via[0].cvss;
  audit.vulnerabilities.undici.via[0].cvss = {
    vectorString: cvss.vectorString,
    score: cvss.score,
  };

  assert.deepEqual(evaluate(audit), { ok: true, failures: [] });
});

test("production audit rejects malformed reports and metadata mismatches", () => {
  const malformed = evaluate({ auditReportVersion: 2, vulnerabilities: {} });
  assert.equal(malformed.ok, false);
  assert.ok(malformed.failures.includes("npm audit output is malformed"));

  const badMetadata = structuredClone(allowedAudit);
  badMetadata.metadata.vulnerabilities.high = 0;
  badMetadata.metadata.dependencies.prod = "11";
  const result = evaluate(badMetadata);
  assert.equal(result.ok, false);
  assert.ok(result.failures.includes("npm audit vulnerability metadata high does not match findings"));
  assert.ok(result.failures.includes("npm audit dependency metadata is malformed"));
});

test("production audit rejects new, duplicate, disappearing, and changed advisories", () => {
  const newSource = structuredClone(allowedAudit);
  newSource.vulnerabilities.undici.via[0].source = 9999999;
  const newResult = evaluate(newSource);
  assert.ok(newResult.failures.includes("finding undici has unlisted advisory source 9999999"));

  const duplicate = structuredClone(allowedAudit);
  duplicate.vulnerabilities.undici.via[1] = structuredClone(duplicate.vulnerabilities.undici.via[0]);
  const duplicateResult = evaluate(duplicate);
  assert.ok(duplicateResult.failures.includes("finding undici repeats advisory source 1112496"));

  const disappeared = structuredClone(allowedAudit);
  disappeared.vulnerabilities.undici.via.pop();
  const disappearedResult = evaluate(disappeared);
  assert.ok(disappearedResult.failures.includes(
    "policy review required: Undici advisory source 1137243 is absent",
  ));

  const changed = structuredClone(allowedAudit);
  changed.vulnerabilities.undici.via[0].title = "Changed title";
  const changedResult = evaluate(changed);
  assert.ok(changedResult.failures.includes("finding undici advisory 1112496 fingerprint changed"));
});

test("production audit rejects finding changes and an available fix", () => {
  const audit = structuredClone(allowedAudit);
  audit.vulnerabilities["@cursor/sdk"].severity = "high";
  audit.vulnerabilities.undici.fixAvailable = {
    name: "undici",
    version: "7.0.0",
    isSemVerMajor: true,
  };

  const result = evaluate(audit);

  assert.ok(result.failures.includes("finding @cursor/sdk field severity changed"));
  assert.ok(result.failures.includes("finding undici field fixAvailable changed"));
});

test("production audit rejects manifest, lock, installed, and route graph drift", () => {
  const manifestDrift = createExpectedPackageState();
  manifestDrift.manifest.dependencies["@cursor/sdk"] = "1.0.29";
  assert.match(evaluate(allowedAudit, manifestDrift).failures.join("\n"), /package.json root/);

  const lockDrift = createExpectedPackageState();
  lockDrift.lockPackages["node_modules/@cursor/sdk"].dependencies["@connectrpc/connect-node"] = "^2.0.0";
  assert.match(evaluate(allowedAudit, lockDrift).failures.join("\n"), /package-lock node_modules\/@cursor\/sdk/);

  const installedDrift = createExpectedPackageState();
  installedDrift.installedPackages["node_modules/@connectrpc/connect-node"].dependencies.undici = "^6.0.0";
  assert.match(evaluate(allowedAudit, installedDrift).failures.join("\n"), /installed node_modules\/@connectrpc\/connect-node/);

  const versionDrift = createExpectedPackageState();
  versionDrift.lockPackages["node_modules/undici"].version = "5.30.0";
  assert.match(evaluate(allowedAudit, versionDrift).failures.join("\n"), /undici@5\.29\.0/);

  const extraRoute = createExpectedPackageState();
  extraRoute.lockPackages["node_modules/other"] = {
    version: "1.0.0",
    dependencies: { undici: "^5.29.0" },
  };
  assert.ok(evaluate(allowedAudit, extraRoute).failures.includes(
    "package-lock has an additional production route node_modules/other -> undici",
  ));

  const installedExtraRoute = createExpectedPackageState();
  installedExtraRoute.installedPackages["node_modules/@cursor/sdk"].dependencies.undici = "^5.29.0";
  const installedRouteFailures = evaluate(allowedAudit, installedExtraRoute).failures;
  assert.ok(installedRouteFailures.includes(
    "installed node_modules/@cursor/sdk dependencies does not match package-lock",
  ));
  assert.ok(installedRouteFailures.includes(
    "installed package has an additional production route node_modules/@cursor/sdk -> undici",
  ));
});

test("runNpmAudit handles normal completion and cleans listeners", async () => {
  const run = startFakeAudit();
  assert.deepEqual(run.calls, [{
    command: "npm",
    args: ["audit", "--omit=dev", "--json"],
    options: { cwd: process.cwd(), shell: false, stdio: ["ignore", "pipe", "pipe"] },
  }]);

  run.child.stdout.emit("data", auditText);
  run.child.close(1);
  const result = await run.promise;

  assert.equal(result.code, 1);
  assert.equal(result.stdout, auditText);
  assert.equal(result.terminationReason, undefined);
  assert.equal(run.child.listenerCount("error"), 0);
  assert.equal(run.child.listenerCount("close"), 0);
  assert.equal(run.child.stdout.listenerCount("data"), 0);
  assert.equal(run.child.stderr.listenerCount("data"), 0);
  assert.ok(run.timers.timers.every((timer) => timer.cleared));
});

test("runNpmAudit fails for synchronous and asynchronous spawn errors", async () => {
  await assert.rejects(
    runNpmAudit({
      spawnProcess() {
        throw new Error("sync failure");
      },
    }),
    /sync failure/,
  );

  const run = startFakeAudit();
  run.child.emit("error", new Error("async failure"));
  await assert.rejects(run.promise, /async failure/);
  assert.equal(run.child.listenerCount("close"), 0);
  assert.ok(run.timers.timers.every((timer) => timer.cleared));

  await assert.rejects(
    runNpmAudit({ spawnProcess: () => ({}) }),
    /invalid child process/,
  );
});

test("runNpmAudit terminates oversized output and waits for close", async () => {
  const run = startFakeAudit({ maxOutputBytes: 4 });
  run.child.stdout.emit("data", "12");
  run.child.stderr.emit("data", "345");
  assert.deepEqual(run.child.kills, ["SIGTERM"]);
  run.timers.fire(5);
  assert.deepEqual(run.child.kills, ["SIGTERM", "SIGKILL"]);
  run.child.close(null, "SIGKILL");

  const result = await run.promise;
  assert.equal(result.terminationReason, "output-overflow");
  assert.equal(result.stdout, "12");
});

test("runNpmAudit terminates a timed out command and waits for close", async () => {
  const run = startFakeAudit();
  run.timers.fire(10);
  assert.deepEqual(run.child.kills, ["SIGTERM"]);
  run.timers.fire(5);
  assert.deepEqual(run.child.kills, ["SIGTERM", "SIGKILL"]);
  run.child.close(null, "SIGKILL");

  const result = await run.promise;
  assert.equal(result.terminationReason, "timeout");
  assert.ok(run.timers.timers.every((timer) => timer.cleared));
});

test("main accepts npm audit exits 0 and 1", async () => {
  for (const code of [0, 1]) {
    const result = await runMain(commandResult({ code }));
    assert.equal(result.status, 0);
    assert.equal(result.errors.length, 0);
    assert.match(result.logs[0], /^audit:prod allowed:/);
  }
});

test("main fails when its audit command or package-state reader rejects", async () => {
  const errors = [];
  const logger = { log() {}, error: (message) => errors.push(message) };

  const auditFailure = await main({
    runAudit: async () => {
      throw new Error("audit command failure");
    },
    readState: async () => createExpectedPackageState(),
    logger,
  });
  const stateFailure = await main({
    runAudit: async () => commandResult(),
    readState: async () => {
      throw new Error("package-state failure");
    },
    logger,
  });

  assert.equal(auditFailure, 1);
  assert.equal(stateFailure, 1);
  assert.deepEqual(errors, [
    "audit:prod failed: audit command failure",
    "audit:prod failed: package-state failure",
  ]);
});

test("main fails for command exits, signals, malformed stdout, timeout, and overflow", async () => {
  const failures = [
    await runMain(commandResult({ code: 2, stderr: "network error" })),
    await runMain(commandResult({ code: null, signal: "SIGTERM" })),
    await runMain(commandResult({ code: 0, stdout: "not json" })),
    await runMain(commandResult({ code: null, terminationReason: "timeout" })),
    await runMain(commandResult({ code: null, terminationReason: "output-overflow" })),
  ];

  for (const result of failures) {
    assert.equal(result.status, 1);
    assert.equal(result.logs.length, 0);
    assert.equal(result.errors.length, 1);
  }
  assert.match(failures[0].errors[0], /exited 2/);
  assert.match(failures[1].errors[0], /signal SIGTERM/);
  assert.match(failures[2].errors[0], /malformed/);
  assert.match(failures[3].errors[0], /timed out/);
  assert.match(failures[4].errors[0], /configured limit/);
});
