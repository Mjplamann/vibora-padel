// Mouse / trackpad / keyboard controls for playing without a camera (SPEC §9).
//
// createFallbackControls({ canvas, handed }) -> { enabled, update(dt, world) -> { moveTarget, racket }, dispose() }
//
// - The racket sweet spot follows the pointer, projected onto a vertical plane 0.65 m in front
//   of the player's eye (camera assumed facing -z, pitched down 6°, vertical FOV from
//   world.settings.fov or 70°).
// - Sweet-spot velocity = 3 x the pointer's velocity on that plane, mostly driven toward the
//   far court: a fast flick through the ball hits it. The face turns toward the flick.
// - The racket axis leans out to the dominant side right of the body (forehand) and across
//   to the other side on the left (backhand); the face flips smoothly between them.
// - WASD / arrow keys move the court target; Space plays an automatic swing that meets the
//   incoming ball (accessibility helper), using a small local ball predictor.
//
// RacketPose (court frame): { grip, axis, normal, vel, angVel, t } with sweet spot at
// grip + axis * RACKET.sweetSpotY. Note: vel carries the 3x pointer gain, so integrators that
// push poses into a racketTrack should keep this vel rather than the finite-difference one.
//
// The math helpers are exported and pure (no DOM), see dev/fallback-test.mjs.

import { Vec3, v3 } from '../util/vec3.js';
import { clamp, lerp, smoothstep, DEG } from '../util/math.js';
import { RACKET, PLAYER, COURT, BALL, SIM, ASSIST, netHeightAt } from '../config.js';
import { createBall, cloneBall, stepBall } from '../physics/ball.js';
import { predict, solveShot } from '../physics/predict.js';
import { racketImpact, spinFromComponents, blendTowardIntent } from '../physics/racket.js';
import { intendedShot, applyNetSafety } from '../game/world.js';
import { GLASS_CLEAR } from '../game/intercept.js';
import { defaultBounds } from '../tracking/locomotion.js';

export const FALLBACK = {
  planeDepth: 0.65,
  velGain: 3,
  forwardShare: 0.8, // share of the swing velocity driven toward the net
  defaultFovDeg: 70,
  pitchDeg: -6,
  moveSpeed: 4.5, // m/s for keyboard movement
  autoSwingSpeed: 12, // m/s sweet-spot speed at contact (integration: was 16, every auto-swing flew long)
  autoWindow: 0.3, // s from backswing end to contact
  // Integration tuning (main.js): face elevation of the auto-swing = ballistic * autoElevScale +
  // autoFaceTiltDeg, swing path lifted by autoBrush (topspin). With the original values (0.5, +4°,
  // 0.22, aim ±2.6/-7.6, 16 m/s) 30/30 auto-swings at Club went long; these land 28/30 in at
  // Club and Rookie through the full world pipeline (Pro, no assist, ~1/3).
  autoElevScale: 0,
  autoFaceTiltDeg: -8,
  autoBrush: 0.15,
  autoTargetX: 1.8, // |x| of the cross-court aim point
  autoTargetZ: -7,
  // Aimed auto-swing (QA2: a third of the assisted swings went in the net or out). The swing
  // is solved backwards from the shot: the drill's aim (or deep cross-court), blended toward
  // the stroke's intended shot by autoIntentBlend, lifted by Rookie net safety, then the
  // racket impact is inverted for the face normal and sweet-spot velocity that produce it.
  autoAim: true, // false: the original unaimed swing on the simple local predictor
  autoIntentBlend: 0.6,
  autoNetSafety: ASSIST.rookie.netSafety,
  autoSpeedKmh: [45, 80], // pace window of the aimed swing (drill hint clamped into it)
  autoBrushDeg: 12, // upward brush of the swing path relative to the face (topspin)
  // Never plan a contact closer than this to the back / side glass (m): the same clearances as
  // the tactical home, the magnet and the autopilot (game/intercept.js, QA2).
  autoGlassGap: GLASS_CLEAR.ground,
  autoSideGap: GLASS_CLEAR.side,
  racketWallGap: 0.1, // the swing's backswing / follow-through stay this far inside the walls (m)
};

const FWD = v3(0, 0, -1);

/** Eye position from world.player (falls back to feet + standing eye height). */
export function eyeOf(player, out = v3()) {
  if (player?.eye) return out.copy(player.eye);
  const p = player?.pos || { x: 0, y: 0, z: 7.8 };
  const h = player?.height || PLAYER.defaultHeight;
  return out.set(p.x, h * PLAYER.eyeHeightRatio, p.z);
}

/**
 * Projects normalized device coords (-1..1, +y up) through a camera at `eye` looking down -z
 * (pitched by pitchDeg) onto the vertical plane z = eye.z - depth.
 */
export function pointerToPlane(ndcX, ndcY, eye, { fovDeg = 70, aspect = 16 / 9, pitchDeg = FALLBACK.pitchDeg, depth = FALLBACK.planeDepth } = {}, out = v3()) {
  const th = Math.tan((fovDeg * DEG) / 2);
  const dx = ndcX * th * aspect, dy = ndcY * th, dz = -1;
  const p = pitchDeg * DEG;
  const y = dy * Math.cos(p) - dz * Math.sin(p);
  const z = dy * Math.sin(p) + dz * Math.cos(p);
  const s = -depth / Math.min(z, -1e-3);
  return out.set(eye.x + dx * s, eye.y + y * s, eye.z + z * s);
}

/** 0 = fully backhand side, 1 = fully forehand side, from the sweet spot's lateral offset. */
export function forehandness(sweet, eye, handed = 'right') {
  const side = handed === 'left' ? -1 : 1;
  return smoothstep(-0.12, 0.12, (sweet.x - eye.x) * side);
}

const _t = v3(), _b = v3(), _d = v3();

/**
 * Racket orientation for a sweet-spot position. faceDir is where the hitting face should
 * point (unit-ish, court frame). Writes pose.grip/axis/normal. The forehand face normal turns
 * about the handle through 180° between forehand and backhand, so there is no pop.
 */
export function orientRacket(sweet, eye, faceDir, handed, pose) {
  const side = handed === 'left' ? -1 : 1;
  const fh = forehandness(sweet, eye, handed);
  const lateral = lerp(-1, 1, fh) * side; // +x on the forehand side for a right-hander
  const shoulderY = eye.y - 0.3;
  const h = clamp(sweet.y - shoulderY, -0.9, 0.7);
  const axis = pose.axis.set(lateral * 0.78, 0.55 + 0.25 * (1 - Math.abs(lerp(-1, 1, fh))) + h * 0.7, -0.28).normalize();
  // face direction orthogonal to the handle
  _d.copy(faceDir).normalize().projectOnPlane(axis);
  if (_d.lengthSq() < 1e-6) _d.copy(FWD).projectOnPlane(axis);
  _d.normalize();
  // rotate about the axis by theta: 0 on the forehand side, PI on the backhand side
  const theta = (1 - fh) * Math.PI;
  _b.crossVectors(axis, _d).scale(side);
  pose.normal.copy(_d).scale(Math.cos(theta)).addScaled(_b, Math.sin(theta)).normalize();
  pose.grip.copy(sweet).addScaled(axis, -RACKET.sweetSpotY);
  return pose;
}

/**
 * Swing velocity from the pointer's velocity on the plane: |vel| = gain * |vPlane|, aimed
 * mostly toward the net with the flick's direction mixed in (an upward flick brushes up for
 * topspin, a sideways flick angles the shot).
 */
export function flickVelocity(vPlane, gain = FALLBACK.velGain, out = v3()) {
  const s = vPlane.length();
  if (s < 1e-6) return out.set(0, 0, 0);
  out.copy(vPlane).scale((1 - FALLBACK.forwardShare) / s).addScaled(FWD, FALLBACK.forwardShare).normalize();
  return out.scale(gain * s);
}

/** Face direction for a flick: forward, turned a little toward the flick and lifted slightly. */
export function flickFaceDir(vPlane, out = v3()) {
  out.copy(FWD);
  const s = vPlane.length();
  if (s > 0.4) out.addScaled(vPlane, (0.4 * Math.min(1, s / 3)) / s);
  out.y += 0.1;
  return out.normalize();
}

// ---------------------------------------------------------------------------------------
// Tiny ball predictor (gravity, drag, Magnus-free; floor, back and side glass) for the
// auto-swing. Local on purpose: the full predictor lives in physics/predict.js.
// ---------------------------------------------------------------------------------------

const K_DRAG = (0.5 * BALL.airDensity * BALL.dragCoef * Math.PI * BALL.radius ** 2) / BALL.mass;

/** Returns [{t, x, y, z, vx, vy, vz, bounced, wall}] samples every dt up to maxT. */
export function predictBallPath(ball, { maxT = 1.8, dt = 1 / 240 } = {}) {
  const out = [];
  if (!ball?.pos || !ball?.vel) return out;
  let { x, y, z } = ball.pos;
  let { x: vx, y: vy, z: vz } = ball.vel;
  let bounced = false, wall = false;
  const r = BALL.radius;
  for (let t = 0; t <= maxT; t += dt) {
    out.push({ t, x, y, z, vx, vy, vz, bounced, wall });
    const sp = Math.hypot(vx, vy, vz);
    vx -= K_DRAG * sp * vx * dt;
    vy -= (SIM.gravity + K_DRAG * sp * vy) * dt;
    vz -= K_DRAG * sp * vz * dt;
    x += vx * dt;
    y += vy * dt;
    z += vz * dt;
    if (y < r && vy < 0) {
      y = r;
      vy = -vy * 0.74;
      vx *= 0.82;
      vz *= 0.82;
      if (z > 0) bounced = true;
      if (Math.abs(vy) < 0.3) break;
    }
    if (z > COURT.halfLength - r && vz > 0 && y < COURT.backWall.glassTop) {
      z = COURT.halfLength - r;
      vz = -vz * 0.72;
      vx *= 0.85;
      if (bounced) wall = true;
    }
    if (Math.abs(x) > COURT.halfWidth - r && x * vx > 0 && y < 2.5 && Math.abs(z) > 6) {
      x = Math.sign(x) * (COURT.halfWidth - r);
      vx = -vx * 0.72;
      if (bounced) wall = true;
    }
  }
  return out;
}

/**
 * Ball path from the real flight model (drag, Magnus, turf / glass / mesh impacts) in the
 * predictBallPath sample format, times relative to the ball's current time. bounced: after
 * the first bounce on the near half; wall: after a wall rebound that followed it.
 */
export function predictCourtPath(ball, court, { maxT = 1.8, dt = 1 / 240 } = {}) {
  const out = [];
  if (!ball?.pos || !ball?.vel || !court) return out;
  const pr = predict(ball, court, { maxTime: maxT, dt, stopOn: ['exit', 'rest'] });
  const t0 = pr.samples.length ? pr.samples[0].t : 0;
  let k = 0, bounced = false, wall = false;
  for (const s of pr.samples) {
    while (k < pr.events.length && pr.events[k].t <= s.t + 1e-9) {
      const e = pr.events[k++];
      if (e.side !== 'near') continue;
      if (e.type === 'bounce') bounced = true;
      else if (e.type === 'wall' && bounced) wall = true;
    }
    out.push({ t: s.t - t0, x: s.pos.x, y: s.pos.y, z: s.pos.z, vx: s.vel.x, vy: s.vel.y, vz: s.vel.z, bounced, wall });
  }
  return out;
}

/**
 * Picks the most comfortable contact sample for a player at (px, pz): ball on the near side,
 * coming toward the player, reachable, 0.35–2.3 m high; prefers after the bounce at hip-chest
 * height on the side of the body. Returns a sample or null.
 */
export function chooseContact(samples, playerPos, handed = 'right', { minT = 0.12, overhead = false, height = PLAYER.defaultHeight } = {}) {
  const side = handed === 'left' ? -1 : 1;
  const k = height / PLAYER.defaultHeight;
  // Overhead drills (bandeja, víbora, smash): take the lob high in the air, in front.
  const yMax = overhead ? 2.6 * k : 2.3;
  const yIdeal = overhead ? 2.3 * k : 1.0;
  let best = null, bestScore = Infinity;
  for (const s of samples) {
    if (s.t < minT || s.z <= 0.3 || s.y < 0.35 || s.y > yMax) continue;
    if (s.z > COURT.halfLength - FALLBACK.autoGlassGap) continue; // let it come off the glass
    if (Math.abs(s.x) > COURT.halfWidth - FALLBACK.autoSideGap) continue; // and off the side glass
    const dx = s.x - playerPos.x;
    const dz = s.z - playerPos.z;
    const reach = Math.hypot(dx, dz);
    if (reach > 1.7 || dz > 0.4 || dz < -1.6) continue;
    const ideal = Math.abs(Math.abs(dx) - (overhead ? 0.35 : 0.7)) + Math.abs(dz + 0.5) * 0.8 + Math.abs(s.y - yIdeal) * 0.6;
    let score = ideal + (s.bounced === !overhead ? 0 : 0.35) + (s.vz < 0 ? 0.8 : 0) + s.t * 0.15;
    if (dx * side < -0.2) score += 0.1; // backhand is fine, forehand slightly preferred
    if (score < bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return best;
}

/** Cubic Hermite point + derivative (per unit u) for vectors. */
function hermite3(p0, m0, p1, m1, u, outP, outV) {
  const u2 = u * u, u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
  const d00 = 6 * u2 - 6 * u, d10 = 3 * u2 - 4 * u + 1, d01 = -6 * u2 + 6 * u, d11 = 3 * u2 - 2 * u;
  for (const k of ['x', 'y', 'z']) {
    outP[k] = h00 * p0[k] + h10 * m0[k] + h01 * p1[k] + h11 * m1[k];
    outV[k] = d00 * p0[k] + d10 * m0[k] + d01 * p1[k] + d11 * m1[k];
  }
}

/**
 * Plans a swing through contact point P at time tc. Returns a plan object for swingSample().
 * swingSide: +1 forehand (hand side), -1 backhand. Aim: deep cross-court with net clearance.
 */
export function planSwing(P, tc, eye, handed = 'right', { speed = FALLBACK.autoSwingSpeed, target = null, vel = null, normal = null } = {}) {
  const side = handed === 'left' ? -1 : 1;
  const swingSide = (P.x - eye.x) * side >= -0.05 ? 1 : -1;
  const lat = swingSide * side; // world-x sign of the hitting side
  const tgt = target || { x: -Math.sign(P.x || lat) * FALLBACK.autoTargetX, y: 0, z: FALLBACK.autoTargetZ };
  const dir = v3(tgt.x - P.x, 0, tgt.z - P.z);
  const dist = dir.length();
  dir.scale(1 / Math.max(dist, 1e-6));
  const vBall = 22;
  const elev = clamp(FALLBACK.autoElevScale * Math.asin(Math.min(1, (SIM.gravity * dist) / (vBall * vBall))) + FALLBACK.autoFaceTiltDeg * DEG - (P.y - 1) * 0.05, -8 * DEG, 32 * DEG);
  const face = v3(dir.x * Math.cos(elev), Math.sin(elev), dir.z * Math.cos(elev));
  const velDir = v3(face.x, face.y + FALLBACK.autoBrush, face.z).normalize(); // brush up: topspin
  const T = FALLBACK.autoWindow;
  const back = v3(P.x + lat * 0.5, P.y - 0.2, P.z + 0.5);
  const follow = v3(P.x - lat * 0.65, P.y + 0.4, P.z - 0.3);
  if (vel && normal) {
    // Aimed swing: the sweet spot meets P with exactly `vel`, the face along `normal`.
    const n = v3(normal.x, normal.y, normal.z).normalize();
    const vd = v3(vel.x, vel.y, vel.z);
    const sp = Math.max(vd.length(), 1e-6);
    const b2 = v3(P.x, P.y, P.z).addScaled(vd, -0.5 / sp).add(v3(lat * 0.15, -0.05, 0));
    const f2 = v3(P.x, P.y, P.z).addScaled(vd, 0.45 / sp).add(v3(-lat * 0.35, 0.25, 0));
    return { P: v3(P.x, P.y, P.z), tc, T, back: insideWalls(b2), follow: insideWalls(f2), face: n.clone(), normal: n, vel: vd, swingSide };
  }
  return { P: v3(P.x, P.y, P.z), tc, T, back: insideWalls(back), follow: insideWalls(follow), face, vel: velDir.scale(speed), swingSide };
}

/** Keeps a swing key point (sweet spot) inside the back / side glass. */
function insideWalls(p) {
  const g = FALLBACK.racketWallGap;
  p.z = Math.min(p.z, COURT.halfLength - g);
  p.x = clamp(p.x, -COURT.halfWidth + g, COURT.halfWidth - g);
  return p;
}

const UPV = v3(0, 1, 0);
const invBall = createBall();
const invPose = { grip: v3(), axis: v3(), normal: v3(), vel: v3(), angVel: v3(), t: 0 };
const invContact = { local: { x: 0, y: RACKET.sweetSpotY } };

/**
 * Inverts the racket impact (physics/racket.js): the face normal and sweet-spot velocity
 * (no racket rotation) that send a ball arriving at P with vin / spinIn out with vDes.
 * lat: world-x sign of the hitting side (orients the handle). Returns { normal, vel, out }.
 */
export function invertImpact(P0, vin0, spinIn, vDes0, { lat = 1, brushDeg = FALLBACK.autoBrushDeg } = {}) {
  const P = v3(P0.x, P0.y, P0.z), vin = v3(vin0.x, vin0.y, vin0.z), vDes = v3(vDes0.x, vDes0.y, vDes0.z);
  const e = RACKET.apparentCOR;
  const tb = Math.tan(brushDeg * DEG);
  const aimV = v3(vDes.x, vDes.y, vDes.z);
  const n = v3(), xh = v3(), err = v3();
  let best = null;
  for (let it = 0; it < 8; it++) {
    n.subVectors(aimV, vin);
    if (n.lengthSq() < 1e-9) n.set(0, 0, -1);
    n.normalize();
    const vn = (aimV.dot(n) + e * vin.dot(n)) / (1 + e);
    xh.copy(UPV).addScaled(n, -n.y);
    if (xh.lengthSq() < 1e-9) xh.set(0, 0, -1);
    xh.normalize();
    const a = invPose.axis.set(lat * 0.78, 0.6, -0.28).projectOnPlane(n);
    if (a.lengthSq() < 1e-9) a.copy(xh);
    a.normalize();
    invPose.normal.copy(n);
    invPose.grip.copy(P).addScaled(a, -RACKET.sweetSpotY);
    invPose.vel.copy(n).scale(vn).addScaled(xh, vn * tb);
    invPose.angVel.set(0, 0, 0);
    invBall.pos.copy(P);
    invBall.vel.copy(vin);
    if (spinIn) invBall.spin.set(spinIn.x, spinIn.y, spinIn.z);
    else invBall.spin.set(0, 0, 0);
    invBall.atRest = false;
    racketImpact(invBall, invPose, invContact, { margin: 0 });
    err.subVectors(vDes, invBall.vel);
    best = { normal: n.clone(), vel: invPose.vel.clone(), out: invBall.vel.clone(), spinOut: invBall.spin.clone(), err: err.length() };
    if (best.err < 0.05) break;
    aimV.add(err);
  }
  return best;
}

/** Drill hint for the ball in play (aim, pace, spin), like the autopilot reads it. */
function drillHint(world) {
  const m = world?.mode;
  if (!m) return null;
  if (m.apHints) return m.apHints;
  const d = m.activeDrill || m.drill;
  return (d && d.ap) || null;
}

/**
 * The shot an assisted auto-swing goes for from contact sample c: the drill's aim and pace
 * (deep cross-court otherwise), blended toward the stroke's intended shot by
 * FALLBACK.autoIntentBlend, then Rookie net safety. Returns { vel, spin, stroke } or null.
 */
export function aimedShot(world, c, eye, handed = 'right', spinOverride = null) {
  const side = handed === 'left' ? -1 : 1;
  const P = v3(c.x, c.y, c.z);
  const fh = (c.x - eye.x) * side >= -0.05;
  const h = drillHint(world) || {};
  const overhead = c.y > 1.75 * ((world?.player?.height || PLAYER.defaultHeight) / 1.75);
  const stroke = overhead ? 'bandeja' : !c.bounced ? (fh ? 'volley-fh' : 'volley-bh') : c.wall ? (fh ? 'glass-fh' : 'glass-bh') : fh ? 'forehand' : 'backhand';
  let aim = (!fh && h.aimBh) || h.aim || null;
  if (!aim || h.contact === 'serve') aim = { x: -Math.sign(c.x || side) * FALLBACK.autoTargetX, z: -7.6 };
  const target = v3(aim.x, 0, aim.z);
  const dir = v3(target.x - P.x, 0, target.z - P.z);
  const top = overhead ? Math.min(0, h.top ?? -400) : Math.max(300, h.top ?? 800);
  const spin = spinOverride ? v3(spinOverride.x, spinOverride.y, spinOverride.z) : spinFromComponents(dir, top, 0);
  const court = world?.court || null;
  const kmh = clamp(h.speedKmh ?? 66, FALLBACK.autoSpeedKmh[0], FALLBACK.autoSpeedKmh[1]);
  let res = h.apex ? solveShot({ from: P, target, spin, apex: h.apex, court }) : solveShot({ from: P, target, spin, speed: kmh / 3.6, court });
  if (!res.ok || !res.clearsNet) {
    const dist = Math.hypot(dir.x, dir.z);
    res = solveShot({ from: P, target, spin, apex: Math.max(P.y + 0.5, netHeightAt(target.x) + 0.9 + 0.08 * dist), court });
  }
  if (!res || !res.vel) return null;
  const vel = res.vel.clone();
  const intent = intendedShot(P, vel, spin, stroke, { dirZ: -1 });
  if (intent) blendTowardIntent(res.vel, intent.vel, FALLBACK.autoIntentBlend, vel);
  const tmp = { pos: P, vel, spin };
  applyNetSafety(tmp, FALLBACK.autoNetSafety, -1);
  return { vel, spin, stroke, target };
}

/**
 * Sweet-spot position and velocity of the planned swing at time t.
 * Returns { phase: 'prep'|'swing'|'follow'|'done', w (blend weight from pointer 0..1) }.
 */
export function swingSample(plan, t, outPos, outVel) {
  const { P, tc, T, back, follow, vel } = plan;
  const u = (t - tc) / T; // -1 at end of backswing, 0 at contact, 0.8 at end of follow-through
  const zero = { x: 0, y: 0, z: 0 };
  if (u < -1) {
    outPos.copy(back);
    outVel.set(0, 0, 0);
    return { phase: 'prep', w: smoothstep(-2.4, -1.2, u) };
  }
  if (u <= 0) {
    const m1 = { x: vel.x * T, y: vel.y * T, z: vel.z * T };
    hermite3(back, zero, P, m1, u + 1, outPos, outVel);
    outVel.scale(1 / T);
    return { phase: 'swing', w: 1 };
  }
  const D = 0.8 * T;
  if (u <= 0.8) {
    const m0 = { x: vel.x * D, y: vel.y * D, z: vel.z * D };
    hermite3(P, m0, follow, zero, u / 0.8, outPos, outVel);
    outVel.scale(1 / D);
    return { phase: 'follow', w: 1 };
  }
  outPos.copy(follow);
  outVel.set(0, 0, 0);
  return { phase: 'done', w: 1 - smoothstep(0.8, 2.0, u) };
}

const newPose = () => ({ grip: v3(), axis: v3(0, 1, 0), normal: v3(0, 0, -1), vel: v3(), angVel: v3(), t: 0 });

// ---------------------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------------------

/**
 * @param {object} o
 * @param {HTMLElement} [o.canvas] element receiving pointer events (null in tests)
 * @param {'right'|'left'} [o.handed]
 * @param {EventTarget} [o.keyTarget] defaults to window
 */
export function createFallbackControls({ canvas = null, handed = 'right', keyTarget = globalThis.window } = {}) {
  const ndc = { x: 0.32, y: -0.28, has: false };
  const keys = new Set();
  let enabled = true;
  let moveTarget = null;
  let autoRequest = false;
  let plan = null;
  const sweet = v3(), prevRel = v3(), rel = v3(), vPlane = v3(), tmpVel = v3(), face = v3();
  const autoPos = v3(), autoVel = v3();
  const eye = v3();
  const camEye = v3();
  let hasPrev = false;
  let flickSpeed = 0; // m/s of the gained pointer flick (no body motion), for the app's swing trigger

  const onPointer = (e) => {
    if (!enabled || !canvas) return;
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    ndc.x = clamp(((e.clientX - r.left) / r.width) * 2 - 1, -1, 1);
    ndc.y = clamp(1 - ((e.clientY - r.top) / r.height) * 2, -1, 1);
    ndc.has = true;
  };
  const isTyping = (e) => {
    const el = e.target;
    return el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName || ''));
  };
  const KEYMAP = { KeyW: 'f', ArrowUp: 'f', KeyS: 'b', ArrowDown: 'b', KeyA: 'l', ArrowLeft: 'l', KeyD: 'r', ArrowRight: 'r' };
  const onKeyDown = (e) => {
    if (!enabled || isTyping(e)) return;
    if (e.code === 'Space') {
      autoRequest = true;
      e.preventDefault();
      return;
    }
    const k = KEYMAP[e.code];
    if (k) {
      keys.add(k);
      e.preventDefault();
    }
  };
  const onKeyUp = (e) => {
    const k = KEYMAP[e.code];
    if (k) keys.delete(k);
  };
  const onBlur = () => keys.clear();

  if (canvas) {
    canvas.addEventListener('pointermove', onPointer);
    canvas.addEventListener('pointerdown', onPointer);
  }
  if (keyTarget?.addEventListener) {
    keyTarget.addEventListener('keydown', onKeyDown);
    keyTarget.addEventListener('keyup', onKeyUp);
    keyTarget.addEventListener('blur', onBlur);
  }

  function updateMove(dt, world) {
    if (!keys.size) return;
    const p = world?.player?.pos || { x: 0, z: 7.8 };
    if (!moveTarget) moveTarget = { x: p.x, z: p.z };
    const dx = (keys.has('r') ? 1 : 0) - (keys.has('l') ? 1 : 0);
    const dz = (keys.has('b') ? 1 : 0) - (keys.has('f') ? 1 : 0);
    const n = Math.hypot(dx, dz) || 1;
    // The same body bounds as camera play (0.6 m off the back glass, 0.45 m off the side glass).
    const bd = defaultBounds();
    moveTarget.x = clamp(moveTarget.x + (dx / n) * FALLBACK.moveSpeed * dt, bd.xMin, bd.xMax);
    moveTarget.z = clamp(moveTarget.z + (dz / n) * FALLBACK.moveSpeed * dt, bd.zMin, bd.zMax);
  }

  /** Ball path to plan on: the real flight model when the world has a court. */
  function ballPath(world) {
    const b = world?.ball;
    if (!b || b.atRest) return [];
    return world.court && FALLBACK.autoAim ? predictCourtPath(b, world.court) : predictBallPath(b);
  }

  /** Swing through contact c: aimed at the drill intent when the world allows it. */
  function swingFor(world, c, now) {
    const side = handed === 'left' ? -1 : 1;
    let shot = world?.court && FALLBACK.autoAim ? aimedShot(world, c, eye, handed) : null;
    if (shot) {
      const fh = (c.x - eye.x) * side >= -0.05;
      // Spin of the ball at the contact (a bounce turns it into topspin toward the player).
      const at = cloneBall(world.ball);
      if (c.t > 0) stepBall(at, c.t, world.court, null, null, { deterministic: true });
      const solve = (sh) => invertImpact(v3(c.x, c.y, c.z), v3(c.vx, c.vy, c.vz), at.spin, sh.vel, { lat: (fh ? 1 : -1) * side });
      let inv = solve(shot);
      // The racket decides the spin: re-solve the shot with the spin this swing really imparts.
      for (let k = 0; k < 1 && inv; k++) {
        const again = aimedShot(world, c, eye, handed, inv.spinOut);
        if (!again) break;
        shot = again;
        inv = solve(shot);
      }
      if (inv && inv.err < 2.5) return Object.assign(planSwing(c, now + c.t, eye, handed, { vel: inv.vel, normal: inv.normal }), { aimed: shot });
    }
    return planSwing(c, now + c.t, eye, handed);
  }

  let lastRefine = -Infinity;
  function contactOpts(world) {
    const h = FALLBACK.autoAim ? drillHint(world) : null;
    return { overhead: !!(h && h.contact === 'overhead'), height: world?.player?.height || PLAYER.defaultHeight };
  }

  function updatePlan(world, now) {
    const playerPos = world?.player?.pos || { x: eye.x, z: eye.z };
    // A swing already under way is not restarted (the app also triggers auto-swings on fast
    // racket motion, which the auto-swing itself produces around the contact).
    if (autoRequest && plan && plan.live && now > plan.tc - plan.T - 0.05 && now < plan.tc + 0.2) autoRequest = false;
    if (autoRequest) {
      autoRequest = false;
      const c = chooseContact(ballPath(world), playerPos, handed, contactOpts(world));
      if (c) plan = swingFor(world, c, now);
      else {
        // no ball to play: a shadow swing on the forehand side
        const side = handed === 'left' ? -1 : 1;
        plan = planSwing({ x: eye.x + side * 0.7, y: 1.0, z: eye.z - 0.6 }, now + 0.45, eye, handed);
      }
      plan.live = !!c;
      lastRefine = now;
    }
    if (plan && plan.live && now < plan.tc - 0.12 && now - lastRefine >= 0.1) {
      // refine contact while the ball is still in flight (the player keeps moving)
      lastRefine = now;
      const c = chooseContact(ballPath(world), playerPos, handed, contactOpts(world));
      if (c && Math.abs(now + c.t - plan.tc) < 0.25) plan = Object.assign(swingFor(world, c, now), { live: true });
    }
  }

  return {
    get enabled() {
      return enabled;
    },
    set enabled(b) {
      enabled = !!b;
      if (!enabled) keys.clear();
    },
    setHanded(h) {
      handed = h === 'left' ? 'left' : 'right';
    },
    /** Clears the keyboard target so locomotion/magnet can position the player again. */
    resetTarget() {
      moveTarget = null;
    },
    /** The active auto-swing plan (tests / debug overlay), or null. */
    get autoPlan() {
      return plan;
    },
    /** For tests and the auto-swing button in UIs. */
    triggerAutoSwing() {
      autoRequest = true;
    },
    /** Synthetic pointer input (tests, touch UIs): ndc in -1..1, +y up. */
    setPointer(x, y) {
      ndc.x = clamp(x, -1, 1);
      ndc.y = clamp(y, -1, 1);
      ndc.has = true;
    },

    update(dt, world) {
      const now = world?.time ?? 0;
      const pose = newPose();
      pose.t = now;
      eyeOf(world?.player, eye);
      if (!enabled) return { moveTarget: null, racket: null };
      updateMove(dt, world);

      const aspect = canvas && canvas.clientHeight ? canvas.clientWidth / canvas.clientHeight : 16 / 9;
      const fovDeg = world?.settings?.fov || FALLBACK.defaultFovDeg;
      // Project from where the camera really is (view offset behind / below the eyes) onto the
      // plane 0.65 m in front of the eyes, so the racket stays under the pointer.
      const off = world?.settings?.eyeOffset;
      const back = off ? off.back || 0 : 0;
      camEye.set(eye.x, eye.y - (off ? off.down || 0 : 0), eye.z + back);
      pointerToPlane(ndc.x, ndc.y, camEye, { fovDeg, aspect, depth: FALLBACK.planeDepth + back }, sweet);
      sweet.y = Math.max(sweet.y, 0.12);

      // Pointer velocity on the plane relative to the eyes (the flick), lightly smoothed. The
      // body's own motion (keys, assist magnet) carries the racket along at 1x and is no flick:
      // with the old absolute velocity a magnet walk (up to 7 m/s, x3) read as a flick and the
      // game auto-swung every ball with no input at all.
      rel.subVectors(sweet, camEye);
      if (hasPrev && dt > 0) {
        tmpVel.subVectors(rel, prevRel).scale(1 / dt);
        vPlane.lerp(tmpVel, 1 - Math.exp(-dt / 0.03));
      } else vPlane.set(0, 0, 0);
      prevRel.copy(rel);
      hasPrev = true;

      flickVelocity(vPlane, FALLBACK.velGain, pose.vel);
      flickSpeed = pose.vel.length();
      const pv = world?.player?.vel;
      if (pv) pose.vel.add(pv);
      flickFaceDir(vPlane, face);
      orientRacket(sweet, eye, face, handed, pose);

      updatePlan(world, now);
      if (plan) {
        const s = swingSample(plan, now, autoPos, autoVel);
        if (s.phase === 'done' && s.w <= 0) plan = null;
        else {
          const w = s.w;
          const pointerSweet = sweet.clone();
          sweet.lerpVectors(pointerSweet, autoPos, w);
          face.lerp(plan.face, w).normalize();
          orientRacket(sweet, eye, face, handed, pose);
          if (plan.normal) {
            // Aimed swing: the face meets the ball along the solved normal (either face).
            const sgn = pose.normal.dot(plan.normal) < 0 ? -1 : 1;
            pose.normal.lerp(_d.copy(plan.normal).scale(sgn), w).normalize();
            pose.axis.projectOnPlane(pose.normal).normalize();
            pose.grip.copy(sweet).addScaled(pose.axis, -RACKET.sweetSpotY);
          }
          pose.vel.lerpVectors(pose.vel, autoVel, w);
        }
      }
      return { moveTarget: moveTarget ? { x: moveTarget.x, z: moveTarget.z } : null, racket: pose, flickSpeed };
    },

    dispose() {
      enabled = false;
      if (canvas) {
        canvas.removeEventListener('pointermove', onPointer);
        canvas.removeEventListener('pointerdown', onPointer);
      }
      if (keyTarget?.removeEventListener) {
        keyTarget.removeEventListener('keydown', onKeyDown);
        keyTarget.removeEventListener('keyup', onKeyUp);
        keyTarget.removeEventListener('blur', onBlur);
      }
    },
  };
}
