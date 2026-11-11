import { normalizeSettings, validateSettingsPatch } from './feature-settings.js';

let settings = normalizeSettings();
export const settingsReady = chrome.storage.local.get('enhancedSettings').then(storage => {
  settings = normalizeSettings(storage.enhancedSettings);
});

export function getSettings() {
  return settings;
}

export async function saveSettings(patch) {
  validateSettingsPatch(patch);
  const storage = await chrome.storage.local.get('enhancedSettings');
  const nextSettings = normalizeSettings({ ...normalizeSettings(storage.enhancedSettings), ...patch });
  await chrome.storage.local.set({ enhancedSettings: nextSettings });
  settings = nextSettings;
  return settings;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.enhancedSettings) settings = normalizeSettings(changes.enhancedSettings.newValue);
});
