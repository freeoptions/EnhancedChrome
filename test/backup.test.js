import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackup, exportFilename, resolvePending, restoreBackup, validateBackup } from '../backup.js';
import { applyCommand, emptyData, flattenTree } from '../core.js';

const url = 'https://www.v2ex.com/t/1081225#reply21';
const sourceList = flattenTree([{ id: 'a-folder', title: '旧目录', children: [{ id: 'a-bookmark', parentId: 'a-folder', title: '旧名称', url }] }]);
const sourceData = { tags: [{ id: 'a-tag', name: 'a标签' }, { id: 'unused', name: '未使用标签' }], bookmarks: { 'a-bookmark': ['a-tag'] } };

test('导出包含完整网址、名称、目录、未使用标签，文件名按本地日期生成', () => {
  const now = new Date(2026, 10, 9, 23, 59);
  assert.equal(exportFilename(now), 'ChromeCollect-2026-11-09-export.json');
  assert.equal(exportFilename(new Date(2027, 0, 2)), 'ChromeCollect-2027-01-02-export.json');
  const backup = createBackup(sourceData, sourceList, now);
  assert.equal(backup.exportedAt, now.toISOString());
  assert.deepEqual(backup.bookmarks, [{ url, title: '旧名称', folderPath: '旧目录', tags: ['a标签'] }]);
  assert.deepEqual(backup.tags, ['a标签', '未使用标签']);
  assert.equal(validateBackup(JSON.parse(JSON.stringify(backup))).version, 1);
});

test('新电脑书签ID不同、改名、移动目录，网址唯一时仍恢复标签', () => {
  const targetList = flattenTree([{ id: 'b-folder', title: '新目录', children: [{ id: 'b-bookmark', parentId: 'b-folder', title: '新名称', url }] }]);
  const backup = JSON.parse(JSON.stringify(createBackup(sourceData, sourceList)));
  const result = restoreBackup(emptyData(), backup, targetList);
  assert.equal(result.matchedCount, 1);
  assert.equal(result.pendingCount, 0);
  const id = result.data.tags.find(tag => tag.name === 'a标签').id;
  assert.deepEqual(result.data.bookmarks['b-bookmark'], [id]);
  assert.equal(result.data.bookmarks['a-bookmark'], undefined);
});

test('合并现有标签和书签关联，重复导入不重复添加，不修改输入', () => {
  const target = { tags: [{ id: 'existing', name: 'a标签' }, { id: 'other', name: '其他' }], bookmarks: { 'a-bookmark': ['other'] } };
  const original = structuredClone(target);
  const backup = createBackup(sourceData, sourceList);
  const first = restoreBackup(target, backup, sourceList);
  const second = restoreBackup(first.data, backup, sourceList);
  assert.deepEqual(target, original);
  assert.deepEqual(second.data, first.data);
  assert.deepEqual(second.data.bookmarks['a-bookmark'], ['other', 'existing']);
});

test('完整网址严格匹配，参数和锚点不同均保留待处理，重复导入不堆积', () => {
  const nodeList = [{ id: 'wrong', title: '旧名称', url: url.replace('reply21', 'reply22') }, { id: 'params', title: '旧名称', url: `${url}?a=1` }];
  const backup = createBackup(sourceData, sourceList);
  const first = restoreBackup(emptyData(), backup, nodeList);
  const second = restoreBackup(first.data, backup, nodeList);
  assert.equal(second.matchedCount, 0);
  assert.equal(second.pendingCount, 1);
  assert.deepEqual(second.data.bookmarks, {});
  const reExport = createBackup(second.data, nodeList);
  assert.deepEqual(reExport.bookmarks, backup.bookmarks);
});

test('重复网址使用名称和目录区分，无法唯一确定时不乱关联', () => {
  const nodeList = [...sourceList, { id: 'duplicate', title: '不同名称', url }];
  const backup = createBackup(sourceData, sourceList);
  assert.equal(restoreBackup(emptyData(), backup, nodeList).matchedCount, 1);
  const result = restoreBackup(emptyData(), backup, [{ id: 'one', title: '新名称', url }, { id: 'two', title: '新名称', url }]);
  assert.equal(result.pendingCount, 1);
  assert.deepEqual(result.data.bookmarks, {});
  resolvePending(result.data, result.data.pendingList[0].id, { id: 'two', url });
  assert.equal(result.data.pendingList.length, 0);
  assert.equal(result.data.bookmarks.two.length, 1);
  assert.equal(result.data.bookmarks.one, undefined);
});

test('待处理持久化后可重试；删除全局标签同时清理待处理引用', () => {
  const backup = createBackup(sourceData, sourceList);
  const first = restoreBackup(emptyData(), backup, []);
  const second = restoreBackup(JSON.parse(JSON.stringify(first.data)), { format: 'ChromeCollect', version: 1, tags: [], bookmarks: [] }, sourceList);
  assert.equal(second.matchedCount, 1);
  assert.equal(second.pendingCount, 0);
  applyCommand(first.data, { type: 'deleteTag', id: first.data.tags.find(tag => tag.name === 'a标签').id });
  assert.deepEqual(first.data.pendingList, []);
});

test('无效备份拒绝写入，人工关联也必须完整网址一致', () => {
  for (const invalid of [null, {}, { format: 'ChromeCollect', version: 2, tags: [], bookmarks: [] },
    { format: 'ChromeCollect', version: 1, tags: ['a', 'A'], bookmarks: [] },
    { format: 'ChromeCollect', version: 1, tags: ['a'], bookmarks: [{ url, title: '标题', folderPath: '', tags: ['missing'] }] }]) {
    assert.throws(() => validateBackup(invalid));
  }
  const initial = structuredClone(sourceData);
  assert.throws(() => restoreBackup(sourceData, {}, sourceList));
  assert.deepEqual(sourceData, initial);
  const result = restoreBackup(emptyData(), createBackup(sourceData, sourceList), []);
  assert.throws(() => resolvePending(result.data, result.data.pendingList[0].id, { id: 'bad', url: 'https://example.com' }), /完整网址/);
  assert.equal(result.data.pendingList.length, 1);
});

test('一万条跨电脑书签可完整导入并再次导出', () => {
  const sourceNodeList = Array.from({ length: 10000 }, (_, index) => ({ id: `a-${index}`, title: String(index), url: `https://example.com/${index}` }));
  const data = { tags: [{ id: 'a', name: '标签' }], bookmarks: Object.fromEntries(sourceNodeList.map(node => [node.id, ['a']])) };
  const backup = createBackup(data, sourceNodeList);
  const targetNodeList = sourceNodeList.map((node, index) => ({ ...node, id: `b-${index}`, title: `重命名${index}` }));
  const result = restoreBackup(emptyData(), backup, targetNodeList);
  assert.equal(result.matchedCount, 10000);
  assert.equal(result.pendingCount, 0);
  assert.equal(createBackup(result.data, targetNodeList).bookmarks.length, 10000);
});

test('标签改名后备份使用新名称，另一电脑仍可恢复关联', () => {
  const data = structuredClone(sourceData);
  applyCommand(data, { type: 'renameTag', id: 'a-tag', name: '改名后的标签' });
  const backup = createBackup(data, sourceList);
  assert.deepEqual(backup.bookmarks[0].tags, ['改名后的标签']);
  const result = restoreBackup(emptyData(), backup, sourceList);
  const tag = result.data.tags.find(item => item.name === '改名后的标签');
  assert.deepEqual(result.data.bookmarks['a-bookmark'], [tag.id]);
});
