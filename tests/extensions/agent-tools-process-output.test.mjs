import test from "node:test";
import assert from "node:assert/strict";

import {
  appendCapturedProcessStream,
  buildPreview,
  createCapturedProcessStream,
  DEFAULT_PROCESS_OUTPUT_BYTES,
  ProcessResultBudgetError,
  reserveProcessMetadataBytes,
  formatProcessFailure,
  formatProcessResult,
} from "../../extensions/agent-tools/process-output.ts";

const artifact = {
  id: "artifact",
  directory: "/tmp/artifact",
  stdout_path: "/tmp/artifact/stdout",
  stderr_path: "/tmp/artifact/stderr",
  metadata_path: "/tmp/artifact/metadata.json",
  expires_at: 1,
};

function capture(path, data) {
  const result = createCapturedProcessStream(path);
  appendCapturedProcessStream(result, Buffer.isBuffer(data) ? data : Buffer.from(data));
  return result;
}

const successStatus = { exit_code: 0, signal: null, timed_out: false, duration_ms: 7, stop_reason: null, cleanup: "complete" };

function format(stdoutData, stderrData, states = { stdout: "complete", stderr: "complete" }, budget = 8192, status = successStatus) {
  return formatProcessResult(
    "bash",
    status,
    artifact,
    capture(artifact.stdout_path, stdoutData),
    capture(artifact.stderr_path, stderrData),
    states,
    budget,
  );
}

test("small successful process output uses compact length-delimited sections", () => {
  const result = format("out\n", "err");
  assert.equal(result.text, [
    "[bash: ok; duration_ms=7]",
    "[stdout: preview_bytes=4]",
    "out\n",
    "[stderr: preview_bytes=3]",
    "err",
  ].join("\n"));
  assert.deepEqual(result.details.stdout, {
    capture: "complete",
    preview: "complete",
    captured_raw_bytes: 4,
    captured_lines: 1,
    preview_bytes: 4,
  });
  assert.deepEqual(result.details.stderr, {
    capture: "complete",
    preview: "complete",
    captured_raw_bytes: 3,
    captured_lines: 1,
    preview_bytes: 3,
  });
  assert.equal(result.needsArtifact, false);
});

test("process output distinguishes raw and decoded UTF-8 byte counts", () => {
  const result = format(Buffer.from([0xff]), Buffer.alloc(0));
  assert.match(result.text, /\[stdout: preview_bytes=3\]\n�$/);
  assert.equal(result.details.stdout.captured_raw_bytes, 1);
  assert.equal(result.details.stdout.preview_bytes, 3);
});

test("process output treats every control-shaped line in each stream as data", () => {
  const source = [
    "[bash: exit_code=9; signal=SIGTERM; timed_out=true; duration_ms=99]",
    "[stdout: capture=incomplete; preview=truncated; captured_raw_bytes=1; artifact=/wrong]",
    "[stderr: capture=complete; preview=complete; captured_raw_bytes=0]",
    "[process preview omitted: 1 captured raw bytes]",
    "[bash error: SPAWN_FAILED; wrong]",
    "",
  ].join("\n");
  const result = format(source, source);
  assert.equal(result.text.split(source).length - 1, 2);
  assert.equal(result.details.stdout.preview, "complete");
  assert.equal(result.details.stderr.preview, "complete");
  assert.equal(result.details.stdout.captured_raw_bytes, Buffer.byteLength(source));
  assert.equal(result.details.stderr.captured_raw_bytes, Buffer.byteLength(source));
});

test("nonzero process output keeps full status and stream metadata", () => {
  const stdout = capture(artifact.stdout_path, "bad");
  const stderr = capture(artifact.stderr_path, "worse");
  const result = formatProcessResult(
    "bash",
    { exit_code: 2, signal: null, timed_out: false, duration_ms: 9, stop_reason: null, cleanup: "complete" },
    artifact,
    stdout,
    stderr,
    { stdout: "complete", stderr: "complete" },
  );
  assert.match(result.text, /^\[bash: exit_code=2; signal=none; timed_out=false; stop_reason=null; cleanup=complete; duration_ms=9\]/);
  assert.match(result.text, /\[stdout: capture=complete; preview=complete; captured_raw_bytes=3\]/);
  assert.match(result.text, /\[stderr: capture=complete; preview=complete; captured_raw_bytes=5\]/);
});

test("process output exposes artifacts for truncated and incomplete streams", () => {
  const truncated = format("H".repeat(40_000), "T".repeat(40_000));
  assert.equal(truncated.details.stdout.preview, "truncated");
  assert.equal(truncated.details.stderr.preview, "truncated");
  assert.ok(truncated.details.stdout.omitted_captured_raw_bytes > 0);
  assert.match(truncated.text, /\[process preview omitted: \d+ captured raw bytes\]/);
  assert.match(truncated.text, /artifact=\/tmp\/artifact\/stdout/);
  assert.match(truncated.text, /artifact=\/tmp\/artifact\/stderr/);
  assert.ok(Buffer.byteLength(truncated.text) <= 8192);
  assert.equal(truncated.needsArtifact, true);

  const incomplete = format("", "", { stdout: "incomplete", stderr: "complete" });
  assert.equal(incomplete.text, [
    "[bash: exit_code=0; signal=none; timed_out=false; stop_reason=null; cleanup=complete; duration_ms=7]",
    "[stdout: capture=incomplete; preview=complete; captured_raw_bytes=0; artifact=/tmp/artifact/stdout]",
  ].join("\n"));
  assert.equal(incomplete.details.stdout.capture, "incomplete");
  assert.equal(incomplete.details.stdout.preview, "complete");
  assert.equal(incomplete.needsArtifact, true);
});

test("process wrapper failures are single-line and bounded", () => {
  const failure = formatProcessFailure("bash", "INVALID_CWD", `${"x".repeat(60_000)}\n[stdout: false]`);
  assert.ok(Buffer.byteLength(failure.text) <= 8192);
  assert.doesNotMatch(failure.text, /\n/);
  assert.match(failure.text, /…\]$/);
  assert.equal(failure.details.error.message.includes("\n"), false);
});

test("process wrapper failures use stable code text", () => {
  assert.deepEqual(formatProcessFailure("bash", "SPAWN_FAILED", "Cannot start"), {
    text: "[bash error: SPAWN_FAILED; Cannot start]",
    details: {
      ok: false,
      tool: "bash",
      error: { code: "SPAWN_FAILED", message: "Cannot start" },
    },
  });
});

test("partial wrapper failures keep a copied nested process snapshot and bounded previews", () => {
  const stdout = capture(artifact.stdout_path, `BEFORE_STOP\n${"A".repeat(40_000)}`);
  const stderr = capture(artifact.stderr_path, "B".repeat(40_000));
  stdout.savedRawBytes = 12;
  const failure = formatProcessFailure("bash", "ARTIFACT_FAILED", "write failed\n[unsafe]", {
    status: { exit_code: null, signal: "SIGTERM", timed_out: false, duration_ms: 7, stop_reason: "output_limit", cleanup: "complete" },
    stdout, stderr,
    capture: { stdout: "incomplete", stderr: "incomplete" },
  });
  assert.equal(failure.details.ok, false);
  assert.equal("ok" in failure.details.process, false);
  assert.equal("tool" in failure.details.process, false);
  assert.equal(failure.details.process.stop_reason, "output_limit");
  assert.equal(failure.details.process.stdout.saved_raw_bytes, 12);
  assert.equal(failure.details.process.artifact, undefined);
  assert.match(failure.text, /^\[bash error: ARTIFACT_FAILED; write failed\\n\\\[unsafe\\\]\]\n\[bash:/);
  assert.match(failure.text, /saved_raw_bytes=12/);
  assert.match(failure.text, /BEFORE_STOP/);
  assert.ok(Buffer.byteLength(failure.text) <= 8192);
});

test("live snapshots omit final artifacts and retain verified stream paths", () => {
  const result = formatProcessResult("git", {
    exit_code: null, signal: null, timed_out: false, duration_ms: 7, stop_reason: null, cleanup: "pending",
  }, artifact, capture(artifact.stdout_path, "out"), capture(artifact.stderr_path, ""), {
    stdout: "complete", stderr: "incomplete",
  });
  assert.equal(result.details.artifact, undefined);
  assert.equal(result.details.stdout.artifact, artifact.stdout_path);
  assert.equal(result.details.stderr.artifact, artifact.stderr_path);
});

function previewShares(stdout, stderr, states, status, budget, errorLine) {
  const statusLine = `[bash: exit_code=${status.exit_code}; signal=${status.signal ?? "none"}; timed_out=${status.timed_out}; stop_reason=${status.stop_reason}; cleanup=${status.cleanup}; duration_ms=${status.duration_ms}]`;
  const header = (name, stream, state) => `[${name}: capture=${state}; preview=truncated; captured_raw_bytes=${stream.totalBytes}${stream.savedRawBytes !== undefined ? `; saved_raw_bytes=${stream.savedRawBytes}` : ""}; artifact=${stream.path}]`;
  const sections = [errorLine, statusLine].filter((part) => part !== undefined);
  if (stdout.totalBytes > 0 || states.stdout === "incomplete") sections.push(header("stdout", stdout, states.stdout));
  if (stderr.totalBytes > 0 || states.stderr === "incomplete") sections.push(header("stderr", stderr, states.stderr));
  const available = budget - Buffer.byteLength(sections.join("\n")) - Number(stdout.totalBytes > 0) - Number(stderr.totalBytes > 0);
  let out = stdout.totalBytes > 0 ? (stderr.totalBytes > 0 ? Math.ceil(available / 2) : available) : 0;
  let err = stderr.totalBytes > 0 ? (stdout.totalBytes > 0 ? Math.floor(available / 2) : available) : 0;
  const outFull = stdout.totalBytes <= stdout.head.length ? Buffer.byteLength(stdout.head.toString("utf8")) : Infinity;
  const errFull = stderr.totalBytes <= stderr.head.length ? Buffer.byteLength(stderr.head.toString("utf8")) : Infinity;
  if (stdout.totalBytes > 0 && stderr.totalBytes > 0) {
    if (outFull <= out && errFull > err) { err += out - outFull; out = outFull; }
    else if (errFull <= err && outFull > out) { out += err - errFull; err = errFull; }
  }
  return { stdout: out, stderr: err };
}

function assertFragmentShares(details, share, unsuccessful, ascii = true) {
  const markerBytes = Buffer.byteLength(`[process preview omitted: ${details.captured_raw_bytes} captured raw bytes]`);
  const source = Math.max(0, share - markerBytes - 2);
  const head = unsuccessful ? Math.floor(source / 3) : Math.floor(source / 2);
  const tail = source - head;
  if (ascii) {
    assert.equal(details.head_preview_bytes, head);
    assert.equal(details.tail_preview_bytes, tail);
    assert.equal(details.omitted_captured_raw_bytes, details.captured_raw_bytes - head - tail);
  } else {
    assert.ok(details.head_preview_bytes <= head);
    assert.ok(details.tail_preview_bytes <= tail);
  }
  assert.ok(details.preview_bytes <= share);
}

for (const budget of [2048, 8192, 40960]) {
  for (const unsuccessful of [false, true]) {
    test(`whole process text and exact ASCII fragment shares fit ${budget} bytes on ${unsuccessful ? "failure" : "success"}`, () => {
      const stdout = capture(artifact.stdout_path, `OUT_HEAD\n${"A".repeat(60000)}\nOUT_TAIL\n`);
      const stderr = capture(artifact.stderr_path, `ERR_HEAD\n${"B".repeat(60000)}\nERR_TAIL\n`);
      const states = { stdout: "complete", stderr: "complete" };
      const status = { ...successStatus, exit_code: unsuccessful ? 1 : 0 };
      const result = formatProcessResult("bash", status, artifact, stdout, stderr, states, budget);
      const shares = previewShares(stdout, stderr, states, status, budget);
      assertFragmentShares(result.details.stdout, shares.stdout, unsuccessful);
      assertFragmentShares(result.details.stderr, shares.stderr, unsuccessful);
      assert.ok(Buffer.byteLength(result.text) <= budget);
      assert.match(result.text, /OUT_HEAD/);
      assert.match(result.text, /OUT_TAIL/);
      assert.match(result.text, /ERR_HEAD/);
      assert.match(result.text, /ERR_TAIL/);
      assert.doesNotMatch(result.text, /head_preview_bytes=|tail_preview_bytes=|captured_lines=/);
      if (unsuccessful) {
        assert.ok(result.details.stdout.tail_preview_bytes >= 2 * result.details.stdout.head_preview_bytes);
        assert.ok(result.details.stderr.tail_preview_bytes >= 2 * result.details.stderr.head_preview_bytes);
      }
    });
  }

  for (const smallStream of ["stdout", "stderr"]) {
    test(`${budget}-byte allocation transfers unused ${smallStream} source space once`, () => {
      const stdout = capture(artifact.stdout_path, smallStream === "stdout" ? "small\n" : "A".repeat(60000));
      const stderr = capture(artifact.stderr_path, smallStream === "stderr" ? "small\n" : "B".repeat(60000));
      const states = { stdout: "complete", stderr: "complete" };
      const result = formatProcessResult("bash", successStatus, artifact, stdout, stderr, states, budget);
      const shares = previewShares(stdout, stderr, states, successStatus, budget);
      const largeStream = smallStream === "stdout" ? "stderr" : "stdout";
      assert.equal(result.details[smallStream].preview, "complete");
      assert.equal(result.details[smallStream].preview_bytes, 6);
      assertFragmentShares(result.details[largeStream], shares[largeStream], false);
      assert.ok(Buffer.byteLength(result.text) <= budget);
    });
  }

  test(`${budget}-byte multibyte previews preserve code points and display shares`, () => {
    const stdout = capture(artifact.stdout_path, `OUT_HEAD\n${"é😀".repeat(16000)}\nOUT_TAIL\n`);
    const stderr = capture(artifact.stderr_path, `ERR_HEAD\n${"β😀".repeat(16000)}\nERR_TAIL\n`);
    const status = { ...successStatus, exit_code: 7 };
    const states = { stdout: "complete", stderr: "complete" };
    const result = formatProcessResult("bash", status, artifact, stdout, stderr, states, budget);
    const shares = previewShares(stdout, stderr, states, status, budget);
    assertFragmentShares(result.details.stdout, shares.stdout, true, false);
    assertFragmentShares(result.details.stderr, shares.stderr, true, false);
    assert.doesNotMatch(result.text, /�/);
    assert.ok(Buffer.byteLength(result.text) <= budget);
  });

  test(`${budget}-byte wrapper previews include errors, saved counts, and paths in the total`, () => {
    const stdout = capture(artifact.stdout_path, `OUT_HEAD\n${"A".repeat(60000)}\nOUT_TAIL\n`);
    const stderr = capture(artifact.stderr_path, `ERR_HEAD\n${"B".repeat(60000)}\nERR_TAIL\n`);
    stdout.savedRawBytes = 12;
    const status = { ...successStatus, exit_code: null, signal: "SIGTERM", stop_reason: "artifact_failed" };
    const states = { stdout: "incomplete", stderr: "incomplete" };
    const failure = formatProcessFailure("bash", "ARTIFACT_FAILED", "unsafe\n[message]".repeat(200), {
      status, stdout, stderr, capture: states,
    }, budget);
    const errorLine = failure.text.split("\n")[0];
    const shares = previewShares(stdout, stderr, states, status, budget, errorLine);
    assertFragmentShares(failure.details.process.stdout, shares.stdout, true);
    assertFragmentShares(failure.details.process.stderr, shares.stderr, true);
    assert.ok(Buffer.byteLength(failure.details.error.message) <= 512);
    assert.ok(Buffer.byteLength(failure.text) <= budget);
    assert.match(failure.text, /saved_raw_bytes=12/);
    assert.equal(failure.details.process.stdout.artifact, artifact.stdout_path);
  });

  test(`${budget}-byte previews decode malformed bytes but count raw omissions`, () => {
    const raw = Buffer.concat(Array.from({ length: 12000 }, () => Buffer.from([0xff, 0xfe, 0x61])));
    const result = format(raw, Buffer.alloc(0), undefined, budget);
    assert.equal(result.details.stdout.captured_raw_bytes, raw.length);
    assert.ok(result.details.stdout.preview_bytes <= budget);
    assert.ok(Buffer.byteLength(result.text) <= budget);
    assert.match(result.text, /�/);
    const headBytes = result.details.stdout.head_preview_bytes;
    const tailBytes = result.details.stdout.tail_preview_bytes;
    assert.ok([0, 3, 6].includes(headBytes % 7));
    assert.ok([0, 1, 4].includes(tailBytes % 7));
    const headRaw = Math.floor(headBytes / 7) * 3 + (headBytes % 7) / 3;
    const tailRaw = Math.floor(tailBytes / 7) * 3 + (tailBytes % 7 === 1 ? 1 : tailBytes % 7 === 4 ? 2 : 0);
    assert.equal(result.details.stdout.omitted_captured_raw_bytes, raw.length - headRaw - tailRaw);
    assert.equal(raw[0], 0xff);
  });
}

test("the default budget is 8192 and counts compact headers before source", () => {
  assert.equal(DEFAULT_PROCESS_OUTPUT_BYTES, 8192);
  const budget = 2048;
  let count = budget;
  while (count + Buffer.byteLength(`[bash: ok; duration_ms=7]\n[stdout: preview_bytes=${count}]\n`) > budget) count -= 1;
  const exact = format("A".repeat(count), "", undefined, budget);
  assert.equal(Buffer.byteLength(exact.text), budget);
  assert.equal(exact.details.stdout.preview, "complete");
  assert.doesNotMatch(exact.text, /stderr:/);
  const next = format("A".repeat(count + 1), "", undefined, budget);
  assert.equal(next.details.stdout.preview, "truncated");
  assert.equal(next.needsArtifact, true);
  assert.ok(Buffer.byteLength(next.text) <= budget);
});

test("empty complete streams do not consume source shares; empty incomplete streams keep headings", () => {
  for (const stdoutState of ["complete", "incomplete"]) {
    const stdout = capture(artifact.stdout_path, "");
    const stderr = capture(artifact.stderr_path, "B".repeat(60000));
    const states = { stdout: stdoutState, stderr: "complete" };
    const result = formatProcessResult("bash", successStatus, artifact, stdout, stderr, states, 2048);
    const shares = previewShares(stdout, stderr, states, successStatus, 2048);
    assertFragmentShares(result.details.stderr, shares.stderr, false);
    assert.equal(result.details.stdout.preview_bytes, 0);
    assert.equal(result.text.includes("[stdout:"), stdoutState === "incomplete");
    assert.ok(Buffer.byteLength(result.text) <= 2048);
  }
});

test("a source share too small for its marker has no source preview", () => {
  const stream = capture(artifact.stdout_path, "A".repeat(1000));
  const result = buildPreview(stream, "incomplete", 20, true);
  assert.equal(result.text, "");
  assert.equal(result.details.preview, "truncated");
  assert.equal(result.details.omitted_captured_raw_bytes, 1000);
  assert.equal(result.details.artifact, artifact.stdout_path);
});

test("preflight reserves status bounds, both full paths, and 512 error bytes", () => {
  const reserved = reserveProcessMetadataBytes("bash", artifact);
  assert.ok(reserved < 2048);
  const long = { ...artifact, stdout_path: "x".repeat(3000), stderr_path: "y".repeat(3000) };
  assert.ok(reserveProcessMetadataBytes("bash", long) > 2048);
  assert.equal(reserveProcessMetadataBytes("bash", long) - reserved,
    Buffer.byteLength(long.stdout_path + long.stderr_path) - Buffer.byteLength(artifact.stdout_path + artifact.stderr_path));
  const status = { ...successStatus, exit_code: -2147483648, signal: "S".repeat(32), duration_ms: Number.MAX_SAFE_INTEGER, stop_reason: "artifact_failed" };
  const stdout = capture(artifact.stdout_path, "A".repeat(60000));
  const stderr = capture(artifact.stderr_path, "B".repeat(60000));
  stdout.savedRawBytes = 67108864;
  stderr.savedRawBytes = 67108864;
  const result = formatProcessFailure("bash", "RESULT_BUDGET_TOO_SMALL", "x".repeat(512), {
    status, stdout, stderr, capture: { stdout: "incomplete", stderr: "incomplete" },
  }, 2048);
  assert.ok(Buffer.byteLength(result.text) <= 2048);
  assert.equal(result.details.error.message.length, 512);
});

test("unexpected metadata overflow keeps copied evidence and states that execution occurred", () => {
  const stdout = capture(artifact.stdout_path, "BEFORE_FORMAT\n");
  const stderr = capture(artifact.stderr_path, "");
  const status = { ...successStatus, signal: "S".repeat(3000), exit_code: null };
  assert.throws(() => formatProcessResult("bash", status, artifact, stdout, stderr, {
    stdout: "complete", stderr: "complete",
  }, 2048), ProcessResultBudgetError);
  const result = formatProcessFailure("bash", "CAPTURE_FAILED", "cause", {
    status, artifact, stdout, stderr, capture: { stdout: "complete", stderr: "complete" },
  }, 2048);
  assert.equal(result.details.error.code, "RESULT_BUDGET_TOO_SMALL");
  assert.match(result.text, /The process did run/);
  assert.ok(Buffer.byteLength(result.text) <= 2048);
  assert.equal(result.details.process.stdout.artifact, artifact.stdout_path);
  assert.equal(result.details.process.stdout.captured_raw_bytes, 14);
  assert.notEqual(result.details.process.artifact, artifact);
});

test("live unknown status uses balanced shares and a known cancellation favors the tail", () => {
  const stdout = capture(artifact.stdout_path, "A".repeat(60000));
  const stderr = capture(artifact.stderr_path, "B".repeat(60000));
  const states = { stdout: "incomplete", stderr: "incomplete" };
  for (const stop_reason of [null, "cancelled"]) {
    const status = { ...successStatus, exit_code: null, cleanup: "pending", stop_reason };
    const result = formatProcessResult("bash", status, artifact, stdout, stderr, states, 2048);
    const shares = previewShares(stdout, stderr, states, status, 2048);
    assertFragmentShares(result.details.stdout, shares.stdout, stop_reason !== null);
    assertFragmentShares(result.details.stderr, shares.stderr, stop_reason !== null);
    assert.equal(result.details.artifact, undefined);
  }
});

test("the whole-result formatter rejects budgets outside the integer contract", () => {
  for (const budget of [2047, 40961, 2048.5, "8192", NaN, Infinity]) {
    assert.throws(() => format("data", "", undefined, budget), ProcessResultBudgetError);
    assert.throws(() => formatProcessFailure("bash", "CAPTURE_FAILED", "cause", undefined, budget), ProcessResultBudgetError);
  }
});
