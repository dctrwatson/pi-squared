# Pi Slack Chrome extension

Scaffold for the local Chrome side of the Pi Slack integration.

This directory also has its own lightweight `package.json` so any future browser-side tooling or dependencies stay isolated from the root package.

## Current state

Connection scaffolding is implemented.

Implemented so far:
- MV3 manifest
- lightweight local `package.json`
- background service worker with WebSocket hello/ack support
- ping response handling for the Pi bridge
- active Slack tab routing for current-thread reads
- temporary Slack tab routing for channel-range reads from permalinks
- temporary Slack tab reuse for expanding thread replies during channel summarization
- action icon state coloring (green connected, red error, gray otherwise)
- Slack content script with current thread extraction
- Slack content script with channel-range extraction from message permalinks
- reply-count detection on channel messages so threaded discussions can be expanded for summaries
- composer draft extraction for reply-context capture
- minimal popup for status, token storage, and test action

Not implemented yet:
- any browser-side write-back tooling
- DOM hardening beyond the current heuristic extractor

## Loading in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Choose **Load unpacked**
4. Select `chrome-extensions/pi-slack`

See `docs/pi-slack-architecture.md` for the implementation plan.
