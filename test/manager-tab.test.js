import test from 'node:test';
import assert from 'node:assert/strict';
import { isManagerUrl, planManagerCleanup } from '../manager-tab-policy.js';

const base = 'chrome-extension://jjlpkcpgoenceomnlcfbmacdcenjfhmb/';

test('只识别自身书签管理页，查询参数和锚点仍属同一页面', () => {
  for (const suffix of ['manager.html', 'manager.html?settings=1', 'manager.html#test']) assert.equal(isManagerUrl(base + suffix, base), true);
  for (const url of ['https://example.com/manager.html', 'chrome-extension://other/manager.html', base + 'wallpaper/newtab.html', base + 'nested/manager.html', 'invalid']) assert.equal(isManagerUrl(url, base), false);
});

test('跨窗口只留一个管理页，固定页优先，其他页面不受影响', () => {
  const tabList = [
    { id: 1, windowId: 10, url: base + 'manager.html' },
    { id: 2, windowId: 20, url: base + 'manager.html?settings=1', pinned: true },
    { id: 3, windowId: 30, url: base + 'manager.html', pinned: true },
    { id: 4, windowId: 30, url: base + 'wallpaper/newtab.html' }
  ];
  assert.deepEqual(planManagerCleanup(tabList, base), { keepId: 2, removeIdList: [3, 1] });
});

test('导航离开管理页的标签不关闭，正在导航进入的页面参与去重', () => {
  const tabList = [
    { id: 1, url: base + 'manager.html', pendingUrl: 'https://example.com' },
    { id: 2, url: base + 'manager.html' },
    { id: 3, url: 'about:blank', pendingUrl: base + 'manager.html' }
  ];
  assert.deepEqual(planManagerCleanup(tabList, base), { keepId: 2, removeIdList: [3] });
});
