// Smoke test (SPEC §11): headless Chromium (SwiftShader WebGL) against the real app.
//   1. ?autopilot=1&drill=fh-drive&speed=3 — the synthetic camera + autopilot drive the real
//      tracking -> hit -> physics pipeline for 60 s of sim time (feeds wait for each rep's
//      ruling, about 4.5-5 s apart). Asserts zero console errors / failed requests, >= 8 player
//      hits and >= 50% of judged shots in the court. Screenshots: just before a contact (hands,
//      racket, incoming ball), just after a hit, the HUD with the shot card, an instant-replay
//      frame and the results screen.
//   1b. The same drill with a realistic Mac pipeline (?aplatency=0.11&apdelivery=0.15): the
//      hit rate must match run 1 and no contact may be rejected as late.
//   2. ?fallback=1&drill=fh-drive&speed=2 — mouse / trackpad controls, pointer flicks + Space swings.
//   3. Camera path with Chromium's fake camera (no person in the picture): title -> camera ->
//      calibration screens with the real MediaPipe model.
//   4. Installable app (PWA) from the GitHub Pages sub-path, in a real (non-incognito) profile:
//      the manifest parses and Chrome reports no installability errors (DevTools Protocol), the
//      service worker precaches the app, then OFFLINE: a relaunch boots with zero errors and a
//      drill runs, and the camera path loads the pose model; finally a new service worker
//      version shows "Update ready" and Restart activates it.
// Usage: node tools/smoke.mjs [--only=autopilot|latency|fallback|camera|nocamera|subpath|pwa] [--width=1280 --height=720]
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createServer, request } from 'node:http';
import { startServer } from './serve.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'tools', 'out');
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? '1']));
const W = Number(args.width || 1280);
const H = Number(args.height || 720);
const SIM_SECONDS = Number(args.seconds || 60);

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    return await import('/opt/node-tools/node_modules/playwright/index.mjs');
  }
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

async function launch(chromium, { fakeCamera = true } = {}) {
  const exe = process.env.PW_CHROMIUM || undefined;
  return chromium.launch({
    executablePath: exe,
    args: [
      '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
      '--autoplay-policy=no-user-gesture-required',
      ...(fakeCamera ? ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] : []),
    ],
  });
}

async function openPage(browser, url, port) {
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const errors = [];
  const logs = [];
  const external = [];
  page.on('request', (r) => {
    const u = r.url();
    if (!/^(http:\/\/127\.0\.0\.1|data:|blob:)/.test(u)) external.push(u);
  });
  page.on('console', (m) => {
    const line = `[${m.type()}] ${m.text()}`;
    logs.push(line);
    if (m.type() === 'error') errors.push(line);
  });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  page.on('requestfailed', (r) => errors.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`));
  page.on('response', (r) => {
    if (r.status() >= 400) errors.push(`[http ${r.status()}] ${r.url()}`);
  });
  await page.goto(`http://127.0.0.1:${port}/${url}`);
  await page.waitForFunction(() => window.__vibora && (window.__vibora.ready || window.__vibora.errors.length), null, { timeout: 180000 });
  return { page, errors, logs, external };
}

const stats = (page) => page.evaluate(() => ({ ...window.__vibora.stats, screen: window.__vibora.screen }));
const shot = (page, name) => page.screenshot({ path: join(OUT, `smoke-${name}.png`) });

/** Freezes the sim on a rule ('contact' | 'hit'), waits for a few rendered frames, screenshots, resumes. */
async function frozenShot(page, kind, offset, name, renderMs = 3500) {
  await page.evaluate(([k, o]) => window.__vibora.freezeOn(k, o), [kind, offset]);
  const ok = await page.waitForFunction(() => window.__vibora.frozen, null, { timeout: 120000 }).then(() => true).catch(() => false);
  await page.waitForTimeout(renderMs);
  await shot(page, name);
  await page.evaluate(() => window.__vibora.resume());
  return ok;
}

async function runAutopilot(browser, port) {
  console.log('\n— autopilot: ?autopilot=1&drill=fh-drive&speed=3');
  const { page, errors } = await openPage(browser, 'index.html?autopilot=1&drill=fh-drive&speed=3', port);
  const t0 = await page.evaluate(() => window.__vibora.world.time);
  // 1) Just before a contact: hands, racket and the incoming ball.
  const pre = await frozenShot(page, 'contact', -0.02, 'precontact');
  // 2) Just after a hit.
  const post = await frozenShot(page, 'hit', 0.16, 'hit');
  // 3) Run on to SIM_SECONDS of sim time; HUD shot after a few hits.
  let hudDone = false;
  for (;;) {
    const s = await stats(page);
    if (!hudDone && s.playerHits >= 3) {
      await page.waitForTimeout(400);
      await shot(page, 'hud');
      hudDone = true;
    }
    if (s.simTime - t0 >= SIM_SECONDS || s.finished || s.errors) break;
    await page.waitForTimeout(1000);
  }
  const s = await stats(page);
  // 4) Instant replay frame.
  await page.evaluate(() => window.__vibora.startReplay());
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.__vibora.replaySeek(-0.08));
  await page.waitForTimeout(3500);
  const replaying = await page.evaluate(() => window.__vibora.replaying);
  console.log('replay', JSON.stringify(await page.evaluate(() => window.__vibora.replayInfo())));
  await shot(page, 'replay');
  await page.evaluate(() => window.__vibora.stopReplay());
  // 5) Results screen.
  await page.evaluate(() => window.__vibora.showResultsNow());
  await page.waitForFunction(() => window.__vibora.screen === 'results', null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3500);
  await shot(page, 'results');
  const rate = s.judgedShots ? s.inCourt / s.judgedShots : 0;
  console.log('stats', JSON.stringify(s));
  check('autopilot: no console errors / failed requests', errors.length === 0, errors.slice(0, 5).join(' | '));
  check('autopilot: no runtime errors', s.errors === 0);
  check('autopilot: >= 8 player hits', s.playerHits >= 8, `${s.playerHits} hits in ${(s.simTime - t0).toFixed(1)} s sim`);
  check('autopilot: >= 50% of judged shots land in the court', rate >= 0.5, `${s.inCourt}/${s.judgedShots}`);
  check('autopilot: instant replay plays', replaying);
  check('autopilot: froze before a contact and after a hit for screenshots', pre && post);
  await page.close();
  return s;
}

/** Realistic latency: display 0.11 s, capture -> result 0.15 s. Same hit rate, no late rejects. */
async function runLatency(browser, port, base) {
  console.log('\n— latency: ?autopilot=1&drill=fh-drive&speed=3&aplatency=0.11&apdelivery=0.15');
  const { page, errors } = await openPage(browser, 'index.html?autopilot=1&drill=fh-drive&speed=3&aplatency=0.11&apdelivery=0.15', port);
  const t0 = await page.evaluate(() => window.__vibora.world.time);
  for (;;) {
    const s = await stats(page);
    if (s.simTime - t0 >= SIM_SECONDS || s.finished || s.errors) break;
    await page.waitForTimeout(1000);
  }
  const s = await stats(page);
  console.log('stats', JSON.stringify(s));
  const rate = (x) => (x && x.feeds ? x.playerHits / x.feeds : 0);
  check('latency: no console errors', errors.length === 0 && s.errors === 0, errors.slice(0, 3).join(' | '));
  check('latency: judge margin covers the pipeline', s.judgeMargin >= 0.15 + 2 / 30 - 1e-6, `margin ${s.judgeMargin}`);
  check('latency: no contact rejected as late', s.lateHits === 0, `${s.lateHits} late`);
  check('latency: hit rate unchanged', !base || rate(s) >= rate(base) - 0.1, `${s.playerHits}/${s.feeds} vs ${base ? `${base.playerHits}/${base.feeds}` : '—'}`);
  await page.close();
}

async function runFallback(browser, port) {
  console.log('\n— fallback: ?fallback=1&drill=fh-drive&speed=2');
  const { page, errors } = await openPage(browser, 'index.html?fallback=1&drill=fh-drive&speed=2', port);
  await page.mouse.move(W * 0.6, H * 0.62);
  for (let i = 0; i < 6; i++) {
    if ((await stats(page)).screen !== 'play') break;
    await page.mouse.move(W * 0.45, H * 0.5, { steps: 3 }); // pointer flick between feeds
    // Space as a machine feed comes. Pressed from inside the page on the first frame the ball is
    // on its way: software GL draws ~10 fps at ?speed=2, so a Playwright round trip per step let
    // the ball pass the player before the key arrived (the auto-swing then had nothing to play).
    await page.evaluate(() => new Promise((resolve) => {
      const t0 = performance.now();
      const tick = () => {
        const w = window.__vibora.world;
        if (w && w.ball && w.flight.by === 'machine' && w.ball.vel.z > 0 && w.ball.pos.z > -6 && w.ball.pos.z < 2) {
          window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true }));
          window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', key: ' ', bubbles: true }));
          resolve(true);
        } else if (performance.now() - t0 > 30000) resolve(false);
        else requestAnimationFrame(tick);
      };
      tick();
    }));
    await page.mouse.move(W * 0.62, H * 0.62, { steps: 3 });
    await page.waitForFunction(() => { const w = window.__vibora.world; return !w || !w.ball || w.flight.by !== 'machine'; }, null, { timeout: 30000 }).catch(() => {});
  }
  await shot(page, 'fallback');
  const s = await stats(page);
  console.log('stats', JSON.stringify(s));
  check('fallback: no console errors / failed requests', errors.length === 0, errors.slice(0, 5).join(' | '));
  check('fallback: running in play', s.screen === 'play' && s.errors === 0 && s.feeds > 0, `screen ${s.screen}, feeds ${s.feeds}`);
  check('fallback: Space auto-swing hits the ball', s.playerHits >= 3, `${s.playerHits} hits`);
  // QA2: the aimed auto-swing (drill intent, net safety, contacts off the glass) keeps >= 80% in court.
  check('fallback: >= 80% of judged auto-swings land in the court', s.judgedShots >= 3 && s.inCourt / s.judgedShots >= 0.8, `${s.inCourt}/${s.judgedShots}`);
  await page.close();
}

async function runCamera(browser, port) {
  console.log('\n— camera path (fake device)');
  const { page, errors, external } = await openPage(browser, 'index.html', port);
  await page.waitForTimeout(4000);
  await shot(page, 'title');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__vibora.screen === 'camera', null, { timeout: 20000 }).catch(() => {});
  // Model load + a few inferences in software GL.
  await page.waitForTimeout(25000);
  await shot(page, 'camera');
  await page.evaluate(() => document.querySelector('[data-action="to-calibrate"]')?.click());
  await page.waitForTimeout(6000);
  await shot(page, 'calibrate');
  // Drive the calibration with a synthetic person standing 2.6 m away (30 fps, real timestamps):
  // full body -> stand on your spot (auto) -> calibrated -> profile step.
  await page.evaluate(async () => {
    const { createSyntheticCamera, standingBody } = await import('./src/tracking/synthetic.js');
    const cam = createSyntheticCamera({ hfovDeg: window.__vibora.settings.hfovDeg });
    const body = standingBody({ height: 1.75, room: { x: 0.1, d: 2.6 } });
    window.__smokeFeed = setInterval(() => window.__vibora.injectPoseFrame(cam.frame(performance.now(), [body])), 33);
  });
  await page.waitForFunction(() => window.__vibora.calibration && window.__vibora.calibration.ok, null, { timeout: 90000 }).catch(() => {});
  await page.waitForTimeout(4000);
  const cal = await page.evaluate(() => ({ cal: window.__vibora.calibration, step: document.querySelector('.stepper li.current span')?.textContent || '' }));
  await shot(page, 'calibrated');
  await page.evaluate(() => clearInterval(window.__smokeFeed));
  console.log('calibration', JSON.stringify(cal));
  check('camera: synthetic person calibrates (spot saved, profile step)', !!(cal.cal && cal.cal.ok) && /Profile/.test(cal.step), cal.step);
  const s = await stats(page);
  const filtered = errors.filter((e) => !/Camera did not deliver frames/.test(e));
  check('camera: no console errors / failed requests', filtered.length === 0, filtered.slice(0, 5).join(' | '));
  check('camera: reached calibration', s.screen === 'calibrate' && s.errors === 0, `screen ${s.screen}`);
  check('camera: no external network requests (MediaPipe telemetry blocked)', external.length === 0, external.slice(0, 3).join(' | '));
  await page.close();
}

async function runNoCamera(chromium, port) {
  console.log('\n— no camera available (human-readable error, mouse fallback offered)');
  const browser = await launch(chromium, { fakeCamera: false });
  try {
    const { page, errors } = await openPage(browser, 'index.html?attract=0', port);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('.cam-error'), null, { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1500);
    await shot(page, 'camera-error');
    const title = await page.evaluate(() => document.querySelector('.cam-error .ce-title')?.textContent || '');
    const hasFallback = await page.evaluate(() => !!document.querySelector('[data-action="fallback"]'));
    check('no camera: explains the problem and offers mouse controls', !!title && hasFallback, title);
    check('no camera: no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
    await page.close();
  } finally {
    await browser.close();
  }
}

/** GitHub Pages serves the site under /<repo>/: proxy /vibora-padel/* to the static server. */
function startSubpathProxy(port) {
  const server = createServer((req, res) => {
    if (!req.url.startsWith('/vibora-padel/')) {
      res.writeHead(404).end('outside the site');
      return;
    }
    const up = request({ host: '127.0.0.1', port, path: req.url.slice('/vibora-padel'.length), method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on('error', () => res.writeHead(502).end());
    req.pipe(up);
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

async function runSubpath(browser, port) {
  console.log('\n— GitHub Pages sub-path: /vibora-padel/?autopilot=1');
  const proxy = await startSubpathProxy(port);
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('response', (r) => { if (r.status() >= 400) errors.push(`[http ${r.status()}] ${r.url()}`); });
    await page.goto(`http://127.0.0.1:${proxy.address().port}/vibora-padel/?autopilot=1&drill=volleys&speed=3`);
    await page.waitForFunction(() => window.__vibora && (window.__vibora.ready || window.__vibora.errors.length), null, { timeout: 180000 });
    await page.waitForFunction(() => window.__vibora.stats.feeds > 0, null, { timeout: 120000 }).catch(() => {});
    const s = await stats(page);
    check('sub-path: every asset loads with relative URLs', errors.length === 0 && s.errors === 0 && s.feeds > 0, errors.slice(0, 3).join(' | ') || `feeds ${s.feeds}`);
    await page.close();
  } finally {
    proxy.close();
  }
}

/**
 * GitHub Pages-like host for the PWA run: /vibora-padel/* proxied to the static server. When
 * `next` is set, sw.js is served with a different VERSION (a new deploy) to test the update flow.
 */
function startPwaHost(port) {
  const host = { next: '' };
  const server = createServer((req, res) => {
    if (!req.url.startsWith('/vibora-padel/')) {
      res.writeHead(404).end('outside the site');
      return;
    }
    const path = req.url.slice('/vibora-padel'.length);
    const up = request({ host: '127.0.0.1', port, path, method: req.method, headers: req.headers }, (r) => {
      if (host.next && path.split('?')[0] === '/sw.js' && r.statusCode === 200) {
        let body = '';
        r.setEncoding('utf8');
        r.on('data', (c) => { body += c; });
        r.on('end', () => {
          body = body.replace(/const VERSION = '([^']*)';/, `const VERSION = '$1${host.next}';`);
          res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' }).end(body);
        });
        return;
      }
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on('error', () => res.writeHead(502).end());
    req.pipe(up);
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => {
    host.server = server;
    host.base = `http://127.0.0.1:${server.address().port}/vibora-padel/`;
    ok(host);
  }));
}

async function runPwa(chromium, port) {
  console.log('\n— installable app: manifest, service worker, offline relaunch, update (/vibora-padel/)');
  const host = await startPwaHost(port);
  // Installability needs a real profile (an incognito-like context reports 'in-incognito').
  const profile = await mkdtemp(join(OUT, 'pwa-profile-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.PW_CHROMIUM || undefined,
    headless: true,
    viewport: { width: 960, height: 540 },
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required',
      '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });
  const external = [];
  ctx.on('request', (r) => { if (!r.url().startsWith(host.base) && !/^(data|blob):/.test(r.url())) external.push(r.url()); });
  try {
    const page = ctx.pages()[0] || (await ctx.newPage());
    const errors = [];
    page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('requestfailed', (r) => errors.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`));
    page.on('response', (r) => { if (r.status() >= 400) errors.push(`[http ${r.status()}] ${r.url()}`); });
    const ready = () => page.waitForFunction(() => window.__vibora && (window.__vibora.ready || window.__vibora.errors.length), null, { timeout: 180000 });

    // 1) Online first launch.
    await page.goto(`${host.base}?autopilot=1&drill=fh-drive&speed=3`);
    await ready();
    const cdp = await ctx.newCDPSession(page);
    const man = await cdp.send('Page.getAppManifest');
    const icons = await page.evaluate(async () => {
      const m = await (await fetch('./manifest.webmanifest')).json();
      const out = [];
      for (const ic of m.icons) {
        const img = new Image();
        img.src = new URL(ic.src, location.href).href;
        await img.decode().catch(() => {});
        out.push({ src: ic.src, sizes: ic.sizes, w: img.naturalWidth, h: img.naturalHeight });
      }
      return { m, out };
    });
    const iconOk = icons.out.every((i) => i.w > 0 && (i.sizes === 'any' || i.sizes === `${i.w}x${i.h}`));
    const mm = icons.m;
    check('pwa: manifest parses with no errors (DevTools Page.getAppManifest)', !!man.data && man.errors.length === 0 && /manifest\.webmanifest$/.test(man.url)
      && mm.start_url === './?source=app' && mm.scope === './' && mm.display === 'fullscreen' && iconOk,
    man.errors.map((e) => e.message).join(' | ') || `${icons.out.length} icons ${iconOk ? 'ok' : JSON.stringify(icons.out)}`);
    const inst = await cdp.send('Page.getInstallabilityErrors');
    const instErr = (inst.installabilityErrors || []).map((e) => e.errorId);
    check('pwa: installable (Page.getInstallabilityErrors: none)', instErr.length === 0, instErr.join(', '));
    await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 180000 }).catch(() => {});
    const st = await page.evaluate(() => (window.__vibora.pwa ? window.__vibora.pwa.swStatus() : null));
    const cached = await page.evaluate(async () => {
      const urls = [];
      for (const n of await caches.keys()) for (const r of await (await caches.open(n)).keys()) urls.push(r.url);
      return urls;
    });
    const foreign = cached.filter((u) => !u.startsWith(host.base));
    check('pwa: service worker precached the app shell, modules, wasm and pose model', !!st && st.total > 50 && st.precached === st.total
      && cached.some((u) => u.endsWith('models/pose_landmarker_full.task')) && cached.some((u) => u.endsWith('vision_wasm_internal.wasm')),
    st ? `${st.precached}/${st.total} files, version ${st.version}${st.missing.length ? `, missing ${st.missing.slice(0, 3).join(', ')}` : ''}` : 'no controller');
    check('pwa: caches hold only this site\'s files (no googleapis, no other origins)', foreign.length === 0 && external.length === 0, [...foreign, ...external].slice(0, 3).join(' | '));
    check('pwa: online launch has no errors', errors.length === 0, errors.slice(0, 3).join(' | '));

    // 2) Offline relaunch: boots and a drill runs.
    await ctx.setOffline(true);
    errors.length = 0;
    await page.reload();
    await ready();
    await page.waitForFunction(() => window.__vibora.stats.playerHits >= 2, null, { timeout: 180000 }).catch(() => {});
    const off = await page.evaluate(() => ({ ...window.__vibora.stats, screen: window.__vibora.screen, online: navigator.onLine }));
    console.log('offline stats', JSON.stringify(off));
    check('pwa: OFFLINE relaunch boots with zero errors and a drill runs', !off.online && off.errors === 0 && errors.length === 0 && off.screen === 'play' && off.playerHits >= 2,
      errors.slice(0, 3).join(' | ') || `${off.playerHits} hits, ${off.feeds} feeds`);

    // 3) Offline camera path: the MediaPipe runtime and pose model come from the cache.
    errors.length = 0;
    await page.goto(`${host.base}?attract=0`);
    await ready();
    await page.evaluate(() => {
      window.__smokeToasts = [];
      new MutationObserver(() => {
        for (const t of document.querySelectorAll('.vp-toasts .toast')) if (!window.__smokeToasts.includes(t.textContent)) window.__smokeToasts.push(t.textContent);
      }).observe(document.querySelector('.vp-toasts'), { childList: true, subtree: true });
    });
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__smokeToasts.some((t) => /Pose tracking (ready|failed|error)|failed to load/i.test(t)), null, { timeout: 120000 }).catch(() => {});
    const toasts = await page.evaluate(() => window.__smokeToasts);
    const poseOk = toasts.some((t) => /Pose tracking ready/.test(t));
    const camErr = errors.filter((e) => !/Camera did not deliver frames/.test(e));
    check('pwa: OFFLINE camera path loads the pose model', poseOk && camErr.length === 0, camErr.slice(0, 2).join(' | ') || toasts.filter((t) => /Pose/.test(t)).join(' · '));

    // 4) A new deploy: "Update ready", Restart activates the new worker.
    await ctx.setOffline(false);
    host.next = '-next';
    await page.evaluate(() => window.__vibora.pwa.state.sw.registration.update().catch(() => {}));
    await page.waitForFunction(() => window.__vibora.pwa.state.sw.updateReady && !document.querySelector('.vp-update').hidden, null, { timeout: 120000 }).catch(() => {});
    await shot(page, 'pwa-update');
    const shown = await page.evaluate(() => !document.querySelector('.vp-update').hidden);
    const nav = page.waitForNavigation({ timeout: 60000 }).catch(() => null);
    if (shown) await page.click('[data-update-restart]');
    await nav;
    await ready();
    await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 60000 }).catch(() => {});
    const st2 = await page.evaluate(() => (window.__vibora.pwa ? window.__vibora.pwa.swStatus() : null));
    check('pwa: "Update ready" toast, Restart activates the new version', shown && !!st2 && /-next$/.test(st2.version) && st2.precached === st2.total,
      st2 ? `now ${st2.version}` : 'no status');
  } finally {
    await ctx.close();
    host.server.close();
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const { chromium } = await loadPlaywright();
  const server = await startServer(0);
  const port = server.address().port;
  const browser = await launch(chromium);
  const only = args.only || null;
  try {
    let base = null;
    if (!only || only === 'autopilot') base = await runAutopilot(browser, port);
    if (!only || only === 'latency') await runLatency(browser, port, base);
    if (!only || only === 'fallback') await runFallback(browser, port);
    if (!only || only === 'camera') await runCamera(browser, port);
    if (!only || only === 'nocamera') await runNoCamera(chromium, port);
    if (!only || only === 'subpath') await runSubpath(browser, port);
    if (!only || only === 'pwa') await runPwa(chromium, port);
  } catch (err) {
    check('smoke run completed', false, err.message);
  } finally {
    await browser.close();
    server.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots in tools/out/smoke-*.png`);
  process.exit(failed.length ? 1 : 0);
}

main();
