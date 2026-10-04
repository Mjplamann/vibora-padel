// Round 5 (QA r5 fixes): the racket ghost at the planned contact and the swing nod of the gaze
// (the racket was off-screen for the ~100 ms before contact), capped automatic replays, and the
// pieces added by the final fix pass (see each describe block).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { loadSettings } from '../src/app/settings.js';
import { RACKET } from '../src/config.js';
import { createGaze, GAZE } from '../src/render/gaze.js';
import { contactGhostPose, createGhostPose, GHOST } from '../src/game/swingAssist.js';
import { createTestGame } from './helpers/closeGame.mjs';

const DEG = Math.PI / 180;
const FRAME = 1 / 60;

/** NDC of point p seen from cam with the gaze's yaw (Y) / pitch (X), YXZ like fpCamera. */
function project(p, cam, yaw, pitch, vfov, asp = 16 / 9) {
  const x = p.x - cam.x, y = p.y - cam.y, z = p.z - cam.z;
  const cy = Math.cos(-yaw), sy = Math.sin(-yaw);
  const x1 = x * cy + z * sy, z1 = -x * sy + z * cy;
  const cp = Math.cos(-pitch), sp = Math.sin(-pitch);
  const y2 = y * cp - z1 * sp, z2 = y * sp + z1 * cp;
  const depth = -z2;
  if (depth < 0.03) return null;
  const t = Math.tan(vfov / 2);
  return { x: x1 / depth / (t * asp), y: y2 / depth / t };
}

describe('racket in view before contact (QA r5)', () => {
  test('forehand drive, human autopilot at Mac latency: the racket is on screen in the last 50 ms for most strikes, the ghost marks the contact', () => {
    const S = loadSettings(null);
    const frames = [];
    const strikes = [];
    const ghosts = [];
    const tip = RACKET.length + RACKET.buttY;
    // Two seeds (~30 strikes): one 16-strike run swings by ±1 strike around the threshold.
    for (const seed of [2, 3]) {
    const g = createTestGame({ spec: { kind: 'drill', drillId: 'fh-drive' }, settings: S, seed });
    const w = g.world;
    const gaze = createGaze();
    const ghost = createGhostPose();
    const t0 = frames.length ? frames[frames.length - 1].t + 1000 : 0; // keeps the runs apart on one time line
    w.bus.on('ball:hit', ({ shot }) => { if (shot.by === 'player' && shot.provisional) strikes.push({ t: t0 + w.time, c: { ...shot.contact } }); });
    while (w.time < 10 + 90 && !g.isFinished()) {
      g.advanceTo(w.time + FRAME);
      const e = w.player.eye;
      const cam = { x: e.x, y: e.y - S.eyeOffset.down, z: e.z + S.eyeOffset.back };
      const ic = w.mode.tactics && w.mode.tactics.state.intercept;
      const r0 = gaze.update(w.ball, cam, FRAME, { basePitch: S.viewPitch * DEG, contact: ic && w.ball && !w.ball.atRest ? { ...ic.contact, t: ic.t } : null, glassView: 'mirror' });
      const r = w.player.renderRacket || w.player.racket;
      const pts = r ? [RACKET.faceCenterY, tip].map((k) => ({ x: r.grip.x + r.axis.x * k, y: r.grip.y + r.axis.y * k, z: r.grip.z + r.axis.z * k })) : [];
      frames.push({ t: t0 + w.time, cam, yaw: r0.yaw, pitch: r0.pitch, pts });
      const gp = contactGhostPose(w, ghost);
      if (gp) ghosts.push({ t: w.time, tStar: w.timing.plan.tStar, pStar: { ...w.timing.plan.pStar }, sweet: { ...gp.sweet }, axis: { ...gp.axis }, normal: { ...gp.normal }, alpha: gp.alpha });
    }
    }
    assert.ok(strikes.length >= 20, `${strikes.length} strikes`);
    let vis50 = 0;
    for (const s of strikes) {
      const f = frames.filter((q) => q.t <= s.t - 0.05 + 1e-6).pop();
      if (f && f.pts.some((p) => { const q = project(p, f.cam, f.yaw, f.pitch, S.fov * DEG); return q && Math.abs(q.x) < 1 && Math.abs(q.y) < 1; })) vis50++;
    }
    // Before the swing nod: 14% (QA strip: "neither racket nor hand on screen from -146 to -63 ms").
    assert.ok(vis50 >= strikes.length * 0.4, `racket on screen 50 ms before the strike: ${vis50}/${strikes.length}`);
    // The ghost: up to GHOST.lead s before t*, the face on the ball (sweet spot one ball radius off p*), an orthonormal frame.
    assert.ok(ghosts.length > 20, `${ghosts.length} ghost frames`);
    for (const q of ghosts) {
      assert.ok(q.tStar - q.t <= GHOST.lead + 1e-6 && q.t - q.tStar <= GHOST.after + 1e-6);
      const d = Math.hypot(q.sweet.x - q.pStar.x, q.sweet.y - q.pStar.y, q.sweet.z - q.pStar.z);
      assert.ok(Math.abs(d - (0.0325 + RACKET.thickness / 2)) < 1e-6, `sweet spot ${d.toFixed(3)} m from the contact`);
      const dot = q.axis.x * q.normal.x + q.axis.y * q.normal.y + q.axis.z * q.normal.z;
      assert.ok(Math.abs(dot) < 1e-6 && Math.abs(Math.hypot(q.axis.x, q.axis.y, q.axis.z) - 1) < 1e-6);
      // The face looks at the far court.
      assert.ok(q.normal.z < -0.3, `face normal z ${q.normal.z.toFixed(2)}`);
      assert.ok(q.alpha >= 0 && q.alpha <= GHOST.alpha + 1e-9);
    }
  });

  test('swing nod: only for contacts below the shoulders; nothing for an overhead', () => {
    const eye = { x: 0, y: 1.64, z: 8 };
    const run = (cy) => {
      const gz = createGaze();
      gz.reset(-14 * DEG);
      let p = 0;
      for (let i = 0; i <= 57; i++) { // to 0.05 s before the contact
        const tNow = i / 60;
        const ball = { pos: { x: 0.4, y: cy + 0.5, z: 8 - 6 + tNow * 6 }, vel: { x: 0, y: 0, z: 6 }, t: tNow };
        const r = gz.update(ball, eye, 1 / 60, { basePitch: -14 * DEG, contact: { x: 0.5, y: cy, z: 7.4, t: 1.0 }, glassView: 'mirror' });
        p = r.pitch;
      }
      return p;
    };
    const low = run(0.9);
    const high = run(2.3);
    const e = Math.atan2(0.9 - 1.64, Math.hypot(0.5, 0.6));
    assert.ok(low < e + GAZE.CONTACT_DROP - 8 * DEG, `low contact: pitch ${(low / DEG).toFixed(1)}° vs framing ${((e + GAZE.CONTACT_DROP) / DEG).toFixed(1)}°`);
    assert.ok(high <= GAZE.OVERHEAD_PITCH_MAX + 1e-6 && high > 10 * DEG, `overhead: ${(high / DEG).toFixed(1)}°`);
  });
});

describe('camera tilt learned in calibration (QA r5: a tilted MacBook lid was never learned)', () => {
  test('MacBook-like: 1.5 m, camera 0.95 m pitched 10° up: the play-area steps give the pitch and the camera height', async () => {
    const { createBodyTracker } = await import('../src/tracking/body.js');
    const { createSyntheticCamera, standingBody } = await import('../src/tracking/synthetic.js');
    const cam = createSyntheticCamera({ hfovDeg: 68, cameraHeight: 0.95, pitchDeg: 10, crop: { seed: 3 }, noise: { imagePx: 2, worldM: 0.012, seed: 4 } });
    const tracker = createBodyTracker({ hfovDeg: 68 });
    tracker.setCalibrating(true);
    let t = 0;
    const DTms = 1000 / 30;
    const at = (d, secs) => {
      for (let i = 0; i < secs * 30; i++, t += DTms) tracker.update(cam.frame(t, [standingBody({ room: { x: 0, d } })]));
    };
    const walk = (d0, d1, secs) => {
      const n = Math.round(secs * 30);
      for (let i = 1; i <= n; i++, t += DTms) tracker.update(cam.frame(t, [standingBody({ room: { x: 0, d: d0 + ((d1 - d0) * i) / n } })]));
    };
    at(1.5, 2.5); // in frame + stand on your spot
    assert.ok(tracker.calibrate());
    // Play area (close mode: 0.2 m steps): forward, back, home.
    walk(1.5, 1.28, 0.5); at(1.28, 0.8); walk(1.28, 1.72, 0.9); at(1.72, 0.8); walk(1.72, 1.5, 0.5); at(1.5, 0.5);
    tracker.setCalibrating(false);
    const tl = tracker.tilt;
    assert.ok(Math.abs(tl.deg - 10) < 2.5, `tilt ${tl.deg.toFixed(1)}° (truth 10°)`);
    assert.ok(Math.abs(tracker.calibration.camHeight - 0.95) < 0.08, `camera height ${tracker.calibration.camHeight.toFixed(2)} m (truth 0.95)`);
    // It holds through play at one depth (no new span).
    at(1.5, 20);
    assert.ok(Math.abs(tracker.tilt.deg - 10) < 2.5, `after play ${tracker.tilt.deg.toFixed(1)}°`);
  });

  test('a level camera stays level through the same calibration; a manual tilt is locked', async () => {
    const { createBodyTracker } = await import('../src/tracking/body.js');
    const { createSyntheticCamera, standingBody } = await import('../src/tracking/synthetic.js');
    const cam = createSyntheticCamera({ hfovDeg: 68, cameraHeight: 1.25, crop: { seed: 3 }, noise: { imagePx: 2, worldM: 0.012, seed: 9 } });
    const tracker = createBodyTracker({ hfovDeg: 68 });
    tracker.setCalibrating(true);
    let t = 0;
    const DTms = 1000 / 30;
    const at = (d, secs) => { for (let i = 0; i < secs * 30; i++, t += DTms) tracker.update(cam.frame(t, [standingBody({ room: { x: 0, d } })])); };
    at(1.7, 2.5);
    tracker.calibrate();
    at(1.5, 0.8); at(1.9, 0.8); at(1.7, 0.5);
    tracker.setCalibrating(false);
    assert.ok(Math.abs(tracker.tilt.deg) < 2.5, `level camera ${tracker.tilt.deg.toFixed(1)}°`);
    assert.ok(Math.abs(tracker.calibration.camHeight - 1.25) < 0.06, `camera height ${tracker.calibration.camHeight.toFixed(2)}`);
    tracker.setTilt(8, { lock: true });
    at(1.4, 1); at(2.0, 1);
    assert.equal(tracker.tilt.deg.toFixed(3), '8.000');
    assert.equal(tracker.tilt.locked, true);
    tracker.setTilt(null);
    assert.equal(tracker.tilt.locked, false);
  });
});

describe('close mode: arm landmarks beyond the frame (QA r5)', () => {
  test('synthetic armOut: a real detector clamps the image position and guesses the world position', async () => {
    const { createSyntheticCamera, standingBody, setHandTarget } = await import('../src/tracking/synthetic.js');
    const { Vec3 } = await import('../src/util/vec3.js');
    const body = standingBody({ room: { x: 0, d: 1.7 } });
    const cam = createSyntheticCamera({ hfovDeg: 68, cameraHeight: 1.25, crop: { seed: 3 }, armOut: { mode: 'clamp' } });
    const truth = createSyntheticCamera({ hfovDeg: 68, cameraHeight: 1.25, crop: { seed: 3 } });
    cam.frame(0, [body]); // the arm in the picture: remembered
    setHandTarget(body, 'R', new Vec3(0.3, 2.25, 0.1), new Vec3(0, 1, 0), new Vec3(0, 0, 1)); // hand far above the frame
    const p = cam.frame(33, [body]).people[0];
    const q = truth.frame(33, [body]).people[0];
    assert.ok(q.landmarks[16].y < 0, 'the true wrist is above the picture');
    assert.ok(p.landmarks[16].y >= 0 && p.landmarks[16].visibility <= 0.3);
    const dw = Math.hypot(p.world[16].x - q.world[16].x, p.world[16].y - q.world[16].y, p.world[16].z - q.world[16].z);
    assert.ok(dw > 0.3, `clamp mode keeps the stale world position (${dw.toFixed(2)} m from the truth)`);
    assert.ok(cam.stats.armOut > 0);
  });

  test('overhead drills from 1.7 m with clamped out-of-frame arms: the rebuilt arm keeps the hit rate (bandeja / smash >= 88%)', async () => {
    const { createTestGame } = await import('./helpers/closeGame.mjs');
    for (const drillId of ['bandeja', 'smash-x3']) {
      let reps = 0, hits = 0, rebuilt = 0;
      for (const seed of [1, 2]) {
        const S = loadSettings(null);
        const g = createTestGame({ spec: { kind: 'drill', drillId }, settings: S, seed, close: true, apNoise: 1, closeOpts: { armOut: { mode: 'clamp' } } });
        while (!g.isFinished() && g.world.time < 10 + 180) g.advanceTo(g.world.time + 0.1);
        for (const r of g.mode.state.results) { if (r.void) continue; reps++; if (r.shot) hits++; }
        rebuilt += g.human.bodyTracker.stats.armRebuilt;
      }
      // Before the rebuild (QA r5): bandeja 80.0%, smash 77-83% with clamped wrists.
      assert.ok(rebuilt > 50, `${drillId}: arm rebuilt in ${rebuilt} frames`);
      assert.ok(hits / reps >= 0.88, `${drillId}: ${hits}/${reps}`);
    }
  });

  test('frame watch: hands leaving the top of the picture twice give a hint, then it rests', async () => {
    const { createFrameWatch, HANDS_TOP } = await import('../src/app/tracking.js');
    const fw = createFrameWatch({ upperBody: true, handsTop: true });
    const lm = (wy) => Array.from({ length: 33 }, (_, i) => ({ x: 0.5, y: i === 16 ? wy : i >= 23 ? 1.3 : 0.4, z: 0, visibility: i >= 23 ? 0.1 : 0.99 }));
    const fr = (t, wy) => ({ t, people: [{ landmarks: lm(wy), world: lm(0) }] });
    let w = null, t = 0;
    for (let ep = 0; ep < 2; ep++) {
      for (let i = 0; i < 6; i++) w = fw.update(fr((t += 33), 0));
      for (let i = 0; i < 10; i++) w = fw.update(fr((t += 33), 0.4));
    }
    assert.ok(w && w.kind === 'hands-top', JSON.stringify(w));
    for (let i = 0; i < (HANDS_TOP.show + 1) * 30; i++) w = fw.update(fr((t += 33), 0.4));
    assert.equal(w, null);
  });
});

describe('workout recap (QA r5: about two swings per shot)', () => {
  test('a forehand drill counts about one swing per stroke, with a believable top speed', async () => {
    const { createGame } = await import('../src/app/game.js');
    const S = loadSettings(null);
    const g = createGame({ spec: { kind: 'drill', drillId: 'fh-drive' }, settings: S, input: 'autopilot', startTime: 10, seed: 3, apLatency: 0.11, apDelivery: 0.15, apProfile: 'human', apJitter: 0.02, apNoise: 1 });
    while (!g.isFinished() && g.world.time < 10 + 150) g.advanceTo(g.world.time + 0.1);
    const ses = g.session.summary();
    const shots = g.stats.playerHits;
    assert.ok(shots >= 10, `${shots} shots`);
    assert.ok(ses.swings >= shots * 0.8 && ses.swings <= shots * 1.4, `${ses.swings} swings for ${shots} shots`);
    assert.ok(ses.peakSwingKmh > 25 && ses.peakSwingKmh < 120, `top swing ${ses.peakSwingKmh} km/h`);
  });
});

describe('Glass Breaker aim (QA r5: the score was mostly luck)', () => {
  test('targets start big and shrink with the combo; the first lit target is flagged as the aim', async () => {
    const { glassTargetRadius, GLASS_TARGET, createChallengeMode } = await import('../src/game/challenges.js');
    assert.equal(glassTargetRadius(0), GLASS_TARGET.startRadius);
    assert.equal(glassTargetRadius(GLASS_TARGET.shrinkAt), GLASS_TARGET.radius);
    assert.equal(glassTargetRadius(40), GLASS_TARGET.radius);
    assert.ok(glassTargetRadius(4) < GLASS_TARGET.startRadius && glassTargetRadius(4) > GLASS_TARGET.radius);
    const S = loadSettings(null);
    const g = createTestGame({ spec: { kind: 'drill', drillId: 'fh-drive' }, settings: S, seed: 3 });
    const sets = [];
    g.world.bus.on('challenge:targets', (p) => sets.push(p.targets));
    const mode = createChallengeMode('glass-breaker', { startDelay: 0.5 });
    g.world.mode = mode;
    mode.start(g.world);
    assert.equal(sets.length, 1);
    assert.deepEqual(sets[0].map((t) => t.aim), [true, false, false]);
    for (const t of sets[0]) {
      assert.equal(t.r, GLASS_TARGET.startRadius);
      assert.ok(t.y - t.r > -0.05, 'the ring stays above the floor');
    }
    assert.equal(mode.apHints && mode.apHints.aim ? Math.round(mode.apHints.aim.x * 10) : null, Math.round(Math.max(-4.2, Math.min(4.2, sets[0][0].x)) * 10), 'an on-time drive aims at the bright target');
    g.advanceTo(g.world.time + 1.5);
    assert.match(mode.hud(g.world).prompt || '', /aim/i, 'the opening prompt names the aim');
    g.advanceTo(g.world.time + 8);
    assert.ok(!/aim/i.test(mode.hud(g.world).prompt || ''), 'then it goes away');
  });
});
