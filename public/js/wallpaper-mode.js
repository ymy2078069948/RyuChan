// Explicit wallpaper mode only. Session storage keeps the layout after Astro navigation.
(function () {
  if (window.__ryuchanWallpaperModeLoaded) return;
  window.__ryuchanWallpaperModeLoaded = true;
  const key = 'ryuchan-wallpaper-mode';

  function syncMode() {
    const value = new URLSearchParams(location.search).get('wallpaper');
    try {
      if (value === '1') sessionStorage.setItem(key, '1');
      if (value === '0') sessionStorage.removeItem(key);
    } catch (_) { /* Private browsing may disable storage. */ }
    let stored = false;
    try { stored = sessionStorage.getItem(key) === '1'; } catch (_) { /* no storage */ }
    const enabled = value === '1' || (value !== '0' && stored);
    if (enabled) document.documentElement.setAttribute('data-wallpaper-mode', 'on');
    else document.documentElement.removeAttribute('data-wallpaper-mode');
    const editor = /^\/(?:config|write|about-edit|projects-edit|friends-edit|navigation-edit)(?:\/|$)/.test(location.pathname);
    if (enabled && editor) document.documentElement.setAttribute('data-wallpaper-editor', 'on');
    else document.documentElement.removeAttribute('data-wallpaper-editor');
  }

  document.addEventListener('click', function (event) {
    const button = event.target.closest?.('[data-wallpaper-scroll]');
    if (!button || document.documentElement.getAttribute('data-wallpaper-mode') !== 'on') return;
    const direction = button.getAttribute('data-wallpaper-scroll') === 'up' ? -1 : 1;
    window.scrollBy({ top: direction * Math.round(window.innerHeight * .75), behavior: 'smooth' });
  });
  document.addEventListener('astro:after-swap', syncMode);
  document.addEventListener('astro:page-load', syncMode);
  syncMode();
})();
