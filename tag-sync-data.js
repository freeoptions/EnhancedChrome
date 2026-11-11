import { createBackup, restoreBackup, validateBackup } from './backup.js';
import { emptyData } from './core.js';

export const SYNC_META_KEY = 'tagSyncMeta';
export const SYNC_CHUNK_PREFIX = 'tagSyncChunk';
const chunkSize = 7000;
const maxChunks = 15;

export function createTagSnapshot(data, nodeList) {
  const backup = createBackup(data, nodeList);
  const tagMap = new Map(data.tags.map(tag => [tag.name.toLocaleLowerCase(), tag.id]));
  return {
    tags: data.tags,
    bookmarks: backup.bookmarks.map(record => ({ ...record, tags: record.tags.map(name => tagMap.get(name.toLocaleLowerCase())) }))
  };
}

export function restoreTagSnapshot(snapshot, nodeList) {
  if (!snapshot || !Array.isArray(snapshot.tags) || !Array.isArray(snapshot.bookmarks)) throw new Error('同步标签数据格式无效');
  const tagMap = new Map();
  for (const tag of snapshot.tags) {
    if (!tag || typeof tag.id !== 'string' || !tag.id || tagMap.has(tag.id)) throw new Error('同步标签ID无效');
    tagMap.set(tag.id, tag.name);
  }
  const backup = { format: 'ChromeCollect', version: 1, tags: snapshot.tags.map(tag => tag.name), bookmarks: snapshot.bookmarks.map(record => {
    if (!Array.isArray(record?.tags) || record.tags.some(id => !tagMap.has(id))) throw new Error('同步标签关联无效');
    return { ...record, tags: record.tags.map(id => tagMap.get(id)) };
  }) };
  validateBackup(backup);
  const result = restoreBackup(emptyData(), backup, nodeList);
  const idMap = new Map(result.data.tags.map(tag => [tag.id, snapshot.tags.find(item => item.name.toLocaleLowerCase() === tag.name.toLocaleLowerCase()).id]));
  result.data.tags = structuredClone(snapshot.tags);
  for (const [id, tagList] of Object.entries(result.data.bookmarks)) result.data.bookmarks[id] = tagList.map(tag => idMap.get(tag));
  for (const record of result.data.pendingList) record.tagList = record.tagList.map(id => idMap.get(id));
  return result;
}

async function checksum(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function encodeTagSnapshot(snapshot, revision = crypto.randomUUID(), updatedAt = Date.now()) {
  const stream = new Blob([JSON.stringify(snapshot)]).stream().pipeThrough(new CompressionStream('gzip'));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary);
  const count = Math.ceil(encoded.length / chunkSize);
  if (count > maxChunks) throw new Error('标签数据超出Chrome同步容量，请使用JSON导出备份');
  const itemMap = {};
  for (let i = 0; i < count; i++) itemMap[`${SYNC_CHUNK_PREFIX}${i}`] = encoded.slice(i * chunkSize, (i + 1) * chunkSize);
  itemMap[SYNC_META_KEY] = { version: 1, revision, updatedAt, count, hash: await checksum(encoded) };
  return itemMap;
}

export async function decodeTagSnapshot(itemMap) {
  const meta = itemMap[SYNC_META_KEY];
  if (!meta) return null;
  if (meta.version !== 1 || typeof meta.revision !== 'string' || !Number.isFinite(meta.updatedAt)
    || !Number.isInteger(meta.count) || meta.count < 1 || meta.count > maxChunks || typeof meta.hash !== 'string') throw new Error('同步版本或数据格式无效');
  let encoded = '';
  for (let i = 0; i < meta.count; i++) {
    const chunk = itemMap[`${SYNC_CHUNK_PREFIX}${i}`];
    if (typeof chunk !== 'string' || chunk.length > chunkSize) return null;
    encoded += chunk;
  }
  // Chrome可能分批送达多个键，完整性校验通过前保留本地数据。
  if (await checksum(encoded) !== meta.hash) return null;
  const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return { meta, snapshot: JSON.parse(await new Response(stream).text()) };
}

export function checkSyncQuota(existingMap, nextMap) {
  const combinedMap = { ...existingMap, ...nextMap };
  const size = value => new TextEncoder().encode(value).byteLength;
  let total = 0;
  for (const [key, value] of Object.entries(combinedMap)) {
    const bytes = size(key) + size(JSON.stringify(value));
    if (bytes > 8192) throw new Error('单项标签数据超出Chrome同步容量');
    total += bytes;
  }
  if (total > 102400 || Object.keys(combinedMap).length > 512) throw new Error('标签数据超出Chrome同步容量，请使用JSON导出备份');
  return total;
}
