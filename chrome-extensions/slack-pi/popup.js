const statusEl = document.getElementById("status");
const tokenEl = document.getElementById("token");
const testResultEl = document.getElementById("test-result");
const saveTokenButton = document.getElementById("save-token");
const resetTokenButton = document.getElementById("reset-token");
const testConnectionButton = document.getElementById("test-connection");

function setStatusText(text) {
  statusEl.textContent = text;
}

function setTestResult(text) {
  testResultEl.textContent = text;
}

function formatStatus(status) {
  const lines = [
    `Bridge: ${status.connected ? "connected" : "offline"}`,
    `Endpoint: ${status.wsUrl}`,
    `Token configured: ${status.hasToken ? "yes" : "no"}`,
    `Slack tabs: ${status.slackTabCount}`,
  ];

  if (status.activeTab) {
    lines.push(`Active tab: ${status.activeTab.title || "(untitled)"}`);
  } else {
    lines.push("Active tab: none");
  }

  if (status.note) {
    lines.push(`Note: ${status.note}`);
  }

  return lines.join("\n");
}

async function refreshStatus() {
  const status = await chrome.runtime.sendMessage({ type: "slack-pi:get-status" });
  setStatusText(formatStatus(status));
}

saveTokenButton.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({
    type: "slack-pi:set-token",
    token: tokenEl.value,
  });
  setTestResult("Token saved.");
  await refreshStatus();
});

resetTokenButton.addEventListener("click", async () => {
  tokenEl.value = "";
  await chrome.runtime.sendMessage({ type: "slack-pi:reset-token" });
  setTestResult("Token cleared.");
  await refreshStatus();
});

testConnectionButton.addEventListener("click", async () => {
  const result = await chrome.runtime.sendMessage({ type: "slack-pi:test-connection" });
  setTestResult(result.message || (result.ok ? "Connected." : "Not connected."));
});

refreshStatus().catch((error) => {
  setStatusText(`Failed to load status: ${String(error)}`);
});
