// First-person gaze assist (src/render/gaze.js) against the real drill pipeline: autopilot ->
// synthetic camera -> tracking -> hits, viewed at 60 Hz exactly as the stage feeds the camera
// (world.ball + world.player.eye). The real player's body and arms face the TV, so the view must
// be close to straight ahead at every contact and must never whip round.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createGame } from '../src/app/game.js';
import { loadSettings } from '../src/app/settings.js';
import { createGaze, GAZE } from '../src/render/gaze.js';
import { createBall } from '../src/physics/ball.js';
import { v3 } from '../src/util/vec3.js';

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

  test('a ball behind heading for the glass turns the head at most to the back limit, then returns fast', () => {
    const gaze = createGaze();
    const eye = { x: 2, y: 1.64, z: 8 };
    const ball = createBall(v3(2.6, 1.0, 8.6), v3(0, 0, 6));
    for (let i = 0; i < 120; i++) gaze.update(ball, eye, FRAME, { basePitch: -12 * DEG });
    assert.equal(gaze.phase, 'out');
    assert.ok(Math.abs(gaze.yaw) <= GAZE.BACK_LIMIT + 1e-9 && Math.abs(gaze.yaw) > 60 * DEG, `yaw ${(gaze.yaw / DEG).toFixed(1)}`);
    // Off the glass, back toward the player: within the contact band in under half a second.
    ball.vel.set(0, 0, -5);
    let t = 0;
    while (Math.abs(gaze.yaw) > GAZE.CONTACT_LIMIT + 1e-6 && t < 2) {
      gaze.update(ball, eye, FRAME, { basePitch: -12 * DEG });
      t += FRAME;
    }
    assert.equal(gaze.phase, 'return');
    assert.ok(t < 0.45, `back within ±30° after ${t.toFixed(2)} s`);
  });

  test('gaze off: the view stays straight ahead at the base pitch', () => {
    const gaze = createGaze();
    const ball = createBall(v3(-3, 1, 2), v3(0, 0, 10));
    for (let i = 0; i < 60; i++) gaze.update(ball, { x: 0, y: 1.6, z: 8 }, FRAME, { basePitch: -12 * DEG, follow: false });
    assert.ok(Math.abs(gaze.yaw) < 1e-9);
    assert.ok(Math.abs(gaze.pitch + 12 * DEG) < 1e-6);
  });
});
