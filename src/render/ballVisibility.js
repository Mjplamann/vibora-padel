// Ball visibility (render/ballView.js), pure so the depth-cue rule is tested under Node (round 6).
import { BALL } from '../config.js';

/**
 * Ball visibility (round 3, "like trying to hit a fruit fly" from 2-3 m on a TV): 'realistic' is the
 * true ball; 'enhanced' (default) adds a soft glow halo, a stronger contact shadow and a thin
 * drop-line to the floor; 'max' also keeps the ball at least 0.8° wide.
 * Round 6: 'enhanced' draws the TRUE size up to ENHANCED_TRUE_SIZE_WITHIN m (it used to stay 0.45°
 * wide out to 8.3 m, so the ball stopped shrinking with distance and looked closer than it was: an
 * early-swing cue); only a ball further than 14 m is held at that size. The glow halo keeps it
 * findable instead (glowMinDeg: the halo never gets smaller than that, soft so it is no size cue).
 */
export const ENHANCED_TRUE_SIZE_WITHIN = 14;
/** Angular diameter (deg) of the true ball at distance d (m). */
export const ballDeg = (d) => (2 * Math.atan(BALL.radius / d) * 180) / Math.PI;
export const BALL_VISIBILITY = Object.freeze({
  realistic: Object.freeze({ minDeg: 0, glow: 0, glowMinDeg: 0, line: 0, shadow: 0.62, shadowFall: 2.2 }),
  enhanced: Object.freeze({ minDeg: ballDeg(ENHANCED_TRUE_SIZE_WITHIN), glow: 0.44, glowMinDeg: 0.85, line: 0.42, shadow: 0.85, shadowFall: 0.9 }),
  max: Object.freeze({ minDeg: 0.8, glow: 0.6, glowMinDeg: 1.3, line: 0.62, shadow: 0.95, shadowFall: 0.5 }),
});

/** Drawn-size factor that keeps a ball of radius r at distance d at least minDeg wide (>= 1). */
export function ballDisplayScale(d, minDeg, r = BALL.radius) {
  if (!(minDeg > 0) || !(d > 0)) return 1;
  const want = 2 * d * Math.tan((minDeg * Math.PI) / 360);
  return Math.max(1, want / (2 * r));
}

