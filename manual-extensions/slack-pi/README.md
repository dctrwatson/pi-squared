# slack-pi

Scaffold for the repo-local Slack Pi extension.

## Purpose

This extension is intentionally **not** part of the root package auto-loaded extensions.
It is meant to be launched explicitly, for example via a shell function:

```sh
slack-pi() {
  pi -e /Users/johnw/Projects/pi-squared/manual-extensions/slack-pi/index.ts "$@"
}
```

## Current state

This is scaffolding only.

Implemented so far:
- repo-local extension entrypoint
- placeholder `/slack-status` command
- placeholder `/slack-ping` command

Not implemented yet:
- singleton localhost WebSocket server
- Chrome extension handshake
- Slack read/insert tools
- composer draft context capture

See `docs/slack-pi-architecture.md` for the implementation plan.
