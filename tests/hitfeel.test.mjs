// Hit feel at realistic Mac latency (QA2 critical #1, major #3): predictive (speculative)
// hitting with authoritative confirmation. The real pipeline (autopilot -> synthetic camera ->
// body tracker -> racket track -> hits) runs at 0.11 s display latency and 0.15 s capture ->
// result delay with jitter, and is drawn at 60 Hz exactly as the stage draws it
// (render/reconcile.js createViewSync).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { v3 } from '../src/util/vec3.js';
import { createRng } from '../src/util/math.js';
import { RACKET } from '../src/config.js';
import { createGame } from '../src/app/game.js';
import { loadSettings } from '../src/app/settings.js';
import { createViewSync, createBallReconciler, elbowForRacket, sweetOf, MAX_OFFSET_SPEED } from '../src/render/reconcile.js';
import { createSyntheticCamera } from '../src/tracking/synthetic.js';
import { createRacketPose, extrapolatePose, rotateAboutAxis } from '../src/tracking/racketTrack.js';
import { relabelByTrajectory, classifyStroke } from '../src/tracking/swing.js';
import { DEFAULT_SETTINGS, createWorld, stepWorld, launchBall } from '../src/game/world.js';
import { createHumanController } from '../src/game/human.js';

const FRAME = 1 / 60;
const LAT = 0.11;
const DELIVERY = 0.15;
const JITTER = 0.02;

/** Replaces the autopilot feed's delivery with a jittered one (same autopilot and camera). */
function jitterFeed(g, seed) {
  const w = g.world;
  const cam = createSyntheticCamera({ hfovDeg: w.settings.hfovDeg });
  const ap = g.feed.autopilot;
  const rng = createRng(seed);
  const pending = [];
  let next = null;
  g.feed.beforeTick = (world, human) => {
    if (next === null) next = world.time;
    world.tracking.delay = DELIVERY + JITTER / 2;
    world.tracking.frameDt = 1 / 30;
    if (world.time >= next - 1e-9) {
      const body = ap.update(world, world.time);
      const at = Math.max(world.time + DELIVERY + rng() * JITTER, pending.length ? pending[pending.length - 1].at : 0);
      pending.push({ at, frame: cam.frame(world.time * 1000, [body]), t: world.time });
      next += 1 / 30;
    }
    while (pending.length && pending[0].at <= world.time + 1e-9) {
      const f = pending.shift();
      human.onPoseFrame(world, f.frame, f.t);
    }
  };
}

/** Makes the autopilot stop its swing short (arm frozen 0.1 s before contact) on every other ball. */
function whiffEveryOther(g) {
  const ap = g.feed.autopilot;
  const orig = ap.update;
  const ARM = ['elbowR', 'wristR', 'indexR', 'pinkyR', 'thumbR'];
  const seen = new Set();
  const whiff = new Set();
  let n = 0;
  let frozen = null;
  ap.update = (world, T) => {
    const body = orig(world, T);
    const p = ap.plan;
    if (p && !p.none) {
      if (!seen.has(p.key)) {
        seen.add(p.key);
        if (++n % 2 === 0) whiff.add(p.key);
      }
      if (whiff.has(p.key) && T >= p.tr - 0.1) {
        if (!frozen || frozen.key !== p.key) frozen = { key: p.key, j: Object.fromEntries(ARM.map((k) => [k, body.joints[k].clone()])) };
        for (const k of ARM) body.joints[k].copy(frozen.j[k]);
      }
    }
    return body;
  };
  return whiff;
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/**
 * Runs a drill through the real pipeline, drawn at 60 Hz. Returns the hit-frame distances,
 * the largest extra on-screen step after a path correction, erased-path announcements, stats.
 */
function run(drillId, { seconds = 60, seed = 5, prediction = true, whiff = false, jitter = true } = {}) {
  const settings = { ...loadSettings(null), hitPrediction: prediction };
  const g = createGame({ spec: { kind: 'drill', drillId }, settings, input: 'autopilot', startTime: 10, seed, apLatency: LAT, apDelivery: DELIVERY });
  if (jitter) jitterFeed(g, seed + 991);
  const whiffKeys = whiff ? whiffEveryOther(g) : null;
  const w = g.world;
  const view = createViewSync();
  const out = { hitShown: [], maxJump: 0, erased: [], unhit: 0, provisional: 0, modeSawProvisional: 0, judgedProvisional: 0 };
  // Erased path: an incoming-ball event announced (sound / effect / glass mark) whose time is
  // after a player contact found later.
  const announced = [];
  for (const type of ['ball:bounce', 'ball:wall', 'ball:net', 'ball:netcord']) {
    w.bus.on(type, ({ evt }) => announced.push({ type, evt }));
  }
  w.bus.on('ball:hit', ({ shot }) => {
    if (shot.by !== 'player') return;
    if (shot.provisional) { out.provisional++; return; }
    for (const a of announced) if (!a.evt.speculative && a.evt.t > shot.t + 1e-6 && !a.counted) { a.counted = true; out.erased.push(`${a.type} ${a.evt.surface}`); }
  });
  w.bus.on('ball:unhit', () => out.unhit++);
  const onBus = w.mode.onBus;
  w.mode.onBus = (type, p, world) => {
    if (p && p.shot && p.shot.provisional) out.modeSawProvisional++;
    if (type === 'judge:hit' && p.shot && p.shot.provisional) out.judgedProvisional++;
    return onBus(type, p, world);
  };
  let lastSeq = null, prev = null, watch = 0;
  const t0 = w.time;
  while (w.time < t0 + seconds && !g.isFinished()) {
    g.advanceTo(w.time + FRAME);
    const v = view.update(w, FRAME);
    const c = w.viewCorrection;
    const b = v.ball;
    if (c && c.seq !== lastSeq) {
      lastSeq = c.seq;
      if (c.kind === 'strike' || c.kind === 'late') out.hitShown.push({ kind: c.kind, d: v.racket && b ? dist(sweetOf(v.racket), b.pos) : Infinity });
      if (c.kind !== 'strike') watch = 45;
    }
    if (b && prev && prev.id === b.id && !v.hitFrame && watch > 0) {
      const sp = b.vel ? Math.hypot(b.vel.x, b.vel.y, b.vel.z) : 0;
      out.maxJump = Math.max(out.maxJump, dist(b.pos, prev) - Math.max(sp, prev.sp) * FRAME - 0.02);
    }
    if (watch > 0) watch--;
    prev = b ? { x: b.pos.x, y: b.pos.y, z: b.pos.z, id: b.id, sp: b.vel ? Math.hypot(b.vel.x, b.vel.y, b.vel.z) : 0 } : null;
  }
  out.stats = { hits: g.stats.playerHits, reps: g.stats.reps, inCourt: g.stats.inCourt, judged: g.stats.judgedShots, outcomes: { ...g.stats.outcomes }, late: w.hitRejects.late };
  out.results = g.mode.state.results.map((r) => ({ shot: !!r.shot, legal: r.legal, reason: r.reason, points: r.points }));
  out.spec = w.specStats;
  out.world = w;
  out.whiffKeys = whiffKeys;
  out.playerShots = w.shots.filter((s) => s.by === 'player');
  return out;
}

const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };

describe('predictive hitting at 0.11 s display + 0.15 s inference latency', () => {
  const on = run('fh-drive', { seconds: 70 });
  const off = run('fh-drive', { seconds: 70, prediction: false });

  test('the racket shown meets the ball shown at the hit frame (>= 80% within 0.2 m)', () => {
    const near = on.hitShown.filter((h) => h.d < 0.2).length;
    const offNear = off.hitShown.filter((h) => h.d < 0.2).length;
    console.log(`[hitfeel] hit frames: ${near}/${on.hitShown.length} within 0.2 m (median ${median(on.hitShown.map((h) => h.d)).toFixed(3)} m); without prediction ${offNear}/${off.hitShown.length} (median ${median(off.hitShown.map((h) => h.d)).toFixed(2)} m)`);
    assert.ok(on.hitShown.length >= 10, `${on.hitShown.length} hits shown`);
    assert.ok(near >= 0.8 * on.hitShown.length, `${near}/${on.hitShown.length}`);
    assert.ok(on.spec.strikes >= 0.8 * on.stats.hits, `speculative strikes ${on.spec.strikes} for ${on.stats.hits} hits`);
  });

  test('confirmation: speculative vs camera-confirmed direction differs by < 6 deg (median), ball never jumps > 0.6 m a frame', () => {
    const d = on.spec.dirDiffDeg;
    console.log(`[hitfeel] confirmed ${on.spec.confirmed}/${on.spec.strikes}, direction diff median ${median(d).toFixed(2)} deg max ${Math.max(...d).toFixed(1)}; contact time diff median ${median(on.spec.dtContact.map(Math.abs)).toFixed(4)} s; largest extra step after a correction ${on.maxJump.toFixed(2)} m`);
    assert.equal(on.spec.confirmed, on.spec.strikes, 'every predicted hit of a full swing is confirmed');
    assert.ok(median(d) < 6, `median ${median(d)}`);
    assert.ok(on.maxJump < 0.6, `jump ${on.maxJump}`);
  });

  test('hit rate and legality are unchanged; the judge and the mode never see a provisional hit', () => {
    assert.deepEqual(on.stats, off.stats);
    assert.deepEqual(on.results, off.results);
    assert.equal(on.modeSawProvisional, 0);
    assert.equal(on.judgedProvisional, 0);
    assert.ok(on.playerShots.every((s) => !s.provisional), 'world.shots holds confirmed shots only');
    assert.equal(off.spec.strikes, 0, 'hitPrediction: false predicts nothing');
  });

  test('no erased-path sounds / effects before the hit (with and without prediction)', () => {
    assert.deepEqual(on.erased, []);
    assert.deepEqual(off.erased, []);
  });
});

describe('back glass at latency', () => {
  test('no glass marks or sounds from the erased incoming path; hits shown on the racket', () => {
    const on = run('back-glass', { seconds: 60 });
    const off = run('back-glass', { seconds: 60, prediction: false });
    const near = on.hitShown.filter((h) => h.d < 0.2).length;
    console.log(`[hitfeel] back-glass: erased ${on.erased.length} (no prediction ${off.erased.length}), hit frames ${near}/${on.hitShown.length} within 0.2 m, direction diff median ${median(on.spec.dirDiffDeg).toFixed(1)} deg`);
    assert.deepEqual(on.erased, []);
    assert.deepEqual(off.erased, [], 'late hits still erase their path silently');
    assert.ok(near >= 0.8 * on.hitShown.length, `${near}/${on.hitShown.length}`);
    assert.deepEqual(on.stats, off.stats);
  });
});

describe('whiff: the swing stops short of the ball', () => {
  test('the predicted hit is undone cleanly and never counts', () => {
    const r = run('fh-drive', { seconds: 60, whiff: true, jitter: false });
    const base = run('fh-drive', { seconds: 60, whiff: true, jitter: false, prediction: false });
    console.log(`[hitfeel] whiff: strikes ${r.spec.strikes}, confirmed ${r.spec.confirmed}, reverted ${r.spec.reverted}, unhit events ${r.unhit}, largest extra step ${r.maxJump.toFixed(2)} m`);
    assert.ok(r.spec.reverted >= 3, `reverted ${r.spec.reverted}`);
    assert.equal(r.unhit, r.spec.reverted);
    assert.ok(r.spec.confirmed >= 3, 'full swings still confirmed');
    assert.equal(r.spec.confirmed + r.spec.reverted, r.spec.strikes);
    assert.equal(r.world.spec, null, 'nothing left pending');
    // The authoritative game is exactly the one without prediction: whiffs are misses.
    assert.deepEqual(r.stats, base.stats);
    assert.deepEqual(r.results, base.results);
    assert.equal(r.stats.hits, r.spec.confirmed);
    assert.ok(r.maxJump < 0.6, `revert jump ${r.maxJump}`);
    assert.equal(r.modeSawProvisional, 0);
  });
});

describe('hit-feel units', () => {
  test('hitPrediction is a default setting (on)', () => {
    assert.equal(DEFAULT_SETTINGS.hitPrediction, true);
    assert.equal(loadSettings(null).hitPrediction, true);
  });

  test('display extrapolation follows the swing arc, decays, and caps the travel', () => {
    // A racket turning at 10 rad/s about a shoulder 0.75 m from its sweet spot (7.5 m/s).
    const S = v3(0, 1.4, 0);
    const p = createRacketPose();
    p.axis.set(0, 0, -1);
    p.normal.set(-1, 0, 0);
    p.sweet.set(0.75, 1.4, 0);
    p.grip.copy(p.sweet).addScaled(p.axis, -RACKET.sweetSpotY);
    p.angVel.set(0, 10, 0);
    p.vel.crossVectors(p.angVel, v3().subVectors(p.sweet, S));
    const e = extrapolatePose(p, 0.05, createRacketPose(), { damping: 0, maxTravel: 10, maxAngle: 10 });
    assert.ok(Math.abs(e.sweet.distanceTo(S) - 0.75) < 1e-6, 'stays on the arc');
    const want = rotateAboutAxis(v3(0.75, 0, 0), v3(0, 1, 0), 0.5, v3()).add(S);
    assert.ok(e.sweet.distanceTo(want) < 1e-6, 'turned 0.5 rad');
    const lin = p.sweet.clone().addScaled(p.vel, 0.05);
    assert.ok(lin.distanceTo(S) > 0.75 + 0.05, 'a straight-line guess would leave the arc');
    const d = extrapolatePose(p, 0.3, createRacketPose(), { damping: 6, maxTravel: 10, maxAngle: 10 });
    const free = extrapolatePose(p, 0.3, createRacketPose(), { damping: 0, maxTravel: 10, maxAngle: 10 });
    assert.ok(p.sweet.distanceTo(d.sweet) < p.sweet.distanceTo(free.sweet), 'damped: no full overshoot');
    assert.ok(d.vel.length() < p.vel.length() * 0.2, 'velocity decays');
    const capped = extrapolatePose(p, 0.3, createRacketPose(), { damping: 0, maxTravel: 0.2, maxAngle: 10 });
    assert.ok(capped.sweet.distanceTo(p.sweet) <= 0.2 + 1e-6, 'travel capped');
  });

  test('lob vs drive is read from the ball that left the racket', () => {
    // QA2: 64-71 km/h balls that hit the far glass on the full were called lobs by the racket path.
    assert.equal(relabelByTrajectory('lob', { apex: 2.1, launchDeg: 9, speed: 19 }, 'forehand'), 'forehand');
    assert.equal(relabelByTrajectory('forehand', { apex: 5.6, launchDeg: 38, speed: 17 }, 'forehand'), 'lob');
    assert.equal(relabelByTrajectory('glass-fh', { apex: 4.6, launchDeg: 30, speed: 16 }, 'glass-fh'), 'lob');
    assert.equal(relabelByTrajectory('volley-fh', { apex: 2.0, launchDeg: 30, speed: 12 }, 'volley-fh'), 'lob', 'steep and soft');
    assert.equal(relabelByTrajectory('forehand', { apex: 3.9, launchDeg: 20, speed: 25 }, 'forehand'), 'forehand', 'borderline: racket path decides');
    assert.equal(relabelByTrajectory('lob', { apex: 3.9, launchDeg: 20, speed: 25 }, 'forehand'), 'lob', 'borderline: racket path decides');
    assert.equal(relabelByTrajectory('smash', { apex: 6, launchDeg: 40, speed: 10 }, 'smash'), 'smash', 'overheads keep their name');
    const args = { contactU: v3(0.7, 0.95, 0.35), racketVelU: v3(0, 12, 6), handed: 'right', ballBounced: true };
    assert.equal(classifyStroke(args), 'lob');
    assert.equal(classifyStroke({ ...args, noLob: true }), 'forehand');
  });

  test('reconciler: a strike frame puts the ball on the strings; corrections never move it faster than the cap', () => {
    const rec = createBallReconciler();
    const ball = { id: 7, pos: v3(0, 1, 7), vel: v3(0, 0, 20), atRest: false };
    rec.update(ball, null, FRAME);
    ball.pos.set(0, 1, 6.5);
    const c = { seq: 1, kind: 'strike', ballId: 7, contact: { x: 0, y: 1, z: 7 } };
    const r1 = rec.update(ball, c, FRAME);
    assert.ok(rec.struck);
    assert.ok(dist(r1.pos, c.contact) < 1e-9, 'drawn at the contact');
    let r = r1;
    for (let i = 0; i < 6; i++) r = rec.update(ball, c, FRAME);
    assert.ok(dist(r.pos, ball.pos) < 1e-9, 'leaves the face onto the real path');
    // A 9 m correction: blended long enough to stay under MAX_OFFSET_SPEED.
    const b2 = { id: 8, pos: v3(0, 1, 0), vel: v3(0, 0, -20), atRest: false };
    const rec2 = createBallReconciler();
    rec2.update(b2, null, FRAME);
    b2.pos.set(0, 1, -9);
    let last = rec2.update(b2, { seq: 2, kind: 'confirm', ballId: 8 }, FRAME).pos;
    last = { x: last.x, y: last.y, z: last.z };
    let maxV = 0;
    for (let i = 0; i < 60; i++) {
      b2.pos.z -= 20 * FRAME;
      const p = rec2.update(b2, { seq: 2, kind: 'confirm', ballId: 8 }, FRAME).pos;
      maxV = Math.max(maxV, (dist(p, last) - 20 * FRAME) / FRAME);
      last = { x: p.x, y: p.y, z: p.z };
    }
    assert.ok(maxV <= MAX_OFFSET_SPEED * 1.05, `offset speed ${maxV.toFixed(1)} m/s`);
  });

  test('the arm follows a predicted racket with its tracked segment lengths', () => {
    const S = { x: 0.2, y: 1.43, z: 8 }, E = { x: 0.45, y: 1.15, z: 8.1 }, W = { x: 0.62, y: 0.95, z: 7.95 };
    const tracked = { grip: { x: 0.66, y: 0.93, z: 7.9 }, axis: { x: 0, y: 0, z: 1 }, normal: { x: 1, y: 0, z: 0 } };
    const shown = { grip: { x: 0.55, y: 1.0, z: 7.55 }, axis: { x: -0.6, y: 0, z: 0.8 }, normal: { x: 0.8, y: 0, z: 0.6 } };
    const out = {};
    assert.equal(elbowForRacket(S, E, W, tracked, tracked, out), null, 'nothing to do');
    assert.ok(elbowForRacket(S, E, W, tracked, shown, out));
    assert.ok(Math.abs(dist(out, S) - dist(E, S)) < 1e-6, 'upper arm length kept');
  });

  test('incoming-ball events near the player are held up to the judge margin (a late hit may erase them), others not', () => {
    const w = createWorld({ settings: { latency: 0.11 }, rng: createRng(4) });
    const h = createHumanController({ settings: w.settings });
    w.human = h;
    w.tracking.delay = 0.15;
    w.player.home = { x: 1.5, z: 9 };
    stepWorld(w, 1 / 240);
    const heard = [];
    w.bus.on('ball:bounce', ({ evt }) => heard.push({ evt, at: w.time }));
    w.bus.on('ball:wall', ({ evt }) => heard.push({ evt, at: w.time }));
    // A machine ball that bounces 2.5 m in front of the player and passes them to the back glass.
    launchBall(w, { pos: v3(1.5, 1.1, -9), vel: v3(0, 3, 21), by: 'machine' });
    for (let i = 0; i < 240 * 1.6; i++) stepWorld(w, 1 / 240);
    const bounce = heard.find((x) => x.evt.type === 'bounce' && x.evt.side === 'near');
    assert.ok(bounce && bounce.at - bounce.evt.t < 1 / 240 + 1e-6, 'the bounce before any possible contact is heard at once');
    const glass = heard.find((x) => x.evt.type === 'wall' && x.evt.side === 'near');
    assert.ok(glass, 'with no hit the back glass is heard');
    assert.ok(glass.at - glass.evt.t > 0.1, 'held while a late hit could still erase it');
    assert.ok(glass.at - glass.evt.t <= 0.25 + 1 / 240 + 1e-6, 'held at most the judge margin');
    assert.equal(w.held.length, 0, 'nothing stuck');
  });
});
