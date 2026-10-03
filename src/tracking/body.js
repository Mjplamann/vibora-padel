// PoseFrame (MediaPipe BlazePose, VIDEO mode) -> BodySample in the user frame U.
//
// U frame: origin on the floor under the hip center, +x = user's right, +y = up,
// +z = toward the TV/camera ("forward", court -z). Pure module: no DOM, no three.
//
// Pipeline per frame:
//   1. pick the person to follow (selectPerson)
//   2. body scale = real / model size (MediaPipe world landmarks come out at the
//      model's idea of an average body; we rescale them to the user's height)
//   3. room position {x, d} from the image: per-segment pinhole distance, a
//      visibility-weighted median, then One Euro smoothing
//   4. joints in U (world landmarks rescaled, hip-centred, axes flipped) with
//      One Euro smoothing; hands get a fast filter so swings are not smeared
//   5. hand frames (grip, racket axis, face normal), crouch, jump / airborne lift

import { Vec3 } from '../util/vec3.js';
import { OneEuro, clamp, DEG, damp } from '../util/math.js';
import { PLAYER, TRACKING } from '../config.js';

// --- Hand / grip model ------------------------------------------------------
/** Racket handle rotation toward the thumb side (radial deviation of a continental grip). */
export const GRIP_RADIAL_DEG = 40;
/** Blend of the forearm direction into the hand direction (stability against finger noise). */
export const FOREARM_BLEND = 0.2;
/** Grip point as a fraction of wrist -> knuckle-midpoint. */
export const GRIP_ALONG = 0.8;
/** Grip point offset along the palm normal (the handle sits in front of the palm), m. */
export const GRIP_PALM_OFFSET = 0.015;

// --- Anthropometry used for scale and hip height ------------------------------
/** Height of the MediaPipe ankle landmark above the floor, m. */
export const ANKLE_HEIGHT = 0.08;
/** Nose-tip height / stature (eyes at PLAYER.eyeHeightRatio = 0.936, nose ~4.5 cm lower). */
export const NOSE_HEIGHT_RATIO = 0.911;

export const JOINT_INDEX = Object.freeze({
  nose: 0, eyeL: 2, eyeR: 5, earL: 7, earR: 8,
  shoulderL: 11, shoulderR: 12, elbowL: 13, elbowR: 14, wristL: 15, wristR: 16,
  pinkyL: 17, pinkyR: 18, indexL: 19, indexR: 20, thumbL: 21, thumbR: 22,
  hipL: 23, hipR: 24, kneeL: 25, kneeR: 26, ankleL: 27, ankleR: 28,
});
export const JOINT_NAMES = Object.freeze(Object.keys(JOINT_INDEX));

const HAND_JOINTS = new Set(['wristL', 'wristR', 'indexL', 'indexR', 'pinkyL', 'pinkyR', 'thumbL', 'thumbR']);
const ELBOW_JOINTS = new Set(['elbowL', 'elbowR']);

// Segments used for the distance estimate: shoulders, hips, left/right torso, left/right thigh.
const DISTANCE_SEGMENTS = [[11, 12], [23, 24], [11, 23], [12, 24], [23, 25], [24, 26]];
const CONFIDENCE_JOINTS = [11, 12, 13, 14, 15, 16, 23, 24];

/**
 * Default filter settings [minCutoff Hz, beta, dCutoff Hz]. distance/lateral/joint/hand
 * minCutoff and beta are the SPEC §4.2 values. dCutoff is not given by the spec: hands use
 * 4 Hz so the speed estimate (and with it the cutoff) ramps up within a frame or two of a
 * swing starting; elbows use 2 Hz because the forearm direction feeds the racket axis.
 */
export const DEFAULT_FILTERS = Object.freeze({
  distance: [0.6, 0.3, 1.0],
  lateral: [1.2, 0.8, 1.0],
  joint: [2.0, 1.5, 1.0],
  elbow: [2.0, 1.5, 2.0],
  hand: [4.0, 8.0, 4.0],
  vertical: [4.0, 2.0, 2.0],
  // Hand-frame orientation (axis/normal): One Euro on rotations,
  // [minCutoff Hz, beta per rad/s of rotation, dCutoff Hz, beta per m/s of wrist speed].
  // The palm normal is a cross product of two ~9 cm vectors ~4 cm apart, so landmark noise
  // becomes large angular jitter whose own rate would open the filter; the wrist's (well
  // filtered) linear speed is the robust cue that the racket is really swinging.
  handRot: [1.0, 0.5, 2.0, 6.0],
});

const JUMP_HIP_SPEED = 1.2; // m/s upward (SPEC)
// Noise floors of the hand rotation filter's speed cues (below them the filter stays closed).
const WRIST_SPEED_FLOOR = 0.5; // m/s of wrist speed
const ROT_SPEED_FLOOR = 4.0; // rad/s of hand rotation (a deliberate twist is faster)
const AIRBORNE_DEADBAND = 0.05; // m of ankle lift ignored (tracking noise, tilted cameras)
const LOST_RESET_S = 0.5; // filters restart after a tracking gap this long

/** Normalised focal length (image widths) for a horizontal field of view. */
export const focalNorm = (hfovDeg) => 0.5 / Math.tan((hfovDeg * DEG) / 2);

const vis = (p) => (p && p.visibility !== undefined ? p.visibility : 1);

// ---------------------------------------------------------------------------
// Small vector helpers (module scratch, no allocation).

/** out = v rotated by `angle` (rad) about unit axis k (Rodrigues). Safe when out aliases v. */
export function rotateAbout(v, k, angle, out) {
  const c = Math.cos(angle), s = Math.sin(angle);
  const kd = k.x * v.x + k.y * v.y + k.z * v.z;
  const cx = k.y * v.z - k.z * v.y;
  const cy = k.z * v.x - k.x * v.z;
  const cz = k.x * v.y - k.y * v.x;
  const x = v.x * c + cx * s + k.x * kd * (1 - c);
  const y = v.y * c + cy * s + k.y * kd * (1 - c);
  const z = v.z * c + cz * s + k.z * kd * (1 - c);
  return out.set(x, y, z);
}

// ---------------------------------------------------------------------------
// Hand frame

const _pw = new Vec3(), _iw = new Vec3(), _k = new Vec3(), _mid = new Vec3(), _h = new Vec3();
const _f = new Vec3(), _b = new Vec3(), _t = new Vec3(), _kb = new Vec3();

/** Empty HandFrame. */
export const createHandFrame = () => ({ grip: new Vec3(), axis: new Vec3(), normal: new Vec3() });

/**
 * HandFrame from hand landmarks in U (or any right-handed frame).
 * - palmDir (way the palm faces): R = normalize((pinky-w) x (index-w)), L = normalize((index-w) x (pinky-w)).
 *   Right hand, fingers up, palm facing the camera -> palmDir = +z.
 * - grip = wrist + GRIP_ALONG*(knuckleMid - wrist) + palmDir*GRIP_PALM_OFFSET
 * - axis = nlerp(handDir, forearmDir, FOREARM_BLEND) rotated GRIP_RADIAL_DEG about palmDir toward the thumb
 * - normal (forehand face) = palmDir orthogonalised against axis
 * @param {'L'|'R'} side
 */
export function computeHandFrame(side, wrist, index, pinky, thumb, elbow, out = createHandFrame()) {
  _pw.subVectors(pinky, wrist);
  _iw.subVectors(index, wrist);
  if (side === 'L') _k.crossVectors(_iw, _pw);
  else _k.crossVectors(_pw, _iw);
  _mid.addVectors(index, pinky).scale(0.5);
  _h.subVectors(_mid, wrist);
  const handLen = _h.length();
  if (handLen < 1e-6) _h.set(0, 1, 0);
  else _h.scale(1 / handLen);

  if (_k.lengthSq() < 1e-14) {
    // Degenerate hand (collapsed landmarks): assume the palm faces the camera.
    _k.set(0, 0, 1);
  }
  _k.projectOnPlane(_h);
  if (_k.lengthSq() < 1e-14) _k.set(side === 'L' ? -1 : 1, 0, 0).projectOnPlane(_h);
  _k.normalize();

  if (elbow) {
    _f.subVectors(wrist, elbow);
    if (_f.lengthSq() < 1e-10) _f.copy(_h);
    else _f.normalize();
  } else _f.copy(_h);
  _b.copy(_h).lerp(_f, FOREARM_BLEND);
  if (_b.lengthSq() < 1e-10) _b.copy(_h);
  _b.normalize();

  out.grip.copy(wrist).addScaled(_h, GRIP_ALONG * handLen).addScaled(_k, GRIP_PALM_OFFSET);

  // Thumb side: the part of (thumb - wrist) perpendicular to both palmDir and handDir.
  _kb.crossVectors(_k, _b);
  let sign = side === 'L' ? -1 : 1;
  if (thumb) {
    _t.subVectors(thumb, wrist).projectOnPlane(_k).projectOnPlane(_h);
    const d = _t.dot(_kb);
    if (_t.lengthSq() > 1e-8 && Math.abs(d) > 1e-6) sign = d > 0 ? 1 : -1;
  }
  rotateAbout(_b, _k, sign * GRIP_RADIAL_DEG * DEG, out.axis).normalize();
  out.normal.copy(_k).addScaled(out.axis, -_k.dot(out.axis)).normalize();
  return out;
}

// ---------------------------------------------------------------------------
// Frame-level helpers

const _segD = new Float64Array(DISTANCE_SEGMENTS.length);
const _segW = new Float64Array(DISTANCE_SEGMENTS.length);

function weightedMedian(vals, weights, n) {
  // Insertion sort of (value, weight) pairs; n <= 6.
  for (let i = 1; i < n; i++) {
    const v = vals[i], w = weights[i];
    let j = i - 1;
    while (j >= 0 && vals[j] > v) {
      vals[j + 1] = vals[j];
      weights[j + 1] = weights[j];
      j--;
    }
    vals[j + 1] = v;
    weights[j + 1] = w;
  }
  let total = 0;
  for (let i = 0; i < n; i++) total += weights[i];
  const half = total / 2;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += weights[i];
    if (acc > half + 1e-12) return vals[i];
    if (Math.abs(acc - half) <= 1e-12 && i + 1 < n) return (vals[i] + vals[i + 1]) / 2;
  }
  return vals[n - 1];
}

/**
 * Raw (unsmoothed) distance from the camera along its axis to the hip center, in meters.
 * For each segment: d_i = f_n * |world_xy| * scale / |image| (image y scaled by height/width),
 * corrected by the segment's mean depth offset from the hips; visibility-weighted median.
 * @returns {number|null}
 */
export function estimateDistance(landmarks, world, hfovDeg, aspect, scale) {
  const fn = focalNorm(hfovDeg);
  let n = 0;
  for (let s = 0; s < DISTANCE_SEGMENTS.length; s++) {
    const [ia, ib] = DISTANCE_SEGMENTS[s];
    const la = landmarks[ia], lb = landmarks[ib], wa = world[ia], wb = world[ib];
    if (!la || !lb || !wa || !wb) continue;
    const w = Math.min(vis(la), vis(lb), vis(wa), vis(wb));
    if (w < 0.2) continue;
    const wx = (wa.x - wb.x) * scale, wy = (wa.y - wb.y) * scale;
    const lw = Math.hypot(wx, wy);
    const iu = la.x - lb.x, iv = (la.y - lb.y) / aspect;
    const li = Math.hypot(iu, iv);
    if (lw < 0.08 || li < 1e-4) continue;
    // Camera depth of a point = D_hip + scale * world.z, so remove the segment's mean offset.
    const dz = clamp((scale * (wa.z + wb.z)) / 2, -0.4, 0.4);
    _segD[n] = (fn * lw) / li - dz;
    _segW[n] = w;
    n++;
  }
  if (n === 0) return null;
  return weightedMedian(_segD, _segW, n);
}

/** Normalised image position of the hip center, or null. */
function hipImage(landmarks) {
  const a = landmarks[23], b = landmarks[24];
  if (!a || !b) return null;
  return { u: (a.x + b.x) / 2, v: (a.y + b.y) / 2 };
}

/**
 * Room position of the user from one frame (unsmoothed).
 * x: meters to the user's right of the camera axis (computed from the UNMIRRORED image:
 * the user's right appears on the image's left). d: distance from the camera to the hips.
 * @param aspect image width / height
 * @returns {{x:number, d:number}|null}
 */
export function roomPosition(landmarks, world, hfovDeg, aspect, scale) {
  const d = estimateDistance(landmarks, world, hfovDeg, aspect, scale);
  const hip = hipImage(landmarks);
  if (d === null || !hip) return null;
  return { x: (-(hip.u - 0.5) * d) / focalNorm(hfovDeg), d };
}

/** Hip height (m) from world landmarks: mid-ankle depth below the hips * scale + ANKLE_HEIGHT. */
export function hipHeightFromWorld(world, scale) {
  return ((world[27].y + world[28].y) / 2) * scale + ANKLE_HEIGHT;
}

/**
 * World landmarks (MediaPipe axes: x image-right, y down, z away from camera, hip-centred)
 * -> joints in U. x_U = -x*scale, y_U = -y*scale + hipHeight, z_U = -z*scale.
 * @returns {Record<string, Vec3>}
 */
export function toUserFrame(world, scale, hipHeight, out = {}) {
  for (const name of JOINT_NAMES) {
    const w = world[JOINT_INDEX[name]];
    const v = out[name] || (out[name] = new Vec3());
    v.set(-w.x * scale, -w.y * scale + hipHeight, -w.z * scale);
  }
  return out;
}

/** Model-space nose -> mid-ankle height, or null when not visible. */
function modelNoseToAnkle(world) {
  const n = world[0], a = world[27], b = world[28];
  if (!n || !a || !b || Math.min(vis(n), vis(a), vis(b)) < 0.5) return null;
  const h = (a.y + b.y) / 2 - n.y;
  return h > 0.5 ? h : null;
}

/** Real/model scale from a model nose->ankle height and the user's stature. */
export function scaleFromModel(noseToAnkle, userHeight) {
  return (userHeight * NOSE_HEIGHT_RATIO - ANKLE_HEIGHT) / noseToAnkle;
}

function personStats(p, aspect) {
  const lm = p.landmarks;
  const hip = hipImage(lm);
  if (!hip) return null;
  let top = Infinity, bottom = -Infinity, vsum = 0;
  for (const i of [0, 11, 12, 23, 24, 27, 28]) {
    const q = lm[i];
    if (!q) continue;
    vsum += vis(q);
    if (vis(q) < 0.3) continue;
    if (q.y < top) top = q.y;
    if (q.y > bottom) bottom = q.y;
  }
  const size = bottom > top ? (bottom - top) / aspect : 0;
  return { u: hip.u, v: hip.v, size, vis: vsum / 7 };
}

/**
 * Index of the person to follow: the one whose hip center is closest (in the image) to the
 * previous sample's, otherwise the largest / most central body. -1 when nobody is visible.
 */
export function selectPerson(frame, prevSample) {
  const people = frame && frame.people;
  if (!people || people.length === 0) return -1;
  if (people.length === 1) return 0;
  const aspect = frame.width && frame.height ? frame.width / frame.height : 16 / 9;
  const prev = prevSample && prevSample.image;
  let best = -1, bestScore = -Infinity, nearest = -1, nearestD = Infinity;
  for (let i = 0; i < people.length; i++) {
    const s = personStats(people[i], aspect);
    if (!s) continue;
    if (prev) {
      const dd = Math.hypot(s.u - prev.hipU, (s.v - prev.hipV) / aspect);
      if (dd < nearestD) {
        nearestD = dd;
        nearest = i;
      }
    }
    const score = s.size * s.vis - 0.5 * Math.abs(s.u - 0.5);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  if (nearest >= 0 && nearestD < 0.15) return nearest;
  return best >= 0 ? best : 0;
}

// ---------------------------------------------------------------------------
// Vector One Euro filter: cutoff from the speed of the whole vector (isotropic, so an
// arc is smoothed the same way in every direction), no allocation.

class OneEuroVec {
  constructor([minCutoff, beta, dCutoff]) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.x = new Vec3();
    this.dx = new Vec3();
    this.t = null;
  }

  reset() {
    this.t = null;
    this.dx.set(0, 0, 0);
  }

  filter(v, t, out) {
    if (this.t === null) {
      this.x.copy(v);
      this.dx.set(0, 0, 0);
      this.t = t;
      return out.copy(this.x);
    }
    if (t <= this.t) return out.copy(this.x);
    const dt = t - this.t;
    this.t = t;
    const ad = OneEuro.alpha(this.dCutoff, dt);
    this.dx.x += ((v.x - this.x.x) / dt - this.dx.x) * ad;
    this.dx.y += ((v.y - this.x.y) / dt - this.dx.y) * ad;
    this.dx.z += ((v.z - this.x.z) / dt - this.dx.z) * ad;
    const a = OneEuro.alpha(this.minCutoff + this.beta * this.dx.length(), dt);
    this.x.lerp(v, a);
    return out.copy(this.x);
  }

  rescale(r) {
    this.x.scale(r);
    this.dx.scale(r);
  }
}

// Orientation of a HandFrame as a quaternion {x,y,z,w}: columns X = Y x Z, Y = axis, Z = normal.
function frameQuat(axis, normal, q) {
  const yx = axis.x, yy = axis.y, yz = axis.z, zx = normal.x, zy = normal.y, zz = normal.z;
  const xx = yy * zz - yz * zy, xy = yz * zx - yx * zz, xz = yx * zy - yy * zx;
  const tr = xx + yy + zz;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    q.w = 0.25 / s; q.x = (yz - zy) * s; q.y = (zx - xz) * s; q.z = (xy - yx) * s;
  } else if (xx > yy && xx > zz) {
    const s = 2 * Math.sqrt(1 + xx - yy - zz);
    q.w = (yz - zy) / s; q.x = 0.25 * s; q.y = (yx + xy) / s; q.z = (zx + xz) / s;
  } else if (yy > zz) {
    const s = 2 * Math.sqrt(1 + yy - xx - zz);
    q.w = (zx - xz) / s; q.x = (yx + xy) / s; q.y = 0.25 * s; q.z = (zy + yz) / s;
  } else {
    const s = 2 * Math.sqrt(1 + zz - xx - yy);
    q.w = (xy - yx) / s; q.x = (zx + xz) / s; q.y = (zy + yz) / s; q.z = 0.25 * s;
  }
  return q;
}

/** Rotation vector (world frame, |v| <= PI) taking frame quaternion qa to qb. */
function rotVecBetween(qa, qb, out) {
  const ax = -qa.x, ay = -qa.y, az = -qa.z, aw = qa.w;
  let w = qb.w * aw - (qb.x * ax + qb.y * ay + qb.z * az);
  let x = qb.w * ax + aw * qb.x + (qb.y * az - qb.z * ay);
  let y = qb.w * ay + aw * qb.y + (qb.z * ax - qb.x * az);
  let z = qb.w * az + aw * qb.z + (qb.x * ay - qb.y * ax);
  if (w < 0) {
    w = -w; x = -x; y = -y; z = -z;
  }
  const s = Math.hypot(x, y, z);
  if (s < 1e-12) return out.set(2 * x, 2 * y, 2 * z);
  const angle = 2 * Math.atan2(s, w);
  return out.set((x / s) * angle, (y / s) * angle, (z / s) * angle);
}

const _qa = { x: 0, y: 0, z: 0, w: 1 }, _qb = { x: 0, y: 0, z: 0, w: 1 };
const copyQuat = (d, q) => {
  d.x = q.x; d.y = q.y; d.z = q.z; d.w = q.w;
};
const _delta = new Vec3(), _rk = new Vec3();

/**
 * One Euro filter on a HandFrame's orientation: the filtered frame is slerped toward the
 * measured one by alpha(cutoff), cutoff = minCutoff + beta * max(0, |w| - ROT_SPEED_FLOOR)
 * + betaWrist * max(0, wristSpeed - WRIST_SPEED_FLOOR), where w is the rotation rate between
 * consecutive raw frames. Grip passes through untouched.
 */
class HandRotFilter {
  constructor([minCutoff, beta, dCutoff, betaWrist = 0]) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.betaWrist = betaWrist;
    this.axis = new Vec3(0, 1, 0);
    this.normal = new Vec3(0, 0, 1);
    this.w = new Vec3();
    this.qRaw = { x: 0, y: 0, z: 0, w: 1 };
    this.t = null;
  }

  reset() {
    this.t = null;
  }

  /** Filters frame.axis / frame.normal in place; wristSpeed (m/s) opens the filter during swings. */
  filter(frame, t, wristSpeed = 0) {
    if (this.t === null) {
      this.axis.copy(frame.axis);
      this.normal.copy(frame.normal);
      frameQuat(frame.axis, frame.normal, this.qRaw);
      this.w.set(0, 0, 0);
      this.t = t;
      return frame;
    }
    if (t > this.t) {
      const dt = t - this.t;
      this.t = t;
      // Rotation rate between consecutive raw frames: noise averages out, real turns persist.
      frameQuat(frame.axis, frame.normal, _qb);
      rotVecBetween(this.qRaw, _qb, _delta);
      const ad = OneEuro.alpha(this.dCutoff, dt);
      this.w.x += (_delta.x / dt - this.w.x) * ad;
      this.w.y += (_delta.y / dt - this.w.y) * ad;
      this.w.z += (_delta.z / dt - this.w.z) * ad;
      copyQuat(this.qRaw, _qb);
      // Correction from the filtered frame to the measurement.
      frameQuat(this.axis, this.normal, _qa);
      rotVecBetween(_qa, _qb, _delta);
      const swing = Math.max(0, wristSpeed - WRIST_SPEED_FLOOR);
      const twist = Math.max(0, this.w.length() - ROT_SPEED_FLOOR);
      const cutoff = this.minCutoff + this.beta * twist + this.betaWrist * swing;
      const a = OneEuro.alpha(cutoff, dt);
      const ang = _delta.length();
      if (ang > 1e-12) {
        _rk.copy(_delta).scale(1 / ang);
        rotateAbout(this.axis, _rk, a * ang, this.axis).normalize();
        rotateAbout(this.normal, _rk, a * ang, this.normal);
        this.normal.addScaled(this.axis, -this.normal.dot(this.axis)).normalize();
      }
    }
    frame.axis.copy(this.axis);
    frame.normal.copy(this.normal);
    return frame;
  }
}

const mkEuro = ([minCutoff, beta, dCutoff]) => new OneEuro(minCutoff, beta, dCutoff);

// ---------------------------------------------------------------------------

/**
 * @param {{hfovDeg?: number, userHeight?: number, handed?: 'right'|'left', filters?: object}} opts
 * @returns BodyTracker = { update(frame) -> BodySample|null, calibrate(sample?) -> boolean,
 *   setOptions(patch), reset(), calibration, last, options }
 */
export function createBodyTracker({
  hfovDeg = TRACKING.cameraPresets[TRACKING.defaultCamera].hfov,
  userHeight = PLAYER.defaultHeight,
  handed = 'right',
  filters = {},
} = {}) {
  const opts = { hfovDeg, userHeight, handed };
  const fp = { ...DEFAULT_FILTERS, ...filters };

  const calibration = { x0: 0, d0: 0, eyeHeight: 0, scale: 1, hipHeight: 0, ok: false };

  let dF = mkEuro(fp.distance);
  let xF = mkEuro(fp.lateral);
  const jointF = {};
  for (const name of JOINT_NAMES) {
    jointF[name] = new OneEuroVec(HAND_JOINTS.has(name) ? fp.hand : ELBOW_JOINTS.has(name) ? fp.elbow : fp.joint);
  }
  const handRotF = { L: new HandRotFilter(fp.handRot), R: new HandRotFilter(fp.handRot) };
  const hipYF = mkEuro(fp.vertical);
  const ankleYF = mkEuro(fp.vertical);

  const rawJ = {};
  let modelH = null; // smoothed model nose->ankle height
  let lastT = null; // seconds
  let last = null;
  let lastHipH = null;
  let room = { x: 0, d: 0 };
  let prevHipY = null, prevAnkleY = null, prevVT = null;
  let hipVy = 0, ankleVy = 0;
  let floorY = null;

  function resetFilters() {
    dF = mkEuro(fp.distance);
    xF = mkEuro(fp.lateral);
    for (const name of JOINT_NAMES) jointF[name].reset();
    handRotF.L.reset();
    handRotF.R.reset();
    hipYF.reset();
    ankleYF.reset();
    prevHipY = prevAnkleY = prevVT = null;
    hipVy = ankleVy = 0;
    floorY = null;
  }

  function currentScale() {
    if (calibration.ok) return calibration.scale;
    if (modelH) return scaleFromModel(modelH, opts.userHeight);
    return 1;
  }

  function update(frame) {
    const idx = selectPerson(frame, last);
    if (idx < 0) return null;
    const person = frame.people[idx];
    const lm = person.landmarks, world = person.world;
    if (!lm || !world || lm.length < 29 || world.length < 29) return null;

    const t = frame.t / 1000;
    if (lastT !== null && (t - lastT > LOST_RESET_S || t < lastT)) resetFilters();
    const dt = lastT === null ? 0 : t - lastT;
    lastT = t;

    const aspect = frame.width && frame.height ? frame.width / frame.height : 16 / 9;
    const fn = focalNorm(opts.hfovDeg);

    let conf = 0;
    for (const i of CONFIDENCE_JOINTS) conf += vis(lm[i]);
    conf /= CONFIDENCE_JOINTS.length;

    // Body scale: continuous estimate before calibration, frozen after.
    const nAnk = modelNoseToAnkle(world);
    if (nAnk !== null) modelH = modelH === null || dt <= 0 ? nAnk : damp(modelH, nAnk, 1.5, dt);
    const scale = currentScale();

    // Hip height from the ankles (keep the last value while the feet are out of view).
    const ankleVis = Math.min(vis(world[27]), vis(world[28]), vis(lm[27]), vis(lm[28]));
    let hipH;
    if (ankleVis >= 0.3) hipH = hipHeightFromWorld(world, scale);
    else hipH = lastHipH ?? (calibration.ok ? calibration.hipHeight : opts.userHeight * PLAYER.hipHeightRatio);
    lastHipH = hipH;

    // Room position: distance first, then lateral from the smoothed distance.
    const dRaw = estimateDistance(lm, world, opts.hfovDeg, aspect, scale);
    const hip = hipImage(lm);
    if (dRaw !== null && hip) {
      const d = dF.filter(dRaw, t);
      const x = xF.filter((-(hip.u - 0.5) * d) / fn, t);
      room = { x, d };
    } else room = { x: room.x, d: room.d };

    // Vertical motion from the image (world landmarks are hip-centred and cannot see jumps).
    let airborne = 0;
    let jump = false;
    if (hip && room.d > 0) {
      const hipY = hipYF.filter((-(hip.v - 0.5) / aspect / fn) * room.d, t);
      let ankleY = null;
      if (ankleVis >= 0.3) {
        const lowV = Math.max(lm[27].y, lm[28].y); // lower foot
        ankleY = ankleYF.filter((-(lowV - 0.5) / aspect / fn) * room.d, t);
      }
      if (prevVT !== null && t > prevVT) {
        const vdt = t - prevVT;
        hipVy = (hipY - prevHipY) / vdt;
        ankleVy = ankleY !== null && prevAnkleY !== null ? (ankleY - prevAnkleY) / vdt : 0;
      }
      prevHipY = hipY;
      prevAnkleY = ankleY;
      prevVT = t;
      if (ankleY !== null) {
        if (floorY === null) floorY = ankleY;
        else if (dt > 0) floorY = damp(floorY, ankleY, ankleY < floorY ? 6 : 0.5, dt);
        const lift = ankleY - floorY;
        airborne = Math.max(0, lift - AIRBORNE_DEADBAND);
        jump = (hipVy > JUMP_HIP_SPEED && (lift > 0.03 || ankleVy > 0.5)) || lift > 0.1;
      } else jump = hipVy > JUMP_HIP_SPEED * 1.5;
    }

    // Joints in U.
    toUserFrame(world, scale, hipH, rawJ);
    const joints = {};
    for (const name of JOINT_NAMES) {
      const v = jointF[name].filter(rawJ[name], t, new Vec3());
      v.y += airborne;
      joints[name] = v;
    }

    const hipHeight = (joints.hipL.y + joints.hipR.y) / 2 - airborne;
    const eyeHeight = (joints.eyeL.y + joints.eyeR.y) / 2;
    const hipRef = calibration.ok ? calibration.hipHeight : opts.userHeight * PLAYER.hipHeightRatio;
    const crouch = clamp(1 - hipHeight / hipRef, 0, 1);

    const handFrames = {
      L: handRotF.L.filter(
        computeHandFrame('L', joints.wristL, joints.indexL, joints.pinkyL, joints.thumbL, joints.elbowL), t, jointF.wristL.dx.length(),
      ),
      R: handRotF.R.filter(
        computeHandFrame('R', joints.wristR, joints.indexR, joints.pinkyR, joints.thumbR, joints.elbowR), t, jointF.wristR.dx.length(),
      ),
    };

    const sample = {
      t: frame.t,
      valid: conf >= TRACKING.minPoseConfidence && room.d > 0,
      confidence: conf,
      room,
      offset: calibration.ok ? { x: room.x - calibration.x0, d: room.d - calibration.d0 } : { x: 0, d: 0 },
      hipHeight,
      eyeHeight,
      crouch,
      joints,
      handFrames,
      dominant: opts.handed === 'left' ? 'L' : 'R',
      jump,
      // Extras (not in SPEC §4.2): see report.
      airborne,
      hipVy,
      scale,
      personIndex: idx,
      image: hip ? { hipU: hip.u, hipV: hip.v } : null,
    };
    last = sample;
    return sample;
  }

  /** Stores the neutral room position, standing eye/hip height and body scale. */
  function calibrate(sample = last) {
    if (!sample) return false;
    const newScale = modelH ? scaleFromModel(modelH, opts.userHeight) : sample.scale || 1;
    const r = newScale / (sample.scale || 1);
    calibration.scale = newScale;
    calibration.x0 = sample.room.x * r;
    calibration.d0 = sample.room.d * r;
    calibration.eyeHeight = (sample.eyeHeight - ANKLE_HEIGHT) * r + ANKLE_HEIGHT;
    calibration.hipHeight = (sample.hipHeight - ANKLE_HEIGHT) * r + ANKLE_HEIGHT;
    calibration.ok = true;
    if (r !== 1) {
      // Distances scale with the body scale; keep the smoothed state consistent.
      if (dF.x !== null) dF.x *= r;
      if (xF.x !== null) xF.x *= r;
      for (const name of JOINT_NAMES) jointF[name].reset();
      handRotF.L.reset();
      handRotF.R.reset();
      lastHipH = null;
    }
    return true;
  }

  function setOptions(patch = {}) {
    if (patch.hfovDeg !== undefined && patch.hfovDeg !== opts.hfovDeg) {
      const r = focalNorm(patch.hfovDeg) / focalNorm(opts.hfovDeg);
      opts.hfovDeg = patch.hfovDeg;
      if (calibration.ok) calibration.d0 *= r; // x = -(u-.5) d / f_n is invariant
      dF = mkEuro(fp.distance);
      xF = mkEuro(fp.lateral);
      floorY = null;
    }
    if (patch.userHeight !== undefined && patch.userHeight !== opts.userHeight) {
      const r = patch.userHeight / opts.userHeight;
      opts.userHeight = patch.userHeight;
      if (calibration.ok) {
        calibration.scale *= r;
        calibration.x0 *= r;
        calibration.d0 *= r;
        calibration.eyeHeight = (calibration.eyeHeight - ANKLE_HEIGHT) * r + ANKLE_HEIGHT;
        calibration.hipHeight = (calibration.hipHeight - ANKLE_HEIGHT) * r + ANKLE_HEIGHT;
      }
      resetFilters();
    }
    if (patch.handed !== undefined) opts.handed = patch.handed;
  }

  function reset() {
    resetFilters();
    for (const name of JOINT_NAMES) jointF[name].reset();
    last = null;
    lastT = null;
    lastHipH = null;
    modelH = null;
    room = { x: 0, d: 0 };
    calibration.ok = false;
    calibration.scale = 1;
  }

  return {
    update,
    calibrate,
    setOptions,
    reset,
    get calibration() {
      return calibration;
    },
    get last() {
      return last;
    },
    get options() {
      return { ...opts };
    },
  };
}
