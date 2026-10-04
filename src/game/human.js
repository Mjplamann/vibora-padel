// Human-player pipeline shared by main.js, the autopilot and the tests:
// PoseFrame -> BodySample -> court position (locomotion + critically damped follow) ->
// racket pose in the COURT frame -> racket track -> lag-compensated swept contact ->
// applyPlayerHit. Pure module: no DOM, no three.
//
// U -> court for the near player at (px, pz): points (px + u.x, u.y, pz - u.z),
// directions (u.x, u.y, -u.z).

import { Vec3 } from '../util/vec3.js';
import { clamp } from '../util/math.js';
import { PLAYER, ASSIST, DEFAULT_ASSIST, TRACKING } from '../config.js';
import { createBodyTracker, JOINT_NAMES } from '../tracking/body.js';
import { createLocomotion, defaultBounds, closeRangeBoost } from '../tracking/locomotion.js';
import { createRacketTrack, createRacketPose, copyRacketPose, MAX_GAP } from '../tracking/racketTrack.js';
import { sweptContact } from '../physics/racket.js';
import { interceptCandidates } from '../physics/predict.js';
import {
  applyPlayerHit, applySpeculativeHit, revertSpeculative, emit, emitView, HIT_COOLDOWN, resolveSettings, predictFlight,
} from './world.js';
import { createSwingPredictor } from './swingPredict.js';
import { playableCandidates, pickGlassContact, stanceBounds } from './intercept.js';
import { createTimingJudge, timingConfig, flightKeyOf } from './swingAssist.js';
import { createSwingView } from './swingView.js';

const REF_HEIGHT = 1.75;

/**
 * Ideal contact point relative to the hip centre in U (right-hander, 1.75 m player;
 * scale by height / 1.75, mirror x for a left-hander), plus the trunk turn (deg, + = to
 * the player's right) used for that stroke family. Groundstrokes sit inside the SPEC
 * §4.5 ideal window (0.25–0.75 m in front, 0.5–0.9 m to the side).
 */
export const CONTACT_OFFSETS = Object.freeze({
  fh: Object.freeze({ x: 0.7, z: 0.34, turn: 0 }),
  bh: Object.freeze({ x: -0.5, z: 0.42, turn: -45 }),
  vfh: Object.freeze({ x: 0.6, z: 0.5, turn: 0 }),
  vbh: Object.freeze({ x: -0.44, z: 0.52, turn: -35 }),
  oh: Object.freeze({ x: 0.3, z: 0.3, turn: 0 }),
  sm: Object.freeze({ x: 0.24, z: 0.45, turn: 0 }), // smash: further in front, hit down through the ball
});

/** Stroke family for a contact: 'fh'|'bh'|'vfh'|'vbh'|'oh'. */
export function contactFamily(contact, kind, playerPos, handed = 'right', height = REF_HEIGHT) {
  const k = height / REF_HEIGHT;
  if (contact.y > 1.78 * k) return 'oh';
  const volley = kind === 'volley';
  const fh = volley ? 'vfh' : 'fh';
  const bh = volley ? 'vbh' : 'bh';
  if (!playerPos) return fh;
  const sf = idealStance(contact, fh, handed, height);
  const sb = idealStance(contact, bh, handed, height);
  const df = Math.hypot(sf.x - playerPos.x, sf.z - playerPos.z);
  const db = Math.hypot(sb.x - playerPos.x, sb.z - playerPos.z);
  return db + 0.45 < df ? bh : fh;
}

/** Court position (feet) that puts `contact` at the ideal contact point of `family`. */
export function idealStance(contact, family, handed = 'right', height = REF_HEIGHT) {
  const off = CONTACT_OFFSETS[family] || CONTACT_OFFSETS.fh;
  const k = height / REF_HEIGHT;
  const dom = handed === 'left' ? -1 : 1;
  return { x: contact.x - dom * off.x * k, z: contact.z + off.z * k };
}

/**
 * The contact a player would go for among interceptCandidates(), following the drill's intent
 * when known (hint.contact: 'overhead' | 'volley' | 'glass' | others = default preference).
 */
export function pickIntercept(cands, hint = null, height = REF_HEIGHT) {
  if (!cands || !cands.length) return null;
  const k = height / REF_HEIGHT;
  const want = hint && hint.contact;
  if (want === 'overhead') {
    const oh = cands.filter((c) => c.kind === 'volley' && c.height >= 1.85 * k && c.height <= 2.3 * k);
    if (oh.length) return oh.reduce((b, c) => (Math.abs(c.height - 2.08 * k) < Math.abs(b.height - 2.08 * k) ? c : b), oh[0]);
  } else if (want === 'volley') {
    const v = cands.filter((c) => c.kind === 'volley' && c.height >= 0.6 && c.height <= 1.7 * k);
    if (v.length) return v.reduce((b, c) => (c.travel + 0.8 * Math.abs(c.height - 1.2 * k) < b.travel + 0.8 * Math.abs(b.height - 1.2 * k) ? c : b), v[0]);
  } else if (want === 'glass') {
    const g = cands.filter((c) => c.kind === 'after-wall' && c.comfortable && !c.cramped);
    if (g.length) return g[0];
  }
  // Groundstroke: near the top of the bounce or a little after (the textbook contact), not
  // the first moment the ball rises into the comfortable band.
  const first = cands[0];
  if (want !== 'volley' && first.kind !== 'volley' && first.comfortable && !first.cramped) {
    const same = cands.filter((c) => c.kind === first.kind && c.comfortable && !c.cramped && c.t - first.t < 0.35);
    return same.reduce((b, c) => (Math.abs(c.height - 0.95 * k) < Math.abs(b.height - 0.95 * k) ? c : b), same[0]);
  }
  return first;
}

/**
 * Predicted contact and the stance that plays it for the incoming ball, or null:
 * { x, z (stance), t, family, contact: Vec3 }. Uses the drill's hints (world.mode.apHints).
 * Planned like the tactical home and the autopilot (game/intercept.js, QA2): only contacts that
 * have come off the back / side glass, a glass ball in its window off the glass, and stances
 * no deeper than STANCE_Z_MAX, so the assist magnet never pulls a player against the glass.
 */
export function interceptStance(world, { maxTime = 3 } = {}) {
  const pl = world.player;
  if (!world.ball) return null;
  const pred = predictFlight(world, { maxTime });
  const cands = playableCandidates(interceptCandidates(pred, {
    playerPos: pl.pos, side: 'near', now: world.time - (world.settings.latency || 0), minHeight: 0.3, maxHeight: 2.4,
  }));
  const m = world.mode;
  const hint = m && m.apHints ? m.apHints : null;
  const c = (hint && hint.contact === 'glass' && pickGlassContact(cands, pl.height)) || pickIntercept(cands, hint, pl.height);
  if (!c) return null;
  const handed = world.settings.handed || pl.handed;
  const fam = contactFamily(c.pos, c.kind, pl.pos, handed, pl.height);
  const s = idealStance(c.pos, fam, handed, pl.height);
  const b = stanceBounds();
  return { x: clamp(s.x, b.xMin, b.xMax), z: clamp(s.z, b.zMin, b.zMax), t: c.t, family: fam, contact: c.pos };
}

/** Maps a U point into the court for a player at (px, pz). */
export function uToCourt(u, px, pz, out = new Vec3()) {
  return out.set(px + u.x, u.y, pz - u.z);
}

/** Maps a U direction into the court. */
export function uDirToCourt(u, out = new Vec3()) {
  return out.set(u.x, u.y, -u.z);
}

const POS_HIST = 720; // 3 s of positions at 240 Hz
/** Court distance (m) the movement target must shift for the player to count as reacting. */
export const REACT_SHIFT = 0.15;
/** Minimum forward-swing time (s) from the end of the backswing to contact for "racket back early". */
export const PREP_MIN = { ground: 0.22, volley: 0.1 };
/** Max sweet-spot travel (m) per swept sub-segment, and the max number of sub-segments. */
export const SUB_SPACING = 0.12;
const SUB_MAX = 10;
/**
 * A predicted hit is undone when the camera's racket has been checked this far (s of capture
 * time) past the predicted contact without a contact (a whiff or a swing stopped short).
 */
export const WHIFF_WINDOW = 0.1;
/** Longest wait (s) of a speculative contact inside the assist margin for the face to meet the ball. */
const MARGIN_WAIT = 0.025;

/** Stroke label -> swing family of the predictor (learning the player's racket speed). */
const STROKE_FAMILY = {
  forehand: 'fh', backhand: 'bh', 'volley-fh': 'vfh', 'volley-bh': 'vbh', 'glass-fh': 'gfh', 'glass-bh': 'gbh',
  bandeja: 'oh', vibora: 'oh', smash: 'sm', serve: 'serve', lob: 'fh', chiquita: 'fh',
};

/**
 * @param {{settings: object}} o  settings as in world.DEFAULT_SETTINGS (live object; read on use)
 * @returns HumanController = { bodyTracker, locomotion, racketTrack, onPoseFrame(world, frame, simT),
 *   onRacketPose(world, poseCourt, simT), calibrate(), update(world, dt), checkHits(world),
 *   posAt(t, out?), moveTo({x,z}|null), state }
 */
export function createHumanController({ settings = {} } = {}) {
  const st = settings && settings.assist !== undefined ? settings : resolveSettings(settings);
  const bodyTracker = createBodyTracker({ hfovDeg: st.hfovDeg, userHeight: st.height, handed: st.handed });
  const locomotion = createLocomotion({ gainLateral: st.gainLateral, gainDepth: st.gainDepth });
  const racketTrack = createRacketTrack({ capacity: 240 });

  // Court position history, so racket poses map with the position at their capture time.
  const hT = new Float64Array(POS_HIST);
  const hX = new Float64Array(POS_HIST);
  const hZ = new Float64Array(POS_HIST);
  let hStart = 0, hLen = 0;

  let checkedUntil = -Infinity;
  let manualTarget = null; // fallback controls
  let lastSample = null;
  let stepClock = 0;
  let magnetKey = null;
  let magnetAt = -Infinity;
  const pose = createRacketPose();
  const subPoses = Array.from({ length: SUB_MAX + 1 }, createRacketPose);
  const ballA = blank();
  const ballB = blank();
  const tmpC = new Vec3();
  const state = { frames: 0, hits: 0, lastContact: null, lastShot: null, valid: false, speculative: 0 };
  // Predictive swing for display and speculative hits (swingPredict.js). With timing hits the swing
  // is completed to the contact the timing plan has chosen (game/swingAssist.js).
  const predictor = createSwingPredictor({ racketTrack, posAt, contactOffsets: CONTACT_OFFSETS, futurePos, contactPlan: timingContact });
  // Timing-based hitting (swingAssist.js): swings -> hits / misses, auto-positioning, cues.
  const judge = createTimingJudge({ racketTrack, posAt, prepTimeBefore: (c) => prepTimeBefore(c) });
  // What is drawn of the racket, arms and eye at render rate (swingView.js; never used for hits).
  const view = createSwingView({ racketTrack, posAt });
  let lastTarget = null; // court target the follow spring tracks (own steps + auto-positioning)
  const specBallPrev = blank();
  let pendingMargin = null; // speculative contact inside the assist margin only, waiting for the face
  let specPrevId = null;
  const planFamily = { key: null, fam: null };
  // Reaction: first real shift of the movement target after the opponent's stroke.
  const react = { key: null, x: 0, z: 0, t: null };

  function blank() {
    return { pos: new Vec3(), vel: new Vec3(), spin: new Vec3(), t: 0, outside: false, atRest: false, lastSurface: null, id: 0 };
  }

  function pushPos(t, x, z) {
    if (hLen && t <= hT[(hStart + hLen - 1) % POS_HIST]) {
      const i = (hStart + hLen - 1) % POS_HIST;
      hT[i] = t; hX[i] = x; hZ[i] = z;
      return;
    }
    const i = (hStart + hLen) % POS_HIST;
    hT[i] = t; hX[i] = x; hZ[i] = z;
    if (hLen < POS_HIST) hLen++;
    else hStart = (hStart + 1) % POS_HIST;
  }

  /** Player court position (x, z) at sim time t (linear interpolation of the history). */
  function posAt(t, out = { x: 0, z: 0 }) {
    if (!hLen) return null;
    const g = (k) => (hStart + k) % POS_HIST;
    if (t <= hT[g(0)]) { out.x = hX[g(0)]; out.z = hZ[g(0)]; return out; }
    const last = g(hLen - 1);
    if (t >= hT[last]) { out.x = hX[last]; out.z = hZ[last]; return out; }
    let lo = 0, hi = hLen - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (hT[g(mid)] <= t) lo = mid;
      else hi = mid;
    }
    const a = g(lo), b = g(hi);
    const u = (t - hT[a]) / (hT[b] - hT[a]);
    out.x = hX[a] + (hX[b] - hX[a]) * u;
    out.z = hZ[a] + (hZ[b] - hZ[a]) * u;
    return out;
  }

  /**
   * The player's court position `ahead` s from now: the critically damped follow (update())
   * toward the current movement target, without its speed / acceleration limits.
   */
  function futurePos(world, ahead, out = { x: 0, z: 0 }) {
    const pl = world.player;
    const tgt = manualTarget || lastTarget || locomotion.target;
    const k = PLAYER.followStiffness;
    const e = Math.exp(-k * ahead);
    const ex = pl.pos.x - tgt.x, ez = pl.pos.z - tgt.z;
    out.x = tgt.x + (ex + (pl.vel.x + k * ex) * ahead) * e;
    out.z = tgt.z + (ez + (pl.vel.z + k * ez) * ahead) * e;
    const b = defaultBounds();
    out.x = clamp(out.x, b.xMin, b.xMax);
    out.z = clamp(out.z, b.zMin, b.zMax);
    return out;
  }

  function playerPosAt(world, t) {
    return posAt(t) || { x: world.player.pos.x, z: world.player.pos.z };
  }

  /**
   * Court-frame body for the renderer, from a sample and a court position. The object and its
   * vectors are reused tick to tick (updated in place).
   */
  function buildBodyCourt(sample, px, pz, bc) {
    if (!bc) {
      bc = { joints: {}, handFrames: {}, dominant: 'R', eye: new Vec3() };
      for (const name of JOINT_NAMES) bc.joints[name] = new Vec3();
      for (const side of ['L', 'R']) bc.handFrames[side] = { grip: new Vec3(), axis: new Vec3(), normal: new Vec3() };
    }
    for (const name of JOINT_NAMES) {
      const j = sample.joints[name];
      if (j) uToCourt(j, px, pz, bc.joints[name]);
    }
    for (const side of ['L', 'R']) {
      const f = sample.handFrames[side];
      const o = bc.handFrames[side];
      uToCourt(f.grip, px, pz, o.grip);
      uDirToCourt(f.axis, o.axis);
      uDirToCourt(f.normal, o.normal);
    }
    const jl = sample.joints.eyeL, jr = sample.joints.eyeR;
    if (jl && jr) bc.eye.set(px + (jl.x + jr.x) / 2, (jl.y + jr.y) / 2, pz - (jl.z + jr.z) / 2);
    else bc.eye.set(px, sample.eyeHeight, pz);
    bc.dominant = sample.dominant;
    return bc;
  }

  // ---- pose input -----------------------------------------------------------

  /**
   * One camera frame. simT = sim time of the frame's capture (world clock, s).
   * Returns the BodySample (or null).
   */
  // Sim time of the last valid pose frame (world.js holds timing-erasable events only while frames come).
  let lastFrameAt = -Infinity;

  function onPoseFrame(world, frame, simT) {
    const sample = bodyTracker.update(frame);
    if (!sample) return null;
    lastSample = sample;
    state.frames++;
    state.valid = sample.valid;
    const pl = world.player;
    pl.body = sample;
    if (!sample.valid) return sample;
    lastFrameAt = world.time;

    const assist = ASSIST[world.settings.assist] || ASSIST[DEFAULT_ASSIST];
    locomotion.update(sample, 0, {
      bounds: defaultBounds(),
      magnet: pl.magnet,
      magnetStrength: pl.magnet ? assist.magnet : 0,
    });
    trackReaction(world, simT);

    // Racket pose in the court frame at the capture time.
    const pp = playerPosAt(world, simT);
    const hf = sample.handFrames[sample.dominant];
    uToCourt(hf.grip, pp.x, pp.z, pose.grip);
    uDirToCourt(hf.axis, pose.axis);
    uDirToCourt(hf.normal, pose.normal);
    racketTrack.push(simT, pose);
    view.onSample(sample, simT);
    if (timingConfig(world)) {
      const fStart = world.flight.startT;
      for (const shot of judge.onFrame(world)) afterHit(world, shot, null, null, fStart);
    } else checkHits(world);
    return sample;
  }

  /** The timing plan's contact for the swing predictor ({ t, pos, vel, fam }) or null. */
  function timingContact(world) {
    const T = world.timing;
    const P = T && T.plan;
    if (!P || !timingConfig(world) || P.key !== flightKeyOf(world)) return null;
    if (T.decided && T.decided.key === P.key) return null;
    return { t: P.tStar, pos: P.pStar, vel: P.vStar, fam: P.family };
  }

  /** Analytics and learning after a confirmed hit (physical or timing). */
  function afterHit(world, shot, fam, racketPose, flightStart) {
    const f = fam || (planFamily.key && planFamily.fam) || STROKE_FAMILY[shot.stroke];
    predictor.learn(world, shot, f);
    const rc = shot.swing && Number.isFinite(shot.swing.racketTime) ? shot.swing.racketTime : null;
    const rp = racketPose || (rc !== null ? racketTrack.sample(rc) : null);
    const shU = lastSample && lastSample.joints[lastSample.dominant === 'L' ? 'shoulderL' : 'shoulderR'];
    const pp = rc !== null ? playerPosAt(world, rc) : world.player.pos;
    if (shU && rp) predictor.learnFrame(world, f, rp, uToCourt(shU, pp.x, pp.z, tmpC.set(0, 0, 0)).clone());
    if (react.key === flightStart && react.t !== null) shot.reactionMs = Math.round(react.t * 1000);
    const prepTime = shot.swing ? shot.swing.prepTime : null;
    if (Number.isFinite(prepTime)) {
      const min = shot.volley || shot.stroke === 'serve' ? PREP_MIN.volley : PREP_MIN.ground;
      shot.prepOnTime = prepTime >= min;
    }
    state.hits++;
    state.lastShot = shot;
  }

  /**
   * Reaction time to the current flight: the capture time of the first frame whose movement
   * target left the spot it had when the opponent struck (or the machine fed), minus the
   * moment the player could see that stroke (stroke time + display latency).
   */
  function trackReaction(world, simT) {
    const f = world.flight;
    if (!world.ball || f.team === 0) return;
    const tg = locomotion.target;
    if (react.key !== f.startT) {
      react.key = f.startT;
      react.x = tg.x;
      react.z = tg.z;
      react.t = null;
      return;
    }
    if (react.t === null && Math.hypot(tg.x - react.x, tg.z - react.z) > REACT_SHIFT) {
      react.t = Math.max(0, simT - f.startT - (world.settings.latency || 0));
    }
  }

  /** Forward-swing time: contact minus the slowest racket moment of the preceding second. */
  function prepTimeBefore(tc) {
    let tMin = null, vMin = Infinity;
    for (let i = racketTrack.indexAt(tc); i >= 0; i--) {
      const p = racketTrack.get(i);
      if (p.t < tc - 1.0) break;
      if (p.t > tc - 0.04) continue;
      const v = p.vel.length();
      if (v < vMin) {
        vMin = v;
        tMin = p.t;
      }
    }
    return tMin === null ? null : tc - tMin;
  }

  /** Fallback (mouse) controls: a racket pose already in the court frame. */
  function onRacketPose(world, poseCourt, simT) {
    racketTrack.push(simT, poseCourt);
    checkHits(world);
  }

  /**
   * Stores the neutral spot (body.js calibrate). A close-mode calibration (upper body only) boosts
   * the movement gains for the smaller play area (locomotion.closeRangeBoost).
   */
  function calibrate() {
    const ok = bodyTracker.calibrate();
    if (ok) {
      const cal = bodyTracker.calibration;
      locomotion.setBoost(cal.mode === 'upper' ? closeRangeBoost(cal.d0) : null);
    }
    return ok;
  }

  /** Fallback movement target (court {x, z}) or null to return to camera control. */
  function moveTo(target) {
    manualTarget = target ? { x: target.x, z: target.z } : null;
  }

  // ---- hits -----------------------------------------------------------------

  /**
   * Lag compensation (SPEC §10.4): every settled racket segment [A, B] (capture times) is
   * swept against the ball at (tA - latency, tB - latency).
   */
  function checkHits(world) {
    const lat = world.settings.latency ?? TRACKING.latencyDefault;
    const assist = ASSIST[world.settings.assist] || ASSIST[DEFAULT_ASSIST];
    const settled = racketTrack.settledTime();
    const segs = racketTrack.segmentsSince(checkedUntil);
    const shots = [];
    const hist = world.ballHistory;
    const ballsFor = (A, B) => {
      const bA = hist.at(A.t - lat, ballA);
      const bB = hist.at(B.t - lat, ballB);
      if (!bA || !bB || bA.id !== bB.id || !world.ball || bA.id !== world.ball.id) return false;
      if (bA.atRest && bB.atRest) return false;
      const dA = tmpC.subVectors(bA.pos, A.sweet).length();
      const dB = tmpC.subVectors(bB.pos, B.sweet).length();
      const span = A.sweet.distanceTo(B.sweet) + bA.pos.distanceTo(bB.pos) + 0.6;
      return Math.min(dA, dB) <= span; // cheap reject: nowhere near the racket
    };
    // Swept test of one segment. A fast swing travels far between camera frames on a curved
    // path, so the segment is split at Hermite samples of the racket track (<= SUB_SPACING of
    // sweet-spot travel each) instead of one straight chord.
    const sweep = (A, B, margin) => {
      const n = clamp(Math.ceil(A.sweet.distanceTo(B.sweet) / SUB_SPACING), 1, SUB_MAX);
      if (n === 1) {
        if (!ballsFor(A, B)) return null;
        return sweptContact(A, B, ballA, ballB, margin);
      }
      for (let j = 0; j < n; j++) {
        const P0 = j === 0 ? A : racketTrack.sample(A.t + ((B.t - A.t) * j) / n, subPoses[j]);
        const P1 = j === n - 1 ? B : racketTrack.sample(A.t + ((B.t - A.t) * (j + 1)) / n, subPoses[j + 1]);
        if (!ballsFor(P0, P1)) continue;
        const c = sweptContact(P0, P1, ballA, ballB, margin);
        if (c) return c;
      }
      return null;
    };
    for (let i = 0; i < segs.length; i++) {
      const [A, B] = segs[i];
      if (B.t > settled + 1e-9) break;
      if (B.t - A.t > MAX_GAP || !ballsFor(A, B)) {
        checkedUntil = B.t;
        continue;
      }
      // The real face first; the assist margin only forgives genuine near-misses (a margin
      // contact triggers early, while the face is still turning toward the ball), so a
      // margin-only contact waits until the next segment shows whether the face really meets it.
      let c = sweep(A, B, 0);
      if (!c && assist.contactMargin > 0) {
        const cm = sweep(A, B, assist.contactMargin);
        if (cm) {
          const next = segs[i + 1];
          if (next && next[1].t <= settled + 1e-9) {
            if (next[1].t - next[0].t <= MAX_GAP && ballsFor(next[0], next[1])) c = sweep(next[0], next[1], 0);
            if (!c) c = cm;
          } else if (racketTrack.latest().t - B.t < 0.1) {
            break; // wait for one more settled pose
          } else c = cm;
        }
      }
      checkedUntil = B.t;
      if (!c) continue;
      if (c.t > B.t + 1e-9) checkedUntil = c.t; // matched in the next segment
      const tSim = c.t - lat;
      if (tSim - world.player.lastHitAt < HIT_COOLDOWN) continue;
      const pp = playerPosAt(world, c.t);
      state.lastContact = c;
      const flightKey = world.flight.startT;
      const fk = world.ball ? `${world.ball.id}:${world.flight.startT}` : null;
      const prepTime = prepTimeBefore(c.t);
      const shot = applyPlayerHit(world, c, c.pose, tSim, {
        playerPos: { x: pp.x, z: pp.z },
        swing: { peakSpeed: racketTrack.peakSpeed(c.t - 0.3, c.t + 0.05), racketTime: c.t, prepTime },
      });
      if (shot) {
        // The player's own swing speed, for the predicted swings to come.
        const fam = (planFamily.key === fk && planFamily.fam) || STROKE_FAMILY[shot.stroke];
        predictor.learn(world, shot, fam);
        const shU = lastSample && lastSample.joints[lastSample.dominant === 'L' ? 'shoulderL' : 'shoulderR'];
        if (shU) predictor.learnFrame(world, fam, c.pose, uToCourt(shU, pp.x, pp.z, tmpC.set(0, 0, 0)).clone());
        // Session analytics (SPEC §5.5): reaction to the incoming ball and racket preparation.
        if (react.key === flightKey && react.t !== null) shot.reactionMs = Math.round(react.t * 1000);
        if (prepTime !== null) {
          const min = shot.volley || shot.stroke === 'serve' ? PREP_MIN.volley : PREP_MIN.ground;
          shot.prepOnTime = prepTime >= min;
        }
        state.hits++;
        state.lastShot = shot;
        shots.push(shot);
      }
    }
    return shots;
  }

  // ---- prediction -------------------------------------------------------------

  /**
   * After each tick's ball physics: the predicted display racket for world.time, a
   * speculative hit when it meets the ball, and the undoing of one the camera did not confirm.
   */
  function afterStep(world, dt) {
    const pose = predictor.update(world);
    const pl = world.player;
    // The racket drawn this frame: render-rate, smoothed, swing-aware (swingView.js). Mouse play
    // draws the predictor's pose as before (the pointer is already smooth and must not lag).
    const shown = world.input === 'fallback' || manualTarget ? pose : view.racket(world, predictor);
    if (shown) {
      if (!pl.renderRacket) pl.renderRacket = createRacketPose();
      copyRacketPose(pl.renderRacket, shown);
    } else pl.renderRacket = null;
    const evs = view.drainEvents();
    if (evs) for (const e of evs) emitView(world, 'player:swing', e);
    const plan = predictor.plan;
    if (plan && !plan.dead) {
      planFamily.key = plan.key;
      planFamily.fam = plan.fam;
    }
    const b = world.ball;
    const timing = !!timingConfig(world);
    // Timing hits: the strike at t*, the magnetized racket, cues and the window are the judge's.
    if (timing) {
      judge.afterStep(world, { predictor, dt });
      // The drawn racket continues its swing from the strike frame (swingView follow-through).
      const M = world.timing && world.timing.magnet;
      if (M && !M.handled && shown && shown === view.lastShown) {
        view.onStrike(world, M.pose, predictor.plan);
        M.handled = true;
      }
    }
    // Speculative contact: the shown racket (previous tick -> now) against the ball over the same tick.
    if (!timing && b && !world.spec && plan && !plan.struck && specPrevId === b.id) {
      const assist = ASSIST[world.settings.assist] || ASSIST[DEFAULT_ASSIST];
      // The real face first. A contact only inside the assist margin waits while the ball is
      // still closing in the margin (it then strikes on the strings, not 10 cm early) and is
      // taken once the ball leaves the margin without touching the face (a forgiven near miss).
      let c = predictor.detect(world, specBallPrev, b, 0);
      if (pendingMargin && pendingMargin.plan.key !== plan.key) pendingMargin = null;
      if (!c && assist.contactMargin > 0) {
        const cm = predictor.detect(world, specBallPrev, b, assist.contactMargin);
        if (pendingMargin && (!cm || world.time - pendingMargin.seenAt >= MARGIN_WAIT)) c = pendingMargin;
        else if (!pendingMargin && cm) {
          pendingMargin = cm;
          cm.seenAt = world.time;
        }
      }
      if (c) pendingMargin = null;
      if (c) {
        const pp = posAt(c.t + (world.settings.latency ?? 0)) || pl.pos;
        const shot = applySpeculativeHit(world, c, c.pose, c.t, {
          playerPos: { x: pp.x, z: pp.z }, cStar: c.plan.cStar,
          plan: { fam: c.plan.fam, D: c.plan.D, rho0: c.plan.rho0, rho1: c.plan.rho1, miss: c.plan.miss, speed: c.plan.speed },
        });
        if (shot) {
          predictor.strike();
          state.speculative++;
        }
      }
    }
    if (b) {
      specBallPrev.pos.copy(b.pos);
      specBallPrev.vel.copy(b.vel);
      specBallPrev.t = b.t;
      specBallPrev.id = b.id;
      specBallPrev.atRest = b.atRest;
      specPrevId = b.id;
    } else specPrevId = null;
    // No contact where the prediction struck: the camera has shown the swing past it.
    const sp = world.spec;
    if (!timing && sp && checkedUntil >= sp.cStar + WHIFF_WINDOW) revertSpeculative(world, 'whiff');
  }

  /** Ball time of the contact the predicted swing is going for (current flight), or null. */
  function predictedContact(world) {
    const plan = predictor.plan;
    if (!plan || plan.dead || !world.ball) return null;
    return plan.key === `${world.ball.id}:${world.flight.startT}` ? plan.tStar : null;
  }

  // ---- movement ---------------------------------------------------------------

  /** A live ball the player may be playing (coming to them, or just struck by them). */
  function playingBall(world) {
    const b = world.ball;
    if (!b || b.atRest || b.outside) return false;
    if (world.flight.team !== 0 || world.flight.by === 'drop') return true;
    return world.time - world.player.lastHitAt < 0.8;
  }

  function updateMagnet(world) {
    const pl = world.player;
    const ball = world.ball;
    const strength = (ASSIST[world.settings.assist] || ASSIST[DEFAULT_ASSIST]).magnet;
    if (!ball || !(strength > 0) || ball.atRest || world.flight.team === 0) {
      pl.magnet = null;
      magnetKey = null;
      return;
    }
    const key = `${ball.id}:${world.flight.startT}`;
    if (key === magnetKey && world.time - magnetAt < 0.25) return;
    // Committed to the contact (< 0.6 s away): keep pulling toward it.
    if (key === magnetKey && pl.magnet && pl.magnet.t - world.time < 0.6) return;
    magnetKey = key;
    magnetAt = world.time;
    const ic = interceptStance(world);
    pl.magnet = ic ? { x: ic.x, z: ic.z, t: ic.t, family: ic.family } : null;
  }

  /**
   * Fixed tick: follows the locomotion target with a critically damped spring
   * (PLAYER.followStiffness, maxAccel, maxSpeed), updates the eye and the court body,
   * emits 'player:step' at a running cadence.
   */
  function update(world, dt) {
    const pl = world.player;
    const lh = locomotion.home;
    // A gliding (tactical) home carries the player's own offset along; a new home snaps.
    if ((pl.home.x !== lh.x || pl.home.z !== lh.z) && !pl.snapToHome) locomotion.moveHome(pl.home);
    if (pl.snapToHome) {
      view.reset(); // a teleport is no motion to smooth
      locomotion.setHome(pl.home);
      pl.pos.set(pl.home.x, 0, pl.home.z);
      pl.vel.set(0, 0, 0);
      pl.snapToHome = false;
    }
    const tcfg = timingConfig(world);
    let tgt;
    if (tcfg) {
      // Timing hits: the contact plan and auto-positioning toward its stance replace the magnet.
      judge.update(world, dt);
      pl.magnet = null;
      magnetKey = null;
      tgt = manualTarget || judge.autoTarget(world, locomotion.target, dt, tcfg);
    } else {
      updateMagnet(world);
      tgt = manualTarget || locomotion.target;
    }
    lastTarget = tgt;
    // Pitch fit (body.js TILT) only from upright moments: no ball on its way to the player.
    bodyTracker.setUpright(!playingBall(world));
    const k = PLAYER.followStiffness;
    let ax = k * k * (tgt.x - pl.pos.x) - 2 * k * pl.vel.x;
    let az = k * k * (tgt.z - pl.pos.z) - 2 * k * pl.vel.z;
    const a = Math.hypot(ax, az);
    if (a > PLAYER.maxAccel) {
      ax *= PLAYER.maxAccel / a;
      az *= PLAYER.maxAccel / a;
    }
    pl.vel.x += ax * dt;
    pl.vel.z += az * dt;
    const v = Math.hypot(pl.vel.x, pl.vel.z);
    if (v > PLAYER.maxSpeed) {
      pl.vel.x *= PLAYER.maxSpeed / v;
      pl.vel.z *= PLAYER.maxSpeed / v;
    }
    pl.pos.x += pl.vel.x * dt;
    pl.pos.z += pl.vel.z * dt;
    const b = defaultBounds();
    if (pl.pos.x < b.xMin || pl.pos.x > b.xMax) { pl.pos.x = clamp(pl.pos.x, b.xMin, b.xMax); pl.vel.x = 0; }
    if (pl.pos.z < b.zMin || pl.pos.z > b.zMax) { pl.pos.z = clamp(pl.pos.z, b.zMin, b.zMax); pl.vel.z = 0; }
    pl.speed = Math.hypot(pl.vel.x, pl.vel.z);
    pushPos(world.time + dt, pl.pos.x, pl.pos.z);

    // Eye and court-frame body (render), from the newest sample at the current position: carried
    // between camera frames and smoothed across them (swingView.js), so arms and view move at
    // render rate.
    const latest = racketTrack.latest();
    if (lastSample && lastSample.valid && !manualTarget) {
      const sj = view.joints(world);
      pl.bodyCourt = buildBodyCourt(sj && sj.joints.eyeL ? sj : lastSample, pl.pos.x, pl.pos.z, pl.bodyCourt);
      pl.eye.copy(pl.bodyCourt.eye);
      const hf = pl.bodyCourt.handFrames[lastSample.dominant];
      if (!pl.racket) pl.racket = createRacketPose();
      if (latest) copyRacketPose(pl.racket, latest);
      pl.racket.grip.copy(hf.grip);
      pl.racket.axis.copy(hf.axis);
      pl.racket.normal.copy(hf.normal);
    } else {
      pl.eye.set(pl.pos.x, pl.height * PLAYER.eyeHeightRatio, pl.pos.z);
      if (manualTarget && latest) {
        if (!pl.racket) pl.racket = createRacketPose();
        copyRacketPose(pl.racket, latest);
      }
    }

    // Footsteps: cadence rises with speed (about 2 steps/s jogging, 4.5/s sprinting).
    if (pl.speed > 0.5) {
      stepClock += dt * clamp(1.6 + 0.45 * pl.speed, 1.8, 4.6);
      if (stepClock >= 1) {
        stepClock -= 1;
        emit(world, 'player:step', { pos: pl.pos.clone(), speed: pl.speed });
      }
    } else stepClock = 0.6;
  }

  return {
    bodyTracker,
    locomotion,
    racketTrack,
    onPoseFrame,
    onRacketPose,
    calibrate,
    update,
    afterStep,
    predictedContact,
    predictor,
    checkHits,
    posAt,
    moveTo,
    get state() {
      return state;
    },
    get lastFrameAt() {
      return lastFrameAt;
    },
    /** The render-rate racket / arm view (swingView.js): stats, shown speed. */
    view,
  };
}

