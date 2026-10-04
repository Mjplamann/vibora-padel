// Synthetic MediaPipe frames: the exact inverse of body.js, used by tests, the
// autopilot and attract mode. Pure module.
//
// A SyntheticBody holds its joints in the user frame U (origin on the floor under
// the hip center, +x user's right, +y up, +z toward the camera) and its room
// position {x, d} (x = user's right of the camera axis, d = camera -> hip distance).
// The camera is a pinhole at `cameraHeight`, looking horizontally, unmirrored.

import { Vec3 } from '../util/vec3.js';
import { clamp, DEG, createRng } from '../util/math.js';
import { PLAYER } from '../config.js';
import {
  ANKLE_HEIGHT, NOSE_HEIGHT_RATIO, GRIP_RADIAL_DEG, GRIP_ALONG, GRIP_PALM_OFFSET, FOREARM_BLEND,
  focalNorm, rotateAbout,
} from './body.js';

/** All 33 BlazePose landmarks in index order ("L" = the person's left). */
export const LANDMARK_NAMES = Object.freeze([
  'nose', 'eyeInnerL', 'eyeL', 'eyeOuterL', 'eyeInnerR', 'eyeR', 'eyeOuterR', 'earL', 'earR', 'mouthL', 'mouthR',
  'shoulderL', 'shoulderR', 'elbowL', 'elbowR', 'wristL', 'wristR', 'pinkyL', 'pinkyR', 'indexL', 'indexR',
  'thumbL', 'thumbR', 'hipL', 'hipR', 'kneeL', 'kneeR', 'ankleL', 'ankleR', 'heelL', 'heelR', 'footL', 'footR',
]);

/** Segment lengths for a 1.75 m person (scaled linearly with height). */
export const ARM = Object.freeze({ upper: 0.3, forearm: 0.27, hand: 0.09 });
const REF_HEIGHT = 1.75;

// Hand landmark layout around the wrist -> knuckle line (1.75 m person).
const KNUCKLE_HALF_SPREAD = 0.022; // index / pinky either side of the knuckle midpoint
const KNUCKLE_DISTAL = 0.006; // index sits slightly more distal than pinky
const THUMB = { along: 0.045, side: 0.035, palm: 0.015 };

const sideSign = (side) => (side === 'R' ? 1 : -1);
const bodyK = (body) => body.height / REF_HEIGHT;

// ---------------------------------------------------------------------------
// Bodies

/**
 * A relaxed standing body in a ready position (elbows bent, forearms forward).
 * @returns SyntheticBody = { height, handed, room: {x, d}, yawDeg, modelScale, joints: {name: Vec3}, visibility: {} }
 */
export function standingBody({ height = PLAYER.defaultHeight, room = { x: 0, d: 2.6 }, handed = 'right', yawDeg = 0, modelScale = 1 } = {}) {
  const k = height / REF_HEIGHT;
  const H = height;
  const P = (x, y, z) => new Vec3(x * k, y, z * k);
  const j = {
    nose: P(0, NOSE_HEIGHT_RATIO * H, 0.1),
    eyeInnerL: P(-0.016, 0.937 * H, 0.082), eyeL: P(-0.032, PLAYER.eyeHeightRatio * H, 0.077), eyeOuterL: P(-0.047, 0.936 * H, 0.066),
    eyeInnerR: P(0.016, 0.937 * H, 0.082), eyeR: P(0.032, PLAYER.eyeHeightRatio * H, 0.077), eyeOuterR: P(0.047, 0.936 * H, 0.066),
    earL: P(-0.075, 0.925 * H, -0.005), earR: P(0.075, 0.925 * H, -0.005),
    mouthL: P(-0.024, 0.893 * H, 0.086), mouthR: P(0.024, 0.893 * H, 0.086),
    shoulderL: P(-0.18, PLAYER.shoulderHeightRatio * H, 0), shoulderR: P(0.18, PLAYER.shoulderHeightRatio * H, 0),
    elbowL: new Vec3(), elbowR: new Vec3(), wristL: new Vec3(), wristR: new Vec3(),
    pinkyL: new Vec3(), pinkyR: new Vec3(), indexL: new Vec3(), indexR: new Vec3(), thumbL: new Vec3(), thumbR: new Vec3(),
    hipL: P(-0.09, PLAYER.hipHeightRatio * H, 0), hipR: P(0.09, PLAYER.hipHeightRatio * H, 0),
    kneeL: P(-0.1, 0.285 * H, 0.02), kneeR: P(0.1, 0.285 * H, 0.02),
    ankleL: new Vec3(-0.11 * k, ANKLE_HEIGHT, 0), ankleR: new Vec3(0.11 * k, ANKLE_HEIGHT, 0),
    heelL: new Vec3(-0.11 * k, 0.03, -0.06 * k), heelR: new Vec3(0.11 * k, 0.03, -0.06 * k),
    footL: new Vec3(-0.12 * k, 0.02, 0.17 * k), footR: new Vec3(0.12 * k, 0.02, 0.17 * k),
  };
  const body = { height, handed, room: { x: room.x, d: room.d }, yawDeg: 0, modelScale, joints: j, visibility: {} };
  const ready = { shoulderAngles: { flex: 15, abd: 10, rot: 0 }, elbowFlex: 75, wristRot: 0 };
  poseArm(body, 'L', ready);
  poseArm(body, 'R', ready);
  if (yawDeg) turnBody(body, yawDeg);
  return body;
}

export function cloneBody(body) {
  const joints = {};
  for (const name of Object.keys(body.joints)) joints[name] = body.joints[name].clone();
  return { ...body, room: { ...body.room }, joints, visibility: { ...body.visibility } };
}

/** Hip center of a body in U. */
export function hipCenter(body, out = new Vec3()) {
  return out.addVectors(body.joints.hipL, body.joints.hipR).scale(0.5);
}

/** Rotates the whole body about the vertical through its hip center. +deg turns it to face its right. */
export function turnBody(body, deg) {
  const c = hipCenter(body);
  const a = deg * DEG, ca = Math.cos(a), sa = Math.sin(a);
  for (const v of Object.values(body.joints)) {
    const x = v.x - c.x, z = v.z - c.z;
    v.x = c.x + x * ca + z * sa;
    v.z = c.z - x * sa + z * ca;
  }
  body.yawDeg += deg;
  return body;
}

/** Local body direction (facing the camera at yaw 0) -> U, honouring body.yawDeg. */
function yawDir(body, x, y, z, out = new Vec3()) {
  const a = body.yawDeg * DEG, ca = Math.cos(a), sa = Math.sin(a);
  return out.set(x * ca + z * sa, y, -x * sa + z * ca);
}

/** Lowers the body by `depth` m with the feet planted; knees bend forward (2-bone IK). */
export function crouchBody(body, depth) {
  const j = body.joints;
  const lens = {};
  for (const s of ['L', 'R']) {
    lens[s] = { thigh: j['hip' + s].distanceTo(j['knee' + s]), shin: j['knee' + s].distanceTo(j['ankle' + s]) };
  }
  const planted = new Set(['ankleL', 'ankleR', 'heelL', 'heelR', 'footL', 'footR']);
  for (const [name, v] of Object.entries(j)) if (!planted.has(name)) v.y -= depth;
  for (const s of ['L', 'R']) {
    const pole = yawDir(body, sideSign(s) * 0.15, 0, 1);
    twoBoneIK(j['hip' + s], j['ankle' + s], lens[s].thigh, lens[s].shin, pole, j['knee' + s], new Vec3());
  }
  return body;
}

/** Translates every joint up by dy (a jump). */
export function liftBody(body, dy) {
  for (const v of Object.values(body.joints)) v.y += dy;
  return body;
}

// ---------------------------------------------------------------------------
// Arms and hands

/**
 * Two-bone IK from root S toward target T. Writes the mid joint into outMid and the
 * (possibly reach-limited) end point into outEnd. Returns true when T was reachable.
 */
export function twoBoneIK(S, T, l1, l2, pole, outMid, outEnd) {
  const dx = T.x - S.x, dy = T.y - S.y, dz = T.z - S.z;
  let D = Math.hypot(dx, dy, dz);
  const dir = D > 1e-9 ? new Vec3(dx / D, dy / D, dz / D) : new Vec3(0, -1, 0);
  const dMin = Math.abs(l1 - l2) + 1e-6, dMax = l1 + l2 - 1e-6;
  const reached = D >= dMin && D <= dMax;
  D = clamp(D, dMin, dMax);
  outEnd.copy(S).addScaled(dir, D);
  const a = (l1 * l1 - l2 * l2 + D * D) / (2 * D);
  const r = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  const q = pole.clone().addScaled(dir, -pole.dot(dir));
  if (q.lengthSq() < 1e-12) {
    q.set(0, 0, 1).addScaled(dir, -dir.z);
    if (q.lengthSq() < 1e-12) q.set(1, 0, 0).addScaled(dir, -dir.x);
  }
  q.normalize();
  outMid.copy(S).addScaled(dir, a).addScaled(q, r);
  return reached;
}

/**
 * Writes the hand landmarks for wrist w, unit hand direction h (wrist -> knuckles) and unit palm
 * direction k (h ⊥ k), consistent with body.js conventions.
 */
function placeHand(body, side, w, h, k) {
  const s = bodyK(body);
  const j = body.joints;
  const L = ARM.hand * s;
  // Thumb-ward unit vector: R -> k × h, L -> h × k (both give palmDir = k in body.js).
  const t = new Vec3().crossVectors(k, h).scale(sideSign(side));
  const mid = w.clone().addScaled(h, L);
  j['wrist' + side].copy(w);
  j['index' + side].copy(mid).addScaled(t, KNUCKLE_HALF_SPREAD * s).addScaled(h, KNUCKLE_DISTAL * s);
  j['pinky' + side].copy(mid).addScaled(t, -KNUCKLE_HALF_SPREAD * s).addScaled(h, -KNUCKLE_DISTAL * s);
  j['thumb' + side].copy(w).addScaled(h, THUMB.along * s).addScaled(t, THUMB.side * s).addScaled(k, THUMB.palm * s);
}

/**
 * Forward kinematics for one arm (degrees, body-local, then turned with the body).
 * shoulderAngles.flex: forward elevation (0 = hanging, 90 = pointing forward, 180 = up);
 * shoulderAngles.abd: sideways elevation; shoulderAngles.rot: humeral rotation of the elbow plane;
 * elbowFlex: 0 = straight; wristRot: forearm pronation (0 = handshake, palm facing the midline).
 * The wrist is straight (hand along the forearm).
 */
export function poseArm(body, side, { shoulderAngles = {}, elbowFlex = 0, wristRot = 0 } = {}) {
  const sg = sideSign(side);
  const s = bodyK(body);
  const flex = (shoulderAngles.flex ?? 0) * DEG, abd = (shoulderAngles.abd ?? 0) * DEG, rot = (shoulderAngles.rot ?? 0) * DEG;
  const j = body.joints;
  const S = j['shoulder' + side];
  // Upper-arm direction and the "forward/up" tangent (always unit and ⊥ u).
  const u = yawDir(body, sg * Math.sin(abd) * Math.cos(flex), -Math.cos(abd) * Math.cos(flex), Math.sin(flex));
  const p = yawDir(body, -sg * Math.sin(abd) * Math.sin(flex), Math.cos(abd) * Math.sin(flex), Math.cos(flex));
  rotateAbout(p, u, -sg * rot, p);
  const ef = elbowFlex * DEG;
  const fo = u.clone().scale(Math.cos(ef)).addScaled(p, Math.sin(ef)).normalize();
  // Palm reference: elbow hinge axis, signed so the palm faces the midline at wristRot 0.
  const k = new Vec3().crossVectors(p, u).scale(-sg);
  rotateAbout(k, fo, sg * wristRot * DEG, k);
  k.addScaled(fo, -k.dot(fo)).normalize();
  const e = S.clone().addScaled(u, ARM.upper * s);
  j['elbow' + side].copy(e);
  const w = e.clone().addScaled(fo, ARM.forearm * s);
  placeHand(body, side, w, fo, k);
  return body;
}

/**
 * Finds palmDir k and hand direction h such that body.js yields (axis a, normal n) for forearm
 * direction f: k = n cosφ + a sinφ, b = rot(k, -σθ) a, h from b = nlerp(h, f, β), with h ⊥ k.
 */
function solveHand(f, a, n, sigma, outK, outH) {
  const theta = sigma * GRIP_RADIAL_DEG * DEG;
  const beta = FOREARM_BLEND, al = 1 - beta;
  const b = new Vec3();
  const evalPhi = (phi) => {
    outK.copy(n).scale(Math.cos(phi)).addScaled(a, Math.sin(phi));
    rotateAbout(a, outK, -theta, b);
    const bf = b.dot(f);
    const c = beta * bf + Math.sqrt(beta * beta * bf * bf + al * al - beta * beta);
    return { c, g: c * Math.sin(phi) - beta * f.dot(outK) };
  };
  let lo = -Math.PI / 2 + 1e-6, hi = Math.PI / 2 - 1e-6;
  for (let i = 0; i < 64; i++) {
    const mid = (lo + hi) / 2;
    if (evalPhi(mid).g > 0) hi = mid;
    else lo = mid;
  }
  const { c } = evalPhi((lo + hi) / 2);
  outH.copy(b).scale(c).addScaled(f, -beta).scale(1 / al);
  outH.addScaled(outK, -outH.dot(outK)).normalize();
}

/**
 * Simple 2-bone IK so the grip lands on gripTargetU and body.js reads back the requested
 * racket axis and forehand-face normal. The elbow hangs toward `pole` (default: down, out, back).
 * @returns {{ reached: boolean, error: number }} error = grip miss distance (m) when out of reach
 */
export function setHandTarget(body, side, gripTargetU, axisU, normalU, { pole = null } = {}) {
  const s = bodyK(body);
  const Lu = ARM.upper * s, Lf = ARM.forearm * s, Lh = ARM.hand * s;
  const sigma = sideSign(side);
  const j = body.joints;
  const S = j['shoulder' + side];
  const a = Vec3.from(axisU).normalize();
  const n = Vec3.from(normalU).addScaled(a, -a.dot(normalU)).normalize();
  const g = Vec3.from(gripTargetU);
  const P = pole ? Vec3.from(pole) : yawDir(body, sigma * 0.6, -1, -0.3);

  const k = new Vec3(), h = new Vec3(), w = new Vec3(), e = new Vec3(), wr = new Vec3();
  const f = rotateAbout(a, n, -sigma * GRIP_RADIAL_DEG * DEG, new Vec3());
  let reached = false;
  for (let iter = 0; iter < 40; iter++) {
    solveHand(f, a, n, sigma, k, h);
    w.copy(g).addScaled(h, -GRIP_ALONG * Lh).addScaled(k, -GRIP_PALM_OFFSET);
    reached = twoBoneIK(S, w, Lu, Lf, P, e, wr);
    const fx = wr.x - e.x, fy = wr.y - e.y, fz = wr.z - e.z;
    const fl = Math.hypot(fx, fy, fz);
    const nf = new Vec3(fx / fl, fy / fl, fz / fl);
    const delta = nf.distanceTo(f);
    f.copy(nf);
    if (delta < 1e-12) break;
  }
  solveHand(f, a, n, sigma, k, h);
  j['elbow' + side].copy(e);
  placeHand(body, side, wr, h, k);
  const gripActual = wr.clone().addScaled(h, GRIP_ALONG * Lh).addScaled(k, GRIP_PALM_OFFSET);
  return { reached, error: gripActual.distanceTo(g) };
}

// ---------------------------------------------------------------------------
// Camera

/** Leg landmarks MediaPipe guesses when they are out of the picture (knees, ankles, heels, feet). */
const LEG_LANDMARKS = Object.freeze([25, 26, 27, 28, 29, 30, 31, 32]);
const HAND_LANDMARKS = Object.freeze({ L: [15, 17, 19, 21], R: [16, 18, 20, 22] });

/**
 * MediaPipe's guess of a cropped leg (U, for a body of scale k): a straight standing leg under its
 * hip, whatever the real pose (crouch, turn, step).
 */
function guessedLeg(body, i, out) {
  const j = body.joints;
  const k = bodyK(body);
  const left = i % 2 === 1; // 25, 27, 29, 31 = left
  const hip = j[left ? 'hipL' : 'hipR'];
  const hx = hip.x * 1.15;
  switch (i) {
    case 25: case 26: return out.set(hx, hip.y - 0.43 * k, hip.z + 0.02 * k);
    case 27: case 28: return out.set(hx * 1.05, hip.y - 0.85 * k, hip.z);
    case 29: case 30: return out.set(hx * 1.05, hip.y - 0.9 * k, hip.z - 0.06 * k);
    default: return out.set(hx * 1.08, hip.y - 0.91 * k, hip.z + 0.17 * k);
  }
}

/**
 * Pinhole camera at (0, cameraHeight) looking horizontally at the user (or pitched up by
 * pitchDeg, world landmarks camera-aligned like MediaPipe's unless worldFrame = 'gravity');
 * unmirrored image.
 * modelScale (real / MediaPipe-model size) simulates MediaPipe's body-size bias; a body's own
 * `modelScale` takes precedence. Optional seeded noise: { imagePx, worldM, seed }.
 *
 * crop (round 4, close mode): MediaPipe-like output for a player too close to be seen whole,
 *   { seed = 11, edge = 0.06 }: every landmark beyond the frame gets a low visibility (U(0.3, 0.6)
 *   within `edge` of the frame, U(0, 0.2) further out) and the legs beyond it a guessed straight
 *   standing pose under the hips (crouch and turns ignored), projected into both the image and the
 *   world landmarks. Landmarks in the picture are untouched.
 * blur: { speed = 6, p = 0.5, lag = [0.2, 0.6], vis = 0.4, seed = 13 }: motion blur of a fast
 *   swing at 30 fps; when a wrist moves faster than `speed` m/s, with probability p the hand's
 *   landmarks are a stale smear (the previous frame's plus a `lag` share of the motion) with their
 *   visibility scaled by `vis`.
 * armOut (round 5, QA r5): a real detector's arm landmarks (elbows, wrists, hands) beyond the frame
 *   are guesses, not the truth: { mode = 'drift', lag = 0.15, noise = 0.03, vis = [0, 0.3], seed = 17 }.
 *   The image position is clamped to the frame edge and the visibility is U(vis); the world position
 *   'drift's after the truth with a first-order lag of `lag` s plus `noise` m of wander, or with
 *   mode 'clamp' stays where the landmark was last seen in the picture (the pessimistic case).
 *   cam.stats.armOut counts such landmarks.
 */
export function createSyntheticCamera({
  hfovDeg, width = 1280, height = 720, cameraHeight = 1.0, modelScale = 1, noise = null, crop = null, blur = null, pitchDeg = 0,
  worldFrame = 'camera', armOut = null,
} = {}) {
  const fn = focalNorm(hfovDeg);
  const aspect = width / height;
  // Camera pitched up by pitchDeg (a MacBook lid tilted back). MediaPipe has no notion of gravity:
  // its world landmarks are aligned with the camera, so a pitched camera sees an upright body
  // leaning away from it by the pitch (worldFrame 'camera'; 'gravity' keeps them level).
  const cp = Math.cos(pitchDeg * DEG), sp = Math.sin(pitchDeg * DEG);
  const camWorld = pitchDeg !== 0 && worldFrame !== 'gravity';
  const rng = noise ? createRng(noise.seed ?? 7) : null;
  const crng = crop ? createRng(crop.seed ?? 11) : null;
  const brng = blur ? createRng(blur.seed ?? 13) : null;
  const arng = armOut ? createRng(armOut.seed ?? 17) : null;
  const armState = []; // per body: { t, seen: [33 world], out: [33 world] }
  const hc = new Vec3();
  const g = new Vec3();
  const prevByIndex = [];
  const stats = { blurred: 0, cropped: 0, armOut: 0 };

  function project(body, J, out) {
    const Xc = -(body.room.x + J.x);
    const H = J.y - cameraHeight; // height above the camera
    const Zh = body.room.d - J.z; // horizontal depth
    const Zc = Zh * cp + H * sp;
    const Up = H * cp - Zh * sp;
    out.u = 0.5 + (fn * Xc) / Zc;
    out.v = 0.5 - (fn * aspect * Up) / Zc;
    out.Zc = Zc;
    return out;
  }
  const P = { u: 0, v: 0, Zc: 0 };

  function personFrom(body, bi, t) {
    const ms = body.modelScale && body.modelScale !== 1 ? body.modelScale : modelScale;
    hipCenter(body, hc);
    const hipDepth = body.room.d - hc.z;
    const landmarks = new Array(33), world = new Array(33);
    // Crop: are the legs (any of them) beyond the frame? Then MediaPipe guesses those.
    for (let i = 0; i < 33; i++) {
      const name = LANDMARK_NAMES[i];
      let J = body.joints[name];
      project(body, J, P);
      let inView = P.Zc > 0.1 && P.u >= 0 && P.u <= 1 && P.v >= 0 && P.v <= 1;
      let outBy = inView ? 0 : Math.max(-P.u, P.u - 1, -P.v, P.v - 1);
      if (crop && !inView && LEG_LANDMARKS.includes(i)) {
        J = guessedLeg(body, i, g);
        project(body, J, P);
        stats.cropped++;
      }
      let u = P.u, v = P.v;
      const Zc = P.Zc;
      if (rng && noise.imagePx) {
        u += rng.normal(0, noise.imagePx) / width;
        v += rng.normal(0, noise.imagePx) / height;
      }
      inView = Zc > 0.1 && u >= 0 && u <= 1 && v >= 0 && v <= 1;
      if (!inView && !outBy) outBy = Math.max(-u, u - 1, -v, v - 1, 0);
      let visibility = body.visibility[name];
      if (visibility === undefined) {
        if (inView) visibility = 0.99;
        else if (crop) visibility = outBy < (crop.edge ?? 0.06) ? crng.range(0.3, 0.6) : crng.range(0, 0.2);
        else visibility = 0.05;
      }
      landmarks[i] = { x: u, y: v, z: (fn * (Zc - hipDepth)) / hipDepth, visibility };
      let wx = -(J.x - hc.x) / ms, wy = -(J.y - hc.y) / ms, wz = -(J.z - hc.z) / ms;
      if (camWorld) {
        const y = wy * cp + wz * sp, z = -wy * sp + wz * cp;
        wy = y;
        wz = z;
      }
      if (rng && noise.worldM) {
        wx += rng.normal(0, noise.worldM);
        wy += rng.normal(0, noise.worldM);
        wz += rng.normal(0, noise.worldM * 2); // MediaPipe depth is the noisiest axis
      }
      world[i] = { x: wx, y: wy, z: wz, visibility };
    }
    if (blur) applyBlur(body, bi, t, landmarks, world);
    if (armOut) applyArmOut(bi, t, landmarks, world);
    return { landmarks, world };
  }

  /** Out-of-frame arm landmarks as a detector reports them (see createSyntheticCamera's armOut). */
  function applyArmOut(bi, t, landmarks, world) {
    const st = armState[bi] || (armState[bi] = { t: null, seen: [], out: [] });
    const dt = st.t === null ? 0 : Math.max(0, (t - st.t) / 1000);
    st.t = t;
    const k = 1 - Math.exp(-dt / Math.max(1e-3, armOut.lag ?? 0.15));
    const vr = armOut.vis || [0, 0.3];
    for (let i = 13; i <= 22; i++) {
      const l = landmarks[i], w = world[i];
      const inView = l.x >= 0 && l.x <= 1 && l.y >= 0 && l.y <= 1;
      if (inView) {
        st.seen[i] = { x: w.x, y: w.y, z: w.z };
        st.out[i] = null;
        continue;
      }
      stats.armOut++;
      l.x = clamp(l.x, 0, 1);
      l.y = clamp(l.y, 0, 1);
      l.visibility = arng.range(vr[0], vr[1]);
      w.visibility = l.visibility;
      const seen = st.seen[i];
      if (armOut.mode === 'clamp') {
        if (seen) { w.x = seen.x; w.y = seen.y; w.z = seen.z; }
        continue;
      }
      const prev = st.out[i] || seen || { x: w.x, y: w.y, z: w.z };
      const n = armOut.noise ?? 0.03;
      const o = {
        x: prev.x + (w.x - prev.x) * k + arng.normal(0, n * Math.sqrt(Math.max(dt, 1e-3) / 0.033)) * 0.5,
        y: prev.y + (w.y - prev.y) * k + arng.normal(0, n * Math.sqrt(Math.max(dt, 1e-3) / 0.033)) * 0.5,
        z: prev.z + (w.z - prev.z) * k + arng.normal(0, n * Math.sqrt(Math.max(dt, 1e-3) / 0.033)) * 0.5,
      };
      st.out[i] = o;
      w.x = o.x; w.y = o.y; w.z = o.z;
    }
  }

  /** Motion blur: a fast hand is returned as a stale smear (see createSyntheticCamera's blur). */
  function applyBlur(body, bi, t, landmarks, world) {
    const prev = prevByIndex[bi];
    const cur = { t, wrist: { L: body.joints.wristL.clone(), R: body.joints.wristR.clone() }, landmarks, world };
    if (prev && t > prev.t) {
      const dt = (t - prev.t) / 1000;
      for (const side of ['L', 'R']) {
        const sp = cur.wrist[side].distanceTo(prev.wrist[side]) / dt;
        if (sp < (blur.speed ?? 6) || brng() >= (blur.p ?? 0.5)) continue;
        const lag = blur.lag || [0.2, 0.6];
        const a = brng.range(lag[0], lag[1]);
        for (const i of HAND_LANDMARKS[side]) {
          const pl = prev.landmarks[i], pw = prev.world[i], l = landmarks[i], w = world[i];
          l.x = pl.x + (l.x - pl.x) * a; l.y = pl.y + (l.y - pl.y) * a;
          w.x = pw.x + (w.x - pw.x) * a; w.y = pw.y + (w.y - pw.y) * a; w.z = pw.z + (w.z - pw.z) * a;
          l.visibility *= blur.vis ?? 0.4;
          w.visibility = l.visibility;
        }
        stats.blurred++;
      }
    }
    prevByIndex[bi] = cur;
  }

  return {
    width,
    height,
    hfovDeg,
    cameraHeight,
    stats,
    /** @returns PoseFrame */
    frame(t, bodies) {
      return { t, width, height, people: bodies.map((b, i) => personFrom(b, i, t)) };
    },
  };
}
