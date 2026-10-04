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

/**
 * Side-on robustness (first real-world session: turning far left / right blacked out the view).
 * MediaPipe at 2-3 m from a MacBook camera, with the player turned side-on, overlaps shoulders and
 * hips in the image, collapses the hidden arm and hand, swaps left / right labels for a few
 * frames, and now and then returns a wild or non-finite landmark. Nothing of that may reach a
 * filter (a One Euro filter that ingests NaN stays NaN forever) or the view.
 *   worldMax / imageMax: plausible ranges of hip-centred world landmarks (model m) and normalised
 *     image coordinates; anything outside (or non-finite) is a missing landmark.
 *   jumpBody / jumpHand: largest believable change of a world landmark between two frames (model
 *     m; a smash moves the hand ~1 m per 30 fps frame); imageJump / imageJumpHand: the same in
 *     normalised image units (a smash crosses up to 0.6 of the picture per frame).
 *     A bigger jump is held for up to spikeFrames frames, then accepted as real.
 *   swapRatio / swapMin: a left/right label group is swapped back when the swapped assignment is
 *     this much closer to the previous frame (and the plain one moved at least swapMin m per pair).
 *   sideOnDeg: torso yaw beyond which the width segments (shoulders, hips) leave the distance
 *     estimate; roomJump: largest believable change of room x / d per frame (m) + roomRate * dt.
 */
export const ROBUST = Object.freeze({
  worldMax: 2.5,
  imageMax: 2.5,
  jumpBody: 0.45,
  jumpHand: 1.5,
  imageJump: 0.3,
  imageJumpHand: 0.9,
  spikeFrames: 2,
  swapRatio: 0.5,
  swapMin: 0.04,
  sideOnDeg: 55,
  roomJump: 0.3,
  roomRate: 3,
});

const SWAP_GROUPS = Object.freeze([
  Object.freeze([[1, 4], [2, 5], [3, 6], [7, 8], [9, 10]]), // face
  Object.freeze([[11, 12], [13, 14], [15, 16], [17, 18], [19, 20], [21, 22]]), // arms
  Object.freeze([[23, 24], [25, 26], [27, 28], [29, 30], [31, 32]]), // legs
]);
const HAND_LANDMARKS = new Set([15, 16, 17, 18, 19, 20, 21, 22]);
/** [child, parent, longest plausible distance (model m, any adult)], parents before children. */
const BONES = Object.freeze([
  [13, 11, 0.5], [14, 12, 0.5], [15, 13, 0.45], [16, 14, 0.45],
  [17, 15, 0.25], [19, 15, 0.25], [21, 15, 0.22], [18, 16, 0.25], [20, 16, 0.25], [22, 16, 0.22],
  [25, 23, 0.65], [26, 24, 0.65], [27, 25, 0.65], [28, 26, 0.65],
]);
const CORE = [11, 12, 23, 24];
const isNum = Number.isFinite;

/** Smoothing-factor scale of an occluded (in-picture, low-visibility) landmark. */
export const OCCLUDED_TRUST = 0.25;
/** Trust of a sanitised image landmark: 1 when visible or outside the picture, down to OCCLUDED_TRUST when hidden inside it. */
export function landmarkTrust(l) {
  if (!l) return 1;
  const inside = l.x > 0.02 && l.x < 0.98 && l.y > 0.02 && l.y < 0.98;
  if (!inside) return 1;
  const v = clamp((l.visibility - 0.1) / 0.4, 0, 1);
  return OCCLUDED_TRUST + (1 - OCCLUDED_TRUST) * v * v * (3 - 2 * v);
}

const sq = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;

/**
 * Left / right label swap test for one group against the previous (accepted) world landmarks:
 * true when swapping every pair of the group fits the previous frame much better.
 */
export function groupSwapped(world, prev, pairs, { ratio = ROBUST.swapRatio, min = ROBUST.swapMin } = {}) {
  let same = 0, swap = 0;
  for (const [a, b] of pairs) {
    same += sq(world[a], prev[a]) + sq(world[b], prev[b]);
    swap += sq(world[b], prev[a]) + sq(world[a], prev[b]);
  }
  return same > pairs.length * 2 * min * min && swap < ratio * same;
}

/**
 * Facing-camera prior: a player who faces the TV has their left shoulder and hip on the image
 * right (world +x) and the nose in front of the shoulders. When the frame clearly faces the
 * camera but the labels say otherwise, they are swapped. null when the frame is not frontal enough
 * to tell.
 */
export function frontalSwapped(world) {
  const sL = world[11], sR = world[12], hL = world[23], hR = world[24], n = world[0];
  const sdx = sL.x - sR.x, hdx = hL.x - hR.x;
  const sz = Math.abs(sL.z - sR.z);
  // Frontal: shoulders mostly across the image (yaw < ~40 deg) and the nose toward the camera.
  if (Math.abs(sdx) < 0.2 || sz > 0.75 * Math.abs(sdx)) return null;
  if (!(n.z < (sL.z + sR.z) / 2 - 0.03)) return null;
  if (sdx < 0 && hdx < 0) return true;
  if (sdx > 0 && hdx > 0) return false;
  return null;
}

/** Torso yaw (deg) from world landmarks: 0 = facing the camera, + = turned to face the player's right. */
export function torsoYawDeg(world) {
  // In U: x = -world.x, z = -world.z. Right-minus-left of shoulders and hips.
  const vx = -(world[12].x - world[11].x) - (world[24].x - world[23].x);
  const vz = -(world[12].z - world[11].z) - (world[24].z - world[23].z);
  if (Math.abs(vx) + Math.abs(vz) < 1e-6) return 0;
  return Math.atan2(-vz, vx) / DEG;
}

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
 *
 * Degenerate palm (side-on play: the hand is edge-on or hidden behind the body and MediaPipe
 * collapses index / pinky onto the wrist, or their visibility drops): the palm normal of a
 * near-zero cross product is noise that flips the racket face from frame to frame. The frame
 * then falls back to the forearm (elbow -> wrist) as the hand direction and keeps the previous
 * palm direction (opts.prevNormal) turned perpendicular to it; out.degenerate is set.
 * @param {'L'|'R'} side
 * @param {{ prevNormal?: {x,y,z}|null, palmVis?: number, handLength?: number }} [opts]
 *   palmVis: visibility of the hand landmarks (0..1); handLength: nominal wrist -> knuckles (m)
 */
export function computeHandFrame(side, wrist, index, pinky, thumb, elbow, out = createHandFrame(), opts = null) {
  _pw.subVectors(pinky, wrist);
  _iw.subVectors(index, wrist);
  if (side === 'L') _k.crossVectors(_iw, _pw);
  else _k.crossVectors(_pw, _iw);
  _mid.addVectors(index, pinky).scale(0.5);
  _h.subVectors(_mid, wrist);
  let handLen = _h.length();
  // Forearm direction (needed by the blend and by the degenerate fallback).
  let foreOk = false;
  if (elbow) {
    _f.subVectors(wrist, elbow);
    foreOk = _f.lengthSq() > HAND_DEGENERATE.foreMin * HAND_DEGENERATE.foreMin;
  }
  const nominal = opts && opts.handLength > 0 ? opts.handLength : 0.09;
  const palmArea = _k.length() / Math.max(1e-12, _pw.length() * _iw.length()); // sin of the knuckle spread angle
  const degenerate = !!opts && (handLen < HAND_DEGENERATE.lenFrac * nominal || !(palmArea >= HAND_DEGENERATE.minSin)
    || (opts.palmVis !== undefined && opts.palmVis < HAND_DEGENERATE.minVis && palmArea < HAND_DEGENERATE.lowVisSin));
  out.degenerate = degenerate;
  if (degenerate) {
    // Hand along the forearm; palm direction carried over from the previous frame.
    if (foreOk) _h.copy(_f).normalize();
    else if (handLen > 1e-6) _h.scale(1 / handLen);
    else _h.set(0, 1, 0);
    handLen = nominal;
    if (opts.prevNormal && Number.isFinite(opts.prevNormal.x)) _k.copy(opts.prevNormal);
    else _k.set(0, 0, 1);
  } else if (handLen < 1e-6) _h.set(0, 1, 0);
  else _h.scale(1 / handLen);

  if (_k.lengthSq() < 1e-14) {
    // Degenerate hand (collapsed landmarks): assume the palm faces the camera.
    _k.set(0, 0, 1);
  }
  _k.projectOnPlane(_h);
  if (_k.lengthSq() < 1e-14) _k.set(side === 'L' ? -1 : 1, 0, 0).projectOnPlane(_h);
  if (_k.lengthSq() < 1e-14) _k.set(0, 0, 1).projectOnPlane(_h);
  _k.normalize();

  if (elbow && foreOk) _f.normalize();
  else if (elbow && _f.lengthSq() >= 1e-10) _f.normalize();
  else _f.copy(_h);
  _b.copy(_h).lerp(_f, FOREARM_BLEND);
  if (_b.lengthSq() < 1e-10) _b.copy(_h);
  _b.normalize();

  out.grip.copy(wrist).addScaled(_h, GRIP_ALONG * handLen).addScaled(_k, GRIP_PALM_OFFSET);

  // Thumb side: the part of (thumb - wrist) perpendicular to both palmDir and handDir.
  _kb.crossVectors(_k, _b);
  let sign = side === 'L' ? -1 : 1;
  if (thumb && !degenerate) {
    _t.subVectors(thumb, wrist).projectOnPlane(_k).projectOnPlane(_h);
    const d = _t.dot(_kb);
    if (_t.lengthSq() > 1e-8 && Math.abs(d) > 1e-6) sign = d > 0 ? 1 : -1;
  }
  rotateAbout(_b, _k, sign * GRIP_RADIAL_DEG * DEG, out.axis).normalize();
  out.normal.copy(_k).addScaled(out.axis, -_k.dot(out.axis)).normalize();
  return out;
}

/**
 * When a palm counts as degenerate (computeHandFrame with opts): knuckle midpoint closer to the
 * wrist than lenFrac x the nominal hand length, knuckle spread angle with sin below minSin, or a
 * hidden hand (visibility below minVis) whose spread is below lowVisSin. A hand that is merely out
 * of the picture (an overhead) keeps plausible landmarks and stays in use. foreMin: shortest
 * usable forearm (m).
 */
export const HAND_DEGENERATE = Object.freeze({ lenFrac: 0.3, minSin: 0.08, minVis: 0.15, lowVisSin: 0.2, foreMin: 0.05 });

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
export function estimateDistance(landmarks, world, hfovDeg, aspect, scale, { sideOn = false } = {}) {
  const fn = focalNorm(hfovDeg);
  let n = 0;
  for (let s = 0; s < DISTANCE_SEGMENTS.length; s++) {
    // Side-on, the shoulder and hip widths are foreshortened to a few cm in the image and their
    // world length rests on MediaPipe's depth guess: torso sides and thighs carry the estimate.
    if (sideOn && s < 2) continue;
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
    const di = (fn * lw) / li - dz;
    if (!(di > 0.3 && di < 30) || !(w > 0)) continue; // non-finite / impossible
    _segD[n] = di;
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

  /** trust (0..1]: scales the smoothing factor (occluded landmarks follow the measurement slowly). */
  filter(v, t, out, trust = 1) {
    // Never ingest a non-finite sample (it would poison the state for good); a state that went
    // non-finite anyway restarts from the measurement.
    if (!(isNum(v.x) && isNum(v.y) && isNum(v.z)) || !isNum(t)) return this.t === null ? out.copy(v) : out.copy(this.x);
    if (this.t !== null && !(isNum(this.x.x) && isNum(this.x.y) && isNum(this.x.z) && isNum(this.dx.x) && isNum(this.dx.y) && isNum(this.dx.z))) this.t = null;
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
    const a = OneEuro.alpha(this.minCutoff + this.beta * this.dx.length(), dt) * trust;
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
    this.w.set(0, 0, 0);
  }

  /** Filters frame.axis / frame.normal in place; wristSpeed (m/s) opens the filter during swings. */
  filter(frame, t, wristSpeed = 0, trust = 1) {
    const fa = frame.axis, fnn = frame.normal;
    const inOk = isNum(fa.x) && isNum(fa.y) && isNum(fa.z) && isNum(fnn.x) && isNum(fnn.y) && isNum(fnn.z)
      && fa.lengthSq() > 0.5 && fnn.lengthSq() > 0.5 && isNum(t);
    if (!inOk) {
      // Keep the last good orientation (or a neutral one) instead of passing garbage on.
      frame.axis.copy(this.axis);
      frame.normal.copy(this.normal);
      return frame;
    }
    if (!isNum(wristSpeed)) wristSpeed = 0;
    if (this.t !== null && !(isNum(this.axis.x) && isNum(this.axis.y) && isNum(this.axis.z) && isNum(this.normal.x)
      && isNum(this.normal.y) && isNum(this.normal.z) && isNum(this.w.x) && isNum(this.w.y) && isNum(this.w.z))) this.t = null;
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
      const a = OneEuro.alpha(cutoff, dt) * trust;
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

/** Scalar One Euro step that never ingests (or keeps) a non-finite value. */
function euro(f, v, t) {
  if (!isNum(v) || !isNum(t)) return f.x;
  if (f.x !== null && !(isNum(f.x) && isNum(f.dx))) f.reset();
  const r = f.filter(v, t);
  if (isNum(r)) return r;
  f.reset();
  return f.filter(v, t);
}

const blankLm = () => ({ x: 0, y: 0, z: 0, visibility: 0 });

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
    forgetLandmarks();
  }

  function currentScale() {
    if (calibration.ok) return calibration.scale;
    if (modelH) return scaleFromModel(modelH, opts.userHeight);
    return 1;
  }

  // --- side-on robustness (ROBUST): sanitised landmark copies, the last accepted (de-swapped)
  // landmarks, per-landmark spike counters and diagnostics counters.
  const cleanLm = Array.from({ length: 33 }, blankLm);
  const cleanW = Array.from({ length: 33 }, blankLm);
  const prevLm = Array.from({ length: 33 }, blankLm);
  const prevW = Array.from({ length: 33 }, blankLm);
  const okFlag = new Uint8Array(33);
  const known = new Uint8Array(33);
  const spikes = new Uint8Array(33);
  let havePrev = false;
  let roomSpikes = 0;
  let lastDRaw = null, lastXRaw = null;
  const stats = {
    frames: 0, dropped: 0, rejectedLandmarks: 0, spikes: 0, swaps: 0, frontalSwaps: 0, degenerateHands: 0,
    roomHeld: 0, sideOnFrames: 0, nonFinite: 0,
  };
  const copyLm = (d, q) => {
    d.x = q.x; d.y = q.y; d.z = q.z; d.visibility = q.visibility;
  };
  function swapGroup(pairs) {
    for (const arr of [cleanLm, cleanW]) {
      for (const [i, j] of pairs) {
        const tmp = arr[i];
        arr[i] = arr[j];
        arr[j] = tmp;
      }
    }
    for (const [i, j] of pairs) {
      const o = okFlag[i];
      okFlag[i] = okFlag[j];
      okFlag[j] = o;
    }
  }

  /**
   * Copies the person's landmarks into cleanLm / cleanW: non-finite or out-of-range landmarks are
   * replaced by the last accepted ones (visibility 0), left / right label swaps are undone by
   * temporal continuity and the facing-camera prior, single-frame spikes are held. false when the
   * frame cannot be used (core landmarks missing with nothing to hold).
   */
  function sanitize(person, dt) {
    const lm = person.landmarks, world = person.world;
    for (let i = 0; i < 33; i++) {
      const a = lm[i], b = world[i], cl = cleanLm[i], cw = cleanW[i];
      const ok = !!(a && b) && isNum(a.x) && isNum(a.y) && isNum(b.x) && isNum(b.y) && isNum(b.z)
        && Math.abs(a.x - 0.5) < ROBUST.imageMax && Math.abs(a.y - 0.5) < ROBUST.imageMax
        && Math.abs(b.x) < ROBUST.worldMax && Math.abs(b.y) < ROBUST.worldMax && Math.abs(b.z) < ROBUST.worldMax;
      okFlag[i] = ok ? 1 : 0;
      if (ok) {
        const va = vis(a), vb = vis(b);
        cl.x = a.x; cl.y = a.y; cl.z = isNum(a.z) ? a.z : 0;
        cl.visibility = isNum(va) ? clamp(va, 0, 1) : 0;
        cw.x = b.x; cw.y = b.y; cw.z = b.z;
        cw.visibility = isNum(vb) ? clamp(vb, 0, 1) : 0;
      } else {
        stats.rejectedLandmarks++;
        if (known[i]) {
          copyLm(cl, prevLm[i]);
          copyLm(cw, prevW[i]);
        } else {
          cl.x = cl.y = 0.5; cl.z = 0;
          cw.x = cw.y = cw.z = 0;
        }
        cl.visibility = cw.visibility = 0;
      }
    }
    for (const i of CORE) if (!okFlag[i] && !known[i]) return false;
    // Label swaps: continuity with the previous frame per group, then the facing-camera prior.
    if (havePrev) {
      for (const g of SWAP_GROUPS) {
        if (groupSwapped(cleanW, prevW, g)) {
          swapGroup(g);
          stats.swaps++;
        }
      }
    }
    if (frontalSwapped(cleanW) === true) {
      for (const g of SWAP_GROUPS) swapGroup(g);
      stats.frontalSwaps++;
    }
    // Spikes: a landmark that jumps further than a body can move in one frame is held.
    const k = Math.max(1, (dt > 0 ? dt : 0) / 0.034);
    for (let i = 0; i < 33; i++) {
      const cl = cleanLm[i], cw = cleanW[i];
      if (havePrev && known[i] && okFlag[i]) {
        const hand = HAND_LANDMARKS.has(i);
        const lim = (hand ? ROBUST.jumpHand : ROBUST.jumpBody) * k;
        const limI = (hand ? ROBUST.imageJumpHand : ROBUST.imageJump) * k;
        const pl = prevLm[i], pw = prevW[i];
        const jump = Math.sqrt(sq(cw, pw)) > lim || Math.hypot(cl.x - pl.x, cl.y - pl.y) > limI;
        if (jump && spikes[i] < ROBUST.spikeFrames) {
          spikes[i]++;
          stats.spikes++;
          const v = Math.min(cl.visibility, pl.visibility);
          copyLm(cl, pl);
          copyLm(cw, pw);
          cl.visibility = cw.visibility = v;
          continue;
        }
        spikes[i] = 0;
      }
      if (okFlag[i] || known[i]) {
        copyLm(prevLm[i], cl);
        copyLm(prevW[i], cw);
        if (okFlag[i]) {
          // Keep the measured visibility for the next comparison.
          known[i] = 1;
        }
      }
    }
    // Anatomy: a landmark further from its parent joint than any body allows is a wild guess
    // (single-frame hand outliers survive the jump test during fast swings): it is held, or pulled
    // in to the longest plausible bone when there is nothing to hold.
    for (const [c, p, maxLen] of BONES) {
      const cw = cleanW[c], pw = cleanW[p];
      const l = Math.sqrt(sq(cw, pw));
      if (l <= maxLen) continue;
      stats.spikes++;
      if (known[c] && Math.sqrt(sq(prevW[c], pw)) <= maxLen) {
        copyLm(cw, prevW[c]);
        copyLm(cleanLm[c], prevLm[c]);
      } else {
        const f = maxLen / l;
        cw.x = pw.x + (cw.x - pw.x) * f;
        cw.y = pw.y + (cw.y - pw.y) * f;
        cw.z = pw.z + (cw.z - pw.z) * f;
      }
      cw.visibility = Math.min(cw.visibility, 0.3);
      copyLm(prevW[c], cw);
      copyLm(prevLm[c], cleanLm[c]);
    }
    havePrev = true;
    return true;
  }

  function forgetLandmarks() {
    havePrev = false;
    known.fill(0);
    spikes.fill(0);
    roomSpikes = 0;
    lastDRaw = lastXRaw = null;
  }

  const finiteV = (v) => isNum(v.x) && isNum(v.y) && isNum(v.z);

  function update(frame) {
    stats.frames++;
    const idx = selectPerson(frame, last);
    if (idx < 0) return null;
    const person = frame.people[idx];
    if (!person || !person.landmarks || !person.world || person.landmarks.length < 29 || person.world.length < 29) return null;

    const t = frame.t / 1000;
    if (!isNum(t)) {
      stats.dropped++;
      return null;
    }
    if (lastT !== null && (t - lastT > LOST_RESET_S || t < lastT)) resetFilters();
    const dt = lastT === null ? 0 : t - lastT;
    if (!sanitize(person, dt)) {
      stats.dropped++;
      return null;
    }
    lastT = t;
    const lm = cleanLm, world = cleanW;

    const aspect = frame.width > 0 && frame.height > 0 ? frame.width / frame.height : 16 / 9;
    const fn = focalNorm(opts.hfovDeg);

    let conf = 0;
    for (const i of CONFIDENCE_JOINTS) conf += vis(lm[i]);
    conf /= CONFIDENCE_JOINTS.length;

    // Torso yaw: side-on frames rely on the torso sides and thighs for distance.
    const yawDeg = torsoYawDeg(world);
    const sideOn = Math.abs(yawDeg) > ROBUST.sideOnDeg;
    if (sideOn) stats.sideOnFrames++;

    // Body scale: continuous estimate before calibration, frozen after.
    const nAnk = modelNoseToAnkle(world);
    if (nAnk !== null && isNum(nAnk)) modelH = modelH === null || dt <= 0 ? nAnk : damp(modelH, nAnk, 1.5, dt);
    const scale = currentScale();

    // Hip height from the ankles (keep the last value while the feet are out of view).
    const ankleVis = Math.min(vis(world[27]), vis(world[28]), vis(lm[27]), vis(lm[28]));
    let hipH;
    if (ankleVis >= 0.3) hipH = hipHeightFromWorld(world, scale);
    else hipH = lastHipH ?? (calibration.ok ? calibration.hipHeight : opts.userHeight * PLAYER.hipHeightRatio);
    if (!isNum(hipH)) hipH = lastHipH ?? opts.userHeight * PLAYER.hipHeightRatio;
    lastHipH = hipH;

    // Room position: distance first, then lateral from the smoothed distance. A step that no
    // person can make in one frame (a wild landmark, a lost label) is held for up to
    // ROBUST.spikeFrames frames.
    const dRaw = estimateDistance(lm, world, opts.hfovDeg, aspect, scale, { sideOn });
    const hip = hipImage(lm);
    if (dRaw !== null && hip) {
      const xRaw = (-(hip.u - 0.5) * dRaw) / fn;
      const lim = ROBUST.roomJump + ROBUST.roomRate * Math.max(0, dt);
      const spike = lastDRaw !== null && (Math.abs(dRaw - lastDRaw) > lim || Math.abs(xRaw - lastXRaw) > lim);
      if (spike && roomSpikes < ROBUST.spikeFrames) {
        roomSpikes++;
        stats.roomHeld++;
        room = { x: room.x, d: room.d };
      } else {
        roomSpikes = 0;
        lastDRaw = dRaw;
        lastXRaw = xRaw;
        const d = euro(dF, dRaw, t);
        const x = euro(xF, (-(hip.u - 0.5) * d) / fn, t);
        room = isNum(d) && isNum(x) ? { x, d } : { x: room.x, d: room.d };
      }
    } else room = { x: room.x, d: room.d };

    // Vertical motion from the image (world landmarks are hip-centred and cannot see jumps).
    let airborne = 0;
    let jump = false;
    if (hip && room.d > 0) {
      const hipY = euro(hipYF, (-(hip.v - 0.5) / aspect / fn) * room.d, t);
      let ankleY = null;
      if (ankleVis >= 0.3) {
        const lowV = Math.max(lm[27].y, lm[28].y); // lower foot
        ankleY = euro(ankleYF, (-(lowV - 0.5) / aspect / fn) * room.d, t);
      }
      if (prevVT !== null && t > prevVT && isNum(prevHipY)) {
        const vdt = t - prevVT;
        hipVy = (hipY - prevHipY) / vdt;
        ankleVy = ankleY !== null && prevAnkleY !== null ? (ankleY - prevAnkleY) / vdt : 0;
      }
      if (!isNum(hipVy)) hipVy = 0;
      if (!isNum(ankleVy)) ankleVy = 0;
      prevHipY = hipY;
      prevAnkleY = ankleY;
      prevVT = t;
      if (ankleY !== null && isNum(ankleY)) {
        if (floorY === null || !isNum(floorY)) floorY = ankleY;
        else if (dt > 0) floorY = damp(floorY, ankleY, ankleY < floorY ? 6 : 0.5, dt);
        const lift = ankleY - floorY;
        airborne = Math.max(0, lift - AIRBORNE_DEADBAND);
        jump = (hipVy > JUMP_HIP_SPEED && (lift > 0.03 || ankleVy > 0.5)) || lift > 0.1;
      } else jump = hipVy > JUMP_HIP_SPEED * 1.5;
    }
    if (!isNum(airborne)) airborne = 0;

    // Joints in U. An arm landmark MediaPipe reports as hidden while it is inside the picture
    // (side-on: the far arm behind the torso) is a guess that wanders frame to frame; it is
    // followed with OCCLUDED_TRUST of the usual smoothing factor. A hand that is merely out of the
    // picture (overheads) is extrapolated plausibly and keeps full trust.
    toUserFrame(world, scale, hipH, rawJ);
    const joints = {};
    for (const name of JOINT_NAMES) {
      const li = JOINT_INDEX[name];
      const v = jointF[name].filter(rawJ[name], t, new Vec3(), li >= 13 && li <= 22 ? landmarkTrust(lm[li]) : 1);
      v.y += airborne;
      joints[name] = v;
    }

    const hipHeight = (joints.hipL.y + joints.hipR.y) / 2 - airborne;
    const eyeHeight = (joints.eyeL.y + joints.eyeR.y) / 2;
    const hipRef = calibration.ok ? calibration.hipHeight : opts.userHeight * PLAYER.hipHeightRatio;
    const crouch = clamp(1 - hipHeight / hipRef, 0, 1);

    // Hand frames; a degenerate palm (edge-on / hidden hand) keeps the previous palm direction.
    const handLength = 0.09 * (opts.userHeight / PLAYER.defaultHeight);
    const handFrame = (side) => {
      const ii = side === 'L' ? [19, 17] : [20, 18];
      const palmVis = Math.min(lm[ii[0]].visibility, lm[ii[1]].visibility);
      const rf = handRotF[side];
      const hf = computeHandFrame(side, joints['wrist' + side], joints['index' + side], joints['pinky' + side], joints['thumb' + side], joints['elbow' + side],
        createHandFrame(), { prevNormal: rf.t !== null ? rf.normal : null, palmVis, handLength });
      if (hf.degenerate) stats.degenerateHands++;
      const out = rf.filter(hf, t, jointF['wrist' + side].dx.length(), Math.min(landmarkTrust(lm[ii[0]]), landmarkTrust(lm[ii[1]])));
      out.degenerate = hf.degenerate;
      return out;
    };
    const handFrames = { L: handFrame('L'), R: handFrame('R') };

    // Last line of defence: nothing non-finite leaves the tracker.
    let finite = isNum(room.x) && isNum(room.d) && isNum(eyeHeight) && isNum(hipHeight);
    for (const name of JOINT_NAMES) finite = finite && finiteV(joints[name]);
    for (const side of ['L', 'R']) {
      const hf = handFrames[side];
      finite = finite && finiteV(hf.grip) && finiteV(hf.axis) && finiteV(hf.normal);
    }
    if (!finite) {
      stats.nonFinite++;
      resetFilters();
      return null;
    }

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
      // Side-on robustness (ROBUST): torso yaw (deg, + = facing the player's right) and its flag.
      yawDeg,
      sideOn,
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
    /** Robustness counters (rejected / held landmarks, label swaps, degenerate hands, held room). */
    get stats() {
      return { ...stats };
    },
    get options() {
      return { ...opts };
    },
  };
}
