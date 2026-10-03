// FIP padel court enclosure: floor, glass + mesh walls (open above), net body + cord,
// hall ceiling. Swept-sphere collision so nothing tunnels at 60 m/s, sequential
// earliest-time-of-impact resolution inside one substep (corners, double walls), and
// the Brody/Cross grip–slip impact model shared by every surface.
// Pure module: no DOM, no three.js.

import { Vec3, v3 } from '../util/vec3.js';
import { clamp, DEG } from '../util/math.js';
import { COURT, BALL, SURFACES, SIM, netHeightAt } from '../config.js';

const R = BALL.radius;
const M = BALL.mass;
const ALPHA = BALL.inertiaFactor;
const HW = COURT.halfWidth;
const HL = COURT.halfLength;
const NET_HALF_T = COURT.net.thickness / 2;
const CORD_R = COURT.net.cordRadius;
const CORD_REACH = R + CORD_R; // ball-center distance from the cord axis at contact
const MAX_ITER = 8;

/**
 * Turf restitution, calibrated locally (config's SURFACES.turf.e0 = 0.80 was tuned
 * ignoring air drag). With the real drag (Cd 0.55) a ball dropped from 2.54 m reaches
 * the turf at ~6.9 m/s and loses ~5% of its rebound height to drag on the way up, so
 * e0 = 0.80 only rebounds to 1.345 m, just under the FIP window. e0 = 0.815 gives
 * e(6.9 m/s) = 0.77 and a 1.40 m rebound, the middle of the FIP 1.35–1.45 m window.
 */
export const TURF_E0 = 0.815;

/**
 * Rolling-resistance coefficients (deceleration = crr * g) once the ball has stopped
 * bouncing. Sand-filled artificial turf is draggy (FIFA-style roll tests on sand
 * turf put a rolling ball at ~0.08–0.12); the hall's concrete is much faster.
 */
export const ROLLING_RESISTANCE = { turf: 0.09, outsideFloor: 0.03 };

/**
 * A floor impact whose rebound normal speed is below this settles into rolling
 * (a 0.25 m/s hop is 3 mm high; real balls stop hopping and roll around here).
 */
export const SETTLE_SPEED = 0.25;

const DEFAULT_SURFACES = { ...SURFACES, turf: { ...SURFACES.turf, e0: TURF_E0 } };

// ---------------------------------------------------------------------------
// Small pure helpers (SPEC §2.2, §2.6)

/** 'near' for z >= 0 (the human's half), 'far' for z < 0. */
export function sideOf(z) {
  return z >= 0 ? 'near' : 'far';
}

/** Floor surface name under (x, z): turf inside the enclosure, outsideFloor beyond. */
export function floorSurfaceAt(x, z) {
  return Math.abs(x) <= HW && Math.abs(z) <= HL ? 'turf' : 'outsideFloor';
}

/** Side-wall band for |z| (first band in COURT.sideWall that contains it). */
function sideBand(absZ) {
  const bands = COURT.sideWall;
  for (let i = 0; i < bands.length; i++) {
    const b = bands[i];
    if (absZ >= b.zMin && absZ <= b.zMax) return b;
  }
  return absZ > HL ? bands[0] : bands[bands.length - 1];
}

/**
 * Wall material at height y. kind 'back' (z = ±10) or 'side' (x = ±5, banded by |z|).
 * Returns 'glass' | 'mesh' | null (null = open air above the wall).
 */
export function surfaceAt(kind, y, absZ = 0) {
  const band = kind === 'back' ? COURT.backWall : sideBand(Math.abs(absZ));
  if (band.glassTop > 0 && y <= band.glassTop) return 'glass';
  if (y <= band.meshTop) return 'mesh';
  return null;
}

/**
 * Whether the point (x, z) is inside a service box. Boxes run from the net to the
 * service line (0 < |z| <= 6.95) and across |x| <= 5. 'right'/'left' are from the
 * receiver's own view: a near receiver (facing -z) has the right box at x >= 0, a far
 * receiver (facing +z) at x <= 0. Lines count as in (the center line belongs to both).
 */
export function inServiceBox(x, z, receivingSide, boxHalf) {
  const sz = receivingSide === 'near' ? z : -z;
  if (!(sz > 0 && sz <= COURT.serviceLine)) return false;
  if (Math.abs(x) > HW) return false;
  const sx = receivingSide === 'near' ? x : -x; // receiver's own right is +sx
  return boxHalf === 'right' ? sx >= 0 : sx <= 0;
}

// ---------------------------------------------------------------------------
// Impact model

const sN = new Vec3();
const sRc = new Vec3();
const sVc = new Vec3();
const sVt = new Vec3();
const sJt = new Vec3();
const sTmp = new Vec3();
const sT1 = new Vec3();
const sT2 = new Vec3();

/** Writes into out a unit normal tilted from n by up to maxDeg in a random direction. */
function jitterNormal(n, maxDeg, rng, out) {
  // Orthonormal tangent basis (t1, t2) of n.
  if (Math.abs(n.y) < 0.9) sT1.set(0, 1, 0);
  else sT1.set(1, 0, 0);
  sT1.projectOnPlane(n).normalize();
  sT2.crossVectors(n, sT1);
  const theta = maxDeg * DEG * Math.sqrt(rng()); // uniform over the cone's disc
  const phi = 2 * Math.PI * rng();
  const st = Math.sin(theta);
  out.copy(n).scale(Math.cos(theta));
  out.addScaled(sT1, st * Math.cos(phi)).addScaled(sT2, st * Math.sin(phi));
  return out.normalize();
}

/**
 * Brody/Cross grip–slip impact of the ball on a rigid surface. Mutates ball.vel and
 * ball.spin. normal: unit, pointing out of the surface toward the ball.
 * Mesh surfaces (normalJitterDeg/lossJitter) tilt the normal and lose a random share of
 * speed using rng; with rng == null they use the expected loss (1 - lossJitter/2) and no
 * tilt, so deterministic predictions match the mean outcome.
 * Surfaces with `absorb` (net body) keep only (1 - absorb) of velocity and spin.
 * @returns {{ impactSpeed: number, e: number, slip: boolean }}
 */
export function resolveImpact(ball, normal, surface, rng = null) {
  const v = ball.vel;
  const w = ball.spin;
  const vIn = v.dot(normal);
  if (!(vIn < 0)) return { impactSpeed: 0, e: 0, slip: false };

  const n = sN.copy(normal);
  if (surface.normalJitterDeg && rng) {
    jitterNormal(normal, surface.normalJitterDeg, rng, n);
    if (v.dot(n) > 0.05 * vIn) n.copy(normal); // the tilt must keep the ball approaching
  }
  const vn = v.dot(n);
  const e = clamp(surface.e0 - surface.eSlope * Math.abs(vn), surface.eMin, surface.eMax);

  // Contact point relative to the center and its velocity.
  sRc.copy(n).scale(-R);
  sVc.crossVectors(w, sRc).add(v);
  sVt.copy(sVc).addScaled(n, -sVc.dot(n));

  const jn = -(1 + e) * M * vn; // > 0
  sJt.copy(sVt).scale((-M * ALPHA) / (1 + ALPHA)); // impulse that makes the ball roll
  const jRoll = sJt.length();
  const jMax = surface.mu * jn;
  let slip = false;
  if (jRoll > jMax) {
    slip = true;
    sJt.scale(jMax / jRoll); // Coulomb limit along -unit(vt)
  }

  v.addScaled(n, jn / M).addScaled(sJt, 1 / M);
  sTmp.crossVectors(sRc, sJt);
  w.addScaled(sTmp, 1 / (ALPHA * M * R * R));

  if (surface.lossJitter) {
    const keep = rng ? 1 - rng() * surface.lossJitter : 1 - surface.lossJitter / 2;
    v.scale(keep);
  }
  if (surface.absorb) {
    const keep = 1 - surface.absorb;
    v.scale(keep);
    w.scale(keep);
  }
  // Whatever the jitter did, the ball must leave the real surface.
  const vOut = v.dot(normal);
  if (vOut < 0) v.addScaled(normal, -2 * vOut);

  return { impactSpeed: -vIn, e, slip };
}

// ---------------------------------------------------------------------------
// Swept tests

/**
 * Fraction u in [0, 1] of the chord at which a sphere whose center signed distance goes
 * s0 -> s1 first touches a plane (s = rad), or -1. An already-overlapping sphere that is
 * still approaching collides at u = 0.
 */
function planeTOI(s0, s1, rad) {
  if (s1 >= rad || s1 >= s0) return -1;
  if (s0 >= rad) return (s0 - rad) / (s0 - s1);
  return s0 > -rad ? 0 : -1;
}

/** First u in [0,1] at which the center comes within CORD_REACH of the cord axis, or -1. */
function cordTOI(S, E) {
  const y0 = S.y - netHeightAt(S.x);
  const y1 = E.y - netHeightAt(E.x);
  const z0 = S.z;
  const z1 = E.z;
  if (y0 > CORD_REACH && y1 > CORD_REACH) return -1;
  if (y0 < -CORD_REACH && y1 < -CORD_REACH) return -1;
  if ((z0 > CORD_REACH && z1 > CORD_REACH) || (z0 < -CORD_REACH && z1 < -CORD_REACH)) return -1;
  const dy = y1 - y0;
  const dz = z1 - z0;
  const a = dy * dy + dz * dz;
  const b = 2 * (y0 * dy + z0 * dz);
  const c = y0 * y0 + z0 * z0 - CORD_REACH * CORD_REACH;
  if (b >= 0) return -1; // not approaching the axis
  if (c <= 0) return 0;
  const disc = b * b - 4 * a * c;
  if (disc < 0 || a < 1e-18) return -1;
  const u = (-b - Math.sqrt(disc)) / (2 * a);
  return u >= 0 && u <= 1 ? u : -1;
}

// ---------------------------------------------------------------------------
// Court

// The four enclosure walls: signed distance s = nx*x + nz*z + c (> 0 inside the court).
const WALLS = [
  { id: 'back-far', wall: 'back', nx: 0, nz: 1, c: HL, normal: v3(0, 0, 1) },
  { id: 'back-near', wall: 'back', nx: 0, nz: -1, c: HL, normal: v3(0, 0, -1) },
  { id: 'side-right', wall: 'side', nx: -1, nz: 0, c: HW, normal: v3(-1, 0, 0) },
  { id: 'side-left', wall: 'side', nx: 1, nz: 0, c: HW, normal: v3(1, 0, 0) },
];

const UP = v3(0, 1, 0);
const DOWN = v3(0, -1, 0);
const NET_N_NEAR = v3(0, 0, 1);
const NET_N_FAR = v3(0, 0, -1);

// Candidate kinds
const K_FLOOR = 1, K_CEIL = 2, K_WALL = 3, K_EXIT = 4, K_NET = 5, K_CORD = 6;

// Scratch for collide()
const segS = new Vec3();
const segE = new Vec3();
const segV0 = new Vec3();
const segV1 = new Vec3();
const pAt = new Vec3();
const cordN = new Vec3();

function makeEvent(type, t, pos, vel, surface, wall, impactSpeed, via, sideZ) {
  return {
    type, t,
    pos: new Vec3(pos.x, pos.y, pos.z),
    vel: new Vec3(vel.x, vel.y, vel.z),
    side: sideOf(sideZ),
    surface, wall, impactSpeed, via,
  };
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.walls=true]   enclosure walls (glass, mesh, open-top exits)
 * @param {boolean} [opts.net=true]     net body + cord
 * @param {boolean} [opts.ceiling=true]
 * @param {object}  [opts.surfaces]     per-surface overrides merged over the defaults
 * @returns Court = { collide, colliders, dims, surfaces }
 */
export function createCourt(opts = {}) {
  const useWalls = opts.walls !== false;
  const useNet = opts.net !== false;
  const useCeiling = opts.ceiling !== false;
  const surfaces = { ...DEFAULT_SURFACES };
  if (opts.surfaces) {
    for (const k of Object.keys(opts.surfaces)) surfaces[k] = { ...surfaces[k], ...opts.surfaces[k] };
  }
  const gravity = SIM.gravity;

  const colliders = [
    { id: 'floor', kind: 'plane', normal: UP.clone(), offset: 0, surface: 'turf|outsideFloor' },
  ];
  if (useCeiling) colliders.push({ id: 'ceiling', kind: 'plane', normal: DOWN.clone(), offset: COURT.ceiling, surface: 'ceiling' });
  if (useWalls) {
    for (const w of WALLS) {
      colliders.push({ id: w.id, kind: 'wall', wall: w.wall, normal: w.normal.clone(), offset: w.c, surface: 'glass|mesh|open' });
    }
  }
  if (useNet) {
    colliders.push({ id: 'net-body', kind: 'slab', axis: 'z', halfThickness: NET_HALF_T, top: 'netHeightAt(x) - cordRadius', surface: 'netBody' });
    colliders.push({ id: 'net-cord', kind: 'cylinder', axis: 'x', radius: CORD_R, height: 'netHeightAt(x)', surface: 'netCord' });
  }

  /**
   * Resolves every contact along the substep chord prevPos -> ball.pos in time order.
   * Call it with ball.t still at the substep start; events get t = ball.t + offset.
   * @param ball      BallState after integration (pos/vel at the substep end)
   * @param prevPos   center at the substep start
   * @param rng       seeded rng for mesh jitter, or null for the expected value
   * @param events    array to push events into (or null)
   * @param dtRemaining substep duration h (s)
   * @param prevVel   optional velocity at the substep start (better contact velocity)
   */
  function collide(ball, prevPos, rng, events, dtRemaining = 1 / (SIM.tickRate * SIM.ballSubsteps), prevVel = null) {
    segS.copy(prevPos);
    segE.copy(ball.pos);
    segV0.copy(prevVel || ball.vel);
    segV1.copy(ball.vel);
    let tSeg = 0;
    let hSeg = dtRemaining;
    let rolling = segV0.y === 0 && segV1.y === 0 && prevPos.y <= R + 1e-9;

    for (let iter = 0; iter < MAX_ITER; iter++) {
      let bestU = 2;
      let bestKind = 0;
      let bestWall = null;
      let u;

      // Floor and ceiling.
      u = planeTOI(segS.y, segE.y, R);
      if (u >= 0 && u < bestU) { bestU = u; bestKind = K_FLOOR; }
      if (useCeiling) {
        u = planeTOI(COURT.ceiling - segS.y, COURT.ceiling - segE.y, R);
        if (u >= 0 && u < bestU) { bestU = u; bestKind = K_CEIL; }
      }

      if (!ball.outside) {
        if (useWalls) {
          for (let i = 0; i < WALLS.length; i++) {
            const w = WALLS[i];
            const s0 = w.nx * segS.x + w.nz * segS.z + w.c;
            const s1 = w.nx * segE.x + w.nz * segE.z + w.c;
            if (s1 >= R) continue;
            u = planeTOI(s0, s1, R);
            if (u >= 0 && u < bestU) {
              pAt.lerpVectors(segS, segE, u);
              if (wallMaterial(w, pAt) !== null) { bestU = u; bestKind = K_WALL; bestWall = w; continue; }
            }
            // Open above the wall: leaving the enclosure when the center crosses the plane.
            if (s0 > 0 && s1 <= 0) {
              u = s0 / (s0 - s1);
              if (u < bestU) {
                pAt.lerpVectors(segS, segE, u);
                const inSpan = w.wall === 'back' ? Math.abs(pAt.x) <= HW + R : Math.abs(pAt.z) <= HL + R;
                if (inSpan) { bestU = u; bestKind = K_EXIT; bestWall = w; }
              }
            }
          }
        }
        if (useNet) {
          // Net body: thin slab, the face toward the ball's current side.
          const sg = segS.z >= 0 ? 1 : -1;
          u = planeTOI(sg * segS.z - NET_HALF_T, sg * segE.z - NET_HALF_T, R);
          if (u >= 0 && u < bestU) {
            pAt.lerpVectors(segS, segE, u);
            if (Math.abs(pAt.x) <= HW && pAt.y <= netHeightAt(pAt.x) - CORD_R) { bestU = u; bestKind = K_NET; }
          }
          u = cordTOI(segS, segE);
          if (u >= 0 && u < bestU) {
            pAt.lerpVectors(segS, segE, u);
            if (Math.abs(pAt.x) <= HW) { bestU = u; bestKind = K_CORD; }
          }
        }
      }

      if (bestKind === 0) break;

      // State at the contact instant.
      const u0 = bestU;
      ball.pos.lerpVectors(segS, segE, u0);
      ball.vel.lerpVectors(segV0, segV1, u0);
      const tEvt = ball.t + tSeg + u0 * hSeg;

      if (bestKind === K_EXIT) {
        ball.outside = true;
        if (events) events.push(makeEvent('exit', tEvt, ball.pos, ball.vel, null, bestWall.wall, 0, bestWall.wall, ball.pos.z));
        segS.copy(ball.pos);
        segV0.copy(ball.vel);
        tSeg += u0 * hSeg;
        hSeg *= 1 - u0;
        continue;
      }

      let normal, surfName, type, wallName = null, contactZ = ball.pos.z;
      pAt.copy(ball.pos);
      switch (bestKind) {
        case K_FLOOR:
          normal = UP;
          surfName = floorSurfaceAt(ball.pos.x, ball.pos.z);
          type = ball.outside || surfName === 'outsideFloor' ? 'outside-bounce' : 'bounce';
          pAt.y -= R;
          break;
        case K_CEIL:
          normal = DOWN;
          surfName = 'ceiling';
          type = 'ceiling';
          pAt.y += R;
          break;
        case K_WALL:
          normal = bestWall.normal;
          surfName = wallMaterial(bestWall, ball.pos);
          type = 'wall';
          wallName = bestWall.wall;
          pAt.addScaled(normal, -R);
          contactZ = pAt.z;
          break;
        case K_NET: {
          normal = ball.pos.z >= 0 ? NET_N_NEAR : NET_N_FAR;
          surfName = 'netBody';
          type = 'net';
          pAt.z = normal.z * NET_HALF_T;
          contactZ = ball.pos.z;
          break;
        }
        default: { // K_CORD
          const hy = ball.pos.y - netHeightAt(ball.pos.x);
          cordN.set(0, hy, ball.pos.z).normalize();
          if (cordN.lengthSq() === 0) cordN.set(0, 1, 0);
          normal = cordN;
          surfName = 'netCord';
          type = 'netcord';
          pAt.set(ball.pos.x, netHeightAt(ball.pos.x) + CORD_R * cordN.y, CORD_R * cordN.z);
          contactZ = ball.pos.z;
        }
      }

      const res = resolveImpact(ball, normal, surfaces[surfName], rng);
      let gy = rolling ? 0 : -gravity;
      if (bestKind === K_FLOOR) {
        ball.pos.y = R;
        if (ball.vel.y < SETTLE_SPEED) {
          ball.vel.y = 0;
          rolling = true;
          gy = 0;
        }
      } else if (rolling && ball.vel.y < 0) {
        ball.vel.y = 0; // the floor takes any downward kick of a rolling ball
      } else if (rolling && ball.vel.y > 0) {
        rolling = false;
        gy = -gravity;
      }
      ball.lastSurface = surfName;
      if (events) events.push(makeEvent(type, tEvt, pAt, ball.vel, surfName, wallName, res.impactSpeed, null, contactZ));

      // Carry the rest of the substep with the post-impact velocity (+ gravity).
      const hr = (1 - u0) * hSeg;
      segS.copy(ball.pos);
      segV0.copy(ball.vel);
      segE.copy(ball.pos).addScaled(ball.vel, hr);
      segE.y += 0.5 * gy * hr * hr;
      segV1.copy(ball.vel);
      segV1.y += gy * hr;
      tSeg += u0 * hSeg;
      hSeg = hr;
    }

    ball.pos.copy(segE);
    ball.vel.copy(segV1);
    // Final guard against numerical leaks through the floor.
    if (ball.pos.y < R) {
      ball.pos.y = R;
      if (ball.vel.y < 0) ball.vel.y = 0;
    }
  }

  return { collide, colliders, dims: COURT, surfaces };
}

function wallMaterial(w, p) {
  return w.wall === 'back' ? surfaceAt('back', p.y, Math.abs(p.z)) : surfaceAt('side', p.y, Math.abs(p.z));
}
