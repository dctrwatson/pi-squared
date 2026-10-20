import test from "node:test";
import assert from "node:assert/strict";
import { Check } from "typebox/value";
import {
  createProcessEnvelope,
  processEnvelopeOutputSchema,
} from "../../extensions/agent-tools/process-envelope.ts";

const MAX_ENVELOPE_BYTES = 48 * 1024;

test("process envelopes preserve success and nonzero process details", () => {
  const successDetails = {
    ok: true,
    tool: "git",
    exit_code: 0,
    signal: null,
    capture: { stdout: { state: "complete", captured_raw_bytes: 4 } },
    request: { args: ["status"], cwd: "/repo" },
  };
  const success = createProcessEnvelope("clean", successDetails, false);
  assert.deepEqual(success, {
    preview: "clean",
    details: successDetails,
    is_error: false,
    preview_truncated: false,
  });
  assert.equal(success.details, successDetails);
  assert.equal(Check(processEnvelopeOutputSchema, success), true);

  const failureDetails = {
    ok: true,
    tool: "gh",
    exit_code: 1,
    signal: null,
    timed_out: false,
    capture: { stderr: { state: "incomplete", saved_raw_bytes: 12 } },
    request: { args: ["pr", "view"], id: "request-1" },
  };
  const failure = createProcessEnvelope("not found", failureDetails, true);
  assert.deepEqual(failure.details, failureDetails);
  assert.equal(failure.is_error, true);
  assert.equal(failure.preview_truncated, false);
  assert.equal(Check(processEnvelopeOutputSchema, failure), true);
});

test("process envelope retains nested failure snapshots and error metadata", () => {
  const details = {
    ok: false,
    tool: "bash",
    error: { code: "ARTIFACT_FAILED", message: "capture write failed", request: { id: "req-2" } },
    process: {
      exit_code: null,
      signal: "SIGTERM",
      timed_out: false,
      duration_ms: 17,
      stop_reason: "artifact_failed",
      cleanup: "complete",
      stdout: { capture: "incomplete", artifact: { id: "a-1", unknown: [1, { value: true }] } },
    },
    extra: { retained: ["unknown", { nested: "value" }] },
  };
  const envelope = createProcessEnvelope("wrapper failure", details, true);

  assert.equal(envelope.details, details);
  assert.deepEqual(envelope.details, details);
  assert.equal(Check(processEnvelopeOutputSchema, envelope), true);
});

test("process envelope exposes bounded complete stdout outside its framed preview", () => {
  const stdoutText = JSON.stringify({ items: [{ name: "primary" }, { name: "secondary" }] });
  const details = {
    ok: true,
    tool: "pskube",
    exit_code: 0,
    signal: null,
    timed_out: false,
    stop_reason: null,
    cleanup: "complete",
    stdout: { capture: "complete", preview: "complete", captured_raw_bytes: Buffer.byteLength(stdoutText) },
    stderr: { capture: "complete", preview: "complete", captured_raw_bytes: 0 },
  };
  const framedPreview = `[pskube: ok]\n[stdout: preview_bytes=${stdoutText.length}]\n${"x".repeat(MAX_ENVELOPE_BYTES)}`;
  const envelope = createProcessEnvelope(framedPreview, details, false, stdoutText);

  assert.equal(envelope.stdout_text, stdoutText);
  assert.deepEqual(JSON.parse(envelope.stdout_text), { items: [{ name: "primary" }, { name: "secondary" }] });
  assert.equal(envelope.details, details);
  assert.equal(envelope.is_error, false);
  assert.equal(envelope.details.stdout.preview, "complete");
  assert.equal(envelope.preview_truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(envelope), "utf8") <= MAX_ENVELOPE_BYTES);
  assert.equal(Check(processEnvelopeOutputSchema, envelope), true);
});

test("process envelope preserves failure state and exposes safe stdout without changing details", () => {
  const stdoutText = JSON.stringify({ status: "partial", rows: [] });
  const details = {
    ok: false,
    tool: "pskube",
    error: { code: "COMMAND_FAILED", message: "reported a nonzero exit" },
    process: {
      exit_code: 7,
      signal: null,
      timed_out: false,
      stop_reason: null,
      cleanup: "complete",
      stdout: { capture: "complete", preview: "complete", captured_raw_bytes: Buffer.byteLength(stdoutText) },
      stderr: { capture: "complete", preview: "complete", captured_raw_bytes: 0 },
    },
  };
  const envelope = createProcessEnvelope("[pskube: exit_code=7]", details, true, stdoutText);

  assert.equal(envelope.is_error, true);
  assert.deepEqual(envelope.details, details);
  assert.deepEqual(JSON.parse(envelope.stdout_text), { status: "partial", rows: [] });
  assert.equal(envelope.details.process.exit_code, 7);
  assert.equal(envelope.details.error.code, "COMMAND_FAILED");
  assert.equal(Check(processEnvelopeOutputSchema, envelope), true);
});

test("process envelope omits raw stdout for unsafe process states or oversized JSON strings", () => {
  const stdoutText = "safe only when complete";
  const base = {
    ok: true,
    tool: "pskube",
    exit_code: 0,
    signal: null,
    timed_out: false,
    stop_reason: null,
    cleanup: "complete",
    stdout: { capture: "complete", preview: "complete", captured_raw_bytes: Buffer.byteLength(stdoutText) },
    stderr: { capture: "complete", preview: "complete", captured_raw_bytes: 0 },
  };
  const unsafe = [
    { ...base, stdout: { ...base.stdout, preview: "truncated" } },
    { ...base, stdout: { ...base.stdout, capture: "incomplete" } },
    { ...base, stdout: { ...base.stdout, artifact: "/saved/stdout" } },
    { ...base, stderr: { ...base.stderr, capture: "incomplete" } },
    { ...base, artifact: { id: "artifact" } },
    { ...base, timed_out: true, stop_reason: "timeout" },
  ];

  for (const details of unsafe) {
    const envelope = createProcessEnvelope("framed", details, true, stdoutText);
    assert.equal("stdout_text" in envelope, false);
    assert.equal(envelope.is_error, true);
    assert.deepEqual(envelope.details, details);
  }

  const oversizedText = "\0".repeat(MAX_ENVELOPE_BYTES);
  const oversized = createProcessEnvelope("framed", {
    ...base,
    stdout: { ...base.stdout, captured_raw_bytes: Buffer.byteLength(oversizedText) },
  }, false, oversizedText);
  assert.equal("stdout_text" in oversized, false);
  assert.equal(Check(processEnvelopeOutputSchema, oversized), true);
});

test("process envelope bounds JSON-escaped multibyte preview at Unicode boundaries", () => {
  const preview = (`é😀\\\"\n\u0000`).repeat(20_000);
  const envelope = createProcessEnvelope(preview, { ok: true, tool: "bash" }, false);

  assert.equal(envelope.preview_truncated, true);
  assert.ok(preview.startsWith(envelope.preview));
  assert.ok(envelope.preview.length < preview.length);
  assert.ok(Buffer.byteLength(JSON.stringify(envelope), "utf8") <= MAX_ENVELOPE_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify(envelope.preview), "utf8") > Buffer.byteLength(envelope.preview, "utf8"));
  assert.equal(/[\uD800-\uDBFF]$/u.test(envelope.preview), false);
  assert.equal(/[\uDC00-\uDFFF]$/u.test(envelope.preview), false);
  assert.equal(Check(processEnvelopeOutputSchema, envelope), true);
});

test("process envelope fails when metadata alone exceeds the JSON byte limit", () => {
  const details = { ok: false, tool: "gh", error: { code: "FAILED", message: "m".repeat(MAX_ENVELOPE_BYTES) } };

  assert.throws(
    () => createProcessEnvelope("preview", details, true),
    { name: "RangeError", message: "Process metadata exceeds the 48 KiB JSON envelope limit" },
  );
  assert.equal(details.error.message.length, MAX_ENVELOPE_BYTES);
});
