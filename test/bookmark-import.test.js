import test from 'node:test';
import assert from 'node:assert/strict';
import { readBookmarkList } from '../bookmark-import.js';

function element(tagName, { children = [], textContent = '', href = null } = {}) {
  return {
    tagName,
    children,
    textContent,
    getAttribute: name => name === 'href' ? href : null,
    querySelector: selector => children.find(child => `:scope > ${child.tagName.toLowerCase()}` === selector) ?? null,
  };
}
const group = (tag, ...children) => element(tag, { children });
const heading = textContent => element('H3', { textContent });
const bookmark = (textContent, href) => group('DT', element('A', { textContent, href }));

test('读取 Chrome 结构，保留父子文件夹、空文件夹和同级项目顺序', () => {
  const list = group('DL',
    group('DT', heading('中文 & 书签'), group('DL',
      bookmark('首页', 'https://example.test/?a=1&b=2'),
      group('DT', heading('空文件夹'), group('DL')),
      bookmark('第二条', 'file:///D:/example.html'),
    )),
    bookmark('根目录书签', 'chrome://settings/'),
  );
  assert.deepEqual(readBookmarkList(list), {
    skippedCount: 0,
    nodeList: [
      { title: '中文 & 书签', children: [
        { title: '首页', url: 'https://example.test/?a=1&b=2' },
        { title: '空文件夹', children: [] },
        { title: '第二条', url: 'file:///D:/example.html' },
      ] },
      { title: '根目录书签', url: 'chrome://settings/' },
    ],
  });
});

test('识别独立或位于描述项内的子列表，跳过缺失和相对链接', () => {
  const list = group('DL',
    group('DT', heading('第一组')),
    group('DL', bookmark('第一条', 'https://example.test/1')),
    group('DT', heading('第二组')),
    group('DD', group('DL', bookmark('第二条', 'https://example.test/2'))),
    bookmark('没有链接'),
    bookmark('相对地址', '/local-page'),
  );
  assert.deepEqual(readBookmarkList(list), {
    skippedCount: 2,
    nodeList: [
      { title: '第一组', children: [{ title: '第一条', url: 'https://example.test/1' }] },
      { title: '第二组', children: [{ title: '第二条', url: 'https://example.test/2' }] },
    ],
  });
  assert.deepEqual(readBookmarkList(null), { skippedCount: 0, nodeList: [] });
});
