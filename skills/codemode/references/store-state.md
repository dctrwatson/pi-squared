# Keep codemode state small

Use `store()` for IDs, cursors, compact evidence, and capture references, not an
evidence cache. Pi permits 262,144 JSON characters per value and 1,048,576 characters
in total, including key text. These are hard limits, not useful size targets.
Compaction and session resume keep the values; they do not free space.

## Before saving

- Keep raw captures in existing granted artifacts. Decode and reduce data in script
  variables; do not store full arrays, schema snapshots, or duplicate previews.
- Aim for a few kilobytes per ordinary checkpoint. Measure a proposed write with
  `key.length + JSON.stringify(value).length`. A bounded reducer result can be larger
  when needed, but its per-value bound does not reserve total store space.
- Reuse named working keys when the previous result is no longer needed. For a
  comparison, retain only the required sides and compact supporting evidence.
- Keep source, exact selectors or queries, time bounds, process and producer status,
  capture and coverage limits, decisive facts, and contrary evidence. A small record
  is not permission to drop uncertainty or claim complete coverage.
- Keep the known working keys in the existing checkpoint or plan. Pi has no store
  key-list or total-size API. Do not invent one or print the whole store.

## Save a capture checkpoint

In the script that receives `processEnvelope`, save this checkpoint instead of the
whole envelope. Keep `details` unchanged: it contains request, status, stream capture
metadata, and artifact references. Omit presentation `preview` on success. Keep safe
`stdout_text` when no artifact is available; deleting the only complete text would
lose the capture. The [decoder](capture-decoding.md) checks its safety before use.

On failure, use process status, `details.ok === false`, or `is_error` to detect it.
`details.ok === true` does not prove process success. The unchanged `details` keeps
structured error text and any granted stderr artifact reference. If neither is
available, retain the bounded presentation as `failure_display`. Keep it opaque; do
not parse it as query data. Keep request, process, and capture status even when the
display is truncated.

```js
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const details = processEnvelope.details;
const status = details.process ?? details;
const stderr = status.stderr ?? details.stderr;
const artifact = details.artifact ?? status.artifact;
const failed = processEnvelope.is_error === true || details.ok === false
  || (typeof status.exit_code === "number" && status.exit_code !== 0)
  || status.signal != null || status.timed_out === true || status.stop_reason != null;
const hasStructuredError = isObject(details.error)
  && typeof details.error.message === "string" && details.error.message.length > 0;
const hasStderrReference = (isObject(stderr) && typeof stderr.artifact === "string" && stderr.artifact.length > 0)
  || (isObject(artifact) && typeof artifact.stderr_path === "string" && artifact.stderr_path.length > 0);
const checkpoint = {
  details,
  is_error: processEnvelope.is_error,
  preview_truncated: processEnvelope.preview_truncated,
  ...(!artifact && typeof processEnvelope.stdout_text === "string"
    ? { stdout_text: processEnvelope.stdout_text } : {}),
  ...(failed && !hasStructuredError && !hasStderrReference
    && typeof processEnvelope.preview === "string" && processEnvelope.preview.length > 0
    ? { failure_display: processEnvelope.preview } : {}),
};
store("saved-query-envelope", checkpoint);
```

After decoding, save compact evidence with status, coverage, and source references
in a successful call. Later calculations use that evidence. Retain a small capture
reference if further source checks are needed. Remove obsolete capture checkpoints
and selections only after their needed facts and recovery references are preserved.
For an artifactless capture, preserve any exact text still needed for follow-up.

## Cleanup and recovery

Run cleanup before new reads or large writes, not only after a limit error. Use exact
known keys and delete only obsolete state. For example, after saving the required
evidence and recovery references, and when no active decoder needs these keys:

```js
const obsoleteKeys = ["saved-query-envelope", "saved-query-selection"];
for (const key of obsoleteKeys) store(key, undefined);
return { deleted: obsoleteKeys };
```

Check that this cleanup call succeeds before continuing. Failed scripts commit no
store writes, including deletions; do not combine cleanup with a live read or a
large write that can fail. Deleting a key removes active state, not its historical
session entries or artifact files. It is not secret removal.

On a store limit, inspect the failed script's completed-call references and omission
counts. Calls already completed are not undone. Use existing granted captures;
do not repeat source queries to recover them. Reduce or replace obsolete state,
commit cleanup, then recover the compact result. If required evidence has no retained
capture and cannot fit, keep the last valid checkpoint and report the storage and
recovery gap. Do not silently discard decisive or contrary evidence to continue.

These are use instructions, not an automatic budget monitor or cleanup mechanism.
