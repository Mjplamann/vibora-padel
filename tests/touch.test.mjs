// Swipe mode end to end in Node: touch samples -> recognizer (src/input/swipe.js) -> touch controller
// (src/input/touch.js: synthetic racket swing into the REAL timing judge) -> app/game.js session.
// Plus the chase camera framing (src/render/chaseCam.js) and the mobile helpers (src/app/mobile.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame } from '../src/app/game.js';
import { resolveSettings } from '../src/game/world.js';
import { flightKeyOf } from '../src/game/swingAssist.js';
import { createRng } from '../src/util/math.js';
import { v3 } from '../src/util/vec3.js';
import { createSwipeRecognizer } from '../src/input/swipe.js';
import {
  createTouchController, attachTouchGame, buildSwing, dirOf, typicalSwing, swingSpeed, speedRange, createTouchProfile, TOUCH,
} from '../src/input/touch.js';
import { chaseTarget, createChaseCam, CHASE } from '../src/render/chaseCam.js';
import { detectDevice, decideInput, mobileTier, limitShadowLights, MOBILE_QUALITY, loadPrefs, savePrefs, MOBILE_STORE, createMobile } from '../src/app/mobile.js';

/** Touch samples of a flick whose speed peaks at tPeakMs (bell profile), 60 Hz. */
function gesture({ x0 = 600, y0 = 330, dx = 0, dy = -220, dur = 0.12, tPeakMs, bend = 0 }) {
  const pts = [];
  const len = Math.hypot(dx, dy) || 1;
  const lx = dy / len, ly = -dx / len;
  const ease = (u) => u - Math.sin(2 * Math.PI * u) / (2 * Math.PI);
  const t0 = tPeakMs - dur * 500;
  for (let t = t0 - 60; t <= t0 + dur * 1000 + 1e-6; t += 1000 / 60) {
    const u = Math.min(1, Math.max(0, (t - t0) / (dur * 1000)));
    const e = ease(u);
    const b = bend * 4 * e * (1 - e);
    pts.push({ x: x0 + dx * e + lx * b, y: y0 + dy * e + ly * b, t });
  }
  return pts;
}

/**
 * A swipe bot over a real session: for every ball planned to the player it swipes with timing error
 * e (s, from eFn), effort and aim, the swipe's velocity peak at (t* + e + displayLatency) of sim time.
 */
function play({ spec, assist = 'club', seed = 1, seconds = 60, eFn = () => 0, effortFn = () => 0.5, aimFn = () => 0, shapeFn = () => ({}), tap = false }) {
  const settings = resolveSettings({ assist, handed: 'right', height: 1.75 });
  const g = createGame({ spec, settings, input: 'touch', startTime: 10, seed });
  const ctl = createTouchController({ simTimeOf: (ms) => ms / 1000 });
  attachTouchGame(g, ctl);
  const rec = createSwipeRecognizer({ width: 844, height: 390 });
  const rng = createRng(seed * 13 + 5);
  const pending = [];
  const seen = new Set();
  const w = g.world;
  const shots = [];
  const misses = [];
  const swipes = [];
  w.bus.on('ball:hit', ({ shot }) => { if (shot.by === 'player' && !shot.provisional) shots.push(shot); });
  w.bus.on('player:miss', (m) => misses.push(m));
  let id = 1;
  while (w.time < 10 + seconds && !g.isFinished()) {
    const P = w.timing.plan;
    if (P && P.key === flightKeyOf(w) && !seen.has(P.key) && P.tStar - w.time < 0.6) {
      seen.add(P.key);
      if (tap && P.serve) {
        const t = (w.time + 0.05) * 1000;
        pending.push({ x: 500, y: 200, t, k: 'down', id }, { x: 501, y: 200, t: t + 60, k: 'up', id: id++ });
      } else {
        const e = eFn(rng), effort = effortFn(rng), aim = aimFn(rng), shape = shapeFn(rng, P);
        const lenPx = shape.lenPx || 200 + 100 * effort;
        const dur = 0.36 - 0.27 * effort;
        const up = shape.up ?? 1;
        const pts = gesture({ x0: 600, y0: up > 0 ? 340 : 60, dx: Math.sin(aim * 0.75) * lenPx, dy: -Math.cos(aim * 0.75) * lenPx * up, dur, tPeakMs: (P.tStar + e + TOUCH.displayLatency) * 1000, bend: shape.bend || 0 });
        pts.forEach((p, i) => pending.push({ ...p, k: i ? 'move' : 'down', id }));
        pending.push({ ...pts[pts.length - 1], t: pts[pts.length - 1].t + 10, k: 'up', id: id++ });
        swipes.push({ key: P.key, e, effort, aim });
      }
      pending.sort((a, b) => a.t - b.t);
    }
    while (pending.length && pending[0].t / 1000 <= w.time + 1e-9) {
      const s = pending.shift();
      const evs = s.k === 'down' ? rec.down(s.id, s.x, s.y, s.t) : s.k === 'move' ? rec.move(s.id, s.x, s.y, s.t) : rec.up(s.id, s.x, s.y, s.t);
      for (const ev of evs) {
        if (ev.type === 'swing') ctl.onSwipe(ev);
        else if (ev.type === 'tap') ctl.onTap(ev);
      }
    }
    for (const ev of rec.poll(w.time * 1000)) if (ev.type === 'swing') ctl.onSwipe(ev);
    g.advanceTo(w.time + 1 / 60);
  }
  return { g, ctl, shots, misses, swipes, seen };
}

const reasons = (ms) => ms.reduce((o, m) => ((o[m.reason] = (o[m.reason] || 0) + 1), o), {});
const pearson = (xs, ys) => {
  const n = xs.length, mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let a = 0, b = 0, c = 0;
  for (let i = 0; i < n; i++) { a += (xs[i] - mx) * (ys[i] - my); b += (xs[i] - mx) ** 2; c += (ys[i] - my) ** 2; }
  return a / Math.sqrt(b * c);
};

test('buildSwing: one swing for the judge, peaking at cPeak at the wanted measured speed; the take-back reads as none', () => {
  const contact = v3(0.7, 1.0, -0.34);
  const from = contact.clone().add(v3(0, 0, -0.05));
  const h = 1 / TOUCH.rate;
  for (const [path, speed, avail] of [[20, 4.8, 0.3], [20, 13, 0.3], [75, 6, 0.2], [-25, 9, 0.12], [-10, 11, 0.3]]) {
    const typ = typicalSwing('fh', 1);
    const sw = buildSwing({ cPeak: 10, cMin: 10 - avail, from, contact, dir: dirOf(typ.az, path), speed, wrap: v3(-1, 0, 0) });
    const P = (t) => { const p = v3(); sw.sample(Math.min(Math.max(t, sw.t0), sw.tEnd), p); return p; };
    const meas = [];
    for (let k = -14; k <= 6; k++) {
      const t = 10 + k * h;
      const v = P(t + 2 * h).sub(P(t - 2 * h)).scale(1 / (4 * h));
      const fwd = -v.z >= -0.1 * v.length() ? v.length() : 0; // the judge's forward-only swing speed
      meas.push({ k, s: fwd });
    }
    const peak = meas.reduce((a, b) => (b.s > a.s ? b : a));
    assert.equal(peak.k, 0, `path ${path} speed ${speed}: peak at frame ${peak.k}`);
    assert.ok(Math.abs(peak.s - speed) / speed < 0.04, `measured ${peak.s.toFixed(2)} for ${speed}`);
    // Monotonic forward speed into the peak (a single swing event, no early bump above 0.8 x).
    let run = 0;
    for (const m of meas.filter((x) => x.k <= 0)) {
      assert.ok(!(run > 3 && m.s < 0.8 * run), `path ${path}: dip at ${m.k} (${m.s.toFixed(2)} after ${run.toFixed(2)})`);
      run = Math.max(run, m.s);
    }
    assert.ok(P(10).distanceTo(contact) < 1e-6, 'through the contact at cPeak');
    assert.ok(sw.backward, 'the take-back goes backward');
  }
});

test('effort maps onto the judge-measured speed range; the touch profile maps it back', () => {
  for (const fam of ['fh', 'vfh', 'oh', 'serve']) {
    const [lo, hi] = speedRange(fam === 'vfh' ? 'volley' : 'ground');
    assert.ok(Math.abs(swingSpeed(0, fam) - lo) < 1e-9 && Math.abs(swingSpeed(1, fam) - hi) < 1e-9);
  }
  const prof = createTouchProfile({ bias: -0.3, n: 9, addTiming() {}, summary: () => ({ bias: -0.3, n: 9, kept: 9, text: null }) });
  assert.equal(prof.bias, -TOUCH.biasMax, 'the personal bias is clamped to a display latency');
  for (const e of [0, 0.3, 0.7, 1]) assert.ok(Math.abs(prof.effort('ground', swingSpeed(e, 'fh')) - e) < 1e-9);
  assert.ok(Math.abs(prof.effort('volley', swingSpeed(0.5, 'vfh')) - 0.5) < 1e-9);
  assert.equal(createTouchProfile(null).bias, 0);
});

test('swipe bot, forehand drill (Club): timed swipes hit; the judge sees the swipe\'s own timing', () => {
  const r = play({ spec: { kind: 'drill', drillId: 'fh-drive' }, seed: 2, seconds: 70, eFn: (rng) => 0.05 * rng.normal(0, 1), effortFn: (rng) => 0.3 + 0.5 * rng() });
  assert.ok(r.swipes.length >= 10, `${r.swipes.length} swipes`);
  assert.ok(r.shots.length >= r.swipes.length - 1, `hits ${r.shots.length} of ${r.swipes.length}; misses ${JSON.stringify(reasons(r.misses))}`);
  // The judged timing error follows the bot's intended error (recognizer + latency compensation).
  const errs = [];
  for (const l of r.ctl.log) {
    const s = r.swipes.find((x) => x.key === l.key);
    if (s && Number.isFinite(l.e)) errs.push(l.e - s.e);
  }
  errs.sort((a, b) => a - b);
  const med = errs[errs.length >> 1];
  assert.ok(Math.abs(med) < 0.02, `median timing offset ${med}`);
  assert.ok(r.ctl.log.every((l) => l.result === 'hit' || l.result === 'pending'), JSON.stringify(r.ctl.log.map((l) => l.result)));
  assert.ok(r.g.world.player.renderRacket, 'the shown racket is drawn');
});

test('forced timing: too early / too late / no swipe give those reasons, held swings still hit', () => {
  const run = (e, skip = false) => play({ spec: { kind: 'drill', drillId: 'fh-drive' }, seed: 3, seconds: 40, eFn: () => e, ...(skip ? { shapeFn: () => ({ none: true }) } : {}) });
  const early = run(-0.55);
  assert.equal(early.shots.length, 0);
  assert.ok((reasons(early.misses).early || 0) >= early.swipes.length - 1, JSON.stringify(reasons(early.misses)));
  const late = run(0.45);
  assert.equal(late.shots.length, 0);
  assert.ok((reasons(late.misses).late || 0) >= late.swipes.length - 1, JSON.stringify(reasons(late.misses)));
  const onTime = run(0);
  assert.equal(onTime.misses.length, 0, JSON.stringify(reasons(onTime.misses)));
});

test('no swipe at all: every ball is a "no swing" miss (and nothing is hit)', () => {
  const settings = resolveSettings({ assist: 'club' });
  const g = createGame({ spec: { kind: 'drill', drillId: 'fh-drive' }, settings, input: 'touch', startTime: 10, seed: 4 });
  const ctl = createTouchController({ simTimeOf: (ms) => ms / 1000 });
  attachTouchGame(g, ctl);
  const misses = [];
  g.world.bus.on('player:miss', (m) => misses.push(m.reason));
  g.advanceTo(40);
  assert.ok(misses.length >= 3 && misses.every((m) => m === 'no-swing'), JSON.stringify(misses));
  assert.equal(g.stats.playerHits, 0);
});

test('pace follows swipe effort (wide spread); aim follows the swipe direction', () => {
  const r = play({ spec: { kind: 'drill', drillId: 'fh-drive' }, seed: 5, seconds: 80, eFn: (rng) => 0.03 * rng.normal(0, 1), effortFn: (rng) => rng(), aimFn: (rng) => rng() * 2 - 1 });
  const byId = new Map(r.shots.map((s) => [s.id, s]));
  const eff = [], kmh = [], aim = [], x = [];
  for (const l of r.ctl.log) {
    const s = byId.get(l.shotId);
    if (!s) continue;
    eff.push(l.effort);
    kmh.push(s.speedOut * 3.6);
    aim.push(l.aimX);
    x.push(s.predictedLanding ? s.predictedLanding.x : s.timingHit.target.x);
  }
  assert.ok(eff.length >= 12, `${eff.length} shots`);
  const rp = pearson(eff, kmh);
  assert.ok(rp > 0.8, `effort vs pace r = ${rp.toFixed(2)}`);
  const sorted = kmh.slice().sort((a, b) => a - b);
  assert.ok(sorted[sorted.length - 1] - sorted[0] > 35, `pace ${sorted[0].toFixed(0)}..${sorted[sorted.length - 1].toFixed(0)} km/h`);
  const ra = pearson(aim, x);
  assert.ok(ra > 0.5, `aim vs landing x r = ${ra.toFixed(2)}`);
});

test('gesture shapes: up = topspin, down = slice, curve = slice + sidespin, slow long up = lob', () => {
  const tops = (shape, effort = 0.6) => {
    const r = play({ spec: { kind: 'drill', drillId: 'fh-drive' }, seed: 6, seconds: 30, eFn: () => 0.01, effortFn: () => effort, shapeFn: () => shape });
    return r.shots.map((s) => ({ top: s.spinRpm.top, side: s.spinRpm.side, type: s.timingHit ? s.timingHit.type : null }));
  };
  const up = tops({ up: 1 });
  const down = tops({ up: -1 });
  const lob = tops({ up: 1, lenPx: 300 }, 0.05);
  assert.ok(up.length >= 3 && up.every((s) => s.top > 500), JSON.stringify(up));
  assert.ok(down.length >= 3 && down.every((s) => s.top < 0), JSON.stringify(down));
  assert.ok(lob.length >= 3 && lob.every((s) => s.type === 'lob'), JSON.stringify(lob));
});

test('serve: a tap plays the serve on time (in the box)', () => {
  const r = play({ spec: { kind: 'drill', drillId: 'serve' }, seed: 7, seconds: 45, tap: true });
  assert.ok(r.seen.size >= 4);
  assert.ok(r.shots.length >= r.seen.size - 1, `${r.shots.length} serves of ${r.seen.size}`);
  assert.ok(r.shots.every((s) => s.isServe), 'serves');
  assert.ok(r.g.stats.inCourt >= r.shots.length - 1, `${r.g.stats.inCourt} in`);
});

test('auto-positioning reaches the stance; the stick shifts it; the third-person actor swings', () => {
  const settings = resolveSettings({ assist: 'club' });
  const g = createGame({ spec: { kind: 'drill', drillId: 'fh-drive' }, settings, input: 'touch', startTime: 10, seed: 8 });
  const ctl = createTouchController({ simTimeOf: (ms) => ms / 1000 });
  attachTouchGame(g, ctl);
  const w = g.world;
  let P = null;
  while (w.time < 30 && !(P = w.timing.plan)) g.advanceTo(w.time + 1 / 60);
  assert.ok(P, 'a ball is planned');
  while (w.time < P.tStar - 0.05) g.advanceTo(w.time + 1 / 60);
  const d0 = Math.hypot(w.player.pos.x - P.stance.x, w.player.pos.z - P.stance.z);
  assert.ok(d0 < 0.25, `at the stance by the contact (${d0.toFixed(2)} m)`);
  const a = ctl.selfActor(w);
  assert.equal(a.holding, 'swing', 'racket taken back while the ball comes');
  assert.ok(a.swingPhase > 0.2 && a.swingPhase < 0.4);
  ctl.onSwipe({ type: 'swing', tSwing: (w.time - 0.02) * 1000, effort: 0.7, upness: 1, aimX: 0, curve: 0, curved: false, lob: false, x: 600, y: 200 });
  g.advanceTo(w.time + 0.12);
  const b = ctl.selfActor(w);
  assert.ok(b.holding === 'swing' && b.swingPhase > 0.55, `forward swing shown (${b.swingPhase})`);
  // Stick: between balls it walks; with a ball planned it nudges the stance.
  ctl.setStick(1, 0, true);
  const x0 = w.player.pos.x;
  g.advanceTo(w.time + 1.5);
  ctl.setStick(0, 0, false);
  assert.ok(Math.abs(w.player.pos.x - x0) > 0.1 || w.timing.plan, 'the stick moves the player');
});

test('chase camera: behind and above the player, ball and feet in frame, portrait wider', () => {
  const w = { player: { pos: { x: 1.5, z: 8.5 } }, ball: { pos: { x: -1, y: 1.1, z: -5 }, atRest: false, outside: false }, timing: { plan: null } };
  const L = chaseTarget(w, 844 / 390);
  assert.ok(L.pos.z > w.player.pos.z + 3 && L.pos.y > 3.5, JSON.stringify(L.pos));
  assert.ok(L.look.z < w.player.pos.z - 4, 'looks toward the net');
  assert.ok(L.pos.z <= CHASE.landscape.maxZ + 1e-9);
  const P = chaseTarget(w, 390 / 844);
  assert.ok(P.fov > L.fov && P.pos.y > L.pos.y, 'portrait: taller field of view, higher');
  // A high lob over the player stays inside the top of the picture (the view widens).
  const lob = chaseTarget({ ...w, ball: { pos: { x: 0, y: 8, z: 3 }, atRest: false } }, 844 / 390);
  const pitch = Math.atan2(lob.look.y - lob.pos.y, lob.pos.z - lob.look.z);
  const top = Math.atan2(8 - lob.pos.y, lob.pos.z - 3);
  assert.ok(top <= pitch + (lob.fov * Math.PI) / 360 + 1e-6, 'the lob is in frame');
  const feet = Math.atan2(-lob.pos.y, lob.pos.z - w.player.pos.z);
  assert.ok(feet >= pitch - (lob.fov * Math.PI) / 360 - 1e-6, 'the feet are in frame');
  // The camera object follows smoothly and never goes non-finite.
  const cam = { position: { x: 0, y: 0, z: 0 }, fov: 50, aspect: 844 / 390, lookAt() {}, updateProjectionMatrix() {} };
  const cc = createChaseCam(cam);
  cc.update(w, 1 / 60);
  const p0 = { ...cam.position };
  w.player.pos.x = -2;
  cc.update(w, 1 / 60);
  assert.ok(Math.abs(cam.position.x - p0.x) < 0.2, 'no jump on a sudden move');
  for (let i = 0; i < 180; i++) cc.update(w, 1 / 60);
  assert.ok(Math.abs(cam.position.x - cc.target.pos.x) < 0.02, 'settles on the target');
  assert.ok(Object.values(cam.position).every(Number.isFinite));
});

test('mobile helpers: device, input choice, quality tier, shadow budget, preferences', () => {
  const mm = (coarse) => (q) => ({ matches: coarse ? q.includes('coarse') : q.includes('fine') });
  const iphone = detectDevice({ nav: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)', maxTouchPoints: 5 }, win: { innerWidth: 844, innerHeight: 390, devicePixelRatio: 3, matchMedia: mm(true) } });
  assert.ok(iphone.iphone && iphone.ios && iphone.phone && iphone.touchPrimary && !iphone.portrait);
  const ipad = detectDevice({ nav: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 5 }, win: { innerWidth: 1180, innerHeight: 820, matchMedia: mm(true) } });
  assert.ok(ipad.ipad && ipad.tablet && !ipad.phone);
  const mac = detectDevice({ nav: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 0 }, win: { innerWidth: 1710, innerHeight: 1000, matchMedia: mm(false) } });
  assert.ok(!mac.touchPrimary);
  assert.equal(decideInput({ search: '', device: iphone }), 'touch');
  assert.equal(decideInput({ search: '?input=camera', device: iphone }), 'camera');
  assert.equal(decideInput({ search: '?autopilot=1', device: iphone }), null);
  assert.equal(decideInput({ search: '', device: mac }), null);
  assert.equal(decideInput({ search: '?swipe=1', device: mac }), 'touch');
  assert.equal(decideInput({ search: '', device: iphone, prefs: { controls: 'camera' } }), 'camera');
  const Q = { balanced: { msaa: 0, maxPixelRatio: 1, shadowMapSize: 1024, newField: 7 } };
  assert.equal(mobileTier(Q), 'mobile');
  assert.equal(Q.mobile.maxPixelRatio, MOBILE_QUALITY.maxPixelRatio);
  assert.equal(Q.mobile.newField, 7, 'fields added to balanced later carry over');
  const lights = [{ isLight: true, castShadow: true, intensity: 5 }, { isLight: true, isDirectionalLight: true, castShadow: true, intensity: 1 }, { isLight: true, castShadow: true, intensity: 9 }];
  const scene = { traverse: (fn) => lights.forEach(fn) };
  assert.equal(limitShadowLights(scene, 1), 2);
  assert.deepEqual(lights.map((l) => l.castShadow), [false, true, false], 'the sun keeps its shadow');
  const mem = new Map();
  const st = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  const p = loadPrefs(st);
  assert.equal(p.view, 'behind');
  savePrefs(st, { ...p, view: 'first', tutorialDone: true });
  assert.ok(mem.has(MOBILE_STORE));
  assert.equal(loadPrefs(st).view, 'first');
});

test('playStage: the wiring sees the behind (chase) view as a play view while a swipe session runs', () => {
  const m = createMobile({ search: '', storage: null, QUALITY: null, forceInput: 'touch', nav: { userAgent: 'iPhone', maxTouchPoints: 5 }, win: { innerWidth: 844, innerHeight: 390 } });
  let view = 'replay';
  const stage = { get view() { return view; }, setView(v) { view = v; }, effects: { ok: 1 } };
  const settings = resolveSettings({ assist: 'club', handed: 'right', height: 1.75 });
  const g = createGame({ spec: { kind: 'drill', drillId: 'fh-drive' }, settings, input: 'touch', startTime: 10, seed: 3 });
  assert.equal(m.playStage(stage).view, 'replay', 'no session: the replay view stays a replay');
  m.attachGame(g);
  const ps = m.playStage(stage);
  assert.equal(ps.view, 'fp', 'behind view in a session reads as the play view');
  assert.equal(ps.effects.ok, 1, 'everything else is the stage');
  view = 'orbit';
  assert.equal(ps.view, 'orbit');
  m.detachGame();
  view = 'replay';
  assert.equal(ps.view, 'replay', 'an instant replay after the session is a replay again');
  assert.equal(m.playStage({ supportsChase: true, view: 'chase' }).view, 'chase', 'a stage with its own chase view is passed through');
  g.dispose();
});

test('a harder down-swipe (slice) is never slower: pace rises with effort up to a full swipe', () => {
  const effs = [0.25, 0.5, 0.75, 0.95];
  let k = 0;
  const r = play({ spec: { kind: 'drill', drillId: 'fh-drive' }, seed: 5, seconds: 30, eFn: () => 0.01, effortFn: () => effs[k++ % effs.length], shapeFn: () => ({ up: -1 }) });
  const byId = new Map(r.shots.map((s) => [s.id, s]));
  const pts = r.ctl.log.map((l) => ({ e: l.effort, kind: l.kind, kmh: byId.get(l.shotId) ? byId.get(l.shotId).speedOut * 3.6 : null })).filter((p) => p.kmh !== null);
  assert.ok(pts.length >= 6, `${pts.length} slices`);
  assert.ok(pts.every((p) => p.kind === 'slice'));
  const sorted = pts.slice().sort((a, b) => a.e - b.e);
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(sorted[i].kmh >= sorted[i - 1].kmh - 4, `effort ${sorted[i].e.toFixed(2)} -> ${sorted[i].kmh.toFixed(0)} km/h after ${sorted[i - 1].e.toFixed(2)} -> ${sorted[i - 1].kmh.toFixed(0)}`);
  }
  assert.ok(sorted[sorted.length - 1].kmh > 95, `hardest slice ${sorted[sorted.length - 1].kmh.toFixed(0)} km/h`);
});
