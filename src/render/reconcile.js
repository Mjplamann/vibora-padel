// Visual reconciliation of lag-compensated hits. A player hit is detected ~0.1–0.25 s after its
// contact (camera, inference, one settled frame); the game rewinds and re-simulates, so the live
// ball jumps from its old (erased) path to the new one. The renderer never shows that jump:
// at a correction the rendered ball keeps its on-screen position and takes the new (outgoing)
// velocity at once, like a struck ball, while the offset to the true ball blends out with a
// smoothstep over BLEND_S (no velocity kink at either end). After ~140 ms it flies on the real
// trajectory. Pure module (no three): returns a render-ball proxy for ballView.update().

export const RECONCILE_BLEND_S = 0.14;

const smoothstep = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/**
 * @returns {{ update(ball, correction, dt): BallState-like|null, offset: {x,y,z}, active: boolean }}
 *   correction: world.ballCorrection ({ seq, ballId, ... }) or null.
 */
export function createBallReconciler({ blend = RECONCILE_BLEND_S } = {}) {
  const off0 = { x: 0, y: 0, z: 0 };
  const offset = { x: 0, y: 0, z: 0 };
  const last = { x: 0, y: 0, z: 0 };
  const lastVel = { x: 0, y: 0, z: 0 };
  let lastId = null;
  let hasLast = false;
  let seenSeq = null;
  let tBlend = Infinity;
  const proxy = { pos: { x: 0, y: 0, z: 0 }, vel: null, spin: null, atRest: false, outside: false, id: null, t: 0 };

  const clear = () => {
    off0.x = off0.y = off0.z = 0;
    offset.x = offset.y = offset.z = 0;
    tBlend = Infinity;
  };

  function update(ball, correction, dt) {
    if (!ball) {
      hasLast = false;
      lastId = null;
      clear();
      return null;
    }
    if (ball.id !== lastId) {
      // A new ball (launch / replay seek): nothing to reconcile.
      clear();
      hasLast = false;
      lastId = ball.id;
    }
    const seq = correction ? correction.seq : null;
    if (seq !== null && seq !== seenSeq) {
      if (hasLast && correction.ballId === ball.id) {
        // Keep what is on screen (the old path, one frame on): the offset takes up the jump.
        off0.x = last.x + lastVel.x * dt - ball.pos.x;
        off0.y = last.y + lastVel.y * dt - ball.pos.y;
        off0.z = last.z + lastVel.z * dt - ball.pos.z;
        tBlend = 0;
      }
      seenSeq = seq;
    } else if (tBlend < blend && dt > 0) {
      tBlend += dt;
    }
    const k = tBlend >= blend ? 0 : 1 - smoothstep(tBlend / blend);
    if (k === 0) clear();
    offset.x = off0.x * k;
    offset.y = off0.y * k;
    offset.z = off0.z * k;
    const p = proxy.pos;
    p.x = ball.pos.x + offset.x;
    p.y = Math.max(0, ball.pos.y + offset.y);
    p.z = ball.pos.z + offset.z;
    last.x = p.x; last.y = p.y; last.z = p.z;
    if (ball.vel) { lastVel.x = ball.vel.x; lastVel.y = ball.vel.y; lastVel.z = ball.vel.z; }
    hasLast = true;
    if (k === 0) return ball;
    proxy.vel = ball.vel;
    proxy.spin = ball.spin;
    proxy.atRest = ball.atRest;
    proxy.outside = ball.outside;
    proxy.id = ball.id;
    proxy.t = ball.t;
    return proxy;
  }

  return { update, get offset() { return offset; }, get active() { return tBlend < blend; } };
}
