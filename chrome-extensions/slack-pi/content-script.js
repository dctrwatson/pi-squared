if (!globalThis.__slackPiContentScriptLoaded) {
  globalThis.__slackPiContentScriptLoaded = true;

  const SCROLL_SETTLE_MS = 120;
  const MAX_SCROLL_STEPS = 240;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

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

  function filterLeafCandidates(elements) {
    return elements.filter(
      (element, index) =>
        !elements.some((other, otherIndex) => otherIndex !== index && element.contains(other)),
    );
  }

  function removeNodes(root, selectors) {
    for (const selector of selectors) {
      for (const element of root.querySelectorAll(selector)) {
        element.remove();
      }
    }
  }

  function stripLeadingMetadata(text, author, timestamp) {
    const lines = text
      .split("\n")
      .map((line) => normalizeText(line))
      .filter(Boolean);

    const metadata = [author, timestamp].filter(Boolean);
    while (lines.length > 0) {
      const line = lines[0];
      if (!line) break;
      if (metadata.some((value) => value === line)) {
        lines.shift();
        continue;
      }
      if (author && timestamp && line.includes(author) && line.includes(timestamp)) {
        lines.shift();
        continue;
      }
      break;
    }

    return normalizeText(lines.join("\n"));
  }

  function extractMessageTextFromSelectors(messageElement, composerElement) {
    const preferredSelectors = [
      '[data-qa="message-text"]',
      '[data-qa*="message-text"]',
      '[data-qa*="message_body"]',
      '[data-qa*="message-body"]',
      '[data-qa*="message_content"]',
      '[data-qa*="message-content"]',
      '[data-qa*="message_blocks"]',
      '[data-qa*="message-blocks"]',
      '[class*="message_body"]',
      '[class*="message-body"]',
      '[class*="message__body"]',
      '[class*="message_content"]',
      '[class*="message-content"]',
      '[class*="message_blocks"]',
      '[class*="message-blocks"]',
      '[class*="p-rich_text"]',
      '[class*="rich_text"]',
      '[class*="rich-text"]',
      '[data-stringify-type="paragraph"]',
      '[data-stringify-type="blockquote"]',
      '[data-stringify-type="pre"]',
      'blockquote',
      'pre',
    ];

    const fallbackSelectors = [
      '[data-stringify-type="code"]',
      '[data-stringify-type]',
      'code',
    ];

    const filterCandidates = (elements) =>
      elements.filter((element) => {
        if (composerElement && composerElement.contains(element)) return false;
        return true;
      });

    const preferredCandidates = filterLeafCandidates(filterCandidates(queryVisibleAll(messageElement, preferredSelectors)));
    const fallbackCandidates = filterLeafCandidates(filterCandidates(queryVisibleAll(messageElement, fallbackSelectors)));
    const candidates = preferredCandidates.length > 0 ? preferredCandidates : fallbackCandidates;

    const parts = [];
    const seen = new Set();
    for (const element of candidates) {
      const text = getElementText(element);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      parts.push(text);
    }

    const author = extractAuthor(messageElement);
    const timestamp = extractTimestamp(messageElement);
    return stripLeadingMetadata(normalizeText(parts.join("\n")), author, timestamp);
  }

  function extractMessageTextFallback(messageElement, composerElement) {
    const author = extractAuthor(messageElement);
    const timestamp = extractTimestamp(messageElement);
    const clone = messageElement.cloneNode(true);
    if (!(clone instanceof HTMLElement)) return "";

    removeNodes(clone, [
      '[data-qa="message_sender_name"]',
      '[data-qa*="message_sender"]',
      '[data-qa*="sender_name"]',
      '[data-qa*="message_author"]',
      'button',
      'time',
      'svg',
      'img',
      '[aria-hidden="true"]',
      '[role="toolbar"]',
      '[data-qa*="reaction"]',
      '[data-qa*="metadata"]',
    ]);

    if (composerElement) {
      const composerText = getElementText(composerElement);
      if (composerText) {
        const cloneText = getElementText(clone).replace(composerText, "");
        return stripLeadingMetadata(cloneText, author, timestamp);
      }
    }

    return stripLeadingMetadata(getElementText(clone), author, timestamp);
  }

  function extractMessageText(messageElement, composerElement) {
    const direct = extractMessageTextFromSelectors(messageElement, composerElement);
    if (direct) return direct;
    return extractMessageTextFallback(messageElement, composerElement);
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

  function extractMessages(threadRoot, composerElement) {
    const messageElements = findMessageElements(threadRoot, composerElement);
    return messageElements
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
  }

  function makeMessageKey(message) {
    return [message.timestamp || "", message.author || "", message.text.slice(0, 240)].join("\u241f");
  }

  function collectMessagesInto(map, messages) {
    for (const message of messages) {
      const key = makeMessageKey(message);
      if (!map.has(key)) {
        map.set(key, message);
      }
    }
  }

  function getElementDepth(element) {
    let depth = 0;
    let current = element;
    while (current.parentElement) {
      depth += 1;
      current = current.parentElement;
    }
    return depth;
  }

  function findThreadScrollContainer(threadRoot) {
    const candidates = [threadRoot, ...threadRoot.querySelectorAll("*")].filter((element) => {
      if (!(element instanceof HTMLElement)) return false;
      if (!isVisible(element)) return false;
      if (element.scrollHeight <= element.clientHeight + 40) return false;
      const style = window.getComputedStyle(element);
      if (!["auto", "scroll", "overlay"].includes(style.overflowY)) return false;
      return true;
    });

    const scored = candidates
      .map((element) => {
        const qa = (element.getAttribute("data-qa") || "").toLowerCase();
        const hasListItems = Boolean(element.querySelector('[data-qa="virtual-list-item"], [role="listitem"]'));
        const hasComposer = Boolean(findComposer(element));
        const overflow = Math.min(600, element.scrollHeight - element.clientHeight);
        const depth = getElementDepth(element);
        let score = overflow + depth;
        if (hasListItems) score += 2_000;
        if (qa.includes("virtual") || qa.includes("scroll")) score += 400;
        if (hasComposer) score += 100;
        return { element, score };
      })
      .sort((a, b) => b.score - a.score);

    return scored[0]?.element ?? null;
  }

  function findReportedMessageCount(threadRoot) {
    const text = getElementText(threadRoot);
    const matches = [...text.matchAll(/\b(\d{1,5})\s+repl(?:y|ies)\b/gi)];
    if (matches.length === 0) return undefined;
    const last = matches[matches.length - 1];
    if (!last || !last[1]) return undefined;
    const value = Number.parseInt(last[1], 10);
    return Number.isFinite(value) ? value : undefined;
  }

  async function harvestThreadMessages(threadRoot, composerElement) {
    const visibleMessages = extractMessages(threadRoot, composerElement);
    const scrollContainer = findThreadScrollContainer(threadRoot);

    if (!scrollContainer) {
      return {
        messages: visibleMessages,
        harvestedViaScroll: false,
      };
    }

    const originalScrollTop = scrollContainer.scrollTop;
    const originalScrollBehavior = scrollContainer.style.scrollBehavior;
    const collected = new Map();

    try {
      scrollContainer.style.scrollBehavior = "auto";
      scrollContainer.scrollTop = 0;
      await sleep(SCROLL_SETTLE_MS);
      collectMessagesInto(collected, extractMessages(threadRoot, composerElement));

      let lastScrollTop = -1;
      for (let step = 0; step < MAX_SCROLL_STEPS; step += 1) {
        const maxScrollTop = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
        const currentTop = scrollContainer.scrollTop;
        collectMessagesInto(collected, extractMessages(threadRoot, composerElement));

        if (currentTop >= maxScrollTop - 2) {
          break;
        }

        const stepSize = Math.max(160, Math.floor(scrollContainer.clientHeight * 0.8));
        const nextTop = Math.min(maxScrollTop, currentTop + stepSize);
        if (nextTop <= currentTop + 1 || nextTop === lastScrollTop) {
          break;
        }

        lastScrollTop = currentTop;
        scrollContainer.scrollTop = nextTop;
        await sleep(SCROLL_SETTLE_MS);
      }

      scrollContainer.scrollTop = scrollContainer.scrollHeight;
      await sleep(SCROLL_SETTLE_MS);
      collectMessagesInto(collected, extractMessages(threadRoot, composerElement));
    } finally {
      scrollContainer.scrollTop = originalScrollTop;
      scrollContainer.style.scrollBehavior = originalScrollBehavior;
    }

    const messages = [...collected.values()];
    messages.forEach((message, index) => {
      message.isRoot = index === 0;
    });

    return {
      messages,
      harvestedViaScroll: true,
    };
  }

  async function buildThreadSnapshot() {
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
    const harvest = await harvestThreadMessages(threadRoot, composerElement);
    const messages = harvest.messages;

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
    const reportedMessageCount = findReportedMessageCount(threadRoot);

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
        reportedMessageCount,
        harvestedViaScroll: harvest.harvestedViaScroll,
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
      void buildThreadSnapshot()
        .then((result) => sendResponse(result))
        .catch((error) => {
          sendResponse({
            ok: false,
            error: {
              code: "thread_extraction_failed",
              message: error instanceof Error ? error.message : String(error),
            },
          });
        });
      return true;
    }

    return undefined;
  });

  console.debug("[slack-pi] content script loaded", {
    title: document.title,
    url: window.location.href,
  });
} else {
  console.debug("[slack-pi] content script already loaded", {
    title: document.title,
    url: window.location.href,
  });
}
