# Agent tools

This extension adds tools and replaces selected Pi tools for all models. It is for trusted local use. It is not a sandbox or security boundary.

Image support is out of scope.

## Activation

The extension registers `read`, `find`, `grep`, `bash`, `bash_job`, `git`, `gh`, `web_search`, and `ask_user` when it loads. Registration requests the normal active defaults; explicit user or CLI selection takes precedence. Session, model, and job changes preserve the user's active tool selection; the extension does not add disabled names.

Unavailable optional tools have no model declaration or tool-specific prompt metadata. `gh` requires a local executable regular file; its declaration check is cached by PATH and session cwd. `web_search` requires an available compatible Codex model. `ask_user` is available only in TUI mode and is `model-only`, so nested calls cannot open its UI. `bash_job` is available while any job handle is retained, including terminal handles. These checks do not run authentication or network probes.

If your configuration names `extensions/codex-tools` or `extensions/ask-user.ts` explicitly, use `extensions/agent-tools` instead. Load `extensions/agent-tools` only once.

`edit` is unchanged. The extension corrects the built-in `write` success message to report UTF-8 byte count. The custom `read` and `bash` tools use Pi's preferred strict JSON-schema sampling when the provider supports it. It does not add a patch tool.

`web_search` sends only its query to a separate Codex request with native web search required. It does not send project files or the current conversation. Success requires a completed native search and a successful final answer. Native citations are counted separately; zero citations are allowed with a warning. An answer or URL alone is not retrieval proof. Billed usage remains in the result if a later check fails.

If the selected Codex model supports native tools, `web_search` uses it. Otherwise, it selects an available Codex model with native tool support. It prefers `gpt-6-luna`, then `gpt-5.6-luna`. Codex authentication is required. If no compatible Codex model is available, `web_search` returns `MODEL_UNAVAILABLE`; the other tools remain available.

`ask_user` asks one question with free text, one option, or multiple options. It requires an interactive TUI. Other modes return `UI_UNAVAILABLE`. Each session permits one active prompt. Session shutdown cancels the prompt. Free-text answers use Pi's `Editor` and configured editing keys. Submission preserves expanded, untrimmed editor text; Pi can normalize paste bytes.

## Result contract

All tool inputs use `snake_case`. The process tools use `timeout_seconds` for their optional time limit. For every tool, `null` or `undefined` in an optional field has the same effect as omission. This includes option descriptions in `ask_user`. Required values, unknown fields, and invalid supplied types fail before Pi can convert them. Caller objects and source strings are unchanged.

Search `limit` must be an integer from 1 through 2147483647. Grep `context` must be an integer from 0 through 200. Fractional values fail; they are not rounded down. Seconds can be finite fractions within the process tool's range.

Each tool result has `details.ok` and `details.tool`. A recoverable failure has `details.ok=false` and `details.error.code` plus `details.error.message`. A process can have `ok=true` with a nonzero exit code, signal, or timeout. Check its process status before you use its output. A started-process wrapper failure also retains a nested `details.process` snapshot. Pre-spawn failures have no process snapshot. `stop_reason` records the first stop request; `cleanup` reports whether process-group cleanup is verified.

Search results report `result_count`, `shown_count`, `preview`, `capture`, and `read_paths`. `grep.mode` supports `content` (default), `files`, `count`, and `exists`. Counts mean matching lines, not occurrences. Incomplete count capture has `total_matching_lines=null`. `exists` uses a native boolean witness, has no artifact, and rejects a supplied `limit`. Positive `context` is valid only in content mode.

## Non-obvious behavior

### Files and search

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
- Foreground process text defaults to an 8192-byte total budget, including status, paths, omission markers, and both streams. `max_output_bytes` accepts integers from 2048 through 40960. Failed command previews keep more tail output. Full capture limits are unchanged. If recovery metadata cannot fit, `RESULT_BUDGET_TOO_SMALL` prevents execution.
- The default timeout is 120 seconds. Timeout, cancellation, and capture failures trigger bounded process-group cleanup. A cleanup failure returns `PROCESS_CONTROL_FAILED` and keeps the original stop reason and readable evidence. A command that leaves its process group is outside this guarantee.
- Tool rows show the invocation, working directory, standard input, and timeout. They use one line and truncate to terminal width.
- A nonzero exit, signal, authentication failure, or timeout includes full process status. Check `exit_code`, `signal`, `timed_out`, and stream capture state before you act. Bash and GitHub CLI tool rows use the error background for these states. A Git status 1 with no Git error diagnostic remains normal. This supports boolean Git commands. Wrapper and capture failures are tool errors.

### Managed Bash jobs

`bash` with `background=true` returns a runtime/session-owned job ID after startup. Active `bash_job` controls are required before allocation or spawn, even while the empty registry's declaration is hidden. The first retained job makes its schema available for the next request without changing selected names. Its prompt guidance can remain hidden until the next user run. The registry permits eight live or reserved jobs. The default deadline remains 120 seconds; explicit background deadlines can reach 86400 seconds. A supplied non-null `max_output_bytes` is invalid in background mode.

`bash_job` supports `status`, `wait`, `output`, and `cancel`. Wait is bounded to 0–5 seconds, default 1; cancelling a wait does not stop the job. Output defaults to the last 4096 saved bytes. Use its numeric `next_start_byte` as the next `start_byte`; Base64 supports non-UTF-8 logs. Pages freeze the current saved size and permit append growth. A successful evidence read stays successful even if the job failed.

Cancel performs bounded process-group cleanup. `stop_failed` is not terminal; cancel retries the same group, never the command. Terminal handles last one hour, with at most 64 retained entries. Logs outlive handles. Foreign-session, expired, and previous-runtime IDs return `JOB_NOT_FOUND`; they cannot recreate a process.

Graceful shutdown supervises foreground and background Bash controllers, including pending starts. Cleanup results are recorded; failures keep readable logs and a warning when UI is available. Pi can catch shutdown errors and continue reload. Emergency exit, SIGKILL, host failure, cross-runtime supervision, and commands that escape their group are outside the guarantee.

### Artifacts

Artifacts contain omitted process or search output and are readable with `read`. They use owner-only temporary files. Use byte mode or Base64 for non-UTF-8 process output.

An artifact with `capture=incomplete` contains only captured data. It does not claim to contain complete output or a strict prefix. Published stream paths are verified as readable. `saved_raw_bytes`, when present, can differ from the observed `captured_raw_bytes`.

Process artifacts expire seven days after verified completion. Active logs and logs with unverified cleanup or metadata are pinned in the current runtime. Other artifacts use creation-based seven-day retention. Expired unpinned directories are removed when a new artifact is created.

## Authority

These tools have full host authority. Coordinate concurrent mutations. Use `edit` for normal file changes. Use `bash`, Git, or the system `patch` command for delete, rename, mode, binary, or unusual multi-file operations.
