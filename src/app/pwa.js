// App packaging (browser module): service worker registration and the "Update ready" toast,
// the install button (Chrome's beforeinstallprompt) or hint (Safari: File → Add to Dock),
// display-mode detection for the installed app, and full screen (F) with Esc handled by the app.
//
// The pure helpers (displayModeOf, installKindOf, browserOf) are exported for tests.

/** 'fullscreen' | 'standalone' | 'minimal-ui' | 'window-controls-overlay' | 'browser' */
export function displayModeOf(matches) {
  for (const m of ['fullscreen', 'standalone', 'minimal-ui', 'window-controls-overlay']) {
    if (matches(`(display-mode: ${m})`)) return m;
  }
  return 'browser';
}

/** Browser family from a user agent: 'chrome' (Chromium: Chrome, Edge, Arc, Brave), 'safari', 'firefox', 'other'. */
export function browserOf(ua = '') {
  if (/Firefox\//.test(ua)) return 'firefox';
  if (/(Chrome|Chromium|CriOS|Edg)\//.test(ua)) return 'chrome';
  if (/Safari\//.test(ua) && /Version\//.test(ua)) return 'safari';
  return 'other';
}

/**
 * What the install UI should offer.
 * @param {{ installed: boolean, promptReady: boolean, browser: string, justInstalled?: boolean }} s
 * @returns {'installed'|'prompt'|'done'|'safari'|'chrome'|'none'}
 *   installed: running as the app · prompt: Chrome can install now (button) · done: installed
 *   from this tab · safari / chrome: manual steps · none: no install path in this browser
 */
export function installKindOf({ installed, promptReady, browser, justInstalled = false }) {
  if (installed) return 'installed';
  if (justInstalled) return 'done';
  if (promptReady) return 'prompt';
  if (browser === 'safari') return 'safari';
  if (browser === 'chrome') return 'chrome';
  return 'none';
}

/** Running as the installed app: launched from its start_url (?source=app) or an app display mode. */
export function isInstalledApp({ search = '', mode = 'browser', navigatorStandalone = false, fullscreenElement = null, menubarVisible = true } = {}) {
  if (navigatorStandalone) return true;
  if (/[?&]source=app(&|$)/.test(search)) return true;
  if (mode === 'standalone' || mode === 'minimal-ui' || mode === 'window-controls-overlay') return true;
  // A browser tab in full screen also matches (display-mode: fullscreen); an app window has no
  // menu bar and no element in full screen.
  return mode === 'fullscreen' && !fullscreenElement && menubarVisible === false;
}

/**
 * @param {{ ui: object, isPlaying: () => boolean, onFullscreenExit: () => void, swUrl?: string }} o
 */
export function initPwa({ ui, isPlaying = () => false, onFullscreenExit = () => {}, swUrl = './sw.js' }) {
  const mq = (q) => typeof matchMedia === 'function' && matchMedia(q).matches;
  const params = new URLSearchParams(location.search);
  const state = {
    mode: displayModeOf(mq),
    installed: false,
    browser: browserOf(navigator.userAgent),
    promptEvent: null,
    justInstalled: false,
    kind: 'none',
    sw: { supported: 'serviceWorker' in navigator && window.isSecureContext, registration: null, version: null, offlineReady: false, updateReady: false, error: null },
  };
  let reloading = false;

  function refresh() {
    state.mode = displayModeOf(mq);
    state.installed = isInstalledApp({
      search: location.search, mode: state.mode, navigatorStandalone: navigator.standalone === true, fullscreenElement: document.fullscreenElement,
      menubarVisible: window.menubar ? window.menubar.visible : true,
    });
    state.kind = installKindOf({ installed: state.installed, promptReady: !!state.promptEvent, browser: state.browser, justInstalled: state.justInstalled });
    const root = document.documentElement;
    root.dataset.display = state.mode;
    if (state.installed) root.dataset.app = 'installed';
    else delete root.dataset.app;
    if (ui && typeof ui.setInstall === 'function') ui.setInstall({ kind: state.kind, onInstall: install });
  }

  async function install() {
    const ev = state.promptEvent;
    if (!ev) {
      if (ui) ui.toast(state.browser === 'safari' ? 'Safari: File → Add to Dock' : 'Chrome: ⋮ → Cast, save and share → Install page as app', { duration: 6000 });
      return false;
    }
    try {
      await ev.prompt(); // needs a real click or key press (a hand-cursor dwell is not one)
    } catch {
      if (ui) ui.toast('Click “Install Víbora” with the mouse, or press Enter on it');
      return false;
    }
    state.promptEvent = null;
    const choice = await Promise.resolve(ev.userChoice).catch(() => null);
    if (choice && choice.outcome === 'accepted') state.justInstalled = true;
    refresh();
    return state.justInstalled;
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // show our own button instead of the mini-infobar
    state.promptEvent = e;
    refresh();
  });
  window.addEventListener('appinstalled', () => {
    state.promptEvent = null;
    state.justInstalled = true;
    refresh();
    if (ui) ui.toast('Víbora is installed · open it from the Dock or Launchpad', { duration: 6000 });
  });
  for (const m of ['fullscreen', 'standalone', 'minimal-ui']) {
    if (typeof matchMedia === 'function') {
      const q = matchMedia(`(display-mode: ${m})`);
      if (q.addEventListener) q.addEventListener('change', refresh);
    }
  }

  // ---- Full screen: F toggles; while in full screen Esc reaches the app (pause / back) and
  // holding Esc leaves full screen (Keyboard Lock, Chrome). Leaving full screen pauses play.
  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      } else if (document.documentElement.webkitRequestFullscreen) {
        document.documentElement.webkitRequestFullscreen();
      }
    } catch {
      if (ui) ui.toast('Full screen: ⌃⌘F (View → Enter Full Screen)');
    }
  }
  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    if (e.key !== 'f' && e.key !== 'F') return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ''))) return;
    toggleFullscreen();
  });
  document.addEventListener('fullscreenchange', () => {
    const kb = navigator.keyboard;
    if (document.fullscreenElement) {
      if (kb && kb.lock) kb.lock(['Escape']).catch(() => {});
    } else {
      if (kb && kb.unlock) kb.unlock();
      if (isPlaying()) onFullscreenExit();
    }
    refresh();
  });

  // ---- Service worker -----------------------------------------------------------------------
  function onUpdateReady(reg) {
    if (state.sw.updateReady) return;
    state.sw.updateReady = true;
    if (ui && typeof ui.updateReady === 'function') {
      ui.updateReady(() => {
        const w = reg.waiting;
        if (!w) {
          location.reload();
          return;
        }
        reloading = true;
        w.postMessage({ type: 'SKIP_WAITING' });
        setTimeout(() => location.reload(), 3000); // controllerchange normally reloads first
      });
    }
  }

  function trackInstalling(reg, w) {
    if (!w) return;
    w.addEventListener('statechange', () => {
      if (w.state === 'installed' && navigator.serviceWorker.controller) onUpdateReady(reg);
    });
  }

  /** First visit: the page loaded before the worker existed; hand it the list of what it used. */
  function sendLoadedResources(sw) {
    if (!sw || typeof performance === 'undefined' || !performance.getEntriesByType) return;
    const urls = performance.getEntriesByType('resource').map((r) => r.name).filter((u) => u.startsWith(location.origin));
    sw.postMessage({ type: 'CACHE_URLS', urls });
  }

  async function register() {
    if (!state.sw.supported || params.get('sw') === '0') return;
    const firstVisit = !navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) {
        reloading = false;
        location.reload();
      } else if (firstVisit) {
        sendLoadedResources(navigator.serviceWorker.controller);
      }
    });
    navigator.serviceWorker.addEventListener('message', (e) => {
      const m = e.data || {};
      if (m.type === 'vibora-sw-ready') {
        state.sw.version = m.version;
        state.sw.offlineReady = true;
        if (firstVisit && ui) ui.toast('Saved for offline play · funciona sin conexión');
      }
    });
    try {
      const reg = await navigator.serviceWorker.register(swUrl, { scope: './', updateViaCache: 'none' });
      state.sw.registration = reg;
      if (reg.waiting && navigator.serviceWorker.controller) onUpdateReady(reg);
      trackInstalling(reg, reg.installing);
      reg.addEventListener('updatefound', () => trackInstalling(reg, reg.installing));
      const check = () => reg.update().catch(() => {});
      setInterval(check, 60 * 60 * 1000);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
      if (!firstVisit && reg.active) state.sw.offlineReady = true;
    } catch (err) {
      state.sw.error = String(err && err.message ? err.message : err);
    }
  }

  refresh();
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', () => register(), { once: true });

  return {
    state,
    install,
    refresh,
    toggleFullscreen,
    /** Resolves with the worker's cache status (tests): { version, precached, total, missing }. */
    swStatus() {
      const c = navigator.serviceWorker && navigator.serviceWorker.controller;
      if (!c) return Promise.resolve(null);
      return new Promise((resolve) => {
        const ch = new MessageChannel();
        ch.port1.onmessage = (e) => resolve(e.data);
        c.postMessage({ type: 'STATUS' }, [ch.port2]);
        setTimeout(() => resolve(null), 5000);
      });
    },
  };
}
