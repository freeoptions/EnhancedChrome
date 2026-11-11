import test from 'node:test';
import assert from 'node:assert/strict';
import { addBookmarkTags, getSelectedBookmarkList } from '../core.js';

const nodeList = [{ id: 'folder', children: [
  { id: 'one', url: 'https://example.com/1' },
  { id: 'two', url: 'https://example.com/2' },
  { id: 'sub', children: [{ id: 'three', url: 'https://example.com/3' }] }
] }, { id: 'outside', url: 'https://example.com/outside' }];
function initialData() {
  return { tags: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], bookmarks: { one: ['a'], outside: ['a'] } };
}

test('勾选个别书签只给所选书签追加标签，保留已有标签', () => {
  const data = initialData();
  const bookmarkList = getSelectedBookmarkList(nodeList, new Set(['one', 'three']));
  assert.deepEqual(addBookmarkTags(data, bookmarkList, ['b']), { totalCount: 2, changedCount: 2 });
  assert.deepEqual(data.bookmarks, { one: ['a', 'b'], three: ['b'], outside: ['a'] });
});

test('文件夹及其子目录、书签同时勾选时去重，外部书签不受影响', () => {
  const data = initialData();
  const bookmarkList = getSelectedBookmarkList(nodeList, new Set(['folder', 'sub', 'three']));
  assert.deepEqual(bookmarkList.map(node => node.id), ['one', 'two', 'three']);
  assert.deepEqual(addBookmarkTags(data, bookmarkList, ['a', 'b', 'b']), { totalCount: 3, changedCount: 3 });
  assert.deepEqual(addBookmarkTags(data, bookmarkList, ['a', 'b']), { totalCount: 3, changedCount: 0 });
  assert.deepEqual(data.bookmarks.outside, ['a']);
  assert.equal(data.bookmarks.folder, undefined);
});

test('选中文件夹后取消某条书签，只操作剩余选择；跨目录选择保留', () => {
  const selectedIdSet = new Set(getSelectedBookmarkList(nodeList, new Set(['folder'])).map(node => node.id));
  selectedIdSet.delete('two');
  selectedIdSet.add('outside');
  const bookmarkList = getSelectedBookmarkList(nodeList, selectedIdSet);
  assert.deepEqual(bookmarkList.map(node => node.id), ['one', 'three', 'outside']);
  const data = initialData();
  addBookmarkTags(data, bookmarkList, ['b']);
  assert.equal(data.bookmarks.two, undefined);
  assert.deepEqual(data.bookmarks.outside, ['a', 'b']);
});

test('无选择、无标签或失效标签不写数据，空目录不产生目标', () => {
  const data = initialData();
  const before = structuredClone(data);
  assert.throws(() => addBookmarkTags(data, [], ['a']), /勾选/);
  assert.throws(() => addBookmarkTags(data, [nodeList[1]], []), /至少/);
  assert.throws(() => addBookmarkTags(data, [nodeList[1]], ['b', 'deleted']), /已被删除/);
  assert.deepEqual(getSelectedBookmarkList([{ id: 'empty' }], new Set(['empty'])), []);
  assert.deepEqual(data, before);
});

test('勾选一万条书签的文件夹不受分页限制', () => {
  const childrenList = Array.from({ length: 10000 }, (_, index) => ({ id: String(index), url: `https://example.com/${index}` }));
  const bookmarkList = getSelectedBookmarkList([{ id: 'large', children: childrenList }], new Set(['large']));
  const data = initialData();
  assert.deepEqual(addBookmarkTags(data, bookmarkList, ['b']), { totalCount: 10000, changedCount: 10000 });
  assert.deepEqual(data.bookmarks['9999'], ['b']);
});
