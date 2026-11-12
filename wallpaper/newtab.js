'use strict';

const IMG_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'];
const FALLBACK_BG = '#eceff1';
const WALLPAPER_DB_NAME = 'WallpaperDirectoryDB';
const WALLPAPER_DB_VERSION = 1;
const WALLPAPER_STORE_NAME = 'handles';
const WALLPAPER_HANDLE_KEY = 'wallpaperDirectoryHandle';
const WALLPAPER_FAILURE_SCAN_THRESHOLD = 10;
const MAX_WALLPAPER_LOAD_ATTEMPTS = WALLPAPER_FAILURE_SCAN_THRESHOLD;
const WALLPAPER_FAILURE_COUNT_KEY = 'wallpaperDirectoryChangeCount';
const WALLPAPER_UNPLAYED_QUEUE_KEY = 'wallpaperUnplayedQueue';
const WALLPAPER_PLAYED_PATHS_KEY = 'wallpaperPlayedPaths';
const WALLPAPER_REVISIT_PROBABILITY = 0.1;
const WALLPAPER_LAST_PATH_KEY = 'wallpaperLastSelectedPath';

let currentPath = null;
let currentWallpaperUrl = null;
let activeWallpaperIndex = 0;
let hasAppliedWallpaper = false;
let wallpaperDirectoryHandle = null;
let wallpaperDbPromise = null;
let needsPermissionRestore = false;
let wallpaperOperationRunning = false;
let wallpaperRefreshPending = false;
let wallpaperRefreshTimer = null;
let wallpaperTabId = null;
let wallpaperInitialized = false;

const setupEl = document.getElementById('setup');
const mainEl = document.getElementById('main');
const folderInput = document.getElementById('folderInput');
const pickBtn = document.getElementById('pickBtn');
const restoreBtn = document.getElementById('restoreBtn');
document.getElementById('previewBtn').onclick = () => showMain();
const wallpaperElementList = [
  document.getElementById('wallpaperA'),
  document.getElementById('wallpaperB')
];
if (wallpaperElementList[0].getAttribute('src')) {
  hasAppliedWallpaper = true;
  currentWallpaperUrl = wallpaperElementList[0].src;
  currentPath = wallpaperElementList[0].dataset.path;
}
const dislikeBtn = document.getElementById('dislikeBtn');
const exportBtn = document.getElementById('exportBtn');
const settingsBtn = document.getElementById('settingsBtn');
const rescanBtn = document.getElementById('rescanBtn');
const toastEl = document.getElementById('toast');
const syncHintEl = document.getElementById('syncHint');
const importStatusEl = document.getElementById('importStatus');
const importStatusTextEl = document.getElementById('importStatusText');

pickBtn.onclick = async () => {
  if (supportsDirectoryPicker()) {
    await pickDirectoryWithHandle();
    return;
  }

  showToast('当前浏览器不支持直接读取目录，请换用较新的 Chromium 浏览器');
};

restoreBtn.onclick = async () => {
  await restoreDirectoryPermission();
};

folderInput.onchange = async () => {
  showToast('请使用“选择文件夹”按钮重新授权壁纸目录');
};

async function pickDirectoryWithHandle() {
  setImporting(true);

  try {
    updateImportStatus('正在选择壁纸文件夹…');
    const dirHandle = await window.showDirectoryPicker({ mode: 'read' });
    updateImportStatus('正在扫描壁纸文件夹… 已发现 0 张图片');
    const fileEntryList = await scanWallpaperDirectory(dirHandle, count => {
      if (count === 1 || count % 100 === 0) {
        updateImportStatus(`正在扫描壁纸文件夹… 已发现 ${count} 张图片`);
      }
    });

    if (!fileEntryList.length) {
      setImporting(false);
      showToast('所选文件夹里没有可用图片');
      return;
    }

    wallpaperDirectoryHandle = dirHandle;
    needsPermissionRestore = false;
    await saveWallpaperDirectoryHandle(dirHandle);

    updateImportStatus(`正在保存索引… 共发现 ${fileEntryList.length} 张图片`);
    await chrome.storage.local.set({
      files: fileEntryList,
      dislikedPaths: [],
      [WALLPAPER_FAILURE_COUNT_KEY]: 0,
      [WALLPAPER_UNPLAYED_QUEUE_KEY]: shuffle(fileEntryList),
      [WALLPAPER_PLAYED_PATHS_KEY]: []
    });

    setImporting(false);
    hideSyncHint();

    showToast(`已导入 ${fileEntryList.length} 张壁纸`);
    updateSetupActions();
    await showMain();
  } catch (error) {
    setImporting(false);

    if (error?.name === 'AbortError') {
      return;
    }

    console.error('Pick directory failed:', error);
    showToast('选择文件夹失败，请重试');
  }
}

async function restoreDirectoryPermission() {
  try {
    const storedHandle = wallpaperDirectoryHandle || await loadWallpaperDirectoryHandle();

    if (storedHandle) {
      const granted = await ensureWallpaperPermissionFromUserGesture(storedHandle);
      if (granted) {
        wallpaperDirectoryHandle = storedHandle;
        needsPermissionRestore = false;
        updateSetupActions();
        showToast('壁纸目录授权已恢复');
        await showMain();
        return;
      }
    }
  } catch (error) {
    console.warn('Restore wallpaper directory permission failed:', error);
  }

  showToast('恢复授权失败，请重新选择文件夹');
}

async function* walkDirectory(dirHandle, prefix = '') {
  for await (const [name, handle] of dirHandle.entries()) {
    const relativePath = prefix ? `${prefix}/${name}` : name;

    if (handle.kind === 'directory') {
      yield* walkDirectory(handle, relativePath);
      continue;
    }

    if (IMG_EXTS.some(ext => name.toLowerCase().endsWith(ext))) {
      yield relativePath;
    }
  }
}

async function scanWallpaperDirectory(dirHandle, onProgress) {
  const fileEntryList = [];

  for await (const relativePath of walkDirectory(dirHandle)) {
    fileEntryList.push(relativePath);
    onProgress?.(fileEntryList.length);
  }

  return fileEntryList;
}

function supportsDirectoryPicker() {
  return typeof window.showDirectoryPicker === 'function';
}

function setImporting(isImporting) {
  pickBtn.disabled = isImporting;
  restoreBtn.disabled = isImporting;
  importStatusEl.hidden = !isImporting;

  if (!isImporting) {
    importStatusTextEl.textContent = '正在扫描壁纸文件夹…';
  }
}

function updateImportStatus(message) {
  importStatusTextEl.textContent = message;
}

async function showMain() {
  if (wallpaperOperationRunning) {
    wallpaperRefreshPending = true;
    return;
  }
  wallpaperOperationRunning = true;
  rescanBtn.disabled = true;
  setupEl.hidden = true;
  mainEl.hidden = false;

  try {
    if (await loadRandomWallpaper() === false) {
      mainEl.hidden = true;
      setupEl.hidden = false;
    }
  } catch (error) {
    console.error('Load wallpaper failed:', error);

    if (error?.code === 'WALLPAPER_PERMISSION_REQUIRED') {
      mainEl.hidden = true;
      setupEl.hidden = false;
      needsPermissionRestore = true;
      updateSetupActions();
      showToast('请先恢复原目录授权，或直接重新选择文件夹');
      return;
    }

    if (error?.code === 'WALLPAPER_DIRECTORY_MISSING') {
      mainEl.hidden = true;
      setupEl.hidden = false;
      needsPermissionRestore = false;
      updateSetupActions();
      showToast('壁纸目录已失效，请重新选择文件夹');
      return;
    }

    if (error?.code === 'WALLPAPER_NO_VALID_FILES') {
      showToast('当前文件夹中没有可读取的图片，请检查图片文件');
      return;
    }

    showToast('壁纸加载失败，已自动尝试其他图片');
  } finally {
    wallpaperOperationRunning = false;
    wallpaperInitialized = true;
    rescanBtn.disabled = false;
    flushWallpaperRefresh();
  }
}

async function loadRandomWallpaper({ skipFailureScan = false } = {}) {
  const { files: fileList = [] } = await chrome.storage.local.get('files');
  if (!fileList.length) {
    return false;
  }

  const failedItemList = [];
  const attemptedPathSet = new Set();

  for (let attempt = 0; attempt < MAX_WALLPAPER_LOAD_ATTEMPTS; attempt += 1) {
    // Directory access and queue selection are independent; don't serialize startup I/O.
    const [candidate, directory] = await Promise.all([
      navigator.locks.request('wallpaper-selection', async () => {
        const state = await prepareWallpaperCycle(fileList, false);
        return reserveWallpaperCandidate(attemptedPathSet, state);
      }),
      getWallpaperDirectoryHandle().then(handle => ({ handle }), error => ({ error }))
    ]);
    if (!candidate) {
      break;
    }

    const { path, isReplay } = candidate;
    attemptedPathSet.add(path);
    let fileUrl = null;

    try {
      if (directory.error) throw directory.error;
      fileUrl = await resolveWallpaperUrl(path, directory.handle);
      await applyWallpaper(fileUrl);
      currentPath = path;
      scheduleWallpaperPreview(path, fileUrl);

      try {
        const directoryChangeCount = countDirectoryChangeFailures(failedItemList);
        if (failedItemList.length) {
          await removeUnavailableWallpaperPaths(failedItemList);
        }
        if (directoryChangeCount && !skipFailureScan) {
          const shouldRescan = await handleWallpaperReadFailures(directoryChangeCount);
          if (shouldRescan) {
            await refreshWallpaperDirectory();
          }
        }
      } catch (error) {
        // Bookkeeping failure must not enter the image-failure path and revoke the displayed URL.
        console.warn('Wallpaper displayed, but directory bookkeeping failed:', error);
      }

      return true;
    } catch (error) {
      if (error?.code === 'WALLPAPER_PERMISSION_REQUIRED'
        || error?.code === 'WALLPAPER_DIRECTORY_MISSING'
        || error?.name === 'NotAllowedError') {
        if (error?.name === 'NotAllowedError') {
          error.code = 'WALLPAPER_PERMISSION_REQUIRED';
        }
        await releaseWallpaperCandidate(path, isReplay, error);
        throw error;
      }

      await releaseWallpaperCandidate(path, isReplay, error);
      failedItemList.push({ path, error });
      if (fileUrl?.startsWith('blob:')) {
        URL.revokeObjectURL(fileUrl);
      }
      console.warn('Skipping unavailable wallpaper:', { path, error });
    }
  }

  const directoryChangeCount = countDirectoryChangeFailures(failedItemList);
  if (failedItemList.length) {
    await removeUnavailableWallpaperPaths(failedItemList);
  }
  if (directoryChangeCount && !skipFailureScan) {
    const shouldRescan = await handleWallpaperReadFailures(directoryChangeCount);

    if (shouldRescan) {
      const refreshedFileList = await refreshWallpaperDirectory();
      if (refreshedFileList.length) {
        await loadRandomWallpaper({ skipFailureScan: true });
        return true;
      }
    }
  }

  const error = new Error('No readable wallpaper found');
  error.code = 'WALLPAPER_NO_VALID_FILES';
  throw error;
}

async function prepareWallpaperCycle(fileList, persist = true) {
  const result = await chrome.storage.local.get([
    WALLPAPER_UNPLAYED_QUEUE_KEY,
    WALLPAPER_PLAYED_PATHS_KEY,
    WALLPAPER_LAST_PATH_KEY
  ]);
  const validPathSet = new Set(fileList);
  const storedUnplayedPathList = Array.isArray(result[WALLPAPER_UNPLAYED_QUEUE_KEY])
    ? result[WALLPAPER_UNPLAYED_QUEUE_KEY]
    : [];
  const storedPlayedPathList = Array.isArray(result[WALLPAPER_PLAYED_PATHS_KEY])
    ? result[WALLPAPER_PLAYED_PATHS_KEY]
    : [];
  const playedSet = new Set(storedPlayedPathList.filter(path => validPathSet.has(path)));
  const knownPathSet = new Set([...storedUnplayedPathList, ...storedPlayedPathList]);

  let playedPathList = [...playedSet];
  let unplayedPathList = uniquePaths(
    storedUnplayedPathList.filter(path => validPathSet.has(path) && !playedSet.has(path))
  );

  const newPathList = fileList.filter(path => !knownPathSet.has(path));
  if (newPathList.length) {
    unplayedPathList.push(...shuffle(newPathList));
  }

  if (!unplayedPathList.length && fileList.length) {
    unplayedPathList = shuffle(fileList);
    playedPathList = [];
  }

  const state = {
    [WALLPAPER_UNPLAYED_QUEUE_KEY]: unplayedPathList,
    [WALLPAPER_PLAYED_PATHS_KEY]: playedPathList,
    [WALLPAPER_LAST_PATH_KEY]: result[WALLPAPER_LAST_PATH_KEY]
  };
  if (persist) {
    await chrome.storage.local.set({
      [WALLPAPER_UNPLAYED_QUEUE_KEY]: unplayedPathList,
      [WALLPAPER_PLAYED_PATHS_KEY]: playedPathList
    });
  }
  return state;
}

async function reserveWallpaperCandidate(attemptedPathSet, state) {
  const result = state ?? await chrome.storage.local.get([
    WALLPAPER_UNPLAYED_QUEUE_KEY,
    WALLPAPER_PLAYED_PATHS_KEY,
    WALLPAPER_LAST_PATH_KEY
  ]);
  const unplayedPathList = Array.isArray(result[WALLPAPER_UNPLAYED_QUEUE_KEY])
    ? result[WALLPAPER_UNPLAYED_QUEUE_KEY]
    : [];
  const playedPathList = Array.isArray(result[WALLPAPER_PLAYED_PATHS_KEY])
    ? result[WALLPAPER_PLAYED_PATHS_KEY]
    : [];
  const previousPath = currentPath ?? result[WALLPAPER_LAST_PATH_KEY];
  const replayCandidateList = playedPathList.filter(path => (
    path !== previousPath && !attemptedPathSet.has(path)
  ));

  if (replayCandidateList.length && Math.random() < WALLPAPER_REVISIT_PROBABILITY) {
    const path = randomItem(replayCandidateList);
    await chrome.storage.local.set({
      [WALLPAPER_UNPLAYED_QUEUE_KEY]: unplayedPathList,
      [WALLPAPER_PLAYED_PATHS_KEY]: playedPathList,
      [WALLPAPER_LAST_PATH_KEY]: path
    });
    return {
      path,
      isReplay: true
    };
  }

  const nextPath = unplayedPathList.find(path => path !== previousPath && !attemptedPathSet.has(path))
    ?? (!replayCandidateList.length ? unplayedPathList.find(path => !attemptedPathSet.has(path)) : null);
  if (!nextPath) {
    if (!replayCandidateList.length) return null;
    const path = randomItem(replayCandidateList);
    await chrome.storage.local.set({
      [WALLPAPER_UNPLAYED_QUEUE_KEY]: unplayedPathList,
      [WALLPAPER_PLAYED_PATHS_KEY]: playedPathList,
      [WALLPAPER_LAST_PATH_KEY]: path
    });
    return { path, isReplay: true };
  }

  const nextUnplayedPathList = unplayedPathList.filter(path => path !== nextPath);
  const nextPlayedPathList = playedPathList.includes(nextPath)
    ? playedPathList
    : [...playedPathList, nextPath];

  await chrome.storage.local.set({
    [WALLPAPER_UNPLAYED_QUEUE_KEY]: nextUnplayedPathList,
    [WALLPAPER_PLAYED_PATHS_KEY]: nextPlayedPathList,
    [WALLPAPER_LAST_PATH_KEY]: nextPath
  });

  return {
    path: nextPath,
    isReplay: false
  };
}

async function releaseWallpaperCandidate(path, isReplay, error) {
  if (isReplay) {
    return;
  }

  const result = await chrome.storage.local.get([
    WALLPAPER_UNPLAYED_QUEUE_KEY,
    WALLPAPER_PLAYED_PATHS_KEY
  ]);
  const unplayedPathList = Array.isArray(result[WALLPAPER_UNPLAYED_QUEUE_KEY])
    ? result[WALLPAPER_UNPLAYED_QUEUE_KEY]
    : [];
  const playedPathList = Array.isArray(result[WALLPAPER_PLAYED_PATHS_KEY])
    ? result[WALLPAPER_PLAYED_PATHS_KEY]
    : [];
  const nextPlayedPathList = playedPathList.filter(item => item !== path);

  if (!isUnavailableWallpaperError(error) && !unplayedPathList.includes(path)) {
    unplayedPathList.push(path);
  }

  await chrome.storage.local.set({
    [WALLPAPER_UNPLAYED_QUEUE_KEY]: unplayedPathList,
    [WALLPAPER_PLAYED_PATHS_KEY]: nextPlayedPathList
  });
}

function uniquePaths(pathList) {
  return [...new Set(pathList)];
}

function randomItem(itemList) {
  return itemList[Math.floor(Math.random() * itemList.length)];
}

function countDirectoryChangeFailures(failedItemList) {
  return failedItemList.filter(({ error }) => isDirectoryChangeError(error)).length;
}

function isDirectoryChangeError(error) {
  return ['NotFoundError', 'TypeMismatchError', 'InvalidStateError'].includes(error?.name);
}

async function handleWallpaperReadFailures(failureCount) {
  const result = await chrome.storage.local.get(WALLPAPER_FAILURE_COUNT_KEY);
  const previousCount = Number(result[WALLPAPER_FAILURE_COUNT_KEY]) || 0;
  const nextCount = previousCount + failureCount;
  const shouldRescan = nextCount >= WALLPAPER_FAILURE_SCAN_THRESHOLD;

  await chrome.storage.local.set({
    [WALLPAPER_FAILURE_COUNT_KEY]: shouldRescan ? 0 : nextCount
  });

  if (shouldRescan) {
    showSyncHint('检测到目录变化，正在更新壁纸目录…', true, 2600);
    return true;
  }

  showSyncHint(`检测到目录变化 ${nextCount}/${WALLPAPER_FAILURE_SCAN_THRESHOLD}`, false, 2600);
  return false;
}

async function refreshWallpaperDirectory({ manual = false } = {}) {
  try {
    const handle = await getWallpaperDirectoryHandle();
    if (!handle) {
      const error = new Error('Wallpaper directory handle unavailable');
      error.code = 'WALLPAPER_DIRECTORY_MISSING';
      throw error;
    }

    const { files: previousFileList = [] } = await chrome.storage.local.get('files');
    const refreshedFileList = await scanWallpaperDirectory(handle);
    const previousPathSet = new Set(previousFileList);
    const refreshedPathSet = new Set(refreshedFileList);
    const addedCount = refreshedFileList.filter(path => !previousPathSet.has(path)).length;
    const removedCount = previousFileList.filter(path => !refreshedPathSet.has(path)).length;
    await chrome.storage.local.set({
      files: refreshedFileList,
      [WALLPAPER_FAILURE_COUNT_KEY]: 0
    });
    await prepareWallpaperCycle(refreshedFileList);
    showSyncHint(`目录重扫完成：新增${addedCount}张，移除${removedCount}张，共${refreshedFileList.length}张`, false, 8000);
    return refreshedFileList;
  } catch (error) {
    if (manual || error?.code === 'WALLPAPER_PERMISSION_REQUIRED'
      || error?.code === 'WALLPAPER_DIRECTORY_MISSING') {
      throw error;
    }
    console.warn('Refresh wallpaper directory failed:', error);
    showSyncHint('壁纸目录更新失败，将在下次累计达到 10 次时重试', false, 2600);
    return [];
  }
}

function shuffle(itemList) {
  const shuffledList = [...itemList];

  for (let index = shuffledList.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [shuffledList[index], shuffledList[randomIndex]] = [shuffledList[randomIndex], shuffledList[index]];
  }

  return shuffledList;
}

async function removeUnavailableWallpaperPaths(failedItemList) {
  const unavailablePathList = failedItemList
    .filter(({ error }) => isUnavailableWallpaperError(error))
    .map(({ path }) => path);

  if (!unavailablePathList.length) {
    return;
  }

  const unavailableSet = new Set(unavailablePathList);
  const result = await chrome.storage.local.get([
    'files',
    WALLPAPER_UNPLAYED_QUEUE_KEY,
    WALLPAPER_PLAYED_PATHS_KEY
  ]);
  const fileList = result.files || [];
  const validFileList = fileList.filter(path => !unavailableSet.has(path));
  const unplayedPathList = Array.isArray(result[WALLPAPER_UNPLAYED_QUEUE_KEY])
    ? result[WALLPAPER_UNPLAYED_QUEUE_KEY].filter(path => !unavailableSet.has(path))
    : [];
  const playedPathList = Array.isArray(result[WALLPAPER_PLAYED_PATHS_KEY])
    ? result[WALLPAPER_PLAYED_PATHS_KEY].filter(path => !unavailableSet.has(path))
    : [];

  if (validFileList.length !== fileList.length) {
    await chrome.storage.local.set({
      files: validFileList,
      [WALLPAPER_UNPLAYED_QUEUE_KEY]: unplayedPathList,
      [WALLPAPER_PLAYED_PATHS_KEY]: playedPathList
    });
  }
}

function isUnavailableWallpaperError(error) {
  return ['NotFoundError', 'TypeMismatchError', 'InvalidStateError'].includes(error?.name)
    || error?.message?.startsWith('Image failed to load:');
}

async function resolveWallpaperUrl(relativePath, handle = null) {
  if (handle) {
    const file = await getFileFromRelativePath(handle, relativePath);
    return URL.createObjectURL(file);
  }

  const error = new Error(`Directory handle unavailable for ${relativePath}`);
  error.code = 'WALLPAPER_DIRECTORY_MISSING';
  throw error;
}

async function getWallpaperDirectoryHandle() {
  if (wallpaperDirectoryHandle) {
    const permission = await wallpaperDirectoryHandle.queryPermission({ mode: 'read' });
    if (permission === 'granted') {
      return wallpaperDirectoryHandle;
    }

    wallpaperDirectoryHandle = null;
  }

  const handle = await loadWallpaperDirectoryHandle();

  if (!handle) {
    return null;
  }

  const permission = await handle.queryPermission({ mode: 'read' });
  if (permission !== 'granted') {
    const error = new Error('Wallpaper directory permission required');
    error.code = 'WALLPAPER_PERMISSION_REQUIRED';
    throw error;
  }

  wallpaperDirectoryHandle = handle;
  return handle;
}

async function ensureWallpaperPermissionFromUserGesture(handle) {
  const permission = await handle.queryPermission({ mode: 'read' });
  if (permission === 'granted') {
    return true;
  }

  const requested = await handle.requestPermission({ mode: 'read' });
  return requested === 'granted';
}

function openWallpaperDb() {
  if (wallpaperDbPromise) {
    return wallpaperDbPromise;
  }

  wallpaperDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(WALLPAPER_DB_NAME, WALLPAPER_DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(WALLPAPER_STORE_NAME)) {
        db.createObjectStore(WALLPAPER_STORE_NAME);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return wallpaperDbPromise;
}

async function saveWallpaperDirectoryHandle(handle) {
  const db = await openWallpaperDb();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(WALLPAPER_STORE_NAME, 'readwrite');
    const store = tx.objectStore(WALLPAPER_STORE_NAME);
    const request = store.put(handle, WALLPAPER_HANDLE_KEY);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function loadWallpaperDirectoryHandle() {
  const db = await openWallpaperDb();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(WALLPAPER_STORE_NAME, 'readonly');
    const store = tx.objectStore(WALLPAPER_STORE_NAME);
    const request = store.get(WALLPAPER_HANDLE_KEY);

    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function getFileFromRelativePath(rootHandle, relativePath) {
  const segmentList = relativePath.split('/').filter(Boolean);
  let currentHandle = rootHandle;

  for (let index = 0; index < segmentList.length - 1; index += 1) {
    currentHandle = await currentHandle.getDirectoryHandle(segmentList[index]);
  }

  const fileHandle = await currentHandle.getFileHandle(segmentList[segmentList.length - 1]);
  return fileHandle.getFile();
}

async function applyWallpaper(fileUrl) {
  const nextIndex = activeWallpaperIndex === 0 ? 1 : 0;
  const currentWallpaperEl = wallpaperElementList[activeWallpaperIndex];
  const nextWallpaperEl = wallpaperElementList[nextIndex];
  const targetEl = hasAppliedWallpaper ? nextWallpaperEl : currentWallpaperEl;
  targetEl.classList.remove('is-visible', 'is-entering');
  targetEl.src = fileUrl;
  try {
    // Decode the actual displayed image, rather than a disposable preload Image followed by a CSS reload.
    await targetEl.decode();
  } catch {
    targetEl.removeAttribute('src');
    throw new Error(`Image failed to load: ${fileUrl}`);
  }

  if (!hasAppliedWallpaper || !currentWallpaperEl.naturalWidth) {
    targetEl.classList.add('is-visible');
    if (targetEl !== currentWallpaperEl) {
      currentWallpaperEl.classList.remove('is-visible');
      currentWallpaperEl.removeAttribute('src');
      activeWallpaperIndex = nextIndex;
    }
    currentWallpaperUrl = fileUrl;
    hasAppliedWallpaper = true;
    document.documentElement.style.background = FALLBACK_BG;
    return;
  }

  const previousUrl = currentWallpaperUrl;
  // Keep the old image fully opaque underneath; fading both layers exposes the page background.
  currentWallpaperEl.style.zIndex = '0';
  nextWallpaperEl.style.zIndex = '1';
  nextWallpaperEl.classList.add('is-entering');

  await new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });

  await new Promise(resolve => {
    let timer;
    const finish = () => {
      clearTimeout(timer);
      nextWallpaperEl.removeEventListener('transitionend', onTransitionEnd);
      resolve();
    };
    const onTransitionEnd = event => {
      if (event.target === nextWallpaperEl && event.propertyName === 'opacity') finish();
    };
    nextWallpaperEl.addEventListener('transitionend', onTransitionEnd);
    nextWallpaperEl.classList.add('is-visible');
    // A hidden tab or disabled transition may not dispatch transitionend.
    const duration = parseFloat(getComputedStyle(nextWallpaperEl).transitionDuration) * 1000 || 0;
    timer = setTimeout(finish, duration + 100);
  });

  // Finish the incoming layer before clearing the old one, including the timeout path.
  nextWallpaperEl.classList.remove('is-entering');
  currentWallpaperEl.classList.remove('is-visible');
  currentWallpaperEl.removeAttribute('src');
  activeWallpaperIndex = nextIndex;
  currentWallpaperUrl = fileUrl;
  if (previousUrl?.startsWith('blob:') && previousUrl !== fileUrl) {
    URL.revokeObjectURL(previousUrl);
  }
}

function scheduleWallpaperPreview(path, fileUrl) {
  const image = wallpaperElementList[activeWallpaperIndex];
  const save = () => {
    if (currentPath !== path || image.src !== fileUrl || !image.naturalWidth) return;
    try {
      const scale = Math.min(1, 1280 / image.naturalWidth, 720 / image.naturalHeight);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      const preview = JSON.stringify({ path, image: canvas.toDataURL('image/webp', 0.75) });
      if (preview.length <= 512 * 1024) localStorage.setItem('wallpaperStartupPreview', preview);
    } catch {
      // A full/disabled cache does not affect displaying the original image.
    }
  };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(save, { timeout: 1500 });
  else setTimeout(save, 200);
}

dislikeBtn.onclick = async () => {
  if (!currentPath) {
    return;
  }

  const { dislikedPaths: dislikedPathList = [] } = await chrome.storage.local.get('dislikedPaths');
  if (dislikedPathList.includes(currentPath)) {
    showToast('已标记过此壁纸');
    return;
  }

  dislikedPathList.push(currentPath);
  await chrome.storage.local.set({ dislikedPaths: dislikedPathList });
  showToast('已标记为不喜欢');
};

exportBtn.onclick = async () => {
  const { dislikedPaths: dislikedPathList = [] } = await chrome.storage.local.get('dislikedPaths');
  if (!dislikedPathList.length) {
    showToast('暂无已标记的壁纸');
    return;
  }

  try {
    await navigator.clipboard.writeText(dislikedPathList.join('\n'));
    await chrome.storage.local.set({ dislikedPaths: [] });
    showToast(`已导出 ${dislikedPathList.length} 条路径，并清空标记`);
  } catch (error) {
    console.error('Export disliked wallpapers failed:', error);
    showToast('导出失败，标记已保留');
  }
};

rescanBtn.onclick = async () => {
  if (wallpaperOperationRunning) return;
  wallpaperOperationRunning = true;
  rescanBtn.disabled = true;
  showSyncHint('正在重新扫描壁纸目录…', true);
  try {
    await refreshWallpaperDirectory({ manual: true });
  } catch (error) {
    console.warn('Manual wallpaper rescan failed:', error);
    const permissionRequired = error?.code === 'WALLPAPER_PERMISSION_REQUIRED' || error?.name === 'NotAllowedError';
    if (permissionRequired) {
      needsPermissionRestore = true;
      mainEl.hidden = true;
      setupEl.hidden = false;
      updateSetupActions();
    }
    showSyncHint(permissionRequired ? '目录重扫失败，请先恢复原目录授权' : '目录重扫失败，请检查目录或重新选择文件夹', false, 8000);
  } finally {
    wallpaperOperationRunning = false;
    rescanBtn.disabled = false;
    flushWallpaperRefresh();
  }
};

function requestWallpaperRefresh() {
  wallpaperRefreshPending = true;
  flushWallpaperRefresh();
}

function flushWallpaperRefresh() {
  if (!wallpaperRefreshPending || wallpaperOperationRunning || wallpaperRefreshTimer
    || document.visibilityState !== 'visible' || mainEl.hidden) return;
  // Coalesce the explicit reuse notification and its visibility event into one switch.
  wallpaperRefreshTimer = setTimeout(() => {
    wallpaperRefreshTimer = null;
    if (document.visibilityState !== 'visible' || mainEl.hidden || wallpaperOperationRunning) return;
    wallpaperRefreshPending = false;
    showMain();
  }, 80);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wallpaperInitialized && hasAppliedWallpaper && !mainEl.hidden) {
    requestWallpaperRefresh();
  }
});

chrome.tabs.getCurrent().then(tab => { wallpaperTabId = tab?.id; });
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || message?.type !== 'WALLPAPER_REFRESH'
    || message.tabId !== wallpaperTabId) return false;
  requestWallpaperRefresh();
  respond({ ok: true });
  return false;
});

settingsBtn.onclick = () => {
  mainEl.hidden = true;
  setupEl.hidden = false;
};

function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  setTimeout(() => toastEl.classList.remove('show'), 2000);
}

let syncHintTimer = null;

function showSyncHint(message, isBusy = false, hideAfterMs = 0) {
  if (!syncHintEl) {
    return;
  }

  if (syncHintTimer) {
    clearTimeout(syncHintTimer);
    syncHintTimer = null;
  }

  syncHintEl.textContent = message;
  syncHintEl.classList.toggle('is-busy', isBusy);
  syncHintEl.hidden = false;

  if (hideAfterMs > 0) {
    syncHintTimer = setTimeout(() => {
      syncHintEl.hidden = true;
      syncHintEl.classList.remove('is-busy');
      syncHintTimer = null;
    }, hideAfterMs);
  }
}

function hideSyncHint() {
  if (!syncHintEl) {
    return;
  }

  if (syncHintTimer) {
    clearTimeout(syncHintTimer);
    syncHintTimer = null;
  }

  syncHintEl.hidden = true;
  syncHintEl.classList.remove('is-busy');
}

function updateSetupActions() {
  restoreBtn.hidden = !needsPermissionRestore;
}

updateSetupActions();
showMain();
