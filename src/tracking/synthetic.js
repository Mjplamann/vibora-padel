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

/**
 * Pinhole camera at (0, cameraHeight) looking horizontally at the user; unmirrored image.
 * modelScale (real / MediaPipe-model size) simulates MediaPipe's body-size bias; a body's own
 * `modelScale` takes precedence. Optional seeded noise: { imagePx, worldM, seed }.
 */
export function createSyntheticCamera({ hfovDeg, width = 1280, height = 720, cameraHeight = 1.0, modelScale = 1, noise = null } = {}) {
  const fn = focalNorm(hfovDeg);
  const aspect = width / height;
  const rng = noise ? createRng(noise.seed ?? 7) : null;
  const hc = new Vec3();

  function personFrom(body) {
    const ms = body.modelScale && body.modelScale !== 1 ? body.modelScale : modelScale;
    hipCenter(body, hc);
    const hipDepth = body.room.d - hc.z;
    const landmarks = new Array(33), world = new Array(33);
    for (let i = 0; i < 33; i++) {
      const name = LANDMARK_NAMES[i];
      const J = body.joints[name];
      const Xc = -(body.room.x + J.x);
      const Yc = cameraHeight - J.y;
      const Zc = body.room.d - J.z;
      let u = 0.5 + (fn * Xc) / Zc;
      let v = 0.5 + (fn * aspect * Yc) / Zc;
      if (rng && noise.imagePx) {
        u += rng.normal(0, noise.imagePx) / width;
        v += rng.normal(0, noise.imagePx) / height;
      }
      const inView = Zc > 0.1 && u >= 0 && u <= 1 && v >= 0 && v <= 1;
      const visibility = body.visibility[name] ?? (inView ? 0.99 : 0.05);
      landmarks[i] = { x: u, y: v, z: (fn * (Zc - hipDepth)) / hipDepth, visibility };
      let wx = -(J.x - hc.x) / ms, wy = -(J.y - hc.y) / ms, wz = -(J.z - hc.z) / ms;
      if (rng && noise.worldM) {
        wx += rng.normal(0, noise.worldM);
        wy += rng.normal(0, noise.worldM);
        wz += rng.normal(0, noise.worldM * 2); // MediaPipe depth is the noisiest axis
      }
      world[i] = { x: wx, y: wy, z: wz, visibility };
    }
    return { landmarks, world };
  }

  return {
    width,
    height,
    hfovDeg,
    cameraHeight,
    /** @returns PoseFrame */
    frame(t, bodies) {
      return { t, width, height, people: bodies.map(personFrom) };
    },
  };
}
