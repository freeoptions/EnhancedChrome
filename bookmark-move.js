export function getBookmarkMoveDestination(nodeList, sourceId, targetId, position) {
  const nodeMap = new Map(nodeList.map(node => [node.id, node]));
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
