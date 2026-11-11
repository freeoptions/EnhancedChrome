import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSyncQuota, createTagSnapshot, decodeTagSnapshot, encodeTagSnapshot, restoreTagSnapshot, SYNC_META_KEY } from '../tag-sync-data.js';

const sourceList = [{ id: 'a-folder', title: '旧目录', path: '旧目录' }, { id: 'a-id', parentId: 'a-folder', title: '旧名称', url: 'https://www.v2ex.com/t/1081225#reply21' }];
const targetList = [{ id: 'b-folder', title: '新目录', path: '新目录' }, { id: 'b-id', parentId: 'b-folder', title: '新名称', url: sourceList[1].url }];
const data = { tags: [{ id: 'tag-a', name: '中文标签' }], bookmarks: { 'a-id': ['tag-a'] } };

test('真实压缩编码往返，跨设备书签ID、名称和目录变化按网址恢复', async () => {
  const itemMap = await encodeTagSnapshot(createTagSnapshot(data, sourceList));
  const decoded = await decodeTagSnapshot(itemMap);
  const result = restoreTagSnapshot(decoded.snapshot, targetList);
  assert.deepEqual(result.data.tags, data.tags);
  assert.deepEqual(result.data.bookmarks, { 'b-id': ['tag-a'] });
  assert.equal(result.pendingCount, 0);
  checkSyncQuota({}, itemMap);
});

test('全量快照保留标签ID，改名和删除不会与旧标签合并', () => {
  const changed = { tags: [{ id: 'tag-a', name: '已改名' }], bookmarks: { 'a-id': ['tag-a'] } };
  const result = restoreTagSnapshot(createTagSnapshot(changed, sourceList), targetList);
  assert.deepEqual(result.data.tags, changed.tags);
  const deleted = restoreTagSnapshot(createTagSnapshot({ tags: [], bookmarks: {} }, sourceList), targetList);
  assert.deepEqual(deleted.data, { tags: [], bookmarks: {}, pendingList: [] });
});

test('书签未到达时保留关联，随后书签到达可恢复', () => {
  const snapshot = createTagSnapshot(data, sourceList);
  const pending = restoreTagSnapshot(snapshot, []);
  assert.equal(pending.pendingCount, 1);
  const restored = restoreTagSnapshot(createTagSnapshot(pending.data, []), targetList);
  assert.equal(restored.pendingCount, 0);
  assert.deepEqual(restored.data.bookmarks, { 'b-id': ['tag-a'] });
});

test('同网址多个候选不随意分配标签', () => {
  const result = restoreTagSnapshot(createTagSnapshot(data, sourceList), [...targetList, { ...targetList[1], id: 'another-id' }]);
  assert.deepEqual(result.data.bookmarks, {});
  assert.equal(result.pendingCount, 1);
});

test('Chrome分批送达时缺块、旧块和损坏块不应用', async () => {
  const itemMap = await encodeTagSnapshot(createTagSnapshot(data, sourceList));
  const missingMap = { [SYNC_META_KEY]: itemMap[SYNC_META_KEY] };
  assert.equal(await decodeTagSnapshot(missingMap), null);
  assert.equal(await decodeTagSnapshot({ ...itemMap, tagSyncChunk0: 'old-chunk' }), null);
});

test('非法同步格式和悬空标签关联明确拒绝', async () => {
  await assert.rejects(decodeTagSnapshot({ [SYNC_META_KEY]: { version: 2 } }), /同步版本/);
  assert.throws(() => restoreTagSnapshot({ tags: [{ id: 'a', name: 'A' }], bookmarks: [{ url: 'https://test', tags: ['missing'] }] }, []), /关联无效/);
});

test('容量检查包含已有扩展数据，不超过单项和总额度', () => {
  assert.throws(() => checkSyncQuota({}, { tooLarge: 'a'.repeat(8192) }), /单项/);
  const existingMap = Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`key${i}`, 'a'.repeat(7000)]));
  assert.throws(() => checkSyncQuota(existingMap, { last: 'b'.repeat(7000) }), /同步容量/);
  assert.ok(checkSyncQuota({ old: 'a' }, { old: 'b' }) < 20);
});

test('大批量标签分块均低于Chrome单项上限并完整恢复', async () => {
  const nodeList = Array.from({ length: 2000 }, (_, i) => ({ id: String(i), title: `书签${i}`, url: `https://example.com/${i}/${i * 7231}` }));
  const bulkData = { tags: data.tags, bookmarks: Object.fromEntries(nodeList.map(node => [node.id, ['tag-a']])) };
  const snapshot = createTagSnapshot(bulkData, nodeList);
  const itemMap = await encodeTagSnapshot(snapshot);
  assert.ok(itemMap[SYNC_META_KEY].count > 1);
  checkSyncQuota({}, itemMap);
  assert.deepEqual((await decodeTagSnapshot(itemMap)).snapshot, snapshot);
});
