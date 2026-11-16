export function getBookmarkClickSelection(nodeList, selectedIdSet, anchorId, targetId, { toggle = false, range = false } = {}) {
  const targetIndex = nodeList.findIndex(node => node.id === targetId && node.url);
  if (targetIndex < 0) return { selectedIdSet: new Set(selectedIdSet), anchorId };
  const nextSelectedIdSet = new Set(toggle ? selectedIdSet : []);
  if (range) {
    const anchorIndex = nodeList.findIndex(node => node.id === anchorId && node.url);
    const start = anchorIndex < 0 ? targetIndex : Math.min(anchorIndex, targetIndex);
    const end = anchorIndex < 0 ? targetIndex : Math.max(anchorIndex, targetIndex);
    for (let index = start; index <= end; index++) {
      const node = nodeList[index];
      if (node.url) nextSelectedIdSet.add(node.id);
    }
    return { selectedIdSet: nextSelectedIdSet, anchorId: anchorIndex < 0 ? targetId : anchorId };
  }
  if (toggle && nextSelectedIdSet.has(targetId)) nextSelectedIdSet.delete(targetId);
  else nextSelectedIdSet.add(targetId);
  return { selectedIdSet: nextSelectedIdSet, anchorId: targetId };
}

export function getRemainingSingleBookmarkId(selectedIdSet, previousCount) {
  return previousCount > 1 && selectedIdSet.size === 1 ? selectedIdSet.values().next().value : null;
}
