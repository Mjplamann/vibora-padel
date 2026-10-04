// Black-screen check (first real-world session: "a couple of the modes just show a black screen
// with image on the side if you turn left or right far enough"). Headless Chromium against the
// real app:
//   1. degenerate mesh: a capsule scaled to zero thickness (what a collapsed, zero-length arm
//      segment becomes) in front of the camera. Without the safety net this turns the whole WebGL
//      picture black (NaN fragments smeared by the bloom) while the HUD / PiP stay. Expect: no
//      black picture, the mesh counted in stage.safety.meshesHidden.
//   2. the same mesh inside the static hall (not covered by the per-mesh check): the finite guard
//      pass in scene.js limits the damage to the mesh's own pixels.
//   3. the autopilot player turning side-on to ±95° and back through the REAL tracking path, with
//      MediaPipe-style corruptions (hidden arm, label swaps, empty frames, wild and NaN / Infinity
//      landmarks, tests/sideon-frames.mjs). Expect: never a black picture, a finite camera, no errors.
// Screenshots: tools/out/blackscreen-*.png. Usage: node tools/blackscreen.mjs [--width=1280 --height=720]
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { startServer } from './serve.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'tools', 'out');
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? '1']));
const W = Number(args.width || 1280), H = Number(args.height || 720);

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

/** Fraction of near-black pixels in the 3D area of a screenshot (HUD corners excluded). */
async function darkFraction(page, png) {
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = 160; c.height = 90;
    const x = c.getContext('2d');
    x.drawImage(img, 0, 0, 160, 90);
    const d = x.getImageData(0, 22, 160, 68).data; // below the top HUD row
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] < 24) n++;
    return n / (d.length / 4);
  }, png.toString('base64'));
}

async function openApp(browser, port, query) {
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/index.html?${query}`);
  await page.waitForFunction(() => window.__vibora && window.__vibora.ready && window.__vibora.world, null, { timeout: 180000 });
  return { page, errors };
}

async function probe(browser, port, where) {
  const { page, errors } = await openApp(browser, port, 'autopilot=1&drill=fh-drive&mute=1&sw=0');
  await page.evaluate(async (where) => {
    const THREE = await import('three');
    const v = window.__vibora;
    v.freezeAt(v.world.time + 0.4);
    const app = v.stage.app;
    const m = new THREE.Mesh(new THREE.CapsuleGeometry(0.045, 0.2, 4, 12), new THREE.MeshPhysicalMaterial({ color: 0xc58c6a, sheen: 0.5 }));
    m.name = 'degenerate-probe';
    m.frustumCulled = false;
    if (where === 'static') v.stage.env.root.add(m);
    else app.scene.add(m);
    const f = new THREE.Vector3();
    m.onBeforeRender = () => {
      f.set(0.05, -0.05, -0.6).applyQuaternion(app.camera.quaternion);
      m.position.copy(app.camera.position).add(f);
      m.scale.set(1, 0, 1);
      m.updateMatrixWorld(true);
    };
    // Keep the probe's matrix degenerate for the stage's pre-render check too.
    m.scale.set(1, 0, 1);
  }, where);
  await page.waitForTimeout(3000);
  const png = await page.screenshot({ path: join(OUT, `blackscreen-probe-${where}.png`) });
  const dark = await darkFraction(page, png);
  const safety = await page.evaluate(() => window.__vibora.stage.safety);
  await page.close();
  return { dark, safety, errors };
}

async function turning(browser, port) {
  const { page, errors } = await openApp(browser, port, 'autopilot=1&drill=fh-drive&mute=1&sw=0&aplatency=0.11&apdelivery=0.15');
  await page.evaluate(async () => {
    const fx = await import('./tests/sideon-frames.mjs');
    const g = window.__vibora.game;
    const ap = g.feed.autopilot;
    const upd = ap.update;
    const T0 = g.world.time;
    window.__turn = { yaw: 0, T0 };
    ap.update = (w, t) => {
      const b = upd(w, t);
      const yaw = fx.turnYaw((t - T0) % 5, { peak: (Math.floor((t - T0) / 5) % 2 ? -1 : 1) * 95 });
      window.__turn.yaw = yaw;
      return fx.turnedBody(b, yaw);
    };
    const corrupt = fx.createSideOnCorruptor({ seed: 3, kinds: ['occlude', 'swap', 'collapse', 'empty', 'outlier', 'zeroseg', 'nan', 'inf'] });
    const h = g.human;
    const opf = h.onPoseFrame;
    h.onPoseFrame = (w, f, t) => opf(w, corrupt(f, window.__turn.yaw), t);
  });
  const T0 = await page.evaluate(() => window.__turn.T0);
  let worst = 0, badCam = 0;
  const at = [1.0, 1.6, 2.3, 6.0, 6.6, 7.3];
  for (const dt of at) {
    await page.evaluate((t) => window.__vibora.freezeAt(t), T0 + dt);
    await page.waitForFunction((t) => window.__vibora.world.time >= t - 0.01, T0 + dt, { timeout: 120000 });
    await page.waitForTimeout(1200);
    const png = await page.screenshot({ path: join(OUT, `blackscreen-turn-${dt.toFixed(1)}.png`) });
    worst = Math.max(worst, await darkFraction(page, png));
    const ok = await page.evaluate(() => {
      const c = window.__vibora.stage.app.camera;
      return [c.position.x, c.position.y, c.position.z, c.quaternion.x, c.quaternion.y, c.quaternion.z, c.quaternion.w].every(Number.isFinite);
    });
    if (!ok) badCam++;
    await page.evaluate(() => window.__vibora.resume());
  }
  const info = await page.evaluate(() => ({ safety: window.__vibora.stage.safety, tracker: window.__vibora.game.human.bodyTracker.stats, errors: window.__vibora.errors.length }));
  await page.close();
  return { worst, badCam, info, errors };
}

const { chromium } = await loadPlaywright();
await mkdir(OUT, { recursive: true });
const server = await startServer(0);
const port = server.address().port;
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
try {
  const a = await probe(browser, port, 'dynamic');
  console.log('probe dynamic', JSON.stringify({ dark: a.dark, safety: a.safety }));
  check('degenerate mesh in front of the camera: the picture is not black', a.dark < 0.5, `dark ${(a.dark * 100).toFixed(1)}%`);
  check('degenerate mesh: hidden and counted by the stage safety net', a.safety.meshesHidden > 0, `meshesHidden ${a.safety.meshesHidden}`);
  check('degenerate mesh: no console errors', a.errors.length === 0, a.errors.slice(0, 3).join(' | '));
  const b = await probe(browser, port, 'static');
  check('degenerate mesh in the static hall: the finite guard pass keeps the picture', b.dark < 0.5, `dark ${(b.dark * 100).toFixed(1)}%`);
  const c = await turning(browser, port);
  console.log('turning', JSON.stringify(c.info));
  check('side-on turns with MediaPipe corruptions: never a black picture', c.worst < 0.5, `worst dark ${(c.worst * 100).toFixed(1)}%`);
  check('side-on turns: the camera stays finite', c.badCam === 0);
  check('side-on turns: no errors', c.errors.length === 0 && c.info.errors === 0, c.errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  server.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
