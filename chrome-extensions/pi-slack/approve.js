const approvalsEl = document.getElementById("approvals");
const policiesEl = document.getElementById("policies");

function formatTimestamp(timestamp) {
  if (!timestamp) return "unknown";
  return new Date(timestamp).toLocaleTimeString();
}

function formatExpiry(expiresAt) {
  if (expiresAt === null || expiresAt === undefined) return "until pairing/session reset";
  return formatTimestamp(expiresAt);
}

async function resolveApproval(id, decision) {
  await chrome.runtime.sendMessage({
    type: "pi-slack:resolve-approval",
    id,
    decision,
  });
  await refresh();
}

async function clearPolicies() {
  await chrome.runtime.sendMessage({ type: "pi-slack:clear-approval-policies" });
  await refresh();
}

function makeDecisionButton(label, decision, approval) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", () => {
    void resolveApproval(approval.id, decision);
  });
  return button;
}

function renderApproval(approval) {
  const wrapper = document.createElement("div");
  wrapper.className = `approval risk-${approval.risk || "medium"}`;

  const risk = document.createElement("div");
  risk.className = "risk";
  risk.textContent = approval.scopeLabel
    ? `${approval.risk || "medium"} · ${approval.scopeLabel}`
    : `${approval.risk || "medium"} scope`;
  wrapper.appendChild(risk);

  const title = document.createElement("h2");
  title.textContent = approval.title;
  wrapper.appendChild(title);

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = `Requested ${formatTimestamp(approval.createdAt)} · expires ${formatTimestamp(approval.expiresAt)} · repeated requests ${approval.requestCount || 1}`;
  wrapper.appendChild(meta);

  const list = document.createElement("ul");
  for (const line of approval.lines || []) {
    const item = document.createElement("li");
    item.textContent = line;
    if (String(line).startsWith("WARNING:")) {
      item.style.color = "#991b1b";
      item.style.fontWeight = "600";
    }
    list.appendChild(item);
  }
  wrapper.appendChild(list);

  const actions = document.createElement("div");
  actions.className = "actions";
  for (const decision of approval.availableDecisions || ["allow_once", "deny"]) {
    if (decision === "allow_once") actions.appendChild(makeDecisionButton("Allow once", decision, approval));
    if (decision === "allow_5m") actions.appendChild(makeDecisionButton("Allow for 5 min", decision, approval));
    if (decision === "allow_session") actions.appendChild(makeDecisionButton("Allow for session", decision, approval));
    if (decision === "deny") actions.appendChild(makeDecisionButton("Deny", decision, approval));
  }
  wrapper.appendChild(actions);
  return wrapper;
}

function describeContextSource(source) {
  if (source === "thread_result") return "completed thread read";
  if (source === "tab") return "active Slack tab";
  return source || "unknown";
}

function renderPolicy(policy) {
  const wrapper = document.createElement("div");
  wrapper.className = "policy";

  const title = document.createElement("h2");
  title.textContent = policy.summary || policy.action;
  wrapper.appendChild(title);

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = `Created ${formatTimestamp(policy.createdAt)} · expires ${formatExpiry(policy.expiresAt)} · ${policy.risk || "medium"} scope`;
  wrapper.appendChild(meta);

  const list = document.createElement("ul");
  const lines = [
    `Action: ${policy.action}`,
    `Scope: ${policy.scope}`,
    ...(policy.contextSummary ? [`Binding: ${policy.contextSummary}`] : []),
    ...(policy.contextSource ? [`Observed from: ${describeContextSource(policy.contextSource)}`] : []),
  ];
  for (const line of lines) {
    const item = document.createElement("li");
    item.textContent = line;
    list.appendChild(item);
  }
  wrapper.appendChild(list);

  return wrapper;
}

async function refresh() {
  const state = await chrome.runtime.sendMessage({ type: "pi-slack:get-approval-state" });
  const pending = Array.isArray(state?.pending) ? state.pending : [];
  const policies = Array.isArray(state?.policies) ? state.policies : [];

  approvalsEl.replaceChildren();
  if (pending.length === 0) {
    approvalsEl.className = "empty";
    approvalsEl.textContent = "No pending approvals.";
  } else {
    approvalsEl.className = "";
    for (const approval of pending) {
      approvalsEl.appendChild(renderApproval(approval));
    }
  }

  policiesEl.replaceChildren();
  if (policies.length === 0) {
    policiesEl.className = "empty";
    policiesEl.textContent = "No temporary approval policies.";
  } else {
    policiesEl.className = "";
    const clearButton = document.createElement("button");
    clearButton.type = "button";
    clearButton.textContent = "Clear all temporary approvals";
    clearButton.addEventListener("click", () => {
      void clearPolicies();
    });
    policiesEl.appendChild(clearButton);

    for (const policy of policies) {
      policiesEl.appendChild(renderPolicy(policy));
    }
  }
}

void refresh();
setInterval(() => {
  void refresh();
}, 1000);
