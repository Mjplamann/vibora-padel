import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { Vec3, v3 } from '../src/util/vec3.js';
import { DEG } from '../src/util/math.js';
import { PLAYER, TRACKING, COURT, RACKET } from '../src/config.js';
import {
  createBodyTracker, selectPerson, roomPosition, toUserFrame, computeHandFrame, focalNorm,
  JOINT_NAMES, GRIP_RADIAL_DEG,
} from '../src/tracking/body.js';
import {
  createSyntheticCamera, standingBody, poseArm, setHandTarget, cloneBody, crouchBody, liftBody, ARM,
} from '../src/tracking/synthetic.js';
import { createLocomotion, softDeadzone, defaultBounds, MAGNET_MAX_PULL } from '../src/tracking/locomotion.js';
import { createRacketTrack } from '../src/tracking/racketTrack.js';
import { classifyStroke, contactQuality, createSwingDetector } from '../src/tracking/swing.js';

const FPS = 30;
const DT_MS = 1000 / FPS;
const HFOV = TRACKING.cameraPresets['macbook-builtin'].hfov;

const angleDeg = (a, b) => {
  const d = (a.x * b.x + a.y * b.y + a.z * b.z) / (Math.hypot(a.x, a.y, a.z) * Math.hypot(b.x, b.y, b.z));
  return Math.acos(Math.max(-1, Math.min(1, d))) / DEG;
};
const near = (actual, expected, tol, msg = '') =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg} expected ${expected} ± ${tol}, got ${actual}`);
const relNear = (actual, expected, rel, msg = '') => near(actual, expected, Math.abs(expected) * rel, msg);

/** Feeds `n` frames of a (possibly changing) body; returns the last sample. */
function feed(tracker, cam, bodyOrFn, n, t0 = 0) {
  let s = null;
  for (let i = 0; i < n; i++) {
    const t = t0 + i * DT_MS;
    const b = typeof bodyOrFn === 'function' ? bodyOrFn(t / 1000, i) : bodyOrFn;
    s = tracker.update(cam.frame(t, Array.isArray(b) ? b : [b]));
  }
  return s;
}

/** Ground-truth HandFrame of a synthetic body, as body.js defines it. */
function trueHandFrame(body, side) {
  const j = body.joints;
  return computeHandFrame(side, j['wrist' + side], j['index' + side], j['pinky' + side], j['thumb' + side], j['elbow' + side]);
}

function maxJointError(sample, body) {
  let worst = 0, worstName = '';
  for (const name of JOINT_NAMES) {
    const e = sample.joints[name].distanceTo(body.joints[name]);
    if (e > worst) {
      worst = e;
      worstName = name;
    }
  }
  return { worst, worstName };
}

// Racket targets in U for a right-hander (mirror x for a left-hander).
const TARGETS = {
  forehand: { grip: v3(0.42, 1.0, 0.3), axis: v3(0.85, 0.15, 0.45), normal: v3(-0.2, 0, 1) },
  backhand: { grip: v3(-0.1, 1.05, 0.35), axis: v3(-0.85, 0.1, 0.4), normal: v3(0.2, 0, -1) },
  overhead: { grip: v3(0.25, 1.9, 0.2), axis: v3(0.05, 1, 0.25), normal: v3(0, -0.2, 1) },
  lowVolley: { grip: v3(0.3, 0.95, 0.28), axis: v3(0.6, 0.3, 0.6), normal: v3(-0.3, 0.3, 1) },
};
const mirror = (v) => v3(-v.x, v.y, v.z);

// ---------------------------------------------------------------------------

describe('hand frame conventions', () => {
  test('right hand, fingers up, palm toward the camera: palmDir = +z, racket tilts toward the thumb (-x)', () => {
    const wrist = v3(0.3, 1.2, 0.3);
    const index = v3(0.28, 1.29, 0.3); // thumb side is the midline (-x) for the right hand
    const pinky = v3(0.33, 1.28, 0.3);
    const thumb = v3(0.26, 1.24, 0.31);
    const elbow = v3(0.3, 0.93, 0.3);
    const hf = computeHandFrame('R', wrist, index, pinky, thumb, elbow);
    assert.ok(hf.normal.z > 0.99, `normal ${hf.normal.toArray()}`);
    assert.ok(hf.axis.x < -0.5 && hf.axis.y > 0.6, `axis ${hf.axis.toArray()}`);
    // The axis is the 80/20 blend of hand and forearm directions rotated GRIP_RADIAL_DEG toward the thumb.
    const base = v3().addVectors(index, pinky).scale(0.5).sub(wrist).normalize().scale(0.8)
      .addScaled(v3().subVectors(wrist, elbow).normalize(), 0.2).normalize();
    near(angleDeg(hf.axis, base), GRIP_RADIAL_DEG, 1e-6, 'radial tilt');
    assert.ok(hf.axis.x < base.x, 'rotated toward the thumb');
    near(hf.axis.dot(hf.normal), 0, 1e-12, 'orthogonal');
    const knuckleMid = v3().addVectors(index, pinky).scale(0.5);
    const grip = wrist.clone().lerp(knuckleMid, 0.8).addScaled(hf.normal, 0.015);
    assert.ok(hf.grip.distanceTo(grip) < 1e-3);
  });

  test('left hand mirror: palmDir = +z, racket tilts toward +x', () => {
    const wrist = v3(-0.3, 1.2, 0.3);
    const index = v3(-0.28, 1.29, 0.3);
    const pinky = v3(-0.33, 1.28, 0.3);
    const thumb = v3(-0.26, 1.24, 0.31);
    const hf = computeHandFrame('L', wrist, index, pinky, thumb, v3(-0.3, 0.93, 0.3));
    assert.ok(hf.normal.z > 0.99);
    assert.ok(hf.axis.x > 0.5 && hf.axis.y > 0.6);
  });

  test('missing thumb falls back to the handed default', () => {
    const wrist = v3(0, 1, 0), index = v3(-0.02, 1.09, 0), pinky = v3(0.03, 1.08, 0);
    const a = computeHandFrame('R', wrist, index, pinky, null, null);
    assert.ok(a.axis.x < 0);
  });
});

describe('synthetic -> body round trip', () => {
  const cam = createSyntheticCamera({ hfovDeg: HFOV });

  test('focal length and raw room position of a static, centred user are exact', () => {
    near(focalNorm(90), 0.5, 1e-12);
    const body = standingBody({ room: { x: 0.3, d: 2.6 } });
    const frame = cam.frame(0, [body]);
    const p = frame.people[0];
    const r = roomPosition(p.landmarks, p.world, HFOV, 1280 / 720, 1);
    near(r.d, 2.6, 0.01, 'd');
    near(r.x, 0.3, 0.01, 'x');
  });

  test('toUserFrame flips MediaPipe axes into U', () => {
    const world = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0 }));
    world[16] = { x: -0.5, y: -0.2, z: -0.3 }; // right wrist: image-left, above, closer to camera
    world[27] = { x: 0, y: 0.85, z: 0 };
    world[28] = { x: 0, y: 0.85, z: 0 };
    const j = toUserFrame(world, 1.1, 0.93);
    near(j.wristR.x, 0.55, 1e-12);
    near(j.wristR.y, 0.22 + 0.93, 1e-12);
    near(j.wristR.z, 0.33, 1e-12);
  });

  test('right-handed user at 2.6 m: room, joints, hand frame', () => {
    const tracker = createBodyTracker({ hfovDeg: HFOV });
    const body = standingBody({ room: { x: 0, d: 2.6 } });
    const s0 = feed(tracker, cam, body, 15);
    assert.equal(s0.calibration, undefined);
    assert.deepEqual(s0.offset, { x: 0, d: 0 });
    assert.equal(tracker.calibration.ok, false);
    tracker.calibrate(s0);
    assert.equal(tracker.calibration.ok, true);
    near(tracker.calibration.eyeHeight, PLAYER.eyeHeightRatio * 1.75, 0.01, 'eye height');

    const swing = cloneBody(body);
    const t = TARGETS.forehand;
    assert.ok(setHandTarget(swing, 'R', t.grip, t.axis, t.normal).reached);
    const s = feed(tracker, cam, swing, 30, 1000);
    assert.equal(s.valid, true);
    assert.equal(s.dominant, 'R');
    relNear(s.room.d, 2.6, 0.1, 'room.d');
    near(s.room.x, 0, 0.26, 'room.x'); // 10% of d
    near(s.room.d, 2.6, 0.03, 'room.d tight');
    const { worst, worstName } = maxJointError(s, swing);
    assert.ok(worst < 0.03, `joint ${worstName} off by ${worst}`);
    const hf = s.handFrames.R;
    assert.ok(hf.grip.distanceTo(t.grip) < 0.03, 'grip');
    assert.ok(angleDeg(hf.axis, t.axis) < 8, `axis off ${angleDeg(hf.axis, t.axis)}`);
    const nWant = t.normal.clone().projectOnPlane(t.axis.clone().normalize());
    assert.ok(angleDeg(hf.normal, nWant) < 8, `normal off ${angleDeg(hf.normal, nWant)}`);
    near(s.crouch, 0, 0.02);
    assert.equal(s.jump, false);
  });

  test('MediaPipe body-size bias (model 1.65 m, real 1.75 m) is removed by calibration scale', () => {
    const ms = 1.75 / 1.65;
    const tracker = createBodyTracker({ hfovDeg: HFOV, userHeight: 1.75 });
    const body = standingBody({ room: { x: 0.8, d: 3.2 }, modelScale: ms });
    tracker.calibrate(feed(tracker, cam, body, 15));
    relNear(tracker.calibration.scale, ms, 0.01, 'scale');
    relNear(tracker.calibration.d0, 3.2, 0.03, 'd0');
    near(tracker.calibration.x0, 0.8, 0.05, 'x0');

    const swing = cloneBody(body);
    const t = TARGETS.overhead;
    assert.ok(setHandTarget(swing, 'R', t.grip, t.axis, t.normal).reached);
    const s = feed(tracker, cam, swing, 30, 1000);
    relNear(s.room.d, 3.2, 0.1);
    near(s.room.x, 0.8, 0.32);
    const { worst, worstName } = maxJointError(s, swing);
    assert.ok(worst < 0.03, `joint ${worstName} off by ${worst}`);
    assert.ok(angleDeg(s.handFrames.R.axis, t.axis) < 8);
  });

  test('without the scale the same bias would put the user 6% too close (sanity of the model)', () => {
    const body = standingBody({ room: { x: 0, d: 3.0 }, modelScale: 1.75 / 1.65 });
    const p = cam.frame(0, [body]).people[0];
    const r = roomPosition(p.landmarks, p.world, HFOV, 16 / 9, 1);
    relNear(r.d, 3.0 * 1.65 / 1.75, 0.01);
  });

  test('left-handed user', () => {
    const tracker = createBodyTracker({ hfovDeg: HFOV, handed: 'left' });
    const body = standingBody({ room: { x: -0.4, d: 2.8 }, handed: 'left' });
    tracker.calibrate(feed(tracker, cam, body, 15));
    const swing = cloneBody(body);
    const t = TARGETS.forehand;
    const grip = mirror(t.grip), axis = mirror(t.axis), normal = mirror(t.normal);
    assert.ok(setHandTarget(swing, 'L', grip, axis, normal).reached);
    const s = feed(tracker, cam, swing, 30, 1000);
    assert.equal(s.dominant, 'L');
    relNear(s.room.d, 2.8, 0.1);
    near(s.room.x, -0.4, 0.28);
    const { worst } = maxJointError(s, swing);
    assert.ok(worst < 0.03);
    const hf = s.handFrames.L;
    assert.ok(hf.grip.distanceTo(grip) < 0.03);
    assert.ok(angleDeg(hf.axis, axis) < 8);
    assert.ok(angleDeg(hf.normal, normal.clone().projectOnPlane(axis.clone().normalize())) < 8);
  });

  for (const yaw of [30, -30]) {
    test(`user turned ${yaw} degrees, off-centre`, () => {
      const tracker = createBodyTracker({ hfovDeg: HFOV });
      const room = { x: 0.6, d: 2.4 };
      tracker.calibrate(feed(tracker, cam, standingBody({ room }), 15));
      const turned = standingBody({ room, yawDeg: yaw });
      const t = { grip: v3(0.38, 1.0, 0.28), axis: v3(0.85, 0.15, 0.45), normal: v3(-0.2, 0, 1) };
      assert.ok(setHandTarget(turned, 'R', t.grip, t.axis, t.normal).reached);
      const s = feed(tracker, cam, turned, 30, 1000);
      relNear(s.room.d, 2.4, 0.1, 'd');
      near(s.room.x, 0.6, 0.24, 'x');
      relNear(s.room.d, 2.4, 0.03, 'd tight');
      const { worst, worstName } = maxJointError(s, turned);
      assert.ok(worst < 0.03, `joint ${worstName} off by ${worst}`);
      assert.ok(angleDeg(s.handFrames.R.axis, t.axis) < 8);
      assert.ok(s.handFrames.R.grip.distanceTo(t.grip) < 0.03);
      // The shoulder line really is turned in U.
      const sh = v3().subVectors(s.joints.shoulderR, s.joints.shoulderL);
      near(Math.atan2(-sh.z, sh.x) / DEG, yaw, 1);
    });
  }

  test('every racket target round-trips for both hands (grip < 3 cm, axis/normal < 8 deg)', () => {
    for (const handed of ['right', 'left']) {
      const side = handed === 'right' ? 'R' : 'L';
      for (const [name, t0] of Object.entries(TARGETS)) {
        const t = handed === 'right' ? t0 : { grip: mirror(t0.grip), axis: mirror(t0.axis), normal: mirror(t0.normal) };
        const body = standingBody({ handed });
        const r = setHandTarget(body, side, t.grip, t.axis, t.normal);
        assert.ok(r.reached, `${handed} ${name} reachable`);
        assert.ok(r.error < 1e-6);
        const j = body.joints;
        relNear(j['shoulder' + side].distanceTo(j['elbow' + side]), ARM.upper, 1e-6, 'upper arm');
        relNear(j['elbow' + side].distanceTo(j['wrist' + side]), ARM.forearm, 1e-6, 'forearm');
        const tracker = createBodyTracker({ hfovDeg: HFOV, handed });
        const s = feed(tracker, cam, body, 10);
        const hf = s.handFrames[side];
        assert.ok(hf.grip.distanceTo(t.grip) < 0.03, `${handed} ${name} grip`);
        assert.ok(angleDeg(hf.axis, t.axis) < 8, `${handed} ${name} axis`);
        const nWant = t.normal.clone().projectOnPlane(t.axis.clone().normalize());
        assert.ok(angleDeg(hf.normal, nWant) < 8, `${handed} ${name} normal`);
      }
    }
  });

  test('out-of-reach targets are reported, not faked', () => {
    const body = standingBody();
    const r = setHandTarget(body, 'R', v3(1.5, 1.0, 0.8), v3(1, 0, 0), v3(0, 0, 1));
    assert.equal(r.reached, false);
    assert.ok(r.error > 0.5);
  });

  test('poseArm keeps segment lengths and gives a handshake palm at wristRot 0', () => {
    const body = standingBody();
    poseArm(body, 'R', { shoulderAngles: { flex: 0, abd: 0 }, elbowFlex: 90, wristRot: 0 });
    const j = body.joints;
    relNear(j.shoulderR.distanceTo(j.elbowR), ARM.upper, 1e-9);
    relNear(j.elbowR.distanceTo(j.wristR), ARM.forearm, 1e-9);
    const hf = trueHandFrame(body, 'R');
    // Forearm forward, palm facing the midline (-x), so the forehand face looks left.
    assert.ok(hf.normal.x < -0.9, `normal ${hf.normal.toArray()}`);
  });

  test('a 1.60 m user is scaled correctly and keeps proportions', () => {
    const tracker = createBodyTracker({ hfovDeg: HFOV, userHeight: 1.6 });
    const body = standingBody({ height: 1.6, room: { x: 0, d: 2.5 } });
    const s = feed(tracker, cam, body, 15);
    tracker.calibrate(s);
    near(tracker.calibration.scale, 1, 0.01);
    near(s.eyeHeight, 1.6 * PLAYER.eyeHeightRatio, 0.01);
    relNear(s.room.d, 2.5, 0.03);
  });

  test('noisy landmarks: room position stays within 10%', () => {
    const noisy = createSyntheticCamera({ hfovDeg: HFOV, noise: { imagePx: 2, worldM: 0.012, seed: 42 } });
    const tracker = createBodyTracker({ hfovDeg: HFOV });
    const body = standingBody({ room: { x: 0.5, d: 3.0 } });
    let worstD = 0, worstX = 0;
    for (let i = 0; i < 90; i++) {
      const s = tracker.update(noisy.frame(i * DT_MS, [body]));
      if (i < 15) continue;
      worstD = Math.max(worstD, Math.abs(s.room.d - 3.0));
      worstX = Math.max(worstX, Math.abs(s.room.x - 0.5));
    }
    assert.ok(worstD < 0.3, `d error ${worstD}`);
    assert.ok(worstX < 0.3, `x error ${worstX}`);
  });

  test('low-confidence frames are flagged invalid', () => {
    const tracker = createBodyTracker({ hfovDeg: HFOV });
    const body = standingBody();
    for (const n of ['shoulderL', 'shoulderR', 'elbowL', 'elbowR', 'wristL', 'wristR', 'hipL', 'hipR']) body.visibility[n] = 0.1;
    const s = feed(tracker, cam, body, 3);
    assert.equal(s.valid, false);
    assert.equal(tracker.update({ t: 500, width: 1280, height: 720, people: [] }), null);
  });

  test('feet out of frame: hip height holds its last value', () => {
    const tracker = createBodyTracker({ hfovDeg: HFOV });
    const body = standingBody({ room: { x: 0, d: 2.6 } });
    const s0 = feed(tracker, cam, body, 10);
    const hidden = cloneBody(body);
    for (const n of ['ankleL', 'ankleR', 'heelL', 'heelR', 'footL', 'footR']) hidden.visibility[n] = 0.05;
    const s1 = feed(tracker, cam, hidden, 10, 400);
    near(s1.hipHeight, s0.hipHeight, 0.005);
    relNear(s1.room.d, 2.6, 0.05);
  });
});

describe('room motion, crouch and jump', () => {
  const cam = createSyntheticCamera({ hfovDeg: HFOV });

  test('stepping back increases distance; stepping right gives +x', () => {
    const tracker = createBodyTracker({ hfovDeg: HFOV });
    const base = standingBody({ room: { x: 0, d: 2.6 } });
    tracker.calibrate(feed(tracker, cam, base, 20));
    // Step back 0.5 m and right 0.4 m over 0.5 s, then hold.
    let prevD = -Infinity;
    let monotonic = true;
    const s = feed(tracker, cam, (t) => {
      const b = cloneBody(base);
      const u = Math.min(1, t / 0.5);
      b.room = { x: 0.4 * u, d: 2.6 + 0.5 * u };
      return b;
    }, 60, 1000);
    // Check intermediate monotonicity on a second run.
    const tr2 = createBodyTracker({ hfovDeg: HFOV });
    tr2.calibrate(feed(tr2, cam, base, 20));
    for (let i = 0; i < 30; i++) {
      const b = cloneBody(base);
      b.room = { x: 0, d: 2.6 + 0.5 * Math.min(1, i / 15) };
      const si = tr2.update(cam.frame(1000 + i * DT_MS, [b]));
      if (si.room.d < prevD - 1e-9) monotonic = false;
      prevD = si.room.d;
    }
    assert.ok(monotonic, 'distance rises monotonically while stepping back');
    near(s.offset.d, 0.5, 0.05, 'offset.d');
    near(s.offset.x, 0.4, 0.05, 'offset.x');
  });

  test('crouch is detected and does not disturb the distance much', () => {
    const tracker = createBodyTracker({ hfovDeg: HFOV });
    const base = standingBody({ room: { x: 0, d: 2.6 } });
    tracker.calibrate(feed(tracker, cam, base, 20));
    const low = crouchBody(cloneBody(base), 0.25);
    const s = feed(tracker, cam, low, 30, 1000);
    const expected = 0.25 / (PLAYER.hipHeightRatio * 1.75);
    near(s.crouch, expected, 0.03, 'crouch');
    near(s.hipHeight, PLAYER.hipHeightRatio * 1.75 - 0.25, 0.02, 'hip height');
    near(s.eyeHeight, PLAYER.eyeHeightRatio * 1.75 - 0.25, 0.02, 'eye height follows');
    relNear(s.room.d, 2.6, 0.1, 'distance');
    assert.equal(s.jump, false);
    // Knees bent forward with the feet planted.
    assert.ok(s.joints.kneeR.z > 0.1);
    near(s.joints.ankleR.y, 0.08, 0.01);
  });

  test('a jump is detected from the image and lifts the joints', () => {
    const tracker = createBodyTracker({ hfovDeg: HFOV });
    const base = standingBody({ room: { x: 0, d: 2.8 } });
    tracker.calibrate(feed(tracker, cam, base, 30));
    const v0 = 2.4, g = 9.81, flight = (2 * v0) / g;
    let jumped = false, maxAir = 0, maxEye = 0;
    feed(tracker, cam, (t) => {
      const b = cloneBody(base);
      const tt = t - 1; // takeoff at t = 1 s
      if (tt > 0 && tt < flight) liftBody(b, v0 * tt - 0.5 * g * tt * tt);
      return b;
    }, 30, 0);
    for (let i = 30; i < 75; i++) {
      const t = i * DT_MS;
      const tt = t / 1000 - 1;
      const b = cloneBody(base);
      if (tt > 0 && tt < flight) liftBody(b, v0 * tt - 0.5 * g * tt * tt);
      const s = tracker.update(cam.frame(t, [b]));
      if (s.jump) jumped = true;
      maxAir = Math.max(maxAir, s.airborne);
      maxEye = Math.max(maxEye, s.eyeHeight);
    }
    assert.ok(jumped, 'jump flag');
    assert.ok(maxAir > 0.12, `airborne ${maxAir}`);
    assert.ok(maxEye > PLAYER.eyeHeightRatio * 1.75 + 0.1, 'view rises with the jump');
  });

  test('standing still never reports a jump', () => {
    const noisy = createSyntheticCamera({ hfovDeg: HFOV, noise: { imagePx: 1.5, worldM: 0.008, seed: 3 } });
    const tracker = createBodyTracker({ hfovDeg: HFOV });
    const body = standingBody({ room: { x: 0, d: 2.6 } });
    for (let i = 0; i < 120; i++) {
      const s = tracker.update(noisy.frame(i * DT_MS, [body]));
      assert.equal(s.jump, false);
      assert.ok(s.airborne < 0.03);
    }
  });

  test('wrist smoothing lags a 10 m/s swing by less than 35 ms at 30 fps', () => {
    const tracker = createBodyTracker({ hfovDeg: HFOV });
    const base = standingBody({ room: { x: 0, d: 2.6 } });
    const reach = ARM.upper + ARM.forearm;
    const vMax = 10, omega = vMax / reach, ramp = 0.1;
    // Straight arm sweeping horizontally (forehand-like), accelerating from rest over 0.1 s.
    const angleAt = (tt) => {
      if (tt <= 0) return 0;
      if (tt < ramp) return (0.5 * omega * tt * tt) / ramp;
      return 0.5 * omega * ramp + omega * (tt - ramp);
    };
    const bodyAt = (t) => {
      const b = cloneBody(base);
      const flex = -40 + angleAt(t - 0.6) / DEG;
      poseArm(b, 'R', { shoulderAngles: { flex, abd: 90 }, elbowFlex: 0, wristRot: 0 });
      return b;
    };
    let worstLag = 0, sumLag = 0, n = 0;
    for (let i = 0; i < 30; i++) {
      const t = i / FPS;
      const b = bodyAt(t);
      const s = tracker.update(cam.frame(t * 1000, [b]));
      const tt = t - 0.6;
      const speed = tt <= 0 ? 0 : tt < ramp ? (vMax * tt) / ramp : vMax;
      if (speed < 5 || tt > 0.35) continue;
      const lag = s.joints.wristR.distanceTo(b.joints.wristR) / speed;
      worstLag = Math.max(worstLag, lag);
      sumLag += lag;
      n++;
    }
    assert.ok(n >= 6);
    assert.ok(worstLag < 0.035, `worst lag ${(worstLag * 1000).toFixed(1)} ms`);
    assert.ok(sumLag / n < 0.02, `mean lag ${((sumLag / n) * 1000).toFixed(1)} ms`);
  });

  test('a still hand holds a steady racket under landmark noise (orientation filter)', () => {
    const measure = (filters) => {
      const noisy = createSyntheticCamera({ hfovDeg: HFOV, noise: { imagePx: 2, worldM: 0.005, seed: 11 } });
      const tracker = createBodyTracker({ hfovDeg: HFOV, filters });
      const body = standingBody({ room: { x: 0.3, d: 2.8 } });
      setHandTarget(body, 'R', v3(0.38, 1.0, 0.28), v3(0.85, 0.15, 0.45), v3(-0.2, 0, 1));
      const truth = trueHandFrame(body, 'R');
      let sum = 0, n = 0;
      for (let i = 0; i < 240; i++) {
        const s = tracker.update(noisy.frame(i * DT_MS, [body]));
        if (i < 30) continue;
        sum += angleDeg(s.handFrames.R.axis, truth.axis) + angleDeg(s.handFrames.R.normal, truth.normal);
        n += 2;
      }
      return sum / n;
    };
    const filtered = measure({});
    const unfiltered = measure({ handRot: [1e4, 0, 1e4, 0] });
    assert.ok(filtered < 5, `mean racket angle jitter ${filtered.toFixed(2)} deg (unfiltered ${unfiltered.toFixed(2)})`);
    assert.ok(filtered < unfiltered * 0.55, `filter roughly halves the jitter (${unfiltered.toFixed(1)} -> ${filtered.toFixed(1)})`);
  });

  test('racket orientation keeps up with a fast swing (21 rad/s) within 6 degrees', () => {
    const tracker = createBodyTracker({ hfovDeg: HFOV });
    const base = standingBody();
    const reach = ARM.upper + ARM.forearm, omega = 12 / reach, ramp = 0.12;
    const angleAt = (tt) => (tt <= 0 ? 0 : tt < ramp ? (0.5 * omega * tt * tt) / ramp : 0.5 * omega * ramp + omega * (tt - ramp));
    let worst = 0;
    for (let i = 0; i < 30; i++) {
      const t = i / FPS;
      const b = cloneBody(base);
      poseArm(b, 'R', { shoulderAngles: { flex: -50 + angleAt(t - 0.5) / DEG, abd: 90 }, elbowFlex: 0, wristRot: 40 });
      const s = tracker.update(cam.frame(t * 1000, [b]));
      const tt = t - 0.5;
      const w = tt <= 0 ? 0 : tt < ramp ? (omega * tt) / ramp : omega;
      if (w < omega / 2 || tt > 0.3) continue;
      const truth = trueHandFrame(b, 'R');
      worst = Math.max(worst, angleDeg(s.handFrames.R.axis, truth.axis), angleDeg(s.handFrames.R.normal, truth.normal));
    }
    assert.ok(worst < 6, `worst racket angle lag ${worst.toFixed(2)} deg`);
  });

  test('setOptions: changing the camera fov rescales distance, height rescales calibration', () => {
    const tracker = createBodyTracker({ hfovDeg: HFOV });
    const body = standingBody({ room: { x: 0, d: 2.6 } });
    tracker.calibrate(feed(tracker, cam, body, 10));
    const d0 = tracker.calibration.d0;
    tracker.setOptions({ hfovDeg: 78 });
    relNear(tracker.calibration.d0, (d0 * focalNorm(78)) / focalNorm(HFOV), 1e-9);
    tracker.setOptions({ userHeight: 1.85 });
    relNear(tracker.calibration.scale, 1.85 / 1.75, 1e-9);
    tracker.setOptions({ handed: 'left' });
    assert.equal(tracker.options.handed, 'left');
  });
});

describe('selectPerson', () => {
  const cam = createSyntheticCamera({ hfovDeg: HFOV });

  test('prefers the large, central body; then follows the previous one', () => {
    const near1 = standingBody({ room: { x: 0.1, d: 2.6 } });
    const far1 = standingBody({ room: { x: -1.2, d: 4.5 } });
    const frame = cam.frame(0, [far1, near1]);
    assert.equal(selectPerson(frame, null), 1);
    assert.equal(selectPerson({ people: [] }, null), -1);
    // Previous sample was the far person: keep following them.
    const tracker = createBodyTracker({ hfovDeg: HFOV });
    const sFar = tracker.update(cam.frame(0, [far1]));
    assert.equal(selectPerson(frame, sFar), 0);
  });

  test('the tracker follows the same person when someone walks into view', () => {
    const tracker = createBodyTracker({ hfovDeg: HFOV });
    const me = standingBody({ room: { x: -0.6, d: 3.4 } });
    feed(tracker, cam, me, 5);
    const intruder = standingBody({ room: { x: 0.2, d: 2.2 } });
    const s = feed(tracker, cam, [intruder, me], 5, 500);
    assert.equal(s.personIndex, 1);
    near(s.room.x, -0.6, 0.1);
  });
});

// ---------------------------------------------------------------------------

describe('locomotion', () => {
  const sample = (x, d) => ({ valid: true, offset: { x, d } });
  const { gainLateral: GL, gainDepth: GD, deadzone: DZ } = TRACKING;

  test('maps real steps to amplified court motion, toward the TV = toward the net', () => {
    const loco = createLocomotion();
    loco.setHome({ x: 2.3, z: 7.8 });
    let r = loco.update(sample(0.5, 0), 1 / 30, {});
    near(r.target.x, 2.3 + GL * (0.5 - DZ), 1e-9);
    near(r.target.z, 7.8, 1e-9);
    r = loco.update(sample(0, -0.5), 1 / 30, {});
    near(r.target.z, 7.8 - GD * (0.5 - DZ), 1e-9);
    assert.ok(r.target.z < 7.8, 'stepping toward the TV moves toward the net');
    r = loco.update(sample(-0.3, 0.3), 1 / 30, {});
    assert.ok(r.target.x < 2.3 && r.target.z > 7.8);
  });

  test('deadzone with a continuous, monotonic soft knee', () => {
    near(softDeadzone(0.01, 0.04), 0, 0);
    near(softDeadzone(-0.019, 0.04), 0, 0);
    near(softDeadzone(0.2, 0.04), 0.16, 1e-12);
    near(softDeadzone(-0.2, 0.04), -0.16, 1e-12);
    let prev = 0;
    for (let v = 0; v <= 0.2; v += 0.0005) {
      const y = softDeadzone(v, 0.04);
      assert.ok(y >= prev - 1e-12, 'monotonic');
      assert.ok(y - prev <= 0.0005 + 1e-9, 'slope <= 1 (no jumps)');
      prev = y;
    }
    // Both knee edges are continuous.
    near(softDeadzone(0.02 + 1e-9, 0.04), 0, 1e-9);
    near(softDeadzone(0.06 - 1e-9, 0.04), 0.02, 1e-8);
    const loco = createLocomotion();
    loco.setHome({ x: 1, z: 7 });
    const r = loco.update(sample(0.015, -0.015), 1 / 30, {});
    assert.deepEqual(r.target, { x: 1, z: 7 });
  });

  test('clamps to the near half inset by the body radius, never closer than the net keep-out', () => {
    const loco = createLocomotion();
    loco.setHome({ x: 0, z: 5 });
    let r = loco.update(sample(5, 5), 1 / 30, {});
    near(r.target.x, COURT.halfWidth - PLAYER.bodyRadius, 1e-12);
    near(r.target.z, COURT.halfLength - PLAYER.bodyRadius, 1e-12);
    r = loco.update(sample(-5, -5), 1 / 30, { bounds: { xMin: -4, xMax: 4, zMin: 0, zMax: 9 } });
    near(r.target.x, -4, 1e-12);
    near(r.target.z, PLAYER.netKeepOut, 1e-12);
    assert.deepEqual(defaultBounds(), { xMin: -4.7, xMax: 4.7, zMin: PLAYER.netKeepOut, zMax: 9.7 });
  });

  test('magnet pulls toward the ideal spot by min(dist, 1.2 m) * strength', () => {
    const loco = createLocomotion();
    loco.setHome({ x: 0, z: 7 });
    let r = loco.update(sample(0, 0), 1 / 30, { magnet: { x: 0.5, z: 7 }, magnetStrength: 0.5 });
    near(r.target.x, 0.25, 1e-12);
    r = loco.update(sample(0, 0), 1 / 30, { magnet: { x: 0, z: 3 }, magnetStrength: 0.35 });
    near(r.target.z, 7 - MAGNET_MAX_PULL * 0.35, 1e-12);
    r = loco.update(sample(0, 0), 1 / 30, { magnet: { x: 3, z: 7 }, magnetStrength: 1 });
    near(r.target.x, 1.2, 1e-12);
    r = loco.update(sample(0, 0), 1 / 30, { magnet: null, magnetStrength: 1 });
    near(r.target.x, 0, 1e-12);
  });

  test('no sample (or an invalid one) keeps the last target; setHome re-anchors', () => {
    const loco = createLocomotion({ gainLateral: 2, gainDepth: 2, deadzone: 0 });
    loco.setHome({ x: 0, z: 6 });
    const r1 = loco.update(sample(0.5, 0.5), 1 / 30, {});
    assert.deepEqual(r1.target, { x: 1, z: 7 });
    assert.deepEqual(loco.update(null, 1 / 30, {}).target, { x: 1, z: 7 });
    assert.deepEqual(loco.update({ valid: false, offset: { x: 3, d: 3 } }, 1 / 30, {}).target, { x: 1, z: 7 });
    loco.setHome({ x: -2, z: 8 });
    assert.deepEqual(loco.target, { x: -2, z: 8 });
  });
});

// ---------------------------------------------------------------------------

describe('racket track', () => {
  // Sweet spot on a horizontal circle (radius R about c), racket pointing outward,
  // forehand face looking along the motion. Analytic pose, velocity and spin.
  const R = 1.0, OMEGA = 20; // 20 m/s at the sweet spot
  const C = v3(0.5, 1.0, 7.0);
  const poseAt = (t) => {
    const a = OMEGA * t;
    const radial = v3(Math.cos(a), 0, -Math.sin(a)); // rotating about +y (counter-clockwise from above)
    const tangent = v3(-Math.sin(a), 0, -Math.cos(a));
    const sweet = C.clone().addScaled(radial, R);
    return {
      grip: sweet.clone().addScaled(radial, -RACKET.sweetSpotY),
      axis: radial,
      normal: tangent,
      sweet,
      vel: tangent.clone().scale(OMEGA * R),
    };
  };

  function run(fps, n = 12) {
    const track = createRacketTrack({});
    for (let i = 0; i < n; i++) {
      const t = i / fps;
      track.push(t, poseAt(t));
    }
    return track;
  }

  for (const [fps, velTol, posTol] of [[60, 0.01, 0.002], [30, 0.02, 0.006]]) {
    test(`circular swing at ${fps} fps: settled velocity within ${velTol * 100}%`, () => {
      const track = run(fps);
      for (let i = 2; i < track.length - 2; i++) {
        const p = track.get(i);
        const truth = poseAt(p.t);
        const err = p.vel.distanceTo(truth.vel) / truth.vel.length();
        assert.ok(err < velTol, `pose ${i} vel err ${err}`);
        assert.ok(p.angVel.distanceTo(v3(0, OMEGA, 0)) < 0.01 * OMEGA, `angVel ${p.angVel.toArray()}`);
      }
      // The newest (provisional) velocity is still in the right ballpark.
      const lastP = track.latest();
      assert.ok(lastP.vel.distanceTo(poseAt(lastP.t).vel) / (OMEGA * R) < 0.2);
    });

    test(`circular swing at ${fps} fps: sub-frame sampling (Hermite) is accurate`, () => {
      const track = run(fps);
      const out = {
        grip: new Vec3(), axis: new Vec3(), normal: new Vec3(), vel: new Vec3(), angVel: new Vec3(), sweet: new Vec3(), t: 0,
      };
      const t0 = 2 / fps, t1 = (track.length - 3) / fps;
      for (let t = t0; t <= t1; t += 1 / (fps * 7)) {
        const truth = poseAt(t);
        const s = track.sample(t, out);
        assert.equal(s, out, 'fills the out object');
        assert.ok(s.sweet.distanceTo(truth.sweet) < posTol, `sweet err ${s.sweet.distanceTo(truth.sweet)} at ${t}`);
        assert.ok(s.grip.distanceTo(truth.grip) < posTol * 2, 'grip');
        assert.ok(s.vel.distanceTo(truth.vel) / (OMEGA * R) < velTol * 2.5, `vel err at ${t}`);
        assert.ok(angleDeg(s.axis, truth.axis) < 1, 'axis');
        assert.ok(angleDeg(s.normal, truth.normal) < 1, 'normal');
        near(s.axis.dot(s.normal), 0, 1e-9, 'orthonormal');
      }
    });
  }

  test('linear motion is reproduced exactly; sampling clamps at the ends', () => {
    const track = createRacketTrack({ capacity: 16 });
    const v = v3(3, -1, -12);
    for (let i = 0; i < 6; i++) {
      const t = 10 + i / 30;
      track.push(t, { grip: v3(1, 1, 7).addScaled(v, i / 30), axis: v3(0, 1, 0), normal: v3(0, 0, -1) });
    }
    for (let i = 0; i < 6; i++) assert.ok(track.get(i).vel.distanceTo(v) < 1e-6);
    const mid = track.sample(10 + 2.5 / 30);
    const want = v3(1, 1 + RACKET.sweetSpotY, 7).addScaled(v, 2.5 / 30);
    assert.ok(mid.sweet.distanceTo(want) < 1e-9);
    assert.ok(mid.vel.distanceTo(v) < 1e-6);
    assert.equal(track.sample(0).t, 10);
    assert.equal(track.sample(99).t, track.latest().t);
    assert.equal(createRacketTrack({}).sample(0), null);
  });

  test('ordering, replacement, gaps and capacity', () => {
    const track = createRacketTrack({ capacity: 5 });
    const P = (x) => ({ grip: v3(x, 1, 7), axis: v3(0, 1, 0), normal: v3(0, 0, -1) });
    assert.equal(track.push(1.0, P(0)), true);
    assert.equal(track.push(1.1, P(1)), true);
    assert.equal(track.push(1.05, P(9)), false, 'out of order is dropped');
    assert.equal(track.push(1.1, P(2)), true, 'same time replaces');
    assert.equal(track.length, 2);
    near(track.latest().grip.x, 2, 1e-12);
    // Gap: a pose 1 s later has no velocity across the gap.
    track.push(2.1, P(50));
    assert.equal(track.latest().vel.length(), 0);
    near(track.get(1).vel.x, 20, 1e-9, 'pose before the gap keeps its own backward difference');
    for (let i = 1; i <= 5; i++) track.push(2.1 + i * 0.1, P(50 + i));
    assert.equal(track.length, 5);
    near(track.get(0).t, 2.2, 1e-12);
  });

  test('segmentsSince and peakSpeed', () => {
    const track = run(60, 12);
    const segs = track.segmentsSince(5 / 60 + 1e-6);
    assert.equal(segs.length, 6);
    for (const [a, b] of segs) {
      assert.ok(b.t > 5 / 60);
      near(b.t - a.t, 1 / 60, 1e-9);
    }
    assert.equal(track.segmentsSince(-1).length, 11);
    assert.equal(track.segmentsSince(100).length, 0);
    near(track.peakSpeed(2 / 60, 9 / 60), OMEGA * R, 0.2);
    assert.equal(track.peakSpeed(50, 60), 0);
    assert.ok(track.settledTime() < track.latest().t);
  });
});

// ---------------------------------------------------------------------------

describe('stroke classification', () => {
  const base = { handed: 'right', ballBounced: true, ballAfterWall: false, playerZ: 8, isServe: false };
  const C = (o) => classifyStroke({ ...base, ...o });

  test('groundstrokes: forehand / backhand by side, by face, and mirrored for lefties', () => {
    assert.equal(C({ contactU: v3(0.7, 1.0, 0.5), racketVelU: v3(-3, 2, 15) }), 'forehand');
    assert.equal(C({ contactU: v3(-0.6, 1.0, 0.5), racketVelU: v3(3, 2, 14) }), 'backhand');
    assert.equal(C({ contactU: v3(-0.6, 1.0, 0.5), racketVelU: v3(3, 2, 14), handed: 'left' }), 'forehand');
    // The face used decides when it's available (palm-side face toward the net = forehand).
    assert.equal(C({ contactU: v3(0.05, 1.0, 0.5), racketVelU: v3(0, 1, 12), racketNormalU: v3(0, 0, -1) }), 'backhand');
    assert.equal(C({ contactU: v3(0.05, 1.0, 0.5), racketVelU: v3(0, 1, 12), racketNormalU: v3(0, 0, 1) }), 'forehand');
    // Ball in the middle, no face: the swing direction decides.
    assert.equal(C({ contactU: v3(0.0, 1.0, 0.5), racketVelU: v3(-4, 0, 12) }), 'forehand');
    assert.equal(C({ contactU: v3(0.0, 1.0, 0.5), racketVelU: v3(4, 0, 12) }), 'backhand');
  });

  test('volleys before the bounce, glass shots after a wall', () => {
    assert.equal(C({ contactU: v3(0.5, 1.2, 0.6), racketVelU: v3(0, 0, 6), ballBounced: false, playerZ: 3 }), 'volley-fh');
    assert.equal(C({ contactU: v3(-0.5, 1.2, 0.6), racketVelU: v3(0, 0, 6), ballBounced: false, playerZ: 3 }), 'volley-bh');
    assert.equal(C({ contactU: v3(0.6, 0.9, 0.2), racketVelU: v3(-2, 3, 13), ballAfterWall: true }), 'glass-fh');
    assert.equal(C({ contactU: v3(-0.6, 0.9, 0.2), racketVelU: v3(2, 3, 13), ballAfterWall: true }), 'glass-bh');
  });

  test('overheads: smash, víbora, bandeja', () => {
    // Flat, fast, steeply downward.
    assert.equal(C({ contactU: v3(0.3, 2.4, 0.4), racketVelU: v3(-2, -9, 17), ballBounced: false, playerZ: 4 }), 'smash');
    // Fast but not downward enough is not a smash.
    assert.notEqual(C({ contactU: v3(0.3, 2.4, 0.4), racketVelU: v3(0, -2, 19), ballBounced: false, playerZ: 4 }), 'smash');
    // Víbora: cut across the ball (right-hander: toward -x) with pace, face open.
    assert.equal(C({
      contactU: v3(0.4, 2.1, 0.3), racketVelU: v3(-9, -3, 9), racketNormalU: v3(-0.3, 0.2, 0.9), ballBounced: false, playerZ: 5,
    }), 'vibora');
    // Left-hander's víbora cuts toward +x.
    assert.equal(C({ contactU: v3(-0.4, 2.1, 0.3), racketVelU: v3(9, -3, 9), handed: 'left', ballBounced: false }), 'vibora');
    // Same cut with the face rolled over (closed) is not a víbora.
    assert.equal(C({
      contactU: v3(0.4, 2.1, 0.3), racketVelU: v3(-9, -3, 9), racketNormalU: v3(0, -0.8, 0.6), ballBounced: false,
    }), 'bandeja');
    // Bandeja: controlled, mostly forward, moderate pace.
    assert.equal(C({ contactU: v3(0.4, 2.0, 0.3), racketVelU: v3(-2, -2, 10), ballBounced: false, playerZ: 5 }), 'bandeja');
    // Overhead threshold scales with the player's height.
    assert.equal(C({ contactU: v3(0.4, 1.65, 0.3), racketVelU: v3(-2, -2, 10), ballBounced: false, height: 1.6 }), 'bandeja');
    assert.equal(C({ contactU: v3(0.4, 1.65, 0.3), racketVelU: v3(0, -2, 10), ballBounced: false }), 'volley-fh');
  });

  test('lob, chiquita, serve', () => {
    assert.equal(C({ contactU: v3(0.6, 0.8, 0.4), racketVelU: v3(0, 9, 8) }), 'lob');
    assert.equal(C({ contactU: v3(0.6, 0.6, 0.4), racketVelU: v3(-1, 1, 6) }), 'chiquita');
    // Soft and low but at the net: not a chiquita.
    assert.equal(C({ contactU: v3(0.6, 0.6, 0.4), racketVelU: v3(-1, 1, 6), playerZ: 1.5 }), 'forehand');
    // Soft but high: a normal forehand.
    assert.equal(C({ contactU: v3(0.6, 1.1, 0.4), racketVelU: v3(-1, 1, 6) }), 'forehand');
    assert.equal(C({ contactU: v3(0.6, 0.8, 0.4), racketVelU: v3(0, 2, 12), isServe: true }), 'serve');
  });
});

describe('contact quality', () => {
  test('ideal forehand contact scores high', () => {
    const q = contactQuality({ contactU: v3(0.7, 1.0, 0.5), handed: 'right', stroke: 'forehand' });
    assert.equal(q.timing, 'good');
    assert.equal(q.spacing, 'good');
    near(q.front, 0.5, 1e-12);
    near(q.side, 0.7, 1e-12);
    near(q.height, 1.0, 1e-12);
    near(q.score, 1, 1e-12);
  });

  test('late, early, cramped, stretched', () => {
    const late = contactQuality({ contactU: v3(0.7, 1.0, -0.1), stroke: 'forehand' });
    assert.equal(late.timing, 'late');
    assert.ok(late.score < 0.6);
    assert.equal(contactQuality({ contactU: v3(0.7, 1.0, 1.1), stroke: 'forehand' }).timing, 'early');
    assert.equal(contactQuality({ contactU: v3(0.25, 1.0, 0.5), stroke: 'forehand' }).spacing, 'cramped');
    assert.equal(contactQuality({ contactU: v3(1.2, 1.0, 0.5), stroke: 'forehand' }).spacing, 'stretched');
    const low = contactQuality({ contactU: v3(0.7, 0.3, 0.5), stroke: 'forehand' });
    assert.ok(low.score < 0.5, 'too low');
  });

  test('backhands are judged on the non-dominant side; lefties mirror', () => {
    const bh = contactQuality({ contactU: v3(-0.7, 1.0, 0.5), handed: 'right', stroke: 'backhand' });
    near(bh.side, -0.7, 1e-12);
    assert.equal(bh.spacing, 'good');
    near(bh.score, 1, 1e-12);
    const lefty = contactQuality({ contactU: v3(-0.7, 1.0, 0.5), handed: 'left', stroke: 'forehand' });
    near(lefty.side, 0.7, 1e-12);
    near(lefty.score, 1, 1e-12);
  });

  test('overheads want height, serves want contact at or below the waist', () => {
    near(contactQuality({ contactU: v3(0.3, 2.3, 0.3), stroke: 'smash' }).score, 1, 1e-12);
    const lowOverhead = contactQuality({ contactU: v3(0.3, 1.75, 0.3), stroke: 'bandeja' }).score;
    assert.ok(lowOverhead < 0.65, `waiting for the ball to drop costs: ${lowOverhead}`);
    assert.ok(contactQuality({ contactU: v3(0.3, 1.5, 0.3), stroke: 'bandeja' }).score < 0.25);
    near(contactQuality({ contactU: v3(0.6, 0.8, 0.4), stroke: 'serve' }).score, 1, 1e-12);
    assert.ok(contactQuality({ contactU: v3(0.6, 1.3, 0.4), stroke: 'serve' }).score < 0.4);
  });
});

describe('swing detector', () => {
  test('finds start, peak and prep time of a swing', () => {
    const events = [];
    const det = createSwingDetector({ threshold: 5, onSwing: (e) => events.push(e) });
    // Rest, backswing pause at t=1.0, forward swing peaking at 22 m/s at t=1.2, follow-through.
    const speedAt = (t) => {
      if (t < 1.0) return 0.5 + 0.3 * Math.sin(t * 10);
      if (t < 1.4) return 22 * Math.exp(-(((t - 1.2) / 0.07) ** 2));
      return 0.5;
    };
    let returned = null;
    for (let i = 0; i <= 60; i++) {
      const t = i / 30;
      const e = det.push(t, speedAt(t));
      if (e) returned = e;
    }
    assert.equal(events.length, 1);
    assert.equal(returned, events[0]);
    const e = events[0];
    near(e.tPeak, 1.2, 0.01, 'tPeak (sub-frame)');
    assert.ok(e.peakSpeed > 20);
    assert.ok(e.tStart <= 1.1 && e.tStart >= 0.95, `tStart ${e.tStart}`);
    near(e.prepTime, e.tPeak - e.tStart, 1e-12);
  });

  test('slow movement is not a swing; two swings give two events', () => {
    const det = createSwingDetector({});
    for (let i = 0; i < 60; i++) assert.equal(det.push(i / 30, 3 + Math.sin(i)), null);
    const speeds = [0, 4, 9, 14, 9, 2, 0, 0, 6, 12, 18, 7, 1];
    const out = [];
    speeds.forEach((s, i) => {
      const e = det.push(3 + i / 30, s);
      if (e) out.push(e);
    });
    assert.equal(out.length, 2);
    near(out[0].peakSpeed, 14, 1e-12);
    near(out[1].peakSpeed, 18, 1e-12);
  });
});
