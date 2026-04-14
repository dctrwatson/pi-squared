# slack-pi

Scaffold for the repo-local Slack Pi extension.

This directory is its **own package** so future Slack-specific dependencies can live here instead of in the root auto-loaded Pi package.

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
- dedicated local `package.json`
- dedicated local `tsconfig.json`
- placeholder `/slack-status` command
- placeholder `/slack-ping` command

Not implemented yet:
- singleton localhost WebSocket server
- Chrome extension handshake
- Slack read/insert tools
- composer draft context capture

See `docs/slack-pi-architecture.md` for the implementation plan.
