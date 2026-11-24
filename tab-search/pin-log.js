const messageType = 'tab-search-pin-diagnostic';
const logPrefix = '[DEBUG-tab-search-pin]';

export function logTabPin(event, details) {
  if (typeof window === 'undefined') {
    console.info(logPrefix, event, details);
    return;
  }
  chrome.runtime.sendMessage({ type: messageType, event, details }).catch(() => {
    console.info(logPrefix, event, details);
  });
}

export function listenForTabPinLogs() {
  const searchUrl = chrome.runtime.getURL('tab-search/search.html');
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.type !== messageType || sender.id !== chrome.runtime.id ||
      !sender.url?.startsWith(`${searchUrl}?`)) return;
    logTabPin(message.event, message.details);
    respond({ ok: true });
  });
}
