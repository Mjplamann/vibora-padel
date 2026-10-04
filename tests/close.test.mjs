// Close mode (round 4): tracking from the upper body at 1.3–2.2 m (tracking/body.js CLOSE), the
// MediaPipe-like cropped synthetic frames, the pitched-camera fit, the calibration checks
// (ui/calibrate.js) and hitting with the human autopilot through a close-range feed.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { PLAYER } from '../src/config.js';
import { createRng, DEG } from '../src/util/math.js';
import {
  createBodyTracker, estimateDistanceUpper, legsUsable, upperUsable, upperGeometry, CLOSE, DISTANCE_RANGES,
} from '../src/tracking/body.js';
import { createSyntheticCamera, standingBody, cloneBody, crouchBody, liftBody, turnBody } from '../src/tracking/synthetic.js';
import { closeRangeBoost, createLocomotion } from '../src/tracking/locomotion.js';
import { createFrameWatch, bodyVisibility } from '../src/app/tracking.js';
import { bodyCheck, spotCheck, areaReadout, CAL_RANGES } from '../src/ui/calibrate.js';

const HFOV = 68;
const DT = 1000 / 30;
const NOISE = { imagePx: 2, worldM: 0.012 };
const HIP = PLAYER.hipHeightRatio * 1.75;

const cropCam = (o = {}) => createSyntheticCamera({ hfovDeg: HFOV, cameraHeight: 1.25, crop: { seed: 3 }, ...o });

function run(tracker, cam, bodyAt, n, t0 = 0, each = null) {
  let s = null;
  for (let i = 0; i < n; i++) {
    const t = t0 + i * DT;
    s = tracker.update(cam.frame(t, [bodyAt(t / 1000, i)]));
    if (each) each(s, t / 1000, i);
  }
  return s;
}

describe('cropped frames (MediaPipe-like)', () => {
  test('legs beyond the frame are guessed: low visibility, a straight standing pose, positions outside the picture', () => {
    const cam = cropCam();
    const body = crouchBody(standingBody({ room: { x: 0, d: 1.6 } }), 0.2);
    const p = cam.frame(0, [body]).people[0];
    for (const i of [25, 26, 27, 28]) {
      assert.ok(p.landmarks[i].y > 1, `landmark ${i} beyond the bottom edge`);
      assert.ok(p.landmarks[i].visibility <= 0.6, `landmark ${i} visibility ${p.landmarks[i].visibility}`);
    }
    // The guessed knee is straight below the hip although the real one is bent forward.
    const w = p.world;
    assert.ok(Math.abs(w[25].z - w[23].z) < 0.05, 'guessed knee not bent');
    assert.equal(legsUsable(p.landmarks), false);
    assert.equal(upperUsable(p.landmarks), true);
  });
});

describe('close mode: upper-body estimation', () => {
  for (const d of [1.3, 1.6, 1.9, 2.2]) {
    test(`room x / d within 10% at ${d} m with only the upper body in view (webcam noise)`, () => {
      const cam = cropCam({ noise: { ...NOISE, seed: Math.round(d * 10) } });
      const tracker = createBodyTracker({ hfovDeg: HFOV });
      for (const x of [0, 0.35, -0.35]) {
        let worstD = 0, worstX = 0, s = null;
        const body = standingBody({ room: { x, d } });
        tracker.reset();
        run(tracker, cam, () => body, 45, 0, (si, t, i) => {
          s = si;
          if (i < 12) return;
          worstD = Math.max(worstD, Math.abs(si.room.d - d) / d);
          worstX = Math.max(worstX, Math.abs(si.room.x - x));
        });
        assert.equal(s.trackMode, 'upper');
        assert.equal(s.legsVisible, false);
        assert.ok(s.valid, 'valid sample');
        assert.ok(worstD < 0.1, `d error ${(worstD * 100).toFixed(1)}%`);
        assert.ok(worstX < 0.1 * d, `x error ${worstX.toFixed(3)} m`);
        assert.ok(Math.abs(s.hipHeight - HIP) < 0.04, `hip height ${s.hipHeight}`);
        assert.ok(s.joints.ankleR.y < 0.12 && s.joints.ankleL.y < 0.12, 'plausible legs on the floor');
      }
    });
  }

  test('turned 60° (foreshortened shoulders): distance still within 10%', () => {
    const cam = cropCam({ noise: { ...NOISE, seed: 9 } });
    const tracker = createBodyTracker({ hfovDeg: HFOV });
    const body = standingBody({ room: { x: 0.2, d: 1.7 }, yawDeg: 60 });
    const s = run(tracker, cam, () => body, 45);
    assert.ok(Math.abs(s.room.d - 1.7) / 1.7 < 0.1, `d ${s.room.d}`);
  });

  test('estimateDistanceUpper never divides by a few pixels (a face-on segment shrunk to a point is skipped)', () => {
    const cam = cropCam();
    const p = cam.frame(0, [standingBody({ room: { x: 0, d: 1.6 } })]).people[0];
    const lm = p.landmarks.map((l) => ({ ...l }));
    // Collapse the shoulders onto one point: their ratio must not be used.
    lm[12] = { ...lm[11] };
    const d = estimateDistanceUpper(lm, p.world, HFOV, 16 / 9, 1);
    assert.ok(d > 1.4 && d < 1.8, `d ${d}`);
  });

  test('steps in close mode map to offsets (deadzone-free) within 10%', () => {
    const cam = cropCam({ noise: { ...NOISE, seed: 21 } });
    const tracker = createBodyTracker({ hfovDeg: HFOV });
    const base = standingBody({ room: { x: 0, d: 1.75 } });
    run(tracker, cam, () => base, 30);
    assert.ok(tracker.calibrate());
    assert.equal(tracker.calibration.mode, 'upper');
    const s = run(tracker, cam, (t) => {
      const u = Math.min(1, t / 0.6);
      return standingBody({ room: { x: 0.4 * u, d: 1.75 - 0.3 * u } });
    }, 50, 1000);
    assert.ok(Math.abs(s.offset.x - 0.4) < 0.05, `offset x ${s.offset.x}`);
    assert.ok(Math.abs(s.offset.d + 0.3) < 0.05, `offset d ${s.offset.d}`);
  });

  test('crouch and jump come from the head and shoulders; standing still is neither', () => {
    const cam = cropCam({ noise: { ...NOISE, seed: 5 } });
    const tracker = createBodyTracker({ hfovDeg: HFOV });
    const base = standingBody({ room: { x: 0.2, d: 1.8 } });
    run(tracker, cam, () => base, 30);
    tracker.calibrate();
    let s = run(tracker, cam, () => crouchBody(cloneBody(base), 0.25), 30, 1000);
    assert.equal(s.trackMode, 'upper');
    assert.ok(Math.abs(s.crouch - 0.25 / HIP) < 0.04, `crouch ${s.crouch}`);
    assert.ok(Math.abs(s.eyeHeight - (PLAYER.eyeHeightRatio * 1.75 - 0.25)) < 0.04, `eye ${s.eyeHeight}`);
    assert.ok(s.joints.kneeR.z > 0.1, 'knees bend forward');
    run(tracker, cam, () => base, 30, 2000);
    const v0 = 2.4, g = 9.81, flight = (2 * v0) / g;
    let jumped = false, maxEye = 0;
    run(tracker, cam, (t) => {
      const b = cloneBody(base);
      const tt = t - 3.2;
      if (tt > 0 && tt < flight) liftBody(b, v0 * tt - 0.5 * g * tt * tt);
      return b;
    }, 40, 3000, (si) => { jumped ||= si.jump; maxEye = Math.max(maxEye, si.eyeHeight); });
    assert.ok(jumped, 'jump flag');
    assert.ok(maxEye > PLAYER.eyeHeightRatio * 1.75 + 0.15, `eye rises ${maxEye}`);
    let falseJumps = 0, maxAir = 0;
    run(tracker, cam, () => base, 120, 6000, (si) => { if (si.jump) falseJumps++; maxAir = Math.max(maxAir, si.airborne); });
    assert.equal(falseJumps, 0);
    assert.ok(maxAir < 0.03, `airborne at rest ${maxAir}`);
  });
});

describe('close mode: switching between full body and upper body', () => {
  test('walking from 2.9 m to 1.5 m and back: one switch each way, no jumps in position or height', () => {
    const cam = createSyntheticCamera({ hfovDeg: HFOV, cameraHeight: 1.0, crop: { seed: 4 } });
    const tracker = createBodyTracker({ hfovDeg: HFOV });
    run(tracker, cam, () => standingBody({ room: { x: 0, d: 2.9 } }), 30);
    tracker.calibrate();
    let prev = null, worstStep = 0, worstHip = 0, worstD = 0;
    const s = run(tracker, cam, (t) => {
      const ph = (t - 1) / 10;
      return standingBody({ room: { x: 0.3 * Math.sin(2 * Math.PI * ph), d: 2.9 - 1.4 * Math.sin(Math.PI * ph) } });
    }, 300, 1000, (si, t) => {
      const ph = (t - 1) / 10;
      const td = 2.9 - 1.4 * Math.sin(Math.PI * ph), tx = 0.3 * Math.sin(2 * Math.PI * ph);
      if (prev) {
        const truth = Math.hypot(td - prev.td, tx - prev.tx);
        worstStep = Math.max(worstStep, Math.hypot(si.room.d - prev.d, si.room.x - prev.x) - truth);
        worstHip = Math.max(worstHip, Math.abs(si.hipHeight - prev.h));
      }
      worstD = Math.max(worstD, Math.abs(si.room.d - td) / td);
      prev = { d: si.room.d, x: si.room.x, h: si.hipHeight, td, tx };
    });
    const st = tracker.stats;
    assert.equal(st.modeSwitches, 2, `switches ${st.modeSwitches}`);
    assert.ok(st.upperFrames > 100, 'upper mode used while close');
    assert.equal(s.trackMode, 'full');
    assert.ok(worstStep < 0.02, `excess step ${worstStep}`);
    assert.ok(worstHip < 0.015, `hip step ${worstHip}`);
    assert.ok(worstD < 0.05, `d error ${worstD}`);
  });

  test('legs flickering at the frame edge do not flip the mode (hysteresis)', () => {
    const cam = createSyntheticCamera({ hfovDeg: HFOV, cameraHeight: 1.0, crop: { seed: 6 } });
    const tracker = createBodyTracker({ hfovDeg: HFOV });
    const near = standingBody({ room: { x: 0, d: 2.0 } });
    const far = standingBody({ room: { x: 0, d: 2.6 } });
    run(tracker, cam, () => far, 20);
    // Ankles in and out of view every other frame (alternating 2.0 / 2.6 is not physical; use visibility).
    run(tracker, cam, (t, i) => {
      const b = cloneBody(far);
      if (i % 3 === 0) for (const n of ['ankleL', 'ankleR']) b.visibility[n] = 0.1;
      return b;
    }, 60, 1000);
    assert.equal(tracker.stats.modeSwitches, 0, 'brief drop-outs keep full mode');
    run(tracker, cam, () => near, 20, 3000);
    assert.equal(tracker.mode, 'upper');
  });
});

describe('close mode: pitched camera (MacBook lid tilted back)', () => {
  test('the pitch is learned from the standing envelope and removes the phantom crouch of stepping', () => {
    const cam = createSyntheticCamera({ hfovDeg: HFOV, cameraHeight: 1.0, pitchDeg: 15, crop: { seed: 3 }, noise: { ...NOISE, seed: 5 } });
    const tracker = createBodyTracker({ hfovDeg: HFOV });
    run(tracker, cam, () => standingBody({ room: { x: 0, d: 1.8 } }), 30);
    tracker.calibrate();
    let worstHip = 0, worstD = 0;
    run(tracker, cam, (t) => standingBody({ room: { x: 0, d: 1.8 + 0.4 * Math.sin(t * 0.9) } }), 1200, 1000, (s, t) => {
      if (t < 25) return;
      const d = 1.8 + 0.4 * Math.sin(t * 0.9);
      worstHip = Math.max(worstHip, Math.abs(s.hipHeight - HIP));
      worstD = Math.max(worstD, Math.abs(s.room.d - d) / d);
    });
    const tl = tracker.tilt;
    assert.ok(Math.abs(tl.deg - 15) < 4, `tilt ${tl.deg}`);
    assert.ok(worstHip < 0.06, `hip error ${worstHip}`);
    assert.ok(worstD < 0.1, `d error ${worstD}`);
  });

  test('a level camera keeps a zero pitch', () => {
    const cam = cropCam({ noise: { ...NOISE, seed: 8 } });
    const tracker = createBodyTracker({ hfovDeg: HFOV });
    run(tracker, cam, (t) => standingBody({ room: { x: 0, d: 1.8 + 0.4 * Math.sin(t * 0.9) } }), 900);
    assert.ok(Math.abs(tracker.tilt.deg) < 1, `tilt ${tracker.tilt.deg}`);
  });

  test('upperGeometry: level camera gives the plain pinhole geometry', () => {
    const cam = cropCam();
    const p = cam.frame(0, [standingBody({ room: { x: 0.3, d: 1.7 } })]).people[0];
    const g = upperGeometry(p.landmarks, p.world, 1.7, HFOV, 16 / 9, 1, 0);
    assert.ok(Math.abs(g.d - 1.7) < 0.01 && Math.abs(g.x - 0.3) < 0.01);
    assert.ok(Math.abs(g.camRel - (HIP - 1.25)) < 0.01, `camRel ${g.camRel}`);
  });
});

describe('close mode: movement, frame watch and calibration', () => {
  test('a close calibration boosts the gains for the smaller play area; full body keeps them', () => {
    assert.deepEqual(closeRangeBoost(2.8), { lateral: 1, depth: 1 });
    const b = closeRangeBoost(1.7);
    assert.ok(b.lateral > 1.3 && b.lateral < 1.45, `boost ${b.lateral}`);
    const loco = createLocomotion({ gainLateral: 2.6, gainDepth: 2.2, deadzone: 0 });
    loco.setHome({ x: 0, z: 8 });
    loco.setBoost(b);
    const r = loco.update({ valid: true, offset: { x: 0.5, d: 0 } }, 0, {});
    assert.ok(Math.abs(r.target.x - 0.5 * 2.6 * b.lateral) < 1e-9);
  });

  test('frame watch in close mode asks for head and shoulders only', () => {
    const cam = cropCam();
    const watch = createFrameWatch({ upperBody: true });
    let w = null;
    for (let i = 0; i < 60; i++) w = watch.update(cam.frame(i * DT, [standingBody({ room: { x: 0, d: 1.5 } })]));
    assert.equal(w, null, 'no feet warning');
    // Too close to a low camera: head cut at the top.
    const low = createSyntheticCamera({ hfovDeg: HFOV, cameraHeight: 1.0, crop: { seed: 3 } });
    for (let i = 0; i < 30; i++) w = watch.update(low.frame(3000 + i * DT, [standingBody({ room: { x: 0, d: 1.35 } })]));
    assert.ok(w && w.kind === 'head', JSON.stringify(w));
    const v = bodyVisibility(cam.frame(0, [standingBody({ room: { x: 0, d: 1.6 } })]));
    assert.equal(v.mode, 'upper');
  });

  test('calibration body check accepts the upper body with a mode-aware ideal distance', () => {
    const vis = { head: true, shoulders: true, hips: false, knees: false, ankles: false };
    const c = bodyCheck({ visible: vis, bodyInFrame: 0.4, distance: 1.7 });
    assert.equal(c.mode, 'upper');
    assert.deepEqual(c.range, CAL_RANGES.upper);
    assert.deepEqual([...CAL_RANGES.upper], [...DISTANCE_RANGES.upper]);
    assert.ok(c.ok, c.msg);
    assert.ok(!bodyCheck({ visible: vis, bodyInFrame: 0.4, distance: 1.1 }).ok, 'too close');
    assert.match(bodyCheck({ visible: { ...vis, head: false }, bodyInFrame: 0.2, distance: 1.4 }).msg, /chest height/);
    const full = bodyCheck({ visible: { head: true, shoulders: true, hips: true, knees: true, ankles: true }, bodyInFrame: 1, distance: 2.8 });
    assert.equal(full.mode, 'full');
    assert.ok(full.ok);
    assert.ok(!bodyCheck({ visible: { head: true, shoulders: true, hips: true, knees: true, ankles: true }, bodyInFrame: 1, distance: 1.7 }).ok, 'full body at 1.7 m is too close for full mode');
    assert.ok(spotCheck({ visible: vis, bodyInFrame: 0.4, distance: 1.7, still: true }).ok);
    const a = areaReadout({ x: 0.2, d: -0.1 }, { gainLateral: 2.6, gainDepth: 2.2 }, { lateral: 1.5, depth: 1.5 });
    assert.equal(a.courtX, '+0.8 m');
  });
});

describe('close mode: hitting with the human autopilot (real pipeline)', () => {
  test('forehand drill from 1.7 m with only the upper body in view: hit rate comparable to full body', async () => {
    const { createTestGame } = await import('./helpers/closeGame.mjs');
    const { loadSettings } = await import('../src/app/settings.js');
    const rate = (close) => {
      let reps = 0, hits = 0, upper = 0, frames = 0;
      for (const seed of [1, 2]) {
        const S = loadSettings(null);
        const g = createTestGame({ spec: { kind: 'drill', drillId: 'fh-drive' }, settings: S, seed, close, apNoise: 1 });
        while (!g.isFinished() && g.world.time < 400) g.advanceTo(g.world.time + 0.1);
        for (const r of g.mode.state.results) { if (r.void) continue; reps++; if (r.shot) hits++; }
        const st = g.human.bodyTracker.stats;
        upper += st.upperFrames;
        frames += st.frames;
        if (close) assert.equal(g.human.bodyTracker.calibration.mode, 'upper');
      }
      return { rate: hits / reps, upperShare: upper / frames };
    };
    const full = rate(false), close = rate(true);
    assert.ok(close.upperShare > 0.95, `close mode tracked from the upper body (${close.upperShare})`);
    assert.ok(close.rate >= 0.85, `close-mode hit rate ${close.rate}`);
    assert.ok(close.rate >= full.rate - 0.08, `close ${close.rate} vs full ${full.rate}`);
  });
});

void createRng; void DEG; void turnBody; void CLOSE;
