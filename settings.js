import { normalizeSettings } from './feature-settings.js';
import { applyFontSize } from './typography.js';

const $ = id => document.getElementById(id);

function showSettingsError(error) {
  $('settings-error').textContent = error.message;
}

function renderSettings(settings) {
  $('single-newtab-enabled').checked = settings.singleNewTabEnabled;
  $('dedupe-enabled').checked = settings.dedupeEnabled;
  $('font-size').value = String(settings.fontSize);
}

async function loadSettings() {
  const storage = await chrome.storage.local.get('enhancedSettings');
  renderSettings(normalizeSettings(storage.enhancedSettings));
}

for (const [id, name] of [['single-newtab-enabled', 'singleNewTabEnabled'], ['dedupe-enabled', 'dedupeEnabled']]) {
  $(id).addEventListener('change', async () => {
    const input = $(id);
    input.disabled = true;
    $('settings-error').textContent = '';
    try {
      const value = input.checked;
      const result = await chrome.runtime.sendMessage({ type: 'updateSettings', patch: { [name]: value } });
      if (!result?.ok) throw new Error(result?.error ?? '保存设置失败');
      renderSettings(result.settings);
    } catch (error) {
      showSettingsError(error);
      await loadSettings();
    } finally { input.disabled = false; }
  });
}

$('font-size').addEventListener('change', async () => {
  const input = $('font-size');
  const fontSize = Number(input.value);
  applyFontSize(fontSize);
  input.disabled = true;
  $('settings-error').textContent = '';
  try {
    const result = await chrome.runtime.sendMessage({ type: 'updateSettings', patch: { fontSize } });
    if (!result?.ok) throw new Error(result?.error ?? '保存字号失败');
    renderSettings(result.settings);
  } catch (error) {
    showSettingsError(error);
    const storage = await chrome.storage.local.get('enhancedSettings');
    const settings = normalizeSettings(storage.enhancedSettings);
    applyFontSize(settings.fontSize);
    renderSettings(settings);
  } finally { input.disabled = false; }
});

$('open-url-rules').addEventListener('click', () => {
  $('module-settings-title').textContent = 'URL规则';
  $('module-settings-frame').title = 'URL规则';
  $('module-settings-frame').src = chrome.runtime.getURL('dedupe/options.html');
  $('module-settings-dialog').showModal();
});
$('module-settings-dialog').addEventListener('close', () => { $('module-settings-frame').src = 'about:blank'; });
document.addEventListener('settings-open', () => {
  loadSettings().catch(showSettingsError);
});
// 首页自动打开设置时，manager模块可能先于本模块执行。
if ($('settings-dialog').open) loadSettings().catch(showSettingsError);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.enhancedSettings) renderSettings(normalizeSettings(changes.enhancedSettings.newValue));
});
window.addEventListener('focus', () => {
  if ($('settings-dialog').open) loadSettings().catch(showSettingsError);
});
