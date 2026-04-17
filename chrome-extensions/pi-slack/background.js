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
const RECENT_ACTIVITY_LIMIT = 20;
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
  tempApprovalPolicies: new Map(),
  lastAutoApproval: null,
  recentActivity: [],
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

  const embeddedCode = trimmed.match(/pi-slack-pair:[A-Za-z0-9_-]+/i)?.[0] ?? "";
  const candidate = embeddedCode || trimmed;
  const raw = candidate.startsWith(PAIRING_CODE_PREFIX) ? candidate.slice(PAIRING_CODE_PREFIX.length) : candidate;
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

function parseSlackTimestampToken(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return "";
  if (/^\d+\.\d+$/.test(normalized)) return normalized;
  if (/^p\d{16,}$/.test(normalized)) {
    const digits = normalized.slice(1);
    return `${digits.slice(0, -6)}.${digits.slice(-6)}`;
  }
  if (/^\d{16,}$/.test(normalized)) {
    return `${normalized.slice(0, -6)}.${normalized.slice(-6)}`;
  }
  return normalized;
}

function parseSlackContextFromUrl(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl) return null;

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const segments = url.pathname.split("/").filter(Boolean);
  const workspaceKey = url.hostname === "app.slack.com"
    ? (segments[0] === "client" ? (segments[1] || "") : "")
    : (url.hostname.endsWith(".slack.com") ? url.hostname.replace(/\.slack\.com$/i, "") : "");
  const channelKey = url.searchParams.get("cid")
    || url.searchParams.get("channel")
    || (segments[0] === "client" ? (segments[2] || "") : "")
    || (segments[0] === "archives" ? (segments[1] || "") : "")
    || "";

  let threadKey = parseSlackTimestampToken(
    url.searchParams.get("thread_ts")
      || url.searchParams.get("message_ts")
      || url.searchParams.get("ts")
      || "",
  );

  if (!threadKey && segments[0] === "archives" && segments[2]) {
    threadKey = parseSlackTimestampToken(segments[2]);
  }

  if (!threadKey) {
    const threadSegmentIndex = segments.findIndex((segment) => segment === "thread");
    if (threadSegmentIndex >= 0 && segments[threadSegmentIndex + 1]) {
      const rawThreadSegment = segments[threadSegmentIndex + 1];
      const lastDash = rawThreadSegment.lastIndexOf("-");
      threadKey = parseSlackTimestampToken(lastDash >= 0 ? rawThreadSegment.slice(lastDash + 1) : rawThreadSegment);
    }
  }

  return {
    url: url.toString(),
    host: url.host,
    workspaceKey,
    channelKey,
    threadKey,
  };
}

function describeObservedSlackContext(context) {
  if (!context) return "current Slack context unavailable";

  const scope = [];
  if (context.channelLabel) {
    scope.push(context.channelLabel.startsWith("#") ? context.channelLabel : `#${context.channelLabel}`);
  } else if (context.channelKey) {
    scope.push(context.channelKey);
  }
  if (context.workspaceLabel) {
    scope.push(context.workspaceLabel);
  } else if (context.workspaceKey) {
    scope.push(context.workspaceKey);
  }

  const location = scope.join(" in ");
  if (context.type === "thread") {
    return location ? `thread-bound to ${location}` : "thread-bound";
  }
  if (context.type === "channel") {
    return location ? `channel-bound to ${location}` : "channel-bound";
  }
  if (location) {
    return `tab-bound to ${location}`;
  }

  if (context.url) {
    try {
      const url = new URL(context.url);
      return `tab-bound to ${url.host}${url.pathname}`;
    } catch {
      return `tab-bound to ${context.url}`;
    }
  }

  return "tab-bound to the current Slack tab";
}

function buildObservedThreadApprovalContext(tab, extras = {}) {
  if (!tab?.url) return null;
  const parsed = parseSlackContextFromUrl(tab.url);
  if (!parsed) return null;

  const workspaceLabel = typeof extras.workspaceLabel === "string" && extras.workspaceLabel ? extras.workspaceLabel : "";
  const channelLabel = typeof extras.channelLabel === "string" && extras.channelLabel ? extras.channelLabel : "";
  const threadPermalink = typeof extras.threadPermalink === "string" && extras.threadPermalink ? extras.threadPermalink : "";
  const workspaceKey = typeof extras.workspaceKey === "string" && extras.workspaceKey ? extras.workspaceKey : parsed.workspaceKey;
  const channelKey = typeof extras.channelKey === "string" && extras.channelKey ? extras.channelKey : parsed.channelKey;
  const threadKey = typeof extras.threadKey === "string" && extras.threadKey ? extras.threadKey : parsed.threadKey;
  const type = threadKey ? "thread" : (workspaceKey && channelKey ? "channel" : "tab");

  const context = {
    type,
    source: extras.source || "tab",
    tabId: typeof tab.id === "number" ? tab.id : null,
    url: parsed.url,
    host: parsed.host,
    workspaceKey,
    workspaceLabel,
    channelKey,
    channelLabel,
    threadKey,
    threadPermalink,
  };
  context.summary = describeObservedSlackContext(context);
  return context;
}

function buildApprovalContextSignature(context) {
  if (!context) return "none";
  return [
    context.type || "tab",
    context.workspaceKey || "",
    context.channelKey || "",
    context.threadKey || "",
    context.threadPermalink || "",
    context.tabId ?? "",
    context.url || "",
  ].join(":");
}

function policyMatchesObservedContext(policy, context) {
  if (!policy?.context || !context) return false;
  const policyContext = policy.context;

  if (policyContext.type === "thread") {
    if (
      policyContext.threadPermalink
      && context.threadPermalink
      && policyContext.threadPermalink === context.threadPermalink
    ) {
      return true;
    }
    if (
      policyContext.threadKey
      && context.threadKey
      && policyContext.threadKey === context.threadKey
      && policyContext.workspaceKey === context.workspaceKey
      && policyContext.channelKey === context.channelKey
    ) {
      return true;
    }
    if (policyContext.threadPermalink || policyContext.threadKey) {
      return false;
    }
    return Boolean(
      policyContext.tabId !== null
      && context.tabId !== null
      && policyContext.tabId === context.tabId
      && policyContext.url
      && context.url
      && policyContext.url === context.url,
    );
  }

  if (policyContext.type === "channel") {
    return Boolean(
      policyContext.workspaceKey
      && context.workspaceKey
      && policyContext.workspaceKey === context.workspaceKey
      && policyContext.channelKey
      && context.channelKey
      && policyContext.channelKey === context.channelKey,
    );
  }

  return Boolean(
    policyContext.tabId !== null
    && context.tabId !== null
    && policyContext.tabId === context.tabId
    && policyContext.url
    && context.url
    && policyContext.url === context.url,
  );
}

function buildTemporaryApprovalSummary(scope, context) {
  const duration = scope === "5m" ? "for 5 minutes" : "for this paired session";
  if (!context) {
    return `Auto-approve current-thread reads ${duration}`;
  }
  return `Auto-approve current-thread reads ${duration} · ${context.summary}`;
}

function describeSlackLocation(context) {
  if (!context) return "unknown Slack location";
  const parts = [];
  if (context.channelKey) parts.push(context.channelKey);
  if (context.workspaceKey) parts.push(context.workspaceKey);
  return parts.length > 0 ? parts.join(" in ") : context.host || context.url || "unknown Slack location";
}

function summarizeChannelRangeScope(startUrl, endUrl) {
  const startContext = parseSlackContextFromUrl(startUrl);
  const endContext = endUrl ? parseSlackContextFromUrl(endUrl) : null;
  const sameWorkspace = Boolean(
    startContext
    && endContext
    && startContext.workspaceKey
    && endContext.workspaceKey
    && startContext.workspaceKey === endContext.workspaceKey,
  );
  const sameChannel = Boolean(
    startContext
    && endContext
    && startContext.channelKey
    && endContext.channelKey
    && startContext.channelKey === endContext.channelKey,
  );

  return {
    startContext,
    endContext,
    sameWorkspace,
    sameChannel,
    crossesContext: Boolean(endContext) && (!sameWorkspace || !sameChannel),
    startLocation: describeSlackLocation(startContext),
    endLocation: endContext ? describeSlackLocation(endContext) : "",
  };
}

function classifyApprovalRequest(message, observedContext = null) {
  if (message.action === "getCurrentThread") {
    return {
      risk: "low",
      scopeLabel: "current thread",
      signature: `getCurrentThread:${buildApprovalContextSignature(observedContext)}`,
      availableDecisions: observedContext ? ["allow_once", "allow_5m", "allow_session", "deny"] : ["allow_once", "deny"],
      policyEligible: Boolean(observedContext),
    };
  }

  if (message.action === "getChannelRange") {
    const limit = Number.isInteger(message.payload?.limit) ? message.payload.limit : null;
    const hasEndUrl = typeof message.payload?.endUrl === "string" && Boolean(message.payload.endUrl);
    const scope = summarizeChannelRangeScope(
      typeof message.payload?.startUrl === "string" ? message.payload.startUrl : "",
      hasEndUrl ? message.payload.endUrl : "",
    );
    return {
      risk: scope.crossesContext || !hasEndUrl || !limit || limit > 25 ? "high" : "medium",
      scopeLabel: scope.crossesContext
        ? "cross-context channel range"
        : hasEndUrl
          ? (limit && limit <= 25 ? "bounded channel range" : "broad channel range")
          : (limit && limit <= 25 ? "forward range from start permalink" : "open-ended forward range"),
      signature: `getChannelRange:${message.payload?.startUrl || ""}:${message.payload?.endUrl || ""}:${limit ?? ""}`,
      availableDecisions: ["allow_once", "deny"],
      policyEligible: false,
    };
  }

  if (message.action === "getChannelRangeAll") {
    const hasEndUrl = typeof message.payload?.endUrl === "string" && Boolean(message.payload.endUrl);
    const maxMessages = Number.isInteger(message.payload?.maxMessages) ? message.payload.maxMessages : 500;
    const includeThreads = message.payload?.includeThreads !== false;
    return {
      risk: includeThreads || !hasEndUrl || maxMessages > 100 ? "high" : "medium",
      scopeLabel: includeThreads
        ? (hasEndUrl ? "paginated summary + thread expansion" : "open-ended paginated summary + thread expansion")
        : (hasEndUrl ? "paginated channel summary" : "open-ended paginated channel summary"),
      signature: `getChannelRangeAll:${message.payload?.startUrl || ""}:${message.payload?.endUrl || ""}:${message.payload?.maxMessages || ""}:${message.payload?.includeThreads !== false}`,
      availableDecisions: ["allow_once", "deny"],
      policyEligible: false,
    };
  }

  if (message.action === "debugCurrentThreadScan" || message.action === "debugCurrentChannelScan") {
    return {
      risk: "medium",
      scopeLabel: "extractor diagnostics",
      signature: message.action,
      availableDecisions: ["allow_once", "deny"],
      policyEligible: false,
    };
  }

  return {
    risk: "medium",
    scopeLabel: "Slack request",
    signature: String(message.action),
    availableDecisions: ["allow_once", "deny"],
    policyEligible: false,
  };
}

function pruneExpiredApprovalPolicies() {
  const now = Date.now();
  for (const [id, policy] of state.tempApprovalPolicies) {
    if (policy.expiresAt !== null && policy.expiresAt <= now) {
      state.tempApprovalPolicies.delete(id);
    }
  }
}

function getApprovalPoliciesForUi() {
  pruneExpiredApprovalPolicies();
  return [...state.tempApprovalPolicies.values()]
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((policy) => ({
      id: policy.id,
      action: policy.action,
      scope: policy.scope,
      risk: policy.risk,
      createdAt: policy.createdAt,
      expiresAt: policy.expiresAt,
      summary: policy.summary,
      contextType: policy.context?.type || "",
      contextSummary: policy.context?.summary || "",
      contextSource: policy.context?.source || "",
    }));
}

function pushRecentActivity(kind, action, summary) {
  const entry = {
    id: `${Date.now()}:${Math.random().toString(16).slice(2, 8)}`,
    at: Date.now(),
    kind,
    action,
    summary,
  };
  state.recentActivity = [...state.recentActivity, entry].slice(-RECENT_ACTIVITY_LIMIT);
}

function clearRecentActivity() {
  state.recentActivity = [];
}

function getRecentActivityForUi() {
  return [...state.recentActivity].sort((a, b) => b.at - a.at);
}

function summarizeSlackPayloadLocation(payload) {
  const channel = typeof payload?.channel === "string" && payload.channel ? payload.channel : "";
  const workspace = typeof payload?.workspace === "string" && payload.workspace ? payload.workspace : "";
  if (channel && workspace) return `${channel} in ${workspace}`;
  return channel || workspace || "Slack";
}

function summarizeReadActivity(action, payload) {
  const location = summarizeSlackPayloadLocation(payload);
  const messageCount = Array.isArray(payload?.messages) ? payload.messages.length : null;

  if (action === "getCurrentThread") {
    return `Read current thread from ${location}${messageCount !== null ? ` (${messageCount} message(s))` : ""}`;
  }
  if (action === "getChannelRange") {
    return `Read channel range from ${location}${messageCount !== null ? ` (${messageCount} message(s))` : ""}`;
  }
  if (action === "getChannelRangeAll") {
    const threadMode = payload?.threadSummariesIncluded ? "thread expansion enabled" : "thread expansion disabled";
    return `Read channel summary from ${location}${messageCount !== null ? ` (${messageCount} message(s), ${threadMode})` : ""}`;
  }
  if (action === "debugCurrentThreadScan") {
    return `Ran thread debug scan on ${location}`;
  }
  if (action === "debugCurrentChannelScan") {
    return `Ran channel debug scan on ${location}`;
  }
  return `Completed ${String(action)}.`;
}

function clearTemporaryApprovalPolicies() {
  const clearedCount = state.tempApprovalPolicies.size;
  state.tempApprovalPolicies.clear();
  state.lastAutoApproval = null;
  if (clearedCount > 0) {
    pushRecentActivity("policies_cleared", "clear-approval-policies", `Cleared ${clearedCount} temporary approval polic${clearedCount === 1 ? "y" : "ies"}.`);
  }
  void updateActionAppearance();
}

function shouldClearPairingOnClose(event) {
  if (event?.code !== 1008) return false;
  const reason = String(event?.reason || "");
  return [
    "Session mismatch",
    "Invalid server challenge",
    "Invalid hello acknowledgement",
    "Invalid server proof",
    "Handshake mismatch",
    "Invalid proof",
    "Pairing rotated",
  ].some((fragment) => reason.includes(fragment));
}

function createTemporaryApprovalPolicy(message, classification, scope, observedContext) {
  const now = Date.now();
  const expiresAt = scope === "5m" ? now + 5 * 60_000 : null;
  return {
    id: `${scope}:${message.action}:${now}`,
    action: message.action,
    scope,
    risk: classification.risk,
    createdAt: now,
    expiresAt,
    sessionId: state.pairing?.sessionId ?? "",
    signature: classification.signature,
    context: observedContext,
    summary: buildTemporaryApprovalSummary(scope, observedContext),
  };
}

function findMatchingApprovalPolicy(message, classification, observedContext) {
  pruneExpiredApprovalPolicies();
  if (!classification.policyEligible || !observedContext) return null;
  const sessionId = state.pairing?.sessionId ?? "";
  for (const policy of state.tempApprovalPolicies.values()) {
    if (policy.sessionId !== sessionId) continue;
    if (policy.action !== message.action) continue;
    if (!policyMatchesObservedContext(policy, observedContext)) continue;
    return policy;
  }
  return null;
}

function noteAutoApproval(message, policy) {
  state.lastAutoApproval = {
    action: message.action,
    scope: policy.scope,
    at: Date.now(),
    summary: policy.summary,
  };
  pushRecentActivity("auto_approved", message.action, `Auto-approved ${message.action} via ${policy.summary}.`);
}

async function approvalSummaryForRequest(message, requestContext = null) {
  if (message.action === "getCurrentThread") {
    const context = requestContext ?? await observeCurrentThreadApprovalContext();
    const bindingLine = context.observedContext
      ? `Temporary approvals for this request would be ${context.observedContext.summary}.`
      : "Temporary approvals are unavailable until Chrome can observe a concrete Slack tab context for this request.";
    return {
      title: "Read current Slack thread",
      lines: [
        ...summarizeTabForApproval(context.activeTab),
        `Slack tabs detected: ${context.slackTabCount}`,
        `Tab selection rule: ${context.selectionRule}`,
        "Reads the currently open Slack thread from the selected Slack tab.",
        "Includes any unsent draft text in the thread composer.",
        bindingLine,
      ],
      observedContext: context.observedContext,
    };
  }

  if (message.action === "getChannelRange") {
    const startUrl = typeof message.payload?.startUrl === "string" ? message.payload.startUrl : "(missing)";
    const endUrl = typeof message.payload?.endUrl === "string" ? message.payload.endUrl : "";
    const limit = Number.isInteger(message.payload?.limit) ? message.payload.limit : null;
    const scope = summarizeChannelRangeScope(startUrl, endUrl);
    return {
      title: "Read Slack channel range",
      lines: [
        `Start permalink: ${startUrl}`,
        `Start location: ${scope.startLocation}`,
        ...(endUrl
          ? [`End permalink: ${endUrl}`, `End location: ${scope.endLocation}`]
          : ["End permalink: not set (Chrome will continue forward from the start permalink)."]),
        ...(limit
          ? [`Requested next messages: ${limit}`]
          : ["Requested next messages: not specified"]),
        ...(endUrl
          ? [scope.crossesContext
              ? "WARNING: start and end permalinks resolve to different Slack contexts; review the range carefully before allowing it."
              : "Scope: a single bounded permalink span in one Slack channel."]
          : ["Scope: a forward range starting at the start permalink; this read is bounded only by the requested next-message count."]),
        "Pagination: single extraction only; this request does not paginate beyond the requested range.",
        "Thread expansion: disabled for this action.",
        "Chrome may temporarily focus a Slack tab to harvest the range.",
      ],
    };
  }

  if (message.action === "getChannelRangeAll") {
    const startUrl = typeof message.payload?.startUrl === "string" ? message.payload.startUrl : "(missing)";
    const endUrl = typeof message.payload?.endUrl === "string" ? message.payload.endUrl : "";
    const maxMessages = Number.isInteger(message.payload?.maxMessages) ? message.payload.maxMessages : 500;
    const pageSize = Number.isInteger(message.payload?.pageSize) ? message.payload.pageSize : CHANNEL_RANGE_PAGE_SIZE;
    const includeThreads = message.payload?.includeThreads !== false;
    const scope = summarizeChannelRangeScope(startUrl, endUrl);
    return {
      title: "Read Slack channel summary span",
      lines: [
        `Start permalink: ${startUrl}`,
        `Start location: ${scope.startLocation}`,
        ...(endUrl
          ? [`End permalink: ${endUrl}`, `End location: ${scope.endLocation}`]
          : ["End permalink: not set (Chrome may continue from the start permalink toward the present until the max-message cap is reached)."]),
        `Max messages across all pages: ${maxMessages}`,
        `Page size: ${pageSize}`,
        `Expand linked threads: ${includeThreads ? "yes" : "no"}`,
        ...(endUrl
          ? [scope.crossesContext
              ? "WARNING: start and end permalinks resolve to different Slack contexts; review the summary span carefully before allowing it."
              : "Scope: paginated harvesting of one permalink-bounded Slack channel span."]
          : ["Scope: open-ended paginated harvesting from the start permalink toward the present."]),
        `Pagination: enabled; Chrome may perform multiple range reads until it reaches the end permalink or ${maxMessages} messages.`,
        ...(includeThreads
          ? ["Thread expansion: enabled; Chrome may revisit linked thread URLs and collect replies while building the summary."]
          : ["Thread expansion: disabled; channel messages will be summarized without revisiting linked thread URLs."]),
        "Chrome may temporarily focus Slack tabs and collect a larger message span.",
        "This is a higher-scope read than the current-thread tool or a single bounded range read.",
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
      risk: approval.risk,
      scopeLabel: approval.scopeLabel,
      availableDecisions: approval.availableDecisions,
      requestCount: approval.requestCount,
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
  const requestContext = message.action === "getCurrentThread"
    ? await observeCurrentThreadApprovalContext()
    : null;
  const classification = classifyApprovalRequest(message, requestContext?.observedContext ?? null);
  const matchingPolicy = findMatchingApprovalPolicy(message, classification, requestContext?.observedContext ?? null);
  if (matchingPolicy) {
    noteAutoApproval(message, matchingPolicy);
    void updateActionAppearance();
    return {
      decision: "auto_approved",
      policyId: matchingPolicy.id,
    };
  }

  const summary = await approvalSummaryForRequest(message, requestContext);
  const existingApproval = [...state.pendingApprovals.values()].find((approval) => approval.signature === classification.signature);
  if (existingApproval) {
    existingApproval.requestCount += 1;
    existingApproval.lines = [...existingApproval.lines.filter((line) => !line.startsWith("Repeated requests:")), `Repeated requests: ${existingApproval.requestCount}`];
    pushRecentActivity("approval_repeated", message.action, `Coalesced repeated approval request for ${existingApproval.title}.`);
    void updateActionAppearance();
    return await new Promise((resolve, reject) => {
      existingApproval.waiters.push({ requestId: message.id, resolve, reject });
    });
  }

  const approval = {
    id: message.id,
    action: message.action,
    title: summary.title,
    lines: summary.lines,
    createdAt: Date.now(),
    expiresAt: Date.now() + APPROVAL_TIMEOUT_MS,
    timeout: null,
    risk: classification.risk,
    scopeLabel: classification.scopeLabel,
    signature: classification.signature,
    availableDecisions: classification.availableDecisions,
    observedContext: summary.observedContext ?? requestContext?.observedContext ?? null,
    requestCount: 1,
    waiters: [],
  };

  return await new Promise((resolve, reject) => {
    approval.waiters.push({ requestId: message.id, resolve, reject });
    approval.timeout = setTimeout(() => {
      state.pendingApprovals.delete(approval.id);
      pushRecentActivity("approval_timeout", approval.action, `Approval timed out for ${approval.title}.`);
      for (const waiter of approval.waiters) {
        waiter.reject(new BridgeActionError("approval_timeout", "Slack read approval timed out in Chrome."));
      }
      void updateActionAppearance();
    }, APPROVAL_TIMEOUT_MS);

    state.pendingApprovals.set(approval.id, approval);
    pushRecentActivity("approval_requested", approval.action, `Approval requested: ${approval.title}.`);
    void updateActionAppearance();
    void openApprovalWindow();
  });
}

function resolveApproval(id, decision) {
  const approval = state.pendingApprovals.get(id);
  if (!approval) return false;
  clearTimeout(approval.timeout);
  state.pendingApprovals.delete(id);

  const normalizedDecision = ["allow_once", "allow_5m", "allow_session", "deny"].includes(decision)
    ? decision
    : "deny";

  let createdPolicy = null;
  if ((normalizedDecision === "allow_5m" || normalizedDecision === "allow_session") && approval.observedContext) {
    const scope = normalizedDecision === "allow_5m" ? "5m" : "session";
    createdPolicy = createTemporaryApprovalPolicy(
      { action: approval.action },
      { risk: approval.risk, signature: approval.signature, policyEligible: true },
      scope,
      approval.observedContext,
    );
    state.tempApprovalPolicies.set(createdPolicy.id, createdPolicy);
  }

  if (normalizedDecision === "deny") {
    pushRecentActivity("approval_denied", approval.action, `Denied ${approval.title}.`);
    for (const waiter of approval.waiters) {
      waiter.reject(new BridgeActionError("user_denied", "User denied this Slack read request in Chrome."));
    }
  } else {
    pushRecentActivity(
      "approval_allowed",
      approval.action,
      createdPolicy
        ? `Allowed ${approval.title} with temporary policy: ${createdPolicy.summary}.`
        : `Allowed ${approval.title} once.`,
    );
    for (const waiter of approval.waiters) {
      waiter.resolve({
        decision: normalizedDecision,
        policyId: createdPolicy?.id ?? null,
      });
    }
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
    for (const waiter of approval.waiters) {
      waiter.reject(new BridgeActionError("approval_cancelled", reason));
    }
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

async function observeCurrentThreadApprovalContext() {
  const details = await getSlackTabsDetailed();
  const activeTab = serializeTab(details.activeTab);
  return {
    activeTab,
    slackTabCount: details.count,
    selectionRule: details.selectionRule,
    observedContext: buildObservedThreadApprovalContext(activeTab),
  };
}

function strengthenPolicyContextFromThreadResult(policyId, activeTab, payload) {
  if (!policyId) return;
  const policy = state.tempApprovalPolicies.get(policyId);
  if (!policy || policy.action !== "getCurrentThread") return;

  const threadPermalink = typeof payload?.rootMessage?.permalinkUrl === "string" ? payload.rootMessage.permalinkUrl : "";
  const parsedPermalink = parseSlackContextFromUrl(threadPermalink);
  const baseTab = activeTab && typeof activeTab === "object" ? activeTab : null;
  const nextContext = buildObservedThreadApprovalContext(baseTab, {
    source: threadPermalink ? "thread_result" : "tab",
    workspaceKey: typeof payload?.workspace === "string" ? payload.workspace : (parsedPermalink?.workspaceKey || ""),
    workspaceLabel: typeof payload?.workspace === "string" ? payload.workspace : "",
    channelKey: parsedPermalink?.channelKey || "",
    channelLabel: typeof payload?.channel === "string" ? payload.channel : "",
    threadKey: parsedPermalink?.threadKey || "",
    threadPermalink,
  });

  if (!nextContext) return;
  policy.context = nextContext;
  policy.summary = buildTemporaryApprovalSummary(policy.scope, nextContext);
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
    let previousLastMessageTs = "";
    const seenCursors = new Set();

    while (allMessages.length < maxMessages) {
      if (signal?.aborted) break; // T16: stop pagination if Pi timed out
      const limit = Math.min(pageSize, maxMessages - allMessages.length);
      let payload;

      if (cursor) {
        const normalizedCursor = normalizeSlackTs(cursor);
        if (!normalizedCursor) {
          throw new BridgeActionError("pagination_stalled", "Slack pagination cursor became invalid before the next page read.");
        }
        if (seenCursors.has(normalizedCursor)) {
          throw new BridgeActionError("pagination_stalled", "Slack channel pagination repeated the same cursor and stopped making progress.");
        }
        seenCursors.add(normalizedCursor);
      }

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

      const lastMessage = payload.messages[payload.messages.length - 1];
      const lastMessageTs = normalizeSlackTs(typeof lastMessage?.messageTs === "string" ? lastMessage.messageTs : "");
      if (previousLastMessageTs && lastMessageTs && lastMessageTs <= previousLastMessageTs) {
        throw new BridgeActionError("pagination_stalled", "Slack channel pagination stopped advancing through message timestamps.");
      }
      if (lastMessageTs) {
        previousLastMessageTs = lastMessageTs;
      }

      if (!payload.nextCursor) break;
      const nextCursor = normalizeSlackTs(payload.nextCursor);
      if (!nextCursor) {
        throw new BridgeActionError("pagination_stalled", "Slack channel pagination returned an unusable next cursor.");
      }
      if (nextCursor === normalizeSlackTs(cursor)) {
        throw new BridgeActionError("pagination_stalled", "Slack channel pagination returned the same cursor twice in a row.");
      }
      cursor = nextCursor;
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
      const approvalResult = await requestUserApproval(message);
      const result = await withExecutionTimeout(
        message.action,
        sendMessageToActiveSlackTab({ type: "pi-slack:get-current-thread" }),
      );
      if (!result.response.ok) {
        const errorPayload = result.response.error ?? {
          code: "thread_read_failed",
          message: "The Slack content script failed to read the current thread.",
        };
        pushRecentActivity("read_failed", message.action, `Current thread read failed: ${errorPayload.message}`);
        sendSocketResponse(socket, message.id, {
          ok: false,
          error: errorPayload,
        });
        return;
      }

      strengthenPolicyContextFromThreadResult(approvalResult?.policyId ?? null, result.activeTab, result.response.payload);
      pushRecentActivity("read_completed", message.action, summarizeReadActivity(message.action, result.response.payload));
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
      pushRecentActivity("read_completed", message.action, summarizeReadActivity(message.action, payload));
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
        pushRecentActivity("read_completed", message.action, summarizeReadActivity(message.action, payload));
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
        const errorPayload = result.response.error ?? {
          code: "thread_debug_failed",
          message: "The Slack content script failed to build a thread debug scan.",
        };
        pushRecentActivity("read_failed", message.action, `Thread debug scan failed: ${errorPayload.message}`);
        sendSocketResponse(socket, message.id, {
          ok: false,
          error: errorPayload,
        });
        return;
      }

      pushRecentActivity("read_completed", message.action, summarizeReadActivity(message.action, result.response.payload));
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
        const errorPayload = result.response.error ?? {
          code: "channel_debug_failed",
          message: "The Slack content script failed to build a channel debug scan.",
        };
        pushRecentActivity("read_failed", message.action, `Channel debug scan failed: ${errorPayload.message}`);
        sendSocketResponse(socket, message.id, {
          ok: false,
          error: errorPayload,
        });
        return;
      }

      pushRecentActivity("read_completed", message.action, summarizeReadActivity(message.action, result.response.payload));
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
    const errorPayload = toErrorPayload(error);
    pushRecentActivity("read_failed", message.action, `${String(message.action)} failed: ${errorPayload.message}`);
    sendSocketResponse(socket, message.id, {
      ok: false,
      error: errorPayload,
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
    let approval = state.pendingApprovals.get(parsed.id);
    if (!approval) {
      approval = [...state.pendingApprovals.values()].find((candidate) =>
        candidate.waiters.some((waiter) => waiter.requestId === parsed.id),
      );
    }
    if (approval) {
      clearTimeout(approval.timeout);
      state.pendingApprovals.delete(approval.id);
      for (const waiter of approval.waiters) {
        waiter.reject(new BridgeActionError("approval_cancelled", "Pi Slack cancelled the pending Chrome approval request."));
      }
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
      clearTemporaryApprovalPolicies();
      state.reconnectAttempt += 1;
      if (event.reason) {
        state.lastError = `Socket closed: ${event.reason}`;
      } else if (event.code) {
        state.lastError = `Socket closed (${event.code}).`;
      }
      const clearPairingBecauseStale = shouldClearPairingOnClose(event);
      resetSocketState();
      void updateActionAppearance();
      if (clearPairingBecauseStale) {
        void clearPairing().then(() => {
          state.lastError = "Pairing is stale or rotated. Run /slack-pair and pair Chrome again.";
          void updateActionAppearance();
        });
        return;
      }
      void scheduleReconnect();
    }
  });

  return false;
}

async function getStatus() {
  await ensureConnected();
  const pairing = state.pairing ?? await getPairing();
  const tabs = await getSlackTabs();
  const policies = getApprovalPoliciesForUi();
  const recentActivity = getRecentActivityForUi();
  const sessionScopedTemporaryApprovalCount = policies.filter((policy) => policy.scope === "session").length;

  return {
    connected: state.connected,
    authenticated: state.authenticated,
    socketState: state.socketState,
    wsUrl: pairing ? wsUrlFromPairing(pairing) : "",
    hasPairing: Boolean(pairing),
    pairSessionId: pairing?.sessionId ?? "",
    pendingApprovalCount: state.pendingApprovals.size,
    temporaryApprovalPolicyCount: policies.length,
    sessionScopedTemporaryApprovalCount,
    lastAutoApproval: state.lastAutoApproval,
    activeApprovalPolicies: policies,
    recentActivity,
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
  clearTemporaryApprovalPolicies();
  clearRecentActivity();
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
        clearTemporaryApprovalPolicies();
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
        clearTemporaryApprovalPolicies();
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
    sendResponse({ pending: getPendingApprovalsForUi(), policies: getApprovalPoliciesForUi(), recentActivity: getRecentActivityForUi() });
    return undefined;
  }

  if (message.type === "pi-slack:open-approval-window") {
    openApprovalWindow().then(() => sendResponse({ ok: true })).catch((error) => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });
    return true;
  }

  if (message.type === "pi-slack:resolve-approval") {
    sendResponse({ ok: resolveApproval(String(message.id ?? ""), String(message.decision ?? "deny")) });
    return undefined;
  }

  if (message.type === "pi-slack:clear-approval-policies") {
    clearTemporaryApprovalPolicies();
    sendResponse({ ok: true });
    return undefined;
  }

  if (message.type === "pi-slack:clear-activity-history") {
    clearRecentActivity();
    sendResponse({ ok: true });
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
