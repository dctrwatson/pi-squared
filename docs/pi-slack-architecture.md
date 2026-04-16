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
- a singleton local WebSocket bridge on `127.0.0.1:27183` by default
- shared-secret authentication between Pi and Chrome
- a Slack-specific Pi system prompt and restricted tool set
- `slack_read_thread` for the currently open Slack thread
- `slack_read_channel` for channel reads starting from a Slack permalink
- paginated channel summarization with optional thread expansion
- Chrome popup status and token setup
- DOM-based extraction of Slack threads, composer draft text, and channel message ranges

The current implementation does **not** provide:

- browser-side message insertion
- automatic sending in Slack
- a workspace-installed Slack app
- a standalone always-on daemon

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
            | WebSocket + shared secret
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

## Pi extension architecture

File: `manual-extensions/pi-slack/index.ts`

### Responsibilities

The Pi extension owns the local bridge and defines the Slack-facing Pi behavior.

It:

- starts the WebSocket server
- enforces singleton ownership through a fixed localhost port
- creates or loads the shared secret token
- authenticates the Chrome extension handshake
- tracks the active Chrome connection
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

On shutdown, it:

- closes the WebSocket server
- disconnects Chrome
- rejects any pending requests

### Bridge defaults

Default values in the implementation:

- host: `127.0.0.1`
- port: `27183`
- protocol version: `1`
- hello timeout: 5 seconds
- default request timeout: 10 seconds
- thread read timeout: 20 seconds
- bounded channel range timeout: 60 seconds
- paginated channel range timeout: 180 seconds

Overrides:

- `PI_SLACK_PORT`
- `PI_SLACK_TOKEN_FILE`

Default token file:

```text
~/.config/pi-slack/token
```

If the token file does not exist, the extension creates one and writes it with mode `0600`.

### Commands

The extension currently registers these commands:

- `/slack-status`
- `/slack-status --show-token`
- `/slack-ping`
- `/slack-read-thread`
- `/slack-read-channel <start-url> [--next N] [--until <end-url>] [--max N] [--no-threads]`

`/slack-read-thread` and `/slack-read-channel` inject a visible `slack-read` message into the session, using a custom renderer in the TUI.

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

### Manifest and permissions

The extension uses Manifest V3.

Permissions:

- `storage`
- `tabs`
- `scripting`

Host permissions:

- `https://app.slack.com/*`
- `https://*.slack.com/*`

The second pattern exists because Slack permalinks and browser fallback flows may use workspace-specific Slack hosts in addition to `app.slack.com`.

### Background service worker

The background worker is the bridge between Pi and Slack tabs.

It is responsible for:

- maintaining the authenticated WebSocket connection to Pi
- reconnecting automatically when Pi is unavailable or restarted
- sending heartbeat events every 20 seconds once authenticated
- routing `getCurrentThread`, `getChannelRange`, and `getChannelRangeAll` requests
- tracking Slack tabs and picking the active one for current-thread reads
- opening temporary Slack tabs for permalink-based channel reads
- restoring the previously active tab after temporary foreground work
- exposing status and token setup flows to the popup
- updating the extension action icon color for connection state

Connection state is stored in the background service worker, including:

- socket lifecycle
- hello/ack timestamps
- ping/pong timestamps
- last error

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
5. harvests the requested channel messages
6. optionally paginates through more messages
7. optionally revisits thread URLs in the same temporary tab to expand replies for summary mode
8. closes the temporary tab
9. restores the previously active tab context

This means permalink reads are not purely hidden background work; they temporarily take foreground focus and then restore it.

### Popup

The popup is intentionally minimal.

It supports:

- viewing bridge status
- entering and saving the shared secret token
- resetting the stored token
- running a simple connection test

The token is stored in `chrome.storage.local` under `piSlackToken`.

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

### Current thread read

1. User launches `pi-slack`
2. Pi extension starts the local bridge
3. Chrome background connects and authenticates with the shared secret
4. User asks Pi to read the current Slack thread
5. Pi calls `slack_read_thread`
6. Pi extension sends `getCurrentThread` over WebSocket
7. Background worker routes the request to the active Slack tab
8. Content script extracts the thread and composer draft
9. Data flows back to Pi
10. Pi normalizes the thread for model context and uses it to draft or refine a reply

### Bounded channel range read

1. User provides a Slack message permalink and a bounded request such as "next 20 messages"
2. Pi calls `slack_read_channel` with `startUrl` and `limit`
3. Pi extension sends `getChannelRange`
4. Background worker opens a temporary Slack tab and prepares it
5. Content script collects messages from the start permalink onward
6. Background worker closes the temporary tab and returns the payload
7. Pi formats the range into compact model-readable text

### Paginated channel summarization

1. User provides a Slack permalink and asks for a summary
2. Pi calls `slack_read_channel` without `limit`
3. Pi extension sends `getChannelRangeAll`
4. Background worker repeatedly collects pages of messages using a cursor
5. If thread expansion is enabled, the background worker revisits selected thread roots in the same temporary tab and attaches thread snapshots to the corresponding channel messages
6. Pi formats the full result into a summary-oriented text block with optional nested thread replies

## WebSocket protocol

The bridge uses a simple JSON protocol.

Message categories:

- `hello`
- `hello_ack`
- `request`
- `response`
- `event`

### Handshake

Chrome sends:

- role `chrome`
- protocol version `1`
- shared secret token
- extension version

Pi validates the token and protocol version, then returns `hello_ack` with:

- role `pi`
- instance `pi-slack`
- protocol version `1`

Only one authenticated Chrome connection is kept active at a time. A newer valid Chrome connection replaces the previous one.

### Requests currently implemented

- `ping`
- `getCurrentThread`
- `getChannelRange`
- `getChannelRangeAll`

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

### Local-only bridge

The WebSocket server binds to `127.0.0.1`, not `0.0.0.0`.

### Shared secret

Authentication is based on a locally stored shared secret.

- Pi stores the token in a local file
- Chrome stores the token in extension local storage
- every connection must send the correct token in the hello message

### Singleton ownership

The Pi extension owns a fixed localhost port. If the port is already in use, startup fails and `pi-slack` exits.

This is the mechanism that makes `pi-slack` a single-controller integration.

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
- no browser-side write-back exists
- no workspace app or Slack API integration exists
- channel and thread extraction are best-effort against a virtualized DOM, not a first-party message API

## Summary

The current `pi-slack` architecture is a local, singleton, read-only Slack assistant:

- `bin/pi-slack` launches a dedicated Pi session
- the Pi extension owns a localhost WebSocket bridge and Slack-specific tooling
- the Chrome extension authenticates to that bridge and reads Slack DOM state
- current-thread and permalink-based channel reads are normalized into model-friendly text
- Pi uses that context to produce replies and summaries for manual copy/paste back into Slack
