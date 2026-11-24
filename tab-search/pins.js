import { logTabPin } from './pin-log.js';

const pinsKey = 'tabSearchPins';
const bindingsKey = 'tabSearchPinBindings';
const lockName = 'tab-search-pins';
const maxTabPins = 5;

async function readState() {
  const [local, session] = await Promise.all([
    chrome.storage.local.get(pinsKey),
    chrome.storage.session.get(bindingsKey)
  ]);
  return { pinList: local[pinsKey] ?? [], bindingMap: session[bindingsKey] ?? {} };
}

export function readPinnedTabIdSet() {
  return navigator.locks.request(lockName, async () => {
    const { pinList, bindingMap } = await readState();
    return new Set(pinList.map(pin => bindingMap[pin.id]).filter(Number.isInteger));
  });
}

export function readTabPins(tabList) {
  return navigator.locks.request(lockName, async () => {
    const { pinList, bindingMap } = await readState();
    const tabIdSet = new Set(tabList.map(tab => tab.id));
    const nextBindingMap = {};
    const claimedIdSet = new Set();
    for (const pin of pinList) {
      const tabId = bindingMap[pin.id];
      if (!tabIdSet.has(tabId) || claimedIdSet.has(tabId)) continue;
      nextBindingMap[pin.id] = tabId;
      claimedIdSet.add(tabId);
    }
    for (const pin of pinList) {
      if (nextBindingMap[pin.id] !== undefined) continue;
      const tab = tabList.find(tab => (tab.url === pin.url || tab.pendingUrl === pin.url) && !claimedIdSet.has(tab.id));
      if (!tab) continue;
      nextBindingMap[pin.id] = tab.id;
      claimedIdSet.add(tab.id);
    }
    if (JSON.stringify(nextBindingMap) !== JSON.stringify(bindingMap)) {
      await chrome.storage.session.set({ [bindingsKey]: nextBindingMap });
    }
    for (const pin of pinList) {
      const previousTabId = bindingMap[pin.id] ?? null;
      const tabId = nextBindingMap[pin.id] ?? null;
      const matchedTab = tabList.find(tab => tab.id === tabId);
      logTabPin('检查置顶关联', {
        pinId: pin.id,
        previousTabId,
        tabId,
        previousTabInSnapshot: tabIdSet.has(previousTabId),
        tabCount: tabList.length,
        chromePinned: matchedTab?.pinned ?? null,
        savedUrlMatchesCurrent: matchedTab ? matchedTab.url === pin.url : null,
        savedUrlMatchesPending: matchedTab ? matchedTab.pendingUrl === pin.url : null,
        result: tabId === null ? '未找到' : tabId === previousTabId ? '按标签ID找到' : '按网址找到'
      });
    }
    return pinList.map(pin => ({ ...pin, tabId: nextBindingMap[pin.id] }));
  });
}

export function addTabPin(tab) {
  return navigator.locks.request(lockName, async () => {
    const { pinList, bindingMap } = await readState();
    if (pinList.length >= maxTabPins) throw new Error(`最多可置顶${maxTabPins}个标签页。`);
    if (Object.values(bindingMap).includes(tab.id)) return;
    const id = crypto.randomUUID();
    bindingMap[id] = tab.id;
    await chrome.storage.session.set({ [bindingsKey]: bindingMap });
    await chrome.storage.local.set({ [pinsKey]: [...pinList, { id, url: tab.url, title: tab.title, alias: '' }] });
    logTabPin('新增置顶', { pinId: id, tabId: tab.id, chromePinned: tab.pinned });
  });
}

export function changeTabPin(id, alias) {
  return navigator.locks.request(lockName, async () => {
    const { pinList, bindingMap } = await readState();
    if (alias === null) {
      await chrome.storage.local.set({ [pinsKey]: pinList.filter(pin => pin.id !== id) });
      delete bindingMap[id];
      await chrome.storage.session.set({ [bindingsKey]: bindingMap });
    } else {
      await chrome.storage.local.set({ [pinsKey]: pinList.map(pin => pin.id === id ? { ...pin, alias } : pin) });
    }
  });
}

export function bindTabPin(id, tabId) {
  return navigator.locks.request(lockName, async () => {
    const session = await chrome.storage.session.get(bindingsKey);
    const bindingMap = session[bindingsKey] ?? {};
    bindingMap[id] = tabId;
    await chrome.storage.session.set({ [bindingsKey]: bindingMap });
    logTabPin('保存新开标签的关联', { pinId: id, tabId });
  });
}

export function updatePinnedTabUrl(tabId, url) {
  return navigator.locks.request(lockName, async () => {
    const { pinList, bindingMap } = await readState();
    const pin = pinList.find(pin => bindingMap[pin.id] === tabId);
    if (!pin || pin.url === url) return;
    pin.url = url;
    await chrome.storage.local.set({ [pinsKey]: pinList });
    logTabPin('更新置顶网址', { pinId: pin.id, tabId });
  });
}

export function replacePinnedTab(addedTabId, removedTabId) {
  return navigator.locks.request(lockName, async () => {
    const session = await chrome.storage.session.get(bindingsKey);
    const bindingMap = session[bindingsKey] ?? {};
    const id = Object.keys(bindingMap).find(id => bindingMap[id] === removedTabId);
    logTabPin('Chrome替换标签', { pinId: id ?? null, removedTabId, addedTabId });
    if (id === undefined) return;
    bindingMap[id] = addedTabId;
    await chrome.storage.session.set({ [bindingsKey]: bindingMap });
  });
}
