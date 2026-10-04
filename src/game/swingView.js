// What the player sees of their own racket and arms, every display frame (round 4: "can we make
// the swinging a bit more smooth?"). The camera delivers a pose 30 times a second, 0.15–0.3 s
// late; the predicted racket (swingPredict.js) re-extrapolated the newest pose by that whole loop
// at every frame, so the drawn racket stepped at 30 Hz and its face flipped by tens of degrees
// when a noisy angular velocity was carried 0.26 s ahead. This layer draws instead:
//
//  1. Render-rate interpolation. A render anchor trails the newest capture by a fraction of a frame
//     interval (latency-aware: the measured arrival age of the frames) and runs continuously; the
//     racket is the Hermite track sampled there (bounded extrapolation past the newest pose when a
//     frame is late), then led to the moment the player sees: along an arc about the hitting
//     shoulder during a swing (rigid rotation from the sweet spot's motion about the shoulder, not
//     the hand's noisy spin), barely at all at rest. The predictor's planned swing (the stroke at
//     the incoming ball) is blended in with the predictor's own weight.
//  2. Discontinuity absorption. A new camera pose re-shapes the curve; the jump is taken into an
//     offset that decays as a critically damped spring (position and velocity continuous). At rest
//     the spring is soft (a spring-damper on the racket: jitter disappears); in a swing it is stiff.
//  3. Swing-aware follow-through. When the planned swing releases, or a pose comes back stale (a
//     blurred wrist lags the swing), the racket coasts on along its arc with decaying angular speed
//     until the camera catches up, then hands back to the track.
//  4. 'player:swing' events (start / peak / end, sweet-spot speed and position of the SHOWN racket,
//     so sound and trails match what is seen).
//  5. The arms and the eye: the tracked joints are carried forward between frames (bounded) and
//     each new frame's jump decays the same way, so the arms and the view move at render rate too.
//
// Hits never use any of this (racketTrack, the timing judge and the swept contact are untouched).
// Pure module; all times are sim seconds, poses COURT frame.

import { Vec3 } from '../util/vec3.js';
import { clamp, smoothstep } from '../util/math.js';
import { RACKET } from '../config.js';
import { createRacketPose, copyRacketPose, extrapolatePose, blendRacketPose, rotateAboutAxis } from '../tracking/racketTrack.js';
import { JOINT_NAMES } from '../tracking/body.js';

export const VIEW = Object.freeze({
  /** Render anchor behind the newest capture (frame intervals), and the bounded extrapolation past it (s). */
  buffer: 0.6,
  maxExtrap: 0.05,
  /** Lead to the moment seen: damping (1/s), sweet-spot travel cap (m), rotation caps (rad) at rest / in a swing. */
  lead: Object.freeze({ damping: 6, maxTravel: 0.35, maxAngleRest: 0.08, maxAngleSwing: 1.1, velTau: 0.07 }),
  /**
   * Body-relative sweet-spot speed (m/s): below `rest` the racket is at rest, above `swing` it
   * swings; `rest` rises to noiseRest x the median speed of the last ~2 s (the camera's jitter).
   */
  rest: 0.6,
  move: 2.0,
  swing: 4.0,
  noiseRest: 1.8,
  /** Spring rates (rad/s) of the absorbed offset: at rest, moving, and for the arm joints / eye. */
  omegaRest: 8,
  /**
   * Noise-adaptive rest smoothing (round 5, QA r5: at twice the synthetic webcam noise the resting
   * racket shook 3.5°/frame): the shown pose is blended, by the rest weight, toward a low-passed copy
   * of itself whose cut-off (Hz) falls from restCut toward restCutMin as the camera's noise floor
   * rises above noiseRef (m/s). A swing (rest weight 0) is never delayed.
   */
  noiseRef: 0.7,
  restCut: 4,
  restCutMin: 1.0,
  restBeta: 8,
  omegaMove: 40,
  omegaJoints: 24,
  /** Single-tick mismatch (m) taken into the offset between camera poses (a re-made plan, a weight step). */
  absorb: 0.008,
  /** Offset beyond which the view snaps (a teleport), m; large offsets converge faster instead. */
  snap: 3,
  /**
   * Follow-through coast: decay of the angular speed (1/s), largest sweep (rad), hand-back blend (s),
   * longest coast (s), least shown speed (m/s); a camera pose is stale when the racket covered less
   * than `stall` of its previous frame's travel at more than stallSpeed m/s.
   */
  coast: Object.freeze({ decay: 2.5, maxSweep: 2.6, blend: 0.2, maxAge: 0.3, followAge: 0.7, minSpeed: 3.0, stall: 0.45, stallSpeed: 6 }),
  /** player:swing: start above `start` m/s (re-armed below `arm`), peak when it falls under peakFall x peak, end below `end`. */
  events: Object.freeze({ start: 4.0, arm: 1.5, peakFall: 0.85, end: 2.0, minPeak: 5.0, maxDur: 1.0, settle: 0.4 }),
  /** Arm joints: longest carry-forward past the newest pose (s). */
  jointsExtrap: 0.05,
});

const SWEET = RACKET.sweetSpotY;
const HAND_SET = new Set(['wristL', 'wristR', 'indexL', 'indexR', 'pinkyL', 'pinkyR', 'thumbL', 'thumbR']);
/** Capture time past the contact (s) the camera must have shown before a follow-through hands back. */
const C_SEEN = 0.05;
const isNum = Number.isFinite;
const finiteV = (v) => isNum(v.x) && isNum(v.y) && isNum(v.z);

/** Critically damped decay of an offset e with rate w over dt (exact), velocity ev; in place. */
function springStep(e, ev, w, dt) {
  const k = Math.exp(-w * dt);
  const ax = ev.x + w * e.x, ay = ev.y + w * e.y, az = ev.z + w * e.z;
  e.set((e.x + ax * dt) * k, (e.y + ay * dt) * k, (e.z + az * dt) * k);
  ev.set((ev.x - w * ax * dt) * k, (ev.y - w * ay * dt) * k, (ev.z - w * az * dt) * k);
}

// Racket frame quaternion (columns X = Y x Z, Y = axis, Z = normal) and the rotation vector between two.
function frameQuat(axis, normal, q) {
  const yx = axis.x, yy = axis.y, yz = axis.z, zx = normal.x, zy = normal.y, zz = normal.z;
  const xx = yy * zz - yz * zy, xy = yz * zx - yx * zz, xz = yx * zy - yy * zx;
  const tr = xx + yy + zz;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    q.w = 0.25 / s; q.x = (yz - zy) * s; q.y = (zx - xz) * s; q.z = (xy - yx) * s;
  } else if (xx > yy && xx > zz) {
    const s = 2 * Math.sqrt(1 + xx - yy - zz);
    q.w = (yz - zy) / s; q.x = 0.25 * s; q.y = (yx + xy) / s; q.z = (zx + xz) / s;
  } else if (yy > zz) {
    const s = 2 * Math.sqrt(1 + yy - xx - zz);
    q.w = (zx - xz) / s; q.x = (yx + xy) / s; q.y = 0.25 * s; q.z = (zy + yz) / s;
  } else {
    const s = 2 * Math.sqrt(1 + zz - xx - yy);
    q.w = (xy - yx) / s; q.x = (zx + xz) / s; q.y = (zy + yz) / s; q.z = 0.25 * s;
  }
  return q;
}

/** Rotation vector (world, |v| <= PI) taking frame a (axis, normal) to frame b. */
function rotBetween(aAxis, aNormal, bAxis, bNormal, out) {
  frameQuat(aAxis, aNormal, _qa);
  frameQuat(bAxis, bNormal, _qb);
  const ax = -_qa.x, ay = -_qa.y, az = -_qa.z, aw = _qa.w;
  let w = _qb.w * aw - (_qb.x * ax + _qb.y * ay + _qb.z * az);
  let x = _qb.w * ax + aw * _qb.x + (_qb.y * az - _qb.z * ay);
  let y = _qb.w * ay + aw * _qb.y + (_qb.z * ax - _qb.x * az);
  let z = _qb.w * az + aw * _qb.z + (_qb.x * ay - _qb.y * ax);
  if (w < 0) { w = -w; x = -x; y = -y; z = -z; }
  const s = Math.hypot(x, y, z);
  if (s < 1e-12) return out.set(2 * x, 2 * y, 2 * z);
  const ang = 2 * Math.atan2(s, w);
  return out.set((x / s) * ang, (y / s) * ang, (z / s) * ang);
}
const _qa = { x: 0, y: 0, z: 0, w: 1 }, _qb = { x: 0, y: 0, z: 0, w: 1 };

/** Rotates a pose's axis / normal (in place) by rotation vector r. */
function rotatePoseBy(p, r) {
  const a = Math.hypot(r.x, r.y, r.z);
  if (!(a > 1e-9)) return p;
  _rk.set(r.x / a, r.y / a, r.z / a);
  rotateAboutAxis(p.axis, _rk, a, p.axis).normalize();
  rotateAboutAxis(p.normal, _rk, a, p.normal);
  p.normal.addScaled(p.axis, -p.normal.dot(p.axis)).normalize();
  return p;
}
const _rk = new Vec3();

/**
 * Lead of a racket pose along an arc about centre S: the sweet spot's motion relative to the body
 * (vRel) about S gives the angular velocity w = r x v / |r|^2 (rigid swing of arm and racket), held
 * for `E` s with exponential damping and capped; the body's own velocity bodyV moves it along too.
 */
function arcLead(src, S, vRel, bodyV, E, { damping, maxTravel, maxAngle }, out) {
  copyRacketPose(out, src);
  if (!(E > 0)) return out;
  const fe = damping > 0 ? (1 - Math.exp(-damping * E)) / damping : E;
  _r.subVectors(src.sweet, S);
  const r2 = _r.lengthSq();
  if (r2 > 0.01) {
    _w.crossVectors(_r, vRel).scale(1 / r2);
    const wl = _w.length();
    // Soft caps (the lead eases into its limit: a hard clamp turns a swing's onset into a burst
    // then a dip).
    const cap = Math.min(maxAngle, maxTravel / Math.sqrt(r2));
    const ang = cap * Math.tanh((wl * fe) / cap);
    if (wl > 1e-6 && ang > 1e-6) {
      _k.copy(_w).scale(1 / wl);
      rotateAboutAxis(_r, _k, ang, _r);
      out.sweet.addVectors(S, _r);
      rotateAboutAxis(src.axis, _k, ang, out.axis).normalize();
      rotateAboutAxis(src.normal, _k, ang, out.normal);
      out.normal.addScaled(out.axis, -out.normal.dot(out.axis)).normalize();
      const decay = Math.exp(-damping * E);
      out.vel.crossVectors(_w, _r).scale(decay);
      out.angVel.copy(_w).scale(decay);
    } else {
      out.vel.set(0, 0, 0);
      out.angVel.set(0, 0, 0);
    }
  }
  const bt = Math.min(fe, 0.2);
  out.sweet.addScaled(bodyV, bt);
  out.vel.add(bodyV);
  out.grip.copy(out.sweet).addScaled(out.axis, -SWEET);
  out.t = src.t + E;
  return out;
}
const _r = new Vec3(), _w = new Vec3(), _k = new Vec3();

/**
 * @param o.racketTrack the human controller's court racket track (camera poses, sim capture time)
 * @param o.posAt (t, out?) -> {x, z} court position history
 * @returns SwingView = { onSample(sample, simT), racket(world, predictor) -> RacketPose|null,
 *   joints(world) -> { joints (U), handFrames (U), t } | null, drainEvents() -> [], reset(), stats }
 */
export function createSwingView({ racketTrack, posAt }) {
  // --- render clock -----------------------------------------------------------------
  let lastLatestT = null; // capture time of the newest racket pose seen
  let ageEst = null; // EMA of a pose's age (sim s) when it arrives
  let frameDt = 1 / 30; // EMA of the capture interval
  let lastT = null;
  let tickDt = 0;
  // --- racket view ------------------------------------------------------------------
  const base = createRacketPose();
  const kin = createRacketPose();
  const planPose = createRacketPose();
  const target = createRacketPose();
  const prevTarget = createRacketPose();
  let hasPrev = false;
  const shown = createRacketPose();
  let hasShown = false;
  const errP = new Vec3(), errV = new Vec3(), errR = new Vec3(), errW = new Vec3();
  const tmp = new Vec3(), tmp2 = new Vec3(), cont = createRacketPose();
  const vRel = new Vec3(), bodyV = new Vec3(), shoulder = new Vec3(), vLead = new Vec3();
  const pA = { x: 0, z: 0 }, pB = { x: 0, z: 0 }, pC = { x: 0, z: 0 };
  // Follow-through coast.
  const coast = {
    on: false, t0: 0, w: 0, from: createRacketPose(), S: new Vec3(), axis: new Vec3(), omega: 0, swept: 0, fading: false, fadeT0: 0, reason: '',
    seenAfter: null, trackPeak: 0, trackDone: false,
  };
  const coastPose = createRacketPose();
  const rs = { ok: false, sweet: new Vec3(), axis: new Vec3(0, 1, 0), normal: new Vec3(0, 0, 1) };
  let prevPlan = null;
  let releasedKey = null;
  // Shown racket motion (events, coast start).
  const prevSweet = new Vec3();
  let hasPrevSweet = false;
  const shownVel = new Vec3();
  let shownSpeed = 0;
  // Merge pass: no swing events until the shown racket has settled after a reset (a session start
  // teleports the player home: the camera's older poses still sit at the old spot, and the drawn
  // racket crossing to the new one read as a 35-350 m/s "swing" in the workout recap and the whoosh).
  let settleUntil = null;
  const ev = { phase: 'idle', armed: true, peak: 0, t0: 0, peakAt: 0, peakPos: new Vec3() };
  const events = [];
  // Latest body samples (U) for the shoulder and the joints.
  const hist = []; // [{ t, J: {name: Vec3}, hf: { L, R }, handVis }]
  const stats = { absorbed: 0, snapped: 0, coasts: 0, staleCoasts: 0, releaseCoasts: 0, coastTicks: 0, events: 0 };

  // ---------------------------------------------------------------------------------
  // Body samples (joints, hand frames) for the arms, the eye and the swing centre.

  function onSample(sample, simT) {
    if (!sample || !sample.joints) return;
    const rec = hist.length >= 3 ? hist.shift() : { t: 0, J: {}, hf: { L: newHF(), R: newHF() } };
    rec.t = simT;
    for (const name of JOINT_NAMES) {
      const j = sample.joints[name];
      if (!j) continue;
      (rec.J[name] || (rec.J[name] = new Vec3())).copy(j);
    }
    for (const s of ['L', 'R']) {
      const f = sample.handFrames && sample.handFrames[s];
      if (!f) continue;
      rec.hf[s].grip.copy(f.grip);
      rec.hf[s].axis.copy(f.axis);
      rec.hf[s].normal.copy(f.normal);
    }
    rec.dominant = sample.dominant;
    rec.handVis = sample.handVis || null;
    hist.push(rec);
  }
  const newHF = () => ({ grip: new Vec3(), axis: new Vec3(0, 1, 0), normal: new Vec3(0, 0, 1) });

  /** Hitting shoulder relative to the body's court position (U -> court axes), newest sample. */
  function shoulderRel(dom, out) {
    const h = hist[hist.length - 1];
    if (!h) return null;
    const s = h.J[dom === 'L' ? 'shoulderL' : 'shoulderR'];
    if (!s) return null;
    return out.set(s.x, s.y, -s.z);
  }
  const ZERO = new Vec3();

  // Noise floor of the tracked racket's body-relative speed: the median of the last ~2 s of frames.
  const noise = { buf: new Float64Array(64), n: 0, i: 0, floor: 0, sorted: new Float64Array(64) };
  function noteSpeed(v) {
    if (!isNum(v)) return;
    noise.buf[noise.i] = v;
    noise.i = (noise.i + 1) % noise.buf.length;
    if (noise.n < noise.buf.length) noise.n++;
    if (noise.n >= 8) {
      for (let k = 0; k < noise.n; k++) noise.sorted[k] = noise.buf[k];
      const a = noise.sorted.subarray(0, noise.n).sort();
      noise.floor = a[noise.n >> 1];
    }
  }

  /** Player court velocity at capture time t (finite difference of the history). */
  function bodyVelAt(t, out) {
    const a = posAt(t - 0.02, pA), b = posAt(t + 0.02, pB);
    if (!a || !b) return out.set(0, 0, 0);
    return out.set((b.x - a.x) / 0.04, 0, (b.z - a.z) / 0.04);
  }

  // ---------------------------------------------------------------------------------
  // Racket

  /**
   * The racket to draw at world.time (or null without tracking). predictor: the swing predictor
   * (its plan and blend weight are honoured; its own display pose is not used).
   */
  function racket(world, predictor = null) {
    const T = world.time;
    const L = racketTrack.latest();
    if (!L) {
      hasShown = hasPrev = false;
      lastT = null;
      return null;
    }
    if (settleUntil === null) settleUntil = T + VIEW.events.settle;
    const dt = lastT === null ? 0 : clamp(T - lastT, 0, 0.1);
    lastT = T;
    tickDt = dt;
    const lat = world.settings.latency ?? 0;
    const tau = T + lat;
    const dom = world.settings.handed === 'left' || world.player.handed === 'left' ? 'L' : 'R';

    // Render clock: the newest capture time runs continuously at T - age.
    let fresh = false;
    if (L.t !== lastLatestT) {
      if (lastLatestT !== null && L.t > lastLatestT) frameDt += (clamp(L.t - lastLatestT, 1 / 120, 0.2) - frameDt) * 0.2;
      const age = T - L.t;
      ageEst = ageEst === null || age > ageEst + 0.25 || age < ageEst - 0.25 ? age : ageEst + (age - ageEst) * 0.15;
      lastLatestT = L.t;
      fresh = true;
    }
    const newest = T - ageEst;
    const ta = Math.min(newest - VIEW.buffer * frameDt, L.t + VIEW.maxExtrap);
    if (ta <= L.t) racketTrack.sample(ta, base);
    else extrapolatePose(L, ta - L.t, base, { damping: 8, maxTravel: 0.12, maxAngle: 0.15 });

    // Swing state of the tracked racket: sweet-spot velocity relative to the body, against the
    // camera's own jitter (a noisy webcam makes a still racket "move" at 1-2 m/s).
    bodyVelAt(ta, bodyV);
    vRel.copy(base.vel).sub(bodyV);
    const speedRel = vRel.length();
    if (fresh) noteSpeed(speedRel);
    const restT = Math.max(VIEW.rest, VIEW.noiseRest * noise.floor);
    const moveT = Math.max(VIEW.move, restT + 1.4);
    const swingT = Math.max(VIEW.swing, moveT + 2);
    const swingW = smoothstep(moveT, swingT, speedRel);
    const restW = 1 - smoothstep(restT, moveT, speedRel);
    // Body-relative from here on: the racket goes where the body is NOW (the eye and the arms are
    // drawn at the current court position; a glide or a teleport must not leave it behind).
    const pTa = posAt(ta, pA) || world.player.pos;
    base.sweet.x -= pTa.x; base.sweet.z -= pTa.z;
    base.grip.x -= pTa.x; base.grip.z -= pTa.z;
    const S = shoulderRel(dom, shoulder) || shoulder.copy(base.sweet).addScaled(base.axis, -0.75);

    // Lead to the moment the player sees: an arc about the shoulder, scaled down toward rest.
    const E = Math.max(0, tau - ta);
    const L0 = VIEW.lead;
    // The lead follows a lightly low-passed velocity (a 30 Hz derivative carried 0.3 s ahead wobbles).
    if (dt > 0) vLead.lerp(vRel, 1 - Math.exp(-dt / L0.velTau));
    else vLead.copy(vRel);
    vRel.copy(vLead).scale(smoothstep(restT, moveT, vLead.length()));
    arcLead(base, S, vRel, ZERO, E, {
      damping: L0.damping, maxTravel: L0.maxTravel, maxAngle: L0.maxAngleRest + (L0.maxAngleSwing - L0.maxAngleRest) * swingW,
    }, kin);
    const pl = world.player;
    kin.sweet.x += pl.pos.x; kin.sweet.z += pl.pos.z;
    kin.grip.x += pl.pos.x; kin.grip.z += pl.pos.z;
    kin.vel.x += pl.vel.x; kin.vel.z += pl.vel.z;
    S.x += pl.pos.x; S.z += pl.pos.z;

    // The predictor's planned stroke at the incoming ball, with its own blend weight.
    const plan = predictor && predictor.plan;
    const mix = plan && predictor.mix > 0 ? predictor.mix : 0;
    if (mix > 0 && predictor.poseOfPlan) {
      predictor.poseOfPlan(plan, tau, planPose);
      blendRacketPose(kin, planPose, mix, target);
    } else copyRacketPose(target, kin);

    // Follow-through coast (swing-aware motion): the planned swing releases, or a camera pose
    // comes back stale while the shown racket swings.
    const shownW = shownSpeed;
    const coasts0 = stats.coasts;
    if (plan && plan.struck && plan.key !== releasedKey && isNum(plan.cStar) && tau >= plan.cStar && predictor.poseOfPlan) {
      // The predicted stroke met the ball: the follow-through continues the planned arc.
      releasedKey = plan.key;
      startFollow(world, T, plan, predictor);
    }
    // Every fresh camera pose is checked (a running coast hands back on the first good one).
    const staleFrame = fresh && hasShown && staleSample(dom);
    if (staleFrame && !coast.on && shownW > VIEW.coast.minSpeed + 2 && mix < 0.5) {
      // A camera pose that stalls the swing (a blurred, lagging wrist): the racket coasts on.
      startCoast(world, T, S, 'stale');
    }
    const coastStarted = stats.coasts !== coasts0;
    // While a follow-through runs, watch the camera's own swing: it hands back after the real
    // swing's peak has been seen (a late real swing must not replay after the predicted one).
    if (coast.on && coast.reason === 'follow' && fresh && isNum(coast.seenAfter) && L.t >= coast.seenAfter - 0.4) {
      if (speedRel > coast.trackPeak) coast.trackPeak = speedRel;
      if (coast.trackPeak > swingT && speedRel < 0.45 * coast.trackPeak) coast.trackDone = true;
      if (L.t > coast.seenAfter + 0.3 && coast.trackPeak <= swingT) coast.trackDone = true;
    }
    let coastW = 0;
    if (coast.on) {
      // A planned swing at the ball takes over from a stale-pose coast.
      if (coast.reason === 'stale' && mix >= 0.5 && !coast.fading) {
        coast.fading = true;
        coast.fadeT0 = T;
      }
      coastW = coastStep(T, dt, target, fresh && !staleNow, world.player.pos, world.player.vel);
      if (coastW > 0) blendRacketPose(target, coastPose, coastW, target);
    }

    // Discontinuity absorption and the rest spring.
    if (!hasShown || !finiteV(target.sweet)) {
      errP.set(0, 0, 0); errV.set(0, 0, 0); errR.set(0, 0, 0); errW.set(0, 0, 0);
    } else if (hasPrev) {
      continuation(prevTarget, dt, cont);
      tmp.subVectors(cont.sweet, target.sweet);
      rotBetween(target.axis, target.normal, cont.axis, cont.normal, tmp2);
      const jump = Math.max(tmp.length(), tmp2.length() * 0.3);
      // A coast that just started begins at the shown pose with the shown motion: nothing to absorb.
      if (!coastStarted && (fresh || restW > 0.5 || jump > VIEW.absorb)) {
        errP.add(tmp);
        errR.add(tmp2);
        errV.add(tmp.subVectors(prevTarget.vel, target.vel));
        errW.add(tmp.subVectors(prevTarget.angVel, target.angVel));
        stats.absorbed++;
      }
      // A large offset (a late planned swing, a long tracking gap) converges faster rather than jumping.
      const rl = errR.length();
      if (rl > Math.PI) errR.scale(Math.PI / rl);
      const big = Math.max(smoothstep(0.15, 0.5, errP.length()), smoothstep(0.6, 2, rl));
      const w = (VIEW.omegaMove + (VIEW.omegaRest - VIEW.omegaMove) * restW) * (1 + big);
      if (dt > 0) {
        springStep(errP, errV, w, dt);
        springStep(errR, errW, w, dt);
      }
      if (errP.length() > VIEW.snap || !finiteV(errP) || !finiteV(errR) || !finiteV(errV) || !finiteV(errW)) {
        errP.set(0, 0, 0); errV.set(0, 0, 0); errR.set(0, 0, 0); errW.set(0, 0, 0);
        stats.snapped++;
        rs.ok = false;
        // A snap is a jump, not motion: no shown velocity from it, and the events settle again.
        hasPrevSweet = false;
        shownVel.set(0, 0, 0);
        shownSpeed = 0;
        settleUntil = T + VIEW.events.settle;
      }
    }
    copyRacketPose(prevTarget, target);
    hasPrev = true;

    copyRacketPose(shown, target);
    shown.sweet.add(errP);
    rotatePoseBy(shown, errR);
    shown.vel.add(errV);
    shown.angVel.add(errW);
    // Rest smoothing (VIEW.restCut): a low-passed copy of the shown pose, blended in by the rest weight.
    {
      const nr = clamp(VIEW.noiseRef / Math.max(1e-3, noise.floor), 0, 1);
      // One-Euro style: the cut-off rises with the shown speed, so the low-passed copy keeps up with
      // any real motion (blending in a lagging copy as a swing slows would pull the racket back).
      const fc = VIEW.restCutMin + (VIEW.restCut - VIEW.restCutMin) * nr * nr + VIEW.restBeta * Math.max(0, shownSpeed - restT);
      if (!rs.ok || !finiteV(rs.sweet) || !(dt > 0)) {
        rs.sweet.copy(shown.sweet); rs.axis.copy(shown.axis); rs.normal.copy(shown.normal); rs.ok = true;
      } else {
        // Relative to the body: walking (or a glide) is not smoothed away.
        const a = 1 - Math.exp(-dt * 2 * Math.PI * fc);
        rs.sweet.x += pl.vel.x * dt; rs.sweet.z += pl.vel.z * dt;
        rs.sweet.lerp(shown.sweet, a);
        rs.axis.lerp(shown.axis, a).normalize();
        rs.normal.lerp(shown.normal, a);
        rs.normal.addScaled(rs.axis, -rs.normal.dot(rs.axis)).normalize();
      }
      // Gated on the SHOWN racket's speed (the camera's track lags a predicted swing by ~0.25 s),
      // and never during a planned stroke or a follow-through coast.
      const ws = coast.on || mix > 0.05 ? 0 : 1 - smoothstep(restT, restT + 1.5, shownSpeed);
      if (ws > 1e-3) {
        shown.sweet.lerp(rs.sweet, ws);
        shown.axis.lerp(rs.axis, ws).normalize();
        shown.normal.lerp(rs.normal, ws);
        shown.normal.addScaled(shown.axis, -shown.normal.dot(shown.axis)).normalize();
      }
    }
    shown.grip.copy(shown.sweet).addScaled(shown.axis, -SWEET);
    shown.t = T;
    hasShown = true;

    // Shown motion relative to the body (events, coast).
    const pv = world.player.vel;
    if (hasPrevSweet && dt > 0) {
      tmp.subVectors(shown.sweet, prevSweet).scale(1 / dt);
      tmp.x -= pv.x;
      tmp.z -= pv.z;
      shownVel.lerp(tmp, 1 - Math.exp(-dt / 0.012));
      shownSpeed = shownVel.length();
    }
    prevSweet.copy(shown.sweet);
    hasPrevSweet = true;
    swingEvents(T);
    prevPlan = plan;
    return shown;
  }

  /**
   * The newest camera pose stalls a fast swing: its sweet spot moved (relative to the body) less
   * than C.stall x the swing's recent speed, or it moved backward, or the hand was barely visible. The recent speed is the median of the three frames
   * before it (a single smeared frame, or the catch-up frame after one, is not the reference). A
   * swing slows over a tenth of a second, never in one frame: such a pose is a motion-blurred,
   * lagging wrist.
   */
  let staleNow = false;
  const segV = new Float64Array(3);
  const segD = new Vec3();
  /** Body-relative sweet-spot displacement from track pose i-1 to i into out; its time step or 0. */
  function seg(i, out) {
    const a = racketTrack.get(i), b = racketTrack.get(i - 1);
    if (!a || !b) return 0;
    const h = a.t - b.t;
    if (!(h > 1e-3 && h < 0.2)) return 0;
    const pa = posAt(a.t, pA), pb = posAt(b.t, pB);
    if (!pa || !pb) return 0;
    out.set(a.sweet.x - pa.x - (b.sweet.x - pb.x), a.sweet.y - b.sweet.y, a.sweet.z - pa.z - (b.sweet.z - pb.z));
    return h;
  }
  function staleSample(dom) {
    staleNow = false;
    const n = racketTrack.length;
    if (n < 5) return false;
    const C = VIEW.coast;
    const ha = seg(n - 1, tmp);
    if (!ha) return false;
    segD.set(0, 0, 0);
    for (let k = 0; k < 3; k++) {
      const h = seg(n - 2 - k, tmp2);
      if (!h) return false;
      segV[k] = tmp2.length() / h;
      segD.add(tmp2);
    }
    const lo = Math.min(segV[0], segV[1], segV[2]), hi = Math.max(segV[0], segV[1], segV[2]);
    const vRef = segV[0] + segV[1] + segV[2] - lo - hi;
    const dl = segD.length();
    if (vRef < C.stallSpeed || !(dl > 1e-6)) return false;
    // Speed of the newest frame, negative when it went back against the recent motion (a swing's
    // arc curves: the frame's own length, not its projection on the last frames' chord).
    const along = (tmp.dot(segD) >= 0 ? tmp.length() : -tmp.length()) / ha;
    // ...and abruptly: a swing that is ending slows frame by frame (the trend of the last two frames
    // predicts it), a lagging wrist drops out of the trend.
    const vExp = segV[0] * clamp(segV[0] / Math.max(segV[1], 1e-3), 0.5, 1.3);
    const h = hist[hist.length - 1];
    const lowVis = !!(h && h.handVis && h.handVis[dom] < 0.5);
    staleNow = (along < C.stall * vRef && along < 0.6 * vExp) || (lowVis && along < 0.8 * vRef && along < 0.8 * vExp);
    return staleNow;
  }

  /** Previous target carried one tick on by its own velocity and spin. */
  function continuation(p, dt, out) {
    copyRacketPose(out, p);
    const vl = p.vel.length(), wl = p.angVel.length();
    if (vl < 80) out.sweet.addScaled(p.vel, dt);
    if (wl > 1e-6 && wl < 80) {
      _k.copy(p.angVel).scale(1 / wl);
      rotateAboutAxis(out.axis, _k, wl * dt, out.axis).normalize();
      rotateAboutAxis(out.normal, _k, wl * dt, out.normal);
      out.normal.addScaled(out.axis, -out.normal.dot(out.axis)).normalize();
    }
    return out;
  }

  /**
   * A timing strike drew the racket at `stamp` (on the ball): the follow-through starts from there,
   * on about the swing's shoulder at the stroke's speed (no slide back to the pre-strike pose).
   */
  function onStrike(world, stamp, plan) {
    if (!stamp || !finiteV(stamp.sweet)) return;
    const pp = world.player.pos;
    copyRacketPose(coast.from, stamp);
    coast.from.sweet.x -= pp.x; coast.from.sweet.z -= pp.z;
    coast.from.grip.x -= pp.x; coast.from.grip.z -= pp.z;
    if (plan && plan.S1 && finiteV(plan.S1)) coast.S.set(plan.S1.x - pp.x, plan.S1.y, plan.S1.z - pp.z);
    else coast.S.set(shoulder.x - pp.x, shoulder.y, shoulder.z - pp.z);
    const wl = plan && plan.axisRot && plan.omega > 0 ? plan.omega : stamp.angVel ? stamp.angVel.length() : 0;
    if (plan && plan.axisRot && finiteV(plan.axisRot)) coast.axis.copy(plan.axisRot);
    else if (wl > 1e-6) coast.axis.copy(stamp.angVel).scale(1 / wl);
    else return;
    coast.omega = wl;
    if (!(coast.omega > 1.5)) return;
    coast.on = true;
    coast.t0 = world.time;
    coast.fading = false;
    coast.reason = 'follow';
    coast.seenAfter = (plan && isNum(plan.cStar) ? plan.cStar : world.time + (world.settings.latency ?? 0)) + C_SEEN;
    coast.trackPeak = 0;
    coast.trackDone = false;
    if (plan) releasedKey = plan.key;
    stats.coasts++;
    stats.releaseCoasts++;
    // The drawn racket is the stamp now: no offset, and the next tick continues from it with the
    // follow-through's own motion (the stamp's velocity is the impact's, not the drawn swing's).
    errP.set(0, 0, 0); errV.set(0, 0, 0); errR.set(0, 0, 0); errW.set(0, 0, 0);
    copyRacketPose(prevTarget, stamp);
    _r.subVectors(coast.from.sweet, coast.S);
    prevTarget.vel.crossVectors(coast.axis, _r).scale(coast.omega);
    prevTarget.vel.x += world.player.vel.x;
    prevTarget.vel.z += world.player.vel.z;
    prevTarget.angVel.copy(coast.axis).scale(coast.omega);
    copyRacketPose(shown, prevTarget);
    prevSweet.copy(stamp.sweet);
  }

  /**
   * Follow-through of a predicted stroke: from the planned arc's contact pose, on about the same
   * shoulder at the stroke's speed, slowing as a real follow-through does (coast.decay), until the
   * tracked racket catches up (it shows the real follow-through ~0.25 s later).
   */
  function startFollow(world, T, plan, predictor) {
    const pp = world.player.pos;
    predictor.poseOfPlan(plan, plan.cStar, coast.from);
    coast.from.sweet.x -= pp.x; coast.from.sweet.z -= pp.z;
    coast.from.grip.x -= pp.x; coast.from.grip.z -= pp.z;
    coast.S.set(plan.S1.x - pp.x, plan.S1.y, plan.S1.z - pp.z);
    coast.axis.copy(plan.axisRot);
    coast.omega = plan.omega;
    if (!(coast.omega > 1.5) || !finiteV(coast.axis)) return;
    coast.on = true;
    coast.t0 = plan.cStar - (world.settings.latency ?? 0);
    coast.fading = false;
    coast.reason = 'follow';
    coast.seenAfter = plan.cStar + C_SEEN;
    coast.trackPeak = 0;
    coast.trackDone = false;
    stats.coasts++;
    stats.releaseCoasts++;
  }

  function startCoast(world, T, S, reason) {
    // From the racket as shown, turning about the shoulder at the shown angular speed (body-relative:
    // the player keeps moving while it coasts).
    const pp = world.player.pos;
    copyRacketPose(coast.from, shown);
    coast.from.sweet.x -= pp.x; coast.from.sweet.z -= pp.z;
    coast.from.grip.x -= pp.x; coast.from.grip.z -= pp.z;
    coast.S.set(S.x - pp.x, S.y, S.z - pp.z);
    _r.subVectors(coast.from.sweet, coast.S);
    const r2 = _r.lengthSq();
    if (!(r2 > 0.02)) return;
    _w.crossVectors(_r, shownVel).scale(1 / r2);
    const wl = _w.length();
    if (!(wl > 1.5)) return;
    coast.axis.copy(_w).scale(1 / wl);
    coast.omega = wl;
    coast.on = true;
    // One tick in already: the coast's first frame moves on from the shown pose (no repeated frame).
    coast.t0 = T - tickDt;
    coast.fading = false;
    coast.reason = reason;
    coast.seenAfter = null;
    stats.coasts++;
    if (reason === 'stale') stats.staleCoasts++;
    else stats.releaseCoasts++;
    // The shown pose is the coast's start: the offset is part of it now.
    errP.set(0, 0, 0); errV.set(0, 0, 0); errR.set(0, 0, 0); errW.set(0, 0, 0);
  }

  /** Coast pose at T (into coastPose) and its blend weight; ends once a good camera pose arrives. */
  function coastStep(T, dt, trackedTarget, goodFrame, pp, pvel) {
    const C = VIEW.coast;
    const age = T - coast.t0;
    const free = (coast.omega * (1 - Math.exp(-C.decay * age))) / C.decay;
    // Soft cap: the sweep eases into maxSweep (no sudden stop).
    const theta = C.maxSweep * Math.tanh(free / C.maxSweep);
    const rate = coast.omega * Math.exp(-C.decay * age) * (1 - Math.tanh(free / C.maxSweep) ** 2);
    copyRacketPose(coastPose, coast.from);
    _r.subVectors(coast.from.sweet, coast.S);
    rotateAboutAxis(_r, coast.axis, theta, _r);
    coastPose.sweet.addVectors(coast.S, _r);
    rotateAboutAxis(coast.from.axis, coast.axis, theta, coastPose.axis).normalize();
    rotateAboutAxis(coast.from.normal, coast.axis, theta, coastPose.normal);
    coastPose.normal.addScaled(coastPose.axis, -coastPose.normal.dot(coastPose.axis)).normalize();
    coastPose.vel.crossVectors(coast.axis, _r).scale(rate);
    coastPose.angVel.copy(coast.axis).scale(rate);
    coastPose.sweet.x += pp.x; coastPose.sweet.z += pp.z;
    coastPose.vel.x += pvel.x; coastPose.vel.z += pvel.z;
    coastPose.grip.copy(coastPose.sweet).addScaled(coastPose.axis, -SWEET);
    stats.coastTicks++;
    // Hand back on the next good camera pose, when the tracked racket has caught up, the swing has
    // died down, or after maxAge.
    const caught = age > 0.06 && trackedTarget.sweet.distanceTo(coastPose.sweet) < 0.15;
    const good = goodFrame && age > 0.02 && coast.reason === 'stale';
    const maxAge = coast.reason === 'follow' ? C.followAge : C.maxAge;
    // A follow-through hands back only once the camera has seen past the contact (else the
    // tracked racket would replay the swing it has not shown yet).
    const L = racketTrack.latest();
    const seen = coast.reason !== 'follow' || !isNum(coast.seenAfter) || (L && L.t >= coast.seenAfter && coast.trackDone);
    if (!coast.fading && ((seen && (caught || good || rate < 1.2)) || age > maxAge)) {
      coast.fading = true;
      coast.fadeT0 = T;
    }
    if (coast.fading) {
      const w = 1 - smoothstep(0, C.blend, T - coast.fadeT0);
      if (w <= 0) coast.on = false;
      return w;
    }
    return 1;
  }

  /** player:swing events from the shown racket. */
  function swingEvents(T) {
    const E = VIEW.events;
    const s = shownSpeed;
    if (settleUntil !== null && T < settleUntil) {
      // Settling after a reset / snap: no events, and the next swing must start from rest.
      ev.phase = 'idle';
      ev.armed = false;
      return;
    }
    if (ev.phase === 'idle') {
      if (!ev.armed && s < E.arm) ev.armed = true;
      // The hand-back of a coast to the camera's racket is a correction, not a swing.
      if (ev.armed && s >= E.start && !(coast.on && coast.fading)) {
        ev.phase = 'up';
        ev.armed = false;
        ev.peak = s;
        ev.t0 = T;
        ev.peakAt = T;
        ev.peakPos.copy(shown.sweet);
        push('start', T, s, shown.sweet);
      }
      return;
    }
    if (ev.phase === 'up') {
      if (s > ev.peak) {
        ev.peak = s;
        ev.peakAt = T;
        ev.peakPos.copy(shown.sweet);
      } else if (s < E.peakFall * ev.peak) {
        if (ev.peak >= E.minPeak) push('peak', ev.peakAt, ev.peak, ev.peakPos);
        ev.phase = 'down';
      }
    }
    if (ev.phase === 'down' || (ev.phase === 'up' && T - ev.t0 > E.maxDur)) {
      if (s < E.end || T - ev.t0 > E.maxDur) {
        push('end', T, s, shown.sweet);
        ev.phase = 'idle';
      }
    }
  }

  function push(phase, t, speed, pos) {
    events.push({ t, phase, speed: Math.round(speed * 100) / 100, pos: { x: pos.x, y: pos.y, z: pos.z } });
    if (events.length > 16) events.shift();
    stats.events++;
  }

  // ---------------------------------------------------------------------------------
  // Arms and eye: joints carried forward between frames, each frame's jump absorbed.

  const jointOut = { joints: {}, handFrames: { L: newHF(), R: newHF() }, t: 0 };
  const jErr = {}, jErrV = {}, jPrev = {};
  for (const name of JOINT_NAMES) {
    jointOut.joints[name] = new Vec3();
    jErr[name] = new Vec3();
    jErrV[name] = new Vec3();
    jPrev[name] = new Vec3();
  }
  const hfErr = { L: { g: new Vec3(), gv: new Vec3(), r: new Vec3(), rv: new Vec3() }, R: { g: new Vec3(), gv: new Vec3(), r: new Vec3(), rv: new Vec3() } };
  const hfPrev = { L: newHF(), R: newHF() };
  let jSample = null, jLastT = null, jHas = false;
  const jt = new Vec3(), jv = new Vec3(), jr = new Vec3(), jv2 = new Vec3();

  /**
   * Linear carry-forward of joint `name` of the newest sample to capture time t (bounded). Hands are
   * not carried (a swing carried 50 ms ahead overshoots, e.g. through the glass): they are only
   * smoothed, which never leaves the path of the camera's poses.
   */
  function carried(name, t, out) {
    const n = hist.length;
    const a = hist[n - 1];
    const j = a.J[name];
    out.copy(j);
    if (n >= 2 && !HAND_SET.has(name)) {
      const b = hist[n - 2];
      const h = a.t - b.t;
      const e = clamp(t - a.t, 0, VIEW.jointsExtrap);
      if (h > 1e-3 && h < 0.2 && b.J[name] && e > 0) out.addScaled(jv.subVectors(j, b.J[name]).scale(1 / h), e);
    }
    return out;
  }

  /**
   * The tracked body to draw at world.time: joints and hand frames (U frame), carried forward to
   * the newest capture moment and smoothed across frames. null without samples.
   */
  function joints(world) {
    const n = hist.length;
    if (!n) return null;
    const T = world.time;
    const dt = jLastT === null ? 0 : clamp(T - jLastT, 0, 0.1);
    jLastT = T;
    const newest = ageEst === null ? hist[n - 1].t : T - ageEst;
    const fresh = jSample !== hist[n - 1];
    const w = VIEW.omegaJoints;
    for (const name of JOINT_NAMES) {
      if (!hist[n - 1].J[name]) continue;
      carried(name, newest, jt);
      const e = jErr[name], ev2 = jErrV[name];
      if (jHas && fresh) {
        // The new frame's jump against where the old one was carrying the joint.
        e.add(jr.subVectors(jPrev[name], jt));
      }
      if (dt > 0) springStep(e, ev2, w, dt);
      if (e.length() > VIEW.snap) { e.set(0, 0, 0); ev2.set(0, 0, 0); }
      jPrev[name].copy(jt);
      jointOut.joints[name].copy(jt).add(e);
    }
    // Hand frames: grip and orientation of the newest sample with the same absorption.
    for (const s of ['L', 'R']) {
      const f = hist[n - 1].hf[s];
      const E2 = hfErr[s], P = hfPrev[s], o = jointOut.handFrames[s];
      const carry = jv2.set(0, 0, 0); // hands are not carried forward (see carried())
      if (jHas && fresh) {
        E2.g.add(jr.subVectors(P.grip, f.grip).sub(carry));
        E2.r.add(rotBetween(f.axis, f.normal, P.axis, P.normal, jr));
      }
      if (dt > 0) {
        springStep(E2.g, E2.gv, w, dt);
        springStep(E2.r, E2.rv, w, dt);
      }
      if (E2.g.length() > VIEW.snap || E2.r.length() > 2.5) { E2.g.set(0, 0, 0); E2.gv.set(0, 0, 0); E2.r.set(0, 0, 0); E2.rv.set(0, 0, 0); }
      P.grip.copy(f.grip).add(carry); P.axis.copy(f.axis); P.normal.copy(f.normal);
      o.grip.copy(f.grip).add(carry).add(E2.g);
      o.axis.copy(f.axis);
      o.normal.copy(f.normal);
      rotatePoseBy(o, E2.r);
    }
    jSample = hist[n - 1];
    jHas = true;
    jointOut.t = newest;
    jointOut.dominant = hist[n - 1].dominant;
    return jointOut;
  }

  function drainEvents() {
    if (!events.length) return null;
    const out = events.slice();
    events.length = 0;
    return out;
  }

  function reset() {
    rs.ok = false;
    hist.length = 0;
    lastLatestT = null;
    ageEst = null;
    lastT = null;
    hasShown = hasPrev = hasPrevSweet = false;
    shownVel.set(0, 0, 0);
    shownSpeed = 0;
    settleUntil = null;
    coast.on = false;
    errP.set(0, 0, 0); errV.set(0, 0, 0); errR.set(0, 0, 0); errW.set(0, 0, 0);
    jSample = null;
    jHas = false;
    jLastT = null;
    events.length = 0;
    ev.phase = 'idle';
    ev.armed = true;
    void prevPlan;
  }

  return {
    onSample,
    racket,
    onStrike,
    joints,
    /** The pose object racket() returned last (identity check for callers). */
    get lastShown() { return hasShown ? shown : null; },
    drainEvents,
    reset,
    stats,
    /** Shown sweet-spot speed relative to the body (m/s). */
    get speed() { return shownSpeed; },
    /** Median body-relative speed of the tracked racket over ~2 s (the camera's jitter, m/s). */
    get noiseFloor() { return noise.floor; },
    get coasting() { return coast.on; },
    /** Diagnostics: the absorbed offset (m, rad) and the target sweet spot. */
    get debug() { return { err: errP.length(), errRot: errR.length(), target: { x: target.sweet.x, y: target.sweet.y, z: target.sweet.z } }; },
  };
}
