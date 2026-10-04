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
