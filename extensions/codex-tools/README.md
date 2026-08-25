# Codex tools

This extension replaces selected Pi tools for the `openai-codex` provider. It is for a trusted local power-user model. It is not a sandbox or security boundary.

## Activation

The extension registers `read`, `find`, `grep`, `bash`, `git`, `gh`, and `web_search` when the selected model uses `openai-codex`. The replacements stay active if you later change models. Restart Pi to restore built-in tools.

`edit` is unchanged. The extension corrects the built-in `write` success message to report UTF-8 byte count. It does not add a patch tool.

`web_search` sends only its query to a separate Codex request with the native web-search tool enabled. It does not send project files or the current conversation. The response includes source URLs and its usage is added to the tool result.

## Result contract

All tool inputs use `snake_case`. The process tools use `timeout_seconds` for their optional time limit.

Each tool result has `details.ok` and `details.tool`. A recoverable failure has `details.ok=false` and `details.error.code` plus `details.error.message`. A process can have `ok=true` with a nonzero exit code, signal, or timeout. Check its process status before you use its output.

Search results always report `result_count`, `shown_count`, `preview`, `capture`, and `read_paths`. They use `result_limit`, `match_limit`, and `lines_truncated` when applicable.

## Non-obvious behavior

### Files and search

- `read` supports inclusive 1-based line ranges and zero-based, half-open byte ranges. Use `show_line_numbers=true` when you need an exact line. A too-long line returns `byte_offset`; retry in byte mode from that offset.
- `find` and `grep` return paths that `read` can use directly. Both create an artifact before they format the preview, so explicit result limits do not limit artifact capture.
- File names with line breaks, CR, non-UTF-8 data, or leading or trailing whitespace cannot use the search line protocol. The tools omit them and set `capture=incomplete`. An incomplete artifact is a subset, not necessarily a prefix. Use `bash` for these names.

### Processes

- `git` and `gh` run direct argument arrays, not a shell. `bash` runs `bash -c`. Relative `cwd` values resolve from the Pi session directory.
- `git` and `gh` have no TTY. Their pagers use `cat`. Git disables terminal prompts and askpass helpers. GitHub CLI disables prompts. Editors and browsers are no-ops.
- Do not use commands or flags that need an interactive UI. Supply messages, bodies, and choices with arguments or standard input. Do not rely on hooks that need input.
- The default timeout is 120 seconds. Timeout and cancellation clean up the process group and its descendants.
- Tool rows show the invocation, working directory, standard input, and timeout. They use one line and truncate to terminal width.
- A nonzero exit, signal, authentication failure, or timeout includes full process status. Check `exit_code`, `signal`, `timed_out`, and stream capture state before you act. Bash and GitHub CLI tool rows use the error background for these states. A Git status 1 with no Git error diagnostic remains normal. This supports boolean Git commands. Wrapper and capture failures are tool errors.

### Artifacts

Artifacts contain omitted process or search output and are readable with `read`. They use owner-only temporary files. Use byte mode or Base64 for non-UTF-8 process output.

An artifact with `capture=incomplete` contains only captured data. It does not claim to contain complete output or a strict prefix. Artifacts older than seven days are removed when a new artifact is created.

## Authority

These tools have full host authority. Coordinate concurrent mutations. Use `edit` for normal file changes. Use `bash`, Git, or the system `patch` command for delete, rename, mode, binary, or unusual multi-file operations.
