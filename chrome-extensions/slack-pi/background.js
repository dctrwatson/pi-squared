const SLACK_PI_PORT = 27183;
const SLACK_PI_WS_URL = `ws://127.0.0.1:${SLACK_PI_PORT}`;
const TOKEN_KEY = "slackPiToken";

chrome.runtime.onInstalled.addListener(() => {
  console.log("[slack-pi] background scaffold installed");
});

async function getToken() {
  const result = await chrome.storage.local.get(TOKEN_KEY);
  return typeof result[TOKEN_KEY] === "string" ? result[TOKEN_KEY] : "";
}

async function getSlackTabs() {
  const tabs = await chrome.tabs.query({ url: ["https://app.slack.com/*"] });
  const sorted = [...tabs].sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
  const activeTab = sorted[0] ?? null;

  return {
    count: tabs.length,
    activeTab: activeTab
      ? {
          id: activeTab.id ?? null,
          title: activeTab.title ?? "",
          url: activeTab.url ?? "",
        }
      : null,
  };
}

async function getStatus() {
  const token = await getToken();
  const tabs = await getSlackTabs();

  return {
    connected: false,
    wsUrl: SLACK_PI_WS_URL,
    hasToken: token.length > 0,
    slackTabCount: tabs.count,
    activeTab: tabs.activeTab,
    note: "WebSocket bridge is not implemented yet in this scaffold.",
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return undefined;

  if (message.type === "slack-pi:get-status") {
    getStatus().then(sendResponse);
    return true;
  }

  if (message.type === "slack-pi:set-token") {
    const token = typeof message.token === "string" ? message.token.trim() : "";
    chrome.storage.local.set({ [TOKEN_KEY]: token }).then(() => {
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.type === "slack-pi:reset-token") {
    chrome.storage.local.remove(TOKEN_KEY).then(() => {
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.type === "slack-pi:test-connection") {
    sendResponse({
      ok: false,
      message: "WebSocket connection not implemented yet in scaffold.",
      wsUrl: SLACK_PI_WS_URL,
    });
    return undefined;
  }

  return undefined;
});
