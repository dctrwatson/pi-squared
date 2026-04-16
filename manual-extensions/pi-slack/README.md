# pi-slack

Scaffold for the repo-local Pi Slack extension.

This directory is its **own package** so future Slack-specific dependencies can live here instead of in the root auto-loaded Pi package.

## Purpose

This extension is intentionally **not** part of the root package auto-loaded extensions.
It is meant to be launched explicitly.

Recommended launcher script:

```sh
./bin/pi-slack
```

You can symlink that into a directory on your `PATH`, for example:

```sh
ln -sf "$(pwd)/bin/pi-slack" "$HOME/bin/pi-slack"
```

The launcher forces a dedicated session directory under Pi's normal session storage so Pi Slack sessions do not depend on the current working directory:

```sh
$HOME/.pi/agent/sessions/--pi-slack--
```

Override it with:

```sh
PI_SLACK_SESSION_DIR=/path/to/sessions pi-slack
```

## Current state

Implemented so far:
- repo-local extension entrypoint
- dedicated local `package.json`
- dedicated local `tsconfig.json`
- singleton localhost WebSocket server on `ws://127.0.0.1:27183`
- local shared-secret creation/loading
- Chrome hello/ack handshake support
- Slack-specific non-coding system prompt override
- active tools restricted to `slack_get_current_thread` and `slack_read_channel`
- automatic Slack-aware session naming for easier resume/history browsing
- `/slack-status` command
- `/slack-ping` command
- `/slack-thread-read` command for the active thread
- `/slack-read-channel` command for channel reads by permalink
- `slack_get_current_thread` tool
- `slack_read_channel` tool
- Slack thread and channel-range normalization for model context
- channel summarization with automatic pagination and optional thread expansion

Not implemented yet:
- any browser-side write-back tooling
- Slack DOM hardening beyond the current heuristic extractor

## Useful commands

- `/slack-status` — show bridge status
- `/slack-status --show-token` — reveal the shared secret for Chrome setup
- `/slack-ping` — ping the connected Chrome extension
- `/slack-thread-read` — read the active Slack thread and add it to the session as a visible message
- `/slack-read-channel <start-url> [--next N] [--until <end-url>] [--max <n>] [--no-threads]` — read channel messages from a Slack message link, either as a bounded window (`--next`) or as a paginated span suitable for summarization
- ask Pi to use `slack_get_current_thread` — read the active Slack thread plus any existing composer draft text
- ask Pi to use `slack_read_channel` — read channel messages from a Slack permalink, either as a bounded range or as a larger paginated span for summarization

## Prompt behavior

When launched via `pi-slack`, Pi no longer behaves like a coding agent. The extension overrides the turn system prompt so the session acts like a read-only Slack reply assistant for concise, accurate SRE/BOFH-style communication.

The launcher also pins session storage to a dedicated Pi Slack subdirectory inside Pi's normal session storage, so normal project cwd-based session partitioning does not apply.

See `docs/pi-slack-architecture.md` for the implementation plan.
