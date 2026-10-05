// Racket trail tuning and strength (round 4, smooth swings): pure (no three.js), shared by
// render/racketTrail.js and the tests.
import { RACKET } from '../config.js';

export const TRAIL = Object.freeze({
  /** Samples kept and their longest age (s). */
  samples: 18,
  maxAge: 0.11,
  /** Head speed (m/s) where the ribbon starts to show and where it is fully on. */
  speedOn: 6,
  speedFull: 15,
  /** Peak opacity, and the distance (m) from the eye inside which the ribbon is not drawn. */
  opacity: 0.32,
  nearEye: 0.3,
  /** Points along the racket axis (from the grip) the ribbon spans: throat and tip. */
  inner: RACKET.faceCenterY - RACKET.faceSemiY * 0.8,
  outer: RACKET.length + RACKET.buttY - 0.01,
});

/** Opacity factor (0..1) of the ribbon for a head speed (m/s). */
export function trailStrength(speed) {
  const t = Math.min(1, Math.max(0, (speed - TRAIL.speedOn) / (TRAIL.speedFull - TRAIL.speedOn)));
  return t * t * (3 - 2 * t);
}

/**
 * Round 6 (swing power): a player stroke's effort (0..1, game/timingProfile.js) scales the ribbon for
 * `hold` s after the hit: opacity and length x (0.6 + 0.8 effort), and a full swing shows a ribbon
 * even when the drawn racket is slow (a slow webcam measures 2-9 m/s: below TRAIL.speedOn).
 */
export const TRAIL_POWER = Object.freeze({ hold: 0.35, base: 0.6, gain: 0.8, floor: 0.55 });

/** { k: strength / length factor, floor: least strength } of an effort (null: no change). */
export function trailPowerOf(effort) {
  if (!Number.isFinite(effort)) return { k: 1, floor: 0 };
  const e = Math.min(1, Math.max(0, effort));
  return { k: TRAIL_POWER.base + TRAIL_POWER.gain * e, floor: e >= 0.5 ? TRAIL_POWER.floor * (e - 0.5) * 2 : 0 };
}

// The last player stroke's power (app/wiring.js 'player:hit' -> setTrailPower). Module state: there is
// one first-person racket trail (render/fpRig.js), which decays `left` with its own dt (racketTrail.js).
export const trailPower = { k: 1, floor: 0, left: 0 };

/** A player stroke's effort (0..1, or null) scales the ribbon for TRAIL_POWER.hold s. */
export function setTrailPower(effort) {
  const p = trailPowerOf(effort);
  trailPower.k = p.k;
  trailPower.floor = p.floor;
  trailPower.left = Number.isFinite(effort) ? TRAIL_POWER.hold : 0;
}
