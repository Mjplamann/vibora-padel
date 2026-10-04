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

/**
 * Side-on play (first real-world session): with the torso turned to the side while the head (and
 * the view) faces the TV, the near arm folds across the chest a hand's width below the eyes and
 * its elbow end filled the bottom of the picture. Such a segment fades as a whole by its NEAREST
 * point: solid beyond SIDE_ON_FADE_DIST[1] from the eye, gone inside SIDE_ON_FADE_DIST[0].
 */
export const SIDE_ON_FADE_DIST = Object.freeze([0.3, 0.48]);
export function sideOnAlpha(a, b, eye) {
  if (!eye) return 1;
  const d = pointSegmentDistance(eye, a, b);
  const t = clamp01((d - SIDE_ON_FADE_DIST[0]) / (SIDE_ON_FADE_DIST[1] - SIDE_ON_FADE_DIST[0]));
  return t * t * (3 - 2 * t);
}

/**
 * Forearm "bulb" (QA2 / round 3 leftover): with the racket raised (back-glass preparation, high
 * ready position) the elbow end of the forearm sits 0.2-0.35 m from the camera, where the per-pixel
 * depth fade leaves it half transparent: a large translucent blob at the bottom of the picture.
 * Round 4 faded the forearm along its length (and the stub by (1 - k)^2), but partial strengths
 * still left wide half-transparent areas: QA r5 saw a "ghost bulb" at the racket hand at contact.
 *
 * Round 5: no limb is ever drawn half transparent over a wide area. Every fade is a CUT with a
 * narrow soft edge, and what changes is WHERE the cut sits:
 * - along the forearm (t = 0 at the elbow, 1 at the wrist): alpha = smoothstep(c, c + band, t),
 *   c from alongCutStart(): -band with the upper-arm stub drawn (the whole forearm, elbow cap and
 *   all, joins the stub), ALONG_CUT.cap with the stub hidden (the rounded elbow cap is cut, so the
 *   forearm never ends in a sphere), up to ALONG_CUT.cuff when the elbow is at the eye (only the
 *   wrist end with the hand), and on to 1 + band as the wrist itself comes to the eye (hidden);
 * - by view depth (per fragment): nearCutAlpha(), a 3 cm band where a limb reaching toward the
 *   lens leaves the picture, at the depth where the old smooth fade was half transparent (same
 *   mean coverage of the picture, without the disc);
 * - the upper-arm stub is drawn solid or not at all (stubShown, with hysteresis).
 */
export const ALONG_CUT = Object.freeze({ band: 0.16, cap: 0.02, cuff: 0.5, near: 0.3, far: 0.42 });

/** Cut start c (in forearm length units) for the stub state and the elbow-to-eye distance (m). */
export function alongCutStart(stubDrawn, elbowDist) {
  if (stubDrawn) return -ALONG_CUT.band;
  const d = Number.isFinite(elbowDist) ? elbowDist : 1;
  const t = clamp01((d - ALONG_CUT.near) / (ALONG_CUT.far - ALONG_CUT.near));
  const k = 1 - t * t * (3 - 2 * t);
  return ALONG_CUT.cap + (ALONG_CUT.cuff - ALONG_CUT.cap) * k;
}

/**
 * Pushes the cut toward the wrist for a whole-forearm factor f (0..1: the wrist close to the eye,
 * beside the eye, side-on): f = 1 keeps c, f = 0 hides the forearm (c = 1 + band).
 */
export function alongCutHide(c, f) {
  const end = 1 + ALONG_CUT.band;
  return c + (end - c) * (1 - clamp01(f));
}

/** Forearm opacity at fraction t (0 elbow .. 1 wrist) for a cut starting at c. */
export function alongCutAlpha(t, c) {
  const u = clamp01((t - c) / ALONG_CUT.band);
  return u * u * (3 - 2 * u);
}

/** Per-fragment near cut: angular radius where a limb is cut (rad) and the half width of the band. */
export const NEAR_CUT = Object.freeze({ A: 0.2, dA: 0.009 });

/** View depths (m) of the near cut for a limb of `radius`: gone below `near`, solid beyond `far`. */
export function nearCutDepths(radius) {
  return { near: radius / (NEAR_CUT.A + NEAR_CUT.dA), far: radius / (NEAR_CUT.A - NEAR_CUT.dA) };
}

/** Opacity of a limb fragment of `radius` at view depth `depth` (m). */
export function nearCutAlpha(radius, depth) {
  const { near, far } = nearCutDepths(radius);
  const t = clamp01((depth - near) / (far - near));
  return t * t * (3 - 2 * t);
}

/**
 * Upper-arm stub drawn (solid) or hidden: only with the elbow well away from the eye (on at
 * STUB_SHOW.on, off below STUB_SHOW.off: hysteresis), the view not pitched down at the body (the
 * stub's end read as a disc over the torso) and the arm not raised / beside the eye / side-on.
 */
export const STUB_SHOW = Object.freeze({ on: 0.66, off: 0.6, minViewY: -0.34 });
export function stubShown(prev, elbowDist, viewDirY, factor) {
  if (!(factor >= 0.5)) return false;
  if (Number.isFinite(viewDirY) && viewDirY < STUB_SHOW.minViewY) return false;
  if (!Number.isFinite(elbowDist)) return false;
  return prev ? elbowDist >= STUB_SHOW.off : elbowDist >= STUB_SHOW.on;
}

/** Longest forearm drawn (x nominal): a stretched tracked forearm is drawn at this length from the wrist. */
export const FOREARM_MAX_RATIO = 1.12;
