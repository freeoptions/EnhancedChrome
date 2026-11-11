export const DEFAULT_SETTINGS = Object.freeze({
  dedupeEnabled: true,
  singleNewTabEnabled: true,
  fontSize: 14
});

export function normalizeSettings(value = {}) {
  return {
    dedupeEnabled: typeof value?.dedupeEnabled === 'boolean' ? value.dedupeEnabled : DEFAULT_SETTINGS.dedupeEnabled,
    fontSize: Number.isInteger(value?.fontSize) && value.fontSize >= 12 && value.fontSize <= 20 ? value.fontSize : DEFAULT_SETTINGS.fontSize,
    singleNewTabEnabled: typeof value?.singleNewTabEnabled === 'boolean' ? value.singleNewTabEnabled : DEFAULT_SETTINGS.singleNewTabEnabled
  };
}

export function validateSettingsPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('设置格式无效');
  for (const [name, value] of Object.entries(patch)) {
    if (name === 'fontSize' && Number.isInteger(value) && value >= 12 && value <= 20) continue;
    if (['dedupeEnabled', 'singleNewTabEnabled'].includes(name) && typeof value === 'boolean') continue;
    throw new Error('设置字段或取值无效');
  }
  return patch;
}
