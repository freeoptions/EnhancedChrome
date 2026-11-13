import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTagSnapshot, decodeTagSnapshot, encodeTagSnapshot } from '../tag-sync-data.js';
import { flattenTree } from '../core.js';

const browserPath = process.argv[2];
if (!browserPath) throw new Error('请传入支持扩展的Chrome或百分浏览器可执行文件路径');
const root = fileURLToPath(new URL('../', import.meta.url));
const profilePath = fs.mkdtempSync(path.join(os.tmpdir(), 'EnhancedChrome-sync-test-'));
const browser = spawn(browserPath, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=0', `--user-data-dir=${profilePath}`,
  `--disable-extensions-except=${root}`, `--load-extension=${root}`
], { windowsHide: true, stdio: 'ignore' });
let launchError;
browser.on('error', error => { launchError = error; });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const requestMap = new Map();
let socket;
let requestId = 0;
let workerSessionId;

function call(method, params = {}, sessionId) {
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      requestMap.delete(id);
      reject(new Error(`浏览器调用超时：${method}`));
    }, 5000);
    requestMap.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });
}

async function evaluate(expression, sessionId = workerSessionId) {
  const response = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
  return response.result.value;
}

async function readState() {
  return evaluate(`(async () => ({
    local: await chrome.storage.local.get(['tagData', 'tagSyncState', 'tagSyncStatus']),
    sync: await chrome.storage.sync.get(null)
  }))()`);
}

async function waitFor(predicate) {
  let state;
  for (let attempt = 0; attempt < 40; attempt++) {
    state = await readState();
    if (predicate(state)) return state;
    await sleep(100);
  }
  throw new Error(`同步状态未满足预期：${JSON.stringify({ status: state.local.tagSyncStatus, meta: state.sync.tagSyncMeta })}`);
}

try {
  const portPath = path.join(profilePath, 'DevToolsActivePort');
  for (let attempt = 0; attempt < 60 && !fs.existsSync(portPath); attempt++) {
    if (launchError) throw launchError;
    await sleep(100);
  }
  if (!fs.existsSync(portPath)) throw new Error('无窗口浏览器调试接口未启动');
  const port = fs.readFileSync(portPath, 'utf8').split('\n')[0];
  let worker;
  for (let attempt = 0; attempt < 40 && !worker; attempt++) {
    const targetList = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
    worker = targetList.find(target => target.type === 'service_worker' && target.url === 'chrome-extension://jjlpkcpgoenceomnlcfbmacdcenjfhmb/background.js');
    if (!worker) await sleep(100);
  }
  if (!worker) throw new Error('扩展后台未启动，请确认浏览器支持命令行加载扩展');
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(5000) })).json();
  socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', event => {
    const response = JSON.parse(event.data);
    const request = requestMap.get(response.id);
    if (!request) return;
    requestMap.delete(response.id);
    clearTimeout(request.timer);
    if (response.error) request.reject(new Error(response.error.message));
    else request.resolve(response.result);
  });
  ({ sessionId: workerSessionId } = await call('Target.attachToTarget', { targetId: worker.id, flatten: true }));

  for (let attempt = 0; attempt < 40; attempt++) {
    if (await evaluate("typeof chrome.bookmarks?.create === 'function'")) break;
    await sleep(100);
  }
  await waitFor(state => !!state.local.tagSyncStatus && state.local.tagSyncStatus.state !== 'syncing');
  const bookmark = await evaluate("chrome.bookmarks.create({ title: 'Sync recovery test', url: 'https://example.com/sync-recovery' })");
  const data = { tags: [{ id: 'recovery-tag', name: '恢复测试' }], bookmarks: { [bookmark.id]: ['recovery-tag'] }, pendingList: [] };
  const snapshot = createTagSnapshot(data, flattenTree(await evaluate('chrome.bookmarks.getTree()')));
  const initialMap = await encodeTagSnapshot(snapshot, 'previous-revision');
  await evaluate(`(async () => {
    await chrome.storage.sync.clear();
    await chrome.storage.local.clear();
    await chrome.storage.local.set(${JSON.stringify({ tagData: data, tagSyncState: { revision: 'previous-revision', dirty: false } })});
    await chrome.storage.sync.set(${JSON.stringify(initialMap)});
  })()`);
  await waitFor(state => !!state.local.tagSyncStatus && state.local.tagSyncStatus.state !== 'syncing' && state.sync.tagSyncMeta?.revision === 'previous-revision');

  await evaluate('chrome.storage.sync.clear()');
  const recovered = await waitFor(state => !!state.sync.tagSyncMeta && state.local.tagSyncStatus?.state === 'submitted');
  assert.notEqual(recovered.sync.tagSyncMeta.revision, 'previous-revision');
  assert.deepEqual(recovered.local.tagData, data);
  assert.equal(recovered.local.tagSyncState.dirty, false);
  assert.deepEqual((await decodeTagSnapshot(recovered.sync)).snapshot, snapshot);
  console.log('PASS: 同步区被清空后，已有版本的完整本地标签重新提交，关联保留');

  const emptyMap = await encodeTagSnapshot({ tags: [], bookmarks: [] }, 'remote-deletion');
  await evaluate(`chrome.storage.sync.set(${JSON.stringify(emptyMap)})`);
  const deleted = await waitFor(state => state.local.tagSyncState?.revision === 'remote-deletion' && state.local.tagSyncStatus?.state === 'received');
  assert.equal(deleted.local.tagData.tags.length, 0);
  assert.equal(deleted.sync.tagSyncMeta.revision, 'remote-deletion');
  console.log('PASS: 有效的远端空快照仍执行删除，不被旧本地标签覆盖');

  await evaluate('chrome.storage.sync.clear()');
  const empty = await waitFor(state => state.local.tagSyncStatus?.state === 'waiting');
  assert.equal(empty.sync.tagSyncMeta, undefined);
  assert.equal(empty.local.tagData.tags.length, 0);
  console.log('PASS: 没有标签的接收端等待数据，不上传空快照');

  const receivedMap = await encodeTagSnapshot(snapshot, 'source-republished');
  await evaluate(`chrome.storage.sync.set(${JSON.stringify({ tagSyncMeta: receivedMap.tagSyncMeta })})`);
  const partial = await waitFor(state => state.local.tagSyncStatus?.state === 'receiving');
  assert.equal(partial.local.tagData.tags.length, 0);
  await evaluate(`chrome.storage.sync.set(${JSON.stringify(receivedMap)})`);
  const received = await waitFor(state => state.local.tagSyncState?.revision === 'source-republished' && state.local.tagSyncStatus?.state === 'received');
  assert.deepEqual(received.local.tagData, data);
  console.log('PASS: 分块未送齐时保留本地，送齐后接收完整标签和书签关联');

  const { targetId } = await call('Target.createTarget', { url: 'chrome-extension://jjlpkcpgoenceomnlcfbmacdcenjfhmb/manager.html' });
  const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await evaluate("typeof chrome?.runtime?.sendMessage === 'function'", sessionId)) break;
    await sleep(100);
  }
  async function command(payload) {
    return evaluate(`chrome.runtime.sendMessage(${JSON.stringify(payload)})`, sessionId);
  }
  const fixture = await evaluate(`(async () => {
    const folder = await chrome.bookmarks.create({ title: '删除撤回测试' });
    const bookmarkList = [];
    for (let i = 0; i < 3; i++) bookmarkList.push(await chrome.bookmarks.create({
      parentId: folder.id, title: i === 1 ? '用于验证长标题省略且撤回按钮始终可见的书签'.repeat(20) : 'Bookmark ' + i, url: 'https://example.com/delete-undo/' + i
    }));
    return { folder, bookmarkList };
  })()`);
  const middle = fixture.bookmarkList[1];
  assert.equal((await command({ type: 'setBookmarkTags', bookmarkId: middle.id, tagList: ['recovery-tag'] })).ok, true);
  const removal = await command({ type: 'deleteBookmark', bookmarkId: middle.id });
  assert.equal(removal.ok, true);
  assert.equal(removal.undoCount, 1);
  assert.equal(removal.undoTitle, middle.title);
  await waitFor(state => !state.local.tagData.bookmarks[middle.id]);
  await call('Page.reload', {}, sessionId);
  await sleep(200);
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await evaluate("document.getElementById('bookmark-undo')?.hidden === false", sessionId)) break;
    await sleep(100);
  }
  const countdown = await evaluate("document.getElementById('bookmark-undo-countdown').textContent", sessionId);
  assert.match(countdown, /^\d+秒$/);
  await sleep(1100);
  const nextCountdown = await evaluate("document.getElementById('bookmark-undo-countdown').textContent", sessionId);
  assert.ok(parseInt(nextCountdown) < parseInt(countdown));
  const notice = await evaluate(`(() => {
    const text = document.getElementById('bookmark-undo-text');
    const button = document.getElementById('undo-bookmark');
    return { text: text.textContent, truncated: text.scrollWidth > text.clientWidth,
      separated: text.getBoundingClientRect().right <= button.getBoundingClientRect().left };
  })()`, sessionId);
  assert.equal(notice.text, `已删除“${middle.title}”`);
  assert.equal(notice.truncated, true);
  assert.equal(notice.separated, true);
  await call('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId);
  const narrowNotice = await evaluate(`(() => {
    const bounds = document.getElementById('bookmark-undo').getBoundingClientRect();
    const button = document.getElementById('undo-bookmark').getBoundingClientRect();
    return { fits: bounds.left >= 0 && bounds.right <= innerWidth, buttonFits: button.left >= bounds.left && button.right <= bounds.right };
  })()`, sessionId);
  assert.equal(narrowNotice.fits, true);
  assert.equal(narrowNotice.buttonFits, true);
  await call('Emulation.clearDeviceMetricsOverride', {}, sessionId);
  console.log('PASS: 提示显示真实书签名称及递减秒数，长标题省略，窄屏撤回按钮不被挤出');
  const undo = await command({ type: 'undoDeleteBookmark' });
  assert.equal(undo.ok, true);
  assert.notEqual(undo.bookmarkId, middle.id);
  const childList = await evaluate(`chrome.bookmarks.getChildren(${JSON.stringify(fixture.folder.id)})`);
  assert.equal(childList[1].id, undo.bookmarkId);
  assert.equal(childList[1].title, middle.title);
  assert.equal(childList[1].url, middle.url);
  const undoState = await readState();
  assert.deepEqual(undoState.local.tagData.bookmarks[undo.bookmarkId], ['recovery-tag']);
  assert.equal(undoState.local.tagData.bookmarks[middle.id], undefined);
  console.log('PASS: 真实消息入口删除书签，撤回恢复原目录、顺序、名称、网址和标签关联');

  for (const index of [0, 2]) assert.equal((await command({ type: 'deleteBookmark', bookmarkId: fixture.bookmarkList[index].id })).ok, true);
  const lastUndo = await command({ type: 'undoDeleteBookmark' });
  assert.equal(lastUndo.ok, true);
  assert.equal(lastUndo.undoCount, 1);
  assert.equal(lastUndo.undoTitle, fixture.bookmarkList[0].title);
  const firstUndo = await command({ type: 'undoDeleteBookmark' });
  assert.equal(firstUndo.ok, true);
  const restoredList = await evaluate(`chrome.bookmarks.getChildren(${JSON.stringify(fixture.folder.id)})`);
  assert.deepEqual(restoredList.map(node => node.title), fixture.bookmarkList.map(node => node.title));
  assert.equal((await command({ type: 'undoDeleteBookmark' })).ok, false);
  assert.equal((await command({ type: 'deleteBookmark', bookmarkId: fixture.folder.id })).ok, false);
  console.log('PASS: 连续删除按倒序逐条恢复；重复撤回及删除文件夹均被拒绝');

  assert.equal((await command({ type: 'deleteBookmark', bookmarkId: restoredList[0].id })).ok, true);
  await sleep(10200);
  const expired = await command({ type: 'undoDeleteBookmark' });
  assert.equal(expired.ok, false);
  assert.match(expired.error, /撤回时间已过/);
  assert.equal((await command({ type: 'getBookmarkUndoState' })).undoCount, 0);
  console.log('PASS: 真实等待10秒后撤回过期，不恢复已超时的删除记录');

  const orphan = await evaluate(`(async () => {
    const folder = await chrome.bookmarks.create({ title: '父目录消失测试' });
    const bookmark = await chrome.bookmarks.create({ parentId: folder.id, title: 'Orphan', url: 'https://example.com/orphan' });
    return { folder, bookmark };
  })()`);
  assert.equal((await command({ type: 'deleteBookmark', bookmarkId: orphan.bookmark.id })).ok, true);
  await evaluate(`chrome.bookmarks.remove(${JSON.stringify(orphan.folder.id)})`);
  const missingParent = await command({ type: 'undoDeleteBookmark' });
  assert.equal(missingParent.ok, false);
  assert.match(missingParent.error, /原文件夹已不存在/);
  const preserved = await evaluate("chrome.storage.session.get('bookmarkUndoState')");
  assert.equal(preserved.bookmarkUndoState.recordList.at(-1).bookmark.id, orphan.bookmark.id);
  console.log('PASS: 原目录不存在时明确失败并保留记录，不擅自恢复到其他文件夹');
} finally {
  if (socket?.readyState === WebSocket.OPEN) {
    await call('Browser.close').catch(() => {});
    socket.close();
  }
  browser.kill();
}
