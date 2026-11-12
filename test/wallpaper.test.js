import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

async function createPage(storage = {}, preview = null) {
  const elements = new Map();
  const frames = [];
  const timers = new Map();
  const revoked = [];
  const events = new Map();
  let messageListener;
  const element = id => {
    if (!elements.has(id)) {
      const classes = new Set();
      const listeners = new Map();
      elements.set(id, {
        style: {},
        dataset: {},
        naturalWidth: 1920,
        naturalHeight: 1080,
        hidden: false,
        decode: async () => {},
        getAttribute(name) { return this[name] ?? null; },
        removeAttribute(name) { delete this[name]; },
        classList: { add: name => classes.add(name), remove: (...names) => names.forEach(name => classes.delete(name)), contains: name => classes.has(name) },
        addEventListener: (name, callback) => listeners.set(name, callback),
        removeEventListener: name => listeners.delete(name),
        endTransition() { listeners.get('transitionend')?.({ target: this, propertyName: 'opacity' }); }
      });
    }
    return elements.get(id);
  };
  const context = vm.createContext({
    document: { visibilityState: 'visible', getElementById: element, documentElement: { style: {} }, addEventListener: (name, callback) => events.set(name, callback) },
    chrome: {
      storage: { local: {
        async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, storage[key]])); },
        async set(patch) { Object.assign(storage, patch); }
      } },
      tabs: { getCurrent: async () => ({ id: 1 }) },
      runtime: { id: 'test', onMessage: { addListener: callback => { messageListener = callback; } } }
    },
    console,
    localStorage: { getItem: () => preview },
    requestAnimationFrame: callback => frames.push(callback),
    getComputedStyle: () => ({ transitionDuration: '1.5s' }),
    setTimeout: (callback, delay) => { const id = {}; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    URL: { revokeObjectURL: url => revoked.push(url) }
  });
  vm.runInContext(fs.readFileSync(new URL('../wallpaper/startup.js', import.meta.url), 'utf8'), context);
  vm.runInContext(fs.readFileSync(new URL('../wallpaper/newtab.js', import.meta.url), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  return { context, element, frames, timers, revoked, events, storage,
    notify: () => messageListener({ type: 'WALLPAPER_REFRESH', tabId: 1 }, { id: 'test' }, () => {}) };
}

test('首图解码后直接显示，后续切换保留旧图到过渡结束，超时也先完成新图', async () => {
  const { context, element, frames, timers, revoked } = await createPage();
  const apply = url => context.applyWallpaper(url);
  await apply('blob:first');
  assert.equal(element('wallpaperA').src, 'blob:first');
  assert.equal(element('wallpaperA').classList.contains('is-entering'), false);
  assert.equal(element('wallpaperB').src, undefined);
  assert.equal(frames.length, 0);

  for (const [previous, next, oldId, nextId, fallback] of [
    ['first', 'second', 'wallpaperA', 'wallpaperB', false],
    ['second', 'third', 'wallpaperB', 'wallpaperA', true]
  ]) {
    let completed = false;
    const pending = apply(`blob:${next}`).then(() => { completed = true; });
    await new Promise(resolve => setImmediate(resolve)); // let decode settle before scheduling paint frames
    while (frames.length) frames.shift()();
    await new Promise(resolve => setImmediate(resolve));
    const oldLayer = element(oldId);
    const nextLayer = element(nextId);
    assert.equal(completed, false);
    assert.equal(oldLayer.classList.contains('is-visible'), true);
    assert.equal(oldLayer.src, `blob:${previous}`);
    assert.equal(nextLayer.style.zIndex, '1');
    assert.equal(oldLayer.style.zIndex, '0');
    assert.equal(nextLayer.classList.contains('is-visible'), true);
    assert.equal(revoked.includes(`blob:${previous}`), false);
    assert.equal([...timers.values()][0].delay, 1600);
    if (fallback) [...timers.values()][0].callback();
    else nextLayer.endTransition();
    await pending;
    assert.equal(oldLayer.src, undefined);
    assert.equal(oldLayer.classList.contains('is-visible'), false);
    assert.equal(nextLayer.classList.contains('is-entering'), false);
    assert.equal(revoked.at(-1), `blob:${previous}`);
    assert.equal(timers.size, 0);
  }
});

test('启动预览先于目录读取显示，只接受有大小上限的本地图片', async () => {
  const preview = JSON.stringify({ path: 'cached.jpg', image: 'data:image/webp;base64,test' });
  const cached = await createPage({}, preview);
  assert.equal(cached.element('wallpaperA').src, 'data:image/webp;base64,test');
  assert.equal(cached.element('wallpaperA').classList.contains('is-visible'), true);
  assert.equal(cached.timers.size, 0);
  for (const invalid of ['broken-json', 'x'.repeat(512 * 1024 + 1),
    JSON.stringify({ path: 'bad.jpg', image: 'https://example.com/image.webp' })]) {
    const page = await createPage({}, invalid);
    assert.equal(page.element('wallpaperA').src, undefined);
  }
});

test('新图解码失败仍完整保留当前壁纸', async () => {
  const { context, element, revoked } = await createPage();
  await context.applyWallpaper('blob:old');
  element('wallpaperB').decode = async () => { throw new Error('corrupt'); };
  await assert.rejects(context.applyWallpaper('blob:bad'), /Image failed to load/);
  assert.equal(element('wallpaperA').src, 'blob:old');
  assert.equal(element('wallpaperA').classList.contains('is-visible'), true);
  assert.equal(element('wallpaperB').src, undefined);
  assert.deepEqual(revoked, []);
});

test('新窗口首次选图避开上一窗口的图片', async () => {
  const { context, storage } = await createPage({
    wallpaperUnplayedQueue: ['last.jpg', 'next.jpg'],
    wallpaperPlayedPaths: [],
    wallpaperLastSelectedPath: 'last.jpg'
  });
  const candidate = await context.reserveWallpaperCandidate(new Set());
  assert.equal(candidate.path, 'next.jpg');
  assert.equal(storage.wallpaperLastSelectedPath, 'next.jpg');
});

test('两个窗口同时加载时串行预留队列，避免抽中同图或覆盖播放记录', async () => {
  const storage = {};
  const first = await createPage(storage);
  const second = await createPage(storage);
  let selection = Promise.resolve();
  const locks = { request(name, operation) {
    assert.equal(name, 'wallpaper-selection');
    const result = selection.then(operation);
    selection = result.catch(() => {});
    return result;
  } };
  storage.files = ['a.jpg', 'b.jpg'];
  for (const page of [first, second]) {
    page.context.navigator = { locks };
    page.context.getWallpaperDirectoryHandle = async () => ({});
    page.context.resolveWallpaperUrl = async path => `blob:${path}`;
    page.context.scheduleWallpaperPreview = () => {};
  }
  await Promise.all([first.context.loadRandomWallpaper(), second.context.loadRandomWallpaper()]);
  assert.notEqual(first.element('wallpaperA').src, second.element('wallpaperA').src);
  assert.deepEqual([...storage.wallpaperPlayedPaths].sort(), ['a.jpg', 'b.jpg']);
  assert.equal(storage.wallpaperUnplayedQueue.length, 0);
});

test('跳过缺失图片后，目录记录更新失败不会释放已经显示的图片', async () => {
  const storage = {};
  const { context, element, revoked } = await createPage(storage);
  Object.assign(storage, {
    files: ['missing.jpg', 'good.jpg'],
    wallpaperUnplayedQueue: ['missing.jpg', 'good.jpg'],
    wallpaperPlayedPaths: []
  });
  context.navigator = { locks: { request: (name, operation) => operation() } };
  context.console = { warn() {}, error() {} };
  context.getWallpaperDirectoryHandle = async () => ({});
  context.resolveWallpaperUrl = async path => {
    if (path === 'missing.jpg') {
      const error = new Error('File missing');
      error.name = 'NotFoundError';
      throw error;
    }
    return `blob:${path}`;
  };
  context.scheduleWallpaperPreview = () => {};
  context.removeUnavailableWallpaperPaths = async () => { throw new Error('Storage unavailable'); };
  assert.equal(await context.loadRandomWallpaper(), true);
  assert.equal(element('wallpaperA').src, 'blob:good.jpg');
  assert.equal(element('wallpaperA').classList.contains('is-visible'), true);
  assert.deepEqual(revoked, []);
});

test('显式通知不依赖可见性变化；重复事件合并；忙碌时请求留待完成后执行', async () => {
  const { context, element, events, timers, notify } = await createPage();
  await context.applyWallpaper('blob:old');
  element('main').hidden = false;
  let switches = 0;
  context.loadRandomWallpaper = async () => { switches++; return true; };
  notify();
  events.get('visibilitychange')();
  assert.equal(timers.size, 1);
  const fire = () => {
    const [id, timer] = timers.entries().next().value;
    timers.delete(id);
    timer.callback();
  };
  fire();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(switches, 1);

  let finishLoad;
  context.loadRandomWallpaper = () => new Promise(resolve => { finishLoad = resolve; });
  const loading = context.showMain();
  notify();
  assert.equal(timers.size, 0);
  finishLoad(true);
  await loading;
  assert.equal(timers.size, 1);
  context.loadRandomWallpaper = async () => { switches++; return true; };
  fire();
  await Promise.resolve();
  assert.equal(switches, 2);
});
