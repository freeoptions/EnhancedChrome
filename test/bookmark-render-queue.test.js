import test from 'node:test';
import assert from 'node:assert/strict';
import { BookmarkRenderQueue } from '../bookmark-render-queue.js';

test('一万条书签首屏只创建可见区域及预加载区，完整数据保留用于全选', () => {
  const nodeList = Array.from({ length: 10000 }, (_, index) => ({ id: String(index) }));
  const queue = new BookmarkRenderQueue(nodeList);
  const renderedList = [];
  for (;;) {
    const chunkList = queue.next(900, 60);
    if (!chunkList.length) break;
    assert.ok(chunkList.length <= 40);
    renderedList.push(...chunkList);
  }
  assert.equal(renderedList.length, 80);
  assert.deepEqual(renderedList, nodeList.slice(0, 80));
  assert.equal(queue.nodeList, nodeList);
  assert.equal(queue.nodeList.length, 10000);
});

test('滚动继续追加，已有条目不重复创建，回滚不重新创建', () => {
  const nodeList = Array.from({ length: 1400 }, (_, index) => ({ id: String(index) }));
  const queue = new BookmarkRenderQueue(nodeList);
  const renderedList = [];
  for (let viewportEnd = 900; viewportEnd <= 90000; viewportEnd += 900) {
    for (;;) {
      const chunkList = queue.next(viewportEnd, 60);
      if (!chunkList.length) break;
      renderedList.push(...chunkList);
    }
  }
  assert.deepEqual(renderedList, nodeList);
  assert.deepEqual(queue.next(900, 60), []);
});

test('跳到列表底部时每批最多40条，按顺序补齐且没有遗漏', () => {
  const nodeList = Array.from({ length: 1437 }, (_, index) => index);
  const queue = new BookmarkRenderQueue(nodeList);
  const renderedList = [];
  for (;;) {
    const chunkList = queue.next(100000, 60);
    if (!chunkList.length) break;
    assert.ok(chunkList.length <= 40);
    renderedList.push(...chunkList);
  }
  assert.deepEqual(renderedList, nodeList);
});

test('空结果、小列表和切换筛选后建立新队列不保留旧数据', () => {
  assert.deepEqual(new BookmarkRenderQueue([]).next(900, 60), []);
  assert.deepEqual(new BookmarkRenderQueue(['one']).next(-100, 60), ['one']);
  const queue = new BookmarkRenderQueue(['filtered']);
  assert.deepEqual(queue.next(900, 60), ['filtered']);
  assert.deepEqual(queue.next(900, 60), []);
});

test('深处滚动后移动3条，刷新保留已渲染范围，不从第一批重新排队', () => {
  const nodeList = Array.from({ length: 1400 }, (_, index) => ({ id: String(index) }));
  const queue = new BookmarkRenderQueue(nodeList);
  while (queue.next(60000, 60).length) { /* 填充移动前的滚动范围。 */ }
  const renderedCount = queue.renderedCount;
  const movedIdSet = new Set(['980', '981', '982']);
  const nextNodeList = nodeList.filter(node => !movedIdSet.has(node.id));
  const retainedList = queue.update(nextNodeList);
  assert.equal(retainedList.length, renderedCount);
  assert.deepEqual(retainedList, nextNodeList.slice(0, renderedCount));
  assert.deepEqual(queue.next(60000, 60), []);
  assert.equal(retainedList[1000].id, '1003');
});

test('移动后总数缩短到已渲染范围内，立即保留全部剩余行', () => {
  const nodeList = Array.from({ length: 1339 }, (_, index) => ({ id: String(index) }));
  const queue = new BookmarkRenderQueue(nodeList);
  while (queue.next(100000, 60).length) { /* 填充移动前的列表。 */ }
  const nextNodeList = nodeList.slice(0, -3);
  assert.deepEqual(queue.update(nextNodeList), nextNodeList);
  assert.equal(queue.renderedCount, 1336);
  assert.deepEqual(queue.next(100000, 60), []);
  assert.deepEqual(queue.update([]), []);
  assert.equal(queue.renderedCount, 0);
});
