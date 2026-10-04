// First-person gaze assist (src/render/gaze.js) against the real drill pipeline: autopilot ->
// synthetic camera -> tracking -> hits, viewed at 60 Hz exactly as the stage feeds the camera
// (world.ball + world.player.eye). The real player's body and arms face the TV, so the view must
// be close to straight ahead at every contact and must never whip round.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createGame } from '../src/app/game.js';
import { loadSettings } from '../src/app/settings.js';
import { createGaze, GAZE, GLASS_VIEW } from '../src/render/gaze.js';
import { createBall } from '../src/physics/ball.js';
import { v3 } from '../src/util/vec3.js';
import { viewBall } from '../src/game/world.js';

const DEG = Math.PI / 180;
const FRAME = 1 / 60;

function runDrill(drillId, seed, maxSeconds = 90) {
  const S = loadSettings(null);
  const g = createGame({ spec: { kind: 'drill', drillId }, settings: S, input: 'autopilot', startTime: 10, seed });
  const gaze = createGaze();
  const frames = [];
  const contacts = [];
  g.world.bus.on('ball:hit', ({ shot }) => { if (shot.by === 'player' && !shot.provisional) contacts.push(shot.t); });
  const t0 = g.world.time;
  while (!g.isFinished() && g.world.time < t0 + maxSeconds) {
    g.advanceTo(g.world.time + FRAME);
    const r = gaze.update(g.world.ball, g.world.player.eye, FRAME, { basePitch: S.viewPitch * DEG });
    frames.push({ t: g.world.time, yaw: r.yaw, phase: r.phase });
  }
  return { frames, contacts, g };
}

describe('gaze follow', () => {
  for (const id of ['back-glass', 'double-wall']) {
    test(`${id}: |yaw| < 35° around every player contact, yaw rate <= 150°/s`, () => {
      const { frames, contacts } = runDrill(id, 5);
      assert.ok(contacts.length >= 8, `contacts ${contacts.length}`);
      for (const t of contacts) {
        const win = frames.filter((f) => f.t >= t - 0.1 && f.t <= t + 0.05);
        assert.ok(win.length > 0);
        const worst = Math.max(...win.map((f) => Math.abs(f.yaw)));
        assert.ok(worst < 35 * DEG, `yaw ${(worst / DEG).toFixed(1)}° around the contact at t=${t.toFixed(2)}`);
      }
      let maxRate = 0, maxYaw = 0, outFrames = 0;
      for (let i = 1; i < frames.length; i++) {
        maxRate = Math.max(maxRate, Math.abs(frames[i].yaw - frames[i - 1].yaw) / FRAME);
        maxYaw = Math.max(maxYaw, Math.abs(frames[i].yaw));
        if (frames[i].phase === 'out') outFrames++;
      }
      assert.ok(maxRate <= GAZE.MAX_YAW_RATE * 1.001, `max yaw rate ${(maxRate / DEG).toFixed(0)}°/s`);
      assert.ok(maxYaw <= GAZE.BACK_LIMIT + 1e-9, `max yaw ${(maxYaw / DEG).toFixed(0)}°`);
      // The head still turns toward the glass while the ball goes there (watching it come off).
      assert.ok(outFrames > 0 && maxYaw > 25 * DEG, `turned ${(maxYaw / DEG).toFixed(0)}° (${outFrames} frames behind)`);
    });
  }

  // Real-world session: "turning to the glass wasn't really fluid". Measured at Mac latency in the
  // glass drills (scratch harness, seeds 5 / 2): the old turn hit the 150°/s cap with jolts of
  // 5 000-10 000°/s²; 'turn' now stays <= ~125°/s and <= ~1 000°/s² (mostly ~550), the default
  // 'mirror' <= ~56°/s and <= ~420°/s² with |yaw| <= 25°.
  for (const [glassView, lim] of [['mirror', { yaw: 25, rate: 75, acc: 700 }], ['turn', { yaw: 75, rate: 140, acc: 1300 }]]) {
    test(`${glassView}: smooth yaw through the back-glass drill at Mac latency (|yaw| <= ${lim.yaw}°, rate < ${lim.rate}°/s, accel < ${lim.acc}°/s²), on target at contact`, () => {
      const S = loadSettings(null);
      const g = createGame({ spec: { kind: 'drill', drillId: 'back-glass' }, settings: S, input: 'autopilot', startTime: 10, seed: 5, apLatency: 0.11, apDelivery: 0.15 });
      const gaze = createGaze();
      const ys = [], ts = [], contacts = [];
      let rear = 0;
      g.world.bus.on('ball:hit', ({ shot }) => { if (shot.by === 'player' && !shot.provisional) contacts.push(shot.t); });
      const t0 = g.world.time;
      while (!g.isFinished() && g.world.time < t0 + 60) {
        g.advanceTo(g.world.time + FRAME);
        const w = g.world;
        const ic = w.mode && w.mode.tactics && w.mode.tactics.state.intercept;
        const b = viewBall(w);
        const r = gaze.update(b, w.player.eye, FRAME, { basePitch: S.viewPitch * DEG, contact: ic && b ? { ...ic.contact, t: ic.t } : null, glassView });
        ys.push(r.yaw);
        ts.push(w.time);
        if (r.rear) rear++;
      }
      let maxRate = 0, maxAcc = 0, maxYaw = 0, prevRate = null;
      for (let i = 1; i < ys.length; i++) {
        const rate = (ys[i] - ys[i - 1]) / FRAME;
        maxRate = Math.max(maxRate, Math.abs(rate));
        if (prevRate !== null) maxAcc = Math.max(maxAcc, Math.abs(rate - prevRate) / FRAME);
        prevRate = rate;
        maxYaw = Math.max(maxYaw, Math.abs(ys[i]));
      }
      assert.ok(contacts.length >= 6, `contacts ${contacts.length}`);
      assert.ok(maxYaw <= lim.yaw * DEG + 1e-9, `max yaw ${(maxYaw / DEG).toFixed(1)}°`);
      assert.ok(maxRate < lim.rate * DEG, `max yaw rate ${(maxRate / DEG).toFixed(0)}°/s`);
      assert.ok(maxAcc < lim.acc * DEG, `max yaw acceleration ${(maxAcc / DEG).toFixed(0)}°/s²`);
      for (const t of contacts) {
        for (let i = 0; i < ts.length; i++) if (ts[i] >= t - 0.1 && ts[i] <= t + 0.05) assert.ok(Math.abs(ys[i]) < 35 * DEG, `yaw ${(ys[i] / DEG).toFixed(0)}° at a contact`);
      }
      assert.ok(rear > 30, `rear cue frames ${rear}`);
      g.dispose();
    });
  }

  // Re-tuned (real-world session: "turning to the glass wasn't really fluid"): the 'turn' option
  // releases toward the contact as the ball reaches the glass instead of snapping back with a
  // 14/s spring at the 150°/s cap (that snap was the jolt). Was: back within ±30° in < 0.45 s.
  test("turn: a ball behind heading for the glass turns the head (<= 75°), then eases back without a snap", () => {
    const gaze = createGaze();
    const eye = { x: 2, y: 1.64, z: 8 };
    const ball = createBall(v3(2.6, 1.0, 8.6), v3(0, 0, 3));
    for (let i = 0; i < 120; i++) gaze.update(ball, eye, FRAME, { basePitch: -12 * DEG, glassView: 'turn' });
    assert.equal(gaze.phase, 'out');
    assert.ok(Math.abs(gaze.yaw) <= GLASS_VIEW.TURN_LIMIT + 1e-9 && Math.abs(gaze.yaw) > 60 * DEG, `yaw ${(gaze.yaw / DEG).toFixed(1)}`);
    // Off the glass, back toward the player: within the contact band in under a second, smoothly.
    ball.vel.set(0, 0, -5);
    let t = 0, prev = gaze.yaw, prevRate = 0, maxRate = 0, maxAcc = 0;
    while (Math.abs(gaze.yaw) > GAZE.CONTACT_LIMIT + 1e-6 && t < 2) {
      gaze.update(ball, eye, FRAME, { basePitch: -12 * DEG, glassView: 'turn' });
      const rate = (gaze.yaw - prev) / FRAME;
      maxRate = Math.max(maxRate, Math.abs(rate));
      if (t > 0) maxAcc = Math.max(maxAcc, Math.abs(rate - prevRate) / FRAME);
      prev = gaze.yaw;
      prevRate = rate;
      t += FRAME;
    }
    assert.equal(gaze.phase, 'return');
    assert.ok(t < 1.0, `back within ±30° after ${t.toFixed(2)} s`);
    assert.ok(maxRate < 130 * DEG, `max yaw rate ${(maxRate / DEG).toFixed(0)}°/s`);
    assert.ok(maxAcc < 900 * DEG, `max yaw acceleration ${(maxAcc / DEG).toFixed(0)}°/s²`);
  });

  test('mirror (default) and fixed: the view keeps facing the net (|yaw| <= 25°); the rear cue is up while the ball is behind', () => {
    for (const glassView of ['mirror', 'fixed']) {
      const gaze = createGaze();
      const eye = { x: 2, y: 1.64, z: 8 };
      const ball = createBall(v3(0.5, 1.2, 4), v3(1.2, 0.5, 9));
      let maxYaw = 0, rearSeen = false, rearWhileFront = false;
      for (let i = 0; i < 90; i++) {
        ball.pos.addScaled(ball.vel, FRAME);
        if (ball.pos.z > 9.9) ball.vel.z = -Math.abs(ball.vel.z) * 0.6;
        const r = gaze.update(ball, eye, FRAME, { basePitch: -12 * DEG, glassView });
        maxYaw = Math.max(maxYaw, Math.abs(r.yaw));
        if (r.rear) rearSeen = true;
        if (r.rear && ball.pos.z < eye.z - 0.5) rearWhileFront = true;
      }
      assert.ok(maxYaw <= GLASS_VIEW.CALM_LIMIT + 1e-9, `${glassView}: yaw ${(maxYaw / DEG).toFixed(1)}°`);
      assert.ok(rearSeen && !rearWhileFront, `${glassView}: rear cue`);
    }
  });

  test('non-finite ball / eye / contact never reach the springs (a NaN view stays NaN for good)', () => {
    const gaze = createGaze();
    const eye = { x: 2, y: 1.64, z: 8 };
    const bad = createBall(v3(NaN, 1, 4), v3(0, 0, 9));
    for (let i = 0; i < 30; i++) gaze.update(bad, eye, FRAME, { basePitch: -12 * DEG, contact: { x: Infinity, y: 1, z: 7, t: 1 } });
    gaze.update(createBall(v3(1, 1, 4), v3(0, 0, 9)), { x: NaN, y: 1, z: 8 }, FRAME, { basePitch: -12 * DEG });
    const r = gaze.update(createBall(v3(1, 1, 4), v3(0, 0, 9)), eye, FRAME, { basePitch: -12 * DEG });
    assert.ok(Number.isFinite(r.yaw) && Number.isFinite(r.pitch), `${r.yaw} ${r.pitch}`);
  });

  test('gaze off: the view stays straight ahead at the base pitch', () => {
    const gaze = createGaze();
    const ball = createBall(v3(-3, 1, 2), v3(0, 0, 10));
    for (let i = 0; i < 60; i++) gaze.update(ball, { x: 0, y: 1.6, z: 8 }, FRAME, { basePitch: -12 * DEG, follow: false });
    assert.ok(Math.abs(gaze.yaw) < 1e-9);
    assert.ok(Math.abs(gaze.pitch + 12 * DEG) < 1e-6);
  });
});
