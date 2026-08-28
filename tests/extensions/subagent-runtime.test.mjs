import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const personasModule = await import("../../extensions/subagents/personas.ts");
const subagentsModule = await import("../../extensions/subagents/index.ts");

async function writePersona(directory, name, frontmatter, body = "Inspect the requested scope.") {
  await writeFile(join(directory, `${name}.md`), `---\n${frontmatter}\n---\n${body}\n`);
}

test("cursor persona frontmatter validates and normalizes runtime metadata", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-cursor-personas-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const personas = join(root, "personas");
  await mkdir(personas);

  await writePersona(personas, "pi-default", "name: pi-default\ndescription: Existing Pi persona");
  await writePersona(personas, "pi-permissive", "name: pi-permissive\ndescription: 42\nunknown-pi-key: allowed");
  await writePersona(personas, "duplicate-heavy-mcps", `name: duplicate-heavy-mcps\nruntime: cursor-cloud\ncursor-mcps:\n${Array.from({ length: 64 }, () => "  - datadog").join("\n")}`);
  await writePersona(personas, "duplicate-heavy-repos", `name: duplicate-heavy-repos\nruntime: cursor-cloud\ncursor-repos:\n${Array.from({ length: 100 }, () => "  - url: https://github.com/example/repeated.git\n    starting-ref: main").join("\n")}`);
  await writePersona(personas, "cursor-valid", `name: cursor-valid
description: Inspect Cloud evidence
runtime: cursor-cloud
preferred-profile: deep
cursor-mcps:
  - datadog
  - sentry
  - datadog
cursor-repos:
  - url: git@github.com:Example/runbooks.git
    starting-ref: main
  - url: https://github.com/example/runbooks
    starting-ref: main
  - url: ssh://git@github.com/example/platform-config.git`);
  await writePersona(personas, "pi-mcps", "name: pi-mcps\ncursor-mcps:\n  - datadog");
  await writePersona(personas, "cursor-extensions", "name: cursor-extensions\nruntime: cursor-cloud\nextensions: ./context.ts");
  await writePersona(personas, "cursor-skills", "name: cursor-skills\nruntime: cursor-cloud\nskills: ./SKILL.md");
  await writePersona(personas, "cursor-empty-extensions", "name: cursor-empty-extensions\nruntime: cursor-cloud\nextensions:");
  await writePersona(personas, "cursor-empty-skills", "name: cursor-empty-skills\nruntime: cursor-cloud\nskills:");
  await writePersona(personas, "cursor-malformed-name", "name: 42\nruntime: cursor-cloud");
  await writePersona(personas, "cursor-malformed-description", "name: cursor-malformed-description\ndescription: 42\nruntime: cursor-cloud");
  await writePersona(personas, "cursor-malformed-context", "name: cursor-malformed-context\ncontext-requirements: 42\nruntime: cursor-cloud");
  await writePersona(personas, "cursor-malformed-lifetime", "name: cursor-malformed-lifetime\npreferred-lifetime: 42\nruntime: cursor-cloud");
  await writePersona(personas, "cursor-malformed-profile", "name: cursor-malformed-profile\npreferred-profile: 42\nruntime: cursor-cloud");
  await writePersona(personas, "cursor-invalid-profile", "name: cursor-invalid-profile\npreferred-profile: slow\nruntime: cursor-cloud");
  await writePersona(personas, "cursor-malformed-model", "name: cursor-malformed-model\nmodel: 42\nruntime: cursor-cloud");
  await writePersona(personas, "cursor-malformed-thinking", "name: cursor-malformed-thinking\nthinking: 42\nruntime: cursor-cloud");
  await writePersona(personas, "cursor-unknown-key", "name: cursor-unknown-key\nruntime: cursor-cloud\nunknown-cursor-key: rejected");
  await writePersona(personas, "invalid-mcps", "name: invalid-mcps\nruntime: cursor-cloud\ncursor-mcps: datadog");
  await writePersona(personas, "too-many-mcps", `name: too-many-mcps\nruntime: cursor-cloud\ncursor-mcps:\n${Array.from({ length: 9 }, (_, index) => `  - mcp-${index + 1}`).join("\n")}`);
  await writePersona(personas, "invalid-ref", "name: invalid-ref\nruntime: cursor-cloud\ncursor-repos:\n  - url: https://github.com/example/private\n    starting-ref: refs/heads/.private");
  await writePersona(personas, "invalid-url", "name: invalid-url\nruntime: cursor-cloud\ncursor-repos:\n  - url: https://token@github.com/example/private");
  await writePersona(personas, "empty-query-url", "name: empty-query-url\nruntime: cursor-cloud\ncursor-repos:\n  - url: \"https://github.com/example/private?\"");
  await writePersona(personas, "empty-fragment-url", "name: empty-fragment-url\nruntime: cursor-cloud\ncursor-repos:\n  - url: \"https://github.com/example/private#\"");
  await writePersona(personas, "conflicting-repo", "name: conflicting-repo\nruntime: cursor-cloud\ncursor-repos:\n  - url: https://github.com/example/runbooks.git\n    starting-ref: main\n  - url: git@github.com:example/runbooks\n    starting-ref: release");
  await writePersona(personas, "too-many-repos", `name: too-many-repos\nruntime: cursor-cloud\ncursor-repos:\n${Array.from({ length: 21 }, (_, index) => `  - url: https://github.com/example/repo-${index + 1}`).join("\n")}`);

  const discovery = personasModule.loadSubagentPersonas(personas);
  assert.deepEqual(discovery.personas.map(({ name }) => name), ["cursor-valid", "duplicate-heavy-mcps", "duplicate-heavy-repos", "pi-default", "pi-permissive"]);
  assert.deepEqual(discovery.personas.find(({ name }) => name === "pi-default"), {
    name: "pi-default",
    description: "Existing Pi persona",
    systemPrompt: "Inspect the requested scope.",
    runtime: "pi",
    extensions: [],
    skills: [],
    filePath: join(personas, "pi-default.md"),
  });
  assert.equal(discovery.personas.find(({ name }) => name === "pi-permissive")?.description, "Run the pi-permissive subagent persona");
  assert.deepEqual(discovery.personas.find(({ name }) => name === "duplicate-heavy-mcps")?.cursorMcps, ["datadog"]);
  assert.deepEqual(discovery.personas.find(({ name }) => name === "duplicate-heavy-repos")?.cursorRepos, [
    { url: "https://github.com/example/repeated", startingRef: "main" },
  ]);
  assert.deepEqual(discovery.personas.find(({ name }) => name === "cursor-valid"), {
    name: "cursor-valid",
    description: "Inspect Cloud evidence",
    systemPrompt: "Inspect the requested scope.",
    runtime: "cursor-cloud",
    preferredProfile: "deep",
    extensions: [],
    skills: [],
    cursorMcps: ["datadog", "sentry"],
    cursorRepos: [
      { url: "https://github.com/Example/runbooks", startingRef: "main" },
      { url: "https://github.com/example/platform-config" },
    ],
    filePath: join(personas, "cursor-valid.md"),
  });
  assert.ok(discovery.diagnostics.filter((diagnostic) => diagnostic.includes("cursor-repos[0].url")).length >= 3);
  for (const field of [
    "cursor-mcps is only valid for runtime cursor-cloud",
    "extensions is not valid for runtime cursor-cloud",
    "skills is not valid for runtime cursor-cloud",
    "name must be a non-empty string",
    "description must be a non-empty string",
    "context-requirements must be a non-empty string",
    "preferred-lifetime must be a non-empty string",
    "preferred-profile must be a non-empty string",
    "invalid preferred-profile \"slow\"; use fast, balanced, or deep",
    "model is not valid in a persona; use a creation profile",
    "thinking is not valid in a persona; use a creation profile",
    "unknown-cursor-key is not valid for runtime cursor-cloud",
    "cursor-mcps must be a list of names",
    "cursor-mcps exceeds 8 names",
    "invalid cursor-repos[0].starting-ref",
    "cursor-repos[0].url",
    "cursor-repos[1].starting-ref conflicts",
    "cursor-repos exceeds 20 repositories",
  ]) {
    assert.ok(discovery.diagnostics.some((diagnostic) => diagnostic.includes(field)), field);
  }
});

test("runtime-aware tool metadata keeps prompt-less Cursor creation local without authentication", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-cursor-tool-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const personas = join(root, "personas");
  await mkdir(personas);
  await writePersona(personas, "pi-scout", "name: pi-scout\ndescription: Inspect local code");
  await writePersona(personas, "cursor-scout", "name: cursor-scout\ndescription: Inspect Cloud evidence\nruntime: cursor-cloud\npreferred-profile: fast\ncursor-mcps:\n  - datadog\n  - sentry\n  - logs");

  const tools = new Map();
  const events = new Map();
  const entries = [];
  subagentsModule.default({
    appendEntry(customType, data) { entries.push({ customType, data }); },
    getThinkingLevel() { return "off"; },
    on(name, handler) { events.set(name, handler); },
    registerCommand() {},
    registerShortcut() {},
    registerTool(tool) { tools.set(tool.name, tool); },
  }, { personaDirectory: personas });

  const context = {
    cwd: root,
    model: undefined,
    scopedModels: [],
    sessionManager: {
      getSessionId: () => "runtime-tool-parent",
      getSessionFile: () => undefined,
      getBranch: () => [],
    },
  };
  events.get("session_start")({}, context);
  events.get("before_agent_start")({
    systemPromptOptions: {
      skills: [{ name: "local-skill", filePath: "/skills/local/SKILL.md", disableModelInvocation: false }],
    },
  }, context);
  const tool = tools.get("subagent");
  const signal = new AbortController().signal;

  assert.deepEqual(tool.parameters.properties.runtime.enum, ["pi", "cursor-cloud"]);
  const personaList = await tool.execute("list-cursor-personas", {
    action: "list",
    kind: "personas",
  }, signal, undefined, context);
  const cursorPersona = personaList.details.personas.find(({ name }) => name === "cursor-scout");
  assert.deepEqual(cursorPersona, {
    name: "cursor-scout",
    description: "Inspect Cloud evidence",
    runtime: "cursor-cloud",
    preferredProfile: "fast",
  });
  assert.match(personaList.content[0].text, /cursor-scout \[cursor-cloud\].*prefers fast profile/);
  assert.doesNotMatch(personaList.content[0].text, /MCP|datadog|sentry|logs/i);

  assert.equal(subagentsModule.resolveSubagentCreationProfile(undefined, undefined), "balanced");
  assert.equal(subagentsModule.resolveSubagentCreationProfile(cursorPersona, undefined), "fast");
  assert.equal(subagentsModule.resolveSubagentCreationProfile(cursorPersona, "deep"), "deep");

  const invalidInputs = [
    ["runtime-mismatch-cursor", { action: "create", runtime: "pi", persona: "cursor-scout", purpose: "Inspect evidence" }, /runtime "pi" does not match persona "cursor-scout" runtime "cursor-cloud"/],
    ["runtime-mismatch-pi", { action: "create", runtime: "cursor-cloud", persona: "pi-scout", purpose: "Inspect local code" }, /runtime "cursor-cloud" does not match persona "pi-scout" runtime "pi"/],
    ["cursor-skills", { action: "create", persona: "cursor-scout", purpose: "Inspect evidence", skills: ["local-skill"] }, /skills are not valid for runtime cursor-cloud/],
    ["runtime-on-list", { action: "list", runtime: "pi" }, /runtime is not valid for subagent action "list"/],
  ];
  for (const [id, input, expected] of invalidInputs) {
    const result = await tool.execute(id, input, signal, undefined, context);
    assert.equal(result.details.ok, false, id);
    assert.equal(result.details.error.code, "INVALID_INPUT", id);
    assert.match(result.details.error.message, expected, id);
  }

  const cursorDormant = await tool.execute("cursor-dormant", {
    action: "create",
    persona: "cursor-scout",
    purpose: "Inspect remote evidence",
  }, signal, undefined, context);
  assert.equal(cursorDormant.details.ok, true);
  assert.equal(cursorDormant.details.subagent.status, "dormant");
  const dormantStored = entries.at(-1).data.upserts.find((stored) => stored.runtime === "cursor-cloud");
  assert.match(dormantStored.agentId, /^bc-/);
  assert.equal(dormantStored.pendingOperations[0].kind, "create-agent");
  assert.match(dormantStored.pendingOperations[0].idempotencyKey, /^pi-cursor-/);
  assert.equal(entries.length, 1);

  const pi = await tool.execute("pi-runtime", {
    action: "create",
    runtime: "pi",
    persona: "pi-scout",
    purpose: "Inspect local code",
  }, signal, undefined, context);
  assert.equal(pi.details.ok, true);
  assert.equal(pi.details.subagent.runtime, "pi");
  const samePurposeCursor = await tool.execute("cursor-same-purpose", {
    action: "create",
    persona: "cursor-scout",
    purpose: "Inspect local code",
  }, signal, undefined, context);
  assert.equal(samePurposeCursor.details.ok, true);
  assert.equal(samePurposeCursor.details.subagent.status, "dormant");
  const status = await tool.execute("pi-status", {
    action: "status",
    id: pi.details.subagent.id,
  }, signal, undefined, context);
  assert.equal(status.details.subagent.runtime, "pi");
  assert.doesNotMatch(status.content[0].text, /\[pi,/);
  const subagents = await tool.execute("list-subagents", { action: "list" }, signal, undefined, context);
  assert.match(subagents.content[0].text, /\[pi, dormant, persistent\]/);

  const legacyStored = structuredClone(entries.flatMap(({ data }) => data.upserts ?? [])
    .find((stored) => stored.id === pi.details.subagent.id));
  delete legacyStored.runtime;
  delete legacyStored.persona.runtime;
  const restored = new subagentsModule.PersistentSubagentRegistry({
    appendEntry() {},
    getThinkingLevel() { return "off"; },
  });
  restored.restore({
    ...context,
    sessionManager: {
      ...context.sessionManager,
      getBranch: () => [{
        type: "custom",
        customType: "persistent-subagents",
        data: {
          version: 2,
          ownerSessionId: "runtime-tool-parent",
          upserts: [legacyStored],
          removedIds: [],
        },
      }],
    },
  });
  const restoredSummary = restored.summaryFor(pi.details.subagent.id);
  assert.equal(restoredSummary.runtime, "pi");
  assert.equal(restoredSummary.persona, "pi-scout");
});
