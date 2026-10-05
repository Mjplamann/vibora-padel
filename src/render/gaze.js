// Gaze assist for the first-person camera (SPEC §6.8). Pure module (no three, no DOM) so the
// behaviour can be tested against the real drill pipeline under Node.
//
// The player's real body and tracked arms always face the TV (court -z). Any yaw of the view
// therefore rotates the picture away from the arm frame, so the gaze follows the ball in phases:
//   front   ball ahead of the eye: follow part of the way (more for far balls); within 2.5 m
//           (the stroke itself) the yaw stays within ±30° so the racket meets the ball on screen.
//   out     ball behind the eye and travelling to the back glass.
//   return  ball behind the eye coming back off the glass (or slowing there).
//
// What happens while the ball is behind depends on opts.glassView (settings.glassView, real-world
// session: "turning to the glass wasn't really fluid"):
//   'mirror' (app default) the view keeps facing the net with a gentle follow (|yaw| <= 25°); the
//            stage shows the glass rebound in a rear-view mirror inset (rear: true in the result).
//   'fixed'  the same view without the mirror.
//   'turn'   a head turn toward the glass (|yaw| <= 75°), re-tuned for smoothness: it starts
//            before the ball passes the eye (anticipation from the ball's time to the eye plane),
//            its target is low-pass filtered and followed by a softer critically damped spring
//            (no snap-back: the return to the contact starts as the ball reaches the glass).
//            The old phase switch with a 14/s spring hit the 150°/s rate cap with ~10 000°/s²
//            jolts; this keeps the pan under ~100°/s and the acceleration a few hundred °/s².
// Every mode keeps a hard yaw-rate cap (150°/s) as a last resort.
//
// Contact framing (QA2): when the predicted contact of the incoming ball is known (opts.contact,
// the tactical home's intercept), the view blends over the last CONTACT_LEAD s from following the
// ball to framing the contact point in the lower-middle of the picture (up to CONTACT_DROP below
// the centre; never by tilting up past a chest-high contact), so racket and ball meet on screen.
// Overheads cap the upward pitch (OVERHEAD_PITCH_MAX): the view does not stare at the ceiling and
// the racket rising from behind the head enters the frame.
//
// Swing nod (QA r5: "the racket is off-screen for the ~100 ms before contact and pops in from the
// corner"): over the last SWING_LEAD s of a contact below the shoulders the view nods SWING_NOD
// further down and turns SWING_YAW toward the hitting side, where the racket comes from, so it
// enters the picture earlier (a player keeps the head down and still through contact). It eases
// out over SWING_RELEASE s after the contact.

const DEG = Math.PI / 180;
const COURT_HALF_LENGTH = 10; // m, back glass plane (config COURT.halfLength; gaze.js stays dependency-free)

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
  CONTACT_DROP: 17 * DEG, // the predicted contact sits this far below the view centre
  CONTACT_YAW_GAIN: 0.75, // share of the contact's bearing the head turns toward (within CONTACT_LIMIT)
  OVERHEAD_PITCH_MAX: 25 * DEG,
  CONTACT_LEAD: Object.freeze([0.25, 0.8]), // s before the contact: full framing .. framing starts
  CONTACT_BLEND_FAR: 4.0, // m (ball to contact, horizontal), when the contact has no time
  CONTACT_BLEND_NEAR: 1.5,
  SWING_NOD: 16 * DEG,
  SWING_YAW: 9 * DEG,
  SWING_LEAD: Object.freeze([0.18, 0.62]), // s before the contact: full nod .. nod starts (the springs lag ~0.1 s)
  SWING_LAMBDA: 12, // pitch / yaw spring during the nod (1/s)
  SWING_SMOOTH: 10, // low-pass of the nod amount (1/s)
  SWING_RELEASE: 0.4, // s after the contact over which the nod eases out
  SWING_BELOW: 0.3, // m: the contact must be this far below the eye (no nod for overheads)
  // Round 6 ("the player loses sight of the ball right before contact"): with the view's vertical
  // half-FOV known (opts.vHalf), the pitch target never puts a ball that is in front of the eye
  // beyond KEEP_MARGIN of the half-height from the centre (a high ball dropping onto a low contact
  // stays in the picture while the contact framing tilts the view down). Only for balls at least
  // KEEP_MIN_AHEAD m in front of the eye (a ball coming off the glass beside the head cannot be framed).
  KEEP_MARGIN: 0.82,
  KEEP_MIN_AHEAD: 0.6,
});

/** Glass-view modes (settings.glassView): limits, springs and anticipation (see the header). */
export const GLASS_VIEW = Object.freeze({
  MODES: Object.freeze(['mirror', 'turn', 'fixed']),
  DEFAULT: 'mirror',
  CALM_LIMIT: 25 * DEG, // mirror / fixed: |yaw| never beyond this
  CALM_LAMBDA: 4, // mirror / fixed: spring (1/s)
  CALM_GAIN: 0.45, // mirror / fixed: share of the ball's bearing followed
  TURN_LIMIT: 75 * DEG,
  TURN_LAMBDA: 6, // turn: spring while the ball is behind / coming back (1/s)
  RETURN_MARGIN: 8 * DEG, // turn: the return aims this far inside the ±30° contact band
  TARGET_LAMBDA: 7, // low-pass of the yaw target (1/s): no target steps reach the spring
  TARGET_LAMBDA_NEAR: 14, // the same at the stroke (contact framing keeps the racket on screen)
  ANTICIPATE: Object.freeze([0.1, 0.55]), // s to the eye plane: full turn .. turn starts
  RELEASE: Object.freeze([0.05, 0.38]), // s to the glass: return starts .. full turn
  REAR_DZ: -0.2, // m: the mirror shows the rebound once the ball is this close to the eye plane
});

const finite3 = (v) => !!v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);

/**
 * The contact the view frames (round 6): the timing plan's p* at t* (game/swingAssist.js: where the
 * approach circle closes on the ball, render/approach.js) while that swing is undecided, so the ball
 * is on screen at the moment to swing whatever t* the timing judge uses; otherwise (physical
 * hitting, no plan) the tactical home's intercept as before. Returns out {x, y, z, t} or null. Pure.
 */
export function framingContact(world, out = { x: 0, y: 0, z: 0, t: 0 }) {
  const b = world && world.ball;
  if (!b || b.atRest) return null;
  const T = world.timing;
  const P = T && T.plan;
  if (P && finite3(P.pStar) && Number.isFinite(P.tStar) && !(T.decided && T.decided.key === P.key)
    && Number.isFinite(world.time) && world.time <= P.tStar + 0.4) {
    out.x = P.pStar.x; out.y = P.pStar.y; out.z = P.pStar.z; out.t = P.tStar;
    return out;
  }
  const ic = world.mode && world.mode.tactics && world.mode.tactics.state && world.mode.tactics.state.intercept;
  const c = ic && ic.contact;
  if (!c || !finite3(c)) return null;
  out.x = c.x; out.y = c.y; out.z = c.z; out.t = ic.t;
  return out;
}
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
 * @returns {{ update(ball, eye, dt, opts): {yaw, pitch, phase, rear}, reset(basePitch), yaw, pitch, phase }}
 *   ball: BallState|null; eye: {x,y,z}; opts: { basePitch (rad), follow = true, contact = null,
 *   glassView = 'turn' ('mirror' | 'turn' | 'fixed'; the app passes settings.glassView, default
 *   'mirror'), vHalf (rad: the view's vertical half-FOV; when given, a ball in front stays in the
 *   picture, GAZE.KEEP_MARGIN) }
 *   contact: predicted contact {x, y, z, t?} (court; t in ball time) for the incoming ball, or null.
 *   yaw: 0 = looking toward -z, + = turned to the player's left (three.js Y rotation).
 *   rear: the ball is behind (or at) the eye plane on the player's side: the mirror inset's cue.
 */
export function createGaze() {
  const yaw = { x: 0, v: 0 };
  const pitch = { x: 0, v: 0 };
  let yawT = 0; // low-passed yaw target
  let lamS = GAZE.LAMBDA; // low-passed spring stiffness (no stiffness steps either)
  let pitchInit = false;
  let phase = 'front';
  let rear = false;
  let nodS = 0; // low-passed swing nod (0..1): no target steps when the planned contact moves

  function reset(basePitch = 0) {
    yaw.x = 0; yaw.v = 0;
    yawT = 0;
    lamS = GAZE.LAMBDA;
    pitch.x = basePitch; pitch.v = 0;
    pitchInit = true;
    phase = 'front';
    rear = false;
    nodS = 0;
  }

  function update(ball, eye, dt, { basePitch = 0, follow = true, contact = null, glassView = 'turn', vHalf = 0 } = {}) {
    if (!(vHalf > 0 && vHalf < Math.PI / 2)) vHalf = 0;
    // Non-finite inputs never reach the springs (a NaN target would keep the view NaN for good).
    if (!Number.isFinite(basePitch)) basePitch = 0;
    if (!(dt >= 0) || !Number.isFinite(dt)) dt = 0;
    if (ball && !(finite3(ball.pos) && (!ball.vel || finite3(ball.vel)))) ball = null;
    if (eye && !finite3(eye)) eye = null;
    if (contact && !finite3(contact)) contact = null;
    if (!pitchInit || !(Number.isFinite(yaw.x) && Number.isFinite(yaw.v) && Number.isFinite(pitch.x) && Number.isFinite(pitch.v) && Number.isFinite(yawT))) reset(basePitch);
    const turn = glassView === 'turn';
    const calm = !turn; // 'mirror' | 'fixed'
    const yawLimit = turn ? GLASS_VIEW.TURN_LIMIT : GLASS_VIEW.CALM_LIMIT;
    let tYaw = 0, tPitch = basePitch;
    let lambda = calm ? GLASS_VIEW.CALM_LAMBDA : GAZE.LAMBDA;
    let lamT = GLASS_VIEW.TARGET_LAMBDA;
    let passing = 0; // turn: weight of a ball passing the eye on its way to the glass
    phase = 'front';
    rear = false;
    let nodTouched = false;
    let lamP = 0; // round 6: a stiffer pitch spring while a glass return is framed (0 = lambda)
    if (follow && ball && !ball.atRest && !ball.outside && eye) {
      const dx = ball.pos.x - eye.x, dy = ball.pos.y - eye.y, dz = ball.pos.z - eye.z;
      const horiz = Math.hypot(dx, dz);
      const vz = ball.vel ? ball.vel.z : 0;
      const vx = ball.vel ? ball.vel.x : 0;
      const behind = dz > GAZE.BEHIND_DZ;
      const near = horiz < GAZE.NEAR_RADIUS && ball.pos.z > 0;
      rear = ball.pos.z > 0 && dz > GLASS_VIEW.REAR_DZ && (vz > GAZE.OUT_VZ || behind);
      // Toward the contact the ball is heading for: beside the body, a little in front.
      const contactSide = clamp(Math.atan2(-dx, 0.6) * 0.6, -GAZE.CONTACT_LIMIT, GAZE.CONTACT_LIMIT);
      // Front following (also the base the turn blends from).
      const ang = Math.atan2(-dx, -dz);
      let front;
      if (calm) front = clamp(ang * GLASS_VIEW.CALM_GAIN, -GLASS_VIEW.CALM_LIMIT, GLASS_VIEW.CALM_LIMIT);
      else {
        const gain = 0.35 + 0.5 * smoothstep(1.2, 4.0, horiz);
        front = clamp(ang * gain, -(near ? GAZE.CONTACT_LIMIT : GAZE.FRONT_LIMIT), near ? GAZE.CONTACT_LIMIT : GAZE.FRONT_LIMIT);
      }
      if (turn && vz > GAZE.OUT_VZ && ball.pos.z > 0) {
        // Heading for the back glass: turn toward where the ball will meet it, starting before it
        // passes the eye and releasing as it reaches the glass.
        const tEye = (eye.z + GAZE.BEHIND_DZ - ball.pos.z) / vz;
        const tGlass = Math.max(0, (COURT_HALF_LENGTH - ball.pos.z) / vz);
        const gx = ball.pos.x + vx * tGlass - eye.x, gz = COURT_HALF_LENGTH - eye.z;
        let gAng = Math.atan2(-gx, -gz);
        // Straight behind: keep turning over the shoulder already turned to (no side flips).
        if (Math.abs(gx) < 0.5 && Math.abs(yawT) > 10 * DEG && Math.sign(gAng) !== Math.sign(yawT)) gAng = Math.sign(yawT) * Math.PI;
        // A contact planned before the ball reaches the eye plane (a volley, a ball taken early)
        // is the stroke, not a glass ball: no turn.
        const tc = contact && Number.isFinite(contact.t) && Number.isFinite(ball.t) ? contact.t - ball.t : null;
        const strokeFirst = tc !== null && tc > -0.15 && tc < Math.max(0, tEye) + 0.1;
        // wPass: the ball is passing the eye plane (front following would whip round); wTurn: there
        // is still time to watch it meet the glass, else the view heads back toward the contact.
        const wPass = strokeFirst ? 0 : 1 - smoothstep(GLASS_VIEW.ANTICIPATE[0], GLASS_VIEW.ANTICIPATE[1], tEye);
        const wTurn = smoothstep(GLASS_VIEW.RELEASE[0], GLASS_VIEW.RELEASE[1], tGlass);
        const wOut = wPass * wTurn;
        passing = wPass;
        const outT = clamp(gAng, -yawLimit, yawLimit);
        const retLim = GAZE.CONTACT_LIMIT - GLASS_VIEW.RETURN_MARGIN;
        const retT = clamp(contactSide, -retLim, retLim);
        tYaw = front + (outT * wTurn + retT * (1 - wTurn) - front) * wPass;
        if ((behind && !strokeFirst) || wOut > 0.5) phase = 'out';
        if (wPass > 0.05) lambda = GLASS_VIEW.TURN_LAMBDA;
      } else if (behind) {
        phase = 'return';
        // The soft spring lags: aim a few degrees inside the contact band.
        const lim = calm ? GLASS_VIEW.CALM_LIMIT : GAZE.CONTACT_LIMIT - GLASS_VIEW.RETURN_MARGIN;
        tYaw = clamp(contactSide, -lim, lim);
        lambda = calm ? GLASS_VIEW.CALM_LAMBDA : GLASS_VIEW.TURN_LAMBDA;
      } else {
        tYaw = front;
        if (near) {
          lambda = calm ? Math.max(lambda, 6) : GAZE.LAMBDA_NEAR;
          lamT = GLASS_VIEW.TARGET_LAMBDA_NEAR;
        }
        // Coming back from a turn (the ball has come off the glass past the eye): no snap.
        if (turn && Math.abs(yaw.x) > GAZE.CONTACT_LIMIT) lambda = Math.max(GLASS_VIEW.TURN_LAMBDA, GAZE.LAMBDA);
      }
      const ballPitch = Math.atan2(dy, Math.max(0.3, horiz));
      const d = ballPitch - basePitch;
      const followP = d < 0 ? 0.6 * d : 0.7 * Math.max(0, d - GAZE.UP_BAND);
      tPitch = clamp(basePitch + followP, GAZE.PITCH_MIN, GAZE.PITCH_MAX);
      // Contact framing for the stroke itself. Round 6: also while a glass ball comes back from
      // behind ('return'): its contact is only ~0.25 m in front of the eye, so the view must already
      // be tilted down when it re-enters the picture (pitch only: the yaw keeps the return's spring).
      const ret = phase === 'return';
      if (contact && (phase === 'front' || ret)) {
        const cx = contact.x - eye.x, cy = contact.y - eye.y, cz = contact.z - eye.z;
        // Blend in over the last CONTACT_LEAD s before the contact (by distance without a time).
        const tl = Number.isFinite(contact.t) && Number.isFinite(ball.t) ? contact.t - ball.t : null;
        // (Not while the ball is still on its way past the eye to the glass.)
        const w = (1 - passing) * (tl !== null
          ? (tl < -0.15 ? 0 : 1 - smoothstep(GAZE.CONTACT_LEAD[0], GAZE.CONTACT_LEAD[1], tl))
          : 1 - smoothstep(GAZE.CONTACT_BLEND_NEAR, GAZE.CONTACT_BLEND_FAR, Math.hypot(ball.pos.x - contact.x, ball.pos.z - contact.z)));
        if (w > 0) {
          const cH = Math.max(0.25, Math.hypot(cx, cz));
          const cLim = calm ? GLASS_VIEW.CALM_LIMIT : GAZE.CONTACT_LIMIT;
          const cYaw = clamp(Math.atan2(-cx, -cz) * GAZE.CONTACT_YAW_GAIN, -cLim, cLim);
          // Contact CONTACT_DROP below the centre, but never by looking up past the contact (a
          // chest-high ball is framed at the centre rather than with the ceiling).
          const e = Math.atan2(cy, cH);
          const cPitch = clamp(Math.min(e + GAZE.CONTACT_DROP, Math.max(basePitch, e)), GAZE.PITCH_MIN, GAZE.OVERHEAD_PITCH_MAX);
          // Swing nod toward where the racket comes from (groundstrokes, volleys below the shoulders).
          let nodT = 0;
          if (tl !== null && cy < -GAZE.SWING_BELOW) {
            nodT = tl >= 0 ? 1 - smoothstep(GAZE.SWING_LEAD[0], GAZE.SWING_LEAD[1], tl) : 1 - smoothstep(0, GAZE.SWING_RELEASE, -tl);
            nodT *= smoothstep(GAZE.SWING_BELOW, GAZE.SWING_BELOW + 0.25, -cy);
          }
          nodS += (nodT - nodS) * (1 - Math.exp(-GAZE.SWING_SMOOTH * dt));
          nodTouched = true;
          const nod = nodS;
          const side = cx > 0.05 ? -1 : cx < -0.05 ? 1 : 0; // yaw + = left: turn toward the contact's side
          const nYaw = clamp(cYaw + side * GAZE.SWING_YAW * nod, -cLim, cLim);
          const nPitch = clamp(cPitch - GAZE.SWING_NOD * nod, GAZE.PITCH_MIN, GAZE.OVERHEAD_PITCH_MAX);
          tPitch = tPitch + (nPitch - tPitch) * w;
          if (ret) {
            lamP = Math.max(lambda, nod > 0.05 ? GAZE.SWING_LAMBDA : GAZE.LAMBDA_NEAR);
          } else {
            tYaw = tYaw + (nYaw - tYaw) * w;
            if (nod > 0.05) lambda = Math.max(lambda, GAZE.SWING_LAMBDA);
            lambda = Math.max(lambda, calm ? 6 : GAZE.LAMBDA_NEAR);
            lamT = GLASS_VIEW.TARGET_LAMBDA_NEAR;
            phase = 'contact';
          }
        }
      }
      // Keep the ball itself in the picture (round 6; needs the view's vertical half-FOV).
      if (vHalf > 0 && phase !== 'out' && !behind && -dz >= GAZE.KEEP_MIN_AHEAD) {
        const lim = vHalf * GAZE.KEEP_MARGIN;
        // The ball's elevation in the view's own vertical plane (the view is yawed toward the ball).
        const bp = Math.atan2(dy, Math.max(0.3, horiz));
        const kept = clamp(tPitch, bp - lim, bp + lim);
        // A binding limit follows the ball with the swing's stiffer spring (no lag out of the picture).
        if (Math.abs(kept - tPitch) > 1 * DEG) lamP = Math.max(lamP, GAZE.SWING_LAMBDA);
        tPitch = kept;
      }
      // Overheads: never stare at the ceiling.
      if (tPitch > GAZE.OVERHEAD_PITCH_MAX && phase !== 'out') tPitch = GAZE.OVERHEAD_PITCH_MAX;
    } else if (turn && Math.abs(yaw.x) > GAZE.CONTACT_LIMIT) {
      lambda = Math.max(GLASS_VIEW.TURN_LAMBDA, GAZE.LAMBDA);
    }
    if (!nodTouched) nodS += (0 - nodS) * (1 - Math.exp(-GAZE.SWING_SMOOTH * dt));
    tYaw = clamp(tYaw, -yawLimit, yawLimit);
    // The yaw target is low-passed so no step reaches the spring (smooth acceleration).
    yawT += (tYaw - yawT) * (1 - Math.exp(-lamT * dt));
    lamS += (lambda - lamS) * (1 - Math.exp(-GLASS_VIEW.TARGET_LAMBDA * dt));
    springCapped(yaw, yawT, lamS, dt, GAZE.MAX_YAW_RATE);
    springCapped(pitch, tPitch, Math.max(lambda, lamP), dt, GAZE.MAX_PITCH_RATE);
    yaw.x = clamp(yaw.x, -yawLimit, yawLimit);
    return { yaw: yaw.x, pitch: pitch.x, phase, rear };
  }

  return {
    update,
    reset,
    get yaw() { return yaw.x; },
    get pitch() { return pitch.x; },
    get phase() { return phase; },
    get rear() { return rear; },
  };
}
