# slack-pi

Scaffold for the repo-local Slack Pi extension.

This directory is its **own package** so future Slack-specific dependencies can live here instead of in the root auto-loaded Pi package.

## Purpose

This extension is intentionally **not** part of the root package auto-loaded extensions.
It is meant to be launched explicitly.

Recommended launcher script:

```sh
/Users/johnw/Projects/pi-squared/bin/slack-pi
```

You can symlink that into a directory on your `PATH`, for example:

```sh
ln -sf /Users/johnw/Projects/pi-squared/bin/slack-pi ~/bin/slack-pi
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
- `/slack-status` command
- `/slack-ping` command

Not implemented yet:
- Slack read/insert tools
- composer draft context capture
- Slack DOM integration

## Useful commands

- `/slack-status` — show bridge status
- `/slack-status --show-token` — reveal the shared secret for Chrome setup
- `/slack-ping` — ping the connected Chrome extension

See `docs/slack-pi-architecture.md` for the implementation plan.
