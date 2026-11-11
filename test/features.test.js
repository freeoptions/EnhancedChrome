import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_SETTINGS, normalizeSettings, validateSettingsPatch } from '../feature-settings.js';
import { messageModule } from '../message-routing.js';
import { isOwnNewTabUrl, planNewTabCleanup } from '../newtab-policy.js';
import { groupDuplicateTabs, planDuplicateClosure } from '../dedupe/policy.js';
import { DEFAULT_RULES, getIdentityKeys, inferRuleFromUrls, normalizeRule } from '../dedupe/url-utils.js';

const base = 'chrome-extension://jjlpkcpgoenceomnlcfbmacdcenjfhmb/';
const getUrl = tab => tab.pendingUrl || tab.url;

test('去重开关可独立关闭，旧显示内容配置不再参与设置', () => {
  assert.deepEqual(normalizeSettings(), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeSettings({ dedupeEnabled: false, singleNewTabEnabled: false, newTabPage: 'bookmarks' }), { dedupeEnabled: false, singleNewTabEnabled: false, fontSize: 14 });
  assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeSettings({ newTabPage: 'bookmarks' }), DEFAULT_SETTINGS);
});

test('设置写入接受去重开关和字号，不再接受显示内容字段', () => {
  for (const patch of [{ arbitrary: true }, { dedupeEnabled: 'false' }, { newTabPage: 'native' }, null, []]) {
    assert.throws(() => validateSettingsPatch(patch));
  }
  assert.deepEqual(validateSettingsPatch({ singleNewTabEnabled: false }), { singleNewTabEnabled: false });
});

test('字号支持12至20的整数，旧配置默认14，非法值不写入', () => {
  assert.equal(normalizeSettings({}).fontSize, 14);
  for (const fontSize of [12, 14, 20]) {
    assert.equal(normalizeSettings({ fontSize }).fontSize, fontSize);
    assert.deepEqual(validateSettingsPatch({ fontSize }), { fontSize });
  }
  for (const fontSize of [11, 21, 14.5, '14', null, NaN]) {
    assert.equal(normalizeSettings({ fontSize }).fontSize, 14);
    assert.throws(() => validateSettingsPatch({ fontSize }));
  }
});

test('书签、去重消息互不抢响应，未知消息不处理', () => {
  for (const type of ['createTag', 'renameTag', 'addBookmarkTags', 'exportBackup', 'updateSettings']) assert.equal(messageModule(type), 'bookmarks');
  for (const type of ['PAGE_PROTECTION_STATE', 'RESCAN_CURRENT_WINDOW']) assert.equal(messageModule(type), 'dedupe');
  assert.equal(messageModule('GET_TAB_STATE'), null);
  assert.equal(messageModule('TOGGLE_MANUAL_PROTECTION'), null);
  assert.equal(messageModule('unknown'), null);
  assert.equal(messageModule(undefined), null);
});

test('新标签页只识别自身完整地址，不误匹配其他扩展或网页同名路径', () => {
  assert.equal(isOwnNewTabUrl('chrome://newtab/', base), true);
  assert.equal(isOwnNewTabUrl(`${base}wallpaper/newtab.html`, base), true);
  for (const url of ['chrome-extension://other/wallpaper/newtab.html', 'https://example.com/newtab/newtab.html', `${base}manager.html`, `${base}manager.html?home=1`, `${base}home.html`, `${base}wallpaper/newtab.html?configure=1`, 'not a URL']) {
    assert.equal(isOwnNewTabUrl(url, base), false, url);
  }
});

test('Manifest直接加载壁纸，无中转页参数且无手动保护快捷键', () => {
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.chrome_url_overrides.newtab, 'wallpaper/newtab.html');
  assert.equal(manifest.commands['toggle-manual-protection'], undefined);
});

test('单首页保留已有页面，导航离开首页的pendingUrl不关闭', () => {
  const plan = planNewTabCleanup([
    { id: 1, url: `${base}wallpaper/newtab.html`, pinned: false },
    { id: 2, url: 'chrome://newtab/', pinned: false },
    { id: 3, url: `${base}wallpaper/newtab.html`, pendingUrl: 'https://example.com', pinned: false },
    { id: 4, url: 'chrome-extension://other/newtab/newtab.html', pinned: false }
  ], base);
  assert.deepEqual(plan, { keepId: 1, removeIdList: [2] });
});

test('单首页不会关闭固定标签页，允许保留多个固定首页', () => {
  const plan = planNewTabCleanup([
    { id: 1, url: 'chrome://newtab/', pinned: false },
    { id: 2, url: `${base}wallpaper/newtab.html`, pinned: true },
    { id: 3, url: `${base}wallpaper/newtab.html`, pinned: true }
  ], base);
  assert.deepEqual(plan, { keepId: 2, removeIdList: [1] });
});

test('网页去重保留原规则字段和完整网址、hash区分', () => {
  const rule = normalizeRule(DEFAULT_RULES[0]);
  assert.deepEqual(rule.ignoreQueryParams, ['cf_*']);
  const url = 'https://a.feishu.cn/wiki/test?cf_source=a#part1';
  const other = 'https://a.feishu.cn/wiki/test?cf_source=b#part1';
  assert.ok(getIdentityKeys(url, [rule]).some(key => getIdentityKeys(other, [rule]).includes(key)));
  assert.equal(getIdentityKeys(url, [rule]).some(key => getIdentityKeys(other.replace('part1', 'part2'), [rule]).includes(key)), false);
});

test('网页分组只合并规则匹配项，file地址参数和锚点仍参与区分', () => {
  const tabList = [
    { id: 1, url: 'https://example.com/a' }, { id: 2, url: 'https://example.com/a' },
    { id: 3, url: 'file:///D:/test.html#one' }, { id: 4, url: 'file:///D:/test.html#two' }
  ];
  assert.deepEqual(groupDuplicateTabs(tabList, [], getUrl).map(groupList => groupList.map(tab => tab.id)), [[1, 2], [3], [4]]);
});

test('网页关闭计划保留固定和未保存内容保护对应的标签页', () => {
  const tabList = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
  assert.deepEqual(planDuplicateClosure(tabList, new Set([2, 3]), (a, b) => a.id - b.id), { keepId: 2, removeIdList: [1, 4] });
  assert.deepEqual(planDuplicateClosure(tabList, new Set(), (a, b) => b.id - a.id), { keepId: 4, removeIdList: [1, 2, 3] });
});

test('URL样本生成规则保持存储字段兼容，可用于分组', () => {
  const rule = inferRuleFromUrls(['https://example.com/a?track=1', 'https://example.com/a?track=2']);
  assert.deepEqual(rule.ignoreQueryParams, ['track']);
  assert.equal(groupDuplicateTabs([{ id: 1, url: rule.samples[0] }, { id: 2, url: rule.samples[1] }], [rule], getUrl).length, 1);
});
