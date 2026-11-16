const statusNode = document.getElementById('tag-sync-status');
const textNode = document.getElementById('tag-sync-text');
const timeNode = document.getElementById('tag-sync-time');
const detailNode = document.getElementById('tag-sync-detail');
const retryButton = document.getElementById('retry-tag-sync');

function render(status = { state: 'syncing' }) {
  const labelMap = {
    syncing: '正在同步标签…', receiving: '正在接收标签…',
    submitted: '已提交Chrome同步', received: '已接收标签更新', unchanged: '标签版本无变化',
    ready: '尚未收到标签数据', waiting: '尚未收到标签数据', error: '标签同步失败'
  };
  statusNode.dataset.state = status.state;
  textNode.textContent = labelMap[status.state] ?? '正在检查标签同步…';
  const time = status.time ? new Date(status.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  timeNode.textContent = ['submitted', 'received', 'unchanged'].includes(status.state) ? time : '';
  timeNode.hidden = !timeNode.textContent;
  if (status.state === 'error') detailNode.textContent = `${status.message}。本地标签已保留，将自动重试。`;
  else if (status.state === 'received') detailNode.textContent = status.pendingCount ? `${status.pendingCount}项关联待匹配` : '';
  else if (['ready', 'waiting'].includes(status.state)) detailNode.textContent = '请在保存完整标签的电脑重试同步。';
  else detailNode.textContent = '';
  detailNode.hidden = !detailNode.textContent;
  retryButton.hidden = !['error', 'ready', 'waiting', 'receiving'].includes(status.state);
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
