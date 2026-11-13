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

async function readBookmarkUndoState() {
  const state = (await chrome.storage.session.get('bookmarkUndoState')).bookmarkUndoState;
  return state?.expiresAt > Date.now() ? state : { recordList: [], expiresAt: 0 };
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
    if (command.type === 'getBookmarkUndoState') {
      const state = await readBookmarkUndoState();
      const bookmark = state.recordList.at(-1)?.bookmark;
      return { ok: true, undoCount: state.recordList.length, undoExpiresAt: state.expiresAt, undoTitle: bookmark?.title || bookmark?.url || '' };
    }
    let data = await readData();
    if (command.type === 'deleteBookmark') {
      const [bookmark] = await chrome.bookmarks.get(command.bookmarkId);
      if (!bookmark.url) throw new Error('只能删除网页书签');
      const previousState = await readBookmarkUndoState();
      const state = {
        recordList: [...previousState.recordList, { bookmark, tagIdList: [...(data.bookmarks[bookmark.id] ?? [])] }],
        expiresAt: Date.now() + 10000
      };
      // 先保留恢复信息，再删除真实书签；删除失败时恢复原撤回记录。
      await chrome.storage.session.set({ bookmarkUndoState: state });
      try { await chrome.bookmarks.remove(bookmark.id); }
      catch (error) {
        await chrome.storage.session.set({ bookmarkUndoState: previousState });
        throw error;
      }
      return { ok: true, undoCount: state.recordList.length, undoExpiresAt: state.expiresAt, undoTitle: bookmark.title || bookmark.url };
    }
    if (command.type === 'undoDeleteBookmark') {
      const state = await readBookmarkUndoState();
      const record = state.recordList.at(-1);
      if (!record) throw new Error('撤回时间已过');
      let restored;
      if (record.restoredBookmarkId) {
        [restored] = await chrome.bookmarks.get(record.restoredBookmarkId);
      } else {
        let parent;
        try { [parent] = await chrome.bookmarks.get(record.bookmark.parentId); }
        catch { throw new Error('原文件夹已不存在，无法撤回；删除记录已保留'); }
        if (parent.url) throw new Error('原位置不是文件夹，无法撤回；删除记录已保留');
        const childList = await chrome.bookmarks.getChildren(parent.id);
        restored = await chrome.bookmarks.create({
          parentId: parent.id, index: Math.min(record.bookmark.index, childList.length),
          title: record.bookmark.title, url: record.bookmark.url
        });
        record.restoredBookmarkId = restored.id;
        // 后续标签保存失败时，重试复用已恢复的书签，避免重复创建。
        await chrome.storage.session.set({ bookmarkUndoState: state });
      }
      const validTagSet = new Set(data.tags.map(tag => tag.id));
      const tagIdList = record.tagIdList.filter(id => validTagSet.has(id));
      delete data.bookmarks[record.bookmark.id];
      if (tagIdList.length) data.bookmarks[restored.id] = tagIdList;
      await tagSync.saveData(data);
      state.recordList.pop();
      await chrome.storage.session.set({ bookmarkUndoState: state });
      const nextBookmark = state.recordList.at(-1)?.bookmark;
      return { ok: true, bookmarkId: restored.id, undoCount: state.recordList.length, undoExpiresAt: state.expiresAt, undoTitle: nextBookmark?.title || nextBookmark?.url || '' };
    }
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
