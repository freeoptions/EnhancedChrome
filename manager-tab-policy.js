export function isManagerUrl(rawUrl, extensionBase) {
  try {
    const url = new URL(rawUrl);
    const base = new URL(extensionBase);
    return url.protocol === base.protocol && url.host === base.host && url.pathname === '/manager.html';
  } catch { return false; }
}

export function planManagerCleanup(tabList, extensionBase) {
  const managerList = tabList.filter(tab => isManagerUrl(tab.pendingUrl || tab.url, extensionBase));
  const sortedList = [...managerList].sort((left, right) => Number(Boolean(right.pinned)) - Number(Boolean(left.pinned)) || left.id - right.id);
  return { keepId: sortedList[0]?.id, removeIdList: sortedList.slice(1).map(tab => tab.id) };
}
