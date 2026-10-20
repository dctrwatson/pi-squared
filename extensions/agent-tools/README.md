# Agent tools

This extension adds tools and replaces selected Pi tools for all models. It is for trusted local use. It is not a sandbox or security boundary.

Image support is out of scope.

## Activation

The extension registers `read`, `find`, `grep`, `bash`, `bash_job`, `git`, `gh`, `web_search`, and `ask_user` when it loads. Registration requests the normal active defaults; explicit user or CLI selection takes precedence. Session, model, and job changes preserve the user's active tool selection; the extension does not add disabled names.

Unavailable optional tools have no model declaration or tool-specific prompt metadata. `gh` requires a local executable regular file; its declaration check is cached by PATH and session cwd. `web_search` requires an available compatible Codex model. `ask_user` is available only in TUI mode and is `model-only`, so nested calls cannot open its UI. `bash_job` is available while any job handle is retained, including terminal handles. These checks do not run authentication or network probes.

If your configuration names `extensions/codex-tools` or `extensions/ask-user.ts` explicitly, use `extensions/agent-tools` instead. Load `extensions/agent-tools` only once.

`agentTools(pi)` keeps the full default registration. An extension host can use the named `createAgentToolsExtension(selectedTools)` export to register only selected tools:

```ts
createAgentToolsExtension(["read", "find", "grep", "web_search", "ask_user"])(pi);
```

Availability checks run only for selected optional tools. The Bash owner, job registry, and their lifecycle hooks are created only when `bash` or `bash_job` is selected.

`edit` is unchanged. The extension corrects the built-in `write` success message to report UTF-8 byte count. The custom `read` and `bash` tools use Pi's preferred strict JSON-schema sampling when the provider supports it. It does not add a patch tool.

`web_search` sends only its query to a separate Codex request with native web search required. It does not send project files or the current conversation. Success requires a completed native search and a successful final answer. Native citations are counted separately; zero citations are allowed with a warning. An answer or URL alone is not retrieval proof. Billed usage remains in the result if a later check fails.

If the selected Codex model supports native tools, `web_search` uses it. Otherwise, it selects an available Codex model with native tool support. It prefers `gpt-6-luna`, then `gpt-5.6-luna`. Codex authentication is required. If no compatible Codex model is available, `web_search` returns `MODEL_UNAVAILABLE`; the other tools remain available.

`ask_user` asks one question with free text, one option, or multiple options. It requires an interactive TUI. Other modes return `UI_UNAVAILABLE`. Each session permits one active prompt. Session shutdown cancels the prompt. Free-text answers use Pi's `Editor` and configured editing keys. Submission preserves expanded, untrimmed editor text; Pi can normalize paste bytes.

## Result contract

All tool inputs use `snake_case`. The process tools use `timeout_seconds` for their optional time limit. For every tool, `null` or `undefined` in an optional field has the same effect as omission. This includes option descriptions in `ask_user`. Required values, unknown fields, and invalid supplied types fail before Pi can convert them. Caller objects and source strings are unchanged.

Search `limit` must be an integer from 1 through 2147483647. Grep `context` must be an integer from 0 through 200. Fractional values fail; they are not rounded down. Seconds can be finite fractions within the process tool's range.

Each tool result has `details.ok` and `details.tool`. A recoverable failure has `details.ok=false` and `details.error.code` plus `details.error.message`. A process can have `ok=true` with a nonzero exit code, signal, or timeout. Check its process status before you use its output. A started-process wrapper failure also retains a nested `details.process` snapshot. Pre-spawn failures have no process snapshot. `stop_reason` records the first stop request; `cleanup` reports whether process-group cleanup is verified.

Search results report `result_count`, `shown_count`, `preview`, `capture`, and `read_paths`. `grep.mode` supports `content` (default), `files`, `count`, and `exists`. Counts mean matching lines, not occurrences. Incomplete count capture has `total_matching_lines=null`. `exists` uses a native boolean witness, has no artifact, and rejects a supplied `limit`. Positive `context` is valid only in content mode.

`find` and `grep` declare an output schema. Their text `content` and `details` stay unchanged. Codemode scripts receive `structuredContent` instead of text `content` on success and failure. Success fields include `ok`, `tool`, `result_count`, `shown_count`, `preview`, `capture`, and typed `records`. Find and files records have a canonical `path`. Content records have `path`, `line_number`, display-bounded `text`, and `match` (`false` marks context). Count records have `path` and `matching_lines`; count results also have `total_matching_lines` and `captured_matching_lines`. Exists results have `exists` and `termination`. Failures have `ok=false` and an `error` with `code` and `message`.

Structured output is limited to 48 KiB after JSON encoding. Records come only from the displayed preview, and content text uses the same 500-character line limit. If the structured limit removes records, `structured_truncated=true`, `structured_record_count` gives the retained record count, and `artifact` identifies the complete or incomplete plain-text capture with `path`, `metadata_path`, and capture counts. That artifact may appear only in `structuredContent` when text output itself was not truncated.

A codemode script can filter content records and keep the search status with the selected lines:

```js
const result = await tools.grep({ pattern: "TODO", mode: "content", limit: 100 });
if (!result.ok) return result;

return {
  selection: "matches from displayed preview; context lines omitted",
  matches: result.records
    .filter((record) => record.match)
    .map(({ path, line_number, text }) => ({ path, line_number, text })),
  result_count: result.result_count,
  shown_count: result.shown_count,
  preview: result.preview,
  capture: result.capture,
  structured_truncated: result.structured_truncated,
  ...(result.artifact ? { artifact: result.artifact } : {}),
};
```

## Non-obvious behavior

### Files and search

For literal/regex hostnames, positive controls, and narrow source paths, use the
[focused source-search examples](../../skills/codemode/references/source-search.md).

- `read` supports inclusive 1-based line ranges and zero-based, half-open byte ranges. Defaults are 200 numbered lines and 16384 source bytes. Use `show_line_numbers=false` for raw line text. A too-long line returns `byte_offset`; retry in byte mode from that offset.
- Reads use bounded scans and positioned byte pages, not whole-file loads. There is no 64-MiB file-size ceiling. `start_byte` accepts safe integers through 9007199254740991. `has_more` reports continuation; `total_lines` is null until the scan reaches logical EOF. A changed file snapshot returns `FILE_CHANGED`. Only regular files are supported.
- `find` and non-existence grep modes return paths that `read` can use directly. They capture before they format previews, so explicit result limits do not limit normal artifact capture. Defaults are 100 find paths, 50 grep content matches, and 100 files/count records. Complete files-mode output contains paths only.
- Outside a Git repository, native find requires fd with `--no-require-git` support. Tested versions are fd 10.5.0 and rg 13.0.0/15.2.0. fd 8.6.0 lacks this flag.
- Search includes hidden files and uses native ignore rules by default. `include_ignored=true` permits ignored files and `node_modules` descendants; descendant `.git` directories remain excluded. Explicit files or search roots in these directories remain searchable. A positive `grep.glob` can override native ignore files, but not the automatic directory exclusions.
- File names with line breaks, CR, non-UTF-8 data, or leading or trailing whitespace cannot use the search line protocol. The tools omit them and set `capture=incomplete`. An incomplete artifact is a subset, not necessarily a prefix. Use `bash` for these names.

### Processes

- `git` and `gh` run direct argument arrays, not a shell. `bash` runs `bash -c`. Relative `cwd` values resolve from the Pi session directory.
- `git` and `gh` have no TTY. Their pagers use `cat`. Git disables terminal prompts and askpass helpers. GitHub CLI disables prompts. Editors and browsers are no-ops.
- Do not use commands or flags that need an interactive UI. Supply messages, bodies, and choices with arguments or standard input. Do not rely on hooks that need input.
- Foreground process text defaults to an 8192-byte total budget, including status, paths, omission markers, and both streams. `max_output_bytes` accepts integers from 2000 through 40960. Failed command previews keep more tail output. Full capture limits are unchanged. If recovery metadata cannot fit, `RESULT_BUDGET_TOO_SMALL` prevents execution.
- The default timeout is 120 seconds. Timeout, cancellation, and capture failures trigger bounded process-group cleanup. A cleanup failure returns `PROCESS_CONTROL_FAILED` and keeps the original stop reason and readable evidence. A command that leaves its process group is outside this guarantee.
- Tool rows show the invocation, working directory, standard input, and timeout. They use one line and truncate to terminal width.
- A nonzero exit, signal, authentication failure, or timeout includes full process status. Check `exit_code`, `signal`, `timed_out`, and stream capture state before you act. Bash and GitHub CLI tool rows use the error background for these states. A Git status 1 with no Git error diagnostic remains normal. This supports boolean Git commands. Wrapper and capture failures are tool errors.
- Direct-process results have optional decoded `stdout_text` for small complete no-artifact output. A complete nonempty stdout capture that cannot use this field keeps a readable process artifact, even when its text preview is complete. `runDirectProcess` accepts `artifactRetention: "when-needed" | "always"`; `when-needed` is the default. `always` retains both completed streams, including empty streams, after a normal capture and omits `stdout_text`. Stopped or incomplete captures keep the existing evidence-retention rules. Pass `stdout_text` as the fourth argument to `createProcessEnvelope(preview, details, isError, stdoutText?)` from `extensions/agent-tools/process-envelope.ts`. Host tools can use `processEnvelopeOutputSchema` as `outputSchema` and the envelope as `structuredContent` for codemode. The helper keeps `details` unchanged and bounds the JSON envelope to 48 KiB by shortening only `preview`, with `preview_truncated=true`. It includes `stdout_text` only when both streams have complete captures and previews, stdout matches its captured UTF-8 byte count, cleanup is normal, no artifact exists, and the JSON-encoded string fits 8 KiB. It throws `RangeError` if metadata alone exceeds the envelope limit. The helper does not change text `content` or parse framing; `bash`, `git`, and `gh` do not use it.

#### Reusable bounded child process

`extensions/agent-tools/bounded-child-process.ts` exports `startBoundedChildProcess(executable, args, options)`. Set `stdoutLimitBytes` and `stderrLimitBytes` to cap retained bytes per stream. Each stream's `bytes` field reports observed bytes and can exceed its cap; `overflow` marks a cap breach. If a stream cap is omitted, the helper drains that stream without retaining bytes or applying a per-stream cap. `totalOutputLimitBytes` sets `totalOutputOverflow` when combined observed bytes exceed its cap. With `stopOnLimit=true`, any configured cap breach requests `SIGTERM`.

The constructor's `signal` requests `SIGTERM` when it aborts. A signal passed to `waitForClose()` cancels only that wait; it does not terminate the child. `stop()` sends `SIGTERM` to a live child, waits, sends `SIGKILL` if the child is still live, then waits for close. `cleanupTimeoutMs` must be a positive safe integer and defaults to 300 ms per wait.

A child can exit while a descendant keeps a pipe open. `stop()` waits for close, then throws `BoundedChildCleanupError` if close is not observed in time. It does not signal a child that has already exited. Repeated calls share the cleanup attempt. If close is observed after a cleanup error, a later call returns that status. The helper does not manage process groups or descendants. An outer owner must retain any required cleanup authority and must not treat this error as verified cleanup.

### Failed codemode call references

`extensions/agent-tools/completed-call-references.ts` exports `registerCompletedCallReferences(pi, options?)`. It tracks nested `tool_result` events only while a codemode parent call is open. On a failed codemode result, it appends a bounded JSON index to text content and adds the same value at `details.completed_call_references`. Successful codemode results stay unchanged. It clears buffers when a parent finishes and at session start or shutdown. A late `tool_result` is ignored; only `tool_call` opens a buffer.

Register it after the host's existing `tool_result` redaction and grant hook. An optional synchronous `projectResult(event, ctx)` callback receives the current event and `ExtensionContext`; it can return host-approved JSON metadata for that nested result. The helper does not copy raw output or infer artifact paths or grants when no projection is supplied. It retains call ID, tool, error state, and observation time. Defaults cap open parents at 8, calls per parent at 32, the complete index at 12 KiB of JSON, and each projected reference at 1 KiB. Parent IDs must be non-empty, at most 128 UTF-8 bytes and 256 code units, and contain no control characters. Invalid IDs and calls arriving while the concurrent-parent cap is full are not indexed. Omitted nested calls and references within an indexed parent are reported with `truncated`, `omitted_call_count`, `reference_omitted_count`, and `completed_observed_count`. The helper registers lifecycle and tool-result observers only; it adds no tools or authority.

### Managed Bash jobs

`bash` with `background=true` returns a runtime/session-owned job ID after startup. Active `bash_job` controls are required before allocation or spawn, even while the empty registry's declaration is hidden. The first retained job makes its schema available for the next request without changing selected names. Its prompt guidance can remain hidden until the next user run. The registry permits eight live or reserved jobs. The default deadline remains 120 seconds; explicit background deadlines can reach 86400 seconds.

`max_output_bytes` sets the startup response budget, with the same default and range as foreground calls. It does not limit saved logs or later `bash_job` responses. Startup fails before spawn if the metadata cannot fit the selected budget or the separate 8192-byte job control budget. Use `bash_job.output.max_bytes` to set the size of later saved-log pages.

`bash_job` supports `status`, `wait`, `output`, and `cancel`. Wait is bounded to 0–5 seconds, default 1; cancelling a wait does not stop the job. Output defaults to the last 4096 saved bytes. Use its numeric `next_start_byte` as the next `start_byte`; Base64 supports non-UTF-8 logs. Pages freeze the current saved size and permit append growth. A successful evidence read stays successful even if the job failed.

Cancel performs bounded process-group cleanup. `stop_failed` is not terminal; cancel retries the same group, never the command. Terminal handles last one hour, with at most 64 retained entries. Logs outlive handles. Foreign-session, expired, and previous-runtime IDs return `JOB_NOT_FOUND`; they cannot recreate a process.

Graceful shutdown supervises foreground and background Bash controllers, including pending starts. Cleanup results are recorded; failures keep readable logs and a warning when UI is available. Pi can catch shutdown errors and continue reload. Emergency exit, SIGKILL, host failure, cross-runtime supervision, and commands that escape their group are outside the guarantee.

### Artifacts

Artifacts contain retained process streams and search output omitted from a preview. Read them with `read`. They use owner-only temporary files. Use byte mode or Base64 for non-UTF-8 process output.

An artifact with `capture=incomplete` contains only captured data. It does not claim to contain complete output or a strict prefix. Published stream paths are verified as readable. `saved_raw_bytes`, when present, can differ from the observed `captured_raw_bytes`.

See the [shared codemode capture skill](../../skills/codemode/SKILL.md) for an example that decodes a saved envelope without rerunning the source process.

`extensions/agent-tools/artifact-read.ts` exports `createArtifactReadTool(options)`. It is a reusable factory and is not registered by `extensions/agent-tools`. A host must register it explicitly and provide `resolveArtifact(id, stream, ctx)`, which returns `{ path, provenance }`. The resolver runs for every page, including cached JSON pages. Use it to enforce the host's exact-path and branch grants. The factory returns supplied provenance unchanged in `structuredContent`; JSON item counts describe the saved document and do not prove that capture was complete. `openFile` is an optional host file opener; the default uses positioned reads of a regular file.

`extensions/agent-tools/capture-read.ts` exports `createCaptureReadTool(options)`. It is also an unregistered factory. A host can register it with `codemode` exposure and the same `resolveArtifact` grant resolver as `artifact_read`; the resolver approves every artifact page. In codemode, call `tools.capture_read({ saved_capture, format?, selection?, project?, reduce?, gzip_field?, jsonl_page? })` with the compact process-envelope checkpoint. The default `format: "json"` keeps the existing JSON behavior and 1-MiB capture limit. `format: "jsonl"` full scans read granted stdout pages to a separate 8-MiB cap, with 256-KiB line and 100000-record limits; `project` and `reduce` pointers apply to each JSONL record, including nested fields. It reports page-verified provenance, saved EOF, bounded line errors, and partial coverage. A prefix or malformed record is not a complete result. `jsonl_page: { start_byte?, max_records? }` returns a bounded record page without changing full-scan or reducer behavior. The default is cursor 0 and 10 records; `max_records` is 1–200, and a page `project.limit` can lower that count. A row-page call scans at most 8 MiB, the existing JSONL scan budget. A page can continue from its returned cursor; if one record spans the full budget before a newline, `read_ok` is false because no safe cursor can advance. `max_records` is per call, so callers that traverse multiple pages must enforce any aggregate row ceiling themselves. The 100000-record cap applies to full scans. Raw records use the existing 2048-character per-row and 12000-character page caps, plus a 12000-byte UTF-8 page-data budget. If the byte budget is reached, `limit_reached: "result_bytes"` leaves the next record at the cursor. You can combine `project.fields` with a row page to select fields from a larger record; the encoded field map is limited to 8 KiB total. Page-projected strings are limited to 2048 characters, while full-scan projections retain the 256-character limit. `reduce` is not accepted with `jsonl_page`. `document.jsonl_page.next_start_byte` is the continuation cursor, and `eof` reports whether that cursor reaches the saved stream end. A cursor must be 0, EOF, or immediately after a newline. Oversized records create an explicit gap and advance the cursor beyond that record. Page errors include absolute byte offsets and page-relative line numbers. A normal continuation can have `read_ok: true` with `eof: false`; use the cursor and EOF flag to continue. In row-page projection mode, missing or unbounded selected fields set `fields_complete: false` and `read_ok: false`. Only a page covering byte 0 through EOF without gaps or errors reports `complete: true`; `complete` tracks source-row coverage, while `fields_complete` tracks projection coverage. Callers that use multiple pages must track contiguous coverage themselves. Each page is still read through the host grant resolver, and the tool does not rerun the source query. `gzip_field: { pointer }` decodes one observed saved JSON string as strict base64+gzip, with a 512-KiB encoded-input limit and a 16-KiB default expansion ceiling. Set `max_decoded_bytes` to request a larger ceiling, up to the existing 1-MiB capture limit; this does not raise any global capture or output limit. `max_bytes` selects a UTF-8 byte page of up to 16 KiB, and `start_byte` continues from the prior page's `next_start_byte`. Pages keep code points whole and may be shortened by the 48-KiB result budget (`page_limit_reached: "result_bytes"`). Each result includes total decoded bytes, page offsets, EOF, CRC/size checks, and the same provenance. The result cap remains 48 KiB. Neither route calls the source query. Selected metadata is limited to 8192 characters; projections return at most 200 rows and 12000 characters; grouped reductions scan at most 100000 rows, retain at most 100 groups and 12000 characters, and return per-group count, sum, minimum, maximum, and (with `value_pointer`) `positive_count`. Model-facing text and `structuredContent` are limited to 48 KiB. See the [codemode capture reference](../../skills/codemode/references/capture-decoding.md) for the call and output limits.

`reduce.time_pointer` accepts finite numeric timestamps or ISO date-times with `Z` or a
numeric `±HH:MM` offset and up to nine fractional-second digits. It returns observed
`first_time` and `last_time` values in timestamp order; numeric timestamps are compared
as given, without unit conversion. Use one timestamp type per group. Missing, invalid, or
mixed-type timestamps increment `invalid_times`, make `groups_complete` false, and
suppress bounds for affected groups. A scanned row without a bounded group identity
makes `groups_complete` false and suppresses every group. Choose a `group_pointer` that
includes the observed unit identity to keep unit totals separate. Reductions scan up to 100,000 rows
independently of the 200-row projection limit.

A resolver can throw `new ArtifactResolutionError(message)` for a denied or unavailable grant. It returns `ARTIFACT_NOT_FOUND` and preserves the message (bounded to 512 UTF-8 bytes). The second argument can set `{ code: "UNSUPPORTED_FILE_TYPE" | "INVALID_INPUT", route?: "bytes" | "json" }`. Set `route` to the supported mode for an unsupported-mode error. An unexpected resolver exception returns `INTERNAL_ERROR` without its diagnostic. Cancellation takes precedence if the signal aborts while the resolver runs. The exact API is `new ArtifactResolutionError(message, options?)`.

The tool name is `artifact_read`. It accepts a UUID `artifact_id`, optional `stream` (`stdout` or `stderr`, default `stdout`), and optional `mode` (`bytes` or `json`, default `bytes`). Success and failure results have an output schema and structured content. Model-facing text is the same JSON envelope as `structuredContent`, with `data`, `page`, and `provenance` in separate fields. Both the envelope and text are limited to 48 KiB after JSON encoding. `RESULT_BUDGET_TOO_SMALL` means provenance or metadata leaves no room for a complete next byte or UTF-8 code point. A mode-mismatched argument reports the route where that argument is supported; for example, `fields` supplied in bytes mode reports `route=json`.

- **Bytes route:** `start_byte` is a zero-based offset, `max_bytes` is an upper bound of 1–40960 UTF-8 bytes or 1–30720 Base64 bytes (default 16384), and `encoding` is `utf8` (default) or `base64`. UTF-8 pages keep code points whole. The 48-KiB envelope limit can shorten a page to a smaller complete byte prefix. Use `page.next_start_byte` to continue; the cursor identifies the first byte not returned. The output envelope includes complete byte offsets, total source bytes, encoding, continuation state, and provenance.
- **JSON array route:** `fields` is required. It maps output aliases to RFC 6901 pointers relative to each selected array item. `array_pointer` selects the array (default root `''`). `offset` defaults to 0, `limit` defaults to 100 and is at most 1000, and `max_bytes` defaults to 16384 and is at most 40960. The input schema permits `max_bytes=1`, but JSON mode requires at least 2 bytes for the encoded empty row array. The byte budget includes the complete JSON encoding of the returned row array. Missing field pointers omit that alias. The tool reduces each page to complete rows that fit the 48-KiB result envelope. A row is never truncated; if the first row cannot fit, the tool returns `ROW_TOO_LARGE`.
- **JSON object route:** `fields` is required. `object_pointer` selects one object; set it to `''` for the root object. It is mutually exclusive with `array_pointer`. Each field pointer is relative to that object. The tool returns one object and does not page it; `offset` and `limit` are invalid. Missing pointers omit aliases. `page.requested_fields`, `page.returned_fields`, `page.missing_fields`, and `page.projection_complete` describe only the requested projection. They do not describe capture completeness; the separate `provenance` retains capture state. The complete encoded object must fit `max_bytes` and the 48-KiB envelope or the tool returns `ROW_TOO_LARGE`; values are never truncated. `json_start_byte` defaults to 0 for either JSON route; set it explicitly to skip a known wrapper or login preamble. The tool never skips a prefix silently.

All routes reject source files larger than 64 MiB. JSON projection output is limited to 8 MiB; array projections also have a 100000-row cap. Object projections accept at most 64 field aliases. The factory caches only compact projected data in a bounded LRU; it does not retain parsed source inventory. Each cached request opens the stream and checks its file snapshot. A changed stream returns `FILE_CHANGED` instead of using the cached projection.

Process artifacts expire seven days after verified completion. Active logs and logs with unverified cleanup or metadata are pinned in the current runtime. Other artifacts use creation-based seven-day retention. Expired unpinned directories are removed when a new artifact is created.

## Authority

These tools have full host authority. Coordinate concurrent mutations. Use `edit` for normal file changes. Use `bash`, Git, or the system `patch` command for delete, rename, mode, binary, or unusual multi-file operations.
