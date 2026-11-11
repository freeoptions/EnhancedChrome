import { addBookmarkTags, applyCommand, emptyData, flattenTree, getSelectedBookmarkList, removeBookmarks } from './core.js';
import { createBackup, resolvePending, restoreBackup } from './backup.js';
import { messageModule } from './message-routing.js';
import { saveSettings } from './settings-store.js';
import { startTagSync } from './tag-sync.js';
import { openManager } from './manager-tab.js';
import './dedupe/background.js';
import './single-newtab.js';

let writeQueue = Promise.resolve();
function enqueue(operation) {
  const result = writeQueue.then(operation);
  writeQueue = result.catch(error => console.error('书签标签保存失败', error));
  return result;
}

const tagSync = startTagSync(enqueue);

async function readData() {
  return (await chrome.storage.local.get('tagData')).tagData ?? emptyData();
}

chrome.action.onClicked.addListener(openManager);

chrome.runtime.onMessage.addListener((command, sender, respond) => {
  if (messageModule(command?.type) !== 'bookmarks' || sender.id !== chrome.runtime.id
    || !sender.url?.startsWith(chrome.runtime.getURL(''))) return false;
  enqueue(async () => {
    if (command.type === 'syncTags') {
      tagSync.schedule();
      return { ok: true };
    }
    if (command.type === 'updateSettings') {
      return { ok: true, settings: await saveSettings(command.patch) };
    }
    let data = await readData();
    if (command.type === 'addBookmarkTags') {
      const selectedIdSet = new Set(command.bookmarkIdList);
      const bookmarkList = getSelectedBookmarkList(await chrome.bookmarks.getTree(), selectedIdSet);
      if (bookmarkList.length !== selectedIdSet.size) throw new Error('部分所选书签已变化，请重新勾选后再保存');
      const result = addBookmarkTags(data, bookmarkList, command.tagList);
      await tagSync.saveData(data);
      return { ok: true, ...result };
    }
    if (command.type === 'exportBackup') {
      const nodeList = flattenTree(await chrome.bookmarks.getTree());
      return { ok: true, backup: createBackup(data, nodeList) };
    }
    if (command.type === 'importBackup' || command.type === 'retryPending') {
      const nodeList = flattenTree(await chrome.bookmarks.getTree());
      const backup = command.type === 'importBackup' ? command.backup
        : { format: 'ChromeCollect', version: 1, tags: [], bookmarks: [] };
      const result = restoreBackup(data, backup, nodeList);
      await tagSync.saveData(result.data);
      return { ok: true, matchedCount: result.matchedCount, pendingCount: result.pendingCount };
    }
    if (command.type === 'resolvePending') {
      const [bookmark] = await chrome.bookmarks.get(command.bookmarkId);
      data = resolvePending(data, command.pendingId, bookmark);
      await tagSync.saveData(data);
      return { ok: true };
    }
    if (command.type === 'setBookmarkTags') {
      const [bookmark] = await chrome.bookmarks.get(command.bookmarkId);
      if (!bookmark.url) throw new Error('只能为网页书签设置标签');
    }
    if (command.type === 'createTag') command.id = crypto.randomUUID();
    applyCommand(data, command);
    await tagSync.saveData(data);
    return { ok: true };
  }).then(respond, error => respond({ ok: false, error: error.message }));
  return true;
});

chrome.bookmarks.onRemoved.addListener((id, info) => {
  enqueue(async () => {
    const data = await readData();
    const idSet = new Set([id, ...flattenTree([info.node]).map(node => node.id)]);
    if (![...idSet].some(bookmarkId => data.bookmarks[bookmarkId]?.length)) return;
    removeBookmarks(data, idSet);
    await tagSync.saveData(data);
  });
});
