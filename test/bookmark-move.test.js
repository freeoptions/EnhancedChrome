import test from 'node:test';
import assert from 'node:assert/strict';
import { getBookmarkDragScrollDelta, getBookmarkMoveDestination } from '../bookmark-move.js';

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
const nodeMap = new Map(nodeList.map(node => [node.id, node]));
const move = (source, target, position) => getBookmarkMoveDestination(nodeMap, source, target, position);

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

test('后续加载的条目使用真实目录索引，跨渲染批次排序不偏移', () => {
  const laterNodeList = [...nodeList, { id: 'later-item', parentId: 'bar', index: 100, url: 'https://page.example' }];
  assert.deepEqual(getBookmarkMoveDestination(new Map(laterNodeList.map(node => [node.id, node])), 'a', 'later-item', 'after'), { parentId: 'bar', index: 101 });
});

test('左侧只显示文件夹时，同级排序仍使用包含书签的真实索引', () => {
  const folderNodeMap = new Map([...nodeMap,
    ['folder-first', { id: 'folder-first', parentId: 'bar', index: 5 }],
    ['hidden-bookmark', { id: 'hidden-bookmark', parentId: 'bar', index: 6, url: 'https://hidden.example' }],
    ['folder-last', { id: 'folder-last', parentId: 'bar', index: 7 }],
  ]);
  assert.deepEqual(getBookmarkMoveDestination(folderNodeMap, 'folder-first', 'folder-last', 'after'), { parentId: 'bar', index: 8 });
  assert.deepEqual(getBookmarkMoveDestination(folderNodeMap, 'folder-last', 'folder-first', 'before'), { parentId: 'bar', index: 5 });
});

test('左侧文件夹可跨目录移入，同级排序不把文件夹移入自身后代', () => {
  const folderNodeMap = new Map([...nodeMap,
    ['destination', { id: 'destination', parentId: 'other', index: 0 }],
    ['destination-child', { id: 'destination-child', parentId: 'destination', index: 0 }],
  ]);
  assert.deepEqual(getBookmarkMoveDestination(folderNodeMap, 'folder', 'destination', 'inside'), { parentId: 'destination' });
  assert.deepEqual(getBookmarkMoveDestination(folderNodeMap, 'nested', 'other', 'inside'), { parentId: 'other' });
  assert.equal(getBookmarkMoveDestination(folderNodeMap, 'destination', 'destination-child', 'inside'), null);
  assert.equal(getBookmarkMoveDestination(folderNodeMap, 'folder', 'nested', 'before'), null);
  assert.equal(getBookmarkMoveDestination(folderNodeMap, 'folder', 'bar', 'before'), null);
});

test('拖动接近上沿向上滚动，接近下沿向下滚动，中间不滚动', () => {
  assert.ok(getBookmarkDragScrollDelta(110, 100, 700, 16) < 0);
  assert.ok(getBookmarkDragScrollDelta(690, 100, 700, 16) > 0);
  assert.equal(getBookmarkDragScrollDelta(400, 100, 700, 16), 0);
  assert.equal(getBookmarkDragScrollDelta(164, 100, 700, 16), 0);
  assert.equal(getBookmarkDragScrollDelta(636, 100, 700, 16), 0);
});

test('越靠近边缘越快，指针保持不动时每帧仍产生滚动距离', () => {
  const nearEdge = getBookmarkDragScrollDelta(105, 100, 700, 16);
  const farther = getBookmarkDragScrollDelta(140, 100, 700, 16);
  assert.ok(Math.abs(nearEdge) > Math.abs(farther));
  assert.equal(getBookmarkDragScrollDelta(105, 100, 700, 16), nearEdge);
  assert.equal(getBookmarkDragScrollDelta(105, 100, 700, 32), nearEdge * 2);
});

test('拖到侧栏固定按钮或底部状态区仍可滚动，单帧位移有上限', () => {
  assert.equal(getBookmarkDragScrollDelta(50, 100, 700, 16), -14.4);
  assert.equal(getBookmarkDragScrollDelta(750, 100, 700, 16), 14.4);
  assert.equal(getBookmarkDragScrollDelta(50, 100, 700, 1000), -28.8);
  assert.equal(getBookmarkDragScrollDelta(50, 100, 700, -1), 0);
});

test('很矮的滚动区域上下边缘不重叠，空区域不滚动', () => {
  assert.ok(getBookmarkDragScrollDelta(101, 100, 130, 16) < 0);
  assert.ok(getBookmarkDragScrollDelta(129, 100, 130, 16) > 0);
  assert.equal(getBookmarkDragScrollDelta(115, 100, 130, 16), 0);
  assert.equal(getBookmarkDragScrollDelta(100, 100, 100, 16), 0);
});
