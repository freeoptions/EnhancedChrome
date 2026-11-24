import { addTabPin, bindTabPin, changeTabPin, readTabPins } from './pins.js';
import { matchesTabSearch } from './match.js';
import { logTabPin } from './pin-log.js';

const query = document.getElementById('query');
const results = document.getElementById('results');
const status = document.getElementById('status');
const pinDialog = document.getElementById('pin-dialog');
const aliasInput = document.getElementById('pin-alias');
const pinCancel = document.getElementById('pin-cancel');
const pinConfirm = document.getElementById('pin-confirm');
const sourceWindowId = Number(new URLSearchParams(location.search).get('windowId'));
let tabList = [];
let pinList = [];
let matchList = [];
let optionList = [];
let selectedIndex = -1;
let switching = false;
let editingPin;

function select(index) {
  optionList[selectedIndex]?.setAttribute('aria-selected', 'false');
  selectedIndex = index;
  const row = optionList[index];
  if (!row) {
    query.removeAttribute('aria-activedescendant');
    return;
  }
  row.setAttribute('aria-selected', 'true');
  query.setAttribute('aria-activedescendant', row.id);
  row.scrollIntoView({ block: 'nearest' });
}

async function switchTo(tab) {
  if (!tab || switching) return;
  switching = true;
  let tabId = tab.id;
  try {
    if (tab.pin) {
      logTabPin('点击置顶项', { pinId: tab.pin.id, displayedTabId: tabId ?? null, sourceWindowId });
      await readTabs();
      const pin = pinList.find(pin => pin.id === tab.pin.id);
      if (!pin) throw new Error('置顶记录已移除。');
      tabId = pin.tabId;
      if (tabId === undefined) {
        logTabPin('按保存的网址新开标签', { pinId: pin.id, sourceWindowId });
        const reopenedTab = await chrome.tabs.create({ windowId: sourceWindowId, url: pin.url, active: false });
        tabId = reopenedTab.id;
        await bindTabPin(pin.id, tabId);
      }
    }
    const activatedTab = await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(activatedTab.windowId, { focused: true });
    if (tab.pin) logTabPin('已切换到标签', { pinId: tab.pin.id, tabId, windowId: activatedTab.windowId });
    window.close();
  } catch (error) {
    if (tab.pin) logTabPin('切换置顶标签失败', { pinId: tab.pin.id, tabId: tabId ?? null, errorName: error.name });
    status.textContent = '无法打开或切换到该标签页。';
    status.hidden = false;
  } finally {
    switching = false;
  }
}

async function readTabs() {
  tabList = (await chrome.tabs.query({ windowType: 'normal' }))
    .filter(tab => !tab.incognito && tab.id >= 0)
    .sort((a, b) => Number(b.windowId === sourceWindowId) - Number(a.windowId === sourceWindowId))
    .map(tab => ({ ...tab, title: tab.title || tab.url || '未命名标签页' }));
  pinList = await readTabPins(tabList);
}

async function updatePins(operation) {
  try {
    await operation();
    await readTabs();
    render();
  } catch (error) {
    status.textContent = error.message;
    status.hidden = false;
  }
  query.focus();
}

function editPin(pin, removing) {
  editingPin = pin;
  document.getElementById('pin-dialog-title').textContent = removing ? '取消置顶？' : '重命名置顶标签页';
  document.getElementById('pin-dialog-description').textContent = removing
    ? `取消「${pin.alias || pin.title}」的置顶？`
    : '留空则显示网页原标题。';
  aliasInput.hidden = removing;
  aliasInput.value = pin.alias;
  pinConfirm.textContent = removing ? '取消置顶' : '保存';
  pinDialog.returnValue = '';
  pinDialog.showModal();
  if (removing) {
    pinCancel.focus();
  } else {
    aliasInput.focus();
    aliasInput.select();
  }
}

function actionButton(icon, label, action) {
  const button = document.createElement('button');
  button.type = 'button';
  button.classList.add('row-action', `${icon}-action`);
  button.title = label;
  button.setAttribute('aria-label', label);
  button.addEventListener('click', action);
  return button;
}

function appendRow(tab, inPinnedSection) {
  const row = document.createElement('li');
  row.className = 'tab-row';
  row.classList.toggle('pinned-row', inPinnedSection);
  row.setAttribute('role', 'presentation');
  const option = document.createElement('div');
  option.id = tab.id === undefined ? `pin-${tab.pin.id}` : `tab-${tab.id}`;
  option.setAttribute('role', 'option');
  option.setAttribute('aria-selected', 'false');
  option.title = tab.pin?.alias || tab.title;

  const icon = document.createElement('img');
  icon.className = 'icon';
  icon.alt = '';
  icon.loading = 'lazy';
  const faviconUrl = new URL(chrome.runtime.getURL('/_favicon/'));
  faviconUrl.searchParams.set('pageUrl', tab.url || '');
  faviconUrl.searchParams.set('size', '32');
  icon.src = faviconUrl.href;

  const text = document.createElement('span');
  text.className = 'tab-text';
  const title = document.createElement('span');
  title.className = 'tab-title';
  title.textContent = option.title;
  const url = document.createElement('span');
  url.className = 'tab-url';
  url.textContent = tab.url;
  text.append(title, url);
  option.append(icon, text);
  option.addEventListener('click', () => switchTo(tab));
  row.append(option);
  if (tab.pin) row.append(actionButton('rename', '重命名', () => editPin(tab.pin, false)));
  if (tab.pin || tab.url) {
    const button = actionButton('pin', tab.pin ? '取消置顶' : '置顶', () => {
      if (tab.pin) editPin(tab.pin, true);
      else updatePins(() => addTabPin(tab));
    });
    button.setAttribute('aria-pressed', String(Boolean(tab.pin)));
    row.append(button);
  }
  results.append(row);
  optionList.push(option);
}

function render() {
  const keywordList = query.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const pinMap = new Map(pinList.map(pin => [pin.tabId, pin]));
  const tabMap = new Map(tabList.map(tab => [tab.id, tab]));
  const openedList = tabList.map(tab => ({ ...tab, pin: pinMap.get(tab.id) }));
  const pinnedList = keywordList.length ? [] : pinList.map(pin => ({
    ...(tabMap.get(pin.tabId) ?? { title: pin.title, url: pin.url }), pin
  }));
  const resultList = keywordList.length
    ? openedList.filter(tab => matchesTabSearch(tab, keywordList))
    : openedList.filter(tab => !tab.pin);
  matchList = [...pinnedList, ...resultList];
  optionList = [];
  results.replaceChildren();
  if (pinnedList.length) {
    const label = document.createElement('li');
    label.className = 'section-label';
    label.setAttribute('role', 'presentation');
    label.textContent = '置顶';
    results.append(label);
  }
  matchList.forEach((tab, index) => appendRow(tab, index < pinnedList.length));
  results.hidden = !matchList.length;
  query.setAttribute('aria-expanded', String(!results.hidden));
  status.hidden = !results.hidden;
  status.textContent = keywordList.length ? '没有匹配的标签页' : '没有可搜索的标签页';
  results.scrollTop = 0;
  select(matchList.length ? 0 : -1);
}

pinCancel.addEventListener('click', () => pinDialog.close());
pinDialog.addEventListener('close', () => {
  if (pinDialog.returnValue === 'confirm') {
    const id = editingPin.id;
    const alias = aliasInput.hidden ? null : aliasInput.value.trim();
    updatePins(() => changeTabPin(id, alias));
  } else {
    query.focus();
  }
});

query.value = '';
query.focus();

query.addEventListener('keydown', event => {
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === 'Enter') {
    event.preventDefault();
    switchTo(matchList[selectedIndex]);
  } else if (matchList.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
    event.preventDefault();
    const direction = event.key === 'ArrowDown' ? 1 : -1;
    select((selectedIndex + direction + matchList.length) % matchList.length);
  }
});
window.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !pinDialog.open && !event.isComposing && event.keyCode !== 229) window.close();
});
window.addEventListener('blur', () => {
  if (!switching) window.close();
});

try {
  if (!sourceWindowId) throw new Error('缺少来源窗口');
  await readTabs();
  query.addEventListener('input', render);
  render();
} catch {
  status.textContent = '无法读取已打开的标签页。';
}
