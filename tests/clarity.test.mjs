// Round 6 (clarity & perception): the one feedback line of the clean HUD, the central play region,
// the approach circle that closes exactly at t*, the enhanced ball that keeps shrinking with distance,
// the settings, and the ball on screen at the moment to swing with the user's own framing.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createFeedbackQueue, FEEDBACK, PRIORITY } from '../src/ui/feedback.js';
import { PLAY_REGION, TOP_BAND, intrudesPlayRegion, playRegionOverlap } from '../src/ui/playRegion.js';
import { approachCue, approachRadius, approachTickOn, greenWindow, APPROACH } from '../src/render/approach.js';
import { BALL_VISIBILITY, ballDisplayScale, ballDeg, ENHANCED_TRUE_SIZE_WITHIN } from '../src/render/ballVisibility.js';
import { createGaze, framingContact } from '../src/render/gaze.js';
import { loadSettings, HUD_MODES } from '../src/app/settings.js';
import { createGame } from '../src/app/game.js';
import { timingConfig } from '../src/game/swingAssist.js';
import { viewBall } from '../src/game/world.js';
import { createTestGame } from './helpers/closeGame.mjs';

const DEG = Math.PI / 180;

describe('feedback line (src/ui/feedback.js)', () => {
  test('one message at a time, each at most 1.6 s, highest priority first', () => {
    const f = createFeedbackQueue();
    f.push({ kind: 'note', text: 'Turn your shoulders' }, 0);
    f.push({ kind: 'miss', text: 'Swing was 0.4 s early' }, 0);
    f.push({ kind: 'shot', text: 'Forehand · 64 km/h' }, 0);
    const seen = [];
    let shownFor = 0, last = null;
    for (let t = 0; t <= 8000; t += 10) {
      const m = f.update(t, { hold: false });
      if (m && m !== last) { seen.push(m.text); shownFor = 0; }
      if (m) shownFor += 10;
      assert.ok(shownFor <= FEEDBACK.maxMs + 10, `${m && m.text} shown ${shownFor} ms`);
      last = m;
    }
    assert.deepEqual(seen, ['Swing was 0.4 s early', 'Forehand · 64 km/h', 'Turn your shoulders']);
    assert.equal(f.update(9000), null);
  });

  test('the shot line carries the swing power (ShotRecord.effort) and a later update of the same shot keeps / refreshes it', () => {
    const f = createFeedbackQueue();
    f.push({ kind: 'shot', key: 'shot:9', text: 'Forehand · 64 km/h', power: 0.4 }, 0);
    assert.equal(f.update(10).power, 0.4);
    f.push({ kind: 'shot', key: 'shot:9', text: 'Forehand · 71 km/h', power: 0.9 }, 20);
    const m = f.update(30);
    assert.equal(m.text, 'Forehand · 71 km/h');
    assert.equal(m.power, 0.9);
    f.push({ kind: 'shot', key: 'shot:9', text: 'Forehand · 71 km/h', tags: ['+100'] }, 40);
    assert.equal(f.update(50).power, 0.9, 'an update without a power keeps it');
  });

  test('a new hit drops a queued miss of the ball before (it waited while this ball came)', () => {
    const f = createFeedbackQueue();
    f.update(0, { hold: true });
    f.push({ kind: 'miss', key: 'miss:1', text: 'No swing detected' }, 10); // ball 1's miss, ball 2 coming
    f.push({ kind: 'note', text: 'Turn early' }, 20);
    f.push({ kind: 'shot', key: 'shot:2', text: 'Forehand · 80 km/h', supersedes: ['miss'] }, 30);
    const seen = [];
    for (let t = 40; t < 6000; t += 10) { const m = f.update(t); if (m && seen[seen.length - 1] !== m.text) seen.push(m.text); }
    assert.deepEqual(seen, ['Forehand · 80 km/h', 'Turn early']);
  });

  test('nothing while the ball is coming (the line hides at once, the queue waits), urgent camera warnings still show', () => {
    const f = createFeedbackQueue();
    f.push({ kind: 'shot', text: 'Backhand · 58 km/h' }, 0);
    assert.equal(f.update(100).text, 'Backhand · 58 km/h');
    assert.equal(f.update(200, { hold: true }), null, 'hidden as soon as the ball comes');
    f.push({ kind: 'miss', text: 'Swing was 0.3 s late' }, 300);
    for (let t = 300; t < 1500; t += 50) assert.equal(f.update(t, { hold: true }), null);
    // Barely seen before the ball came: it waits its turn again (after the more important miss).
    assert.equal(f.update(1500, { hold: false }).text, 'Swing was 0.3 s late');
    f.push({ kind: 'urgent', text: 'Out of frame', urgent: true }, 1600);
    assert.equal(f.update(1700, { hold: true }).text, 'Out of frame');
    f.setPrompt({ text: 'Get ready' });
    const g = createFeedbackQueue();
    g.setPrompt({ text: 'Your serve: let it bounce' });
    assert.equal(g.update(0).text, 'Your serve: let it bounce', 'a prompt fills the idle line');
    assert.equal(g.update(10, { hold: true }), null, 'not while the ball comes');
    g.setPrompt({ text: 'Head out of view · step back', urgent: true });
    assert.equal(g.update(20, { hold: true }).text, 'Head out of view · step back');
  });

  test('merge: the same key updates in place; "Perfect" joins its shot line; stale messages are dropped; banners preempt', () => {
    const f = createFeedbackQueue();
    f.push({ kind: 'shot', key: 'shot:7', text: 'Forehand · 61 km/h', tags: ['On time'] }, 0);
    f.push({ kind: 'shot', key: 'shot:7', text: 'Forehand · 61 km/h', tags: ['On time', '+120'] }, 200);
    f.push({ kind: 'perfect', tag: true, text: 'Perfect timing', tone: 'good' }, 300);
    assert.equal(f.size, 1, 'one line for the shot, its result and its "Perfect"');
    const m = f.update(400);
    assert.deepEqual(m.tags, ['On time', '+120', 'Perfect timing']);
    f.push({ kind: 'shot', tag: true, text: 'Early 120 ms', replace: /^(on time|early|late)/i }, 450);
    assert.deepEqual(f.update(500).tags, ['+120', 'Perfect timing', 'Early 120 ms'], 'the meter reading replaces the timing chip');
    f.push({ kind: 'banner', text: '¡Por tres!' }, 700);
    assert.equal(f.update(710).text, '¡Por tres!', 'a banner preempts a lower message');
    assert.ok(PRIORITY.banner >= PRIORITY.shot + FEEDBACK.preempt);
    // The HUD tick re-sends the last miss for 3.5 s: once shown it does not come back.
    const r = createFeedbackQueue();
    for (let t = 0; t < 3500; t += 100) {
      r.push({ kind: 'miss', key: 'miss:12.5', text: 'Swing was 0.5 s early' }, t);
      const m = r.update(t);
      if (t >= FEEDBACK.maxMs + 100) assert.equal(m, null, `back at ${t} ms`);
    }
    const s = createFeedbackQueue();
    s.push({ kind: 'note', text: 'old note' }, 0);
    assert.equal(s.update(100, { hold: true }), null);
    assert.equal(s.update(FEEDBACK.staleMs + 200, { hold: false }), null, 'about an old ball: dropped');
  });
});

describe('central play region (src/ui/playRegion.js)', () => {
  test('the central 70 % × lower 80 % is the play region; the top band and the side columns are free', () => {
    assert.deepEqual({ ...PLAY_REGION }, { x0: 0.15, x1: 0.85, y0: 0.2, y1: 1 });
    assert.equal(TOP_BAND, 0.2);
    const W = 1710, H = 876;
    assert.equal(intrudesPlayRegion({ left: 85, top: 44, right: 470, bottom: 90 }, W, H), false, 'top-left bar');
    assert.equal(intrudesPlayRegion({ left: 400, top: 100, right: 1300, bottom: 150 }, W, H), false, 'feedback line');
    assert.equal(intrudesPlayRegion({ left: 85, top: 150, right: 240, bottom: 300 }, W, H), false, 'camera picture in the left column');
    assert.equal(intrudesPlayRegion({ left: 1200, top: 190, right: 1625, bottom: 400 }, W, H), true, 'the old shot card');
    assert.equal(intrudesPlayRegion({ left: 300, top: 220, right: 1400, bottom: 360 }, W, H), true, 'a banner at 28 %');
    assert.ok(playRegionOverlap({ x0: 0, y0: 0, x1: W, y1: H }, W, H) > 0.55 * W * H);
  });
});

describe('approach circle (src/render/approach.js)', () => {
  test('closes at a constant rate and exactly at t*; green only inside the swing window; perfect within ±60 ms', () => {
    const S = { ...loadSettings(null), assist: 'rookie' };
    const g = createGame({ spec: { kind: 'drill', drillId: 'fh-drive' }, settings: S, input: 'autopilot', startTime: 10, seed: 1, apLatency: 0.11, apDelivery: 0.15 });
    const w = g.world;
    const cfg = timingConfig(w);
    assert.ok(cfg && cfg.early > 0.25, 'rookie timing window');
    const STEP = 1 / 240;
    let samples = 0, closes = 0, maxRateErr = 0, prev = null, greenEarly = 0, whiteInWindow = 0, perfectOff = 0, firstTau = [];
    const cue = {};
    while (w.time < 10 + 14) {
      g.advanceTo(w.time + STEP);
      const a = approachCue(w, cue);
      if (!a) { prev = null; continue; }
      samples++;
      assert.ok(a.tau <= APPROACH.lead + 1e-9, 'never before the lead');
      if (!prev || prev.key !== a.key) firstTau.push(a.tau);
      if (prev && prev.key === a.key && Math.abs(a.tStar - prev.tStar) < 1e-9 && a.tau > 0 && prev.tau > 0) {
        const rate = (prev.k - a.k) / (w.time - prev.t);
        maxRateErr = Math.max(maxRateErr, Math.abs(rate - 1 / APPROACH.lead));
      }
      // Linear in the time left: it reaches the ball's outline (k = 0) exactly at t*.
      if (a.tau >= 0) assert.ok(Math.abs(a.k - a.tau / APPROACH.lead) < 1e-9 || a.tau > APPROACH.lead, `k ${a.k} at tau ${a.tau}`);
      if (a.tau >= 0 && a.tau < 0.05) closes++;
      if (a.green > 0 && a.tau > cfg.early + 1e-9) greenEarly++;
      if (a.green === 0 && a.inWindow && a.tau < cfg.early - APPROACH.greenEase - 1e-9) whiteInWindow++;
      if (a.perfect && Math.abs(a.tau) > APPROACH.perfect + 1e-9) perfectOff++;
      prev = { ...a, t: w.time };
    }
    g.dispose();
    assert.ok(samples > 200, `${samples} samples`);
    assert.ok(closes >= 2, `drawn within 50 ms of t* (nearly closed) ${closes} times`);
    assert.ok(maxRateErr < 1e-6, `constant closing rate (err ${maxRateErr})`);
    assert.equal(greenEarly, 0, 'never green before the window opens');
    assert.equal(whiteInWindow, 0, 'green throughout the window');
    assert.equal(perfectOff, 0);
    assert.ok(firstTau.some((t) => t > APPROACH.lead - 0.05), 'appears a full lead before t* when the plan exists that early');
  });

  test('personal timing bias: the circle still closes at the true t*, green only where both windows agree', () => {
    // A stub world: a planned ball with t* = 5 s and the player's learned bias (game/timingProfile.js).
    const mk = (assist, bias) => ({
      settings: { assist, hitMode: 'auto' }, input: 'autopilot', time: 0, spec: null,
      ball: { id: 7, atRest: false }, flight: { startT: 1 },
      timingProfile: { bias, summary: () => ({ bias, text: '' }) },
      timing: { plan: { key: '7:1', tStar: 5, pStar: { x: 0, y: 1, z: 9 }, closed: false, glass: false }, decided: null },
    });
    for (const assist of ['rookie', 'club']) {
      for (const bias of [-0.35, -0.2, 0, 0.2, 0.35]) {
        const w = mk(assist, bias);
        const cfg = timingConfig(w);
        const win = greenWindow(cfg, bias);
        assert.ok(win.early + win.late >= 0.04, `${assist} ${bias}: a green window remains`);
        const cue = {};
        let greenOutsideJudge = 0, greenOutsideTrue = 0, kAtTStar = null;
        for (let t = 4; t <= 5.6; t += 0.002) {
          w.time = t;
          const a = approachCue(w, cue);
          if (!a) continue;
          if (Math.abs(t - 5) < 1e-3) kAtTStar = a.k;
          if (a.green > 0) {
            const e = t - 5; // swing now, relative to t*
            if (e < bias - cfg.early - 1e-9 || e > bias + cfg.late + 1e-9) greenOutsideJudge++;
            if (e < -cfg.early - 1e-9 || e > cfg.late + 1e-9) greenOutsideTrue++;
          }
          if (a.perfect) assert.ok(a.inWindow, 'perfect only inside the green window');
        }
        assert.ok(kAtTStar !== null && kAtTStar < 0.003, `${assist} ${bias}: closed at the true t* (k ${kAtTStar})`);
        assert.equal(greenOutsideJudge, 0, `${assist} ${bias}: green only when the judge calls it on time`);
        assert.equal(greenOutsideTrue, 0, `${assist} ${bias}: green never earlier / later than the true window`);
      }
    }
  });

  test('its radius closes onto the ball outline; the tick setting (auto = Rookie)', () => {
    const ball = 0.01;
    assert.ok(Math.abs(approachRadius(0, ball) - (ball * APPROACH.close + APPROACH.closePad)) < 1e-12);
    assert.ok(Math.abs(approachRadius(1, ball) - approachRadius(0, ball) - APPROACH.open) < 1e-12);
    assert.ok(approachRadius(0.5, ball) < approachRadius(0.6, ball));
    assert.equal(approachTickOn({ assist: 'rookie', approachTick: 'auto' }), true);
    assert.equal(approachTickOn({ assist: 'club', approachTick: 'auto' }), false);
    assert.equal(approachTickOn({ assist: 'club', approachTick: 'on' }), true);
    assert.equal(approachTickOn({ assist: 'rookie', approachTick: 'off' }), false);
    assert.equal(APPROACH.tickLead, 0.2);
  });
});

describe('enhanced ball visibility keeps the depth cue (src/render/ballVisibility.js)', () => {
  test('true size up to 14 m (it used to stop shrinking at 8.3 m); held only beyond', () => {
    const v = BALL_VISIBILITY.enhanced;
    assert.equal(ENHANCED_TRUE_SIZE_WITHIN, 14);
    for (const d of [1, 4, 8.3, 10, 12, 13.9]) assert.equal(ballDisplayScale(d, v.minDeg), 1, `${d} m`);
    assert.ok(ballDisplayScale(20, v.minDeg) > 1.3 && ballDisplayScale(20, v.minDeg) < 1.5);
    assert.ok(ballDisplayScale(10, 0.45) > 1.2, 'the round-3 0.45° rule enlarged a ball 10 m away');
    // Drawn angular size strictly shrinks with distance up to 14 m.
    let prev = Infinity;
    for (let d = 0.5; d <= 14; d += 0.5) {
      const deg = ballDeg(d) * ballDisplayScale(d, v.minDeg);
      assert.ok(deg < prev, `${d} m`);
      prev = deg;
    }
    assert.ok(v.glow > 0 && v.glowMinDeg > 0, 'a soft glow halo keeps it findable');
    assert.equal(BALL_VISIBILITY.realistic.minDeg, 0);
  });
});

describe('settings (round 6)', () => {
  test('clean HUD and the camera picture off by default; old saves migrate; bad values are clamped', () => {
    const S = loadSettings(null);
    assert.equal(S.hud, 'clean');
    assert.equal(S.pip, false);
    assert.equal(S.approachTick, 'auto');
    assert.deepEqual([...HUD_MODES], ['clean', 'standard', 'coach']);
    const old = { getItem: () => JSON.stringify({ pip: true, skeleton: true, assist: 'rookie', timingTick: true }), setItem() {} };
    const T = loadSettings(old);
    assert.equal(T.pip, false, 'a pre-round-6 save starts on the new default');
    assert.equal(T.approachTick, 'on', 'a legacy "tick on every ball" keeps ticking');
    const kept = { getItem: () => JSON.stringify({ hud: 'coach', pip: true, approachTick: 'off' }), setItem() {} };
    const K = loadSettings(kept);
    assert.equal(K.hud, 'coach');
    assert.equal(K.pip, true, 'a round-6 choice is kept');
    assert.equal(K.approachTick, 'off');
    const bad = { getItem: () => JSON.stringify({ hud: 'busy', approachTick: 'loud' }), setItem() {} };
    const B = loadSettings(bad);
    assert.equal(B.hud, 'clean');
    assert.equal(B.approachTick, 'auto');
  });
});

describe('the ball is on screen at the moment to swing (user framing: fov 74°, pitch -14°, eye 12 cm back / 6 cm down, close mode)', () => {
  // Node replica of render/fpCamera.js: the gaze (render/gaze.js) fed with the shown ball, the
  // offset eye and the framing contact (gaze.js framingContact), projected at 1710 x 876.
  function project(p, cam, fovDeg, aspect) {
    const rx = p.x - cam.x, ry = p.y - cam.y, rz = p.z - cam.z;
    const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
    const x1 = cy * rx - sy * rz, z1 = sy * rx + cy * rz;
    const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    const y2 = cp * ry + sp * z1, z2 = -sp * ry + cp * z1;
    if (z2 >= -1e-3) return null;
    const t = Math.tan((fovDeg * DEG) / 2);
    return { x: x1 / -z2 / (t * aspect), y: y2 / -z2 / t };
  }
  function contactsInView(spec, seed) {
    const S = { ...loadSettings(null), assist: 'rookie', fov: 74, viewPitch: -14, eyeOffset: { back: 0.12, down: 0.06 }, glassView: 'mirror' };
    const g = createTestGame({ spec, settings: S, seed, close: true, profile: 'human' });
    const w = g.world;
    const gaze = createGaze();
    const plans = new Map();
    const frames = [];
    const t0 = w.time;
    while (!g.isFinished() && w.time < t0 + 70) {
      g.advanceTo(w.time + 1 / 60);
      const b = viewBall(w);
      const e = w.player.eye;
      const eye = { x: e.x, y: e.y - 0.06, z: e.z + 0.12 };
      const c = b && !b.atRest ? framingContact(Object.assign(Object.create(w), { ball: b }), {}) : null;
      const r = gaze.update(b, eye, 1 / 60, { basePitch: S.viewPitch * DEG, contact: c, glassView: 'mirror', vHalf: (S.fov * DEG) / 2 });
      frames.push({ t: w.time, eye, yaw: r.yaw, pitch: r.pitch });
      const P = w.timing && w.timing.plan;
      if (P && P.pStar) plans.set(P.key, { tStar: P.tStar, p: { x: P.pStar.x, y: P.pStar.y, z: P.pStar.z } });
    }
    let n = 0, inside = 0;
    for (const p of plans.values()) {
      const f = frames.find((x) => x.t >= p.tStar);
      if (!f || p.tStar < t0 + 0.5) continue;
      n++;
      const q = project(p.p, { ...f.eye, yaw: f.yaw, pitch: f.pitch }, 74, 1710 / 876);
      if (q && Math.abs(q.x) <= 0.9 && Math.abs(q.y) <= 0.9) inside++;
    }
    return { n, inside };
  }
  test('drives, back glass, volleys, bandeja and a rally: >= 95 % of the contacts at t* inside the picture with a 10 % margin (each mode all but one)', () => {
    let n = 0, inside = 0;
    const per = [];
    for (const [name, spec] of [['fh-drive', { kind: 'drill', drillId: 'fh-drive' }], ['back-glass', { kind: 'drill', drillId: 'back-glass' }], ['volleys', { kind: 'drill', drillId: 'volleys' }], ['bandeja', { kind: 'drill', drillId: 'bandeja' }], ['rally', { kind: 'rally', level: 'club' }]]) {
      const r = contactsInView(spec, 1);
      assert.ok(r.n >= 8, `${name}: ${r.n} contacts`);
      assert.ok(r.inside >= r.n - 1, `${name}: ${r.inside}/${r.n}`);
      per.push(`${name} ${r.inside}/${r.n}`);
      n += r.n;
      inside += r.inside;
    }
    assert.ok(inside / n >= 0.95, `${inside}/${n} (${per.join(', ')})`);
  });
});

describe('the gaze keeps a ball in front inside the picture (render/gaze.js vHalf, GAZE.KEEP_MARGIN)', () => {
  test('a high ball dropping onto a low contact stays in view while the contact framing tilts the view down', () => {
    const vHalf = (74 * DEG) / 2;
    const run = (withHalf) => {
      const g = createGaze();
      g.reset(-14 * DEG);
      const eye = { x: 0, y: 1.6, z: 8 };
      let worst = 0;
      // A ball 2.5 m in front, falling from 4.5 m to the contact at hip height over 0.8 s (followed
      // at its apex for 0.6 s first, as a lob is watched on its way up).
      for (let i = -36; i <= 48; i++) {
        const t = Math.max(0, i) / 60;
        const y = 4.5 - (4.5 - 1.0) * (t / 0.8) ** 2;
        const z = 8 - 2.5 + 1.6 * (t / 0.8);
        const ball = { pos: { x: 0.3, y, z }, vel: { x: 0, y: -8, z: 2 }, t: 10 + i / 60, atRest: false, outside: false };
        const contact = { x: 0.35, y: 1.0, z: 8 - 0.9, t: 10.8 }; // ball time (ball.t) of the contact
        const r = g.update(ball, eye, 1 / 60, { basePitch: -14 * DEG, contact, glassView: 'mirror', vHalf: withHalf ? vHalf : 0 });
        const bp = Math.atan2(y - eye.y, Math.hypot(0.3, z - eye.z));
        if (i >= 0) worst = Math.max(worst, Math.abs(bp - r.pitch) / vHalf);
      }
      return worst;
    };
    const kept = run(true), free = run(false);
    assert.ok(kept <= 1, `ball inside the picture with vHalf (worst ${kept.toFixed(2)} of the half-height)`);
    assert.ok(free >= kept, `never worse than without it (${free.toFixed(2)} vs ${kept.toFixed(2)})`);
  });
});

describe('wiring (app/wiring.js): approach circle, its tick, live / incoming', () => {
  // A no-op stand-in for the stage / UI / audio objects (any method exists and does nothing).
  const fake = (over = {}) => new Proxy(Object.assign(function noop() {}, over), {
    get: (t, k) => (Object.prototype.hasOwnProperty.call(over, k) ? over[k] : k === 'then' ? undefined : fake()),
  });
  async function run(assist, approachTick = 'auto') {
    const { bindWorld } = await import('../src/app/wiring.js');
    const S = { ...loadSettings(null), assist, approachTick };
    const g = createGame({ spec: { kind: 'drill', drillId: 'fh-drive' }, settings: S, input: 'autopilot', startTime: 10, seed: 3, apLatency: 0.11, apDelivery: 0.15 });
    const w = g.world;
    let src = null, liveFn = null, play = null;
    const ticks = [];
    const stage = fake({ view: 'fp', ballView: fake({ bind(s) { src = s; } }), effects: fake({ bindLive(f) { liveFn = f; } }), env: fake(), machine: fake() });
    const ui = fake({ bindPlay(b) { play = b; } });
    const audio = fake({ ui(kind) { if (kind === 'tick') ticks.push({ t: w.time, plan: w.timing.plan ? { key: w.timing.plan.key, tStar: w.timing.plan.tStar } : null }); }, bindBus: () => () => {} });
    const off = bindWorld(w, { audio, voice: null, stage, ui, recorder: null });
    let incomingFrames = 0, liveFrames = 0, incomingNotLive = 0, ringErr = 0, newFeedHeld = 0, newFeedFree = 0;
    try {
      while (w.time < 10 + 30) {
        g.advanceTo(w.time + 1 / 60);
        src.frame(1 / 60);
        const r = src.ring();
        if (r && r.tau > APPROACH.lead + 1e-9) ringErr++;
        if (play.incoming()) incomingFrames++;
        if (liveFn()) liveFrames++;
        if (play.incoming() && !play.live()) incomingNotLive++;
        // A ball just fed while the referee still holds the last rep's ruling ('dead'): it is
        // coming to the player, so the feedback line must already wait.
        const b = w.ball, f = w.flight;
        if (b && !b.atRest && !b.outside && f.by === 'machine' && w.time - f.startT < 0.5) {
          if (play.incoming()) newFeedHeld++;
          else newFeedFree++;
        }
      }
    } finally {
      off(); // clears the venue binding's crowd timer
      g.dispose();
    }
    assert.equal(ringErr, 0);
    return { ticks, incomingFrames, liveFrames, incomingNotLive, newFeedHeld, newFeedFree };
  }
  test('Rookie: one tick per ball, 0.2 s before t* (within a frame); Club (auto): none for balls off the ground; on: every ball', async () => {
    const r = await run('rookie');
    assert.ok(r.ticks.length >= 4, `${r.ticks.length} ticks`);
    const keys = new Set();
    for (const t of r.ticks) {
      assert.ok(t.plan, 'a planned ball');
      const tau = t.plan.tStar - t.t;
      assert.ok(tau <= APPROACH.tickLead + 1e-9 && tau > APPROACH.tickLead - 0.12, `tick at t* - ${tau.toFixed(3)} s`);
      assert.ok(!keys.has(t.plan.key), 'once per ball');
      keys.add(t.plan.key);
    }
    assert.ok(r.incomingFrames > 60 && r.liveFrames > r.incomingFrames && r.incomingNotLive === 0);
    assert.ok(r.newFeedHeld > 30, `${r.newFeedHeld} frames of fresh feeds held`);
    assert.equal(r.newFeedFree, 0, 'a freshly fed ball counts as incoming even before the referee resets');
    const c = await run('club');
    assert.equal(c.ticks.length, 0, 'Club, auto: no tick on drives');
    const on = await run('club', 'on');
    assert.ok(on.ticks.length >= 4, 'Club, on: ticks');
  });
});
