const PAIRING_KEY = "piSlackPairing";
const PAIRING_CODE_PREFIX = "pi-slack-pair:";
const PROTOCOL_VERSION = 1;
const HEARTBEAT_INTERVAL_MS = 20_000;
const APPROVAL_TIMEOUT_MS = 60_000;
const DEFAULT_EXECUTION_TIMEOUT_MS = 10_000;
const THREAD_EXECUTION_TIMEOUT_MS = 20_000;
const CHANNEL_RANGE_EXECUTION_TIMEOUT_MS = 60_000;
const CHANNEL_RANGE_ALL_EXECUTION_TIMEOUT_MS = 180_000;
const CHANNEL_RANGE_PAGE_SIZE = 16;
const CHANNEL_SUMMARY_THREAD_LIMIT = 50;
const CHANNEL_SUMMARY_THREAD_MESSAGE_LIMIT = 100;
const CHANNEL_SUMMARY_THREAD_REPLY_LIMIT = 2_000;
const ICON_SIZES = [16, 32, 48, 128];
const HEARTBEAT_ALARM = "pi-slack-heartbeat";
const RECONNECT_ALARM = "pi-slack-reconnect";
const APPROVAL_WINDOW_PATH = "approve.html";

const state = {
  socket: null,
  socketState: "idle",
  connected: false,
  authenticated: false,
  reconnectAttempt: 0,
  temporaryTabIds: new Set(),
  lastError: "",
  lastHelloSentAt: 0,
  lastHelloAckAt: 0,
  lastHeartbeatSentAt: 0,
  lastPingAt: 0,
  lastPongAt: 0,
  pairing: null,
  handshake: null,
  approvalWindowId: null,
  pendingApprovals: new Map(),
  pendingAbortControllers: new Map(),
};

chrome.runtime.onInstalled.addListener(() => {
  console.log("[pi-slack] background installed");
  void updateActionAppearance();
  void ensureConnected();
});

chrome.runtime.onStartup.addListener(() => {
  void updateActionAppearance();
  void ensureConnected();
});

function wsUrlFromPairing(pairing) {
  if (!pairing) return "";
  return `ws://${pairing.host}:${pairing.port}`;
}

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return atob(normalized + padding);
}

function parsePairingCode(input) {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) {
    throw new Error("Pairing code is empty.");
  }

  const raw = trimmed.startsWith(PAIRING_CODE_PREFIX) ? trimmed.slice(PAIRING_CODE_PREFIX.length) : trimmed;
  let parsed;
  try {
    parsed = JSON.parse(decodeBase64Url(raw));
  } catch {
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error("Pairing code is not valid Pi Slack pairing data.");
    }
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Pairing code is invalid.");
  }

  const host = typeof parsed.host === "string" ? parsed.host.trim() : "";
  const port = Number.isInteger(parsed.port) ? parsed.port : Number.parseInt(String(parsed.port ?? ""), 10);
  const sessionId = typeof parsed.sessionId === "string" ? parsed.sessionId.trim() : "";
  const secret = typeof parsed.secret === "string" ? parsed.secret.trim() : "";
  const version = Number.isInteger(parsed.version) ? parsed.version : Number.parseInt(String(parsed.version ?? ""), 10);

  if (version !== PROTOCOL_VERSION || host !== "127.0.0.1" || !Number.isInteger(port) || port < 1 || port > 65535 || !sessionId || !secret) {
    throw new Error("Pairing code is missing required Pi Slack session fields.");
  }

  return { version, host, port, sessionId, secret };
}

async function getPairing() {
  const result = await chrome.storage.session.get(PAIRING_KEY);
  const value = result[PAIRING_KEY];
  return value && typeof value === "object" ? value : null;
}

async function setPairing(pairing) {
  await chrome.storage.session.set({ [PAIRING_KEY]: pairing });
  state.pairing = pairing;
}

async function clearPairing() {
  await chrome.storage.session.remove(PAIRING_KEY);
  state.pairing = null;
}

function getAppearanceState() {
  if (state.pendingApprovals.size > 0) {
    return {
      color: "#f59e0b",
      title: `Pi Slack: ${state.pendingApprovals.size} approval${state.pendingApprovals.size === 1 ? "" : "s"} pending`,
      badgeText: String(Math.min(9, state.pendingApprovals.size)),
      badgeColor: "#f59e0b",
    };
  }

  if (state.authenticated && state.connected) {
    return {
      color: "#22c55e",
      title: "Pi Slack: connected",
      badgeText: "",
      badgeColor: "#22c55e",
    };
  }

  if (state.socketState === "connecting" || state.socketState === "open") {
    return {
      color: "#6b7280",
      title: "Pi Slack: connecting",
      badgeText: "",
      badgeColor: "#6b7280",
    };
  }

  if (state.lastError) {
    return {
      color: "#ef4444",
      title: `Pi Slack: ${state.lastError}`,
      badgeText: "",
      badgeColor: "#ef4444",
    };
  }

  if (state.pairing) {
    return {
      color: "#6b7280",
      title: "Pi Slack: paired, waiting for session",
      badgeText: "",
      badgeColor: "#6b7280",
    };
  }

  return {
    color: "#6b7280",
    title: "Pi Slack: idle",
    badgeText: "",
    badgeColor: "#6b7280",
  };
}

function makeIconImageData(size, color) {
  if (typeof OffscreenCanvas !== "function") {
    return null;
  }

  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.clearRect(0, 0, size, size);

  const inset = -0.5;
  const width = size + 1;
  const height = size + 1;
  const radius = Math.max(1, size * 0.08);
  const center = size / 2;
  const fontSize = Math.max(13, Math.floor(size * 1.12));

  const roundedRect = (x, y, w, h, r) => {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  };

  ctx.fillStyle = color;
  roundedRect(inset, inset, width, height, radius);
  ctx.fill();

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `700 ${fontSize}px "SF Pro Display", "Segoe UI Symbol", "Noto Sans Symbols 2", "Noto Sans Symbols", sans-serif`;
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(1, size * 0.055);
  ctx.strokeStyle = "rgba(15, 23, 42, 0.28)";
  ctx.strokeText("π", center, center + size * 0.055);
  ctx.fillStyle = "#ffffff";
  ctx.fillText("π", center, center + size * 0.055);

  return ctx.getImageData(0, 0, size, size);
}

async function updateActionAppearance() {
  const appearance = getAppearanceState();

  try {
    await chrome.action.setTitle({ title: appearance.title });
    await chrome.action.setBadgeText({ text: appearance.badgeText ?? "" });
    await chrome.action.setBadgeBackgroundColor({ color: appearance.badgeColor ?? appearance.color });

    const imageData = {};
    let hasImageData = false;
    for (const size of ICON_SIZES) {
      const data = makeIconImageData(size, appearance.color);
      if (!data) continue;
      imageData[size] = data;
      hasImageData = true;
    }

    if (hasImageData) {
      await chrome.action.setIcon({ imageData });
    }
  } catch (error) {
    console.warn("[pi-slack] failed to update action appearance", error);
  }
}

function clearReconnectTimer() {
  void chrome.alarms.clear(RECONNECT_ALARM); // T22
}

function clearHeartbeatTimer() {
  void chrome.alarms.clear(HEARTBEAT_ALARM); // T22
}

function resetSocketState() {
  clearHeartbeatTimer();
  state.socket = null;
  state.socketState = "idle";
  state.connected = false;
  state.authenticated = false;
  state.handshake = null;
  void updateActionAppearance();
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

  const pairing = state.pairing ?? await getPairing();
  if (!pairing) return;

  const delay = Math.min(30_000, 1_000 * 2 ** state.reconnectAttempt) + Math.floor(Math.random() * 500);
  chrome.alarms.create(RECONNECT_ALARM, { delayInMinutes: delay / 60_000 });
}

function sendJson(socket, message) {
  socket.send(JSON.stringify(message));
}

function startHeartbeat() {
  // T22: Use chrome.alarms so heartbeats survive service worker eviction.
  clearHeartbeatTimer();
  chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: HEARTBEAT_INTERVAL_MS / 60_000 });
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function utf8Bytes(value) {
  return new TextEncoder().encode(value);
}

function toHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function computeHandshakeProof(secret, sessionId, clientNonce, serverNonce, role) {
  const key = await crypto.subtle.importKey(
    "raw",
    utf8Bytes(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const payload = [String(PROTOCOL_VERSION), sessionId, clientNonce, serverNonce, role].join("\n");
  const signature = await crypto.subtle.sign("HMAC", key, utf8Bytes(payload));
  return toHex(new Uint8Array(signature));
}

function createNonce() {
  return toHex(crypto.getRandomValues(new Uint8Array(16)));
}

function summarizeTabForApproval(tab) {
  if (!tab) {
    return [
      "No active Slack tab is currently available.",
      "If you allow this request now, it may still fail until Slack is open in Chrome.",
    ];
  }

  return [
    `Active tab title: ${tab.title || "(untitled)"}`,
    `Active tab URL: ${tab.url || "(missing URL)"}`,
  ];
}

async function approvalSummaryForRequest(message) {
  if (message.action === "getCurrentThread") {
    const tabs = await getSlackTabsDetailed();
    return {
      title: "Read current Slack thread",
      lines: [
        ...summarizeTabForApproval(serializeTab(tabs.activeTab)),
        `Slack tabs detected: ${tabs.count}`,
        `Tab selection rule: ${tabs.selectionRule}`,
        "Reads the currently open Slack thread from the selected Slack tab.",
        "Includes any unsent draft text in the thread composer.",
      ],
    };
  }

  if (message.action === "getChannelRange") {
    const startUrl = typeof message.payload?.startUrl === "string" ? message.payload.startUrl : "(missing)";
    const endUrl = typeof message.payload?.endUrl === "string" ? message.payload.endUrl : "";
    const limit = Number.isInteger(message.payload?.limit) ? message.payload.limit : null;
    return {
      title: "Read Slack channel range",
      lines: [
        `Start URL: ${startUrl}`,
        ...(endUrl ? [`End URL: ${endUrl}`] : ["End URL: not set (bounded read starts at Start URL and stops after the requested count)."]),
        ...(limit ? [`Requested next messages: ${limit}`] : ["Requested next messages: not specified"]),
        "Chrome may temporarily focus a Slack tab to harvest the range.",
      ],
    };
  }

  if (message.action === "getChannelRangeAll") {
    const startUrl = typeof message.payload?.startUrl === "string" ? message.payload.startUrl : "(missing)";
    const endUrl = typeof message.payload?.endUrl === "string" ? message.payload.endUrl : "";
    const maxMessages = Number.isInteger(message.payload?.maxMessages) ? message.payload.maxMessages : 500;
    const includeThreads = message.payload?.includeThreads !== false;
    return {
      title: "Read Slack channel summary span",
      lines: [
        `Start URL: ${startUrl}`,
        ...(endUrl ? [`End URL: ${endUrl}`] : ["End URL: not set (read may continue from Start URL to the present)."]),
        `Max messages: ${maxMessages}`,
        `Expand threads: ${includeThreads ? "yes" : "no"}`,
        "Chrome may temporarily focus Slack tabs and collect a larger message span.",
        "This is a higher-scope read than the current-thread tool.",
      ],
    };
  }

  if (message.action === "debugCurrentThreadScan") {
    const tabs = await getSlackTabsDetailed();
    return {
      title: "Debug current Slack thread extraction",
      lines: [
        ...summarizeTabForApproval(serializeTab(tabs.activeTab)),
        `Slack tabs detected: ${tabs.count}`,
        "Reads lightweight extractor diagnostics and sample rows for the open thread pane.",
      ],
    };
  }

  if (message.action === "debugCurrentChannelScan") {
    const tabs = await getSlackTabsDetailed();
    return {
      title: "Debug current Slack channel extraction",
      lines: [
        ...summarizeTabForApproval(serializeTab(tabs.activeTab)),
        `Slack tabs detected: ${tabs.count}`,
        "Reads lightweight extractor diagnostics and sample rows for the active channel view.",
      ],
    };
  }

  return {
    title: `Allow Pi Slack request: ${String(message.action)}`,
    lines: ["The connected Pi Slack session is asking Chrome to process a request."],
  };
}

function getPendingApprovalsForUi() {
  return [...state.pendingApprovals.values()]
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((approval) => ({
      id: approval.id,
      action: approval.action,
      title: approval.title,
      lines: approval.lines,
      createdAt: approval.createdAt,
      expiresAt: approval.expiresAt,
    }));
}

async function openApprovalWindow() {
  const url = chrome.runtime.getURL(APPROVAL_WINDOW_PATH);
  if (typeof state.approvalWindowId === "number") {
    try {
      await chrome.windows.update(state.approvalWindowId, { focused: true });
      return;
    } catch {
      state.approvalWindowId = null;
    }
  }

  const created = await chrome.windows.create({
    url,
    type: "popup",
    width: 460,
    height: 560,
    focused: true,
  });
  state.approvalWindowId = typeof created.id === "number" ? created.id : null;
}

async function requestUserApproval(message) {
  const summary = await approvalSummaryForRequest(message);
  const approval = {
    id: message.id,
    action: message.action,
    title: summary.title,
    lines: summary.lines,
    createdAt: Date.now(),
    expiresAt: Date.now() + APPROVAL_TIMEOUT_MS,
    timeout: null,
    resolve: null,
    reject: null,
  };

  return await new Promise((resolve, reject) => {
    approval.resolve = resolve;
    approval.reject = reject;
    approval.timeout = setTimeout(() => {
      state.pendingApprovals.delete(approval.id);
      if (state.pendingApprovals.size === 0) {
        void updateActionAppearance();
      }
      reject(new BridgeActionError("approval_timeout", "Slack read approval timed out in Chrome."));
      void updateActionAppearance();
    }, APPROVAL_TIMEOUT_MS);

    state.pendingApprovals.set(approval.id, approval);
    void updateActionAppearance();
    void openApprovalWindow();
  });
}

function resolveApproval(id, allow) {
  const approval = state.pendingApprovals.get(id);
  if (!approval) return false;
  clearTimeout(approval.timeout);
  state.pendingApprovals.delete(id);
  if (allow) {
    approval.resolve();
  } else {
    approval.reject(new BridgeActionError("user_denied", "User denied this Slack read request in Chrome."));
  }
  void updateActionAppearance();
  return true;
}

function getExecutionTimeoutMs(action) {
  switch (action) {
    case "getCurrentThread":
      return THREAD_EXECUTION_TIMEOUT_MS;
    case "getChannelRange":
      return CHANNEL_RANGE_EXECUTION_TIMEOUT_MS;
    case "getChannelRangeAll":
      return CHANNEL_RANGE_ALL_EXECUTION_TIMEOUT_MS;
    default:
      return DEFAULT_EXECUTION_TIMEOUT_MS;
  }
}

async function withExecutionTimeout(action, operation, controller) {
  const timeoutMs = getExecutionTimeoutMs(action);
  let timeoutId;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          if (controller) controller.abort();
          reject(new BridgeActionError(
            "execution_timeout",
            `Slack request ${action} timed out in Chrome after approval after ${Math.round(timeoutMs / 1000)}s.`,
          ));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function rejectAllApprovals(reason) {
  for (const approval of state.pendingApprovals.values()) {
    clearTimeout(approval.timeout);
    approval.reject(new BridgeActionError("approval_cancelled", reason));
  }
  state.pendingApprovals.clear();
  void updateActionAppearance();
}

chrome.windows.onRemoved.addListener((windowId) => {
  if (state.approvalWindowId === windowId) {
    state.approvalWindowId = null;
  }
});

function isSlackUrl(url) {
  // T06: URL-parser allowlist instead of loose regex.
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    return host === "app.slack.com" || host.endsWith(".slack.com");
  } catch {
    return false;
  }
}

function normalizeSlackTs(ts) {
  if (typeof ts !== "string") return "";
  const trimmed = ts.trim();
  if (!trimmed) return "";
  if (/^\d{10}\.\d{6}$/.test(trimmed)) return trimmed;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 16) {
    const normalized = `${digits.slice(0, 10)}.${digits.slice(10)}`;
    return /^\d{10}\.\d{6}$/.test(normalized) ? normalized : ""; // T20
  }
  const cleaned = trimmed.replace(/[^\d.]/g, "");
  return /^\d{10}\.\d{6}$/.test(cleaned) ? cleaned : ""; // T20
}

function parseSlackWorkspaceHostFromUrl(url) {
  if (!url) return undefined;

  try {
    const parsed = new URL(url);
    if (/^[^.]+\.slack\.com$/i.test(parsed.hostname) && parsed.hostname.toLowerCase() !== "app.slack.com") {
      return parsed.hostname;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function parseSlackTeamIdFromUrl(url) {
  if (!url) return undefined;

  try {
    const parsed = new URL(url);
    const teamMatch = parsed.pathname.match(/\/client\/(T[A-Z0-9]+)(?:\/|$)/i);
    if (teamMatch?.[1]) return teamMatch[1];
    const team = parsed.searchParams.get("team");
    if (team) return team;
  } catch {
    return undefined;
  }

  return undefined;
}

function parseSlackMessageLink(url) {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname;
    const teamId =
      parseSlackTeamIdFromUrl(url) ||
      parsed.searchParams.get("team") ||
      undefined;
    const workspaceHost = parseSlackWorkspaceHostFromUrl(url);

    let channelId = parsed.searchParams.get("cid") || undefined;
    let messageTs = normalizeSlackTs(parsed.searchParams.get("message_ts") || "");
    let threadTs = normalizeSlackTs(parsed.searchParams.get("thread_ts") || "");

    const archiveMatch = pathname.match(/\/archives\/([A-Z0-9]+)\/p(\d{16})/i);
    if (archiveMatch?.[1]) {
      channelId ||= archiveMatch[1];
      if (!messageTs) {
        messageTs = normalizeSlackTs(archiveMatch[2]);
      }
    }

    const messagesMatch = pathname.match(/\/messages\/([A-Z0-9]+)\/p(\d{16})/i);
    if (messagesMatch?.[1]) {
      channelId ||= messagesMatch[1];
      if (!messageTs) {
        messageTs = normalizeSlackTs(messagesMatch[2]);
      }
    }

    const clientMatch = pathname.match(/\/client\/(T[A-Z0-9]+)\/([A-Z0-9]+)(?:\/|$)/i);
    if (clientMatch?.[1]) {
      channelId ||= clientMatch[2];
    }

    const threadPathMatch = pathname.match(/\/thread\/([A-Z0-9]+)-(\d{10}\.\d{6})/i);
    if (threadPathMatch?.[1]) {
      channelId ||= threadPathMatch[1];
      if (!messageTs) {
        messageTs = normalizeSlackTs(threadPathMatch[2]);
      }
      if (!threadTs) {
        threadTs = normalizeSlackTs(threadPathMatch[2]);
      }
    }

    if (!channelId || !messageTs) {
      return null;
    }

    return {
      teamId,
      workspaceHost,
      channelId,
      messageTs,
      threadTs: threadTs || undefined,
    };
  } catch {
    return null;
  }
}

function slackTsToPathDigits(ts) {
  return normalizeSlackTs(ts).replace(/\D/g, "");
}

function buildSlackWorkspaceMessageUrl(workspaceHost, channelId, messageTs, threadTs) {
  const pathTs = slackTsToPathDigits(messageTs);
  const url = new URL(`https://${workspaceHost}/messages/${channelId}/p${pathTs}`);
  if (threadTs) {
    url.searchParams.set("cid", channelId);
    url.searchParams.set("message_ts", messageTs);
    url.searchParams.set("thread_ts", threadTs);
  }
  return url.href;
}

function buildSlackWebClientMessageUrl(teamId, channelId, messageTs, threadTs) {
  const url = new URL(`https://app.slack.com/client/${teamId}/${channelId}`);
  url.searchParams.set("cid", channelId);
  url.searchParams.set("message_ts", messageTs);
  url.searchParams.set("cdn", "1");
  if (threadTs) {
    url.searchParams.set("thread_ts", threadTs);
  }
  return url.href;
}

async function resolveSlackWebMessageUrl(url) {
  const parsed = parseSlackMessageLink(url);
  if (!parsed) {
    return { url, rewritten: false, reason: "unrecognized_message_link" };
  }

  if (parsed.workspaceHost) {
    return {
      url: buildSlackWorkspaceMessageUrl(parsed.workspaceHost, parsed.channelId, parsed.messageTs, parsed.threadTs),
      rewritten: true,
      reason: "from_workspace_host",
      workspaceHost: parsed.workspaceHost,
      channelId: parsed.channelId,
      messageTs: parsed.messageTs,
      threadTs: parsed.threadTs,
    };
  }

  let teamId = parsed.teamId;
  if (!teamId) {
    const details = await getSlackTabsDetailed();
    const candidateTabs = [details.activeTab, ...details.tabs].filter(Boolean);
    for (const tab of candidateTabs) {
      const candidateTeamId = parseSlackTeamIdFromUrl(tab.url);
      if (candidateTeamId) {
        teamId = candidateTeamId;
        break;
      }
    }
  }

  if (!teamId) {
    return { url, rewritten: false, reason: "missing_team_id" };
  }

  return {
    url: buildSlackWebClientMessageUrl(teamId, parsed.channelId, parsed.messageTs, parsed.threadTs),
    rewritten: true,
    reason: parsed.teamId ? "from_input_url" : "from_open_slack_tab",
    teamId,
    channelId: parsed.channelId,
    messageTs: parsed.messageTs,
    threadTs: parsed.threadTs,
  };
}

function isReceivingEndMissing(error) {
  if (!(error instanceof Error)) return false;
  return /receiving end does not exist|could not establish connection/i.test(error.message);
}

async function ensureContentScriptLoaded(tabId) {
  try {
    const probe = await chrome.tabs.sendMessage(tabId, { type: "pi-slack:content-ping" });
    if (probe && typeof probe === "object") return;
  } catch (error) {
    if (!isReceivingEndMissing(error)) {
      throw error;
    }
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content-script.js"],
  });
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
  const tabs = await chrome.tabs.query({ url: ["https://app.slack.com/*", "https://*.slack.com/*"] });
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

async function sendMessageToTab(tabId, message) {
  try {
    await ensureContentScriptLoaded(tabId);
  } catch (error) {
    throw new BridgeActionError(
      "content_script_unavailable",
      error instanceof Error
        ? error.message
        : "The Pi Slack content script could not be loaded into the target Slack tab.",
    );
  }

  let response;
  try {
    response = await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    throw new BridgeActionError(
      "content_script_unavailable",
      error instanceof Error
        ? error.message
        : "The Pi Slack content script is not available in the target Slack tab.",
    );
  }

  if (!response || typeof response !== "object") {
    throw new BridgeActionError(
      "content_script_invalid_response",
      "The Pi Slack content script returned an invalid response.",
    );
  }

  return response;
}

async function sendMessageToActiveSlackTab(message) {
  const { tab, selectionRule, tabCount } = await resolveActiveSlackTab();
  const response = await sendMessageToTab(tab.id, message);

  return {
    response,
    activeTab: serializeTab(tab),
    selectionRule,
    tabCount,
  };
}

async function waitForTabComplete(tabId, timeoutMs = 20_000) {
  const current = await chrome.tabs.get(tabId);
  if (current.status === "complete") {
    await sleep(500);
    return current;
  }

  return await new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new BridgeActionError("tab_load_timeout", "Timed out waiting for Slack to load the target message link."));
    }, timeoutMs);

    const onUpdated = (updatedTabId, changeInfo, updatedTab) => {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status !== "complete") return;
      clearTimeout(timeoutId);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      void sleep(500).then(() => resolve(updatedTab));
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function waitForTabSettle(tabId, delayMs = 1_000) {
  await sleep(delayMs);
  const tab = await chrome.tabs.get(tabId);
  if (tab.status !== "complete") {
    return await waitForTabComplete(tabId);
  }
  return tab;
}

async function prepareTemporarySlackTab(tabId, maxAttempts = 4) {
  let lastPreparePayload = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const prepare = await sendMessageToTab(tabId, { type: "pi-slack:prepare-channel-range-page" });
    if (!prepare || typeof prepare !== "object") {
      return { prepared: false, lastPreparePayload };
    }
    if (!prepare.ok) {
      return { prepared: false, lastPreparePayload: prepare.error ?? lastPreparePayload };
    }

    lastPreparePayload = prepare.payload ?? lastPreparePayload;
    const state = prepare.payload?.state;
    if (state === "ready") {
      return { prepared: true, lastPreparePayload };
    }

    if (state === "navigate" && typeof prepare.payload?.url === "string" && prepare.payload.url) {
      await chrome.tabs.update(tabId, { url: prepare.payload.url });
      await waitForTabComplete(tabId);
      continue;
    }

    if (state === "clicked") {
      await waitForTabSettle(tabId, 1_500);
      continue;
    }

    if (state === "unready") {
      await waitForTabSettle(tabId, 1_000);
      continue;
    }

    return { prepared: false, lastPreparePayload };
  }

  return { prepared: false, lastPreparePayload };
}

async function resolveTemporarySlackTabUrl(url) {
  if (!isSlackUrl(url)) {
    throw new BridgeActionError("invalid_slack_url", "The supplied Slack link is not a recognized Slack URL.");
  }

  const resolvedUrl = await resolveSlackWebMessageUrl(url);
  if (!resolvedUrl.rewritten) {
    console.warn("[pi-slack] could not rewrite Slack message URL to a browser-safe web client URL", resolvedUrl);
    if (resolvedUrl.reason === "missing_team_id") {
      throw new BridgeActionError(
        "missing_team_id",
        "Could not map the Slack permalink to a browser-safe web URL. Keep the target workspace open in Chrome and try again.",
      );
    }
  }

  return resolvedUrl;
}

async function prepareLoadedTemporarySlackTab(tabId, resolvedUrl) {
  await waitForTabComplete(tabId);
  const preparation = await prepareTemporarySlackTab(tabId);
  if (!preparation.prepared) {
    console.warn("[pi-slack] temporary Slack tab was not fully prepared", {
      prepare: preparation.lastPreparePayload,
      resolvedUrl,
    });
  }

  return preparation;
}

async function captureActiveTabContext() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || typeof tab.id !== "number") return null;
  return {
    tabId: tab.id,
    windowId: typeof tab.windowId === "number" ? tab.windowId : undefined,
  };
}

async function focusTab(tabId, windowId) {
  if (typeof windowId === "number") {
    try {
      await chrome.windows.update(windowId, { focused: true });
    } catch {
      // ignore focus errors; tab activation may still succeed.
    }
  }
  await chrome.tabs.update(tabId, { active: true });
}

async function restoreActiveTabContext(context) {
  if (!context || typeof context.tabId !== "number") return;
  try {
    await focusTab(context.tabId, context.windowId);
  } catch {
    // ignore restore errors
  }
}

async function openTemporarySlackTab(url, options = {}) {
  const resolvedUrl = await resolveTemporarySlackTabUrl(url);
  const tab = await chrome.tabs.create({ url: resolvedUrl.url, active: Boolean(options.foreground) });
  if (typeof tab.id !== "number") {
    throw new BridgeActionError("invalid_tab", "Could not create a temporary Slack tab.");
  }
  state.temporaryTabIds.add(tab.id); // T26: track for cleanup on disconnect

  if (options.foreground) {
    await focusTab(tab.id, typeof tab.windowId === "number" ? tab.windowId : undefined);
  }

  const preparation = await prepareLoadedTemporarySlackTab(tab.id, resolvedUrl);
  return { tabId: tab.id, resolvedUrl, preparation };
}

async function withTemporarySlackTab(url, handler, options = {}) {
  const previousContext = options.foreground ? await captureActiveTabContext() : null;
  const temporaryTab = await openTemporarySlackTab(url, options);

  try {
    return await handler({
      ...temporaryTab,
      getCurrentTab: async () => serializeTab(await chrome.tabs.get(temporaryTab.tabId)),
    });
  } finally {
    try {
      await chrome.tabs.remove(temporaryTab.tabId);
    } catch {
      // ignore cleanup errors
    }
    state.temporaryTabIds.delete(temporaryTab.tabId); // T26: untrack after normal close
    if (options.foreground) {
      await restoreActiveTabContext(previousContext);
    }
  }
}

async function readChannelRangePageFromTemporarySlackTab(tabId, { startUrl, endUrl, limit, cursor, seedAuthor }) {
  const page = await sendMessageToTab(tabId, {
    type: "pi-slack:get-channel-range",
    startUrl,
    endUrl,
    limit,
    cursor,
    seedAuthor,
  });

  if (!page.ok) {
    throw new BridgeActionError(
      page.error?.code || "channel_range_read_failed",
      page.error?.message || "The Slack content script failed to read the requested channel range.",
    );
  }

  const payload = page.payload;
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.messages) || payload.messages.length === 0) {
    throw new BridgeActionError("channel_range_read_failed", "Chrome returned an empty Slack channel range.");
  }

  return payload;
}

async function getChannelRangeFromTemporarySlackTab(startUrl, endUrl, limit, cursor) {
  return await withTemporarySlackTab(startUrl, async ({ tabId, getCurrentTab }) => {
    const payload = await readChannelRangePageFromTemporarySlackTab(tabId, {
      startUrl,
      endUrl,
      limit,
      cursor,
    });

    return {
      ...payload,
      tempTab: await getCurrentTab(),
    };
  }, { foreground: true });
}

function makeMessageKey(message) {
  // T21: Prefer messageTs as sole key so edited messages (text changes, ts unchanged) deduplicate correctly.
  const ts = typeof message?.messageTs === "string" && message.messageTs
    ? normalizeSlackTs(message.messageTs)
    : "";
  if (ts) return `ts:${ts}`;
  const perma = typeof message?.permalinkUrl === "string" ? message.permalinkUrl : "";
  if (perma) return `url:${perma}`;
  return `txt:${(typeof message?.text === "string" ? message.text : "").slice(0, 240)}`;
}

function buildThreadUrlFromMessage(message) {
  const messageTs = normalizeSlackTs(typeof message?.messageTs === "string" ? message.messageTs : "");
  const permalinkUrl = typeof message?.permalinkUrl === "string" ? message.permalinkUrl : "";
  if (!messageTs || !permalinkUrl) return null;

  try {
    const url = new URL(permalinkUrl);
    url.searchParams.set("message_ts", messageTs);
    url.searchParams.set("thread_ts", messageTs);
    return url.href;
  } catch {
    return null;
  }
}

function limitThreadMessagesForSummary(thread, maxMessages) {
  if (!thread || typeof thread !== "object" || !Array.isArray(thread.messages) || thread.messages.length <= maxMessages) {
    return thread;
  }

  const root = thread.messages[0];
  const replies = thread.messages.slice(1);
  const replySlots = Math.max(0, maxMessages - 1);
  const selected = [];
  const seen = new Set();

  if (root) {
    selected.push(root);
    seen.add(makeMessageKey(root));
  }

  if (replySlots <= 0 || replies.length === 0) {
    return {
      ...thread,
      messages: selected,
    };
  }

  const denominator = Math.max(1, replySlots - 1);
  for (let slot = 0; slot < replySlots; slot += 1) {
    const index = Math.round((slot * (replies.length - 1)) / denominator);
    const reply = replies[index];
    if (!reply) continue;
    const key = makeMessageKey(reply);
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(reply);
  }

  return {
    ...thread,
    messages: selected,
  };
}

async function readThreadSnapshotFromTemporarySlackTab(tabId, threadUrl) {
  const resolvedUrl = await resolveTemporarySlackTabUrl(threadUrl);
  await chrome.tabs.update(tabId, { url: resolvedUrl.url });
  await waitForTabComplete(tabId);

  const thread = await sendMessageToTab(tabId, { type: "pi-slack:get-current-thread" });
  if (!thread.ok) {
    throw new BridgeActionError(
      thread.error?.code || "thread_read_failed",
      thread.error?.message || "The Slack content script failed to read the requested thread.",
    );
  }

  const payload = thread.payload;
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.messages) || payload.messages.length === 0) {
    throw new BridgeActionError("thread_read_failed", "Chrome returned an empty Slack thread.");
  }

  return payload;
}

async function expandThreadsOnChannelMessages(tabId, messages, options = {}, signal) {
  const maxThreadRoots = Number.isInteger(options.maxThreadRoots) ? options.maxThreadRoots : CHANNEL_SUMMARY_THREAD_LIMIT;
  const maxThreadMessages = Number.isInteger(options.maxThreadMessages) ? options.maxThreadMessages : CHANNEL_SUMMARY_THREAD_MESSAGE_LIMIT;
  let remainingReplies = Number.isInteger(options.maxThreadReplies) ? options.maxThreadReplies : CHANNEL_SUMMARY_THREAD_REPLY_LIMIT;
  let expandedThreadCount = 0;
  let omittedThreadCount = 0;
  let failedThreadCount = 0;

  for (const message of messages) {
    if (signal?.aborted) { omittedThreadCount += 1; continue; } // T16: bail if Pi timed out
    const replyCount = Number.isInteger(message?.replyCount) ? message.replyCount : 0;
    if (!replyCount) continue;

    const threadUrl = buildThreadUrlFromMessage(message);
    if (!threadUrl) {
      omittedThreadCount += 1;
      continue;
    }

    if (expandedThreadCount >= maxThreadRoots || remainingReplies <= 0) {
      omittedThreadCount += 1;
      continue;
    }

    try {
      const maxMessagesForThisThread = Math.max(2, Math.min(maxThreadMessages, remainingReplies + 1));
      const thread = await readThreadSnapshotFromTemporarySlackTab(tabId, threadUrl);
      const limitedThread = limitThreadMessagesForSummary(thread, maxMessagesForThisThread);
      const capturedReplies = Math.max(0, (limitedThread.messages?.length ?? 1) - 1);
      message.thread = limitedThread;
      remainingReplies = Math.max(0, remainingReplies - capturedReplies);
      expandedThreadCount += 1;
    } catch (error) {
      console.warn("[pi-slack] failed to expand thread while summarizing channel", {
        error: error instanceof Error ? error.message : String(error),
        threadUrl,
      });
      failedThreadCount += 1;
    }
  }

  return {
    messages,
    expandedThreadCount,
    omittedThreadCount,
    failedThreadCount,
  };
}

async function getChannelRangeAllFromTemporarySlackTab(
  startUrl,
  endUrl,
  maxMessages = 500,
  pageSize = CHANNEL_RANGE_PAGE_SIZE,
  includeThreads = false,
  signal, // T16
) {
  return await withTemporarySlackTab(startUrl, async ({ tabId, getCurrentTab }) => {
    let firstPayload = null;
    const allMessages = [];
    let cursor;
    let seedAuthor;

    while (allMessages.length < maxMessages) {
      if (signal?.aborted) break; // T16: stop pagination if Pi timed out
      const limit = Math.min(pageSize, maxMessages - allMessages.length);
      let payload;

      try {
        payload = await readChannelRangePageFromTemporarySlackTab(tabId, {
          startUrl,
          endUrl,
          limit,
          cursor,
          seedAuthor,
        });
      } catch (error) {
        if (allMessages.length > 0 && cursor && error instanceof BridgeActionError && error.code === "no_channel_messages") {
          break;
        }
        throw error;
      }

      if (!firstPayload) firstPayload = payload;
      allMessages.push(...payload.messages);

      const lastAuthor = [...payload.messages].reverse().find((message) => typeof message?.author === "string" && message.author)?.author;
      if (lastAuthor) {
        seedAuthor = lastAuthor;
      }

      if (!payload.nextCursor) break;
      cursor = payload.nextCursor;
    }

    if (!firstPayload) {
      throw new BridgeActionError("channel_range_read_failed", "No messages returned.");
    }

    const messages = allMessages.slice(0, maxMessages);
    const threadExpansion = includeThreads
      ? await expandThreadsOnChannelMessages(tabId, messages, {}, signal) // T16: pass abort signal
      : { expandedThreadCount: 0, omittedThreadCount: 0, failedThreadCount: 0 };

    return {
      ...firstPayload,
      messages,
      threadSummariesIncluded: includeThreads,
      ...(includeThreads ? threadExpansion : {}),
      tempTab: await getCurrentTab(),
    };
  }, { foreground: true });
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
      await requestUserApproval(message);
      const result = await withExecutionTimeout(
        message.action,
        sendMessageToActiveSlackTab({ type: "pi-slack:get-current-thread" }),
      );
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

    if (message.action === "getChannelRange") {
      const startUrl = typeof message.payload?.startUrl === "string" ? message.payload.startUrl : "";
      const endUrl = typeof message.payload?.endUrl === "string" ? message.payload.endUrl : undefined;
      const limit = Number.isInteger(message.payload?.limit) ? message.payload.limit : undefined;
      const cursor = typeof message.payload?.cursor === "string" ? message.payload.cursor : undefined;
      if (!startUrl) {
        throw new BridgeActionError("invalid_request", "getChannelRange requires startUrl.");
      }

      await requestUserApproval(message);
      const payload = await withExecutionTimeout(
        message.action,
        getChannelRangeFromTemporarySlackTab(startUrl, endUrl, limit, cursor),
      );
      sendSocketResponse(socket, message.id, {
        ok: true,
        payload,
      });
      return;
    }

    if (message.action === "getChannelRangeAll") {
      const startUrl = typeof message.payload?.startUrl === "string" ? message.payload.startUrl : "";
      const endUrl = typeof message.payload?.endUrl === "string" ? message.payload.endUrl : undefined;
      const maxMessages = Number.isInteger(message.payload?.maxMessages) ? message.payload.maxMessages : 500;
      const pageSize = Number.isInteger(message.payload?.pageSize) ? message.payload.pageSize : CHANNEL_RANGE_PAGE_SIZE;
      const includeThreads = message.payload?.includeThreads !== false;
      if (!startUrl) {
        throw new BridgeActionError("invalid_request", "getChannelRangeAll requires startUrl.");
      }

      await requestUserApproval(message);
      const controller = new AbortController();
      state.pendingAbortControllers.set(message.id, controller);
      try {
        const payload = await withExecutionTimeout(
          message.action,
          getChannelRangeAllFromTemporarySlackTab(startUrl, endUrl, maxMessages, pageSize, includeThreads, controller.signal),
          controller,
        );
        sendSocketResponse(socket, message.id, {
          ok: true,
          payload,
        });
      } finally {
        state.pendingAbortControllers.delete(message.id);
      }
      return;
    }

    if (message.action === "debugCurrentThreadScan") {
      await requestUserApproval(message);
      const result = await withExecutionTimeout(
        message.action,
        sendMessageToActiveSlackTab({ type: "pi-slack:debug-thread-scan" }),
      );
      if (!result.response.ok) {
        sendSocketResponse(socket, message.id, {
          ok: false,
          error: result.response.error ?? {
            code: "thread_debug_failed",
            message: "The Slack content script failed to build a thread debug scan.",
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

    if (message.action === "debugCurrentChannelScan") {
      await requestUserApproval(message);
      const result = await withExecutionTimeout(
        message.action,
        sendMessageToActiveSlackTab({ type: "pi-slack:debug-channel-scan" }),
      );
      if (!result.response.ok) {
        sendSocketResponse(socket, message.id, {
          ok: false,
          error: result.response.error ?? {
            code: "channel_debug_failed",
            message: "The Slack content script failed to build a channel debug scan.",
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

async function handleSocketMessage(socket, event) {
  let parsed;
  try {
    parsed = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
  } catch {
    state.lastError = "Received invalid JSON from pi-slack.";
    return;
  }

  if (!parsed || typeof parsed !== "object") return;

  if (parsed.type === "server_challenge") {
    const pairing = state.pairing ?? await getPairing();
    if (!pairing || !state.handshake) {
      closeSocket(socket, 1008, "Unexpected server challenge");
      return;
    }
    if (parsed.version !== PROTOCOL_VERSION || parsed.sessionId !== pairing.sessionId || typeof parsed.serverNonce !== "string") {
      closeSocket(socket, 1008, "Invalid server challenge");
      return;
    }

    state.handshake.serverNonce = parsed.serverNonce;
    const proof = await computeHandshakeProof(
      pairing.secret,
      pairing.sessionId,
      state.handshake.clientNonce,
      parsed.serverNonce,
      "chrome",
    );
    sendJson(socket, {
      type: "client_proof",
      role: "chrome",
      version: PROTOCOL_VERSION,
      sessionId: pairing.sessionId,
      proof,
    });
    return;
  }

  if (parsed.type === "hello_ack") {
    const pairing = state.pairing ?? await getPairing();
    const serverNonce = state.handshake?.serverNonce;
    if (!pairing || !state.handshake || !serverNonce || parsed.version !== PROTOCOL_VERSION || parsed.sessionId !== pairing.sessionId || typeof parsed.proof !== "string") {
      closeSocket(socket, 1008, "Invalid hello acknowledgement");
      return;
    }

    const expectedProof = await computeHandshakeProof(
      pairing.secret,
      pairing.sessionId,
      state.handshake.clientNonce,
      serverNonce,
      "pi",
    );
    if (parsed.proof !== expectedProof) {
      closeSocket(socket, 1008, "Invalid server proof");
      return;
    }

    state.connected = true;
    state.authenticated = true;
    state.socketState = "authenticated";
    state.lastHelloAckAt = Date.now();
    state.lastError = "";
    state.reconnectAttempt = 0;
    state.handshake = null;
    startHeartbeat();
    void updateActionAppearance();
    return;
  }

  if (parsed.type === "cancel" && typeof parsed.id === "string") {
    const approval = state.pendingApprovals.get(parsed.id);
    if (approval) {
      clearTimeout(approval.timeout);
      state.pendingApprovals.delete(parsed.id);
      approval.reject(new BridgeActionError("approval_cancelled", "Pi Slack cancelled the pending Chrome approval request."));
      void updateActionAppearance();
      return;
    }

    const controller = state.pendingAbortControllers.get(parsed.id);
    if (controller) controller.abort();
    return;
  }

  if (parsed.type === "request" && typeof parsed.id === "string") {
    void handleRequestMessage(socket, parsed);
  }
}

async function ensureConnected() {
  const pairing = state.pairing ?? await getPairing();
  state.pairing = pairing;
  if (!pairing) {
    clearReconnectTimer();
    closeSocket();
    state.lastError = "No pairing configured for the current Pi Slack session.";
    void updateActionAppearance();
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

  if (typeof WebSocket !== "function") {
    state.socketState = "error";
    state.lastError = "WebSocket is not available in this Chrome extension service worker.";
    void updateActionAppearance();
    return false;
  }

  state.socketState = "connecting";
  state.connected = false;
  state.authenticated = false;
  state.lastError = "";
  void updateActionAppearance();

  let socket;
  try {
    socket = new WebSocket(wsUrlFromPairing(pairing));
  } catch (error) {
    state.socketState = "error";
    state.lastError = error instanceof Error ? error.message : String(error);
    console.error("[pi-slack] failed to create WebSocket", error);
    void updateActionAppearance();
    void scheduleReconnect();
    return false;
  }

  state.socket = socket;

  socket.addEventListener("open", () => {
    const clientNonce = createNonce();
    state.handshake = { clientNonce, serverNonce: null };
    state.socketState = "open";
    state.lastHelloSentAt = Date.now();
    void updateActionAppearance();
    sendJson(socket, {
      type: "client_hello",
      role: "chrome",
      version: PROTOCOL_VERSION,
      sessionId: pairing.sessionId,
      clientNonce,
      payload: {
        extensionVersion: chrome.runtime.getManifest().version,
      },
    });
  });

  socket.addEventListener("message", (event) => {
    void handleSocketMessage(socket, event);
  });

  socket.addEventListener("error", () => {
    state.lastError = "WebSocket error while talking to pi-slack.";
    void updateActionAppearance();
  });

  socket.addEventListener("close", (event) => {
    if (state.socket === socket) {
      for (const tabId of state.temporaryTabIds) {
        chrome.tabs.remove(tabId).catch(() => { /* ignore */ });
      }
      state.temporaryTabIds.clear();
      rejectAllApprovals("Pi Slack disconnected while Chrome approval was pending.");
      state.reconnectAttempt += 1;
      if (event.reason) {
        state.lastError = `Socket closed: ${event.reason}`;
      } else if (event.code) {
        state.lastError = `Socket closed (${event.code}).`;
      }
      resetSocketState();
      void updateActionAppearance();
      void scheduleReconnect();
    }
  });

  return false;
}

async function getStatus() {
  await ensureConnected();
  const pairing = state.pairing ?? await getPairing();
  const tabs = await getSlackTabs();

  return {
    connected: state.connected,
    authenticated: state.authenticated,
    socketState: state.socketState,
    wsUrl: pairing ? wsUrlFromPairing(pairing) : "",
    hasPairing: Boolean(pairing),
    pairSessionId: pairing?.sessionId ?? "",
    pendingApprovalCount: state.pendingApprovals.size,
    slackTabCount: tabs.count,
    activeTab: tabs.activeTab,
    selectionRule: tabs.selectionRule,
    lastHelloSentAt: state.lastHelloSentAt,
    lastHelloAckAt: state.lastHelloAckAt,
    lastHeartbeatSentAt: state.lastHeartbeatSentAt,
    lastPingAt: state.lastPingAt,
    lastPongAt: state.lastPongAt,
    lastError: state.lastError,
    extensionVersion: chrome.runtime.getManifest().version,
  };
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === HEARTBEAT_ALARM) {
    if (!state.authenticated || !state.socket || state.socket.readyState !== WebSocket.OPEN) return;
    state.lastHeartbeatSentAt = Date.now();
    try {
      sendJson(state.socket, {
        type: "event",
        event: "heartbeat",
        payload: { sentAt: new Date(state.lastHeartbeatSentAt).toISOString() },
      });
    } catch (error) {
      state.lastError = error instanceof Error ? error.message : String(error);
      void updateActionAppearance();
    }
    return;
  }

  if (alarm.name === RECONNECT_ALARM) {
    void ensureConnected();
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "session" || !(PAIRING_KEY in changes)) return;
  state.pairing = changes[PAIRING_KEY]?.newValue ?? null;
  void updateActionAppearance();
  void ensureConnected();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return undefined;

  if (message.type === "pi-slack:get-status") {
    getStatus().then(sendResponse);
    return true;
  }

  if (message.type === "pi-slack:set-pairing") {
    Promise.resolve()
      .then(async () => {
        const pairing = parsePairingCode(message.pairingCode);
        await setPairing(pairing);
        clearReconnectTimer();
        closeSocket();
        await ensureConnected();
        sendResponse({ ok: true });
      })
      .catch((error) => {
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      });
    return true;
  }

  if (message.type === "pi-slack:reset-pairing") {
    Promise.resolve()
      .then(async () => {
        clearReconnectTimer();
        closeSocket();
        rejectAllApprovals("Pairing reset in Chrome.");
        for (const tabId of state.temporaryTabIds) {
          chrome.tabs.remove(tabId).catch(() => { /* ignore */ });
        }
        state.temporaryTabIds.clear();
        await clearPairing();
        state.lastError = "No pairing configured for the current Pi Slack session.";
        void updateActionAppearance();
        sendResponse({ ok: true });
      })
      .catch((error) => {
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      });
    return true;
  }

  if (message.type === "pi-slack:get-approval-state") {
    sendResponse({ pending: getPendingApprovalsForUi() });
    return undefined;
  }

  if (message.type === "pi-slack:open-approval-window") {
    openApprovalWindow().then(() => sendResponse({ ok: true })).catch((error) => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });
    return true;
  }

  if (message.type === "pi-slack:resolve-approval") {
    sendResponse({ ok: resolveApproval(String(message.id ?? ""), message.decision === "allow") });
    return undefined;
  }

  if (message.type === "pi-slack:test-connection") {
    getStatus().then((status) => {
      sendResponse({
        ok: status.connected,
        message: status.connected
          ? "Connected to the paired Pi Slack session."
          : status.lastError || "Not connected to Pi Slack yet.",
        wsUrl: status.wsUrl,
      });
    });
    return true;
  }

  return undefined;
});

void ensureConnected();
