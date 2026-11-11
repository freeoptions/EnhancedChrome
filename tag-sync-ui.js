const statusNode = document.getElementById('tag-sync-status');
const textNode = document.getElementById('tag-sync-text');
const detailNode = document.getElementById('tag-sync-detail');
const retryButton = document.getElementById('retry-tag-sync');

function render(status = { state: 'syncing' }) {
  const labelMap = {
    syncing: '正在同步标签…', receiving: '正在接收标签…',
    submitted: '已提交Chrome同步', received: '已接收标签更新',
    ready: '自动同步已就绪', waiting: '等待Chrome同步数据', error: '标签同步失败'
  };
  statusNode.dataset.state = status.state;
  textNode.textContent = labelMap[status.state] ?? '正在检查标签同步…';
  const time = status.time ? new Date(status.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  if (status.state === 'error') detailNode.textContent = `${status.message}。本地标签已保留，将自动重试。`;
  else if (status.state === 'submitted') detailNode.textContent = `${time} · Chrome已接收，其他设备送达时间由Chrome决定。`;
  else if (status.state === 'received') detailNode.textContent = `${time}${status.pendingCount ? ` · ${status.pendingCount}项关联待匹配` : ' · 本地标签已更新'}`;
  else if (status.state === 'receiving') detailNode.textContent = '数据尚未完整送达，暂时保留本地标签。';
  else detailNode.textContent = '需在两台电脑启用Chrome扩展同步；离线时由Chrome稍后传送。';
  retryButton.hidden = !['error', 'waiting', 'receiving'].includes(status.state);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.tagSyncStatus) render(changes.tagSyncStatus.newValue);
});
chrome.storage.local.get('tagSyncStatus').then(storage => render(storage.tagSyncStatus)).catch(error => render({ state: 'error', message: error.message }));
retryButton.addEventListener('click', async () => {
  render({ state: 'syncing' });
  try {
    const result = await chrome.runtime.sendMessage({ type: 'syncTags' });
    if (!result?.ok) throw new Error(result?.error ?? '后台未响应');
  } catch (error) { render({ state: 'error', message: error.message }); }
});
chrome.runtime.sendMessage({ type: 'syncTags' }).catch(error => render({ state: 'error', message: error.message }));
