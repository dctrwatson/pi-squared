# Slack Pi Architecture and Implementation Plan

## Summary

Build a **Slack-aware Pi launcher** named `slack-pi` that loads a repo-local Pi extension on demand, plus a Chrome extension that talks to it over a **local WebSocket**.

This design intentionally avoids:
- installing a Slack app into the Slack workspace
- auto-loading Slack integration into every normal Pi session
- a separate always-on local daemon
- multi-instance ambiguity

It assumes the primary workflow is:
1. Slack is open in a pinned Chrome tab
2. `slack-pi` is launched when Slack assistance is needed
3. Pi uses tool calls to read the current thread, incorporate any existing Slack composer draft as context, and produce a revised reply for manual copy/paste back into Slack

---

## Goals

### Primary goals
- Read the **currently open Slack thread** from Chrome
- Let Pi use the thread as context during a normal tool-calling workflow
- Accept a short or long user draft/note and turn it into a polished Slack reply
- If the Slack composer already contains text, use that draft as additional reply context
- Keep the integration **opt-in** via a dedicated `slack-pi` launcher
- Keep the final reply workflow manual via copy/paste

### Secondary goals
- Keep implementation local-only and personal-workflow-friendly
- Keep normal `pi` sessions unaffected
- Store all source in this repo without making the Slack extension auto-load as part of the package
- Make failure modes clear and predictable

### Non-goals
- No Slack workspace app or OAuth install
- No background processing when Pi is closed
- No support for autonomous bot behavior
- No attempt to read messages outside the currently accessible Slack web UI
- No multi-controller coordination between several Pi instances
- No Pi-driven final send action; the user always clicks send in Slack manually
- No Pi-driven composer insertion in the MVP; the user copy/pastes manually

---

## Key constraints

1. **No Slack workspace installation**
   - Integration must work entirely through the logged-in Slack web app in Chrome.

2. **No always-on bridge daemon**
   - Pi owns the WebSocket server while `slack-pi` is running.

3. **Single Slack-aware Pi instance**
   - `slack-pi` is treated as a singleton.
   - If another Slack-aware instance is started, it should fail fast or disable Slack tools.

4. **Repo-local, not auto-loaded**
   - The Slack extension must live in this repo, but outside the root package manifest paths so it is not auto-discovered.

---

## Proposed repository layout

```text
pi-squared/
  docs/
    slack-pi-architecture.md
  extensions/
    ...existing auto-loaded extensions...
  skills/
    ...existing skills...
  manual-extensions/
    slack-pi/
      index.ts
      package.json
      tsconfig.json
      README.md             # setup and local usage
  chrome-extensions/
    slack-pi/
      manifest.json
      package.json
      background.js
      content-script.js
      popup.html
      popup.js
```

### Why this layout
- `extensions/` is already auto-loaded by the root `package.json`
- `manual-extensions/` is **not** referenced by the root `pi.extensions` manifest
- the Slack extension can be launched explicitly with `pi -e ...`
- the Slack Pi pieces can live beside the main package without being auto-loaded
- separate local package boundaries keep future Slack-specific dependencies out of the root auto-loaded Pi package

---

## Launcher model

Use a dedicated shell function or script instead of auto-loading the Slack extension globally.

Example shape:

```sh
slack-pi() {
  pi -e ./manual-extensions/slack-pi/index.ts "$@"
}
```

### Launcher responsibilities
- load the Slack Pi extension explicitly
- keep normal `pi` usage untouched
- provide a stable mental model: **Slack tools only exist in `slack-pi`**

### Singleton enforcement
The Slack Pi extension should bind a **fixed localhost port**, for example:
- `ws://127.0.0.1:27183`

If the port is already in use:
- report that `slack-pi` is already running
- fail fast and exit

This is a deliberate design choice so there is exactly one Slack controller.

---

## High-level architecture

```text
+-----------------------+
| Chrome Slack Tab      |
| app.slack.com         |
+-----------+-----------+
            |
            | DOM read/write
            v
+-----------------------+
| Chrome Content Script |
+-----------+-----------+
            |
            | extension messaging
            v
+-----------------------+
| Chrome Background SW  |
+-----------+-----------+
            |
            | WebSocket
            v
+-----------------------+
| slack-pi Pi Extension |
| ws://127.0.0.1:27183  |
+-----------+-----------+
            |
            | tool calls / commands
            v
+-----------------------+
| Pi model workflow     |
+-----------------------+
```

---

## Component design

## 1. Pi extension (`manual-extensions/slack-pi/index.ts`)

### Responsibilities
- host the local WebSocket server
- maintain connection state for Chrome
- expose Slack-oriented tools to the LLM
- expose a few slash commands for status/debugging
- normalize Chrome-returned Slack data into clean LLM context
- support a read-only Slack integration plus manual copy/paste workflow

### Proposed slash commands
- `/slack-status`
  - show whether Chrome is connected
  - show last active Slack tab metadata if available
- `/slack-reconnect`
  - reset connection state if needed
- `/slack-ping`
  - round-trip test to Chrome

### Proposed tools

#### `slack_get_current_thread`
Read the currently open Slack thread from the active Slack tab.

**Behavior:**
- request thread data from Chrome
- only operate on the currently open thread pane in the MVP
- fail clearly if no thread pane is open
- include current Slack composer contents as additional context when non-empty
- normalize it into compact text for the model
- include structured details for rendering/debugging

There is no write-back tool in the MVP. Manual copy/paste is the intended workflow.

#### Optional later tool: `slack_get_selection`
Read only the currently selected message or visible root message rather than the full thread.

---

## 2. Chrome extension

### Manifest version
Use **Manifest V3**.

### Permissions
Keep permissions as narrow as possible.

Expected host permission:
- `https://app.slack.com/*`

Expected extension pieces:
- **content script** on Slack pages
- **background service worker** for WebSocket lifecycle and routing
- **minimal popup** for status, token setup/reset, and connection testing

### Background service worker responsibilities
- connect to the Pi WebSocket server
- reconnect when Pi starts/stops
- route requests between Pi and the Slack tab
- track which Slack tab is considered active
- apply the MVP active-tab rule:
  - if exactly one Slack tab exists, use it
  - if multiple Slack tabs exist, use the most recently focused one
  - if no Slack tab exists, report that no active Slack tab is available
- expose simple connection state for the popup

### Content script responsibilities
- read visible Slack message/thread DOM
- read current Slack composer contents when present
- normalize DOM fragments into structured data
- report whether the page is in a supported state

### MVP page scope
- read operations are limited to the currently open thread pane
- if no thread pane is open, read requests fail clearly
- top-level channel reads are out of scope for the MVP

---

## 3. Slack DOM adapter layer

The browser side should isolate Slack DOM handling into a small adapter instead of scattering selectors through the code.

### Responsibilities
- detect whether a thread pane is open
- extract:
  - workspace/team name if available
  - channel or DM title
  - permalink if discoverable
  - root message
  - replies
  - author labels
  - timestamps if available
  - current composer draft text if present
- normalize message text

### Design principle
Expect selectors to break eventually. Keep them centralized and easy to update.

---

## Connection and ownership model

## Why a singleton is acceptable
This design intentionally treats Slack control as a singleton because:
- there is one pinned Slack workflow
- only `slack-pi` should own Slack tools
- normal `pi` sessions should not compete for the browser

## Ownership rules
- `slack-pi` binds a fixed port and becomes the sole Slack controller
- Chrome always attempts to connect to that fixed endpoint
- if `slack-pi` is not running, Chrome reports **offline**
- normal `pi` sessions are unaffected because they do not load the Slack extension

## Expected behavior when Pi is not running
- Chrome extension remains installed and idle
- background worker attempts reconnect with backoff
- any popup/status UI shows `Pi offline`
- no tool-driven behavior is available until `slack-pi` starts

This is acceptable because the chosen UX is explicitly **Pi-only**, not always-on.

---

## WebSocket protocol

Use a simple JSON request/response protocol with explicit IDs.

## Envelope

```json
{
  "id": "req_123",
  "type": "request",
  "action": "getCurrentThread",
  "payload": {}
}
```

```json
{
  "id": "req_123",
  "type": "response",
  "ok": true,
  "payload": {}
}
```

```json
{
  "type": "event",
  "event": "status",
  "payload": {
    "connected": true
  }
}
```

## Initial handshake

### Chrome -> Pi
```json
{
  "type": "hello",
  "role": "chrome",
  "version": 1,
  "token": "shared-secret",
  "payload": {
    "extensionVersion": "0.1.0"
  }
}
```

### Pi -> Chrome
```json
{
  "type": "hello_ack",
  "role": "pi",
  "version": 1,
  "payload": {
    "instance": "slack-pi",
    "protocolVersion": 1
  }
}
```

## Initial request set

### `ping`
Health check.

### `getCurrentThread`
Ask Chrome for the current Slack thread.

#### Success response shape
```json
{
  "id": "req_1",
  "type": "response",
  "ok": true,
  "payload": {
    "workspace": "Acme",
    "channel": "eng",
    "title": "Thread in #eng",
    "url": "https://app.slack.com/...",
    "isThread": true,
    "rootMessage": {
      "author": "Alice",
      "text": "Can we ship this today?",
      "timestamp": "2026-04-14T10:15:00Z"
    },
    "messages": [
      {
        "author": "Alice",
        "text": "Can we ship this today?",
        "timestamp": "2026-04-14T10:15:00Z",
        "isRoot": true
      },
      {
        "author": "Bob",
        "text": "Blocked on final review.",
        "timestamp": "2026-04-14T10:18:00Z",
        "isRoot": false
      }
    ],
    "composerDraftText": "I can take the review this afternoon if that helps."
  }
}
```

### `insertReply`
Insert text into the active Slack composer.

#### Request
```json
{
  "id": "req_2",
  "type": "request",
  "action": "insertReply",
  "payload": {
    "text": "Draft reply text"
  }
}
```

## Error shape

```json
{
  "id": "req_3",
  "type": "response",
  "ok": false,
  "error": {
    "code": "composer_not_found",
    "message": "Could not locate the Slack reply composer"
  }
}
```

---

## Pi-facing data normalization

The LLM should not receive raw DOM output. Normalize the thread into a compact structured text block.

## Suggested normalization format

```text
Slack thread
Workspace: Acme
Channel: #eng
URL: https://app.slack.com/...

1. Alice (2026-04-14 10:15)
Can we ship this today?

2. Bob (2026-04-14 10:18)
Blocked on final review.

3. Carol (2026-04-14 10:21)
If review lands by noon, yes.

Current composer draft:
I can take the review this afternoon if that helps.
```

## Normalization rules
- preserve message order
- strip visual-only UI text
- keep author and timestamp when available
- keep line breaks inside message bodies
- if the Slack composer already has text, include it as a separate draft-context section
- treat composer draft text as user intent/context, not as the final reply
- truncate long threads safely if needed
- return structured `details` alongside the text form

## Truncation strategy
For long threads:
- keep enough context to understand the conversation
- include count of omitted messages
- prefer preserving the root message and most recent replies

---

## Tool UX design

## Typical user flow
1. Launch `slack-pi`
2. Open or focus the Slack thread in Chrome
3. Optionally start a rough draft in the Slack composer
4. Ask Pi something like:
   - `Read the current Slack thread and refine my draft into a concise reply.`
5. Pi calls `slack_get_current_thread`
6. Pi sees both the thread and any existing composer draft text
7. Pi drafts or refines a reply
8. You copy/paste the final reply into Slack
9. You review it and press send manually in the Slack UI

## Recommended safety model
- the browser integration is read-only in the MVP
- final copy/paste and send actions always happen manually in Slack UI

### Final-send policy
- Pi never triggers Slack send in the MVP
- the user always reviews and clicks send manually in Slack

---

## Security model

## Local-only transport
- bind WebSocket server to `127.0.0.1`
- do not listen on `0.0.0.0`

## Shared secret
Use a long-lived shared secret stored locally.

### Proposed setup
- secret stored outside the repo, for example in a user config file
- `slack-pi` reads it at startup and creates it on first run if missing
- Chrome extension gets the value once through the popup setup flow
- Chrome extension stores the same value in extension local storage/options after setup

## Browser restrictions
- only run content script on `https://app.slack.com/*`
- background worker should reject actions unless a matching Slack tab exists

## Final send policy
- Pi does not send Slack messages in the MVP
- the final send action always happens manually in the Slack UI

---

## Failure modes and recovery

## Pi not running
### Symptom
Chrome shows disconnected/offline.

### Recovery
Start `slack-pi`; Chrome reconnects automatically.

## Chrome not connected
### Symptom
Pi Slack tools fail with a clear message.

### Recovery
Open Slack in Chrome and wait for reconnect, or use `/slack-status`.

## Unsupported Slack page state
### Symptom
No thread open, or composer not found.

### Recovery
Prompt the user to open the target thread or channel and retry.

## Broken Slack selectors after UI changes
### Symptom
Read/insert tools begin failing.

### Recovery
Update the centralized DOM adapter selectors in the Chrome extension.

## Port already in use
### Symptom
A second `slack-pi` instance starts.

### Recovery
Fail fast with a clear singleton message.

---

## Configuration model

## Fixed values for MVP
- WebSocket URL: `ws://127.0.0.1:27183`
- protocol version: `1`
- single active Slack controller: yes

## Configurable values later if needed
- port
- reconnect backoff
- preferred active Slack tab behavior
- optional future write-back behavior if manual copy/paste is revisited

---

## Recommended implementation phases

## Phase 0: repo scaffolding
**Goal:** create the structure without affecting current package loading.

### Tasks
- create `manual-extensions/slack-pi/`
- create `chrome-extensions/slack-pi/`
- add local README/setup notes
- create separate local package boundaries for Slack Pi code
- keep root typechecking wired through `npm run check`

### Deliverable
Repo structure exists, does not auto-load the Slack extension, and keeps Slack-specific dependencies out of the root package.

---

## Phase 1: Pi-side connection skeleton
**Goal:** make `slack-pi` launchable and expose connection status.

### Tasks
- implement Pi extension entrypoint
- start WebSocket server on fixed port
- reject startup if port is already bound
- implement shared-secret handshake
- track Chrome connection status in memory
- add `/slack-status` and `/slack-ping`

### Acceptance criteria
- `slack-pi` starts cleanly
- second `slack-pi` instance fails clearly
- `/slack-status` reports disconnected/connected accurately
- Chrome can authenticate and complete handshake

---

## Phase 2: Chrome extension connection skeleton
**Goal:** connect Chrome to Pi and identify an active Slack tab.

### Tasks
- create MV3 manifest
- implement background service worker
- open WebSocket to Pi with reconnect logic
- register content script on Slack pages
- surface connection status, token setup/reset, and a test action in the minimal popup

### Acceptance criteria
- background worker reconnects automatically
- Pi sees Chrome connection events
- `/slack-ping` performs a full round trip

---

## Phase 3: Read current thread and existing draft
**Goal:** support `slack_get_current_thread` end to end.

### Tasks
- implement Slack DOM adapter for thread extraction
- extract current composer draft text when present
- define normalized thread payload shape
- implement Pi tool `slack_get_current_thread`
- normalize tool output for LLM consumption
- add truncation/formatting for long threads

### Acceptance criteria
- Pi can read the currently open Slack thread
- output includes workspace/channel/url when available
- existing composer text is included as separate context when present
- errors are clear when no thread is open or selectors fail

---

## Phase 4: polish and hardening
**Goal:** make the integration pleasant and resilient.

### Tasks
- improve Slack text normalization
- improve diagnostics in `/slack-status`
- add helpful empty-state guidance
- add better composer mode detection
- document setup and troubleshooting
- add tests where practical for message protocol and normalization logic

### Acceptance criteria
- common failures are easy to diagnose
- day-to-day usage feels predictable
- docs are sufficient to reinstall from scratch

---

## Suggested MVP scope

The MVP should include only:
- `slack-pi` launcher
- fixed-port singleton WebSocket server
- Chrome extension with reconnect logic
- minimal Chrome popup for status/setup/testing
- `slack_get_current_thread`
- `/slack-read`
- `/slack-status`

Everything else is optional.

---

## Testing strategy

## Manual test cases

### Connection
- start `slack-pi`
- verify Chrome connects
- close `slack-pi`
- verify Chrome reports offline
- attempt second `slack-pi` launch and verify singleton enforcement

### Read thread
- open thread in Slack
- ask Pi to read it
- verify author/text ordering
- verify existing composer text is included when present
- test on DM and channel thread if possible
- test with no thread open

### Manual copy/paste workflow
- ask Pi to produce a generated draft after `/slack-read`
- verify the draft is easy to copy/paste into Slack manually
- verify existing composer text can still be used as context without any browser-side write-back

### Error handling
- disconnect Chrome
- reload Slack tab
- change focus between multiple Slack tabs
- verify meaningful error messages

---

## Resolved MVP decisions

1. **Active tab selection**
   - If exactly one `app.slack.com` tab exists, use it.
   - If multiple Slack tabs exist, use the most recently focused one.
   - If no Slack tab exists, fail clearly.

2. **Reply workflow**
   - Manual copy/paste is the MVP workflow.
   - Do not implement browser-side reply insertion in the MVP.

3. **Thread extraction scope**
   - Read only the currently open thread pane in the MVP.
   - If no thread pane is open, fail clearly.
   - Top-level channel reads can be added later as a separate tool.

4. **Token/setup UX**
   - Use a one-time setup flow.
   - `slack-pi` creates or reads a local shared secret.
   - The Chrome popup accepts that secret once and stores it locally.

5. **Popup UI**
   - Include a minimal popup in v1.
   - It should show connection status, active Slack tab state, token entry/reset, and a simple test action.

6. **Existing composer draft context**
   - If the Slack composer already contains text, include it in read results as additional draft context.
   - Pi should treat that text as user intent/context, not as the final message.

7. **Final send behavior**
   - Pi never sends the Slack message.
   - The user always presses send manually in the Slack UI.

8. **Singleton behavior**
   - If the fixed port is already in use, the second `slack-pi` instance fails fast and exits.

---

## Recommended next steps

1. Create the directories under:
   - `manual-extensions/slack-pi/`
   - `chrome-extensions/slack-pi/`
2. Implement **Phase 1** and **Phase 2** only
3. Prove the WebSocket handshake and singleton behavior
4. Then build `slack_get_current_thread` before any write action

That order gives the best feedback loop with the least risk.
