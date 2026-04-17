# Pi Slack Chrome extension

Scaffold for the local Chrome side of the Pi Slack integration.

This directory also has its own lightweight `package.json` so any future browser-side tooling or dependencies stay isolated from the root package.

## Current state

Connection scaffolding is implemented.

Implemented so far:
- MV3 manifest
- lightweight local `package.json`
- background service worker with per-session WebSocket pairing and nonce/HMAC handshake
- stale-pairing invalidation when the Pi session rotates or rejects the current pairing
- ping response handling for the Pi bridge
- Chrome-side approval gate for every Slack read request, with exact broad-read scope summaries for channel ranges and paginated summaries
- short-lived, context-bound temporary approval policies for current-thread reads only
- active Slack tab routing for current-thread reads
- temporary Slack tab routing for channel-range reads from permalinks
- temporary Slack tab reuse for expanding thread replies during channel summarization
- action icon state coloring (green connected, yellow approval pending, red error, gray otherwise)
- Slack content script with current thread extraction
- Slack content script with channel-range extraction from message permalinks
- extractor fail-closed checks for ambiguous identity, boundary, and message-order cases
- reply-count detection on channel messages so threaded discussions can be expanded for summaries
- composer draft extraction for reply-context capture
- popup for status, per-session pairing, temporary approval reset, approval window access, and test action

Not implemented yet:
- any browser-side write-back tooling
- DOM hardening beyond the current heuristic extractor

## Pairing setup

The Chrome extension now pairs to a single live `pi-slack` session.
See `manual-extensions/pi-slack/README.md` — **First-run setup** — for the flow:
launch `pi-slack`, run `/slack-status --show-pairing`, then paste that pairing code into the popup.
Chrome will prompt before each Slack read request is executed.

## Loading in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Choose **Load unpacked**
4. Select `chrome-extensions/pi-slack`
5. Open the extension popup, paste the pairing code from the Pi side, and press **Save pairing**.

See `docs/pi-slack-architecture.md` for the architecture details.
