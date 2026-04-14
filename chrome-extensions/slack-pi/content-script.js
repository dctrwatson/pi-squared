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

  return undefined;
});

console.debug("[slack-pi] content script scaffold loaded", {
  title: document.title,
  url: window.location.href,
});
