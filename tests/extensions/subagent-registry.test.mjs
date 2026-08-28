import test from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const {
  MAX_CONCURRENT_SUBAGENTS,
  PersistentSubagentRegistry,
  SubagentCursorPromptFailure,
} = await import("../../extensions/subagents/registry.ts");
const { CursorCloudBackend, createCursorSubagentLifecyclePort } = await import("../../extensions/subagents/cursor-backend.ts");

test("registry creates controllers with its injected backend factory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-registry-factory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entries = [];
  const context = {
    cwd: root,
    model: undefined,
    scopedModels: [],
    sessionManager: {
      getSessionId: () => "registry-factory-parent",
      getSessionFile: () => undefined,
      getBranch: () => [],
    },
  };
  const factoryCalls = [];
  const backendFactory = (options) => {
    factoryCalls.push(options);
    const run = { id: "factory-run", runtime: "pi" };
    return {
      runtime: "pi",
      displayName: "Injected backend",
      capabilities: {
        extensionUi: false,
        steering: false,
        queuedFollowUp: false,
        modelControls: false,
        thinkingControls: false,
        sessionHistory: false,
        sessionFile: false,
        usage: false,
        toolOutput: false,
      },
      async start() {},
      async stop() {},
      getDiagnostics() { return ""; },
      async prompt() {
        options.onEvent({ type: "run_started", run });
        options.onEvent({
          type: "message_completed",
          run,
          message: { role: "assistant", text: "Factory result", thinking: "", stopReason: "stop" },
        });
        options.onEvent({ type: "run_settled", run });
        return { run };
      },
      async steer() {},
      async followUp() { return { run }; },
      async abort() {},
      async getState() {
        return {
          connection: { id: "injected-connection", runtime: "pi" },
          thinkingLevel: "off",
          isStreaming: false,
          isCompacting: false,
        };
      },
      async getHistory() { return []; },
      async getSessionStats() { return {}; },
      async getAvailableModels() { return []; },
      async setModel() { throw new Error("Unsupported"); },
      async cycleModel() { return null; },
      async setThinkingLevel() {},
      async cycleThinkingLevel() { return null; },
      respondToExtensionUI() {},
    };
  };
  const registry = new PersistentSubagentRegistry({
    getThinkingLevel: () => "low",
    appendEntry(...entry) { entries.push(entry); },
  }, backendFactory);
  registry.restore(context);
  const summary = registry.create(context, {
    mode: "fresh",
    name: "factory-agent",
    purpose: "Verify backend factory propagation",
  });

  const result = await registry.prompt(context, summary.id, "Use the injected backend");
  assert.equal(result.text, "Factory result");
  assert.equal(factoryCalls.length, 1);
  assert.equal(factoryCalls[0].cwd, root);
  assert.ok(factoryCalls[0].args.includes("--mode"));
  assert.ok(entries.length > 0);
  await registry.shutdown();
});

function registryContext(root, branch = []) {
  return {
    cwd: root,
    model: undefined,
    scopedModels: [],
    sessionManager: {
      getSessionId: () => "registry-persistence-parent",
      getSessionFile: () => join(root, "parent.jsonl"),
      getBranch: () => branch,
    },
  };
}

function controlledPiBackendFactory({ rejectPrompt } = {}) {
  const pendingRuns = [];
  let nextRun = 0;
  const backendFactory = (options) => ({
    runtime: "pi",
    displayName: "Controlled Pi",
    capabilities: {
      extensionUi: false,
      steering: false,
      queuedFollowUp: false,
      settledFollowUp: false,
      modelControls: false,
      thinkingControls: false,
      sessionHistory: false,
      sessionFile: false,
      usage: false,
      toolOutput: false,
    },
    async start() {},
    async stop() {},
    getDiagnostics() { return ""; },
    async prompt() {
      if (rejectPrompt) throw new Error(rejectPrompt);
      const run = { id: `controlled-${++nextRun}`, runtime: "pi" };
      options.onEvent({ type: "run_started", run });
      pendingRuns.push({
        settle(text = `Result ${run.id}`) {
          options.onEvent({
            type: "message_completed",
            run,
            message: { role: "assistant", text, thinking: "", stopReason: "stop" },
          });
          options.onEvent({ type: "run_settled", run });
        },
      });
      return { run };
    },
    async steer() {},
    async followUp() { throw new Error("Unsupported"); },
    async abort() {},
    async getState() {
      return {
        connection: { id: "controlled-connection", runtime: "pi" },
        thinkingLevel: "off",
        isStreaming: false,
        isCompacting: false,
      };
    },
    async getHistory() { return []; },
    async getSessionStats() { return {}; },
    async getAvailableModels() { return []; },
    async setModel() { throw new Error("Unsupported"); },
    async cycleModel() { return null; },
    async setThinkingLevel() {},
    async cycleThinkingLevel() { return null; },
    respondToExtensionUI() {},
  });
  return { backendFactory, pendingRuns };
}

async function waitForPendingRuns(pendingRuns, expected) {
  for (let attempt = 0; attempt < 100 && pendingRuns.length < expected; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(pendingRuns.length, expected);
}

function storedPi(root, id, name) {
  return {
    id,
    name,
    runtime: "pi",
    purpose: `Inspect ${name}`,
    lifetime: "persistent",
    mode: "fresh",
    cwd: root,
    createdAt: 1,
    lastActiveAt: 1,
    localLifecycle: "available",
    selectedSkillPaths: ["/skills/inspect/SKILL.md"],
    sessionDir: join(root, "subagents"),
    thinking: "low",
    scopedModels: [{ provider: "openai", id: "gpt-test" }],
  };
}

function storedCursor(root, id, name, remoteLifecycle = "idle", localLifecycle = "available") {
  const remoteCreated = remoteLifecycle !== "local";
  const pendingOperations = remoteLifecycle === "stopping"
    ? [{ kind: "cancel-run", idempotencyKey: `cancel-${id}`, createdAt: 1 }]
    : remoteLifecycle === "archive-started" || remoteLifecycle === "archive-pending"
      ? [{ kind: "archive", idempotencyKey: `archive-${id}`, createdAt: 1 }]
      : [];
  return {
    id,
    name,
    runtime: "cursor-cloud",
    purpose: `Inspect ${name}`,
    lifetime: "task",
    mode: "fresh",
    cwd: root,
    createdAt: 1,
    lastActiveAt: 1,
    localLifecycle,
    ...(remoteCreated ? {
      agentId: `bc-${id}`,
      currentRunId: `run-${id}`,
      currentRequestId: `request-${id}`,
    } : { agentId: `bc-${id}` }),
    remoteCreated,
    repositories: [{ url: "https://github.com/example/project", startingRef: "a".repeat(40) }],
    requestedProfile: "balanced",
    currentModel: {
      id: "cursor-model",
      parameters: [{ id: "thinking", value: "high" }],
      resolvedAt: 1,
    },
    pendingOperations,
    remoteLifecycle,
    pendingResult: { state: "none" },
  };
}

function registryBranch(subagents, version = 3) {
  return [{
    type: "custom",
    customType: "persistent-subagents",
    data: {
      version,
      ownerSessionId: "registry-persistence-parent",
      upserts: subagents,
      removedIds: [],
    },
  }];
}

test("registry limits concurrent work without limiting dormant continuity", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-registry-concurrency-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { backendFactory, pendingRuns } = controlledPiBackendFactory();
  const registry = new PersistentSubagentRegistry({
    getThinkingLevel: () => "low",
    appendEntry() {},
  }, backendFactory);
  const context = registryContext(root);
  registry.restore(context);
  const retained = Array.from({ length: MAX_CONCURRENT_SUBAGENTS + 1 }, (_, index) => registry.create(context, {
    name: `worker-${index + 1}`,
    purpose: `Retain worker context ${index + 1}`,
    lifetime: "task",
    mode: "fresh",
  }));
  assert.ok(retained.every(({ status }) => status === "dormant"));

  const active = retained.slice(0, MAX_CONCURRENT_SUBAGENTS)
    .map((summary) => registry.prompt(context, summary.id, "Wait for controlled settlement"));
  await waitForPendingRuns(pendingRuns, MAX_CONCURRENT_SUBAGENTS);
  await assert.rejects(
    registry.prompt(context, retained.at(-1).id, "Do not exceed the concurrent limit"),
    /Concurrent subagent limit reached \(4\)/i,
  );

  pendingRuns[0].settle("First worker settled");
  await active[0];
  const resumed = registry.prompt(context, retained.at(-1).id, "Use the released concurrent slot");
  await waitForPendingRuns(pendingRuns, MAX_CONCURRENT_SUBAGENTS + 1);
  for (const pending of pendingRuns.slice(1)) pending.settle();
  await Promise.all([...active.slice(1), resumed]);
  assert.equal(registry.list().filter(({ status }) => status !== "stopped").length, MAX_CONCURRENT_SUBAGENTS + 1);
  await registry.shutdown();
});

test("restored uncertain Cursor work consumes concurrent slots", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-registry-restored-concurrency-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pendingFirstSend = storedCursor(root, "pending-first", "pending-first", "local");
  pendingFirstSend.pendingOperations = [{ kind: "start-run", idempotencyKey: "start-pending", createdAt: 1 }];
  const pendingFollowUp = storedCursor(root, "pending-follow-up", "pending-follow-up", "idle");
  pendingFollowUp.pendingOperations = [{
    kind: "follow-up",
    idempotencyKey: "follow-up-pending",
    nonce: "follow-up-nonce",
    createdAt: 1,
  }];
  const uncertain = [
    storedCursor(root, "stopping", "stopping", "stopping", "unavailable"),
    storedCursor(root, "unknown", "unknown", "remote-state-unknown", "unavailable"),
    pendingFirstSend,
    pendingFollowUp,
  ];

  for (const candidate of uncertain) {
    const { backendFactory } = controlledPiBackendFactory({ rejectPrompt: "Concurrent work escaped its limit" });
    const registry = new PersistentSubagentRegistry({
      getThinkingLevel: () => "low",
      appendEntry() {},
    }, backendFactory);
    const context = registryContext(root, registryBranch([
      storedCursor(root, `${candidate.id}-running-1`, "running-1", "running"),
      storedCursor(root, `${candidate.id}-running-2`, "running-2", "running"),
      storedCursor(root, `${candidate.id}-running-3`, "running-3", "running"),
      candidate,
    ]));
    registry.restore(context);
    const retained = registry.create(context, {
      name: `waiting-${candidate.id}`,
      purpose: `Wait for restored ${candidate.id} work`,
      lifetime: "task",
      mode: "fresh",
    });
    await assert.rejects(
      registry.prompt(context, retained.id, "Do not exceed restored work"),
      /Concurrent subagent limit reached \(4\)/i,
      candidate.id,
    );
    await registry.shutdown();
  }
});

test("registry migrates stopped version 1 and explicit Pi version 2 records", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-registry-legacy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const versionOne = storedPi(root, "legacy-v1", "legacy-v1");
  delete versionOne.runtime;
  delete versionOne.localLifecycle;
  versionOne.stopped = true;
  const versionTwo = storedPi(root, "legacy-v2", "legacy-v2");
  versionTwo.runtime = "pi";
  delete versionTwo.localLifecycle;
  versionTwo.stopped = true;
  const entries = [];
  const registry = new PersistentSubagentRegistry({
    getThinkingLevel: () => "low",
    appendEntry(customType, data) { entries.push({ customType, data }); },
  });
  registry.restore(registryContext(root, [
    {
      type: "custom",
      customType: "persistent-subagents",
      data: {
        version: 1,
        ownerSessionId: "registry-persistence-parent",
        subagents: [versionOne],
      },
    },
    ...registryBranch([versionTwo], 2),
  ]));

  assert.deepEqual(registry.list().map(({ id, runtime, status }) => ({ id, runtime, status })), [
    { id: "legacy-v1", runtime: "pi", status: "stopped" },
    { id: "legacy-v2", runtime: "pi", status: "stopped" },
  ]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].data.version, 3);
  assert.ok(entries[0].data.upserts.every((stored) => stored.runtime === "pi"));
  assert.ok(entries[0].data.upserts.every((stored) => stored.localLifecycle === "stopped"));
  for (let index = 1; index <= 5; index++) {
    assert.equal(registry.create(registryContext(root), {
      name: `retained-${index}`,
      purpose: `Retain dormant context ${index}`,
      mode: "fresh",
    }).status, "dormant");
  }
});

test("registry persists tombstones when migration prunes stopped legacy records", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-registry-legacy-prune-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stoppedLegacy = (id, lastActiveAt, includeRuntime) => {
    const stored = storedPi(root, id, id);
    if (!includeRuntime) delete stored.runtime;
    else stored.runtime = "pi";
    delete stored.localLifecycle;
    stored.stopped = true;
    stored.lastActiveAt = lastActiveAt;
    return stored;
  };
  const versionOne = Array.from({ length: 11 }, (_, index) =>
    stoppedLegacy(`v1-${index + 1}`, index + 1, false));
  const versionTwo = Array.from({ length: 11 }, (_, index) =>
    stoppedLegacy(`v2-${index + 12}`, index + 12, true));
  const branch = [{
    type: "custom",
    customType: "persistent-subagents",
    data: {
      version: 1,
      ownerSessionId: "registry-persistence-parent",
      subagents: versionOne,
    },
  }, ...registryBranch(versionTwo, 2)];
  const entries = [];
  const registry = new PersistentSubagentRegistry({
    getThinkingLevel: () => "low",
    appendEntry(customType, data) { entries.push({ customType, data }); },
  });
  registry.restore(registryContext(root, branch));

  assert.equal(registry.list().length, 20);
  assert.equal(entries.length, 1);
  const migration = entries[0].data;
  assert.equal(migration.version, 3);
  assert.equal(migration.upserts.length, 20);
  assert.deepEqual([...migration.removedIds].sort(), ["v1-1", "v1-2"]);

  const replay = new PersistentSubagentRegistry({ getThinkingLevel: () => "low", appendEntry() {} });
  replay.restore(registryContext(root, [...branch, {
    type: "custom",
    customType: "persistent-subagents",
    data: migration,
  }]));
  assert.equal(replay.list().length, 20);
  assert.deepEqual(replay.list().map(({ id }) => id).filter((id) => id === "v1-1" || id === "v1-2"), []);
});

test("registry persists tombstones for pruned normalized version 3 records", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-registry-v3-prune-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const records = Array.from({ length: 21 }, (_, index) => {
    const stored = storedPi(root, `v3-${index + 1}`, `v3-${index + 1}`);
    stored.localLifecycle = "stopped";
    stored.lastActiveAt = index + 1;
    return stored;
  });
  records[0].activeBlocker = { reason: "Old blocker", need: "Old need" };
  records[20].activeBlocker = { reason: "Retained blocker", need: "Retained need" };
  const branch = registryBranch(records);
  const entries = [];
  const registry = new PersistentSubagentRegistry({
    getThinkingLevel: () => "low",
    appendEntry(customType, data) { entries.push({ customType, data }); },
  });
  registry.restore(registryContext(root, branch));

  assert.equal(entries.length, 1);
  const mutation = entries[0].data;
  assert.deepEqual(mutation.removedIds, ["v3-1"]);
  assert.deepEqual(mutation.upserts.map((stored) => stored.id), ["v3-21"]);
  assert.equal(mutation.upserts[0].activeBlocker, undefined);

  const replay = new PersistentSubagentRegistry({ getThinkingLevel: () => "low", appendEntry() {} });
  replay.restore(registryContext(root, [...branch, {
    type: "custom",
    customType: "persistent-subagents",
    data: mutation,
  }]));
  assert.equal(replay.list().length, 20);
  assert.equal(replay.list().some(({ id }) => id === "v3-1"), false);
  assert.equal(replay.summaryFor("v3-21").blocker, undefined);
});

test("malformed stored persona context does not abort versioned restore", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-registry-malformed-persona-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const malformed = (id) => ({
    ...storedPi(root, id, id),
    persona: {
      name: "invalid-persona",
      description: "Invalid persisted persona",
      systemPrompt: "Inspect the project.",
      runtime: "pi",
      extensions: [],
      skills: [],
      filePath: "/personas/invalid.md",
      contextRequirements: "x".repeat(241),
    },
  });
  const branches = [
    [{
      type: "custom",
      customType: "persistent-subagents",
      data: {
        version: 1,
        ownerSessionId: "registry-persistence-parent",
        subagents: [storedPi(root, "v1-valid", "v1-valid"), malformed("v1-invalid")],
      },
    }],
    registryBranch([storedPi(root, "v2-valid", "v2-valid"), malformed("v2-invalid")], 2),
    registryBranch([storedPi(root, "v3-valid", "v3-valid"), malformed("v3-invalid")]),
  ];
  for (const [index, branch] of branches.entries()) {
    const registry = new PersistentSubagentRegistry({ getThinkingLevel: () => "low", appendEntry() {} });
    assert.doesNotThrow(() => registry.restore(registryContext(root, branch)));
    assert.deepEqual(registry.list().map(({ name }) => name), [`v${index + 1}-valid`]);
  }
});

test("stored persona lifetime preferences restore as inert legacy data", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-registry-legacy-persona-lifetime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stored = storedPi(root, "legacy-persona", "legacy-persona");
  stored.lifetime = "task";
  stored.persona = {
    name: "legacy-reviewer",
    description: "Review one change",
    systemPrompt: "Review the requested change.",
    runtime: "pi",
    preferredLifetime: "one-shot",
    preferredProfile: "fast",
    extensions: [],
    skills: [],
    filePath: "/personas/legacy-reviewer.md",
  };
  const registry = new PersistentSubagentRegistry({ getThinkingLevel: () => "low", appendEntry() {} });
  registry.restore(registryContext(root, registryBranch([stored])));

  const restored = registry.resolve(stored.id).stored;
  assert.equal(restored.lifetime, "task");
  assert.equal(Object.hasOwn(restored.persona, "preferredLifetime"), false);
  assert.equal(restored.persona.preferredProfile, "fast");
});

test("registry represents each saved Cursor lifecycle without remote access", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-registry-cursor-state-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lifecycleStates = [
    ["local", "available", "dormant"],
    ["idle", "available", "idle"],
    ["running", "available", "running"],
    ["stopping", "unavailable", "stopping"],
    ["archive-started", "unavailable", "stopping"],
    ["archive-pending", "unavailable", "archive-pending"],
    ["remote-state-unknown", "unavailable", "remote-state-unknown"],
    ["archived", "available", "stopped"],
  ];
  const registry = new PersistentSubagentRegistry({
    getThinkingLevel: () => "low",
    appendEntry() {},
  }, undefined, {
    async reconcile(stored) {
      return { remoteLifecycle: stored.remoteLifecycle };
    },
  });
  registry.restore(registryContext(root, registryBranch(lifecycleStates.map(([remote, local], index) =>
    storedCursor(root, `cursor-${index}`, `cursor-${index}`, remote, local)))));

  for (const [remote, _local, expected] of lifecycleStates) {
    const summary = await registry.status(`cursor-${lifecycleStates.findIndex(([candidate]) => candidate === remote)}`);
    assert.equal(summary.status, expected, remote);
  }
});

test("malformed Cursor identity and cleanup combinations do not restore", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-registry-cursor-invariants-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const invalid = [];
  const missingAgent = storedCursor(root, "missing-agent", "missing-agent", "idle");
  delete missingAgent.agentId;
  invalid.push(missingAgent);
  // requestId is optional in the installed public SDK. The run ID is durable authority.
  const unsafeRun = storedCursor(root, "unsafe-run", "unsafe-run", "running");
  unsafeRun.currentRunId = "\u0000";
  invalid.push(unsafeRun);
  const missingArchive = storedCursor(root, "missing-archive", "missing-archive", "archive-pending", "unavailable");
  missingArchive.pendingOperations = [];
  invalid.push(missingArchive);
  const contradictoryLocal = storedCursor(root, "contradictory-local", "contradictory-local", "local");
  contradictoryLocal.remoteCreated = true;
  invalid.push(contradictoryLocal);
  const uncertainWithCreate = storedCursor(root, "uncertain-create", "uncertain-create", "remote-state-unknown", "unavailable");
  uncertainWithCreate.remoteCreated = false;
  delete uncertainWithCreate.currentRunId;
  delete uncertainWithCreate.currentRequestId;
  uncertainWithCreate.pendingOperations = [{ kind: "create-agent", idempotencyKey: "create-uncertain", createdAt: 1 }];
  invalid.push(uncertainWithCreate);
  const repositoryWithQueryDelimiter = storedCursor(root, "query-delimiter", "query-delimiter");
  repositoryWithQueryDelimiter.repositories = [{ url: "https://github.com/example/project?" }];
  invalid.push(repositoryWithQueryDelimiter);
  const repositoryWithFragmentDelimiter = storedCursor(root, "fragment-delimiter", "fragment-delimiter");
  repositoryWithFragmentDelimiter.repositories = [{ url: "https://github.com/example/project#" }];
  invalid.push(repositoryWithFragmentDelimiter);
  const wrongCloudRouting = storedCursor(root, "wrong-cloud-routing", "wrong-cloud-routing");
  wrongCloudRouting.agentId = "local-agent-id";
  invalid.push(wrongCloudRouting);
  const wrongRunRouting = storedCursor(root, "wrong-run-routing", "wrong-run-routing", "running");
  wrongRunRouting.currentRunId = "local-run-id";
  invalid.push(wrongRunRouting);
  const unpinnedPrimary = storedCursor(root, "unpinned-primary", "unpinned-primary");
  unpinnedPrimary.repositories = [{ url: "https://github.com/example/project", startingRef: "main" }];
  invalid.push(unpinnedPrimary);
  const invalidSupportRef = storedCursor(root, "invalid-support-ref", "invalid-support-ref");
  invalidSupportRef.repositories = [
    { url: "https://github.com/example/project", startingRef: "a".repeat(40) },
    { url: "https://github.com/example/support", startingRef: "main..unsafe" },
  ];
  invalid.push(invalidSupportRef);
  const invalidFollowBaseline = storedCursor(root, "invalid-follow-baseline", "invalid-follow-baseline", "remote-state-unknown", "unavailable");
  invalidFollowBaseline.pendingOperations = [{ kind: "follow-up", idempotencyKey: "invalid-baseline", createdAt: 1, baselineRunId: "not-a-run", baselineCreatedAt: 1 }];
  invalid.push(invalidFollowBaseline);
  const oversizedPendingNonce = storedCursor(root, "oversized-pending-nonce", "oversized-pending-nonce", "remote-state-unknown", "unavailable");
  oversizedPendingNonce.remoteCreated = false;
  delete oversizedPendingNonce.currentRunId;
  delete oversizedPendingNonce.currentRequestId;
  oversizedPendingNonce.pendingOperations = [{ kind: "start-run", idempotencyKey: "oversized-nonce", nonce: "x".repeat(257), createdAt: 1 }];
  invalid.push(oversizedPendingNonce);
  const mismatchedPendingResult = storedCursor(root, "mismatched-pending-result", "mismatched-pending-result");
  mismatchedPendingResult.pendingResult = { state: "available", runId: "run-other-result" };
  invalid.push(mismatchedPendingResult);
  const conflictingDuplicateRepository = storedCursor(root, "conflicting-duplicate-repository", "conflicting-duplicate-repository");
  conflictingDuplicateRepository.repositories = [
    { url: "git@github.com:Example/Project.git", startingRef: "a".repeat(40) },
    { url: "https://github.com/example/project", startingRef: "b".repeat(40) },
  ];
  invalid.push(conflictingDuplicateRepository);

  for (const stored of invalid) {
    const registry = new PersistentSubagentRegistry({ getThinkingLevel: () => "low", appendEntry() {} });
    registry.restore(registryContext(root, registryBranch([
      storedPi(root, `valid-${stored.id}`, `valid-${stored.id}`),
      stored,
    ])));
    assert.deepEqual(registry.list().map(({ id }) => id), [`valid-${stored.id}`], stored.id);
  }

  const normalizedRepository = storedCursor(root, "normalized-repository", "normalized-repository");
  normalizedRepository.repositories = [{ url: "git@github.com:Example/Project.git", startingRef: "A".repeat(40) }];
  const normalized = new PersistentSubagentRegistry({ getThinkingLevel: () => "low", appendEntry() {} });
  normalized.restore(registryContext(root, registryBranch([normalizedRepository])));
  assert.deepEqual(normalized.resolve("normalized-repository").stored.repositories, [{
    url: "https://github.com/Example/Project", startingRef: "a".repeat(40),
  }]);

  const validPendingResult = storedCursor(root, "valid-pending-result", "valid-pending-result");
  validPendingResult.pendingResult = { state: "available", runId: validPendingResult.currentRunId };
  const pendingResultRegistry = new PersistentSubagentRegistry({ getThinkingLevel: () => "low", appendEntry() {} });
  pendingResultRegistry.restore(registryContext(root, registryBranch([validPendingResult])));
  assert.deepEqual(pendingResultRegistry.resolve("valid-pending-result").stored.pendingResult, validPendingResult.pendingResult);

  const duplicateRepository = storedCursor(root, "duplicate-repository", "duplicate-repository");
  duplicateRepository.repositories = [
    { url: "https://github.com/Example/Project", startingRef: "a".repeat(40) },
    { url: "git@github.com:example/project.git", startingRef: "a".repeat(40) },
  ];
  const deduplicated = new PersistentSubagentRegistry({ getThinkingLevel: () => "low", appendEntry() {} });
  deduplicated.restore(registryContext(root, registryBranch([duplicateRepository])));
  assert.deepEqual(deduplicated.resolve("duplicate-repository").stored.repositories, [{
    url: "https://github.com/Example/Project", startingRef: "a".repeat(40),
  }]);

  const pendingHandle = storedCursor(root, "pending-handle", "pending-handle", "local");
  delete pendingHandle.agentId;
  pendingHandle.pendingOperations = [{ kind: "create-agent", idempotencyKey: "create-handle", createdAt: 1 }];
  const pendingFirstRun = storedCursor(root, "pending-first-run", "pending-first-run", "local");
  pendingFirstRun.pendingOperations = [{ kind: "start-run", idempotencyKey: "start-first-run", createdAt: 1 }];
  const lazy = new PersistentSubagentRegistry({ getThinkingLevel: () => "low", appendEntry() {} });
  lazy.restore(registryContext(root, registryBranch([pendingHandle, pendingFirstRun])));
  assert.deepEqual(lazy.list().map(({ id, status }) => ({ id, status })), [
    { id: "pending-handle", status: "dormant" },
    { id: "pending-first-run", status: "dormant" },
  ]);
});

test("Cursor cleanup states do not block dormant retention", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-registry-slots-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const archivePending = storedCursor(root, "archive", "archive", "archive-pending", "unavailable");
  const remoteUnknown = storedCursor(root, "unknown", "unknown", "remote-state-unknown", "unavailable");
  const registry = new PersistentSubagentRegistry({ getThinkingLevel: () => "low", appendEntry() {} });
  registry.restore(registryContext(root, registryBranch([
    archivePending,
    remoteUnknown,
    storedPi(root, "pi-one", "pi-one"),
    storedPi(root, "pi-two", "pi-two"),
  ])));

  assert.equal(registry.summaryFor("archive").status, "archive-pending");
  assert.equal(registry.summaryFor("unknown").status, "remote-state-unknown");
  for (const name of ["pi-three", "pi-four"]) {
    assert.equal(registry.create(registryContext(root), {
      name,
      purpose: `Retain ${name}`,
      mode: "fresh",
    }).status, "dormant");
  }
});

test("Cursor stop preserves failure and archive retry states", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-registry-stop-lifecycle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const occupiedBranch = (record) => registryBranch([
    record,
    storedPi(root, "pi-one", "pi-one"),
    storedPi(root, "pi-two", "pi-two"),
    storedPi(root, "pi-three", "pi-three"),
  ]);

  const failureEntries = [];
  const failure = new PersistentSubagentRegistry({
    getThinkingLevel: () => "low",
    appendEntry(customType, data) { failureEntries.push({ customType, data }); },
  }, undefined, {
    async reconcile(stored) { return { remoteLifecycle: stored.remoteLifecycle }; },
    async stop() { throw new Error("Cancellation failed before archival"); },
  });
  failure.restore(registryContext(root, occupiedBranch(storedCursor(root, "failure", "failure", "idle", "available"))));
  await assert.rejects(failure.stop("failure"), /before archival/);
  assert.equal(failure.summaryFor("failure").status, "remote-state-unknown");
  const failed = failureEntries.flatMap(({ data }) => data.upserts ?? [])
    .filter((entry) => entry.id === "failure").at(-1);
  assert.equal(failed.pendingOperations[0].kind, "cancel-run");
  assert.equal(failure.create(registryContext(root), {
    name: "pi-four",
    purpose: "Retain work while cleanup is uncertain",
    mode: "fresh",
  }).status, "dormant");

  const archiveStarted = new PersistentSubagentRegistry({ getThinkingLevel: () => "low", appendEntry() {} });
  archiveStarted.restore(registryContext(root, occupiedBranch(
    storedCursor(root, "archive-started", "archive-started", "archive-started", "unavailable"),
  )));
  assert.equal(archiveStarted.create(registryContext(root), {
    name: "pi-four",
    purpose: "Retain work while archival starts",
    mode: "fresh",
  }).status, "dormant");

  const retryEntries = [];
  let attempts = 0;
  let retriedArchiveKey;
  const retry = new PersistentSubagentRegistry({
    getThinkingLevel: () => "low",
    appendEntry(customType, data) { retryEntries.push({ customType, data }); },
  }, undefined, {
    async reconcile(stored) { return { remoteLifecycle: stored.remoteLifecycle }; },
    async stop(stored, progress) {
      attempts++;
      if (attempts === 1) {
        progress.persistArchiveStarted();
        return { state: "archive-pending" };
      }
      retriedArchiveKey = stored.pendingOperations.find((operation) => operation.kind === "archive")?.idempotencyKey;
      return { state: "stopped" };
    },
  });
  retry.restore(registryContext(root, occupiedBranch(storedCursor(root, "retry", "retry", "idle", "available"))));
  assert.equal((await retry.stop("retry")).status, "archive-pending");
  const archiveKey = retryEntries.flatMap(({ data }) => data.upserts ?? [])
    .filter((entry) => entry.id === "retry" && entry.remoteLifecycle === "archive-pending").at(-1)
    .pendingOperations.find((operation) => operation.kind === "archive")?.idempotencyKey;
  assert.ok(archiveKey);
  assert.equal(retry.create(registryContext(root), {
    name: "pi-four",
    purpose: "Retain work while archival is pending",
    mode: "fresh",
  }).status, "dormant");
  assert.equal((await retry.stop("retry")).status, "stopped");
  assert.equal(retriedArchiveKey, archiveKey);
});

test("pre-send lazy Cursor handles stop locally and persists terminal state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-registry-local-stop-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entries = [];
  const local = storedCursor(root, "local", "local", "local");
  local.pendingOperations = [{ kind: "create-agent", idempotencyKey: "create-local", createdAt: 1 }];
  const registry = new PersistentSubagentRegistry({
    getThinkingLevel: () => "low",
    appendEntry(customType, data) { entries.push({ customType, data }); },
  });
  registry.restore(registryContext(root, registryBranch([
    local,
    storedPi(root, "pi-one", "pi-one"),
    storedPi(root, "pi-two", "pi-two"),
    storedPi(root, "pi-three", "pi-three"),
  ])));

  const stopped = await registry.stop("local");
  assert.equal(stopped.status, "stopped");
  const persisted = entries.at(-1).data.upserts.find((entry) => entry.id === "local");
  assert.equal(persisted.remoteCreated, false);
  assert.equal(persisted.remoteLifecycle, "local");
  assert.equal(persisted.localLifecycle, "stopped");
  assert.equal(persisted.agentId, undefined);
  assert.deepEqual(persisted.pendingOperations, []);

  const retained = registry.create(registryContext(root), {
    name: "pi-four",
    purpose: "Retain work after local Cursor cleanup",
    mode: "fresh",
  });
  assert.equal(retained.status, "dormant");

  const restored = new PersistentSubagentRegistry({ getThinkingLevel: () => "low", appendEntry() {} });
  restored.restore(registryContext(root, registryBranch([persisted])));
  assert.equal(restored.summaryFor("local").status, "stopped");
});

test("pending first sends reconcile before remote stop", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-registry-first-send-stop-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const firstSend = storedCursor(root, "first-send", "first-send", "local");
  firstSend.pendingOperations = [{ kind: "start-run", idempotencyKey: "start-first-send", createdAt: 1 }];
  const reconciliations = [];
  const stops = [];
  const registry = new PersistentSubagentRegistry({ getThinkingLevel: () => "low", appendEntry() {} }, undefined, {
    async reconcile(stored) {
      reconciliations.push(stored);
      return { remoteLifecycle: "idle" };
    },
    async stop(stored) {
      stops.push(stored);
      return { state: "stopped" };
    },
  });
  registry.restore(registryContext(root, registryBranch([firstSend])));

  const stopped = await registry.stop("first-send");
  assert.equal(stopped.status, "stopped");
  assert.equal(reconciliations.length, 1);
  assert.equal(reconciliations[0].agentId, "bc-first-send");
  assert.deepEqual(reconciliations[0].pendingOperations, [{
    kind: "start-run",
    idempotencyKey: "start-first-send",
    createdAt: 1,
  }]);
  assert.equal(stops.length, 1);
  assert.equal(stops[0].remoteCreated, true);
  assert.equal(stops[0].agentId, "bc-first-send");
});

test("pending first sends retain durable state when reconciliation is unavailable or uncertain", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-registry-first-send-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const unavailableRecord = storedCursor(root, "unavailable", "unavailable", "local");
  unavailableRecord.pendingOperations = [{ kind: "start-run", idempotencyKey: "start-unavailable", createdAt: 1 }];
  const unavailableEntries = [];
  const unavailable = new PersistentSubagentRegistry({
    getThinkingLevel: () => "low",
    appendEntry(customType, data) { unavailableEntries.push({ customType, data }); },
  });
  unavailable.restore(registryContext(root, registryBranch([unavailableRecord])));
  await assert.rejects(unavailable.stop("unavailable"), /CURSOR_API_KEY/i);
  const retained = unavailable.resolve("unavailable").stored;
  assert.equal(retained.agentId, "bc-unavailable");
  assert.deepEqual(retained.pendingOperations, [{
    kind: "start-run",
    idempotencyKey: "start-unavailable",
    createdAt: 1,
  }]);
  assert.equal(unavailableEntries.length, 0);

  const uncertainRecord = storedCursor(root, "uncertain", "uncertain", "local");
  uncertainRecord.pendingOperations = [{ kind: "start-run", idempotencyKey: "start-uncertain", createdAt: 1 }];
  const uncertainEntries = [];
  const uncertain = new PersistentSubagentRegistry({
    getThinkingLevel: () => "low",
    appendEntry(customType, data) { uncertainEntries.push({ customType, data }); },
  }, undefined, {
    async reconcile() { return { remoteLifecycle: "remote-state-unknown" }; },
  });
  uncertain.restore(registryContext(root, registryBranch([uncertainRecord])));
  assert.equal((await uncertain.stop("uncertain")).status, "remote-state-unknown");
  const persisted = uncertainEntries.at(-1).data.upserts.find((entry) => entry.id === "uncertain");
  assert.equal(persisted.remoteCreated, false);
  assert.equal(persisted.remoteLifecycle, "remote-state-unknown");
  assert.equal(persisted.localLifecycle, "unavailable");
  assert.equal(persisted.agentId, "bc-uncertain");
  assert.deepEqual(persisted.pendingOperations, [{
    kind: "start-run",
    idempotencyKey: "start-uncertain",
    createdAt: 1,
  }]);

  const recoveryEntries = [];
  const recovered = new PersistentSubagentRegistry({
    getThinkingLevel: () => "low",
    appendEntry(customType, data) { recoveryEntries.push({ customType, data }); },
  }, undefined, {
    async reconcile(stored) {
      assert.equal(stored.remoteCreated, false);
      assert.equal(stored.agentId, "bc-uncertain");
      return { remoteLifecycle: "local" };
    },
  });
  recovered.restore(registryContext(root, registryBranch([persisted])));
  assert.equal((await recovered.status("uncertain")).status, "dormant");
  const retry = recoveryEntries.at(-1).data.upserts.find((entry) => entry.id === "uncertain");
  assert.equal(retry.remoteCreated, false);
  assert.equal(retry.remoteLifecycle, "local");
  assert.equal(retry.localLifecycle, "available");
  assert.equal(retry.agentId, "bc-uncertain");
  assert.deepEqual(retry.pendingOperations, [{
    kind: "start-run",
    idempotencyKey: "start-uncertain",
    createdAt: 1,
  }]);
});

test("pending first sends stop locally after authoritative local reconciliation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-registry-first-send-local-stop-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entries = [];
  const firstSend = storedCursor(root, "first-send-local", "first-send-local", "local");
  firstSend.pendingOperations = [{ kind: "start-run", idempotencyKey: "start-local", createdAt: 1 }];
  let remoteStops = 0;
  const registry = new PersistentSubagentRegistry({
    getThinkingLevel: () => "low",
    appendEntry(customType, data) { entries.push({ customType, data }); },
  }, undefined, {
    async reconcile() { return { remoteLifecycle: "local" }; },
    async stop() { remoteStops++; return { state: "stopped" }; },
  });
  registry.restore(registryContext(root, registryBranch([
    firstSend,
    storedPi(root, "pi-one", "pi-one"),
    storedPi(root, "pi-two", "pi-two"),
    storedPi(root, "pi-three", "pi-three"),
  ])));

  assert.equal((await registry.stop("first-send-local")).status, "stopped");
  assert.equal(remoteStops, 0);
  const persisted = entries.flatMap(({ data }) => data.upserts ?? [])
    .filter((entry) => entry.id === "first-send-local").at(-1);
  assert.equal(persisted.remoteCreated, false);
  assert.equal(persisted.remoteLifecycle, "local");
  assert.equal(persisted.localLifecycle, "stopped");
  assert.equal(persisted.agentId, undefined);
  assert.deepEqual(persisted.pendingOperations, []);
  assert.equal(registry.create(registryContext(root), {
    name: "pi-four",
    purpose: "Retain work after the stopped first send",
    mode: "fresh",
  }).status, "dormant");
});

test("pending first sends remain unknown when reconciliation returns no result", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-registry-first-send-no-result-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entries = [];
  const firstSend = storedCursor(root, "first-send-none", "first-send-none", "local");
  firstSend.pendingOperations = [{ kind: "start-run", idempotencyKey: "start-none", createdAt: 1 }];
  let remoteStops = 0;
  const registry = new PersistentSubagentRegistry({
    getThinkingLevel: () => "low",
    appendEntry(customType, data) { entries.push({ customType, data }); },
  }, undefined, {
    async reconcile() { return undefined; },
    async stop() { remoteStops++; return { state: "stopped" }; },
  });
  registry.restore(registryContext(root, registryBranch([
    firstSend,
    storedPi(root, "pi-one", "pi-one"),
    storedPi(root, "pi-two", "pi-two"),
    storedPi(root, "pi-three", "pi-three"),
  ])));

  assert.equal((await registry.stop("first-send-none")).status, "remote-state-unknown");
  assert.equal(remoteStops, 0);
  const persisted = entries.at(-1).data.upserts.find((entry) => entry.id === "first-send-none");
  assert.equal(persisted.remoteCreated, false);
  assert.equal(persisted.remoteLifecycle, "remote-state-unknown");
  assert.equal(persisted.localLifecycle, "unavailable");
  assert.equal(persisted.agentId, "bc-first-send-none");
  assert.deepEqual(persisted.pendingOperations, [{
    kind: "start-run",
    idempotencyKey: "start-none",
    createdAt: 1,
  }]);
  assert.equal(registry.create(registryContext(root), {
    name: "pi-four",
    purpose: "Retain work while the first send is uncertain",
    mode: "fresh",
  }).status, "dormant");
});

test("Cursor operations persist identity before later work and retain uncertain cleanup", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-registry-operations-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entries = [];
  let persistedBeforeStop = false;
  const registry = new PersistentSubagentRegistry({
    getThinkingLevel: () => "low",
    appendEntry(customType, data) { entries.push({ customType, data }); },
  }, undefined, {
    async reconcile(stored) {
      return { remoteLifecycle: stored.remoteLifecycle };
    },
    async stop(stored) {
      const storedBeforeStop = entries.at(-1).data.upserts.find((entry) => entry.id === stored.id);
      persistedBeforeStop = storedBeforeStop?.remoteLifecycle === "stopping"
        && storedBeforeStop?.pendingOperations[0]?.kind === "cancel-run";
      return { state: "remote-state-unknown" };
    },
  });
  const local = storedCursor(root, "local", "local", "local", "available");
  local.remoteCreated = false;
  local.apiKey = "secret-test-key";
  local.cloudTranscript = "full Cloud transcript must not persist";
  const running = storedCursor(root, "running", "running", "running", "available");
  registry.restore(registryContext(root, registryBranch([local, running])));

  let identityPersisted = false;
  await registry.runCursorOperation("local", async (stored, persist) => {
    persist({
      ...stored,
      agentId: "bc-durable",
      pendingOperations: [{ kind: "create-agent", idempotencyKey: "operation-create", createdAt: 2 }],
    });
    identityPersisted = entries.at(-1).data.upserts[0].agentId === "bc-durable";
  });
  assert.equal(identityPersisted, true);

  const operationOrder = [];
  let firstStarted;
  const firstHasStarted = new Promise((resolve) => { firstStarted = resolve; });
  let releaseFirst;
  const firstMayFinish = new Promise((resolve) => { releaseFirst = resolve; });
  const first = registry.runCursorOperation("local", async () => {
    operationOrder.push("first-start");
    firstStarted();
    await firstMayFinish;
    operationOrder.push("first-end");
  });
  await firstHasStarted;
  const second = registry.runCursorOperation("local", async () => {
    operationOrder.push("second");
  });
  const different = registry.runCursorOperation("running", async () => {
    operationOrder.push("different-record");
  });
  await different;
  assert.deepEqual(operationOrder, ["first-start", "different-record"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(operationOrder, ["first-start", "different-record", "first-end", "second"]);

  const stopped = await registry.stop("running");
  assert.equal(persistedBeforeStop, true);
  assert.equal(stopped.status, "remote-state-unknown");
  assert.equal(registry.summaryFor("running").status, "remote-state-unknown");
  assert.doesNotMatch(JSON.stringify(entries), /secret-test-key|full Cloud transcript|CURSOR_API_KEY|conversation/i);
});

test("Cursor operations queued during stop do not run after archival", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-registry-stop-operation-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let stopStarted;
  const stopping = new Promise((resolve) => { stopStarted = resolve; });
  let finishStop;
  const stopMayFinish = new Promise((resolve) => { finishStop = resolve; });
  let effects = 0;
  const registry = new PersistentSubagentRegistry({ getThinkingLevel: () => "low", appendEntry() {} }, undefined, {
    async reconcile(stored) { return { remoteLifecycle: stored.remoteLifecycle }; },
    async stop() {
      stopStarted();
      await stopMayFinish;
      return { state: "stopped" };
    },
  });
  registry.restore(registryContext(root, registryBranch([
    storedCursor(root, "race", "race", "idle", "available"),
  ])));

  const stopped = registry.stop("race");
  await stopping;
  const queued = registry.runCursorOperation("race", async () => { effects++; });
  finishStop();
  assert.equal((await stopped).status, "stopped");
  await assert.rejects(queued, /has been stopped/i);
  assert.equal(effects, 0);
});

test("Cursor operations persist queued work but reject late submissions after shutdown starts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-registry-operation-shutdown-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entries = [];
  const timeline = [];
  let started;
  const inFlightStarted = new Promise((resolve) => { started = resolve; });
  let releaseInFlight;
  const inFlightReleased = new Promise((resolve) => { releaseInFlight = resolve; });
  const registry = new PersistentSubagentRegistry({
    getThinkingLevel: () => "low",
    appendEntry(customType, data) { entries.push({ customType, data }); },
  }, undefined, {
    async disposeObservers() { timeline.push("dispose"); },
  });
  registry.restore(registryContext(root, registryBranch([
    storedCursor(root, "cursor", "cursor", "idle", "available"),
  ])));

  const inFlight = registry.runCursorOperation("cursor", async (stored, persist) => {
    started();
    await inFlightReleased;
    persist({ ...stored, requestedProfile: "fast" });
    assert.equal(entries.at(-1).data.upserts.find((entry) => entry.id === stored.id)?.requestedProfile, "fast");
    timeline.push("in-flight-persisted", "in-flight-remote-effect");
  });
  await inFlightStarted;
  const queued = registry.runCursorOperation("cursor", async (stored, persist) => {
    persist({ ...stored, requestedProfile: "deep" });
    assert.equal(entries.at(-1).data.upserts.find((entry) => entry.id === stored.id)?.requestedProfile, "deep");
    timeline.push("queued-persisted", "queued-remote-effect");
  });
  const shutdown = registry.shutdown();
  await assert.rejects(registry.runCursorOperation("cursor", async () => {
    throw new Error("Late Cursor operation ran");
  }), /registry is shutting down/i);
  releaseInFlight();
  await Promise.all([inFlight, queued, shutdown]);

  assert.deepEqual(timeline, [
    "in-flight-persisted",
    "in-flight-remote-effect",
    "queued-persisted",
    "queued-remote-effect",
    "dispose",
  ]);
  const updates = entries.flatMap(({ data }) => data.upserts ?? [])
    .filter((entry) => entry.id === "cursor").map((entry) => entry.requestedProfile);
  assert.deepEqual(updates, ["fast", "deep"]);
});

test("Cursor stop retains archive recovery state through shutdown and a lost response", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-registry-stop-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entries = [];
  let archiveStatePersisted = false;
  let stopStarted;
  const stopMayFail = new Promise((resolve) => { stopStarted = resolve; });
  let releaseLostResponse;
  const lostResponse = new Promise((resolve) => { releaseLostResponse = resolve; });
  const registry = new PersistentSubagentRegistry({
    getThinkingLevel: () => "low",
    appendEntry(customType, data) { entries.push({ customType, data }); },
  }, undefined, {
    async reconcile(stored) {
      return { remoteLifecycle: stored.remoteLifecycle };
    },
    async stop(stored, progress) {
      progress.persistArchiveStarted();
      const latest = entries.at(-1).data.upserts.find((entry) => entry.id === stored.id);
      archiveStatePersisted = latest?.remoteLifecycle === "archive-started"
        && latest?.pendingOperations[0]?.kind === "archive";
      stopStarted();
      await lostResponse;
      throw new Error("Lost archive response");
    },
    async disposeObservers() {},
  });
  registry.restore(registryContext(root, registryBranch([
    storedCursor(root, "race", "race", "running", "available"),
  ])));

  const stopping = registry.stop("race");
  await stopMayFail;
  const shutdown = registry.shutdown();
  releaseLostResponse();
  await assert.rejects(stopping, /Lost archive response/);
  await shutdown;

  const persisted = entries.flatMap(({ data }) => data.upserts ?? [])
    .filter((stored) => stored.id === "race").at(-1);
  assert.equal(archiveStatePersisted, true);
  assert.equal(persisted.remoteLifecycle, "archive-pending");
  assert.equal(persisted.localLifecycle, "unavailable");
  assert.equal(persisted.pendingOperations[0].kind, "archive");
});

test("Cursor stop persists a late authoritative outcome during shutdown", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-registry-stop-settled-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entries = [];
  let stopStarted;
  const started = new Promise((resolve) => { stopStarted = resolve; });
  let settleStop;
  const settled = new Promise((resolve) => { settleStop = resolve; });
  const registry = new PersistentSubagentRegistry({
    getThinkingLevel: () => "low",
    appendEntry(customType, data) { entries.push({ customType, data }); },
  }, undefined, {
    async reconcile(stored) {
      return { remoteLifecycle: stored.remoteLifecycle };
    },
    async stop(_stored, progress) {
      progress.persistArchiveStarted();
      stopStarted();
      await settled;
      return { state: "stopped" };
    },
    async disposeObservers() {},
  });
  registry.restore(registryContext(root, registryBranch([
    storedCursor(root, "settled", "settled", "running", "available"),
  ])));

  const stopping = registry.stop("settled");
  await started;
  const shutdown = registry.shutdown();
  settleStop();
  const stopped = await stopping;
  await shutdown;
  const persisted = entries.flatMap(({ data }) => data.upserts ?? [])
    .filter((stored) => stored.id === "settled").at(-1);
  assert.equal(stopped.status, "stopped");
  assert.equal(persisted.remoteLifecycle, "archived");
  assert.equal(persisted.localLifecycle, "stopped");
});

test("missing Cursor authentication preserves durable restored records", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-registry-auth-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entries = [];
  const original = storedCursor(root, "auth", "auth", "idle", "available");
  original.pendingOperations = [{ kind: "follow-up", idempotencyKey: "follow-auth", createdAt: 1 }];
  const durableState = (stored) => ({
    remoteCreated: stored.remoteCreated,
    remoteLifecycle: stored.remoteLifecycle,
    agentId: stored.agentId,
    currentRunId: stored.currentRunId,
    currentRequestId: stored.currentRequestId,
    pendingOperations: stored.pendingOperations,
  });
  const expected = durableState(original);
  const registry = new PersistentSubagentRegistry({
    getThinkingLevel: () => "low",
    appendEntry(customType, data) { entries.push({ customType, data }); },
  }, undefined, {
    async reconcile() {
      throw new Error("AUTH_REQUIRED: Cursor authentication is required");
    },
  });
  const branch = registryBranch([original]);
  registry.restore(registryContext(root, branch));

  await assert.rejects(registry.status("auth"), /AUTH_REQUIRED/);
  assert.equal(entries.length, 0);
  assert.equal(registry.summaryFor("auth").status, "idle");
  assert.deepEqual(durableState(registry.resolve("auth").stored), expected);

  const restored = new PersistentSubagentRegistry({ getThinkingLevel: () => "low", appendEntry() {} });
  restored.restore(registryContext(root, branch));
  assert.deepEqual(durableState(restored.resolve("auth").stored), expected);
});

test("shutdown stops Pi controllers and only disposes Cursor observers", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-registry-shutdown-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let piStops = 0;
  let remoteStops = 0;
  const observerDisposals = [];
  const registry = new PersistentSubagentRegistry({ getThinkingLevel: () => "low", appendEntry() {} }, undefined, {
    async stop() { remoteStops++; return { state: "stopped" }; },
    async disposeObservers(stored) { observerDisposals.push(stored.id); },
  });
  registry.restore(registryContext(root, registryBranch([
    storedCursor(root, "cursor", "cursor", "running", "available"),
  ])));
  const pi = registry.create(registryContext(root), {
    name: "local-pi",
    purpose: "Stop the local Pi controller",
    mode: "fresh",
  });
  registry.resolve(pi.id).controller = {
    state: { connected: true, lifecycle: "ready" },
    async stop() { piStops++; },
  };

  await registry.shutdown();
  assert.equal(piStops, 1);
  assert.equal(remoteStops, 0);
  assert.deepEqual(observerDisposals, ["cursor"]);
});

test("Cursor actions reconcile one record before status, prompt, open, and stop", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-registry-reconcile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let reconciliations = 0;
  const registry = new PersistentSubagentRegistry({ getThinkingLevel: () => "low", appendEntry() {} }, undefined, {
    async reconcile(stored) {
      reconciliations++;
      return { remoteLifecycle: stored.remoteLifecycle };
    },
    async stop() {
      return { state: "archive-pending" };
    },
  });
  const context = registryContext(root, registryBranch([
    storedCursor(root, "reconcile", "reconcile", "idle", "available"),
  ]));
  registry.restore(context);
  assert.equal(reconciliations, 0, "restore is synchronous");

  await registry.status("reconcile");
  await assert.rejects(registry.prompt(context, "reconcile", "Inspect the state"), /CURSOR_API_KEY/);
  const stopped = await registry.stop("reconcile");
  assert.equal(reconciliations, 3);
  assert.equal(stopped.status, "archive-pending");
  assert.equal(registry.summaryFor("reconcile").status, "archive-pending");
});

async function createPushedCursorWorktree(root) {
  await execFile("git", ["init", "-b", "main"], { cwd: root });
  await execFile("git", ["config", "user.email", "cursor-tests@example.invalid"], { cwd: root });
  await execFile("git", ["config", "user.name", "Cursor tests"], { cwd: root });
  await writeFile(join(root, ".gitignore"), "remote.git\n");
  await writeFile(join(root, "README.md"), "initial\n");
  await execFile("git", ["add", ".gitignore", "README.md"], { cwd: root });
  await execFile("git", ["commit", "-m", "initial"], { cwd: root });
  await execFile("git", ["init", "--bare", "remote.git"], { cwd: root });
  await execFile("git", ["remote", "add", "origin", join(root, "remote.git")], { cwd: root });
  await execFile("git", ["push", "-u", "origin", "main"], { cwd: root });
  await execFile("git", ["remote", "set-url", "origin", "git@github.com:Example/Project.git"], { cwd: root });
}

function fakeCursorCatalog() {
  const model = { id: "cursor-test", name: "Cursor test", aliases: [], parameters: [], variantsPresent: false, variantsComplete: true, variants: [] };
  return {
    async resolveCreation() { return { requested: "cursor-test", model, selection: { id: "cursor-test", parameters: [] }, resolvedAt: 1 }; },
    async panelModels() { return [{ id: "cursor-test", name: "Cursor test" }]; },
    async resolveSelection() { return { requested: "cursor-test", model, selection: { id: "cursor-test", parameters: [] }, resolvedAt: 1 }; },
  };
}

function fakeCursorRun(id, agentId, wait = () => new Promise(() => {})) {
  return {
    id,
    agentId,
    status: "running",
    supports(operation) { return operation === "stream" || operation === "wait"; },
    unsupportedReason() { return undefined; },
    async *stream() {},
    wait,
    async cancel() {},
    onDidChangeStatus() { return () => {}; },
  };
}

test("prompt-less Cursor creation keeps its lazy handle local until the first prompt", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-registry-cursor-lazy-handle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await createPushedCursorWorktree(root);
  const { stdout: head } = await execFile("git", ["rev-parse", "HEAD"], { cwd: root });
  const entries = [];
  let creates = 0;
  let sends = 0;
  const agent = {
    agentId: "bc-lazy-handle",
    async send() {
      sends++;
      const run = fakeCursorRun("run-lazy", this.agentId, async () => ({
        id: "run-lazy", agentId: this.agentId, status: "finished", result: "First prompt creates the remote run",
      }));
      run.status = "finished";
      return run;
    },
    close() {}, async listArtifacts() { return []; }, async getUsage() { return {}; },
  };
  const sdk = {
    async createAgent(options) {
      creates++;
      const persisted = entries.flatMap(({ data }) => data.upserts ?? []).at(-1);
      assert.equal(persisted.agentId, options.agentId);
      assert.equal(persisted.pendingOperations[0].kind, "create-agent");
      assert.match(persisted.pendingOperations[0].idempotencyKey, /^pi-cursor-/);
      assert.equal(options.mode, "plan");
      assert.deepEqual(options.model, { id: "cursor-test" });
      assert.equal(options.cloud.workOnCurrentBranch, false);
      assert.equal(options.cloud.autoCreatePR, false);
      assert.deepEqual(options.cloud.repos[0], { url: "https://github.com/Example/Project", startingRef: head.trim() });
      assert.deepEqual(options.cloud.repos[1], { url: "https://github.com/example/support", startingRef: "main" });
      return { ...agent, agentId: options.agentId };
    },
    async resumeAgent() { return agent; }, async getAgent() { return {}; }, async listRuns() { return []; },
    async getRun() { throw new Error("no run before prompt"); }, async cancelRun() {}, async archiveAgent() {},
    async listModels() { return []; }, async listRepositories() { return []; },
  };
  const factory = (options) => options.cursor
    ? new CursorCloudBackend({ ...options, cursor: { ...options.cursor, sdk, catalog: fakeCursorCatalog() } })
    : (() => { throw new Error("Pi backend is not part of this Cursor test"); })();
  const registry = new PersistentSubagentRegistry({
    getThinkingLevel: () => "off",
    appendEntry(customType, data) { entries.push({ customType, data }); },
  }, factory);
  const context = registryContext(root);
  registry.restore(context);
  const created = await registry.create(context, {
    runtime: "cursor-cloud", name: "lazy-cursor", purpose: "Create only a lazy Cloud handle", mode: "fresh",
    persona: {
      name: "lazy-persona", description: "Inspect Cloud evidence", systemPrompt: "Inspect evidence.", runtime: "cursor-cloud",
      extensions: [], skills: [], cursorRepos: [{ url: "https://github.com/example/support", startingRef: "main" }], filePath: "/tmp/lazy-persona.md",
    },
  });
  assert.equal(created.status, "dormant");
  assert.equal(creates, 0, "prompt-less creation does not build an SDK handle");
  assert.equal(sends, 0);
  const finalStored = entries.flatMap(({ data }) => data.upserts ?? []).filter((entry) => entry.id === created.id).at(-1);
  assert.equal(finalStored.remoteCreated, false);
  assert.equal(finalStored.pendingOperations[0].kind, "create-agent");
  assert.equal((await registry.prompt(context, created.id, "Start the remote run")).text, "First prompt creates the remote run");
  assert.equal(creates, 1, "the first prompt builds the lazy SDK handle");
  assert.equal(sends, 1, "the first prompt creates the remote run");
  await registry.shutdown();
});

test("Cursor prompt acceptance persists identity before explicit stop obtains the record", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-registry-cursor-prompt-stop-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await createPushedCursorWorktree(root);
  const entries = [];
  let resolveSend;
  const sendReleased = new Promise((resolve) => { resolveSend = resolve; });
  let sendStarted;
  const started = new Promise((resolve) => { sendStarted = resolve; });
  const run = fakeCursorRun("run-prompt-stop", "bc-prompt-stop");
  const agent = {
    agentId: "bc-prompt-stop",
    async send() { sendStarted(); await sendReleased; return run; },
    close() {}, async listArtifacts() { return []; }, async getUsage() { return {}; },
  };
  const sdk = {
    async createAgent(options) { agent.agentId = options.agentId; run.agentId = options.agentId; return agent; }, async resumeAgent() { return agent; },
    async getAgent() { return {}; }, async listRuns() { return []; }, async getRun() { return run; },
    async cancelRun() {}, async archiveAgent() {}, async listModels() { return []; }, async listRepositories() { return []; },
  };
  let identityPersistedBeforeStop = false;
  const lifecycle = {
    async reconcile(stored) { return { remoteLifecycle: "running", currentRunId: stored.currentRunId }; },
    async stop(stored) {
      const latest = entries.flatMap(({ data }) => data.upserts ?? []).filter((entry) => entry.id === stored.id).at(-1);
      identityPersistedBeforeStop = latest?.currentRunId === "run-prompt-stop" && latest?.remoteLifecycle === "stopping";
      return { state: "stopped" };
    },
  };
  const factory = (options) => options.cursor
    ? new CursorCloudBackend({ ...options, cursor: { ...options.cursor, sdk, catalog: fakeCursorCatalog() } })
    : (() => { throw new Error("Pi backend is not part of this Cursor test"); })();
  const registry = new PersistentSubagentRegistry({
    getThinkingLevel: () => "off", appendEntry(customType, data) { entries.push({ customType, data }); },
  }, factory, lifecycle);
  const context = registryContext(root);
  registry.restore(context);
  const created = await registry.create(context, { runtime: "cursor-cloud", name: "prompt-stop", purpose: "Order prompt and stop", mode: "fresh" });
  const raceRecord = registry.resolve(created.id);
  raceRecord.stored.repositories = [{ url: "https://github.com/example/project", startingRef: "a".repeat(40) }];
  const prompt = registry.prompt(context, created.id, "Start then stop").catch((error) => error);
  await started;
  const stopping = registry.stop(created.id);
  resolveSend();
  assert.equal((await stopping).status, "stopped");
  assert.equal(identityPersistedBeforeStop, true);
  assert.ok(await prompt instanceof Error);
});

test("Cursor shutdown waits for prompt acceptance persistence, then invalidates its observer", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-registry-cursor-prompt-shutdown-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await createPushedCursorWorktree(root);
  const entries = [];
  let resolveSend;
  const sendReleased = new Promise((resolve) => { resolveSend = resolve; });
  let sendStarted;
  const started = new Promise((resolve) => { sendStarted = resolve; });
  let closed = 0;
  let disposedAfterPersistence = false;
  const run = fakeCursorRun("run-prompt-shutdown", "bc-prompt-shutdown");
  const agent = {
    agentId: "bc-prompt-shutdown",
    async send() { sendStarted(); await sendReleased; return run; },
    close() { closed++; }, async listArtifacts() { return []; }, async getUsage() { return {}; },
  };
  const sdk = {
    async createAgent(options) { agent.agentId = options.agentId; run.agentId = options.agentId; return agent; }, async resumeAgent() { return agent; },
    async getAgent() { return {}; }, async listRuns() { return []; }, async getRun() { return run; },
    async cancelRun() {}, async archiveAgent() {}, async listModels() { return []; }, async listRepositories() { return []; },
  };
  const factory = (options) => options.cursor
    ? new CursorCloudBackend({ ...options, cursor: { ...options.cursor, sdk, catalog: fakeCursorCatalog() } })
    : (() => { throw new Error("Pi backend is not part of this Cursor test"); })();
  const lifecycle = {
    async disposeObservers(stored) {
      const latest = entries.flatMap(({ data }) => data.upserts ?? []).filter((entry) => entry.id === stored.id).at(-1);
      disposedAfterPersistence = latest?.currentRunId === "run-prompt-shutdown";
    },
  };
  const registry = new PersistentSubagentRegistry({
    getThinkingLevel: () => "off", appendEntry(customType, data) { entries.push({ customType, data }); },
  }, factory, lifecycle);
  const context = registryContext(root);
  registry.restore(context);
  const created = await registry.create(context, { runtime: "cursor-cloud", name: "prompt-shutdown", purpose: "Order prompt and shutdown", mode: "fresh" });
  const raceRecord = registry.resolve(created.id);
  closed = 0;
  raceRecord.stored.repositories = [{ url: "https://github.com/example/project", startingRef: "a".repeat(40) }];
  const prompt = registry.prompt(context, created.id, "Start then shutdown").catch((error) => error);
  await started;
  const shutdown = registry.shutdown();
  resolveSend();
  await shutdown;
  assert.equal(disposedAfterPersistence, true);
  assert.equal(closed, 1);
  assert.ok(await prompt instanceof Error);
});

test("registry applies an explicit clearPendingSend reconciliation without invalid Cursor state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-registry-clear-pending-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const initial = storedCursor(root, "clear-initial", "clear-initial", "remote-state-unknown", "unavailable");
  initial.remoteCreated = false;
  delete initial.currentRunId;
  delete initial.currentRequestId;
  initial.pendingOperations = [{ kind: "start-run", idempotencyKey: "initial-clear", createdAt: 100 }];
  const follow = storedCursor(root, "clear-follow", "clear-follow", "remote-state-unknown", "unavailable");
  follow.pendingOperations = [{ kind: "follow-up", idempotencyKey: "follow-clear", createdAt: 100 }];
  const registry = new PersistentSubagentRegistry({ getThinkingLevel: () => "off", appendEntry() {} }, undefined, {
    async reconcile(stored) {
      return stored.id === "clear-initial"
        ? { remoteLifecycle: "local", clearPendingSend: true }
        : { remoteLifecycle: "idle", clearPendingSend: true };
    },
  });
  registry.restore(registryContext(root, registryBranch([initial, follow])));
  assert.equal((await registry.status("clear-initial")).status, "dormant");
  assert.equal((await registry.status("clear-follow")).status, "idle");
  const initialStored = registry.resolve("clear-initial").stored;
  const followStored = registry.resolve("clear-follow").stored;
  assert.equal(initialStored.remoteCreated, false);
  assert.deepEqual(initialStored.pendingOperations, []);
  assert.equal(followStored.remoteCreated, true);
  assert.deepEqual(followStored.pendingOperations, []);
});

test("connected Cursor backend syncs status reconciliation before busy or follow-up decisions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-registry-sync-state-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await createPushedCursorWorktree(root);
  const sends = [];
  const agent = {
    agentId: "",
    async send(message, options) {
      sends.push({ message, options });
      return {
        id: "run-new-follow", agentId: this.agentId, status: "finished", createdAt: 9_000_000_000_000_000,
        supports(operation) { return operation === "wait"; }, unsupportedReason() { return undefined; }, async *stream() {},
        async wait() { return { id: "run-new-follow", status: "finished", result: "follow result" }; },
        async cancel() {}, onDidChangeStatus() { return () => {}; },
      };
    },
    close() {}, async listArtifacts() { return []; }, async getUsage() { return {}; },
  };
  const sdk = {
    async createAgent(options) { agent.agentId = options.agentId; return agent; }, async resumeAgent(agentId) { agent.agentId = agentId; return agent; },
    async getAgent() { return {}; },
    async listRuns() { return [{ id: "run-reconciled-initial", agentId: agent.agentId, status: "running", createdAt: 9_000_000_000_000_000 }]; },
    async getRun(id) {
      return {
        id, agentId: agent.agentId, status: "running", createdAt: 9_000_000_000_000_000,
        supports(operation) { return operation === "wait"; }, unsupportedReason() { return undefined; }, async *stream() {},
        async wait() { return await new Promise(() => {}); }, async cancel() {}, onDidChangeStatus() { return () => {}; },
      };
    },
    async cancelRun() {}, async archiveAgent() {}, async listModels() { return []; }, async listRepositories() { return []; },
  };
  const lifecycle = {
    async reconcile(stored) {
      return stored.name === "sync-busy"
        ? { remoteLifecycle: "running", currentRunId: "run-reconciled-busy" }
        : { remoteLifecycle: "idle", currentRunId: "run-reconciled-initial" };
    },
  };
  const factory = (options) => options.cursor
    ? new CursorCloudBackend({ ...options, cursor: { ...options.cursor, sdk, catalog: fakeCursorCatalog() } })
    : (() => { throw new Error("Pi backend is not part of this Cursor test"); })();
  const registry = new PersistentSubagentRegistry({ getThinkingLevel: () => "off", appendEntry() {} }, factory, lifecycle);
  const context = registryContext(root);
  registry.restore(context);
  const busy = await registry.create(context, { runtime: "cursor-cloud", name: "sync-busy", purpose: "Observe reconciled busy state", mode: "fresh" });
  const busyStored = registry.resolve(busy.id).stored;
  busyStored.remoteCreated = true;
  busyStored.remoteLifecycle = "idle";
  busyStored.currentRunId = "run-before-busy";
  await registry.status(busy.id);
  await assert.rejects(registry.prompt(context, busy.id, "Must not send"), /active run/i);
  assert.equal(sends.length, 0);

  const terminal = await registry.create(context, { runtime: "cursor-cloud", name: "sync-terminal", purpose: "Observe terminal initial state", mode: "fresh" });
  const terminalStored = registry.resolve(terminal.id).stored;
  terminalStored.remoteCreated = false;
  terminalStored.remoteLifecycle = "remote-state-unknown";
  terminalStored.pendingOperations = [{ kind: "start-run", idempotencyKey: "initial-reconciled-key", createdAt: 100 }];
  await registry.status(terminal.id);
  assert.equal(terminalStored.remoteCreated, true);
  assert.deepEqual(terminalStored.pendingOperations, []);
  const result = await registry.prompt(context, terminal.id, "Use durable follow-up state");
  assert.equal(result.text, "follow result");
  assert.equal(sends.length, 1);
  assert.match(sends[0].message, /^## Current operating constraints\nLifetime: persistent\nInspect and plan only\. Do not edit, commit, push, create branches, create pull requests, or use mutating MCP operations\.\n## Follow-up request\nUse durable follow-up state\n\n\[Pi request correlation: pi-correlation-[a-f0-9]{32}\]$/);
  assert.notEqual(sends[0].options.idempotencyKey, "initial-reconciled-key");
  await registry.shutdown();
});

test("Cursor restore retains terminal results through status, panel return, and parent delivery", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-registry-pending-result-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const openStored = storedCursor(root, "offline-open", "offline-open");
  const promptStored = storedCursor(root, "offline-prompt", "offline-prompt");
  const sends = [];
  const terminalRun = (stored) => ({
    id: stored.currentRunId, requestId: stored.currentRequestId, agentId: stored.agentId, status: "finished", result: `Recovered ${stored.name} result`, createdAt: 10,
    supports(operation) { return operation === "wait"; }, unsupportedReason() { return undefined; }, async *stream() {},
    async wait() { return { id: this.id, requestId: this.requestId, status: "finished", result: this.result }; }, async cancel() {}, onDidChangeStatus() { return () => {}; },
  });
  const agent = {
    agentId: "",
    async send(message) { sends.push(message); throw new Error("a saved result must return before a new prompt"); },
    close() {}, async listArtifacts() { return []; }, async getUsage() { return {}; },
  };
  const sdk = {
    async createAgent() { throw new Error("must not create"); }, async resumeAgent(agentId) { agent.agentId = agentId; return agent; }, async getAgent() { return {}; }, async listRuns() { return []; },
    async getRun(runId, agentId) {
      const stored = runId === openStored.currentRunId ? openStored : promptStored;
      return { ...terminalRun(stored), id: runId, agentId };
    }, async cancelRun() {}, async archiveAgent() {}, async listModels() { return []; }, async listRepositories() { return []; },
  };
  const lifecycle = {
    async reconcile(stored) {
      return {
        remoteLifecycle: "idle",
        currentRunId: stored.currentRunId,
        currentRequestId: stored.currentRequestId,
        pendingResult: { state: "available", runId: stored.currentRunId },
      };
    },
  };
  const factory = (options) => new CursorCloudBackend({ ...options, cursor: { ...options.cursor, sdk, catalog: fakeCursorCatalog() } });
  let panelAction = "cancel";
  const context = {
    ...registryContext(root, registryBranch([openStored, promptStored])),
    ui: {
      async custom(factory) {
        factory({ requestRender() {} }, {}, { matches() { return false; } }, () => {});
        await new Promise((resolve) => setTimeout(resolve, 20));
        return panelAction === "return" ? { action: "return", text: "Recovered offline-open result" } : { action: "cancel" };
      },
    },
  };
  const registry = new PersistentSubagentRegistry({ getThinkingLevel: () => "off", appendEntry() {} }, factory, lifecycle);
  registry.restore(context);
  assert.equal((await registry.status(openStored.id)).status, "idle");
  assert.deepEqual(registry.resolve(openStored.id).stored.pendingResult, { state: "available", runId: openStored.currentRunId });
  await registry.open(context, openStored.id);
  assert.equal(registry.resolve(openStored.id).controller.state.lastCompletedAssistantText, "Recovered offline-open result", "the panel receives the restored result");
  assert.equal(registry.resolve(openStored.id).stored.pendingResult.state, "available", "panel cancel does not discard a saved result");
  panelAction = "return";
  const panelReturn = await registry.open(context, openStored.id);
  assert.equal(panelReturn.action, "return");
  assert.equal(registry.resolve(openStored.id).stored.pendingResult.state, "available", "a pre-ack handoff failure leaves the durable result available");
  await panelReturn.delivery.acknowledge();
  assert.equal(registry.resolve(openStored.id).stored.pendingResult.state, "none", "panel acknowledgement consumes the saved result");
  await registry.status(promptStored.id);
  const delivered = await registry.prompt(context, promptStored.id, "This must not dispatch");
  assert.equal(delivered.text, "Recovered offline-prompt result");
  assert.equal(sends.length, 0);
  assert.equal(registry.resolve(promptStored.id).stored.pendingResult.state, "available");
  await delivered.delivery.acknowledge();
  assert.equal(registry.resolve(promptStored.id).stored.pendingResult.state, "none");
  await registry.shutdown();
});

test("an archived Cursor result opens as a read-only delivery panel", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-registry-archived-delivery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stored = storedCursor(root, "archived-delivery", "archived-delivery", "archived", "stopped");
  stored.pendingResult = { state: "available", runId: stored.currentRunId };
  let promptCalls = 0;
  let readOnly = false;
  let pending = true;
  const run = { id: stored.currentRunId, runtime: "cursor-cloud", parentOwned: true };
  const factory = (options) => ({
    runtime: "cursor-cloud",
    displayName: "Archived Cursor",
    capabilities: {
      extensionUi: false, steering: false, queuedFollowUp: false, settledFollowUp: true,
      modelControls: true, thinkingControls: true, sessionHistory: false, sessionFile: false, usage: false, toolOutput: false,
    },
    async start() {
      options.onEvent({ type: "run_started", run });
      options.onEvent({ type: "message_completed", run, message: { role: "assistant", text: "Archived result", thinking: "", stopReason: "stop" } });
      options.onEvent({ type: "run_settled", run });
    },
    async stop() {}, getDiagnostics() { return ""; },
    async prompt() { promptCalls++; return { run }; }, async steer() {}, async followUp() { return { run }; }, async abort() {},
    async getState() {
      return {
        connection: { id: stored.agentId, runtime: "cursor-cloud" },
        ...(pending ? { pendingResult: run } : {}),
        details: { agent: { id: stored.agentId }, run: { id: run.id }, lifecycle: "archived" },
        thinkingLevel: "off", isStreaming: false, isCompacting: false,
      };
    },
    async getRunCompletion() { return { text: "Archived result", responseProduced: true, stopReason: "stop" }; },
    async markRunCompletionDelivered() { pending = false; }, async getHistory() { return []; }, async getSessionStats() { return {}; },
    async getAvailableModels() { return []; }, async setModel() { throw new Error("read-only"); }, async cycleModel() { return null; },
    async setThinkingLevel() {}, async cycleThinkingLevel() { return null; }, respondToExtensionUI() {},
  });
  const context = {
    ...registryContext(root, registryBranch([stored])),
    ui: {
      async custom(panelFactory) {
        panelFactory({ requestRender() {} }, {}, { matches() { return false; } }, () => {});
        await new Promise((resolve) => setTimeout(resolve, 10));
        const controller = registry.resolve(stored.id).controller;
        readOnly = controller.state.readOnly;
        assert.equal(await controller.submit("Must not send"), false);
        return { action: "return", text: controller.returnText() };
      },
    },
  };
  const registry = new PersistentSubagentRegistry({ getThinkingLevel: () => "off", appendEntry() {} }, factory);
  registry.restore(context);
  const result = await registry.open(context, stored.id);
  assert.equal(readOnly, true);
  assert.equal(promptCalls, 0);
  assert.equal(result.action, "return");
  assert.equal(result.text, "Archived result");
  assert.equal(result.delivery.runId, run.id);
  await result.delivery.acknowledge();
  assert.equal(registry.resolve(stored.id).controller.state.readOnly, false);
  assert.equal(registry.summaryFor(stored.id).status, "stopped");
  await registry.shutdown();
});

test("an acknowledged normal Cursor delivery reopens as writable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-registry-writable-delivery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stored = storedCursor(root, "writable-delivery", "writable-delivery");
  stored.pendingResult = { state: "available", runId: stored.currentRunId };
  const run = { id: stored.currentRunId, runtime: "cursor-cloud", parentOwned: true };
  let pending = true;
  let expectReadOnly = true;
  let promptCalls = 0;
  const factory = (options) => ({
    runtime: "cursor-cloud", displayName: "Reusable Cursor",
    capabilities: {
      extensionUi: false, steering: false, queuedFollowUp: false, settledFollowUp: true,
      modelControls: true, thinkingControls: true, sessionHistory: false, sessionFile: false, usage: false, toolOutput: false,
    },
    async start() {
      options.onEvent({ type: "run_started", run });
      options.onEvent({ type: "message_completed", run, message: { role: "assistant", text: "Retained result", thinking: "", stopReason: "stop" } });
      options.onEvent({ type: "run_settled", run });
    },
    async stop() {}, async disposeObservation() {}, getDiagnostics() { return ""; },
    async prompt() { promptCalls++; return { run: { id: "reused-normal-run", runtime: "cursor-cloud" } }; },
    async steer() {}, async followUp() { return { run }; }, async abort() {},
    async getState() {
      return {
        connection: { id: stored.agentId, runtime: "cursor-cloud" },
        ...(pending ? { pendingResult: run } : {}), thinkingLevel: "off", isStreaming: false, isCompacting: false,
      };
    },
    async getRunCompletion() { return { text: "Retained result", responseProduced: true, stopReason: "stop" }; },
    async markRunCompletionDelivered() { pending = false; }, async getHistory() { return []; }, async getSessionStats() { return {}; },
    async getAvailableModels() { return []; }, async setModel() { return { provider: "test", id: "model" }; }, async cycleModel() { return null; },
    async setThinkingLevel() {}, async cycleThinkingLevel() { return null; }, respondToExtensionUI() {},
  });
  const lifecycle = {
    async reconcile(current) {
      return {
        remoteLifecycle: "idle", currentRunId: current.currentRunId, currentRequestId: current.currentRequestId,
        pendingResult: pending ? { state: "available", runId: current.currentRunId } : { state: "none" },
      };
    },
  };
  const context = {
    ...registryContext(root, registryBranch([stored])),
    ui: {
      async custom(panelFactory) {
        panelFactory({ requestRender() {} }, {}, { matches() { return false; } }, () => {});
        await new Promise((resolve) => setTimeout(resolve, 10));
        const controller = registry.resolve(stored.id).controller;
        if (expectReadOnly) {
          assert.equal(controller.state.readOnly, true);
          assert.equal(await controller.submit("Blocked while retained"), false);
          return { action: "return", text: controller.returnText() };
        }
        assert.equal(controller.state.readOnly, false);
        assert.equal(await controller.submit("Reusable after acknowledgement", "prompt"), true);
        return { action: "cancel" };
      },
    },
  };
  const registry = new PersistentSubagentRegistry({ getThinkingLevel: () => "off", appendEntry() {} }, factory, lifecycle);
  registry.restore(context);
  const delivery = await registry.open(context, stored.id);
  await delivery.delivery.acknowledge();
  expectReadOnly = false;
  assert.equal((await registry.open(context, stored.id)).action, "cancel");
  assert.equal(promptCalls, 1);
  assert.equal(registry.resolve(stored.id).controller.state.readOnly, false);
  await registry.shutdown();
});

test("offline Cursor one-shot recovery promotes, delivers once, and archives after its receipt", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-registry-offline-one-shot-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await createPushedCursorWorktree(root);
  const stored = storedCursor(root, "offline-one-shot", "offline-one-shot", "running");
  stored.lifetime = "one-shot";
  stored.pendingResult = { state: "pending", runId: stored.currentRunId };
  const terminal = {
    id: stored.currentRunId, requestId: stored.currentRequestId, agentId: stored.agentId,
    status: "finished", result: "Recovered offline one-shot result", createdAt: 1,
    supports(operation) { return operation === "wait"; }, unsupportedReason() { return undefined; }, async *stream() {},
    async wait() { return { id: this.id, requestId: this.requestId, status: "finished", result: this.result }; },
    async cancel() {}, onDidChangeStatus() { return () => {}; },
  };
  let sends = 0;
  let archives = 0;
  const agent = {
    agentId: stored.agentId,
    async send() { sends++; throw new Error("the recovered result must return before a new send"); },
    close() {}, async listArtifacts() { return []; }, async getUsage() { return {}; },
  };
  const sdk = {
    async createAgent() { throw new Error("offline recovery resumes the existing agent"); },
    async resumeAgent(agentId) { agent.agentId = agentId; return agent; }, async getAgent() { return {}; }, async listRuns() { return []; },
    async getRun() { return terminal; }, async cancelRun() { throw new Error("a terminal result must not cancel"); },
    async archiveAgent() { archives++; }, async listModels() { return []; }, async listRepositories() { return []; },
  };
  const factory = (options) => options.cursor
    ? new CursorCloudBackend({ ...options, cursor: { ...options.cursor, sdk, catalog: fakeCursorCatalog() } })
    : (() => { throw new Error("Pi backend is not part of this Cursor test"); })();
  const lifecycle = {
    async reconcile(value) {
      return {
        remoteLifecycle: "idle", currentRunId: value.currentRunId, currentRequestId: value.currentRequestId,
        ...(value.pendingResult.state === "none" ? {} : { pendingResult: { state: "available", runId: value.currentRunId } }),
      };
    },
    async stop() { archives++; return { state: "stopped" }; },
  };
  const registry = new PersistentSubagentRegistry({ getThinkingLevel: () => "off", appendEntry() {} }, factory, lifecycle);
  const context = registryContext(root, registryBranch([stored]));
  registry.restore(context);
  assert.equal(registry.summaryFor(stored.id).lifetime, "one-shot", "restore defers incomplete one-shot recovery");
  await registry.status(stored.id);
  assert.equal(registry.summaryFor(stored.id).lifetime, "task", "terminal reconciliation promotes the offline one-shot");
  assert.deepEqual(registry.resolve(stored.id).stored.pendingResult, {
    state: "available", runId: stored.currentRunId, archiveAfterDelivery: true,
  });
  const delivered = await registry.prompt(context, stored.id, "Return the offline result");
  assert.equal(delivered.text, "Recovered offline one-shot result");
  assert.equal(sends, 0, "recovery returns the owned terminal run exactly once");
  assert.equal(archives, 0, "delivery remains durable before turn_end receipt cleanup");
  const controller = registry.resolve(stored.id).controller;
  const backend = controller.backend;
  const originalAcknowledge = backend.markRunCompletionDelivered.bind(backend);
  let acknowledgements = 0;
  backend.markRunCompletionDelivered = async (...args) => {
    acknowledgements++;
    return await originalAcknowledge(...args);
  };
  const receipt = { version: 1, subagentId: stored.id, runId: stored.currentRunId, archiveAfterDelivery: true };
  await Promise.all([
    registry.processCursorDeliveryReceipt(receipt),
    registry.processCursorDeliveryReceipt(receipt),
  ]);
  assert.equal(acknowledgements, 1, "concurrent duplicate receipts perform one backend acknowledgement");
  assert.equal(registry.resolve(stored.id).stored.pendingResult.state, "none");
  assert.equal(archives, 1, "concurrent turn_end cleanup starts at most one archive after delivery");
  assert.equal(registry.summaryFor(stored.id).status, "stopped");
});

test("restored Cursor delivery receipts settle once after ToolResult persistence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-registry-delivery-receipt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stored = storedCursor(root, "receipt-one-shot", "receipt-one-shot");
  stored.lifetime = "one-shot";
  stored.pendingResult = { state: "available", runId: stored.currentRunId };
  const receipt = { version: 1, subagentId: stored.id, runId: stored.currentRunId, archiveAfterDelivery: true };
  let archives = 0;
  const lifecycle = {
    async reconcile(value) { return { remoteLifecycle: "idle", currentRunId: value.currentRunId }; },
    async stop() { archives++; return { state: "stopped" }; },
  };
  const context = registryContext(root, [
    ...registryBranch([stored]),
    { type: "message", message: { role: "toolResult", toolName: "subagent", details: { cursorDeliveryReceipt: receipt } } },
  ]);
  const registry = new PersistentSubagentRegistry({ getThinkingLevel: () => "off", appendEntry() {} }, undefined, lifecycle);
  registry.restore(context);
  for (let attempt = 0; attempt < 20 && registry.summaryFor(stored.id).status !== "stopped"; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(registry.summaryFor(stored.id).status, "stopped", "restore recognizes a persisted receipt after a crash before turn_end cleanup");
  assert.equal(archives, 1);
  await registry.processCursorDeliveryReceipt(receipt);
  assert.equal(archives, 1, "a repeated turn_end receipt does not repeat archive cleanup");
});

test("restore ignores a valid-looking Cursor receipt from a foreign tool result", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-registry-foreign-receipt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stored = storedCursor(root, "foreign-receipt", "foreign-receipt");
  stored.pendingResult = { state: "available", runId: stored.currentRunId };
  const receipt = { version: 1, subagentId: stored.id, runId: stored.currentRunId, archiveAfterDelivery: true };
  let archives = 0;
  const registry = new PersistentSubagentRegistry(
    { getThinkingLevel: () => "off", appendEntry() {} },
    undefined,
    {
      async reconcile(value) { return { remoteLifecycle: "idle", currentRunId: value.currentRunId }; },
      async stop() { archives++; return { state: "stopped" }; },
    },
  );
  registry.restore(registryContext(root, [
    ...registryBranch([stored]),
    { type: "message", message: { role: "toolResult", toolName: "other-tool", details: { cursorDeliveryReceipt: receipt } } },
  ]));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(registry.resolve(stored.id).stored.pendingResult, { state: "available", runId: stored.currentRunId });
  assert.equal(archives, 0, "a foreign ToolResult cannot acknowledge or archive Cursor state");
  await registry.shutdown();
});

test("restored Cursor rehydration failure has no delivery receipt", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-registry-rehydrate-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stored = storedCursor(root, "rehydrate-failure", "rehydrate-failure");
  stored.pendingResult = { state: "available", runId: stored.currentRunId };
  const run = { id: stored.currentRunId, runtime: "cursor-cloud", parentOwned: true };
  let delivered = 0;
  const factory = () => ({
    runtime: "cursor-cloud",
    displayName: "Rehydration failure",
    capabilities: {
      extensionUi: false, steering: false, queuedFollowUp: false, modelControls: false,
      thinkingControls: false, sessionHistory: false, sessionFile: false, usage: false, toolOutput: false,
    },
    async start() {}, async stop() {}, getDiagnostics() { return ""; },
    async prompt() { throw new Error("a pending result must rehydrate before dispatch"); },
    async steer() {}, async followUp() { throw new Error("a pending result must rehydrate before dispatch"); }, async abort() {},
    async getState() {
      return {
        connection: { id: "rehydration-failure", runtime: "cursor-cloud" }, pendingResult: run,
        thinkingLevel: "off", isStreaming: false, isCompacting: false,
      };
    },
    async getRunCompletion() { return undefined; },
    async markRunCompletionDelivered() { delivered++; },
    async getHistory() { return []; }, async getSessionStats() { return {}; }, async getAvailableModels() { return []; },
    async setModel() { throw new Error("Unsupported"); }, async cycleModel() { return null; },
    async setThinkingLevel() {}, async cycleThinkingLevel() { return null; }, respondToExtensionUI() {},
  });
  const registry = new PersistentSubagentRegistry(
    { getThinkingLevel: () => "off", appendEntry() {} },
    factory,
    { async reconcile(value) { return { remoteLifecycle: "idle", currentRunId: value.currentRunId, pendingResult: value.pendingResult }; } },
  );
  const context = registryContext(root, registryBranch([stored]));
  registry.restore(context);
  await assert.rejects(
    registry.prompt(context, stored.id, "Return the saved result"),
    (error) => {
      assert.equal(error instanceof SubagentCursorPromptFailure, false, "unknown durable state does not infer a delivery receipt");
      assert.match(error.message, /could not be recovered/i);
      return true;
    },
  );
  assert.equal(delivered, 0);
  assert.deepEqual(registry.resolve(stored.id).stored.pendingResult, { state: "available", runId: stored.currentRunId });
  await registry.shutdown();
});

test("receipt cleanup uncertainty remains recoverable after acknowledgement", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-registry-delivery-uncertain-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stored = storedCursor(root, "receipt-uncertain", "receipt-uncertain");
  stored.lifetime = "one-shot";
  stored.pendingResult = { state: "available", runId: stored.currentRunId };
  const receipt = { version: 1, subagentId: stored.id, runId: stored.currentRunId, archiveAfterDelivery: true };
  const registry = new PersistentSubagentRegistry(
    { getThinkingLevel: () => "off", appendEntry() {} },
    undefined,
    {
      async reconcile(value) { return { remoteLifecycle: "idle", currentRunId: value.currentRunId }; },
      async stop() { return { state: "remote-state-unknown" }; },
    },
  );
  const context = registryContext(root, registryBranch([stored]));
  registry.restore(context);
  await registry.processCursorDeliveryReceipt(receipt);
  assert.equal(registry.summaryFor(stored.id).status, "remote-state-unknown");
  assert.equal(registry.resolve(stored.id).stored.pendingResult.state, "none", "the delivered result is not replayed when cleanup is uncertain");
});

test("restored Cursor capped one-shot panel return remains a task after acknowledgement", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-registry-restored-one-shot-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stored = storedCursor(root, "restored-one-shot", "restored-one-shot");
  stored.lifetime = "one-shot";
  stored.pendingResult = { state: "available", runId: stored.currentRunId };
  let returned = false;
  let archives = 0;
  const terminal = {
    id: stored.currentRunId,
    requestId: stored.currentRequestId,
    agentId: stored.agentId,
    status: "finished",
    result: "x".repeat(1_100_000),
    createdAt: 1,
    supports(operation) { return operation === "wait"; },
    unsupportedReason() { return undefined; },
    async *stream() {},
    async wait() { return { id: this.id, requestId: this.requestId, status: "finished", result: this.result }; },
    async cancel() {},
    onDidChangeStatus() { return () => {}; },
  };
  const continuation = {
    ...terminal,
    id: "run-restored-one-shot-continuation",
    result: "Continuation remains available",
    async wait() { return { id: this.id, status: "finished", result: this.result }; },
  };
  const followUpPrompts = [];
  const agent = {
    agentId: stored.agentId,
    async send(message) { followUpPrompts.push(message); return continuation; }, close() {}, async listArtifacts() { return []; }, async getUsage() { return {}; },
  };
  const sdk = {
    async createAgent() { throw new Error("must not create"); }, async resumeAgent(agentId) { agent.agentId = agentId; return agent; },
    async getAgent() { return { status: "finished" }; }, async listRuns() { return [terminal]; }, async getRun(runId) { return runId === continuation.id ? continuation : terminal; },
    async cancelRun() { throw new Error("terminal run must not cancel"); },
    async archiveAgent() { assert.equal(returned, true, "archive starts after the panel has the full result"); archives++; },
    async listModels() { return []; }, async listRepositories() { return []; },
  };
  const factory = (options) => options.cursor
    ? new CursorCloudBackend({ ...options, cursor: { ...options.cursor, sdk, catalog: fakeCursorCatalog() } })
    : (() => { throw new Error("Pi backend is not part of this Cursor test"); })();
  const context = {
    ...registryContext(root, registryBranch([stored])),
    ui: {
      async custom(factory) {
        factory({ requestRender() {} }, {}, { matches() { return false; } }, () => {});
        await new Promise((resolve) => setTimeout(resolve, 20));
        returned = true;
        return { action: "return", text: registry.resolve(stored.id).controller.returnText() };
      },
    },
  };
  const registry = new PersistentSubagentRegistry(
    { getThinkingLevel: () => "off", appendEntry() {} },
    factory,
    createCursorSubagentLifecyclePort(sdk),
  );
  registry.restore(context);
  assert.equal(registry.summaryFor(stored.id).lifetime, "task");
  assert.deepEqual(registry.resolve(stored.id).stored.pendingResult, {
    state: "available", runId: stored.currentRunId, archiveAfterDelivery: true,
  });
  const panelReturn = await registry.open(context, stored.id);
  assert.equal(panelReturn.action, "return");
  assert.equal(panelReturn.delivery.completion.truncated, true, "the authoritative completion cap is retained for panel lifetime decisions");
  assert.equal(archives, 0, "opening does not archive before editor handoff acknowledgement");
  await registry.setLifetime(stored.id, "task");
  const acknowledgement = await panelReturn.delivery.acknowledge();
  assert.equal(acknowledgement.acknowledged, true);
  assert.equal(archives, 0, "a capped panel return stays available for continuation after acknowledgement");
  assert.equal(registry.summaryFor(stored.id).status, "idle");
  const continued = await registry.prompt(context, stored.id, "Continue the capped result");
  assert.equal(continued.text, "Continuation remains available");
  assert.match(followUpPrompts[0], /Lifetime: task/);
  assert.match(followUpPrompts[0], /Inspect and plan only\. Do not edit, commit, push/i);
  await continued.delivery.acknowledge();
});

test("Cursor persistent prompts clear blockers, deliver once, and dispatch the next parent prompt", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-registry-cursor-delivered-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await createPushedCursorWorktree(root);
  const runs = new Map();
  const prompts = [];
  let sends = 0;
  const agent = {
    agentId: "",
    async send(message) {
      prompts.push(message);
      const id = `run-delivered-${++sends}`;
      const result = sends === 1
        ? "BLOCKED: Missing repository evidence\nNEEDS: Repository evidence"
        : "Normal follow-up result";
      const run = {
        id, agentId: this.agentId, status: "finished", createdAt: sends,
        supports(operation) { return operation === "wait"; }, unsupportedReason() { return undefined; }, async *stream() {},
        async wait() { return { id, status: "finished", result }; }, async cancel() {}, onDidChangeStatus() { return () => {}; },
      };
      runs.set(id, run);
      return run;
    },
    close() {}, async listArtifacts() { return []; }, async getUsage() { return {}; },
  };
  const sdk = {
    async createAgent(options) { agent.agentId = options.agentId; return agent; }, async resumeAgent(agentId) { agent.agentId = agentId; return agent; },
    async getAgent() { return { status: "finished" }; }, async listRuns() { return [...runs.values()]; },
    async getRun(id) { return runs.get(id); }, async cancelRun() {}, async archiveAgent() {}, async listModels() { return []; }, async listRepositories() { return []; },
  };
  const factory = (options) => options.cursor
    ? new CursorCloudBackend({ ...options, cursor: { ...options.cursor, sdk, catalog: fakeCursorCatalog() } })
    : (() => { throw new Error("Pi backend is not part of this Cursor test"); })();
  const registry = new PersistentSubagentRegistry(
    { getThinkingLevel: () => "off", appendEntry() {} },
    factory,
    createCursorSubagentLifecyclePort(sdk),
  );
  const context = registryContext(root);
  registry.restore(context);
  const created = await registry.create(context, {
    runtime: "cursor-cloud", name: "delivered-task", purpose: "Deliver each result once", mode: "fresh", lifetime: "persistent",
  });
  const first = await registry.prompt(context, created.id, "First parent prompt");
  assert.match(first.text, /^BLOCKED: Missing repository evidence/);
  assert.deepEqual(first.summary.blocker, { reason: "Missing repository evidence", need: "Repository evidence" });
  assert.deepEqual((await registry.status(created.id)).blocker, first.summary.blocker, "status retains the Cursor blocker");
  assert.deepEqual(registry.list().find((summary) => summary.id === created.id)?.blocker, first.summary.blocker, "list retains the Cursor blocker");
  assert.equal(registry.resolve(created.id).stored.pendingResult.state, "available");
  const firstAcknowledgement = await first.delivery.acknowledge();
  assert.equal(firstAcknowledgement.acknowledged, true);
  assert.equal(registry.resolve(created.id).stored.pendingResult.state, "none");
  const second = await registry.prompt(context, created.id, "Second parent prompt");
  assert.equal(second.text, "Normal follow-up result");
  assert.equal(second.summary.blocker, undefined, "a normal Cursor completion clears the blocker");
  assert.equal((await registry.status(created.id)).blocker, undefined, "status clears the Cursor blocker");
  assert.equal(registry.list().find((summary) => summary.id === created.id)?.blocker, undefined, "list clears the Cursor blocker");
  assert.match(prompts[1], /Lifetime: persistent/, "real Cursor follow-ups repeat the persistent lifetime");
  const staleAcknowledgement = await first.delivery.acknowledge();
  assert.equal(staleAcknowledgement.acknowledged, false, "a stale run token cannot clear the newer result");
  assert.deepEqual(registry.resolve(created.id).stored.pendingResult, { state: "available", runId: "run-delivered-2" });
  await second.delivery.acknowledge();
  assert.equal(sends, 2, "a delivered run must not replay after terminal reconciliation");
  await registry.shutdown();
});

test("Cursor preserves a pending result before an external run for status, open, prompt, and stop", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-registry-cursor-pending-priority-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const saved = (id) => {
    const stored = storedCursor(root, id, id, "running");
    stored.currentRunId = `run-${id}-a`;
    stored.currentRequestId = `request-${id}-a`;
    stored.pendingResult = { state: "pending", runId: stored.currentRunId };
    return stored;
  };
  const statusStored = saved("pending-status");
  const openStored = saved("pending-open");
  const promptStored = saved("pending-prompt");
  const stopStored = saved("pending-stop");
  const calls = [];
  const cancelled = new Set();
  const archived = [];
  const externalRunId = (agentId) => `run-${agentId.slice(3)}-b`;
  const terminalRun = (runId, agentId) => ({
    id: runId, requestId: `request-${runId}`, agentId, status: "finished", result: `Saved ${runId}`, createdAt: 10,
    supports() { return false; }, unsupportedReason() { return undefined; }, async *stream() {}, async wait() { return { id: runId, status: "finished", result: `Saved ${runId}` }; }, async cancel() {}, onDidChangeStatus() { return () => {}; },
  });
  const agent = {
    agentId: "",
    async send() { throw new Error("a saved result must return before sending"); }, close() {}, async listArtifacts() { return []; }, async getUsage() { return {}; },
  };
  const sdk = {
    async createAgent() { throw new Error("must not create"); }, async resumeAgent(agentId) { agent.agentId = agentId; return agent; },
    async getAgent(agentId) { return { status: cancelled.has(agentId) ? "finished" : "running" }; },
    async listRuns(agentId) {
      const id = externalRunId(agentId);
      return [{ id, agentId, status: cancelled.has(agentId) ? "cancelled" : "running", createdAt: 20 }];
    },
    async getRun(runId, agentId) {
      calls.push({ runId, agentId });
      if (runId === externalRunId(agentId)) {
        return {
          id: runId, agentId, status: cancelled.has(agentId) ? "cancelled" : "running", createdAt: 20,
          supports() { return false; }, unsupportedReason() { return undefined; }, async *stream() {}, async wait() { return await new Promise(() => {}); }, async cancel() {}, onDidChangeStatus() { return () => {}; },
        };
      }
      return terminalRun(runId, agentId);
    },
    async cancelRun(runId, agentId) { assert.equal(runId, externalRunId(agentId)); cancelled.add(agentId); },
    async archiveAgent(agentId) { archived.push(agentId); }, async listModels() { return []; }, async listRepositories() { return []; },
  };
  const factory = (options) => options.cursor
    ? new CursorCloudBackend({ ...options, cursor: { ...options.cursor, sdk, catalog: fakeCursorCatalog() } })
    : (() => { throw new Error("Pi backend is not part of this Cursor test"); })();
  const context = {
    ...registryContext(root, registryBranch([statusStored, openStored, promptStored, stopStored])),
    ui: {
      async custom(factory) {
        factory({ requestRender() {} }, {}, { matches() { return false; } }, () => {});
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { action: "cancel" };
      },
    },
  };
  const registry = new PersistentSubagentRegistry(
    { getThinkingLevel: () => "off", appendEntry() {} },
    factory,
    createCursorSubagentLifecyclePort(sdk),
  );
  registry.restore(context);
  assert.equal((await registry.status(statusStored.id)).status, "idle");
  assert.deepEqual(registry.resolve(statusStored.id).stored.pendingResult, { state: "available", runId: statusStored.currentRunId });
  await registry.open(context, openStored.id);
  assert.deepEqual(registry.resolve(openStored.id).stored.pendingResult, { state: "available", runId: openStored.currentRunId });
  const delivered = await registry.prompt(context, promptStored.id, "Return saved result");
  assert.equal(delivered.text, `Saved ${promptStored.currentRunId}`);
  await assert.rejects(registry.stop(stopStored.id), /undelivered result/i);
  assert.deepEqual(registry.resolve(stopStored.id).stored.pendingResult, { state: "available", runId: stopStored.currentRunId });
  assert.deepEqual(archived, []);
  assert.ok(calls.every(({ runId, agentId }) => runId !== externalRunId(agentId) || agentId === stopStored.agentId), "a blocked stop does not inspect a newer external run");
  await registry.shutdown();
});

test("Cursor direct panel open synchronizes an external observation before Return", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-registry-cursor-observation-return-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stored = storedCursor(root, "observation-return", "observation-return", "idle");
  stored.currentRunId = "run-observation-before";
  stored.currentRequestId = "request-observation-before";
  const terminalRun = (id, result) => ({
    id, agentId: stored.agentId, status: "finished", result, createdAt: id === "run-observation-before" ? 1 : 20,
    supports(operation) { return operation === "wait"; }, unsupportedReason() { return undefined; }, async *stream() {},
    async wait() { return { id, status: "finished", result }; }, async cancel() {}, onDidChangeStatus() { return () => {}; },
  });
  const local = terminalRun("run-observation-local", "Local parent result");
  let resolveExternal;
  const externalWait = new Promise((resolve) => { resolveExternal = resolve; });
  let externalActive = false;
  let externalSettled = false;
  let observerSubscriptions = 0;
  const external = {
    id: "run-observation-external", agentId: stored.agentId, status: "running", createdAt: 30, result: "External observation output",
    supports(operation) { return operation === "wait"; }, unsupportedReason() { return undefined; }, async *stream() {},
    async wait() { return await externalWait; }, async cancel() {}, onDidChangeStatus() { observerSubscriptions++; return () => {}; },
  };
  let sends = 0;
  const agent = {
    agentId: stored.agentId,
    async send() { sends++; return local; }, close() {}, async listArtifacts() { return []; }, async getUsage() { return {}; },
  };
  const sdk = {
    async createAgent() { throw new Error("must not create"); }, async resumeAgent(agentId) { agent.agentId = agentId; return agent; },
    async getAgent() { return { status: externalActive && !externalSettled ? "running" : "finished" }; },
    async listRuns() {
      if (externalActive) return [{ id: external.id, agentId: stored.agentId, status: externalSettled ? "finished" : "running", createdAt: 30 }];
      return [{ id: "run-observation-before", agentId: stored.agentId, status: "finished", createdAt: 1 }];
    },
    async getRun(id) {
      if (id === external.id) return externalSettled ? terminalRun(external.id, external.result) : external;
      if (id === local.id) return local;
      return terminalRun("run-observation-before", "Earlier baseline");
    },
    async cancelRun() {}, async archiveAgent() {}, async listModels() { return []; }, async listRepositories() { return []; },
  };
  const factory = (options) => options.cursor
    ? new CursorCloudBackend({ ...options, cursor: { ...options.cursor, sdk, catalog: fakeCursorCatalog() } })
    : (() => { throw new Error("Pi backend is not part of this Cursor test"); })();
  const panelBusyStates = [];
  const context = {
    ...registryContext(root, registryBranch([stored])),
    ui: {
      async custom(factory) {
        return await new Promise((resolve) => {
          const panel = factory(
            { requestRender() {} },
            {},
            { matches(data, action) { return (data === "copy" && action === "app.message.copy") || (data === "close" && action === "app.exit"); } },
            resolve,
          );
          panelBusyStates.push(registry.resolve(stored.id).controller.state.busy);
          void (async () => {
            for (let attempt = 0; attempt < 100; attempt++) {
              const state = registry.resolve(stored.id).controller.state;
              if (state.connected && state.busy) {
                panelBusyStates.push(state.busy);
                break;
              }
              await new Promise((resolve) => setTimeout(resolve, 1));
            }
            panel.handleInput("copy");
            panel.handleInput("close");
          })();
        });
      },
    },
  };
  const registry = new PersistentSubagentRegistry(
    { getThinkingLevel: () => "off", appendEntry() {} },
    factory,
    createCursorSubagentLifecyclePort(sdk),
  );
  registry.restore(context);
  const localResult = await registry.prompt(context, stored.id, "Produce the local result");
  assert.equal(localResult.text, "Local parent result");
  await localResult.delivery.acknowledge();
  const controller = registry.resolve(stored.id).controller;
  assert.equal(controller.state.lastCompletedAssistantText, "Local parent result");

  externalActive = true;
  assert.deepEqual(
    await registry.open(context, stored.id),
    { action: "cancel" },
    "direct open synchronizes the external run before Return can use the local result",
  );
  assert.equal(panelBusyStates[0], false, "the panel opens before Cursor reconciliation completes");
  assert.equal(panelBusyStates[1], true, "Return is unavailable while the reconciled external run is active");
  assert.equal(controller.state.lastCompletedAssistantText, undefined, "observation start clears the local panel return value");
  assert.equal(observerSubscriptions, 1, "direct open attaches one observer for the reconciled external run");
  await assert.rejects(registry.prompt(context, stored.id, "Do not send while external work runs"), /active run/i);
  externalSettled = true;
  resolveExternal({ id: external.id, status: "finished", result: external.result, git: { branches: [{ branch: "external" }] } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(controller.returnText(), undefined);
  assert.equal(controller.latestSettledAssistantText, undefined);
  assert.equal(registry.resolve(stored.id).stored.activeBlocker, undefined, "external output is not parsed as a blocker");
  assert.deepEqual(await registry.open(context, stored.id), { action: "cancel" }, "panel Return has no observation-only text to return");
  assert.equal(sends, 1);
  await registry.shutdown();
});

test("Cursor archive retry and panel detach or shutdown do no extra remote cleanup", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-registry-cursor-archive-retry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = storedCursor(root, "archive-retry", "archive-retry", "running");
  const occupied = [storedPi(root, "occupied-one", "occupied-one"), storedPi(root, "occupied-two", "occupied-two"), storedPi(root, "occupied-three", "occupied-three")];
  let status = "running";
  let cancels = 0;
  let archives = 0;
  const remoteRun = () => ({
    id: target.currentRunId, agentId: target.agentId, status, createdAt: 1,
    supports(operation) { return operation === "wait"; }, unsupportedReason() { return undefined; }, async *stream() {},
    async wait() { return await new Promise(() => {}); }, async cancel() {}, onDidChangeStatus() { return () => {}; },
  });
  const agent = { agentId: target.agentId, close() {}, async listArtifacts() { return []; }, async getUsage() { return {}; } };
  const sdk = {
    async createAgent() { throw new Error("must not create"); }, async resumeAgent() { return agent; },
    async getAgent() { return { status }; }, async listRuns() { return { runs: [remoteRun()], complete: true }; }, async getRun() { return remoteRun(); },
    async cancelRun() { cancels++; status = "cancelled"; },
    async archiveAgent() { archives++; if (archives === 1) throw new Error("archive transport failure"); },
    async listModels() { return []; }, async listRepositories() { return []; },
  };
  const factory = (options) => options.cursor
    ? new CursorCloudBackend({ ...options, cursor: { ...options.cursor, sdk } })
    : (() => { throw new Error("Pi backend is not part of this Cursor test"); })();
  const context = {
    ...registryContext(root, registryBranch([target, ...occupied])),
    ui: {
      async custom(factory) {
        factory({ requestRender() {} }, {}, { matches() { return false; } }, () => {});
        return { action: "cancel" };
      },
    },
  };
  const registry = new PersistentSubagentRegistry(
    { getThinkingLevel: () => "off", appendEntry() {} },
    factory,
    createCursorSubagentLifecyclePort(sdk),
  );
  registry.restore(context);
  await registry.open(context, target.id);
  assert.equal(cancels, 0, "panel detach does not cancel remote Cursor work");
  assert.equal(archives, 0, "panel detach does not archive remote Cursor work");

  assert.equal((await registry.stop(target.id)).status, "archive-pending");
  assert.equal(cancels, 1, "stop confirms terminal cancellation before archival");
  assert.equal(archives, 1);
  const replacement = registry.create(context, { name: "replacement", purpose: "Retain work during archive retry", mode: "fresh" });
  assert.equal(replacement.name, "replacement", "archive-pending Cursor cleanup does not block dormant retention");
  assert.equal((await registry.stop(target.id)).status, "stopped");
  assert.equal(cancels, 1, "archive retry does not repeat cancellation");
  assert.equal(archives, 2);
  const cleanupCalls = { cancels, archives };
  await registry.shutdown();
  assert.deepEqual({ cancels, archives }, cleanupCalls, "shutdown does not cancel or archive Cursor work");
});
