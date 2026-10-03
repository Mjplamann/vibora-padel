// Trajectory prediction, shot solving and intercept planning (SPEC §2.4). Pure module.
//
// Everything here runs the real ball integrator (ball.js: drag, Magnus, spin decay at
// 960 Hz) so the coach, the ball machine, landing markers and the autopilot see the
// same flight the game will simulate. Predictions are deterministic: mesh jitter is
// replaced by its expected value.

import { Vec3 } from '../util/vec3.js';
import { BALL, COURT, SIM, PLAYER, netHeightAt } from '../config.js';
import { createBall, cloneBall, stepBall, SUBSTEP_HZ } from './ball.js';
import { sideOf } from './court.js';

const R = BALL.radius;
const G = SIM.gravity;
const CORD_REACH = R + COURT.net.cordRadius;

/** Seconds of reaction/preparation charged before a player can start moving (SPEC). */
export const REACTION_TIME = 0.15;
/** Comfortable groundstroke contact height band (m), per coaching convention. */
export const COMFORT_MIN = 0.6;
export const COMFORT_MAX = 1.3;
/**
 * A contact closer than this to the back glass (or SIDE_ROOM to the side glass) leaves no
 * room for a swing; the textbook answer is to let the ball come off the glass.
 */
export const BACK_ROOM = 0.6;
export const SIDE_ROOM = 0.4;

const PREDICT_DEFAULTS = { maxTime: 4, dt: 1 / 240, stopOn: ['exit', 'rest'], deterministic: true, rng: null };

// ---------------------------------------------------------------------------
// predict

/**
 * Simulates a clone of ball with the real stepper.
 * @param ball  BallState (not modified)
 * @param court createCourt() result, or null for free flight
 * @param opts  { maxTime = 4, dt = 1/240, stopOn = ['exit','rest'], deterministic = true, rng = null }
 * @returns { samples: [{ t, pos: Vec3, vel: Vec3 }], events: [...], ball: BallState (final clone) }
 *   samples[0] is the starting state; one sample per dt. Simulation stops after the step
 *   in which an event whose type is in stopOn occurs (that sample is included).
 */
export function predict(ball, court, opts = {}) {
  const o = { ...PREDICT_DEFAULTS, ...opts };
  const b = cloneBall(ball);
  const samples = [{ t: b.t, pos: b.pos.clone(), vel: b.vel.clone() }];
  const events = [];
  const stopOn = o.stopOn || [];
  const stepOpts = { deterministic: !!o.deterministic };
  const rng = o.deterministic ? null : o.rng;
  const n = Math.max(1, Math.ceil(o.maxTime / o.dt - 1e-9));

  for (let i = 0; i < n; i++) {
    if (b.atRest) break;
    const first = events.length;
    stepBall(b, o.dt, court, rng, events, stepOpts);
    samples.push({ t: b.t, pos: b.pos.clone(), vel: b.vel.clone() });
    let stop = false;
    for (let k = first; k < events.length; k++) {
      if (stopOn.includes(events[k].type)) { stop = true; break; }
    }
    if (stop) break;
  }
  return { samples, events, ball: b };
}

/**
 * Ball-centre height above the net top (y - netHeightAt(x)) where the ball first crosses
 * z = 0, or null if it never crosses. Only the first crossing counts: a ball that later
 * comes back over the net off the far glass is not part of the shot's clearance. A net
 * or cord contact before that crossing (or without any crossing) reports the clearance
 * at that contact when it is lower. The cord is touched when the value drops below
 * r + cordRadius (about 5.75 cm).
 */
export function netClearance(prediction) {
  let best = null;
  let tCross = Infinity;
  const s = prediction.samples;
  for (let i = 1; i < s.length; i++) {
    const a = s[i - 1].pos;
    const b = s[i].pos;
    if ((a.z > 0 && b.z <= 0) || (a.z < 0 && b.z >= 0)) {
      const f = a.z / (a.z - b.z);
      const x = a.x + (b.x - a.x) * f;
      if (Math.abs(x) > COURT.halfWidth + R) continue; // passed beside the posts
      best = a.y + (b.y - a.y) * f - netHeightAt(x);
      tCross = s[i - 1].t + (s[i].t - s[i - 1].t) * f;
      break;
    }
  }
  for (const e of prediction.events) {
    if (e.t > tCross + 1e-9) break;
    let c = null;
    if (e.type === 'net') c = e.pos.y - netHeightAt(e.pos.x);
    else if (e.type === 'netcord') c = (e.pos.y - netHeightAt(e.pos.x)) * (CORD_REACH / COURT.net.cordRadius);
    if (c !== null && (best === null || c < best)) best = c;
    if (c !== null && tCross === Infinity) break;
  }
  return best;
}

/** First 'bounce' (turf) event of a prediction, or null. */
export function firstBounce(prediction) {
  for (const e of prediction.events) if (e.type === 'bounce') return e;
  return null;
}

// ---------------------------------------------------------------------------
// solveShot

const flyBall = createBall();
const flight = { landed: false, x: 0, z: 0, T: 0, apex: 0, net: null };

/**
 * Flies (pos, vel, spin) to the first floor contact (ball centre at y = r) in free air
 * with the real integrator. Writes landing x/z, flight time, apex (ball-centre height)
 * and net clearance into `flight`.
 */
function flyToFloor(from, vx, vy, vz, spin, maxTime) {
  const b = flyBall;
  b.pos.copy(from);
  b.vel.set(vx, vy, vz);
  b.spin.copy(spin);
  b.t = 0;
  b.outside = false;
  b.atRest = false;
  b.lastSurface = null;
  const h = 1 / SUBSTEP_HZ;
  const n = Math.ceil(maxTime / h);
  let apex = from.y;
  let net = null;
  flight.landed = false;
  for (let i = 0; i < n; i++) {
    const px = b.pos.x, py = b.pos.y, pz = b.pos.z;
    stepBall(b, h, null, null, null);
    const y = b.pos.y;
    if (y > apex) apex = y;
    const z = b.pos.z;
    if ((pz > 0 && z <= 0) || (pz < 0 && z >= 0)) {
      const f = pz / (pz - z);
      if (net === null) net = py + (y - py) * f - netHeightAt(px + (b.pos.x - px) * f);
    }
    if (y <= R && py > R) {
      const f = (py - R) / (py - y);
      flight.landed = true;
      flight.x = px + (b.pos.x - px) * f;
      flight.z = pz + (z - pz) * f;
      flight.T = (i + f) * h;
      break;
    }
  }
  if (!flight.landed) {
    flight.x = b.pos.x;
    flight.z = b.pos.z;
    flight.T = maxTime;
  }
  flight.apex = apex;
  flight.net = net;
  return flight;
}

/** Drag-free launch velocity landing at (tx, tz) (ball centre at y = r) after time T. */
function ballisticGuess(from, tx, tz, T, out) {
  return out.set((tx - from.x) / T, (R - from.y + 0.5 * G * T * T) / T, (tz - from.z) / T);
}

/** Drag-free flight time for a launch apex (ball-centre height). */
function timeForApex(from, apex) {
  const vy = Math.sqrt(2 * G * Math.max(0, apex - from.y));
  return (vy + Math.sqrt(vy * vy + 2 * G * Math.max(0, from.y - R))) / G;
}

/** Drag-free flight time of the lowest trajectory with launch speed S (or the min-speed one). */
function timeForSpeed(from, tx, tz, S) {
  const d = Math.hypot(tx - from.x, tz - from.z);
  const dy = R - from.y;
  const speedAt = (T) => Math.hypot(d / T, (dy + 0.5 * G * T * T) / T);
  // Speed is convex in T: find its minimum, then bisect on the fast (low) branch.
  let lo = 0.05, hi = 6;
  for (let i = 0; i < 60; i++) {
    const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
    if (speedAt(m1) < speedAt(m2)) hi = m2;
    else lo = m1;
  }
  const tMin = 0.5 * (lo + hi);
  if (speedAt(tMin) >= S) return tMin;
  lo = 0.02;
  hi = tMin;
  for (let i = 0; i < 60; i++) {
    const mid = 0.5 * (lo + hi);
    if (speedAt(mid) > S) lo = mid;
    else hi = mid;
  }
  return hi;
}

/**
 * Solves the launch velocity that makes a ball from `from` with world spin `spin` first
 * touch the floor at `target` (x, z; y ignored), with full drag and Magnus.
 * The third degree of freedom is fixed by, in priority order: `apex` (peak ball-centre
 * height, m), `flightTime` (s to the landing), `speed` (launch speed m/s, lowest
 * trajectory), or a 1.0 s flight time. Newton iterations (finite-difference Jacobian of
 * the real integrator, damped by a line search, ≤ maxIter).
 *
 * @returns { vel: Vec3, landing: Vec3 (y = 0), flightTime, netClearance (centre above the
 *   net top at z = 0, null if it does not cross), apex, ok (landing within 5 cm), error
 *   (landing miss, m), iterations, mode: 'apex'|'time'|'speed', clearsNet (centre passes
 *   above the cord: netClearance > r + cordRadius, or no crossing), blockedBy (with a
 *   court: first non-floor contact before the landing, e.g. 'net'|'netcord'|'wall', else null) }
 */
export function solveShot({
  from, target, spin = null, flightTime = null, apex = null, speed = null, court = null,
  maxIter = 10, tolerance = 0.005, maxTime = 8,
} = {}) {
  const w = spin || ZERO;
  const tx = target.x;
  const tz = target.z;

  let mode = 'time';
  let goal = 1.0;
  let T0 = 1.0;
  if (apex !== null && apex !== undefined && apex > from.y + 0.05) {
    mode = 'apex';
    goal = apex;
    T0 = timeForApex(from, apex);
  } else if (flightTime !== null && flightTime !== undefined && flightTime > 0) {
    goal = flightTime;
    T0 = flightTime;
  } else if (speed !== null && speed !== undefined && speed > 0) {
    mode = 'speed';
    goal = speed;
    T0 = timeForSpeed(from, tx, tz, speed);
  }

  const p = [0, 0, 0];
  const g0 = ballisticGuess(from, tx, tz, T0, new Vec3());
  p[0] = g0.x; p[1] = g0.y; p[2] = g0.z;

  // Residual weights for the line search: 1 s of flight ~ 10 m of landing error.
  const w3 = mode === 'time' ? 10 : 1;
  const F = [0, 0, 0];
  const residual = (q, out) => {
    const f = flyToFloor(from, q[0], q[1], q[2], w, maxTime);
    out[0] = f.x - tx;
    out[1] = f.z - tz;
    out[2] = mode === 'apex' ? f.apex - goal : mode === 'time' ? f.T - goal : Math.hypot(q[0], q[1], q[2]) - goal;
    return out;
  };
  const norm = (f) => Math.hypot(f[0], f[1], w3 * f[2]);
  const thirdTol = mode === 'apex' ? 0.02 : mode === 'time' ? 0.002 : 0.02;

  residual(p, F);
  let fn = norm(F);
  let iterations = 0;
  const J = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const Fd = [0, 0, 0];
  const trial = [0, 0, 0];
  const Ft = [0, 0, 0];
  const dp = [0, 0, 0];

  while (iterations < maxIter && (Math.hypot(F[0], F[1]) > tolerance || Math.abs(F[2]) > thirdTol)) {
    iterations++;
    for (let j = 0; j < 3; j++) {
      const d = 0.01 * Math.max(1, Math.abs(p[j]) * 0.05);
      trial[0] = p[0]; trial[1] = p[1]; trial[2] = p[2];
      trial[j] += d;
      residual(trial, Fd);
      for (let i = 0; i < 3; i++) J[i][j] = (Fd[i] - F[i]) / d;
    }
    if (!solve3(J, F, dp)) break;
    let step = 1;
    let improved = false;
    for (let k = 0; k < 6; k++) {
      for (let j = 0; j < 3; j++) trial[j] = p[j] - step * dp[j];
      residual(trial, Ft);
      const ftn = norm(Ft);
      if (ftn < fn) {
        p[0] = trial[0]; p[1] = trial[1]; p[2] = trial[2];
        F[0] = Ft[0]; F[1] = Ft[1]; F[2] = Ft[2];
        fn = ftn;
        improved = true;
        break;
      }
      step *= 0.5;
    }
    if (!improved) break;
  }

  const f = flyToFloor(from, p[0], p[1], p[2], w, maxTime);
  const error = Math.hypot(f.x - tx, f.z - tz);
  const result = {
    vel: new Vec3(p[0], p[1], p[2]),
    landing: new Vec3(f.x, 0, f.z),
    flightTime: f.T,
    netClearance: f.net,
    apex: f.apex,
    ok: f.landed && error <= 0.05,
    error,
    iterations,
    mode,
    clearsNet: f.net === null || f.net > CORD_REACH,
    blockedBy: null,
  };
  if (court) result.blockedBy = firstObstacle(from, result.vel, w, court, f.T + 0.1);
  return result;
}

const ZERO = new Vec3();
const FLOOR_TYPES = ['bounce', 'outside-bounce'];

/** Runs the shot through the real court until its first contact; returns its type unless it is the floor. */
function firstObstacle(from, vel, spin, court, maxTime) {
  const b = createBall(from, vel, spin);
  const events = [];
  const dt = 1 / SIM.tickRate;
  const n = Math.ceil(maxTime / dt);
  for (let i = 0; i < n && events.length === 0; i++) stepBall(b, dt, court, null, events, { deterministic: true });
  if (events.length === 0) return null;
  const t = events[0].type;
  return FLOOR_TYPES.includes(t) ? null : t;
}

/** Solves J x = b (3x3) by Gaussian elimination with partial pivoting. Returns false if singular. */
function solve3(J, b, x) {
  const m = [
    [J[0][0], J[0][1], J[0][2], b[0]],
    [J[1][0], J[1][1], J[1][2], b[1]],
    [J[2][0], J[2][1], J[2][2], b[2]],
  ];
  for (let c = 0; c < 3; c++) {
    let piv = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(m[r][c]) > Math.abs(m[piv][c])) piv = r;
    if (Math.abs(m[piv][c]) < 1e-12) return false;
    if (piv !== c) { const tmp = m[c]; m[c] = m[piv]; m[piv] = tmp; }
    for (let r = c + 1; r < 3; r++) {
      const k = m[r][c] / m[c][c];
      for (let k2 = c; k2 < 4; k2++) m[r][k2] -= k * m[c][k2];
    }
  }
  for (let r = 2; r >= 0; r--) {
    let s = m[r][3];
    for (let c = r + 1; c < 3; c++) s -= m[r][c] * x[c];
    x[r] = s / m[r][r];
  }
  return true;
}

// ---------------------------------------------------------------------------
// interceptCandidates

const KIND_RANK_VOLLEY = 1;

/**
 * Reachable contact points for a player on `side`, walking the prediction in time.
 * Each sample on the player's half (and inside the enclosure) is labelled from the
 * events seen so far on that half:
 *   'volley'        before the ball's first bounce there,
 *   'after-bounce'  after that bounce,
 *   'after-wall'    after a wall/mesh contact that followed the bounce.
 * The walk ends at a second bounce, a wall touched before the bounce (the point is
 * already won), an exit, an outside bounce, the ceiling or rest.
 *
 * travel = max(0, horizontal distance from playerPos - reachRadius); the player needs
 * travel / maxSpeed + REACTION_TIME (0.15 s) to get there, so
 * slack = (t - now) - travel / maxSpeed - 0.15, with now = opts.now ?? samples[0].t.
 * Kept when slack >= 0, minHeight <= y <= maxHeight and t >= fromTime.
 *
 * Sorted by preference: groundstrokes (after-bounce / after-wall) at a comfortable
 * 0.6–1.3 m with room to swing (not `cramped` against the glass) first, then volleys,
 * then the other groundstrokes; earliest first within a group.
 * pos/vel are the prediction's own sample vectors (treat as read-only).
 *
 * @returns [{ t, pos, vel, kind, travel, slack, height, comfortable, cramped }]
 */
export function interceptCandidates(prediction, {
  playerPos, maxSpeed = PLAYER.maxSpeed, reachRadius = 1.0, minHeight = 0.15, maxHeight = 2.7,
  side = 'near', fromTime = 0, now = null,
} = {}) {
  const samples = prediction.samples;
  const events = prediction.events;
  if (!samples.length) return [];
  const t0 = now ?? samples[0].t;
  const px = playerPos ? playerPos.x : 0;
  const pz = playerPos ? playerPos.z : 0;
  const out = [];
  let phase = 0; // 0 = before bounce, 1 = bounced, 2 = after wall, 3 = dead
  let ei = 0;

  for (let i = 0; i < samples.length && phase < 3; i++) {
    const s = samples[i];
    while (ei < events.length && events[ei].t <= s.t + 1e-9) {
      phase = advancePhase(phase, events[ei], side);
      ei++;
    }
    if (phase >= 3) break;
    if (s.t < fromTime) continue;
    const p = s.pos;
    if (sideOf(p.z) !== side) continue;
    if (Math.abs(p.x) > COURT.halfWidth || Math.abs(p.z) > COURT.halfLength) continue;
    if (p.y < minHeight || p.y > maxHeight) continue;
    const travel = Math.max(0, Math.hypot(p.x - px, p.z - pz) - reachRadius);
    const slack = (s.t - t0) - travel / maxSpeed - REACTION_TIME;
    if (slack < 0) continue;
    const kind = phase === 0 ? 'volley' : phase === 1 ? 'after-bounce' : 'after-wall';
    const comfortable = p.y >= COMFORT_MIN && p.y <= COMFORT_MAX;
    const cramped = COURT.halfLength - Math.abs(p.z) < BACK_ROOM || COURT.halfWidth - Math.abs(p.x) < SIDE_ROOM;
    out.push({ t: s.t, pos: p, vel: s.vel, kind, travel, slack, height: p.y, comfortable, cramped });
  }

  const rank = (c) => (c.kind === 'volley' ? KIND_RANK_VOLLEY : c.comfortable && !c.cramped ? 0 : 2);
  out.sort((a, b) => rank(a) - rank(b) || a.t - b.t);
  return out;
}

function advancePhase(phase, e, side) {
  switch (e.type) {
    case 'bounce':
      if (e.side !== side) return phase;
      return phase === 0 ? 1 : 3;
    case 'wall':
      if (e.side !== side) return phase;
      return phase === 0 ? 3 : 2;
    case 'exit':
    case 'outside-bounce':
    case 'ceiling':
    case 'rest':
      return 3;
    default:
      return phase;
  }
}
