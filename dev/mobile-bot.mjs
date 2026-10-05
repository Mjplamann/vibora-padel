// Swipe bot for swipe mode (dev/mobile.html): Playwright Chromium with an iPhone 15 Pro descriptor
// (390x844 @3, isMobile, hasTouch, iOS Safari UA) plays the REAL app modules with real touch events
// (CDP Input.dispatchTouchEvent) timed at the timing plan's t*, with varied speed / aim / path.
//
// Time: the page runs ?lockstep=1 — a virtual clock the bot advances frame by frame (__vpm.step) —
// and every touch carries a virtual timestamp (CDP `timestamp`, honoured as Event.timeStamp), so the
// software renderer's frame rate cannot skew the timing being measured. Touch samples are 120 Hz
// (ProMotion), the finger lands ~70 ms before it moves and lifts at the end of the stroke.
//
// Reports: hit rate (all swipes and per drill), pace spread vs swipe speed (Pearson r), aim control
// (landing x vs the swipe's aim), path -> spin / shot kind, and screenshots of landscape and portrait
// play, the tutorial, the pause menu and the swipe settings. Zero console errors expected.
//
// Usage: node dev/mobile-bot.mjs [outDir] [ballsPerRun=24] [sigmaMs=30] [onlyRegex] [extraQuery]
//   onlyRegex limits the parts run: fh-drive | bh-drive | smash-x3 | volleys | portrait | tutorial
import { mkdir, writeFile } from 'node:fs/promises';
import { startServer } from '../tools/serve.mjs';

async function loadPlaywright() {
  try { return await import('playwright'); } catch { return await import('/opt/node-tools/node_modules/playwright/index.mjs'); }
}

const OUT = process.argv[2] || 'tools/out/mobile';
const BALLS = Number(process.argv[3]) || 24;
const SIGMA = Number.isFinite(Number(process.argv[4])) ? Number(process.argv[4]) : 30;
const ONLY = process.argv[5] ? new RegExp(process.argv[5]) : null;
const want = (part) => !ONLY || ONLY.test(part);
const EXTRA_Q = process.argv[6] || ''; // e.g. 'assist=pro'
await mkdir(OUT, { recursive: true });
const { chromium } = await loadPlaywright();
const server = await startServer(0);
const port = server.address().port;
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const IPHONE = { deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: UA };
const DISPLAY_LATENCY_MS = 45; // src/input/touch.js TOUCH.displayLatency: a human's peak lands this late

// Seeded RNG (reproducible runs).
let rs = 12345;
const rnd = () => ((rs = (rs * 1664525 + 1013904223) >>> 0) / 4294967296);
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
const pick = (a) => a[Math.floor(rnd() * a.length)];

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  return sxx > 0 && syy > 0 ? +(sxy / Math.sqrt(sxx * syy)).toFixed(3) : null;
}
function slope(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
  }
  return sxx > 0 ? +(sxy / sxx).toFixed(3) : null;
}
const pct = (a, p) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))];
};

async function openPage(name, { w, h, query }) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, ...IPHONE });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console ${m.text()}`); });
  await page.goto(`http://127.0.0.1:${port}/dev/mobile.html?lockstep=1&mute=1&${query}${EXTRA_Q ? `&${EXTRA_Q}` : ''}`);
  await page.waitForFunction(() => window.__vpm && window.__vpm.ready, null, { timeout: 120000 });
  const cdp = await ctx.newCDPSession(page);
  const origin = await page.evaluate(() => performance.timeOrigin);
  const S = {
    name, ctx, page, cdp, origin, errors, w, h,
    /** Advance the virtual clock to vTarget (ms) in frames of <= 1/60 s. */
    /** Advance the virtual clock to vTarget (ms) in frames of <= maxStep ms (the sim's own step is fixed). */
    stepTo: (vTarget, render = false, maxStep = 1000 / 60) => page.evaluate(([vt, r, ms]) => {
      let out = null;
      let guard = 0;
      while (window.__vpm.vnow < vt - 1e-6 && guard++ < 4000) out = window.__vpm.step(Math.min(ms, vt - window.__vpm.vnow), r);
      return out || { vnow: window.__vpm.vnow, plan: window.__vpm.plan() };
    }, [vTarget, render, maxStep]),
    /** Step until a fresh (undecided, unswiped) plan exists; returns it or null. */
    waitPlan: async (skipKey, maxMs = 15000) => {
      // In chunks, with real time between them: the dev page restarts a finished drill on a timer.
      for (let left = maxMs; left > 0; left -= 2500) {
        const p = await page.evaluate(([skip, max]) => {
          const v = window.__vpm;
          const end = v.vnow + max;
          while (v.vnow < end) {
            const q = v.plan();
            if (q && !q.decided && q.key !== skip && v.simNow() < q.tStar - 0.35) return q;
            v.step(40);
          }
          return null;
        }, [skipKey, Math.min(2500, left)]);
        if (p) return p;
        await page.waitForTimeout(400);
      }
      return null;
    },
    touch: (type, points, tMs) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points, timestamp: (origin + tMs) / 1000 }),
    render: () => page.evaluate(() => window.__vpm.step(1000 / 60, true)),
  };
  return S;
}

/**
 * A one-finger swing: cosine-eased travel (peak speed at the middle), 120 Hz samples, optional curve.
 * speed in screen diagonals / s, len in diagonals, dir {x, y up}, curve = sagitta / chord.
 */
function swipeSamples({ x0, y0, dir, len, speed, curve = 0, tPeak }) {
  const S0 = 0; // placeholder for readability
  void S0;
  return (W, H) => {
    const diag = Math.hypot(W, H);
    const L = len * diag;
    const T = (len * Math.PI) / (2 * speed) * 1000; // ms
    const t0 = tPeak - T / 2;
    const nx = -dir.y, ny = dir.x; // left normal in (x right, y up)
    const pts = [];
    const dt = 1000 / 120;
    pts.push({ t: t0 - 70, x: x0, y: y0, kind: 'touchStart' });
    for (let t = t0 + dt; t < t0 + T + dt * 0.5; t += dt) {
      const u = Math.min(1, (t - t0) / T);
      const s = L * (1 - Math.cos(Math.PI * u)) / 2;
      const bulge = curve * L * Math.sin(Math.PI * u) / 2;
      const xu = x0 + dir.x * s + nx * bulge;
      const yu = y0 - (dir.y * s + ny * bulge);
      pts.push({ t, x: Math.max(1, Math.min(W - 1, xu)), y: Math.max(1, Math.min(H - 1, yu)), kind: 'touchMove' });
    }
    const last = pts[pts.length - 1];
    pts.push({ t: last.t + 12, x: last.x, y: last.y, kind: 'touchEnd' });
    return { pts, T, t0 };
  };
}

async function playSwipe(S, sw) {
  const { pts } = swipeSamples(sw)(S.w, S.h);
  for (const p of pts) {
    await S.stepTo(p.t);
    if (p.kind === 'touchEnd') await S.touch('touchEnd', [], p.t);
    else await S.touch(p.kind, [{ x: p.x, y: p.y, id: 1, radiusX: 18, radiusY: 18, force: 0.5 }], p.t);
  }
}

/** Swipe parameters for a family and a requested path. */
function design(fam, path, W, H) {
  const speed = 1.3 + rnd() * 4.2; // diag/s: a lazy push .. a hard flick
  const len = 0.14 + rnd() * 0.24;
  const aim = -0.9 + rnd() * 1.8; // requested aimX
  let up;
  let curve = 0;
  if (path === 'up') up = 0.55 + rnd() * 0.35;
  else if (path === 'flat') up = -0.15 + rnd() * 0.3;
  else if (path === 'down') up = -(0.6 + rnd() * 0.35);
  else if (path === 'curve') { up = 0.2 + rnd() * 0.3; curve = (rnd() < 0.5 ? -1 : 1) * (0.3 + rnd() * 0.25); }
  else if (path === 'lob') up = 0.97;
  let dx = aim / 1.35;
  if (path === 'lob') dx = aim * 0.15;
  // A flat swipe is a sideways one: its horizontal share is the aim (swipe.js aimX saturates).
  if (path === 'flat') dx = aim >= 0 ? 1 : -1;
  const n = Math.hypot(dx, up) || 1;
  const dir = { x: dx / n, y: up / n };
  const L = path === 'lob' ? 0.3 + rnd() * 0.1 : len;
  const V = path === 'lob' ? 1.3 + rnd() * 0.4 : speed;
  // Start so the whole stroke stays on the canvas and clear of the top-right buttons.
  const diag = Math.hypot(W, H);
  const fx = fam === 'bh' || fam === 'vbh' ? 0.38 : 0.62;
  let x0 = W * fx - dir.x * L * diag * 0.5;
  let y0 = H * 0.6 + dir.y * L * diag * 0.5;
  x0 = Math.max(30, Math.min(W - 30, x0));
  y0 = Math.max(H * 0.25, Math.min(H - 20, y0));
  const aimReq = Math.max(-1, Math.min(1, dir.x * 1.35));
  return { speed: V, len: L, dir, curve, aimReq, path, x0, y0 };
}

async function runDrill(S, { drill, balls, paths, shotsAt = [] }) {
  const out = [];
  let skip = null;
  const shots0 = await S.page.evaluate(() => window.__vpm.shots().length);
  for (let i = 0; i < balls; i++) {
    const plan = await S.waitPlan(skip);
    if (!plan) break;
    skip = plan.key;
    if (plan.serve) {
      // Serve: a tap (the controller schedules the underhand serve so it meets the ball at t*).
      const v0 = (await S.page.evaluate(() => window.__vpm.vnow)) + 30;
      const nLog0 = await S.page.evaluate(() => window.__vpm.log().length);
      await S.stepTo(v0);
      await S.touch('touchStart', [{ x: S.w * 0.6, y: S.h * 0.55, id: 1 }], v0);
      await S.stepTo(v0 + 70);
      await S.touch('touchEnd', [], v0 + 70);
      await S.stepTo(v0 + 3200, false, 40);
      const log = await S.page.evaluate(() => window.__vpm.log());
      const rec = log.filter((l) => l.key === plan.key).pop() || log[log.length - 1] || null;
      const o = { i, drill, fam: 'serve', path: 'tap', result: rec ? rec.result : 'no-swing', kind: rec ? rec.kind : null, shotId: rec ? rec.shotId : null, e: rec && rec.e !== null ? +(rec.e * 1000).toFixed(1) : null, effort: rec ? +rec.effort.toFixed(3) : null };
      const sh = o.shotId != null ? await S.page.evaluate((id) => window.__vpm.shots().filter((x) => x.id === id).pop() || null, o.shotId) : null;
      if (sh) Object.assign(o, { kmh: sh.kmh, landX: sh.landing ? sh.landing.x : null, landZ: sh.landing ? sh.landing.z : null, stroke: sh.stroke, type: sh.type });
      out.push(o);
      void nLog0;
      continue;
    }
    const fam = plan.family;
    const path = typeof paths === 'function' ? paths(i, fam) : pick(paths);
    const d = design(fam, path, S.w, S.h);
    const errMs = SIGMA * gauss();
    // Wait until shortly before the swing, then read t* -> virtual ms at the current clock rate.
    const lead = (d.len * Math.PI) / (2 * d.speed) * 1000 / 2 + 140;
    const tPeakEst = await S.page.evaluate((ts) => window.__vpm.perfAt(ts), plan.tStar);
    await S.stepTo(tPeakEst - lead - 200, false, 40);
    const tPeak = (await S.page.evaluate((ts) => window.__vpm.perfAt(ts), plan.tStar)) + DISPLAY_LATENCY_MS + errMs;
    if (shotsAt.includes(i)) {
      // Just before contact: the approach circle closing on the ball (workflow A's cue) in this view.
      await S.stepTo(tPeak - DISPLAY_LATENCY_MS - errMs - 230, true);
      await shot(S, `${S.name}-${drill}-precontact-${i}.png`);
    }
    const nLog0 = await S.page.evaluate(() => window.__vpm.log().length);
    await playSwipe(S, { ...d, tPeak });
    if (shotsAt.includes(i)) {
      // Screenshot right after contact (ball leaving the racket) in the chase view.
      await S.stepTo(tPeak + 140, true);
      await shot(S, `${S.name}-${drill}-contact-${i}.png`);
    }
    await S.stepTo(tPeak + 1300, false, 40);
    const log = await S.page.evaluate(() => window.__vpm.log());
    const rec = log.slice(Math.max(0, nLog0 - (log.length >= 60 ? 1 : 0))).filter((l) => l.key === plan.key).pop() || log[log.length - 1] || null;
    out.push({
      i, drill, fam, path, speedReq: +d.speed.toFixed(2), lenReq: +d.len.toFixed(3), aimReq: +d.aimReq.toFixed(2), curve: d.curve, errMs: +errMs.toFixed(1),
      result: rec ? rec.result : 'no-swing', e: rec && rec.e !== null ? +(rec.e * 1000).toFixed(1) : null, effort: rec ? +rec.effort.toFixed(3) : null,
      kind: rec ? rec.kind : null, aimX: rec ? +rec.aimX.toFixed(2) : null, shotId: rec ? rec.shotId : null,
    });
    // The shot right away: ids restart with every session (a drill restarts after its last ball).
    const o = out[out.length - 1];
    const s = o.shotId !== null && o.shotId !== undefined
      ? await S.page.evaluate((id) => window.__vpm.shots().filter((x) => x.id === id).pop() || null, o.shotId) : null;
    if (s) Object.assign(o, { kmh: s.kmh, landX: s.landing ? s.landing.x : null, landZ: s.landing ? s.landing.z : null, top: s.top, side: s.side, stroke: s.stroke, type: s.type });
  }
  void shots0;
  return out;
}

function summarise(rows) {
  const hits = rows.filter((r) => r.kmh != null);
  const res = {};
  for (const r of rows) res[r.result] = (res[r.result] || 0) + 1;
  const sp = hits.map((r) => r.speedReq), kmh = hits.map((r) => r.kmh), eff = hits.map((r) => r.effort);
  const withLand = hits.filter((r) => r.landX != null && r.path !== 'lob');
  const byPath = {};
  for (const r of hits) {
    const b = (byPath[r.path] ||= { n: 0, top: [], side: [], kinds: {} });
    b.n++;
    if (r.top != null) b.top.push(r.top);
    if (r.side != null) b.side.push(r.side);
    b.kinds[r.kind] = (b.kinds[r.kind] || 0) + 1;
  }
  for (const b of Object.values(byPath)) {
    b.topMed = pct(b.top, 50);
    b.sideAbsMed = pct(b.side.map(Math.abs), 50);
    delete b.top;
    delete b.side;
  }
  // Aim within each drill / family (forehand and backhand land on opposite sides): centred landings.
  const groups = {};
  for (const r of withLand) (groups[`${r.drill}:${r.fam}`] ||= []).push(r);
  const ca = [], cx = [];
  for (const g of Object.values(groups)) {
    if (g.length < 2) continue;
    const m = g.reduce((a, r) => a + r.landX, 0) / g.length;
    for (const r of g) { ca.push(r.aimReq); cx.push(r.landX - m); }
  }
  const absE = rows.filter((r) => r.e != null).map((r) => Math.abs(r.e));
  return {
    swipes: rows.length, hits: hits.length, hitRate: rows.length ? +(hits.length / rows.length).toFixed(3) : null, results: res,
    timingAbsErrMs: { p50: pct(absE, 50), p90: pct(absE, 90) },
    pace: { kmhMin: pct(kmh, 0), kmhP10: pct(kmh, 10), kmhP50: pct(kmh, 50), kmhP90: pct(kmh, 90), kmhMax: pct(kmh, 100), rSpeed: pearson(sp, kmh), rEffort: pearson(eff, kmh), kmhPerDiagPerS: slope(sp, kmh) },
    aim: { n: withLand.length, rLandX: pearson(withLand.map((r) => r.aimReq), withLand.map((r) => r.landX)), mPerAim: slope(withLand.map((r) => r.aimReq), withLand.map((r) => r.landX)), landXRange: [pct(withLand.map((r) => r.landX), 0), pct(withLand.map((r) => r.landX), 100)], rWithinDrill: pearson(ca, cx), mPerAimWithinDrill: slope(ca, cx) },
    byPath,
  };
}

async function shot(S, file) {
  try {
    await S.page.screenshot({ path: `${OUT}/${file}`, timeout: 45000, animations: 'disabled' });
  } catch (err) {
    try {
      const r = await S.cdp.send('Page.captureScreenshot', { format: 'png' });
      await writeFile(`${OUT}/${file}`, Buffer.from(r.data, 'base64'));
    } catch (e2) { console.log('screenshot failed', file, e2.message); }
  }
}

const report = { extraQuery: EXTRA_Q, device: 'iPhone 15 Pro (390x844 @3, isMobile, hasTouch, iOS 17 Safari UA) on Chromium', sigmaMs: SIGMA, runs: {}, errors: {} };
const t0 = Date.now();
const save = () => writeFile(`${OUT}/report.json`, JSON.stringify(report, null, 1));

// ---- 1. landscape play: forehand drive, backhand drive, overheads, a lob drill --------------------
if (want('fh-drive')) {
  const S = await openPage('landscape', { w: 844, h: 390, query: 'tutorial=0&seed=11&drill=fh-drive' });
  await S.render();
  await shot(S, `landscape-start.png`);
  const rows = await runDrill(S, { drill: 'fh-drive', balls: BALLS, paths: (i) => (i % 8 === 7 ? 'lob' : i % 8 === 5 ? 'curve' : i % 8 === 3 ? 'down' : i % 8 === 6 ? 'flat' : 'up'), shotsAt: [2] });
  report.runs['fh-drive'] = { rows, summary: summarise(rows) };
  console.log('fh-drive', JSON.stringify(report.runs['fh-drive'].summary));
  await save();
  // Two-finger tap -> pause menu.
  const v = (await S.page.evaluate(() => window.__vpm.vnow)) + 20;
  await S.stepTo(v);
  await S.touch('touchStart', [{ x: 300, y: 200, id: 1 }, { x: 420, y: 210, id: 2 }], v);
  await S.stepTo(v + 90);
  await S.touch('touchEnd', [], v + 90);
  await S.stepTo(v + 200, true);
  await S.page.waitForTimeout(400);
  report.pauseByTwoFingerTap = await S.page.evaluate(() => window.__vpm.screen);
  await shot(S, `landscape-pause.png`);
  const resume = S.page.locator('[data-action="resume"]');
  if (await resume.count()) await resume.first().tap();
  await S.stepTo(v + 400, true);
  report.resumedScreen = await S.page.evaluate(() => window.__vpm.screen);
  // The view button: first person.
  const fpBtn = S.page.locator('[data-vpm="view"]');
  if (await fpBtn.count()) {
    await fpBtn.first().tap();
    const plan = await S.waitPlan(null);
    if (plan) await S.stepTo((await S.page.evaluate((ts) => window.__vpm.perfAt(ts), plan.tStar)) - 120, true);
    else await S.stepTo((await S.page.evaluate(() => window.__vpm.vnow)) + 300, true);
    await shot(S, `landscape-first-person.png`);
    report.fpView = await S.page.evaluate(() => window.__vpm.stats().view);
    await fpBtn.first().tap();
  }
  report.errors.landscape = [...S.errors, ...(await S.page.evaluate(() => window.__vpm.errors))];
  report.landscapeStats = await S.page.evaluate(() => window.__vpm.stats());
  await S.ctx.close();
}
for (const [drill, balls, paths] of [['bh-drive', Math.ceil(BALLS / 2), ['up', 'up', 'flat', 'down']], ['smash-x3', Math.ceil(BALLS / 3), ['down', 'down', 'flat', 'curve']], ['volleys', Math.ceil(BALLS / 3), ['flat', 'up', 'down']], ['serve', 6, ['up']]]) {
  if (!want(drill)) continue;
  const S = await openPage(`landscape-${drill}`, { w: 844, h: 390, query: `tutorial=0&seed=5&drill=${drill}` });
  const rows = await runDrill(S, { drill, balls, paths, shotsAt: drill === 'smash-x3' ? [1] : [] });
  report.runs[drill] = { rows, summary: summarise(rows) };
  console.log(drill, JSON.stringify(report.runs[drill].summary));
  await save();
  report.errors[drill] = [...S.errors, ...(await S.page.evaluate(() => window.__vpm.errors))];
  await S.ctx.close();
}

// ---- 2. portrait play + rotate hint --------------------------------------------------------------
if (want('portrait')) {
  const S = await openPage('portrait', { w: 390, h: 844, query: 'tutorial=0&seed=21&drill=fh-drive' });
  await S.render();
  await shot(S, `portrait-start.png`);
  const rows = await runDrill(S, { drill: 'fh-drive', balls: Math.ceil(BALLS / 2), paths: ['up', 'up', 'flat', 'down', 'curve'], shotsAt: [1] });
  report.runs['portrait-fh-drive'] = { rows, summary: summarise(rows) };
  console.log('portrait', JSON.stringify(report.runs['portrait-fh-drive'].summary));
  report.errors.portrait = [...S.errors, ...(await S.page.evaluate(() => window.__vpm.errors))];
  report.portraitStats = await S.page.evaluate(() => window.__vpm.stats());
  await S.ctx.close();
}

// ---- 3. first-run tutorial (fresh storage) + the swipe settings sheet --------------------------
if (want('tutorial')) {
  const S = await openPage('tutorial', { w: 844, h: 390, query: 'seed=3&tutorial=1' });
  await S.render();
  await S.page.waitForTimeout(600);
  await shot(S, `tutorial-1.png`);
  report.tutorial = { visible: await S.page.evaluate(() => !!document.querySelector('.vpm-tutorial:not([hidden])')) };
  // A swipe in the tutorial gives feedback and advances.
  let v = (await S.page.evaluate(() => window.__vpm.vnow)) + 200;
  await playSwipe(S, { x0: 520, y0: 300, dir: { x: 0.35, y: 0.94 }, len: 0.25, speed: 3.5, tPeak: v });
  await S.stepTo(v + 150, true);
  await S.page.waitForTimeout(300);
  report.tutorial.feedback = await S.page.evaluate(() => (document.querySelector('.vpm-tut-try') || {}).textContent || null);
  await shot(S, `tutorial-1-feedback.png`);
  for (const k of [2, 3]) {
    const next = S.page.locator('[data-tut="next"]');
    if (await next.count()) await next.first().tap().catch(() => {});
    await S.page.waitForTimeout(1300);
    await S.render();
    await shot(S, `tutorial-${k}.png`);
  }
  const go = S.page.locator('[data-tut="next"]');
  if (await go.count()) await go.first().tap().catch(() => {});
  await S.page.waitForTimeout(600);
  v = (await S.page.evaluate(() => window.__vpm.vnow)) + 600;
  await S.stepTo(v, true);
  report.tutorial.after = { screen: await S.page.evaluate(() => window.__vpm.screen), stored: await S.page.evaluate(() => localStorage.getItem('vibora.mobile.v1')) };
  // Swipe settings sheet: the pause button, then the gear (shown on the pause screen).
  await S.page.locator('[data-vpm="pause"]').first().tap().catch(() => {});
  await S.stepTo((await S.page.evaluate(() => window.__vpm.vnow)) + 100, true);
  await S.page.waitForTimeout(300);
  const sheetBtn = S.page.locator('[data-vpm="sheet"]');
  if (await sheetBtn.count()) {
    await sheetBtn.first().tap().catch(() => {});
    await S.page.waitForTimeout(500);
    report.tutorial.sheetOpen = await S.page.evaluate(() => !!document.querySelector('.vpm-sheet:not([hidden])'));
    await shot(S, `swipe-settings.png`);
  }
  report.errors.tutorial = [...S.errors, ...(await S.page.evaluate(() => window.__vpm.errors))];
  await S.ctx.close();
}

// ---- totals -------------------------------------------------------------------------------------
const all = Object.entries(report.runs).filter(([k]) => k !== 'portrait-fh-drive' && k !== 'serve').flatMap(([, r]) => r.rows);
report.total = summarise(all);
report.groundstrokes = summarise([...(report.runs['fh-drive'] || { rows: [] }).rows, ...(report.runs['bh-drive'] || { rows: [] }).rows].filter((r) => r.path !== 'lob'));
report.errorCount = Object.values(report.errors).reduce((a, e) => a + e.length, 0);
report.wallSeconds = Math.round((Date.now() - t0) / 1000);
await writeFile(`${OUT}/report.json`, JSON.stringify(report, null, 1));
console.log('TOTAL', JSON.stringify(report.total));
console.log('GROUND', JSON.stringify(report.groundstrokes));
console.log('pause', report.pauseByTwoFingerTap, 'resumed', report.resumedScreen, 'fpView', report.fpView, 'tutorial', JSON.stringify(report.tutorial));
console.log('errors', report.errorCount, JSON.stringify(report.errors).slice(0, 2000));
await browser.close();
server.close();
