import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, clampSidebarWidth, emptyData, filterBookmarks, flattenTree, getBookmarkPage, removeBookmarks } from '../core.js';

test('侧栏拖动限制宽度，窄窗口保留内容区域，非法存储值使用默认宽度', () => {
  assert.equal(clampSidebarWidth(20, 1440), 140);
  assert.equal(clampSidebarWidth(900, 1440), 600);
  assert.equal(clampSidebarWidth(600, 800), 554);
  assert.equal(clampSidebarWidth(600, 375), 140);
  assert.equal(clampSidebarWidth(undefined, 1440), 280);
  assert.equal(clampSidebarWidth('400', 1440), 280);
  assert.equal(clampSidebarWidth(350, 1440), 350);
});

test('一万条书签每次只提供100条给页面，翻页无遗漏或重复', () => {
  const nodeList = Array.from({ length: 10000 }, (_, index) => ({ id: String(index) }));
  const visitedList = [];
  for (let page = 1; page <= 100; page++) {
    const result = getBookmarkPage(nodeList, page);
    assert.equal(result.itemList.length, 100);
    assert.equal(result.page, page);
    assert.equal(result.totalPages, 100);
    visitedList.push(...result.itemList);
  }
  assert.deepEqual(visitedList, nodeList);
});

test('筛选后页码自动收缩，空列表和最后一页不越界', () => {
  const nodeList = Array.from({ length: 101 }, (_, index) => ({ id: String(index) }));
  const result = getBookmarkPage(nodeList, 99);
  assert.equal(result.page, 2);
  assert.deepEqual(result.itemList, [nodeList[100]]);
  assert.deepEqual(getBookmarkPage([], 99), { itemList: [], page: 1, totalPages: 1 });
  assert.equal(getBookmarkPage(nodeList, 0).page, 1);
});

test('标签绑定书签ID，修改名称、网址、文件夹以及持久化后保留', () => {
  let data = emptyData();
  applyCommand(data, { type: 'createTag', id: 'a', name: 'a标签' });
  applyCommand(data, { type: 'setBookmarkTags', bookmarkId: '21', tagList: ['a'] });
  data = JSON.parse(JSON.stringify(data));
  const updated = { id: '21', title: '新名称', url: 'https://www.v2ex.com/t/1081226', parentId: 'new-folder' };
  assert.deepEqual(filterBookmarks([updated], data, new Set(['a']), ''), [updated]);
  assert.deepEqual(filterBookmarks([{ ...updated, id: '22' }], data, new Set(['a']), ''), []);
});

test('多标签取交集，并与名称、网址搜索组合', () => {
  const data = { tags: [], bookmarks: { one: ['a', 'b'], two: ['a'] } };
  const nodeList = [{ id: 'one', title: 'V2EX', url: 'https://www.v2ex.com/t/1081225#reply21' }, { id: 'two', title: '其他', url: 'https://example.com' }];
  assert.deepEqual(filterBookmarks(nodeList, data, new Set(['a', 'b']), 'v2ex'), [nodeList[0]]);
  assert.deepEqual(filterBookmarks(nodeList, data, new Set(['a', 'b']), 'reply21'), [nodeList[0]]);
  assert.equal(filterBookmarks(nodeList, data, new Set(), '').length, 2);
  assert.equal(filterBookmarks(nodeList, data, new Set(['a', 'b']), '其他').length, 0);
});

test('删除标签清理引用，保留其他标签；移除全部标签清理记录', () => {
  const data = { tags: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], bookmarks: { one: ['a', 'b'], two: ['a'] } };
  applyCommand(data, { type: 'deleteTag', id: 'a' });
  assert.deepEqual(data, { tags: [{ id: 'b', name: 'B' }], bookmarks: { one: ['b'] } });
  applyCommand(data, { type: 'setBookmarkTags', bookmarkId: 'one', tagList: [] });
  assert.deepEqual(data.bookmarks, {});
});

test('标签校验、去重，并忽略已经被删除的标签', () => {
  const data = emptyData();
  applyCommand(data, { type: 'createTag', id: 'a', name: ' Work ' });
  assert.throws(() => applyCommand(data, { type: 'createTag', id: 'b', name: 'work' }), /同名/);
  assert.throws(() => applyCommand(data, { type: 'createTag', id: 'b', name: '  ' }), /1至30/);
  assert.throws(() => applyCommand(data, { type: 'createTag', id: 'b', name: 'a'.repeat(31) }), /1至30/);
  applyCommand(data, { type: 'setBookmarkTags', bookmarkId: 'one', tagList: ['a', 'a', 'deleted'] });
  assert.deepEqual(data.bookmarks.one, ['a']);
});

test('递归遍历文件夹，并清理删除文件夹内书签的标签', () => {
  const nodeList = [{ id: 'folder', title: '收藏', children: [{ id: 'nested', title: '子目录', children: [{ id: 'one', title: '网页', url: 'https://example.com' }] }] }];
  const flatList = flattenTree(nodeList);
  assert.equal(flatList.length, 3);
  assert.equal(flatList[2].path, '收藏 / 子目录 / 网页');
  const data = { tags: [], bookmarks: { one: ['a'], other: ['a'] } };
  removeBookmarks(data, new Set(flatList.map(node => node.id)));
  assert.deepEqual(data.bookmarks, { other: ['a'] });
});

test('标签改名保持ID、书签与待处理关联，原筛选仍然有效', () => {
  const data = { tags: [{ id: 'a', name: '旧标签' }], bookmarks: { one: ['a'] }, pendingList: [{ id: 'pending', tagList: ['a'] }] };
  const nodeList = [{ id: 'one', title: '书签', url: 'https://example.com' }];
  applyCommand(data, { type: 'renameTag', id: 'a', name: ' 新标签 ' });
  assert.deepEqual(data.tags, [{ id: 'a', name: '新标签' }]);
  assert.deepEqual(data.bookmarks, { one: ['a'] });
  assert.deepEqual(data.pendingList, [{ id: 'pending', tagList: ['a'] }]);
  assert.deepEqual(filterBookmarks(nodeList, data, new Set(['a']), ''), nodeList);
});

test('改名拒绝重名、空白、过长及已删除标签，失败不修改数据', () => {
  const data = { tags: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], bookmarks: {} };
  const before = structuredClone(data);
  for (const name of ['b', ' ', 'a'.repeat(31)]) assert.throws(() => applyCommand(data, { type: 'renameTag', id: 'a', name }));
  assert.throws(() => applyCommand(data, { type: 'renameTag', id: 'deleted', name: 'C' }), /已被删除/);
  assert.deepEqual(data, before);
  applyCommand(data, { type: 'renameTag', id: 'a', name: 'a' });
  assert.equal(data.tags[0].name, 'a');
});
