// Render safety net (first real-world session: "a black screen with image on the side if you turn
// left or right far enough"). Reproduced: ONE mesh with a degenerate transform (a zero-length arm
// segment scaled to 0, a zero / NaN quaternion) or a NaN camera turns the whole WebGL picture
// black — its NaN fragments are smeared over the screen by the bloom mip chain — while the DOM HUD
// and the camera PiP stay visible. Pure module (plain {x,y,z} / {x,y,z,w} / 16-element matrices),
// so the rules are tested under Node; the stage applies them to three.js objects every frame.

/** Smallest |det| of a visible mesh's world matrix that is still drawn (a 1 mm x 1 m x 1 m box is 1e-3). */
export const MIN_DET = 1e-10;
/** Arm segment lengths drawn, as a fraction of the nominal length (shorter / longer = tracking garbage). */
export const SEGMENT_RANGE = Object.freeze({ min: 0.4, max: 1.8 });

export const isFiniteVec = (v) => !!v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);

/** A finite, unit-ish quaternion. */
export function isFiniteQuat(q) {
  if (!q || !Number.isFinite(q.x) || !Number.isFinite(q.y) || !Number.isFinite(q.z) || !Number.isFinite(q.w)) return false;
  const l = q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w;
  return l > 0.5 && l < 2;
}

/** Determinant of a column-major 4x4 matrix's upper 3x3 (three.js Matrix4.elements). */
export function det3(e) {
  return e[0] * (e[5] * e[10] - e[9] * e[6]) - e[4] * (e[1] * e[10] - e[9] * e[2]) + e[8] * (e[1] * e[6] - e[5] * e[2]);
}

/** A drawable world matrix: finite and not (nearly) singular. */
export function matrixOk(e) {
  for (let i = 0; i < 16; i++) if (!Number.isFinite(e[i])) return false;
  return Math.abs(det3(e)) > MIN_DET;
}

/** True when segment a-b is finite and its length is plausible for `nominal` (m). */
export function segmentOk(a, b, nominal) {
  if (!isFiniteVec(a) || !isFiniteVec(b)) return false;
  const l = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  return l >= SEGMENT_RANGE.min * nominal && l <= SEGMENT_RANGE.max * nominal;
}

/** A unit racket / hand frame: finite grip, unit axis and normal that are not parallel. */
export function frameOk(f) {
  if (!f || !isFiniteVec(f.grip) || !isFiniteVec(f.axis) || !isFiniteVec(f.normal)) return false;
  const la = Math.hypot(f.axis.x, f.axis.y, f.axis.z), ln = Math.hypot(f.normal.x, f.normal.y, f.normal.z);
  if (la < 0.5 || ln < 0.5) return false;
  const c = Math.abs(f.axis.x * f.normal.x + f.axis.y * f.normal.y + f.axis.z * f.normal.z) / (la * ln);
  return c < 0.99;
}

/** A ball to draw: finite position (and velocity when present). */
export function ballOk(b) {
  return !!b && isFiniteVec(b.pos) && (!b.vel || isFiniteVec(b.vel));
}

/**
 * Last-good store for the camera pose: check(pos, quat) returns true and remembers them when they
 * are finite, false otherwise (the caller restores last.pos / last.quat). Counters in stats.
 */
export function createSafetyNet() {
  const stats = { cameraRestored: 0, eyeRestored: 0, racketHidden: 0, ballHidden: 0, meshesHidden: 0, rigHidden: 0, frames: 0, lastEvent: null };
  const last = { pos: { x: 0, y: 1.6, z: 8 }, quat: { x: 0, y: 0, z: 0, w: 1 }, eye: { x: 0, y: 1.64, z: 8 }, ok: false };
  function note(kind, t) {
    stats[kind]++;
    stats.lastEvent = { kind, t: t ?? null };
  }
  return {
    stats,
    last,
    note,
    /** Camera pose check; remembers a good one. */
    camera(pos, quat, t) {
      if (isFiniteVec(pos) && isFiniteQuat(quat) && Math.abs(pos.x) < 1e3 && Math.abs(pos.y) < 1e3 && Math.abs(pos.z) < 1e3) {
        last.pos.x = pos.x; last.pos.y = pos.y; last.pos.z = pos.z;
        last.quat.x = quat.x; last.quat.y = quat.y; last.quat.z = quat.z; last.quat.w = quat.w;
        last.ok = true;
        return true;
      }
      note('cameraRestored', t);
      return false;
    },
    /** Eye check: returns a finite eye (the input, or the last good one). */
    eye(e, t) {
      if (isFiniteVec(e) && Math.abs(e.x) < 50 && e.y > -1 && e.y < 5 && Math.abs(e.z) < 50) {
        last.eye.x = e.x; last.eye.y = e.y; last.eye.z = e.z;
        return e;
      }
      note('eyeRestored', t);
      return last.eye;
    },
  };
}
