// Autopilot (SPEC §4.7): a virtual player that drives the REAL pipeline through synthetic
// camera frames. Each update returns a SyntheticBody (room position + joints in U) for the
// synthetic camera; body.js / locomotion / racketTrack / lag-compensated hits do the rest.
//
//  - Reads world.ball with predict() + interceptCandidates(), picks a contact (drill hints
//    in world.mode.activeDrill.ap: overhead / volley / glass / ground / serve) and a stance
//    that puts the ball at the ideal contact point of the stroke family (fh, bh, volleys,
//    overhead). Locomotion is inverted: room offset = (court target - home) / gain through
//    the soft deadzone, after cancelling the assist magnet's pull. The room position moves
//    at human speed (rate- and acceleration-limited).
//  - Swing: the racket is a rigid body rotating about the hitting shoulder. At the contact
//    (racket time = ball contact time + settings.latency, because the game rewinds by the
//    latency) the sweet spot sits on the ball with the face normal and velocity found by
//    inverting the real racket impact model (racketImpact) toward an aimed shot solved
//    with solveShot. The angle follows θ(τ) = ωτ0·tanh(τ/τ0): a backswing that is held, a
//    forward swing peaking at contact, and a follow-through that decelerates. Families:
//    groundstroke (horizontal arc with brush-up topspin), volley (short punch), overhead
//    (high arc). Low balls are met by crouching, backhands with a shoulder turn.
// Pure module.

import { Vec3, v3 } from '../util/vec3.js';
import { clamp, createRng, smoothstep } from '../util/math.js';
import { RACKET, PLAYER, TRACKING, ASSIST, DEFAULT_ASSIST } from '../config.js';
import { standingBody, crouchBody, turnBody, poseArm, setHandTarget } from './synthetic.js';
import { defaultBounds, MAGNET_MAX_PULL, softDeadzone } from './locomotion.js';
import { rotateAbout } from './body.js';
import { predict, interceptCandidates, solveShot } from '../physics/predict.js';
import { racketImpact, spinFromComponents } from '../physics/racket.js';
import { createBall, cloneBall, stepBall } from '../physics/ball.js';
import { CONTACT_OFFSETS, idealStance, contactFamily } from '../game/human.js';
import { predictFlight, currentStroke } from '../game/world.js';

const REF_H = 1.75;
const UP = new Vec3(0, 1, 0);
const SWEET = RACKET.sweetSpotY;

/** Arc radius limit (shoulder -> sweet spot, m, for 1.75 m): arm (0.64) + racket to the sweet spot, bent. */
export const RHO_MAX = 0.8;
/** Swing shape per family: tau0 (s), max swing angle each way (rad), brush angle (deg, + = topspin). */
export const SWING_SHAPE = Object.freeze({
  fh: { tau0: 0.12, thetaMax: 1.7, brush: 32 },
  bh: { tau0: 0.12, thetaMax: 1.6, brush: 32 },
  vfh: { tau0: 0.1, thetaMax: 0.8, brush: 0 },
  vbh: { tau0: 0.1, thetaMax: 0.8, brush: 0 },
  oh: { tau0: 0.11, thetaMax: 1.8, brush: 0 },
  sm: { tau0: 0.1, thetaMax: 2.0, brush: 20 }, // QA: a 20° brush takes ~30% of the backspin off the smash (40° costs accuracy)
});
const ARC_IN = 0.32; // s before contact when the forward arc takes over from the preparation
const ARC_OUT = 0.24; // s after contact when the follow-through starts returning to ready
const RECOVER = 0.5; // s to return to the ready pose
const PREP = 0.5; // s of preparation (ready -> backswing)
const COMMIT_LEAD = 0.42; // s (racket time) before contact when the swing is re-solved and frozen
const ROOM_SPEED = 2.4; // m/s real-world movement
const ROOM_ACCEL = 9; // m/s^2
/**
 * Real play area in front of a MacBook / TV camera (m, relative to the calibrated spot at
 * about 2.6 m): a person stays trackable head to knees within ~0.7 m toward the camera,
 * ~0.6 m back and ±1 m sideways. The autopilot never leaves it, so its hit rates reflect
 * what a real living room allows (movement beyond it comes from the gains, magnet and the
 * modes' tactical home).
 */
export const ROOM_ENVELOPE = Object.freeze({ front: 0.7, back: 0.6, side: 1.0 });
/**
 * A contact is playable when the stance the play area allows is within this of the ideal one
 * (court m): sideways the arm absorbs it; in depth it would turn a drive into a late contact.
 */
const REACH_TOL = { x: 0.3, z: 0.14 };

const READY = { grip: [0.12, 1.06, 0.36], axis: [-0.3, 0.75, 0.55], normal: [-0.9, 0.1, 0.35] };

function softDeadzoneInverse(out, deadzone, knee = deadzone) {
  const a = Math.abs(out);
  if (deadzone <= 0 || a === 0) return out;
  const k = Math.max(1e-9, Math.min(knee, 2 * deadzone));
  const lo = deadzone - k / 2;
  const v = a >= k / 2 ? a + deadzone : lo + Math.sqrt(2 * k * a);
  return out < 0 ? -v : v;
}

/** Pre-compensates a wanted launch velocity by a learned bias {el, az, pace}. */
function applyCorrection(v, c) {
  const sp = v.length() / c.pace;
  const el = Math.atan2(v.y, Math.hypot(v.x, v.z)) - c.el;
  const az = Math.atan2(v.x, -v.z) - c.az;
  const h = Math.cos(el) * sp;
  return v3(Math.sin(az) * h, Math.sin(el) * sp, -Math.cos(az) * h);
}

function rotateInto(v, axis, angle, out) {
  return rotateAbout(v, axis, angle, out);
}

/**
 * Inverts the racket impact: finds the face normal, sweet-spot velocity (tangent to an arc
 * about the shoulder) and angular velocity that send a ball arriving with vin/spinIn at C
 * out with vDes. Returns { n (struck-face normal), a (axis), V, omega (vector), rho, r̂, vOut, spinOut }.
 */
export function solveSwing({ C, vin, spinIn, vDes, shoulder, faceSign = 1, brushDeg = 0 }) {
  const r = v3().subVectors(C, shoulder);
  const rho = r.length();
  const rh = r.clone().scale(1 / rho);
  const aimV = vDes.clone();
  const n = v3(), a = v3(), V = v3(), om = v3(), xh = v3(), tmp = v3();
  const ball = createBall();
  const contact = { local: { x: 0, y: SWEET }, face: faceSign > 0 ? 'front' : 'back' };
  const pose = { grip: v3(), axis: a, normal: v3(), vel: V, angVel: om, t: 0 };
  const e = RACKET.apparentCOR;
  const tb = Math.tan((brushDeg * Math.PI) / 180);
  let best = null;
  for (let it = 0; it < 7; it++) {
    n.subVectors(aimV, vin).normalize();
    a.copy(rh).addScaled(n, -rh.dot(n));
    if (a.lengthSq() < 1e-6) a.copy(UP).addScaled(n, -n.y);
    a.normalize();
    const vn = (aimV.dot(n) + e * vin.dot(n)) / (1 + e);
    xh.crossVectors(a, n).normalize();
    if (xh.y < 0) xh.negate();
    V.copy(n).scale(vn).addScaled(xh, vn * tb);
    V.addScaled(rh, -V.dot(rh));
    om.crossVectors(rh, V).scale(1 / rho);
    pose.grip.copy(C).addScaled(a, -SWEET);
    pose.normal.copy(n).scale(faceSign);
    ball.pos.copy(C);
    ball.vel.copy(vin);
    ball.spin.copy(spinIn);
    ball.atRest = false;
    racketImpact(ball, pose, contact, { margin: 0 });
    tmp.subVectors(vDes, ball.vel);
    best = { n: n.clone(), a: a.clone(), V: V.clone(), omega: om.clone(), rho, rh: rh.clone(), vOut: ball.vel.clone(), spinOut: ball.spin.clone(), err: tmp.length() };
    if (best.err < 0.05) break;
    aimV.add(tmp);
  }
  return best;
}

/**
 * @param {{handed?: 'right'|'left', skill?: number, rng?: Function, height?: number, room0?: {x,d}}} o
 * @returns Autopilot = { update(world, simTime) -> SyntheticBody, state, reset() }
 */
export function createAutopilot({ handed = 'right', skill = 0.9, rng = createRng(0xa7a7), height = PLAYER.defaultHeight, room0 = { x: 0, d: 2.6 } } = {}) {
  const dom = handed === 'left' ? -1 : 1;
  const domSide = handed === 'left' ? 'L' : 'R';
  const offSide = handed === 'left' ? 'R' : 'L';
  const k = height / REF_H;
  const room = { x: room0.x, d: room0.d };
  const roomVel = { x: 0, d: 0 };
  let lastT = null;
  let plan = null;
  let lastRecheck = -Infinity;
  const cur = { grip: v3(), axis: v3(), normal: v3(), valid: false }; // last commanded racket pose (court)
  const st = { plans: 0, swings: 0, lastPlan: null, crouch: 0, turn: 0, reached: true, maxGripError: 0, adapt: {} };
  // Learned aim corrections per stroke family (like a player adjusting after each shot):
  // elevation / azimuth offsets (rad) and a pace ratio between realised and planned launch.
  const adapt = st.adapt;
  let seenShots = 0;

  // Scratch
  const tA = v3(), tB = v3(), tC = v3();

  function readyPoseCourt(px, pz, out) {
    out.grip.set(px + dom * READY.grip[0] * k, READY.grip[1] * k, pz - READY.grip[2] * k);
    out.axis.set(dom * READY.axis[0], READY.axis[1], -READY.axis[2]).normalize();
    out.normal.set(dom * READY.normal[0], READY.normal[1], -READY.normal[2]);
    out.normal.addScaled(out.axis, -out.normal.dot(out.axis)).normalize();
    return out;
  }

  /** Shoulder of the hitting arm in U for a body turned `turn` deg and crouched `crouch` m. */
  function shoulderU(turn, crouch) {
    const sx = dom * 0.18 * k, sy = PLAYER.shoulderHeightRatio * height - crouch;
    const a = (turn * Math.PI) / 180;
    // turnBody rotates about the hip centre: x' = x cos a + z sin a, z' = -x sin a + z cos a.
    return v3(sx * Math.cos(a), sy, -sx * Math.sin(a));
  }

  function hints(world) {
    const m = world.mode;
    if (m && m.apHints) return m.apHints;
    const d = m && (m.activeDrill || m.drill);
    return (d && d.ap) || { contact: 'any', family: 'auto' };
  }

  function chooseCandidate(world, cands, hint, serving) {
    if (!cands.length) return null;
    const volleyCost = (c) => c.travel + 0.8 * Math.abs(c.height - 1.2 * k);
    const h = (c) => c.height;
    if (serving) {
      const after = cands.filter((c) => c.kind === 'after-bounce' && h(c) <= 0.53 * height && h(c) >= 0.3);
      if (!after.length) return null;
      return after.reduce((b, c) => (h(c) > h(b) ? c : b), after[0]);
    }
    const byT = (arr) => arr.slice().sort((x, y) => x.t - y.t);
    // A contact whose stance would be behind the back glass / beside the side glass is no option.
    const b = defaultBounds();
    // ...and so is one the real play area cannot take the player to (ROOM_ENVELOPE).
    const reach = (st) => {
      const a = reachableStance(world, { x: clamp(st.x, b.xMin, b.xMax), z: clamp(st.z, b.zMin, b.zMax) });
      return Math.abs(a.x - st.x) <= REACH_TOL.x && Math.abs(a.z - st.z) <= REACH_TOL.z;
    };
    cands = cands.filter((c) => {
      const fam = c.pos.y > 1.78 * k ? 'oh' : 'fh';
      const sF = idealStance(c.pos, fam, handed, height);
      const sB = idealStance(c.pos, 'bh', handed, height);
      const okF = sF.z <= b.zMax + 0.05 && sF.x >= b.xMin - 0.05 && sF.x <= b.xMax + 0.05;
      const okB = sB.z <= b.zMax + 0.05 && sB.x >= b.xMin - 0.05 && sB.x <= b.xMax + 0.05;
      return (okF && reach(sF)) || (okB && reach(sB));
    });
    if (!cands.length) return null;
    if (hint.contact === 'overhead') {
      const oh = cands.filter((c) => c.kind === 'volley' && h(c) >= 1.85 * k && h(c) <= 2.25 * k);
      if (oh.length) return oh.reduce((b, c) => (Math.abs(h(c) - 2.08 * k) < Math.abs(h(b) - 2.08 * k) ? c : b), oh[0]);
    } else if (hint.contact === 'volley') {
      // Take it where you stand, at a comfortable chest height (not by sprinting to the tape).
      const v = cands.filter((c) => c.kind === 'volley' && h(c) >= 0.6 && h(c) <= 1.7 * k);
      if (v.length) return v.reduce((b, c) => (volleyCost(c) < volleyCost(b) ? c : b), v[0]);
    } else if (hint.contact === 'glass') {
      const g = byT(cands.filter((c) => c.kind === 'after-wall' && c.comfortable && !c.cramped));
      if (g.length) return g[Math.min(2, g.length - 1)];
    }
    // Default preference (comfortable groundstroke, then volley...), never an overhead by accident.
    const low = cands.filter((c) => h(c) <= 1.7 * k);
    const pool = low.length ? low : cands;
    const ground = pool.filter((c) => c.kind !== 'volley' && c.comfortable && !c.cramped);
    if (ground.length && hint.contact !== 'volley') {
      // Meet it near the top of its bounce, or a little after: the textbook drive contact.
      const first = ground[0];
      const sameKind = ground.filter((c) => c.kind === first.kind && c.t - first.t < 0.35);
      return sameKind.reduce((b, c) => (Math.abs(h(c) - 0.95 * k) < Math.abs(h(b) - 0.95 * k) ? c : b), sameKind[0]);
    }
    return pool[0];
  }

  function familyFor(c, hint, playerPos) {
    if (c.pos.y > 1.78 * k) return hint.family === 'sm' ? 'sm' : 'oh';
    const volley = c.kind === 'volley';
    let fam = hint.family && hint.family !== 'auto' ? hint.family : contactFamily(c.pos, c.kind, playerPos, handed, height);
    if (fam === 'oh' || fam === 'sm') fam = 'fh';
    if (volley) fam = fam === 'bh' || fam === 'vbh' ? 'vbh' : 'vfh';
    else fam = fam === 'bh' || fam === 'vbh' ? 'bh' : 'fh';
    return fam;
  }

  function aimFor(world, hint, fam, serving) {
    // Without a drill target: deep, varied (mostly cross-court), like a rally player.
    let aim = hint.aim || { x: -dom * rng.range(-1.5, 3.0), z: -rng.range(7.6, 8.6) };
    if (serving) {
      // Diagonal box of the far receiver: their right box is x <= 0, the left box x >= 0.
      const ref = world.referee;
      const box = ref && ref.state.serving ? ref.state.serving.box : 'right';
      const bx = box === 'left' ? 1 : -1;
      const z = hint.contact === 'serve' && hint.aim ? hint.aim.z : -5.6;
      aim = { x: bx * Math.abs(hint.contact === 'serve' && hint.aim ? hint.aim.x : 2.4), z };
      hint = { ...hint, speedKmh: hint.contact === 'serve' ? hint.speedKmh : 62, top: hint.contact === 'serve' ? hint.top : -200, apex: null };
    }
    if ((fam === 'bh' || fam === 'vbh') && hint.aimBh) aim = hint.aimBh;
    const sig = (1 - skill) * 1.2;
    const target = v3(aim.x + rng.normal(0, sig), 0, aim.z + rng.normal(0, sig * 0.8));
    if (serving) target.z = clamp(target.z, -6.6, -3);
    return {
      target,
      speed: (hint.speedKmh ?? (fam === 'oh' ? 65 : fam === 'vfh' || fam === 'vbh' ? 50 : 70)) / 3.6,
      apex: hint.apex ?? null,
      maxClear: hint.maxClear ?? null,
      top: hint.top ?? (fam === 'fh' || fam === 'bh' ? 900 : 0),
    };
  }

  function makePlan(world, T, key, committed) {
    const ball = world.ball;
    const lat = world.settings.latency ?? TRACKING.latencyDefault;
    const pl = world.player;
    const pred = predictFlight(world, { maxTime: 3.5 });
    const stroke0 = currentStroke(world);
    const receivingServe = !!(stroke0 && stroke0.isServe && stroke0.team !== 0);
    const serving = world.flight.by === 'drop';
    let cands = interceptCandidates(pred, {
      playerPos: pl.pos, maxSpeed: 4.6, reachRadius: 0.8, side: 'near', now: world.time - lat + 0.12, minHeight: 0.3, maxHeight: 2.3 * k,
    });
    if (receivingServe) cands = cands.filter((c) => c.kind !== 'volley');
    const hint = hints(world);
    const c = chooseCandidate(world, cands, hint, serving);
    if (!c) return { key, none: true, made: T };
    const fam = serving ? 'fh' : familyFor(c, hint, pl.pos);
    const off = CONTACT_OFFSETS[fam];
    const b = defaultBounds();
    const s = idealStance(c.pos, fam, handed, height);
    // Where the play area can actually put the player (the swing is planned from there).
    const stance = reachableStance(world, { x: clamp(s.x, b.xMin, b.xMax), z: clamp(s.z, b.zMin, b.zMax) });
    const turn = dom * off.turn;

    // Contact in U relative to the stance; crouch so the shoulder can reach a low ball.
    const cu = v3(c.pos.x - stance.x, c.pos.y, stance.z - c.pos.z);
    let crouch = 0;
    let sh = shoulderU(turn, 0);
    const hd2 = (cu.x - sh.x) ** 2 + (cu.z - sh.z) ** 2;
    const rmax = RHO_MAX * k;
    const dyMax = Math.sqrt(Math.max(0.01, rmax * rmax - hd2));
    if (sh.y - cu.y > dyMax) crouch = clamp(sh.y - cu.y - dyMax, 0, 0.42 * k);
    sh = shoulderU(turn, crouch);
    const shoulder = v3(stance.x + sh.x, sh.y, stance.z - sh.z);

    const tr = c.t + lat + rng.normal(0, (1 - skill) * 0.025);
    const aim = aimFor(world, hint, fam, serving);
    const fromC = c.pos.clone();
    const dir = v3(aim.target.x - fromC.x, 0, aim.target.z - fromC.z);
    let spinGuess = spinFromComponents(dir, aim.top, 0);
    const solveDes = (spin) => {
      let res = aim.apex ? solveShot({ from: fromC, target: aim.target, spin, apex: aim.apex }) : solveShot({ from: fromC, target: aim.target, spin, speed: aim.speed });
      // Skim the tape (chiquita): add pace until the lowest trajectory clears by < maxClear.
      for (let dv = 0.3; aim.maxClear && dv < 2.5 && res.ok && res.netClearance > aim.maxClear; dv += 0.3) {
        res = solveShot({ from: fromC, target: aim.target, spin, speed: aim.speed + dv });
      }
      if (!res.ok || !res.clearsNet) res = solveShot({ from: fromC, target: aim.target, spin, apex: Math.max(fromC.y + 0.4, 1.8) });
      return res;
    };
    const shape = SWING_SHAPE[fam];
    const faceSign = fam === 'bh' || fam === 'vbh' ? -1 : 1;
    // Incoming state at the contact (the bounce on the turf changes the spin a lot).
    const atC = cloneBall(ball);
    if (c.t > atC.t) stepBall(atC, c.t - atC.t, world.court, null, null, { deterministic: true });
    const spinIn = atC.spin.clone();
    const vIn = atC.vel.clone();
    const adaptKey = serving ? 'serve' : fam;
    const corr = adapt[adaptKey];
    const corrected = (v) => (corr ? applyCorrection(v, corr) : v);
    let des = solveDes(spinGuess);
    let sw = solveSwing({ C: fromC, vin: vIn, spinIn, vDes: corrected(des.vel), shoulder, faceSign, brushDeg: shape.brush });
    spinGuess = sw.spinOut;
    des = solveDes(spinGuess);
    sw = solveSwing({ C: fromC, vin: vIn, spinIn, vDes: corrected(des.vel), shoulder, faceSign, brushDeg: shape.brush });

    const omega = sw.omega.length();
    const tau0 = Math.min(shape.tau0, shape.thetaMax / Math.max(omega, 1e-3));
    st.plans++;
    const p = {
      key, none: false, made: T, committed, t: c.t, tr, kind: c.kind, fam, adaptKey, stance, crouch, turn,
      homeT: world.player.homeTarget ? { x: world.player.homeTarget.x, z: world.player.homeTarget.z } : null,
      C: fromC, vin: c.vel.clone(), shoulder, sw, tau0, omega, faceSign, aim, des, vWanted: des.vel.clone(),
      prepFrom: null, prepStart: T,
    };
    st.lastPlan = p;
    return p;
  }

  /** Racket pose (court) on the swing arc at racket time T. */
  function arcPose(p, T, out) {
    const tau = T - p.tr;
    const theta = p.omega * p.tau0 * Math.tanh(tau / p.tau0);
    const axisW = tA.copy(p.sw.omega).normalize();
    const r = tB.subVectors(p.C, p.shoulder);
    rotateInto(r, axisW, theta, tC);
    const sweet = tC.add(p.shoulder);
    rotateInto(p.sw.a, axisW, theta, out.axis);
    rotateInto(p.sw.n, axisW, theta, out.normal);
    out.normal.scale(p.faceSign);
    out.grip.copy(sweet).addScaled(out.axis, -SWEET);
    return out;
  }

  const poseA = { grip: v3(), axis: v3(), normal: v3() };
  const poseB = { grip: v3(), axis: v3(), normal: v3() };

  function blendPose(a, b, u, out) {
    // Blend the sweet spots (the part that matters for contact), then rebuild the grip.
    const sa = tA.copy(a.grip).addScaled(a.axis, SWEET);
    const sb = tB.copy(b.grip).addScaled(b.axis, SWEET);
    const s = tC.lerpVectors(sa, sb, u);
    out.axis.lerpVectors(a.axis, b.axis, u);
    if (out.axis.lengthSq() < 1e-8) out.axis.copy(b.axis);
    out.axis.normalize();
    out.normal.lerpVectors(a.normal, b.normal, u);
    out.normal.addScaled(out.axis, -out.normal.dot(out.axis));
    if (out.normal.lengthSq() < 1e-8) out.normal.copy(b.normal).addScaled(out.axis, -b.normal.dot(out.axis));
    out.normal.normalize();
    out.grip.copy(s).addScaled(out.axis, -SWEET);
    return out;
  }

  /** Commanded racket pose (court) at racket time T. */
  function racketPose(world, T, out) {
    const pp = world.player.pos;
    const ready = readyPoseCourt(pp.x, pp.z, poseA);
    const p = plan;
    if (!p || p.none) {
      if (cur.valid && st.recoverFrom && T - st.recoverFrom.t < RECOVER) {
        return blendPose(st.recoverFrom.pose, ready, smoothstep(0, 1, (T - st.recoverFrom.t) / RECOVER), out);
      }
      return copyPose(out, ready);
    }
    const tau = T - p.tr;
    if (tau >= -ARC_IN && tau <= ARC_OUT) return arcPose(p, T, out);
    if (tau < -ARC_IN) {
      const prepEnd = p.tr - ARC_IN;
      const prepStart = Math.max(p.prepStart, prepEnd - PREP);
      if (T <= prepStart) return copyPose(out, p.prepFrom || ready);
      const u = smoothstep(0, 1, (T - prepStart) / Math.max(1e-3, prepEnd - prepStart));
      arcPose(p, prepEnd, poseB);
      return blendPose(p.prepFrom || ready, poseB, u, out);
    }
    // Follow-through back to ready.
    arcPose(p, p.tr + ARC_OUT, poseB);
    const u = smoothstep(0, 1, (tau - ARC_OUT) / RECOVER);
    return blendPose(poseB, ready, u, out);
  }

  function copyPose(out, src) {
    out.grip.copy(src.grip);
    out.axis.copy(src.axis);
    out.normal.copy(src.normal);
    return out;
  }

  // ---- movement ----------------------------------------------------------------

  /** forPlan: plan against the home the mode is gliding to (tactical home), not the current one. */
  function locoOf(world, forPlan = false) {
    const pl = world.player;
    const loco = world.human && world.human.locomotion;
    const cfg = loco ? loco.config : {
      gainLateral: world.settings.gainLateral ?? TRACKING.gainLateral,
      gainDepth: world.settings.gainDepth ?? TRACKING.gainDepth,
      deadzone: TRACKING.deadzone, knee: TRACKING.deadzone,
    };
    const home = forPlan && pl.homeTarget ? pl.homeTarget : loco ? loco.home : pl.home;
    const assist = ASSIST[world.settings.assist] || ASSIST[DEFAULT_ASSIST];
    const m = pl.magnet;
    return { cfg, home, m, sMag: m ? assist.magnet : 0 };
  }

  /** Court position the game gives a room position (locomotion + magnet + bounds), as human.js does. */
  function courtFor(world, r, forPlan = true) {
    const { cfg, home, m, sMag } = locoOf(world, forPlan);
    let x = home.x + cfg.gainLateral * softDeadzone(r.x - room0.x, cfg.deadzone, cfg.knee);
    let z = home.z + cfg.gainDepth * softDeadzone(r.d - room0.d, cfg.deadzone, cfg.knee);
    if (m && sMag > 0) {
      const dx = m.x - x, dz = m.z - z;
      const dist = Math.hypot(dx, dz);
      if (dist > 1e-9) {
        const pull = Math.min(dist, MAGNET_MAX_PULL) * sMag;
        x += (dx / dist) * pull;
        z += (dz / dist) * pull;
      }
    }
    const b = defaultBounds();
    return { x: clamp(x, b.xMin, b.xMax), z: clamp(z, b.zMin, b.zMax) };
  }

  /** The court stance nearest P that the play area allows. */
  function reachableStance(world, P) {
    return courtFor(world, roomTargetFor(world, P, true), true);
  }

  function roomTargetFor(world, P, forPlan = false) {
    const { cfg, home, m, sMag } = locoOf(world, forPlan);
    let rx = P.x, rz = P.z;
    for (let i = 0; i < 8 && sMag > 0; i++) {
      const dx = m.x - rx, dz = m.z - rz;
      const dist = Math.hypot(dx, dz);
      if (dist < 1e-6) break;
      const pull = Math.min(dist, MAGNET_MAX_PULL) * sMag;
      rx = P.x - (dx / dist) * pull;
      rz = P.z - (dz / dist) * pull;
    }
    const E = ROOM_ENVELOPE;
    return {
      x: room0.x + clamp(softDeadzoneInverse((rx - home.x) / cfg.gainLateral, cfg.deadzone, cfg.knee), -E.side, E.side),
      d: room0.d + clamp(softDeadzoneInverse((rz - home.z) / cfg.gainDepth, cfg.deadzone, cfg.knee), -E.front, E.back),
    };
  }

  function moveRoom(target, dt) {
    for (const key of ['x', 'd']) {
      const err = target[key] - room[key];
      const vDes = clamp(err * 7, -ROOM_SPEED, ROOM_SPEED);
      const dv = clamp(vDes - roomVel[key], -ROOM_ACCEL * dt, ROOM_ACCEL * dt);
      roomVel[key] += dv;
      room[key] += roomVel[key] * dt;
    }
  }

  // ---- main ----------------------------------------------------------------------

  function maintainPlan(world, T) {
    const ball = world.ball;
    const live = ball && !ball.atRest && !ball.outside;
    const mine = live && (world.flight.team !== 0 || world.flight.by === 'drop');
    const key = live ? `${ball.id}:${world.flight.startT}` : null;
    if (plan && !plan.none && T > plan.tr + ARC_OUT) {
      // Swing finished: recover from where the follow-through ended.
      st.swings++;
      st.recoverFrom = { t: plan.tr + ARC_OUT, pose: arcPose(plan, plan.tr + ARC_OUT, { grip: v3(), axis: v3(), normal: v3() }) };
      plan = null;
    }
    if (!mine) {
      if (plan && plan.none) plan = null;
      if (plan && plan.key !== key && T < plan.tr - ARC_IN) plan = null; // ball taken away before the swing
      return;
    }
    if (plan && plan.key === key && plan.none) {
      if (T - plan.made > 0.2) plan = makePlan(world, T, key, false);
      return;
    }
    if (!plan || plan.key !== key) {
      if (plan && T >= plan.tr - ARC_IN && T <= plan.tr + ARC_OUT) return; // mid-swing on the previous ball
      const prev = currentPose(world, T);
      plan = makePlan(world, T, key, false);
      if (!plan.none) {
        plan.prepFrom = prev;
        plan.prepStart = T;
      }
      lastRecheck = T;
      return;
    }
    if (!plan.committed && T >= plan.tr - COMMIT_LEAD) {
      const old = plan;
      const fresh = makePlan(world, T, key, true);
      if (!fresh.none && Math.abs(fresh.tr - old.tr) < 0.25) {
        fresh.prepFrom = old.prepFrom;
        fresh.prepStart = old.prepStart;
        plan = fresh;
      } else old.committed = true;
      return;
    }
    if (!plan.committed && T - lastRecheck > 0.15) {
      lastRecheck = T;
      const pred = predict(ball, world.court, { maxTime: Math.max(0.05, plan.t - world.time + 0.02) });
      const s = pred.samples[pred.samples.length - 1];
      const ht = world.player.homeTarget;
      const homeMoved = ht && plan.homeT && Math.hypot(ht.x - plan.homeT.x, ht.z - plan.homeT.z) > 0.3;
      if (s.pos.distanceTo(plan.C) > 0.2 || homeMoved) {
        const prev = currentPose(world, T);
        const fresh = makePlan(world, T, key, false);
        if (!fresh.none) {
          fresh.prepFrom = prev;
          fresh.prepStart = T;
        }
        plan = fresh;
      }
    }
  }

  function currentPose(world, T) {
    if (cur.valid) return { grip: cur.grip.clone(), axis: cur.axis.clone(), normal: cur.normal.clone() };
    const pp = world.player.pos;
    return readyPoseCourt(pp.x, pp.z, { grip: v3(), axis: v3(), normal: v3() });
  }

  const outPose = { grip: v3(), axis: v3(), normal: v3() };

  /** Learns from the player's last shot: realised physical launch vs the planned one. */
  function learn(world) {
    const shots = world.shots;
    for (; seenShots < shots.length; seenShots++) {
      const s = shots[seenShots];
      if (s.by !== 'player' || !s.physVel) continue;
      const p = plan && !plan.none ? plan : st.lastPlan;
      if (!p || Math.abs(s.t + (world.settings.latency ?? 0) - p.tr) > 0.12) continue;
      const want = p.vWanted, got = s.physVel;
      const el = (v) => Math.atan2(v.y, Math.hypot(v.x, v.z));
      const az = (v) => Math.atan2(v.x, -v.z);
      const a = adapt[p.adaptKey] || (adapt[p.adaptKey] = { el: 0, az: 0, pace: 1, n: 0 });
      const g = a.n < 2 ? 0.6 : 0.35;
      a.el = clamp(a.el + g * (el(got) - el(want)), -0.25, 0.25);
      a.az = clamp(a.az + g * (az(got) - az(want)), -0.25, 0.25);
      a.pace = clamp(a.pace * (1 + g * (got.length() / want.length() - 1)), 0.7, 1.4);
      a.n++;
    }
  }

  /** Synthetic body for capture time T (sim seconds). */
  function update(world, T = world.time) {
    const dt = lastT === null ? 1 / 30 : clamp(T - lastT, 1e-3, 0.25);
    lastT = T;
    learn(world);
    maintainPlan(world, T);

    // Movement.
    const p = plan && !plan.none ? plan : null;
    const goal = p ? p.stance : world.player.home;
    moveRoom(roomTargetFor(world, goal), dt);

    // Posture: crouch and trunk turn ramp in during the preparation.
    let crouch = 0, turn = 0;
    if (p) {
      const ramp = smoothstep(p.tr - ARC_IN - 0.45, p.tr - ARC_IN, T) * (1 - smoothstep(p.tr + ARC_OUT, p.tr + ARC_OUT + RECOVER, T));
      crouch = p.crouch * ramp;
      turn = p.turn * ramp;
    }
    st.crouch = crouch;
    st.turn = turn;

    const body = standingBody({ height, room: { x: room.x, d: room.d }, handed });
    if (turn) turnBody(body, turn);
    if (crouch > 1e-4) crouchBody(body, crouch);

    // Racket -> hand target in U with the player's current court position.
    racketPose(world, T, outPose);
    cur.grip.copy(outPose.grip);
    cur.axis.copy(outPose.axis);
    cur.normal.copy(outPose.normal);
    cur.valid = true;
    const pp = world.player.pos;
    const gU = v3(outPose.grip.x - pp.x, outPose.grip.y, pp.z - outPose.grip.z);
    const aU = v3(outPose.axis.x, outPose.axis.y, -outPose.axis.z);
    const nU = v3(outPose.normal.x, outPose.normal.y, -outPose.normal.z);
    const pole = p && (p.fam === 'oh' || p.fam === 'sm') ? v3(dom * 1.0, 0.25, -0.2) : null;
    const res = setHandTarget(body, domSide, gU, aU, nU, pole ? { pole } : {});
    st.reached = res.reached;
    if (p && Math.abs(T - p.tr) < 0.1) st.maxGripError = Math.max(st.maxGripError, res.error);
    poseArm(body, offSide, { shoulderAngles: { flex: 35, abd: 25, rot: 0 }, elbowFlex: 80, wristRot: 0 });
    return body;
  }

  function reset() {
    plan = null;
    lastT = null;
    room.x = room0.x;
    room.d = room0.d;
    roomVel.x = roomVel.d = 0;
    cur.valid = false;
  }

  return {
    update,
    reset,
    get plan() {
      return plan;
    },
    get state() {
      return { ...st, room: { ...room } };
    },
  };
}


