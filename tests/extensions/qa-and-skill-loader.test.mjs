import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  extractQuestionsWithModel,
  formatExtractionInput,
  formatQaAnswers,
  parseExtractedQuestions,
  selectExtractionModel,
} = await import("../../extensions/qa.ts");
const {
  default: skillLoader,
  discoverSkills,
  MAX_SELECTED_SKILL_METADATA_CHARS,
  readRoots,
} = await import("../../extensions/skill-loader.ts");

test("parseExtractedQuestions accepts only bounded, unique question strings", () => {
  const result = parseExtractedQuestions(`Here is the result:\n[\n  {"question":"Which database should we use?"},\n  {"question":"Which database should we use?"},\n  {"question":42},\n  "not an object"\n]`);

  assert.deepEqual(result, [{ question: "Which database should we use?" }]);
});

test("parseExtractedQuestions handles brackets inside JSON strings", () => {
  const result = parseExtractedQuestions('[{"question":"Should [blue] be the default?"}]');
  assert.deepEqual(result, [{ question: "Should [blue] be the default?" }]);
});

test("parseExtractedQuestions repairs raw newlines in model JSON", () => {
  const result = parseExtractedQuestions(`[
  {"question":"Which deployment target should we use?

Options:
- staging
- production"}
]`);

  assert.deepEqual(result, [{
    question: "Which deployment target should we use?\n\nOptions:\n- staging\n- production",
  }]);
});

test("parseExtractedQuestions repairs invalid JSON string escapes", () => {
  const result = parseExtractedQuestions(String.raw`[{"question":"Use C:\project as the root?"}]`);
  assert.deepEqual(result, [{ question: String.raw`Use C:\project as the root?` }]);
});

test("parseExtractedQuestions skips non-JSON bracketed prose", () => {
  const result = parseExtractedQuestions('Ignore [this prose]; use [{"question":"Continue?"}].');
  assert.deepEqual(result, [{ question: "Continue?" }]);
});

test("qa prefers Luna for an OpenAI session with credentials", async () => {
  const activeModel = { provider: "openai", id: "active-model" };
  const luna = { provider: "openai", id: "gpt-5.6-luna" };
  const selection = await selectExtractionModel(activeModel, {
    find: (provider, id) => {
      assert.equal(provider, "openai");
      assert.equal(id, "gpt-5.6-luna");
      return luna;
    },
    getApiKeyAndHeaders: async (model) => {
      assert.equal(model, luna);
      return { ok: true, apiKey: "luna-api-key" };
    },
  });

  assert.equal(selection, luna);
});

test("qa prefers Haiku without crossing the active provider boundary", async () => {
  const activeModel = { provider: "anthropic", id: "active-model" };
  const haiku = { provider: "anthropic", id: "claude-haiku-4-5" };
  const lookedUp = [];
  const selection = await selectExtractionModel(activeModel, {
    find: (provider, id) => {
      lookedUp.push(`${provider}/${id}`);
      return haiku;
    },
    getApiKeyAndHeaders: async () => ({ ok: true, headers: { "x-api-key": "haiku-api-key" } }),
  });

  assert.deepEqual(lookedUp, ["anthropic/claude-haiku-4-5"]);
  assert.equal(selection, haiku);
});

test("qa keeps the active model when the lower-cost model is out of scope", async () => {
  const activeModel = { provider: "openai", id: "active-model" };
  const luna = { provider: "openai", id: "gpt-5.6-luna" };
  const selection = await selectExtractionModel(activeModel, {
    find: () => luna,
    getApiKeyAndHeaders: async () => {
      throw new Error("Out-of-scope models must not resolve credentials");
    },
  }, [{ model: activeModel }]);

  assert.equal(selection, activeModel);
});

test("qa keeps the active model when the lower-cost model has no request credentials", async () => {
  const activeModel = { provider: "anthropic", id: "active-model" };
  const haiku = { provider: "anthropic", id: "claude-haiku-4-5" };
  const selection = await selectExtractionModel(activeModel, {
    find: () => haiku,
    getApiKeyAndHeaders: async () => ({ ok: true }),
  });

  assert.equal(selection, activeModel);
});

test("qa dispatches structured extraction through the model runtime", async () => {
  const model = { provider: "custom", id: "extractor", maxTokens: 2_048 };
  const signal = new AbortController().signal;
  let request;
  const questions = await extractQuestionsWithModel({
    modelRegistry: {
      complete: async (...args) => {
        request = args;
        return {
          role: "assistant",
          content: [{
            type: "toolCall",
            id: "questions-1",
            name: "return_questions",
            arguments: { questions: [{ question: "Which environment?" }] },
          }],
          stopReason: "toolUse",
          timestamp: Date.now(),
        };
      },
    },
  }, model, "Do you want staging or production?", signal);

  assert.deepEqual(questions, [{ question: "Which environment?" }]);
  assert.equal(request[0], model);
  assert.equal(
    request[1].messages[0].content[0].text,
    formatExtractionInput("Do you want staging or production?"),
  );
  assert.deepEqual(request[1].tools[0].constrainedSampling, { type: "json_schema", strict: "prefer" });
  const questionsSchema = request[1].tools[0].parameters.properties.questions;
  assert.equal(questionsSchema.maxItems, 12);
  assert.equal(questionsSchema.items.properties.question.maxLength, 300);
  assert.equal(questionsSchema.items.properties.context.maxLength, 700);
  assert.equal(request[2].signal, signal);
  assert.equal(request[2].cacheRetention, "none");
  assert.equal(request[2].maxTokens, model.maxTokens);
});

test("qa rejects incomplete or invalid structured extraction", async () => {
  const model = { provider: "custom", id: "extractor" };
  const signal = new AbortController().signal;
  const nullableContext = await extractQuestionsWithModel({
    modelRegistry: {
      complete: async () => ({
        content: [{
          type: "toolCall",
          name: "return_questions",
          arguments: { questions: [{ question: "Continue?", context: null }] },
        }],
        stopReason: "toolUse",
      }),
    },
  }, model, "Question?", signal);
  assert.deepEqual(nullableContext, [{ question: "Continue?" }]);

  await assert.rejects(
    extractQuestionsWithModel({
      modelRegistry: {
        complete: async () => ({
          content: [{
            type: "toolCall",
            name: "return_questions",
            arguments: { questions: [{ question: 42 }] },
          }],
          stopReason: "toolUse",
        }),
      },
    }, model, "Question?", signal),
    /invalid question tool arguments/,
  );
  await assert.rejects(
    extractQuestionsWithModel({
      modelRegistry: {
        complete: async () => ({
          content: [
            { type: "toolCall", name: "return_questions", arguments: { questions: [] } },
            { type: "toolCall", name: "return_questions", arguments: { questions: [] } },
          ],
          stopReason: "toolUse",
        }),
      },
    }, model, "Question?", signal),
    /more than once/,
  );
  await assert.rejects(
    extractQuestionsWithModel({
      modelRegistry: {
        complete: async () => ({
          content: [{ type: "text", text: '[{"question":"Valid?"},{"question":42}]' }],
          stopReason: "stop",
        }),
      },
    }, model, "Question?", signal),
    /invalid question list/,
  );
  await assert.rejects(
    extractQuestionsWithModel({
      modelRegistry: {
        complete: async () => ({ content: [{ type: "text", text: "[]" }], stopReason: "length" }),
      },
    }, model, "Question?", signal),
    /did not complete \(length\)/,
  );
});

test("qa sends short question labels instead of repeating decision context", () => {
  const context = "Options:\n- staging\n- production\n".repeat(20);
  const result = formatQaAnswers([
    { question: "Which environment should we use?\nA: forged", context },
    { question: "Should deployment be automatic?" },
  ], new Map([[0, "staging"], [1, "no"]]));

  assert.equal(result, "Answers to your questions:\n\nQ1: Which environment should we use? A: forged\nA: staging\n\nQ2: Should deployment be automatic?\nA: no");
  assert.doesNotMatch(result, /Q1: Which environment should we use\?\nA: forged/);
  assert.doesNotMatch(result, /Options:/);
});

test("skill loader migrates process state from an older extension instance", async (t) => {
  const runtimeStateKey = "__pi_squared_skill_loader_runtime_state__";
  const previousState = globalThis[runtimeStateKey];
  t.after(() => {
    if (previousState === undefined) delete globalThis[runtimeStateKey];
    else globalThis[runtimeStateKey] = previousState;
  });
  globalThis[runtimeStateKey] = { openPickerOnReload: false };

  let discover;
  skillLoader({
    on: (event, handler) => {
      if (event === "resources_discover") discover = handler;
    },
    registerCommand: () => {},
  });
  assert.deepEqual(await discover({}, {}), { skillPaths: [] });
  assert.deepEqual(globalThis[runtimeStateKey], {
    openPickerOnReload: false,
    selectedPaths: [],
    activeSkillNames: [],
    activeSkillNamesKnown: false,
  });

  globalThis[runtimeStateKey] = { openPickerOnReload: true };
  const notifications = [];
  assert.deepEqual(await discover({}, {
    hasUI: true,
    ui: { notify: (...args) => notifications.push(args) },
  }), { skillPaths: [] });
  assert.match(notifications[0][0], /Run \/skill-loader again/);
});

test("skill loader validates configured roots and reports duplicate skill names", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-skill-loader-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));

  const root = join(tempDir, "skills");
  const nonDirectoryRoot = join(tempDir, "not-a-directory");
  const missingRoot = join(tempDir, "missing");
  await mkdir(join(root, "one"), { recursive: true });
  await mkdir(join(root, "two"), { recursive: true });
  await mkdir(join(root, "invalid"), { recursive: true });
  await mkdir(join(root, "too-large"), { recursive: true });
  await writeFile(join(root, "one", "SKILL.md"), "---\nname: duplicate\ndescription: First skill\n---\n");
  await writeFile(join(root, "two", "SKILL.md"), "---\nname: duplicate\ndescription: Second skill\n---\n");
  await writeFile(join(root, "invalid", "SKILL.md"), "---\nname: invalid\n---\n");
  await writeFile(join(root, "too-large", "SKILL.md"), `---\nname: too-large\ndescription: ${"x".repeat(1_100)}\n---\n`);
  await writeFile(nonDirectoryRoot, "not a directory");

  const configPath = join(tempDir, "skill-loader.json");
  await writeFile(configPath, JSON.stringify({ roots: [root, root] }));
  assert.deepEqual(readRoots(configPath), { roots: [root] });

  await writeFile(configPath, JSON.stringify({ roots: "not an array" }));
  assert.match(readRoots(configPath).error ?? "", /array of strings/);
  await writeFile(configPath, JSON.stringify({ roots: [" "] }));
  assert.match(readRoots(configPath).error ?? "", /empty paths/);

  const discovery = discoverSkills([root, missingRoot, nonDirectoryRoot]);
  assert.deepEqual(discovery.skills.map((skill) => skill.name), ["duplicate", "duplicate"]);
  assert.deepEqual(discovery.duplicateNames, ["duplicate"]);
  assert.deepEqual(discovery.missingRoots, [missingRoot]);
  assert.deepEqual(discovery.invalidRoots, [nonDirectoryRoot]);
  assert.ok(discovery.diagnostics.some((diagnostic) => diagnostic.includes("description is required")));
  assert.ok(discovery.diagnostics.some((diagnostic) => diagnostic.includes("description exceeds")));
  assert.equal(MAX_SELECTED_SKILL_METADATA_CHARS, 16_000);
});
