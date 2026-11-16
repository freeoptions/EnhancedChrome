import test from 'node:test';
import assert from 'node:assert/strict';
import { canDragBookmarkNode, getBookmarkBatchMovePlan } from '../bookmark-move.js';

const nodeMap = new Map([
  ['root', { id: 'root' }],
  ['bar', { id: 'bar', parentId: 'root' }],
  ['a', { id: 'a', parentId: 'bar', index: 0 }],
  ['b', { id: 'b', parentId: 'bar', index: 1 }],
  ['one', { id: 'one', parentId: 'bar', index: 2, url: 'https://one.example' }],
  ['two', { id: 'two', parentId: 'a', index: 0, url: 'https://two.example' }],
  ['three', { id: 'three', parentId: 'bar', index: 3, url: 'https://three.example' }],
  ['managed', { id: 'managed', parentId: 'bar', index: 4, unmodifiable: 'managed', url: 'https://managed.example' }],
]);

test('批量选中3条后，每条已选书签都能作为整组拖动入口', () => {
  const selectedIdSet = new Set(['one', 'two', 'three']);
  for (const id of selectedIdSet) assert.equal(canDragBookmarkNode(nodeMap, id, true, selectedIdSet), true);
  assert.equal(canDragBookmarkNode(nodeMap, 'a', true, selectedIdSet), false);
  assert.equal(canDragBookmarkNode(nodeMap, 'three', true, new Set(['one', 'two'])), false);
  assert.equal(canDragBookmarkNode(nodeMap, 'managed', true, new Set(['managed'])), false);
  assert.equal(canDragBookmarkNode(nodeMap, 'bar', false, new Set()), false);
  assert.equal(canDragBookmarkNode(nodeMap, 'missing', false, new Set()), false);
});

test('批量移入文件夹包含跨目录选择，按浏览器原顺序追加', () => {
  assert.deepEqual(getBookmarkBatchMovePlan(nodeMap, ['three', 'two', 'one'], 'b'), [
    { id: 'one', parentId: 'b' },
    { id: 'two', parentId: 'b' },
    { id: 'three', parentId: 'b' },
  ]);
});

test('目标目录已有的已选书签保持位置，只移动其余书签', () => {
  assert.deepEqual(getBookmarkBatchMovePlan(nodeMap, ['one', 'two', 'three'], 'a'), [
    { id: 'one', parentId: 'a' },
    { id: 'three', parentId: 'a' },
  ]);
  assert.deepEqual(getBookmarkBatchMovePlan(nodeMap, ['two'], 'a'), []);
});

test('无效来源、受管理书签、书签目标及根节点在执行前拒绝', () => {
  assert.equal(getBookmarkBatchMovePlan(nodeMap, ['one', 'missing'], 'b'), null);
  assert.equal(getBookmarkBatchMovePlan(nodeMap, ['one', 'managed'], 'b'), null);
  assert.equal(getBookmarkBatchMovePlan(nodeMap, ['one', 'a'], 'b'), null);
  assert.equal(getBookmarkBatchMovePlan(nodeMap, ['one', 'two'], 'three'), null);
  assert.equal(getBookmarkBatchMovePlan(nodeMap, ['one'], 'root'), null);
  assert.equal(getBookmarkBatchMovePlan(nodeMap, [], 'b'), null);
});

test('批量移动规划不会改写书签ID、标签选择或原目录数据', () => {
  const before = structuredClone([...nodeMap]);
  const sourceIdList = ['one', 'two', 'one'];
  assert.equal(getBookmarkBatchMovePlan(nodeMap, sourceIdList, 'b').length, 2);
  assert.deepEqual([...nodeMap], before);
  assert.deepEqual(sourceIdList, ['one', 'two', 'one']);
});

test('受管理目录内的书签不可拖出，受管理目录也不能接收整组选中项', () => {
  const managedNodeMap = new Map([...nodeMap,
    ['managed-folder', { id: 'managed-folder', parentId: 'bar', index: 5, unmodifiable: 'managed' }],
    ['managed-child', { id: 'managed-child', parentId: 'managed-folder', index: 0, url: 'https://managed-child.example' }],
  ]);
  assert.equal(canDragBookmarkNode(managedNodeMap, 'managed-child', true, new Set(['managed-child'])), false);
  assert.equal(getBookmarkBatchMovePlan(managedNodeMap, ['one', 'two'], 'managed-folder'), null);
});
