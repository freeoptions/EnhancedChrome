'use strict';

// A single bounded local preview covers startup I/O and short-lived duplicate tabs.
// Load it before newtab.js starts directory/queue work; no network request is involved.
try {
  const cached = localStorage.getItem('wallpaperStartupPreview');
  if (cached && cached.length <= 512 * 1024) {
    const preview = JSON.parse(cached);
    if (typeof preview.path === 'string' && typeof preview.image === 'string'
      && preview.image.startsWith('data:image/webp;base64,')) {
      const image = document.getElementById('wallpaperA');
      image.src = preview.image;
      image.dataset.path = preview.path;
      image.classList.add('is-visible');
    }
  }
} catch {
  // Cache access/decoding must never prevent loading the source wallpaper.
}
