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

function call(method, params = {}) {
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      requestMap.delete(id);
      reject(new Error(`浏览器调用超时：${method}`));
    }, 5000);
    requestMap.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const response = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
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
  socket = new WebSocket(worker.webSocketDebuggerUrl);
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
} finally {
  if (socket?.readyState === WebSocket.OPEN) {
    await call('Browser.close').catch(() => {});
    socket.close();
  }
  browser.kill();
}
