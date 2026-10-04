// Contact planning near the enclosure, shared by the tactical home (tactics.js), the autopilot
// and (via human.interceptStance) the assist magnet. Pure module.
//
// QA2: the glass reps took the first comfortable sample right after the rebound (0.3-0.6 m off
// the back glass) and the stance (+0.34 m behind the contact) was clamped against the glass, so the
// racket swung through it. A padel player lets the ball come off the glass: contacts here are at
// least GLASS_CLEAR off the back glass and stances no deeper than STANCE_Z_MAX.

import { COURT } from '../config.js';
import { defaultBounds } from '../tracking/locomotion.js';

/** Deepest stance (court z of the feet) a plan may ask for, m. */
export const STANCE_Z_MAX = 9.2;
/** Minimum contact distance from the back glass by candidate kind, and from the side glass, m. */
export const GLASS_CLEAR = Object.freeze({ ground: 1.1, glass: 1.2, volley: 0.8, side: 0.45 });
/** Glass rep: the contact window after the glass (m off the back glass) and its max height (x height/1.75). */
export const GLASS_WINDOW = Object.freeze({ near: 1.2, far: 2.8, maxHeight: 1.72, minHeight: 0.55 });

/** defaultBounds() with the planning depth limit (STANCE_Z_MAX). */
export function stanceBounds() {
  const b = defaultBounds();
  b.zMax = Math.min(b.zMax, STANCE_Z_MAX);
  return b;
}

/**
 * The intercept candidates (physics/predict.interceptCandidates) a player can actually swing at:
 * not jammed against the back glass or the side glass. Order is preserved.
 */
export function playableCandidates(cands) {
  if (!cands || !cands.length) return cands || [];
  const L = COURT.halfLength, W = COURT.halfWidth;
  return cands.filter((c) => {
    const clear = c.kind === 'after-wall' ? GLASS_CLEAR.glass : c.kind === 'volley' ? GLASS_CLEAR.volley : GLASS_CLEAR.ground;
    return Math.abs(c.pos.z) <= L - clear && Math.abs(c.pos.x) <= W - GLASS_CLEAR.side;
  });
}

/**
 * "Salida de pared": the first after-wall contact that has come out of the glass into the window
 * (1.2-2.8 m off it) at a height a groundstroke can take (<= 1.72 m), else the first comfortable
 * one further out. cands: playable candidates; returns one of them or null.
 */
export function pickGlassContact(cands, height = 1.75) {
  const k = height / 1.75;
  const L = COURT.halfLength;
  const aw = cands.filter((c) => c.kind === 'after-wall').sort((a, b) => a.t - b.t);
  if (!aw.length) return null;
  const inWin = aw.filter((c) => {
    const off = L - Math.abs(c.pos.z);
    return off >= GLASS_WINDOW.near && off <= GLASS_WINDOW.far && c.height <= GLASS_WINDOW.maxHeight * k && c.height >= GLASS_WINDOW.minHeight * k;
  });
  if (inWin.length) {
    // Within the first 0.25 s of the window, the height nearest a waist-to-chest contact.
    const near = inWin.filter((c) => c.t - inWin[0].t < 0.25);
    return near.reduce((b, c) => (Math.abs(c.height - 1.1 * k) < Math.abs(b.height - 1.1 * k) ? c : b), near[0]);
  }
  const comfy = aw.filter((c) => c.comfortable && !c.cramped);
  return comfy.length ? comfy[0] : null;
}
