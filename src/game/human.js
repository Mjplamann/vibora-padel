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
import { createLocomotion, defaultBounds } from '../tracking/locomotion.js';
import { createRacketTrack, createRacketPose, copyRacketPose, MAX_GAP } from '../tracking/racketTrack.js';
import { sweptContact } from '../physics/racket.js';
import { interceptCandidates } from '../physics/predict.js';
import { applyPlayerHit, emit, HIT_COOLDOWN, resolveSettings, predictFlight } from './world.js';

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
 */
export function interceptStance(world, { maxTime = 3 } = {}) {
  const pl = world.player;
  if (!world.ball) return null;
  const pred = predictFlight(world, { maxTime });
  const cands = interceptCandidates(pred, {
    playerPos: pl.pos, side: 'near', now: world.time - (world.settings.latency || 0), minHeight: 0.3, maxHeight: 2.4,
  });
  const m = world.mode;
  const hint = m && m.apHints ? m.apHints : null;
  const c = pickIntercept(cands, hint, pl.height);
  if (!c) return null;
  const handed = world.settings.handed || pl.handed;
  const fam = contactFamily(c.pos, c.kind, pl.pos, handed, pl.height);
  const s = idealStance(c.pos, fam, handed, pl.height);
  const b = defaultBounds();
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
  const state = { frames: 0, hits: 0, lastContact: null, lastShot: null, valid: false };
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
  function onPoseFrame(world, frame, simT) {
    const sample = bodyTracker.update(frame);
    if (!sample) return null;
    lastSample = sample;
    state.frames++;
    state.valid = sample.valid;
    const pl = world.player;
    pl.body = sample;
    if (!sample.valid) return sample;

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
    checkHits(world);
    return sample;
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

  function calibrate() {
    return bodyTracker.calibrate();
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
      const prepTime = prepTimeBefore(c.t);
      const shot = applyPlayerHit(world, c, c.pose, tSim, {
        playerPos: { x: pp.x, z: pp.z },
        swing: { peakSpeed: racketTrack.peakSpeed(c.t - 0.3, c.t + 0.05), racketTime: c.t, prepTime },
      });
      if (shot) {
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

  // ---- movement ---------------------------------------------------------------

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
      locomotion.setHome(pl.home);
      pl.pos.set(pl.home.x, 0, pl.home.z);
      pl.vel.set(0, 0, 0);
      pl.snapToHome = false;
    }
    updateMagnet(world);

    const tgt = manualTarget || locomotion.target;
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

    // Eye and court-frame body (render), from the newest sample at the current position.
    const latest = racketTrack.latest();
    if (lastSample && lastSample.valid && !manualTarget) {
      pl.bodyCourt = buildBodyCourt(lastSample, pl.pos.x, pl.pos.z, pl.bodyCourt);
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
    checkHits,
    posAt,
    moveTo,
    get state() {
      return state;
    },
  };
}

