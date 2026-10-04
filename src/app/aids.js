// Training aids computed from the live ball: the predicted first bounce on the player's side
// (landing marker) and the ideal contact point (contact ghost). Re-predicted per flight and
// every 0.3 s, so mesh scatter or a net cord is picked up. With timing hits (game/swingAssist.js)
// the contact marker is the planned contact p*: shown for balls off the glass whenever the ball
// visibility aids are on (round 3 off-the-glass coaching), for every ball at 'max' visibility, or
// with the ghost setting. Pure module.
import { predictFlight } from '../game/world.js';
import { interceptCandidates } from '../physics/predict.js';
import { playableCandidates, pickGlassContact } from '../game/intercept.js';
import { timingConfig, flightKeyOf } from '../game/swingAssist.js';

/** The timing plan's contact marker {x, y, z, t} for this frame, or null. */
export function timingMarker(world, { wantGhost = false } = {}) {
  const T = world.timing;
  const P = T && T.plan;
  if (!P || !timingConfig(world) || P.key !== flightKeyOf(world)) return null;
  if (P.closed || (T.decided && T.decided.key === P.key)) return null;
  const vis = world.settings.ballVisibility || 'enhanced';
  const want = wantGhost || vis === 'max' || (P.glass && vis !== 'realistic');
  if (!want || world.time > P.tStar + 0.25) return null;
  return { x: P.pStar.x, y: P.pStar.y, z: P.pStar.z, t: P.tStar };
}

export function createAids() {
  let key = null;
  let at = -Infinity;
  let landing = null;
  let ghost = null;
  const out = { landing: null, ghost: null };

  function clear() {
    key = null;
    landing = ghost = null;
    out.landing = out.ghost = null;
    return out;
  }

  /** @returns {{landing: Vec3|null, ghost: Vec3|null}} */
  function update(world, { wantLanding = true, wantGhost = false } = {}) {
    const ball = world.ball;
    const f = world.flight;
    const incoming = ball && !ball.atRest && !ball.outside && f && f.team !== 0 && f.by !== 'drop';
    // Timing hits: the planned contact is the marker (its own rules), the landing marker as before.
    const tm = incoming && !world.spec && timingConfig(world) ? timingMarker(world, { wantGhost }) : null;
    if (timingConfig(world)) wantGhost = false;
    if (!incoming || (!wantLanding && !wantGhost && !tm)) return clear();
    // A predicted hit is showing (game/world.js world.spec): the incoming ball is struck on
    // screen, so its bounce marker and contact ghost would point at a path the player left.
    if (world.spec) return clear();
    if (tm && !wantLanding) {
      out.landing = null;
      out.ghost = tm;
      return out;
    }
    const k = `${ball.id}:${f.startT}`;
    if (k !== key || world.time - at > 0.3) {
      key = k;
      at = world.time;
      const pred = predictFlight(world, { maxTime: 3 });
      landing = null;
      let bouncedNear = false;
      for (const e of pred.events) {
        if (e.type !== 'bounce' || e.side !== 'near') continue;
        if (e.t < world.time - 1e-6) bouncedNear = true;
        else if (!bouncedNear && !landing) landing = e.pos;
        break;
      }
      ghost = null;
      if (wantGhost) {
        const pl = world.player;
        // Never a ghost against the glass: the contacts a player can swing at (game/intercept.js),
        // off the glass once it has come out when the drill plays the glass.
        const cands = playableCandidates(interceptCandidates(pred, {
          playerPos: pl.pos, side: 'near', now: world.time, minHeight: 0.3, maxHeight: 2.4 * ((pl.height || 1.75) / 1.75),
        })).filter((x) => x.t > world.time + 0.05);
        const hint = world.mode && world.mode.apHints;
        const c = (hint && hint.contact === 'glass' && pickGlassContact(cands, pl.height)) || cands[0];
        if (c) ghost = { x: c.pos.x, y: c.pos.y, z: c.pos.z, t: c.t };
      }
    }
    if (ghost && ghost.t < world.time - 0.05) ghost = null;
    out.landing = wantLanding ? landing : null;
    out.ghost = tm || (wantGhost ? ghost : null);
    return out;
  }

  return { update, clear };
}
