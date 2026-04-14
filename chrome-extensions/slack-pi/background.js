const SLACK_PI_PORT = 27183;
const SLACK_PI_WS_URL = `ws://127.0.0.1:${SLACK_PI_PORT}`;
const TOKEN_KEY = "slackPiToken";
const PROTOCOL_VERSION = 1;
const RECONNECT_DELAY_MS = 2_000;

const state = {
  socket: null,
  socketState: "idle",
  connected: false,
  authenticated: false,
  reconnectTimer: null,
  lastError: "",
  lastHelloSentAt: 0,
  lastHelloAckAt: 0,
  lastPingAt: 0,
  lastPongAt: 0,
};

chrome.runtime.onInstalled.addListener(() => {
  console.log("[slack-pi] background installed");
  void ensureConnected();
});

chrome.runtime.onStartup.addListener(() => {
  void ensureConnected();
});

async function getToken() {
  const result = await chrome.storage.local.get(TOKEN_KEY);
  return typeof result[TOKEN_KEY] === "string" ? result[TOKEN_KEY] : "";
}

function clearReconnectTimer() {
  if (state.reconnectTimer !== null) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
}

function resetSocketState() {
  state.socket = null;
  state.socketState = "idle";
  state.connected = false;
  state.authenticated = false;
}

function closeSocket() {
  if (!state.socket) return;
  try {
    state.socket.close();
  } catch {
    // ignore
  }
  resetSocketState();
}

async function scheduleReconnect() {
  clearReconnectTimer();

  const token = await getToken();
  if (!token) return;

  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    void ensureConnected();
  }, RECONNECT_DELAY_MS);
}

function sendJson(socket, message) {
  socket.send(JSON.stringify(message));
}

class BridgeActionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BridgeActionError";
    this.code = code;
  }
}

function sendSocketResponse(socket, id, response) {
  sendJson(socket, {
    id,
    type: "response",
    ...response,
  });
}

function serializeTab(tab) {
  return tab
    ? {
        id: tab.id ?? null,
        title: tab.title ?? "",
        url: tab.url ?? "",
      }
    : null;
}

function toErrorPayload(error) {
  if (error instanceof BridgeActionError) {
    return { code: error.code, message: error.message };
  }

  if (error instanceof Error) {
    return { code: "bridge_error", message: error.message };
  }

  return { code: "bridge_error", message: String(error) };
}

async function getSlackTabsDetailed() {
  const tabs = await chrome.tabs.query({ url: ["https://app.slack.com/*"] });
  const sorted = [...tabs].sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
  const activeTab = sorted[0] ?? null;

  return {
    tabs,
    activeTab,
    count: tabs.length,
    selectionRule: tabs.length <= 1 ? "single_tab" : "most_recently_focused",
  };
}

async function getSlackTabs() {
  const details = await getSlackTabsDetailed();
  return {
    count: details.count,
    activeTab: serializeTab(details.activeTab),
    selectionRule: details.selectionRule,
  };
}

async function resolveActiveSlackTab() {
  const details = await getSlackTabsDetailed();
  const tab = details.activeTab;

  if (!tab) {
    throw new BridgeActionError(
      "no_active_slack_tab",
      "No Slack tab is available. Open Slack in Chrome and try again.",
    );
  }

  if (typeof tab.id !== "number") {
    throw new BridgeActionError("invalid_tab", "The active Slack tab does not have a usable tab id.");
  }

  return {
    tab,
    selectionRule: details.selectionRule,
    tabCount: details.count,
  };
}

async function sendMessageToActiveSlackTab(message) {
  const { tab, selectionRule, tabCount } = await resolveActiveSlackTab();

  let response;
  try {
    response = await chrome.tabs.sendMessage(tab.id, message);
  } catch (error) {
    throw new BridgeActionError(
      "content_script_unavailable",
      error instanceof Error
        ? error.message
        : "The Slack Pi content script is not available in the active Slack tab.",
    );
  }

  if (!response || typeof response !== "object") {
    throw new BridgeActionError(
      "content_script_invalid_response",
      "The Slack Pi content script returned an invalid response.",
    );
  }

  return {
    response,
    activeTab: serializeTab(tab),
    selectionRule,
    tabCount,
  };
}

async function handleRequestMessage(socket, message) {
  try {
    if (message.action === "ping") {
      state.lastPingAt = Date.now();
      sendSocketResponse(socket, message.id, {
        ok: true,
        payload: {
          now: new Date().toISOString(),
        },
      });
      state.lastPongAt = Date.now();
      return;
    }

    if (message.action === "getCurrentThread") {
      const result = await sendMessageToActiveSlackTab({ type: "slack-pi:get-current-thread" });
      if (!result.response.ok) {
        sendSocketResponse(socket, message.id, {
          ok: false,
          error: result.response.error ?? {
            code: "thread_read_failed",
            message: "The Slack content script failed to read the current thread.",
          },
        });
        return;
      }

      sendSocketResponse(socket, message.id, {
        ok: true,
        payload: {
          ...result.response.payload,
          activeTab: result.activeTab,
          selectionRule: result.selectionRule,
          slackTabCount: result.tabCount,
        },
      });
      return;
    }

    sendSocketResponse(socket, message.id, {
      ok: false,
      error: {
        code: "unsupported_action",
        message: `Unsupported action: ${String(message.action)}`,
      },
    });
  } catch (error) {
    state.lastError = error instanceof Error ? error.message : String(error);
    sendSocketResponse(socket, message.id, {
      ok: false,
      error: toErrorPayload(error),
    });
  }
}

function handleSocketMessage(socket, event) {
  let parsed;
  try {
    parsed = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
  } catch {
    state.lastError = "Received invalid JSON from slack-pi.";
    return;
  }

  if (!parsed || typeof parsed !== "object") return;

  if (parsed.type === "hello_ack") {
    state.connected = true;
    state.authenticated = true;
    state.socketState = "authenticated";
    state.lastHelloAckAt = Date.now();
    state.lastError = "";
    return;
  }

  if (parsed.type === "request" && typeof parsed.id === "string") {
    handleRequestMessage(socket, parsed);
  }
}

async function ensureConnected() {
  const token = (await getToken()).trim();
  if (!token) {
    clearReconnectTimer();
    closeSocket();
    state.lastError = "No shared secret configured.";
    return false;
  }

  if (
    state.socket &&
    (state.socketState === "connecting" || state.socketState === "open" || state.socketState === "authenticated")
  ) {
    return state.connected;
  }

  clearReconnectTimer();
  closeSocket();

  state.socketState = "connecting";
  state.connected = false;
  state.authenticated = false;
  state.lastError = "";

  const socket = new WebSocket(SLACK_PI_WS_URL);
  state.socket = socket;

  socket.addEventListener("open", () => {
    state.socketState = "open";
    state.lastHelloSentAt = Date.now();
    sendJson(socket, {
      type: "hello",
      role: "chrome",
      version: PROTOCOL_VERSION,
      token,
      payload: {
        extensionVersion: chrome.runtime.getManifest().version,
      },
    });
  });

  socket.addEventListener("message", (event) => {
    handleSocketMessage(socket, event);
  });

  socket.addEventListener("error", () => {
    state.lastError = "WebSocket error while talking to slack-pi.";
  });

  socket.addEventListener("close", (event) => {
    if (state.socket === socket) {
      if (event.reason) {
        state.lastError = `Socket closed: ${event.reason}`;
      } else if (event.code) {
        state.lastError = `Socket closed (${event.code}).`;
      }
      resetSocketState();
      void scheduleReconnect();
    }
  });

  return false;
}

async function getStatus() {
  await ensureConnected();
  const token = await getToken();
  const tabs = await getSlackTabs();

  return {
    connected: state.connected,
    authenticated: state.authenticated,
    socketState: state.socketState,
    wsUrl: SLACK_PI_WS_URL,
    hasToken: token.length > 0,
    slackTabCount: tabs.count,
    activeTab: tabs.activeTab,
    lastHelloSentAt: state.lastHelloSentAt,
    lastHelloAckAt: state.lastHelloAckAt,
    lastPingAt: state.lastPingAt,
    lastPongAt: state.lastPongAt,
    lastError: state.lastError,
  };
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !(TOKEN_KEY in changes)) return;
  void ensureConnected();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return undefined;

  if (message.type === "slack-pi:get-status") {
    getStatus().then(sendResponse);
    return true;
  }

  if (message.type === "slack-pi:set-token") {
    const token = typeof message.token === "string" ? message.token.trim() : "";
    chrome.storage.local.set({ [TOKEN_KEY]: token }).then(async () => {
      await ensureConnected();
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.type === "slack-pi:reset-token") {
    chrome.storage.local.remove(TOKEN_KEY).then(() => {
      clearReconnectTimer();
      closeSocket();
      state.lastError = "No shared secret configured.";
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.type === "slack-pi:test-connection") {
    getStatus().then((status) => {
      sendResponse({
        ok: status.connected,
        message: status.connected
          ? "Connected to slack-pi."
          : status.lastError || "Not connected to slack-pi yet.",
        wsUrl: SLACK_PI_WS_URL,
      });
    });
    return true;
  }

  return undefined;
});

void ensureConnected();
