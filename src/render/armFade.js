// First-person arm visibility (QA2): a limb a few tens of centimetres from the eye covers a big
// part of a TV picture (a 6.6 cm sleeve at 0.3 m spans more than 20°). Like VR games, the rig
// shows the forearms and only a short stub of the upper arm from the elbow, and fades every arm
// segment by its angular size seen from the eye. Pure module (no three) so the rule is tested
// in Node with the same numbers the renderer uses.

/** Angular radius (rad, limb radius / distance) where a segment starts to fade, and where it is gone. */
export const ARM_FADE = Object.freeze({ A0: 0.12, A1: 0.2 });
/** Upper-arm stub shown from the elbow toward the shoulder (m, for a 1.75 m player). */
export const UPPER_STUB = 0.09;
/** Visible limb radii (m) used for the angular size. */
export const ARM_RADIUS = Object.freeze({ upper: 0.046, fore: 0.042 });

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Opacity (0..1) of a limb of `radius` whose nearest point is `dist` from the eye. */
export function angularAlpha(radius, dist) {
  if (!(dist > 1e-6)) return 0;
  const a = radius / dist;
  const t = clamp01((a - ARM_FADE.A0) / (ARM_FADE.A1 - ARM_FADE.A0));
  return 1 - t * t * (3 - 2 * t);
}

/** Distance from point p to segment a-b ({x,y,z} objects). */
export function pointSegmentDistance(p, a, b) {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const l2 = abx * abx + aby * aby + abz * abz;
  let u = l2 > 1e-12 ? ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / l2 : 0;
  u = u < 0 ? 0 : u > 1 ? 1 : u;
  return Math.hypot(a.x + abx * u - p.x, a.y + aby * u - p.y, a.z + abz * u - p.z);
}

/**
 * Start of the upper-arm stub: the point UPPER_STUB (x scale) from the elbow toward the shoulder
 * (never past the shoulder). out: {x,y,z}.
 */
export function stubStart(shoulder, elbow, scale = 1, out = { x: 0, y: 0, z: 0 }) {
  const dx = shoulder.x - elbow.x, dy = shoulder.y - elbow.y, dz = shoulder.z - elbow.z;
  const len = Math.hypot(dx, dy, dz);
  const k = len > 1e-6 ? Math.min(1, (UPPER_STUB * scale) / len) : 0;
  out.x = elbow.x + dx * k;
  out.y = elbow.y + dy * k;
  out.z = elbow.z + dz * k;
  return out;
}

/** Opacity of segment a-b of `radius` seen from the nearer of the eyes (the tracked eye and the camera). */
export function segmentAlpha(radius, a, b, eyes) {
  let d = Infinity;
  for (const e of eyes) if (e) d = Math.min(d, pointSegmentDistance(e, a, b));
  return d === Infinity ? 1 : angularAlpha(radius, d);
}

/**
 * Extra opacity factor for the upper-arm stub: a raised elbow (overhead preparation, trophy
 * position) puts the upper arm beside the head, right in front of a camera that sits a few cm
 * behind the eyes, so the stub fades out as the elbow rises to shoulder height.
 */
export function stubRaiseFactor(shoulder, elbow, scale = 1) {
  const t = clamp01((elbow.y - (shoulder.y - 0.14 * scale)) / (0.12 * scale));
  return 1 - t * t * (3 - 2 * t);
}

/**
 * Extra opacity factor for a segment beside or behind the eyes (overhead preparation: the forearm
 * is level with the head). Such a limb is peripheral vision in real life, but a wide TV frustum
 * turned toward the contact draws it huge and stretched in a corner. fwd: the body's forward
 * direction (unit, horizontal); the factor rises from 0 to 1 as the segment's most forward point
 * goes from the eye plane to BESIDE_FADE in front of it.
 */
export const BESIDE_FADE = 0.12;
export function besideEyeFactor(a, b, eye, fwd) {
  if (!eye || !fwd) return 1;
  const da = (a.x - eye.x) * fwd.x + (a.y - eye.y) * fwd.y + (a.z - eye.z) * fwd.z;
  const db = (b.x - eye.x) * fwd.x + (b.y - eye.y) * fwd.y + (b.z - eye.z) * fwd.z;
  const t = clamp01(Math.max(da, db) / BESIDE_FADE);
  return t * t * (3 - 2 * t);
}
