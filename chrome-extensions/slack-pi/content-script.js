function normalizeText(value) {
  return String(value ?? "")
    .replace(/\u200B|\u200C|\u200D|\uFEFF/g, "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isVisible(element) {
  if (!(element instanceof HTMLElement)) return false;
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function uniqueElements(elements) {
  const seen = new Set();
  const result = [];
  for (const element of elements) {
    if (!(element instanceof HTMLElement)) continue;
    if (seen.has(element)) continue;
    seen.add(element);
    result.push(element);
  }
  return result;
}

function sortByDocumentOrder(elements) {
  return [...elements].sort((a, b) => {
    if (a === b) return 0;
    const position = a.compareDocumentPosition(b);
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });
}

function queryVisibleAll(root, selectors) {
  const matches = [];
  for (const selector of selectors) {
    const elements = root.querySelectorAll(selector);
    for (const element of elements) {
      if (isVisible(element)) matches.push(element);
    }
  }
  return sortByDocumentOrder(uniqueElements(matches));
}

function queryVisibleFirst(root, selectors) {
  return queryVisibleAll(root, selectors)[0] ?? null;
}

function getElementText(element) {
  if (!(element instanceof HTMLElement)) return "";
  return normalizeText(element.innerText || element.textContent || "");
}

function parseDocumentTitle() {
  const parts = document.title
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => part.toLowerCase() !== "slack");

  return {
    title: parts[0] || document.title.trim(),
    workspace: parts.length >= 2 ? parts[parts.length - 1] : undefined,
  };
}

function findThreadRoot() {
  const selectors = [
    '[data-qa="thread_flexpane"]',
    '[data-qa="threads_flexpane"]',
    '[data-qa="thread-pane"]',
    '[data-qa*="thread"][data-qa*="pane"]',
    'aside[aria-label*="Thread" i]',
    '[aria-label*="Thread" i]',
    'div[role="complementary"]',
  ];

  const candidates = queryVisibleAll(document, selectors);
  for (const candidate of candidates) {
    const text = getElementText(candidate).toLowerCase();
    if (
      text.includes("thread") ||
      candidate.querySelector('[contenteditable="true"]') ||
      candidate.querySelector('[data-qa="virtual-list-item"], [role="listitem"]')
    ) {
      return candidate;
    }
  }

  return null;
}

function isLikelyComposer(element) {
  if (!(element instanceof HTMLElement)) return false;
  if (element.closest('[role="search"]')) return false;
  if (element.closest('header, nav')) return false;

  const label = [
    element.getAttribute("aria-label"),
    element.getAttribute("data-placeholder"),
    element.getAttribute("placeholder"),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (/\b(search|find|filter)\b/.test(label)) return false;
  return true;
}

function findComposer(scope) {
  const selectors = [
    '[data-qa*="message_input"] [contenteditable="true"]',
    '[data-qa*="message_input"] [role="textbox"]',
    '[contenteditable="true"][role="textbox"]',
    '[contenteditable="true"]',
  ];

  const candidates = queryVisibleAll(scope, selectors);
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index];
    if (candidate && isLikelyComposer(candidate)) return candidate;
  }
  return null;
}

function findChannelName() {
  const selectors = [
    '[data-qa="channel_name"]',
    '[data-qa="channel_header_title"]',
    'header h1',
    '[role="main"] h1',
  ];

  const element = queryVisibleFirst(document, selectors);
  return element ? getElementText(element) : "";
}

function extractAuthor(messageElement) {
  const selectors = [
    '[data-qa="message_sender_name"]',
    '[data-qa*="message_sender"]',
    '[data-qa*="sender_name"]',
    '[data-qa*="message_author"]',
    'button[aria-label*="profile" i]',
    'a[data-qa*="message_sender"]',
    'span[data-qa*="message_sender"]',
  ];

  for (const selector of selectors) {
    const element = messageElement.querySelector(selector);
    const text = getElementText(element);
    if (text) return text;
  }

  return "";
}

function extractTimestamp(messageElement) {
  const selectors = [
    'a[href*="/archives/"] time',
    'time',
    'a[href*="/archives/"]',
  ];

  for (const selector of selectors) {
    const element = messageElement.querySelector(selector);
    if (!(element instanceof HTMLElement)) continue;
    const dateTime = element.getAttribute("datetime");
    if (dateTime) return dateTime;
    const text = getElementText(element);
    if (text) return text;
  }

  return "";
}

function extractMessageText(messageElement, composerElement) {
  const contentSelectors = [
    '[data-stringify-type="paragraph"]',
    '[data-stringify-type="blockquote"]',
    '[data-stringify-type="pre"]',
    '[data-stringify-type="code"]',
    '[data-stringify-type]',
    'blockquote',
    'pre',
    'code',
  ];

  const parts = [];
  const seen = new Set();
  for (const selector of contentSelectors) {
    const elements = messageElement.querySelectorAll(selector);
    for (const element of elements) {
      if (!(element instanceof HTMLElement)) continue;
      if (!isVisible(element)) continue;
      if (composerElement && composerElement.contains(element)) continue;
      const text = getElementText(element);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      parts.push(text);
    }
  }

  let text = normalizeText(parts.join("\n"));
  if (!text) {
    text = getElementText(messageElement);
  }

  return text;
}

function isLikelyMessageElement(element, composerElement) {
  if (!(element instanceof HTMLElement)) return false;
  if (composerElement && (composerElement.contains(element) || element.contains(composerElement))) return false;

  const qa = (element.getAttribute("data-qa") || "").toLowerCase();
  const author = extractAuthor(element);
  const timestamp = extractTimestamp(element);
  const text = extractMessageText(element, composerElement);

  if (!text) return false;
  if (qa.includes("message") || qa.includes("virtual-list-item")) return true;
  if (author || timestamp) return true;
  return text.length > 30;
}

function findMessageElements(threadRoot, composerElement) {
  const selectors = [
    '[data-qa="virtual-list-item"]',
    '[data-qa^="virtual-list-item"]',
    '[data-qa*="message_container"]',
    '[data-qa*="message"][data-qa*="container"]',
    '[role="listitem"]',
  ];

  const candidates = queryVisibleAll(threadRoot, selectors).filter((element) =>
    isLikelyMessageElement(element, composerElement),
  );

  return candidates.filter(
    (element, index) =>
      !candidates.some((other, otherIndex) => otherIndex !== index && other.contains(element)),
  );
}

function buildThreadSnapshot() {
  const threadRoot = findThreadRoot();
  if (!threadRoot) {
    return {
      ok: false,
      error: {
        code: "no_thread_open",
        message: "No visible Slack thread pane is open.",
      },
    };
  }

  const composerElement = findComposer(threadRoot);
  const composerDraftText = composerElement ? getElementText(composerElement) : "";
  const messageElements = findMessageElements(threadRoot, composerElement);
  const messages = messageElements
    .map((element, index) => {
      const text = extractMessageText(element, composerElement);
      if (!text) return null;
      return {
        author: extractAuthor(element) || undefined,
        text,
        timestamp: extractTimestamp(element) || undefined,
        isRoot: index === 0,
      };
    })
    .filter(Boolean);

  if (messages.length === 0) {
    return {
      ok: false,
      error: {
        code: "no_thread_messages",
        message: "A thread pane is open, but no thread messages could be extracted.",
      },
    };
  }

  const documentMeta = parseDocumentTitle();
  const channel = findChannelName() || undefined;

  return {
    ok: true,
    payload: {
      workspace: documentMeta.workspace,
      channel,
      title: documentMeta.title || channel,
      url: window.location.href,
      isThread: true,
      rootMessage: messages[0],
      messages,
      composerDraftText: composerDraftText || undefined,
    },
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return undefined;

  if (message.type === "slack-pi:content-ping") {
    sendResponse({
      ok: true,
      title: document.title,
      url: window.location.href,
    });
    return undefined;
  }

  if (message.type === "slack-pi:get-current-thread") {
    try {
      sendResponse(buildThreadSnapshot());
    } catch (error) {
      sendResponse({
        ok: false,
        error: {
          code: "thread_extraction_failed",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
    return undefined;
  }

  return undefined;
});

console.debug("[slack-pi] content script loaded", {
  title: document.title,
  url: window.location.href,
});
