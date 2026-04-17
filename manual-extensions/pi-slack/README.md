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

> **Trust boundary.** The launcher passes any extra arguments verbatim to `pi`. An extra `-e` flag
> (e.g. `pi-slack -e /tmp/x.ts`) would load an additional extension that could inspect bridge state
> or reveal the live session pairing code. Only use extra `-e` flags with extensions you fully trust.

## First-run setup

1. **Launch the bridge.**

   ```sh
   bin/pi-slack
   ```

   The extension starts a localhost WebSocket bridge on a session-specific port.

2. **Reveal the pairing code.**

   Inside the Pi session run:

   ```
   /slack-status --show-pairing
   ```

   This displays the pairing code for the live `pi-slack` session. Keep the terminal output
   confidential until that session exits.

3. **Configure Chrome.**

   Open the Pi Slack Chrome extension popup (`chrome-extensions/pi-slack` loaded as an unpacked
   extension), paste the pairing code into the pairing field, and press **Save pairing**.

   Chrome will connect to that specific session and ask you to approve each Slack read request.
   Current-thread reads can optionally be temporarily auto-approved from the approval window, but
   those temporary approvals are bound to the observed Slack context (for example the same thread or
   channel) and larger channel reads remain one-time approvals.

   See `chrome-extensions/pi-slack/README.md` for Chrome loading instructions.

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
- localhost WebSocket server on a session-specific port (or `PI_SLACK_PORT` override)
- per-session pairing code generation
- pairing rotation command and automatic post-disconnect pairing rotation grace period
- nonce/HMAC Chrome handshake support
- stricter default origin policy (`chrome-extension://` required unless `PI_SLACK_ALLOW_NO_ORIGIN=1`)
- Slack-specific non-coding system prompt override
- active tools restricted to `slack_read_thread` and `slack_read_channel`
- automatic Slack-aware session naming for easier resume/history browsing
- `/slack-status` command
- `/slack-rotate-pairing` command
- `/slack-ping` command
- `/slack-read-thread` command for the active thread
- `/slack-read-channel` command for channel reads by permalink
- `slack_read_thread` tool
- `slack_read_channel` tool
- Slack thread and channel-range normalization for model context
- channel summarization with automatic pagination and optional thread expansion

Not implemented yet:
- any browser-side write-back tooling
- Slack DOM hardening beyond the current heuristic extractor

## Useful commands

- `/slack-status` — show bridge status
- `/slack-status --show-pairing` — reveal the pairing code for Chrome setup (`--show-token` remains a compatibility alias)
- `/slack-rotate-pairing` — rotate the live pairing code and force Chrome to re-pair
- `/slack-ping` — ping the connected Chrome extension
- `/slack-read-thread` — read the active Slack thread and add it to the session as a visible message
- `/slack-read-channel <start-url> [--next N] [--until <end-url>] [--max <n>] [--no-threads]` — read channel messages from a Slack message link, either as a bounded window (`--next`) or as a paginated span suitable for summarization
- `/slack-debug-thread-scan` — capture a lightweight extractor debug scan for the currently open Slack thread
- `/slack-debug-channel-scan` — capture a lightweight extractor debug scan for the active Slack channel view
- ask Pi to use `slack_read_thread` — read the active Slack thread plus any existing composer draft text
- ask Pi to use `slack_read_channel` — read channel messages from a Slack permalink, either as a bounded range or as a larger paginated span for summarization

## Prompt behavior

When launched via `pi-slack`, Pi no longer behaves like a coding agent. The extension overrides the turn system prompt so the session acts like a read-only Slack reply assistant for concise, accurate SRE/BOFH-style communication.

The launcher also pins session storage to a dedicated Pi Slack subdirectory inside Pi's normal session storage, so normal project cwd-based session partitioning does not apply.

See `docs/pi-slack-architecture.md` for the architecture details.
