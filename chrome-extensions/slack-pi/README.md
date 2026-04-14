# Slack Pi Chrome extension

Scaffold for the local Chrome side of the Slack Pi integration.

## Current state

This is scaffolding only.

Implemented so far:
- MV3 manifest
- background service worker placeholder
- Slack content script placeholder
- minimal popup for status, token storage, and test action

Not implemented yet:
- WebSocket connection to `slack-pi`
- request/response protocol
- Slack thread extraction
- composer draft extraction
- composer insertion

## Loading in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Choose **Load unpacked**
4. Select `chrome-extensions/slack-pi`

See `docs/slack-pi-architecture.md` for the implementation plan.
