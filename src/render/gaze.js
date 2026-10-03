// Gaze assist for the first-person camera (SPEC §6.8). Pure module (no three, no DOM) so the
// behaviour can be tested against the real drill pipeline under Node.
//
// The player's real body and tracked arms always face the TV (court -z). Any yaw of the view
// therefore rotates the picture away from the arm frame, so the gaze follows the ball with
// three phases:
//   front   ball ahead of the eye: follow part of the way (more for far balls); within 2.5 m
//           (the stroke itself) the yaw stays within ±30° so the racket meets the ball on screen.
//   out     ball behind the eye and travelling to the back glass: a head turn toward it, capped
//           at ±80° (the off-screen arrow covers the rest).
//   return  ball behind the eye coming back off the glass (or slowing there): snap back toward
//           the expected contact beside the body (±30°) with a stiffer spring.
// Every phase shares a yaw-rate cap (150°/s): no whip pans on a big TV.

const DEG = Math.PI / 180;

export const GAZE = Object.freeze({
  FRONT_LIMIT: 70 * DEG,
  BACK_LIMIT: 80 * DEG,
  CONTACT_LIMIT: 30 * DEG,
  NEAR_RADIUS: 2.5, // m (horizontal) within which the ball counts as "at the stroke"
  BEHIND_DZ: 0.35, // m behind the eye before the ball counts as behind
  OUT_VZ: 0.3, // m/s toward the back glass for the "out" phase
  LAMBDA: 6, // critically damped spring (1/s)
  LAMBDA_NEAR: 10,
  LAMBDA_RETURN: 14,
  MAX_YAW_RATE: 150 * DEG, // rad/s
  MAX_PITCH_RATE: 120 * DEG,
  UP_BAND: 8 * DEG, // balls above the base direction are followed only beyond this band
  PITCH_MIN: -55 * DEG,
  PITCH_MAX: 50 * DEG,
});

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Critically damped spring on {x, v} with a rate cap, sub-stepped at <= 1/240 s. */
export function springCapped(s, target, lambda, dt, maxRate) {
  const n = Math.max(1, Math.ceil(dt * 240));
  const h = dt / n;
  for (let i = 0; i < n; i++) {
    s.v += (lambda * lambda * (target - s.x) - 2 * lambda * s.v) * h;
    if (s.v > maxRate) s.v = maxRate;
    else if (s.v < -maxRate) s.v = -maxRate;
    s.x += s.v * h;
  }
}

/**
 * @returns {{ update(ball, eye, dt, opts): {yaw, pitch, phase}, reset(basePitch), yaw, pitch, phase }}
 *   ball: BallState|null; eye: {x,y,z}; opts: { basePitch (rad), follow = true }
 *   yaw: 0 = looking toward -z, + = turned to the player's left (three.js Y rotation).
 */
export function createGaze() {
  const yaw = { x: 0, v: 0 };
  const pitch = { x: 0, v: 0 };
  let pitchInit = false;
  let phase = 'front';

  function reset(basePitch = 0) {
    yaw.x = 0; yaw.v = 0;
    pitch.x = basePitch; pitch.v = 0;
    pitchInit = true;
    phase = 'front';
  }

  function update(ball, eye, dt, { basePitch = 0, follow = true } = {}) {
    if (!pitchInit) reset(basePitch);
    let tYaw = 0, tPitch = basePitch;
    let lambda = GAZE.LAMBDA;
    phase = 'front';
    if (follow && ball && !ball.atRest && !ball.outside && eye) {
      const dx = ball.pos.x - eye.x, dy = ball.pos.y - eye.y, dz = ball.pos.z - eye.z;
      const horiz = Math.hypot(dx, dz);
      const vz = ball.vel ? ball.vel.z : 0;
      const behind = dz > GAZE.BEHIND_DZ;
      const near = horiz < GAZE.NEAR_RADIUS && ball.pos.z > 0;
      if (behind && vz > GAZE.OUT_VZ) {
        phase = 'out';
        let ang = Math.atan2(-dx, -dz);
        // Straight behind: keep turning over the shoulder already turned to (no side flips).
        if (Math.abs(ang) > GAZE.BACK_LIMIT && Math.abs(dx) < 0.5 && Math.abs(yaw.x) > 10 * DEG && Math.sign(ang) !== Math.sign(yaw.x)) {
          ang = Math.sign(yaw.x) * Math.PI;
        }
        tYaw = clamp(ang, -GAZE.BACK_LIMIT, GAZE.BACK_LIMIT);
      } else if (behind) {
        phase = 'return';
        // Toward the contact the ball is heading for: beside the body, a little in front.
        tYaw = clamp(Math.atan2(-dx, 0.6) * 0.6, -GAZE.CONTACT_LIMIT, GAZE.CONTACT_LIMIT);
        lambda = GAZE.LAMBDA_RETURN;
      } else {
        const ang = Math.atan2(-dx, -dz);
        const gain = 0.35 + 0.5 * smoothstep(1.2, 4.0, horiz);
        const lim = near ? GAZE.CONTACT_LIMIT : GAZE.FRONT_LIMIT;
        tYaw = clamp(ang * gain, -lim, lim);
        if (near) lambda = GAZE.LAMBDA_NEAR;
        // Coming back from a turn (e.g. the ball has just come off the glass past the eye).
        if (Math.abs(yaw.x) > GAZE.CONTACT_LIMIT) lambda = GAZE.LAMBDA_RETURN;
      }
      const ballPitch = Math.atan2(dy, Math.max(0.3, horiz));
      const d = ballPitch - basePitch;
      const followP = d < 0 ? 0.6 * d : 0.7 * Math.max(0, d - GAZE.UP_BAND);
      tPitch = clamp(basePitch + followP, GAZE.PITCH_MIN, GAZE.PITCH_MAX);
    } else if (Math.abs(yaw.x) > GAZE.CONTACT_LIMIT) {
      lambda = GAZE.LAMBDA_RETURN;
    }
    springCapped(yaw, tYaw, lambda, dt, GAZE.MAX_YAW_RATE);
    springCapped(pitch, tPitch, lambda, dt, GAZE.MAX_PITCH_RATE);
    yaw.x = clamp(yaw.x, -GAZE.BACK_LIMIT, GAZE.BACK_LIMIT);
    return { yaw: yaw.x, pitch: pitch.x, phase };
  }

  return {
    update,
    reset,
    get yaw() { return yaw.x; },
    get pitch() { return pitch.x; },
    get phase() { return phase; },
  };
}
