---
name: codemode
description: Decodes saved process envelopes in codemode. Keeps process, capture, decode, and producer status separate.
---

# Decode a saved process capture in codemode

Use this skill only for a saved process envelope. Default `bash`, `git`, and `gh` results are not saved envelopes. `createCaptureReadTool` and `createArtifactReadTool` are host-only factories. The `agent-tools` extension does not register them. Do not assume that either reader is callable.

Before a capture read, check `ALL_TOOLS` for `capture_read`, then call `await describeTool("capture_read")`. Use the reader only when both show that it is callable; follow its declaration. Use a host-approved `artifact_read` route only for a specialized raw-data need the helper cannot express. Read the [advanced decoder](references/capture-decoding-advanced.md) for that route. Otherwise report the access limit.

Save a process envelope as a small checkpoint, not an evidence cache. Keep `details` unchanged, plus `is_error` and `preview_truncated`. Omit the success preview. Keep `stdout_text` only when no artifact is present; the decoder checks whether it is safe. On failure, keep `preview` only as opaque `failure_display` when no structured error or stderr artifact exists.

```js
const details = processEnvelope.details;
const process = details.process ?? details;
const stderr = process.stderr ?? details.stderr;
const artifact = details.artifact ?? process.artifact;
const hasArtifact = artifact !== undefined || typeof (process.stdout ?? details.stdout)?.artifact === "string";
const failed = processEnvelope.is_error === true || details.ok === false
  || (typeof process.exit_code === "number" && process.exit_code !== 0)
  || process.signal != null || process.timed_out === true || process.stop_reason != null;
const hasError = typeof details.error?.message === "string" && details.error.message.length > 0;
const hasStderr = (typeof stderr?.artifact === "string" && stderr.artifact.length > 0)
  || (typeof artifact?.stderr_path === "string" && artifact.stderr_path.length > 0);
store("saved-query-envelope", {
  details, is_error: processEnvelope.is_error, preview_truncated: processEnvelope.preview_truncated,
  ...(!hasArtifact && typeof processEnvelope.stdout_text === "string" ? { stdout_text: processEnvelope.stdout_text } : {}),
  ...(failed && !hasError && !hasStderr && typeof processEnvelope.preview === "string"
    ? { failure_display: processEnvelope.preview } : {}),
});
```

In a later codemode call, use the declared reader API. This default JSON call needs no selection:

```js
const listed = ALL_TOOLS.some(({ name }) => name === "capture_read");
const declared = listed ? await describeTool("capture_read") : undefined;
if (!declared) return { read_ok: false, error: "capture_read is not callable" };
const decoded = await tools.capture_read({ saved_capture: load("saved-query-envelope") });
if (!decoded.read_ok) return decoded;
store("saved-query-capture", decoded);
return decoded;
```

Keep `decoded.status.process`, `.capture`, `.decode`, and `.producer` separate. `details.ok` and `read_ok` do not prove process or producer success. A failed read is not an empty result. Use only observed JSON Pointers; do not guess its schema. Never parse envelope previews, framed stream previews, or `failure_display` as query data. Do not rerun a source query only because output or a preview is truncated.

Read [capture-decoding](references/capture-decoding.md) only for custom selections, projections, reductions, JSONL, gzip, limits, or detailed result interpretation. Read [store-state](references/store-state.md) only for store limits, cleanup, or recovery beyond the checkpoint above. Read [capture-reducers](references/capture-reducers.md) for specialized reducers, [consumer-search](references/consumer-search.md) for Kubernetes retained-capture searches, and [source-search](references/source-search.md) for source discovery.
