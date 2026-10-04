// Time-stamped racket poses (COURT frame, sim seconds) with sweet-spot velocity and
// angular velocity from finite differences, and smooth sub-frame sampling for swept
// racket-ball contact. Slots are preallocated and reused: push() does not allocate.
// Pure module.
//
// Velocities: the newest pose gets a provisional backward estimate; it is refined to a
// central difference when the next pose arrives, and to a 5-point (4th-order) central
// difference two poses later. settledTime() says up to where velocities are central.

import { Vec3 } from '../util/vec3.js';
import { hermite } from '../util/math.js';
import { RACKET } from '../config.js';

/** Poses further apart than this (s) are treated as a tracking gap: no differences across it. */
export const MAX_GAP = 0.25;

/** Fresh RacketPose with sweet spot: { t, grip, axis, normal, vel, angVel, sweet }. */
export function createRacketPose() {
  return {
    t: 0,
    grip: new Vec3(),
    axis: new Vec3(0, 1, 0),
    normal: new Vec3(0, 0, 1),
    vel: new Vec3(),
    angVel: new Vec3(),
    sweet: new Vec3(),
  };
}

export function copyRacketPose(dst, src) {
  dst.t = src.t;
  dst.grip.copy(src.grip);
  dst.axis.copy(src.axis);
  dst.normal.copy(src.normal);
  dst.vel.copy(src.vel);
  dst.angVel.copy(src.angVel);
  dst.sweet.copy(src.sweet);
  return dst;
}

/** out = v rotated about the unit axis by angle (rad), Rodrigues. out may alias v. */
export function rotateAboutAxis(v, axis, angle, out) {
  const c = Math.cos(angle), s = Math.sin(angle);
  const d = axis.x * v.x + axis.y * v.y + axis.z * v.z;
  const cx = axis.y * v.z - axis.z * v.y, cy = axis.z * v.x - axis.x * v.z, cz = axis.x * v.y - axis.y * v.x;
  return out.set(
    v.x * c + cx * s + axis.x * d * (1 - c),
    v.y * c + cy * s + axis.y * d * (1 - c),
    v.z * c + cz * s + axis.z * d * (1 - c),
  );
}

/** Display extrapolation defaults: velocity decay rate (1/s) and the cap on sweet-spot travel (m). */
export const EXTRAPOLATE = Object.freeze({ damping: 6, maxTravel: 0.35, maxAngle: 1.2 });

const _ax = new Vec3(), _c = new Vec3(), _r = new Vec3();

/**
 * Racket pose `E` s after `src`, for display: rigid screw motion with the pose's sweet-spot
 * velocity and angular velocity (a swing is a rotation about the shoulder, so the sweet spot
 * follows an arc instead of shooting off along its tangent), both decaying as exp(-damping t)
 * so a decelerating racket does not overshoot. Sweet-spot travel is capped at maxTravel and
 * the rotation at maxAngle. Returns out (with vel / angVel at the extrapolated instant).
 */
export function extrapolatePose(src, E, out = createRacketPose(), { damping = EXTRAPOLATE.damping, maxTravel = EXTRAPOLATE.maxTravel, maxAngle = EXTRAPOLATE.maxAngle } = {}) {
  if (out !== src) copyRacketPose(out, src);
  if (!(E > 0)) return out;
  let fe = damping > 0 ? (1 - Math.exp(-damping * E)) / damping : E;
  const om = src.angVel, wl = om.length();
  const speed = src.vel.length();
  if (wl * fe > maxAngle) fe = maxAngle / wl;
  if (speed * fe > maxTravel) fe = maxTravel / speed;
  const sx = src.sweet.x, sy = src.sweet.y, sz = src.sweet.z;
  if (wl > 1e-6) {
    _ax.copy(om).scale(1 / wl);
    const ang = wl * fe;
    rotateAboutAxis(src.axis, _ax, ang, out.axis);
    rotateAboutAxis(src.normal, _ax, ang, out.normal);
    // Instantaneous screw axis through c = s + (w x v) / |w|^2; translation along it.
    _c.crossVectors(om, src.vel).scale(1 / (wl * wl));
    _r.copy(_c).scale(-1);
    rotateAboutAxis(_r, _ax, ang, _r);
    const along = src.vel.dot(_ax) * fe;
    out.sweet.set(sx + _c.x + _r.x + _ax.x * along, sy + _c.y + _r.y + _ax.y * along, sz + _c.z + _r.z + _ax.z * along);
    rotateAboutAxis(src.vel, _ax, ang, out.vel);
  } else {
    out.sweet.set(sx + src.vel.x * fe, sy + src.vel.y * fe, sz + src.vel.z * fe);
    out.vel.copy(src.vel);
  }
  const decay = damping > 0 ? Math.exp(-damping * E) : 1;
  out.vel.scale(decay);
  out.angVel.copy(om).scale(decay);
  out.grip.copy(out.sweet).addScaled(out.axis, -RACKET.sweetSpotY);
  out.t = src.t + E;
  return out;
}

/** out = a blended toward b by w (sweet spot lerp, nlerp of axis / normal, lerp of velocities). */
export function blendRacketPose(a, b, w, out = createRacketPose()) {
  if (w <= 0) return out === a ? out : copyRacketPose(out, a);
  if (w >= 1) return out === b ? out : copyRacketPose(out, b);
  out.sweet.lerpVectors(a.sweet, b.sweet, w);
  out.axis.lerpVectors(a.axis, b.axis, w);
  if (out.axis.lengthSq() < 1e-10) out.axis.copy(w < 0.5 ? a.axis : b.axis);
  out.axis.normalize();
  out.normal.lerpVectors(a.normal, b.normal, w);
  out.normal.addScaled(out.axis, -out.normal.dot(out.axis));
  if (out.normal.lengthSq() < 1e-10) out.normal.copy(b.normal).addScaled(out.axis, -b.normal.dot(out.axis));
  out.normal.normalize();
  out.vel.lerpVectors(a.vel, b.vel, w);
  out.angVel.lerpVectors(a.angVel, b.angVel, w);
  out.grip.copy(out.sweet).addScaled(out.axis, -RACKET.sweetSpotY);
  out.t = a.t + (b.t - a.t) * w;
  return out;
}

// --- Quaternions as plain {x,y,z,w} ------------------------------------------

/** Rotation of the racket frame: columns X = Y × Z, Y = axis, Z = normal. */
function frameQuat(axis, normal, q) {
  const yx = axis.x, yy = axis.y, yz = axis.z;
  const zx = normal.x, zy = normal.y, zz = normal.z;
  const xx = yy * zz - yz * zy, xy = yz * zx - yx * zz, xz = yx * zy - yy * zx;
  // m[row][col]
  const m00 = xx, m01 = yx, m02 = zx;
  const m10 = xy, m11 = yy, m12 = zy;
  const m20 = xz, m21 = yz, m22 = zz;
  const tr = m00 + m11 + m22;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    q.w = 0.25 / s;
    q.x = (m21 - m12) * s;
    q.y = (m02 - m20) * s;
    q.z = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    q.w = (m21 - m12) / s;
    q.x = 0.25 * s;
    q.y = (m01 + m10) / s;
    q.z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    q.w = (m02 - m20) / s;
    q.x = (m01 + m10) / s;
    q.y = 0.25 * s;
    q.z = (m12 + m21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    q.w = (m10 - m01) / s;
    q.x = (m02 + m20) / s;
    q.y = (m12 + m21) / s;
    q.z = 0.25 * s;
  }
  return q;
}

/** out = rotation vector (axis * angle, world frame) of qb ⊗ conj(qa). */
function relRotVec(qa, qb, out) {
  // conj(qa) = (-ax, -ay, -az, aw)
  const ax = -qa.x, ay = -qa.y, az = -qa.z, aw = qa.w;
  let w = qb.w * aw - (qb.x * ax + qb.y * ay + qb.z * az);
  let x = qb.w * ax + aw * qb.x + (qb.y * az - qb.z * ay);
  let y = qb.w * ay + aw * qb.y + (qb.z * ax - qb.x * az);
  let z = qb.w * az + aw * qb.z + (qb.x * ay - qb.y * ax);
  if (w < 0) {
    w = -w;
    x = -x;
    y = -y;
    z = -z;
  }
  const s = Math.hypot(x, y, z);
  if (s < 1e-12) return out.set(2 * x, 2 * y, 2 * z);
  const angle = 2 * Math.atan2(s, w);
  return out.set((x / s) * angle, (y / s) * angle, (z / s) * angle);
}

// --- Finite differences --------------------------------------------------------

/** Lagrange derivative weights at node j for nodes ts[0..n-1] (n <= 5). */
function derivWeights(ts, n, j, w) {
  for (let k = 0; k < n; k++) {
    if (k === j) {
      let s = 0;
      for (let l = 0; l < n; l++) if (l !== j) s += 1 / (ts[j] - ts[l]);
      w[k] = s;
    } else {
      let num = 1, den = 1;
      for (let l = 0; l < n; l++) {
        if (l === k) continue;
        den *= ts[k] - ts[l];
        if (l !== j) num *= ts[j] - ts[l];
      }
      w[k] = num / den;
    }
  }
  return w;
}

const _ts = new Float64Array(5);
const _w = new Float64Array(5);
const _nodes = new Array(5);
const _r1 = new Vec3(), _r2 = new Vec3();

/**
 * @param {{capacity?: number, maxGap?: number}} opts
 * @returns RacketTrack = { push(t, pose) -> boolean, sample(t, out?) -> RacketPose|null,
 *   segmentsSince(t) -> [[poseA, poseB], ...], peakSpeed(t0, t1) -> number, latest() -> RacketPose|null,
 *   settledTime() -> number, get(i), clear(), length, capacity }
 */
export function createRacketTrack({ capacity = 240, maxGap = MAX_GAP } = {}) {
  const slots = Array.from({ length: capacity }, () => {
    const p = createRacketPose();
    p.q = { x: 0, y: 0, z: 0, w: 1 };
    return p;
  });
  let start = 0;
  let len = 0;

  const get = (i) => (i >= 0 && i < len ? slots[(start + i) % capacity] : undefined);
  const linked = (a, b) => b.t - a.t <= maxGap;

  /** Velocity and angular velocity of pose i from its contiguous neighbours. */
  function differentiate(i) {
    const p = get(i);
    // Contiguous neighbours: up to two on each side.
    let lo = i, hi = i;
    while (lo > i - 2 && lo > 0 && linked(get(lo - 1), get(lo))) lo--;
    while (hi < i + 2 && hi < len - 1 && linked(get(hi), get(hi + 1))) hi++;
    // Symmetric stencil where possible (5- or 3-point central), else one-sided (3- or 2-point).
    const left = i - lo, right = hi - i;
    const sym = Math.min(left, right);
    let a, b;
    if (sym > 0) {
      a = i - sym;
      b = i + sym;
    } else {
      a = lo;
      b = hi;
    }
    const n = b - a + 1;
    if (n < 2) {
      p.vel.set(0, 0, 0);
      p.angVel.set(0, 0, 0);
      return;
    }
    for (let k = 0; k < n; k++) {
      _nodes[k] = get(a + k);
      _ts[k] = _nodes[k].t;
    }
    derivWeights(_ts, n, i - a, _w);
    let vx = 0, vy = 0, vz = 0;
    for (let k = 0; k < n; k++) {
      const s = _nodes[k].sweet;
      vx += _w[k] * s.x;
      vy += _w[k] * s.y;
      vz += _w[k] * s.z;
    }
    p.vel.set(vx, vy, vz);

    // Angular velocity: exact for a constant rotation rate (quaternion log), not a chord.
    if (sym > 0) {
      const pa = get(i - 1), pb = get(i + 1);
      relRotVec(pa.q, pb.q, p.angVel).scale(1 / (pb.t - pa.t));
    } else if (left > 0) {
      const p1 = get(i - 1);
      const h2 = p.t - p1.t;
      relRotVec(p1.q, p.q, _r1).scale(1 / h2);
      if (left > 1) {
        const p2 = get(i - 2);
        const h1 = p1.t - p2.t;
        relRotVec(p2.q, p1.q, _r2).scale(1 / h1);
        // Linear extrapolation of the two half-step rates to the newest pose.
        p.angVel.copy(_r1).addScaled(_r2, -1).scale(h2 / (h1 + h2)).add(_r1);
      } else p.angVel.copy(_r1);
    } else {
      const p1 = get(i + 1);
      relRotVec(p.q, p1.q, p.angVel).scale(1 / (p1.t - p.t));
    }
  }

  /**
   * Adds a pose (COURT frame, without vel) captured at sim time t. Out-of-order poses are
   * dropped; a pose at the same time replaces the newest. Returns true when stored.
   */
  function push(t, pose) {
    let slot;
    const last = get(len - 1);
    if (last && t <= last.t) {
      if (t < last.t - 1e-9) return false;
      slot = last;
    } else if (len < capacity) {
      slot = slots[(start + len) % capacity];
      len++;
    } else {
      slot = slots[start];
      start = (start + 1) % capacity;
    }
    slot.t = t;
    slot.grip.copy(pose.grip);
    slot.axis.copy(pose.axis).normalize();
    slot.normal.copy(pose.normal).addScaled(slot.axis, -slot.normal.dot(slot.axis)).normalize();
    slot.sweet.copy(slot.grip).addScaled(slot.axis, RACKET.sweetSpotY);
    frameQuat(slot.axis, slot.normal, slot.q);
    for (let i = Math.max(0, len - 3); i < len; i++) differentiate(i);
    return true;
  }

  /** Index of the newest pose with t_i <= t (binary search), or -1. */
  function indexAt(t) {
    let lo = 0, hi = len - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (get(mid).t <= t) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }

  /**
   * Pose at time t: cubic Hermite on the sweet spot (finite-difference tangents), its
   * derivative as vel, normalized lerp on axis and normal (re-orthogonalised), linear angVel.
   * Clamps to the first / last pose outside the stored range.
   */
  function sample(t, out = createRacketPose()) {
    if (len === 0) return null;
    const first = get(0), last = get(len - 1);
    if (t <= first.t) return copyRacketPose(out, first);
    if (t >= last.t) return copyRacketPose(out, last);
    const i = indexAt(t);
    const A = get(i), B = get(i + 1);
    const h = B.t - A.t;
    const s = (t - A.t) / h;
    const pa = A.sweet, pb = B.sweet, ma = A.vel, mb = B.vel;
    out.sweet.set(
      hermite(pa.x, ma.x * h, pb.x, mb.x * h, s),
      hermite(pa.y, ma.y * h, pb.y, mb.y * h, s),
      hermite(pa.z, ma.z * h, pb.z, mb.z * h, s),
    );
    // d/ds of the Hermite basis, divided by h -> d/dt.
    const s2 = s * s;
    const d00 = (6 * s2 - 6 * s) / h, d10 = 3 * s2 - 4 * s + 1, d01 = (-6 * s2 + 6 * s) / h, d11 = 3 * s2 - 2 * s;
    out.vel.set(
      d00 * pa.x + d10 * ma.x + d01 * pb.x + d11 * mb.x,
      d00 * pa.y + d10 * ma.y + d01 * pb.y + d11 * mb.y,
      d00 * pa.z + d10 * ma.z + d01 * pb.z + d11 * mb.z,
    );
    out.axis.lerpVectors(A.axis, B.axis, s);
    if (out.axis.lengthSq() < 1e-12) out.axis.copy(s < 0.5 ? A.axis : B.axis);
    out.axis.normalize();
    out.normal.lerpVectors(A.normal, B.normal, s);
    out.normal.addScaled(out.axis, -out.normal.dot(out.axis));
    if (out.normal.lengthSq() < 1e-12) out.normal.copy(A.normal).addScaled(out.axis, -A.normal.dot(out.axis));
    out.normal.normalize();
    out.angVel.lerpVectors(A.angVel, B.angVel, s);
    out.grip.copy(out.sweet).addScaled(out.axis, -RACKET.sweetSpotY);
    out.t = t;
    return out;
  }

  /** Consecutive stored pairs [A, B] with B.t > t (stored objects: read-only, reused after `capacity` pushes). */
  function segmentsSince(t) {
    const out = [];
    for (let i = Math.max(1, indexAt(t) + 1); i < len; i++) {
      const A = get(i - 1), B = get(i);
      if (B.t > t) out.push([A, B]);
    }
    return out;
  }

  /** Max sweet-spot speed among stored poses with t0 <= t <= t1. */
  function peakSpeed(t0 = -Infinity, t1 = Infinity) {
    let best = 0;
    for (let i = Math.max(0, indexAt(t0)); i < len; i++) {
      const p = get(i);
      if (p.t > t1) break;
      if (p.t < t0) continue;
      const v = p.vel.length();
      if (v > best) best = v;
    }
    return best;
  }

  return {
    push,
    sample,
    segmentsSince,
    peakSpeed,
    latest: () => (len ? get(len - 1) : null),
    /** Time up to which stored velocities use central differences (the second-newest pose). */
    settledTime: () => (len >= 2 ? get(len - 2).t : -Infinity),
    get,
    indexAt,
    clear() {
      start = 0;
      len = 0;
    },
    get length() {
      return len;
    },
    capacity,
  };
}
