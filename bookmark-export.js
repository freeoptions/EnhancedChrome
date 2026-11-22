const htmlEntities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const escapeHtml = text => text.replace(/[&<>"]/g, character => htmlEntities[character]);

export function createBookmarkExport(treeList, folderIdSet = null, now = new Date()) {
  const remainingIdSet = new Set(folderIdSet);
  const exportNodeList = folderIdSet ? [] : treeList.flatMap(root => root.children ?? []);
  function collectFolders(nodeList, ancestorSelected = false) {
    for (const node of nodeList) {
      if (!remainingIdSet.size) return;
      if (node.url !== undefined) continue;
      const selected = remainingIdSet.delete(node.id);
      if (selected && !ancestorSelected) exportNodeList.push(node);
      if (node.children) collectFolders(node.children, ancestorSelected || selected);
    }
  }
  collectFolders(treeList);
  if (folderIdSet && (!exportNodeList.length || remainingIdSet.size)) return null;

  const lineList = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>',
  ];
  function writeNode(node, indent) {
    const title = escapeHtml(node.title);
    const added = Number.isFinite(node.dateAdded) ? ` ADD_DATE="${Math.floor(node.dateAdded / 1000)}"` : '';
    if (node.url !== undefined) {
      lineList.push(`${indent}<DT><A HREF="${escapeHtml(node.url)}"${added}>${title}</A>`);
      return;
    }
    const modified = Number.isFinite(node.dateGroupModified)
      ? ` LAST_MODIFIED="${Math.floor(node.dateGroupModified / 1000)}"` : '';
    lineList.push(`${indent}<DT><H3${added}${modified}>${title}</H3>`, `${indent}<DL><p>`);
    for (const child of node.children ?? []) writeNode(child, `${indent}    `);
    lineList.push(`${indent}</DL><p>`);
  }
  for (const node of exportNodeList) writeNode(node, '    ');
  lineList.push('</DL><p>', '');

  const date = [now.getFullYear(), now.getMonth() + 1, now.getDate()]
    .map(part => String(part).padStart(2, '0')).join('-');
  const folderName = folderIdSet && exportNodeList.length === 1
    ? Array.from(exportNodeList[0].title.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim()).slice(0, 60).join('')
    : '';
  return {
    html: lineList.join('\r\n'),
    filename: `${folderName ? `${folderName}-` : ''}书签-${date}.html`,
  };
}
