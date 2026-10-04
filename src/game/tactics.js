// Tactical home: the court spot the player's calibrated room position maps to. A living room
// gives about ±0.6 m of real steps toward / away from the TV and ±1 m sideways, which the
// locomotion gains turn into roughly ±1.3 m / ±2.6 m of court. Padel needs more than that (a
// chiquita at the feet, a lob over the head, holding the net), so the game moves the home and
// the player's own steps do the fine positioning:
//   - the incoming ball's playable contact (drill intent via mode.apHints) is predicted; the
//     home glides only by the part of the stance that lies beyond comfortable reach (REACH_*),
//     so the player still has to step to every ball;
//   - in rally / match (netGame) the base itself follows padel tactics: after a serve, a volley,
//     a lob or a shot from mid-court the player holds the net; after a groundstroke from the
//     back they stay back. A lob over them pulls them back through the reach rule above.
// Near the enclosure the plan follows padel technique (game/intercept.js, QA2): glass balls are
// played once they have come >= 1.2 m off the glass, groundstrokes >= 1.1 m off it, and no stance
// is planned deeper than 9.2 m (the body itself stays >= 0.6 m off the back glass).
// The glide is critically damped with a speed cap (no jumps). Pure module.

import { clamp } from '../util/math.js';
import { stanceBounds, playableCandidates, pickGlassContact } from './intercept.js';
import { interceptCandidates } from '../physics/predict.js';
import { pickIntercept, contactFamily, idealStance } from './human.js';
import { predictFlight } from './world.js';

export const TACTICS = Object.freeze({
  REACH_DEPTH: 0.9, // court m covered by the player's own steps toward / away from the TV
  REACH_LATERAL: 1.8, // court m covered sideways
  MAX_SPEED: 4.5, // m/s: a padel player's sprint to a short ball
  LAMBDA: 5, // 1/s critically damped glide
  REFRESH: 0.25, // s between intercept predictions
  COMMIT: 0.6, // s before the predicted contact when it stops being re-planned
  NET_Z: 3.8, // net position (court z) in rally / match
  NET_FROM_Z: 5.5, // a shot struck in front of this sends the player to the net
});

/**
 * Predicted contact and stance for the incoming ball, like human.interceptStance but planned the
 * way a padel player does it near the enclosure (QA2): only contacts that have come >= 1.1-1.2 m
 * off the back glass (playableCandidates), and stances no deeper than STANCE_Z_MAX (9.2 m).
 * @returns {{x, z, t, family, contact}|null}
 */
export function planIntercept(world, { maxTime = 3 } = {}) {
  const pl = world.player;
  if (!world.ball) return null;
  const pred = predictFlight(world, { maxTime });
  const cands = playableCandidates(interceptCandidates(pred, {
    playerPos: pl.pos, side: 'near', now: world.time - (world.settings.latency || 0), minHeight: 0.3, maxHeight: 2.4,
  }));
  const m = world.mode;
  const hint = m && m.apHints ? m.apHints : null;
  const c = (hint && hint.contact === 'glass' && pickGlassContact(cands, pl.height)) || pickIntercept(cands, hint, pl.height);
  if (!c) return null;
  const handed = world.settings.handed || pl.handed;
  const fam = contactFamily(c.pos, c.kind, pl.pos, handed, pl.height);
  const s = idealStance(c.pos, fam, handed, pl.height);
  const b = stanceBounds();
  return { x: clamp(s.x, b.xMin, b.xMax), z: clamp(s.z, b.zMin, b.zMax), t: c.t, family: fam, contact: c.pos };
}

const excess = (v, reach) => (v > reach ? v - reach : v < -reach ? v + reach : 0);

/**
 * @param {{ netGame?: boolean }} o netGame: rally / match tactics (net vs back base)
 * @returns {{ setBase(world, p, opts?), update(world, dt), onPlayerShot(world, shot), state }}
 */
export function createTacticalHome({ netGame = false } = {}) {
  const base = { x: 0, z: 8 };
  const backBase = { x: 0, z: 8 };
  const vel = { x: 0, z: 0 };
  let key = null;
  let at = -Infinity;
  let ic = null;
  const state = { phase: 'back', target: { x: 0, z: 8 }, intercept: null };

  /** The mode's own spot (drill home, rally / receive position). snap teleports the player there. */
  function setBase(world, p, { snap = true } = {}) {
    base.x = backBase.x = p.x;
    base.z = backBase.z = p.z;
    state.phase = 'back';
    if (netGame && p.z < TACTICS.NET_FROM_Z) {
      // Starting at the net (the partner serves): "back" is the baseline position.
      state.phase = 'net';
      backBase.z = 7.8;
    }
    const pl = world.player;
    pl.homeTarget = { x: p.x, z: p.z };
    key = null;
    ic = null;
    if (!snap) return; // glide there
    pl.home = { x: p.x, z: p.z };
    pl.snapToHome = true;
    vel.x = vel.z = 0;
  }

  /** Rally / match: where to stand after the player's own stroke. */
  function onPlayerShot(world, shot) {
    if (!netGame || !shot) return;
    const net = shot.isServe || shot.volley || (shot.apex || 0) > 4.0 || (shot.contact && shot.contact.z < TACTICS.NET_FROM_Z);
    state.phase = net ? 'net' : 'back';
    base.x = backBase.x;
    base.z = net ? Math.min(backBase.z, TACTICS.NET_Z) : backBase.z;
  }

  function update(world, dt) {
    const pl = world.player;
    const b = world.ball;
    let tx = base.x, tz = base.z;
    const incoming = b && !b.atRest && !b.outside && world.flight.team !== 0 && world.flight.by !== 'drop';
    if (incoming) {
      const k = `${b.id}:${world.flight.startT}`;
      // Refresh the prediction, except once committed to a contact (< COMMIT s away): a player
      // does not re-plan mid-stroke when the overhead / volley chance is about to pass.
      const committed = k === key && ic && ic.t - world.time < TACTICS.COMMIT;
      if (k !== key || (!committed && world.time - at >= TACTICS.REFRESH)) {
        key = k;
        at = world.time;
        ic = planIntercept(world);
      }
      if (ic) {
        tx = base.x + excess(ic.x - base.x, TACTICS.REACH_LATERAL);
        tz = base.z + excess(ic.z - base.z, TACTICS.REACH_DEPTH);
      }
    } else {
      key = null;
      ic = null;
    }
    const bd = stanceBounds();
    tx = clamp(tx, bd.xMin, bd.xMax);
    tz = clamp(tz, bd.zMin, bd.zMax);
    state.target.x = tx;
    state.target.z = tz;
    state.intercept = ic;
    if (!pl.homeTarget) pl.homeTarget = { x: tx, z: tz };
    pl.homeTarget.x = tx;
    pl.homeTarget.z = tz;
    if (pl.snapToHome) return; // the controller teleports to pl.home this tick
    // Glide pl.home toward the target (critically damped, speed-capped).
    const L = TACTICS.LAMBDA;
    const h = pl.home;
    let vx = vel.x + (L * L * (tx - h.x) - 2 * L * vel.x) * dt;
    let vz = vel.z + (L * L * (tz - h.z) - 2 * L * vel.z) * dt;
    const sp = Math.hypot(vx, vz);
    if (sp > TACTICS.MAX_SPEED) {
      vx *= TACTICS.MAX_SPEED / sp;
      vz *= TACTICS.MAX_SPEED / sp;
    }
    vel.x = vx;
    vel.z = vz;
    if (Math.abs(tx - h.x) < 1e-4 && Math.abs(tz - h.z) < 1e-4 && sp < 1e-3) return;
    pl.home = { x: h.x + vx * dt, z: h.z + vz * dt };
  }

  return { setBase, update, onPlayerShot, get state() { return state; } };
}
