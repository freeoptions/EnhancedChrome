export function readBookmarkList(list) {
  let skippedCount = 0;

  function readList(bookmarkList) {
    const nodeList = [];
    let pendingFolder = null;
    for (const entry of bookmarkList.children) {
      if (entry.tagName === 'DL' || entry.tagName === 'DD') {
        const nestedList = entry.tagName === 'DL' ? entry : entry.querySelector(':scope > dl');
        if (pendingFolder && nestedList) {
          pendingFolder.children = readList(nestedList);
          pendingFolder = null;
        }
        continue;
      }
      if (entry.tagName !== 'DT') continue;
      pendingFolder = null;

      const heading = entry.querySelector(':scope > h3');
      if (heading) {
        const nestedList = entry.querySelector(':scope > dl');
        const folder = { title: heading.textContent, children: nestedList ? readList(nestedList) : [] };
        nodeList.push(folder);
        if (!nestedList) pendingFolder = folder;
        continue;
      }

      const link = entry.querySelector(':scope > a');
      const url = link?.getAttribute('href')?.trim();
      if (!link) continue;
      try {
        new URL(url);
        nodeList.push({ title: link.textContent, url });
      } catch {
        skippedCount++;
      }
    }
    return nodeList;
  }

  return { nodeList: list ? readList(list) : [], skippedCount };
}

export function parseBookmarkHtml(html) {
  // Template content stays inert, including scripts and external resources.
  const template = document.createElement('template');
  template.innerHTML = html;
  return readBookmarkList(template.content.querySelector('dl'));
}
