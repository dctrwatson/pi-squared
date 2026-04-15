if (!globalThis.__slackPiContentScriptLoaded) {
  globalThis.__slackPiContentScriptLoaded = true;

  const SCROLL_SETTLE_MS = 120;
  const MAX_SCROLL_STEPS = 240;
  const READY_POLL_MS = 250;
  const READY_TIMEOUT_MS = 10_000;

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
    if (element.getAttribute("aria-hidden") === "true") return false;
    if (document.visibilityState !== "visible") return true;
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

  function parseSlackTsFromUrl(url) {
    if (!url) return undefined;

    try {
      const parsed = new URL(url, window.location.href);
      const messageTs = parsed.searchParams.get("message_ts");
      if (messageTs) {
        return messageTs.replace(/[^\d.]/g, "");
      }

      const archiveMatch = parsed.pathname.match(/\/(?:archives|messages)\/[^/]+\/p(\d{16})/i);
      if (archiveMatch && archiveMatch[1]) {
        const digits = archiveMatch[1];
        return `${digits.slice(0, 10)}.${digits.slice(10)}`;
      }
    } catch {
      return undefined;
    }

    return undefined;
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

  function extractMessagePermalinkUrl(messageElement) {
    const selectors = [
      'a[href*="/archives/"][href*="/p"]',
      'a[href*="/messages/"][href*="/p"]',
      'a[href*="message_ts="]',
    ];

    for (const selector of selectors) {
      const element = messageElement.querySelector(selector);
      if (!(element instanceof HTMLAnchorElement)) continue;
      const href = element.href || element.getAttribute("href");
      if (href) return href;
    }

    return undefined;
  }

  function extractMessageTs(messageElement) {
    const permalinkUrl = extractMessagePermalinkUrl(messageElement);
    return parseSlackTsFromUrl(permalinkUrl);
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

  function countMessageLikeDescendants(root) {
    if (!(root instanceof HTMLElement)) return 0;
    return root.querySelectorAll(
      '[data-qa="virtual-list-item"], [data-qa^="virtual-list-item"], [data-qa*="message_container"], [data-qa*="message"][data-qa*="container"], [role="listitem"]',
    ).length;
  }

  function findMainRoot() {
    const selectors = [
      '[role="main"]',
      'main',
      '[data-qa*="message_pane"]',
      '[data-qa*="conversation"]',
      '[data-qa*="client"]',
    ];

    const candidates = queryVisibleAll(document, selectors);
    const scored = candidates
      .map((candidate) => {
        const messageCount = countMessageLikeDescendants(candidate);
        const hasComposer = Boolean(findComposer(candidate));
        const rect = candidate.getBoundingClientRect();
        const area = Math.max(0, rect.width * rect.height);
        let score = messageCount * 100;
        if (hasComposer) score += 500;
        if (candidate.getAttribute("role") === "main" || candidate.tagName.toLowerCase() === "main") {
          score += 200;
        }
        score += Math.min(area, 50_000) / 100;
        return { candidate, score, messageCount };
      })
      .sort((a, b) => b.score - a.score);

    const best = scored.find((entry) => entry.messageCount > 0);
    if (best) return best.candidate;
    if (scored[0]) return scored[0].candidate;
    if (document.body && countMessageLikeDescendants(document.body) > 0) return document.body;
    return document.body ?? null;
  }

  async function waitForChannelRoot(timeoutMs = READY_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    let lastRoot = findMainRoot();

    while (Date.now() < deadline) {
      const root = findMainRoot();
      if (root) {
        lastRoot = root;
        if (countMessageLikeDescendants(root) > 0) {
          return root;
        }
      }
      await sleep(READY_POLL_MS);
    }

    return lastRoot ?? findMainRoot();
  }

  function findMessageElements(root, composerElement) {
    const selectors = [
      '[data-qa="virtual-list-item"]',
      '[data-qa^="virtual-list-item"]',
      '[data-qa*="message_container"]',
      '[data-qa*="message"][data-qa*="container"]',
      '[role="listitem"]',
    ];

    const candidates = queryVisibleAll(root, selectors).filter((element) =>
      isLikelyMessageElement(element, composerElement),
    );

    return candidates.filter(
      (element, index) =>
        !candidates.some((other, otherIndex) => otherIndex !== index && other.contains(element)),
    );
  }

  function backfillMissingAuthors(messages) {
    let currentAuthor;

    return messages.map((message) => {
      if (!message) return message;
      if (message.author) {
        currentAuthor = message.author;
        return message;
      }

      // In Slack's compact theme, grouped follow-up messages often omit the
      // visible sender name. Reuse the most recent explicit author for normal
      // message rows that still have a permalink/timestamp identity.
      if (currentAuthor && (message.messageTs || message.permalinkUrl || message.timestamp)) {
        return {
          ...message,
          author: currentAuthor,
        };
      }

      return message;
    });
  }

  function extractMessages(root, composerElement) {
    const messageElements = findMessageElements(root, composerElement);
    const messages = messageElements
      .map((element, index) => {
        const text = extractMessageText(element, composerElement);
        if (!text) return null;
        return {
          author: extractAuthor(element) || undefined,
          text,
          timestamp: extractTimestamp(element) || undefined,
          messageTs: extractMessageTs(element),
          permalinkUrl: extractMessagePermalinkUrl(element),
          isRoot: index === 0,
        };
      })
      .filter(Boolean);

    return backfillMissingAuthors(messages);
  }

  function makeMessageKey(message) {
    return [message.messageTs || "", message.timestamp || "", message.author || "", message.text.slice(0, 240)].join("\u241f");
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

  function findScrollContainer(root) {
    const candidates = [root, ...root.querySelectorAll("*")].filter((element) => {
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
    const scrollContainer = findScrollContainer(threadRoot);

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

  async function harvestChannelRangeMessages(mainRoot, composerElement, startTs, endTs, limit, cursorTs) {
    const scrollContainer = findScrollContainer(mainRoot);
    const collected = new Map();
    let started = false;
    let reachedEnd = false;
    let hitLimit = false;

    const collectVisible = () => {
      const visible = extractMessages(mainRoot, composerElement);
      for (const message of visible) {
        if (!started) {
          if (cursorTs) {
            // Exclusive start: collect from the first message strictly after the cursor.
            if (message.messageTs && message.messageTs > cursorTs) {
              started = true;
            } else {
              continue;
            }
          } else {
            // Inclusive start: begin at the message matching startTs.
            if (message.messageTs === startTs) {
              started = true;
            } else {
              continue;
            }
          }
        }

        const key = makeMessageKey(message);
        if (!collected.has(key)) {
          collected.set(key, message);
        }

        if (endTs && message.messageTs === endTs) {
          reachedEnd = true;
          break;
        }
        if (limit && collected.size >= limit) {
          hitLimit = true;
          reachedEnd = true;
          break;
        }
      }
    };

    collectVisible();

    // Strip DOM virtualization artifacts: pre-start nodes that Slack hadn't
    // recycled yet and were collected after started=true.
    const withinBounds = (m) => !m.messageTs || (cursorTs ? m.messageTs > cursorTs : m.messageTs >= startTs);

    if (!scrollContainer) {
      return {
        messages: [...collected.values()].filter(withinBounds),
        harvestedViaScroll: false,
        started,
        reachedEnd,
        hitLimit,
      };
    }

    let lastScrollTop = -1;
    for (let step = 0; step < MAX_SCROLL_STEPS; step += 1) {
      if (reachedEnd) break;
      const maxScrollTop = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
      const currentTop = scrollContainer.scrollTop;
      if (currentTop >= maxScrollTop - 2) {
        break;
      }

      const stepSize = Math.max(180, Math.floor(scrollContainer.clientHeight * 0.85));
      const nextTop = Math.min(maxScrollTop, currentTop + stepSize);
      if (nextTop <= currentTop + 1 || nextTop === lastScrollTop) {
        break;
      }

      lastScrollTop = currentTop;
      scrollContainer.scrollTop = nextTop;
      await sleep(SCROLL_SETTLE_MS);
      collectVisible();
    }

    return {
      messages: [...collected.values()].filter(withinBounds),
      harvestedViaScroll: true,
      started,
      reachedEnd,
      hitLimit,
    };
  }

  function getDocumentTextSnippet() {
    return normalizeText(document.body?.innerText || "").slice(0, 800);
  }

  function findBrowserFallbackControl() {
    const selectors = ['a[href]', 'button', '[role="button"]'];
    const positivePatterns = [
      /use (?:slack )?(?:in |on )?(?:your )?browser/i,
      /use browser instead/i,
      /continue in browser/i,
      /open in browser/i,
      /continue to browser/i,
      /stay in browser/i,
      /open slack in your browser/i,
      /use the web app/i,
    ];

    const elements = queryVisibleAll(document, selectors);
    for (const element of elements) {
      const text = getElementText(element);
      if (!text || !positivePatterns.some((pattern) => pattern.test(text))) continue;
      if (element instanceof HTMLAnchorElement) {
        const href = element.href || element.getAttribute("href");
        if (href) {
          try {
            return { action: "navigate", url: new URL(href, window.location.href).href, text };
          } catch {
            return { action: "navigate", url: href, text };
          }
        }
      }
      return { action: "click", element, text };
    }

    return null;
  }

  async function prepareChannelRangePage() {
    const mainRoot = await waitForChannelRoot(2_000);
    if (mainRoot && countMessageLikeDescendants(mainRoot) > 0) {
      return {
        ok: true,
        payload: {
          state: "ready",
          title: document.title,
          url: window.location.href,
        },
      };
    }

    const fallback = findBrowserFallbackControl();
    if (fallback?.action === "navigate") {
      return {
        ok: true,
        payload: {
          state: "navigate",
          title: document.title,
          url: fallback.url,
          controlText: fallback.text,
        },
      };
    }

    if (fallback?.action === "click") {
      setTimeout(() => {
        try {
          fallback.element.click();
        } catch {
          // ignore click failures here; caller will retry and report a better error if needed.
        }
      }, 0);
      return {
        ok: true,
        payload: {
          state: "clicked",
          title: document.title,
          url: window.location.href,
          controlText: fallback.text,
        },
      };
    }

    return {
      ok: true,
      payload: {
        state: "unready",
        title: document.title,
        url: window.location.href,
        textSnippet: getDocumentTextSnippet(),
      },
    };
  }

  async function buildChannelRangeSnapshot(startUrl, endUrl, limit, cursor) {
    const startTs = parseSlackTsFromUrl(startUrl);
    if (!startTs) {
      return {
        ok: false,
        error: {
          code: "invalid_start_url",
          message: "The start Slack URL could not be parsed as a message permalink.",
        },
      };
    }

    const endTs = endUrl ? parseSlackTsFromUrl(endUrl) : undefined;
    if (endUrl && !endTs) {
      return {
        ok: false,
        error: {
          code: "invalid_end_url",
          message: "The end Slack URL could not be parsed as a message permalink.",
        },
      };
    }

    const mainRoot = await waitForChannelRoot();
    if (!mainRoot) {
      return {
        ok: false,
        error: {
          code: "no_channel_view",
          message: "No visible Slack channel view is open.",
        },
      };
    }

    const cursorTs = typeof cursor === "string" && cursor ? cursor : undefined;
    const composerElement = findComposer(mainRoot);
    const harvest = await harvestChannelRangeMessages(mainRoot, composerElement, startTs, endTs, limit, cursorTs);
    if (!harvest.started) {
      return {
        ok: false,
        error: {
          code: cursorTs ? "no_channel_messages" : "start_message_not_found",
          message: cursorTs
            ? "No channel messages found after the pagination cursor."
            : "Could not find the starting Slack message in the loaded channel view.",
        },
      };
    }

    if (harvest.messages.length === 0) {
      return {
        ok: false,
        error: {
          code: "no_channel_messages",
          message: "No channel messages could be extracted from the requested range.",
        },
      };
    }

    const documentMeta = parseDocumentTitle();
    const channel = findChannelName() || undefined;

    const lastMessage = harvest.messages[harvest.messages.length - 1];
    const nextCursor = harvest.hitLimit && lastMessage?.messageTs ? lastMessage.messageTs : undefined;
    const nextStartUrl = harvest.hitLimit && lastMessage?.permalinkUrl ? lastMessage.permalinkUrl : undefined;

    return {
      ok: true,
      payload: {
        workspace: documentMeta.workspace,
        channel,
        title: documentMeta.title || channel,
        url: window.location.href,
        startUrl,
        endUrl: endUrl || undefined,
        requestedLimit: limit,
        messages: harvest.messages,
        harvestedViaScroll: harvest.harvestedViaScroll,
        nextCursor,
        nextStartUrl,
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

    if (message.type === "slack-pi:prepare-channel-range-page") {
      void prepareChannelRangePage()
        .then((result) => sendResponse(result))
        .catch((error) => {
          sendResponse({
            ok: false,
            error: {
              code: "channel_range_prepare_failed",
              message: error instanceof Error ? error.message : String(error),
            },
          });
        });
      return true;
    }

    if (message.type === "slack-pi:get-channel-range") {
      void buildChannelRangeSnapshot(message.startUrl, message.endUrl, message.limit, message.cursor)
        .then((result) => sendResponse(result))
        .catch((error) => {
          sendResponse({
            ok: false,
            error: {
              code: "channel_range_extraction_failed",
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
