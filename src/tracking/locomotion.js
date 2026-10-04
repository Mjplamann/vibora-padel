// Real-room steps -> court position target (amplified). Pure module.
//
// Stepping to the right moves the player right (+x on court). Stepping toward the TV
// (offset.d < 0) moves the player toward the net (court z decreases). The player's
// actual motion toward the target (speed / acceleration limits) belongs to the world.

import { COURT, PLAYER, TRACKING } from '../config.js';
import { clamp } from '../util/math.js';

/** Max distance the magnet may pull the target, m (SPEC §4.4). */
export const MAGNET_MAX_PULL = 1.2;

/**
 * How close the player's body may come to the enclosure (m, body centre to the glass plane). QA:
 * with only the body radius (0.3 m) a glass rep pinned the player against the back glass and the
 * racket swung 40-57 cm through it. A real player keeps a stride from the back glass and stays
 * clear of the side glass to swing.
 */
export const ENCLOSURE_MARGIN = Object.freeze({ back: 0.6, side: 0.45 });

/** Near-half bounds for the body (court x/z of the feet): enclosure margins plus the net keep-out. */
export function defaultBounds() {
  return {
    xMin: -COURT.halfWidth + ENCLOSURE_MARGIN.side,
    xMax: COURT.halfWidth - ENCLOSURE_MARGIN.side,
    zMin: PLAYER.netKeepOut,
    zMax: COURT.halfLength - ENCLOSURE_MARGIN.back,
  };
}

/**
 * Deadzone with a quadratic soft knee (C1-continuous). |v| <= dz - knee/2 -> 0,
 * |v| >= dz + knee/2 -> |v| - dz, smooth in between. Sign preserved.
 */
export function softDeadzone(v, deadzone, knee = deadzone) {
  const a = Math.abs(v);
  if (deadzone <= 0) return v;
  const k = Math.max(1e-9, Math.min(knee, 2 * deadzone));
  const lo = deadzone - k / 2, hi = deadzone + k / 2;
  let out;
  if (a <= lo) out = 0;
  else if (a >= hi) out = a - deadzone;
  else out = ((a - lo) * (a - lo)) / (2 * k);
  return v < 0 ? -out : out;
}

/**
 * @param cfg { gainLateral, gainDepth, deadzone, knee? } defaults from TRACKING
 * @returns Locomotion = { setHome({x,z}), moveHome({x,z}), update(sample, dt, ctx) -> { target: {x,z} }, target, home, config }
 */
export function createLocomotion(cfg = {}) {
  const conf = {
    gainLateral: cfg.gainLateral ?? TRACKING.gainLateral,
    gainDepth: cfg.gainDepth ?? TRACKING.gainDepth,
    deadzone: cfg.deadzone ?? TRACKING.deadzone,
    knee: cfg.knee ?? cfg.deadzone ?? TRACKING.deadzone,
  };
  const home = { x: 0, z: 8 };
  const target = { x: home.x, z: home.z };

  function setHome({ x, z }) {
    home.x = x;
    home.z = z;
    // A new home (drill start, side switch) re-anchors the target until the next sample.
    target.x = x;
    target.z = z;
  }

  /**
   * Moves the home (a gliding tactical home) and the current target with it, so the player's
   * own room offset is kept between samples.
   */
  function moveHome({ x, z }) {
    target.x += x - home.x;
    target.z += z - home.z;
    home.x = x;
    home.z = z;
  }

  /**
   * @param sample BodySample|null
   * @param dt seconds (unused: the mapping is positional)
   * @param ctx { bounds?: {xMin,xMax,zMin,zMax}, magnet?: {x,z}|null, magnetStrength?: 0..1 }
   */
  function update(sample, dt, ctx = {}) {
    if (!sample || sample.valid === false || !sample.offset) return { target: { x: target.x, z: target.z } };
    let x = home.x + conf.gainLateral * softDeadzone(sample.offset.x, conf.deadzone, conf.knee);
    let z = home.z + conf.gainDepth * softDeadzone(sample.offset.d, conf.deadzone, conf.knee);

    const m = ctx.magnet;
    const strength = clamp(ctx.magnetStrength ?? 0, 0, 1);
    if (m && strength > 0) {
      const dx = m.x - x, dz = m.z - z;
      const dist = Math.hypot(dx, dz);
      if (dist > 1e-9) {
        const pull = Math.min(dist, MAGNET_MAX_PULL) * strength;
        x += (dx / dist) * pull;
        z += (dz / dist) * pull;
      }
    }

    const b = ctx.bounds || defaultBounds();
    const zMin = Math.max(b.zMin, PLAYER.netKeepOut);
    target.x = clamp(x, b.xMin, b.xMax);
    target.z = clamp(z, zMin, b.zMax);
    return { target: { x: target.x, z: target.z } };
  }

  return {
    setHome,
    moveHome,
    update,
    get target() {
      return { x: target.x, z: target.z };
    },
    get home() {
      return { x: home.x, z: home.z };
    },
    config: conf,
  };
}
