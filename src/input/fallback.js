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
import { RACKET, PLAYER, COURT, BALL, SIM } from '../config.js';

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
 * Picks the most comfortable contact sample for a player at (px, pz): ball on the near side,
 * coming toward the player, reachable, 0.35–2.3 m high; prefers after the bounce at hip-chest
 * height on the side of the body. Returns a sample or null.
 */
export function chooseContact(samples, playerPos, handed = 'right', { minT = 0.12 } = {}) {
  const side = handed === 'left' ? -1 : 1;
  let best = null, bestScore = Infinity;
  for (const s of samples) {
    if (s.t < minT || s.z <= 0.3 || s.y < 0.35 || s.y > 2.3) continue;
    const dx = s.x - playerPos.x;
    const dz = s.z - playerPos.z;
    const reach = Math.hypot(dx, dz);
    if (reach > 1.7 || dz > 0.4 || dz < -1.6) continue;
    const ideal = Math.abs(Math.abs(dx) - 0.7) + Math.abs(dz + 0.5) * 0.8 + Math.abs(s.y - 1.0) * 0.6;
    let score = ideal + (s.bounced ? 0 : 0.35) + (s.vz < 0 ? 0.8 : 0) + s.t * 0.15;
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
export function planSwing(P, tc, eye, handed = 'right', { speed = FALLBACK.autoSwingSpeed, target = null } = {}) {
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
  return { P: v3(P.x, P.y, P.z), tc, T, back, follow, face, vel: velDir.scale(speed), swingSide };
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
  const sweet = v3(), prevSweet = v3(), vPlane = v3(), tmpVel = v3(), face = v3();
  const autoPos = v3(), autoVel = v3();
  const eye = v3();
  const camEye = v3();
  let hasPrev = false;

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
    const r = PLAYER.bodyRadius;
    moveTarget.x = clamp(moveTarget.x + (dx / n) * FALLBACK.moveSpeed * dt, -COURT.halfWidth + r, COURT.halfWidth - r);
    moveTarget.z = clamp(moveTarget.z + (dz / n) * FALLBACK.moveSpeed * dt, PLAYER.netKeepOut, COURT.halfLength - r);
  }

  function updatePlan(world, now) {
    const playerPos = world?.player?.pos || { x: eye.x, z: eye.z };
    if (autoRequest) {
      autoRequest = false;
      const c = chooseContact(predictBallPath(world?.ball), playerPos, handed);
      if (c) plan = planSwing(c, now + c.t, eye, handed);
      else {
        // no ball to play: a shadow swing on the forehand side
        const side = handed === 'left' ? -1 : 1;
        plan = planSwing({ x: eye.x + side * 0.7, y: 1.0, z: eye.z - 0.6 }, now + 0.45, eye, handed);
      }
      plan.live = !!c;
    }
    if (plan && plan.live && now < plan.tc - 0.12) {
      // refine contact while the ball is still in flight
      const c = chooseContact(predictBallPath(world?.ball), playerPos, handed);
      if (c && Math.abs(now + c.t - plan.tc) < 0.25) plan = Object.assign(planSwing(c, now + c.t, eye, handed), { live: true });
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

      // pointer velocity on the plane, lightly smoothed
      if (hasPrev && dt > 0) {
        tmpVel.subVectors(sweet, prevSweet).scale(1 / dt);
        vPlane.lerp(tmpVel, 1 - Math.exp(-dt / 0.03));
      } else vPlane.set(0, 0, 0);
      prevSweet.copy(sweet);
      hasPrev = true;

      flickVelocity(vPlane, FALLBACK.velGain, pose.vel);
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
          pose.vel.lerpVectors(pose.vel, autoVel, w);
        }
      }
      return { moveTarget: moveTarget ? { x: moveTarget.x, z: moveTarget.z } : null, racket: pose };
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
