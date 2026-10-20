import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const subagents = await import("../../extensions/subagents/index.ts");
const { PiRpcBackend } = await import("../../extensions/subagents/pi-backend.ts");
const { SubagentRpcClient } = await import("../../extensions/subagents/rpc.ts");

function registryContext(root, branch = []) {
  return {
    cwd: root,
    model: { provider: "test-provider", id: "parent-model" },
    scopedModels: [],
    sessionManager: {
      getSessionId: () => "launch-policy-parent",
      getSessionFile: () => join(root, "parent.jsonl"),
      getBranch: () => branch,
    },
  };
}

function testPiApi(entries = []) {
  return {
    getThinkingLevel: () => "off",
    appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
  };
}

function testBackendFactory(calls) {
  return (options) => {
    calls.push(options);
    const run = { id: `launch-run-${calls.length}`, runtime: "pi" };
    return {
      runtime: "pi",
      displayName: "Launch test backend",
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
      async prompt(message) {
        options.onEvent({ type: "run_started", run });
        options.onEvent({
          type: "message_completed",
          run,
          message: { role: "assistant", text: `Started: ${message}`, thinking: "", stopReason: "stop" },
        });
        options.onEvent({ type: "run_settled", run });
        return { run };
      },
      async steer() {},
      async followUp() { return { run }; },
      async abort() {},
      async getState() {
        return {
          connection: { id: `launch-connection-${calls.length}`, runtime: "pi" },
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
}

async function tempRoot(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("Pi launch policy is wired through the extension and runs for fresh and restored children", async (t) => {
  const root = await tempRoot(t, "pi-subagent-launch-policy-");
  await writeFile(join(root, "parent.jsonl"), "{}\n");
  const entries = [];
  const backendOptions = [];
  let rpcOptions;
  const policyCalls = [];
  const context = registryContext(root);
  const policy = (input, parentContext, stored) => {
    policyCalls.push({ input, parentContext, stored });
    return {
      args: [...input.args, "--no-context-files"],
      cwd: join(root, "child-worktree"),
      env: { ...input.env, PI_CHILD_POLICY_MARKER: "not-persistent" },
      invocation: { command: "/pinned/pi", args: ["--host-cli", ...input.args, "--no-context-files"] },
    };
  };
  const tools = new Map();
  const events = new Map();
  const personaDirectory = join(root, "personas");
  await mkdir(personaDirectory);
  await writeFile(join(personaDirectory, "launch-probe.md"), `---\nname: launch-probe\ndescription: Check child launch setup\n---\nUse the supplied scope.\n`);

  assert.equal(subagents.SUBAGENT_EXTENSION_CAPABILITIES.piLaunchPolicy, true);
  subagents.default({
    getThinkingLevel: () => "off",
    appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand() {},
    registerShortcut() {},
    on(name, listener) { events.set(name, listener); },
  }, {
    personaDirectory,
    backendFactory: (options) => {
      new PiRpcBackend(options, (captured) => {
        rpcOptions = captured;
        return {};
      });
      return testBackendFactory(backendOptions)(options);
    },
    piLaunchPolicy: policy,
  });
  events.get("session_start")({}, context);

  const result = await tools.get("subagent").execute("launch-policy", {
    action: "create",
    mode: "fresh",
    name: "policy-probe",
    persona: "launch-probe",
    purpose: "Verify the child launch hook",
    lifetime: "task",
    prompt: "Start with the launch policy",
    target_contract: { targets: ["src/change.ts"] },
  }, undefined, undefined, context);

  assert.equal(result.details.ok, true, result.content[0]?.text);
  assert.equal(policyCalls.length, 1);
  assert.equal(policyCalls[0].parentContext, context);
  assert.equal(Object.isFrozen(policyCalls[0].input.args), true);
  assert.equal(Object.isFrozen(policyCalls[0].input.env), true);
  assert.equal(Object.isFrozen(policyCalls[0].stored), true);
  assert.equal(Object.isFrozen(policyCalls[0].stored.selectedSkillPaths), true);
  assert.deepEqual(policyCalls[0].stored.targetContract, { targets: ["src/change.ts"] });
  assert.equal(Object.isFrozen(policyCalls[0].stored.targetContract), true);
  assert.equal(Object.isFrozen(policyCalls[0].stored.targetContract.targets), true);
  assert.ok(policyCalls[0].input.args.includes("--mode"));
  assert.equal(backendOptions[0].cwd, join(root, "child-worktree"));
  assert.ok(backendOptions[0].args.includes("--no-context-files"));
  assert.equal(backendOptions[0].env.PI_CHILD_POLICY_MARKER, "not-persistent");
  assert.equal(rpcOptions.env.PI_CHILD_POLICY_MARKER, "not-persistent");
  assert.deepEqual(rpcOptions.invocation, backendOptions[0].invocation);
  assert.deepEqual(backendOptions[0].invocation, policyCalls[0].stored.runtime === "pi"
    ? { command: "/pinned/pi", args: ["--host-cli", ...policyCalls[0].input.args, "--no-context-files"] }
    : undefined);
  assert.doesNotMatch(JSON.stringify(entries), /PI_CHILD_POLICY_MARKER|not-persistent|pinned\/pi/);

  const branch = entries;
  const restoredContext = registryContext(root, branch);
  const restoredCalls = [];
  const restoredRegistry = new subagents.PersistentSubagentRegistry(
    testPiApi(),
    testBackendFactory(restoredCalls),
    undefined,
    undefined,
    policy,
  );
  restoredRegistry.restore(restoredContext);
  const restoredId = result.details.subagent.id;
  const restoredResult = await restoredRegistry.prompt(restoredContext, restoredId, "Resume with the launch policy");
  assert.equal(restoredResult.text, "Started: Resume with the launch policy");
  assert.equal(policyCalls.length, 2);
  assert.deepEqual(policyCalls[1].stored.targetContract, { targets: ["src/change.ts"] });
  assert.equal(Object.isFrozen(policyCalls[1].stored.targetContract.targets), true);
  assert.equal(restoredCalls.length, 1);
  assert.equal(restoredCalls[0].env.PI_CHILD_POLICY_MARKER, "not-persistent");
  assert.equal(restoredCalls[0].invocation.command, "/pinned/pi");
  assert.doesNotMatch(JSON.stringify(branch), /PI_CHILD_POLICY_MARKER|not-persistent|pinned\/pi/);
  await restoredRegistry.shutdown();
});

test("Pi launch policy applies to fork launches and preserves normal launch defaults without a hook", async (t) => {
  const root = await tempRoot(t, "pi-subagent-launch-fork-");
  const parentFile = join(root, "parent.jsonl");
  await writeFile(parentFile, '{"type":"session","version":3,"id":"parent","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');
  const context = registryContext(root);
  const backendOptions = [];
  const policyInputs = [];
  const policy = (input, _context, _stored) => {
    policyInputs.push(input);
    return { args: [...input.args, "--no-approve"], cwd: input.cwd, env: input.env };
  };
  const registry = new subagents.PersistentSubagentRegistry(
    testPiApi(),
    testBackendFactory(backendOptions),
    undefined,
    undefined,
    policy,
  );
  registry.restore(context);
  const fork = registry.create(context, {
    mode: "fork",
    parentSessionFile: parentFile,
    name: "fork-policy",
    purpose: "Check a fork launch",
  });
  await registry.prompt(context, fork.id, "Start the fork");
  assert.ok(policyInputs[0].args.includes("--fork"));
  assert.ok(backendOptions[0].args.includes("--no-approve"));
  assert.equal(backendOptions[0].env.PATH, process.env.PATH);
  assert.equal(backendOptions[0].invocation, undefined);
  await registry.shutdown();

  const noHookCalls = [];
  const noHookRegistry = new subagents.PersistentSubagentRegistry(testPiApi(), testBackendFactory(noHookCalls));
  noHookRegistry.restore(context);
  const fresh = noHookRegistry.create(context, { mode: "fresh", name: "default-policy", purpose: "Check defaults" });
  await noHookRegistry.prompt(context, fresh.id, "Use default Pi launch settings");
  assert.equal(Object.hasOwn(noHookCalls[0], "env"), false);
  assert.equal(Object.hasOwn(noHookCalls[0], "invocation"), false);
  await noHookRegistry.shutdown();
});

test("Pi launch policy failure or invalid output prevents backend creation and launch persistence", async (t) => {
  const root = await tempRoot(t, "pi-subagent-launch-failure-");
  const context = registryContext(root);
  const entries = [];
  const backendCalls = [];
  const registry = new subagents.PersistentSubagentRegistry(
    testPiApi(entries),
    testBackendFactory(backendCalls),
    undefined,
    undefined,
    () => { throw new Error("policy rejected launch"); },
  );
  registry.restore(context);
  const stored = registry.create(context, { mode: "fresh", name: "rejected-policy", purpose: "Check rejection" });
  const before = structuredClone(entries);
  await assert.rejects(registry.prompt(context, stored.id, "Do not start"), /policy rejected launch/);
  assert.equal(backendCalls.length, 0);
  assert.deepEqual(entries, before);
  assert.equal(registry.resolve(stored.id).controller, undefined);
  await registry.shutdown();

  const invalidCalls = [];
  const invalidRegistry = new subagents.PersistentSubagentRegistry(
    testPiApi(),
    testBackendFactory(invalidCalls),
    undefined,
    undefined,
    (input) => ({ args: ["bad\0argument"], cwd: input.cwd, env: input.env }),
  );
  invalidRegistry.restore(context);
  const invalidStored = invalidRegistry.create(context, { mode: "fresh", name: "invalid-policy", purpose: "Check result validation" });
  await assert.rejects(invalidRegistry.prompt(context, invalidStored.id, "Do not start"), /without null characters/);
  assert.equal(invalidCalls.length, 0);
  await invalidRegistry.shutdown();
});

test("controlled Pi environment and invocation pass through PiRpcBackend to RPC spawn without persistence", async (t) => {
  const root = await tempRoot(t, "pi-subagent-launch-rpc-");
  const env = { PI_POLICY_SECRET: "transient-child-value" };
  const invocation = { command: process.execPath, args: ["-e", `
    const readline = require("node:readline");
    const input = readline.createInterface({ input: process.stdin });
    input.on("line", (line) => {
      const request = JSON.parse(line);
      process.stdout.write(JSON.stringify({
        type: "response", id: request.id, success: true,
        data: { marker: process.env.PI_POLICY_SECRET, inherited: process.env.PI_POLICY_PARENT_ONLY || null },
      }) + "\\n");
    });
  `] };
  let rpcOptions;
  const fakeRpc = {
    async start() {}, async stop() {}, getStderr() { return ""; },
    async prompt() {}, async steer() {}, async followUp() {}, async abort() {},
    async getState() { return {}; }, async getMessages() { return []; }, async getSessionStats() { return {}; },
    async getAvailableModels() { return []; }, async setModel() { return {}; }, async cycleModel() { return null; },
    async setThinkingLevel() {}, async cycleThinkingLevel() { return null; }, respondToExtensionUI() {},
  };
  new PiRpcBackend({ cwd: root, args: ["--mode", "rpc"], env, invocation, onEvent() {}, onExit() {} }, (options) => {
    rpcOptions = options;
    return fakeRpc;
  });
  assert.deepEqual(rpcOptions.env, env);
  assert.deepEqual(rpcOptions.invocation, invocation);

  const child = new SubagentRpcClient({
    cwd: root,
    args: rpcOptions.args,
    env: rpcOptions.env,
    invocation: rpcOptions.invocation,
    onOutput() {},
    onExit() {},
  });
  await child.start();
  const state = await child.getState();
  assert.deepEqual(state, { marker: "transient-child-value", inherited: null });
  await child.stop();
});
