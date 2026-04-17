const approvalsEl = document.getElementById("approvals");

function formatTimestamp(timestamp) {
  if (!timestamp) return "unknown";
  return new Date(timestamp).toLocaleTimeString();
}

async function resolveApproval(id, decision) {
  await chrome.runtime.sendMessage({
    type: "pi-slack:resolve-approval",
    id,
    decision,
  });
  await refresh();
}

function renderApproval(approval) {
  const wrapper = document.createElement("div");
  wrapper.className = "approval";

  const title = document.createElement("h2");
  title.textContent = approval.title;
  wrapper.appendChild(title);

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = `Requested ${formatTimestamp(approval.createdAt)} · expires ${formatTimestamp(approval.expiresAt)}`;
  wrapper.appendChild(meta);

  const list = document.createElement("ul");
  for (const line of approval.lines || []) {
    const item = document.createElement("li");
    item.textContent = line;
    list.appendChild(item);
  }
  wrapper.appendChild(list);

  const actions = document.createElement("div");
  actions.className = "actions";

  const allow = document.createElement("button");
  allow.type = "button";
  allow.textContent = "Allow once";
  allow.addEventListener("click", () => {
    void resolveApproval(approval.id, "allow");
  });
  actions.appendChild(allow);

  const deny = document.createElement("button");
  deny.type = "button";
  deny.textContent = "Deny";
  deny.addEventListener("click", () => {
    void resolveApproval(approval.id, "deny");
  });
  actions.appendChild(deny);

  wrapper.appendChild(actions);
  return wrapper;
}

async function refresh() {
  const state = await chrome.runtime.sendMessage({ type: "pi-slack:get-approval-state" });
  const pending = Array.isArray(state?.pending) ? state.pending : [];

  approvalsEl.replaceChildren();
  if (pending.length === 0) {
    approvalsEl.className = "empty";
    approvalsEl.textContent = "No pending approvals.";
    return;
  }

  approvalsEl.className = "";
  for (const approval of pending) {
    approvalsEl.appendChild(renderApproval(approval));
  }
}

void refresh();
setInterval(() => {
  void refresh();
}, 1000);
