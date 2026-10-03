// Ball machine on the far side (SPEC §5.2). Feeds are solved with the real flight model
// (drag + Magnus) so the first bounce lands on the requested point; the launch head
// slews toward the next feed during the countdown (the renderer shows it aiming).
// Pure module.

import { Vec3, v3 } from '../util/vec3.js';
import { createRng } from '../util/math.js';
import { BALL, SIM, netHeightAt } from '../config.js';
import { createBall, stepBall } from '../physics/ball.js';
import { solveShot } from '../physics/predict.js';
import { spinFromComponents } from '../physics/racket.js';
import { launchBall, emit } from './world.js';

/** Landing scatter of a good padel ball machine (1 sigma per axis, m). */
export const MACHINE_LANDING_SIGMA = 0.08;
/** Head slew rate (deg/s) and how long before a feed it is solved and aimed. */
export const HEAD_SLEW_DEG_S = 120;
export const AIM_LEAD = 1.0;
/**
 * While the feed gate is closed (machine.gate(world) === false) the countdown holds this far
 * from the shot, unaimed; once it opens the head re-aims for HOLD_LEAD s and fires.
 */
export const HOLD_LEAD = 0.6;

const R = BALL.radius;
const hzBall = createBall();

/** Height of the ball centre where it first reaches z = zPlane (free flight), or null. */
export function heightAtZ(from, vel, spin, zPlane, maxTime = 3) {
  const b = hzBall;
  b.pos.copy(from);
  b.vel.copy(vel);
  b.spin.copy(spin);
  b.t = 0;
  b.atRest = false;
  b.outside = false;
  const h = 1 / SIM.tickRate;
  const s0 = Math.sign(zPlane - from.z);
  for (let t = 0; t < maxTime; t += h) {
    const pz = b.pos.z, py = b.pos.y;
    stepBall(b, h, null, null, null);
    if (Math.sign(zPlane - b.pos.z) !== s0) {
      const f = (zPlane - pz) / (b.pos.z - pz);
      return py + (b.pos.y - py) * f;
    }
    if (b.pos.y < R) return b.pos.y;
  }
  return null;
}

function spinFor(feed, from, target) {
  const top = feed.spinRpm?.top ?? 0;
  const side = feed.spinRpm?.side ?? 0;
  return spinFromComponents(v3(target.x - from.x, 0, target.z - from.z), top, side);
}

/** Solves a feed whose ball must pass `via` {x, y, z} at speedKmh (landing found by bisection). */
function solveVia(feed, from, court) {
  const via = feed.via;
  const dx = via.x - from.x, dz = via.z - from.z;
  const d = Math.hypot(dx, dz);
  const ux = dx / d, uz = dz / d;
  const speed = (feed.speedKmh ?? 55) / 3.6;
  const at = (L) => {
    const target = v3(via.x + ux * L, 0, via.z + uz * L);
    const spin = spinFor(feed, from, target);
    const res = solveShot({ from, target, spin, speed, court });
    const y = heightAtZ(from, res.vel, spin, via.z);
    return { target, spin, res, y: y === null ? -1 : y };
  };
  let lo = 0.3, hi = 9;
  let best = at(hi);
  if (best.y < via.y) return best;
  best = at(lo);
  if (best.y > via.y) return best;
  for (let i = 0; i < 14; i++) {
    const mid = 0.5 * (lo + hi);
    const r = at(mid);
    best = r;
    if (r.y > via.y) hi = mid;
    else lo = mid;
    if (Math.abs(r.y - via.y) < 0.01) break;
  }
  return best;
}

/**
 * Turns a Feed into a launch: { from, target (aimed, with scatter), nominal, vel, spin, solve }.
 * Feed = { target: {x,z}, speedKmh?, flightTime?, apex?, spinRpm: {top, side}, launchHeight?, via?: {x,y,z},
 *         offsetX? (launch point x offset), serve? (launched as a serve by team 1) }.
 * Priority of the third constraint: apex, flightTime, speedKmh, else a 1.1 s flight.
 */
export function planFeed(feed, { origin, rng = null, court = null, sigma = MACHINE_LANDING_SIGMA } = {}) {
  const from = v3(origin.x + (feed.offsetX ?? 0), feed.launchHeight ?? origin.y, origin.z);
  if (feed.via) {
    const r = solveVia(feed, from, court);
    return { feed, from, target: r.target, nominal: r.target.clone(), vel: r.res.vel, spin: r.spin, solve: r.res };
  }
  const nominal = v3(feed.target.x, 0, feed.target.z);
  const target = nominal.clone();
  if (rng && sigma > 0) {
    target.x += rng.normal(0, sigma);
    target.z += rng.normal(0, sigma);
  }
  const spin = spinFor(feed, from, target);
  const opts = { from, target, spin, court };
  if (feed.apex) opts.apex = feed.apex;
  else if (feed.flightTime) opts.flightTime = feed.flightTime;
  else if (feed.speedKmh) opts.speed = feed.speedKmh / 3.6;
  else opts.flightTime = 1.1;
  let res = solveShot(opts);
  // A feed that would clip the tape or hit something first is re-solved higher.
  for (let k = 1; k <= 4 && (!res.ok || !res.clearsNet || (res.blockedBy && res.blockedBy !== 'wall')); k++) {
    const apex = Math.max(res.apex || 0, from.y, netHeightAt(target.x) + 0.3) + 0.35 * k;
    res = solveShot({ from, target, spin, apex, court });
  }
  return { feed, from, target, nominal, vel: res.vel, spin, solve: res };
}

/**
 * @param {{pos?: Vec3, rng?: Function, landingSigma?: number}} o
 * @returns Machine = { load(program, {interval, count, startDelay}), update(world, dt), feedNow(world),
 *   stop(), state, lastFeed, pos }
 */
export function createMachine({ pos = v3(0, 1.0, -9.2), rng = createRng(0x5eed), landingSigma = MACHINE_LANDING_SIGMA } = {}) {
  const origin = Vec3.from(pos);
  let program = null;
  let interval = 3.2;
  let plan = null;
  const state = { fed: 0, total: 0, nextIn: 0, headYaw: 0, headPitch: 0.15, feeding: false, held: false };
  const machine = {
    pos: origin,
    lastFeed: null,
    /** Optional (world) => boolean: false holds the next feed (e.g. the player's return is still live). */
    gate: null,
    load,
    update,
    feedNow,
    stop,
    get state() {
      return state;
    },
  };

  function load(prog, { interval: iv = 3.2, count = 20, startDelay = 1.5 } = {}) {
    program = prog;
    interval = iv;
    state.fed = 0;
    state.total = count;
    state.nextIn = startDelay;
    state.feeding = count > 0;
    plan = null;
  }

  function stop() {
    state.feeding = false;
    plan = null;
  }

  function feedAt(i, world) {
    if (typeof program === 'function') return program(i, world);
    if (Array.isArray(program) && program.length) return program[i % program.length];
    return null;
  }

  function makePlan(world) {
    const feed = feedAt(state.fed, world);
    if (!feed) return null;
    return planFeed(feed, { origin, rng, court: world.court, sigma: landingSigma });
  }

  function aimHead(dt) {
    if (!plan) return;
    const v = plan.vel;
    const yaw = Math.atan2(v.x, v.z);
    const pitch = Math.atan2(v.y, Math.hypot(v.x, v.z));
    const maxStep = (HEAD_SLEW_DEG_S * Math.PI / 180) * dt;
    const dy = yaw - state.headYaw, dp = pitch - state.headPitch;
    state.headYaw += Math.max(-maxStep, Math.min(maxStep, dy));
    state.headPitch += Math.max(-maxStep, Math.min(maxStep, dp));
  }

  function fire(world) {
    const p = plan || makePlan(world);
    plan = null;
    if (!p) return null;
    // A served feed (return drill) is a stroke by the far team: logged and ruled as a serve.
    const strike = p.feed.serve ? { team: 1, isServe: true, stroke: 'serve' } : null;
    launchBall(world, { pos: p.from, vel: p.vel, spin: p.spin, by: 'machine', strike });
    state.fed++;
    machine.lastFeed = p;
    state.headYaw = Math.atan2(p.vel.x, p.vel.z);
    state.headPitch = Math.atan2(p.vel.y, Math.hypot(p.vel.x, p.vel.z));
    emit(world, 'machine:feed', { index: state.fed - 1, plan: p });
    return p;
  }

  /** Feeds immediately (outside the schedule). */
  function feedNow(world) {
    return fire(world);
  }

  function update(world, dt) {
    if (!state.feeding) return;
    state.nextIn -= dt;
    const open = !machine.gate || machine.gate(world) !== false;
    state.held = !open && state.nextIn <= HOLD_LEAD;
    if (!open && state.nextIn < HOLD_LEAD) {
      // Never fire over a live ball: wait (unaimed: the player may still move) until released.
      state.nextIn = HOLD_LEAD;
      plan = null;
    }
    if (!plan && open && state.nextIn <= AIM_LEAD && state.fed < state.total) plan = makePlan(world);
    aimHead(dt);
    if (state.nextIn <= 0) {
      fire(world);
      state.nextIn += interval;
      if (state.fed >= state.total) state.feeding = false;
    }
  }

  return machine;
}


