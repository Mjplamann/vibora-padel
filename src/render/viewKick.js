// Swing-power view kick (round 6, "would be cool if swing speed made an impact"). A top-effort stroke
// (game/timingProfile.js effort >= KICK.minEffort) nudges the first-person view up by at most
// KICK.maxDeg, decaying with time constant KICK.tau s. Pure (render/fpCamera.js applies it to the pitch;
// app/wiring.js triggers it on 'player:hit'); no kick with head tracking (glasses).

export const KICK = Object.freeze({ maxDeg: 0.6, tau: 0.08, minEffort: 0.85 });

const DEG = Math.PI / 180;

/** Kick (deg) of a stroke's effort: 0 below KICK.minEffort, KICK.maxDeg / 2 there, KICK.maxDeg at 1. */
export function kickDegOf(effort) {
  if (!(effort >= KICK.minEffort)) return 0;
  return KICK.maxDeg * (0.5 + 0.5 * Math.min(1, (effort - KICK.minEffort) / (1 - KICK.minEffort)));
}

/** { add(effort) -> deg, step(dt) -> rad, rad, deg }: the kick's pitch offset (rad, up). */
export function createViewKick() {
  let rad = 0;
  return {
    add(effort) {
      const d = kickDegOf(effort);
      if (d > 0) rad = Math.max(rad, d * DEG);
      return d;
    },
    step(dt) {
      if (rad !== 0) {
        rad *= Math.exp(-Math.max(0, dt || 0) / KICK.tau);
        if (Math.abs(rad) < 1e-5) rad = 0;
      }
      return rad;
    },
    get rad() { return rad; },
    get deg() { return rad / DEG; },
  };
}
