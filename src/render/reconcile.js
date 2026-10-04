// What the player is shown of the ball and racket around a hit. Pure module (no three).
//
// A hit is seen by the camera 0.25–0.35 s after the contact. The game therefore predicts the
// swing (game/swingPredict.js) and strikes the shown ball at once (a speculative hit), then the
// camera's view confirms it (the authoritative, lag-compensated hit) or undoes it (a whiff).
// Each change of the shown ball's path arrives as world.viewCorrection { seq, kind }:
//   strike  — the predicted racket met the ball: for one frame both are drawn at the contact
//             (ball on the strings, racket at the contact pose), then the ball leaves the face.
//   confirm — the speculative path is replaced by the real one.
//   revert  — no real contact: back to the unhit ball.
//   late    — a hit nobody predicted, found after the fact (the old behaviour).
// For confirm / revert / late the shown ball keeps its on-screen position and takes the new
// velocity at once, while the offset to the true ball blends out with a smoothstep (no velocity
// kink at either end). The blend lasts at least RECONCILE_BLEND_S and long enough that the
// offset never moves the ball more than MAX_OFFSET_SPEED (m/s, ~0.45 m per 60 Hz frame on top
// of its own motion).

import { viewBall } from '../game/world.js';
import { RACKET } from '../config.js';

export const RECONCILE_BLEND_S = 0.14;
/** Fastest the reconciling offset may move the shown ball (m/s): smoothstep peak slope 1.5. */
export const MAX_OFFSET_SPEED = 27;
/** Longest blend (s); a revert (whiff) settles faster. */
export const MAX_BLEND_S = 0.6;
export const MAX_REVERT_BLEND_S = 0.4;
/** The ball leaving the strings after a speculative strike (s). */
export const STRIKE_BLEND_S = 0.05;

const smoothstep = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/**
 * @returns {{ update(ball, correction, dt): BallState-like|null, offset: {x,y,z}, active: boolean, blend: number, struck: boolean }}
 *   correction: world.viewCorrection / world.ballCorrection ({ seq, ballId, kind?, contact? }) or null.
 */
export function createBallReconciler({ blend = RECONCILE_BLEND_S, maxSpeed = MAX_OFFSET_SPEED } = {}) {
  const off0 = { x: 0, y: 0, z: 0 };
  const offset = { x: 0, y: 0, z: 0 };
  const last = { x: 0, y: 0, z: 0 };
  const lastVel = { x: 0, y: 0, z: 0 };
  let lastId = null;
  let hasLast = false;
  let seenSeq = null;
  let tBlend = Infinity;
  let dur = blend;
  let struck = false; // the current frame is a strike frame
  const proxy = { pos: { x: 0, y: 0, z: 0 }, vel: null, spin: null, atRest: false, outside: false, id: null, t: 0 };

  const clear = () => {
    off0.x = off0.y = off0.z = 0;
    offset.x = offset.y = offset.z = 0;
    tBlend = Infinity;
  };

  function update(ball, correction, dt) {
    struck = false;
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
      if (correction.ballId === ball.id && correction.kind === 'strike' && correction.contact) {
        // Drawn on the strings this frame, then leaving the face.
        const c = correction.contact;
        off0.x = c.x - ball.pos.x;
        off0.y = c.y - ball.pos.y;
        off0.z = c.z - ball.pos.z;
        tBlend = 0;
        dur = STRIKE_BLEND_S;
        struck = true;
      } else if (hasLast && correction.ballId === ball.id) {
        // Keep what is on screen (the old path, one frame on): the offset takes up the jump.
        off0.x = last.x + lastVel.x * dt - ball.pos.x;
        off0.y = last.y + lastVel.y * dt - ball.pos.y;
        off0.z = last.z + lastVel.z * dt - ball.pos.z;
        tBlend = 0;
        const jump = Math.hypot(off0.x, off0.y, off0.z);
        const cap = correction.kind === 'revert' ? MAX_REVERT_BLEND_S : MAX_BLEND_S;
        dur = Math.min(cap, Math.max(blend, (1.5 * jump) / maxSpeed));
      }
      seenSeq = seq;
    } else if (tBlend < dur && dt > 0) {
      tBlend += dt;
    }
    const k = tBlend >= dur ? 0 : 1 - smoothstep(tBlend / dur);
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

  return {
    update,
    get offset() { return offset; },
    get active() { return tBlend < dur; },
    get blend() { return dur; },
    get struck() { return struck; },
  };
}

/**
 * The shown ball and racket of a World (or a replay frame) for this display frame:
 * { ball (reconciled, or null), racket (RacketPose to draw, or null), hitFrame (a strike frame:
 * ball on the strings, racket at the contact pose) }. Live worlds draw the speculative ball
 * and the predicted racket (player.renderRacket); replay frames their recorded ones.
 */
export function createViewSync(opts = {}) {
  const rec = createBallReconciler(opts);
  const out = { ball: null, racket: null, hitFrame: false };
  function update(w, dt) {
    if (!w) {
      rec.update(null, null, dt);
      out.ball = null;
      out.racket = null;
      out.hitFrame = false;
      return out;
    }
    const live = w.viewCorrection !== undefined;
    const b = live ? viewBall(w) : w.ball;
    const corr = live ? w.viewCorrection : w.ballCorrection || null;
    out.ball = rec.update(b || null, corr || null, dt);
    out.hitFrame = rec.struck;
    const pl = w.player;
    out.racket = out.hitFrame && corr && corr.pose ? corr.pose : pl ? pl.renderRacket || pl.racket || null : null;
    return out;
  }
  return { update, reconciler: rec, get state() { return out; } };
}

const RACKET_SWEET_Y = RACKET.sweetSpotY;

function frameAxes(p, out) {
  // x = axis x normal (racket frame of SPEC §6.4: +Y axis, +Z normal)
  const a = p.axis, n = p.normal;
  out.ax = a.x; out.ay = a.y; out.az = a.z;
  out.nx = n.x; out.ny = n.y; out.nz = n.z;
  out.xx = a.y * n.z - a.z * n.y; out.xy = a.z * n.x - a.x * n.z; out.xz = a.x * n.y - a.y * n.x;
  return out;
}
const fA = {}, fB = {};

/**
 * Elbow for an arm whose racket is drawn at `shown` instead of the tracked `tracked` pose
 * (the predicted swing runs ahead of the camera): the wrist rides with the racket and the
 * elbow is re-solved on the tracked segment lengths, bending the same way as the tracked arm.
 * Points are {x,y,z} (court). Writes and returns `out`, or null when nothing needs changing.
 */
export function elbowForRacket(shoulder, elbow, wrist, tracked, shown, out) {
  const dg = Math.hypot(shown.grip.x - tracked.grip.x, shown.grip.y - tracked.grip.y, shown.grip.z - tracked.grip.z);
  const da = Math.hypot(shown.axis.x - tracked.axis.x, shown.axis.y - tracked.axis.y, shown.axis.z - tracked.axis.z);
  if (dg < 0.005 && da < 0.01) return null;
  frameAxes(tracked, fA);
  frameAxes(shown, fB);
  // Wrist offset from the grip, carried from the tracked racket frame to the shown one.
  const vx = wrist.x - tracked.grip.x, vy = wrist.y - tracked.grip.y, vz = wrist.z - tracked.grip.z;
  const cx = fA.xx * vx + fA.xy * vy + fA.xz * vz;
  const ca = fA.ax * vx + fA.ay * vy + fA.az * vz;
  const cn = fA.nx * vx + fA.ny * vy + fA.nz * vz;
  const wx = shown.grip.x + fB.xx * cx + fB.ax * ca + fB.nx * cn;
  const wy = shown.grip.y + fB.xy * cx + fB.ay * ca + fB.ny * cn;
  const wz = shown.grip.z + fB.xz * cx + fB.az * ca + fB.nz * cn;
  const l1 = Math.hypot(elbow.x - shoulder.x, elbow.y - shoulder.y, elbow.z - shoulder.z);
  const l2 = Math.hypot(wrist.x - elbow.x, wrist.y - elbow.y, wrist.z - elbow.z);
  let dx = wx - shoulder.x, dy = wy - shoulder.y, dz = wz - shoulder.z;
  const dl = Math.hypot(dx, dy, dz);
  if (dl < 1e-6 || l1 < 1e-6 || l2 < 1e-6) return null;
  dx /= dl; dy /= dl; dz /= dl;
  const dist = Math.min(Math.max(dl, Math.abs(l1 - l2) + 1e-3), l1 + l2 - 1e-3);
  const cosA = Math.min(1, Math.max(-1, (l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist)));
  // Bend toward where the tracked elbow sits relative to the shoulder->wrist line.
  let px = elbow.x - shoulder.x, py = elbow.y - shoulder.y, pz = elbow.z - shoulder.z;
  const pd = px * dx + py * dy + pz * dz;
  px -= dx * pd; py -= dy * pd; pz -= dz * pd;
  let pl = Math.hypot(px, py, pz);
  if (pl < 1e-6) { px = 0; py = -1; pz = 0; pl = 1; }
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  out.x = shoulder.x + (dx * cosA + (px / pl) * sinA) * l1;
  out.y = shoulder.y + (dy * cosA + (py / pl) * sinA) * l1;
  out.z = shoulder.z + (dz * cosA + (pz / pl) * sinA) * l1;
  return out;
}

/** Sweet spot of a racket pose {grip, axis} ({x,y,z}). */
export function sweetOf(p, out = { x: 0, y: 0, z: 0 }) {
  out.x = p.grip.x + p.axis.x * RACKET_SWEET_Y;
  out.y = p.grip.y + p.axis.y * RACKET_SWEET_Y;
  out.z = p.grip.z + p.axis.z * RACKET_SWEET_Y;
  return out;
}
