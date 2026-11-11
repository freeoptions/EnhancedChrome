import { isManagerUrl, planManagerCleanup } from './manager-tab-policy.js';

const extensionBase = chrome.runtime.getURL('');
let queue = Promise.resolve();

function run(operation) {
  const result = queue.then(operation);
  queue = result.catch(error => console.error('书签管理页去重失败', error));
  return queue;
}

async function activate(tab) {
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
}

async function enforce(focusDuplicates = false) {
  const tabList = await chrome.tabs.query({});
  for (const incognito of [false, true]) {
    const plan = planManagerCleanup(tabList.filter(tab => Boolean(tab.incognito) === incognito), extensionBase);
    if (!plan.removeIdList.length) continue;
    for (const id of plan.removeIdList) {
      try {
        const [duplicate, survivor] = await Promise.all([chrome.tabs.get(id), chrome.tabs.get(plan.keepId)]);
        if (!isManagerUrl(survivor.pendingUrl || survivor.url, extensionBase)) {
          run(() => enforce(focusDuplicates));
          break;
        }
        if (!isManagerUrl(duplicate.pendingUrl || duplicate.url, extensionBase)) continue;
        const sourceUrl = new URL(duplicate.pendingUrl || duplicate.url);
        if (sourceUrl.searchParams.get('settings') === '1') {
          await chrome.runtime.sendMessage({ type: 'openManagerSettings', targetTabId: survivor.id }).catch(() => {});
        }
        const window = focusDuplicates && duplicate.active ? await chrome.windows.get(duplicate.windowId) : null;
        await chrome.tabs.remove(id);
        if (window?.focused) await activate(survivor);
      } catch (error) {
        if (!error.message.includes('No tab with id')) throw error;
        run(() => enforce(focusDuplicates));
        break;
      }
    }
  }
}

export function openManager(sourceTab = {}) {
  return run(async () => {
    await enforce();
    const tabList = await chrome.tabs.query({});
    const existing = tabList.find(tab => Boolean(tab.incognito) === Boolean(sourceTab.incognito) && isManagerUrl(tab.pendingUrl || tab.url, extensionBase));
    if (existing) await activate(existing);
    else await chrome.tabs.create({ url: chrome.runtime.getURL('manager.html'), ...(sourceTab.windowId === undefined ? {} : { windowId: sourceTab.windowId }) });
  });
}

chrome.tabs.onCreated.addListener(tab => {
  if (isManagerUrl(tab.pendingUrl || tab.url, extensionBase)) run(() => enforce(true));
});
chrome.tabs.onUpdated.addListener((id, changes, tab) => {
  if ((changes.url || changes.status === 'loading') && isManagerUrl(tab.pendingUrl || tab.url, extensionBase)) run(() => enforce(true));
});
chrome.tabs.onAttached.addListener(() => run(() => enforce(true)));
run(() => enforce());
