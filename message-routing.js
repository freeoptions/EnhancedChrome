const bookmarkCommandSet = new Set([
  'createTag', 'renameTag', 'deleteTag', 'setBookmarkTags', 'addBookmarkTags',
  'deleteBookmark', 'undoDeleteBookmark', 'getBookmarkUndoState',
  'syncTags', 'exportBackup', 'importBackup', 'retryPending', 'resolvePending', 'updateSettings'
]);
const dedupeCommandSet = new Set([
  'PAGE_PROTECTION_STATE', 'RESCAN_CURRENT_WINDOW'
]);

export function messageModule(type) {
  if (bookmarkCommandSet.has(type)) return 'bookmarks';
  if (dedupeCommandSet.has(type)) return 'dedupe';
  return null;
}
