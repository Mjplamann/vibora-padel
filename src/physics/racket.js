// Racket–ball contact and response (SPEC §2.3). Pure module: no DOM, no three.js.
//
// Racket local frame (config RACKET): origin = grip point, +Y = handle -> tip (pose.axis),
// +Z = forehand face normal (pose.normal), +X = Y x Z. The hitting surface is an ellipse
// centred at faceCenterY with semi-axes faceSemiX/faceSemiY; the sweet spot sits on the
// long axis at sweetSpotY.
//
// Impact model: apparent coefficient of restitution of a hand-held racket (Cross,
// "The coefficient of restitution for collisions of happy balls, unhappy balls and
// tennis balls", Am. J. Phys. 2000; Brody, Cross & Lindsey, "The Physics and
// Technology of Tennis"): in the racket-point frame the normal relative velocity
// reverses with e_A, which already accounts for the racket recoiling in the hand.
// Tangentially the ball either grips the face (ends rolling on it) or slides under
// Coulomb friction, the same grip/slip rule the court surfaces use, which is what
// turns a brushing swing into topspin or slice.

import { Vec3 } from '../util/vec3.js';
import { clamp, lerp, DEG, radsToRpm, rpmToRads } from '../util/math.js';
import { BALL, RACKET } from '../config.js';

const R = BALL.radius;
const ALPHA = BALL.inertiaFactor;
const HALF_T = RACKET.thickness / 2;
const SEMI_X = RACKET.faceSemiX;
const SEMI_Y = RACKET.faceSemiY;
const FACE_Y = RACKET.faceCenterY;
const SWEET_Y = RACKET.sweetSpotY;

/**
 * Off-centre twist (local constant, not in config). A hit away from the long axis
 * rotates the racket about that axis in the hand during the ~1 ms dwell, opening the
 * face toward the side of the hit; a hit toward the tip rotates it about the wrist.
 * The effective normal tilts toward the impact offset by up to these angles at the
 * rim for a 30 m/s normal impact (scaled linearly with impact speed). Measured
 * hand-held racket twist at the rim is a few degrees.
 */
export const TWIST_DEG_AT_RIM = 5;
export const TIP_TILT_DEG_AT_RIM = 2.5;
const TWIST_REF_SPEED = 30;

/** Sub-samples per swept test are chosen so relative travel per sample is <= this. */
const SAMPLE_SPACING = 0.02;
const MIN_SAMPLES = 12;
const MAX_SAMPLES = 96;
const BISECT_ITERS = 24;

// ---------------------------------------------------------------------------
// Pose helpers

const UP = new Vec3(0, 1, 0);

/** Sweet-spot world position of a pose. */
function sweetSpotInto(pose, out) {
  return out.copy(pose.grip).addScaled(pose.axis, SWEET_Y);
}

/**
 * World-space face ellipse of a pose: { center, normal, xAxis, yAxis, semiX, semiY }.
 * normal is the forehand face normal made orthogonal to the axis. Reuses out's vectors.
 */
export function racketFace(pose, out = {}) {
  const yAx = out.yAxis || (out.yAxis = new Vec3());
  const n = out.normal || (out.normal = new Vec3());
  const xAx = out.xAxis || (out.xAxis = new Vec3());
  const c = out.center || (out.center = new Vec3());
  yAx.copy(pose.axis).normalize();
  n.copy(pose.normal).projectOnPlane(yAx).normalize();
  xAx.crossVectors(yAx, n);
  c.copy(pose.grip).addScaled(yAx, FACE_Y);
  out.semiX = SEMI_X;
  out.semiY = SEMI_Y;
  return out;
}

const pfFace = {};

/** World point at racket-local (x, y) on the face plane (origin at the grip, y along the axis). */
export function pointOnRacket(pose, localX, localY, out = new Vec3()) {
  const f = racketFace(pose, pfFace);
  return out.copy(pose.grip).addScaled(f.xAxis, localX).addScaled(f.yAxis, localY);
}

/** Linear pose interpolation (grip lerp, normalised lerp of axis and normal). */
function lerpPoseInto(a, b, u, out) {
  out.grip.lerpVectors(a.grip, b.grip, u);
  out.axis.lerpVectors(a.axis, b.axis, u).normalize();
  if (out.axis.lengthSq() === 0) out.axis.copy(u < 0.5 ? a.axis : b.axis);
  out.normal.lerpVectors(a.normal, b.normal, u).projectOnPlane(out.axis).normalize();
  if (out.normal.lengthSq() === 0) out.normal.copy(u < 0.5 ? a.normal : b.normal);
  return out;
}

function makePose() {
  return { grip: new Vec3(), axis: new Vec3(0, 1, 0), normal: new Vec3(0, 0, 1), vel: new Vec3(), angVel: null, t: 0 };
}

const posOf = (b) => (b && b.pos ? b.pos : b);

// ---------------------------------------------------------------------------
// Swept contact

// Scratch for sweptContact (module scope: no allocation unless a hit is returned).
const swPose = makePose();
const swFace = {};
const swBall = new Vec3();
const swTmp = new Vec3();
const ev = { s: 0, px: 0, py: 0 };
let swA = null, swB = null, swBA = null, swBB = null;

/** Evaluates the swept configuration at u: signed face distance and in-plane coords. */
function evalAt(u) {
  lerpPoseInto(swA, swB, u, swPose);
  racketFace(swPose, swFace);
  swBall.lerpVectors(swBA, swBB, u);
  swTmp.subVectors(swBall, swFace.center);
  ev.s = swTmp.dot(swFace.normal);
  ev.px = swTmp.dot(swFace.xAxis);
  ev.py = swTmp.dot(swFace.yAxis);
  return ev;
}

function inGrownEllipse(px, py, margin) {
  const ax = SEMI_X + margin;
  const ay = SEMI_Y + margin;
  return (px * px) / (ax * ax) + (py * py) / (ay * ay) <= 1;
}

/** d s / d u at u by central difference on the swept chord. */
function dsdu(u) {
  const d = 1e-4;
  const u0 = Math.max(0, u - d);
  const u1 = Math.min(1, u + d);
  const s0 = evalAt(u0).s;
  const s1 = evalAt(u1).s;
  return (s1 - s0) / (u1 - u0);
}

/** Root of sg * s(u) = level in [lo, hi], given sg * s - level is > 0 at lo and <= 0 at hi. */
function bisectLevel(lo, hi, sg, level) {
  for (let i = 0; i < BISECT_ITERS; i++) {
    const mid = 0.5 * (lo + hi);
    if (sg * evalAt(mid).s - level > 0) lo = mid;
    else hi = mid;
  }
  return hi;
}

/**
 * First u in [lo, hi] (a stretch the ball spends inside the slab) at which its centre
 * projects inside the grown face ellipse, or -1. The in-plane path over one interval is a
 * short, nearly straight chord, so a few sub-samples plus bisection are exact enough.
 */
function firstInsideFace(lo, hi, D, margin) {
  const K = 8;
  let prev = lo;
  for (let j = 0; j <= K; j++) {
    const u = lo + ((hi - lo) * j) / K;
    const e = evalAt(u);
    if (Math.abs(e.s) <= D + 1e-9 && inGrownEllipse(e.px, e.py, margin)) {
      return j === 0 ? u : bisectContact(prev, u, D, margin);
    }
    prev = u;
  }
  return -1;
}

/** First u in [lo, hi] at which the ball is in the slab and inside the grown ellipse (true at hi). */
function bisectContact(lo, hi, D, margin) {
  for (let i = 0; i < BISECT_ITERS; i++) {
    const mid = 0.5 * (lo + hi);
    const e = evalAt(mid);
    if (Math.abs(e.s) <= D + 1e-9 && inGrownEllipse(e.px, e.py, margin)) hi = mid;
    else lo = mid;
  }
  return hi;
}

/**
 * Whether the ball approaches a face at u. side is the face it came at (+1 front,
 * -1 back), or 0 to infer it from the current side of the plane. Returns the side or 0.
 */
function approachingSide(u, side) {
  const ds = dsdu(u);
  let sg = side;
  if (!sg) {
    const s = evalAt(u).s;
    sg = Math.abs(s) > 1e-9 ? Math.sign(s) : -Math.sign(ds) || 1;
  }
  return sg * ds < 0 ? sg : 0;
}

function segmentDuration(poseA, poseB, ballA, ballB) {
  const dp = (poseB.t ?? NaN) - (poseA.t ?? NaN);
  if (dp > 0) return dp;
  const db = (ballB.t ?? NaN) - (ballA.t ?? NaN);
  return db > 0 ? db : NaN;
}

/**
 * Swept racket–ball contact between two racket poses and two ball states at the same
 * two instants. Both are interpolated linearly in u ∈ [0, 1]. A hit is the first u where
 * the ball centre is within r + thickness/2 + margin of the face plane, its projection
 * is inside the face ellipse grown by margin, and the ball approaches that face (front
 * or back). Plane crossings between sub-samples are found exactly (bisection), so a
 * racket sweeping far between samples cannot tunnel through the ball.
 *
 * @param poseA RacketPose at the segment start   @param poseB RacketPose at the end
 * @param ballA BallState (or Vec3) at the start   @param ballB BallState (or Vec3) at the end
 * @param margin assist margin, metres (grows the face ellipse and the contact slab)
 * @returns null | { u, t, point, ballPos, ballVel, local: {x, y}, offCenter, approachSpeed,
 *                   normal, face: 'front'|'back', pose }
 */
export function sweptContact(poseA, poseB, ballA, ballB, margin = 0) {
  const pA = posOf(ballA);
  const pB = posOf(ballB);
  if (!pA || !pB) return null;
  margin = Math.max(0, margin || 0);
  swA = poseA; swB = poseB; swBA = pA; swBB = pB;
  const D = R + HALF_T + margin;

  // Quick reject: the ball never gets near the racket head along the segment.
  const reach = RACKET.length + D + 0.05;
  const gA = poseA.grip, gB = poseB.grip;
  const travel = Math.max(Math.hypot(gB.x - gA.x, gB.y - gA.y, gB.z - gA.z), 0);
  const ballTravel = Math.hypot(pB.x - pA.x, pB.y - pA.y, pB.z - pA.z);
  const dA = Math.hypot(pA.x - gA.x, pA.y - gA.y, pA.z - gA.z);
  const dB = Math.hypot(pB.x - gB.x, pB.y - gB.y, pB.z - gB.z);
  if (Math.min(dA, dB) > reach + travel + ballTravel) return null;

  // Tip travel bounds the relative motion of any face point.
  const tipTravel = travel + RACKET.length * angleBetween(poseA.axis, poseB.axis)
    + RACKET.length * angleBetween(poseA.normal, poseB.normal);
  const n = clamp(Math.ceil((tipTravel + ballTravel) / SAMPLE_SPACING), MIN_SAMPLES, MAX_SAMPLES);

  // slabSide: the face (+1 front, -1 back) whose side the ball entered the contact slab
  // from during the current passage, 0 while the ball is outside the slab. The approach
  // test uses it, so a ball that clips the rim and only projects inside the face after
  // its centre has crossed the plane still counts as a hit on the face it came at.
  let e = evalAt(0);
  let sPrev = e.s;
  let slabSide = 0;
  if (Math.abs(sPrev) <= D) {
    slabSide = sPrev !== 0 ? Math.sign(sPrev) : -Math.sign(dsdu(0)) || 1;
    e = evalAt(0);
    if (inGrownEllipse(e.px, e.py, margin)) {
      const side = approachingSide(0, slabSide);
      if (side) return buildContact(0, side, poseA, poseB, ballA, ballB);
    }
  }

  for (let i = 1; i <= n; i++) {
    const a = (i - 1) / n;
    const b = i / n;
    const sCur = evalAt(b).s;
    let lo = -1; // start of the in-slab part of [a, b]
    if (Math.abs(sPrev) > D) {
      const sg = Math.sign(sPrev);
      if (sg * sCur <= D) {
        slabSide = sg;
        lo = bisectLevel(a, b, sg, D);
      }
    } else {
      lo = a;
    }
    if (lo >= 0) {
      let hi = b;
      // Passed right through to the far side of the slab inside this interval.
      if (slabSide * sCur < -D) hi = bisectLevel(lo, b, slabSide, -D);
      const uHit = firstInsideFace(lo, hi, D, margin);
      if (uHit >= 0) {
        const side = approachingSide(uHit, slabSide);
        if (side) return buildContact(uHit, side, poseA, poseB, ballA, ballB);
      }
    }
    if (Math.abs(sCur) > D) slabSide = 0;
    sPrev = sCur;
  }
  return null;
}

function angleBetween(a, b) {
  const la = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
  const lb = Math.sqrt(b.x * b.x + b.y * b.y + b.z * b.z);
  if (la < 1e-12 || lb < 1e-12) return 0;
  return Math.acos(clamp((a.x * b.x + a.y * b.y + a.z * b.z) / (la * lb), -1, 1));
}

function buildContact(u, side, poseA, poseB, ballA, ballB) {
  const e = evalAt(u);
  const px = e.px;
  const py = e.py;
  const pose = makePose();
  lerpPoseInto(poseA, poseB, u, pose);
  if (poseA.vel && poseB.vel) pose.vel.lerpVectors(poseA.vel, poseB.vel, u);
  else if (poseA.vel || poseB.vel) pose.vel.copy(poseA.vel || poseB.vel);
  if (poseA.angVel && poseB.angVel) pose.angVel = new Vec3().lerpVectors(poseA.angVel, poseB.angVel, u);
  else if (poseA.angVel || poseB.angVel) pose.angVel = (poseA.angVel || poseB.angVel).clone();
  const tA = poseA.t ?? ballA.t;
  const tB = poseB.t ?? ballB.t;
  pose.t = Number.isFinite(tA) && Number.isFinite(tB) ? lerp(tA, tB, u) : NaN;

  const face = racketFace(pose, {});
  const normal = face.normal.clone().scale(side);
  const ballPos = new Vec3().lerpVectors(posOf(ballA), posOf(ballB), u);
  const point = face.center.clone().addScaled(face.xAxis, px).addScaled(face.yAxis, py).addScaled(normal, HALF_T);
  let ballVel = null;
  if (ballA.vel && ballB.vel) ballVel = new Vec3().lerpVectors(ballA.vel, ballB.vel, u);

  const ly = py + FACE_Y;
  const offCenter = Math.hypot(px, ly - SWEET_Y);

  // Normal closing speed in m/s.
  const dur = segmentDuration(poseA, poseB, ballA, ballB);
  let approachSpeed;
  if (dur > 0) {
    approachSpeed = (-side * dsdu(u)) / dur;
  } else {
    const vR = pose.vel;
    approachSpeed = ballVel ? -(ballVel.dot(normal) - vR.dot(normal)) : 0;
  }
  return {
    u, t: pose.t, point, ballPos, ballVel,
    local: { x: px, y: ly },
    offCenter, approachSpeed, normal,
    face: side > 0 ? 'front' : 'back',
    pose,
  };
}

// ---------------------------------------------------------------------------
// Impact response

const imFace = {};
const imSweet = new Vec3();
const imPoint = new Vec3();
const imVR = new Vec3();
const imVrel = new Vec3();
const imN = new Vec3();
const imRc = new Vec3();
const imVc = new Vec3();
const imVt = new Vec3();
const imJt = new Vec3();
const imTmp = new Vec3();

/**
 * Applies a racket hit to the ball (mutates ball.vel, ball.spin, may nudge ball.pos out
 * of the face). poseAtContact is the RacketPose at the contact instant (sweptContact's
 * contact.pose is ideal). contact needs local {x, y} (racket-local coords, y from the
 * grip) and ideally face ('front'|'back').
 *
 * opts:
 *   margin  (m, default 0): assist forgiveness — the effective impact point is pulled this
 *           far toward the sweet spot before computing e_A and twist (offCenter/quality
 *           still report the real point).
 *   cor, corFalloff, minCOR, mu: override RACKET values.
 *   twist   (default true): off-centre face twist (see TWIST_DEG_AT_RIM).
 *
 * @returns ImpactInfo { speedIn, speedOut, racketSpeed, offCenter, eA, spinRpm: {top, side, total},
 *   quality, face, normal: Vec3, approachSpeed, hit: boolean }
 */
export function racketImpact(ball, poseAtContact, contact, opts = {}) {
  const cor = opts.cor ?? RACKET.apparentCOR;
  const falloff = opts.corFalloff ?? RACKET.corFalloff;
  const minCOR = opts.minCOR ?? RACKET.minCOR;
  const mu = opts.mu ?? RACKET.mu;
  const margin = Math.max(0, opts.margin ?? 0);
  const useTwist = opts.twist !== false;

  const pose = poseAtContact;
  const face = racketFace(pose, imFace);

  // Contact location in racket-local coordinates.
  let lx, ly;
  if (contact && contact.local) {
    lx = contact.local.x;
    ly = contact.local.y;
  } else {
    imTmp.subVectors(ball.pos, face.center);
    lx = imTmp.dot(face.xAxis);
    ly = imTmp.dot(face.yAxis) + FACE_Y;
  }
  const sx = lx;
  const sy = ly - SWEET_Y;
  const offCenter = Math.hypot(sx, sy);
  const rho = Math.sqrt((sx * sx) / (SEMI_X * SEMI_X) + (sy * sy) / (SEMI_Y * SEMI_Y));
  const quality = clamp(1 - rho, 0, 1);

  // Assist forgiveness pulls the effective point toward the sweet spot.
  let ex = sx, ey = sy;
  if (margin > 0 && offCenter > 1e-12) {
    const k = Math.max(0, offCenter - margin) / offCenter;
    ex *= k;
    ey *= k;
  }
  const rho2Eff = (ex * ex) / (SEMI_X * SEMI_X) + (ey * ey) / (SEMI_Y * SEMI_Y);
  const eA = Math.max(minCOR, cor * (1 - falloff * rho2Eff));

  // Racket velocity at the contact point.
  sweetSpotInto(pose, imSweet);
  imPoint.copy(pose.grip).addScaled(face.xAxis, lx).addScaled(face.yAxis, ly);
  imVR.copy(pose.vel || imTmp.set(0, 0, 0));
  if (pose.angVel) {
    imTmp.subVectors(imPoint, imSweet);
    imVR.add(imTmp.crossVectors(pose.angVel, imTmp));
  }
  const racketSpeed = imVR.length();

  // Face actually hit.
  imVrel.subVectors(ball.vel, imVR);
  let side;
  if (contact && (contact.face === 'front' || contact.face === 'back')) {
    side = contact.face === 'front' ? 1 : -1;
  } else {
    imTmp.subVectors(ball.pos, face.center);
    const s = imTmp.dot(face.normal);
    side = Math.abs(s) > 1e-6 ? Math.sign(s) : (imVrel.dot(face.normal) <= 0 ? 1 : -1);
  }
  const nHit = imN.copy(face.normal).scale(side);

  const speedIn = ball.vel.length();
  const vn0 = imVrel.dot(nHit);
  if (!(vn0 < 0)) {
    return {
      speedIn, speedOut: speedIn, racketSpeed, offCenter, eA,
      spinRpm: spinComponents(ball.vel, ball.spin), quality,
      face: side > 0 ? 'front' : 'back', normal: nHit.clone(), approachSpeed: 0, hit: false,
    };
  }

  // Off-centre twist: the face opens toward the side of the impact.
  if (useTwist) {
    const strength = clamp(-vn0 / TWIST_REF_SPEED, 0, 1.5);
    const tx = Math.tan(TWIST_DEG_AT_RIM * DEG * strength * clamp(ex / SEMI_X, -1.2, 1.2));
    const ty = Math.tan(TIP_TILT_DEG_AT_RIM * DEG * strength * clamp(Math.max(0, ey) / SEMI_Y, 0, 1.2));
    imTmp.copy(nHit).addScaled(face.xAxis, tx).addScaled(face.yAxis, ty).normalize();
    if (imVrel.dot(imTmp) < 0) nHit.copy(imTmp);
  }

  const vn = imVrel.dot(nHit);
  const dvn = -(1 + eA) * vn; // normal velocity change (impulse / m), > 0

  // Tangential grip/slip against the face (Brody), per unit ball mass.
  imRc.copy(nHit).scale(-R);
  imVc.crossVectors(ball.spin, imRc).add(imVrel);
  imVt.copy(imVc).addScaled(nHit, -imVc.dot(nHit));
  imJt.copy(imVt).scale(-ALPHA / (1 + ALPHA));
  const jRoll = imJt.length();
  const jMax = mu * dvn;
  if (jRoll > jMax) imJt.scale(jMax / jRoll);

  imVrel.addScaled(nHit, dvn).add(imJt);
  imTmp.crossVectors(imRc, imJt);
  ball.spin.addScaled(imTmp, 1 / (ALPHA * R * R));
  ball.vel.addVectors(imVrel, imVR);

  // Keep the ball clear of the face so it is not struck twice.
  const clearance = R + HALF_T;
  imTmp.subVectors(ball.pos, face.center);
  const sNow = imTmp.dot(face.normal) * side;
  if (sNow < clearance) ball.pos.addScaled(face.normal, side * (clearance - sNow));
  ball.atRest = false;
  ball.lastSurface = 'racket';

  return {
    speedIn,
    speedOut: ball.vel.length(),
    racketSpeed,
    offCenter,
    eA,
    spinRpm: spinComponents(ball.vel, ball.spin),
    quality,
    face: side > 0 ? 'front' : 'back',
    normal: nHit.clone(),
    approachSpeed: -vn0,
    hit: true,
  };
}

// ---------------------------------------------------------------------------
// Spin conventions (shared with machine / HUD)

const scD = new Vec3();
const scAx = new Vec3();

/**
 * Splits a world spin vector into rpm components relative to the travel direction:
 *   top  > 0 topspin (Magnus pushes down), < 0 backspin/slice;
 *   side > 0 curves the ball to the RIGHT of its horizontal travel (clockwise seen from above),
 *   total = |spin|.
 * Uses the horizontal travel direction (falls back to -z when the ball moves vertically).
 */
export function spinComponents(vel, spin) {
  scD.set(vel.x, 0, vel.z);
  if (scD.lengthSq() < 1e-10) scD.set(0, 0, -1);
  scD.normalize();
  scAx.crossVectors(UP, scD); // topspin axis
  return {
    top: radsToRpm(spin.dot(scAx)),
    side: -radsToRpm(spin.y),
    total: radsToRpm(spin.length()),
  };
}

/** Inverse of spinComponents: world spin (rad/s) for travel direction dir and rpm components. */
export function spinFromComponents(dir, topRpm = 0, sideRpm = 0, out = new Vec3()) {
  scD.set(dir.x, 0, dir.z);
  if (scD.lengthSq() < 1e-10) scD.set(0, 0, -1);
  scD.normalize();
  scAx.crossVectors(UP, scD);
  return out.copy(scAx).scale(rpmToRads(topRpm)).addScaled(UP, -rpmToRads(sideRpm));
}

// ---------------------------------------------------------------------------
// Assist blend

const blA = new Vec3();
const blB = new Vec3();

/**
 * Blends a physical outgoing velocity toward the intended one: direction slerped by w,
 * speed lerp(|phys|, |intent|, 0.6 w) so the player keeps most of their own power.
 */
export function blendTowardIntent(physVel, intentVel, w, out = new Vec3()) {
  w = clamp(w, 0, 1);
  const sp = physVel.length();
  const si = intentVel.length();
  const speed = lerp(sp, si, w * 0.6);
  if (sp < 1e-9 && si < 1e-9) return out.set(0, 0, 0);
  if (sp < 1e-9) return out.copy(intentVel).scale(speed / si);
  if (si < 1e-9 || w === 0) return out.copy(physVel).scale(speed / sp);

  blA.copy(physVel).scale(1 / sp);
  blB.copy(intentVel).scale(1 / si);
  const cosT = clamp(blA.dot(blB), -1, 1);
  const theta = Math.acos(cosT);
  if (theta < 1e-6) return out.copy(blA).scale(speed);
  if (Math.PI - theta < 1e-6) {
    // Antiparallel: rotate through a perpendicular (prefer one that keeps "up" sensible).
    blB.crossVectors(blA, UP);
    if (blB.lengthSq() < 1e-12) blB.set(1, 0, 0).projectOnPlane(blA);
    blB.normalize();
    const phi = w * Math.PI;
    return out.copy(blA).scale(Math.cos(phi)).addScaled(blB, Math.sin(phi)).normalize().scale(speed);
  }
  const sinT = Math.sin(theta);
  const ka = Math.sin((1 - w) * theta) / sinT;
  const kb = Math.sin(w * theta) / sinT;
  out.set(blA.x * ka + blB.x * kb, blA.y * ka + blB.y * kb, blA.z * ka + blB.z * kb);
  return out.normalize().scale(speed);
}
