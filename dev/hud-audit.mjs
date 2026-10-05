// Round 6 (clarity) HUD overlap audit in the REAL app: the human autopilot in close mode at Mac latency
// with the settings of a real player's MacBook session (1710x876 @2x, fov 74, pitch -14), frozen
// LEAD s before the planned contact of an incoming ball. For each scenario it measures every visible
// HUD block's DOM rect against the ball (now), its predicted path to t* (projected with the frozen
// camera), the racket's screen box and the central play region (src/ui/playRegion.js), in three
// states: 'live' (as it plays), 'union' (every transient element forced on at once: miss, perfect,
// partner call, coach cue, achievement, banner, shot card, "now"), 'feed' (the clean HUD's feedback
// line released while the ball is still live: its worst case). Writes <out>/audit-<filter>.json and
// screenshots. SwiftShader is slow (~10-15 min per scenario): run one scenario per call.
// Usage: node dev/hud-audit.mjs [outDir=tools/out/hud-audit] [scenario regex] [--dpr=2] [--lead=0.3]
//        [--sizes=1710x876,1920x1080] [--union=0] [--feed=0] [--hud=clean|standard|coach]
//        [--profile=human|user1|precise] [--aplatency=0.11] [--reps=1] [--after=0]
//   --profile / --aplatency: the autopilot's play (round 6 merge: 'user1' = the real MacBook Air
//   session at 0.142 s); --reps=N: N more live freezes (later balls, first size only) for the overlap
//   count; --after=1: a frame 0.45 s after a hit (the feedback line with the shot, km/h and power pips).
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const opt = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')));
const ROOT = resolve(new URL('..', import.meta.url).pathname);
const OUT = resolve(args[0] || 'tools/out/hud-audit');
const filter = args[1] ? new RegExp(args[1]) : null;
const DPR = Number(opt.dpr || 2);
const LEAD = Number(opt.lead || 0.3);
const SIZES = (opt.sizes || '1710x876,1920x1080').split(',').map((s) => s.split('x').map(Number));
const UNION = opt.union !== '0';
await mkdir(OUT, { recursive: true });
const { startServer } = await import(`${ROOT}/tools/serve.mjs`);
let chromium;
try { ({ chromium } = await import('playwright')); } catch { ({ chromium } = await import('/opt/node-tools/node_modules/playwright/index.mjs')); }
// The player's saved settings from their diagnostics (2026-10-04, MacBook Air 15", close mode).
const USER_SETTINGS = {"assist": "rookie", "latency": 0.142, "height": 1.75, "handed": "right", "gainLateral": 2.6, "gainDepth": 2.2, "hfovDeg": 68, "cameraPreset": "macbook-builtin", "gazeFollow": true, "fov": 74, "landingMarker": true, "contactGhost": true, "halo": true, "quality": "high", "voice": "en", "volumes": {"master": 0.9, "sfx": 1, "ambience": 0.5, "crowd": 0.7}, "hitPrediction": true, "hitMode": "auto", "learningSlowmo": "auto", "timingTick": false, "racketGhost": true, "cameraTilt": "auto", "skinTone": "#c58c6a", "racketColor": "#e8572a", "pip": true, "skeleton": true, "ballVisibility": "enhanced", "venue": "sunset", "umpireLang": "es", "callouts": true, "autoReplay": true, "racketModel": "fang", "outfit": "club", "viewPitch": -14, "eyeOffset": {"back": 0.12, "down": 0.06}, "offAxisYaw": false, "glassView": "mirror"};
if (opt.hud) USER_SETTINGS.hud = opt.hud;

const BASE = `autopilot=1&approfile=${opt.profile || 'human'}&aplatency=${opt.aplatency || 0.11}&apdelivery=0.15&apclose=1&sw=0&mute=1&attract=0&quality=balanced&speed=3&autoreplay=0`;
const REPS = Number(opt.reps || 1);
const SCEN = [
  ['drill-fh', 'drill=fh-drive'],
  ['drill-glass', 'drill=back-glass'],
  ['drill-bandeja', 'drill=bandeja'],
  ['rally', 'mode=rally&level=club'],
  ['match', 'mode=match&level=rookie'],
  ['arcade-portres', 'challenge=por-tres-party'],
  ['arcade-glass', 'challenge=glass-breaker'],
  ['arcade-marathon', 'challenge=rally-marathon'],
  ['arcade-volley', 'challenge=volley-wall'],
  ['career', 'career=club-open&quick=1'],
];

const server = await startServer(0);
const port = server.address().port;
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });

/** In-page measurement: visible HUD blocks, the ball (now + path to t*), the racket box, overlaps. */
async function measure(page, label) {
  return page.evaluate(async ({ label }) => {
    const V = window.__vibora;
    const W = innerWidth, H = innerHeight;
    const cam = V.stage.app.camera;
    const vm = cam.matrixWorldInverse.elements, pm = cam.projectionMatrix.elements;
    const proj = (p) => {
      const x = p.x, y = p.y, z = p.z;
      const vx = vm[0] * x + vm[4] * y + vm[8] * z + vm[12];
      const vy = vm[1] * x + vm[5] * y + vm[9] * z + vm[13];
      const vz = vm[2] * x + vm[6] * y + vm[10] * z + vm[14];
      const cx = pm[0] * vx + pm[4] * vy + pm[8] * vz + pm[12];
      const cy = pm[1] * vx + pm[5] * vy + pm[9] * vz + pm[13];
      const cw = pm[3] * vx + pm[7] * vy + pm[11] * vz + pm[15];
      if (cw <= 1e-4) return null;
      return { x: (cx / cw * 0.5 + 0.5) * W, y: (0.5 - cy / cw * 0.5) * H, depth: -vz };
    };
    const { RACKET, BALL } = await import('/src/config.js');
    const { predictFlight } = await import('/src/game/world.js');
    const w = V.world;
    const ball = V.stage.shownBall || (w && w.ball);
    const tanH = Math.tan((cam.fov * Math.PI) / 360);
    let ballNow = null;
    if (ball && !ball.atRest) {
      const p = proj(ball.pos);
      if (p) ballNow = { x: p.x, y: p.y, r: Math.max(3, (BALL.radius * (V.stage.ballView.displayScale || 1)) / (p.depth * tanH) * H / 2) };
    }
    const P = w && w.timing && w.timing.plan;
    const path = [];
    if (w && w.ball && !w.ball.atRest) {
      try {
        const pred = predictFlight(w, { maxTime: 2.5 });
        const tEnd = P && P.tStar ? P.tStar + 0.1 : w.time + 1.2;
        for (let i = 0; i < pred.samples.length; i += 3) {
          const s = pred.samples[i];
          if (s.t > tEnd) break;
          const p = proj(s.pos);
          if (p) path.push({ x: p.x, y: p.y, t: s.t, r: Math.max(3, BALL.radius / (p.depth * tanH) * H / 2) });
        }
      } catch (err) { /* no prediction */ }
    }
    let racket = null;
    const rm = V.stage.rig && V.stage.rig.racketMesh;
    if (rm && rm.visible !== false) {
      rm.updateMatrixWorld(true);
      const m = rm.matrixWorld.elements;
      const sx = RACKET.faceSemiX + RACKET.frameWidth, top = RACKET.faceCenterY + RACKET.faceSemiY + RACKET.frameWidth;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, n = 0;
      for (const lx of [-sx, sx]) for (const ly of [-0.06, top]) for (const lz of [-0.02, 0.02]) {
        const wp = { x: m[0] * lx + m[4] * ly + m[8] * lz + m[12], y: m[1] * lx + m[5] * ly + m[9] * lz + m[13], z: m[2] * lx + m[6] * ly + m[10] * lz + m[14] };
        const p = proj(wp);
        if (!p) continue;
        n++;
        x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
      }
      if (n) racket = { x0: Math.max(0, x0), y0: Math.max(0, y0), x1: Math.min(W, x1), y1: Math.min(H, y1), onScreen: x1 > 0 && x0 < W && y1 > 0 && y0 < H };
    }
    // Visible HUD blocks.
    // HUD blocks (the top-left / top-right columns by their children, as ui.js guards them).
    const sel = '.vp-hud > :not(.hud-tl):not(.hud-tr):not(.hud-bar), .vp-hud .hud-bar > *, .vp-hud .hud-tl > *, .vp-hud .hud-tr > *, .vp-banner .banner, .vp-toasts .toast, .vp-achievements .ach-toast, .vp-replay, .vp-pausehold, .vp-debug';
    const blocks = [];
    const visibleEl = (el) => {
      if (el.hidden || el.closest('[hidden]')) return false;
      let o = 1;
      for (let e = el; e && e !== document.body; e = e.parentElement) {
        const cs = getComputedStyle(e);
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
        o *= Number(cs.opacity);
      }
      return o > 0.06;
    };
    for (const el of document.querySelectorAll(sel)) {
      if (!visibleEl(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      if (r.width >= W * 0.98 && r.height >= H * 0.98) continue; // layers
      blocks.push({ cls: el.className && el.className.baseVal === undefined ? String(el.className).split(' ').slice(0, 2).join('.') : el.tagName, x0: r.left, y0: r.top, x1: r.right, y1: r.bottom, text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60) });
    }
    const CR = { x0: 0.15 * W, y0: 0.2 * H, x1: 0.85 * W, y1: H };
    const inter = (a, b, m = 0) => a.x1 > b.x0 - m && a.x0 < b.x1 + m && a.y1 > b.y0 - m && a.y0 < b.y1 + m;
    const circ = (c, b) => { const dx = Math.max(b.x0 - c.x, 0, c.x - b.x1), dy = Math.max(b.y0 - c.y, 0, c.y - b.y1); return dx * dx + dy * dy <= (c.r + 6) * (c.r + 6); };
    const overlaps = [];
    for (const b of blocks) {
      const o = { cls: b.cls, text: b.text, central: inter(b, CR), ballNow: !!(ballNow && circ(ballNow, b)), path: path.filter((p) => p.x >= 0 && p.x <= W && p.y >= 0 && p.y <= H && circ(p, b)).length, racket: !!(racket && racket.onScreen && inter(b, racket, 4)) };
      if (o.central || o.ballNow || o.path || o.racket) overlaps.push(o);
    }
    const area = blocks.reduce((s, b) => s + Math.max(0, Math.min(b.x1, CR.x1) - Math.max(b.x0, CR.x0)) * Math.max(0, Math.min(b.y1, CR.y1) - Math.max(b.y0, CR.y0)), 0);
    return {
      label, W, H, time: w ? w.time : null, tStar: P ? P.tStar : null, ballNow, racket, pathN: path.length,
      pathOnScreen: path.filter((p) => p.x >= 0 && p.x <= W && p.y >= 0 && p.y <= H).length, blocks, overlaps,
      centralAreaPct: Math.round((area / ((CR.x1 - CR.x0) * (CR.y1 - CR.y0))) * 1000) / 10,
      hudMode: document.querySelector('.vp') ? document.querySelector('.vp').dataset.hud || null : null,
    };
  }, { label });
}

/** Freezes the sim LEAD s before the autopilot's planned contact (tick-precise freeze rule), after `wait` s of play. */
async function freezeBeforeContact(page, lead, wait = 4) {
  await page.waitForFunction((wait) => { const V = window.__vibora; if (!V.world) return false; window.__t0 = window.__t0 ?? V.world.time; return V.world.time > window.__t0 + wait; }, wait, { timeout: 600000, polling: 250 });
  await page.evaluate((lead) => window.__vibora.freezeOn('contact', lead), lead);
  await page.waitForFunction(() => window.__vibora.frozen, null, { timeout: 600000, polling: 250 });
  // Two rendered frames on the frozen state.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

async function forceUnion(page) {
  await page.evaluate(() => {
    // Freeze the UI's own time for the capture (software GL draws a frame every few seconds): no
    // CSS animations, no expiry timers, a still performance.now (the feedback line's clock).
    const st = document.createElement('style');
    st.textContent = '.vp *, .vp *::before, .vp *::after { animation: none !important; transition: none !important; }';
    document.head.appendChild(st);
    const t0 = performance.now();
    performance.now = () => t0;
    window.setTimeout = () => 0;
    const V = window.__vibora;
    const ui = document.getElementById('ui').viboraUi;
    const w = V.world;
    const bus = w.bus;
    // Everything transient that can appear during play, at once (worst case).
    bus.emit('player:miss', { reason: 'early', text: 'Swing was 0.42 s early', es: 'Golpeaste 0,42 s pronto', at: w.time, e: -0.42 });
    bus.emit('challenge:perfect', { streak: 3 });
    bus.emit('partner:call', { who: 'Lucía', text: '¡Mía!', en: 'Mine!', kind: 'mine' });
    bus.emit('coach:cue', { text: 'Turn your shoulders early and finish over the other shoulder', es: '', priority: 2 });
    if (ui) {
      ui.achievement({ name: 'Hot streak', desc: 'Five perfect hits in a row', xp: 50, tier: 'silver', icon: 'flame' });
      ui.banner('¡Por tres!', 'por-tres');
      ui.shotCard({ by: 'player', stroke: 'forehand', speedOut: 18, spinRpm: { total: 1400, top: 900 }, netClearance: 0.42, quality: 0.8, timing: 'early', spacing: 'good', notes: ['Contact a little further in front of your hip'] });
      if (ui.timingCue) ui.timingCue('now');
    }
  });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.waitForTimeout(300);
}

const report = {};
for (const [name, q] of SCEN) {
  if (filter && !filter.test(name)) continue;
  const t0 = Date.now();
  const [w0, h0] = SIZES[0];
  const ctx = await browser.newContext({ viewport: { width: w0, height: h0 }, deviceScaleFactor: DPR });
  await ctx.addInitScript((s) => {
    try {
      localStorage.setItem('vibora.settings.v1', JSON.stringify(s));
    } catch { /* ignore */ }
  }, USER_SETTINGS);
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  page.setDefaultTimeout(300000);
  const rec = { errors };
  try {
    await page.goto(`http://127.0.0.1:${port}/index.html?${BASE}&${q}`);
    await page.waitForFunction(() => window.__vibora && window.__vibora.ready && window.__vibora.world, null, { timeout: 300000 });
    await freezeBeforeContact(page, LEAD, name.startsWith('drill') ? 6 : 4);
    for (const [w, h] of SIZES) {
      await page.setViewportSize({ width: w, height: h });
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      await page.waitForTimeout(400);
      rec[`live-${w}`] = await measure(page, `${name} live ${w}x${h}`);
      await page.screenshot({ path: `${OUT}/${name}-live-${w}.png`, timeout: 300000 });
    }
    // More balls (first size): the live overlap count over several contacts.
    for (let i = 1; i < REPS; i++) {
      await page.setViewportSize({ width: w0, height: h0 });
      await page.evaluate(() => { window.__vibora.resume(); window.__t0 = window.__vibora.world.time; });
      await freezeBeforeContact(page, LEAD, 0.5);
      await page.waitForTimeout(400);
      rec[`live${i + 1}-${w0}`] = await measure(page, `${name} live#${i + 1} ${w0}x${h0}`);
      await page.screenshot({ path: `${OUT}/${name}-live${i + 1}-${w0}.png`, timeout: 300000 });
    }
    if (opt.after === '1') {
      // The feedback line after a hit: the shot line (km/h, chips, power pips) once the ball has gone.
      await page.setViewportSize({ width: w0, height: h0 });
      await page.evaluate(() => { window.__vibora.resume(); window.__vibora.freezeOn('hit', 0.45); });
      await page.waitForFunction(() => window.__vibora.frozen, null, { timeout: 600000, polling: 250 });
      // Software GL draws a frame every second or so: the 1.6 s shot line would expire between two
      // frames. Hold the UI's clock the moment the line shows the shot (as forceUnion does).
      await page.waitForFunction(() => {
        const ui = document.getElementById('ui').viboraUi;
        const m = ui && ui.feedLine;
        if (!m || !/km\/h/.test(m.text)) return false;
        const st = document.createElement('style');
        st.textContent = '.vp *, .vp *::before, .vp *::after { animation: none !important; transition: none !important; }';
        document.head.appendChild(st);
        const t0 = performance.now();
        performance.now = () => t0;
        return true;
      }, null, { timeout: 60000, polling: 30 }).catch(() => {});
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      rec[`after-${w0}`] = await measure(page, `${name} after-hit ${w0}x${h0}`);
      rec[`after-${w0}`].feedLine = await page.evaluate(() => { const ui = document.getElementById('ui').viboraUi; return ui ? ui.feedLine : null; });
      rec[`after-${w0}`].lastShot = await page.evaluate(() => { const s = window.__vibora.game.stats.lastShot; return s ? { stroke: s.stroke, kmh: Math.round(s.speedOut * 3.6), effort: s.effort, timing: s.timing } : null; });
      await page.screenshot({ path: `${OUT}/${name}-after-${w0}.png`, timeout: 300000 });
    }
    if (UNION) {
      await page.setViewportSize({ width: w0, height: h0 });
      await forceUnion(page);
      for (const [w, h] of SIZES.slice(0, 1)) {
        await page.setViewportSize({ width: w, height: h });
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
        await page.waitForTimeout(400);
        rec[`union-${w}`] = await measure(page, `${name} union ${w}x${h}`);
        await page.screenshot({ path: `${OUT}/${name}-union-${w}.png`, timeout: 300000 });
      }
    }
    if (UNION && opt.feed !== '0') {
      // Worst case of the clean HUD: the feedback line released while the ball is still live (as when it
      // goes away to the far court) - is it clear of the ball's path and the racket?
      await page.setViewportSize({ width: w0, height: h0 });
      await page.evaluate(() => {
        const ui = document.getElementById('ui').viboraUi;
        if (ui && ui.bindPlay) ui.bindPlay({ live: () => true, incoming: () => false });
      });
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      await page.waitForTimeout(400);
      rec[`feed-${w0}`] = await measure(page, `${name} feed ${w0}x${h0}`);
      rec[`feed-${w0}`].feedLine = await page.evaluate(() => { const ui = document.getElementById('ui').viboraUi; return ui ? ui.feedLine : null; });
      await page.screenshot({ path: `${OUT}/${name}-feed-${w0}.png`, timeout: 300000 });
    }
    rec.appErrors = await page.evaluate(() => window.__vibora.errors);
  } catch (err) {
    rec.fail = String(err && err.message ? err.message : err).split('\n')[0];
    try { await page.screenshot({ path: `${OUT}/${name}-fail.png`, timeout: 120000 }); } catch { /* ignore */ }
  }
  rec.seconds = Math.round((Date.now() - t0) / 1000);
  report[name] = rec;
  const s = (k) => (rec[k] ? `${rec[k].overlaps.length} overlaps, central ${rec[k].centralAreaPct}%` : '-');
  const more = Array.from({ length: Math.max(0, REPS - 1) }, (_, i) => ` | live#${i + 2}: ${s(`live${i + 2}-${SIZES[0][0]}`)}`).join('');
  const after = rec[`after-${SIZES[0][0]}`];
  console.log(`${name}: ${rec.fail ? `FAIL ${rec.fail}` : 'ok'} (${rec.seconds}s) live1710: ${s(`live-${SIZES[0][0]}`)}${SIZES[1] ? ` | live${SIZES[1][0]}: ${s(`live-${SIZES[1][0]}`)}` : ''}${more} | union1710: ${s(`union-${SIZES[0][0]}`)} | feed1710: ${s(`feed-${SIZES[0][0]}`)}${after ? ` | after: ${JSON.stringify(after.feedLine)} ${JSON.stringify(after.lastShot)}` : ''} errors ${errors.length + (rec.appErrors || []).length}`);
  await writeFile(`${OUT}/audit-${filter ? filter.source.replace(/[^a-z0-9-]/gi, '_') : 'all'}.json`, JSON.stringify(report, null, 1));
  await ctx.close();
}
await browser.close();
server.close();
