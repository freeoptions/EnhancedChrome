import { normalizeSettings } from './feature-settings.js';

export function applyFontSize(fontSize) {
  const settings = normalizeSettings({ fontSize });
  document.documentElement.style.setProperty('--text-base', `${settings.fontSize}px`);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.enhancedSettings) applyFontSize(normalizeSettings(changes.enhancedSettings.newValue).fontSize);
});
chrome.storage.local.get('enhancedSettings').then(storage => {
  applyFontSize(normalizeSettings(storage.enhancedSettings).fontSize);
}).catch(error => console.error('读取字号设置失败', error));
