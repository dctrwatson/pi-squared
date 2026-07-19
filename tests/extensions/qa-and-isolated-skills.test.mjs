import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { parseExtractedQuestions, selectExtractionModel } = await import("../../extensions/qa.ts");
const { parseFlags, truncateOutput } = await import("../../extensions/isolated-skills.ts");
const { discoverSkills, readRoots } = await import("../../extensions/skill-loader.ts");

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

test("parseExtractedQuestions skips non-JSON bracketed prose", () => {
  const result = parseExtractedQuestions('Ignore [this prose]; use [{"question":"Continue?"}].');
  assert.deepEqual(result, [{ question: "Continue?" }]);
});

test("qa prefers Luna when its OpenAI credentials are available", async () => {
  const activeModel = { provider: "anthropic", id: "active-model" };
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

  assert.equal(selection.model, luna);
  assert.equal(selection.auth?.apiKey, "luna-api-key");
});

test("qa falls back to Haiku when Luna is unavailable", async () => {
  const activeModel = { provider: "openai", id: "active-model" };
  const haiku = { provider: "anthropic", id: "claude-haiku-4-5" };
  const lookedUp = [];
  const selection = await selectExtractionModel(activeModel, {
    find: (provider, id) => {
      lookedUp.push(`${provider}/${id}`);
      return provider === "anthropic" ? haiku : undefined;
    },
    getApiKeyAndHeaders: async (model) => {
      assert.equal(model, haiku);
      return { ok: true, headers: { "x-api-key": "haiku-api-key" } };
    },
  });

  assert.deepEqual(lookedUp, ["openai/gpt-5.6-luna", "anthropic/claude-haiku-4-5"]);
  assert.equal(selection.model, haiku);
  assert.equal(selection.auth?.headers?.["x-api-key"], "haiku-api-key");
});

test("qa falls back to the active model when Luna and Haiku have no request credentials", async () => {
  const activeModel = { provider: "anthropic", id: "active-model" };
  const luna = { provider: "openai", id: "gpt-5.6-luna" };
  const haiku = { provider: "anthropic", id: "claude-haiku-4-5" };
  const authenticatedModels = [];
  const selection = await selectExtractionModel(activeModel, {
    find: (provider) => provider === "openai" ? luna : haiku,
    getApiKeyAndHeaders: async (model) => {
      authenticatedModels.push(model);
      return { ok: true };
    },
  });

  assert.deepEqual(authenticatedModels, [luna, haiku]);
  assert.equal(selection.model, activeModel);
  assert.equal(selection.auth, undefined);
});

test("isolated-skill flags require a complete leading token", () => {
  assert.deepEqual(parseFlags("--fork review the diff"), { mode: "fork", rest: "review the diff" });
  assert.deepEqual(parseFlags("--isolated"), { mode: "isolated", rest: "" });
  assert.deepEqual(parseFlags("--forked review the diff"), { mode: null, rest: "--forked review the diff" });
});

test("isolated-skill output truncation respects the byte limit", () => {
  const output = truncateOutput("😀".repeat(1_000), 1_024);
  assert.ok(Buffer.byteLength(output, "utf8") <= 1_024);
  assert.match(output, /truncated/i);
  assert.ok(Buffer.byteLength(truncateOutput("long output", 1), "utf8") <= 1);
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
  await writeFile(join(root, "one", "SKILL.md"), "---\nname: duplicate\ndescription: First skill\n---\n");
  await writeFile(join(root, "two", "SKILL.md"), "---\nname: duplicate\ndescription: Second skill\n---\n");
  await writeFile(join(root, "invalid", "SKILL.md"), "---\nname: invalid\n---\n");
  await writeFile(nonDirectoryRoot, "not a directory");

  const configPath = join(tempDir, "skill-loader.json");
  await writeFile(configPath, JSON.stringify({ roots: [root, root] }));
  assert.deepEqual(readRoots(configPath), { roots: [root] });

  await writeFile(configPath, JSON.stringify({ roots: "not an array" }));
  assert.match(readRoots(configPath).error ?? "", /array of strings/);

  const discovery = discoverSkills([root, missingRoot, nonDirectoryRoot]);
  assert.deepEqual(discovery.skills.map((skill) => skill.name), ["duplicate", "duplicate"]);
  assert.deepEqual(discovery.duplicateNames, ["duplicate"]);
  assert.deepEqual(discovery.missingRoots, [missingRoot]);
  assert.deepEqual(discovery.invalidRoots, [nonDirectoryRoot]);
  assert.ok(discovery.diagnostics.some((diagnostic) => diagnostic.includes("description is required")));
});
