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
// Close mode: the hips are often out of the picture and the hands leave it in overheads.
const CONFIDENCE_UPPER = [0, 11, 12, 13, 14];

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
/** Hand rotation filter noise floors: k x the median over the last `window` frames (HandRotFilter). */
export const HAND_NOISE = Object.freeze({ k: 1.6, window: 45 });
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

/** A landmark inside the picture (normalised image coordinates), `margin` from the edges. */
export function inPicture(l, margin = 0) {
  return !!l && l.x >= margin && l.x <= 1 - margin && l.y >= margin && l.y <= 1 - margin;
}
// Image landmarks beyond the frame are MediaPipe's guesses (a cropped player's legs): their
// image length says nothing about the distance.
const ON_PICTURE = -0.005;

/**
 * Raw (unsmoothed) distance from the camera along its axis to the hip center, in meters.
 * For each segment: d_i = f_n * |world_xy| * scale / |image| (image y scaled by height/width),
 * corrected by the segment's mean depth offset from the hips; visibility-weighted median.
 * Segments with an end outside the picture are skipped (guessed landmarks).
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
    if (!inPicture(la, ON_PICTURE) || !inPicture(lb, ON_PICTURE)) continue;
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

// ---------------------------------------------------------------------------
// Close mode: the upper body only (round 4)

/**
 * Close mode (round 4, first real sessions: "needing to see feet too makes you stand very far; if
 * it can just see the upper body, base movement on that"). At 1.3–2.2 m from a MacBook camera only
 * the head, shoulders and arms (hips optional) are in the picture; MediaPipe still returns every
 * landmark, guessing the legs (low visibility, a straight standing pose, positions beyond the
 * frame). Every frame the tracker decides whether the legs are usable and estimates with the whole
 * body ('full') or the upper body ('upper'):
 *  - distance: shoulder width, ear and outer-eye spacing, neck, shoulder -> ear and (hips in the
 *    picture) the torso sides, each weighted by visibility, by how much of it lies in the image
 *    plane (a turned body foreshortens it: weight x cos^2) and by its length (never a ratio of a
 *    few pixels), weighted median (estimateDistanceUpper);
 *  - lateral: the shoulder centre, moved to the hip centre with the model's own offset;
 *  - height: the camera's height above the floor is learned (full-body frames, calibration), and
 *    the hip height follows the shoulders' and eyes' height in the picture at their own depth
 *    (distance-compensated): crouches and jumps come from the head and shoulders. Leg joints are a
 *    plausible standing / crouching pose.
 * Switching has hysteresis (legs usable for toFull s before 'full', unusable for toUpper s before
 * 'upper') and a C1 crossfade of `blend` s. While both estimates are available the upper one's
 * bias against the full one (distance ratio, lateral offset, camera height) is learned, so a
 * switch does not move the player. The U frame is the same in both modes.
 *   legVis / margin: visibility and image margin of a usable landmark;
 *   biasRate / camRate: learning rates (1/s) of the upper-vs-full bias and the camera height;
 *   torsoRatio / shoulderRatio: model shoulder-centre -> hip-centre length and shoulder width as a
 *     share of the model nose -> ankle height (body scale without feet; SPEC §4.2 anthropometry).
 */
export const CLOSE = Object.freeze({
  legVis: 0.5,
  margin: 0.01,
  toFull: 0.35,
  toUpper: 0.15,
  blend: 0.45,
  biasRate: 0.8,
  camRate: 1.5,
  torsoRatio: 0.3328,
  shoulderRatio: 0.2377,
  minWorld: 0.04,
  minImage: 0.012,
});
/** Ideal distance ranges (m) of the two tracking modes, for the calibration meter. */
export const DISTANCE_RANGES = Object.freeze({ upper: Object.freeze([1.3, 2.2]), full: Object.freeze([2.2, 3.5]) });

const LEG_IDX = [23, 24, 25, 26, 27, 28];
const SHOULDER_IDX = [11, 12];
const HEAD_IDX = [0, 2, 5, 7, 8];

function partUsable(lm, idx, minVis, margin) {
  for (const i of idx) {
    const l = lm[i];
    if (!l || !(vis(l) >= minVis) || !inPicture(l, margin)) return false;
  }
  return true;
}

function anyUsable(lm, idx, minVis, margin) {
  for (const i of idx) {
    const l = lm[i];
    if (l && vis(l) >= minVis && inPicture(l, margin)) return true;
  }
  return false;
}

/** Legs (hips, knees, ankles) in the picture and confidently seen: whole-body estimation works. */
export function legsUsable(landmarks) {
  return partUsable(landmarks, LEG_IDX, CLOSE.legVis, CLOSE.margin);
}

/** Shoulders and some of the head in the picture: upper-body estimation works. */
export function upperUsable(landmarks) {
  return partUsable(landmarks, SHOULDER_IDX, CLOSE.legVis, CLOSE.margin) && anyUsable(landmarks, HEAD_IDX, CLOSE.legVis, CLOSE.margin);
}

// [a, b, gain]: shoulder width, ears, outer eye corners, shoulder -> ear (a diagonal survives
// turning), torso sides and thighs (with the hips / knees in the picture).
// Torso sides and thighs count only while their ends are in the picture and seen.
const UPPER_SEGMENTS = Object.freeze([
  [11, 12, 1], [7, 8, 0.7], [3, 6, 0.5], [11, 7, 0.6], [12, 8, 0.6], [11, 23, 0.8], [12, 24, 0.8], [23, 25, 0.6], [24, 26, 0.6],
]);
const _uD = new Float64Array(UPPER_SEGMENTS.length + 1);
const _uW = new Float64Array(UPPER_SEGMENTS.length + 1);
const _mA = { x: 0, y: 0, z: 0, visibility: 0 }, _mB = { x: 0, y: 0, z: 0, visibility: 0 };
const _mWA = { x: 0, y: 0, z: 0, visibility: 0 }, _mWB = { x: 0, y: 0, z: 0, visibility: 0 };
const midInto = (o, a, b) => {
  o.x = (a.x + b.x) / 2; o.y = (a.y + b.y) / 2; o.z = ((a.z || 0) + (b.z || 0)) / 2;
  o.visibility = Math.min(vis(a), vis(b));
  return o;
};

/**
 * Raw distance (camera -> hip centre, m) from the upper body only (CLOSE): pinhole ratios of the
 * shoulder width, ear and outer-eye spacing, the neck (shoulder centre -> ear centre), shoulder ->
 * ear and, with `hips`, the torso sides; weights = visibility x (in-plane share)^2 x length /
 * (length + 5 cm) x the segment's gain; weighted median. Ends outside the picture are skipped.
 * @returns {number|null}
 */
export function estimateDistanceUpper(landmarks, world, hfovDeg, aspect, scale, { hips = true } = {}) {
  const fn = focalNorm(hfovDeg);
  let n = 0;
  const seg = (la, lb, wa, wb, gain) => {
    if (!la || !lb || !wa || !wb) return;
    const v = Math.min(vis(la), vis(lb), vis(wa), vis(wb));
    if (!(v >= 0.3) || !inPicture(la, 0) || !inPicture(lb, 0)) return;
    const wx = (wa.x - wb.x) * scale, wy = (wa.y - wb.y) * scale, wz = (wa.z - wb.z) * scale;
    const lw = Math.hypot(wx, wy);
    const l3 = Math.hypot(lw, wz);
    const li = Math.hypot(la.x - lb.x, (la.y - lb.y) / aspect);
    if (lw < CLOSE.minWorld || li < CLOSE.minImage || !(l3 > 0)) return;
    const dz = clamp((scale * (wa.z + wb.z)) / 2, -0.5, 0.5);
    const di = (fn * lw) / li - dz;
    if (!(di > 0.3 && di < 30)) return;
    const flat = lw / l3;
    _uD[n] = di;
    _uW[n] = gain * v * flat * flat * (lw / (lw + 0.05));
    n++;
  };
  for (const [a, b, gain] of UPPER_SEGMENTS) {
    if (!hips && a >= 23) continue;
    seg(landmarks[a], landmarks[b], world[a], world[b], gain);
  }
  // Neck: shoulder centre -> ear centre (nearly vertical: turning does not shorten it).
  if (landmarks[11] && landmarks[12] && landmarks[7] && landmarks[8]) {
    seg(midInto(_mA, landmarks[11], landmarks[12]), midInto(_mB, landmarks[7], landmarks[8]),
      midInto(_mWA, world[11], world[12]), midInto(_mWB, world[7], world[8]), 0.6);
  }
  if (n === 0) return null;
  return weightedMedian(_uD, _uW, n);
}

/**
 * Model nose -> ankle height (the body scale reference) from the upper body: torso length /
 * torsoRatio and shoulder width / shoulderRatio (3D lengths: turning does not change them).
 */
export function modelHeightUpper(world, landmarks) {
  const sm = midInto(_mWA, world[11], world[12]), hm = midInto(_mWB, world[23], world[24]);
  let sum = 0, wsum = 0;
  const torso = Math.hypot(sm.x - hm.x, sm.y - hm.y, sm.z - hm.z);
  if (torso > 0.15 && torso < 1.2) { sum += (2 * torso) / CLOSE.torsoRatio; wsum += 2; }
  const a = world[11], b = world[12];
  if (vis(landmarks[11]) >= 0.5 && vis(landmarks[12]) >= 0.5) {
    const sw = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    if (sw > 0.12 && sw < 0.8) { sum += sw / CLOSE.shoulderRatio; wsum += 1; }
  }
  return wsum > 0 ? sum / wsum : null;
}

/**
 * Upper-body geometry for a camera pitched up by `tilt` rad (a MacBook lid tilted back), from the
 * optical depth of the hip centre (dOpt: what the pinhole size ratios measure) and the image
 * heights of the shoulder and eye centres. MediaPipe's world landmarks are camera-aligned, so the
 * hip centre is placed in camera coordinates (forward zc, up) from each point and the model's
 * offset to it, then turned level:
 *   d      horizontal camera -> hip-centre distance (m) = zc cos(t) - up sin(t);
 *   x      lateral position of the hip centre (m; the camera's x axis is level);
 *   camRel hip-centre height relative to the camera (m, + = above it) = zc sin(t) + up cos(t);
 *   zc, up the hip centre in camera coordinates (the tilt fit: a standing player's `up` falls by
 *          tan(t) per metre of zc).
 * Returns null without the shoulders in the picture.
 */
export function upperGeometry(landmarks, world, dOpt, hfovDeg, aspect, scale, tilt = 0, out = {}) {
  const fn = focalNorm(hfovDeg);
  const l11 = landmarks[11], l12 = landmarks[12];
  if (!inPicture(l11, 0) || !inPicture(l12, 0) || !(dOpt > 0.2)) return null;
  const hx = (world[23].x + world[24].x) / 2, hy = (world[23].y + world[24].y) / 2, hz = (world[23].z + world[24].z) / 2;
  const ct = Math.cos(tilt), st = Math.sin(tilt);
  // Shoulder centre: camera coordinates of the point and of the hip centre below it.
  const sOffZ = scale * ((world[11].z + world[12].z) / 2 - hz);
  const zcS = dOpt + sOffZ;
  const upS = (zcS * (0.5 - (l11.y + l12.y) / 2)) / (fn * aspect);
  let zc = 0.6 * dOpt, up = 0.6 * (upS + scale * ((world[11].y + world[12].y) / 2 - hy)), wsum = 0.6;
  out.x = (-((l11.x + l12.x) / 2 - 0.5) * zcS) / fn + scale * ((world[11].x + world[12].x) / 2 - hx);
  const e2 = landmarks[2], e5 = landmarks[5];
  if (inPicture(e2, 0) && inPicture(e5, 0) && Math.min(vis(e2), vis(e5)) >= 0.5) {
    const zcE = dOpt + scale * ((world[2].z + world[5].z) / 2 - hz);
    const upE = (zcE * (0.5 - (e2.y + e5.y) / 2)) / (fn * aspect);
    zc += 0.4 * dOpt;
    up += 0.4 * (upE + scale * ((world[2].y + world[5].y) / 2 - hy));
    wsum += 0.4;
  }
  zc /= wsum;
  up /= wsum;
  out.zc = zc;
  out.up = up;
  out.d = zc * ct - up * st;
  out.camRel = zc * st + up * ct;
  return out;
}

/** Camera-relative hip height of a stored reference frame { zc, up } at a given tilt. */
const camRelAt = (ref, tilt) => ref.zc * Math.sin(tilt) + ref.up * Math.cos(tilt);

/** World landmarks (camera-aligned, MediaPipe axes) turned level for a camera pitched up by tilt rad. */
export function levelWorld(src, tilt, out) {
  const c = Math.cos(tilt), sn = Math.sin(tilt);
  for (let i = 0; i < src.length; i++) {
    const a = src[i], o = out[i];
    o.x = a.x;
    o.y = a.y * c - a.z * sn;
    o.z = a.y * sn + a.z * c;
    o.visibility = a.visibility;
  }
  return out;
}

/**
 * Camera pitch from the standing envelope (close mode). A standing player's uncorrected
 * camera-relative hip height h0 falls by tan(pitch) per metre of optical depth; crouches only
 * lower it. Per depth bin (TILT.bin m) h0 is followed by an upper-quantile tracker (fast up, slow
 * down; fast vertical motion is skipped), and the slope of a line through the bins seen recently,
 * refitted without bins more than `below` m under it (only crouched visits so far), gives the
 * pitch once they span minSpan m (full weight from `full` m), shrunk by `dead` rad
 * toward zero (a level camera's estimate wanders by a degree or two).
 */
export const TILT = Object.freeze({
  bin: 0.1, zMin: 0.6, bins: 40, up: 0.1, down: 0.004, vy: 0.6, minCount: 6, maxAge: 90,
  minSpan: 0.25, full: 0.4, max: 0.55, rate: 1.5, below: 0.05, dead: 0.04, vd: 0.12,
});
/**
 * Calibration (round 5, QA r5: a tilted MacBook lid was never learned in play, where the player
 * hardly changes depth): while the calibration screen runs, the play-area step's steps forward
 * and back (d0 ± 0.2–0.3 m) feed a faster fit with these overrides; leaving it keeps the estimate.
 */
export const TILT_CAL = Object.freeze({ minCount: 3, minSpan: 0.15, full: 0.3, rate: 6, dead: 0.01, up: 0.3, widen: 0.15 });

export function createTiltEstimator() {
  const v = new Float64Array(TILT.bins), c = new Uint32Array(TILT.bins), tl = new Float64Array(TILT.bins);
  let est = 0, conf = 0, lastFit = -Infinity, meas = 0;
  let P = TILT; // TILT, or TILT with the TILT_CAL overrides during calibration
  let locked = false; // a manual camera tilt (Settings): no learning
  let cal = null; // { value, span }: the calibration fit, kept until play shows a wider depth span
  function add(zc, h0, vy, t) {
    if (locked) return;
    if (!isNum(zc) || !isNum(h0) || !(Math.abs(vy) < TILT.vy)) return;
    const b = Math.floor((zc - TILT.zMin) / TILT.bin);
    if (b < 0 || b >= TILT.bins) return;
    if (c[b] === 0 || t - tl[b] > TILT.maxAge) {
      v[b] = h0;
      c[b] = 0;
    } else v[b] += (h0 > v[b] ? P.up : TILT.down) * (h0 - v[b]);
    c[b]++;
    tl[b] = t;
  }
  // Weighted line fit over the usable bins; bins further than `below` m under the previous line
  // (only crouched visits so far) are left out. Returns { slope, span } or null.
  function line(t, prev, below) {
    let sw = 0, sz = 0, sh = 0, szz = 0, szh = 0, zlo = Infinity, zhi = -Infinity;
    for (let b = 0; b < TILT.bins; b++) {
      if (c[b] < P.minCount || t - tl[b] > TILT.maxAge) continue;
      const z = TILT.zMin + (b + 0.5) * TILT.bin;
      if (prev && v[b] < prev.a + prev.slope * z - below) continue;
      const w = Math.min(c[b], 60);
      sw += w; sz += w * z; sh += w * v[b]; szz += w * z * z; szh += w * z * v[b];
      if (z < zlo) zlo = z;
      if (z > zhi) zhi = z;
    }
    const den = sw * szz - sz * sz;
    if (!(sw > 0) || !(den > 1e-9)) return null;
    const slope = (sw * szh - sz * sh) / den;
    return { slope, a: (sh - slope * sz) / sw, span: zhi - zlo };
  }
  let lastSpan = 0;
  function fit(t, dt) {
    if (locked) return est;
    if (t - lastFit >= 0.25) {
      lastFit = t;
      // Upper envelope: refit without the bins well under the line (only crouched visits so far).
      let L = line(t, null, 0);
      for (let k = 0; k < 3 && L; k++) L = line(t, L, TILT.below) || L;
      if (L && L.span >= P.minSpan && !(cal && P === TILT && L.span < cal.span + TILT_CAL.widen)) {
        cal = P === TILT ? null : cal;
        meas = clamp(Math.atan(-L.slope), -TILT.max, TILT.max);
        conf = clamp((L.span - P.minSpan) / (P.full - P.minSpan), 0, 1);
        lastSpan = L.span;
      }
    }
    if (cal) {
      // Calibrated: hold that value (play at one depth adds no slope information).
      if (dt > 0) est += (cal.value - est) * (1 - Math.exp(-TILT.rate * dt));
      return est;
    }
    // A level camera's estimate wanders by a degree or two (noise, crouches): shrink toward zero.
    const want = Math.sign(meas) * Math.max(0, Math.abs(meas) - P.dead) * conf;
    if (dt > 0) est += (want - est) * (1 - Math.exp(-P.rate * dt));
    return est;
  }
  return {
    add,
    fit,
    get value() { return est; },
    get confidence() { return conf; },
    get locked() { return locked; },
    set(rad, { lock = false } = {}) { est = rad; meas = rad; conf = 1; locked = !!lock; cal = null; },
    unlock() { locked = false; },
    /** Calibration: the faster TILT_CAL fit while on; off settles the estimate at the measured value. */
    setFast(on) {
      const was = P !== TILT;
      P = on ? { ...TILT, ...TILT_CAL } : TILT;
      if (on) cal = null;
      if (was && !on && conf >= 0.5) {
        est = Math.sign(meas) * Math.max(0, Math.abs(meas) - TILT_CAL.dead) * conf;
        cal = { value: est, span: lastSpan };
      }
    },
    /** Diagnostics: the depth bins [{ z, h, n, age }] at time t. */
    bins(t = 0) {
      const out = [];
      for (let b = 0; b < TILT.bins; b++) if (c[b]) out.push({ z: +(TILT.zMin + (b + 0.5) * TILT.bin).toFixed(2), h: +v[b].toFixed(3), n: c[b], age: +(t - tl[b]).toFixed(1) });
      return out;
    },
    reset() { c.fill(0); est = 0; conf = 0; meas = 0; lastFit = -Infinity; locked = false; cal = null; lastSpan = 0; },
  };
}

const _lgF = new Vec3(), _lgD = new Vec3(), _lgP = new Vec3();
/**
 * Plausible leg joints in U (close mode, legs not seen): the ankles on the floor under the hips,
 * the knees bent forward by two-bone IK (a crouch bends them). Blends rawJ's knees / ankles toward
 * it by w, except those seen in the picture (lm).
 */
function synthLegs(J, k, w, lm) {
  // Body forward from the hips (right -> forward = (-right.z, 0, right.x)).
  _lgF.set(-(J.hipR.z - J.hipL.z), 0, J.hipR.x - J.hipL.x);
  if (_lgF.lengthSq() < 1e-8) _lgF.set(0, 0, 1);
  _lgF.normalize();
  const thigh = 0.429 * k, shin = 0.419 * k;
  for (const s of ['L', 'R']) {
    const hip = J['hip' + s], knee = J['knee' + s], ankle = J['ankle' + s];
    const ax = hip.x + (hip.x - (J.hipL.x + J.hipR.x) / 2) * 0.25, az = hip.z;
    const ay = ANKLE_HEIGHT;
    _lgD.set(ax - hip.x, ay - hip.y, az - hip.z);
    let D = _lgD.length();
    if (D < 1e-6) { _lgD.set(0, -1, 0); D = 1e-6; } else _lgD.scale(1 / D);
    const Dc = Math.min(D, thigh + shin - 1e-4);
    const a = (thigh * thigh - shin * shin + Dc * Dc) / (2 * Dc);
    const r = Math.sqrt(Math.max(0, thigh * thigh - a * a));
    _lgP.copy(_lgF).addScaled(_lgD, -_lgF.dot(_lgD));
    if (_lgP.lengthSq() < 1e-8) _lgP.set(0, 0, 1);
    _lgP.normalize();
    const kx = hip.x + _lgD.x * a + _lgP.x * r, ky = hip.y + _lgD.y * a + _lgP.y * r, kz = hip.z + _lgD.z * a + _lgP.z * r;
    const seen = (i) => vis(lm[i]) >= CLOSE.legVis && inPicture(lm[i], CLOSE.margin);
    const wk = seen(s === 'L' ? 25 : 26) ? 0 : w, wa = seen(s === 'L' ? 27 : 28) ? 0 : w;
    knee.set(knee.x + (kx - knee.x) * wk, knee.y + (ky - knee.y) * wk, knee.z + (kz - knee.z) * wk);
    ankle.set(ankle.x + (ax - ankle.x) * wa, ankle.y + (ay - ankle.y) * wa, ankle.z + (az - ankle.z) * wa);
  }
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
    // Adaptive noise floors (round 4): a noisy webcam spins a still palm at 5-20 rad/s and moves a
    // still wrist at ~1 m/s, which opened the filter at rest (the drawn racket face flipped). The
    // floors rise to HAND_NOISE.k x the median raw rotation rate / wrist speed of the last frames.
    this.rates = new Float64Array(HAND_NOISE.window);
    this.speeds = new Float64Array(HAND_NOISE.window);
    this.sorted = new Float64Array(HAND_NOISE.window);
    this.nNoise = 0;
    this.iNoise = 0;
    this.rotFloor = ROT_SPEED_FLOOR;
    this.wristFloor = WRIST_SPEED_FLOOR;
  }

  noteNoise(rate, wristSpeed) {
    this.rates[this.iNoise] = rate;
    this.speeds[this.iNoise] = wristSpeed;
    this.iNoise = (this.iNoise + 1) % this.rates.length;
    if (this.nNoise < this.rates.length) this.nNoise++;
    if (this.nNoise < 8) return;
    const med = (src) => {
      for (let k = 0; k < this.nNoise; k++) this.sorted[k] = src[k];
      const a = this.sorted.subarray(0, this.nNoise).sort();
      return a[this.nNoise >> 1];
    };
    this.rotFloor = Math.max(ROT_SPEED_FLOOR, HAND_NOISE.k * med(this.rates));
    this.wristFloor = Math.max(WRIST_SPEED_FLOOR, HAND_NOISE.k * med(this.speeds));
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
      this.noteNoise(_delta.length() / dt, wristSpeed);
      // Correction from the filtered frame to the measurement.
      frameQuat(this.axis, this.normal, _qa);
      rotVecBetween(_qa, _qb, _delta);
      const swing = Math.max(0, wristSpeed - this.wristFloor);
      const twist = Math.max(0, this.w.length() - this.rotFloor);
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
/**
 * Arm landmarks beyond the frame (round 5, QA r5): close to the camera an overhead's hand (and in a
 * smash its elbow) leaves the top of the picture right at contact, and a real detector then reports
 * a guess: the image position clamped to the edge or extrapolated, the world position stale or
 * lagging. Such a landmark (outside the picture by `margin`, visibility < maxVis) is treated as
 * missing and rebuilt from the last frame that saw the whole arm: the forearm and hand rigid on
 * the upper arm while the elbow is still in the picture (the arm keeps its elbow angle and turns
 * with the upper arm), else the whole arm rigid on the torso (shoulder line and spine) turned on by
 * the part of the swing the tracker can see. `vis` is the visibility given to a rebuilt landmark.
 */
export const ARM_OUT = Object.freeze({ margin: 0.004, maxVis: 0.5, vis: 0.5, maxAge: 1.5 });
const ARM_CHAIN = Object.freeze({
  L: Object.freeze({ sh: 11, el: 13, wr: 15, hand: Object.freeze([17, 19, 21]) }),
  R: Object.freeze({ sh: 12, el: 14, wr: 16, hand: Object.freeze([18, 20, 22]) }),
});
const createArmRef = () => ({ ok: false, t: -Infinity, upper: new Vec3(), fore: new Vec3(), hand: [new Vec3(), new Vec3(), new Vec3()], basis: [new Vec3(), new Vec3(), new Vec3()] });
const _aB = [new Vec3(), new Vec3(), new Vec3()];
const _aU = new Vec3(), _aV = new Vec3(), _aT = new Vec3(), _aA = new Vec3();
const SIDES2 = Object.freeze(['L', 'R']);

/** Orthonormal torso basis (shoulder line, spine, their normal) from world landmarks; false if degenerate. */
function torsoBasis(W, out) {
  const ex = out[0].set(W[12].x - W[11].x, W[12].y - W[11].y, W[12].z - W[11].z);
  const sp = out[1].set((W[11].x + W[12].x - W[23].x - W[24].x) / 2, (W[11].y + W[12].y - W[23].y - W[24].y) / 2, (W[11].z + W[12].z - W[23].z - W[24].z) / 2);
  if (ex.lengthSq() < 1e-6 || sp.lengthSq() < 1e-6) return false;
  ex.normalize();
  sp.addScaled(ex, -sp.dot(ex));
  if (sp.lengthSq() < 1e-8) return false;
  sp.normalize();
  out[2].crossVectors(ex, sp);
  return true;
}

/** v rotated by the rotation that takes basis A to basis B (out may alias v). */
function rebase(v, A, B, out) {
  const a = v.dot(A[0]), b = v.dot(A[1]), c = v.dot(A[2]);
  return out.set(B[0].x * a + B[1].x * b + B[2].x * c, B[0].y * a + B[1].y * b + B[2].y * c, B[0].z * a + B[1].z * b + B[2].z * c);
}

/** Minimal rotation taking unit u to unit v, applied to w (out may alias w). */
function rotateFromTo(u, v, w, out) {
  _aA.crossVectors(u, v);
  const s = _aA.length();
  const c = clamp(u.dot(v), -1, 1);
  if (s < 1e-9) return out.copy(w);
  return rotateAbout(w, _aA.scale(1 / s), Math.atan2(s, c), out);
}

export function createBodyTracker({
  hfovDeg = TRACKING.cameraPresets[TRACKING.defaultCamera].hfov,
  userHeight = PLAYER.defaultHeight,
  handed = 'right',
  filters = {},
} = {}) {
  const opts = { hfovDeg, userHeight, handed };
  const fp = { ...DEFAULT_FILTERS, ...filters };

  const calibration = { x0: 0, d0: 0, eyeHeight: 0, scale: 1, hipHeight: 0, ok: false, mode: null, camHeight: null };

  let dF = mkEuro(fp.distance);
  let xF = mkEuro(fp.lateral);
  const jointF = {};
  for (const name of JOINT_NAMES) {
    jointF[name] = new OneEuroVec(HAND_JOINTS.has(name) ? fp.hand : ELBOW_JOINTS.has(name) ? fp.elbow : fp.joint);
  }
  const handRotF = { L: new HandRotFilter(fp.handRot), R: new HandRotFilter(fp.handRot) };
  const hipYF = mkEuro(fp.vertical);
  const ankleYF = mkEuro(fp.vertical);
  const hipUF = mkEuro(fp.vertical);

  // Close mode (CLOSE): 'full' / 'upper', the crossfade weight of the full estimate (1 = full),
  // hysteresis clocks, the learned upper-vs-full bias and the camera height above the floor.
  const close = {
    mode: null, w: null, okFor: 0, badFor: 0,
    ratioD: null, biasX: null, camH: null, anchor: null, optRatio: 1, prevHipU: null, prevHipUT: null, hipUVy: 0, upright: true,
    prevD: null, prevDT: null, vD: 0,
  };
  const tilt = createTiltEstimator();
  const _geo = {}, _geo2 = {};
  const armRef = { L: createArmRef(), R: createArmRef() };

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
    hipUF.reset();
    prevHipY = prevAnkleY = prevVT = null;
    hipVy = ankleVy = 0;
    floorY = null;
    close.prevHipU = close.prevHipUT = null;
    close.hipUVy = 0;
    forgetLandmarks();
  }

  /** Close mode: which estimator this frame uses (hysteresis), and the crossfade weight. */
  function updateMode(legsOk, dt) {
    if (close.w === null) {
      close.mode = legsOk ? 'full' : 'upper';
      close.w = legsOk ? 1 : 0;
      close.okFor = close.badFor = 0;
      return;
    }
    // A gap between frames says nothing about the legs: count at most two frames of it.
    const step = dt > 0 ? Math.min(dt, 0.067) : 0;
    if (legsOk) {
      close.okFor += step;
      close.badFor = 0;
    } else {
      close.badFor += step;
      close.okFor = 0;
    }
    const prev = close.mode;
    if (prev === 'upper' && legsOk && close.okFor >= CLOSE.toFull) close.mode = 'full';
    else if (prev === 'full' && !legsOk && close.badFor >= CLOSE.toUpper) close.mode = 'upper';
    if (close.mode !== prev) stats.modeSwitches++;
    const target = close.mode === 'full' ? 1 : 0;
    const r = step / CLOSE.blend;
    close.w += clamp(target - close.w, -r, r);
  }

  /** Exponential learning step (rate 1/s over dt); the first value is taken as is. */
  const learn = (old, v, rate, dt) => (old === null || !isNum(old) ? v : old + (v - old) * (1 - Math.exp(-rate * Math.max(0, dt))));

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
  const levelW = Array.from({ length: 33 }, blankLm);
  const okFlag = new Uint8Array(33);
  const known = new Uint8Array(33);
  const spikes = new Uint8Array(33);
  let havePrev = false;
  let roomSpikes = 0;
  let lastDRaw = null, lastXRaw = null;
  const stats = {
    frames: 0, dropped: 0, rejectedLandmarks: 0, spikes: 0, swaps: 0, frontalSwaps: 0, degenerateHands: 0,
    roomHeld: 0, sideOnFrames: 0, nonFinite: 0, upperFrames: 0, modeSwitches: 0, armRebuilt: 0,
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

  /** ARM_OUT: rebuilds arm landmarks a detector only guesses (beyond the frame) in W, in place. */
  function rebuildArms(lm, W, t) {
    const missing = (i) => !inPicture(lm[i], ARM_OUT.margin) && vis(lm[i]) < ARM_OUT.maxVis;
    const torsoOk = inPicture(lm[11], 0) && inPicture(lm[12], 0) && torsoBasis(W, _aB);
    for (const side of SIDES2) {
      const c = ARM_CHAIN[side], ref = armRef[side];
      const elOut = missing(c.el);
      const wrOut = missing(c.wr) || missing(c.hand[0]) || missing(c.hand[1]);
      if (!elOut && !wrOut) {
        // The whole arm is seen: remember it relative to the upper arm and to the torso.
        ref.upper.set(W[c.el].x - W[c.sh].x, W[c.el].y - W[c.sh].y, W[c.el].z - W[c.sh].z);
        ref.fore.set(W[c.wr].x - W[c.el].x, W[c.wr].y - W[c.el].y, W[c.wr].z - W[c.el].z);
        for (let k = 0; k < 3; k++) ref.hand[k].set(W[c.hand[k]].x - W[c.wr].x, W[c.hand[k]].y - W[c.wr].y, W[c.hand[k]].z - W[c.wr].z);
        if (torsoOk) for (let k = 0; k < 3; k++) ref.basis[k].copy(_aB[k]);
        ref.ok = torsoOk && ref.upper.lengthSq() > 1e-4 && ref.fore.lengthSq() > 1e-4;
        ref.t = t;
        continue;
      }
      if (!ref.ok || t - ref.t > ARM_OUT.maxAge || !torsoOk) continue;
      const S = W[c.sh], E = W[c.el], Wr = W[c.wr];
      if (!elOut) {
        // Forearm and hand rigid on the upper arm (the elbow angle held).
        _aU.copy(ref.upper).normalize();
        _aV.set(E.x - S.x, E.y - S.y, E.z - S.z);
        if (_aV.lengthSq() < 1e-6) continue;
        _aV.normalize();
        rotateFromTo(_aU, _aV, ref.fore, _aT);
        Wr.x = E.x + _aT.x; Wr.y = E.y + _aT.y; Wr.z = E.z + _aT.z;
        for (let k = 0; k < 3; k++) {
          const h = W[c.hand[k]];
          rotateFromTo(_aU, _aV, ref.hand[k], _aT);
          h.x = Wr.x + _aT.x; h.y = Wr.y + _aT.y; h.z = Wr.z + _aT.z;
        }
      } else {
        // The whole arm rigid on the torso.
        rebase(ref.upper, ref.basis, _aB, _aT);
        E.x = S.x + _aT.x; E.y = S.y + _aT.y; E.z = S.z + _aT.z;
        rebase(ref.fore, ref.basis, _aB, _aT);
        Wr.x = E.x + _aT.x; Wr.y = E.y + _aT.y; Wr.z = E.z + _aT.z;
        for (let k = 0; k < 3; k++) {
          const h = W[c.hand[k]];
          rebase(ref.hand[k], ref.basis, _aB, _aT);
          h.x = Wr.x + _aT.x; h.y = Wr.y + _aT.y; h.z = Wr.z + _aT.z;
        }
        lm[c.el].visibility = Math.max(lm[c.el].visibility, ARM_OUT.vis);
      }
      lm[c.wr].visibility = Math.max(lm[c.wr].visibility, ARM_OUT.vis);
      for (const i of c.hand) lm[i].visibility = Math.max(lm[i].visibility, ARM_OUT.vis);
      stats.armRebuilt++;
    }
  }

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
    // MediaPipe's world landmarks are camera-aligned: with a pitched camera (TILT) the body leans
    // by the pitch. Distances use them as they are (the image plane); the body in U is levelled.
    const tilt0 = tilt.value;
    const wl = Math.abs(tilt0) > 1e-4 ? levelWorld(cleanW, tilt0, levelW) : cleanW;

    const aspect = frame.width > 0 && frame.height > 0 ? frame.width / frame.height : 16 / 9;
    const fn = focalNorm(opts.hfovDeg);

    // Close mode (CLOSE): legs usable -> whole-body estimation, else the upper body only.
    const legsOk = legsUsable(lm);
    const upOk = upperUsable(lm);
    updateMode(legsOk, dt);
    const wF = close.w * close.w * (3 - 2 * close.w); // C1 crossfade weight of the full estimate
    if (wF < 0.5) stats.upperFrames++;
    const hipsIn = partUsable(lm, [23, 24], CLOSE.legVis, 0);

    let confF = 0;
    for (const i of CONFIDENCE_JOINTS) confF += vis(lm[i]);
    confF /= CONFIDENCE_JOINTS.length;
    let conf = confF;
    if (wF < 1) {
      let confU = 0;
      for (const i of CONFIDENCE_UPPER) confU += vis(lm[i]);
      confU /= CONFIDENCE_UPPER.length;
      conf = wF * confF + (1 - wF) * confU;
    }

    // Torso yaw: side-on frames rely on the torso sides and thighs for distance.
    const yawDeg = torsoYawDeg(wl);
    const sideOn = Math.abs(yawDeg) > ROBUST.sideOnDeg;
    if (sideOn) stats.sideOnFrames++;

    // Body scale: continuous estimate before calibration, frozen after (from the feet, or the upper
    // body when the legs are out of the picture).
    const anklesIn = inPicture(lm[27], ON_PICTURE) && inPicture(lm[28], ON_PICTURE);
    const nAnk = anklesIn ? modelNoseToAnkle(wl) : null;
    if (nAnk !== null && isNum(nAnk)) modelH = modelH === null || dt <= 0 ? nAnk : damp(modelH, nAnk, 1.5, dt);
    else if (!legsOk && upOk) {
      const mu = modelHeightUpper(world, lm);
      if (mu !== null && isNum(mu)) modelH = modelH === null || dt <= 0 ? mu : damp(modelH, mu, 1.0, dt);
    }
    const scale = currentScale();
    const hipRef = calibration.ok ? calibration.hipHeight : opts.userHeight * PLAYER.hipHeightRatio;

    // Hip height from the ankles (keep the last value while the feet are out of view).
    const ankleVis = Math.min(vis(world[27]), vis(world[28]), vis(lm[27]), vis(lm[28]));
    const anklesSeen = ankleVis >= 0.3 && anklesIn;
    let hipHF;
    if (anklesSeen) hipHF = hipHeightFromWorld(wl, scale);
    else hipHF = lastHipH ?? hipRef;
    if (!isNum(hipHF)) hipHF = lastHipH ?? opts.userHeight * PLAYER.hipHeightRatio;

    // Room position: distance first, then lateral from the smoothed distance. A step that no
    // person can make in one frame (a wild landmark, a lost label) is held for up to
    // ROBUST.spikeFrames frames. Close mode blends the upper-body estimate in (bias learned while
    // the whole body was seen).
    const dRawF = estimateDistance(lm, world, opts.hfovDeg, aspect, scale, { sideOn });
    const dOptU0 = upOk || wF < 1 ? estimateDistanceUpper(lm, world, opts.hfovDeg, aspect, scale, { hips: hipsIn }) : null;
    const both = wF >= 1 && legsOk && upOk;
    if (both && dRawF !== null && dOptU0 !== null) close.ratioD = learn(close.ratioD, clamp(dRawF / dOptU0, 0.7, 1.4), CLOSE.biasRate, dt);
    const dOptU = dOptU0 !== null ? dOptU0 * (close.ratioD ?? 1) : null;
    // Pitched camera: the pinhole ratios give the optical depth; the upper-body geometry turns it
    // into the horizontal distance (TILT, learned from the standing envelope).
    const tiltNow = tilt0;
    const geo = dOptU !== null && upOk ? upperGeometry(lm, world, dOptU, opts.hfovDeg, aspect, scale, tiltNow, _geo) : null;
    if (geo) close.optRatio = clamp(dOptU / Math.max(0.2, geo.d), 0.5, 2);
    const dRawU = geo ? geo.d : dOptU;
    let dRaw;
    if (dRawU === null || (wF >= 1 && dRawF !== null)) dRaw = dRawF;
    else if (dRawF === null || wF <= 0) dRaw = dRawU;
    else dRaw = wF * dRawF + (1 - wF) * dRawU;
    const hip = hipImage(lm);
    // Lateral: hip centre (whole body) or shoulder centre moved to the hip centre (upper body).
    const xFull = (d) => (-(hip.u - 0.5) * d) / fn;
    const xUpRaw = (d) => {
      const g = upperGeometry(lm, world, d * close.optRatio, opts.hfovDeg, aspect, scale, tiltNow, _geo2);
      return g ? g.x : xFull(d);
    };
    if (both && dRaw !== null && hip) close.biasX = learn(close.biasX, clamp(xFull(dRaw) - xUpRaw(dRaw), -0.4, 0.4), CLOSE.biasRate, dt);
    const xUp = (d) => xUpRaw(d) + (close.biasX ?? 0);
    const useUp = upOk || !hip;
    const xOf = (d) => (!useUp || wF >= 1 ? xFull(d) : wF <= 0 || !hip ? xUp(d) : wF * xFull(d) + (1 - wF) * xUp(d));
    if (dRaw !== null && (hip || upOk)) {
      const xRaw = xOf(dRaw);
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
        const x = euro(xF, xOf(d), t);
        room = isNum(d) && isNum(x) ? { x, d } : { x: room.x, d: room.d };
      }
    } else room = { x: room.x, d: room.d };

    // Vertical motion from the image (world landmarks are hip-centred and cannot see jumps).
    let airF = 0;
    let jumpF = false;
    if (hip && room.d > 0) {
      const hipY = euro(hipYF, (-(hip.v - 0.5) / aspect / fn) * room.d, t);
      let ankleY = null;
      if (anklesSeen) {
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
        airF = Math.max(0, lift - AIRBORNE_DEADBAND);
        jumpF = (hipVy > JUMP_HIP_SPEED && (lift > 0.03 || ankleVy > 0.5)) || lift > 0.1;
      } else jumpF = hipVy > JUMP_HIP_SPEED * 1.5;
    }
    if (!isNum(airF)) airF = 0;

    // Close mode height: the hip height follows the shoulders and eyes in the picture over the
    // camera height, held as an anchor frame { zc, up, above, hip } (learned while the feet are
    // seen, else the first frame standing; re-anchored at calibration) so a new pitch estimate
    // keeps the anchor's own height.
    let hipHU = null, airU = 0, jumpU = false;
    const g2 = upOk && room.d > 0 ? upperGeometry(lm, world, room.d * close.optRatio, opts.hfovDeg, aspect, scale, tiltNow, _geo2) : null;
    let camRel = null;
    if (g2 && isNum(g2.camRel)) {
      camRel = g2.camRel;
      const A = close.anchor;
      if (both && anklesSeen) {
        const hipTrue = hipHF + airF;
        if (!A) close.anchor = { zc: g2.zc, up: g2.up, hip: hipTrue, full: true };
        else {
          const k = 1 - Math.exp(-CLOSE.camRate * Math.max(0, dt));
          A.zc += (g2.zc - A.zc) * k; A.up += (g2.up - A.up) * k; A.hip += (hipTrue - A.hip) * k;
          A.full = true;
        }
      } else if (!A) close.anchor = { zc: g2.zc, up: g2.up, hip: hipRef, full: false };
      const A2 = close.anchor;
      close.camH = A2.hip - camRelAt(A2, tiltNow);
      const hu = euro(hipUF, close.camH + camRel, t);
      if (close.prevHipUT !== null && t > close.prevHipUT && isNum(close.prevHipU)) close.hipUVy = (hu - close.prevHipU) / (t - close.prevHipUT);
      if (!isNum(close.hipUVy)) close.hipUVy = 0;
      close.prevHipU = hu;
      close.prevHipUT = t;
      airU = Math.max(0, hu - hipRef - AIRBORNE_DEADBAND);
      hipHU = hu - airU;
      jumpU = (close.hipUVy > JUMP_HIP_SPEED && airU > 0.03) || airU > 0.1;
      // Pitch: the standing envelope of the uncorrected height over the optical depth (only
      // while the player is likely upright: setUpright(false) during play near the ball).
      // Round 5: only while standing still in depth too. While stepping, the smoothed distance lags
      // the picture, so a walk toward the camera put higher hips into farther bins and flattened
      // the fit (10° read as 7.9°).
      const vd = close.prevD !== null && t > close.prevDT ? (room.d - close.prevD) / (t - close.prevDT) : 0;
      close.vD = close.vD + (vd - close.vD) * (dt > 0 ? 1 - Math.exp(-12 * dt) : 1);
      close.prevD = room.d;
      close.prevDT = t;
      if (close.upright && Math.abs(close.vD) < TILT.vd) tilt.add(g2.zc, g2.up, close.hipUVy, t);
    }
    tilt.fit(t, dt);
    let hipH = hipHF, airborne = airF, jump = jumpF, vy = hipVy;
    if (wF < 1 && hipHU !== null && isNum(hipHU)) {
      hipH = wF * hipHF + (1 - wF) * hipHU;
      airborne = wF * airF + (1 - wF) * airU;
      jump = wF >= 0.5 ? jumpF : jumpU;
      vy = wF * hipVy + (1 - wF) * close.hipUVy;
    }
    if (!isNum(hipH)) hipH = lastHipH ?? opts.userHeight * PLAYER.hipHeightRatio;
    if (!isNum(airborne)) airborne = 0;
    lastHipH = hipH;

    // Joints in U. An arm landmark MediaPipe reports as hidden while it is inside the picture
    // (side-on: the far arm behind the torso) is a guess that wanders frame to frame; it is
    // followed with OCCLUDED_TRUST of the usual smoothing factor. A hand that is merely out of the
    // picture (overheads) is extrapolated plausibly and keeps full trust.
    // Arm landmarks beyond the frame are the detector's guesses: rebuilt from the arm last seen.
    rebuildArms(lm, wl, t);
    toUserFrame(wl, scale, hipH, rawJ);
    // Close mode: MediaPipe's guessed legs give way to a plausible standing / crouching pose.
    if (wF < 1) synthLegs(rawJ, opts.userHeight / PLAYER.defaultHeight, 1 - wF, lm);
    const joints = {};
    for (const name of JOINT_NAMES) {
      const li = JOINT_INDEX[name];
      const v = jointF[name].filter(rawJ[name], t, new Vec3(), li >= 13 && li <= 22 ? landmarkTrust(lm[li]) : 1);
      v.y += airborne;
      joints[name] = v;
    }

    const hipHeight = (joints.hipL.y + joints.hipR.y) / 2 - airborne;
    const eyeHeight = (joints.eyeL.y + joints.eyeR.y) / 2;
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
      hipVy: vy,
      scale,
      personIndex: idx,
      image: hip ? { hipU: hip.u, hipV: hip.v } : null,
      // Side-on robustness (ROBUST): torso yaw (deg, + = facing the player's right) and its flag.
      yawDeg,
      sideOn,
      // Close mode (CLOSE): the estimator in use ('full' | 'upper'), its crossfade weight (1 =
      // whole body), whether the legs / upper body are usable this frame, the camera-relative hip
      // height seen from the upper body (m) and the learned camera height above the floor (m).
      trackMode: close.mode,
      modeBlend: wF,
      legsVisible: legsOk,
      upperVisible: upOk,
      camRelHip: camRel,
      camHeight: close.camH,
      tiltDeg: tilt.value / DEG,
      // Visibility of each hand (wrist, index, pinky; 0..1): a blurred or hidden hand is a guess.
      handVis: {
        L: Math.min(vis(lm[15]), vis(lm[17]), vis(lm[19])),
        R: Math.min(vis(lm[16]), vis(lm[18]), vis(lm[20])),
      },
      upperRef: g2 ? { zc: g2.zc, up: g2.up } : null,
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
    calibration.mode = sample.trackMode || 'full';
    // Close mode: the calibration pose (standing on the spot) re-anchors the camera height, so a
    // crouch reads against it. Without the feet ever seen, the hips are at their standing height.
    if (sample.upperRef) {
      const full = (sample.modeBlend ?? 1) >= 1 || !!(close.anchor && close.anchor.full);
      const hipCal = full ? calibration.hipHeight : opts.userHeight * PLAYER.hipHeightRatio;
      if (!full) calibration.eyeHeight += hipCal - calibration.hipHeight;
      calibration.hipHeight = hipCal;
      const R = sample.upperRef;
      close.anchor = { zc: R.zc * r, up: R.up * r, hip: hipCal, full };
      close.camH = hipCal - camRelAt(close.anchor, tilt.value);
      hipUF.reset();
      close.prevHipU = close.prevHipUT = null;
    }
    if (close.biasX !== null) close.biasX *= r;
    calibration.camHeight = close.camH;
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
      if (close.camH !== null) close.camH *= r;
      if (close.biasX !== null) close.biasX *= r;
      if (close.anchor) for (const k of ['zc', 'up', 'hip']) close.anchor[k] *= r;
      resetFilters();
    }
    if (patch.handed !== undefined) opts.handed = patch.handed;
  }

  /** Camera height for the current pitch estimate (the anchor holds the calibrated stance). */
  function refreshCamHeight() {
    if (!close.anchor) return;
    close.camH = close.anchor.hip - camRelAt(close.anchor, tilt.value);
    if (calibration.ok) calibration.camHeight = close.camH;
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
    calibration.mode = null;
    calibration.camHeight = null;
    Object.assign(close, {
      mode: null, w: null, okFor: 0, badFor: 0, ratioD: null, biasX: null, camH: null, anchor: null, optRatio: 1, prevHipU: null, prevHipUT: null, hipUVy: 0, upright: true,
      prevD: null, prevDT: null, vD: 0,
    });
    tilt.reset();
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
    /** Close mode: the estimator in use ('full' | 'upper' | null before the first frame). */
    get mode() {
      return close.mode;
    },
    /** Camera pitch (deg, + = tilted up) learned from the standing envelope, and its confidence 0..1. */
    get tilt() {
      return { deg: tilt.value / DEG, confidence: tilt.confidence, locked: tilt.locked, bins: tilt.bins(lastT ?? 0) };
    },
    /**
     * Posture hint for the pitch fit (TILT): false while the player is playing a ball (low balls
     * mean crouches at the depths they are played from), true otherwise (default: calibration,
     * between points, walking back to position).
     */
    setUpright(on) {
      close.upright = on !== false;
    },
    /**
     * Sets the camera pitch (deg) when it is known. { lock: true } (Settings → Camera tilt) keeps it
     * there (no learning) until setTilt(null) returns to the automatic estimate.
     */
    setTilt(deg, { lock = false } = {}) {
      if (Number.isFinite(deg)) tilt.set(clamp(deg * DEG, -TILT.max, TILT.max), { lock });
      else if (deg === null) tilt.unlock();
      refreshCamHeight();
    },
    /**
     * Calibration screen open (round 5): the pitch is fitted fast from the spot and play-area steps
     * (TILT_CAL); closing it keeps the estimate and stores the camera height with it.
     */
    setCalibrating(on) {
      tilt.setFast(!!on);
      if (!on) refreshCamHeight();
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
