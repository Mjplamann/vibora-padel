// Procedural animation of the skinned athletes (skinnedHuman.js). Two layers:
//   createPoseSolver(human)  — model-space pose targets (pelvis, spine twist and lean, look-at,
//       wrist / hand frames with elbow poles, feet) -> bone rotations with two-bone IK; shared by
//       the AI actors and the player's own first-person body (fpBody.js).
//   createActorAnimator(human) — drives the solver from an actor state (game/coach.js shape: pos,
//       vel, facing, stroke, swingPhase, holding) with the stroke library, foot planting
//       (stepper.js), split-steps / celebrations / high fives (director.js cues), the serve routine
//       with a ball, looking at the ball, and an optional real racket path (instant replay).
// No allocation per frame: every temporary is preallocated here.
import * as THREE from 'three';
import { BONES, LIMBS } from '../humanModel.js';
import { racketInHand, cradleInRacketMatrix } from '../handPose.js';
import { STROKES, sampleStroke, strokeSample, readySample, strokeFamily, STANCES } from './strokes.js';
import { createStepper } from './stepper.js';
import { envelope } from './director.js';

const DEG = Math.PI / 180;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrapPi = (a) => {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
};
const B = Object.fromEntries(BONES.map((b, i) => [b.name, i]));
const SIDES = Object.freeze(['R', 'L']);
const SCALARS = Object.freeze(['turn', 'hip', 'crouch', 'lean', 'jump']);

// ------------------------------------------------------------------ pose solver

/**
 * @param {ReturnType<import('../skinnedHuman.js').createSkinnedHuman>} human
 */
export function createPoseSolver(human) {
  const n = BONES.length;
  const parent = BONES.map((b) => b.parent);
  const offset = BONES.map((b) => {
    const p = b.parent >= 0 ? BONES[b.parent].pos : [0, 0, 0];
    return new THREE.Vector3(b.pos[0] - p[0], b.pos[1] - p[1], b.pos[2] - p[2]);
  });
  const mPos = BONES.map(() => new THREE.Vector3());
  const mQuat = BONES.map(() => new THREE.Quaternion());
  const boneObj = BONES.map((b) => human.bones[b.name]);

  // Bind bases for aimed bones: Y = direction to the child joint, Z = forward-ish secondary.
  const bindInv = BONES.map(() => new THREE.Quaternion());
  const m4 = new THREE.Matrix4();
  const tx = new THREE.Vector3(), ty = new THREE.Vector3(), tz = new THREE.Vector3();
  function basisQuat(y, zHint, out) {
    ty.copy(y).normalize();
    tz.copy(zHint).addScaledVector(ty, -tz.dot(ty));
    if (tz.lengthSq() < 1e-10) tz.set(0, 0, 1).addScaledVector(ty, -ty.z);
    if (tz.lengthSq() < 1e-10) tz.set(1, 0, 0);
    tz.normalize();
    tx.crossVectors(ty, tz);
    m4.makeBasis(tx, ty, tz);
    return out.setFromRotationMatrix(m4);
  }
  const FWD = new THREE.Vector3(0, 0, 1);
  const childDir = (name, child) => {
    const a = BONES[B[name]].pos, b = BONES[B[child]].pos;
    return new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]).normalize();
  };
  const AIMED = {
    upperArmR: childDir('upperArmR', 'foreArmR'), foreArmR: childDir('foreArmR', 'handR'),
    upperArmL: childDir('upperArmL', 'foreArmL'), foreArmL: childDir('foreArmL', 'handL'),
    thighR: childDir('thighR', 'shinR'), shinR: childDir('shinR', 'footR'),
    thighL: childDir('thighL', 'shinL'), shinL: childDir('shinL', 'footL'),
  };
  for (const [name, d] of Object.entries(AIMED)) {
    basisQuat(d, FWD, bindInv[B[name]]);
    bindInv[B[name]].invert();
  }
  const handBindInv = { R: human.handQuat.R.clone().invert(), L: human.handQuat.L.clone().invert() };

  /** Pose targets (model space, metres of the 1.80 m model; the rig scale maps to the person). */
  const T = {
    hipsPos: new THREE.Vector3(0, LIMBS.hipY, 0),
    hips: new THREE.Euler(0, 0, 0, 'YXZ'), // pitch (lean), yaw, roll
    spine: new THREE.Euler(0, 0, 0, 'YXZ'),
    chest: new THREE.Euler(0, 0, 0, 'YXZ'),
    look: new THREE.Vector3(0, 1.6, 5), // head look-at point
    lookWeight: 1,
    headTilt: 0, // extra head pitch (frustration)
    clavRaise: { R: 0, L: 0 },
    arm: {
      R: { wrist: new THREE.Vector3(), hand: new THREE.Quaternion(), pole: new THREE.Vector3(), on: true },
      L: { wrist: new THREE.Vector3(), hand: new THREE.Quaternion(), pole: new THREE.Vector3(), on: true },
    },
    leg: {
      R: { ankle: new THREE.Vector3(), yaw: 0, pitch: 0, pole: new THREE.Vector3(0, 0, 1) },
      L: { ankle: new THREE.Vector3(), yaw: 0, pitch: 0, pole: new THREE.Vector3(0, 0, 1) },
    },
  };

  const qA = new THREE.Quaternion(), qB = new THREE.Quaternion(), qC = new THREE.Quaternion();
  const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3(), vD = new THREE.Vector3(), vE = new THREE.Vector3(), vF = new THREE.Vector3();
  const eul = new THREE.Euler(0, 0, 0, 'YXZ');

  function fk(i) {
    const p = parent[i];
    if (p < 0) {
      mPos[i].copy(offset[i]);
      return;
    }
    mPos[i].copy(offset[i]).applyQuaternion(mQuat[p]).add(mPos[p]);
  }
  function inherit(i) {
    mQuat[i].copy(mQuat[parent[i]]);
    fk(i);
  }
  /** Bone i (aimed) so its child direction is `dir` and its forward secondary is `sec`. */
  function aim(i, dir, sec) {
    basisQuat(dir, sec, qA);
    mQuat[i].multiplyQuaternions(qA, bindInv[i]);
  }

  /** Two-bone IK: elbow / knee position for root S, target T, lengths and pole direction. */
  function twoBone(S, Tg, l1, l2, pole, out) {
    const d = vA.subVectors(Tg, S);
    const dist = clamp(d.length(), Math.abs(l1 - l2) + 1e-3, l1 + l2 - 1e-3);
    d.normalize();
    const a = Math.acos(clamp((l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist), -1, 1));
    const perp = vB.copy(pole).addScaledVector(d, -pole.dot(d));
    if (perp.lengthSq() < 1e-8) perp.set(0, 0, 1).addScaledVector(d, -d.z);
    perp.normalize();
    return out.copy(S).addScaledVector(d, Math.cos(a) * l1).addScaledVector(perp, Math.sin(a) * l1);
  }

  const elbow = new THREE.Vector3(), knee = new THREE.Vector3(), wristReach = new THREE.Vector3();
  const thumb = new THREE.Vector3();

  function solveArm(side) {
    const A = T.arm[side];
    const u = B[`upperArm${side}`], f = B[`foreArm${side}`], h = B[`hand${side}`];
    if (!A.on) {
      inherit(u); inherit(f); inherit(h);
      return;
    }
    const S = mPos[u];
    twoBone(S, A.wrist, LIMBS.upperArm, LIMBS.foreArm, A.pole, elbow);
    // Upper arm: toward the elbow; secondary = the side the forearm bends to.
    vC.subVectors(elbow, S);
    vD.subVectors(A.wrist, elbow);
    vE.copy(vD).addScaledVector(vC, -vD.dot(vC) / Math.max(1e-9, vC.lengthSq()));
    if (vE.lengthSq() < 1e-6) vE.copy(A.pole);
    aim(u, vC, vE);
    fk(f);
    // Forearm: toward the (reachable) wrist; twist follows the hand's thumb side.
    wristReach.copy(A.wrist).sub(mPos[f]);
    const l = wristReach.length();
    if (l > 1e-6) wristReach.multiplyScalar(LIMBS.foreArm / l);
    else wristReach.set(0, -LIMBS.foreArm, 0);
    thumb.set(1, 0, 0).applyQuaternion(A.hand);
    if (side === 'L') thumb.negate();
    aim(f, wristReach, thumb);
    fk(h);
    mQuat[h].multiplyQuaternions(A.hand, handBindInv[side]);
  }

  function solveLeg(side) {
    const L = T.leg[side];
    const th = B[`thigh${side}`], sh = B[`shin${side}`], ft = B[`foot${side}`], to = B[`toe${side}`];
    fk(th);
    const H = mPos[th];
    twoBone(H, L.ankle, LIMBS.thigh, LIMBS.shin, L.pole, knee);
    vC.subVectors(knee, H);
    aim(th, vC, L.pole);
    fk(sh);
    vD.subVectors(L.ankle, knee);
    aim(sh, vD, L.pole);
    fk(ft);
    eul.set(L.pitch, L.yaw, 0, 'YXZ');
    mQuat[ft].setFromEuler(eul);
    fk(to);
    eul.set(-Math.max(0, L.pitch) * 0.9, 0, 0, 'YXZ');
    mQuat[to].copy(mQuat[ft]).multiply(qB.setFromEuler(eul));
  }

  const headDir = new THREE.Vector3();
  function solve() {
    // Root, pelvis, spine, chest.
    mQuat[0].identity();
    mPos[0].set(0, 0, 0);
    mPos[B.hips].copy(T.hipsPos);
    mQuat[B.hips].setFromEuler(T.hips);
    mQuat[B.spine].setFromEuler(T.spine);
    fk(B.spine);
    mQuat[B.chest].setFromEuler(T.chest);
    fk(B.chest);
    // Neck and head look at T.look (yaw / pitch limited relative to the chest).
    fk(B.neck);
    headDir.subVectors(T.look, mPos[B.neck]);
    let yaw = Math.atan2(headDir.x, headDir.z);
    let pitch = Math.atan2(-headDir.y + 0.1, Math.hypot(headDir.x, headDir.z));
    const cy = T.chest.y;
    yaw = cy + clamp(wrapPi(yaw - cy), -1.3, 1.3) * T.lookWeight;
    pitch = clamp(pitch, -0.6, 0.75) * T.lookWeight + T.headTilt;
    eul.set(T.chest.x * 0.4 + pitch * 0.35, cy + wrapPi(yaw - cy) * 0.4, T.chest.z * 0.5, 'YXZ');
    mQuat[B.neck].setFromEuler(eul);
    fk(B.head);
    eul.set(pitch, yaw, 0, 'YXZ');
    mQuat[B.head].setFromEuler(eul);
    // Clavicles: shrug as the arm rises, and reach (protract) toward a wrist target beyond the
    // arm's length so wide strokes still put the hand on the racket.
    for (const side of SIDES) {
      const c = B[`clavicle${side}`], u = B[`upperArm${side}`];
      fk(c);
      const sgn = side === 'R' ? 1 : -1;
      qB.setFromAxisAngle(FWD, sgn * T.clavRaise[side] * 0.35);
      mQuat[c].multiplyQuaternions(mQuat[B.chest], qB);
      fk(u);
      const A = T.arm[side];
      if (A.on) {
        vC.subVectors(A.wrist, mPos[u]);
        const reach = (LIMBS.upperArm + LIMBS.foreArm) * 0.985;
        const excess = vC.length() - reach;
        if (excess > 0) {
          vD.subVectors(mPos[u], mPos[c]); // clavicle -> shoulder
          const cl = vD.length();
          vE.copy(vD).addScaledVector(vC.normalize(), Math.min(excess, 0.075)).normalize().multiplyScalar(cl);
          qB.setFromUnitVectors(vD.normalize(), vF.copy(vE).normalize());
          mQuat[c].premultiply(qB);
          fk(u);
        }
      }
    }
    solveArm('R');
    solveArm('L');
    solveLeg('R');
    solveLeg('L');
    // Write local rotations (and the pelvis position) to the bones.
    for (let i = 0; i < n; i++) {
      const b = boneObj[i];
      const p = parent[i];
      if (p < 0) {
        b.quaternion.identity();
        continue;
      }
      qC.copy(mQuat[p]).invert().multiply(mQuat[i]);
      if (Number.isFinite(qC.x) && Number.isFinite(qC.w)) b.quaternion.copy(qC);
    }
    const hp = mPos[B.hips];
    if (Number.isFinite(hp.x) && Number.isFinite(hp.y) && Number.isFinite(hp.z)) boneObj[B.hips].position.copy(hp);
  }

  // World <-> model conversions for the human's current root transform.
  const invQ = new THREE.Quaternion();
  const rootPos = new THREE.Vector3();
  function setRoot(x, z, yaw) {
    human.root.position.set(x, 0, z);
    human.root.quaternion.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, yaw);
    rootPos.set(x, 0, z);
    invQ.copy(human.root.quaternion).invert();
  }
  function toModel(p, out) {
    return out.set(p.x - rootPos.x, p.y - rootPos.y, p.z - rootPos.z).applyQuaternion(invQ).multiplyScalar(1 / human.scale);
  }
  function dirToModel(d, out) {
    return out.set(d.x, d.y, d.z).applyQuaternion(invQ);
  }
  function modelToWorld(p, out) {
    return out.copy(p).multiplyScalar(human.scale).applyQuaternion(human.root.quaternion).add(rootPos);
  }

  return { T, solve, mPos, mQuat, B, setRoot, toModel, dirToModel, modelToWorld, basisQuat, fk };
}

// ------------------------------------------------------------------ actor animator

const _rih = { pos: new THREE.Vector3(), quat: new THREE.Quaternion() };

/**
 * @param human createSkinnedHuman(...)
 * @returns {{ update(state, dt, ctx), solver, stepper, reset(), ball: THREE.Mesh }}
 * ctx: { time, ball: {x,y,z}|null (look at), cue: director cue|null, partner: {x,z}|null,
 *        racket: {grip, axis, normal}|null (world; the real racket path, replay), lookAt }
 */
export function createActorAnimator(human) {
  const solver = createPoseSolver(human);
  const { T } = solver;
  const stepper = createStepper();
  let hand = human.handed;
  let mir = hand === 'left' ? -1 : 1;
  let rih = racketInHand(hand, _rih);
  let cradle = cradleInRacketMatrix(hand);

  const tgt = strokeSample();
  const cur = strokeSample();
  readySample(cur);
  let curOffW = 1; // off hand cradle weight
  let yawS = null;
  let runTurn = 0;
  let time = 0;
  let splitDone = -Infinity;
  let initialized = false;
  let lastStroke = null, lastPhase = 0, lateStart = -Infinity;

  // Ball for the serve routine.
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.033, 14, 10), new THREE.MeshStandardMaterial({ color: '#d8f03c', roughness: 0.75, emissive: '#2a3005' }));
  ball.visible = false;
  ball.castShadow = true;
  ball.name = 'serve-ball';
  human.rig.add(ball);

  // Scratch.
  const gM = new THREE.Vector3(), aM = new THREE.Vector3(), nM = new THREE.Vector3(), offM = new THREE.Vector3();
  const qR = new THREE.Quaternion(), qHand = new THREE.Quaternion(), qOff = new THREE.Quaternion(), qFree = new THREE.Quaternion();
  const mR = new THREE.Matrix4(), mOff = new THREE.Matrix4();
  const vT = new THREE.Vector3(), vU = new THREE.Vector3(), vS = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
  const wGrip = new THREE.Vector3(), wAxis = new THREE.Vector3(), wNorm = new THREE.Vector3();
  const pWrist = new THREE.Vector3();
  const stance = { R: [0, 0], L: [0, 0] };
  const footYaw = { R: 0, L: 0 };
  const stepIn = { x: 0, z: 0, vx: 0, vz: 0, yaw: 0, stance, footYaw, hop: false, jump: 0 };
  const lookW = new THREE.Vector3();
  const bodyArr = [0, 0, 0];

  const toM = (arr, out) => out.set(-mir * arr[0], arr[1], arr[2]);

  function setStance(name) {
    const s = STANCES[name] || STANCES.ready;
    // Mirror for left-handers: the racket-side foot is the left one.
    if (mir > 0) {
      stance.R[0] = s.R[0]; stance.R[1] = s.R[1]; stance.L[0] = s.L[0]; stance.L[1] = s.L[1];
    } else {
      stance.L[0] = -s.R[0]; stance.L[1] = s.R[1]; stance.R[0] = -s.L[0]; stance.R[1] = s.L[1];
    }
  }

  function blendToward(o, k) {
    for (let j = 0; j < 3; j++) {
      cur.g[j] += (o.g[j] - cur.g[j]) * k;
      cur.a[j] += (o.a[j] - cur.a[j]) * k;
      cur.n[j] += (o.n[j] - cur.n[j]) * k;
      cur.off[j] += (o.off[j] - cur.off[j]) * k;
    }
    for (let i = 0; i < SCALARS.length; i++) { const c = SCALARS[i]; cur[c] += (o[c] - cur[c]) * k; }
  }

  /** Gesture overlays on the target sample (weights 0..1). */
  function toward(arr, x, y, z, w) {
    arr[0] += (x - arr[0]) * w; arr[1] += (y - arr[1]) * w; arr[2] += (z - arr[2]) * w;
  }
  function gesture(kind, w, t) {
    if (w <= 0) return;
    if (kind === 'celebrate') {
      const pump = Math.max(0, Math.sin(t * Math.PI * 2 * 2.1));
      toward(tgt.g, 0.26, 1.62 + 0.06 * pump, 0.26, w);
      toward(tgt.a, 0.1, 0.98, 0.15, w);
      toward(tgt.n, -0.95, 0.0, 0.25, w);
      toward(tgt.off, -0.18, 1.18 + 0.2 * pump, 0.3, w);
      tgt.offThroat *= 1 - w;
      tgt.turn *= 1 - w; tgt.hip *= 1 - w;
      tgt.crouch += (0.35 - tgt.crouch) * w;
      tgt.lean += (0.02 - tgt.lean) * w;
    } else if (kind === 'frustrate') {
      toward(tgt.g, 0.26, 0.74, 0.14, w);
      toward(tgt.a, 0.25, -0.55, 0.6, w);
      toward(tgt.n, -0.95, 0.1, 0.2, w);
      toward(tgt.off, -0.19, 1.0, -0.03, w);
      tgt.offThroat *= 1 - w;
      tgt.turn *= 1 - w; tgt.hip *= 1 - w;
      tgt.crouch += (0.1 - tgt.crouch) * w;
      tgt.lean += (0.05 - tgt.lean) * w;
    }
  }

  function reset() {
    initialized = false;
  }

  /**
   * One frame. state: actor state (pos, vel, facing, stroke, swingPhase, holding, handed).
   */
  function update(state, dt = 1 / 60, ctx = {}) {
    if (!state || !state.pos) return;
    dt = clamp(Number.isFinite(dt) ? dt : 1 / 60, 0, 0.1);
    time = Number.isFinite(ctx.time) ? ctx.time : time + dt;
    if (state.handed && state.handed !== hand) {
      hand = state.handed === 'left' ? 'left' : 'right';
      mir = hand === 'left' ? -1 : 1;
      rih = racketInHand(hand, _rih);
      cradle = cradleInRacketMatrix(hand);
    }
    const facing = Number.isFinite(state.facing) ? state.facing : 0;
    if (yawS === null || !initialized) yawS = facing;
    yawS += wrapPi(facing - yawS) * (1 - Math.exp(-10 * dt));
    const px = state.pos.x, pz = state.pos.z;
    const vx = state.vel ? state.vel.x || 0 : 0, vz = state.vel ? state.vel.z || 0 : 0;
    const speed = Math.hypot(vx, vz);
    const fx = Math.sin(yawS), fz = Math.cos(yawS);
    const vF = vx * fx + vz * fz, vR = vx * -fz + vz * fx;
    const holding = state.holding || 'ready';
    const keys = holding === 'swing' && state.stroke ? STROKES[state.stroke] : null;
    const cue = ctx.cue || null;

    // ---- upper body target
    let lam = 12;
    let phase = state.swingPhase || 0;
    let stroke = keys ? state.stroke : null;
    // Pre-serve routine (cue.serve): bounce the ball while the serve is awaited; with the serve
    // time known (coach state.serveAt) drop it 0.95 s before, let it bounce, and play the swing
    // into the contact.
    let servePrep = false;
    let serveT = null;
    if (!keys && cue && cue.serve) {
      const at = cue.serve.at;
      serveT = Number.isFinite(at) ? at - time : null;
      if (serveT !== null && serveT <= 0.6 && serveT > -0.05) {
        stroke = 'serve';
        phase = clamp(0.6 - serveT, 0, 0.6);
      } else if (serveT !== null && serveT <= 0.95 && serveT > 0.6) {
        stroke = 'serve';
        phase = 0;
      } else servePrep = true;
    }
    if (stroke && STROKES[stroke]) {
      sampleStroke(STROKES[stroke], clamp(phase, 0, 1), tgt);
      // A swing that starts late (hand feeds and AI serves begin at the contact phase) sweeps in
      // over ~0.2 s instead of snapping to the contact pose.
      if (stroke !== lastStroke || phase < lastPhase - 0.05) lateStart = phase > 0.25 ? time : -Infinity;
      lam = time - lateStart < 0.22 ? 16 : 40;
    } else {
      readySample(tgt);
      if (speed > 0.6) {
        // Running: racket carried up at the side, the off arm swings with the stride.
        const r = clamp((speed - 0.6) / 2.4, 0, 1);
        const ft = stepper.feet;
        const sw = (!ft.R.planted ? Math.sin(Math.PI * ft.R.u) : 0) - (!ft.L.planted ? Math.sin(Math.PI * ft.L.u) : 0);
        tgt.g[0] += (0.27 - tgt.g[0]) * r; tgt.g[1] += (1.02 - tgt.g[1]) * r; tgt.g[2] += (0.2 + 0.08 * sw * mir - tgt.g[2]) * r;
        tgt.a[0] += (0.05 - tgt.a[0]) * r; tgt.a[1] += (0.85 - tgt.a[1]) * r; tgt.a[2] += (0.5 - tgt.a[2]) * r;
        tgt.n[0] += (-0.95 - tgt.n[0]) * r; tgt.n[1] += (0 - tgt.n[1]) * r; tgt.n[2] += (0.1 - tgt.n[2]) * r;
        tgt.offThroat = 1 - r;
        tgt.off[0] = -0.22; tgt.off[1] = 1.0 + 0.06 * Math.abs(sw); tgt.off[2] = 0.08 - 0.26 * sw * mir;
        tgt.crouch += (0.45 - tgt.crouch) * r;
        tgt.lean += (0.1 + 0.1 * clamp(vF / 6, 0, 1) - tgt.lean) * r;
      } else if (holding === 'recover') {
        lam = 8;
      }
      if (servePrep) {
        // Bouncing the ball before the serve: side-on, racket back, the free hand dribbling.
        const T0 = 0.85;
        const u = (time % T0) / T0;
        tgt.g[0] = 0.32; tgt.g[1] = 0.98; tgt.g[2] = -0.05;
        tgt.a[0] = 0.35; tgt.a[1] = 0.75; tgt.a[2] = -0.4;
        tgt.n[0] = -0.6; tgt.n[1] = 0.0; tgt.n[2] = -0.8;
        tgt.offThroat = 0;
        tgt.off[0] = -0.04; tgt.off[1] = 0.93 - 0.08 * Math.sin(Math.PI * Math.min(1, u * 4)); tgt.off[2] = 0.46;
        tgt.turn = 30; tgt.hip = 18; tgt.crouch = 0.3; tgt.lean = 0.18;
      }
      // Reactions between points.
      if (cue && cue.react) gesture(cue.react.kind, envelope(time, cue.react.t0, cue.react.dur), time - cue.react.t0);
    }
    // Split-step: a little deeper on the landing.
    let hop = false;
    if (cue && cue.split && !stroke) {
      if (cue.split.t0 > splitDone && time >= cue.split.t0 && speed < 3.5) {
        hop = true;
        splitDone = cue.split.t0;
      }
      const land = envelope(time, cue.split.tLand - 0.05, 0.3, 0.05, 0.2);
      tgt.crouch = Math.min(1, tgt.crouch + 0.25 * land);
    }

    lastStroke = stroke;
    lastPhase = stroke ? phase : 0;
    const k = initialized ? 1 - Math.exp(-lam * dt) : 1;
    blendToward(tgt, k);
    curOffW += (tgt.offThroat - curOffW) * (initialized ? 1 - Math.exp(-14 * dt) : 1);
    // Racket axis / normal stay unit and orthogonal.
    normalizeArr(cur.a);
    orthoArr(cur.n, cur.a);

    // ---- lower body: run orientation, stance, foot planting
    // Long sideways / backward runs turn the hips toward the run (crossover), the chest keeps
    // facing the ball.
    const runDir = speed > 0.3 ? Math.atan2(vx, vz) : yawS;
    let wantTurn = 0;
    if (!stroke && speed > 2.6) {
      const rel = wrapPi(runDir - yawS);
      wantTurn = Math.abs(rel) > 2.4 ? 0 : clamp(rel, -1.2, 1.2) * clamp((speed - 2.6) / 1.4, 0, 1);
      if (Math.abs(rel) > 2.4) wantTurn = clamp(wrapPi(rel - Math.sign(rel) * Math.PI), -0.6, 0.6); // backpedal
    }
    runTurn += (wantTurn - runTurn) * (1 - Math.exp(-6 * dt));
    const fam = stroke ? strokeFamily(stroke) : servePrep ? 'serve' : speed > 2.6 ? 'run' : cue && cue.split && time < cue.split.tLand + 0.25 ? 'split' : 'ready';
    setStance(fam);
    footYaw.R = (mir > 0 ? -0.18 : 0.12) - (fam === 'fh' || fam === 'oh' || fam === 'serve' ? 0.5 * mir : 0) + (fam === 'bh' ? 0.4 * mir : 0);
    footYaw.L = (mir > 0 ? 0.12 : -0.18) - (fam === 'bh' ? 0.5 * -mir : 0);
    if (fam === 'ready' || fam === 'split' || fam === 'run') { footYaw.R = -0.12; footYaw.L = 0.12; }
    if (!initialized) {
      stepper.reset(px, pz, yawS + runTurn, stance);
    }
    stepIn.x = px; stepIn.z = pz; stepIn.vx = vx; stepIn.vz = vz; stepIn.yaw = yawS + runTurn;
    stepIn.hop = hop; stepIn.jump = cur.jump;
    const st = stepper.update(dt, stepIn);

    // ---- solve
    solver.setRoot(px, pz, yawS);
    const crouchDrop = cur.crouch * 0.13 + Math.max(0, st.stride - 0.55) * 0.12;
    T.hipsPos.set(-st.sway * 0.5, LIMBS.hipY - crouchDrop + st.bob + st.hopY + cur.jump, -0.02 - cur.lean * 0.05);
    const chestYaw = -cur.turn * DEG * mir;
    const hipYaw = -cur.hip * DEG * mir + runTurn;
    const lean = cur.lean + cur.crouch * 0.1;
    const roll = -vR * 0.025 * (fam === 'ready' || fam === 'split' ? 1 : 0.3);
    T.hips.set(lean * 0.35, hipYaw, roll * 0.6 - st.sway * 1.5, 'YXZ');
    T.spine.set(lean * 0.7, hipYaw + (chestYaw - hipYaw) * 0.5, roll * 0.3, 'YXZ');
    T.chest.set(lean, chestYaw + runTurn * 0.45, roll * 0.15, 'YXZ');
    T.clavRaise.R = 0; T.clavRaise.L = 0;

    // Racket frame (model space): the stroke target, or the real recorded racket (replay).
    toM(cur.g, gM);
    gM.y += cur.jump;
    toM(cur.a, aM);
    toM(cur.n, nM);
    if (ctx.racket && ctx.racket.grip) {
      wGrip.set(ctx.racket.grip.x, ctx.racket.grip.y, ctx.racket.grip.z);
      solver.toModel(wGrip, gM);
      solver.dirToModel(ctx.racket.axis, wAxis);
      solver.dirToModel(ctx.racket.normal, wNorm);
      aM.copy(wAxis).normalize();
      nM.copy(wNorm).addScaledVector(aM, -wNorm.dot(aM)).normalize();
    }
    solver.basisQuat(aM, nM, qR);
    // Hand canonical frame and wrist from the grip.
    const rs = mir > 0 ? 'R' : 'L', os = mir > 0 ? 'L' : 'R';
    qHand.multiplyQuaternions(qR, vQinv(rih.quat));
    pWrist.copy(rih.pos).applyQuaternion(qHand);
    T.arm[rs].wrist.copy(gM).sub(pWrist);
    T.arm[rs].hand.copy(qHand);
    // Elbow pole: down / out / back, swinging outward and forward for overheads.
    const over = clamp((T.arm[rs].wrist.y - 1.35) / 0.35, 0, 1);
    T.arm[rs].pole.set(-mir * (0.7 + 0.3 * over), -1 + 1.4 * over, -0.35 + 0.2 * over).normalize();
    T.clavRaise[rs] = over;

    // Off hand: cradle at the throat, or its own target (palm in, fingers forward-down).
    mR.compose(gM, qR, one);
    mOff.multiplyMatrices(mR, cradle);
    mOff.decompose(offM, qOff, vS);
    toM(cur.off, vT);
    // Free hand frame: fingers forward-down, palm toward the body's midline.
    vU.set(0, -0.35, 1).normalize();
    vS.set(-mir, 0.15, 0);
    solver.basisQuat(vU, vS, qFree);
    // The wrist sits ~7 cm behind the palm target along the fingers.
    vT.addScaledVector(vU, -0.07);
    offM.lerp(vT, 1 - curOffW);
    qOff.slerp(qFree, 1 - curOffW);
    // High five: the free hand meets the partner's halfway (or reaches toward them).
    if (cue && cue.five && ctx.partner && !stroke) {
      const w5 = envelope(time, cue.five.t0, cue.five.dur, 0.3, 0.4);
      if (w5 > 0) {
        vT.set(ctx.partner.x, 0, ctx.partner.z);
        solver.toModel(vT, vU);
        const d = Math.hypot(vU.x, vU.z);
        const reach = Math.min(0.55, d * 0.5);
        const dirx = d > 1e-3 ? vU.x / d : -mir, dirz = d > 1e-3 ? vU.z / d : 0;
        vT.set(dirx * reach - mir * 0.12, 1.58, dirz * reach + 0.08);
        vU.set(dirx * 0.3, 1, dirz * 0.3).normalize(); // fingers up
        vS.set(dirx, 0, dirz); // palm toward the partner
        solver.basisQuat(vU, vS, qFree);
        vT.addScaledVector(vU, -0.07);
        offM.lerp(vT, w5);
        qOff.slerp(qFree, w5);
        // Turn the chest toward the partner.
        const yawTo = Math.atan2(dirx, dirz);
        T.chest.y += wrapPi(yawTo - T.chest.y) * 0.45 * w5;
        T.spine.y += wrapPi(yawTo - T.spine.y) * 0.25 * w5;
        T.clavRaise[os] = Math.max(T.clavRaise[os], w5);
      }
    }
    T.arm[os].wrist.copy(offM);
    T.arm[os].hand.copy(qOff);
    const overO = clamp((offM.y - 1.35) / 0.35, 0, 1);
    T.arm[os].pole.set(mir * (0.7 + 0.2 * overO), -1 + 1.3 * overO, -0.4 + 0.3 * overO).normalize();
    T.clavRaise[os] = Math.max(T.clavRaise[os], overO);

    // Look at the ball (or ahead / at the partner).
    const look = ctx.lookAt || ctx.ball;
    T.headTilt = 0;
    if (look) {
      lookW.set(look.x, look.y, look.z);
      solver.toModel(lookW, T.look);
      T.lookWeight = 1;
    } else {
      T.look.set(Math.sin(T.chest.y) * 5, 1.4, Math.cos(T.chest.y) * 5);
      T.lookWeight = 0.6;
    }
    if (cue && cue.react && cue.react.kind === 'frustrate') {
      const wf = envelope(time, cue.react.t0, cue.react.dur);
      T.headTilt = 0.5 * wf;
      T.lookWeight *= 1 - wf * 0.8;
    } else if (cue && cue.react && cue.react.kind === 'celebrate') {
      const wc = envelope(time, cue.react.t0, cue.react.dur);
      T.headTilt = -0.2 * wc;
      T.lookWeight *= 1 - wc * 0.6;
    }

    // Feet (court -> model).
    for (const side of SIDES) {
      const f = stepper.feet[side];
      vT.set(f.x, 0, f.z);
      solver.toModel(vT, vU);
      const L = T.leg[side];
      const heel = Math.max(0, f.pitch) * 0.075;
      L.ankle.set(vU.x, LIMBS.ankleY + f.y / human.scale + heel + cur.jump * 0.85, vU.z);
      L.yaw = wrapPi(f.yaw - yawS);
      L.pitch = f.pitch;
      const sgn = side === 'R' ? -1 : 1;
      L.pole.set(Math.sin(L.yaw) + sgn * 0.12, 0, Math.cos(L.yaw)).normalize();
    }
    keepFeetReachable(T);
    solver.solve();

    // Serve routine ball: dribbled while waiting, then dropped 0.95 s before the contact.
    if (servePrep) {
      ball.visible = true;
      const u = (time % 0.85) / 0.85;
      ball.position.set(0.04 * mir, 0.035 + 0.88 * Math.abs(Math.cos(Math.PI * u)), 0.5);
    } else if (serveT !== null && serveT > 0 && serveT <= 0.95 && !keys) {
      ball.visible = true;
      const fall = 0.95 - serveT;
      let h;
      if (fall < 0.44) h = 0.95 - 4.9 * fall * fall;
      else {
        const tau = fall - 0.44;
        h = 0.035 + 3.66 * tau - 4.9 * tau * tau;
      }
      ball.position.set(0.04 * mir + 0.12 * mir * clamp(fall / 0.95, 0, 1), Math.max(0.035, h), 0.5);
    } else ball.visible = false;
    initialized = true;
  }

  const _qi = new THREE.Quaternion();
  function vQinv(q) {
    return _qi.copy(q).invert();
  }

  return {
    update,
    solver,
    stepper,
    reset,
    ball,
    get handed() { return hand; },
  };
}

function normalizeArr(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  v[0] /= l; v[1] /= l; v[2] /= l;
}
function orthoArr(nv, a) {
  const d = nv[0] * a[0] + nv[1] * a[1] + nv[2] * a[2];
  nv[0] -= a[0] * d; nv[1] -= a[1] * d; nv[2] -= a[2] * d;
  normalizeArr(nv);
}

/**
 * Lowers the pelvis (bends both knees) when a foot target is beyond the leg's reach from its hip
 * joint, so planted feet stay planted in wide stances and lunges (at most 0.22 m).
 */
export function keepFeetReachable(T) {
  const reach = (LIMBS.thigh + LIMBS.shin) * 0.985;
  let maxY = Infinity;
  for (const side of SIDES) {
    const a = T.leg[side].ankle;
    const hx = T.hipsPos.x + (side === 'R' ? -0.09 : 0.09), hz = T.hipsPos.z;
    const dh = Math.hypot(a.x - hx, a.z - hz);
    const vy = dh < reach ? Math.sqrt(reach * reach - dh * dh) : 0;
    maxY = Math.min(maxY, a.y + vy + 0.05);
  }
  const y0 = T.hipsPos.y;
  if (maxY < y0) T.hipsPos.y = Math.max(y0 - 0.22, maxY);
}

/** Converts a body-frame array to a model-space vector for a handedness (exported for tests). */
export function bodyToModel(arr, handed, out) {
  const mir = handed === 'left' ? -1 : 1;
  return out.set(-mir * arr[0], arr[1], arr[2]);
}
