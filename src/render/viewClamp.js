// Visual-only enclosure clamp for the first-person racket (QA2: a backswing beside the back glass
// was drawn 40-57 cm through it). The physics never sees this: hits use the tracked pose. Pure
// module (plain {x,y,z}) so it is tested under Node.
import { COURT, RACKET } from '../config.js';

/** Gap kept between the racket frame and the glass (m), and the soft knee width (m). */
export const RACKET_CLAMP = Object.freeze({ gap: 0.03, knee: 0.05 });

// Probe points along the racket (axis offset from the grip, sideways offset across the face).
const PROBES = [
  [RACKET.buttY, 0], [RACKET.length + RACKET.buttY, 0],
  [RACKET.faceCenterY, RACKET.headWidth / 2], [RACKET.faceCenterY, -RACKET.headWidth / 2],
];

const soft = (p, k) => (p <= -k ? 0 : p >= k ? p : ((p + k) * (p + k)) / (4 * k));

/**
 * Shift {dx, dz} (m, court) to ADD to the racket's grip so its frame stays inside the back and side
 * glass. Soft knee: zero until a probe is within `knee` of the limit, then C1-smooth, and exactly
 * the penetration beyond it.
 */
export function racketEnclosureShift(grip, axis, normal, { gap = RACKET_CLAMP.gap, knee = RACKET_CLAMP.knee } = {}) {
  // Across-the-face direction = axis x normal.
  let sx = axis.y * normal.z - axis.z * normal.y;
  let sz = axis.x * normal.y - axis.y * normal.x;
  const sy = axis.z * normal.x - axis.x * normal.z;
  const sl = Math.hypot(sx, sy, sz);
  if (sl < 1e-6) { sx = 1; sz = 0; } else { sx /= sl; sz /= sl; }
  const L = COURT.halfLength - gap, W = COURT.halfWidth - gap;
  let pz = -Infinity, nz = -Infinity, px = -Infinity, nx = -Infinity;
  for (const [y, w] of PROBES) {
    const x = grip.x + axis.x * y + sx * w, z = grip.z + axis.z * y + sz * w;
    pz = Math.max(pz, z - L);
    nz = Math.max(nz, -L - z);
    px = Math.max(px, x - W);
    nx = Math.max(nx, -W - x);
  }
  return { dx: soft(nx, knee) - soft(px, knee), dz: soft(nz, knee) - soft(pz, knee) };
}
