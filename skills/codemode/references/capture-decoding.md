# Decode a saved process capture

Use `capture_read` by default when the host registers it. It reads safe complete
`stdout_text` or a host-granted stdout artifact and returns bounded metadata,
projections, and grouped summaries. It does not run the source query. Keep process
status, capture state, decode status, and producer status separate. Use
`format: "jsonl"` for line-delimited JSON; the callable reader handles split lines and
nested JSON fields. Save a small envelope checkpoint as described in the skill; read
[store-state.md](store-state.md) only for store limits, cleanup, or recovery. Use the
[advanced decoder](capture-decoding-advanced.md) only when a specialized bounded reducer
needs raw JSONL text or a transform that row pages and projections cannot express, and
only when safe complete `stdout_text` or a host-approved `artifact_read` route exists.

## Short invocation

Set `saved-query-selection` only after inspecting the saved JSON document or its
producer schema. JSON Pointers must match observed fields. Then call:

```js
const decoded = await tools.capture_read({
  saved_capture: load("saved-query-envelope"),
  selection: load("saved-query-selection"),
  project: { fields: { time: "/timestamp", value: "/value" }, limit: 100 },
  // Use /metric only if that observed value contains both metric name and unit.
  reduce: { group_pointer: "/metric", value_pointer: "/value", time_pointer: "/timestamp" },
});
if (!decoded.read_ok) return decoded;
store("saved-query-capture", decoded);
return decoded;
```

Keep plain decoder output under `saved-query-capture`; reserve `saved-query-evidence`
for specialized reducer results.

Omit `project` or `reduce` when they are not needed. A projection returns only the
selected fields. A reduction groups exact bounded values and, when `value_pointer` is
set, returns count, sum, minimum, maximum, and `positive_count`. An optional
`time_pointer` accepts finite numeric timestamps or ISO date-times with `Z` or a
numeric `±HH:MM` offset and up to nine fractional-second digits. `first_time` and
`last_time` return observed values in timestamp order, not row order. Numeric timestamps
are compared as given; no unit conversion occurs. Use one timestamp type per group.
Invalid, missing, or mixed-type timestamps increment `invalid_times` and make
`groups_complete` false. A group with invalid times gets null time bounds; incomplete
scans also suppress time bounds. If a scanned row cannot be assigned a bounded group
identity, the reducer sets `groups_complete` false and suppresses every group rather
than returning totals for only the assignable rows. Invalid values make the reduction
incomplete; check its counters before use. Group by an observed metric/unit identity,
such as an object containing both, to avoid cross-unit totals. Reductions scan up to
100,000 rows independently of the 200-row projection limit. Keep request, process
status, producer metadata, capture state, and provenance with the reduced facts.

## JSONL entry point

Set `format: "jsonl"` when the saved stdout is line-delimited JSON. `selection` is not
used in this mode. `project` and `reduce` use JSON Pointers relative to each parsed
record, so nested fields do not need a custom paging loop:

```js
const decoded = await tools.capture_read({
  saved_capture: load("saved-query-envelope"),
  format: "jsonl",
  project: { fields: { time: "/time", caller: "/labels/caller" }, limit: 100 },
  reduce: { group_pointer: "/labels/caller", value_pointer: "/duration_ms" },
});
if (!decoded.read_ok) return decoded;
store("saved-query-capture", decoded);
return decoded;
```

The JSON path keeps its 1-MiB capture limit. JSONL uses a separate 8-MiB byte cap, a
256-KiB line cap, and a 100,000-record cap. Pages keep UTF-8 code points whole. The
reader checks page offsets, saved EOF, file size, and provenance before it accepts the
result. It does not raise the artifact, state, loader, or output limits. `read_ok` and
`document.jsonl.records_complete` describe the saved-record scan, not producer completeness.
The source `capture.state` and `status.producer` remain separate; an incomplete capture can
reach saved EOF, and JSONL keeps producer status `unknown` unless a separate producer contract exists.

`document.jsonl.byte_scan_complete` reports whether the saved artifact reached EOF.
`records_complete` is false for a byte, line, record, or parse limit. `errors` reports at
most ten malformed or non-object records; `errors_omitted` reports more errors. A failed
`read_ok` can include parsed records, but they are partial evidence. Check
`decode_error`, `document.jsonl`, `capture.saved_eof`, and `provenance`; do not treat a
prefix or malformed input as a complete result. An incomplete source capture can reach
saved EOF and still remain incomplete. A projection has separate `scan_complete`,
`fields_complete`, and `limit_reached` fields. `fields_complete` covers the shown items;
`scan_complete` means all records were considered. `document.jsonl.limit_reached` describes
the source scan; a projection may hit its own row or output limit first. Check both before
you use projected rows as complete evidence.

Use `jsonl_page: { start_byte?, max_records? }` when a caller needs each saved record rather than the default ten-row sample. The default cursor is 0, and `max_records` is 1–200. A page returns unprojected records in `document.rows.sample`, or selected fields in `document.rows.projection.items` when combined with `project.fields`. Page rows keep the 2,048-character per-row and 12,000-character aggregate sample limits, plus a 12,000-byte UTF-8 page-data budget. If that byte budget is reached, `limit_reached: "result_bytes"` leaves the next record at the cursor. Page projections allow selected strings up to 2,048 characters and an encoded field map up to 8 KiB total; the normal full-scan projection keeps its 256-character string limit. Unrelated source padding does not affect projected fields when the record fits the 256-KiB line cap. Each row-page call scans at most 8 MiB, the existing JSONL scan budget. Continue from its cursor when the page stops at a newline boundary; if one record spans the full budget before a newline, `read_ok` is false because no safe cursor can advance. `max_records` is per call, so callers must enforce any aggregate row ceiling across calls. The 100,000-record cap applies to full scans. `reduce` is not valid with a row page.

`document.jsonl_page.next_start_byte` is the next byte cursor, including at EOF. Pass it as the next `start_byte`. A cursor must be 0, EOF, or immediately after a newline. `eof` reports that the cursor reached saved-file EOF; `complete` is true only when the page starts at byte 0, reaches EOF, and has no errors or gaps. Pages that start later cannot claim global coverage. A normal continuation can have `read_ok: true` while `eof` is false, so follow the cursor rather than treating `read_ok` as whole-file completion. In projected pages, missing or unbounded selected fields set `fields_complete: false` and `read_ok: false`; scripts must reject those rows. `complete` describes source-record coverage, not projection completeness. A record that exceeds the page row limit is reported in `gaps` and skipped to its next cursor; other unreturned records stay at the cursor for the next call. Page errors include absolute byte offsets and page-relative line numbers. Check `errors`, `gaps`, `next_start_byte`, and `eof` on every page. Continue until EOF, and do not claim complete coverage if any page has a gap or error. Each call uses the host artifact grant and reads only the saved capture; it does not run the source query.

## Decode one saved compressed field

Use `gzip_field` only for a base64-encoded gzip string in the already granted saved JSON
document. It does not read another artifact or rerun the source:

```js
const decoded = await tools.capture_read({
  saved_capture: load("saved-query-envelope"),
  gzip_field: {
    pointer: "/payload/compressed",
    max_decoded_bytes: 256 * 1024,
    start_byte: 0,
    max_bytes: 16 * 1024,
  },
});
if (!decoded.read_ok) return decoded;
const page = decoded.document.gzip_field;
return {
  text: page.text,
  total_decoded_bytes: page.total_decoded_bytes,
  start_byte: page.start_byte,
  next_start_byte: page.next_start_byte,
  eof: page.eof,
  crc_verified: page.crc_verified,
  provenance: decoded.provenance,
};
```

The pointer must match an observed string field. Base64 must be canonical and padded.
The input limit is 512 KiB. By default the decoded-size ceiling and page size remain 16 KiB,
so small fields keep the existing one-call behavior. Set `max_decoded_bytes` to raise only
this field's ceiling, up to the existing 1-MiB capture limit. `max_bytes` selects a UTF-8
byte page up to 16 KiB; `start_byte` is zero-based and must be a code-point boundary. For
the next page, repeat the same saved capture, pointer, and limits, and set `start_byte` to
the previous `next_start_byte`. Continue until `eof` is true. The result reports
`total_decoded_bytes` (also `decoded_bytes`), page byte offsets, `page_bytes`, EOF, CRC and
size checks, and the same artifact provenance. A page can be shortened to fit the 48-KiB
result budget; `page_limit_reached: "result_bytes"` identifies that case. Each call reads
the same saved capture and re-decodes the selected field; it does not rerun the source
query. The 1-MiB JSON capture limit and 48-KiB result limit do not change. Invalid
base64, corrupt or truncated gzip, an expansion over the selected ceiling, trailing bytes,
an invalid page offset, and invalid UTF-8 return explicit `field_decode` errors.

## Selection and completeness

Selection keys are `rows_pointer`, `metadata_pointers`, and `identity_pointers`.
`rows_pointer` defaults to `/rows`. Row and metadata pointers are JSON Pointers of at
most 4,096 characters. The six default metadata aliases map `source`, `status`, `time`,
`coverage`, `row_count`, and `truncated` to the matching root fields. `metadata_pointers`
overlays these defaults and can add up to ten aliases (16 total). Alias keys match
`[a-z][a-z0-9_]{0,63}`. All selected metadata together is limited to 8,192 characters;
an oversized selection fails rather than dropping fields.

`identity_pointers` accepts one to eight lowercase aliases (matching
`[a-z][a-z0-9_]{0,63}`) with JSON Pointers of at most 512 characters relative to each
row. It returns at most 200 identities and 12,000 characters. Values are null, boolean,
finite numbers, strings of at most 256 characters, or JSON trees with at most 16 entries
per array/object and four levels; keys are at most 256 characters. Each selected identity
value is limited to 2,048 encoded characters. It reports missing/invalid identities and scan
limits. `identities_complete: true` requires a complete identity scan with no missing
or invalid identity fields; only then can the selected projection support a negative
search. Full row samples are omitted when identity projection is enabled. `project`
instead returns one to 16 selected fields, with JSON Pointers of at most 512 characters,
for at most 200 rows and 12,000 characters. Do not combine `project` with
`identity_pointers`. Both outputs are bounded projections, not full rows. Without
either, `sample` contains at most ten rows and 12,000 characters (and at most 2,048
characters per row); it is never a complete input for specialized reducers.

`document.rows.state` is `array`, `missing`, or `wrong_type`; `value_type` distinguishes
null and other wrong types. A missing or wrong-type row path has `count: null`; an empty
array has count zero. `sample_incomplete` describes only the ten-row sample. Projection
and identity results report their own `shown_count` and scan/completeness fields. For a
field projection, `scan_complete` means all rows were scanned, `fields_complete` means
every requested value was bounded and present, and `invalid_rows` counts non-object rows.
For identities, `scan_complete` means all rows were scanned; `identities_complete` also
requires no missing or invalid identity. For reductions, `scan_complete` reports whether
the row scan reached its end, while `groups_complete` is false for invalid group/value/
time data or a scan/output/group limit. Check `invalid_groups`, `invalid_values`,
`invalid_times`, `omitted_groups`, and `limit_reached` before using the result. No sample
or projection establishes producer coverage.

The host must register `createCaptureReadTool({ resolveArtifact })` from
`extensions/agent-tools/capture-read.ts` with `codemode` exposure. This factory is not
registered by the `agent-tools` extension because only the host can enforce artifact
grants. The resolver must approve the exact artifact ID and stream on every page. For
specialized reducers that need raw JSONL text or a transform the helper cannot express,
first use bounded `jsonl_page` continuation when it fits, then use the advanced reference
only when safe complete `stdout_text` or a host-approved `artifact_read` grant provides the saved bytes. If no approved raw
route exists, report that limit. Never rerun the source query or parse presentation
previews.

## Result and limits

`status.process` is `ok`, `failed`, or `unknown`; `status.capture` reflects the source
stdout capture state; `status.decode` is `not_attempted`, `failed`, or `ok`; and
`status.producer` is the selected producer status or `unknown`. These are separate.
`details_ok` describes the tool result, not process success. A normal `read_ok: true`
means the saved JSON reached EOF, parsed, and fit the bounded result. On `output_limit`,
`read_ok` is false while `status.decode` is `ok`: the document parsed, but the result
could not fit. A failed read has no rows and does not mean an empty result. Check the
unchanged `request` and `query_error` fields when present. A safe inline `stdout_text`
uses `capture_ref: { source: "stdout_text" }`; artifact references contain an opaque
artifact ID and stream-availability summary. Neither is a path or grant.

The decoder uses `stdout_text` only when the saved envelope confirms complete stdout
and stderr captures and previews, normal cleanup, no artifact, and an exact UTF-8 byte
count. It never parses the envelope preview or framed stream preview. Otherwise it
reads the granted artifact by numeric byte offsets. It checks every page's offsets,
file size, provenance, payload byte count, and final EOF before parsing. A changed file
size returns `FILE_CHANGED`; changed provenance returns `PROVENANCE_CHANGED`; a capture
over 1 MiB returns `CAPTURE_TOO_LARGE`. None returns parsed rows. A partial source
capture may still contain valid saved JSON; source capture state remains `incomplete`,
separate from `capture.saved_eof`.

The output retains the original process status, request, and error fields when they
fit the metadata budget. It also retains `failure_display` as opaque diagnostics when
the checkpoint uses that fallback; it does not parse that text as query data. If an
original metadata field is oversized, the result replaces that field with an explicit
`{ omitted: true, reference, encoded_bytes }` record. The reference points into the
saved checkpoint so the evidence is not silently discarded. Result-limit failures
retain process status, `capture_ref`, and original errors or their checkpoint
references; oversized provenance is reported by reference.

Artifact provenance stays separate from producer metadata. Missing producer metadata
stays missing. The generic decoder makes no producer-completeness claim: it preserves
only metadata selected from observed fields, including tokens, pagination EOF, and
coverage gaps when selected. Do not infer producer coverage from row counts or a
`truncated` flag alone.

The helper admits 12 KiB of original process metadata before it reads a capture. An
`original_metadata_limit` occurs before capture reads and leaves decode status
`not_attempted`; oversized individual original fields are replaced by explicit
checkpoint references. The post-parse `metadata_limit` rejects selected producer
metadata and marks decode `failed`. Other limits are 1 MiB per capture, 8,192
characters of selected metadata, 2,048 encoded bytes per original request/error/
diagnostic field, 512 encoded bytes per process metadata field, ten default row
samples, 200 projected or identity rows and 12,000 characters per projection, 100,000
rows per grouped reduction, 100 groups, and a 48-KiB result. Oversized selected
metadata and captures fail; incomplete projections and reductions report their limits
and do not imply complete producer coverage.

For explicit byte pages or JSON projections without envelope decoding, use the
host-registered `artifact_read` described in the
[agent-tools reference](../../../extensions/agent-tools/README.md#artifacts). For
specialized JSONL and temporal-matrix reducers, read
[capture-reducers.md](capture-reducers.md) and use the on-demand
[advanced decoder](capture-decoding-advanced.md) when the bounded helper result is
insufficient. Those reducers and templates do not grant artifact access or rerun a
source query.
