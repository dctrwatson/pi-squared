import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";

const webSearchModule = await import("../../extensions/codex-tools/web-search.ts");

const usage = {
  input: 10,
  output: 20,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 30,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function context(complete, model = {
  provider: "openai-codex",
  id: "gpt-5.4-mini",
  api: "openai-codex-responses",
}) {
  return { model, modelRegistry: { complete } };
}

test("web_search forwards only the query to a separate native web-search request", async () => {
  const calls = [];
  const updates = [];
  const tool = webSearchModule.createCodexWebSearchTool();
  const result = await tool.execute(
    "tool-call",
    { query: "latest Node.js release" },
    undefined,
    (update) => updates.push(update),
    context(async (model, request, options) => {
      calls.push({ model, request, options });
      return {
        content: [
          { type: "thinking", thinking: "search" },
          { type: "text", text: "Node.js release notes: https://nodejs.org/en/blog/release" },
        ],
        provider: "openai-codex",
        model: "gpt-5.4-mini",
        usage,
        stopReason: "stop",
      };
    }),
  );

  assert.deepEqual(updates, [{
    content: [{ type: "text", text: "Searching the web…" }],
    details: {
      ok: true,
      tool: "web_search",
      external_session: true,
      provider: "openai-codex",
      model: "gpt-5.4-mini",
    },
  }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model.id, "gpt-5.4-mini");
  assert.equal(calls[0].request.messages.length, 1);
  assert.deepEqual(calls[0].request.messages[0].content, [{ type: "text", text: "latest Node.js release" }]);
  assert.match(calls[0].request.systemPrompt, /Use web search/);
  assert.deepEqual(await calls[0].options.onPayload({
    model: "gpt-5.4-mini",
    tools: [{ type: "function", name: "do_not_forward" }],
    tool_choice: "none",
  }), {
    model: "gpt-5.4-mini",
    tools: [{ type: "web_search" }],
    tool_choice: "auto",
    parallel_tool_calls: false,
  });
  assert.deepEqual(result, {
    content: [{ type: "text", text: "Node.js release notes: https://nodejs.org/en/blog/release" }],
    details: {
      ok: true,
      tool: "web_search",
      external_session: true,
      provider: "openai-codex",
      model: "gpt-5.4-mini",
    },
    usage,
  });
});

test("web_search returns structured validation and external failures", async () => {
  const tool = webSearchModule.createCodexWebSearchTool();
  let called = false;
  const unused = context(async () => {
    called = true;
    throw new Error("must not run");
  });

  const invalid = await tool.execute("tool-call", { query: " \n" }, undefined, undefined, unused);
  assert.equal(invalid.details.ok, false);
  assert.equal(invalid.details.tool, "web_search");
  assert.equal(invalid.details.error.code, "INVALID_INPUT");
  assert.match(invalid.content[0].text, /web_search query/);
  assert.equal(called, false);

  const failed = await tool.execute(
    "tool-call",
    { query: "current weather" },
    undefined,
    undefined,
    context(async () => ({
      content: [],
      provider: "openai-codex",
      model: "gpt-5.4-mini",
      usage,
      stopReason: "error",
      errorMessage: "rate limited",
    })),
  );
  assert.equal(failed.details.error.code, "REQUEST_FAILED");
  assert.match(failed.details.error.message, /rate limited/);

  const unavailable = await tool.execute(
    "tool-call",
    { query: "current weather" },
    undefined,
    undefined,
    context(async () => {
      throw new Error("must not run");
    }, { provider: "openai", id: "gpt-5.4", api: "openai-responses" }),
  );
  assert.equal(unavailable.details.error.code, "MODEL_UNAVAILABLE");
  assert.match(unavailable.details.error.message, /openai-codex/);
});

test("web_search bounds a large external response and retains its complete artifact", async () => {
  const artifacts = [];
  const tool = webSearchModule.createCodexWebSearchTool({
    onArtifactCreated: (artifact) => artifacts.push(artifact),
  });
  const text = Array.from({ length: 2_001 }, (_, index) => `source ${index}`).join("\n");
  try {
    const result = await tool.execute(
      "tool-call",
      { query: "large response" },
      undefined,
      undefined,
      context(async () => ({
        content: [{ type: "text", text }],
        provider: "openai-codex",
        model: "gpt-5.4-mini",
        usage,
        stopReason: "stop",
      })),
    );

    assert.match(result.content[0].text, /^source 0\n/);
    assert.match(result.content[0].text, /\[web_search: preview=truncated;/);
    assert.equal(result.details.ok, true);
    assert.equal(result.details.tool, "web_search");
    assert.deepEqual(result.details.response_truncated, {
      by: "lines",
      total_lines: 2_001,
      total_bytes: Buffer.byteLength(text),
    });
    assert.equal(artifacts.length, 1);
    assert.deepEqual(result.details.artifact, {
      path: artifacts[0].stdout_path,
      metadata_path: artifacts[0].metadata_path,
      format: "text",
      capture: "complete",
      captured_bytes: Buffer.byteLength(text),
      captured_lines: 2_001,
      expires_at: artifacts[0].expires_at,
    });
    assert.equal(await readFile(result.details.artifact.path, "utf8"), text);
    assert.deepEqual(JSON.parse(await readFile(result.details.artifact.metadata_path, "utf8")), {
      id: artifacts[0].id,
      tool: "web_search",
      format: "text",
      capture: "complete",
      captured_bytes: Buffer.byteLength(text),
      captured_lines: 2_001,
      provider: "openai-codex",
      model: "gpt-5.4-mini",
      response_truncated: result.details.response_truncated,
    });
  } finally {
    await Promise.all(artifacts.map((artifact) => rm(artifact.directory, { recursive: true, force: true })));
  }
});
