// Round 6, timing & power (second real session: MacBook Air camera, close mode at 1.23 m, Rookie,
// 47 % hits; misses 0.34-0.82 s early, "no swing", and every shot at the bottom of the pace range).
// The personal timing profile (game/timingProfile.js), windows centred on the learned bias, held
// early / late hits, volleys at a ball still in the air, swings out of the picture, the personal
// swing threshold, effort-driven pace, the 'user1' autopilot profile and the diagnostics' mode.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { v3 } from '../src/util/vec3.js';
import { ASSIST } from '../src/config.js';
import { createGame } from '../src/app/game.js';
import { loadSettings } from '../src/app/settings.js';
import { createBall } from '../src/physics/ball.js';
import {
  TIMING, timingAnalysis, createTimingState, activeHitting, windowsOf, windowsAround, minSpeedFor, createSwingWatch, timingNote,
} from '../src/game/swingAssist.js';
import {
  createTimingProfile, robustBias, tunedText, effortKind, EFFORT, TIMING_STORE_KEY, sharedTimingProfile, resetTimingProfile,
} from '../src/game/timingProfile.js';
import { TIMING_CONTACT_OFFSETS, CONTACT_OFFSETS } from '../src/game/human.js';
import { USER1_PROFILE, USER1_SETUP, AP_PROFILES } from '../src/tracking/autopilot.js';
import { createRacketTrack } from '../src/tracking/racketTrack.js';

const LAT = 0.11;

function memStore() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), map: m };
}

/** A drill through the real pipeline (autopilot, Mac latency). */
function play(drillId, { assist = 'club', profile = 'human', seed = 1, seconds = 90, overrides = null, settings = {}, timingProfile = null } = {}) {
  const S = { ...loadSettings(null), assist, ...settings };
  const g = createGame({
    spec: { kind: 'drill', drillId }, settings: S, input: 'autopilot', startTime: 10, seed,
    apLatency: LAT, apDelivery: 0.15, apProfile: profile, apJitter: 0.02, timingProfile,
  });
  if (overrides) g.feed.autopilot.setProfile(profile, { seed: seed * 31 + 7, overrides });
  const w = g.world;
  const out = { misses: [], shots: [], hitEvents: [] };
  w.bus.on('player:miss', (m) => out.misses.push(m));
  w.bus.on('ball:hit', ({ shot }) => { if (shot.by === 'player' && !shot.provisional) out.shots.push(shot); });
  w.bus.on('player:hit', (p) => out.hitEvents.push(p));
  while (w.time < 10 + seconds && !g.isFinished()) g.advanceTo(w.time + 0.1);
  const reps = g.mode.state.results.filter((r) => !r.void);
  out.reps = reps.length;
  out.hits = reps.filter((r) => r.shot).length;
  out.world = w;
  g.dispose();
  return out;
}

const pearson = (a, b) => {
  const n = a.length;
  const ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
  return sab / Math.sqrt(saa * sbb);
};

describe('personal timing profile (game/timingProfile.js)', () => {
  test('the bias is the centre of the main cluster: the real session (median -0.18 s) reads -0.14 s', () => {
    // First swing of each ball in user-diag-1.json (s, swing peak - ideal contact).
    const real = [-1.088, -0.756, -0.748, -0.548, -0.49, -0.394, -0.373, -0.344, -0.326, -0.232, -0.231, -0.191, -0.164, -0.153,
      -0.144, -0.116, -0.104, -0.045, 0.002, 0.003, 0.072, 0.125, 0.237, 0.616];
    const b = robustBias(real);
    assert.ok(b.bias < -0.1 && b.bias > -0.18, `bias ${b.bias}`);
    assert.ok(b.kept >= 10 && b.kept < real.length, 'anticipation swings and the late one are left out');
    assert.equal(tunedText(b.bias, b.n), 'Timing tuned to you: −0.14 s');
    assert.equal(robustBias([0.1, 0.2]).bias, 0, 'no bias from two swings');
    assert.ok(Math.abs(robustBias(Array(24).fill(0.6)).bias) <= 0.35 + 1e-9, 'clamped');
  });

  test('persisted per device and camera; reset forgets it', () => {
    const store = memStore();
    const a = createTimingProfile({ storage: store, key: 'macbook-builtin' });
    for (const e of [-0.2, -0.15, -0.25, -0.18, -0.22, 0.6]) a.addTiming(e);
    for (const v of [3, 4, 5, 6]) a.addSwing('ground', v);
    const b = createTimingProfile({ storage: store, key: 'macbook-builtin' });
    assert.ok(Math.abs(b.bias - a.bias) < 1e-9 && b.bias < -0.12, `reloaded ${b.bias}`);
    const other = createTimingProfile({ storage: store, key: 'iphone-continuity' });
    assert.equal(other.bias, 0, 'another camera learns apart');
    assert.ok(JSON.parse(store.getItem(TIMING_STORE_KEY))['macbook-builtin'].e.length === 6);
    b.reset();
    assert.equal(createTimingProfile({ storage: store, key: 'macbook-builtin' }).bias, 0);
    // The app's shared profile (camera player) and its Settings reset.
    const s1 = sharedTimingProfile(store, 'usb-webcam');
    assert.equal(sharedTimingProfile(store, 'usb-webcam'), s1, 'one per camera for the app session');
    for (let i = 0; i < 5; i++) s1.addTiming(0.2);
    assert.ok(s1.bias > 0.1);
    resetTimingProfile(store, 'usb-webcam');
    assert.equal(s1.bias, 0);
  });

  test("effort: a swing against the player's own swings, so a slow webcam spans 0..1 too", () => {
    const p = createTimingProfile();
    const pr = EFFORT.prior.ground;
    assert.ok(Math.abs(p.effort('ground', pr[0])) < 1e-9 && Math.abs(p.effort('ground', pr[1]) - 1) < 1e-9, 'prior range before any swing');
    for (let i = 0; i < 40; i++) p.addSwing('ground', 2.5 + (i % 10) * 0.5); // a camera that sees 2.5-7 m/s
    const [lo, hi] = p.range('ground');
    assert.ok(lo < 3.6 && hi < 8.5 && hi - lo >= EFFORT.minSpan, `range ${lo.toFixed(2)}-${hi.toFixed(2)}`);
    assert.ok(p.effort('ground', 7) > 0.9, 'their hardest swing is a full one');
    assert.ok(p.effort('ground', 3) < 0.15, 'their softest is soft');
    assert.equal(effortKind('vbh'), 'volley');
    assert.equal(effortKind('sm'), 'overhead');
    assert.equal(effortKind('fh', true), 'serve');
  });
});

describe('windows, held and late hits', () => {
  test('config: Rookie holds a swing 0.6 s early and plays one 0.45 s late, Club 0.4 / 0.3; Pro physical', () => {
    assert.deepEqual(windowsOf(ASSIST.rookie.timing), { early: 0.32, late: 0.35, bufferEarly: 0.6, bufferLate: 0.45 });
    assert.deepEqual(windowsOf(ASSIST.club.timing), { early: 0.2, late: 0.22, bufferEarly: 0.4, bufferLate: 0.3 });
    assert.equal(ASSIST.pro.mode, 'physical');
  });

  /** timingAnalysis on a minimal world: a forehand drive arriving at (2.4, 0.95, 7.9). */
  function shotFor({ e = 0, speed = 9, effort = undefined, pathDeg = 15, family = 'fh', buffered = null, y = 0.95, afterBounce = true } = {}) {
    const world = { settings: { ...loadSettings(null) }, player: { pos: v3(1.7, 0, 8.3), height: 1.75, handed: 'right' }, mode: null, referee: null, timing: createTimingState() };
    const ball = createBall(v3(family === 'bh' ? -0.2 : 2.4, y, 7.9), v3(0, -1, 9), v3());
    const contact = { timing: { e, speed, effort, pathDeg, az: null, dist: 0.2, offU: null, family, kind: 'after-bounce', tStar: 20, early: 0.2, late: 0.22, key: 'k', buffered } };
    return timingAnalysis(world, ball, contact, 20, { playerPos: world.player.pos }, { afterBounce, afterWall: false }, false);
  }

  test('a held early swing pulls cross-court, weaker; a late hit goes down the line, weaker; both say so', () => {
    const on = shotFor({ e: 0, effort: 0.7 });
    const early = shotFor({ e: -0.35, effort: 0.7, buffered: 'early' });
    const late = shotFor({ e: 0.27, effort: 0.7, buffered: 'late' });
    assert.ok(early.timing.target.x < on.timing.target.x - 1, `early cross-court ${early.timing.target.x.toFixed(2)} vs ${on.timing.target.x.toFixed(2)}`);
    assert.ok(late.timing.target.x > on.timing.target.x + 1, `late down the line ${late.timing.target.x.toFixed(2)}`);
    assert.ok(early.timing.kmh < on.timing.kmh * 0.85 && late.timing.kmh < on.timing.kmh * 0.85, `${early.timing.kmh.toFixed(0)} / ${late.timing.kmh.toFixed(0)} vs ${on.timing.kmh.toFixed(0)} km/h`);
    assert.ok(early.timing.quality < on.timing.quality && late.timing.quality < on.timing.quality);
    assert.equal(early.timing.spacingText, 'A bit early — wait for the ball');
    assert.equal(late.timing.spacingText, 'A bit late — swing sooner');
    assert.equal(early.q.timing, 'early');
    assert.equal(late.q.timing, 'late');
    assert.equal(timingNote(null), null);
  });

  test('swing effort sets the pace across a wide range (drive 45 -> 115 km/h), spin grows with it', () => {
    const lo = shotFor({ effort: 0 }), hi = shotFor({ effort: 1 });
    assert.ok(lo.timing.kmh < 50 && hi.timing.kmh > 105, `${lo.timing.kmh.toFixed(0)} -> ${hi.timing.kmh.toFixed(0)} km/h`);
    assert.ok(lo.info.speedOut * 3.6 < 58 && hi.info.speedOut * 3.6 > 100, 'the ball leaves at that pace');
    assert.ok(hi.timing.top > lo.timing.top * 1.4, 'a faster brush spins more');
    // A soft drive lands shorter instead of being struck harder.
    assert.ok(lo.timing.target.z > hi.timing.target.z + 1, `soft ${lo.timing.target.z.toFixed(1)} vs full ${hi.timing.target.z.toFixed(1)}`);
    const sm0 = shotFor({ family: 'oh', y: 2.3, afterBounce: false, effort: 0, pathDeg: -25 });
    const sm1 = shotFor({ family: 'oh', y: 2.3, afterBounce: false, effort: 1, pathDeg: -25 });
    assert.equal(sm1.stroke, 'smash');
    assert.ok(sm1.timing.kmh > 135, `smash ${sm1.timing.kmh.toFixed(0)} km/h`);
    assert.ok(sm0.timing.kmh < sm1.timing.kmh - 30);
    assert.ok(Math.abs(TIMING.pace.ground[0] - 45) < 1e-9 && Math.abs(TIMING.pace.smash[1] - 150) < 1e-9);
  });

  test('a consistently late player is tuned: the windows centre on their timing and the balls are hits', () => {
    const tp = createTimingProfile();
    const r = play('fh-drive', { assist: 'club', seconds: 90, timingProfile: tp, overrides: { timingMean: 0.34, timingSigma: 0.04, timingClamp: 0.9, noSwing: 0 } });
    const s = tp.summary();
    assert.ok(s.bias > 0.2 && s.bias <= 0.35, `bias ${s.bias}`);
    assert.match(s.text, /^Timing tuned to you: \+0\.\d\d s$/);
    assert.ok(r.hits >= 0.8 * r.reps, `${r.hits}/${r.reps} hits`);
    const later = r.shots.slice(4);
    assert.ok(later.length >= 5 && later.every((x) => Math.abs(x.timingHit.e) < 0.2), 'after a few balls the swings read as on time');
    const adaptOff = play('fh-drive', { assist: 'club', seconds: 60, settings: { timingAdapt: false }, overrides: { timingMean: 0.34, timingSigma: 0.04, timingClamp: 0.9, noSwing: 0 } });
    assert.ok(adaptOff.hits <= 1, `without the tuning: ${adaptOff.hits} hits`);
  });

  test('a swing 0.3 s early on Club is held: it strikes as the ball arrives (cross-court, "a bit early")', () => {
    const r = play('fh-drive', { assist: 'club', seconds: 70, settings: { timingAdapt: false }, overrides: { timingMean: -0.31, timingSigma: 0.03, timingClamp: 0.9, noSwing: 0 } });
    assert.ok(r.hits >= 0.8 * r.reps, `${r.hits}/${r.reps}`);
    const held = r.shots.filter((x) => x.timingHit.buffered === 'early');
    assert.ok(held.length >= 0.8 * r.shots.length, `${held.length}/${r.shots.length} held`);
    for (const s of held) {
      assert.ok(s.t >= s.timingHit.tStar - TIMING.kappa * ASSIST.club.timing.early - 1e-6, 'struck when the ball arrives');
      assert.equal(s.timingHit.spacingText, 'A bit early — wait for the ball');
    }
  });
});

describe('effort on the shot and the bus', () => {
  test('ShotRecord.effort and player:hit { effort, kmh } (provisional strike and confirmation)', () => {
    const r = play('fh-drive', { assist: 'club', seconds: 60 });
    assert.ok(r.shots.length >= 6);
    for (const s of r.shots) assert.ok(s.effort >= 0 && s.effort <= 1, `effort ${s.effort}`);
    const conf = r.hitEvents.filter((p) => !p.provisional);
    assert.equal(conf.length, r.shots.length);
    assert.ok(r.hitEvents.some((p) => p.provisional), 'the predicted strike is announced too');
    for (const p of r.hitEvents) assert.ok(Number.isFinite(p.kmh) && p.stroke && 'effort' in p && 'confirms' in p);
  });

  test('swing speed and ball speed correlate (r >= 0.7 over drives) with a wide pace spread', () => {
    const shots = [];
    for (const seed of [1, 2]) shots.push(...play('fh-drive', { assist: 'rookie', seed, seconds: 120 }).shots);
    const drives = shots.filter((s) => s.timingHit && s.timingHit.type === 'ground');
    assert.ok(drives.length >= 20, `${drives.length} drives`);
    const r = pearson(drives.map((s) => s.timingHit.speed), drives.map((s) => s.speedOut));
    const kmh = drives.map((s) => s.speedOut * 3.6).sort((a, b) => a - b);
    console.log(`[timing6] drives r(swing, ball) ${r.toFixed(2)}, pace ${kmh[0].toFixed(0)}-${kmh[kmh.length - 1].toFixed(0)} km/h`);
    assert.ok(r >= 0.7, `r ${r}`);
    assert.ok(kmh[kmh.length - 1] - kmh[0] >= 35, 'pace spread');
  });
});

describe('detection: personal threshold and swings out of the picture', () => {
  test('a camera that measures slow swings lowers the threshold toward the floor, never below it', () => {
    const world = { settings: { ...loadSettings(null), assist: 'rookie' }, mode: null, timing: createTimingState() };
    const cfg = ASSIST.rookie.timing;
    const P = { family: 'fh', serve: false };
    assert.equal(minSpeedFor(world, cfg, P), cfg.minSpeed, 'no history: the assist threshold');
    const prof = createTimingProfile();
    world.timingProfile = prof;
    for (const v of [2.6, 3, 3.2, 3.5, 4, 4.4, 5]) prof.addSwing('ground', v);
    const th = minSpeedFor(world, cfg, P);
    assert.ok(th < cfg.minSpeed && th >= cfg.minSpeedFloor, `personal ${th}`);
    for (let i = 0; i < 40; i++) prof.addSwing('ground', 1.2);
    assert.equal(minSpeedFor(world, cfg, P), cfg.minSpeedFloor, 'floor');
    assert.equal(minSpeedFor(world, cfg, P, false), cfg.minSpeed, 'the assist threshold on request');
  });

  test('a swing hidden from the camera is read when the hand comes back into the picture, only while a ball is due', () => {
    const run = (window) => {
      const track = createRacketTrack({ capacity: 240 });
      const posAt = (t, out = { x: 0, z: 0 }) => { out.x = 0; out.z = 8; return out; };
      const watch = createSwingWatch({ racketTrack: track, posAt });
      const pose = { grip: v3(), axis: v3(0, 1, 0), normal: v3(0, 0, -1), hidden: false };
      const events = [];
      for (let i = 0; i <= 60; i++) {
        const t = i / 30;
        // Still at the side (ready, x 0.35, z 8.2), out of the picture from 0.8 s to 1.3 s, back in at the
        // contact (x 0.6, z 7.5): the swing itself was never seen.
        const hidden = t > 0.8 && t < 1.3;
        const back = t >= 1.3;
        pose.grip.set(back ? 0.6 : 0.35, 1.0, back ? 7.5 : 8.2);
        pose.hidden = hidden;
        track.push(t, pose);
        events.push(...watch.process(2, 0.3, { family: 'fh', dom: 1, window }));
      }
      return { events, watch };
    };
    const due = run([1.0, 1.5]);
    assert.equal(due.events.length, 1, 'one swing inferred');
    const ev = due.events[0];
    assert.ok(ev.inferred && ev.cPeak > 1.2 && ev.cPeak < 1.31 && ev.peakSpeed >= 2, `${ev.cPeak} ${ev.peakSpeed}`);
    assert.equal(run([3, 4]).events.length, 0, 'not when no ball is due then');
    assert.equal(run(null).events.length, 0, 'not without a ball');
  });
});

describe('ideal contact out in front', () => {
  test('timing plans meet the ball 0.55-0.7 m in front of the hips (visible); Pro keeps the hip-line offsets', () => {
    for (const f of ['fh', 'bh', 'vfh', 'vbh']) {
      assert.ok(TIMING_CONTACT_OFFSETS[f].z >= 0.55 && TIMING_CONTACT_OFFSETS[f].z <= 0.72, `${f} ${TIMING_CONTACT_OFFSETS[f].z}`);
      assert.ok(TIMING_CONTACT_OFFSETS[f].z > CONTACT_OFFSETS[f].z + 0.1);
      // Within the arm and racket's reach of the hitting shoulder (with the turn): <= 0.95 m.
      const o = TIMING_CONTACT_OFFSETS[f];
      assert.ok(Math.hypot(Math.abs(o.x) - 0.12, o.z) < 0.95, `${f} reach`);
    }
    const S = { ...loadSettings(null), assist: 'rookie' };
    const g = createGame({ spec: { kind: 'drill', drillId: 'fh-drive' }, settings: S, input: 'autopilot', startTime: 10, seed: 3, apLatency: LAT, apDelivery: 0.15 });
    const w = g.world;
    let n = 0, sum = 0;
    const seen = new Set();
    while (w.time < 40) {
      g.advanceTo(w.time + 1 / 60);
      const P = w.timing.plan;
      if (P && !seen.has(P.key) && w.time >= P.tStar) {
        seen.add(P.key);
        sum += w.player.pos.z - P.pStar.z;
        n++;
      }
    }
    g.dispose();
    assert.ok(n >= 4);
    assert.ok(sum / n > 0.45 && sum / n < 0.75, `ball ${(sum / n).toFixed(2)} m in front of the player at t*`);
  });
});

describe("'user1' autopilot profile and the diagnostics' hitting mode", () => {
  test('user1 is the fitted session: timing mixture with an early cluster, slow log-normal swings, 1.23 m close setup', () => {
    assert.equal(AP_PROFILES.user1, USER1_PROFILE);
    const w = USER1_PROFILE.timingMix.reduce((a, c) => a + c.w, 0);
    assert.ok(Math.abs(w - 1) < 1e-9);
    assert.ok(USER1_PROFILE.timingMix.some((c) => c.mean < -0.5 && c.w > 0.2), 'anticipation cluster');
    assert.ok(USER1_PROFILE.speedLog.fh[0] < 7, 'slow swings');
    assert.equal(USER1_SETUP.distance, 1.23);
  });

  test('hitting mode / windows come from settings when no game runs (Rookie read "physical" in the real diagnostics)', () => {
    const rookie = activeHitting({ settings: { ...loadSettings(null), assist: 'rookie' }, input: 'camera' });
    assert.equal(rookie.mode, 'timing');
    assert.equal(rookie.windows.bufferEarly, 0.6);
    assert.equal(rookie.windows.reach, 'any');
    assert.equal(activeHitting({ settings: { ...loadSettings(null), assist: 'pro' }, input: 'camera' }).mode, 'physical');
    assert.equal(activeHitting({ settings: { ...loadSettings(null), assist: 'club' }, input: 'fallback' }).mode, 'physical');
    const prof = createTimingProfile();
    for (const e of [-0.2, -0.22, -0.18, -0.25, -0.2]) prof.addTiming(e);
    const tuned = activeHitting({ settings: { ...loadSettings(null), assist: 'rookie' }, input: 'camera', profile: prof });
    assert.ok(tuned.bias < -0.1);
    assert.match(tuned.text, /^Timing tuned to you: −0\.\d\d s$/);
    // The outer limits in use widen away from the bias: t* + bias + 0.45 + |bias| is still t* + 0.45.
    assert.ok(Math.abs(tuned.active.bufferLate - (0.45 - tuned.bias)) < 1e-3, JSON.stringify(tuned.active));
    assert.equal(tuned.active.bufferEarly, 0.6);
  });

  test('tuning never shrinks the window: the clean window moves with the bias, the outer limits only widen', () => {
    const cfg = ASSIST.club.timing;
    assert.deepEqual(windowsAround(cfg, 0), windowsOf(cfg));
    const early = windowsAround(cfg, -0.11); // an early player: their moment is t* - 0.11
    assert.equal(early.early, 0.2);
    assert.equal(early.late, 0.22);
    assert.equal(early.bufferEarly, 0.4); // held from t* - 0.51
    assert.ok(Math.abs(early.bufferLate - 0.41) < 1e-9); // late hits up to t* + 0.30, as untuned
    const late = windowsAround(cfg, 0.2);
    assert.ok(Math.abs(late.bufferEarly - 0.6) < 1e-9); // held from t* - 0.40, as untuned
    assert.equal(late.bufferLate, 0.3); // late hits up to t* + 0.50
  });
});
