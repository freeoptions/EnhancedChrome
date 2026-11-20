import {
  DEFAULT_RULES,
  isSupportedUrl,
  normalizeRule
} from "./url-utils.js";
import { messageModule } from '../message-routing.js';
import { getSettings, settingsReady } from '../settings-store.js';
import { readPinnedTabIdSet } from '../tab-search/pins.js';
import { groupDuplicateTabs, planDuplicateClosure } from './policy.js';

const tabMetaMap = new Map();
const autoProtectionMap = new Map();
const pendingToastMap = new Map();
const pendingNavigationMap = new Map();
let currentWindowId = null;
let scanTimer = null;
let pendingScanDelay = null;
let scanning = false;
let ruleCacheList = null;
let sessionStorageAvailable = Boolean(chrome.storage?.session);

function now() {
  return Date.now();
}

function getMeta(tabId) {
  if (!tabMetaMap.has(tabId)) {
    tabMetaMap.set(tabId, {
      createdAt: now(),
      navigationStartedAt: now(),
      completedAt: null,
      url: "",
      windowId: null
    });
  }
  return tabMetaMap.get(tabId);
}

function getTabUrl(tab, changeInfo = {}) {
  return changeInfo.url || pendingNavigationMap.get(tab.id) || tab.pendingUrl || tab.url || "";
}

function serializeMap(valueMap) {
  return Object.fromEntries(valueMap.entries());
}

async function persistSessionState() {
  if (!sessionStorageAvailable) {
    return;
  }

  try {
    await chrome.storage.session.set({
      duplicateTabMeta: serializeMap(tabMetaMap),
      duplicateTabProtection: serializeMap(autoProtectionMap)
    });
  } catch {
    sessionStorageAvailable = false;
  }
}

async function restoreSessionState() {
  if (!sessionStorageAvailable) {
    return;
  }

  try {
    const data = await chrome.storage.session.get(["duplicateTabMeta", "duplicateTabProtection"]);

    for (const [tabId, meta] of Object.entries(data.duplicateTabMeta || {})) {
      tabMetaMap.set(Number(tabId), meta);
    }
    for (const [tabId, protection] of Object.entries(data.duplicateTabProtection || {})) {
      autoProtectionMap.set(Number(tabId), protection);
    }
  } catch {
    sessionStorageAvailable = false;
  }
}

async function loadRules() {
  if (ruleCacheList) {
    return ruleCacheList;
  }

  const data = await chrome.storage.local.get("rules");
  if (data.rules === undefined) {
    ruleCacheList = DEFAULT_RULES.map((rule, index) => normalizeRule(rule, index));
    await chrome.storage.local.set({ rules: ruleCacheList });
  } else {
    ruleCacheList = Array.isArray(data.rules)
      ? data.rules.map((rule, index) => normalizeRule(rule, index))
      : [];
  }
  return ruleCacheList;
}

async function initializeTabMeta() {
  const tabList = await chrome.tabs.query({});
  for (const tab of tabList) {
    const meta = getMeta(tab.id);
    if (!meta.url || meta.url !== tab.url) {
      meta.url = tab.url || "";
      meta.windowId = tab.windowId;
      meta.navigationStartedAt = now();
      meta.completedAt = tab.status === "complete" ? now() : null;
    }
    if (meta.windowId === null) {
      meta.windowId = tab.windowId;
    }
  }
  await persistSessionState();
}

async function initializeCurrentWindow() {
  try {
    const window = await chrome.windows.getLastFocused();
    if (window?.id !== undefined && window.id !== chrome.windows.WINDOW_ID_NONE) {
      currentWindowId = window.id;
    }
  } catch {
    currentWindowId = null;
  }
}

async function initialize() {
  await settingsReady;
  await restoreSessionState();
  await loadRules();
  await initializeTabMeta();
  await initializeCurrentWindow();
  scheduleScan();
}

const initialized = initialize();

function setTabNavigation(tab, url = getTabUrl(tab)) {
  const meta = getMeta(tab.id);
  if (meta.url !== url) {
    meta.url = url || "";
    meta.windowId = tab.windowId;
    meta.navigationStartedAt = now();
    meta.completedAt = tab.status === "complete" ? now() : null;
    autoProtectionMap.delete(tab.id);
  } else if (meta.windowId !== tab.windowId) {
    meta.windowId = tab.windowId;
  }
  return meta;
}

function markTabComplete(tab) {
  const meta = setTabNavigation(tab, getTabUrl(tab));
  meta.completedAt = now();
}

function scheduleScan(urgent = false) {
  if (!getSettings().dedupeEnabled) return;
  const delay = urgent ? 0 : 40;
  if (pendingScanDelay !== null && pendingScanDelay <= delay) return;
  pendingScanDelay = delay;
  if (!scanning) startScanTimer();
}

function startScanTimer() {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(async () => {
    scanTimer = null;
    pendingScanDelay = null;
    scanning = true;
    try {
      await scanWindows();
    } catch (error) {
      console.warn("检查重复标签页失败", error);
    } finally {
      scanning = false;
      if (pendingScanDelay !== null) startScanTimer();
    }
  }, pendingScanDelay);
}

function isProtected(tab) {
  if (tab.pinned) {
    return { protected: true, reasons: ["固定标签页"] };
  }

  const reasonList = [];

  const automatic = autoProtectionMap.get(tab.id);
  if (automatic?.url === tab.url && automatic.dirty) {
    reasonList.push(automatic.hasBeforeUnloadHandler ? "页面有离开确认" : "检测到未保存内容");
  }

  return { protected: reasonList.length > 0, reasons: reasonList };
}

function loadStage(tab) {
  const isNavigating = pendingNavigationMap.has(tab.id) || (
    tab.pendingUrl && tab.pendingUrl !== tab.url
  );
  const status = isNavigating ? "loading" : tab.status;

  if (status === "complete" && !tab.discarded) {
    return 0;
  }
  if (!tab.discarded) {
    return 1;
  }
  if (status === "complete") {
    return 2;
  }
  return 3;
}

function compareTabs(left, right) {
  const stageDifference = loadStage(left) - loadStage(right);
  if (stageDifference !== 0) {
    return stageDifference;
  }

  const leftMeta = getMeta(left.id);
  const rightMeta = getMeta(right.id);
  const leftCompleted = leftMeta.completedAt ?? Number.MAX_SAFE_INTEGER;
  const rightCompleted = rightMeta.completedAt ?? Number.MAX_SAFE_INTEGER;
  if (leftCompleted !== rightCompleted) {
    return leftCompleted - rightCompleted;
  }

  const leftStarted = leftMeta.navigationStartedAt ?? Number.MAX_SAFE_INTEGER;
  const rightStarted = rightMeta.navigationStartedAt ?? Number.MAX_SAFE_INTEGER;
  if (leftStarted !== rightStarted) {
    return leftStarted - rightStarted;
  }

  const leftCreated = leftMeta.createdAt ?? Number.MAX_SAFE_INTEGER;
  const rightCreated = rightMeta.createdAt ?? Number.MAX_SAFE_INTEGER;
  if (leftCreated !== rightCreated) {
    return leftCreated - rightCreated;
  }

  return left.index - right.index;
}

async function processDuplicateGroup(snapshotList, urlMap, ruleList, localWindowId) {
  if (!getSettings().dedupeEnabled || ruleCacheList !== ruleList) return;

  const tabGroupList = await Promise.all(snapshotList.map(tab => chrome.tabs.get(tab.id).catch(() => null)));
  const pinnedTabIdSet = await readPinnedTabIdSet();
  if (!getSettings().dedupeEnabled || ruleCacheList !== ruleList
    || (localWindowId !== undefined && localWindowId !== currentWindowId)) return;
  if (tabGroupList.some((tab, index) => !tab || tab.windowId !== snapshotList[index].windowId || getTabUrl(tab) !== urlMap.get(tab.id))) {
    scheduleScan(true);
    return;
  }
  if (tabGroupList.some(tab => pinnedTabIdSet.has(tab.id) && getTabUrl(tab) !== tab.url)) return;
  const protectedIdSet = new Set(tabGroupList
    .filter(tab => pinnedTabIdSet.has(tab.id) || isProtected(tab).protected)
    .map(tab => tab.id));
  const plan = planDuplicateClosure(tabGroupList, protectedIdSet, compareTabs);
  const survivor = tabGroupList.find(tab => tab.id === plan.keepId);
  const removeIdSet = new Set(plan.removeIdList);
  const loserList = tabGroupList.filter(tab => removeIdSet.has(tab.id));

  if (loserList.length === 0) {
    return;
  }

  const focusedLoser = loserList.find(tab => tab.active && tab.windowId === currentWindowId);
  try {
    await chrome.tabs.remove(loserList.map((tab) => tab.id));
    if (focusedLoser) {
      const activatedTab = await chrome.tabs.update(survivor.id, { active: true });
      if (activatedTab.windowId !== focusedLoser.windowId) {
        await chrome.windows.update(activatedTab.windowId, { focused: true });
      }
      void showToast(survivor.id, `已关闭 ${loserList.length} 个重复标签页，已切换到保留页面`);
    }
  } catch (error) {
    console.warn("关闭重复标签页失败", error);
  }
}

async function scanWindows() {
  await initialized;
  if (!getSettings().dedupeEnabled) return;

  const ruleList = await loadRules();
  const normalTabList = (await chrome.tabs.query({ windowType: "normal" })).filter(tab => !tab.incognito);
  const localWindowId = currentWindowId;
  const localTabList = localWindowId !== null && !normalTabList.some(tab => tab.windowId === localWindowId)
    ? await chrome.tabs.query({ windowId: localWindowId }).catch(() => [])
    : [];

  for (const tabList of [normalTabList, localTabList]) {
    const urlMap = new Map(tabList.map(tab => [tab.id, getTabUrl(tab)]));
    const supportedTabList = tabList.filter(tab => tab.id >= 0 && isSupportedUrl(urlMap.get(tab.id)));
    for (const tabGroupList of groupDuplicateTabs(supportedTabList, ruleList, tab => urlMap.get(tab.id))) {
      if (tabGroupList.length > 1) {
        await processDuplicateGroup(tabGroupList, urlMap, ruleList, tabList === localTabList ? localWindowId : undefined);
      }
    }
  }
}

async function showToast(tabId, message) {
  const { fontSize } = getSettings();
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "SHOW_DEDUPE_TOAST",
      message,
      fontSize
    });
    pendingToastMap.delete(tabId);
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (toastMessage, toastFontSize) => {
          document.querySelector("[data-duplicate-url-toast]")?.remove();
          const toast = document.createElement("div");
          toast.dataset.duplicateUrlToast = "true";
          toast.textContent = toastMessage;
          toast.style.cssText = [
            "all: initial",
            "position: fixed !important",
            "top: 20px !important",
            "right: 20px !important",
            "z-index: 2147483647 !important",
            "max-width: 360px !important",
            "padding: 10px 14px !important",
            "border: 1px solid rgba(255,255,255,.2) !important",
            "border-radius: 10px !important",
            "background: rgba(24, 32, 51, .94) !important",
            "box-shadow: 0 8px 26px rgba(0,0,0,.2) !important",
            "color: #fff !important",
            `font: ${toastFontSize}px/1.5 'Segoe UI Variable Text', 'Segoe UI', 'Microsoft YaHei UI', 'Microsoft YaHei', sans-serif !important`,
            "opacity: 0 !important",
            "transform: translateY(-6px) !important",
            "transition: opacity .18s ease, transform .18s ease !important"
          ].join(";");
          document.documentElement.append(toast);
          requestAnimationFrame(() => {
            toast.style.setProperty("opacity", "1", "important");
            toast.style.setProperty("transform", "translateY(0)", "important");
          });
          setTimeout(() => {
            toast.style.setProperty("opacity", "0", "important");
            toast.style.setProperty("transform", "translateY(-6px)", "important");
            setTimeout(() => toast.remove(), 220);
          }, 1800);
        },
        args: [message, fontSize]
      });
      pendingToastMap.delete(tabId);
    } catch {
      pendingToastMap.set(tabId, message);
    }
  }
}

async function flushPendingToast(tab) {
  if (tab.status === "complete" && pendingToastMap.has(tab.id)) {
    await showToast(tab.id, pendingToastMap.get(tab.id));
  }
}

function updateAutoProtection(tabId, protection) {
  if (!protection?.url) {
    return;
  }

  if (protection.dirty || protection.hasBeforeUnloadHandler) {
    autoProtectionMap.set(tabId, {
      url: protection.url,
      dirty: true,
      hasBeforeUnloadHandler: Boolean(protection.hasBeforeUnloadHandler)
    });
  } else {
    autoProtectionMap.delete(tabId);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (messageModule(message?.type) !== 'dedupe' || sender.id !== chrome.runtime.id) return false;
  if (message.type !== 'PAGE_PROTECTION_STATE' && !sender.url?.startsWith(chrome.runtime.getURL(''))) return false;
  (async () => {
    await initialized;

    if (message?.type === "PAGE_PROTECTION_STATE" && sender.tab?.id !== undefined) {
      updateAutoProtection(sender.tab.id, message);
      await persistSessionState();
      scheduleScan();
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "RESCAN_TABS") {
      scheduleScan();
      sendResponse({ ok: true });
      return;
    }

    sendResponse({ ok: false });
  })().catch((error) => {
    console.error("处理扩展消息失败", error);
    sendResponse({ ok: false, error: error.message });
  });
  return true;
});

chrome.tabs.onCreated.addListener((tab) => {
  const meta = getMeta(tab.id);
  meta.createdAt = now();
  meta.navigationStartedAt = now();
  meta.completedAt = tab.status === "complete" ? now() : null;
  meta.url = getTabUrl(tab);
  meta.windowId = tab.windowId;
  persistSessionState();
  scheduleScan(isSupportedUrl(meta.url));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const targetUrl = getTabUrl(tab, changeInfo);
  setTabNavigation(tab, targetUrl);
  if (changeInfo.status === "complete") {
    pendingNavigationMap.delete(tabId);
    markTabComplete(tab);
    flushPendingToast(tab);
  }
  if (changeInfo.url || changeInfo.status === "loading") {
    autoProtectionMap.delete(tabId);
  }
  if (changeInfo.url || changeInfo.status || changeInfo.pinned !== undefined || changeInfo.discarded !== undefined) {
    const urgent = Boolean(changeInfo.url || tab.pendingUrl) && isSupportedUrl(targetUrl);
    scheduleScan(urgent);
  }
  persistSessionState();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabMetaMap.delete(tabId);
  autoProtectionMap.delete(tabId);
  pendingToastMap.delete(tabId);
  pendingNavigationMap.delete(tabId);
  persistSessionState();
});

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0 || !isSupportedUrl(details.url)) {
    return;
  }

  pendingNavigationMap.set(details.tabId, details.url);
  chrome.tabs.get(details.tabId).then((tab) => {
    if (pendingNavigationMap.get(details.tabId) !== details.url) {
      return;
    }
    setTabNavigation({ ...tab, pendingUrl: details.url }, details.url);
    scheduleScan(true);
  }).catch(() => {});
});

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) {
    return;
  }

  const pendingUrl = pendingNavigationMap.get(details.tabId);
  pendingNavigationMap.delete(details.tabId);
  chrome.tabs.get(details.tabId).then((tab) => {
    if (getTabUrl(tab) !== details.url) {
      return;
    }
    const previousUrl = tabMetaMap.get(details.tabId)?.url;
    setTabNavigation(tab, details.url);
    if (isSupportedUrl(details.url) && (previousUrl !== details.url || (pendingUrl && pendingUrl !== details.url))) {
      scheduleScan(true);
    }
  }).catch(() => {});
});

chrome.webNavigation.onErrorOccurred.addListener((details) => {
  if (details.frameId === 0) {
    pendingNavigationMap.delete(details.tabId);
  }
});

chrome.tabs.onAttached.addListener((tabId, attachInfo) => {
  const meta = getMeta(tabId);
  meta.windowId = attachInfo.newWindowId;
  scheduleScan();
});

chrome.tabs.onDetached.addListener((tabId) => {
  const meta = getMeta(tabId);
  meta.windowId = null;
  scheduleScan();
});

chrome.tabs.onReplaced.addListener((_, removedTabId) => {
  tabMetaMap.delete(removedTabId);
  autoProtectionMap.delete(removedTabId);
  pendingNavigationMap.delete(removedTabId);
  persistSessionState();
  scheduleScan();
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    currentWindowId = null;
    return;
  }
  currentWindowId = windowId;
  scheduleScan();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.enhancedSettings) {
    if (getSettings().dedupeEnabled) scheduleScan();
    else {
      clearTimeout(scanTimer);
      scanTimer = null;
      pendingScanDelay = null;
    }
  }
  if (areaName !== "local" || !changes.rules) {
    return;
  }
  ruleCacheList = Array.isArray(changes.rules.newValue)
    ? changes.rules.newValue.map((rule, index) => normalizeRule(rule, index))
    : [];
  scheduleScan();
});

chrome.runtime.onInstalled.addListener(async () => {
  await loadRules();
  await initializeCurrentWindow();
  scheduleScan();
});

chrome.runtime.onStartup.addListener(async () => {
  await initialize();
});
