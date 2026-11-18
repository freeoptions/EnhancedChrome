import { clampSidebarWidth, emptyData, filterBookmarks, flattenTree, getBookmarkPage, getSelectedBookmarkList } from './core.js';
import { bookmarkCandidates, exportFilename, validateBackup } from './backup.js';
import './tag-sync-ui.js';
import { canDragBookmarkNode, getBookmarkBatchMovePlan, getBookmarkDragScrollDelta, getBookmarkMoveDestination } from './bookmark-move.js';
import { BookmarkRenderQueue } from './bookmark-render-queue.js';
import { getBookmarkClickSelection, getRemainingSingleBookmarkId } from './bookmark-selection.js';

const $ = id => document.getElementById(id);
let treeList = [];
let flatList = [];
let bookmarkNodeMap = new Map();
const bookmarkRowMap = new Map();
const bookmarkRowSignatureMap = new Map();
const folderBookmarkListMap = new Map();
let data = emptyData();
let folderId = null;
let selectedTagSet = new Set();
let tagFilterMode = 'multiple';
const expandedSet = new Set();
let editingBookmarkId = null;
let selectedBookmarkId = null;
let cutBookmarkId = null;
let bookmarkSelectionAnchorId = null;
let bookmarkMutationRunning = false;
let bookmarkUndoTimer;
let renamingTagId = null;
let selectionMode = false;
let previousSelectionCount = 0;
let bulkEditing = false;
const selectedBookmarkSet = new Set();
let bulkBookmarkIdList = [];
let visibleNodeList = [];
let initialTagSet = new Set();
let draftTagSet = new Set();
let editingNode = null;
let toastTimer;
let refreshVersion = 0;
let dataVersion = 0;
let tagDataJSON = JSON.stringify(data);
let searchTimer;
let refreshTimer;
let pendingPage = 1;
let sidebarWidth = 280;
let dragPointerId = null;
let dragOffset = 0;
let draggedNodeId = null;
let draggedBookmarkIdList = [];
let bookmarkDragPoint = null;
let bookmarkDragScrollFrame = null;
let bookmarkDragScrollTime = null;
let bookmarkDropTarget = null;
let bookmarkRenderQueue;
let bookmarkRowFactory;
let bookmarkRenderFrame;
let bookmarkRowHeight = 60;
let bookmarkViewKey = '';

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(text, className, handler) {
  const node = element('button', className, text);
  node.type = 'button';
  node.addEventListener('click', handler);
  return node;
}

function showError(error) {
  $('error').textContent = `操作失败：${error.message}`;
  $('error').hidden = false;
}

function notify(text) {
  clearTimeout(toastTimer);
  $('toast').textContent = text;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2400);
}

function updateBookmarkUndo(result) {
  clearTimeout(bookmarkUndoTimer);
  const message = result.undoCount > 1
    ? `已删除${result.undoCount}条书签，最近删除“${result.undoTitle}”`
    : `已删除“${result.undoTitle}”`;
  $('bookmark-undo-text').textContent = message;
  $('bookmark-undo-text').title = message;
  function updateCountdown() {
    const remaining = result.undoExpiresAt - Date.now();
    $('bookmark-undo').hidden = !result.undoCount || remaining <= 0;
    if ($('bookmark-undo').hidden) {
      $('bookmark-undo-countdown').textContent = '';
      return;
    }
    $('bookmark-undo-countdown').textContent = `${Math.ceil(remaining / 1000)}秒`;
    bookmarkUndoTimer = setTimeout(updateCountdown, Math.min(1000, remaining));
  }
  updateCountdown();
}

function selectBookmark(id) {
  const previousRow = bookmarkRowMap.get(selectedBookmarkId);
  previousRow?.classList.remove('is-selected');
  previousRow?.removeAttribute('aria-current');
  selectedBookmarkId = id;
  const row = bookmarkRowMap.get(id);
  row?.classList.add('is-selected');
  row?.setAttribute('aria-current', 'true');
}

async function deleteBookmark(id) {
  if (bookmarkMutationRunning) return;
  bookmarkMutationRunning = true;
  try {
    const result = await command({ type: 'deleteBookmark', bookmarkId: id });
    if (selectedBookmarkId === id) selectedBookmarkId = null;
    updateBookmarkUndo(result);
    await refresh();
  } catch (error) { showError(error); }
  finally { bookmarkMutationRunning = false; }
}

async function pasteCutBookmark(targetId) {
  if (bookmarkMutationRunning) return;
  bookmarkMutationRunning = true;
  const sourceId = cutBookmarkId;
  try {
    const nodeMap = new Map(flattenTree(await chrome.bookmarks.getTree()).map(node => [node.id, node]));
    const source = nodeMap.get(sourceId);
    const target = nodeMap.get(targetId);
    if (!source?.url) {
      cutBookmarkId = null;
      return notify('剪切的书签已不存在');
    }
    if (!target?.url || sourceId === targetId) return notify('请选择另一条书签作为粘贴位置');
    const destination = getBookmarkMoveDestination(nodeMap, sourceId, targetId, 'after', { allowCrossFolder: true });
    if (!destination) {
      if (source.parentId !== target.parentId || source.index !== target.index + 1) {
        return notify('无法粘贴到这条书签下方');
      }
      cutBookmarkId = null;
      return notify('剪切的书签已在目标下方');
    }
    await chrome.bookmarks.move(sourceId, destination);
    cutBookmarkId = null;
    await refresh();
    notify('书签已粘贴到目标下方');
  } catch (error) { showError(error); }
  finally { bookmarkMutationRunning = false; }
}

$('undo-bookmark').addEventListener('click', async () => {
  if (bookmarkMutationRunning) return;
  bookmarkMutationRunning = true;
  $('undo-bookmark').disabled = true;
  try {
    const result = await command({ type: 'undoDeleteBookmark' });
    selectedBookmarkId = result.bookmarkId;
    updateBookmarkUndo(result);
    await refresh();
    if (!result.undoCount) notify('书签已恢复');
  } catch (error) { showError(error); }
  finally {
    bookmarkMutationRunning = false;
    $('undo-bookmark').disabled = false;
  }
});

async function command(payload) {
  const result = await chrome.runtime.sendMessage(payload);
  if (!result?.ok) throw new Error(result?.error ?? '保存失败，请重试');
  applyTagData((await chrome.storage.local.get('tagData')).tagData ?? emptyData());
  return result;
}

function applyTagData(nextData) {
  const nextJSON = JSON.stringify(nextData);
  if (nextJSON === tagDataJSON) return;
  dataVersion++;
  data = nextData;
  const validTagSet = new Set(data.tags.map(tag => tag.id));
  selectedTagSet = new Set([...selectedTagSet].filter(id => validTagSet.has(id)));
  tagDataJSON = nextJSON;
  renderFilters(); renderBookmarks();
  if ($('tag-dialog').open) renderTagOptions();
  renderPending();
}

function renderPending() {
  const pendingList = data.pendingList ?? [];
  $('pending-panel').hidden = !pendingList.length;
  $('pending-summary').textContent = `待处理关联（${pendingList.length}项）`;
  if (!pendingList.length || !$('pending-panel').open) {
    $('pending-records').replaceChildren();
    return;
  }
  const pageResult = getBookmarkPage(pendingList, pendingPage);
  pendingPage = pageResult.page;
  $('pending-page-info').textContent = `${pendingList.length}项 · 第${pendingPage}/${pageResult.totalPages}页`;
  $('pending-previous').disabled = pendingPage === 1;
  $('pending-next').disabled = pendingPage === pageResult.totalPages;
  $('retry-pending').disabled = !pendingList.length;
  const container = $('pending-records');
  container.replaceChildren();
  if (!pendingList.length) container.append(element('p', 'muted', '没有待处理关联'));
  const nodeMap = new Map(flatList.map(node => [node.id, node]));
  const tagMap = new Map(data.tags.map(tag => [tag.id, tag.name]));
  for (const record of pageResult.itemList) {
    const row = element('div', 'pending-record');
    row.append(element('div', '', record.title || record.url), element('p', 'muted', record.url));
    row.append(element('p', 'muted', `原目录：${record.folderPath || '无'}；标签：${record.tagList.map(id => tagMap.get(id)).filter(Boolean).join('、')}`));
    const candidateList = bookmarkCandidates(record, flatList);
    if (!candidateList.length) row.append(element('span', 'muted', '未找到相同完整网址的书签，等待书签同步后重新匹配。'));
    else {
      const select = element('select');
      select.setAttribute('aria-label', `选择“${record.title || record.url}”对应的书签`);
      const placeholder = element('option', '', '请选择对应书签');
      placeholder.value = '';
      select.append(placeholder);
      for (const node of candidateList) {
        const option = element('option', '', `${nodeMap.get(node.parentId)?.path ?? ''} / ${node.title || node.url}（ID:${node.id}）`);
        option.value = node.id;
        select.append(option);
      }
      const resolve = button('关联并合并标签', 'text-button', async () => {
        if (!select.value) { $('backup-error').textContent = '请先选择对应的书签'; return; }
        resolve.disabled = true;
        try {
          await command({ type: 'resolvePending', pendingId: record.id, bookmarkId: select.value });
          $('backup-error').textContent = '';
          $('backup-status').textContent = '标签关联已保存';
        } catch (error) { $('backup-error').textContent = error.message; }
        finally { resolve.disabled = false; }
      });
      row.append(select, resolve);
    }
    container.append(row);
  }
}

function clearBookmarkDrop() {
  if (bookmarkDropTarget) delete bookmarkDropTarget.dataset.dropPosition;
  bookmarkDropTarget = null;
}

function stopBookmarkDragScroll() {
  cancelAnimationFrame(bookmarkDragScrollFrame);
  bookmarkDragScrollFrame = null;
  bookmarkDragScrollTime = null;
  bookmarkDragPoint = null;
}

function scrollDuringBookmarkDrag(time) {
  bookmarkDragScrollFrame = null;
  if (!draggedNodeId || !bookmarkDragPoint || bookmarkMutationRunning) {
    stopBookmarkDragScroll();
    return;
  }
  const sidebar = $('sidebar');
  const main = document.querySelector('main');
  let scrollTarget = null;
  for (const area of [sidebar, main]) {
    const bounds = area.getBoundingClientRect();
    if (bookmarkDragPoint.x >= bounds.left && bookmarkDragPoint.x <= bounds.right
      && bookmarkDragPoint.y >= bounds.top && bookmarkDragPoint.y <= bounds.bottom) {
      scrollTarget = area === sidebar ? $('folders') : main;
      break;
    }
  }
  if (!scrollTarget) {
    stopBookmarkDragScroll();
    return;
  }
  const bounds = scrollTarget.getBoundingClientRect();
  const delta = getBookmarkDragScrollDelta(bookmarkDragPoint.y, bounds.top, bounds.bottom,
    bookmarkDragScrollTime === null ? 16 : time - bookmarkDragScrollTime);
  const previousTop = scrollTarget.scrollTop;
  scrollTarget.scrollTop += delta;
  if (!delta || scrollTarget.scrollTop === previousTop) {
    stopBookmarkDragScroll();
    return;
  }
  clearBookmarkDrop();
  bookmarkDragScrollTime = time;
  bookmarkDragScrollFrame = requestAnimationFrame(scrollDuringBookmarkDrag);
}

document.addEventListener('dragover', event => {
  if (!draggedNodeId) return;
  bookmarkDragPoint = { x: event.clientX, y: event.clientY };
  if (bookmarkDragScrollFrame === null) bookmarkDragScrollFrame = requestAnimationFrame(scrollDuringBookmarkDrag);
});
document.addEventListener('dragleave', event => {
  if (!event.relatedTarget && (event.clientX <= 0 || event.clientX >= innerWidth
    || event.clientY <= 0 || event.clientY >= innerHeight)) stopBookmarkDragScroll();
});
document.addEventListener('drop', stopBookmarkDragScroll);
document.addEventListener('dragend', stopBookmarkDragScroll);
window.addEventListener('blur', stopBookmarkDragScroll);

function bindBookmarkDrag(row, node, allowSort = false) {
  row.draggable = canDragBookmarkNode(bookmarkNodeMap, node.id, selectionMode, selectedBookmarkSet);
  row.addEventListener('dragstart', event => {
    if (!row.draggable || bookmarkMutationRunning || event.target.closest('input, .text-button, .icon-button, .folder-toggle')) {
      event.preventDefault();
      return;
    }
    draggedNodeId = node.id;
    draggedBookmarkIdList = selectionMode ? [...selectedBookmarkSet] : [node.id];
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/x-enhanced-chrome-bookmark', node.id);
    row.classList.add('is-dragging');
  });
  row.addEventListener('dragend', () => {
    stopBookmarkDragScroll();
    draggedNodeId = null;
    draggedBookmarkIdList = [];
    row.classList.remove('is-dragging');
    clearBookmarkDrop();
  });
  function dropPosition(event) {
    if (selectionMode) return node.url ? null : 'inside';
    const bounds = row.getBoundingClientRect();
    const ratio = (event.clientY - bounds.top) / bounds.height;
    if (!node.url && (!allowSort || (ratio >= .25 && ratio <= .75))) return 'inside';
    return allowSort ? (ratio < .5 ? 'before' : 'after') : null;
  }
  function dropPlan(nodeMap, sourceIdList, position, bulkMove) {
    if (bulkMove) return position === 'inside' ? getBookmarkBatchMovePlan(nodeMap, sourceIdList, node.id) : null;
    const destination = getBookmarkMoveDestination(nodeMap, sourceIdList[0], node.id, position);
    return destination ? [{ id: sourceIdList[0], ...destination }] : null;
  }
  row.addEventListener('dragover', event => {
    clearBookmarkDrop();
    if (!draggedNodeId || bookmarkMutationRunning) return;
    const position = dropPosition(event);
    if (!dropPlan(bookmarkNodeMap, draggedBookmarkIdList, position, selectionMode)?.length) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    row.dataset.dropPosition = position;
    bookmarkDropTarget = row;
  });
  row.addEventListener('dragleave', event => {
    if (!row.contains(event.relatedTarget)) delete row.dataset.dropPosition;
  });
  row.addEventListener('drop', async event => {
    stopBookmarkDragScroll();
    const sourceIdList = [...draggedBookmarkIdList];
    const bulkMove = selectionMode;
    const position = dropPosition(event);
    clearBookmarkDrop();
    if (!draggedNodeId || bookmarkMutationRunning
      || !dropPlan(bookmarkNodeMap, sourceIdList, position, bulkMove)?.length) return;
    event.preventDefault();
    draggedNodeId = null;
    draggedBookmarkIdList = [];
    bookmarkMutationRunning = true;
    let moveList = [];
    let movedCount = 0;
    let failure = null;
    try {
      const nextNodeMap = new Map(flattenTree(await chrome.bookmarks.getTree()).map(item => [item.id, item]));
      moveList = dropPlan(nextNodeMap, sourceIdList, position, bulkMove);
      if (!moveList?.length) throw new Error('书签位置已变化，请重新拖动');
      for (const { id, ...destination } of moveList) {
        await chrome.bookmarks.move(id, destination);
        movedCount++;
      }
      if (position === 'inside') expandedSet.add(node.id);
      if (bulkMove) {
        selectedBookmarkId = null;
        exitSelection();
      }
    } catch (error) {
      failure = error;
      if (bulkMove && movedCount > 0) {
        selectedBookmarkSet.clear();
        for (const item of moveList.slice(movedCount)) selectedBookmarkSet.add(item.id);
      }
    } finally {
      await refresh();
      bookmarkMutationRunning = false;
    }
    if (failure) showError(movedCount ? new Error(`已移动${movedCount}条，${moveList.length - movedCount}条未移动：${failure.message}`) : failure);
    else notify(bulkMove ? `已移动${movedCount}条书签至“${node.title}”` : position === 'inside' ? '已移入文件夹' : '顺序已更新');
  });
}

function renderFolders() {
  const nav = $('folders');
  nav.replaceChildren();
  function addFolder(node, depth) {
    const line = element('div', `folder-line${folderId === node.id ? ' active' : ''}`);
    line.style.paddingLeft = `${12 + depth * 22}px`;
    for (let level = 0; level < depth; level++) {
      const guide = element('span', 'folder-guide');
      guide.setAttribute('aria-hidden', 'true');
      guide.style.left = `${24 + level * 22}px`;
      line.append(guide);
    }
    const childFolderList = (node.children ?? []).filter(child => !child.url);
    const toggle = button('', 'folder-toggle', () => {
      if (expandedSet.has(node.id)) expandedSet.delete(node.id);
      else expandedSet.add(node.id);
      renderFolders();
    });
    toggle.disabled = !childFolderList.length;
    if (childFolderList.length) {
      toggle.setAttribute('aria-label', `${expandedSet.has(node.id) ? '折叠' : '展开'}${node.title}`);
      toggle.setAttribute('aria-expanded', String(expandedSet.has(node.id)));
    }
    const select = button('', 'folder-button', event => {
      if (node.id && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        toggleBookmarkSelection(node);
        return;
      }
      folderId = node.id;
      renderFolders();
      renderBookmarks();
    });
    select.title = node.title;
    if (folderId === node.id) select.setAttribute('aria-current', 'page');
    select.append(element('span', 'folder-icon'), element('span', '', node.title));
    line.append(toggle);
    line.append(select);
    if (node.id) {
      line.dataset.folderId = node.id;
      bindBookmarkDrag(line, node, !!bookmarkNodeMap.get(node.parentId)?.parentId);
      select.draggable = line.draggable;
      if (select.draggable) select.title = `${node.title}\n拖动名称或图标移动文件夹，上下沿调整同级顺序，中央移入文件夹`;
    }
    nav.append(line);
    if (expandedSet.has(node.id)) childFolderList.forEach(child => addFolder(child, depth + 1));
  }
  addFolder({ id: null, title: '全部书签' }, 0);
  for (const root of treeList) {
    for (const node of root.children ?? []) if (!node.url) addFolder(node, 0);
  }
  updateFolderSelection();
}

$('expand-folders').addEventListener('click', () => {
  expandedSet.clear();
  for (const node of flatList) {
    if (!node.url && node.children?.some(child => !child.url)) expandedSet.add(node.id);
  }
  renderFolders();
});
$('collapse-folders').addEventListener('click', () => {
  expandedSet.clear();
  renderFolders();
});

function applyTagFilterMode(mode) {
  tagFilterMode = mode === 'single' ? 'single' : 'multiple';
  if (tagFilterMode === 'single' && selectedTagSet.size > 1) {
    selectedTagSet = new Set([[...selectedTagSet].at(-1)]);
  }
  $('filter-single').setAttribute('aria-pressed', String(tagFilterMode === 'single'));
  $('filter-multiple').setAttribute('aria-pressed', String(tagFilterMode === 'multiple'));
  $('filter-mode-hint').textContent = tagFilterMode === 'single' ? '同时只选一个标签' : '多选时同时包含';
  renderFilters(); renderBookmarks();
}

for (const [id, mode] of [['filter-single', 'single'], ['filter-multiple', 'multiple']]) {
  $(id).addEventListener('click', async () => {
    if (mode === tagFilterMode) return;
    const previousMode = tagFilterMode;
    const previousTagSet = new Set(selectedTagSet);
    applyTagFilterMode(mode);
    $('filter-single').disabled = $('filter-multiple').disabled = true;
    try { await chrome.storage.local.set({ tagFilterMode: mode }); }
    catch (error) {
      selectedTagSet = previousTagSet;
      applyTagFilterMode(previousMode);
      showError(error);
    } finally { $('filter-single').disabled = $('filter-multiple').disabled = false; }
  });
}
chrome.storage.local.get('tagFilterMode').then(storage => {
  applyTagFilterMode(storage.tagFilterMode);
}).catch(showError);

function renderFilters() {
  const validTagSet = new Set(data.tags.map(tag => tag.id));
  selectedTagSet = new Set([...selectedTagSet].filter(id => validTagSet.has(id)));
  $('clear-tags').disabled = !selectedTagSet.size;
  const container = $('tag-filters');
  const all = button('全部', 'chip', () => {
    selectedTagSet.clear(); renderFilters(); renderBookmarks();
  });
  all.setAttribute('aria-pressed', String(!selectedTagSet.size));
  container.replaceChildren(all);
  function updatePressed() {
    for (const chip of container.querySelectorAll('[data-tag-id]')) {
      chip.setAttribute('aria-pressed', String(selectedTagSet.has(chip.dataset.tagId)));
    }
    all.setAttribute('aria-pressed', String(!selectedTagSet.size));
    $('clear-tags').disabled = !selectedTagSet.size;
  }
  for (const tag of data.tags) {
    let previousTagSet;
    const chip = button(tag.name, 'chip', event => {
      if (event.detail < 2) previousTagSet = new Set(selectedTagSet);
      if (selectedTagSet.has(tag.id)) selectedTagSet.delete(tag.id);
      else {
        if (tagFilterMode === 'single') selectedTagSet.clear();
        selectedTagSet.add(tag.id);
      }
      updatePressed();
      renderBookmarks();
    });
    chip.dataset.tagId = tag.id;
    chip.title = '双击管理标签';
    chip.addEventListener('dblclick', () => {
      if (previousTagSet) selectedTagSet = previousTagSet;
      updatePressed(); renderBookmarks();
      openTags(null);
    });
    chip.setAttribute('aria-pressed', String(selectedTagSet.has(tag.id)));
    container.append(chip);
  }
  container.append(button('＋ 新增标签', 'chip add', () => openTags(null)));
}

function renderBookmarks() {
  const query = $('search').value;
  const currentFolder = bookmarkNodeMap.get(folderId);
  if (folderId && !currentFolder) folderId = null;
  const globalTagFiltering = selectedTagSet.size > 0;
  const filtering = globalTagFiltering || query.trim().length > 0;
  $('folder-title').textContent = globalTagFiltering ? '全部书签' : currentFolder?.title ?? '全部书签';
  $('bulk-tags').hidden = selectionMode;
  $('scope-hint').textContent = globalTagFiltering ? '全局标签筛选' : filtering && folderId ? '含子文件夹' : '';
  let candidateList;
  if (!folderId || globalTagFiltering) candidateList = flatList.filter(node => node.url);
  else if (filtering) candidateList = flattenTree(currentFolder.children ?? []);
  else candidateList = currentFolder.children ?? [];
  const visibleList = filtering
    ? filterBookmarks(candidateList, data, selectedTagSet, query)
    : candidateList;
  $('result-count').textContent = `${visibleList.length}项`;
  visibleNodeList = visibleList;
  const visibleIdSet = new Set(visibleList.map(node => node.id));
  if (!visibleIdSet.has(selectedBookmarkId)) selectedBookmarkId = null;
  updateSelectionToolbar();
  cancelAnimationFrame(bookmarkRenderFrame);
  const container = $('bookmarks');
  const viewKey = JSON.stringify([folderId, query, [...selectedTagSet]]);
  const sameView = viewKey === bookmarkViewKey && !!bookmarkRenderQueue;
  const scrollAnchor = sameView ? getBookmarkScrollAnchor(container, visibleIdSet) : null;
  if (!sameView) {
    document.querySelector('main').scrollTop = 0;
    bookmarkViewKey = viewKey;
    bookmarkSelectionAnchorId = null;
  }
  clearBookmarkDrop();
  const retainedList = sameView ? bookmarkRenderQueue.update(visibleNodeList) : [];
  if (!sameView) bookmarkRenderQueue = new BookmarkRenderQueue(visibleNodeList);
  if (!retainedList.length) {
    bookmarkRowMap.clear();
    bookmarkRowSignatureMap.clear();
    container.replaceChildren();
  }
  container.style.minHeight = bookmarkRenderQueue.renderedCount < visibleNodeList.length
    ? `${visibleNodeList.length * bookmarkRowHeight}px` : '';
  if (!visibleList.length) {
    container.style.minHeight = '';
    container.append(element('p', 'empty', filtering ? '没有符合条件的书签\n试试减少标签或更换搜索关键词' : '此文件夹暂无书签'));
    return;
  }
  const tagMap = new Map(data.tags.map(tag => [tag.id, tag]));
  bookmarkRowFactory = node => {
    const signature = JSON.stringify([node.title, node.url, node.parentId,
      (data.bookmarks[node.id] ?? []).map(id => [id, tagMap.get(id)?.name])]);
    const previousRow = bookmarkRowMap.get(node.id);
    if (previousRow && bookmarkRowSignatureMap.get(node.id) === signature) {
      previousRow.draggable = canDragBookmarkNode(bookmarkNodeMap, node.id, selectionMode, selectedBookmarkSet);
      return previousRow;
    }
    const row = element('div', 'bookmark-row');
    row.dataset.nodeId = node.id;
    bindBookmarkDrag(row, node, !!folderId && !filtering);
    if (!node.url) {
      const open = button('', 'folder-button', event => {
        if (event.ctrlKey || event.metaKey) {
          event.preventDefault();
          toggleBookmarkSelection(node);
          return;
        }
        folderId = node.id;
        if (node.parentId) expandedSet.add(node.parentId);
        renderFolders(); renderBookmarks();
      });
      open.append(element('span', 'folder-icon'), element('span', '', node.title));
      row.append(open);
    } else {
      row.classList.add('bookmark-item');
      row.dataset.bookmarkId = node.id;
      row.tabIndex = 0;
      if (selectionMode ? selectedBookmarkSet.has(node.id) : node.id === selectedBookmarkId) {
        row.classList.add('is-selected');
        row.setAttribute('aria-current', 'true');
      }
      row.addEventListener('mousedown', event => {
        if (event.button === 0 && (event.ctrlKey || event.metaKey || event.shiftKey)
          && !event.target.closest('button, input')) event.preventDefault();
      });
      row.addEventListener('click', event => {
        if (event.target.closest('button, input')) return;
        if (event.ctrlKey || event.metaKey || event.shiftKey) {
          event.preventDefault();
          selectBookmarkWithModifiers(node.id, event);
        } else if (selectionMode) toggleBookmarkSelection(node);
        else {
          selectBookmark(node.id);
          bookmarkSelectionAnchorId = node.id;
          row.focus({ preventScroll: true });
        }
      });
      row.addEventListener('dblclick', event => {
        if (selectionMode || event.ctrlKey || event.metaKey || event.shiftKey || event.target.closest('button, input')) return;
        event.preventDefault();
        chrome.tabs.create({ url: node.url }).catch(showError);
      });
      row.addEventListener('focus', () => { if (!selectionMode) selectBookmark(node.id); });
      let hostname = '';
      try { hostname = new URL(node.url).hostname; } catch { /* Chrome允许部分特殊书签地址。 */ }
      const siteIcon = element('span', 'site-icon', hostname ? hostname.replace(/^www\./, '')[0].toUpperCase() : '↗');
      const favicon = element('img', 'site-favicon');
      favicon.alt = '';
      favicon.draggable = false;
      favicon.loading = 'lazy';
      const faviconUrl = new URL(chrome.runtime.getURL('/_favicon/'));
      faviconUrl.searchParams.set('pageUrl', node.url);
      faviconUrl.searchParams.set('size', '32');
      favicon.addEventListener('load', () => {
        siteIcon.replaceChildren(favicon);
      });
      favicon.addEventListener('error', () => favicon.remove());
      favicon.src = faviconUrl.href;
      siteIcon.append(favicon);
      row.append(siteIcon);
      const info = element('div', 'bookmark-info');
      const link = element('a', 'bookmark-link', node.title || node.url);
      link.href = '#';
      link.title = `${node.title}\n${node.url}`;
      link.addEventListener('click', event => {
        event.preventDefault();
      });
      info.append(link, element('div', 'bookmark-url', node.url));
      row.append(info);
      const badges = element('div', 'row-tags');
      for (const tagId of data.bookmarks[node.id] ?? []) {
        const tag = tagMap.get(tagId);
        if (tag) badges.append(element('span', 'tag-badge', tag.name));
      }
      const tagButton = button('打标签', 'text-button', () => openTags(node));
      tagButton.setAttribute('aria-label', `设置“${node.title || node.url}”的标签`);
      const editButton = button('⋮', 'icon-button', () => openEdit(node));
      editButton.title = '编辑名称和网址';
      editButton.setAttribute('aria-label', `编辑“${node.title || node.url}”`);
      row.append(badges, tagButton, editButton);
    }
    previousRow?.replaceWith(row);
    bookmarkRowMap.set(node.id, row);
    bookmarkRowSignatureMap.set(node.id, signature);
    return row;
  };
  if (retainedList.length) reconcileBookmarkChunks(retainedList);
  const anchorRow = scrollAnchor && bookmarkRowMap.get(scrollAnchor.id);
  if (anchorRow) document.querySelector('main').scrollTop += anchorRow.getBoundingClientRect().top - scrollAnchor.top;
  fillBookmarkViewport();
}

function getBookmarkScrollAnchor(container, visibleIdSet) {
  const bounds = document.querySelector('main').getBoundingClientRect();
  const top = Math.max(bounds.top, document.querySelector('.list-heading').getBoundingClientRect().bottom);
  for (const chunk of container.children) {
    const chunkBounds = chunk.getBoundingClientRect();
    if (chunkBounds.bottom <= top || chunkBounds.top >= bounds.bottom) continue;
    for (const row of chunk.children) {
      if (!visibleIdSet.has(row.dataset.nodeId)) continue;
      const rowBounds = row.getBoundingClientRect();
      if (rowBounds.bottom > top && rowBounds.top < bounds.bottom) return { id: row.dataset.nodeId, top: rowBounds.top };
    }
  }
  return null;
}

function reconcileBookmarkChunks(nodeList) {
  const container = $('bookmarks');
  const retainedIdSet = new Set(nodeList.map(node => node.id));
  for (const [id, row] of bookmarkRowMap) {
    if (retainedIdSet.has(id)) continue;
    row.remove();
    bookmarkRowMap.delete(id);
    bookmarkRowSignatureMap.delete(id);
  }
  const chunkSize = bookmarkRenderQueue.chunkSize;
  const chunkCount = Math.ceil(nodeList.length / chunkSize);
  for (let index = 0; index < chunkCount; index++) {
    let chunk = container.children[index];
    if (!chunk) {
      chunk = element('div', 'bookmark-chunk');
      container.append(chunk);
    }
    const chunkList = nodeList.slice(index * chunkSize, (index + 1) * chunkSize);
    chunk.style.containIntrinsicSize = `auto ${chunkList.length * bookmarkRowHeight}px`;
    for (let offset = 0; offset < chunkList.length; offset++) {
      const row = bookmarkRowFactory(chunkList[offset]);
      const currentRow = chunk.children[offset];
      if (currentRow !== row) chunk.insertBefore(row, currentRow ?? null);
    }
    while (chunk.children.length > chunkList.length) chunk.lastElementChild.remove();
  }
  while (container.children.length > chunkCount) container.lastElementChild.remove();
}

function scheduleBookmarkRender() {
  cancelAnimationFrame(bookmarkRenderFrame);
  bookmarkRenderFrame = requestAnimationFrame(fillBookmarkViewport);
}

function fillBookmarkViewport() {
  if (!bookmarkRenderQueue || !visibleNodeList.length) return;
  const container = $('bookmarks');
  const main = document.querySelector('main');
  const viewportEnd = main.getBoundingClientRect().bottom - container.getBoundingClientRect().top;
  const chunkList = bookmarkRenderQueue.next(viewportEnd, bookmarkRowHeight);
  if (!chunkList.length) return;
  const chunk = element('div', 'bookmark-chunk');
  chunk.style.containIntrinsicSize = `auto ${chunkList.length * bookmarkRowHeight}px`;
  for (const node of chunkList) chunk.append(bookmarkRowFactory(node));
  container.append(chunk);
  const firstRow = container.querySelector('.bookmark-row');
  bookmarkRowHeight = Math.max(60, firstRow.getBoundingClientRect().height);
  container.style.minHeight = bookmarkRenderQueue.renderedCount < visibleNodeList.length
    ? `${visibleNodeList.length * bookmarkRowHeight}px` : '';
  scheduleBookmarkRender();
}

document.querySelector('main').addEventListener('scroll', scheduleBookmarkRender, { passive: true });
new ResizeObserver(scheduleBookmarkRender).observe(document.querySelector('main'));

function openTags(node) {
  bulkEditing = false;
  editingBookmarkId = node?.id ?? null;
  initialTagSet = new Set(data.bookmarks[editingBookmarkId] ?? []);
  draftTagSet = new Set(initialTagSet);
  $('tag-dialog-title').textContent = node ? '设置书签标签' : '管理标签';
  $('tag-dialog-description').textContent = node ? node.title || node.url : '删除标签会移除所有书签上的该标签，书签会保留。';
  $('save-tags').hidden = !node;
  $('save-tags').disabled = false;
  $('save-tags').textContent = '保存';
  $('new-tag').value = '';
  $('dialog-error').textContent = '';
  renderTagOptions();
  $('tag-dialog').showModal();
  if (!node) $('new-tag').focus();
}

function getSelectableBookmarkList(node) {
  node = bookmarkNodeMap.get(node.id) ?? node;
  let bookmarkList = node.url ? [node] : folderBookmarkListMap.get(node.id);
  if (!bookmarkList) {
    bookmarkList = getSelectedBookmarkList([node], new Set([node.id]));
    folderBookmarkListMap.set(node.id, bookmarkList);
  }
  return bookmarkList;
}

function toggleBookmarkSelection(node) {
  const bookmarkList = getSelectableBookmarkList(node);
  if (!bookmarkList.length) return;
  if (!selectionMode && selectedBookmarkId) selectedBookmarkSet.add(selectedBookmarkId);
  const deselect = bookmarkList.every(bookmark => selectedBookmarkSet.has(bookmark.id));
  for (const bookmark of bookmarkList) {
    if (deselect) selectedBookmarkSet.delete(bookmark.id);
    else selectedBookmarkSet.add(bookmark.id);
  }
  if (node.url) bookmarkSelectionAnchorId = node.id;
  enterSelection();
  updateBookmarkSelection();
  if (!selectionMode) bookmarkRowMap.get(selectedBookmarkId)?.focus({ preventScroll: true });
}

function updateFolderSelection() {
  for (const line of $('folders').querySelectorAll('[data-folder-id]')) {
    const node = bookmarkNodeMap.get(line.dataset.folderId);
    const bookmarkList = selectionMode && node ? getSelectableBookmarkList(node) : [];
    line.classList.toggle('is-selected', bookmarkList.length > 0 && bookmarkList.every(bookmark => selectedBookmarkSet.has(bookmark.id)));
  }
}

function updateBookmarkSelection() {
  const remainingId = selectionMode ? getRemainingSingleBookmarkId(selectedBookmarkSet, previousSelectionCount) : null;
  if (remainingId) {
    selectedBookmarkId = remainingId;
    exitSelection();
    return;
  }
  previousSelectionCount = selectedBookmarkSet.size;
  updateSelectionToolbar();
  updateFolderSelection();
  for (const [id, row] of bookmarkRowMap) {
    const selected = selectionMode ? selectedBookmarkSet.has(id) : selectedBookmarkId === id;
    row.classList.toggle('is-selected', selected);
    if (selected) row.setAttribute('aria-current', 'true');
    else row.removeAttribute('aria-current');
    row.draggable = canDragBookmarkNode(bookmarkNodeMap, id, selectionMode, selectedBookmarkSet);
  }
}

function updateSelectionToolbar() {
  $('selection-toolbar').hidden = !selectionMode;
  $('selection-count').textContent = `已选${selectedBookmarkSet.size}条书签（跨文件夹保留）`;
  $('label-selection').disabled = !selectedBookmarkSet.size;
  $('clear-selection').disabled = !selectedBookmarkSet.size;
}

function enterSelection() {
  if (selectionMode) return;
  selectionMode = true;
  previousSelectionCount = selectedBookmarkSet.size;
  $('bulk-tags').hidden = true;
  for (const row of $('bookmarks').querySelectorAll('.bookmark-row')) {
    row.draggable = canDragBookmarkNode(bookmarkNodeMap, row.dataset.nodeId, selectionMode, selectedBookmarkSet);
  }
  renderFolders();
  updateBookmarkSelection();
}

function selectBookmarkWithModifiers(id, event) {
  const initialIdSet = selectionMode ? selectedBookmarkSet : new Set(selectedBookmarkId ? [selectedBookmarkId] : []);
  const result = getBookmarkClickSelection(visibleNodeList, initialIdSet, bookmarkSelectionAnchorId, id,
    { toggle: event.ctrlKey || event.metaKey, range: event.shiftKey });
  selectedBookmarkSet.clear();
  for (const selectedId of result.selectedIdSet) selectedBookmarkSet.add(selectedId);
  bookmarkSelectionAnchorId = result.anchorId;
  enterSelection();
  updateBookmarkSelection();
  bookmarkRowMap.get(selectionMode ? id : selectedBookmarkId)?.focus({ preventScroll: true });
}

function exitSelection() {
  selectionMode = false;
  selectedBookmarkSet.clear();
  previousSelectionCount = 0;
  bookmarkSelectionAnchorId = selectedBookmarkId;
  $('bulk-tags').hidden = false;
  for (const row of $('bookmarks').querySelectorAll('.bookmark-row')) {
    row.draggable = canDragBookmarkNode(bookmarkNodeMap, row.dataset.nodeId, selectionMode, selectedBookmarkSet);
  }
  renderFolders();
  updateBookmarkSelection();
}
$('bulk-tags').addEventListener('click', enterSelection);
$('exit-selection').addEventListener('click', exitSelection);
$('clear-selection').addEventListener('click', () => {
  selectedBookmarkSet.clear(); bookmarkSelectionAnchorId = null; updateBookmarkSelection();
});
$('select-visible').addEventListener('click', () => {
  const bookmarkList = getSelectedBookmarkList(visibleNodeList, new Set(visibleNodeList.map(node => node.id)));
  for (const bookmark of bookmarkList) selectedBookmarkSet.add(bookmark.id);
  updateBookmarkSelection();
});
$('label-selection').addEventListener('click', () => {
  if (!selectedBookmarkSet.size) return;
  bulkEditing = true;
  bulkBookmarkIdList = [...selectedBookmarkSet];
  editingBookmarkId = null;
  initialTagSet.clear();
  draftTagSet = new Set();
  $('tag-dialog-title').textContent = '批量打标签';
  $('tag-dialog-description').textContent = `为勾选的${bulkBookmarkIdList.length}条书签追加标签，保留已有标签。选中文件夹时包含其所有层级的书签。`;
  $('save-tags').hidden = false;
  $('save-tags').disabled = false;
  $('save-tags').textContent = '批量添加';
  $('new-tag').value = '';
  $('dialog-error').textContent = '';
  renderTagOptions();
  $('tag-dialog').showModal();
});

function renderTagOptions() {
  const container = $('tag-options');
  container.replaceChildren();
  if (!data.tags.length) container.append(element('p', 'muted', '还没有标签，在下方新增第一个标签。'));
  for (const tag of data.tags) {
    const row = element('div', 'tag-option');
    if (editingBookmarkId || bulkEditing) {
      const label = element('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = tag.id;
      checkbox.checked = draftTagSet.has(tag.id);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) draftTagSet.add(tag.id);
        else draftTagSet.delete(tag.id);
      });
      label.append(checkbox, document.createTextNode(tag.name));
      row.append(label);
    } else {
      row.append(element('span', '', tag.name));
      const edit = button('编辑', 'text-button', () => {
        renamingTagId = tag.id;
        const nameInput = $('rename-tag-name');
        nameInput.value = tag.name;
        nameInput.defaultValue = nameInput.value;
        $('rename-tag-error').textContent = '';
        $('rename-tag-dialog').showModal();
        nameInput.focus(); nameInput.select();
      });
      edit.setAttribute('aria-label', `编辑标签“${tag.name}”`);
      const remove = button('删除', 'text-button danger', async () => {
        if (!confirm(`删除标签“${tag.name}”？所有书签上的该标签都会移除，书签不会删除。`)) return;
        remove.disabled = true;
        try {
          await command({ type: 'deleteTag', id: tag.id });
          notify('标签已删除');
        } catch (error) { $('dialog-error').textContent = error.message; }
        finally { remove.disabled = false; }
      });
      const actions = element('div', 'tag-actions');
      actions.append(edit, remove);
      row.append(actions);
    }
    container.append(row);
  }
}

function openEdit(node) {
  editingNode = node;
  const nameInput = $('bookmark-name');
  const urlInput = $('bookmark-url');
  nameInput.value = node.title;
  nameInput.defaultValue = nameInput.value;
  urlInput.value = node.url;
  urlInput.defaultValue = urlInput.value;
  $('edit-error').textContent = '';
  $('edit-dialog').showModal();
}

async function refresh() {
  const version = ++refreshVersion;
  const initialDataVersion = dataVersion;
  try {
    const [nextTreeList, storage] = await Promise.all([chrome.bookmarks.getTree(), chrome.storage.local.get('tagData')]);
    if (version !== refreshVersion) return;
    treeList = nextTreeList;
    flatList = flattenTree(treeList);
    bookmarkNodeMap = new Map(flatList.map(node => [node.id, node]));
    folderBookmarkListMap.clear();
    const validBookmarkSet = new Set(flatList.filter(node => node.url).map(node => node.id));
    for (const id of selectedBookmarkSet) if (!validBookmarkSet.has(id)) selectedBookmarkSet.delete(id);
    updateBookmarkSelection();
    if (dataVersion === initialDataVersion) {
      data = storage.tagData ?? emptyData();
      tagDataJSON = JSON.stringify(data);
    }
    $('error').hidden = true;
    renderFilters(); renderBookmarks(); renderFolders();
    if ($('tag-dialog').open) renderTagOptions();
    renderPending();
  } catch (error) { showError(error); }
}

$('search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { renderBookmarks(); }, 150);
});
$('manage-tags').addEventListener('click', () => openTags(null));
chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.id !== chrome.runtime.id || message?.type !== 'openManagerSettings') return;
  chrome.tabs.getCurrent().then(tab => {
    if (tab?.id === message.targetTabId && !$('settings-dialog').open) $('settings').click();
  });
});
$('pending-panel').addEventListener('toggle', () => { if ($('pending-panel').open) renderPending(); });
$('export-tags').addEventListener('click', async () => {
  $('export-tags').disabled = true;
  $('backup-error').textContent = '';
  try {
    const result = await command({ type: 'exportBackup' });
    const url = URL.createObjectURL(new Blob([JSON.stringify(result.backup, null, 2)], { type: 'application/json;charset=utf-8' }));
    const link = element('a');
    link.href = url;
    link.download = exportFilename();
    document.body.append(link);
    link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    $('backup-status').textContent = `已发起下载：${link.download}，请保留该文件用于换电脑恢复。`;
  } catch (error) { $('backup-error').textContent = error.message; }
  finally { $('export-tags').disabled = false; }
});
$('import-tags').addEventListener('click', () => { $('backup-file').value = ''; $('backup-file').click(); });
$('backup-file').addEventListener('change', async () => {
  const file = $('backup-file').files[0];
  if (!file) return;
  $('import-tags').disabled = true;
  $('backup-error').textContent = '';
  $('backup-status').textContent = '正在读取并匹配标签备份…';
  try {
    const backup = validateBackup(JSON.parse((await file.text()).replace(/^\uFEFF/, '')));
    const result = await command({ type: 'importBackup', backup });
    $('backup-status').textContent = `已合并恢复${result.matchedCount}条书签的标签，待处理${result.pendingCount}项。`;
    pendingPage = 1;
    $('pending-panel').open = result.pendingCount > 0;
    renderPending();
  } catch (error) {
    $('backup-status').textContent = '';
    $('backup-error').textContent = error instanceof SyntaxError ? '文件不是有效的JSON，请选择ChromeCollect导出的备份' : error.message;
  } finally { $('import-tags').disabled = false; }
});
$('retry-pending').addEventListener('click', async () => {
  $('retry-pending').disabled = true;
  $('backup-error').textContent = '';
  try {
    const result = await command({ type: 'retryPending' });
    await refresh();
    $('backup-status').textContent = `本次恢复${result.matchedCount}条书签的标签，待处理${result.pendingCount}项。`;
  } catch (error) { $('backup-error').textContent = error.message; }
  finally { $('retry-pending').disabled = !(data.pendingList ?? []).length; }
});
for (const [id, direction] of [['pending-previous', -1], ['pending-next', 1]]) {
  $(id).addEventListener('click', () => { pendingPage += direction; renderPending(); $('pending-records').scrollTop = 0; });
}
$('clear-tags').addEventListener('click', () => { selectedTagSet.clear(); renderFilters(); renderBookmarks(); });
document.querySelectorAll('.close-dialog').forEach(node => node.addEventListener('click', () => node.closest('dialog').close()));

function isDialogBackdrop(event) {
  const dialog = event.currentTarget;
  if (event.target !== dialog) return false;
  const { left, right, top, bottom } = dialog.getBoundingClientRect();
  return event.clientX < left || event.clientX >= right || event.clientY < top || event.clientY >= bottom;
}

function hasTagDraft() {
  const tagsChanged = draftTagSet.size !== initialTagSet.size || [...draftTagSet].some(id => !initialTagSet.has(id));
  const submittingNewTag = $('new-tag-form').querySelector('button[type="submit"]').disabled;
  return tagsChanged || $('new-tag').value !== '' || submittingNewTag || $('save-tags').disabled;
}

function hasUnsavedFormChanges(form) {
  return [...form.querySelectorAll('input')].some(input => input.value !== input.defaultValue)
    || form.querySelector('button[type="submit"]').disabled;
}

const backdropGuardMap = new Map([
  ['tag-dialog', hasTagDraft],
  ['rename-tag-dialog', () => hasUnsavedFormChanges($('rename-tag-form'))],
  ['edit-dialog', () => hasUnsavedFormChanges($('edit-form'))],
  ['settings-dialog', () => ['font-size', 'single-newtab-enabled', 'dedupe-enabled'].some(id => $(id).disabled)],
  ['module-settings-dialog', () => $('module-settings-frame').contentDocument?.dispatchEvent(
    new Event('before-backdrop-close', { cancelable: true })
  ) === false]
]);
for (const [id, hasUnsavedChanges] of backdropGuardMap) {
  const dialog = $(id);
  let pointerStartedOutside = false;
  dialog.addEventListener('pointerdown', event => {
    pointerStartedOutside = event.button === 0 && isDialogBackdrop(event);
  });
  dialog.addEventListener('click', event => {
    const startedOutside = pointerStartedOutside;
    pointerStartedOutside = false;
    if (startedOutside && isDialogBackdrop(event) && !hasUnsavedChanges()) dialog.close();
  });
}

document.addEventListener('keydown', event => {
  if (event.key === 'Delete' && !event.repeat && !event.ctrlKey && !event.metaKey && !event.altKey
    && !selectionMode && selectedBookmarkId && !document.querySelector('dialog[open]')
    && !event.target.isContentEditable && !event.target.closest('input, textarea, select, button')) {
    event.preventDefault();
    deleteBookmark(selectedBookmarkId);
    return;
  }
  if ((event.ctrlKey || event.metaKey) && !event.altKey && ['f', 'k'].includes(event.key.toLowerCase())) {
    event.preventDefault();
    document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
    $('search').focus(); $('search').select();
  }
  const key = event.key.toLowerCase();
  if ((key !== 'x' && key !== 'v') || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.repeat
    || selectionMode || !selectedBookmarkId || bookmarkMutationRunning
    || document.querySelector('dialog[open]') || event.target.isContentEditable
    || event.target.closest('input, textarea, select, button')) return;

  if (key === 'x' && canDragBookmarkNode(bookmarkNodeMap, selectedBookmarkId, false, selectedBookmarkSet)) {
    event.preventDefault();
    cutBookmarkId = selectedBookmarkId;
    notify('书签已剪切，选中目标书签后粘贴');
  } else if (key === 'v' && cutBookmarkId) {
    event.preventDefault();
    pasteCutBookmark(selectedBookmarkId);
  }
});

function setSidebarWidth(width) {
  sidebarWidth = clampSidebarWidth(width, window.innerWidth);
  document.documentElement.style.setProperty('--sidebar-width', `${sidebarWidth}px`);
  $('sidebar-resizer').setAttribute('aria-valuenow', String(Math.round(sidebarWidth)));
  $('sidebar-resizer').setAttribute('aria-valuemax', String(clampSidebarWidth(600, window.innerWidth)));
}

function saveSidebarWidth() {
  chrome.storage.local.set({ sidebarWidth }).catch(showError);
}

$('sidebar-resizer').addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  event.preventDefault();
  dragPointerId = event.pointerId;
  dragOffset = event.clientX - $('sidebar').getBoundingClientRect().right;
  $('sidebar-resizer').setPointerCapture(event.pointerId);
  document.body.classList.add('resizing-sidebar');
});
$('sidebar-resizer').addEventListener('pointermove', event => {
  if (event.pointerId !== dragPointerId) return;
  setSidebarWidth(event.clientX - dragOffset);
});
for (const eventName of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  $('sidebar-resizer').addEventListener(eventName, event => {
    if (event.pointerId !== dragPointerId) return;
    dragPointerId = null;
    document.body.classList.remove('resizing-sidebar');
    if ($('sidebar-resizer').hasPointerCapture(event.pointerId)) $('sidebar-resizer').releasePointerCapture(event.pointerId);
    saveSidebarWidth();
  });
}
$('sidebar-resizer').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const width = event.key === 'Home' ? 140 : event.key === 'End' ? 600
    : sidebarWidth + (event.key === 'ArrowLeft' ? -20 : 20);
  setSidebarWidth(width); saveSidebarWidth();
});
window.addEventListener('resize', () => setSidebarWidth(sidebarWidth));
chrome.storage.local.get('sidebarWidth').then(storage => {
  if (dragPointerId === null) setSidebarWidth(storage.sidebarWidth);
}).catch(showError);

async function updateShortcut() {
  try {
    const commandList = await chrome.commands.getAll();
    const shortcut = commandList.find(item => item.name === '_execute_action')?.shortcut;
    $('current-shortcut').textContent = shortcut ? `当前快捷键：${shortcut}` : '尚未分配快捷键或当前Chrome版本无法读取，请点击下方按钮设置。';
  } catch (error) { $('settings-error').textContent = error.message; }
}
$('settings').addEventListener('click', () => {
  $('settings-error').textContent = '';
  $('page-url').value = chrome.runtime.getURL('manager.html');
  $('settings-dialog').showModal();
  updateShortcut();
  document.dispatchEvent(new Event('settings-open'));
});
$('configure-shortcut').addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }).catch(error => { $('settings-error').textContent = error.message; });
});
$('copy-page-url').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('page-url').value);
    notify('页面地址已复制');
  } catch {
    $('page-url').focus(); $('page-url').select();
    $('settings-error').textContent = '未能自动复制，地址已选中，请按Ctrl+C复制。';
  }
});
window.addEventListener('focus', () => { if ($('settings-dialog').open) updateShortcut(); });
$('rename-tag-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('rename-tag-save').disabled = true;
  $('rename-tag-error').textContent = '';
  try {
    await command({ type: 'renameTag', id: renamingTagId, name: $('rename-tag-name').value });
    $('rename-tag-dialog').close(); notify('标签名称已更新');
  } catch (error) { $('rename-tag-error').textContent = error.message; }
  finally { $('rename-tag-save').disabled = false; }
});
$('new-tag-form').addEventListener('submit', async event => {
  event.preventDefault();
  const submit = event.submitter;
  submit.disabled = true;
  $('dialog-error').textContent = '';
  try {
    await command({ type: 'createTag', name: $('new-tag').value });
    $('new-tag').value = '';
    $('new-tag').focus(); notify('标签已新增');
  } catch (error) { $('dialog-error').textContent = error.message; }
  finally { submit.disabled = false; }
});
$('save-tags').addEventListener('click', async () => {
  $('save-tags').disabled = true;
  try {
    if (bulkEditing) {
      const result = await command({ type: 'addBookmarkTags', bookmarkIdList: bulkBookmarkIdList, tagList: [...draftTagSet] });
      $('tag-dialog').close();
      exitSelection();
      notify(`已处理${result.totalCount}条书签，新增标签关联${result.changedCount}条`);
    } else {
      await command({ type: 'setBookmarkTags', bookmarkId: editingBookmarkId, tagList: [...draftTagSet] });
      $('tag-dialog').close(); notify('书签标签已保存');
    }
  } catch (error) { $('dialog-error').textContent = error.message; }
  finally { $('save-tags').disabled = false; }
});
$('edit-form').addEventListener('submit', async event => {
  event.preventDefault();
  const submit = event.submitter;
  submit.disabled = true;
  try {
    await chrome.bookmarks.update(editingNode.id, { title: $('bookmark-name').value, url: $('bookmark-url').value });
    $('edit-dialog').close(); await refresh(); notify('书签已更新，标签已保留');
  } catch (error) { $('edit-error').textContent = error.message; }
  finally { submit.disabled = false; }
});

for (const event of [chrome.bookmarks.onCreated, chrome.bookmarks.onRemoved, chrome.bookmarks.onChanged, chrome.bookmarks.onMoved, chrome.bookmarks.onChildrenReordered, chrome.bookmarks.onImportEnded]) {
  event.addListener(() => {
    clearTimeout(refreshTimer);
    if (!bookmarkMutationRunning) refreshTimer = setTimeout(refresh, 60);
  });
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.tagFilterMode) applyTagFilterMode(changes.tagFilterMode.newValue);
  if (area === 'local' && changes.tagData) applyTagData(changes.tagData.newValue ?? emptyData());
});
refresh();
command({ type: 'getBookmarkUndoState' }).then(updateBookmarkUndo).catch(showError);
if (new URLSearchParams(location.search).get('settings') === '1') $('settings').click();
