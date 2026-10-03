// Training aids computed from the live ball: the predicted first bounce on the player's side
// (landing marker) and the ideal contact point (contact ghost). Re-predicted per flight and
// every 0.3 s, so mesh scatter or a net cord is picked up. Pure module.
import { predictFlight } from '../game/world.js';
import { interceptCandidates } from '../physics/predict.js';

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
    if (!incoming || (!wantLanding && !wantGhost)) return clear();
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
        const cands = interceptCandidates(pred, {
          playerPos: pl.pos, side: 'near', now: world.time, minHeight: 0.3, maxHeight: 2.4 * ((pl.height || 1.75) / 1.75),
        });
        const c = cands.find((x) => x.t > world.time + 0.05);
        if (c) ghost = { x: c.pos.x, y: c.pos.y, z: c.pos.z, t: c.t };
      }
    }
    if (ghost && ghost.t < world.time - 0.05) ghost = null;
    out.landing = wantLanding ? landing : null;
    out.ghost = wantGhost ? ghost : null;
    return out;
  }

  return { update, clear };
}
