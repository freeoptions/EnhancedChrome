import test from 'node:test';
import assert from 'node:assert/strict';
import { getBookmarkClickSelection, getRemainingSingleBookmarkId } from '../bookmark-selection.js';

const nodeList = [
  { id: 'a', url: 'https://a.example' },
  { id: 'folder' },
  { id: 'b', url: 'https://b.example' },
  { id: 'c', url: 'https://c.example' },
  { id: 'd', url: 'https://d.example' },
];

test('Ctrl点击保留初始单选，追加不相邻书签，再次点击取消该条', () => {
  const initialSet = new Set(['a']);
  const result = getBookmarkClickSelection(nodeList, initialSet, 'a', 'c', { toggle: true });
  assert.deepEqual([...result.selectedIdSet], ['a', 'c']);
  assert.equal(result.anchorId, 'c');
  assert.deepEqual([...initialSet], ['a']);
  assert.deepEqual([...getBookmarkClickSelection(nodeList, result.selectedIdSet, 'c', 'a', { toggle: true }).selectedIdSet], ['c']);
});

test('Shift正向及反向选择闭区间，忽略文件夹并替换原选择', () => {
  const forward = getBookmarkClickSelection(nodeList, new Set(['d']), 'a', 'c', { range: true });
  assert.deepEqual([...forward.selectedIdSet], ['a', 'b', 'c']);
  assert.equal(forward.anchorId, 'a');
  const backward = getBookmarkClickSelection(nodeList, new Set(['a']), 'd', 'b', { range: true });
  assert.deepEqual([...backward.selectedIdSet], ['b', 'c', 'd']);
  assert.equal(backward.anchorId, 'd');
});

test('连续Shift点击保留最初锚点，区间可扩大也可缩小', () => {
  const first = getBookmarkClickSelection(nodeList, new Set(['a']), 'a', 'd', { range: true });
  const second = getBookmarkClickSelection(nodeList, first.selectedIdSet, first.anchorId, 'b', { range: true });
  assert.deepEqual([...second.selectedIdSet], ['a', 'b']);
});

test('Ctrl+Shift追加区间并保留区间外及其他文件夹已选书签', () => {
  const result = getBookmarkClickSelection(nodeList, new Set(['outside', 'd']), 'a', 'b', { toggle: true, range: true });
  assert.deepEqual([...result.selectedIdSet], ['outside', 'd', 'a', 'b']);
});

test('没有锚点或筛选后锚点消失时只选目标，不跨视图构造区间', () => {
  for (const anchorId of [null, 'missing', 'folder']) {
    const result = getBookmarkClickSelection(nodeList, new Set(['a']), anchorId, 'c', { range: true });
    assert.deepEqual([...result.selectedIdSet], ['c']);
    assert.equal(result.anchorId, 'c');
  }
});

test('区间覆盖尚未创建元素的书签，按完整筛选结果顺序选择', () => {
  const largeNodeList = Array.from({ length: 10000 }, (_, index) => ({ id: String(index), url: 'https://example.com/' + index }));
  const result = getBookmarkClickSelection(largeNodeList, new Set(['20']), '20', '9000', { range: true });
  assert.equal(result.selectedIdSet.size, 8981);
  assert.equal(result.selectedIdSet.has('21'), true);
  assert.equal(result.selectedIdSet.has('9000'), true);
  assert.equal(result.selectedIdSet.has('9001'), false);
});

test('目标已删除或为文件夹时保留原选择', () => {
  for (const targetId of ['missing', 'folder']) {
    const result = getBookmarkClickSelection(nodeList, new Set(['a']), 'a', targetId, { range: true });
    assert.deepEqual([...result.selectedIdSet], ['a']);
    assert.equal(result.anchorId, 'a');
  }
});

test('Ctrl取消到最后一条时返回剩余书签，不能把取消的目标作为单选', () => {
  const result = getBookmarkClickSelection(nodeList, new Set(['a', 'c']), 'c', 'a', { toggle: true });
  assert.equal(getRemainingSingleBookmarkId(result.selectedIdSet, 2), 'c');
});

test('复选框取消、区间缩小或删除后仅剩一条时退出批量', () => {
  assert.equal(getRemainingSingleBookmarkId(new Set(['b']), 3), 'b');
  const result = getBookmarkClickSelection(nodeList, new Set(['a', 'b', 'c']), 'a', 'a', { range: true });
  assert.equal(getRemainingSingleBookmarkId(result.selectedIdSet, 3), 'a');
});

test('刚进入批量后的首次选择和仍有多条时保持批量模式', () => {
  assert.equal(getRemainingSingleBookmarkId(new Set(['a']), 0), null);
  assert.equal(getRemainingSingleBookmarkId(new Set(['a']), 1), null);
  assert.equal(getRemainingSingleBookmarkId(new Set(['a', 'b']), 3), null);
  assert.equal(getRemainingSingleBookmarkId(new Set(), 2), null);
});
