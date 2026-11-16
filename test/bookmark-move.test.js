import test from 'node:test';
import assert from 'node:assert/strict';
import { getBookmarkMoveDestination } from '../bookmark-move.js';

const nodeList = [
  { id: '0' },
  { id: 'bar', parentId: '0', folderType: 'bookmarks-bar' },
  { id: 'other', parentId: '0' },
  { id: 'a', parentId: 'bar', index: 0, url: 'https://a.example' },
  { id: 'b', parentId: 'bar', index: 1, url: 'https://b.example' },
  { id: 'folder', parentId: 'bar', index: 2 },
  { id: 'nested', parentId: 'folder', index: 0 },
  { id: 'last', parentId: 'bar', index: 3, url: 'https://last.example' },
  { id: 'managed', parentId: 'bar', index: 4, unmodifiable: 'managed' },
  { id: 'managed-child', parentId: 'managed', index: 0, url: 'https://managed.example' },
];
const move = (source, target, position) => getBookmarkMoveDestination(nodeList, source, target, position);

test('同目录排序使用Chrome移动前索引，覆盖向前、向后及文件夹排序', () => {
  assert.deepEqual(move('last', 'a', 'before'), { parentId: 'bar', index: 0 });
  assert.deepEqual(move('a', 'b', 'after'), { parentId: 'bar', index: 2 });
  assert.deepEqual(move('a', 'last', 'after'), { parentId: 'bar', index: 4 });
  assert.deepEqual(move('folder', 'a', 'before'), { parentId: 'bar', index: 0 });
});

test('相邻原位置不重复移动，混合目录结果不允许排序', () => {
  assert.equal(move('a', 'b', 'before'), null);
  assert.equal(move('b', 'a', 'after'), null);
  assert.equal(move('a', 'nested', 'before'), null);
  assert.equal(move('a', 'a', 'before'), null);
});

test('跨目录移入追加末尾，可移入空目录与系统书签目录', () => {
  assert.deepEqual(move('a', 'nested', 'inside'), { parentId: 'nested' });
  assert.deepEqual(move('folder', 'other', 'inside'), { parentId: 'other' });
  assert.deepEqual(move('nested', 'bar', 'inside'), { parentId: 'bar' });
  assert.equal(move('a', 'bar', 'inside'), null);
});

test('禁止文件夹移入自身、后代、书签以及根节点，保护系统目录', () => {
  for (const [source, target] of [['folder', 'folder'], ['folder', 'nested'], ['a', 'b'], ['a', '0'], ['bar', 'other'], ['other', 'folder']]) {
    assert.equal(move(source, target, 'inside'), null);
  }
});

test('受管理节点及其后代不能移动，受管理目录不接收拖放', () => {
  assert.equal(move('managed', 'other', 'inside'), null);
  assert.equal(move('managed-child', 'other', 'inside'), null);
  assert.equal(move('a', 'managed', 'inside'), null);
});

test('来源或目标被删除、非法位置时取消移动', () => {
  assert.equal(move('missing', 'folder', 'inside'), null);
  assert.equal(move('a', 'missing', 'inside'), null);
  assert.equal(move('a', 'folder', null), null);
});

test('分页条目使用真实目录索引，而非页内索引', () => {
  const pageNodeList = [...nodeList, { id: 'page-two', parentId: 'bar', index: 100, url: 'https://page.example' }];
  assert.deepEqual(getBookmarkMoveDestination(pageNodeList, 'a', 'page-two', 'after'), { parentId: 'bar', index: 101 });
});
