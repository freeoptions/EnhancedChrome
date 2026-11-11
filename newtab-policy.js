export function isOwnNewTabUrl(rawUrl, extensionBase) {
  if (rawUrl === 'chrome://newtab/' || rawUrl === 'chrome://newtab') return true;
  try {
    const url = new URL(rawUrl);
    url.hash = '';
    const base = new URL(extensionBase);
    if (url.protocol !== base.protocol || url.host !== base.host) return false;
    return url.pathname === '/wallpaper/newtab.html' && !url.search;
  } catch { return false; }
}

export function planNewTabCleanup(tabList, extensionBase) {
  const homeTabList = tabList.filter(tab => isOwnNewTabUrl(tab.pendingUrl || tab.url, extensionBase));
  const sortedList = [...homeTabList].sort((left, right) => Number(right.pinned) - Number(left.pinned) || left.id - right.id);
  const keepId = sortedList[0]?.id;
  return { keepId, removeIdList: homeTabList.filter(tab => tab.id !== keepId && !tab.pinned).map(tab => tab.id) };
}
