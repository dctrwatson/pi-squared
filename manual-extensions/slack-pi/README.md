# slack-pi

Scaffold for the repo-local Slack Pi extension.

This directory is its **own package** so future Slack-specific dependencies can live here instead of in the root auto-loaded Pi package.

## Purpose

This extension is intentionally **not** part of the root package auto-loaded extensions.
It is meant to be launched explicitly.

Recommended launcher script:

```sh
./bin/slack-pi
```

You can symlink that into a directory on your `PATH`, for example:

```sh
ln -sf "$(pwd)/bin/slack-pi" "$HOME/bin/slack-pi"
```

The launcher forces a dedicated session directory under Pi's normal session storage so Slack Pi sessions do not depend on the current working directory:

```sh
$HOME/.pi/agent/sessions/--slack-pi--
```

Override it with:

```sh
SLACK_PI_SESSION_DIR=/path/to/sessions slack-pi
```

## Current state

Phase 1 is implemented.

Implemented so far:
- repo-local extension entrypoint
- dedicated local `package.json`
- dedicated local `tsconfig.json`
- singleton localhost WebSocket server on `ws://127.0.0.1:27183`
- local shared-secret creation/loading
- Chrome hello/ack handshake support
- Slack-specific non-coding system prompt override
- active tools restricted to `slack_get_current_thread`
- `/slack-status` command
- `/slack-ping` command
- `slack_get_current_thread` tool
- Slack thread normalization for model context

Not implemented yet:
- any browser-side write-back tooling
- Slack DOM hardening beyond the current heuristic extractor

## Useful commands

- `/slack-status` — show bridge status
- `/slack-status --show-token` — reveal the shared secret for Chrome setup
- `/slack-ping` — ping the connected Chrome extension
- `/slack-read` — read the active Slack thread and add it to the session as a visible message
- ask Pi to use `slack_get_current_thread` — read the active Slack thread plus any existing composer draft text

## Prompt behavior

When launched via `slack-pi`, Pi no longer behaves like a coding agent. The extension overrides the turn system prompt so the session acts like a read-only Slack reply assistant for concise, accurate SRE/BOFH-style communication.

The launcher also pins session storage to a dedicated Slack Pi subdirectory inside Pi's normal session storage, so normal project cwd-based session partitioning does not apply.

See `docs/slack-pi-architecture.md` for the implementation plan.
