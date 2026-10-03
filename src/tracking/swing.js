// Stroke analysis: what was played, how good the contact was, and swing timing.
// Pure module. Inputs are in the user frame U (+x right, +y up, +z toward the net).

import { PLAYER, TRACKING } from '../config.js';
import { DEG } from '../util/math.js';

const REF_HEIGHT = PLAYER.defaultHeight;

/** Classification thresholds (meters for a 1.75 m player; scaled by the player's height). */
export const STROKE_RULES = Object.freeze({
  overheadHeight: 1.7, // contact above this is an overhead (SPEC)
  smashSpeed: 17, // m/s racket speed
  smashPitchDeg: -20, // racket path at least this steep downward
  viboraSideRatio: 0.45, // sideways / horizontal racket velocity (cut across the ball)
  viboraMinSpeed: 9, // m/s; the víbora is hit with more pace than a bandeja
  faceClosedNy: -0.2, // forehand-face normal y below this = face closed (rolled over)
  lobPitchDeg: 35, // racket path rising more than this (SPEC)
  chiquitaSpeed: 8, // m/s
  chiquitaHeight: 0.9, // contact below this
  chiquitaMinZ: 2.5, // a soft low ball at the net is a volley / drop, not a chiquita
  sideDeadband: 0.08, // m: contact this close to the body center uses the swing direction
  faceZ: 0.3, // |normal.z| above this decides forehand/backhand from the face used
});

const hasVec = (v) => v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);

/**
 * Forehand when the ball is struck with the palm-side face (normal toward the net), or, without
 * a face normal, when contact is on the dominant side (or the swing travels across the body).
 */
export function isForehand({ contactU, racketVelU, handed = 'right', racketNormalU = null }) {
  const dom = handed === 'left' ? -1 : 1;
  if (hasVec(racketNormalU) && Math.abs(racketNormalU.z) > STROKE_RULES.faceZ) return racketNormalU.z > 0;
  const side = contactU.x * dom;
  if (Math.abs(side) > STROKE_RULES.sideDeadband || !hasVec(racketVelU)) return side >= 0;
  // A forehand swing travels from the dominant side toward the other side.
  return racketVelU.x * dom <= 0;
}

/**
 * @param {object} p
 * @param p.contactU contact point in U
 * @param p.racketVelU sweet-spot velocity in U (m/s)
 * @param p.handed 'right'|'left'
 * @param p.ballBounced ball bounced on the player's side before contact
 * @param p.ballAfterWall ball came off a wall (after its bounce) before contact
 * @param p.playerZ player's court z (m from the net)
 * @param p.isServe
 * @param [p.racketNormalU] forehand-face normal in U (improves fh/bh and víbora reads)
 * @param [p.height] player height (default 1.75)
 * @returns 'forehand'|'backhand'|'volley-fh'|'volley-bh'|'bandeja'|'vibora'|'smash'|'lob'|'chiquita'|'serve'|'glass-fh'|'glass-bh'
 */
export function classifyStroke({
  contactU, racketVelU, handed = 'right', ballBounced = true, ballAfterWall = false, playerZ = 8, isServe = false,
  racketNormalU = null, height = REF_HEIGHT,
}) {
  if (isServe) return 'serve';
  const hs = height / REF_HEIGHT;
  const dom = handed === 'left' ? -1 : 1;
  const v = hasVec(racketVelU) ? racketVelU : { x: 0, y: 0, z: 0 };
  const speed = Math.hypot(v.x, v.y, v.z);
  const horiz = Math.hypot(v.x, v.z);
  const pitch = speed > 1e-6 ? Math.asin(v.y / speed) / DEG : 0;

  if (contactU.y > STROKE_RULES.overheadHeight * hs) {
    if (speed > STROKE_RULES.smashSpeed && pitch < STROKE_RULES.smashPitchDeg) return 'smash';
    const across = horiz > 1e-6 ? (-dom * v.x) / horiz : 0; // toward the non-dominant side
    const faceOpen = !hasVec(racketNormalU) || racketNormalU.y > STROKE_RULES.faceClosedNy;
    if (across > STROKE_RULES.viboraSideRatio && speed >= STROKE_RULES.viboraMinSpeed && faceOpen) return 'vibora';
    return 'bandeja';
  }
  if (pitch > STROKE_RULES.lobPitchDeg && speed > 2) return 'lob';
  if (
    ballBounced && speed < STROKE_RULES.chiquitaSpeed && contactU.y < STROKE_RULES.chiquitaHeight * hs
    && playerZ >= STROKE_RULES.chiquitaMinZ
  ) return 'chiquita';
  const fh = isForehand({ contactU, racketVelU: v, handed, racketNormalU });
  if (!ballBounced) return fh ? 'volley-fh' : 'volley-bh';
  if (ballAfterWall) return fh ? 'glass-fh' : 'glass-bh';
  return fh ? 'forehand' : 'backhand';
}

/**
 * Ideal contact windows per stroke family (1.75 m player; heights scale with height).
 * front: m in front of the hip line; lateral: m from the body toward the hitting side; height: m.
 * Groundstrokes per SPEC §4.5. Overheads are struck in front of the head with the arm extended,
 * serves at or below the waist (FIP rule).
 */
export const IDEAL_CONTACT = Object.freeze({
  ground: { front: [0.25, 0.75], lateral: [0.5, 0.9], height: [0.6, 1.3] },
  glass: { front: [0.0, 0.6], lateral: [0.5, 0.95], height: [0.5, 1.3] },
  low: { front: [0.2, 0.7], lateral: [0.4, 0.9], height: [0.25, 0.9] },
  volley: { front: [0.3, 0.9], lateral: [0.3, 0.8], height: [0.7, 1.6] },
  overhead: { front: [0.0, 0.6], lateral: [0.0, 0.5], height: [2.0, 2.6] },
  serve: { front: [0.2, 0.7], lateral: [0.4, 0.9], height: [0.45, 0.93] },
});
const TOLERANCE = { front: 0.25, lateral: 0.2, height: 0.25 };

function familyOf(stroke) {
  switch (stroke) {
    case 'bandeja': case 'vibora': case 'smash': return 'overhead';
    case 'volley-fh': case 'volley-bh': return 'volley';
    case 'glass-fh': case 'glass-bh': return 'glass';
    case 'chiquita': return 'low';
    case 'serve': return 'serve';
    default: return 'ground';
  }
}

const isBackhandStroke = (stroke) => stroke === 'backhand' || stroke === 'volley-bh' || stroke === 'glass-bh';

const excess = (v, [lo, hi]) => (v < lo ? lo - v : v > hi ? v - hi : 0);

/**
 * @returns { front, side, height, timing: 'early'|'good'|'late', spacing: 'cramped'|'good'|'stretched', score }
 * front: m in front of the hips (+ toward the net); side: m toward the dominant side (signed);
 * spacing is judged on the hitting side (non-dominant side for backhands).
 */
export function contactQuality({ contactU, handed = 'right', stroke = 'forehand', height = REF_HEIGHT }) {
  const dom = handed === 'left' ? -1 : 1;
  const hs = height / REF_HEIGHT;
  const front = contactU.z;
  const side = contactU.x * dom;
  const h = contactU.y;
  const fam = familyOf(stroke);
  const ideal = IDEAL_CONTACT[fam];
  const lateral = isBackhandStroke(stroke) ? -side : side;
  const hRange = [ideal.height[0] * hs, ideal.height[1] * hs];

  const timing = front > ideal.front[1] ? 'early' : front < ideal.front[0] ? 'late' : 'good';
  // Overheads are judged on reach (height) rather than sideways spacing.
  const spacing = lateral < ideal.lateral[0] ? 'cramped' : lateral > ideal.lateral[1] ? 'stretched' : 'good';

  const ef = excess(front, ideal.front) / TOLERANCE.front;
  const el = excess(lateral, ideal.lateral) / TOLERANCE.lateral;
  const eh = excess(h, hRange) / TOLERANCE.height;
  const score = Math.exp(-0.5 * (ef * ef + el * el + eh * eh));
  return { front, side, height: h, timing, spacing, score };
}

/**
 * Swing detector fed with racket sweet-spot speeds. A swing starts when the speed crosses
 * `threshold`; tStart is the last moment the racket was (nearly) still before that, so
 * prepTime = tPeak - tStart measures the forward swing from the end of the backswing.
 * The swing ends when the speed drops below endRatio * threshold (or after maxDuration).
 * @returns { push(t, speed) -> SwingEvent|null, reset(), state }
 * SwingEvent = { tStart, tPeak, peakSpeed, prepTime, tEnd }
 */
export function createSwingDetector({
  threshold = TRACKING.swingSpeedThreshold, restSpeed = 1.5, endRatio = 0.6, maxDuration = 1.5, maxPrep = 1.0, onSwing = null,
} = {}) {
  const st = { phase: 'idle', lastRestT: null, tCross: 0, tStart: 0, tPeak: 0, peakSpeed: 0 };
  let prevT = null, prevS = 0;
  let peakNeighbours = null;

  function reset() {
    st.phase = 'idle';
    st.lastRestT = null;
    prevT = null;
    peakNeighbours = null;
  }

  function push(t, speed) {
    let event = null;
    if (st.phase === 'idle') {
      if (speed <= restSpeed) st.lastRestT = t;
      if (speed >= threshold) {
        st.phase = 'swing';
        st.tCross = t;
        const rest = st.lastRestT ?? prevT ?? t;
        st.tStart = Math.max(rest, t - maxPrep);
        st.tPeak = t;
        st.peakSpeed = speed;
        peakNeighbours = { t0: prevT, s0: prevS, t2: null, s2: 0 };
      }
    } else {
      if (speed > st.peakSpeed) {
        st.peakSpeed = speed;
        st.tPeak = t;
        peakNeighbours = { t0: prevT, s0: prevS, t2: null, s2: 0 };
      } else if (peakNeighbours && peakNeighbours.t2 === null && prevT === st.tPeak) {
        peakNeighbours.t2 = t;
        peakNeighbours.s2 = speed;
      }
      if (speed < threshold * endRatio || t - st.tCross > maxDuration) {
        event = {
          tStart: st.tStart,
          tPeak: refinePeak(),
          peakSpeed: st.peakSpeed,
          prepTime: 0,
          tEnd: t,
        };
        event.prepTime = Math.max(0, event.tPeak - event.tStart);
        st.phase = 'idle';
        st.lastRestT = speed <= restSpeed ? t : null;
        if (onSwing) onSwing(event);
      }
    }
    prevT = t;
    prevS = speed;
    return event;
  }

  /** Sub-frame peak time from a parabola through the peak and its neighbours. */
  function refinePeak() {
    const n = peakNeighbours;
    if (!n || n.t0 === null || n.t2 === null) return st.tPeak;
    const h0 = st.tPeak - n.t0, h2 = n.t2 - st.tPeak;
    if (h0 <= 0 || h2 <= 0 || Math.abs(h0 - h2) > 0.25 * Math.max(h0, h2)) return st.tPeak;
    const h = (h0 + h2) / 2;
    const denom = n.s0 - 2 * st.peakSpeed + n.s2;
    if (denom >= 0) return st.tPeak;
    const off = (0.5 * (n.s0 - n.s2)) / denom;
    return st.tPeak + Math.max(-0.5, Math.min(0.5, off)) * h;
  }

  return {
    push,
    reset,
    get state() {
      return { ...st };
    },
  };
}
