// Interaction checks for the UI: keyboard spatial navigation, Enter/Escape, mouse,
// hand-cursor dwell clicks (buttons and sliders) and the pause gesture.
// Usage: node dev/ui-interact.mjs   (exit 1 on failure or console errors)
import { startServer } from '../tools/serve.mjs';

const { chromium } = await import('/opt/node-tools/node_modules/playwright/index.mjs').catch(() => import('playwright'));
const server = await startServer(0);
const base = `http://127.0.0.1:${server.address().port}/dev/ui.html`;
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(e.message));
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ` — ${extra}` : ''}`); if (!ok) failed++; };
const calls = () => page.evaluate(() => window.__calls.map((c) => c[0]));
const focusKey = () => page.evaluate(() => document.activeElement?.dataset?.focusKey || document.activeElement?.className || null);
const screen = () => page.evaluate(() => window.ui.screen);

// 1. Hub keyboard navigation.
await page.goto(`${base}?screen=hub`);
await page.waitForTimeout(700);
check('hub autofocus on Rally', (await focusKey()) === 'rally', await focusKey());
await page.keyboard.press('ArrowRight');
check('ArrowRight → Match', (await focusKey()) === 'match', await focusKey());
await page.keyboard.press('ArrowDown');
const k1 = await focusKey();
check('ArrowDown → a drill card', /^drill-/.test(k1 || ''), k1);
await page.keyboard.press('ArrowLeft');
const k2 = await focusKey();
check('ArrowLeft → card in previous column', /^drill-/.test(k2 || '') && k2 !== k1, k2);
await page.keyboard.press('Enter');
await page.waitForTimeout(300);
check('Enter on card → drill-intro', (await screen()) === 'drill-intro');
check('drill-intro focuses Start', (await focusKey()) === 'start', await focusKey());
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
check('Escape → hub', (await screen()) === 'hub');
check('focus restored to the card', (await focusKey()) === k2, await focusKey());
await page.keyboard.press('Enter');
await page.waitForTimeout(200);
await page.keyboard.press('Enter');
await page.waitForTimeout(200);
check('Start drill → onStartDrill + play', (await calls()).includes('onStartDrill') && (await screen()) === 'play');
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
check('Esc in play → onPause → pause', (await calls()).includes('onPause') && (await screen()) === 'pause');
check('pause focuses Resume', (await focusKey()) === 'resume', await focusKey());
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
check('Esc in pause → onResume', (await calls()).includes('onResume') && (await screen()) === 'play');

// 2. Settings: keyboard slider + mouse seg + switch.
await page.goto(`${base}?screen=settings`);
await page.waitForTimeout(700);
check('settings autofocus on selected assist', (await page.evaluate(() => document.activeElement?.dataset?.value)) === 'club');
await page.keyboard.press('ArrowDown');
await page.keyboard.press('ArrowDown');
await page.keyboard.press('ArrowRight');
const f = await page.evaluate(() => ({ role: document.activeElement.getAttribute('role'), sw: document.activeElement.dataset.switch, label: document.activeElement.getAttribute('aria-label') }));
check('spatial nav reaches a control in the next column', !!f.role || !!f.sw, JSON.stringify(f));
await page.evaluate(() => document.querySelector('[data-range="fov"] .range-track').focus());
await page.keyboard.press('ArrowRight');
await page.keyboard.press('ArrowRight');
const fovCall = await page.evaluate(() => window.__calls.filter((c) => c[0] === 'onSettings' && 'fov' in c[1]).pop());
check('slider ArrowRight → onSettings({fov: 74})', fovCall && fovCall[1].fov === 74, JSON.stringify(fovCall));
const out = await page.evaluate(() => document.querySelector('[data-out="fov"]').textContent);
check('slider live value updates', out === '74°', out);
await page.click('[data-seg="quality"] [data-value="ultra"]');
const q = await page.evaluate(() => window.__calls.filter((c) => c[0] === 'onSettings').pop()[1]);
check('mouse click on segmented → onSettings({quality})', q.quality === 'ultra', JSON.stringify(q));
await page.click('[data-switch="halo"]');
const h = await page.evaluate(() => window.__calls.filter((c) => c[0] === 'onSettings').pop()[1]);
check('switch toggles → onSettings({halo:true})', h.halo === true, JSON.stringify(h));
await page.click('[data-range="volumes.master"] [data-delta="-1"]');
const v = await page.evaluate(() => window.__calls.filter((c) => c[0] === 'onSettings').pop()[1]);
check('volume stepper → nested volumes patch', v.volumes && Math.abs(v.volumes.master - 0.85) < 1e-9 && v.volumes.sfx === 1, JSON.stringify(v));
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
check('Escape in settings → back', (await screen()) !== 'settings', await screen());

// 3. Hand cursor: dwell on a slider sets it at the cursor x; pause gesture.
await page.goto(`${base}?screen=settings`);
await page.waitForTimeout(600);
const dwell = await page.evaluate(async () => {
  const { createHandCursor } = await import('../src/ui/cursor.js');
  let paused = 0;
  let now = 0;
  const cursor = createHandCursor({ root: document.getElementById('ui'), ui: window.ui, onPause: () => paused++, now: () => now });
  const track = document.querySelector('[data-range="fov"] .range-track');
  const r = track.getBoundingClientRect();
  const tx = (r.left + r.width * 0.75) / innerWidth, ty = (r.top + r.height / 2) / innerHeight;
  const v = (x, y) => ({ x, y, z: 0.3 });
  const body = (wx, wy, both = false) => ({
    t: now, valid: true, dominant: 'R',
    joints: { nose: v(0, 1.62), shoulderL: v(-0.19, 1.43), shoulderR: v(0.19, 1.43), hipL: v(-0.1, 0.93), hipR: v(0.1, 0.93),
      wristR: v(wx, wy), wristL: both ? v(-0.2, 1.85) : v(-0.22, 0.9) },
  });
  const wx = 0.19 + 0.12 + (tx - 0.5) * 0.62, wy = 1.43 - 0.04 + (0.5 - ty) * 0.44;
  let st;
  for (let i = 0; i <= 70; i++) { now = i * 16.7; st = cursor.update(body(wx, wy)); }
  const fov = Number(track.getAttribute('aria-valuenow'));
  const sx = st.x, sy = st.y;
  const cursorVisible = !document.querySelector('.vp-cursor').hidden;
  // Pause gesture: both wrists above the head for 1.5 s.
  for (let i = 0; i <= 100; i++) { now = 2000 + i * 16.7; cursor.update(body(0.2, 1.85, true)); }
  return { fov, cursorVisible, paused, sx, sy, tx: tx * innerWidth, ty: ty * innerHeight };
});
check('hand cursor maps onto the target', Math.abs(dwell.sx - dwell.tx) < 30 && Math.abs(dwell.sy - dwell.ty) < 30, `${dwell.sx.toFixed(0)},${dwell.sy.toFixed(0)} vs ${dwell.tx.toFixed(0)},${dwell.ty.toFixed(0)}`);
check('dwell 1 s on slider sets value at 75%', Math.abs(dwell.fov - (55 + 0.75 * 45)) <= 2, String(dwell.fov));
check('cursor visual shown', dwell.cursorVisible);
check('both hands above head 1.5 s → onPause', dwell.paused === 1, String(dwell.paused));

// 4. Title: Enter starts → camera screen.
await page.goto(`${base}?screen=title`);
await page.waitForTimeout(600);
await page.keyboard.press('Enter');
await page.waitForTimeout(300);
check('title Enter → camera', (await screen()) === 'camera');
await page.click('[data-device="builtin"]');
const cam = await page.evaluate(() => window.__calls.filter((c) => c[0] === 'onCameraSelect').pop());
check('camera click → onCameraSelect(deviceId, preset)', cam && cam[1] === 'builtin' && cam[2] === 'macbook-builtin', JSON.stringify(cam));

// 5. Reduced motion renders without animation errors.
await page.emulateMedia({ reducedMotion: 'reduce' });
await page.goto(`${base}?screen=play&variant=banner`);
await page.waitForTimeout(500);
check('reduced motion play screen ok', (await screen()) === 'play');

check('no console errors', errors.length === 0, errors.join(' | '));
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
