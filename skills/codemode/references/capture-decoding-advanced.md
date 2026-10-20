# Advanced saved-capture decoder

Use this reference only when a specialized bounded adapter needs raw JSONL text or a
transform that `capture_read` cannot express. For generic JSONL projection, grouping, or
record-by-record work, use `capture_read({ format: "jsonl" })` and continue with
`jsonl_page` cursors when needed. The default path stays `capture_read`; it returns only
bounded samples, projections, row pages, or grouped summaries. Never feed the default
`document.rows.sample` to a reducer that needs all rows; use explicit row pages instead.

This EOF/provenance decoder template reads the saved checkpoint only. A raw input route must
be available: either the envelope contains safe complete `stdout_text`, or the host
registers `artifact_read` with `codemode` exposure and approves the exact artifact grant.
Otherwise report that the raw route is unavailable. It does not run the source query.
Do not parse the envelope preview or framed stream preview.

The script exposes these variables at its final return point: `document` is the full
parsed JSON object, `rows` is the full array selected by the observed `rows_pointer`
(or an empty array when that pointer is not an array), `sourceText` is the complete
saved UTF-8 document text, `producerMetadata` is the selected metadata, `original`
contains process status/request/error evidence, `capture(savedEof)` returns the saved
capture summary, and `provenance` is the page-verified artifact provenance. Specialized
reducers can run before the final `return decoded;`, but only after `read_ok` is true
(the decoder reaches that return only on successful parse). JSONL reducers use
`sourceText`; row reducers use full `rows`, not the bounded sample.

For JSONL, branch after the saved-text paging loop reaches EOF but before the object
`JSON.parse(sourceText)` block. Call the bounded JSONL adapter on complete `sourceText`
and return its summary with `capture(true)` and verified `provenance`; do not run the
object decoder on line-oriented input or parse a prefix.

Keep this advanced template in an on-demand reference. Do not copy it into the skill's
default prompt or use it as a general raw-output tool.

```js
const MAX_CAPTURE_BYTES = 1024 * 1024;
const MAX_METADATA_CHARS = 8192;
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const utf8ByteLength = (text) => {
  let bytes = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
};
const unknownStatus = { process: "unknown", capture: "unknown", decode: "not_attempted", producer: "unknown" };
const saved = load("saved-query-envelope");
if (!isObject(saved)) return { status: unknownStatus, read_ok: false, stage: "store", error: "No saved process envelope" };
const details = saved.details;
if (!isObject(details)) return { status: unknownStatus, read_ok: false, stage: "envelope", error: "No process details" };

const processDetails = isObject(details.process) ? details.process : details;
const stdout = isObject(processDetails.stdout) ? processDetails.stdout : isObject(details.stdout) ? details.stdout : {};
const stderr = isObject(processDetails.stderr) ? processDetails.stderr : isObject(details.stderr) ? details.stderr : {};
const artifact = details.artifact ?? processDetails.artifact;
const processFailed = details.ok === false || saved.is_error === true
  || (typeof processDetails.exit_code === "number" && processDetails.exit_code !== 0)
  || processDetails.signal != null || processDetails.timed_out === true || processDetails.stop_reason != null;
const processSucceeded = details.ok === true && saved.is_error !== true && processDetails.exit_code === 0
  && processDetails.signal === null && processDetails.timed_out === false
  && processDetails.stop_reason === null && processDetails.cleanup === "complete";
const processOutcome = processFailed ? "failed" : processSucceeded ? "ok" : "unknown";
const captureReference = isObject(artifact) && typeof artifact.id === "string"
  ? {
      artifact_id: artifact.id,
      stdout: (typeof stdout.artifact === "string" && stdout.artifact.length > 0)
        || (typeof artifact.stdout_path === "string" && artifact.stdout_path.length > 0),
      stderr: (typeof stderr.artifact === "string" && stderr.artifact.length > 0)
        || (typeof artifact.stderr_path === "string" && artifact.stderr_path.length > 0),
    }
  : null;
const original = {
  status: {
    process: processOutcome,
    capture: stdout.capture ?? "unknown",
    decode: "not_attempted",
    producer: "unknown",
  },
  capture_ref: captureReference,
  process: {
    tool: details.tool ?? null,
    details_ok: details.ok === true,
    is_error: saved.is_error === true,
    exit_code: processDetails.exit_code ?? null,
    signal: processDetails.signal ?? null,
    timed_out: processDetails.timed_out ?? null,
    stop_reason: processDetails.stop_reason ?? null,
    cleanup: processDetails.cleanup ?? null,
    duration_ms: processDetails.duration_ms ?? null,
    stdout_capture: stdout.capture ?? null,
    stdout_preview: stdout.preview ?? null,
    stdout_captured_bytes: stdout.captured_raw_bytes ?? null,
    stderr_captured_bytes: stderr.captured_raw_bytes ?? null,
    envelope_preview_truncated: saved.preview_truncated === true,
  },
  ...(own(details, "request") ? { request: details.request } : {}),
  ...(own(details, "error") ? { query_error: details.error } : {}),
};
const fail = (stage, code, message, extra = {}) => ({
  ...original,
  ...extra,
  status: {
    ...original.status,
    decode: ["json_parse", "document_shape", "metadata_limit"].includes(stage) ? "failed" : "not_attempted",
    producer: "unknown",
  },
  read_ok: false,
  stage,
  decode_error: { code, message },
});

const rawSelection = load("saved-query-selection");
const selection = rawSelection === undefined ? {} : rawSelection;
const defaults = { source: "/source", status: "/status", time: "/time", coverage: "/coverage", row_count: "/row_count", truncated: "/truncated" };
const defaultFields = Object.keys(defaults);
if (!isObject(selection) || Object.keys(selection).some((key) => !["rows_pointer", "metadata_pointers", "identity_pointers"].includes(key))) {
  return fail("selection", "INVALID_SELECTION", "Selection must contain only rows_pointer, metadata_pointers, and identity_pointers");
}
const metadataOverrides = selection.metadata_pointers === undefined ? {} : selection.metadata_pointers;
if (!isObject(metadataOverrides)) return fail("selection", "INVALID_SELECTION", "metadata_pointers must be an object");
const identityOverrides = selection.identity_pointers === undefined ? null : selection.identity_pointers;
if (identityOverrides !== null && !isObject(identityOverrides)) return fail("selection", "INVALID_SELECTION", "identity_pointers must be an object");
const identityFields = identityOverrides === null ? [] : Object.keys(identityOverrides);
if ((identityOverrides !== null && identityFields.length === 0) || identityFields.length > 8
    || identityFields.some((key) => !/^[a-z][a-z0-9_]{0,63}$/.test(key))
    || identityFields.some((key) => typeof identityOverrides[key] !== "string" || identityOverrides[key].length > 512)) {
  return fail("selection", "INVALID_SELECTION", "Use at most eight lowercase identity fields with JSON Pointers of at most 512 characters");
}
const extraFields = Object.keys(metadataOverrides).filter((key) => !own(defaults, key));
if (Object.keys(metadataOverrides).some((key) => !/^[a-z][a-z0-9_]{0,63}$/.test(key)) || extraFields.length > 10) {
  return fail("selection", "INVALID_SELECTION", "Use at most ten additional lowercase metadata aliases of up to 64 characters");
}
const fields = [...defaultFields, ...extraFields];
const parsePointer = (pointer) => {
  if (typeof pointer !== "string" || pointer.length > 4096) throw new Error("A JSON Pointer must be a string of at most 4096 characters");
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) throw new Error("A JSON Pointer must be empty or start with /");
  return pointer.slice(1).split("/").map((part) => {
    if (/~(?![01])/.test(part)) throw new Error("A JSON Pointer has an invalid escape");
    return part.replace(/~1/g, "/").replace(/~0/g, "~");
  });
};
const getPointer = (root, parts) => {
  let value = root;
  for (const part of parts) {
    if (Array.isArray(value)) {
      if (!/^(0|[1-9][0-9]*)$/.test(part) || Number(part) >= value.length) return { found: false };
      value = value[Number(part)];
    } else if (isObject(value) && own(value, part)) value = value[part];
    else return { found: false };
  }
  return { found: true, value };
};
let rowsParts;
let effectiveMetadataPointers = {};
let metadataParts = {};
let identityParts = {};
try {
  rowsParts = parsePointer(own(selection, "rows_pointer") ? selection.rows_pointer : "/rows");
  for (const field of fields) {
    const pointer = own(metadataOverrides, field) ? metadataOverrides[field] : defaults[field];
    effectiveMetadataPointers[field] = pointer;
    metadataParts[field] = parsePointer(pointer);
  }
  for (const field of identityFields) identityParts[field] = parsePointer(identityOverrides[field]);
} catch (error) {
  return fail("selection", "INVALID_SELECTION", String(error));
}
const stdoutTextIsSafe = typeof saved.stdout_text === "string"
  && processDetails.stop_reason === null && processDetails.cleanup === "complete" && processDetails.timed_out === false
  && stdout.capture === "complete" && stdout.preview === "complete" && stdout.artifact === undefined
  && stdout.captured_raw_bytes === utf8ByteLength(saved.stdout_text)
  && stderr.capture === "complete" && stderr.preview === "complete" && stderr.artifact === undefined
  && processDetails.artifact === undefined && details.artifact === undefined;
if (captureReference === null && stdoutTextIsSafe) original.capture_ref = { source: "stdout_text" };
if (!stdoutTextIsSafe && (!isObject(artifact) || typeof artifact.id !== "string")) {
  return fail("artifact", "ARTIFACT_MISSING", "The saved envelope has no artifact ID");
}

let nextStartByte = 0;
let bytesRead = 0;
let totalBytes;
let pageCount = 0;
let sourceText = "";
let provenance;
let provenanceJson;
const capture = (savedEof = false) => ({
  state: original.process.stdout_capture,
  ...(stdoutTextIsSafe ? { source: "stdout_text" } : {}),
  saved_bytes: stdoutTextIsSafe ? null : totalBytes ?? null,
  bytes_read: bytesRead,
  page_count: pageCount,
  saved_eof: savedEof,
});
const readFailure = (code, message) => fail("artifact_read", code, message, {
  capture: capture(), ...(provenance === undefined ? {} : { provenance }),
});

if (stdoutTextIsSafe) {
  sourceText = saved.stdout_text;
  totalBytes = utf8ByteLength(sourceText);
  bytesRead = totalBytes;
} else {
  while (true) {
    let page;
    try {
      page = await tools.artifact_read({ artifact_id: artifact.id, stream: "stdout", mode: "bytes", encoding: "utf8", start_byte: nextStartByte, max_bytes: 40960 });
    } catch (error) {
      return readFailure("ARTIFACT_READ_FAILED", String(error));
    }
    if (!page || page.ok !== true) {
      const error = page && page.error ? page.error : { code: "INVALID_RESULT", message: "No artifact page" };
      return readFailure(error.code ?? "ARTIFACT_READ_FAILED", error.message ?? "artifact_read failed");
    }
    if (!page.page || typeof page.data !== "string") {
      return readFailure("INVALID_PAGE", "artifact_read returned an invalid page");
    }
    const meta = page.page;
    if (!Number.isSafeInteger(meta.total_bytes) || meta.total_bytes < 0 ||
        !Number.isSafeInteger(meta.start_byte) || !Number.isSafeInteger(meta.end_byte) ||
        meta.start_byte !== nextStartByte || meta.end_byte < nextStartByte || meta.end_byte > meta.total_bytes ||
        typeof meta.has_more !== "boolean") {
      return readFailure("INVALID_PAGE", "artifact_read returned invalid byte offsets");
    }
    const firstPage = pageCount === 0;
    bytesRead += meta.end_byte - meta.start_byte;
    pageCount += 1;
    if (totalBytes !== undefined && totalBytes !== meta.total_bytes) return readFailure("FILE_CHANGED", "Saved stream size changed between pages");
    totalBytes = meta.total_bytes;
    if (!isObject(page.provenance)) return readFailure("INVALID_PAGE", "artifact_read returned invalid provenance");
    const currentProvenance = JSON.stringify(page.provenance);
    if (firstPage) {
      provenance = page.provenance;
      provenanceJson = currentProvenance;
    } else if (currentProvenance !== provenanceJson) {
      return readFailure("PROVENANCE_CHANGED", "Artifact provenance changed between pages");
    }
    if (totalBytes > MAX_CAPTURE_BYTES) {
      return fail("size_limit", "CAPTURE_TOO_LARGE", "Saved capture exceeds the size limit", { capture: capture(), provenance });
    }
    sourceText += page.data;
    if (!meta.has_more) {
      if (meta.next_start_byte !== null || meta.end_byte !== totalBytes) return readFailure("INVALID_PAGE", "Final page did not reach saved-file EOF");
      nextStartByte = meta.end_byte;
      break;
    }
    if (!Number.isSafeInteger(meta.next_start_byte) || meta.next_start_byte <= nextStartByte || meta.next_start_byte !== meta.end_byte) {
      return readFailure("INVALID_PAGE", "Byte page has no valid numeric continuation");
    }
    nextStartByte = meta.next_start_byte;
  }
}

let document;
try {
  document = JSON.parse(sourceText);
} catch (error) {
  return fail("json_parse", "INVALID_JSON", String(error), { capture: capture(true), provenance });
}
if (!isObject(document)) return fail("document_shape", "INVALID_DOCUMENT", "Saved JSON is not an object", { capture: capture(true), provenance });
const producerMetadata = {};
const missingMetadata = [];
for (const field of fields) {
  const selected = getPointer(document, metadataParts[field]);
  if (selected.found) producerMetadata[field] = selected.value;
  else missingMetadata.push(field);
}
const metadataChars = JSON.stringify(producerMetadata).length;
if (metadataChars > MAX_METADATA_CHARS) {
  return fail("metadata_limit", "METADATA_TOO_LARGE", "Selected metadata exceeds its output limit", {
    capture: capture(true), provenance, metadata_chars: metadataChars, max_metadata_chars: MAX_METADATA_CHARS,
  });
}
const selectedRows = getPointer(document, rowsParts);
const rowsAreArray = selectedRows.found && Array.isArray(selectedRows.value);
const rowsType = !selectedRows.found ? "missing" : selectedRows.value === null ? "null" : Array.isArray(selectedRows.value) ? "array" : typeof selectedRows.value;
const rows = rowsAreArray ? selectedRows.value : [];
const rowSamples = [];
let rowSampleChars = 0;
if (identityOverrides === null) {
  for (const row of rows) {
    if (rowSamples.length >= 10) break;
    const encoded = JSON.stringify(row);
    if (typeof encoded !== "string" || encoded.length > 2048 || rowSampleChars + encoded.length > 12000) break;
    rowSamples.push(row);
    rowSampleChars += encoded.length;
  }
}
const projectIdentityValue = (value, depth = 0) => {
  if ((typeof value === "string" && value.length <= 256)
      || (typeof value === "number" && Number.isFinite(value)) || typeof value === "boolean") {
    return { ok: true, value };
  }
  if (depth >= 4) return { ok: false };
  if (Array.isArray(value) && value.length <= 16) {
    const children = value.map((child) => projectIdentityValue(child, depth + 1));
    return children.every((child) => child.ok)
      ? { ok: true, value: children.map((child) => child.value) } : { ok: false };
  }
  if (isObject(value) && Object.keys(value).length <= 16) {
    const entries = Object.entries(value).map(([key, child]) => [key, projectIdentityValue(child, depth + 1)]);
    return entries.every(([key, child]) => key.length <= 256 && child.ok)
      ? { ok: true, value: Object.fromEntries(entries.map(([key, child]) => [key, child.value])) } : { ok: false };
  }
  return { ok: false };
};
let identityProjection;
if (identityOverrides !== null) {
  const MAX_IDENTITY_ROWS = 200;
  const MAX_IDENTITY_CHARS = 12000;
  const items = [];
  let identityChars = 2;
  let missingRows = 0;
  let invalidRows = 0;
  let scanComplete = rowsAreArray;
  let limitReached = null;
  if (rowsAreArray) {
    for (const row of rows) {
      if (items.length >= MAX_IDENTITY_ROWS) {
        scanComplete = false;
        limitReached = "rows";
        break;
      }
      let identity = null;
      if (isObject(row)) {
        identity = {};
        for (const field of identityFields) {
          const selected = getPointer(row, identityParts[field]);
          const value = selected.found ? projectIdentityValue(selected.value) : { ok: false };
          const encoded = value.ok ? JSON.stringify(value.value) : undefined;
          identity[field] = value.ok && typeof encoded === "string" && encoded.length <= 2048 ? value.value : null;
        }
        if (Object.values(identity).some((value) => value === null)) missingRows += 1;
      } else invalidRows += 1;
      const encoded = JSON.stringify(identity);
      const nextChars = identityChars + (items.length === 0 ? 0 : 1) + encoded.length;
      if (nextChars > MAX_IDENTITY_CHARS) {
        scanComplete = false;
        limitReached = "output_chars";
        break;
      }
      items.push(identity);
      identityChars = nextChars;
    }
  }
  identityProjection = {
    fields: identityOverrides,
    row_count: rowsAreArray ? rows.length : null,
    shown_count: items.length,
    scan_complete: scanComplete,
    identities_complete: scanComplete && missingRows === 0 && invalidRows === 0,
    missing_rows: missingRows,
    invalid_rows: invalidRows,
    limit_reached: limitReached,
    items,
  };
}
const decoded = {
  ...original,
  status: {
    ...original.status,
    decode: "ok",
    producer: own(producerMetadata, "status") ? producerMetadata.status : "unknown",
  },
  read_ok: true,
  capture: capture(true),
  provenance,
  document: {
    selection: {
      rows_pointer: own(selection, "rows_pointer") ? selection.rows_pointer : "/rows",
      metadata_pointers: effectiveMetadataPointers,
      ...(identityOverrides === null ? {} : { identity_pointers: identityOverrides }),
    },
    producer_metadata: producerMetadata,
    missing_metadata: missingMetadata,
    rows: {
      state: !selectedRows.found ? "missing" : rowsAreArray ? "array" : "wrong_type",
      value_type: rowsType,
      count: rowsAreArray ? rows.length : null,
      shown: rowSamples.length,
      sample_incomplete: identityOverrides !== null ? null : rowsAreArray ? rowSamples.length < rows.length : null,
      sample: identityOverrides !== null ? null : rowsAreArray ? rowSamples : null,
      ...(identityProjection === undefined ? {} : { identity_projection: identityProjection }),
    },
  },
};
return decoded;
```
