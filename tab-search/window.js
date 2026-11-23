import { replacePinnedTab, updatePinnedTabUrl } from './pins.js';

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) {
    updatePinnedTabUrl(tabId, changeInfo.url).catch(error => console.error('保存置顶标签页网址失败', error));
  }
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  replacePinnedTab(addedTabId, removedTabId).catch(error => console.error('更新置顶标签页失败', error));
});

let opening = false;

export async function openTabSearch(tab) {
  if (opening) return;
  opening = true;
  try {
    const source = tab?.windowId == null ? await chrome.windows.getLastFocused() : await chrome.windows.get(tab.windowId);
    if (source.type !== 'normal' || source.incognito) return;

    const url = new URL(chrome.runtime.getURL('tab-search/search.html'));
    url.searchParams.set('windowId', source.id);
    const width = Math.min(620, source.width);
    const height = Math.min(390, source.height);
    await chrome.windows.create({
      url: url.href, type: 'popup', focused: true, width, height,
      left: source.left + Math.floor((source.width - width) / 2),
      top: source.top + Math.floor((source.height - height) / 2)
    });
  } finally {
    opening = false;
  }
}
