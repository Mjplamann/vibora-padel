// Dev check: the REAL app with glasses mode as main.js installs it (src/xr/boot.js installGlasses
// at boot, per-frame frame(), 10 Hz hud(), the Settings / Help panels from the UI's onScreen),
// driven by the URL flags (?xrsim=1 -> simulated V2 pose stream sweeping the head ±25°, ?stereo=1,
// ?glasses=1) and the realistic autopilot. Saves screenshots and exits 1 on page errors, a black /
// non-finite picture, head tracking that does not reach the camera, or a missing Settings / Help
// panel (mounted by the app itself: this script only clicks through the menus).
// Usage: node dev/xr-app-shot.mjs [outDir=tools/out] [--only=stereo|mono|panel]
import { startServer } from '../tools/serve.mjs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const args = process.argv.slice(2);
const outDir = args.find((a) => !a.startsWith('--')) || 'tools/out';
const only = (args.find((a) => a.startsWith('--only=')) || '').slice(7);
let pw;
try {
  pw = await import('playwright');
} catch {
  pw = await import('/opt/node-tools/node_modules/playwright/index.mjs');
}
await mkdir(outDir, { recursive: true });

const APP = 'autopilot=1&drill=back-glass&speed=1&aplatency=0.11&apdelivery=0.15&quality=balanced';
const CASES = [
  { id: 'stereo', w: 3840, h: 1200, app: APP, xr: '?xrsim=1&stereo=1', play: true },
  { id: 'mono', w: 1920, h: 1200, app: APP, xr: '?xrsim=1', play: true },
  { id: 'panel', w: 1920, h: 1200, app: 'fallback=1&quality=balanced', xr: '?glasses=1', play: false },
].filter((c) => !only || c.id === only);

/** In-page: the app's own glasses integration (main.js installs it at boot from the URL flags). */
async function install(page) {
  return page.evaluate(() => {
    const xb = window.__vibora.xr;
    if (!xb) return 'NO GLASSES INTEGRATION (__vibora.xr is null)';
    window.__xb = xb;
    return xb.glasses.status().message;
  });
}

/** Mean luminance and a finite-camera check of the current canvas. */
function probe(page) {
  return page.evaluate(() => {
    const V = window.__vibora;
    const cam = V.stage.app.camera;
    const finite = [cam.position.x, cam.position.y, cam.position.z, cam.quaternion.x, cam.quaternion.y, cam.quaternion.z, cam.quaternion.w].every(Number.isFinite);
    const c = V.stage.app.renderer.domElement;
    // Render now and read back in the same task (the drawing buffer is not preserved).
    V.stage.render(0);
    const tmp = document.createElement('canvas');
    tmp.width = 96; tmp.height = 30;
    const g = tmp.getContext('2d');
    g.drawImage(c, 0, 0, 96, 30);
    const px = g.getImageData(0, 0, 96, 30).data;
    let sumL = 0, sumR = 0;
    for (let y = 0; y < 30; y++) {
      for (let x = 0; x < 96; x++) {
        const i = (y * 96 + x) * 4;
        const l = (px[i] + px[i + 1] + px[i + 2]) / 3;
        if (x < 48) sumL += l; else sumR += l;
      }
    }
    const xr = V.stage.xr;
    return {
      finite, lumLeft: sumL / 1440, lumRight: sumR / 1440, fov: cam.fov, headTracking: V.stage.fpCam.headTracking,
      stereo: !!(xr && xr.stereo && xr.stereo.enabled), stereoStats: xr && xr.stereo ? xr.stereo.stats : null,
      cls: document.documentElement.className, screen: V.screen, safety: V.stage.safety, errors: V.errors,
    };
  });
}

const server = await startServer(0);
const port = server.address().port;
const browser = await pw.chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
let failed = 0;
for (const c of CASES) {
  const page = await browser.newPage({ viewport: { width: c.w, height: c.h }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  const t0 = Date.now();
  await page.goto(`http://127.0.0.1:${port}/?${c.app}&${c.xr.replace(/^\?/, '')}`);
  await page.waitForFunction(() => window.__vibora && window.__vibora.ready, null, { timeout: 300000, polling: 500 });
  const msg = await install(page);
  const problems = [];
  if (/^NO GLASSES/.test(msg)) problems.push(msg);
  let r = null;
  if (c.play) {
    await page.waitForFunction(() => window.__vibora.screen === 'play', null, { timeout: 120000, polling: 500 });
    // Let the drill feed a few balls with the head sweeping.
    await page.waitForTimeout(12000);
    r = await probe(page);
    const yaw = await page.evaluate(() => {
      const out = [];
      const d = window.__xb.glasses.driver;
      for (let i = 0; i < 1; i++) out.push(d.getEuler());
      return out[0];
    });
    r.headEuler = yaw;
    await page.screenshot({ path: join(outDir, `xr-app-${c.id}.png`), timeout: 240000 });
    if (!r.finite) problems.push('non-finite camera');
    if (!r.headTracking) problems.push('head tracking did not reach the camera');
    if (!(Math.abs(r.fov - 32.74) < 0.1)) problems.push(`fov ${r.fov}`);
    if (c.id === 'stereo' && !r.stereo) problems.push('stereo not active');
    if (c.id === 'stereo' && r.stereoStats && r.stereoStats.layout !== 'full') problems.push(`layout ${r.stereoStats.layout}`);
    if (r.lumLeft < 8 || r.lumRight < 8) problems.push(`black picture (${r.lumLeft.toFixed(1)} / ${r.lumRight.toFixed(1)})`);
    if (!/xr-glasses/.test(r.cls)) problems.push('no xr-glasses class');
  } else {
    // Settings and Help panels mounted as main.js's onScreen handler will.
    await page.waitForFunction(() => window.__vibora.screen === 'hub', null, { timeout: 120000, polling: 500 });
    await page.keyboard.press('Escape').catch(() => {});
    const opened = await page.evaluate(async () => {
      const b = [...document.querySelectorAll('[data-action="settings"]')][0];
      if (b) b.click();
      await new Promise((res) => setTimeout(res, 1000));
      const panel = document.querySelector('.screen-settings .xr-panel');
      if (panel) panel.scrollIntoView({ block: 'start' });
      return { screen: window.__vibora.screen, panel: !!panel, text: panel ? panel.innerText.slice(0, 200) : null };
    });
    r = { opened };
    if (!opened.panel) problems.push(`no settings panel (screen ${opened.screen})`);
    await page.waitForTimeout(2500);
    await page.screenshot({ path: join(outDir, `xr-app-panel-settings.png`), timeout: 240000 });
    const help = await page.evaluate(async () => {
      const back = document.querySelector('[data-action="back"]');
      if (back) back.click();
      await new Promise((res) => setTimeout(res, 500));
      const b = document.querySelector('[data-action="help"]');
      if (b) b.click();
      await new Promise((res) => setTimeout(res, 900));
      const panel = document.querySelector('.screen-help .xr-panel');
      if (panel) panel.scrollIntoView({ block: 'start' });
      return { screen: window.__vibora.screen, panel: !!panel };
    });
    r.help = help;
    if (!help.panel) problems.push(`no help panel (screen ${help.screen})`);
    await page.waitForTimeout(2500);
    await page.screenshot({ path: join(outDir, `xr-app-panel-help.png`), timeout: 240000 });
  }
  problems.push(...errors);
  console.log(`${c.id} ${c.w}×${c.h} ${((Date.now() - t0) / 1000).toFixed(1)} s · ${msg}`);
  console.log(`  ${JSON.stringify(r)}`);
  if (problems.length) {
    failed++;
    console.log(`  FAIL: ${problems.join('; ')}`);
  } else console.log('  ok');
  await page.close();
}
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
