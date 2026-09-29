import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, stat } from "node:fs/promises";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { validateToolArguments } from "@earendil-works/pi-ai";
import * as web from "../../extensions/agent-tools/web-search.ts";
import { jsonBytes, WEB_ARTIFACT_LIMIT } from "../../extensions/agent-tools/web-common.ts";

const usage = { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const model = { provider: "openai-codex", id: "gpt-6-luna", api: "openai-codex-responses", compat: { supportsAdditionalTools: true } };
const completed = (id = "ws_1", action) => ({ type: "response.output_item.done", item: { type: "web_search_call", status: "completed", id, ...(action === undefined ? {} : { action }) } });
const annotation = { type: "url_citation", url: "https://example.com/releases", title: "Release notes", start_index: 0, end_index: 7 };
const citation = (overrides = {}) => ({ type: "response.output_text.annotation.added", item_id: "msg_1", content_index: 0, annotation_index: 0, annotation, ...overrides });
function context(complete, active, available = [model]) {
  if (arguments.length < 2) active = model;
  return { model: active, modelRegistry: { complete, getAvailable: () => available }, sessionManager: { getBranch() { throw new Error("must not read the conversation"); } } };
}
function completion(events = [completed()], overrides = {}, inspect) {
  return async (selected, request, options) => {
    inspect?.(selected, request, options);
    for (const event of events) options.onProviderStreamEvent(event, selected);
    return { content: [{ type: "text", text: "Release notes: https://example.com/releases" }], provider: selected.provider, model: selected.id, usage, stopReason: "stop", ...overrides };
  };
}
function prepareAndValidate(tool, input) {
  return validateToolArguments(tool, { id: "call", name: tool.name, arguments: tool.prepareArguments(input) });
}
async function run(events, overrides = {}, options = {}, signal) {
  return web.createAgentWebSearchTool(options).execute("call", { query: "release notes" }, signal, undefined, context(completion(events, overrides)));
}
function failure(result, code, billed = true) {
  assert.equal(result.details.ok, false);
  assert.equal(result.details.error.code, code);
  assert.equal(result.isError, true);
  if (billed) assert.strictEqual(result.usage, usage);
  else assert.equal(result.usage, undefined);
}
async function cleanup(artifacts) { await Promise.all(artifacts.map((artifact) => rm(artifact.directory, { recursive: true, force: true }))); }

test("web_search sends only the query through the public completion callbacks", async () => {
  const updates = [];
  const controller = new AbortController();
  let calls = 0;
  const query = " latest Node.js release ";
  const result = await web.createAgentWebSearchTool().execute("call", { query }, controller.signal, (update) => updates.push(update), context(completion([completed()], {}, (selected, request, options) => {
    calls++;
    assert.strictEqual(selected, model);
    assert.strictEqual(options.signal, controller.signal);
    assert.equal(options.reasoningEffort, "minimal");
    assert.equal(options.textVerbosity, "low");
    assert.deepEqual(Object.keys(request).sort(), ["messages", "systemPrompt"]);
    assert.equal(request.systemPrompt, "Search the web. Return a concise factual answer with direct source URLs. Do not make unsupported claims.");
    assert.equal(request.messages.length, 1);
    assert.deepEqual(request.messages[0].content, [{ type: "text", text: query }]);
    assert.equal(request.messages[0].role, "user");
    const payload = { tools: [{ type: "function" }], tool_choice: "none", other: 1 };
    assert.deepEqual(options.onPayload(payload), { tools: [{ type: "web_search" }], tool_choice: "required", parallel_tool_calls: false, other: 1 });
    assert.equal(payload.tool_choice, "none");
    for (const bad of [null, [], 1]) assert.throws(() => options.onPayload(bad));
  })));
  assert.equal(calls, 1);
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].details, { ok: true, tool: "web_search", external_session: true, provider: model.provider, model: model.id });
  assert.equal(result.details.native_search_count, 1);
  assert.equal(result.details.citation_count, 0);
  assert.equal(result.details.uncited_summary, true);
  assert.match(result.content[0].text, /^\[web_search: provider="openai-codex";/);
  assert.match(result.content[0].text, /This summary is uncited/);
  assert.match(result.content[0].text, /Summary \(auxiliary model; not source text\):/);
  assert.strictEqual(result.usage, usage);
});

test("selection uses available entries and cannot use an unavailable active model", async () => {
  const fallback = { ...model, id: "gpt-5.6-luna" };
  const availableActive = { ...model, id: "custom", metadata: "current" };
  const active = { ...availableActive, metadata: "stale" };
  const unsupported = { ...model, compat: {} };
  for (const [current, available, expected] of [
    [active, [model, availableActive], availableActive], [active, [fallback, model], model],
    [active, [fallback], fallback], [undefined, [unsupported, fallback], fallback],
    [{ provider: "anthropic", id: "other" }, [unsupported, fallback], fallback],
    [undefined, [availableActive], availableActive],
  ]) {
    const ctx = context(completion([completed()], {}, (selected) => assert.strictEqual(selected, expected)), current, available);
    assert.strictEqual(web.selectWebSearchModel(ctx), expected);
    const result = await web.createAgentWebSearchTool().execute("call", { query: "news" }, undefined, undefined, ctx);
    assert.equal(result.details.ok, true);
    assert.strictEqual(ctx.model, current);
  }
  const updates = [];
  const unavailable = context(() => { throw new Error("must not run"); }, model, []);
  failure(await web.createAgentWebSearchTool().execute("call", { query: "news" }, undefined, (u) => updates.push(u), unavailable), "MODEL_UNAVAILABLE", false);
  assert.deepEqual(updates, []);
  failure(await web.createAgentWebSearchTool().execute("call", { query: " \n" }, undefined, (u) => updates.push(u), unavailable), "INVALID_INPUT", false);
  assert.deepEqual(updates, []);
});

test("native records deduplicate, replace citations, and copy actions without mutable event references", async () => {
  const event = completed("ws_1", { type: "search", query: "release notes" });
  const collector = web.createNativeWebEvidenceCollector();
  collector.observe({ type: "response.web_search_call.completed", item_id: "ws_1" });
  collector.observe(event);
  collector.observe(event);
  collector.observe(citation());
  collector.observe({ type: "response.content_part.done", item_id: "msg_1", content_index: 0, part: { type: "output_text", annotations: [{ ...annotation, title: "New title" }] } });
  event.item.action.query = "changed";
  assert.deepEqual(collector.searches()[0].completion_events, ["response.web_search_call.completed", "response.output_item.done"]);
  assert.equal(collector.searches()[0].action.query, "release notes");
  assert.equal(Object.getPrototypeOf(collector.searches()[0].action), null);
  assert.deepEqual(collector.citations(), [{ item_id: "msg_1", content_index: 0, annotation_index: 0, ...annotation, type: undefined }].map(({ type, ...rest }) => ({ ...rest, title: "New title" })));
  const result = await run([event, citation()]);
  assert.equal(result.details.citation_count, 1);
  assert.equal(result.details.uncited_summary, false);
  assert.doesNotMatch(result.content[0].text, /Warning:/);
  assert.match(result.content[0].text, /\[1\] \{"url":"https:\/\/example.com\/releases","title":"Release notes"\}/);
});

test("terminal raw event aliases establish proof only with completed status", async () => {
  const message = { id: "msg_1", type: "message", content: [{ type: "output_text", annotations: [annotation] }] };
  for (const type of ["response.completed", "response.done"]) {
    const result = await run([{ type, response: { status: "completed", output: [completed().item, message] } }]);
    assert.equal(result.details.native_search_count, 1);
    assert.equal(result.details.citation_count, 1);
    assert.deepEqual(result.details.searches[0].completion_events, [type]);
    failure(await run([{ type, response: { status: "incomplete", output: [completed().item, message] } }]), "RETRIEVAL_UNVERIFIED");
  }
});

test("malformed and incomplete provider events cannot establish retrieval", async () => {
  const malformed = [null, [], 1, {}, { type: "unknown" }, { type: "response.incomplete", response: { status: "completed", output: [completed().item] } },
    { type: "response.output_item.added", item: completed().item },
    ...["searching", "in_progress", "failed", "incomplete"].map((status) => ({ ...completed(), item: { ...completed().item, status } })),
    { type: "response.web_search_call.completed", item_id: "" },
    citation({ annotation: null }), citation({ content_index: -1 }), citation({ annotation: { ...annotation, start_index: 8 } }),
    citation({ item_id: undefined }), citation({ annotation: { type: "file_citation" } })];
  failure(await run(malformed), "RETRIEVAL_UNVERIFIED");
  failure(await run([citation()]), "RETRIEVAL_UNVERIFIED");
  failure(await run([]), "RETRIEVAL_UNVERIFIED");
  assert.equal((await run([...malformed, completed()])).details.ok, true);
});

test("returned usage survives final-answer failures and stop checks precede evidence limits", async () => {
  const overflowing = Array.from({ length: 33 }, (_, i) => completed(String(i)));
  for (const stopReason of ["error", "toolUse", "length", "pending", "aborted"]) {
    failure(await run(overflowing, { stopReason, errorMessage: "failure\n[remote]" }), stopReason === "aborted" ? "CANCELLED" : "REQUEST_FAILED");
  }
  failure(await run([completed()], { content: [{ type: "text", text: " \n" }] }), "EMPTY_RESPONSE");
  const controller = new AbortController();
  controller.abort();
  failure(await run([completed()], {}, {}, controller.signal), "CANCELLED");
  const thrown = await web.createAgentWebSearchTool().execute("call", { query: "news" }, undefined, undefined, context(async () => { throw new Error("provider rejected required tools"); }));
  failure(thrown, "REQUEST_FAILED", false);
});

test("collector identity and UTF-8 field limits latch and stop all later retention", () => {
  for (const [build, count] of [[(i) => completed(String(i)), 32], [(i) => citation({ annotation_index: i }), 128]]) {
    const collector = web.createNativeWebEvidenceCollector();
    for (let i = 0; i < count; i++) collector.observe(build(i));
    assert.equal(collector.limitExceeded(), false);
    collector.observe(build(0));
    assert.equal(collector.limitExceeded(), false);
    collector.observe(build(count));
    assert.equal(collector.limitExceeded(), true);
    const before = JSON.stringify([collector.searches(), collector.citations()]);
    collector.observe(completed("extra"));
    collector.observe(citation({ annotation: { ...annotation, title: "replacement" } }));
    assert.equal(JSON.stringify([collector.searches(), collector.citations()]), before);
  }
  for (const [build, max] of [
    [(text) => completed(text), 128], [(text) => citation({ item_id: text }), 128],
    [(text) => citation({ annotation: { ...annotation, url: text } }), 4096],
    [(text) => citation({ annotation: { ...annotation, title: text } }), 1024],
  ]) {
    const collector = web.createNativeWebEvidenceCollector();
    collector.observe(build("é".repeat(max / 2)));
    assert.equal(collector.limitExceeded(), false);
    collector.observe(build("é".repeat(max / 2) + "x"));
    assert.equal(collector.limitExceeded(), true);
  }
});

test("actions enforce exact JSON bytes, depth and nodes without calling accessors or toJSON", () => {
  const nested = (depth) => { let result = {}; for (let i = 1; i < depth; i++) result = { child: result }; return result; };
  for (const [within, over] of [
    [{ x: "a".repeat(16_376) }, { x: "a".repeat(16_377) }],
    [nested(8), nested(9)],
    [{ x: Array(254).fill(null) }, { x: Array(255).fill(null) }],
  ]) {
    const collector = web.createNativeWebEvidenceCollector();
    collector.observe(completed("ok", within));
    assert.equal(collector.limitExceeded(), false);
    assert.ok(collector.searches()[0].action);
    collector.observe(completed("over", over));
    assert.equal(collector.limitExceeded(), true);
  }
  let called = 0;
  const accessor = Object.defineProperty({}, "x", { enumerable: true, get() { called++; throw new Error("getter"); } });
  const cyclic = {}; cyclic.self = cyclic;
  for (const action of [cyclic, accessor, { toJSON() { called++; return {}; } }, new Date(), { x: undefined }, { x: Infinity }, { x: 1n }]) {
    const collector = web.createNativeWebEvidenceCollector();
    assert.doesNotThrow(() => collector.observe(completed("ok", action)));
    assert.equal(collector.limitExceeded(), false);
    assert.equal(collector.searches().length, 1);
    assert.equal(collector.searches()[0].action, undefined);
  }
  assert.equal(called, 0);
});

test("summary limits include separators and retain billed usage after overflow", async () => {
  const artifacts = [];
  try {
    const opts = { onArtifactCreated: (artifact) => artifacts.push(artifact) };
    const content = [{ type: "thinking", thinking: "not evidence" }, { type: "text", text: "x".repeat(524_288) }, { type: "text", text: "y".repeat(524_287) }];
    assert.equal((await run([completed()], { content }, opts)).details.ok, true);
    content[2].text += "z";
    failure(await run([], { content }, opts), "EVIDENCE_LIMIT");
    failure(await run(Array.from({ length: 33 }, (_, i) => completed(String(i)))), "EVIDENCE_LIMIT");
  } finally { await cleanup(artifacts); }
});

test("bounded previews keep whole citations and complete provenance artifacts", async () => {
  const artifacts = [];
  try {
    for (const text of ["😀".repeat(6000), Array.from({ length: 2001 }, (_, i) => `source ${i}`).join("\n")]) {
      const events = [completed("ws_1", { query: "release" }), ...Array.from({ length: 20 }, (_, i) => citation({ annotation_index: i, annotation: { ...annotation, url: "https://example.com/" + "x".repeat(4000), title: "t".repeat(1000) } }))];
      const result = await run(events, { content: [{ type: "text", text }] }, { onArtifactCreated: (artifact) => artifacts.push(artifact) });
      assert.equal(result.details.ok, true);
      const preview = result.content[0].text;
      assert.ok(Buffer.byteLength(preview) <= 16384);
      assert.ok(preview.split("\n").length <= 200);
      assert.doesNotMatch(preview, /�/);
      for (const line of preview.split("\n").filter((line) => /^\[\d+\]/.test(line))) assert.doesNotThrow(() => JSON.parse(line.slice(line.indexOf(" ") + 1)));
      const artifact = result.details.artifact;
      const full = await readFile(artifact.path, "utf8");
      const metadata = JSON.parse(await readFile(artifact.metadata_path, "utf8"));
      assert.match(full, /^\[web_search:/);
      assert.ok(full.includes(text));
      assert.ok(full.includes("[20]"));
      assert.doesNotMatch(full, /preview=truncated/);
      assert.equal(artifact.captured_bytes, Buffer.byteLength(full));
      assert.equal(artifact.captured_lines, full.split("\n").length);
      assert.equal(result.details.response_truncated.total_bytes, Buffer.byteLength(full));
      assert.deepEqual(metadata.searches, JSON.parse(JSON.stringify(result.details.searches)));
      assert.deepEqual(metadata.citations, result.details.citations);
      assert.equal(metadata.query, "release notes");
      assert.equal(metadata.retrieved_at, result.details.retrieved_at);
      assert.equal((await stat(artifact.path)).mode & 0o777, 0o600);
    }
  } finally { await cleanup(artifacts); }
});

test("artifact failures and cancellation clean incomplete captures and preserve usage", async () => {
  for (const cancel of [false, true]) {
    const artifacts = [];
    const controller = new AbortController();
    try {
      const result = await run([completed()], { content: [{ type: "text", text: "x".repeat(24000) }] }, { onArtifactCreated(artifact) {
        artifacts.push(artifact);
        if (cancel) controller.abort();
        else throw new Error("capture failed");
      } }, controller.signal);
      failure(result, cancel ? "CANCELLED" : "ARTIFACT_FAILED");
      assert.equal(result.details.artifact, undefined);
      assert.equal(artifacts.length, 1);
      await assert.rejects(stat(artifacts[0].directory), { code: "ENOENT" });
    } finally { await cleanup(artifacts); }
  }
});

test("serialized artifact and metadata boundaries include escaping and the metadata LF", async () => {
  const artifacts = [];
  const details = { ok: true, tool: "web_search", external_session: true, provider: model.provider, model: model.id, retrieved_at: "2026-01-01T00:00:00.000Z", native_search_count: 1, citation_count: 0, uncited_summary: true, searches: [{ id: "ws_1", completion_events: ["response.output_item.done"] }], citations: [], response_truncated: { by: "bytes", total_lines: 1, total_bytes: WEB_ARTIFACT_LIMIT } };
  try {
    const text = "x".repeat(WEB_ARTIFACT_LIMIT);
    const artifact = await web.writeWebSearchArtifact(text, "query", details, undefined, (a) => artifacts.push(a));
    assert.equal((await stat(artifact.path)).size, WEB_ARTIFACT_LIMIT);
    await assert.rejects(web.writeWebSearchArtifact(text + "x", "query", details), { code: "EVIDENCE_LIMIT" });
    const metadata = JSON.parse(await readFile(artifact.metadata_path, "utf8"));
    metadata.captured_bytes = 1;
    metadata.query = "";
    const overhead = jsonBytes(metadata, WEB_ARTIFACT_LIMIT);
    const query = "q".repeat(WEB_ARTIFACT_LIMIT - overhead - 1);
    const exact = await web.writeWebSearchArtifact("x", query, details, undefined, (a) => artifacts.push(a));
    assert.equal((await stat(exact.metadata_path)).size, WEB_ARTIFACT_LIMIT);
    await assert.rejects(web.writeWebSearchArtifact("x", query + "q", details, undefined, (a) => artifacts.push(a)), { code: "EVIDENCE_LIMIT" });
    await assert.rejects(stat(artifacts.at(-1).directory), { code: "ENOENT" });
  } finally { await cleanup(artifacts); }
});

test("input preparation and direct execution reject invalid input before model work", async () => {
  const tool = web.createAgentWebSearchTool();
  const ctx = context(() => { throw new Error("must not run"); }, undefined, []);
  for (const args of [{ query: null }, { query: 1 }, { query: "" }, { query: "\0" }, { query: "x".repeat(12289) }, { query: "news", surprise: null }]) {
    assert.throws(() => prepareAndValidate(tool, args));
    failure(await tool.execute("call", args, undefined, undefined, ctx), "INVALID_INPUT", false);
  }
  const args = { query: " news " };
  assert.deepEqual(prepareAndValidate(tool, args), args);
  assert.deepEqual(args, { query: " news " });
});


test("actual text and metadata write failures retain billed usage and remove incomplete artifacts", async () => {
  for (const stage of ["text", "metadata"]) {
    const artifacts = [];
    try {
      const result = await run([completed()], { content: [{ type: "text", text: "x".repeat(24000) }] }, { onArtifactCreated(artifact) {
        artifacts.push(artifact);
        if (stage === "text") { unlinkSync(artifact.stdout_path); mkdirSync(artifact.stdout_path); }
        else writeFileSync(artifact.metadata_path, "collision");
      } });
      failure(result, "ARTIFACT_FAILED");
      await assert.rejects(stat(artifacts[0].directory), { code: "ENOENT" });
    } finally { await cleanup(artifacts); }
  }
});

test("escaped citation expansion cannot exceed complete-evidence bounds or publish a retained prefix", async () => {
  const events = [completed(), ...Array.from({ length: 128 }, (_, i) => citation({ annotation_index: i, annotation: { ...annotation, url: "\0".repeat(4096), title: "\0".repeat(1024) } }))];
  let created = 0;
  failure(await run(events, {}, { onArtifactCreated() { created++; } }), "EVIDENCE_LIMIT");
  assert.equal(created, 0);
});

test("caller abort after capture starts cancels the real writer and retains billed usage", async () => {
  const controller = new AbortController();
  const artifacts = [];
  try {
    const result = await run([completed()], { content: [{ type: "text", text: "x".repeat(1_048_576) }] }, { onArtifactCreated(artifact) {
      artifacts.push(artifact);
      setImmediate(() => controller.abort());
    } }, controller.signal);
    failure(result, "CANCELLED");
    await assert.rejects(stat(artifacts[0].directory), { code: "ENOENT" });
  } finally { await cleanup(artifacts); }
});

test("runtime complete text and metadata caps hold with all native field limits satisfied", async () => {
  const artifacts = [];
  const sourceSummary = "Release notes: https://example.com/releases";
  const nativeCitations = (count) => Array.from({ length: count }, (_, i) => citation({ annotation_index: i, annotation: { ...annotation, url: "\0".repeat(4096), title: "t".repeat(1024) } }));
  const header = (searches, citations) => `[web_search: provider="openai-codex"; model="gpt-6-luna"; native_searches=${searches}; citations=${citations}; retrieved_at=2026-01-01T00:00:00.000Z]\n\nSummary (auxiliary model; not source text):\n`;
  const citationText = (events) => "\n\nNative URL citations:\n" + events.map((event, i) => `[${i + 1}] ${JSON.stringify({ url: event.annotation.url, title: event.annotation.title })}`).join("\n");
  try {
    const textCitations = nativeCitations(41);
    const fixedBytes = Buffer.byteLength(header(1, 41) + citationText(textCitations));
    const summary = "x".repeat(WEB_ARTIFACT_LIMIT - fixedBytes);
    assert.ok(Buffer.byteLength(summary) <= 1_048_576);
    const textResult = await run([completed(), ...textCitations], { content: [{ type: "text", text: summary }] }, { onArtifactCreated: (a) => artifacts.push(a) });
    assert.equal(textResult.details.ok, true);
    assert.equal((await stat(textResult.details.artifact.path)).size, WEB_ARTIFACT_LIMIT);
    const before = artifacts.length;
    failure(await run([completed(), ...textCitations], { content: [{ type: "text", text: summary + "x" }] }, { onArtifactCreated: (a) => artifacts.push(a) }), "EVIDENCE_LIMIT");
    assert.equal(artifacts.length, before);

    const metadataCitations = nativeCitations(64);
    const searches = Array.from({ length: 32 }, (_, i) => completed(`ws_${i}`, { x: "" }));
    const collector = web.createNativeWebEvidenceCollector();
    for (const event of [...searches, ...metadataCitations]) collector.observe(event);
    const full = header(32, 64) + sourceSummary + citationText(metadataCitations);
    const metadata = {
      id: "0".repeat(36), tool: "web_search", format: "text", capture: "complete",
      captured_bytes: Buffer.byteLength(full), captured_lines: full.split("\n").length, query: "release notes",
      provider: model.provider, model: model.id, retrieved_at: "2026-01-01T00:00:00.000Z",
      native_search_count: 32, citation_count: 64, uncited_summary: false, searches: collector.searches(), citations: collector.citations(),
      response_truncated: { by: "bytes", total_lines: full.split("\n").length, total_bytes: Buffer.byteLength(full) },
    };
    let remaining = WEB_ARTIFACT_LIMIT - jsonBytes(metadata, WEB_ARTIFACT_LIMIT) - 1;
    for (const event of searches) {
      const size = Math.min(16_376, remaining);
      event.item.action.x = "a".repeat(size);
      remaining -= size;
    }
    assert.equal(remaining, 0);
    assert.ok(searches.at(-1).item.action.x.length < 16_376);
    const metadataResult = await run([...searches, ...metadataCitations], {}, { onArtifactCreated: (a) => artifacts.push(a) });
    assert.equal(metadataResult.details.ok, true);
    assert.equal((await stat(metadataResult.details.artifact.metadata_path)).size, WEB_ARTIFACT_LIMIT);
    searches.at(-1).item.action.x += "a";
    failure(await run([...searches, ...metadataCitations], {}, { onArtifactCreated: (a) => artifacts.push(a) }), "EVIDENCE_LIMIT");
    await assert.rejects(stat(artifacts.at(-1).directory), { code: "ENOENT" });
  } finally { await cleanup(artifacts); }
});

test("a capture callback RangeError is an artifact failure, not evidence overflow", async () => {
  const artifacts = [];
  try {
    const result = await run([completed()], { content: [{ type: "text", text: "x".repeat(24000) }] }, { onArtifactCreated(artifact) {
      artifacts.push(artifact);
      throw new RangeError("capture failed");
    } });
    failure(result, "ARTIFACT_FAILED");
    await assert.rejects(stat(artifacts[0].directory), { code: "ENOENT" });
  } finally { await cleanup(artifacts); }
});
