// App packaging (PWA): manifest, icons, service worker precache list and routing, install helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { displayModeOf, browserOf, installKindOf, isInstalledApp } from '../src/app/pwa.js';
import { buildPrecache, EXTRA } from '../tools/precache.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFile(join(ROOT, p), 'utf8');
const exists = (p) => stat(join(ROOT, p)).then(() => true, () => false);

async function pngSize(p) {
  const b = await readFile(join(ROOT, p));
  assert.equal(b.toString('ascii', 1, 4), 'PNG', `${p} is a PNG`);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

test('manifest: app identity, sub-path-safe URLs, display and colours', async () => {
  const m = JSON.parse(await read('manifest.webmanifest'));
  assert.equal(m.name, 'Víbora Padel');
  assert.equal(m.short_name, 'Víbora');
  assert.equal(m.start_url, './?source=app');
  assert.equal(m.scope, './');
  assert.equal(m.id, './');
  assert.equal(m.display, 'fullscreen');
  assert.deepEqual(m.display_override, ['fullscreen', 'standalone']);
  assert.equal(m.orientation, 'any'); // portrait allowed on phones (swipe mode shows a rotate hint)
  assert.deepEqual(m.categories, ['sports', 'games', 'health']);
  assert.ok(m.description.length > 20);
  for (const k of ['background_color', 'theme_color']) assert.match(m[k], /^#[0-9a-f]{6}$/i);
  const html = await read('index.html');
  assert.ok(html.includes(`<meta name="theme-color" content="${m.theme_color}">`), 'theme colour matches index.html');
  for (const u of [m.start_url, m.scope, ...m.icons.map((i) => i.src)]) assert.ok(!u.startsWith('/'), `${u} is relative (GitHub Pages sub-path)`);
});

test('manifest icons exist with the declared sizes (192, 512, maskable 512, SVG)', async () => {
  const m = JSON.parse(await read('manifest.webmanifest'));
  const purposes = new Set();
  for (const ic of m.icons) {
    assert.ok(await exists(ic.src), `${ic.src} exists`);
    purposes.add(`${ic.purpose}:${ic.sizes}`);
    if (ic.type === 'image/png') {
      const [w, h] = await pngSize(ic.src);
      assert.equal(`${w}x${h}`, ic.sizes, ic.src);
    } else {
      assert.equal(ic.type, 'image/svg+xml');
      assert.match(await read(ic.src), /<svg[^>]+viewBox="0 0 512 512"/);
    }
  }
  for (const need of ['any:192x192', 'any:512x512', 'maskable:512x512', 'any:any']) assert.ok(purposes.has(need), need);
  assert.deepEqual(await pngSize('icons/apple-touch-icon.png'), [180, 180]);
  assert.deepEqual(await pngSize('icons/favicon-32.png'), [32, 32]);
});

test('index.html links the manifest, icons and Safari web-app meta', async () => {
  const html = await read('index.html');
  for (const s of ['rel="manifest" href="./manifest.webmanifest"', 'rel="apple-touch-icon" href="./icons/apple-touch-icon.png"',
    'name="apple-mobile-web-app-capable" content="yes"', 'name="apple-mobile-web-app-title" content="Víbora"', 'rel="icon" href="./icons/favicon.svg"']) {
    assert.ok(html.includes(s), s);
  }
});

test('precache list: shell, every module, SIMD wasm and the default full model; nothing from dev/tests/tools', async () => {
  const { entries, version, bytes } = await buildPrecache();
  const paths = entries.map((e) => e[0]);
  for (const p of EXTRA) assert.ok(paths.includes(p), p);
  for (const p of ['src/main.js', 'src/app/pwa.js', 'vendor/three/three.module.js', 'vendor/three/three.core.js', 'assets/hands/left.glb',
    'assets/hands/right.glb', 'icons/icon-512.png', 'vendor/three/addons/loaders/GLTFLoader.js']) assert.ok(paths.includes(p), p);
  assert.ok(paths.some((p) => p.startsWith('fonts/') && p.endsWith('.woff2')));
  assert.ok(!paths.some((p) => /^(dev|tests|tools|docs)\//.test(p) || p === 'sw.js'), 'no dev files');
  assert.ok(!paths.includes('models/pose_landmarker_heavy.task'), 'heavy model is runtime-cached only');
  assert.ok(!paths.some((p) => p.includes('nosimd')), 'non-SIMD wasm is runtime-cached only');
  assert.equal(new Set(paths).size, paths.length);
  assert.match(version, /^[0-9a-f]{10}$/);
  assert.ok(bytes > 15e6 && bytes < 60e6, `${(bytes / 1e6).toFixed(1)} MB`);
});

test('sw.js: its precache list names only existing site files, including the critical ones', async () => {
  const text = await read('sw.js');
  assert.match(text, /const VERSION = '[^']+';/);
  const list = [...text.matchAll(/^ {2}\['([^']+)', '([0-9a-f]+)'\],$/gm)].map((m) => m[1]);
  assert.ok(list.length > 50, `${list.length} entries`);
  for (const p of EXTRA) assert.ok(list.includes(p), `${p} precached`);
  for (const p of EXTRA) assert.ok(await exists(p), `${p} exists`);
});

/** Loads sw.js in a fake ServiceWorkerGlobalScope served from https://example.github.io/vibora-padel/. */
async function loadSw() {
  const listeners = {};
  const self = {
    location: new URL('https://example.github.io/vibora-padel/sw.js'),
    addEventListener: (t, fn) => { listeners[t] = fn; },
    registration: { scope: 'https://example.github.io/vibora-padel/' },
    clients: { matchAll: async () => [], claim: async () => {} },
    skipWaiting: () => {},
  };
  const ctx = vm.createContext({ self, URL, Response, Request, Promise, setTimeout, caches: {}, fetch: async () => new Response('') });
  vm.runInContext(await read('sw.js'), ctx, { filename: 'sw.js' });
  const route = (url, { mode = 'cors', method = 'GET', headers = {} } = {}) => {
    let responded = false;
    listeners.fetch({
      request: { url, mode, method, headers: { has: (k) => k in headers } },
      respondWith: (p) => { responded = true; Promise.resolve(p).catch(() => {}); },
    });
    return responded;
  };
  return { listeners, route };
}

test('sw.js routing: same-origin site files only; googleapis telemetry and other origins are never touched', async () => {
  const { listeners, route } = await loadSw();
  for (const t of ['install', 'activate', 'fetch', 'message']) assert.equal(typeof listeners[t], 'function', t);
  const site = 'https://example.github.io/vibora-padel/';
  assert.equal(route('https://odml.pa.googleapis.com/v1/log', { method: 'POST' }), false);
  assert.equal(route('https://odml.pa.googleapis.com/v1/log'), false);
  assert.equal(route('https://fonts.googleapis.com/css2?family=x'), false);
  assert.equal(route('https://example.github.io/other-repo/index.html'), false, 'outside the scope');
  assert.equal(route(`${site}sw.js`), false);
  assert.equal(route(`${site}models/pose_landmarker_full.task`, { headers: { range: 'bytes=0-1' } }), false, 'range requests pass through');
  assert.equal(route(`${site}src/main.js`, { method: 'POST' }), false);
  assert.equal(route(`${site}?source=app`, { mode: 'navigate' }), true);
  assert.equal(route(`${site}src/main.js`), true);
  assert.equal(route(`${site}vendor/mediapipe/wasm/vision_wasm_internal.wasm`), true);
  assert.equal(route(`${site}models/pose_landmarker_heavy.task`), true);
});

test('install helpers: display mode, browser family, what to offer', () => {
  assert.equal(displayModeOf((q) => q === '(display-mode: standalone)'), 'standalone');
  assert.equal(displayModeOf((q) => q === '(display-mode: fullscreen)' || q === '(display-mode: standalone)'), 'fullscreen');
  assert.equal(displayModeOf(() => false), 'browser');
  const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)';
  assert.equal(browserOf(`${mac} Chrome/141.0.0.0 Safari/537.36`), 'chrome');
  assert.equal(browserOf(`${mac} Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0`), 'chrome');
  assert.equal(browserOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15'), 'safari');
  assert.equal(browserOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 14.1; rv:132.0) Gecko/20100101 Firefox/132.0'), 'firefox');
  assert.equal(installKindOf({ installed: true, promptReady: true, browser: 'chrome' }), 'installed');
  assert.equal(installKindOf({ installed: false, promptReady: true, browser: 'chrome' }), 'prompt');
  assert.equal(installKindOf({ installed: false, promptReady: false, browser: 'chrome', justInstalled: true }), 'done');
  assert.equal(installKindOf({ installed: false, promptReady: false, browser: 'safari' }), 'safari');
  assert.equal(installKindOf({ installed: false, promptReady: false, browser: 'chrome' }), 'chrome');
  assert.equal(installKindOf({ installed: false, promptReady: false, browser: 'firefox' }), 'none');
  assert.equal(isInstalledApp({ search: '?source=app' }), true);
  assert.equal(isInstalledApp({ search: '?autopilot=1&source=app' }), true);
  assert.equal(isInstalledApp({ search: '?source=apple' }), false);
  assert.equal(isInstalledApp({ mode: 'standalone' }), true);
  assert.equal(isInstalledApp({ navigatorStandalone: true }), true);
  // A browser tab in full screen (⌃⌘F or the Fullscreen API) is not the installed app.
  assert.equal(isInstalledApp({ mode: 'fullscreen', menubarVisible: true }), false);
  assert.equal(isInstalledApp({ mode: 'fullscreen', fullscreenElement: {}, menubarVisible: false }), false);
  assert.equal(isInstalledApp({ mode: 'fullscreen', menubarVisible: false }), true);
  assert.equal(isInstalledApp({}), false);
});

test('Pages workflow refreshes the precache list and ships the app files', async () => {
  const wf = await read('.github/workflows/pages.yml');
  assert.match(wf, /node tools\/precache\.mjs --write/);
  const ignore = await read('.gitignore');
  for (const p of ['sw.js', 'manifest.webmanifest', 'icons']) assert.ok(!ignore.split('\n').some((l) => l.trim() && p.startsWith(l.trim().replace(/\/$/, ''))), `${p} not ignored`);
});
