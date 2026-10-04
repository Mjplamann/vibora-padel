// Round 3 hittability (first real-world session: "it was like trying to hit a fruit fly", "I'd swing
// and never make contact but I didn't know why"). Timing-based hitting (game/swingAssist.js), the
// human-like autopilot (tracking/autopilot.js HUMAN_PROFILE), miss reasons, auto-positioning, ball
// visibility helpers, learning slow motion and diagnostics. Realistic Mac pipeline: 0.11 s display
// latency, 0.15 s capture -> result delivery with 0.02 s jitter, 30 fps camera.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { v3 } from '../src/util/vec3.js';
import { ASSIST } from '../src/config.js';
import { createGame } from '../src/app/game.js';
import { loadSettings } from '../src/app/settings.js';
import { createBall } from '../src/physics/ball.js';
import {
  TIMING, timingConfig, timingAnalysis, missText, contactTimeFor, learningSlowmoOn, reachRing, createTimingState,
} from '../src/game/swingAssist.js';
import { HUMAN_PROFILE } from '../src/tracking/autopilot.js';
import { STANCE_Z_MAX } from '../src/game/intercept.js';
import { buildDiagnostics, copyText } from '../src/app/diagnostics.js';
import { MISS_TIPS } from '../src/game/modes.js';

const LAT = 0.11;
const DELIVERY = 0.15;
const JITTER = 0.02;

/** Runs a drill with the autopilot through the real pipeline at Mac latency. */
function play(drillId, { assist = 'club', profile = 'human', seed = 1, seconds = 200, overrides = null, settings = {} } = {}) {
  const S = { ...loadSettings(null), assist, ...settings };
  const g = createGame({
    spec: { kind: 'drill', drillId }, settings: S, input: 'autopilot', startTime: 10, seed,
    apLatency: LAT, apDelivery: DELIVERY, apProfile: profile, apJitter: JITTER,
  });
  if (overrides) g.feed.autopilot.setProfile('human', { seed: seed * 31 + 7, overrides });
  const w = g.world;
  const out = { misses: [], shots: [], provisional: 0, unhit: 0 };
  w.bus.on('player:miss', (m) => out.misses.push(m));
  w.bus.on('ball:unhit', () => out.unhit++);
  w.bus.on('ball:hit', ({ shot }) => {
    if (shot.by !== 'player') return;
    if (shot.provisional) out.provisional++;
    else out.shots.push(shot);
  });
  while (w.time < 10 + seconds && !g.isFinished()) g.advanceTo(w.time + 0.1);
  const reps = g.mode.state.results.filter((r) => !r.void);
  out.reps = reps.length;
  out.hits = reps.filter((r) => r.shot).length;
  out.unhitReps = reps.filter((r) => !r.shot);
  out.inCourt = g.stats.inCourt;
  out.judged = g.stats.judgedShots;
  out.late = w.hitRejects.late;
  out.world = w;
  out.game = g;
  out.summary = g.mode.summary(w);
  g.dispose();
  return out;
}

const rate = (r) => r.hits / Math.max(1, r.reps);

describe('timing hits: configuration', () => {
  test('Club and Rookie hit on timing with forgiving windows; Pro stays physical', () => {
    assert.equal(ASSIST.club.mode, 'timing');
    assert.equal(ASSIST.rookie.mode, 'timing');
    assert.equal(ASSIST.pro.mode, 'physical');
    assert.deepEqual([ASSIST.club.timing.early, ASSIST.club.timing.late], [0.2, 0.22]);
    assert.deepEqual([ASSIST.rookie.timing.early, ASSIST.rookie.timing.late], [0.32, 0.35]);
    assert.equal(ASSIST.club.timing.reach, 0.75);
    assert.equal(ASSIST.rookie.timing.reach, Infinity);
    const w = (s, input = 'camera') => ({ settings: { ...loadSettings(null), ...s }, input });
    assert.ok(timingConfig(w({ assist: 'club' })));
    assert.equal(timingConfig(w({ assist: 'pro' })), null);
    assert.equal(timingConfig(w({ assist: 'club', hitMode: 'physical' })), null);
    assert.ok(timingConfig(w({ assist: 'pro', hitMode: 'timing' })), 'timing can be chosen for Pro');
    assert.equal(timingConfig(w({ assist: 'club' }, 'fallback')), null, 'mouse play keeps its aimed auto-swing');
  });

  test('round-3 settings default and validate', () => {
    const S = loadSettings(null);
    assert.equal(S.hitMode, 'auto');
    assert.equal(S.ballVisibility, 'enhanced');
    assert.equal(S.learningSlowmo, 'auto');
    assert.equal(S.timingTick, false);
    const store = { getItem: () => JSON.stringify({ hitMode: 'x', ballVisibility: 'huge', learningSlowmo: true, timingTick: 'yes' }), setItem() {} };
    const T = loadSettings(store);
    assert.equal(T.hitMode, 'auto');
    assert.equal(T.ballVisibility, 'enhanced');
    assert.equal(T.learningSlowmo, 'on');
    assert.equal(T.timingTick, false);
    assert.equal(learningSlowmoOn({ assist: 'rookie', learningSlowmo: 'auto' }), true);
    assert.equal(learningSlowmoOn({ assist: 'club', learningSlowmo: 'auto' }), false);
    assert.equal(learningSlowmoOn({ assist: 'club', learningSlowmo: 'on' }), true);
    assert.equal(learningSlowmoOn({ assist: 'rookie', learningSlowmo: 'off' }), false);
  });

  test('the contact moment follows the swing a little and stays on the right side of the bounce / glass', () => {
    const P = { tStar: 10, kind: 'after-bounce', bounceT: 9.8, wallT: 10.25 };
    assert.equal(contactTimeFor(P, 0), 10);
    assert.ok(Math.abs(contactTimeFor(P, 0.2) - (10 + TIMING.kappa * 0.2)) < 1e-9);
    assert.ok(contactTimeFor(P, -0.8) >= 9.83 - 1e-9, 'never before the bounce');
    assert.ok(contactTimeFor(P, 0.8) <= 10.22 + 1e-9, 'never past the glass');
    assert.ok(contactTimeFor({ tStar: 10, kind: 'volley', bounceT: 10.1 }, 0.5) <= 10.07 + 1e-9, 'a volley stays a volley');
    assert.ok(contactTimeFor({ tStar: 10, kind: 'after-wall', wallT: 9.9 }, -0.5) >= 9.95 - 1e-9, 'a glass ball is played off the glass');
  });
});

describe('timing hits: the shot a swing plays', () => {
  /** timingAnalysis on a minimal world: a forehand drive arriving at (2.4, 0.95, 7.9). */
  function shotFor({ e = 0, speed = 9, pathDeg = 15, family = 'fh', handed = 'right', y = 0.95, afterBounce = true, hint = null } = {}) {
    const world = {
      settings: { ...loadSettings(null), handed }, player: { pos: v3(handed === 'left' ? -1.7 : 1.7, 0, 8.3), height: 1.75, handed },
      mode: hint ? { apHints: hint } : null, referee: null, timing: createTimingState(),
    };
    const x = (handed === 'left' ? -1 : 1) * (family === 'bh' ? -0.2 : 2.4);
    const ball = createBall(v3(x, y, 7.9), v3(0, -1, 9), v3());
    const contact = { timing: { e, speed, pathDeg, az: null, dist: 0.2, offU: null, family, kind: afterBounce ? 'after-bounce' : 'volley', tStar: 20, early: 0.2, late: 0.22, key: 'k' } };
    const a = timingAnalysis(world, ball, contact, 20, { playerPos: world.player.pos }, { afterBounce, afterWall: false }, false);
    return { a, ball };
  }

  test('timing error sets the direction: early -> cross-court, late -> down the line (both wings, both hands)', () => {
    for (const handed of ['right', 'left']) {
      const dom = handed === 'left' ? -1 : 1;
      const fhE = shotFor({ e: -0.15, handed }).a.timing.target.x * dom;
      const fh0 = shotFor({ e: 0, handed }).a.timing.target.x * dom;
      const fhL = shotFor({ e: 0.18, handed }).a.timing.target.x * dom;
      assert.ok(fhE < fh0 && fh0 < fhL, `${handed} forehand: early ${fhE.toFixed(2)} < on time ${fh0.toFixed(2)} < late ${fhL.toFixed(2)}`);
      const bhE = shotFor({ e: -0.15, family: 'bh', handed }).a.timing.target.x * dom;
      const bhL = shotFor({ e: 0.18, family: 'bh', handed }).a.timing.target.x * dom;
      assert.ok(bhE > bhL, `${handed} backhand: early pulls cross-court (${bhE.toFixed(2)} > ${bhL.toFixed(2)})`);
    }
  });

  test('swing speed sets the pace inside the stroke range; the swing path sets the spin', () => {
    const slow = shotFor({ speed: 4 }).a, fast = shotFor({ speed: 14 }).a;
    assert.ok(fast.timing.kmh > slow.timing.kmh + 25, `${slow.timing.kmh.toFixed(0)} -> ${fast.timing.kmh.toFixed(0)} km/h`);
    assert.ok(slow.timing.kmh >= TIMING.pace.ground[0] * 0.85 && fast.timing.kmh <= TIMING.pace.ground[1], 'realistic drive range');
    const top = shotFor({ pathDeg: 30 }).a.timing.top, flat = shotFor({ pathDeg: 0 }).a.timing.top, slice = shotFor({ pathDeg: -25 }).a.timing.top;
    assert.ok(top > 1800, `low -> high: topspin ${top.toFixed(0)} rpm`);
    assert.ok(flat > 0 && flat < 700, `flat path: light topspin ${flat.toFixed(0)} rpm`);
    assert.ok(slice < -600, `high -> low: slice ${slice.toFixed(0)} rpm`);
  });

  test('overheads: a fast downward swing is a flat smash, a controlled one a sliced bandeja', () => {
    const smash = shotFor({ family: 'oh', y: 2.3, afterBounce: false, speed: 13, pathDeg: -25 }).a;
    const bandeja = shotFor({ family: 'oh', y: 2.3, afterBounce: false, speed: 8, pathDeg: -5 }).a;
    assert.equal(smash.stroke, 'smash');
    assert.ok(Math.abs(smash.timing.top) < 400, `flat smash ${smash.timing.top.toFixed(0)} rpm`);
    assert.ok(smash.timing.kmh > 115, `smash pace ${smash.timing.kmh.toFixed(0)} km/h`);
    assert.equal(bandeja.stroke, 'bandeja');
    assert.ok(bandeja.timing.top < -600, `sliced bandeja ${bandeja.timing.top.toFixed(0)} rpm`);
    const vib = shotFor({ family: 'oh', y: 2.3, afterBounce: false, speed: 9, pathDeg: -5, hint: { shot: 'vibora', aim: { x: -3.9, z: -8.2 } } }).a;
    assert.equal(vib.stroke, 'vibora');
    assert.ok(Math.abs(vib.timing.side) > 500, 'víbora carries side spin');
  });

  test('the ball is struck where it is, and leaves toward the far court', () => {
    const { a, ball } = shotFor({ e: 0.1 });
    assert.ok(a.contactPos.distanceTo(v3(2.4, 0.95, 7.9)) < 1e-9);
    assert.ok(ball.vel.z < -10, 'over the net');
    assert.ok(a.pose && a.pose.sweet.distanceTo(a.contactPos) < 0.06, 'the drawn racket meets the ball');
  });
});

describe('miss reasons', () => {
  test('texts name the error with its size', () => {
    assert.equal(missText({ reason: 'late', e: 0.3 }).text, 'Swing was 0.3 s late');
    assert.equal(missText({ reason: 'early', e: -0.25 }).text, 'Swing was 0.25 s early');
    assert.equal(missText({ reason: 'early', e: -0.06 }).text, 'Swing was 60 ms early');
    assert.equal(missText({ reason: 'no-swing', speed: 0 }).text, 'No swing detected — swing a bit faster');
    assert.equal(missText({ reason: 'below', cm: 50 }).text, 'Racket was 50 cm below the ball — swing higher');
    assert.match(missText({ reason: 'too-far', cm: 60, step: 'right' }).text, /60 cm out of reach — step right/);
    assert.equal(missText({ reason: 'rules', rule: 'serve' }).text, 'Let the serve bounce');
    assert.equal(missText({ reason: 'late', e: 0.3 }).es, 'Golpeaste 0,3 s tarde');
    for (const k of Object.keys(MISS_TIPS)) assert.ok(MISS_TIPS[k].length > 10);
  });

  const forced = {
    late: { timingMean: 0.33, timingSigma: 0.02, noSwing: 0, spatialSigma: { x: 0.02, y: 0.02, z: 0.02 } },
    early: { timingMean: -0.37, timingSigma: 0.02, noSwing: 0, spatialSigma: { x: 0.02, y: 0.02, z: 0.02 } },
    'no-swing': { noSwing: 1 },
  };
  for (const [reason, overrides] of Object.entries(forced)) {
    test(`every ball missed by a ${reason} swing is explained as "${reason}" (HUD, voice, rep note, summary)`, () => {
      const r = play('fh-drive', { seconds: 50, overrides });
      assert.ok(r.reps >= 8, `${r.reps} reps`);
      assert.ok(r.hits <= 1, `${r.hits} hits`);
      const missed = r.unhitReps;
      assert.ok(missed.length >= r.reps - 1);
      for (const rep of missed) {
        assert.equal(rep.miss, reason, `rep ${rep.index}: ${rep.miss}`);
        assert.ok(rep.notes[0] && rep.notes[0].length > 5, 'the rep note is the reason');
      }
      assert.ok(r.misses.every((m) => m.reason === reason && m.text && m.es));
      assert.equal(r.summary.misses[reason], r.misses.length);
      if (reason === 'late' || reason === 'early') assert.ok(r.misses.every((m) => Math.abs(m.ms) > 220), 'timing error in ms (outside the window)');
      if (reason === 'no-swing') assert.equal(r.provisional, 0, 'no swing: nothing is shown hit, then undone');
      assert.ok(r.summary.tips.includes(MISS_TIPS[reason]), 'the results tips name the advice');
    });
  }

  test('no swing -> no hit (Club and Rookie), and the referee never waits on a decision forever', () => {
    for (const assist of ['club', 'rookie']) {
      const r = play('bh-drive', { assist, seconds: 45, overrides: { noSwing: 1 } });
      assert.equal(r.hits, 0, `${assist}: ${r.hits} hits without a swing`);
      assert.equal(r.shots.length, 0);
      assert.ok(r.reps >= 8, `${assist}: reps still resolve (${r.reps})`);
      assert.ok(r.unhitReps.every((x) => x.miss === 'no-swing'), `${assist}: every rep says why: ${r.unhitReps.map((x) => x.miss)}`);
    }
  });

  test('the last rep of a drill carries its miss reason too (the result waits for the explanation)', () => {
    const r = play('back-glass', { seconds: 400, overrides: { noSwing: 1 } });
    assert.ok(r.game.isFinished(), 'drill finished');
    assert.ok(r.reps >= 10 && r.hits === 0);
    assert.deepEqual([...new Set(r.unhitReps.map((x) => x.miss))], ['no-swing']);
    assert.equal(r.summary.misses && r.summary.misses['no-swing'], r.reps, 'results summary counts them');
  });
});

describe('human-like autopilot at Mac latency (0.11 + 0.15 s, jitter, 30 fps)', () => {
  test('the human profile is what a person does: timing σ 90 ms (late bias), ~0.27 m racket error, 8-16 m/s', () => {
    assert.equal(HUMAN_PROFILE.timingSigma, 0.09);
    assert.ok(HUMAN_PROFILE.timingMean > 0);
    const s = HUMAN_PROFILE.spatialSigma;
    assert.ok(Math.hypot(s.x, s.y, s.z) > 0.24 && Math.hypot(s.x, s.y, s.z) < 0.32);
    assert.deepEqual([...HUMAN_PROFILE.speed.fh], [8, 16]);
    assert.ok(HUMAN_PROFILE.noSwing > 0 && HUMAN_PROFILE.noStep > 0);
  });

  test('Club timing hits: forehand >= 80%, back glass >= 65%, >= 70% of hits land in the far court', () => {
    const fh = [play('fh-drive', { seed: 1, seconds: 90 }), play('fh-drive', { seed: 2, seconds: 90 })];
    const bg = [play('back-glass', { seed: 1, seconds: 90 }), play('back-glass', { seed: 2, seconds: 90 })];
    const sum = (a, k) => a.reduce((s, r) => s + r[k], 0);
    const fhRate = sum(fh, 'hits') / sum(fh, 'reps');
    const bgRate = sum(bg, 'hits') / sum(bg, 'reps');
    const all = [...fh, ...bg];
    const inCourt = sum(all, 'inCourt') / Math.max(1, sum(all, 'judged'));
    console.log(`[hittability] club human: fh ${(fhRate * 100).toFixed(0)}% back-glass ${(bgRate * 100).toFixed(0)}% in court ${(inCourt * 100).toFixed(0)}%`);
    assert.ok(fhRate >= 0.8, `fh ${fhRate}`);
    assert.ok(bgRate >= 0.65, `back-glass ${bgRate}`);
    assert.ok(inCourt >= 0.7, `in court ${inCourt}`);
    for (const r of all) {
      assert.equal(r.late, 0, 'no contact rejected as late: the judge waits for the swing');
      for (const s of r.shots) assert.ok(s.timingHit && Number.isFinite(s.timingHit.e), 'timing hit record');
      assert.equal(r.misses.length + r.hits >= r.reps, true, 'every playable ball not hit has a reason');
    }
  });

  test('Rookie: forehand >= 90%; the player is placed at the stance', () => {
    const r = play('fh-drive', { assist: 'rookie', seed: 3, seconds: 90 });
    assert.ok(rate(r) >= 0.9, `rookie fh ${rate(r)}`);
  });

  test('Pro keeps physical hitting (no timing records), unchanged by the timing code', () => {
    const r = play('fh-drive', { assist: 'pro', profile: 'precise', seed: 1, seconds: 40 });
    assert.ok(r.shots.length >= 5);
    assert.ok(r.shots.every((s) => !s.timingHit), 'physical contacts');
    assert.equal(r.misses.length, 0, 'no timing judge in Pro');
  });
});

describe('webcam landmark noise', () => {
  test('a still player on a noisy camera (2x a typical webcam) never hits and is never shown a hit; a swinging one still hits', () => {
    for (const noise of [1, 2]) {
      const S = loadSettings(null);
      const still = createGame({ spec: { kind: 'drill', drillId: 'fh-drive' }, settings: S, input: 'autopilot', startTime: 10, seed: 2, apLatency: LAT, apDelivery: DELIVERY, apProfile: 'human', apJitter: JITTER, apNoise: noise });
      still.feed.autopilot.setProfile('human', { seed: 5, overrides: { noSwing: 1 } });
      const w = still.world;
      while (w.time < 10 + 45 && !still.isFinished()) still.advanceTo(w.time + 0.1);
      assert.equal(still.stats.playerHits, 0, `noise ${noise}: ${still.stats.playerHits} hits without a swing`);
      assert.ok(w.specStats.strikes <= 2, `noise ${noise}: ${w.specStats.strikes} hits shown without a swing`);
      assert.ok(w.timing.swings.filter((x) => x.speed > 0).length <= 1, 'no swings read from jitter');
      still.dispose();
    }
    const S = loadSettings(null);
    const g = createGame({ spec: { kind: 'drill', drillId: 'fh-drive' }, settings: S, input: 'autopilot', startTime: 10, seed: 2, apLatency: LAT, apDelivery: DELIVERY, apProfile: 'human', apJitter: JITTER, apNoise: 1 });
    while (g.world.time < 10 + 60 && !g.isFinished()) g.advanceTo(g.world.time + 0.1);
    const reps = g.mode.state.results.filter((r) => !r.void);
    const hits = reps.filter((r) => r.shot).length;
    assert.ok(hits >= 0.85 * reps.length, `noisy camera: ${hits}/${reps.length}`);
    g.dispose();
  });
});

describe('auto-positioning (timing hits)', () => {
  test('Rookie places a player who never steps at the stance; Club leaves a quarter to their own steps; never deeper than 9.2 m', () => {
    const lazy = { noStep: 1, stepPart: [0, 0], stepNoise: 0, noSwing: 0 };
    for (const [assist, maxD] of [['rookie', 0.03], ['club', 0.55]]) {
      const S = { ...loadSettings(null), assist };
      const g = createGame({ spec: { kind: 'drill', drillId: 'back-glass' }, settings: S, input: 'autopilot', startTime: 10, seed: 2, apLatency: LAT, apDelivery: DELIVERY, apJitter: JITTER });
      g.feed.autopilot.setProfile('human', { seed: 4, overrides: lazy });
      const w = g.world;
      let last = null, maxStanceZ = 0, maxZ = 0, n = 0, worst = 0;
      while (w.time < 10 + 45 && !g.isFinished()) {
        g.advanceTo(w.time + 1 / 120);
        const p = w.timing.plan;
        maxZ = Math.max(maxZ, w.player.pos.z);
        if (p) maxStanceZ = Math.max(maxStanceZ, p.stance.z);
        if (p && p.key !== last && w.time >= p.tStar) {
          last = p.key;
          n++;
          worst = Math.max(worst, Math.hypot(w.player.pos.x - p.stance.x, w.player.pos.z - p.stance.z));
        }
      }
      assert.ok(n >= 5, `${n} contacts`);
      assert.ok(worst <= maxD, `${assist}: ${worst.toFixed(2)} m from the stance at the contact`);
      assert.ok(maxStanceZ <= STANCE_Z_MAX + 1e-9 && maxZ <= 9.4 + 1e-9, `stance ${maxStanceZ.toFixed(2)} body ${maxZ.toFixed(2)}`);
      g.dispose();
    }
  });
});

describe('learning aids off the glass', () => {
  test('Rookie (auto) eases the sim to 0.7x from the glass rebound to the contact; Club (auto) does not', () => {
    for (const [assist, want] of [['rookie', true], ['club', false]]) {
      const S = { ...loadSettings(null), assist };
      const g = createGame({ spec: { kind: 'drill', drillId: 'back-glass' }, settings: S, input: 'autopilot', startTime: 10, seed: 5, apLatency: LAT, apDelivery: DELIVERY });
      const w = g.world;
      let minScale = 1;
      const cues = [];
      w.bus.on('timing:cue', (c) => cues.push(c.kind));
      while (w.time < 10 + 25) {
        g.advanceTo(w.time + 1 / 60);
        minScale = Math.min(minScale, g.timeScale());
      }
      if (want) assert.ok(Math.abs(minScale - TIMING.slowmo) < 1e-6, `${assist}: ${minScale}`);
      else assert.equal(minScale, 1, `${assist}: ${minScale}`);
      for (const k of ['glass', 'now-voice', 'tick', 'now']) assert.ok(cues.includes(k), `${k} cue`);
      g.dispose();
    }
  });

  test('the reach ring closes on the ball and is green within 60 ms of the moment to swing', () => {
    const S = loadSettings(null);
    const g = createGame({ spec: { kind: 'drill', drillId: 'fh-drive' }, settings: S, input: 'autopilot', startTime: 10, seed: 1, apLatency: LAT, apDelivery: DELIVERY });
    const w = g.world;
    let sawYellow = false, sawGreen = false, greenOff = 0, lastP = -1, monotone = true;
    while (w.time < 10 + 12) {
      g.advanceTo(w.time + 1 / 240);
      const r = reachRing(w);
      if (!r) { lastP = -1; continue; }
      if (r.green) {
        sawGreen = true;
        greenOff = Math.max(greenOff, Math.abs(w.time - r.tStar));
      } else if (!r.after) sawYellow = true;
      if (!r.after && r.progress < lastP - 1e-9) monotone = false;
      if (!r.after) lastP = r.progress;
    }
    assert.ok(sawYellow && sawGreen);
    assert.ok(greenOff <= TIMING.green + 1e-9);
    assert.ok(monotone, 'the ring closes steadily');
    g.dispose();
  });
});

describe('copy diagnostics', () => {
  test('a compact JSON with setup, settings, per-drill hits / misses and the last 40 swings', () => {
    const r = play('fh-drive', { seconds: 40, overrides: { timingMean: 0.3, timingSigma: 0.05, noSwing: 0.2 } });
    const d = buildDiagnostics({
      world: r.world, settings: r.world.settings, calibration: { x0: 0, d0: 2.6, eyeHeight: 1.64, scale: 1, ok: true },
      tracking: { camera: { label: 'FaceTime HD Camera', kind: 'builtin', presetKey: 'macbook-builtin', settings: { width: 1280, height: 720, frameRate: 30 } }, stats: { fps: 29.7, inferMs: 21, latencyMs: 148, frames: 900, needsLatencyTest: false } },
      env: { ua: 'test', width: 1920, height: 1080, dpr: 2 },
    });
    const json = JSON.stringify(d);
    assert.ok(json.length < 40000, `${json.length} chars`);
    const back = JSON.parse(json);
    assert.equal(back.kind, 'vibora-diagnostics');
    assert.equal(back.camera.fps, 30);
    assert.equal(back.tracker.captureTime, true);
    assert.equal(back.settings.assist, 'club');
    assert.equal(back.hitting.mode, 'timing');
    assert.ok(back.perDrill['drill:fh-drive'], 'per drill');
    const pd = back.perDrill['drill:fh-drive'];
    assert.ok(Object.values(pd.misses).reduce((a, b) => a + b, 0) >= 1, 'misses by reason');
    assert.ok(back.swings.length >= 3 && back.swings.length <= 40);
    for (const s of back.swings) for (const k of ['tStar', 'e', 'speed', 'result', 'dist']) assert.ok(k in s, `swing.${k}`);
  });

  test('merge: glasses status, render safety net and side-on tracker guards ride along (JSON-safe)', () => {
    const glasses = { glasses: { enabled: true, headTracking: true }, driver: { status: 'streaming', lastBytes: '7308 00' } };
    const safety = { ballHidden: 0, rigHidden: 1, meshesHidden: 2, framesWithHidden: 2, lastHidden: 'probe', camera: { eyeRestored: 0, cameraRestored: 0 }, rig: { racketRejected: 0, segmentsHidden: 3 }, mirrorFrames: 9 };
    const robust = { stats: { frames: 10, swaps: 2, spikes: 1, nonFinite: 0 }, yawDeg: 61.23456, sideOn: true };
    const cyclic = { a: 1 };
    cyclic.self = cyclic;
    const d = JSON.parse(JSON.stringify(buildDiagnostics({ settings: { assist: 'club' }, glasses, safety, robust, env: {} })));
    assert.deepEqual(d.glasses, glasses);
    assert.equal(d.safety.meshesHidden, 2);
    assert.equal(d.safety.rig.segmentsHidden, 3);
    assert.equal(d.robust.stats.swaps, 2);
    assert.equal(d.robust.yawDeg, 61.235);
    assert.equal(d.robust.sideOn, true);
    const none = buildDiagnostics({ glasses: cyclic });
    assert.equal(none.glasses, null, 'a non-serialisable part is dropped, not thrown');
    assert.equal(none.safety, null);
    assert.equal(none.robust, null);
  });

  test('copy falls back to a selectable text when the clipboard is unavailable', async () => {
    let shown = null;
    const r = await copyText('{"a":1}', (t) => { shown = t; });
    assert.equal(r, 'fallback');
    assert.equal(shown, '{"a":1}');
  });
});
