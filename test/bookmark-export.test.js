import test from 'node:test';
import assert from 'node:assert/strict';
import { createBookmarkExport } from '../bookmark-export.js';

const now = new Date(2026, 10, 22);
const treeList = [{ id: '0', title: '', children: [
  { id: '1', title: 'Blogs', children: [{ id: '10', title: '未选书签', url: 'https://example.test/unselected' }] },
  { id: '2', title: 'Blogs', children: [
    { id: '20', title: '首条书签', url: 'https://example.test/first' },
    { id: '21', title: '子文件夹', children: [{ id: '22', title: '子书签', url: 'https://example.test/child' }] },
    { id: '23', title: '末条书签', url: 'https://example.test/last' },
  ] },
  { id: '3', title: '另一个文件夹', children: [] },
] }];

test('全量导出保留所有顶级文件夹，省略浏览器内部根节点', () => {
  const result = createBookmarkExport(treeList, null, now);
  assert.equal(result.filename, '书签-2026-11-22.html');
  assert.deepEqual([...result.html.matchAll(/^ {4}<DT><H3>(.*?)<\/H3>$/gm)].map(match => match[1]),
    ['Blogs', 'Blogs', '另一个文件夹']);
  assert.match(result.html, /未选书签/);
});

test('按 ID 导出同名文件夹中的指定项，保留子目录与书签顺序', () => {
  const result = createBookmarkExport(treeList, new Set(['2']), now);
  assert.equal(result.filename, 'Blogs-书签-2026-11-22.html');
  assert.doesNotMatch(result.html, /未选书签|另一个文件夹/);
  assert.equal(result.html.match(/<H3>Blogs<\/H3>/g).length, 1);
  assert.match(result.html, /首条书签[\s\S]*<H3>子文件夹<\/H3>\r\n {8}<DL><p>\r\n {12}<DT><A [^>]+>子书签<\/A>\r\n {8}<\/DL><p>[\s\S]*末条书签/);
});

test('以原文件夹顺序合并勾选，父子重复选中只输出一次', () => {
  const result = createBookmarkExport(treeList, new Set(['3', '21', '2']), now);
  assert.equal(result.filename, '书签-2026-11-22.html');
  assert.match(result.html, /<H3>Blogs<\/H3>[\s\S]*<H3>另一个文件夹<\/H3>/);
  assert.equal(result.html.match(/<H3>子文件夹<\/H3>/g).length, 1);
  assert.equal(createBookmarkExport(treeList, new Set(['2', 'missing']), now), null);
});

test('导出 UTF-8 书签 HTML，转义文本与网址并清理文件名', () => {
  const folder = { id: '1', title: '中文/<&"', dateAdded: 1500, dateGroupModified: 2500, children: [
    { id: '2', title: '<链接> & "标题"', url: 'https://example.test/?a=1&b="2"', dateAdded: 3500 },
  ] };
  const result = createBookmarkExport([folder], new Set(['1']), now);
  assert.equal(result.filename, '中文__&_-书签-2026-11-22.html');
  assert.match(result.html, /^<!DOCTYPE NETSCAPE-Bookmark-file-1>\r\n.*charset=UTF-8/);
  assert.ok(result.html.includes('<H3 ADD_DATE="1" LAST_MODIFIED="2">中文/&lt;&amp;&quot;</H3>'));
  assert.ok(result.html.includes('<A HREF="https://example.test/?a=1&amp;b=&quot;2&quot;" ADD_DATE="3">&lt;链接&gt; &amp; &quot;标题&quot;</A>'));
});
