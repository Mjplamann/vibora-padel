// Realism round 3: por tres in the smash drill, spin variety of serves and feeds, Safari
// capture-time offsets, the aimed mouse/Space auto-swing and the optional off-axis yaw fix.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { v3 } from '../src/util/vec3.js';
import { createRng } from '../src/util/math.js';
import { TRACKING } from '../src/config.js';
import { spinComponents } from '../src/physics/racket.js';
import { createWorld, launchBall, stepWorld } from '../src/game/world.js';
import { planFeed } from '../src/game/machine.js';
import { SERVE_SPIN } from '../src/game/coach.js';
import { DRILLS, DRILL_BY_ID, getDrill, FEED_SIDE_RPM, feedJitter } from '../src/game/drills.js';
import { createGame } from '../src/app/game.js';
import { loadSettings } from '../src/app/settings.js';
import { createFallbackControls, chooseContact, invertImpact } from '../src/input/fallback.js';
import { estimateCaptureTime } from '../src/tracking/pose.js';
import { captureOffsetFor, offAxisBearing, correctOffAxisYaw } from '../src/app/tracking.js';

const runGame = (spec, { seconds = 120, seed = 11, input = 'autopilot', settings = {}, fallback = null } = {}) => {
  const s = { ...loadSettings(null), ...settings };
  return createGame({ spec, settings: s, input, startTime: 10, seed, fallback });
};

describe('smash drill: por tres is reachable', () => {
  test('autopilot smashes from near the net earn por tres (and por cuatro), not only double bounces', () => {
    const g = runGame({ kind: 'drill', drillId: 'smash-x3' });
    const w = g.world;
    while (w.time < 10 + 120 && !g.isFinished()) g.advanceTo(w.time + 0.1);
    const o = g.stats.outcomes;
    assert.ok(g.isFinished());
    assert.ok((o['por-tres'] || 0) >= 2, `por tres ${JSON.stringify(o)}`);
    assert.ok((o['por-tres'] || 0) + (o['por-cuatro'] || 0) <= g.stats.reps - 2, `still a challenge: ${JSON.stringify(o)}`);
    const d = DRILL_BY_ID['smash-x3'];
    assert.ok(d.home.z <= 3.0 && d.ap.aim.z >= -3.0 && d.ap.speedKmh >= 130, 'drill set up for a steep, hard smash');
  });
});

describe('spin variety: serves and feeds', () => {
  test('machine feeds carry a small varying sidespin (±FEED_SIDE_RPM), mirrored for lefties', () => {
    for (const d of DRILLS) {
      if (d.id === 'serve' || d.id === 'return') continue;
      const sides = [];
      for (let i = 0; i < 12; i++) {
        const f = d.feeds(i, createRng(40 + i), { home: d.home });
        sides.push(f.spinRpm.side);
        assert.ok(Math.abs(f.spinRpm.side) <= FEED_SIDE_RPM + 1e-9, `${d.id} side ${f.spinRpm.side}`);
      }
      assert.ok(sides.filter((s) => Math.abs(s) > 20).length >= 8, `${d.id}: ${sides.map(Math.round)}`);
      assert.ok(Math.max(...sides) > 0 && Math.min(...sides) < 0, `${d.id} both ways`);
    }
    const right = DRILL_BY_ID['fh-drive'].feeds(3, createRng(1));
    const left = getDrill('fh-drive', 'left').feeds(3, createRng(1));
    assert.equal(left.spinRpm.side, -right.spinRpm.side);
    // The spin comes from the feed index, so the rng stream that places the feeds is unchanged.
    assert.equal(feedJitter(5, 1), feedJitter(5, 1));
    const a = createRng(9), b = createRng(9);
    DRILL_BY_ID['back-glass'].feeds(0, a);
    b.range(0, 1); b.range(0, 1); b.range(0, 1); b.range(0, 1);
    assert.equal(a.range(0, 1), b.range(0, 1), 'four draws per back-glass feed, as before');
  });

  test('return drill: machine serves are sliced with side spin either way, some reach the side glass', () => {
    const d = DRILL_BY_ID.return;
    let wide = 0, plus = 0, minus = 0;
    for (let i = 0; i < 20; i++) {
      const f = d.feeds(i, createRng(70 + i));
      assert.ok(f.spinRpm.top <= -200 && f.spinRpm.top >= -600, `top ${f.spinRpm.top}`);
      const s = Math.abs(f.spinRpm.side);
      assert.ok(s >= 300 && s <= 900, `side ${f.spinRpm.side}`);
      if (f.spinRpm.side > 0) plus++; else minus++;
      if (f.target.x > 3.5) wide++;
    }
    assert.ok(plus >= 4 && minus >= 4, `${plus} / ${minus}`);
    assert.ok(wide >= 2, `${wide} wide serves`);
    // Sliced, side-spun serves still land where the machine aims them.
    for (let i = 0; i < 6; i++) {
      const w = createWorld({ rng: createRng(i + 1) });
      const plan = planFeed(d.feeds(i, createRng(90 + i)), { origin: v3(0, 1, -9.2), court: w.court, sigma: 0 });
      launchBall(w, { pos: plan.from, vel: plan.vel, spin: plan.spin, by: 'machine' });
      for (let k = 0; k < 240 * 2 && !w.flight.events.some((e) => e.type === 'bounce'); k++) stepWorld(w, 1 / 240);
      const b = w.flight.events.find((e) => e.type === 'bounce');
      assert.ok(b && Math.hypot(b.pos.x - plan.nominal.x, b.pos.z - plan.nominal.z) < 0.3, `serve ${i} lands on target`);
    }
  });

  test('AI serves: slice and sidespin vary per serve within the level window, and land in the box', () => {
    for (const level of ['club', 'pro']) {
      const g = runGame({ kind: 'match', level }, { seed: 3 });
      const w = g.world;
      const serves = [];
      let faults = 0, last = null;
      w.bus.on('ball:hit', ({ shot }) => { last = shot.isServe && shot.by !== 'player' ? shot : null; if (last) serves.push(shot); });
      w.bus.on('rally:outcome', (o) => { if (last && (o.reason === 'serve-fault' || o.reason === 'double-fault')) faults++; });
      // 240 s (was 150): since the assist intent follows the ball the racket produced (merge pass),
      // the autopilot no longer gifts points by sending drives onto the far glass, so rallies are
      // longer and 150 s held only 4 AI serves at this seed. The serve assertions are unchanged.
      while (w.time < 10 + 240 && !g.isFinished()) g.advanceTo(w.time + 0.1);
      assert.ok(serves.length >= 5, `${level}: ${serves.length} AI serves`);
      const sides = serves.map((s) => s.spinRpm.side);
      const tops = serves.map((s) => s.spinRpm.top);
      const L = SERVE_SPIN[level];
      for (const s of sides) assert.ok(Math.abs(s) >= L.side[0] * 0.8 && Math.abs(s) <= L.side[1] * 1.05, `${level} side ${s}`);
      for (const t of tops) assert.ok(t < -100 && t > -L.slice[1] * 1.1, `${level} top ${t}`);
      assert.ok(new Set(sides.map((s) => Math.round(s / 50))).size >= Math.min(4, serves.length - 1), 'varied');
      assert.ok(sides.some((s) => s > 0) && sides.some((s) => s < 0), 'both ways');
      assert.ok(faults <= Math.ceil(serves.length * 0.1), `${level}: ${faults} faults in ${serves.length}`);
      g.dispose();
    }
  });

  test('coach hand feeds (rally) carry a little sidespin', () => {
    const g = runGame({ kind: 'rally', level: 'club' }, { seconds: 40 });
    const w = g.world;
    const sides = [];
    w.bus.on('ball:launch', ({ by }) => {
      if (by !== 'coach' || !w.ball) return;
      sides.push(spinComponents(w.ball.vel, w.ball.spin).side);
    });
    while (w.time < 10 + 60) g.advanceTo(w.time + 0.1);
    assert.ok(sides.length >= 1);
    for (const s of sides) assert.ok(Math.abs(s) <= 210, `side ${s}`);
    g.dispose();
  });
});

describe('Safari capture time', () => {
  test('real captureTime is used as is; without it the per-camera offset back-dates the estimate', () => {
    const real = estimateCaptureTime({ perfNow: 1000, now: 995, md: { captureTime: 950, expectedDisplayTime: 1010 }, fps: 30, offsetMs: 120 });
    assert.deepEqual(real, { t: 950, real: true });
    const est = estimateCaptureTime({ perfNow: 1000, now: 995, md: { expectedDisplayTime: 1010 }, fps: 30, offsetMs: 120 });
    assert.equal(est.real, false);
    assert.ok(Math.abs(est.t - (1010 - 1000 / 30 - 120)) < 1e-9, `min(now, display - frame) - offset: ${est.t}`);
    const noMd = estimateCaptureTime({ perfNow: 1000, now: 990, fps: 60, offsetMs: 50 });
    assert.ok(Math.abs(noMd.t - (990 - 1000 / 60 - 50)) < 1e-9);
    // Stale or future captureTime falls back to the estimate.
    assert.equal(estimateCaptureTime({ perfNow: 5000, now: 5000, md: { captureTime: 100 }, offsetMs: 70 }).real, false);
  });

  test('camera presets carry capture offsets: built-in 50 ms, Continuity 120 ms, USB 70 ms', () => {
    assert.equal(captureOffsetFor('macbook-builtin'), 50);
    assert.equal(captureOffsetFor('iphone-continuity'), 120);
    assert.equal(captureOffsetFor('usb-webcam'), 70);
    assert.equal(captureOffsetFor('nope'), captureOffsetFor(TRACKING.defaultCamera));
    for (const p of Object.values(TRACKING.cameraPresets)) assert.ok(p.captureOffsetMs >= 30 && p.captureOffsetMs <= 150);
  });
});

describe('off-axis yaw (optional)', () => {
  const frameAt = (u, world) => {
    const lm = Array.from({ length: 33 }, () => ({ x: u, y: 0.5, z: 0, visibility: 1 }));
    lm[23] = { x: u - 0.02, y: 0.55, z: 0, visibility: 1 };
    lm[24] = { x: u + 0.02, y: 0.55, z: 0, visibility: 1 };
    return { t: 0, width: 1280, height: 720, people: [{ landmarks: lm, world }] };
  };

  test('bearing: zero on axis, ~20° at 1 m off-axis at 2.6 m, + toward image right', () => {
    const fn = 0.5 / Math.tan((68 * Math.PI) / 360);
    assert.equal(offAxisBearing(frameAt(0.5, []), 68), 0);
    const u = 0.5 + fn * (1 / 2.6); // 1 m right in the image at 2.6 m
    const b = offAxisBearing(frameAt(u, []), 68);
    assert.ok(Math.abs(b - Math.atan(1 / 2.6)) < 1e-9, `${b}`);
    assert.ok(offAxisBearing(frameAt(1 - u, []), 68) < 0);
    assert.equal(offAxisBearing({ people: [] }, 68), null);
  });

  test('correction rotates world landmarks about +y by the bearing, leaves the input alone', () => {
    const fn = 0.5 / Math.tan((68 * Math.PI) / 360);
    const u = 0.5 + fn * Math.tan((20 * Math.PI) / 180);
    // Shoulder line square to the viewing ray (ray frame): along x'.
    const world = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 1 }));
    world[11] = { x: 0.2, y: -0.5, z: 0, visibility: 1 };
    world[12] = { x: -0.2, y: -0.5, z: 0, visibility: 1 };
    world[15] = { x: 0, y: 0, z: -0.5, visibility: 1 }; // hand 0.5 m toward the camera along the ray
    const f = frameAt(u, world);
    const out = correctOffAxisYaw(f, 68);
    assert.notEqual(out, f);
    assert.equal(f.people[0].world[11].x, 0.2, 'input untouched');
    const s = out.people[0].world;
    const deg = (a) => (a * 180) / Math.PI;
    assert.ok(Math.abs(deg(Math.atan2(-(s[11].z - s[12].z), s[11].x - s[12].x)) - 20) < 1e-6, 'shoulders yawed 20°');
    assert.ok(Math.abs(s[11].y - -0.5) < 1e-12);
    // Toward the camera along the ray = toward the camera and toward image left in camera axes.
    assert.ok(s[15].z < 0 && s[15].x < 0 && Math.abs(Math.hypot(s[15].x, s[15].z) - 0.5) < 1e-12);
    assert.equal(correctOffAxisYaw(frameAt(0.5, world), 68).people[0].world[11].x, 0.2, 'on axis: unchanged');
  });
});

describe('mouse / Space auto-swing aims at the drill intent', () => {
  const playFallback = (drillId, { seed = 2, assist = 'club', seconds = 50 } = {}) => {
    const fb = createFallbackControls({ canvas: null, keyTarget: null, handed: 'right' });
    const g = runGame({ kind: 'drill', drillId }, { input: 'fallback', fallback: fb, seed, settings: { assist } });
    const w = g.world;
    let armed = true;
    w.bus.on('ball:launch', () => { armed = true; });
    let t = w.time;
    while (t < 10 + seconds) {
      t += 0.05;
      if (armed && w.ball && w.flight.by === 'machine' && w.ball.vel.z > 0 && w.ball.pos.z > -4) {
        fb.triggerAutoSwing();
        armed = false;
      }
      g.advanceTo(t);
    }
    const s = { ...g.stats };
    g.dispose();
    return s;
  };

  test('>= 80% of auto-swing returns land in court (drives, glass, volleys, overheads; Club and Pro)', () => {
    const runs = [
      ['fh-drive', 'club'], ['bh-drive', 'club'], ['back-glass', 'club'], ['volleys', 'club'], ['bandeja', 'club'],
      ['fh-drive', 'pro'], ['back-glass', 'pro'],
    ];
    for (const [id, assist] of runs) {
      const s = playFallback(id, { assist });
      assert.ok(s.playerHits >= s.feeds * 0.75, `${id}/${assist}: hits ${s.playerHits} of ${s.feeds}`);
      assert.ok(s.inCourt >= 0.8 * s.judgedShots, `${id}/${assist}: in court ${s.inCourt}/${s.judgedShots} ${JSON.stringify(s.outcomes)}`);
    }
  });

  test('invertImpact finds the racket that sends the ball where the swing aims', () => {
    const P = v3(2.6, 0.9, 7.4);
    const vin = v3(-0.4, 2.0, 14);
    const want = v3(-6, 5, -18);
    const r = invertImpact(P, vin, v3(-60, 0, 0), want);
    assert.ok(r.err < 0.1, `err ${r.err}`);
    assert.ok(Math.abs(r.normal.length() - 1) < 1e-9 && r.normal.z < 0, 'face toward the far court');
    assert.ok(r.vel.length() > 5 && r.vel.length() < 20, `racket ${r.vel.length()} m/s`);
  });

  test('overhead drills take the lob high in front; others keep away from the back glass', () => {
    const path = [];
    for (let i = 0; i <= 60; i++) path.push({ t: i / 60, x: 1.6, y: 3.2 - i * 0.04, z: 3.0 + i * 0.03, vx: 0, vy: -3, vz: 2, bounced: false, wall: false });
    const oh = chooseContact(path, { x: 1.4, z: 4.4 }, 'right', { overhead: true });
    assert.ok(oh && oh.y > 2.0, `overhead contact at ${oh && oh.y}`);
    const deep = [{ t: 0.5, x: 2.4, y: 1.0, z: 9.5, vx: 0, vy: 0, vz: 3, bounced: true, wall: false }];
    assert.equal(chooseContact(deep, { x: 2.0, z: 9.3 }, 'right'), null);
  });
});
