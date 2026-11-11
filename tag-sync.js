import { emptyData, flattenTree } from './core.js';
import { restoreBackup } from './backup.js';
import { checkSyncQuota, createTagSnapshot, decodeTagSnapshot, encodeTagSnapshot, restoreTagSnapshot, SYNC_CHUNK_PREFIX, SYNC_META_KEY } from './tag-sync-data.js';

const retryAlarm = 'retry-tag-sync';

export function startTagSync(enqueue) {
  async function status(state, extra = {}) {
    await chrome.storage.local.set({ tagSyncStatus: { state, time: Date.now(), ...extra } });
  }

  async function failed(error) {
    await status('error', { message: error.message });
    await chrome.alarms.create(retryAlarm, { delayInMinutes: 1 });
  }

  async function synchronize() {
    try {
      await status('syncing');
      const local = await chrome.storage.local.get(['tagData', 'tagSyncState']);
      const state = local.tagSyncState ?? {};
      const data = local.tagData ?? emptyData();
      const cloudMap = await chrome.storage.sync.get(null);
      const meta = cloudMap[SYNC_META_KEY];
      const nodeList = flattenTree(await chrome.bookmarks.getTree());
      if (state.dirty || (!meta && data.tags.length && !state.revision)) {
        const nextMap = await encodeTagSnapshot(createTagSnapshot(data, nodeList));
        checkSyncQuota(cloudMap, nextMap);
        await chrome.storage.sync.set(nextMap);
        const nextMeta = nextMap[SYNC_META_KEY];
        await chrome.storage.local.set({ tagSyncState: { revision: nextMeta.revision, dirty: false } });
        const obsoleteList = Object.keys(cloudMap).filter(key => key.startsWith(SYNC_CHUNK_PREFIX) && !(key in nextMap));
        if (obsoleteList.length) await chrome.storage.sync.remove(obsoleteList);
        await status('submitted');
      } else if (meta && meta.revision !== state.revision) {
        const decoded = await decodeTagSnapshot(cloudMap);
        if (!decoded) {
          await status('receiving');
          await chrome.alarms.create(retryAlarm, { delayInMinutes: 1 });
          return;
        }
        const result = restoreTagSnapshot(decoded.snapshot, nodeList);
        const update = { tagData: result.data, tagSyncState: { revision: meta.revision, dirty: false } };
        // 首次接入已有云端数据时，保留一份原本机数据，避免旧标签无法找回。
        if (!state.revision && data.tags.length) update.tagDataBeforeSync = data;
        await chrome.storage.local.set(update);
        await status('received', { pendingCount: result.pendingCount });
      } else if (!meta && state.revision) {
        await status('waiting');
      } else {
        const previous = (await chrome.storage.local.get('tagSyncLastSuccess')).tagSyncLastSuccess;
        await status(previous?.state ?? 'ready', previous ?? {});
      }
      const current = (await chrome.storage.local.get('tagSyncStatus')).tagSyncStatus;
      if (['submitted', 'received'].includes(current.state)) await chrome.storage.local.set({ tagSyncLastSuccess: current });
      await chrome.alarms.clear(retryAlarm);
    } catch (error) { await failed(error); }
  }

  async function saveData(data) {
    const state = (await chrome.storage.local.get('tagSyncState')).tagSyncState ?? {};
    await chrome.storage.local.set({ tagData: data, tagSyncState: { ...state, dirty: true }, tagSyncStatus: { state: 'syncing', time: Date.now() } });
    // 本地保存立即返回，云端写入在同一串行队列中进行，不阻塞弹窗交互。
    enqueue(synchronize);
  }

  function schedule() { enqueue(synchronize); }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && Object.keys(changes).some(key => key === SYNC_META_KEY || key.startsWith(SYNC_CHUNK_PREFIX))) schedule();
  });
  chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === retryAlarm) schedule(); });
  for (const event of [chrome.bookmarks.onCreated, chrome.bookmarks.onImportEnded, chrome.bookmarks.onChanged, chrome.bookmarks.onMoved]) {
    event.addListener(() => enqueue(async () => {
      const data = (await chrome.storage.local.get('tagData')).tagData;
      if (!data?.pendingList?.length) return;
      const result = restoreBackup(data, { format: 'ChromeCollect', version: 1, tags: [], bookmarks: [] }, flattenTree(await chrome.bookmarks.getTree()));
      if (result.pendingCount !== data.pendingList.length) {
        await chrome.storage.local.set({ tagData: result.data });
        const current = (await chrome.storage.local.get('tagSyncStatus')).tagSyncStatus;
        if (current?.state === 'received') {
          await status('received', { pendingCount: result.pendingCount });
          await chrome.storage.local.set({ tagSyncLastSuccess: (await chrome.storage.local.get('tagSyncStatus')).tagSyncStatus });
        }
      }
    }));
  }
  for (const event of [chrome.bookmarks.onChanged, chrome.bookmarks.onMoved]) {
    event.addListener(id => enqueue(async () => {
      const data = (await chrome.storage.local.get('tagData')).tagData;
      if (!data?.tags.length) return;
      const nodeList = flattenTree(await chrome.bookmarks.getTree());
      const nodeMap = new Map(nodeList.map(node => [node.id, node]));
      const affected = Object.keys(data.bookmarks).some(bookmarkId => {
        for (let node = nodeMap.get(bookmarkId); node; node = nodeMap.get(node.parentId)) {
          if (node.id === id) return true;
        }
        return false;
      });
      if (affected) await saveData(data);
    }));
  }
  schedule();
  return { saveData, schedule };
}
