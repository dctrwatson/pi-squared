const statusEl = document.getElementById("status");
const pairingCodeEl = document.getElementById("pairing-code");
const resultEl = document.getElementById("result");
const savePairingButton = document.getElementById("save-pairing");
const resetPairingButton = document.getElementById("reset-pairing");
const testConnectionButton = document.getElementById("test-connection");
const openApprovalsButton = document.getElementById("open-approvals");

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

function formatStatus(status) {
  const lines = [
    `Bridge: ${status.connected ? "connected" : "offline"}`,
    `Socket state: ${status.socketState}`,
    `Authenticated: ${status.authenticated ? "yes" : "no"}`,
    `Pairing configured: ${status.hasPairing ? "yes" : "no"}`,
    `Endpoint: ${status.wsUrl || "(none)"}`,
    `Pending approvals: ${status.pendingApprovalCount}`,
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

  if (status.lastError) {
    lines.push(`Last error: ${status.lastError}`);
  }

  return lines.join("\n");
}

async function refreshStatus() {
  const status = await chrome.runtime.sendMessage({ type: "pi-slack:get-status" });
  setStatusText(formatStatus(status));
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

refreshStatus().catch((error) => {
  setStatusText(`Failed to load status: ${String(error)}`);
});
