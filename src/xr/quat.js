// Quaternion helpers for head tracking (plain {x,y,z,w} objects; pure, runs under Node).
// Convention: three.js camera frame. +X right, +Y up, the view looks down -Z. Positive yaw turns
// the view LEFT (counter-clockwise seen from above, about +Y), positive pitch looks UP (about +X),
// positive roll tilts the head LEFT (left ear down, about +Z). Euler order 'YXZ' (yaw, then pitch,
// then roll), as for a first-person camera: R = Ry(yaw) * Rx(pitch) * Rz(roll).

export const qIdentity = () => ({ x: 0, y: 0, z: 0, w: 1 });

export function qSet(out, x, y, z, w) {
  out.x = x; out.y = y; out.z = z; out.w = w;
  return out;
}

export function qCopy(out, q) {
  return qSet(out, q.x, q.y, q.z, q.w);
}

/** Finite with a plausible norm (0.5..1.5): anything else is sensor or parser garbage. */
export function qValid(q) {
  if (!q || !Number.isFinite(q.x) || !Number.isFinite(q.y) || !Number.isFinite(q.z) || !Number.isFinite(q.w)) return false;
  const n = Math.hypot(q.x, q.y, q.z, q.w);
  return n > 0.5 && n < 1.5;
}

export function qNormalize(q, out = q) {
  const n = Math.hypot(q.x, q.y, q.z, q.w);
  if (!(n > 1e-12) || !Number.isFinite(n)) return qSet(out, 0, 0, 0, 1);
  return qSet(out, q.x / n, q.y / n, q.z / n, q.w / n);
}

/** a * b (apply b first, then a). Safe when out aliases a or b. */
export function qMul(a, b, out = {}) {
  const x = a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y;
  const y = a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x;
  const z = a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w;
  const w = a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z;
  return qSet(out, x, y, z, w);
}

export function qConj(q, out = {}) {
  return qSet(out, -q.x, -q.y, -q.z, q.w);
}

export function qDot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
}

/** Angle (rad) of the rotation taking a to b. */
export function qAngleBetween(a, b) {
  const d = Math.min(1, Math.abs(qDot(a, b)) / (Math.hypot(a.x, a.y, a.z, a.w) * Math.hypot(b.x, b.y, b.z, b.w) || 1));
  return 2 * Math.acos(d);
}

export function qFromAxisAngle(ax, ay, az, angle, out = {}) {
  const n = Math.hypot(ax, ay, az);
  if (!(n > 1e-12)) return qSet(out, 0, 0, 0, 1);
  const s = Math.sin(angle / 2) / n;
  return qSet(out, ax * s, ay * s, az * s, Math.cos(angle / 2));
}

/** R = Ry(yaw) * Rx(pitch) * Rz(roll) (three.js Euler order 'YXZ'). */
export function qFromEulerYXZ(yaw, pitch, roll, out = {}) {
  const c1 = Math.cos(pitch / 2), s1 = Math.sin(pitch / 2);
  const c2 = Math.cos(yaw / 2), s2 = Math.sin(yaw / 2);
  const c3 = Math.cos(roll / 2), s3 = Math.sin(roll / 2);
  return qSet(out,
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 - s1 * s2 * c3,
    c1 * c2 * c3 + s1 * s2 * s3);
}

/** Inverse of qFromEulerYXZ: { yaw, pitch, roll } in radians (pitch in [-PI/2, PI/2]). */
export function qToEulerYXZ(q, out = {}) {
  const { x, y, z, w } = q;
  const m11 = 1 - 2 * (y * y + z * z), m13 = 2 * (x * z + w * y);
  const m21 = 2 * (x * y + w * z), m22 = 1 - 2 * (x * x + z * z), m23 = 2 * (y * z - w * x);
  const m31 = 2 * (x * z - w * y), m33 = 1 - 2 * (x * x + y * y);
  const s = Math.max(-1, Math.min(1, m23));
  out.pitch = Math.asin(-s);
  if (Math.abs(s) < 0.9999999) {
    out.yaw = Math.atan2(m13, m33);
    out.roll = Math.atan2(m21, m22);
  } else {
    out.yaw = Math.atan2(-m31, m11);
    out.roll = 0;
  }
  return out;
}

/** Heading of q about world +Y (rad), the yaw of its YXZ Euler decomposition. */
export function qYaw(q) {
  const { x, y, z, w } = q;
  return Math.atan2(2 * (x * z + w * y), 1 - 2 * (x * x + y * y));
}

/** Spherical interpolation (shortest path). */
export function qSlerp(a, b, t, out = {}) {
  let bx = b.x, by = b.y, bz = b.z, bw = b.w;
  let cos = a.x * bx + a.y * by + a.z * bz + a.w * bw;
  if (cos < 0) {
    cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw;
  }
  let k0, k1;
  if (cos > 0.9995) {
    k0 = 1 - t;
    k1 = t;
  } else {
    const th = Math.acos(cos);
    const s = Math.sin(th);
    k0 = Math.sin((1 - t) * th) / s;
    k1 = Math.sin(t * th) / s;
  }
  qSet(out, a.x * k0 + bx * k1, a.y * k0 + by * k1, a.z * k0 + bz * k1, a.w * k0 + bw * k1);
  return qNormalize(out);
}

/**
 * World-frame rotation vector (axis * angle, rad) taking `from` to `to`: to = Exp(v) * from.
 * Used for the angular velocity of the head.
 */
export function qDeltaWorld(from, to, out = {}) {
  const d = qMul(to, qConj(from, {}), {});
  if (d.w < 0) qSet(d, -d.x, -d.y, -d.z, -d.w);
  const s = Math.hypot(d.x, d.y, d.z);
  const angle = 2 * Math.atan2(s, d.w);
  const k = s > 1e-12 ? angle / s : 2;
  out.x = d.x * k; out.y = d.y * k; out.z = d.z * k;
  return out;
}

/** Exp(omega * dt) * q: rotates q by a world-frame angular velocity (rad/s) for dt seconds. */
export function qIntegrate(q, wx, wy, wz, dt, out = {}) {
  const a = Math.hypot(wx, wy, wz) * dt;
  if (!(a > 1e-12)) return qCopy(out, q);
  const r = qFromAxisAngle(wx, wy, wz, a, {});
  return qNormalize(qMul(r, q, out));
}

/**
 * Applies a signed axis permutation to a rotation: v'_i = sign[i] * v[src[i]], w' = w.
 * For a device whose axes differ from the camera frame by a fixed rotation (a proper signed
 * permutation, det +1) this is exactly the conjugation that maps its rotations into ours.
 */
export function qRemap(q, src, sign, out = {}) {
  const v = [q.x, q.y, q.z];
  return qSet(out, sign[0] * v[src[0]], sign[1] * v[src[1]], sign[2] * v[src[2]], q.w);
}

/** Determinant of the signed permutation (+1: a proper rotation of the axes). */
export function remapDet(src, sign) {
  const [a, b, c] = src;
  // Parity of the permutation (a,b,c) of (0,1,2).
  let inv = 0;
  if (a > b) inv++;
  if (a > c) inv++;
  if (b > c) inv++;
  return (inv % 2 ? -1 : 1) * sign[0] * sign[1] * sign[2];
}

/** A valid {src, sign} remap: src a permutation of 0..2, signs ±1. */
export function remapValid(r) {
  if (!r || !Array.isArray(r.src) || !Array.isArray(r.sign) || r.src.length !== 3 || r.sign.length !== 3) return false;
  const s = [...r.src].sort();
  if (s[0] !== 0 || s[1] !== 1 || s[2] !== 2) return false;
  return r.sign.every((x) => x === 1 || x === -1);
}

/** Rotates a vector by q: q * v * conj(q). */
export function qRotateVec(q, v, out = {}) {
  const { x, y, z, w } = q;
  const ix = w * v.x + y * v.z - z * v.y;
  const iy = w * v.y + z * v.x - x * v.z;
  const iz = w * v.z + x * v.y - y * v.x;
  const iw = -x * v.x - y * v.y - z * v.z;
  out.x = ix * w + iw * -x + iy * -z - iz * -y;
  out.y = iy * w + iw * -y + iz * -x - ix * -z;
  out.z = iz * w + iw * -z + ix * -y - iy * -x;
  return out;
}
