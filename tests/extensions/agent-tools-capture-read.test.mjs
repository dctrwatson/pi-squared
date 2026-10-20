import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  InMemoryCredentialStore, fauxProvider, fauxAssistantMessage, fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession,
} from "@earendil-works/pi-coding-agent";
import { createCodemodeExtension } from "../../node_modules/@earendil-works/pi-coding-agent/dist/extensions/codemode/index.js";
import { ArtifactResolutionError } from "../../extensions/agent-tools/artifact-read.ts";
import { createCaptureReadTool } from "../../extensions/agent-tools/capture-read.ts";

const ARTIFACT_ID = "123e4567-e89b-42d3-a456-426614174100";
const jsonDocument = (fields, byteLength = 58_952) => {
  const base = { ...fields, padding: "" };
  const paddingBytes = byteLength - Buffer.byteLength(JSON.stringify(base), "utf8");
  assert.ok(paddingBytes >= 0);
  const document = JSON.stringify({ ...fields, padding: "x".repeat(paddingBytes) });
  assert.equal(Buffer.byteLength(document, "utf8"), byteLength);
  return document;
};

function largeJsonlFixture(targetBytes = 1_217_957) {
  const count = 100;
  const rows = Array.from({ length: count }, (_, index) => ({
    identity: { name: "api", unit: "requests" },
    values: { count: 1 },
    padding: "",
    marker: "🙂",
    tail: "",
    index,
  }));
  const baseLines = rows.map((row) => JSON.stringify(row));
  const fixedBytes = baseLines.reduce((total, line) => total + Buffer.byteLength(line), 0) + count;
  const extraBytes = targetBytes - fixedBytes;
  assert.ok(extraBytes > 0);
  const firstMarkerByte = Buffer.byteLength(baseLines[0].slice(0, baseLines[0].indexOf("🙂")));
  const firstPaddingBytes = 40_958 - firstMarkerByte;
  assert.ok(firstPaddingBytes > 0);
  const firstLineBytes = 45_000;
  const firstTailBytes = firstLineBytes - Buffer.byteLength(baseLines[0]) - firstPaddingBytes;
  assert.ok(firstTailBytes > 0);
  const paddingLengths = Array(count).fill(0);
  const tailLengths = Array(count).fill(0);
  paddingLengths[0] = firstPaddingBytes;
  tailLengths[0] = firstTailBytes;
  let remaining = extraBytes - firstPaddingBytes - firstTailBytes;
  for (let index = 1; index < count; index++) {
    const extra = Math.floor(remaining / (count - index));
    paddingLengths[index] = extra;
    remaining -= extra;
  }
  assert.equal(remaining, 0);
  const lines = rows.map((row, index) => JSON.stringify({ ...row,
    padding: "x".repeat(paddingLengths[index]), tail: "y".repeat(tailLengths[index]) }));
  const text = `${lines.join("\n")}\n`;
  assert.equal(Buffer.byteLength(text), targetBytes);
  assert.equal(Buffer.byteLength(lines[0].slice(0, lines[0].indexOf("🙂"))), 40_958, "a four-byte character begins across the first UTF-8 page boundary");
  return text;
}

function processCapture({ id = ARTIFACT_ID, document, capture = "complete",
  exitCode = 0, error, request = { argv: ["query", "fixture"], started_at: "2025-01-02T03:04:00Z" },
  stdoutText, preview = "[preview is not query data]", failureDisplay } = {}) {
  const details = {
    ok: true, tool: "query", exit_code: exitCode, signal: null, timed_out: false, stop_reason: null, cleanup: "complete",
    duration_ms: 27, request,
    stdout: { capture, preview: stdoutText === undefined ? "truncated" : "complete", captured_raw_bytes: Buffer.byteLength(document),
      ...(stdoutText === undefined ? { saved_raw_bytes: Buffer.byteLength(document) } : {}) },
    stderr: { capture: "complete", preview: "complete", captured_raw_bytes: 0 },
    ...(stdoutText === undefined ? { artifact: { id, stdout_path: `/granted/${id}/stdout` } } : {}),
    ...(error === undefined ? {} : { error }),
  };
  return { details, is_error: exitCode !== 0, preview, preview_truncated: true,
    ...(stdoutText === undefined ? {} : { stdout_text: stdoutText }),
    ...(failureDisplay === undefined ? {} : { failure_display: failureDisplay }) };
}

function context(cwd) {
  return { cwd, mode: "json", hasUI: false, tools: [], executeTool: async () => { throw new Error("no nested tools expected"); } };
}

function value(result) {
  assert.ok(result.structuredContent);
  return result.structuredContent;
}

async function withDirectory(callback) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-agent-capture-read-"));
  try { return await callback(cwd); }
  finally { await rm(cwd, { recursive: true, force: true }); }
}

test("capture_read decodes partial saved captures once to EOF and returns bounded projection and grouped reduction", async () => {
  await withDirectory(async (cwd) => {
    const document = jsonDocument({ source: "fixture", status: "partial", row_count: 2, truncated: false,
      next_token: "page-2", pagination_eof: false, coverage_gaps: ["producer_page_pending"],
      rows: [{ name: "api", value: 3, timestamp: "2025-01-02T03:04:05Z" }, { name: "api", value: 4 }] });
    const path = join(cwd, "stdout");
    await writeFile(path, document, { mode: 0o600 });
    const provenance = { request_id: "request-100", finished_at: "2025-01-02T03:04:06Z", capture: { state: "incomplete" } };
    const resolutions = [];
    const tool = createCaptureReadTool({
      resolveArtifact: async (id, stream, ctx) => {
        resolutions.push({ id, stream, cwd: ctx.cwd });
        if (id !== ARTIFACT_ID) throw new ArtifactResolutionError("The exact capture grant is unavailable");
        return { path, provenance };
      },
    });
    const saved = processCapture({ document, capture: "incomplete",
      exitCode: 1, error: { code: "QUERY_FAILED", message: "original query diagnostic" } });
    const result = await tool.execute("capture-read-test", {
      saved_capture: saved,
      selection: { metadata_pointers: { next_token: "/next_token", pagination_eof: "/pagination_eof", coverage_gaps: "/coverage_gaps" } },
      project: { fields: { time: "/timestamp", value: "/value" } },
      reduce: { group_pointer: "/name", value_pointer: "/value" },
    }, undefined, undefined, context(cwd));
    const decoded = value(result);
    assert.equal(decoded.tool, "capture_read");
    assert.equal(decoded.read_ok, true);
    assert.deepEqual(decoded.status, { process: "failed", capture: "incomplete", decode: "ok", producer: "partial" });
    assert.equal(decoded.process.exit_code, 1);
    assert.deepEqual(decoded.query_error, { code: "QUERY_FAILED", message: "original query diagnostic" });
    assert.deepEqual(decoded.request, saved.details.request);
    assert.deepEqual(decoded.capture, { state: "incomplete", saved_bytes: document.length, bytes_read: document.length, page_count: 2, saved_eof: true });
    assert.deepEqual(decoded.provenance, provenance);
    assert.deepEqual(decoded.document.producer_metadata, { source: "fixture", status: "partial", row_count: 2, truncated: false,
      next_token: "page-2", pagination_eof: false, coverage_gaps: ["producer_page_pending"] });
    assert.equal("producer_complete" in decoded.document, false, "generic decoding preserves observed gaps without inferring producer coverage");
    assert.equal(decoded.document.rows.count, 2);
    assert.equal(decoded.document.rows.sample, null);
    assert.deepEqual(decoded.document.rows.projection.items, [{ time: "2025-01-02T03:04:05Z", value: 3 }, { time: null, value: 4 }]);
    assert.equal(decoded.document.rows.projection.shown_count, 2);
    assert.equal(decoded.document.rows.projection.fields_complete, false);
    assert.deepEqual(decoded.document.rows.reduction.groups, [{ group: "api", count: 2, sum: 7, min: 3, max: 4, positive_count: 2 }]);
    assert.equal(JSON.stringify(decoded).includes("[preview is not query data]"), false);
    assert.equal(result.content[0].text, JSON.stringify(decoded));
    assert.ok(Buffer.byteLength(result.content[0].text) < 48 * 1024);
    assert.deepEqual(resolutions, [
      { id: ARTIFACT_ID, stream: "stdout", cwd }, { id: ARTIFACT_ID, stream: "stdout", cwd },
    ]);
  });
});

test("capture_read reducer orders ISO timestamps and counts positive values", async () => {
  await withDirectory(async (cwd) => {
    const rows = [
      { metric: { name: "Count", unit: "requests" }, value: 1, time: "2025-02-01T03:00:00Z" },
      { metric: { name: "Count", unit: "requests" }, value: -2, time: "2025-02-01T00:15:00-01:00" },
      { metric: { name: "Count", unit: "requests" }, value: 2, time: "2025-02-01T01:30:00Z" },
    ];
    const document = JSON.stringify({ rows });
    const path = join(cwd, "stdout");
    await writeFile(path, document, { mode: 0o600 });
    const tool = createCaptureReadTool({ resolveArtifact: async () => ({ path, provenance: {} }) });
    const decoded = value(await tool.execute("capture-read-test", {
      saved_capture: processCapture({ document }),
      reduce: { group_pointer: "/metric", value_pointer: "/value", time_pointer: "/time" },
    }, undefined, undefined, context(cwd)));
    const reduction = decoded.document.rows.reduction;
    assert.equal(reduction.groups_complete, true);
    assert.equal(reduction.invalid_times, 0);
    assert.equal(reduction.time_pointer, "/time");
    assert.deepEqual(reduction.groups, [{
      group: { name: "Count", unit: "requests" }, count: 3, sum: 1, min: -2, max: 2, positive_count: 2,
      first_time: "2025-02-01T00:15:00-01:00", last_time: "2025-02-01T03:00:00Z", invalid_times: 0,
    }]);
  });
});

test("capture_read reducer reports invalid or missing times and emits no fake bounds", async () => {
  await withDirectory(async (cwd) => {
    const rows = [
      { group: "bad", value: 1, time: "2025-01-01T00:00:00Z" },
      { group: "bad", value: 1 },
      { group: "bad", value: 1, time: "2025-02-30T00:00:00Z" },
      { group: "good", value: 1, time: "2025-03-01T00:00:00Z" },
    ];
    const document = JSON.stringify({ rows });
    const path = join(cwd, "stdout");
    await writeFile(path, document, { mode: 0o600 });
    const tool = createCaptureReadTool({ resolveArtifact: async () => ({ path, provenance: {} }) });
    const decoded = value(await tool.execute("capture-read-test", {
      saved_capture: processCapture({ document }),
      reduce: { group_pointer: "/group", value_pointer: "/value", time_pointer: "/time" },
    }, undefined, undefined, context(cwd)));
    const reduction = decoded.document.rows.reduction;
    assert.equal(reduction.invalid_times, 2);
    assert.equal(reduction.groups_complete, false);
    assert.deepEqual(reduction.groups, [
      { group: "bad", count: 3, sum: 3, min: 1, max: 1, positive_count: 3, first_time: null, last_time: null, invalid_times: 2 },
      { group: "good", count: 1, sum: 1, min: 1, max: 1, positive_count: 1,
        first_time: "2025-03-01T00:00:00Z", last_time: "2025-03-01T00:00:00Z", invalid_times: 0 },
    ]);
  });
});

test("capture_read suppresses every group when a scanned row cannot be assigned", async () => {
  await withDirectory(async (cwd) => {
    const rows = [
      { group: "requests", value: 2 },
      { value: 3 },
      { group: "errors", value: 1 },
    ];
    const document = JSON.stringify({ rows });
    const path = join(cwd, "stdout");
    await writeFile(path, document, { mode: 0o600 });
    const tool = createCaptureReadTool({ resolveArtifact: async () => ({ path, provenance: {} }) });
    const decoded = value(await tool.execute("capture-read-test", {
      saved_capture: processCapture({ document }),
      reduce: { group_pointer: "/group", value_pointer: "/value" },
    }, undefined, undefined, context(cwd)));
    const reduction = decoded.document.rows.reduction;
    assert.equal(decoded.read_ok, true);
    assert.equal(reduction.rows_scanned, rows.length);
    assert.equal(reduction.invalid_groups, 1);
    assert.equal(reduction.groups_complete, false);
    assert.deepEqual(reduction.groups, [], "a partial set of valid groups must not look complete");
  });
});

test("capture_read reducer orders numeric timestamps and summarizes 288 Count rows per unit beyond projection limits", async () => {
  await withDirectory(async (cwd) => {
    const rows = Array.from({ length: 288 }, (_, index) => ({
      metric: { name: "Count", unit: index < 144 ? "requests" : "errors" },
      value: 1,
      time: 288 - index,
    }));
    const document = JSON.stringify({ rows });
    const path = join(cwd, "stdout");
    await writeFile(path, document, { mode: 0o600 });
    const tool = createCaptureReadTool({ resolveArtifact: async () => ({ path, provenance: {} }) });
    const decoded = value(await tool.execute("capture-read-test", {
      saved_capture: processCapture({ document }),
      project: { fields: { unit: "/metric/unit", value: "/value" }, limit: 200 },
      reduce: { group_pointer: "/metric", value_pointer: "/value", time_pointer: "/time" },
    }, undefined, undefined, context(cwd)));
    assert.equal(decoded.document.rows.projection.shown_count, 200);
    assert.equal(decoded.document.rows.projection.scan_complete, false);
    const reduction = decoded.document.rows.reduction;
    assert.equal(reduction.rows_scanned, 288);
    assert.equal(reduction.groups_complete, true);
    assert.deepEqual(reduction.groups, [
      { group: { name: "Count", unit: "requests" }, count: 144, sum: 144, min: 1, max: 1, positive_count: 144,
        first_time: 145, last_time: 288, invalid_times: 0 },
      { group: { name: "Count", unit: "errors" }, count: 144, sum: 144, min: 1, max: 1, positive_count: 144,
        first_time: 1, last_time: 144, invalid_times: 0 },
    ], "exact metric/unit group values remain separate; no cross-unit total is formed");
  });
});

test("capture_read measures changed reduction groups instead of serializing every group per row", async () => {
  await withDirectory(async (cwd) => {
    const rows = Array.from({ length: 10_000 }, (_, index) => ({ group: `g${index % 100}`, value: 1.25 }));
    const document = JSON.stringify({ rows });
    const path = join(cwd, "stdout");
    await writeFile(path, document, { mode: 0o600 });
    const tool = createCaptureReadTool({ resolveArtifact: async () => ({ path, provenance: {} }) });
    const stringify = JSON.stringify;
    let aggregateSerializations = 0;
    let decoded;
    JSON.stringify = function (value, ...args) {
      if (value?.group_pointer === "/group" && Array.isArray(value.groups) && value.groups.length > 1) aggregateSerializations += 1;
      return Reflect.apply(stringify, this, [value, ...args]);
    };
    try {
      decoded = value(await tool.execute("capture-read-test", {
        saved_capture: processCapture({ document }),
        reduce: { group_pointer: "/group", value_pointer: "/value" },
      }, undefined, undefined, context(cwd)));
    } finally {
      JSON.stringify = stringify;
    }
    assert.equal(decoded.read_ok, true);
    const reduction = decoded.document.rows.reduction;
    assert.equal(reduction.rows_scanned, rows.length);
    assert.equal(reduction.groups_complete, true);
    assert.equal(reduction.groups.length, 100);
    assert.ok(reduction.groups.every((group) => group.count === 100 && group.sum === 125 && group.positive_count === 100));
    assert.ok(aggregateSerializations <= 2, `serialized the complete group array ${aggregateSerializations} times`);
  });
});

test("capture_read keeps incremental reduction budgets exact for escaped groups and invalid values", async () => {
  await withDirectory(async (cwd) => {
    for (const scenario of [{ times: false, validValues: true }, { times: true, validValues: true }, { times: true, validValues: false }]) {
      const rows = Array.from({ length: 100 }, (_, index) => ({
        group: `${"\u0000\"\\🙂".repeat(40)}${index}`,
        ...(scenario.validValues ? { value: index % 2 ? -1e100 : 1e100 } : {}),
        time: index,
      }));
      const document = JSON.stringify({ rows });
      const path = join(cwd, "stdout");
      await writeFile(path, document, { mode: 0o600 });
      const tool = createCaptureReadTool({ resolveArtifact: async () => ({ path, provenance: {} }) });
      const decoded = value(await tool.execute("capture-read-test", {
        saved_capture: processCapture({ document }),
        reduce: { group_pointer: "/group", value_pointer: "/value", ...(scenario.times ? { time_pointer: "/time" } : {}) },
      }, undefined, undefined, context(cwd)));
      assert.equal(decoded.read_ok, true);
      const reduction = decoded.document.rows.reduction;
      assert.ok(JSON.stringify(reduction).length <= 12_000, JSON.stringify(scenario));
      assert.equal(reduction.limit_reached, "output_chars");
      assert.equal(reduction.groups_complete, false);
      assert.ok(reduction.groups.length > 0 && reduction.groups.length < rows.length);
      assert.equal(reduction.scan_complete, !scenario.validValues);
      if (scenario.times && scenario.validValues) {
        assert.ok(reduction.groups.every((group) => group.first_time === null && group.last_time === null));
      }
      if (!scenario.validValues) {
        assert.equal(reduction.invalid_values, rows.length);
        assert.ok(reduction.omitted_groups > 0);
        assert.ok(reduction.groups.every((group) => group.count === 0 && group.sum === 0));
      }
    }
  });
});

test("capture_read reports FILE_CHANGED when saved artifact size changes between pages", async () => {
  await withDirectory(async (cwd) => {
    const document = jsonDocument({ rows: [{ value: 7 }] });
    const path = join(cwd, "stdout");
    await writeFile(path, document, { mode: 0o600 });
    let resolutions = 0;
    const tool = createCaptureReadTool({
      resolveArtifact: async () => {
        resolutions += 1;
        if (resolutions === 2) await writeFile(path, `${document}x`, { mode: 0o600 });
        return { path, provenance: { request_id: "stable-provenance" } };
      },
    });
    const decoded = value(await tool.execute("capture-read-test", {
      saved_capture: processCapture({ document }),
    }, undefined, undefined, context(cwd)));
    assert.equal(decoded.read_ok, false);
    assert.equal(decoded.stage, "artifact_read");
    assert.equal(decoded.decode_error.code, "FILE_CHANGED");
    assert.equal(decoded.status.decode, "not_attempted");
    assert.equal(decoded.capture.saved_eof, false);
    assert.equal(decoded.capture.page_count, 2);
    assert.equal("document" in decoded, false);
    assert.equal(resolutions, 2);
  });
});

test("capture_read detects changed artifact provenance without treating a partial capture as empty or rerunning its source", async () => {
  await withDirectory(async (cwd) => {
    const document = jsonDocument({ source: "fixture", status: "partial", rows: [{ value: 7 }] });
    const path = join(cwd, "stdout");
    await writeFile(path, document, { mode: 0o600 });
    let resolutions = 0;
    const tool = createCaptureReadTool({
      resolveArtifact: async () => {
        resolutions += 1;
        return { path, provenance: { request_id: "request-100", finished_at: resolutions === 1 ? "2025-01-02T03:04:06Z" : "2025-01-02T03:04:07Z" } };
      },
    });
    const saved = processCapture({ document, capture: "incomplete", exitCode: 1,
      error: { code: "QUERY_FAILED", message: "do not replace this diagnostic" } });
    const decoded = value(await tool.execute("capture-read-test", { saved_capture: saved }, undefined, undefined, context(cwd)));
    assert.equal(decoded.read_ok, false);
    assert.equal(decoded.stage, "artifact_read");
    assert.equal(decoded.decode_error.code, "PROVENANCE_CHANGED");
    assert.equal(decoded.status.decode, "not_attempted");
    assert.equal(decoded.status.producer, "unknown");
    assert.equal(decoded.capture.state, "incomplete");
    assert.equal(decoded.capture.saved_eof, false);
    assert.equal(decoded.capture.page_count, 2);
    assert.equal(decoded.capture.bytes_read, document.length);
    assert.deepEqual(decoded.provenance, { request_id: "request-100", finished_at: "2025-01-02T03:04:06Z" });
    assert.deepEqual(decoded.query_error, { code: "QUERY_FAILED", message: "do not replace this diagnostic" });
    assert.equal("document" in decoded, false, "a changed-provenance prefix is not parsed or exposed as an empty result");
    assert.equal(resolutions, 2, "only the two granted artifact pages were read; there is no source-query tool");
  });
});

test("capture_read retains failure_display as opaque fallback diagnostics when no structured error exists", async () => {
  await withDirectory(async (cwd) => {
    const document = JSON.stringify({ rows: [{ value: 1 }] });
    const failureDisplay = "[process failed] {\"error\":\"opaque; do not parse\"}";
    const path = join(cwd, "stdout");
    await writeFile(path, document, { mode: 0o600 });
    const tool = createCaptureReadTool({ resolveArtifact: async () => ({ path, provenance: { request_id: "fallback-diagnostic" } }) });
    const saved = processCapture({ document, exitCode: 1, failureDisplay });
    const decoded = value(await tool.execute("capture-read-test", { saved_capture: saved }, undefined, undefined, context(cwd)));
    assert.equal(decoded.read_ok, true);
    assert.equal(decoded.status.process, "failed");
    assert.equal(decoded.process.exit_code, 1);
    assert.deepEqual(decoded.capture_ref, { artifact_id: ARTIFACT_ID, stdout: true, stderr: false });
    assert.equal(decoded.failure_display, failureDisplay);
    assert.equal("query_error" in decoded, false);

    const oversizedDisplay = "opaque diagnostic ".repeat(2_000);
    const oversized = value(await tool.execute("capture-read-test", {
      saved_capture: processCapture({ document, exitCode: 1, failureDisplay: oversizedDisplay }),
    }, undefined, undefined, context(cwd)));
    assert.equal(oversized.read_ok, true);
    assert.equal(oversized.status.process, "failed");
    assert.equal(oversized.failure_display.omitted, true);
    assert.equal(oversized.failure_display.reference, "saved_capture.failure_display");
    assert.equal(oversized.failure_display.encoded_bytes, Buffer.byteLength(JSON.stringify(oversizedDisplay)));
  });
});

test("capture_read keeps oversized original metadata explicit by reference", async () => {
  await withDirectory(async (cwd) => {
    const document = JSON.stringify({ rows: [] });
    const path = join(cwd, "stdout");
    await writeFile(path, document, { mode: 0o600 });
    const tool = createCaptureReadTool({ resolveArtifact: async () => ({ path, provenance: {} }) });
    const request = { query: "q".repeat(20_000) };
    const error = { code: "QUERY_FAILED", message: "e".repeat(20_000) };
    const saved = processCapture({ document, exitCode: 1, request, error });
    const decoded = value(await tool.execute("capture-read-test", { saved_capture: saved }, undefined, undefined, context(cwd)));
    assert.equal(decoded.read_ok, true);
    assert.equal(decoded.status.process, "failed");
    assert.equal(decoded.process.exit_code, 1);
    assert.deepEqual(decoded.capture_ref, { artifact_id: ARTIFACT_ID, stdout: true, stderr: false });
    assert.deepEqual(decoded.request, { omitted: true, reference: "saved_capture.details.request", encoded_bytes: Buffer.byteLength(JSON.stringify(request)) });
    assert.deepEqual(decoded.query_error, { omitted: true, reference: "saved_capture.details.error", encoded_bytes: Buffer.byteLength(JSON.stringify(error)) });
    assert.ok(Buffer.byteLength(JSON.stringify(decoded)) < 48 * 1024);
  });
});

test("capture_read leaves decode not_attempted when original metadata exceeds its pre-read budget", async () => {
  await withDirectory(async (cwd) => {
    const document = JSON.stringify({ rows: [] });
    const path = join(cwd, "stdout");
    await writeFile(path, document, { mode: 0o600 });
    let resolutions = 0;
    const tool = createCaptureReadTool({ resolveArtifact: async () => { resolutions += 1; return { path, provenance: {} }; } });
    const repeated = "m".repeat(510);
    const request = { query: "r".repeat(2035) };
    const error = { code: "QUERY_FAILED", message: "e".repeat(1990) };
    const failureDisplay = "d".repeat(2046);
    const saved = processCapture({ document, exitCode: 1, request, error, failureDisplay });
    Object.assign(saved.details, {
      tool: repeated, exit_code: repeated, signal: repeated, timed_out: repeated, stop_reason: repeated,
      cleanup: repeated, duration_ms: repeated,
    });
    Object.assign(saved.details.stdout, { capture: repeated, preview: repeated, captured_raw_bytes: repeated });
    saved.details.stderr.captured_raw_bytes = repeated;
    const decoded = value(await tool.execute("capture-read-test", { saved_capture: saved }, undefined, undefined, context(cwd)));
    assert.equal(decoded.read_ok, false);
    assert.equal(decoded.stage, "original_metadata_limit");
    assert.equal(decoded.decode_error.code, "METADATA_TOO_LARGE");
    assert.equal(decoded.status.decode, "not_attempted");
    assert.equal(decoded.status.process, "failed");
    assert.equal(decoded.process.exit_code, repeated);
    assert.deepEqual(decoded.query_error, error);
    assert.equal(decoded.failure_display, failureDisplay);
    assert.deepEqual(decoded.capture_ref, { artifact_id: ARTIFACT_ID, stdout: true, stderr: false });
    assert.equal(resolutions, 0, "original metadata is rejected before any artifact read");
  });
});

test("capture_read output-limit failures preserve original process and error evidence", async () => {
  await withDirectory(async (cwd) => {
    const document = JSON.stringify({ rows: [] });
    const path = join(cwd, "stdout");
    await writeFile(path, document, { mode: 0o600 });
    const queryError = { code: "QUERY_FAILED", message: "original diagnostic remains" };
    const tool = createCaptureReadTool({ resolveArtifact: async () => ({
      path, provenance: { detail: "p".repeat(48_250) },
    }) });
    const saved = processCapture({ document, exitCode: 1, error: queryError });
    const result = await tool.execute("capture-read-test", { saved_capture: saved }, undefined, undefined, context(cwd));
    const decoded = value(result);
    assert.equal(decoded.read_ok, false);
    assert.equal(decoded.stage, "output_limit");
    assert.equal(decoded.decode_error.code, "RESULT_TOO_LARGE");
    assert.equal(decoded.status.process, "failed");
    assert.equal(decoded.status.capture, "complete");
    assert.equal(decoded.process.exit_code, 1);
    assert.deepEqual(decoded.query_error, queryError);
    assert.deepEqual(decoded.capture_ref, { artifact_id: ARTIFACT_ID, stdout: true, stderr: false });
    assert.equal(decoded.provenance.omitted, true);
    assert.equal(decoded.provenance.reference, "capture_read.provenance");
    assert.ok(Buffer.byteLength(result.content[0].text) < 48 * 1024);
  });
});

test("capture_read uses only verified complete stdout_text and never parses the preview", async () => {
  await withDirectory(async (cwd) => {
    const inlineText = JSON.stringify({ source: "inline", status: "ok", rows: [{ value: 5 }] });
    const saved = processCapture({ document: inlineText, stdoutText: inlineText, preview: `framed ${inlineText}` });
    let resolutions = 0;
    const tool = createCaptureReadTool({ resolveArtifact: async () => { resolutions += 1; throw new Error("must not resolve"); } });
    const decoded = value(await tool.execute("capture-read-test", { saved_capture: saved }, undefined, undefined, context(cwd)));
    assert.equal(decoded.read_ok, true);
    assert.deepEqual(decoded.capture_ref, { source: "stdout_text" });
    assert.equal(decoded.capture.source, "stdout_text");
    assert.equal(decoded.document.producer_metadata.source, "inline");
    assert.equal(resolutions, 0);
    const unsafe = processCapture({ document: inlineText, stdoutText: `${inlineText} ` });
    unsafe.details.stdout.captured_raw_bytes -= 1;
    const rejected = value(await tool.execute("capture-read-test", { saved_capture: unsafe }, undefined, undefined, context(cwd)));
    assert.equal(rejected.read_ok, false);
    assert.equal(rejected.decode_error.code, "ARTIFACT_MISSING");
    assert.equal(resolutions, 0);
  });
});

test("capture_read returns the host grant error unchanged and applies the source-size limit before parsing", async () => {
  await withDirectory(async (cwd) => {
    const document = JSON.stringify({ rows: [] });
    const denied = createCaptureReadTool({ resolveArtifact: async () => { throw new ArtifactResolutionError("branch grant is unavailable"); } });
    const deniedResult = value(await denied.execute("capture-read-test", { saved_capture: processCapture({ document }) }, undefined, undefined, context(cwd)));
    assert.equal(deniedResult.read_ok, false);
    assert.equal(deniedResult.decode_error.code, "ARTIFACT_NOT_FOUND");
    assert.equal(deniedResult.decode_error.message, "branch grant is unavailable");

    const path = join(cwd, "large");
    await writeFile(path, "x".repeat(1024 * 1024 + 1), { mode: 0o600 });
    let resolutions = 0;
    const limited = createCaptureReadTool({ resolveArtifact: async () => { resolutions += 1; return { path, provenance: {} }; } });
    const result = value(await limited.execute("capture-read-test", { saved_capture: processCapture({ document }) }, undefined, undefined, context(cwd)));
    assert.equal(result.read_ok, false);
    assert.equal(result.stage, "size_limit");
    assert.equal(result.decode_error.code, "CAPTURE_TOO_LARGE");
    assert.equal(result.capture.bytes_read, 40_960);
    assert.equal(result.capture.page_count, 1);
    assert.equal(result.capture.saved_eof, false);
    assert.equal(resolutions, 1);
  });
});

test("capture_read scans a 1,217,957-byte JSONL artifact through exact ID grants, split UTF-8 pages, and nested projection", async () => {
  await withDirectory(async (cwd) => {
    const document = largeJsonlFixture();
    const path = join(cwd, "stdout");
    await writeFile(path, document, { mode: 0o600 });
    const resolutions = [];
    const provenance = { request_id: "jsonl-request", capture: { state: "complete" } };
    const tool = createCaptureReadTool({ resolveArtifact: async (id, stream, ctx) => {
      resolutions.push({ id, stream, cwd: ctx.cwd });
      if (id !== ARTIFACT_ID) throw new ArtifactResolutionError("The exact saved artifact grant is unavailable");
      assert.equal(stream, "stdout");
      assert.equal(ctx.cwd, cwd);
      return { path, provenance };
    } });
    const decoded = value(await tool.execute("capture-jsonl-test", {
      saved_capture: processCapture({ document, capture: "incomplete" }),
      format: "jsonl",
      project: { fields: { name: "/identity/name", count: "/values/count", marker: "/marker" } },
      reduce: { group_pointer: "/identity", value_pointer: "/values/count" },
    }, undefined, undefined, context(cwd)));
    assert.equal(decoded.read_ok, true);
    assert.deepEqual(decoded.status, { process: "ok", capture: "incomplete", decode: "ok", producer: "unknown" });
    assert.deepEqual(decoded.capture, { state: "incomplete", saved_bytes: 1_217_957, bytes_read: 1_217_957, page_count: 30, saved_eof: true });
    assert.deepEqual(decoded.provenance, provenance);
    assert.deepEqual(decoded.document.jsonl, {
      byte_scan_complete: true, records_complete: true, lines_seen: 100, records_seen: 100, valid_records: 100,
      invalid_lines: 0, blank_lines: 0, non_object_records: 0, omitted_records: 0, errors_omitted: 0,
      limit_reached: null, errors: [],
    });
    assert.equal(decoded.document.rows.count, 100);
    assert.deepEqual(decoded.document.rows.projection.items[0], { name: "api", count: 1, marker: "🙂" });
    assert.equal(decoded.document.rows.projection.shown_count, 100);
    assert.equal(decoded.document.rows.projection.scan_complete, true);
    assert.deepEqual(decoded.document.rows.reduction.groups, [{ group: { name: "api", unit: "requests" }, count: 100, sum: 100, min: 1, max: 1, positive_count: 100 }]);
    assert.equal(decoded.document.rows.reduction.rows_scanned, 100);
    assert.equal(resolutions.length, decoded.capture.page_count);
    assert.ok(Buffer.byteLength(JSON.stringify(decoded)) < 48 * 1024);

    const ungranted = value(await tool.execute("capture-jsonl-ungranted", {
      saved_capture: processCapture({ id: "123e4567-e89b-42d3-a456-426614174110", document }), format: "jsonl",
    }, undefined, undefined, context(cwd)));
    assert.equal(ungranted.read_ok, false);
    assert.equal(ungranted.decode_error.code, "ARTIFACT_NOT_FOUND");
  });
});

test("capture_read JSONL retains malformed-line evidence, fails incomplete data, and treats empty input as zero rows", async () => {
  await withDirectory(async (cwd) => {
    const path = join(cwd, "stdout");
    await writeFile(path, '{"id":1,"value":2}\n{bad json}\n{"id":2,"value":3}\n', { mode: 0o600 });
    const tool = createCaptureReadTool({ resolveArtifact: async () => ({ path, provenance: { request_id: "jsonl-malformed" } }) });
    const malformed = value(await tool.execute("capture-jsonl-malformed", {
      saved_capture: processCapture({ document: '{"id":1,"value":2}\n{bad json}\n{"id":2,"value":3}\n' }),
      format: "jsonl",
      project: { fields: { id: "/id", value: "/value" } },
      reduce: { group_pointer: "/id", value_pointer: "/value" },
    }, undefined, undefined, context(cwd)));
    assert.equal(malformed.read_ok, false);
    assert.equal(malformed.stage, "jsonl_parse");
    assert.equal(malformed.decode_error.code, "INVALID_JSONL_LINES");
    assert.equal(malformed.status.decode, "failed");
    assert.deepEqual(malformed.document.jsonl.errors, [{ line: 2, code: "INVALID_JSON", message: "JSONL record is not valid JSON" }]);
    assert.equal(malformed.document.rows.count, 3);
    assert.deepEqual(malformed.document.rows.projection.items, [{ id: 1, value: 2 }, { id: null, value: null }, { id: 2, value: 3 }]);
    assert.equal(malformed.document.rows.reduction.groups_complete, false);
    assert.deepEqual(malformed.document.rows.reduction.groups, [], "a malformed row cannot produce apparently complete totals");

    await writeFile(path, "", { mode: 0o600 });
    const empty = value(await tool.execute("capture-jsonl-empty", {
      saved_capture: processCapture({ document: "" }), format: "jsonl",
    }, undefined, undefined, context(cwd)));
    assert.equal(empty.read_ok, true);
    assert.equal(empty.capture.saved_eof, true);
    assert.equal(empty.document.rows.count, 0);
    assert.deepEqual(empty.document.rows.sample, []);
    assert.equal(empty.document.jsonl.records_complete, true);
  });
});

test("capture_read bounds an oversized JSONL line and resumes at the next record", async () => {
  await withDirectory(async (cwd) => {
    const oversized = JSON.stringify({ id: 1, padding: "x".repeat(256 * 1024) });
    assert.ok(Buffer.byteLength(oversized) > 256 * 1024);
    const document = `${oversized}\n${JSON.stringify({ id: 2 })}\n`;
    const path = join(cwd, "stdout");
    await writeFile(path, document, { mode: 0o600 });
    const tool = createCaptureReadTool({ resolveArtifact: async () => ({ path, provenance: { request_id: "jsonl-long-line" } }) });
    const decoded = value(await tool.execute("capture-jsonl-long-line", {
      saved_capture: processCapture({ document }), format: "jsonl", project: { fields: { id: "/id" } },
    }, undefined, undefined, context(cwd)));
    assert.equal(decoded.read_ok, false);
    assert.equal(decoded.stage, "jsonl_parse");
    assert.equal(decoded.decode_error.code, "JSONL_LINE_TOO_LARGE");
    assert.equal(decoded.capture.saved_eof, true);
    assert.equal(decoded.document.jsonl.byte_scan_complete, true);
    assert.equal(decoded.document.jsonl.limit_reached, "line_bytes");
    assert.deepEqual(decoded.document.jsonl.errors, [{ line: 1, code: "LINE_TOO_LARGE", message: "Line exceeds the 262144-byte limit" }]);
    assert.deepEqual(decoded.document.rows.projection.items, [{ id: null }, { id: 2 }]);
  });
});

test("capture_read JSONL stops at its fixed byte budget and marks prefix coverage incomplete", async () => {
  await withDirectory(async (cwd) => {
    const line = `${JSON.stringify({ group: "api", value: 1, padding: "x".repeat(80) })}\n`;
    const document = line.repeat(90_000);
    assert.ok(Buffer.byteLength(document) > 8 * 1024 * 1024);
    const path = join(cwd, "stdout");
    await writeFile(path, document, { mode: 0o600 });
    let resolutions = 0;
    const tool = createCaptureReadTool({ resolveArtifact: async () => { resolutions += 1; return { path, provenance: { request_id: "jsonl-bounded" } }; } });
    const decoded = value(await tool.execute("capture-jsonl-limit", {
      saved_capture: processCapture({ document }), format: "jsonl", project: { fields: { group: "/group" }, limit: 100 },
    }, undefined, undefined, context(cwd)));
    assert.equal(decoded.read_ok, false);
    assert.equal(decoded.stage, "size_limit");
    assert.equal(decoded.decode_error.code, "CAPTURE_TOO_LARGE");
    assert.equal(decoded.capture.bytes_read, 8 * 1024 * 1024);
    assert.equal(decoded.capture.saved_eof, false);
    assert.equal(decoded.document.jsonl.byte_scan_complete, false);
    assert.equal(decoded.document.jsonl.records_complete, false);
    assert.equal(decoded.document.jsonl.limit_reached, "capture_bytes");
    assert.equal(decoded.document.jsonl.omitted_records, 0);
    assert.equal(decoded.document.rows.count, null);
    assert.equal(decoded.document.rows.projection.shown_count, 100);
    assert.equal(decoded.document.rows.projection.scan_complete, false);
    assert.equal(decoded.document.rows.projection.limit_reached, "rows", "projection and byte-scan limits remain distinct");

    const resolutionsBeforeInline = resolutions;
    const safeText = value(await tool.execute("capture-jsonl-text-limit", {
      saved_capture: processCapture({ document, stdoutText: document }), format: "jsonl",
    }, undefined, undefined, context(cwd)));
    assert.equal(safeText.read_ok, false);
    assert.equal(safeText.decode_error.code, "CAPTURE_TOO_LARGE");
    assert.equal(safeText.capture.bytes_read, 8 * 1024 * 1024);
    assert.equal(safeText.capture.saved_eof, false);
    assert.equal(safeText.document.rows.count, null);
    assert.equal(resolutions, resolutionsBeforeInline, "safe stdout_text must not consult the artifact resolver");
  });
});

test("capture_read rejects JSONL pages whose granted provenance changes", async () => {
  await withDirectory(async (cwd) => {
    const document = '{"value":1}\n'.repeat(5_000);
    const path = join(cwd, "stdout");
    await writeFile(path, document, { mode: 0o600 });
    let resolutions = 0;
    const tool = createCaptureReadTool({ resolveArtifact: async () => ({ path, provenance: { request_id: `page-${++resolutions}` } }) });
    const decoded = value(await tool.execute("capture-jsonl-provenance", {
      saved_capture: processCapture({ document }), format: "jsonl",
    }, undefined, undefined, context(cwd)));
    assert.equal(decoded.read_ok, false);
    assert.equal(decoded.stage, "artifact_read");
    assert.equal(decoded.decode_error.code, "PROVENANCE_CHANGED");
    assert.equal(decoded.capture.saved_eof, false);
    assert.equal("document" in decoded, false);
    assert.ok(resolutions > 1);
  });
});

test("capture_read JSONL pages are contiguous, retain the ten-row default sample, and reach a 200-row EOF", async () => {
  await withDirectory(async (cwd) => {
    const rows = Array.from({ length: 6 }, (_, index) => ({ id: index + 1, message: `event-${index + 1}` }));
    const document = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
    const path = join(cwd, "stdout");
    await writeFile(path, document, { mode: 0o600 });
    const tool = createCaptureReadTool({ resolveArtifact: async () => ({ path, provenance: { request_id: "jsonl-row-pages" } }) });
    const saved = processCapture({ document });
    const first = value(await tool.execute("capture-jsonl-row-page-1", {
      saved_capture: saved, format: "jsonl", jsonl_page: { start_byte: 0, max_records: 3 },
    }, undefined, undefined, context(cwd)));
    assert.deepEqual(first.document.rows.sample, rows.slice(0, 3));
    assert.equal(first.document.jsonl_page.start_byte, 0);
    assert.equal(first.document.jsonl_page.next_start_byte, Buffer.byteLength(`${rows.slice(0, 3).map((row) => JSON.stringify(row)).join("\n")}\n`));
    assert.equal(first.document.jsonl_page.eof, false);
    assert.equal(first.document.jsonl_page.complete, false);

    const second = value(await tool.execute("capture-jsonl-row-page-2", {
      saved_capture: saved,
      format: "jsonl",
      jsonl_page: { start_byte: first.document.jsonl_page.next_start_byte, max_records: 3 },
    }, undefined, undefined, context(cwd)));
    assert.deepEqual(second.document.rows.sample, rows.slice(3));
    assert.equal(second.document.jsonl_page.eof, true);
    assert.equal(second.document.jsonl_page.next_start_byte, Buffer.byteLength(document));
    assert.equal(second.document.jsonl_page.complete, false, "a suffix page cannot claim global coverage");

    const sampleText = `${Array.from({ length: 15 }, (_, index) => JSON.stringify({ id: index })).join("\n")}\n`;
    const defaultSample = value(await tool.execute("capture-jsonl-default-sample", {
      saved_capture: processCapture({ document: sampleText, stdoutText: sampleText }), format: "jsonl",
    }, undefined, undefined, context(cwd)));
    assert.equal(defaultSample.document.rows.sample.length, 10);
    assert.equal(defaultSample.document.rows.sample_incomplete, true);

    const twoHundredRows = Array.from({ length: 200 }, (_, index) => ({ id: index }));
    const twoHundredText = `${twoHundredRows.map((row) => JSON.stringify(row)).join("\n")}\n`;
    const fullPage = value(await tool.execute("capture-jsonl-page-200", {
      saved_capture: processCapture({ document: twoHundredText, stdoutText: twoHundredText }),
      format: "jsonl", jsonl_page: { max_records: 200 },
    }, undefined, undefined, context(cwd)));
    assert.deepEqual(fullPage.document.rows.sample, twoHundredRows);
    assert.equal(fullPage.document.rows.count, 200);
    assert.equal(fullPage.document.jsonl_page.eof, true);
    assert.equal(fullPage.document.jsonl_page.complete, true);
    assert.equal(fullPage.document.jsonl_page.next_start_byte, Buffer.byteLength(twoHundredText));
  });
});

test("capture_read JSONL row pages use the 8-MiB scan budget and continue at the next line boundary", async () => {
  await withDirectory(async (cwd) => {
    const scanBudgetBytes = 8 * 1024 * 1024;
    const row = JSON.stringify({ value: "🙂" });
    const rowPrefix = row.slice(0, row.indexOf("🙂"));
    const prefixBytes = scanBudgetBytes - 3 - Buffer.byteLength(rowPrefix);
    const document = `${"\n".repeat(prefixBytes)}${row}\n`;
    const path = join(cwd, "scan-budget-stdout");
    await writeFile(path, document, { mode: 0o600 });
    const tool = createCaptureReadTool({ resolveArtifact: async () => ({ path, provenance: { request_id: "jsonl-page-scan-budget" } }) });
    const saved = processCapture({ document });
    const first = value(await tool.execute("capture-jsonl-scan-budget-first", {
      saved_capture: saved, format: "jsonl", jsonl_page: { max_records: 10 },
    }, undefined, undefined, context(cwd)));
    assert.equal(first.read_ok, true);
    assert.equal(first.capture.bytes_read, scanBudgetBytes - 3);
    assert.equal(first.document.rows.sample.length, 0, "the partially scanned multibyte row is not returned");
    assert.equal(first.document.jsonl_page.limit_reached, "scan_bytes");
    assert.equal(first.document.jsonl_page.next_start_byte, prefixBytes);
    assert.equal(first.document.jsonl_page.eof, false);

    const second = value(await tool.execute("capture-jsonl-scan-budget-next", {
      saved_capture: saved, format: "jsonl", jsonl_page: { start_byte: prefixBytes, max_records: 10 },
    }, undefined, undefined, context(cwd)));
    assert.deepEqual(second.document.rows.sample, [{ value: "🙂" }]);
    assert.equal(second.document.jsonl_page.eof, true);
    assert.equal(second.document.jsonl_page.complete, false);
  });
});

test("capture_read JSONL row pages project selected fields around padding and surface oversized record gaps", async () => {
  await withDirectory(async (cwd) => {
    const document = largeJsonlFixture();
    const path = join(cwd, "stdout");
    await writeFile(path, document, { mode: 0o600 });
    const provenance = { request_id: "jsonl-page-padding" };
    const tool = createCaptureReadTool({ resolveArtifact: async () => ({ path, provenance }) });
    const projected = value(await tool.execute("capture-jsonl-projected-page", {
      saved_capture: processCapture({ document }),
      format: "jsonl",
      project: { fields: { name: "/identity/name", marker: "/marker" } },
      jsonl_page: { max_records: 2 },
    }, undefined, undefined, context(cwd)));
    assert.equal(projected.read_ok, true);
    assert.deepEqual(projected.document.rows.projection.items, [
      { name: "api", marker: "🙂" }, { name: "api", marker: "🙂" },
    ]);
    assert.equal(projected.document.jsonl_page.records_returned, 2);
    assert.equal(projected.document.jsonl_page.eof, false);
    assert.deepEqual(projected.document.jsonl_page.gaps, []);
    assert.deepEqual(projected.provenance, provenance);

    const traversed = [];
    let cursor = 0;
    let pageNumber = 0;
    while (true) {
      const page = value(await tool.execute(`capture-jsonl-large-traversal-${pageNumber}`, {
        saved_capture: processCapture({ document }), format: "jsonl",
        project: { fields: { index: "/index", marker: "/marker" } },
        jsonl_page: { start_byte: cursor, max_records: 10 },
      }, undefined, undefined, context(cwd)));
      assert.equal(page.read_ok, true);
      assert.equal(page.document.jsonl_page.start_byte, cursor);
      assert.deepEqual(page.document.jsonl_page.errors, []);
      assert.deepEqual(page.document.jsonl_page.gaps, []);
      assert.deepEqual(page.provenance, provenance);
      traversed.push(...page.document.rows.projection.items);
      const nextCursor = page.document.jsonl_page.next_start_byte;
      if (page.document.jsonl_page.eof) {
        assert.equal(nextCursor, Buffer.byteLength(document));
        break;
      }
      assert.ok(nextCursor > cursor, "each row page advances its newline-boundary cursor");
      cursor = nextCursor;
      pageNumber += 1;
    }
    assert.deepEqual(traversed, Array.from({ length: 100 }, (_, index) => ({ index, marker: "🙂" })));

    const selectedValue = "s".repeat(1_000);
    const selectedDocument = `${JSON.stringify({ message: selectedValue, padding: "p".repeat(4_096) })}\n`;
    const selectedPath = join(cwd, "selected-stdout");
    await writeFile(selectedPath, selectedDocument, { mode: 0o600 });
    const selectedTool = createCaptureReadTool({ resolveArtifact: async () => ({ path: selectedPath, provenance: { request_id: "jsonl-page-selected" } }) });
    const selectedPage = value(await selectedTool.execute("capture-jsonl-selected-page-field", {
      saved_capture: processCapture({ document: selectedDocument }), format: "jsonl",
      project: { fields: { message: "/message" } }, jsonl_page: { max_records: 1 },
    }, undefined, undefined, context(cwd)));
    assert.deepEqual(selectedPage.document.rows.projection.items, [{ message: selectedValue }]);
    assert.equal(selectedPage.document.jsonl_page.gaps.length, 0);

    const missingFieldDocument = `${JSON.stringify({ id: 1 })}\n`;
    const missingField = value(await selectedTool.execute("capture-jsonl-missing-projected-field", {
      saved_capture: processCapture({ document: missingFieldDocument, stdoutText: missingFieldDocument }),
      format: "jsonl", project: { fields: { required: "/required" } }, jsonl_page: { max_records: 1 },
    }, undefined, undefined, context(cwd)));
    assert.equal(missingField.read_ok, false);
    assert.equal(missingField.decode_error.code, "JSONL_FIELDS_INCOMPLETE");
    assert.equal(missingField.document.rows.projection.fields_complete, false);
    assert.deepEqual(missingField.document.rows.projection.items, [{ required: null }]);
    assert.equal(missingField.document.jsonl_page.complete, true, "source coverage and projection completeness are separate");

    const oversized = JSON.stringify({ id: 1, padding: "x".repeat(3_000) });
    const gapText = `${oversized}\n${JSON.stringify({ id: 2 })}\n`;
    const gapPath = join(cwd, "gap-stdout");
    await writeFile(gapPath, gapText, { mode: 0o600 });
    const gapTool = createCaptureReadTool({ resolveArtifact: async () => ({ path: gapPath, provenance: { request_id: "jsonl-page-gap" } }) });
    const gap = value(await gapTool.execute("capture-jsonl-oversize-gap", {
      saved_capture: processCapture({ document: gapText }), format: "jsonl", jsonl_page: { max_records: 1 },
    }, undefined, undefined, context(cwd)));
    const nextCursor = Buffer.byteLength(`${oversized}\n`);
    assert.equal(gap.read_ok, false);
    assert.equal(gap.decode_error.code, "JSONL_RECORD_GAP");
    assert.deepEqual(gap.document.rows.sample, [], "the oversized first record is not returned partially");
    assert.equal(gap.document.jsonl_page.records_returned, 0);
    assert.equal(gap.document.jsonl.omitted_records, 1);
    assert.equal(gap.document.jsonl.invalid_lines, 1);
    assert.deepEqual(gap.document.jsonl_page.errors, [], "a record gap is not duplicated as a parse error");
    assert.deepEqual(gap.document.jsonl_page.gaps, [{
      start_byte: 0,
      end_byte: Buffer.byteLength(oversized),
      next_start_byte: nextCursor,
      code: "ROW_TOO_LARGE",
      message: "JSONL page row exceeds the 2048-character limit",
    }]);
    assert.equal(gap.document.jsonl_page.next_start_byte, nextCursor);
    assert.equal(gap.document.jsonl_page.eof, false);

    const afterGap = value(await gapTool.execute("capture-jsonl-after-gap", {
      saved_capture: processCapture({ document: gapText }),
      format: "jsonl",
      jsonl_page: { start_byte: gap.document.jsonl_page.next_start_byte, max_records: 1 },
    }, undefined, undefined, context(cwd)));
    assert.deepEqual(afterGap.document.rows.sample, [{ id: 2 }]);
    assert.equal(afterGap.document.jsonl_page.records_returned, 1);
    assert.deepEqual(afterGap.document.jsonl_page.gaps, []);
    assert.equal(afterGap.document.jsonl.omitted_records, 0);
    assert.equal(afterGap.document.jsonl_page.eof, true);
    assert.equal(afterGap.document.jsonl_page.complete, false, "an earlier gap prevents complete coverage");

    const oversizedLine = JSON.stringify({ id: 3, padding: "x".repeat(256 * 1024) });
    const lineGapText = `${oversizedLine}\n${JSON.stringify({ id: 4 })}\n`;
    const lineGapPath = join(cwd, "line-gap-stdout");
    await writeFile(lineGapPath, lineGapText, { mode: 0o600 });
    const lineGapTool = createCaptureReadTool({ resolveArtifact: async () => ({ path: lineGapPath, provenance: { request_id: "jsonl-page-line-gap" } }) });
    const lineGap = value(await lineGapTool.execute("capture-jsonl-line-gap", {
      saved_capture: processCapture({ document: lineGapText }), format: "jsonl", jsonl_page: { max_records: 1 },
    }, undefined, undefined, context(cwd)));
    assert.equal(lineGap.document.jsonl_page.gaps[0].code, "LINE_TOO_LARGE");
    assert.equal(lineGap.document.jsonl_page.next_start_byte, Buffer.byteLength(`${oversizedLine}\n`));
    const afterLineGap = value(await lineGapTool.execute("capture-jsonl-after-line-gap", {
      saved_capture: processCapture({ document: lineGapText }), format: "jsonl",
      jsonl_page: { start_byte: lineGap.document.jsonl_page.next_start_byte, max_records: 1 },
    }, undefined, undefined, context(cwd)));
    assert.deepEqual(afterLineGap.document.rows.sample, [{ id: 4 }]);
    assert.equal(afterLineGap.document.jsonl_page.eof, true);
  });
});

test("capture_read JSONL row pages keep UTF-8 output bounded without skipping the next record", async () => {
  await withDirectory(async (cwd) => {
    const rows = Array.from({ length: 5 }, (_, id) => ({ id, message: "漢".repeat(1_000) }));
    const lines = rows.map((row) => JSON.stringify(row));
    const document = `${lines.join("\n")}\n`;
    const tool = createCaptureReadTool({ resolveArtifact: async () => { throw new Error("inline capture should not need an artifact grant"); } });
    const first = value(await tool.execute("capture-jsonl-output-byte-page", {
      saved_capture: processCapture({ document, stdoutText: document }), format: "jsonl", jsonl_page: { max_records: 10 },
    }, undefined, undefined, context(cwd)));
    assert.equal(first.read_ok, true);
    assert.equal(first.document.rows.sample.length, 3);
    assert.equal(first.document.jsonl_page.limit_reached, "result_bytes");
    const nextStartByte = Buffer.byteLength(`${lines.slice(0, 3).join("\n")}\n`);
    assert.equal(first.document.jsonl_page.next_start_byte, nextStartByte);
    const second = value(await tool.execute("capture-jsonl-output-byte-page-next", {
      saved_capture: processCapture({ document, stdoutText: document }), format: "jsonl", jsonl_page: { start_byte: nextStartByte, max_records: 10 },
    }, undefined, undefined, context(cwd)));
    assert.deepEqual(second.document.rows.sample, rows.slice(3));
    assert.equal(second.document.jsonl_page.eof, true);
    assert.equal(second.document.jsonl_page.complete, false);
  });
});

test("capture_read validates JSONL cursors and provenance across UTF-8 pages without a source call or ungranted read", async () => {
  await withDirectory(async (cwd) => {
    const rows = [{ id: 1 }, { id: 2 }];
    const document = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
    const path = join(cwd, "stdout");
    await writeFile(path, document, { mode: 0o600 });
    const stable = createCaptureReadTool({ resolveArtifact: async () => ({ path, provenance: { request_id: "jsonl-cursor" } }) });
    const invalid = value(await stable.execute("capture-jsonl-invalid-cursor", {
      saved_capture: processCapture({ document }), format: "jsonl", jsonl_page: { start_byte: 1 },
    }, undefined, undefined, context(cwd)));
    assert.equal(invalid.read_ok, false);
    assert.equal(invalid.decode_error.code, "INVALID_CURSOR");
    assert.match(invalid.decode_error.message, /immediately after a newline/);
    const eofByte = Buffer.byteLength(document);
    for (const [index, delta] of [1, 2, 100].entries()) {
      const beyondEof = value(await stable.execute(`capture-jsonl-cursor-past-eof-${index}`, {
        saved_capture: processCapture({ document }), format: "jsonl", jsonl_page: { start_byte: eofByte + delta },
      }, undefined, undefined, context(cwd)));
      assert.equal(beyondEof.decode_error.code, "INVALID_CURSOR");
    }

    const malformedPrefix = '{"bad":"';
    const malformedPadding = "x".repeat(40_958 - Buffer.byteLength(malformedPrefix));
    const malformedLine = `${malformedPrefix}${malformedPadding}🙂" trailing}`;
    const malformedDocument = `${malformedLine}\n${JSON.stringify({ id: 2 })}\n`;
    await writeFile(path, malformedDocument, { mode: 0o600 });
    let malformedReads = 0;
    const malformedTool = createCaptureReadTool({ resolveArtifact: async () => {
      malformedReads += 1;
      return { path, provenance: { request_id: "jsonl-malformed-split" } };
    } });
    const malformedPage = value(await malformedTool.execute("capture-jsonl-malformed-split", {
      saved_capture: processCapture({ document: malformedDocument }), format: "jsonl",
      project: { fields: { id: "/id" } }, jsonl_page: { max_records: 2 },
    }, undefined, undefined, context(cwd)));
    assert.equal(malformedPage.read_ok, false);
    assert.deepEqual(malformedPage.document.rows.projection.items, [{ id: null }, { id: 2 }]);
    assert.equal(malformedPage.document.jsonl_page.errors[0].code, "INVALID_JSON");
    assert.equal(malformedPage.document.jsonl_page.errors[0].end_byte, Buffer.byteLength(malformedLine));
    assert.equal(malformedPage.document.jsonl_page.eof, true);
    assert.ok(malformedReads > 1, "a record with a boundary-adjacent multibyte character spans UTF-8 pages");

    const splitDocument = largeJsonlFixture();
    await writeFile(path, splitDocument, { mode: 0o600 });
    let provenanceCalls = 0;
    const changed = createCaptureReadTool({ resolveArtifact: async () => ({
      path, provenance: { request_id: `jsonl-page-${++provenanceCalls}` },
    }) });
    const split = value(await changed.execute("capture-jsonl-page-provenance", {
      saved_capture: processCapture({ document: splitDocument }), format: "jsonl",
      project: { fields: { marker: "/marker" } }, jsonl_page: { max_records: 1 },
    }, undefined, undefined, context(cwd)));
    assert.equal(split.read_ok, false);
    assert.equal(split.decode_error.code, "PROVENANCE_CHANGED");
    assert.ok(provenanceCalls > 1, "the selected record spans multiple verified artifact pages");

    let grantCalls = 0;
    let sourceCalls = 0;
    const noGrant = createCaptureReadTool({ resolveArtifact: async () => {
      grantCalls += 1;
      throw new ArtifactResolutionError("JSONL page grant denied");
    } });
    const noSourceContext = {
      ...context(cwd),
      executeTool: async () => { sourceCalls += 1; throw new Error("source query must not run"); },
    };
    const denied = value(await noGrant.execute("capture-jsonl-page-no-grant", {
      saved_capture: processCapture({ document }), format: "jsonl", jsonl_page: { max_records: 1 },
    }, undefined, undefined, noSourceContext));
    assert.equal(denied.read_ok, false);
    assert.equal(denied.decode_error.code, "ARTIFACT_NOT_FOUND");
    assert.equal(denied.decode_error.message, "JSONL page grant denied");
    assert.equal(grantCalls, 1);
    assert.equal(sourceCalls, 0);
  });
});

test("capture_read decodes only a bounded granted base64+gzip JSON field and verifies gzip integrity", async () => {
  await withDirectory(async (cwd) => {
    const payload = "saved gzip evidence 🙂";
    const gzip = gzipSync(Buffer.from(payload, "utf8"));
    const source = JSON.stringify({ payload: gzip.toString("base64"), padding: "x".repeat(50 * 1024) });
    const path = join(cwd, "stdout");
    await writeFile(path, source, { mode: 0o600 });
    let resolutions = 0;
    const tool = createCaptureReadTool({ resolveArtifact: async (id, stream, ctx) => {
      resolutions += 1;
      assert.equal(id, ARTIFACT_ID);
      assert.equal(stream, "stdout");
      assert.equal(ctx.cwd, cwd);
      return { path, provenance: { request_id: "gzip-grant" } };
    } });
    const saved = processCapture({ document: source });
    const decoded = value(await tool.execute("capture-gzip-valid", {
      saved_capture: saved, gzip_field: { pointer: "/payload" },
    }, undefined, undefined, context(cwd)));
    assert.equal(decoded.read_ok, true);
    assert.deepEqual(decoded.provenance, { request_id: "gzip-grant" });
    assert.deepEqual(decoded.document.gzip_field, {
      pointer: "/payload", encoding: "base64+gzip", encoded_bytes: Buffer.byteLength(gzip.toString("base64")),
      compressed_bytes: gzip.length, decoded_bytes: Buffer.byteLength(payload), total_decoded_bytes: Buffer.byteLength(payload), max_decoded_bytes: 16 * 1024,
      start_byte: 0, next_start_byte: null, page_bytes: Buffer.byteLength(payload), eof: true,
      crc_verified: true, size_verified: true, text: payload,
    });
    assert.ok(decoded.capture.page_count > 1, "the saved JSON field spans granted artifact pages");
    assert.equal(resolutions, decoded.capture.page_count, "the saved field is decoded from its granted pages without a source reread");

    const expanded = Buffer.alloc(175_386, 0x61);
    let seed = 0x12345678;
    for (let index = 0; index < 30_055; index += 1) {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      expanded[index] = 0x20 + (seed % 95);
    }
    const expandedGzip = gzipSync(expanded);
    assert.equal(expandedGzip.length, 25_528, "the fixture matches the observed compressed size");
    assert.equal(expanded.length, 175_386, "the fixture matches the observed decoded size");
    const expandedSource = JSON.stringify({ payload: expandedGzip.toString("base64") });
    assert.ok(Buffer.byteLength(expandedSource) < 1024 * 1024, "the existing saved-JSON capture limit is unchanged");
    await writeFile(path, expandedSource, { mode: 0o600 });
    const resolutionsBeforeExpanded = resolutions;
    let startByte = 0;
    let pages = 0;
    let sourcePagesPerRead;
    const textPages = [];
    while (true) {
      const pageResult = value(await tool.execute(`capture-gzip-page-${pages}`, {
        saved_capture: processCapture({ document: expandedSource }),
        gzip_field: { pointer: "/payload", max_decoded_bytes: 256 * 1024, start_byte: startByte, max_bytes: 16 * 1024 },
      }, undefined, undefined, context(cwd)));
      assert.equal(pageResult.read_ok, true);
      assert.deepEqual(pageResult.provenance, { request_id: "gzip-grant" });
      const gzipPage = pageResult.document.gzip_field;
      assert.equal(gzipPage.total_decoded_bytes, 175_386);
      assert.equal(gzipPage.compressed_bytes, 25_528);
      assert.equal(gzipPage.crc_verified, true);
      assert.equal(gzipPage.size_verified, true);
      assert.equal(gzipPage.start_byte, startByte);
      assert.ok(gzipPage.page_bytes <= 16 * 1024);
      assert.equal(Buffer.byteLength(gzipPage.text), gzipPage.page_bytes);
      sourcePagesPerRead ??= pageResult.capture.page_count;
      assert.equal(pageResult.capture.page_count, sourcePagesPerRead);
      textPages.push(gzipPage.text);
      pages += 1;
      if (gzipPage.eof) {
        assert.equal(gzipPage.next_start_byte, null);
        break;
      }
      assert.ok(gzipPage.next_start_byte > startByte);
      startByte = gzipPage.next_start_byte;
    }
    assert.equal(pages, 11);
    assert.equal(resolutions - resolutionsBeforeExpanded, pages * sourcePagesPerRead);
    assert.deepEqual(Buffer.from(textPages.join(""), "utf8"), expanded, "re-reading the same field by byte cursor reconstructs the decoded payload");

    const unicodeBoundary = `${"x".repeat(16_383)}🙂tail`;
    const boundarySource = JSON.stringify({ payload: gzipSync(Buffer.from(unicodeBoundary)).toString("base64") });
    await writeFile(path, boundarySource, { mode: 0o600 });
    const firstBoundaryPage = value(await tool.execute("capture-gzip-utf8-page-1", {
      saved_capture: processCapture({ document: boundarySource }),
      gzip_field: { pointer: "/payload", max_decoded_bytes: 32 * 1024, max_bytes: 16 * 1024 },
    }, undefined, undefined, context(cwd)));
    assert.equal(firstBoundaryPage.document.gzip_field.page_bytes, 16_383);
    assert.equal(firstBoundaryPage.document.gzip_field.text, "x".repeat(16_383));
    const secondBoundaryPage = value(await tool.execute("capture-gzip-utf8-page-2", {
      saved_capture: processCapture({ document: boundarySource }),
      gzip_field: { pointer: "/payload", max_decoded_bytes: 32 * 1024, start_byte: 16_383, max_bytes: 16 * 1024 },
    }, undefined, undefined, context(cwd)));
    assert.equal(secondBoundaryPage.document.gzip_field.text, "🙂tail");
    assert.equal(secondBoundaryPage.document.gzip_field.eof, true);

    const controlText = "\0".repeat(16 * 1024);
    const controlSource = JSON.stringify({ payload: gzipSync(Buffer.from(controlText)).toString("base64") });
    await writeFile(path, controlSource, { mode: 0o600 });
    let controlStart = 0;
    const controlPages = [];
    while (true) {
      const controlPageResult = value(await tool.execute("capture-gzip-control-page", {
        saved_capture: processCapture({ document: controlSource }),
        gzip_field: { pointer: "/payload", max_decoded_bytes: 16 * 1024, start_byte: controlStart, max_bytes: 16 * 1024 },
      }, undefined, undefined, context(cwd)));
      assert.equal(controlPageResult.read_ok, true);
      assert.ok(Buffer.byteLength(JSON.stringify(controlPageResult)) <= 48 * 1024);
      const controlPage = controlPageResult.document.gzip_field;
      assert.ok(controlPage.page_bytes <= 16 * 1024);
      controlPages.push(controlPage.text);
      if (controlPage.eof) break;
      assert.equal(controlPage.page_limit_reached, "result_bytes");
      controlStart = controlPage.next_start_byte;
    }
    assert.equal(controlPages.join(""), controlText);

    await writeFile(path, boundarySource, { mode: 0o600 });
    const midCharacter = value(await tool.execute("capture-gzip-mid-character", {
      saved_capture: processCapture({ document: boundarySource }),
      gzip_field: { pointer: "/payload", max_decoded_bytes: 32 * 1024, start_byte: 16_384 },
    }, undefined, undefined, context(cwd)));
    assert.equal(midCharacter.decode_error.code, "GZIP_OFFSET_NOT_BOUNDARY");

    const corrupted = Buffer.from(gzip);
    corrupted[corrupted.length - 8] ^= 0xff;
    const corruptSource = JSON.stringify({ payload: corrupted.toString("base64") });
    await writeFile(path, corruptSource, { mode: 0o600 });
    const badCrc = value(await tool.execute("capture-gzip-crc", {
      saved_capture: processCapture({ document: corruptSource }), gzip_field: { pointer: "/payload" },
    }, undefined, undefined, context(cwd)));
    assert.equal(badCrc.read_ok, false);
    assert.equal(badCrc.stage, "field_decode");
    assert.equal(badCrc.decode_error.code, "GZIP_CRC_MISMATCH");
    assert.equal(badCrc.capture.saved_eof, true);

    const truncated = JSON.stringify({ payload: gzip.subarray(0, gzip.length - 2).toString("base64") });
    await writeFile(path, truncated, { mode: 0o600 });
    const badLength = value(await tool.execute("capture-gzip-truncated", {
      saved_capture: processCapture({ document: truncated }), gzip_field: { pointer: "/payload" },
    }, undefined, undefined, context(cwd)));
    assert.equal(badLength.read_ok, false);
    assert.equal(badLength.decode_error.code, "GZIP_TRUNCATED");

    const trailing = JSON.stringify({ payload: Buffer.concat([gzip, Buffer.from([0x00, 0x01])]).toString("base64") });
    await writeFile(path, trailing, { mode: 0o600 });
    const trailingData = value(await tool.execute("capture-gzip-trailing", {
      saved_capture: processCapture({ document: trailing }), gzip_field: { pointer: "/payload" },
    }, undefined, undefined, context(cwd)));
    assert.equal(trailingData.read_ok, false);
    assert.equal(trailingData.decode_error.code, "GZIP_TRAILING_DATA");

    const oversized = JSON.stringify({ payload: gzipSync(Buffer.alloc(16 * 1024 + 1, 0x61)).toString("base64") });
    await writeFile(path, oversized, { mode: 0o600 });
    const overLimit = value(await tool.execute("capture-gzip-limit", {
      saved_capture: processCapture({ document: oversized }), gzip_field: { pointer: "/payload" },
    }, undefined, undefined, context(cwd)));
    assert.equal(overLimit.read_ok, false);
    assert.equal(overLimit.decode_error.code, "GZIP_OUTPUT_TOO_LARGE");

    const atMaximum = JSON.stringify({ payload: gzipSync(Buffer.alloc(1024 * 1024, 0x61)).toString("base64") });
    assert.ok(Buffer.byteLength(atMaximum) < 1024 * 1024);
    await writeFile(path, atMaximum, { mode: 0o600 });
    const maximum = value(await tool.execute("capture-gzip-at-maximum", {
      saved_capture: processCapture({ document: atMaximum }),
      gzip_field: { pointer: "/payload", max_decoded_bytes: 1024 * 1024 },
    }, undefined, undefined, context(cwd)));
    assert.equal(maximum.read_ok, true);
    assert.equal(maximum.document.gzip_field.total_decoded_bytes, 1024 * 1024);
    assert.equal(maximum.document.gzip_field.page_bytes, 16 * 1024);
    assert.equal(maximum.document.gzip_field.eof, false);

    const beyondMaximum = JSON.stringify({ payload: gzipSync(Buffer.alloc(1024 * 1024 + 1, 0x61)).toString("base64") });
    assert.ok(Buffer.byteLength(beyondMaximum) < 1024 * 1024);
    await writeFile(path, beyondMaximum, { mode: 0o600 });
    const maximumLimit = value(await tool.execute("capture-gzip-maximum-limit", {
      saved_capture: processCapture({ document: beyondMaximum }),
      gzip_field: { pointer: "/payload", max_decoded_bytes: 1024 * 1024 },
    }, undefined, undefined, context(cwd)));
    assert.equal(maximumLimit.read_ok, false);
    assert.equal(maximumLimit.decode_error.code, "GZIP_OUTPUT_TOO_LARGE");

    const wrongSize = Buffer.from(gzip);
    wrongSize.writeUInt32LE(1, wrongSize.length - 4);
    const sizeSource = JSON.stringify({ payload: wrongSize.toString("base64") });
    await writeFile(path, sizeSource, { mode: 0o600 });
    const badSize = value(await tool.execute("capture-gzip-size", {
      saved_capture: processCapture({ document: sizeSource }), gzip_field: { pointer: "/payload" },
    }, undefined, undefined, context(cwd)));
    assert.equal(badSize.read_ok, false);
    assert.equal(badSize.decode_error.code, "GZIP_SIZE_MISMATCH");

    const invalidUtf8Source = JSON.stringify({ payload: gzipSync(Buffer.from([0xff])).toString("base64") });
    await writeFile(path, invalidUtf8Source, { mode: 0o600 });
    const invalidUtf8 = value(await tool.execute("capture-gzip-utf8", {
      saved_capture: processCapture({ document: invalidUtf8Source }), gzip_field: { pointer: "/payload" },
    }, undefined, undefined, context(cwd)));
    assert.equal(invalidUtf8.read_ok, false);
    assert.equal(invalidUtf8.decode_error.code, "INVALID_UTF8");

    const inputLimitSource = JSON.stringify({ payload: "A".repeat(512 * 1024 + 4) });
    assert.ok(Buffer.byteLength(inputLimitSource) < 1024 * 1024);
    await writeFile(path, inputLimitSource, { mode: 0o600 });
    const inputLimit = value(await tool.execute("capture-gzip-input-limit", {
      saved_capture: processCapture({ document: inputLimitSource }), gzip_field: { pointer: "/payload" },
    }, undefined, undefined, context(cwd)));
    assert.equal(inputLimit.read_ok, false);
    assert.equal(inputLimit.decode_error.code, "FIELD_INPUT_TOO_LARGE");
  });
});

test("codemode invokes the registered capture_read helper with a short script and no source query", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-codemode-capture-read-"));
  const artifactDirectory = join(root, "artifacts");
  await mkdir(artifactDirectory);
  const document = JSON.stringify({ source: "fixture", status: "ok", rows: [{ name: "api", value: 7 }] });
  await writeFile(join(artifactDirectory, ARTIFACT_ID), document, { mode: 0o600 });
  let session;
  t.after(async () => { session?.dispose(); await rm(root, { recursive: true, force: true }); });

  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false },
    defaultTools: ["+codemode"], codemode: { mode: "only" } });
  const captureTool = createCaptureReadTool({ resolveArtifact: async (id, stream, ctx) => {
    assert.equal(id, ARTIFACT_ID); assert.equal(stream, "stdout"); assert.equal(ctx.cwd, root);
    return { path: join(artifactDirectory, ARTIFACT_ID), provenance: { granted: true } };
  } });
  const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir: join(root, "agent"), settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: ["builtin:codemode"], systemPrompt: "", appendSystemPrompt: [],
    extensionFactories: [
      { name: "codemode", builtin: true, factory: createCodemodeExtension({ models: false }) },
      (pi) => pi.registerTool(captureTool),
    ],
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const provider = fauxProvider({ provider: "capture-read-short-call" });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
    allowModelNetwork: false, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(provider.provider);
  ({ session } = await createAgentSession({ cwd: root, agentDir: join(root, "agent"), resourceLoader, settingsManager,
    modelRuntime, sessionManager: SessionManager.inMemory(root), model: provider.getModel() }));
  await session.bindExtensions({ mode: "print", onError: (error) => { throw error; } });
  const saved = processCapture({ document });
  const code = `store("saved-query-envelope", JSON.parse(${JSON.stringify(JSON.stringify(saved))}));
    return await tools.capture_read({ saved_capture: load("saved-query-envelope"), project: { fields: { value: "/value" } } });`;
  provider.setResponses([
    (context) => fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);
  await session.prompt("Decode the already saved capture");
  const result = session.messages.findLast((message) => message.role === "toolResult" && message.toolName === "codemode");
  assert.ok(result);
  const output = JSON.parse(result.content.filter((item) => item.type === "text").at(-1).text);
  assert.equal(output.read_ok, true);
  assert.equal(output.document.rows.count, 1);
  assert.deepEqual(output.document.rows.projection.items, [{ value: 7 }]);
  assert.deepEqual(result.details.calls.map((call) => call.name), ["capture_read"], "no source query or model-copied page loop ran");
  assert.doesNotMatch(code, /artifact_read|JSON\.parse\(saved\.preview\)/);
});
