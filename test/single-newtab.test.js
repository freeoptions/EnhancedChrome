import test from 'node:test';
import assert from 'node:assert/strict';

test('去重显式通知原壁纸页，先激活原页再删除新页，后台副本不抢焦点', async () => {
  const calls = [];
  const listeners = {};
  const base = 'chrome-extension://test/';
  const tabs = new Map([[1, { id: 1, windowId: 10, url: `${base}wallpaper/newtab.html`, active: true }]]);
  const event = name => ({ addListener: callback => { listeners[name] = callback; } });
  const previous = globalThis.chrome;
  globalThis.chrome = {
    runtime: { getURL: () => base, sendMessage: async message => { calls.push(['notify', message.tabId]); } },
    storage: {
      local: { get: async () => ({}) },
      onChanged: event('storage')
    },
    windows: { getAll: async () => [{ id: 10 }] },
    tabs: {
      query: async () => [...tabs.values()],
      get: async id => ({ ...tabs.get(id) }),
      update: async id => {
        calls.push(['activate', id]);
        for (const tab of tabs.values()) tab.active = tab.id === id;
      },
      remove: async id => { calls.push(['remove', id]); tabs.delete(id); },
      onCreated: event('created'), onUpdated: event('updated'), onAttached: event('attached')
    }
  };
  try {
    await import('../single-newtab.js');
    await new Promise(resolve => setImmediate(resolve));
    tabs.get(1).active = false;
    tabs.set(2, { id: 2, windowId: 10, url: 'chrome://newtab/', active: true });
    listeners.created(tabs.get(2));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, [['notify', 1], ['activate', 1], ['remove', 2]]);
    calls.length = 0;
    tabs.set(3, { id: 3, windowId: 10, url: 'chrome://newtab/', active: false });
    listeners.created(tabs.get(3));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, [['remove', 3]]);
  } finally {
    globalThis.chrome = previous;
  }
});
