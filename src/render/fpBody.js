// The player's own body in first person (presence): torso, shorts, legs and shoes under the
// camera like a good VR game, plus a full-body shadow on the court. One skinned athlete
// (skinnedHuman.js, mode 'fp') posed every frame:
//   upper body  from the tracked joints (player.bodyCourt): shoulder line -> chest yaw / roll,
//               shoulders over the pelvis -> lean and crouch, wrists / elbows -> arms (the shown,
//               predicted racket for the racket hand), face -> head;
//   lower body  procedural from the court movement (animation/stepper.js: planted feet, side
//               shuffles, split-steps as the opponent strikes, small jumps), so it works when the
//               camera only sees the upper body (standing close to the TV).
// The visible mesh draws no head and no arms (the first-person rig draws forearms and hands) and
// dissolves within ~0.3 m of the eye; a lower-detail copy that writes no colour casts the full-body
// shadow (head, arms and all) from the key lights. Browser-only.
import * as THREE from 'three';
import { createSkinnedHuman } from './skinnedHuman.js';
import { createPoseSolver, keepFeetReachable } from './animation/animator.js';
import { createStepper } from './animation/stepper.js';
import { STANCES } from './animation/strokes.js';
import { envelope } from './animation/director.js';
import { racketInHand } from './handPose.js';
import { LIMBS } from './humanModel.js';
import { isFiniteVec, frameOk } from './safeView.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const SIDES = Object.freeze(['R', 'L']);
/** Model-space distance from the pelvis (hips bone) to the shoulder midpoint. */
const TORSO = 1.445 - LIMBS.hipY;
/** Dissolve by height below the eye (m): gone within NEAR, solid from FAR down. */
export const FP_BODY_FADE = Object.freeze({ near: 0.14, far: 0.24 });
/** The chest front stays at least this far (m) behind the eye (VR-style), so looking down shows
 * the chest, belly, legs and shoes from the front-top instead of the top of the shoulders. */
export const FP_CHEST_BEHIND_EYE = 0.07;

/**
 * Poses a skinned athlete from a tracked player (court-frame joints in player.bodyCourt, the racket
 * pose, court position / velocity): the first-person body, and the player's body in instant
 * replays recorded with joints.
 * @returns {{ update(player, dt, o) -> boolean, stats, pose, setHanded(h) }}
 */
export function createTrackedPoser(human, { keepBehindEye = false } = {}) {
  let backShift = 0;
  let jShift = 0; // shift applied by J(): 0 for the torso stage, backShift afterwards
  const solver = createPoseSolver(human);
  const { T } = solver;
  const stepper = createStepper();
  const stats = { frames: 0, tracked: 0, hipsTracked: 0, splits: 0, hidden: 0 };

  let hand = human.handed;
  let rihD = racketInHand(hand);
  let init = false;
  let splitDone = -Infinity;
  let time = 0;
  let crouchS = 0;
  let leanS = 0.08;
  let jumpY = 0;
  let jumpV = 0;
  const YAW = Math.PI; // the player faces -z

  // Scratch.
  const sc = new THREE.Vector3(), sl = new THREE.Vector3(), sr = new THREE.Vector3(), hc = new THREE.Vector3();
  const hl = new THREE.Vector3(), hr = new THREE.Vector3(), up = new THREE.Vector3(), v = new THREE.Vector3(), w = new THREE.Vector3();
  const nose = new THREE.Vector3(), earC = new THREE.Vector3(), el = new THREE.Vector3();
  const qR = new THREE.Quaternion(), qI = new THREE.Quaternion(), qC = new THREE.Quaternion();
  const ax = new THREE.Vector3(), nm = new THREE.Vector3(), g = new THREE.Vector3();
  const stance = { R: [0.24, 0.02], L: [-0.24, 0.02] };
  const footYaw = { R: -0.12, L: 0.12 };
  const stepIn = { x: 0, z: 0, vx: 0, vz: 0, yaw: YAW, stance, footYaw, hop: false, jump: 0 };

  const J = (j, name, out) => {
    const p = j && j[name];
    if (!p || !isFiniteVec(p)) return null;
    solver.toModel(p, out);
    out.z -= jShift;
    return out;
  };

  /** Hand canonical frame from a racket-like pose {grip, axis, normal} (world) for `side`. */
  function handFromRacket(pose, rih, side) {
    solver.toModel(pose.grip, g);
    g.z -= jShift;
    solver.dirToModel(pose.axis, ax).normalize();
    solver.dirToModel(pose.normal, nm);
    nm.addScaledVector(ax, -nm.dot(ax)).normalize();
    solver.basisQuat(ax, nm, qR);
    qC.multiplyQuaternions(qR, qI.copy(rih.quat).invert());
    T.arm[side].hand.copy(qC);
    T.arm[side].wrist.copy(rih.pos).applyQuaternion(qC).negate().add(g);
  }

  /**
   * @param player world.player (or the stage's proxy with the shown racket / re-solved elbow)
   * @param dt display dt (s)
   * @param o { visible, racket: RacketPose|null (shown), time, cue: director cue|null }
   */
  function update(player, dt = 1 / 60, o = {}) {
    if (!player || !player.pos || !isFiniteVec(player.pos)) return false;
    dt = clamp(Number.isFinite(dt) ? dt : 1 / 60, 0, 0.1);
    time = Number.isFinite(o.time) ? o.time : time + dt;
    stats.frames++;
    if ((player.handed === 'left' || player.handed === 'right') && player.handed !== hand) setHanded(player.handed);
    const px = player.pos.x, pz = player.pos.z;
    const vx = player.vel ? player.vel.x || 0 : 0, vz = player.vel ? player.vel.z || 0 : 0;
    solver.setRoot(px, pz, YAW);
    const bc = player.bodyCourt;
    const j = bc && bc.joints;
    const rs = hand === 'left' ? 'L' : 'R', os = rs === 'R' ? 'L' : 'R';

    // ---- torso from the shoulders (and the hips when they are plausible)
    jShift = 0;
    const okS = J(j, 'shoulderL', sl) && J(j, 'shoulderR', sr);
    let chestYaw = 0, chestRoll = 0;
    if (okS) {
      stats.tracked++;
      sc.addVectors(sl, sr).multiplyScalar(0.5);
      v.subVectors(sr, sl); // model: from the left shoulder to the right one (bind: -x)
      chestYaw = clamp(Math.atan2(v.z, -v.x), -1.2, 1.2);
      chestRoll = clamp(-Math.asin(clamp(v.y / Math.max(1e-6, v.length()), -1, 1)), -0.5, 0.5);
      // Lean: the hips under the shoulders when tracked, else a crouch-dependent forward lean.
      let lean = null;
      if (J(j, 'hipL', hl) && J(j, 'hipR', hr)) {
        hc.addVectors(hl, hr).multiplyScalar(0.5);
        up.subVectors(sc, hc);
        const L = up.length();
        if (L > 0.3 && L < 0.75 && hc.y > 0.45 && hc.y < 1.25 && up.y > 0.25) {
          lean = Math.atan2(up.z, up.y);
          stats.hipsTracked++;
        }
      }
      const standingS = 1.445;
      const drop = clamp(standingS - sc.y, -0.05, 0.6);
      const crouch = clamp(drop / 0.45, 0, 1);
      crouchS += (crouch - crouchS) * (init ? 1 - Math.exp(-12 * dt) : 1);
      const leanT = lean !== null ? clamp(lean, -0.25, 0.9) : 0.06 + 0.5 * crouchS;
      leanS += (leanT - leanS) * (init ? 1 - Math.exp(-10 * dt) : 1);
      // Pelvis under the shoulder midpoint along the lean.
      T.hipsPos.set(sc.x - Math.sin(leanS) * TORSO * 0.6, clamp(sc.y - Math.cos(leanS) * TORSO, 0.5, LIMBS.hipY + 0.04), sc.z - Math.sin(leanS) * TORSO);
      // First person: keep the chest front behind the eye (tracked eye-to-shoulder offsets vary).
      if (keepBehindEye && player.eye && isFiniteVec(player.eye)) {
        solver.toModel(player.eye, v);
        const chestFront = T.hipsPos.z + 0.105 + Math.sin(leanS) * 0.47;
        const shift = clamp(chestFront - (v.z - FP_CHEST_BEHIND_EYE), 0, 0.22);
        backShift += (shift - backShift) * (init ? 1 - Math.exp(-6 * dt) : 1);
      }
      T.hipsPos.z -= backShift;
      sl.z -= backShift; sr.z -= backShift;
    } else {
      crouchS += (0 - crouchS) * (1 - Math.exp(-4 * dt));
      T.hipsPos.set(0, LIMBS.hipY - 0.04, 0);
      leanS = 0.08;
    }
    jShift = backShift; // arms, hands, head and the racket move back with the torso
    // Small jumps: the tracker's jump flag lifts the pelvis (feet follow).
    if (player.body && player.body.jump && jumpY <= 0.001) jumpV = 1.6;
    jumpV -= 9.81 * dt;
    jumpY = Math.max(0, jumpY + jumpV * dt);
    if (jumpY <= 0) jumpV = 0;
    T.hipsPos.y += jumpY;

    const hipYaw = chestYaw * 0.45;
    T.hips.set(leanS * 0.3, hipYaw, chestRoll * 0.3, 'YXZ');
    T.spine.set(leanS * 0.65, hipYaw + (chestYaw - hipYaw) * 0.5, chestRoll * 0.6, 'YXZ');
    T.chest.set(leanS, chestYaw, chestRoll, 'YXZ');
    T.clavRaise.R = 0;
    T.clavRaise.L = 0;

    // ---- arms: tracked wrists / elbows; the racket hand rides the shown racket
    for (const side of SIDES) {
      const A = T.arm[side];
      const W = J(j, `wrist${side}`, A.wrist);
      A.on = !!W;
      if (!W) continue;
      const E = J(j, `elbow${side}`, el);
      if (E) {
        // Pole: from the shoulder-wrist line toward the tracked elbow.
        v.copy(side === 'R' ? sr : sl);
        w.subVectors(A.wrist, v).multiplyScalar(0.5).add(v);
        A.pole.subVectors(el, w);
        if (A.pole.lengthSq() < 1e-6) A.pole.set(side === 'R' ? -0.6 : 0.6, -1, -0.3);
        A.pole.normalize();
      } else A.pole.set(side === 'R' ? -0.6 : 0.6, -1, -0.3).normalize();
      T.clavRaise[side] = clamp((A.wrist.y - 1.4) / 0.35, 0, 1);
      if (side === rs && o.racket && frameOk(o.racket)) {
        handFromRacket(o.racket, rihD, side);
      } else {
        // Hand frame from the tracked knuckles (palm normal as fpRig.js computes it).
        const I = j[`index${side}`], P = j[`pinky${side}`], Wc = j[`wrist${side}`];
        if (I && P && Wc && isFiniteVec(I) && isFiniteVec(P)) {
          ax.set((I.x + P.x) / 2 - Wc.x, (I.y + P.y) / 2 - Wc.y, (I.z + P.z) / 2 - Wc.z);
          nm.set(I.x - Wc.x, I.y - Wc.y, I.z - Wc.z).cross(v.set(P.x - Wc.x, P.y - Wc.y, P.z - Wc.z));
          if (side === 'L') nm.negate();
          if (ax.lengthSq() > 1e-8 && nm.lengthSq() > 1e-10) {
            solver.dirToModel(ax, ax).normalize();
            solver.dirToModel(nm, nm).normalize();
            solver.basisQuat(ax, nm, A.hand);
          }
        }
      }
    }

    // ---- head: toward where the face points
    if (J(j, 'nose', nose) && J(j, 'earL', hl) && J(j, 'earR', hr)) {
      earC.addVectors(hl, hr).multiplyScalar(0.5);
      v.subVectors(nose, earC);
      v.y -= 0.02;
      if (v.lengthSq() > 1e-6) T.look.copy(nose).addScaledVector(v.normalize(), 5);
      T.lookWeight = 1;
    } else {
      T.look.set(Math.sin(chestYaw) * 5, 1.5, Math.cos(chestYaw) * 5);
      T.lookWeight = 0.6;
    }
    T.headTilt = 0;

    // ---- legs: foot planting from the court movement, split-steps on cue
    const cue = o.cue || null;
    let hop = false;
    if (cue && cue.split && time >= cue.split.t0 && cue.split.t0 > splitDone && Math.hypot(vx, vz) < 3.5) {
      hop = true;
      splitDone = cue.split.t0;
      stats.splits++;
    }
    const st0 = cue && cue.split && time < cue.split.tLand + 0.25 ? STANCES.split : STANCES.ready;
    const wide = 1 + crouchS * 0.35;
    // Feet a little ahead of the hips (athletic ready stance): looking down shows the shoes.
    stance.R[0] = st0.R[0] * wide; stance.R[1] = st0.R[1] + 0.06 + 0.08 * crouchS;
    stance.L[0] = st0.L[0] * wide; stance.L[1] = st0.L[1] + 0.06 + 0.08 * crouchS;
    if (!init) stepper.reset(px, pz + backShift * human.scale, YAW + hipYaw, stance);
    stepIn.x = px; stepIn.z = pz + backShift * human.scale; stepIn.vx = vx; stepIn.vz = vz; stepIn.yaw = YAW + hipYaw;
    stepIn.hop = hop;
    stepIn.jump = jumpY;
    const st = stepper.update(dt, stepIn);
    T.hipsPos.y += st.hopY + st.bob * 0.6;
    T.hipsPos.x += -st.sway * 0.4;
    if (cue && cue.split) {
      const land = envelope(time, cue.split.tLand - 0.05, 0.3, 0.05, 0.2);
      T.hipsPos.y -= 0.035 * land;
    }
    for (const side of SIDES) {
      const f = stepper.feet[side];
      w.set(f.x, 0, f.z);
      solver.toModel(w, v);
      const L = T.leg[side];
      const heel = Math.max(0, f.pitch) * 0.075;
      L.ankle.set(v.x, LIMBS.ankleY + f.y / human.scale + heel + jumpY * 0.85, v.z);
      let yaw = f.yaw - YAW;
      while (yaw > Math.PI) yaw -= 2 * Math.PI;
      while (yaw < -Math.PI) yaw += 2 * Math.PI;
      L.yaw = yaw;
      L.pitch = f.pitch;
      L.pole.set(Math.sin(yaw) + (side === 'R' ? -0.12 : 0.12), 0, Math.cos(yaw)).normalize();
    }
    keepFeetReachable(T);
    solver.solve();
    init = true;
    return true;
  }

  function setHanded(h) {
    const n = h === 'left' ? 'left' : 'right';
    if (n === hand) return;
    hand = n;
    rihD = racketInHand(hand);
    if (human.handed !== n) human.setHanded(n);
  }

  return { update, stats, pose: T, setHanded, reset() { init = false; } };
}

/** Camera pitch (rad, view direction below the horizon) below which the body can be in view. */
export const FP_BODY_PITCH = -0.3;

/**
 * @param {{ handed?: 'right'|'left', height?: number, kit?: object }} o
 * @returns {{ root, human, update(player, dt, o), setKit(k), setHanded(h), setHeight(h), stats, pose }}
 */
export function createFirstPersonBody({ handed = 'right', height = 1.75, kit = {} } = {}) {
  const human = createSkinnedHuman({ kit, handed, height, mode: 'fp' });
  const root = human.root;
  root.name = 'fp-body';
  const poser = createTrackedPoser(human, { keepBehindEye: true });
  retune();

  /**
   * o: { visible, racket (shown), time, cue, viewDir: {x,y,z} (camera forward; the visible mesh is
   * only drawn while looking down far enough to see it — the shadow caster always is) }
   */
  function update(player, dt = 1 / 60, o = {}) {
    if (!player || o.visible === false || !poser.update(player, dt, o)) {
      root.visible = false;
      return;
    }
    root.visible = true;
    const m = human.meshes[0] && human.meshes[0].material;
    const eyeY = o.camPos && Number.isFinite(o.camPos.y) ? o.camPos.y : player.eye && Number.isFinite(player.eye.y) ? player.eye.y : 1.6;
    if (m && m.userData.fpEyeY) m.userData.fpEyeY.value = eyeY;
    const vd = o.viewDir;
    const lookingDown = !vd || !Number.isFinite(vd.y) || Math.asin(Math.max(-1, Math.min(1, vd.y))) < FP_BODY_PITCH;
    if (human.meshes[0]) human.meshes[0].visible = lookingDown;
  }

  function setHanded(h) {
    poser.setHanded(h);
    retune();
  }
  function retune() {
    const m = human.meshes[0] && human.meshes[0].material;
    if (m && m.userData.fpNear) {
      m.userData.fpNear.value = FP_BODY_FADE.near;
      m.userData.fpFar.value = FP_BODY_FADE.far;
    }
  }

  return {
    root,
    human,
    update,
    stats: poser.stats,
    pose: poser.pose,
    setKit(k) { human.setKit(k); retune(); },
    setHanded,
    setHeight(h) { human.setHeight(h); },
    /** The visible (first-person) mesh and the shadow caster. */
    get meshes() { return { visible: human.meshes[0], shadow: human.meshes.shadow }; },
  };
}
