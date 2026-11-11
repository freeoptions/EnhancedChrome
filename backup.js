import { emptyData, tagName } from './core.js';

export function exportFilename(now = new Date()) {
  const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
  return `ChromeCollect-${date}-export.json`;
}

export function createBackup(data, nodeList, now = new Date()) {
  const nodeMap = new Map(nodeList.map(node => [node.id, node]));
  const tagMap = new Map(data.tags.map(tag => [tag.id, tag.name]));
  const bookmarkList = [];
  for (const node of nodeList) {
    if (!node.url) continue;
    const tagList = (data.bookmarks[node.id] ?? []).map(id => tagMap.get(id)).filter(Boolean);
    if (tagList.length) bookmarkList.push({ url: node.url, title: node.title, folderPath: nodeMap.get(node.parentId)?.path ?? '', tags: tagList });
  }
  for (const pending of data.pendingList ?? []) {
    const tagList = pending.tagList.map(id => tagMap.get(id)).filter(Boolean);
    if (tagList.length) bookmarkList.push({ url: pending.url, title: pending.title, folderPath: pending.folderPath, tags: tagList });
  }
  return { format: 'ChromeCollect', version: 1, exportedAt: now.toISOString(), tags: data.tags.map(tag => tag.name), bookmarks: bookmarkList };
}

export function validateBackup(backup) {
  if (!backup || backup.format !== 'ChromeCollect' || backup.version !== 1
    || !Array.isArray(backup.tags) || !Array.isArray(backup.bookmarks)) {
    throw new Error('不是支持的ChromeCollect标签备份文件');
  }
  const nameSet = new Set();
  for (const name of backup.tags) {
    if (typeof name !== 'string' || tagName(name) !== name) throw new Error('备份中的标签名称无效');
    const key = name.toLocaleLowerCase();
    if (nameSet.has(key)) throw new Error('备份中存在同名标签');
    nameSet.add(key);
  }
  for (const record of backup.bookmarks) {
    if (!record || typeof record.url !== 'string' || !record.url
      || typeof record.title !== 'string' || typeof record.folderPath !== 'string'
      || !Array.isArray(record.tags) || !record.tags.length
      || record.tags.some(name => typeof name !== 'string' || !nameSet.has(name.toLocaleLowerCase()))) {
      throw new Error('备份中的书签或标签关联无效');
    }
  }
  return backup;
}

export function bookmarkCandidates(record, nodeList) {
  return nodeList.filter(node => node.url === record.url);
}

export function restoreBackup(currentData, backup, nodeList) {
  validateBackup(backup);
  const data = structuredClone(currentData ?? emptyData());
  const tagMap = new Map(data.tags.map(tag => [tag.name.toLocaleLowerCase(), tag.id]));
  for (const name of backup.tags) {
    if (!tagMap.has(name.toLocaleLowerCase())) {
      const id = crypto.randomUUID();
      data.tags.push({ id, name });
      tagMap.set(name.toLocaleLowerCase(), id);
    }
  }
  const nodeMap = new Map(nodeList.map(node => [node.id, node]));
  const urlMap = new Map();
  for (const node of nodeList) {
    if (!node.url) continue;
    if (!urlMap.has(node.url)) urlMap.set(node.url, []);
    urlMap.get(node.url).push(node);
  }
  // 旧的待处理记录一起重试，保留无法匹配的记录以便后续恢复。
  const recordList = [
    ...(data.pendingList ?? []),
    ...backup.bookmarks.map(record => ({
      url: record.url, title: record.title, folderPath: record.folderPath,
      tagList: record.tags.map(name => tagMap.get(name.toLocaleLowerCase()))
    }))
  ];
  const pendingMap = new Map();
  const matchedSet = new Set();
  for (const record of recordList) {
    const candidateList = urlMap.get(record.url) ?? [];
    const exactList = candidateList.length > 1
      ? candidateList.filter(node => node.title === record.title && (nodeMap.get(node.parentId)?.path ?? '') === record.folderPath)
      : candidateList;
    if (exactList.length === 1) {
      const id = exactList[0].id;
      data.bookmarks[id] = [...new Set([...(data.bookmarks[id] ?? []), ...record.tagList])];
      matchedSet.add(id);
    } else {
      const key = JSON.stringify([record.url, record.title, record.folderPath]);
      const existing = pendingMap.get(key);
      pendingMap.set(key, {
        id: existing?.id ?? record.id ?? crypto.randomUUID(),
        url: record.url, title: record.title, folderPath: record.folderPath,
        tagList: [...new Set([...(existing?.tagList ?? []), ...record.tagList])]
      });
    }
  }
  data.pendingList = [...pendingMap.values()];
  return { data, matchedCount: matchedSet.size, pendingCount: data.pendingList.length };
}

export function resolvePending(data, pendingId, bookmark) {
  const record = (data.pendingList ?? []).find(item => item.id === pendingId);
  if (!record) throw new Error('该待处理记录已更新，请刷新后重试');
  if (!bookmark.url || bookmark.url !== record.url) throw new Error('请选择完整网址相同的书签');
  data.bookmarks[bookmark.id] = [...new Set([...(data.bookmarks[bookmark.id] ?? []), ...record.tagList])];
  data.pendingList = data.pendingList.filter(item => item.id !== pendingId);
  return data;
}
