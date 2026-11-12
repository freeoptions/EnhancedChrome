import { isOwnNewTabUrl, planNewTabCleanup } from './newtab-policy.js';
import { getSettings, settingsReady } from './settings-store.js';

const extensionBase = chrome.runtime.getURL('');
const runningWindowSet = new Set();
const pendingWindowSet = new Set();

async function syncWindow(windowId) {
  pendingWindowSet.add(windowId);
  if (runningWindowSet.has(windowId)) return;
  runningWindowSet.add(windowId);
  try {
    await settingsReady;
    while (pendingWindowSet.delete(windowId)) {
      if (!getSettings().singleNewTabEnabled) continue;
      const tabList = await chrome.tabs.query({ windowId });
      const plan = planNewTabCleanup(tabList, extensionBase);
      if (!getSettings().singleNewTabEnabled || !plan.removeIdList.length) continue;
      // 每次关闭前重新读取，避免把已经导航离开首页的标签页关闭。
      for (const id of plan.removeIdList) {
        try {
          const [tab, survivor] = await Promise.all([chrome.tabs.get(id), chrome.tabs.get(plan.keepId)]);
          if (!getSettings().singleNewTabEnabled) break;
          if (survivor.windowId !== windowId || !isOwnNewTabUrl(survivor.pendingUrl || survivor.url, extensionBase)) {
            pendingWindowSet.add(windowId);
            break;
          }
          if (tab.windowId !== windowId) continue;
          if (tab.pinned || !isOwnNewTabUrl(tab.pendingUrl || tab.url, extensionBase)) continue;
          if (tab.active) {
            // Notify explicitly: a very short-lived duplicate may never hide the retained page.
            await chrome.runtime.sendMessage({ type: 'WALLPAPER_REFRESH', tabId: plan.keepId })
              .catch(() => {}); // A retained page that is still starting loads its first wallpaper itself.
            // Activate first so removal doesn't briefly select an unrelated page.
            await chrome.tabs.update(plan.keepId, { active: true });
          }
          const closingTab = await chrome.tabs.get(id);
          if (closingTab.windowId !== windowId || closingTab.pinned
            || !isOwnNewTabUrl(closingTab.pendingUrl || closingTab.url, extensionBase)) continue;
          await chrome.tabs.remove(id);
        } catch (error) {
          if (!error.message.includes('No tab with id')) throw error;
          pendingWindowSet.add(windowId);
          break;
        }
      }
    }
  } catch (error) { console.error('新标签页去重失败', error); }
  finally { runningWindowSet.delete(windowId); }
}

function onHomeTab(tab) {
  if (isOwnNewTabUrl(tab.pendingUrl || tab.url, extensionBase)) syncWindow(tab.windowId);
}
chrome.tabs.onCreated.addListener(onHomeTab);
chrome.tabs.onUpdated.addListener((id, changes, tab) => {
  if (changes.url || changes.status === 'loading') onHomeTab(tab);
});
chrome.tabs.onAttached.addListener((id, info) => syncWindow(info.newWindowId));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.enhancedSettings) scanWindows();
});
async function scanWindows() {
  try {
    const windowList = await chrome.windows.getAll();
    for (const window of windowList) syncWindow(window.id);
  } catch (error) { console.error('读取窗口失败', error); }
}
scanWindows();
