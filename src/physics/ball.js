// Ball state and flight integrator: gravity, quadratic drag, Magnus lift with a
// saturating lift coefficient, exponential spin decay. RK2 (midpoint) at ~960 Hz,
// swept collisions delegated to court.collide after every substep, rolling on the
// floor with rolling resistance, and rest detection. Pure module.

import { Vec3, v3 } from '../util/vec3.js';
import { BALL, SIM } from '../config.js';
import { floorSurfaceAt, sideOf, ROLLING_RESISTANCE } from './court.js';

const R = BALL.radius;
const AREA = Math.PI * R * R;
const K_DRAG = (0.5 * BALL.airDensity * BALL.dragCoef * AREA) / BALL.mass; // 1/m
const K_LIFT = (0.5 * BALL.airDensity * AREA) / BALL.mass; // 1/m, times C_L
const G = SIM.gravity;

/** Default integration rate: SIM.tickRate * SIM.ballSubsteps (960 Hz). */
export const SUBSTEP_HZ = SIM.tickRate * SIM.ballSubsteps;

let nextId = 1;

/**
 * BallState = { pos, vel, spin (rad/s, world), t, outside, atRest, lastSurface, id }.
 * Inputs are copied, so callers may reuse their vectors.
 */
export function createBall(pos = v3(0, 1, 0), vel = v3(), spin = v3()) {
  return {
    pos: new Vec3(pos.x, pos.y, pos.z),
    vel: new Vec3(vel.x, vel.y, vel.z),
    spin: new Vec3(spin.x, spin.y, spin.z),
    t: 0,
    outside: false,
    atRest: false,
    lastSurface: null,
    id: nextId++,
  };
}

/** Deep copy (same id). */
export function cloneBall(ball) {
  return copyBallInto(
    { pos: new Vec3(), vel: new Vec3(), spin: new Vec3(), t: 0, outside: false, atRest: false, lastSurface: null, id: 0 },
    ball,
  );
}

/** Copies every field of src into dst (vectors by value). Returns dst. */
export function copyBallInto(dst, src) {
  dst.pos.copy(src.pos);
  dst.vel.copy(src.vel);
  dst.spin.copy(src.spin);
  dst.t = src.t;
  dst.outside = src.outside;
  dst.atRest = src.atRest;
  dst.lastSurface = src.lastSurface;
  dst.id = src.id;
  return dst;
}

export function ballSpeed(ball) {
  return ball.vel.length();
}

/** Number of integrator substeps used for a step of dt at the given rate. */
export function substepCount(dt, rate = SUBSTEP_HZ) {
  return Math.max(1, Math.ceil(dt * rate - 1e-6));
}

/**
 * Flight acceleration for velocity v and spin w (gravity + drag + Magnus) into out.
 * Drag: -k_d |v| v. Magnus: k_l C_L |v|^2 unit(w x v),
 * C_L = min(maxLiftCoef, 1 / (2 + |v| / (r |w_perp|))).
 */
function accelInto(v, w, out) {
  const vx = v.x, vy = v.y, vz = v.z;
  out.x = 0;
  out.y = -G;
  out.z = 0;
  const speed2 = vx * vx + vy * vy + vz * vz;
  if (speed2 < 1e-18) return out;
  const speed = Math.sqrt(speed2);
  const kd = K_DRAG * speed;
  out.x -= kd * vx;
  out.y -= kd * vy;
  out.z -= kd * vz;
  // w x v; |w x v| = |w_perp| |v|.
  const cx = w.y * vz - w.z * vy;
  const cy = w.z * vx - w.x * vz;
  const cz = w.x * vy - w.y * vx;
  const c2 = cx * cx + cy * cy + cz * cz;
  if (c2 < 1e-18) return out;
  const cMag = Math.sqrt(c2);
  const wPerp = cMag / speed;
  let cl = 1 / (2 + speed / (R * wPerp));
  if (cl > BALL.maxLiftCoef) cl = BALL.maxLiftCoef;
  const f = (K_LIFT * cl * speed2) / cMag;
  out.x += f * cx;
  out.y += f * cy;
  out.z += f * cz;
  return out;
}

/** Gravity + drag + Magnus acceleration of the ball in flight, written into out. */
export function ballAccel(ball, out = new Vec3()) {
  return accelInto(ball.vel, ball.spin, out);
}

/** True when the ball is in rolling contact with the floor (vertical motion settled). */
export function isRolling(ball) {
  return ball.vel.y === 0 && ball.pos.y <= R + 1e-9;
}

const a1 = new Vec3();
const a2 = new Vec3();
const vMid = new Vec3();
const prevPos = new Vec3();
const prevVel = new Vec3();

function flightSubstep(ball, h, decay) {
  accelInto(ball.vel, ball.spin, a1);
  vMid.copy(ball.vel).addScaled(a1, 0.5 * h);
  accelInto(vMid, ball.spin, a2);
  ball.pos.addScaled(vMid, h);
  ball.vel.addScaled(a2, h);
  ball.spin.scale(decay);
}

/** Rolling on the floor: drag + rolling resistance, spin locked to pure rolling. */
function rollSubstep(ball, h, decay) {
  const v = ball.vel;
  ball.pos.y = R;
  const vh = Math.hypot(v.x, v.z);
  if (vh > 1e-12) {
    const crr = ROLLING_RESISTANCE[floorSurfaceAt(ball.pos.x, ball.pos.z)];
    const decel = K_DRAG * vh * vh + crr * G;
    const vNew = Math.max(0, vh - decel * h);
    const k = vNew / vh;
    ball.pos.x += 0.5 * (1 + k) * v.x * h;
    ball.pos.z += 0.5 * (1 + k) * v.z * h;
    v.x *= k;
    v.z *= k;
  }
  // Rolling without slip on +y: w = (y x v) / r = (vz, 0, -vx) / r; sidespin decays.
  ball.spin.set(v.z / R, ball.spin.y * decay * decay, -v.x / R);
}

/**
 * Advances the ball by dt in substeps of dt / ceil(dt * 960) (opts.substepRate).
 * court: createCourt() result or null for free flight. rng: seeded rng for mesh
 * jitter (null or opts.deterministic -> expected value). events: array or null.
 */
export function stepBall(ball, dt, court, rng, events, opts = {}) {
  if (!(dt > 0)) return ball;
  const t0 = ball.t;
  if (ball.atRest) {
    ball.t = t0 + dt;
    return ball;
  }
  const n = substepCount(dt, opts.substepRate || SUBSTEP_HZ);
  const h = dt / n;
  const decay = Math.exp(-h / BALL.spinDecayTau);
  const r = opts.deterministic ? null : rng || null;

  for (let i = 0; i < n; i++) {
    prevPos.copy(ball.pos);
    prevVel.copy(ball.vel);
    if (isRolling(ball)) rollSubstep(ball, h, decay);
    else flightSubstep(ball, h, decay);
    if (court) court.collide(ball, prevPos, r, events, h, prevVel);
    ball.t = t0 + (i + 1) * h;

    if (isRolling(ball) && ball.vel.x * ball.vel.x + ball.vel.z * ball.vel.z < BALL.restSpeed * BALL.restSpeed) {
      settle(ball, events);
      break;
    }
  }
  ball.t = t0 + dt;
  return ball;
}

function settle(ball, events) {
  ball.atRest = true;
  ball.vel.set(0, 0, 0);
  ball.spin.set(0, 0, 0);
  ball.pos.y = R;
  if (events) {
    const p = ball.pos;
    events.push({
      type: 'rest',
      t: ball.t,
      pos: new Vec3(p.x, 0, p.z),
      vel: new Vec3(),
      side: sideOf(p.z),
      surface: ball.outside ? 'outsideFloor' : floorSurfaceAt(p.x, p.z),
      wall: null,
      impactSpeed: 0,
      via: null,
    });
  }
}
