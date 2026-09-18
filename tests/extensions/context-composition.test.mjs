import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryCredentialStore, fauxProvider } from "@earendil-works/pi-ai";
import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  loadSkillsFromDir,
} from "@earendil-works/pi-coding-agent";

const COMPOSED_PROMPT_CHAR_BUDGET = 8_000;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      && specifier.startsWith(".")
      && specifier.endsWith(".js")
    ) {
      const sourceUrl = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(sourceUrl))) return { url: sourceUrl.href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const agentToolsModule = await import("../../extensions/agent-tools/index.ts");
const subagentsModule = await import("../../extensions/subagents/index.ts");

function occurrences(text, value) {
  return text.split(value).length - 1;
}

function createRegistrationCollector() {
  const tools = new Map();
  const commands = new Map();
  return {
    tools,
    commands,
    api: {
      registerTool(tool) {
        assert.equal(tools.has(tool.name), false, `duplicate tool registration: ${tool.name}`);
        tools.set(tool.name, tool);
      },
      registerCommand(name, command) {
        commands.set(name, command);
      },
      registerShortcut() {},
      on() {},
    },
  };
}

test("offline system-prompt composition selects and deduplicates registered tool guidance", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-context-composition-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const personaBody = "PERSONA_BODY_CONTEXT_COMPOSITION_MUST_NOT_APPEAR";
  const skillBody = "SKILL_BODY_CONTEXT_COMPOSITION_MUST_NOT_APPEAR";
  const personaDirectory = join(root, "personas");
  const skillDirectory = join(root, "skill");
  await mkdir(personaDirectory);
  await mkdir(skillDirectory);
  await writeFile(join(personaDirectory, "context-persona.md"), `---
name: context-persona
description: Test persona for prompt composition
---
${personaBody}
`);
  await writeFile(join(skillDirectory, "SKILL.md"), `---
name: context-composition-skill
description: Test skill catalog entry for prompt composition
---
${skillBody}
`);

  const registration = createRegistrationCollector();
  agentToolsModule.default(registration.api);
  subagentsModule.default(registration.api, { personaDirectory });
  assert.deepEqual([...registration.tools.keys()].sort(), [
    "ask_user", "bash", "find", "gh", "git", "grep", "read", "recall", "subagent", "web_search",
  ]);
  assert.ok(registration.commands.has("subagent:context-persona"), "the test persona was loaded");

  const { skills, diagnostics } = loadSkillsFromDir({ dir: skillDirectory, source: "path" });
  assert.deepEqual(diagnostics, []);
  assert.equal(skills.length, 1);
  const selectedTools = ["read", "git", "gh", "subagent", "recall"];
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({
    cwd: root,
    agentDir: join(root, "agent"),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "",
    appendSystemPrompt: [],
    skillsOverride: () => ({ skills, diagnostics: [] }),
  });
  await resourceLoader.reload();
  const provider = fauxProvider({ provider: "context-composition" });
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(provider.provider);
  const { session } = await createAgentSession({
    cwd: root,
    agentDir: join(root, "agent"),
    resourceLoader,
    sessionManager: SessionManager.inMemory(root),
    settingsManager,
    modelRuntime,
    model: provider.getModel(),
    noTools: "all",
    tools: selectedTools,
    customTools: [...registration.tools.values()],
  });
  t.after(() => session.dispose());

  assert.deepEqual(session.getActiveToolNames(), selectedTools);
  const prompt = session.systemPrompt;
  t.diagnostic(`Composed prompt: ${prompt.length} characters; budget: ${COMPOSED_PROMPT_CHAR_BUDGET}.`);
  assert.ok(prompt.length <= COMPOSED_PROMPT_CHAR_BUDGET, `composed prompt is ${prompt.length} characters`);

  for (const name of selectedTools) {
    const tool = registration.tools.get(name);
    assert.ok(tool, `registered selected tool: ${name}`);
    assert.equal(occurrences(prompt, `- ${name}: ${tool.promptSnippet}`), 1, `${name} snippet appears once`);
    for (const guideline of tool.promptGuidelines ?? []) {
      assert.equal(occurrences(prompt, guideline), 1, `${name} guideline appears once`);
    }
  }

  const sharedProcessStatusGuideline = registration.tools.get("git").promptGuidelines[0];
  assert.equal(sharedProcessStatusGuideline, registration.tools.get("gh").promptGuidelines[0]);
  assert.equal(occurrences(prompt, sharedProcessStatusGuideline), 1, "shared Git/GH guidance is deduplicated");

  for (const [name, tool] of registration.tools) {
    if (selectedTools.includes(name)) continue;
    assert.equal(prompt.includes(`- ${name}: ${tool.promptSnippet}`), false, `${name} snippet is excluded`);
    for (const guideline of tool.promptGuidelines ?? []) {
      assert.equal(prompt.includes(guideline), false, `${name} guidance is excluded`);
    }
  }

  assert.match(prompt, /<name>context-composition-skill<\/name>/);
  assert.equal(prompt.includes(personaBody), false, "persona bodies are not auto-injected");
  assert.equal(prompt.includes(skillBody), false, "skill bodies are not auto-injected");
});
