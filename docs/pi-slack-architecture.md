# Pi Slack Architecture

## Overview

`pi-slack` is a repo-local Slack assistant built from two cooperating pieces:

- a dedicated Pi extension at `manual-extensions/pi-slack`
- a Chrome extension at `chrome-extensions/pi-slack`

The integration is intentionally opt-in. Normal `pi` sessions do not load any Slack tooling. Slack support only exists when the user launches Pi through `bin/pi-slack`.

The system is read-only with respect to Slack itself. It reads Slack threads and channel message ranges from the Slack web UI, feeds normalized text into Pi, and lets Pi draft replies or summaries for manual copy/paste.

## What exists today

The current implementation provides:

- a dedicated `pi-slack` launcher with a fixed session directory
- a local WebSocket bridge on `127.0.0.1` using a session-specific port by default
- session pairing via a one-session pairing code shown by Pi
- manual and automatic pairing rotation to reduce stale pairing lifetime
- nonce/HMAC handshake between Chrome and Pi after pairing
- a Slack-specific Pi system prompt and restricted tool set
- explicit Chrome-side approval before each Slack read request
- `slack_read_thread` for the currently open Slack thread
- `slack_read_channel` for channel reads starting from a Slack permalink
- paginated channel summarization with optional thread expansion
- Chrome popup status, pairing setup, and approval window access
- DOM-based extraction of Slack threads, composer draft text, and channel message ranges

The current implementation does **not** provide:

- browser-side message insertion
- automatic sending in Slack
- a workspace-installed Slack app
- a standalone always-on daemon
- long-lived Chrome-side credentials for Slack reads

## Repository layout

```text
pi-squared/
  bin/
    pi-slack
  docs/
    pi-slack-architecture.md
  manual-extensions/
    pi-slack/
      index.ts
      package.json
      tsconfig.json
      README.md
  chrome-extensions/
    pi-slack/
      manifest.json
      background.js
      content-script.js
      popup.html
      popup.js
      approve.html
      approve.js
      README.md
      package.json
```

This layout keeps the Slack integration out of the repo's auto-loaded `extensions/` path. The Pi side is only loaded explicitly through the launcher.

## Runtime architecture

```text
+-----------------------+
| Chrome Slack Tab      |
| app.slack.com / *.slack.com |
+-----------+-----------+
            |
            | DOM inspection
            v
+-----------------------+
| Content Script        |
| content-script.js     |
+-----------+-----------+
            |
            | chrome.runtime messaging
            v
+-----------------------+
| Background SW         |
| background.js         |
+-----------+-----------+
            |
            | WebSocket + pairing + approval gate
            v
+-----------------------+
| Pi Slack Extension    |
| manual-extensions/... |
+-----------+-----------+
            |
            | tools + commands
            v
+-----------------------+
| Pi model session      |
+-----------------------+
```

## Launcher model

`bin/pi-slack` is the supported entrypoint.

It is responsible for:

- locating `manual-extensions/pi-slack/index.ts`
- verifying that `pi` is installed
- verifying that `manual-extensions/pi-slack/node_modules` exists
- forcing a dedicated session directory
- launching Pi with the Slack extension explicitly enabled

Default session directory:

```text
$HOME/.pi/agent/sessions/--pi-slack--
```

Override:

- `PI_SLACK_SESSION_DIR`

This gives `pi-slack` stable session storage independent of the current working directory.

### Trust boundary

The launcher passes any extra arguments verbatim to `pi` via `"$@"`. An additional `-e` flag (e.g. `pi-slack -e /tmp/x.ts`) would load a second extension alongside the Slack extension. That extension runs with full Node.js access and could inspect live bridge state or reveal the current pairing code. Only use extra `-e` flags with extensions you fully trust. This is not a supported usage and is outside the normal operating model.

## Pi extension architecture

File: `manual-extensions/pi-slack/index.ts`

### Responsibilities

The Pi extension owns the local bridge and defines the Slack-facing Pi behavior.

It:

- starts the WebSocket server
- generates a fresh session id and session secret on startup
- binds to a session-specific localhost port by default
- exposes a pairing code for the current live session
- authenticates the Chrome extension handshake using nonce/HMAC proof exchange
- tracks the active Chrome connection for this Pi Slack session
- exposes Slack read tools and commands to Pi
- rewrites the system prompt so the session behaves as a Slack communications assistant rather than a coding agent
- renames the session based on the Slack context that was read

### Startup and shutdown

On session start, the extension:

- ensures the WebSocket bridge is listening
- fails the session early if the bridge cannot start
- restricts active tools to:
  - `slack_read_thread`
  - `slack_read_channel`
- sets a default session name of `Pi Slack` if none exists
- shows the bridge endpoint and reminds the user to reveal the pairing code for Chrome setup

On shutdown, it:

- closes the WebSocket server
- disconnects Chrome
- clears the active pairing code
- rejects any pending requests

### Bridge defaults

Default values in the implementation:

- host: `127.0.0.1`
- port: OS-assigned ephemeral port by default
- protocol version: `1`
- hello timeout: 5 seconds
- approval timeout: 60 seconds
- request timeout buffer: 5 seconds
- default execution timeout: 10 seconds
- thread execution timeout: 20 seconds
- bounded channel range execution timeout: 60 seconds
- paginated channel range execution timeout: 180 seconds
- automatic pairing rotation after Chrome disconnect grace period: 10 minutes
- total Pi-side wait budget for default requests: 75 seconds
- total Pi-side wait budget for thread reads: 85 seconds
- total Pi-side wait budget for bounded channel reads: 125 seconds
- total Pi-side wait budget for paginated channel reads: 245 seconds

Overrides:

- `PI_SLACK_PORT` — bind to a fixed port instead of a session-specific ephemeral one
- `PI_SLACK_ALLOW_NO_ORIGIN=1` — allow no-origin clients for manual debugging; by default `chrome-extension://` origin is required
- `PI_SLACK_PAIRING_ROTATE_AFTER_DISCONNECT_MS` — override the post-disconnect pairing rotation grace period; `0` disables automatic rotation

### Commands

The extension currently registers these commands:

- `/slack-status`
- `/slack-status --show-pairing`
- `/slack-status --show-token` — compatibility alias for `--show-pairing`
- `/slack-rotate-pairing`
- `/slack-ping`
- `/slack-read-thread`
- `/slack-read-channel <start-url> [--next N] [--until <end-url>] [--max N] [--no-threads]`
- `/slack-debug-thread-scan`
- `/slack-debug-channel-scan`

`/slack-read-thread` and `/slack-read-channel` inject a visible `slack-read` message into the session, using a custom renderer in the TUI.

### Pairing

Chrome does not persist a long-lived shared secret.

Instead, each live `pi-slack` session creates:

- a session id
- a session secret
- a session-specific bridge URL
- a pairing code that encodes those values for the current session only

The pairing code is revealed from Pi with:

```text
/slack-status --show-pairing
```

The user pastes that code into the Chrome popup. Chrome stores it in `chrome.storage.session`, not `chrome.storage.local`, so the pairing is session-scoped rather than a long-lived browser secret.

### Tools

#### `slack_read_thread`

Reads the currently open Slack thread from the active Slack tab.

Returned context includes:

- workspace name if available
- channel name if available
- page title
- current Slack URL
- ordered thread messages
- root message
- existing composer draft text when present
- extraction metadata such as reported message count and whether scrolling was needed

#### `slack_read_channel`

Reads channel messages starting from a Slack permalink.

It supports two modes:

- bounded mode via `limit`
- paginated mode when `limit` is omitted

Parameters:

- `startUrl` required
- `limit` optional bounded read size
- `endUrl` optional inclusive stop permalink
- `maxMessages` optional cap for paginated mode
- `includeThreads` optional, defaults to true in paginated mode

Paginated mode returns a larger, summary-oriented snapshot and can expand thread replies for channel messages that have replies.

## Chrome extension architecture

Files:

- `chrome-extensions/pi-slack/manifest.json`
- `chrome-extensions/pi-slack/background.js`
- `chrome-extensions/pi-slack/content-script.js`
- `chrome-extensions/pi-slack/popup.html`
- `chrome-extensions/pi-slack/popup.js`
- `chrome-extensions/pi-slack/approve.html`
- `chrome-extensions/pi-slack/approve.js`

### Manifest and permissions

The extension uses Manifest V3.

Permissions:

- `storage`
- `tabs`
- `scripting`
- `alarms` — used for the alarm-based heartbeat and reconnect scheduler so both survive MV3 service worker eviction

Host permissions:

- `https://app.slack.com/*`
- `https://*.slack.com/*`

The broad host-permission pattern exists because Slack permalinks and browser fallback flows may use workspace-specific hosts. Content scripts are auto-injected only on `https://app.slack.com/*`; non-`app.slack.com` tabs are covered on demand via `chrome.scripting.executeScript` in `ensureContentScriptLoaded`.

### Background service worker

The background worker is the bridge between Pi and Slack tabs.

It is responsible for:

- maintaining the authenticated WebSocket connection to the currently paired Pi Slack session
- reconnecting automatically when Pi is unavailable or restarted
- sending heartbeat events every 20 seconds once authenticated
- routing `getCurrentThread`, `getChannelRange`, and `getChannelRangeAll` requests
- tracking Slack tabs and picking the active one for current-thread reads
- opening temporary Slack tabs for permalink-based channel reads
- restoring the previously active tab after temporary foreground work
- exposing pairing, status, and approval flows to the popup
- updating the extension action icon color for connection state and pending approvals

Connection state is stored in the background service worker, including:

- socket lifecycle
- pairing payload for the current Pi session
- handshake nonce state
- hello/challenge/ack timestamps
- ping/pong timestamps
- pending approval requests
- last error

### Pairing and authentication

Chrome does not auto-authenticate to a fixed port with a long-lived token.

Instead:

1. the user pastes a Pi-generated pairing code into the popup
2. the background worker stores that pairing in `chrome.storage.session`
3. Chrome connects to the session-specific bridge URL from the pairing code
4. Chrome sends `client_hello` with the session id and a client nonce
5. Pi responds with `server_challenge` carrying a server nonce
6. Chrome responds with `client_proof`, an HMAC over protocol version, session id, both nonces, and the role label
7. Pi validates that proof and returns `hello_ack` containing its own HMAC proof
8. Chrome verifies the server proof before marking the bridge authenticated

This removes the previous behavior where Chrome sent a long-lived secret as the first WebSocket message.

### Approval gate

Every Slack read request from Pi requires explicit approval in Chrome before the browser will execute it, unless a short-lived in-memory approval policy is active for a low-scope current-thread read.

Applies to:

- `getCurrentThread`
- `getChannelRange`
- `getChannelRangeAll`
- debug scans

Approval flow:

1. Pi sends a request over the authenticated bridge
2. the background worker classifies the request by scope/risk
3. if a matching temporary approval policy exists for a low-scope current-thread read, Chrome auto-approves it in memory
4. otherwise the background worker creates a pending approval entry
5. Chrome opens or focuses `approve.html`
6. the user chooses **Allow once** or **Deny**
7. for low-scope current-thread reads only, the user may also choose **Allow for 5 min** or **Allow for session**
8. only after approval does the background worker read Slack DOM state and return the result

High-scope reads such as paginated channel summaries remain one-time approvals and are never auto-approved.

If the user denies the request, Chrome returns a structured error such as `user_denied`. If the user never responds, Chrome returns `approval_timeout`. Once approval is granted, Chrome applies a separate execution timeout for the actual Slack read and returns `execution_timeout` if that phase runs too long.

### Active Slack tab selection

For current-thread reads, the background worker queries all Slack tabs and sorts them by `lastAccessed`.

Selection rule:

- if one Slack tab exists, use it
- if multiple Slack tabs exist, use the most recently focused one
- if no Slack tab exists, return a clear error

### Temporary-tab channel reads

Channel permalink reads are performed in a temporary Slack tab.

The background worker:

1. rewrites the input URL into a browser-safe Slack web URL when needed
2. opens a temporary Slack tab in the foreground
3. waits for the page to load
4. asks the content script to prepare the page if Slack shows an app-to-browser handoff screen
5. waits for Chrome approval if the read has not already been approved
6. harvests the requested channel messages
7. optionally paginates through more messages
8. optionally revisits thread URLs in the same temporary tab to expand replies for summary mode
9. closes the temporary tab
10. restores the previously active tab context

This means permalink reads are not purely hidden background work; they temporarily take foreground focus and then restore it.

### Popup

The popup is intentionally minimal.

It supports:

- viewing bridge status
- entering and saving the current session pairing code
- resetting the stored pairing
- opening the approval window
- clearing temporary approval policies
- running a simple connection test

Developer-oriented extractor diagnostics are exposed through Pi commands rather than the popup:

- `/slack-debug-thread-scan`
- `/slack-debug-channel-scan`

The pairing is stored in `chrome.storage.session`, not `chrome.storage.local`, so it is scoped to the current browser session and live Pi Slack session.

### Extractor debug scans

For live diagnosis of Slack DOM drift, Pi can request lightweight debug scans from Chrome.

Chrome supports two debug actions:

- current thread debug scan
- current channel debug scan

These scans return structured diagnostics such as:

- chosen root selector
- candidate and filtered row counts
- permalink and `messageTs` coverage
- fallback text extraction count
- author backfill count
- a few sample extracted rows with short text previews

They are intended for debugging extractor behavior, not for normal summarization. Like other browser reads, they still require Chrome-side approval.

### Approval window

`approve.html` is a dedicated extension page for request approval.

It shows:

- each pending Slack read request
- a concise summary of what will be read
- request risk/scope labels such as low, medium, and high scope
- timing metadata such as request age and timeout
- **Allow once** and **Deny** controls for all requests
- **Allow for 5 min** and **Allow for session** controls for low-scope current-thread reads only
- currently active temporary approval policies with a reset control

The extension action icon turns yellow and shows a badge count while approvals are pending.

## Slack DOM extraction architecture

File: `chrome-extensions/pi-slack/content-script.js`

The content script is a heuristic DOM adapter for the Slack web UI. It isolates Slack-specific selectors and extraction behavior from the rest of the system.

### General approach

The script:

- locates either the thread pane or the main channel view
- finds visible message containers
- extracts author, timestamp, permalink, text, and reply count
- finds the active composer when present
- scrolls virtualized Slack lists to collect messages that are not currently rendered
- backfills missing authors for grouped Slack message rows
- normalizes text to remove UI noise and zero-width characters

### Thread extraction

For `getCurrentThread`, the script:

- finds a visible thread pane
- finds the thread composer, if present
- extracts the composer draft text
- scrolls the virtualized thread list from top to bottom to harvest all visible thread messages it can collect
- returns the first collected message as the root message
- reports whether scrolling-based harvesting was used

If no thread pane is open, it returns `no_thread_open`.

### Channel range extraction

For permalink-based channel reads, the script:

- parses `message_ts` from the start URL
- optionally parses an end URL
- waits for the main channel root to be ready
- scans messages until it reaches the start boundary
- keeps collecting until the end permalink or limit is reached
- returns a pagination cursor based on the last message timestamp when the limit is hit

To improve author continuity, it scrolls slightly upward before collection so that grouped messages after the start point can inherit the previous author when Slack omits repeated sender labels.

### Browser fallback preparation

Slack sometimes lands on pages that prompt the user to continue in the browser.

The content script includes a preparation step that can:

- report that the page is already ready
- navigate to a browser-safe URL
- click a visible browser fallback control
- report that the page is still unready

This preparation loop is what makes workspace-host permalinks and app handoff pages usable from the bridge.

## End-to-end data flows

### Pairing and connection

1. User launches `pi-slack`
2. Pi extension starts the local bridge on a session-specific port
3. User runs `/slack-status --show-pairing`
4. User pastes the pairing code into the Chrome popup
5. Chrome connects to the bridge URL from that pairing code
6. Chrome and Pi complete the nonce/HMAC handshake
7. The extension action icon turns green once authenticated

### Current thread read

1. User asks Pi to read the current Slack thread
2. Pi calls `slack_read_thread`
3. Pi extension sends `getCurrentThread` over WebSocket
4. Chrome opens or focuses the approval window
5. User approves the request in Chrome
6. Background worker routes the request to the active Slack tab
7. Content script extracts the thread and composer draft
8. Data flows back to Pi
9. Pi normalizes the thread for model context and uses it to draft or refine a reply

### Bounded channel range read

1. User provides a Slack message permalink and a bounded request such as "next 20 messages"
2. Pi calls `slack_read_channel` with `startUrl` and `limit`
3. Pi extension sends `getChannelRange`
4. Chrome asks for approval
5. After approval, the background worker opens a temporary Slack tab and prepares it
6. Content script collects messages from the start permalink onward
7. Background worker closes the temporary tab and returns the payload
8. Pi formats the range into compact model-readable text

### Paginated channel summarization

1. User provides a Slack permalink and asks for a summary
2. Pi calls `slack_read_channel` without `limit`
3. Pi extension sends `getChannelRangeAll`
4. Chrome asks for approval
5. After approval, the background worker repeatedly collects pages of messages using a cursor
6. If thread expansion is enabled, the background worker revisits selected thread roots in the same temporary tab and attaches thread snapshots to the corresponding channel messages
7. Pi formats the full result into a summary-oriented text block with optional nested thread replies

## WebSocket protocol

The bridge uses a simple JSON protocol.

Message categories:

- `client_hello`
- `server_challenge`
- `client_proof`
- `hello_ack`
- `request`
- `response`
- `event`

### Handshake

Chrome sends:

- role `chrome`
- protocol version `1`
- session id
- client nonce
- extension version

Pi validates the protocol version and session id, then returns `server_challenge` with:

- role `pi`
- session id
- server nonce
- instance `pi-slack`
- protocol version `1`

Chrome then sends `client_proof`, which is an HMAC over:

- protocol version
- session id
- client nonce
- server nonce
- role label `chrome`

Pi validates that HMAC with the session secret, then returns `hello_ack` containing:

- role `pi`
- protocol version `1`
- session id
- server proof HMAC over the same fields but with role label `pi`

Chrome verifies the server proof before treating the bridge as authenticated.

Only one authenticated Chrome connection is kept active at a time per Pi Slack session. A newer valid Chrome connection replaces the previous one.

### Requests currently implemented

- `ping`
- `getCurrentThread`
- `getChannelRange`
- `getChannelRangeAll`

### Cancellation

When Pi's request timeout fires it sends a Pi→Chrome message:

```json
{ "type": "cancel", "id": "<request-uuid>" }
```

Chrome looks up the matching `AbortController` in `pendingAbortControllers` and calls `.abort()`. Pagination loops and thread-expansion loops check the signal between iterations and bail early, still closing the temporary tab and restoring the active tab context.

If a request is still waiting for user approval when cancellation arrives, Chrome removes the pending approval and rejects it.

### Events

Chrome currently emits heartbeat events. Pi accepts them but does not currently surface them as a higher-level feature.

### Errors

Responses use a structured error shape with a code and message. Common error codes include:

- `no_active_slack_tab`
- `no_thread_open`
- `thread_read_failed`
- `invalid_start_url`
- `invalid_end_url`
- `start_message_not_found`
- `no_channel_messages`
- `missing_team_id`
- `content_script_unavailable`
- `user_denied`
- `approval_timeout`
- `approval_cancelled`
- `execution_timeout`

## Model-facing normalization

The Pi extension does not pass raw DOM fragments to the model.

Instead, it formats Slack data into compact text blocks such as:

- `Slack thread`
- `Slack channel range`
- `Slack channel summary`

Formatting includes:

- workspace, channel, title, and URLs when available
- numbered messages in order
- timestamps and author names when available
- composer draft text as a separate section for thread reads
- omission notices when content must be trimmed to fit context
- nested thread reply formatting for summary mode when thread expansion succeeded

### Context budgeting

The extension computes approximate character budgets from the current model context window and current token usage.

The budgeting logic tries to:

- always preserve the root message
- preserve early thread context
- preserve recent context from the end
- condense larger channel summaries when necessary

## Session behavior

Launching through `pi-slack` changes Pi from a coding assistant into a Slack reply assistant.

The custom system prompt emphasizes:

- concise, direct, technically precise replies
- using Slack tools when thread or channel context is needed
- treating existing composer text as user intent, not as already-sent content
- never claiming to have sent or inserted a Slack message
- producing Slack-ready output for manual copy/paste

Session names are also updated from read results so saved sessions are easier to identify in history.

## Security and ownership model

### Browser origin enforcement

The WebSocket server uses `verifyClient` to require a `chrome-extension://` origin by default. No-origin clients (CLI tools, `wscat`) are rejected unless the user explicitly sets `PI_SLACK_ALLOW_NO_ORIGIN=1` for manual debugging. This is a defense-in-depth measure on top of session pairing and the nonce/HMAC handshake.

### Session pairing

Authentication is scoped to a live Pi Slack session.

- Pi generates a fresh session id and session secret at startup
- Pi exposes those through a pairing code for the current session only
- Chrome stores the pairing in `chrome.storage.session`
- Chrome proves knowledge of the session secret without sending it as plaintext in the first message
- Pi can rotate the pairing on demand with `/slack-rotate-pairing`
- Pi also rotates the pairing automatically after a configurable grace period if Chrome disconnects and does not return
- Chrome invalidates stale pairing state when the Pi side rejects the current session as rotated or mismatched

This means pairing must be repeated for each new `pi-slack` session and after pairing rotation.

### Approval gate

The browser will not silently process Slack read requests.

Before Chrome reads:

- the current thread
- a bounded channel range
- a paginated channel span

…the user must explicitly approve the request in Chrome.

This changes the failure mode of a mistaken or malicious local peer from silent Slack extraction to a visible approval prompt that the user can deny.

### Prompt injection

Slack message bodies are untrusted third-party content and are wrapped in fresh nonce-based delimiters in every model-facing text block, using lines that start with `BEGIN_UNTRUSTED_SLACK_...` and the matching `END_UNTRUSTED_SLACK_...`. The system prompt instructs the model to treat anything inside those matching delimiters as data, never as instructions, and to ignore delimiter-looking text inside the region unless it is the exact outer matching delimiter line. Composer draft text receives the same treatment. This is a structural mitigation, not a guarantee — outputs should be reviewed before use.

### Local-only bridge

The WebSocket server binds to `127.0.0.1`, not `0.0.0.0`.

### Manual-send policy

The integration is intentionally read-only with respect to Slack message sending.

Pi can:

- read Slack context
- summarize it
- draft replies

Pi cannot:

- insert text into the Slack composer
- press send
- operate as an autonomous Slack bot

## Current limitations

The current implementation is usable, but still intentionally conservative.

Known limitations:

- Slack extraction depends on heuristic DOM selectors and may need maintenance when Slack changes its UI
- current-thread reads require an already open thread pane
- permalink-based reads temporarily open a foreground Slack tab
- every Slack read requires explicit approval in Chrome, which adds user friction by design
- pairing is per live Pi Slack session rather than a persistent setup step
- no browser-side write-back exists
- no workspace app or Slack API integration exists
- channel and thread extraction are best-effort against a virtualized DOM, not a first-party message API
- Slack content is untrusted and prompt-injection-capable; structural delimiters and a system-prompt instruction are the current mitigations, not guarantees
- localhost WebSockets are still a local IPC compromise compared with native messaging; the hardened handshake and approval gate improve safety, but do not turn the bridge into a full OS-authenticated channel

## Summary

The current `pi-slack` architecture is a local, read-only Slack assistant with explicit per-request browser approval:

- `bin/pi-slack` launches a dedicated Pi session
- the Pi extension owns a localhost WebSocket bridge for the current session
- the Pi extension generates a session pairing code and authenticates Chrome with nonce/HMAC proof exchange
- the Chrome extension reads Slack DOM state only after the user explicitly approves each request
- current-thread and permalink-based channel reads are normalized into model-friendly text
- Pi uses that context to produce replies and summaries for manual copy/paste back into Slack
