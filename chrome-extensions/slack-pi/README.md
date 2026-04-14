# Slack Pi Chrome extension

Scaffold for the local Chrome side of the Slack Pi integration.

This directory also has its own lightweight `package.json` so any future browser-side tooling or dependencies stay isolated from the root package.

## Current state

Connection scaffolding is implemented.

Implemented so far:
- MV3 manifest
- lightweight local `package.json`
- background service worker with WebSocket hello/ack support
- ping response handling for the Pi bridge
- active Slack tab routing
- action icon state coloring (green connected, amber connecting, red error, gray idle)
- Slack content script with current thread extraction
- composer draft extraction for reply-context capture
- minimal popup for status, token storage, and test action

Not implemented yet:
- any browser-side write-back tooling
- DOM hardening beyond the current heuristic extractor

## Loading in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Choose **Load unpacked**
4. Select `chrome-extensions/slack-pi`

See `docs/slack-pi-architecture.md` for the implementation plan.
