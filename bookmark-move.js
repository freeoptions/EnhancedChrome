export function getBookmarkMoveDestination(nodeMap, sourceId, targetId, position) {
  const source = nodeMap.get(sourceId);
  const target = nodeMap.get(targetId);
  if (!source || !target || source.id === target.id || !['before', 'after', 'inside'].includes(position)) return null;
  const parent = position === 'inside' ? target : nodeMap.get(target.parentId);
  if (!parent || parent.url || !parent.parentId || !source.parentId) return null;
  const sourceParent = nodeMap.get(source.parentId);
  if (!sourceParent?.parentId || source.folderType) return null;
  for (const start of [source, parent]) {
    const visitedSet = new Set();
    for (let node = start; node; node = nodeMap.get(node.parentId)) {
      if (node.unmodifiable || visitedSet.has(node.id)) return null;
      if (start === parent && node.id === source.id) return null;
      visitedSet.add(node.id);
    }
  }
  if (position === 'inside') return source.parentId === parent.id ? null : { parentId: parent.id };
  if (source.parentId !== parent.id || !Number.isInteger(target.index)) return null;
  // Chrome接收移动前的插入位置，同目录向后移动时由Chrome调整索引。
  const index = target.index + (position === 'after' ? 1 : 0);
  if (index === source.index || index === source.index + 1) return null;
  return { parentId: parent.id, index };
}

export function getBookmarkDragScrollDelta(pointerY, top, bottom, elapsedMs) {
  if (bottom <= top || elapsedMs <= 0) return 0;
  const edgeSize = Math.min(64, (bottom - top) / 3);
  const upward = Math.max(0, Math.min(1, (top + edgeSize - pointerY) / edgeSize));
  const downward = Math.max(0, Math.min(1, (pointerY - bottom + edgeSize) / edgeSize));
  return (downward - upward) * 900 * Math.max(0, Math.min(32, elapsedMs)) / 1000;
}

export function canDragBookmarkNode(nodeMap, sourceId, selectionMode, selectedIdSet) {
  const node = nodeMap.get(sourceId);
  if (!node || !node.parentId || !nodeMap.get(node.parentId)?.parentId || node.folderType
    || (selectionMode && (!node.url || !selectedIdSet.has(sourceId)))) return false;
  const visitedSet = new Set();
  for (let ancestor = node; ancestor; ancestor = nodeMap.get(ancestor.parentId)) {
    if (ancestor.unmodifiable || visitedSet.has(ancestor.id)) return false;
    visitedSet.add(ancestor.id);
  }
  return true;
}

export function getBookmarkBatchMovePlan(nodeMap, sourceIdList, targetId) {
  const target = nodeMap.get(targetId);
  if (!target || target.url || !target.parentId || !sourceIdList.length) return null;
  const sourceIdSet = new Set(sourceIdList);
  for (const id of sourceIdSet) {
    if (!nodeMap.get(id)?.url || !canDragBookmarkNode(nodeMap, id, true, sourceIdSet)) return null;
  }
  const moveList = [];
  for (const node of nodeMap.values()) {
    if (!sourceIdSet.has(node.id)) continue;
    const destination = getBookmarkMoveDestination(nodeMap, node.id, targetId, 'inside');
    if (!destination) {
      if (node.parentId !== targetId) return null;
      continue;
    }
    moveList.push({ id: node.id, ...destination });
  }
  return moveList;
}
