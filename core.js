export function emptyData() {
  return { tags: [], bookmarks: {} };
}

export function clampSidebarWidth(width, viewportWidth) {
  const maximum = Math.max(140, Math.min(600, viewportWidth - 246));
  return Math.max(140, Math.min(Number.isFinite(width) ? width : 280, maximum));
}

export function tagName(value) {
  const name = String(value ?? '').trim();
  if (!name || name.length > 30) throw new Error('标签名称请输入1至30个字符');
  return name;
}

export function flattenTree(nodeList, parentPath = '') {
  return nodeList.flatMap(node => {
    const path = [parentPath, node.title].filter(Boolean).join(' / ');
    return [{ ...node, path }, ...flattenTree(node.children ?? [], path)];
  });
}

export function filterBookmarks(nodeList, data, selectedTagSet, query) {
  const keyword = query.trim().toLocaleLowerCase();
  return nodeList.filter(node => node.url
    && [...selectedTagSet].every(id => (data.bookmarks[node.id] ?? []).includes(id))
    && (!keyword || `${node.title} ${node.url}`.toLocaleLowerCase().includes(keyword)));
}

export function getBookmarkPage(nodeList, requestedPage) {
  const pageSize = 100;
  const totalPages = Math.max(1, Math.ceil(nodeList.length / pageSize));
  const page = Math.max(1, Math.min(requestedPage, totalPages));
  const start = (page - 1) * pageSize;
  return { itemList: nodeList.slice(start, start + pageSize), page, totalPages };
}

export function removeBookmarks(data, idSet) {
  for (const id of idSet) delete data.bookmarks[id];
  return data;
}

export function getSelectedBookmarkList(nodeList, selectedIdSet) {
  const bookmarkMap = new Map();
  function visit(node, parentSelected) {
    const selected = parentSelected || selectedIdSet.has(node.id);
    if (node.url && selected) bookmarkMap.set(node.id, node);
    for (const child of node.children ?? []) visit(child, selected);
  }
  for (const node of nodeList) visit(node, false);
  return [...bookmarkMap.values()];
}

export function addBookmarkTags(data, bookmarkList, tagList) {
  if (!bookmarkList.length) throw new Error('请先勾选书签或文件夹');
  if (!Array.isArray(tagList) || !tagList.length) throw new Error('请至少选择一个标签');
  const validTagSet = new Set(data.tags.map(tag => tag.id));
  if (tagList.some(id => !validTagSet.has(id))) throw new Error('所选标签已被删除，请重新选择');
  let changedCount = 0;
  for (const bookmark of bookmarkList) {
    const existingList = data.bookmarks[bookmark.id] ?? [];
    const mergedList = [...new Set([...existingList, ...tagList])];
    if (mergedList.length !== existingList.length) {
      data.bookmarks[bookmark.id] = mergedList;
      changedCount++;
    }
  }
  return { totalCount: bookmarkList.length, changedCount };
}

export function applyCommand(data, command) {
  switch (command.type) {
    case 'createTag': {
      const name = tagName(command.name);
      if (data.tags.some(tag => tag.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
        throw new Error('已存在同名标签');
      }
      data.tags.push({ id: command.id, name });
      break;
    }
    case 'renameTag': {
      const tag = data.tags.find(item => item.id === command.id);
      if (!tag) throw new Error('该标签已被删除，请重新打开管理标签');
      const name = tagName(command.name);
      if (data.tags.some(item => item.id !== tag.id && item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
        throw new Error('已存在同名标签');
      }
      tag.name = name;
      break;
    }
    case 'deleteTag':
      data.tags = data.tags.filter(tag => tag.id !== command.id);
      for (const [id, tagList] of Object.entries(data.bookmarks)) {
        const remainingList = tagList.filter(tag => tag !== command.id);
        if (remainingList.length) data.bookmarks[id] = remainingList;
        else delete data.bookmarks[id];
      }
      if (data.pendingList) {
        data.pendingList = data.pendingList.map(record => ({ ...record, tagList: record.tagList.filter(id => id !== command.id) }))
          .filter(record => record.tagList.length);
      }
      break;
    case 'setBookmarkTags': {
      const validTagSet = new Set(data.tags.map(tag => tag.id));
      const tagList = [...new Set(command.tagList)].filter(id => validTagSet.has(id));
      if (tagList.length) data.bookmarks[command.bookmarkId] = tagList;
      else delete data.bookmarks[command.bookmarkId];
      break;
    }
    default: throw new Error('未知操作');
  }
  return data;
}
