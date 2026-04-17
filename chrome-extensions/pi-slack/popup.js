const statusEl = document.getElementById("status");
const pairingCodeEl = document.getElementById("pairing-code");
const resultEl = document.getElementById("result");
const savePairingButton = document.getElementById("save-pairing");
const resetPairingButton = document.getElementById("reset-pairing");
const testConnectionButton = document.getElementById("test-connection");
const openApprovalsButton = document.getElementById("open-approvals");
const clearPoliciesButton = document.getElementById("clear-policies");
const clearActivityButton = document.getElementById("clear-activity");
const activePoliciesEl = document.getElementById("active-policies");
const recentActivityEl = document.getElementById("recent-activity");

function setStatusText(text) {
  statusEl.textContent = text;
}

function setResult(text) {
  resultEl.textContent = text;
}

function formatTimestamp(timestamp) {
  if (!timestamp) return "never";
  return new Date(timestamp).toLocaleString();
}

function formatExpiry(expiresAt) {
  if (expiresAt === null || expiresAt === undefined) return "until pairing/session reset";
  return formatTimestamp(expiresAt);
}

function renderActivePolicies(status) {
  const policies = Array.isArray(status.activeApprovalPolicies) ? status.activeApprovalPolicies : [];
  activePoliciesEl.replaceChildren();

  if (policies.length === 0) {
    activePoliciesEl.textContent = "No active temporary approvals.";
    return;
  }

  if ((status.sessionScopedTemporaryApprovalCount ?? 0) > 0) {
    const warning = document.createElement("div");
    warning.className = "list-item warning";
    warning.textContent = `Warning: ${status.sessionScopedTemporaryApprovalCount} session-scoped temporary approval${status.sessionScopedTemporaryApprovalCount === 1 ? " is" : "s are"} active.`;
    activePoliciesEl.appendChild(warning);
  }

  for (const policy of policies) {
    const item = document.createElement("div");
    item.className = "list-item";
    item.textContent = `${policy.summary} · expires ${formatExpiry(policy.expiresAt)}`;
    activePoliciesEl.appendChild(item);
  }
}

function renderRecentActivity(status) {
  const activity = Array.isArray(status.recentActivity) ? status.recentActivity.slice(0, 8) : [];
  recentActivityEl.replaceChildren();

  if (activity.length === 0) {
    recentActivityEl.textContent = "No recent activity yet.";
    return;
  }

  for (const entry of activity) {
    const item = document.createElement("div");
    item.className = "list-item";
    item.textContent = `${formatTimestamp(entry.at)} · ${entry.summary}`;
    recentActivityEl.appendChild(item);
  }
}

function formatStatus(status) {
  const lines = [
    `Bridge: ${status.connected ? "connected" : "offline"}`,
    `Socket state: ${status.socketState}`,
    `Authenticated: ${status.authenticated ? "yes" : "no"}`,
    `Pairing configured: ${status.hasPairing ? "yes" : "no"}`,
    `Endpoint: ${status.wsUrl || "(none)"}`,
    `Pending approvals: ${status.pendingApprovalCount}`,
    `Temporary approvals: ${status.temporaryApprovalPolicyCount ?? 0}`,
    `Slack tabs: ${status.slackTabCount}`,
  ];

  if (status.pairSessionId) {
    lines.push(`Session: ${status.pairSessionId}`);
  }

  if (status.activeTab) {
    lines.push(`Active tab: ${status.activeTab.title || "(untitled)"}`);
  } else {
    lines.push("Active tab: none");
  }

  if (status.selectionRule) {
    lines.push(`Tab rule: ${status.selectionRule}`);
  }

  if (status.extensionVersion) {
    lines.push(`Extension: v${status.extensionVersion}`);
  }

  lines.push(`Hello sent: ${formatTimestamp(status.lastHelloSentAt)}`);
  lines.push(`Hello ack: ${formatTimestamp(status.lastHelloAckAt)}`);
  lines.push(`Heartbeat: ${formatTimestamp(status.lastHeartbeatSentAt)}`);

  if ((status.sessionScopedTemporaryApprovalCount ?? 0) > 0) {
    lines.push(`WARNING: session-scoped temporary approvals active: ${status.sessionScopedTemporaryApprovalCount}`);
  }

  if (status.lastAutoApproval?.summary) {
    lines.push(`Last auto-approved: ${status.lastAutoApproval.summary} at ${formatTimestamp(status.lastAutoApproval.at)}`);
  }

  if (status.lastError) {
    lines.push(`Last error: ${status.lastError}`);
  }

  return lines.join("\n");
}

async function refreshStatus() {
  const status = await chrome.runtime.sendMessage({ type: "pi-slack:get-status" });
  setStatusText(formatStatus(status));
  renderActivePolicies(status);
  renderRecentActivity(status);
}

savePairingButton.addEventListener("click", async () => {
  const response = await chrome.runtime.sendMessage({
    type: "pi-slack:set-pairing",
    pairingCode: pairingCodeEl.value,
  });

  if (!response?.ok) {
    setResult(response?.error || "Failed to save pairing.");
    return;
  }

  setResult("Pairing saved.");
  await refreshStatus();
});

resetPairingButton.addEventListener("click", async () => {
  pairingCodeEl.value = "";
  await chrome.runtime.sendMessage({ type: "pi-slack:reset-pairing" });
  setResult("Pairing cleared.");
  await refreshStatus();
});

testConnectionButton.addEventListener("click", async () => {
  const result = await chrome.runtime.sendMessage({ type: "pi-slack:test-connection" });
  setResult(result.message || (result.ok ? "Connected." : "Not connected."));
});

openApprovalsButton.addEventListener("click", async () => {
  const result = await chrome.runtime.sendMessage({ type: "pi-slack:open-approval-window" });
  setResult(result?.ok ? "Approval window opened." : (result?.error || "Failed to open approvals."));
});

clearPoliciesButton.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "pi-slack:clear-approval-policies" });
  setResult("Temporary approvals cleared.");
  await refreshStatus();
});

clearActivityButton.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "pi-slack:clear-activity-history" });
  setResult("Activity history cleared.");
  await refreshStatus();
});

refreshStatus().catch((error) => {
  setStatusText(`Failed to load status: ${String(error)}`);
});

setInterval(() => {
  void refreshStatus();
}, 1000);
