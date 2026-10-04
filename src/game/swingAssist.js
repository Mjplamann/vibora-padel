// Timing-based hitting (round 3). The first real-world session (MacBook camera, player 2–3 m
// away): "like trying to hit a fruit fly", "I'd swing and never make contact but I didn't know
// why". A webcam at that distance cannot put a racket face within the few cm of the ball that a
// physical contact needs. In the 'timing' assist modes (Club, Rookie: config ASSIST[*].mode) a hit
// is a swing ON TIME:
//
//   plan   For the incoming ball the player may legally play: the ideal contact moment t* and
//          point p* (intercept.js rules: off the glass, the drill's intent) and the stance that
//          puts p* at the stroke family's ideal contact spot (human.js CONTACT_OFFSETS). The
//          player is glided there (auto-positioning: Rookie fully, Club strongly, own steps count).
//   swing  The tracked racket's sweet-spot velocity relative to the body (court racket track minus
//          the player's own court motion), only while it moves forward: a backswing never counts.
//          A swing is a run above minSpeed; its (sub-frame) peak is the moment of the stroke.
//   judge  Peak capture time - latency = ball time of the stroke. Inside [t* - early, t* + late]
//          with the racket path within `reach` of the ball -> a hit at t_c = t* + κ·e, the ball
//          where it really is then. Pace from the swing speed (per-stroke km/h ranges), direction
//          from the timing error (early -> cross-court, late -> down the line) blended with the
//          swing's direction, spin from the swing path (low->high topspin, high->low slice; overheads
//          flat smash or sliced bandeja / víbora), quality from timing and spacing; then the normal
//          flight (drag, Magnus) and net safety (world.js).
//   miss   Every playable ball not hit gets a reason: no swing, early / late by ms, racket below /
//          above / short of / past the ball by cm (with a stepping hint), rules, out of reach.
//
// It replaces the physical sweep inside the round-2 pipeline, not beside it: at t* the shown
// racket strikes the shown ball (world.applySpeculativeHit, drawn racket magnetized onto the
// contact); the camera's swing then confirms it through world.applyPlayerHit (same rewind, judge
// queue and reconcile blend) or the window closes and it is reverted with the miss reason.
// Pure module.

import { Vec3, v3 } from '../util/vec3.js';
import { clamp, smoothstep, lerp, angleDiff, createRng } from '../util/math.js';
import { BALL, RACKET, PLAYER, ASSIST, DEFAULT_ASSIST, COURT, netHeightAt } from '../config.js';
import { interceptCandidates, solveShot } from '../physics/predict.js';
import { spinFromComponents } from '../physics/racket.js';
import { playableCandidates, pickGlassContact, stanceBounds } from './intercept.js';
import { pickIntercept, contactFamily, idealStance } from './human.js';
import {
  applyPlayerHit, applySpeculativeHit, revertSpeculative, emit, emitView, predictFlight, currentStroke,
} from './world.js';
import { blendRacketPose, createRacketPose } from '../tracking/racketTrack.js';

const REF_H = PLAYER.defaultHeight;
/** Poses further apart than this (s) are a tracking gap (racketTrack MAX_GAP). */
const MAX_GAP_S = 0.25;

export const TIMING = Object.freeze({
  /** Contact time t_c = t* + kappa * timing error: an early swing meets the ball a little earlier. */
  kappa: 0.35,
  /** Capture s past the window before it closes (a swing peak is settled two or three frames later). */
  decideLag: 0.12,
  /** Capture s after the window that a swing is still awaited for the miss reason ("late", not "no swing"). */
  lateWait: 0.4,
  /** s before t* when the plan stops being re-planned, and the refresh interval before that. */
  commit: 0.5,
  refresh: 0.15,
  /** Body-relative swing speed (m/s, as a webcam measures it) mapped onto each stroke's pace range. */
  speedRef: Object.freeze([4, 13]),
  speedRefVolley: Object.freeze([2.4, 8.5]),
  /** Outgoing pace ranges (km/h) per shot type. */
  pace: Object.freeze({
    ground: [52, 92], glass: [48, 80], volley: [40, 72], bandeja: [58, 82], vibora: [64, 92],
    smash: [95, 142], lob: [46, 64], chiquita: [28, 42], serve: [46, 72],
  }),
  /** Far-court metres (x) of a full window of timing error: early -> cross-court, late -> down the line. */
  spread: Object.freeze({ ground: 3.0, glass: 2.6, volley: 2.6, overhead: 1.6, lob: 2.0, chiquita: 1.5, serve: 0.8 }),
  /** Weight of the swing's own horizontal direction (deviation from the family's usual path, ±0.45 rad). */
  swingDirWeight: 0.2,
  /** Usual horizontal swing direction at the peak (rad across the body) for forehands / backhands. */
  typicalSwingAz: 0.35,
  /** Swing path angle (deg) that gives full topspin (rising) or slice (falling). */
  pathFull: 35,
  /** Landing scatter σ (m) at quality 1 -> 0. */
  scatterX: Object.freeze([0.2, 1.5]),
  scatterZ: Object.freeze([0.25, 1.3]),
  /** Swing threshold factor by family (volleys are short punches, serves underhand). */
  minSpeedFactor: Object.freeze({ vfh: 0.6, vbh: 0.6, serve: 0.75 }),
  /** Racket travel (m, body-relative, within 0.9 s) that counts as preparation for a predicted strike. */
  prepTravel: 0.3,
  prepTravelShort: 0.18,
  /** A swing must carry the racket at least this far (m) in the 0.3 s into its peak (punches: minTravelShort). */
  minTravel: 0.32,
  minTravelShort: 0.2,
  /** Swing threshold >= noiseFactor × the median jitter speed of the tracked racket (capped at 1.6 × minSpeed). */
  noiseFactor: 2.4,
  /**
   * Early close of the window: a racket still (< stillSpeed m/s) for stillFor s after the ideal
   * moment, with less than minBuild s of window left (a forward swing needs that long to build).
   */
  stillSpeed: 1.2,
  stillFor: 0.1,
  minBuild: 0.1,
  /** Drawn racket magnetized onto the contact for this long (s). */
  magnetS: 0.12,
  /** Reach ring: green within ±green s of t*; shown from ringLead s before the window. */
  green: 0.06,
  ringLead: 0.3,
  /** Learning slow motion: sim rate from the glass rebound to the decision, and its ease (s). */
  slowmo: 0.7,
  slowmoEase: 0.25,
});

/** Default measured swing speed (m/s) and path (deg) per family before the player's own are learned. */
const DEFAULT_SWING = Object.freeze({
  fh: [9, 14], bh: [8, 14], vfh: [5, 0], vbh: [5, 0], oh: [8, -8], sm: [12, -15], serve: [7, 8],
});

const R = BALL.radius;

/** Timing parameters of the active assist, or null for physical hitting. */
export function timingConfig(world) {
  const s = world.settings || {};
  if (world.input === 'fallback') return null; // mouse play keeps its aimed auto-swing
  const mode = s.hitMode || 'auto';
  if (mode === 'physical') return null;
  const a = ASSIST[s.assist] || ASSIST[DEFAULT_ASSIST];
  if (mode === 'timing') return a.timing || ASSIST.club.timing;
  return a.mode === 'timing' && a.timing ? a.timing : null;
}

/** Learning slow motion off the glass: settings.learningSlowmo 'on' / 'off' (or true / false), or 'auto' (on for Rookie). */
export function learningSlowmoOn(s = {}) {
  const v = s.learningSlowmo;
  if (v === true || v === 'on') return true;
  if (v === false || v === 'off') return false;
  return s.assist === 'rookie';
}

/**
 * App-session log across every world (diagnostics, app/diagnostics.js): per mode id the hits and
 * misses by reason, and the last 40 swing evaluations.
 */
export const timingLog = { byMode: {}, swings: [] };

function logMode(world) {
  const mid = world.mode && world.mode.id ? world.mode.id : 'free';
  const T = world.timing;
  const a = T.byMode[mid] || (T.byMode[mid] = { hits: 0, misses: {} });
  const b = timingLog.byMode[mid] || (timingLog.byMode[mid] = { hits: 0, misses: {} });
  return [a, b];
}

/** world.timing: the plan, decisions, swings and logs the HUD, aids and diagnostics read. */
export function createTimingState() {
  return {
    plan: null,
    auto: { x: 0, z: 0, vx: 0, vz: 0, w: 0, init: false },
    decided: null, // { key, kind: 'hit'|'miss', at }
    lastSwing: null, // timing meter: { e, early, late, hit, at, label }
    lastMiss: null, // { reason, text, es, ... }
    swings: [], // last 40 swing evaluations (diagnostics)
    // noStrike: why no hit was predicted at t* (diagnostics: 'tracking' the swing predictor had no
    // live plan, 'prep' no backswing seen yet, 'early' an early swing already went by).
    log: { plans: 0, hits: 0, misses: {}, strikes: 0, reverted: 0, noStrike: { tracking: 0, prep: 0, early: 0 } },
    byMode: {}, // mode id -> { hits, misses: { reason: n } }
    hold: null, // judge hold (sim time) while a contact may still be decided
    magnet: null,
    learned: { speed: {}, path: {} },
    cue: { key: null, intro: false, tick: false, now: false, voice: false },
    flight: { key: null, incoming: false, planned: false, nearBounce: false, hit: false },
    timeScale: 1,
  };
}

export const flightKeyOf = (world) => (world.ball ? `${world.ball.id}:${world.flight.startT}` : null);

/** The live ball is the player's to play (coming to them, or their own dropped serve). */
export function incomingToPlayer(world) {
  const b = world.ball;
  if (!b || b.atRest || b.outside) return false;
  const f = world.flight;
  if (f.team === 0 && f.by !== 'drop') return false;
  const lh = world.lastHit;
  return !(lh && lh.team === 0 && lh.t >= f.startT - 1e-9);
}

const isDecided = (T, key) => !!(T.decided && T.decided.key === key);

// ---------------------------------------------------------------------------
// Plan

function computePlan(world, key) {
  const pl = world.player;
  const H = world.settings.height || pl.height || REF_H;
  const k = H / REF_H;
  const handed = world.settings.handed || pl.handed || 'right';
  const pred = predictFlight(world, { maxTime: 3 });
  const serving = world.flight.by === 'drop';
  const s0 = currentStroke(world);
  const receivingServe = !!(s0 && s0.isServe && s0.team !== 0);
  let cands = interceptCandidates(pred, {
    playerPos: pl.pos, maxSpeed: 6.5, reachRadius: 1.0, side: 'near', now: world.time, minHeight: 0.3, maxHeight: 2.4 * k,
  }).filter((c) => c.t > world.time + 0.06);
  if (receivingServe) cands = cands.filter((c) => c.kind !== 'volley');
  const hint = world.mode && world.mode.apHints ? world.mode.apHints : null;
  let c = null;
  if (serving) {
    const after = cands.filter((x) => x.kind === 'after-bounce' && x.height <= 0.53 * H && x.height >= 0.3);
    c = after.length ? after.reduce((b, x) => (x.height > b.height ? x : b), after[0]) : null;
  } else {
    let pc = playableCandidates(cands);
    // A glass drill is played off the glass (or at worst after the bounce), never in the air.
    if (hint && hint.contact === 'glass') pc = pc.filter((x) => x.kind !== 'volley');
    c = (hint && hint.contact === 'glass' && pickGlassContact(pc, H)) || pickIntercept(pc, hint, H);
  }
  if (!c) return null;
  let fam = serving ? 'fh' : contactFamily(c.pos, c.kind, pl.pos, handed, H);
  if (fam !== 'oh' && hint && (hint.family === 'fh' || hint.family === 'bh')) {
    fam = c.kind === 'volley' ? (hint.family === 'bh' ? 'vbh' : 'vfh') : hint.family;
  }
  if (fam === 'oh' && hint && hint.family === 'sm') fam = 'sm';
  const st = idealStance(c.pos, fam, handed, H);
  const bnd = stanceBounds();
  let bounceT = Infinity, wallT = Infinity;
  for (const e of pred.events) {
    if (e.side !== 'near') continue;
    if (e.type === 'bounce' && bounceT === Infinity) bounceT = e.t;
    else if (e.type === 'wall' && bounceT < Infinity && e.t > bounceT && wallT === Infinity) wallT = e.t;
  }
  return {
    key, tStar: c.t, pStar: c.pos.clone(), vStar: c.vel.clone(), kind: serving ? 'serve' : c.kind, family: fam,
    stance: { x: clamp(st.x, bnd.xMin, bnd.xMax), z: clamp(st.z, bnd.zMin, bnd.zMax) },
    serve: serving, receivingServe, bounceT, wallT, glass: c.kind === 'after-wall', made: world.time, nEv: world.flight.events.length,
    early: null, specTried: false,
  };
}

/**
 * Refreshes world.timing.plan for the incoming ball (every TIMING.refresh s until TIMING.commit s
 * before the contact; then held, and kept after t* until the swing is decided). Also notes balls
 * that came to the player with no possible contact (out of reach). Returns the plan or null.
 */
export function planTiming(world) {
  const T = world.timing;
  const key = flightKeyOf(world);
  watchFlight(world, key);
  const P = T.plan;
  if (P && P.key !== key) {
    T.plan = null; // a new flight (struck by somebody else, or replaced) before a decision: nobody's miss
    T.hold = null;
  }
  if (!incomingToPlayer(world) || isDecided(T, key)) return T.plan;
  const now = world.time;
  let plan = T.plan;
  if (plan) {
    if (now >= plan.tStar - TIMING.commit) return plan; // committed: the swing is under way
    if (now - plan.made < TIMING.refresh && plan.nEv === world.flight.events.length) return plan;
  }
  const np = computePlan(world, key);
  if (np) {
    if (!plan) T.log.plans++;
    else {
      np.early = plan.early;
      np.specTried = plan.specTried;
    }
    T.plan = np;
    T.flight.planned = true;
  } else if (!plan) T.plan = null;
  return T.plan;
}

/** Flight bookkeeping for "out of reach": an incoming ball that bounced in and was never playable. */
function watchFlight(world, key) {
  const T = world.timing;
  const F = T.flight;
  const live = key && world.ball && !world.ball.atRest && !world.ball.outside;
  if (F.key !== key || !live) {
    // The ball ended on the player's side (died, or a new feed), not struck by their own team.
    const ownTeamHit = F.key !== key && key && world.flight.team === 0 && world.flight.by !== 'drop';
    if (F.key && F.incoming && !F.planned && !F.hit && F.nearBounce && !ownTeamHit && timingConfig(world)) {
      F.incoming = false;
      reportMiss(world, null, { reason: 'out-of-reach', key: F.key });
    }
    if (F.key !== key) {
      T.flight = { key, incoming: false, planned: false, nearBounce: false, hit: false };
      if (T.cue.key !== key) T.cue = { key, intro: false, tick: false, now: false, voice: false };
    }
    if (!live) T.flight.incoming = false;
    return;
  }
  if (incomingToPlayer(world) && world.flight.by !== 'drop') F.incoming = true;
  if (!F.nearBounce) for (const e of world.flight.events) if (e.type === 'bounce' && e.side === 'near') { F.nearBounce = true; break; }
}

/**
 * Judge hold: rulings after the earliest possible contact wait while a swing may still decide it,
 * and (so the rep / point result carries its miss reason) until the miss is explained.
 * untilClosed: only while a hit is still possible (presentation holds: sounds, glass marks).
 */
export function judgeHoldOf(world, untilClosed = false) {
  const T = world.timing;
  const P = T && T.plan;
  if (!P || (untilClosed && P.closed) || isDecided(T, P.key) || P.key !== flightKeyOf(world)) return Infinity;
  const cfg = timingConfig(world);
  if (!cfg) return Infinity;
  // Failsafe: a tracker that stalls must not freeze the rulings.
  if (world.time > P.tStar + cfg.late + 1.2) return Infinity;
  return P.tStar - TIMING.kappa * cfg.early - 0.02;
}

/** Ball time of the contact for a swing `e` s off the ideal moment (kept on the right side of bounces / glass). */
export function contactTimeFor(P, e) {
  let tc = P.tStar + TIMING.kappa * e;
  if (P.kind === 'volley') {
    if (Number.isFinite(P.bounceT)) tc = Math.min(tc, P.bounceT - 0.03);
  } else if (P.kind === 'after-wall') {
    if (Number.isFinite(P.wallT)) tc = Math.max(tc, P.wallT + 0.05);
  } else if (Number.isFinite(P.bounceT)) {
    tc = Math.max(tc, P.bounceT + 0.03);
    if (Number.isFinite(P.wallT)) tc = Math.min(tc, P.wallT - 0.03);
  }
  return tc;
}

// ---------------------------------------------------------------------------
// Auto-positioning

/**
 * Court target while a contact is planned: the player's own target pulled toward the plan's
 * stance with weight cfg.position (Rookie 1: placed; Club 0.75: own steps move it by a quarter).
 * The stance point glides (critically damped, speed-capped) and the weight eases in and out, so
 * nothing snaps; stances respect the glass / net keep-outs (intercept.stanceBounds).
 */
export function autoTarget(world, own, dt, cfg = timingConfig(world)) {
  const T = world.timing;
  const A = T.auto;
  const P = T.plan;
  if (!A.init || !(A.w > 1e-3)) {
    A.x = own.x;
    A.z = own.z;
    A.vx = A.vz = 0;
    A.init = true;
  }
  let want = 0;
  if (cfg && P && P.stance) {
    const dec = isDecided(T, P.key) ? T.decided : null;
    // Hold the stance through the stroke, then hand back to the player's own position.
    const release = dec ? world.time - dec.at > 0.35 : world.time > P.tStar + cfg.late + 0.6;
    if (!release) want = clamp(cfg.position, 0, 1);
  }
  const ease = want > A.w ? dt / 0.3 : dt / 0.45;
  A.w = clamp(A.w + clamp(want - A.w, -ease, ease), 0, 1);
  if (A.w <= 1e-3) {
    A.w = 0;
    return own;
  }
  const gx = want > 0 ? P.stance.x : own.x;
  const gz = want > 0 ? P.stance.z : own.z;
  const L = 9;
  let vx = A.vx + (L * L * (gx - A.x) - 2 * L * A.vx) * dt;
  let vz = A.vz + (L * L * (gz - A.z) - 2 * L * A.vz) * dt;
  const sp = Math.hypot(vx, vz);
  if (sp > 6) {
    vx *= 6 / sp;
    vz *= 6 / sp;
  }
  A.vx = vx;
  A.vz = vz;
  A.x += vx * dt;
  A.z += vz * dt;
  const b = stanceBounds();
  A.x = clamp(A.x, b.xMin, b.xMax);
  A.z = clamp(A.z, b.zMin, b.zMax);
  return { x: own.x + (A.x - own.x) * A.w, z: own.z + (A.z - own.z) * A.w };
}

// ---------------------------------------------------------------------------
// Swings (body-relative sweet-spot speed of the tracked racket)

/**
 * Turns settled racket-track poses into swing events. racketTrack is the court-frame track of the
 * human controller; posAt(t) its court position history (subtracted: own movement is no swing).
 * @returns { process(minSpeed) -> SwingEvent[], prepared(c0) -> boolean, maxSpeed(c0, c1), lastT, recent }
 * SwingEvent = { tStart, cPeak, peakSpeed, vRel: Vec3 (court), pathDeg, az (court azimuth, rad), at }
 */
export function createSwingWatch({ racketTrack, posAt }) {
  let upTo = -Infinity;
  let cur = null;
  let armed = true; // a new swing starts only after the last one has died down
  let prev = null; // { t, s }
  const recent = []; // { t, s (gated), raw, back, up }
  const pA = { x: 0, z: 0 }, pB = { x: 0, z: 0 };
  const vr = new Vec3();
  const rp = new Vec3();
  const out = { lastT: -Infinity, threshold: 0 };

  /**
   * Body-relative sweet-spot velocity of stored pose i: a central difference of (sweet spot - the
   * player's court position at that capture time), so the player's own movement (steps, auto-
   * positioning, a new drill's home) cancels exactly. Returns false without neighbours.
   */
  /** Body-relative sweet-spot position of stored pose i (sweet spot - the player's court position). */
  function relPos(i, out) {
    const p = racketTrack.get(i);
    const pp = p && posAt(p.t, pA);
    if (!pp) return false;
    out.set(p.sweet.x - pp.x, p.sweet.y, p.sweet.z - pp.z);
    return true;
  }

  function relVel(i, out) {
    // Over ±2 frames (±1 near a gap): a webcam's landmark jitter on the racket's lever arm is
    // averaged out (a still racket's noise falls ~2x, a swing's peak ~15%).
    const p = racketTrack.get(i);
    if (!p) return false;
    const pick = (d) => {
      let q = p;
      for (let k = 1; k <= 2; k++) {
        const c = racketTrack.get(i + d * k);
        if (!c || Math.abs(c.t - q.t) > MAX_GAP_S) break;
        q = c;
      }
      return q;
    };
    const A = pick(-1), B = pick(1);
    if (A === B) return false;
    const pa = posAt(A.t, pA), pb = posAt(B.t, pB);
    if (!pa || !pb) return false;
    const dt = B.t - A.t;
    out.set(((B.sweet.x - pb.x) - (A.sweet.x - pa.x)) / dt, (B.sweet.y - A.sweet.y) / dt, ((B.sweet.z - pb.z) - (A.sweet.z - pa.z)) / dt);
    return true;
  }

  function finalize() {
    const p = cur.peak;
    let tPeak = p.t;
    const a = p.before, c = p.after;
    if (a && c) {
      const h0 = p.t - a.t, h2 = c.t - p.t;
      const den = a.s - 2 * p.s + c.s;
      if (h0 > 0 && h2 > 0 && Math.abs(h0 - h2) < 0.3 * Math.max(h0, h2) && den < 0) {
        tPeak = p.t + clamp((0.5 * (a.s - c.s)) / den, -0.5, 0.5) * 0.5 * (h0 + h2);
      }
    }
    const v = p.v;
    const horiz = Math.hypot(v.x, v.z);
    const ev = {
      tStart: cur.tStart, cPeak: tPeak, peakSpeed: p.s, vRel: v,
      pathDeg: (Math.atan2(v.y, Math.max(1e-6, horiz)) * 180) / Math.PI,
      az: horiz > 0.5 ? Math.atan2(v.x, -v.z) : null,
    };
    cur = null;
    return ev;
  }

  /** Median body-relative racket speed of the last 2 s: the jitter of the tracking. */
  function noiseFloor() {
    const n = recent.length;
    if (n < 8) return 0;
    const a = recent.map((r) => r.raw).sort((x, y) => x - y);
    return a[n >> 1];
  }

  /** How far (m) the racket travelled in the 0.3 s into a peak (body-relative). */
  function travelTo(pk) {
    let m = 0;
    for (const r of recent) {
      if (r.t < pk.t - 0.3 || r.t > pk.t) continue;
      const d = Math.hypot(pk.x - r.x, pk.y - r.y, pk.z - r.z);
      if (d > m) m = d;
    }
    return m;
  }

  let minTravel = TIMING.minTravel;
  function process(minSpeed, travel = TIMING.minTravel) {
    minTravel = travel;
    const events = [];
    const settled = racketTrack.settledTime();
    const n = racketTrack.length;
    let i = Math.max(0, racketTrack.indexAt(upTo) + 1);
    for (; i < n; i++) {
      const p = racketTrack.get(i);
      if (p.t > settled + 1e-9) break;
      // Wait for the frame after next (the ±2 frame velocity), unless the track has a gap there.
      const n2 = racketTrack.get(i + 2);
      if (!n2 && racketTrack.latest().t - p.t <= MAX_GAP_S) break;
      if (p.t <= upTo) continue;
      upTo = p.t;
      if (!relVel(i, vr)) vr.set(0, 0, 0);
      if (!relPos(i, rp)) rp.set(0, 0, 0);
      const raw = vr.length();
      const fwd = -vr.z;
      const s = fwd >= -0.1 * raw ? raw : 0; // forward (or across): a backswing never counts
      recent.push({ t: p.t, s, raw, back: Math.max(0, vr.z), up: Math.max(0, vr.y), x: rp.x, y: rp.y, z: rp.z });
      while (recent.length && recent[0].t < p.t - 2) recent.shift();
      // Tracking noise sets the floor: a swing must stand well above the jitter of a still racket.
      const th = Math.min(1.6 * minSpeed, Math.max(minSpeed, TIMING.noiseFactor * noiseFloor()));
      out.threshold = th;
      if (!cur) {
        if (!armed && s < 0.7 * th) armed = true;
        if (armed && s >= th) {
          cur = { tStart: p.t, th, peak: { t: p.t, s, v: vr.clone(), x: rp.x, y: rp.y, z: rp.z, before: prev, after: null } };
        }
      } else if (s > cur.peak.s) {
        cur.peak = { t: p.t, s, v: vr.clone(), x: rp.x, y: rp.y, z: rp.z, before: prev, after: null };
      } else {
        if (!cur.peak.after) cur.peak.after = { t: p.t, s };
        if (s < 0.8 * cur.peak.s || s < 0.6 * cur.th || p.t - cur.peak.t > 0.12) {
          const pk = cur.peak;
          const travel = travelTo(pk);
          const ev = finalize();
          ev.at = p.t;
          ev.travel = travel;
          ev.threshold = th;
          // A real swing carries the racket a long way into its peak; jitter does not.
          if (travel >= minTravel) events.push(ev);
          armed = s < 0.7 * th; // the follow-through is no new swing
        }
      }
      prev = { t: p.t, s };
      out.lastT = p.t;
    }
    return events;
  }

  /**
   * The racket was prepared at some capture time after c0: taken back (or up, or already swinging)
   * by a real distance — a still racket's jitter moves it a few cm, a backswing tens of cm.
   */
  function prepared(c0, travel = TIMING.prepTravel) {
    // Range of the 5-frame moving average of the racket position (jitter averages out). A shorter
    // average sees a late backswing sooner but lets a noisy webcam's jitter pass for one
    // (measured: 3 frames -> 4 strikes shown to a still player at 2x webcam noise in 45 s, 5 -> 1).
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    let i0 = recent.length;
    while (i0 > 0 && recent[i0 - 1].t >= c0) i0--;
    const W = 5;
    for (let i = i0; i + W <= recent.length; i++) {
      let x = 0, y = 0, z = 0;
      for (let k = 0; k < W; k++) { const r = recent[i + k]; x += r.x; y += r.y; z += r.z; }
      x /= W; y /= W; z /= W;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (z < z0) z0 = z;
      if (z > z1) z1 = z;
    }
    return x1 >= x0 && Math.hypot(x1 - x0, y1 - y0, z1 - z0) >= travel;
  }

  /** Capture time since which the racket has been still (body-relative speed < th), or Infinity if moving. */
  function stillSince(th = 1.2) {
    let t = Infinity;
    for (let i = recent.length - 1; i >= 0 && recent[i].raw < th; i--) t = recent[i].t;
    return t;
  }

  /** Fastest forward racket speed between capture times c0 and c1. */
  function maxSpeed(c0, c1) {
    let m = 0;
    for (const r of recent) if (r.t >= c0 && r.t <= c1 && r.s > m) m = r.s;
    return m;
  }

  return {
    process,
    prepared,
    maxSpeed,
    stillSince,
    get lastT() { return out.lastT; },
    /** Swing threshold in use (m/s): minSpeed raised over a noisy camera's jitter. */
    get threshold() { return out.threshold; },
    noiseFloor,
    reset() {
      cur = null;
      armed = true;
      prev = null;
      recent.length = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// The shot a timing hit plays

function hashOf(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0 || 1;
}

const typeOfFamily = (fam) => (fam === 'oh' || fam === 'sm' ? 'overhead' : fam === 'vfh' || fam === 'vbh' ? 'volley' : 'ground');

/** Default aim (court {x, z}) per shot type when the drill has none: deep and cross-court. */
function defaultAim(type, contact, dom, serveBox) {
  const cross = Math.abs(contact.x) > 0.8 ? -Math.sign(contact.x) * 1.8 : -dom * 1.2;
  switch (type) {
    case 'serve': return { x: (serveBox === 'left' ? 1 : -1) * 2.4, z: -5.6 };
    case 'smash': return { x: cross * 0.5, z: -3.0 };
    case 'lob': return { x: cross * 0.6, z: -8.6 };
    case 'chiquita': return { x: cross * 0.8, z: -2.9 };
    case 'volley': return { x: cross * 1.4, z: -7.8 };
    case 'bandeja': return { x: cross * 0.7, z: -8.3 };
    case 'vibora': return { x: -dom * 3.8, z: -8.0 };
    default: return { x: cross, z: -8.2 };
  }
}

/** Drill intent (drills.js ap.shot) that matches a shot type. */
const INTENT_TYPES = Object.freeze({
  drive: ['ground', 'glass'], glass: ['glass', 'ground'], volley: ['volley'], bandeja: ['bandeja'], vibora: ['vibora'],
  smash: ['smash'], lob: ['lob'], chiquita: ['chiquita'], serve: ['serve'], return: ['ground', 'glass'],
});

/**
 * Virtual racket pose (court frame) that plays vOut from a ball arriving with vIn at C: struck-face
 * normal along the impulse, sweet spot on the ball, handle pointing away from the shoulder, sweet-spot
 * velocity from the apparent-COR inversion plus a brush along the face for the swing path.
 */
export function contactPose(C, vIn, vOut, shoulder, { back = false, pathDeg = 0 } = {}, out = createRacketPose()) {
  const n = new Vec3().subVectors(vOut, vIn);
  if (n.lengthSq() < 1e-9) n.set(0, 0, -1);
  n.normalize();
  out.sweet.copy(C).addScaled(n, -(R + RACKET.thickness / 2));
  const rh = new Vec3().subVectors(out.sweet, shoulder);
  const rho = Math.max(0.2, rh.length());
  rh.scale(1 / rho);
  out.axis.copy(rh).addScaled(n, -rh.dot(n));
  if (out.axis.lengthSq() < 1e-6) out.axis.set(0, 1, 0).addScaled(n, -n.y);
  out.axis.normalize();
  out.normal.copy(n).scale(back ? -1 : 1);
  const e = RACKET.apparentCOR;
  const vn = (vOut.dot(n) + e * vIn.dot(n)) / (1 + e);
  const up = new Vec3(0, 1, 0).addScaled(n, -n.y);
  if (up.lengthSq() > 1e-6) up.normalize();
  out.vel.copy(n).scale(vn).addScaled(up, vn * Math.tan((clamp(pathDeg, -50, 50) * Math.PI) / 180) * 0.6);
  out.angVel.crossVectors(rh, out.vel).scale(1 / rho);
  out.grip.copy(out.sweet).addScaled(out.axis, -RACKET.sweetSpotY);
  return out;
}

/**
 * Strike analysis of a timing hit (called by world.strikeAnalysis for contact.timing). Mutates
 * `ball` (at the contact) into the outgoing ball before net safety. Returns the analysis fields
 * world.js uses for the ShotRecord (info, stroke, q, contactU, physVel, intent, pose, timing).
 */
export function timingAnalysis(world, ball, contact, t, extra, ctx, isServe) {
  const tm = contact.timing;
  const s = world.settings;
  const pl = world.player;
  const H = s.height || pl.height || REF_H;
  const k = H / REF_H;
  const handed = s.handed || pl.handed || 'right';
  const dom = handed === 'left' ? -1 : 1;
  const C = ball.pos.clone();
  const vIn = ball.vel.clone();
  const speedIn = vIn.length();
  const pp = extra.playerPos || pl.pos;
  const contactU = v3(C.x - pp.x, C.y, pp.z - C.z);
  const fam = tm.family || 'fh';
  const back = fam === 'bh' || fam === 'vbh';
  const volley = !ctx.afterBounce && !isServe;
  const overhead = !isServe && (fam === 'oh' || fam === 'sm' || (volley && C.y > 1.78 * k));
  const hint = (world.mode && world.mode.apHints) || null;
  const intent = hint && hint.shot ? hint.shot : null;
  const e = Number.isFinite(tm.e) ? tm.e : 0;
  const win = e < 0 ? tm.early || 0.2 : tm.late || 0.22;
  const eN = clamp(e / Math.max(0.05, win), -1, 1);
  // Volleys are punches: a webcam sees 3-8 m/s where a drive shows 8-14.
  const ref = volley && !overhead ? TIMING.speedRefVolley : TIMING.speedRef;
  const u = clamp((tm.speed - ref[0]) / (ref[1] - ref[0]), 0, 1);
  const path = Number.isFinite(tm.pathDeg) ? tm.pathDeg : 0;

  // Quality: on time and well spaced.
  const qT = 1 - 0.55 * Math.abs(eN) ** 1.5;
  const qS = Number.isFinite(tm.dist) ? 1 - 0.45 * Math.min(1.4, tm.dist / 0.75) ** 2 : 1;
  const q = clamp(qT * qS, 0.25, 1);

  // What the swing plays: the drill's stroke (ap.shot) unless the swing clearly says otherwise.
  let type;
  if (isServe) type = 'serve';
  else if (overhead) {
    const lateral = Number.isFinite(tm.az) && Math.abs(tm.az) > 0.6;
    if (intent === 'smash' || fam === 'sm' || (!intent && u > 0.7 && path < -12)) type = 'smash';
    else if (intent === 'vibora' || (!intent && lateral && u > 0.45)) type = 'vibora';
    else type = 'bandeja';
  } else {
    const lobDrill = intent === 'lob' && !(u > 0.8 && path < 5); // a fast flat swing is still a drive
    const lobPath = intent === 'chiquita' ? 70 : intent === 'glass' ? 62 : volley ? 55 : intent ? 50 : 40;
    if (lobDrill || (intent !== 'lob' && path > lobPath)) type = 'lob';
    else if (!volley && intent === 'chiquita' && u < 0.75) type = 'chiquita';
    else if (volley) type = 'volley';
    else type = ctx.afterWall ? 'glass' : 'ground';
  }

  // Pace.
  const pr = TIMING.pace[type];
  const kmh = lerp(pr[0], pr[1], u ** 0.85) * (0.85 + 0.15 * q);

  // Spin (rpm) from the swing path.
  const f = clamp(path / TIMING.pathFull, -1, 1);
  let top = 0, side = 0;
  switch (type) {
    case 'ground': case 'glass': top = f >= 0 ? lerp(300, 2600, f) : lerp(300, -1500, -f); break;
    case 'volley': top = clamp(-450 + 12 * path, -1100, 300); break;
    case 'lob': top = clamp(300 + 25 * path, 200, 1600); break;
    case 'chiquita': top = 500 + 15 * Math.max(0, path); break;
    case 'bandeja': top = -700 - 600 * u; break;
    case 'vibora': top = -900 - 500 * u; break;
    case 'smash': top = clamp(150 + 6 * path, 0, 350); break;
    case 'serve': top = -350; break;
    default: break;
  }

  // Aim: the drill's target for this shot (or deep cross-court), moved by the timing error.
  // Scatter: the same for the predicted strike and its confirmation (ball ids are not; the ideal
  // contact moment is).
  const rng = createRng(hashOf(`${Number.isFinite(tm.tStar) ? tm.tStar.toFixed(3) : t.toFixed(3)}:${fam}`));
  const serveBox = isServe && world.referee && world.referee.state.serving ? world.referee.state.serving.box : null;
  let aim = defaultAim(type, C, dom, serveBox);
  if (hint && hint.aim && (!intent || (INTENT_TYPES[intent] || []).includes(type))) {
    const a = back && hint.aimBh ? hint.aimBh : hint.aim;
    aim = isServe ? { x: aim.x, z: a.z } : { x: a.x, z: a.z };
  } else if (hint && hint.aim && !isServe) aim = { x: hint.aim.x, z: aim.z };
  const kind = type === 'smash' || type === 'bandeja' || type === 'vibora' ? 'overhead' : type;
  const spread = TIMING.spread[kind] ?? TIMING.spread.ground;
  let tx = aim.x + dom * (back ? -1 : 1) * spread * eN;
  let tz = aim.z;
  const dist = Math.hypot(tx - C.x, tz - C.z);
  if (Number.isFinite(tm.az) && !isServe) {
    const typ = typeOfFamily(fam) === 'overhead' ? 0 : (back ? dom : -dom) * TIMING.typicalSwingAz;
    const dev = clamp(angleDiff(typ, tm.az), -0.45, 0.45);
    tx += TIMING.swingDirWeight * Math.tan(dev) * dist;
    side += clamp(-dev * 700, -400, 400);
  }
  // The timing / swing aim stays inside the court; only a poor contact (scatter) can miss it.
  tx = clamp(tx, -4.6, 4.6);
  tx += rng.normal(0, lerp(TIMING.scatterX[0], TIMING.scatterX[1], 1 - q));
  tz += rng.normal(0, lerp(TIMING.scatterZ[0], TIMING.scatterZ[1], 1 - q));
  if (isServe) {
    const sx = serveBox === 'left' ? 1 : -1;
    tx = sx > 0 ? clamp(tx, 0.2, 5.3) : clamp(tx, -5.3, -0.2);
    tz = clamp(tz, -7.4, -1.5);
  } else {
    tx = clamp(tx, -5.4, 5.4);
    tz = clamp(tz, -10.6, -0.4);
  }
  if (type === 'vibora') {
    tx = clamp(tx, -3.7, 3.7); // the cut curves it on toward the side glass: land it first
    side += -800 * Math.sign(tx - C.x || -dom);
  }
  if (type === 'serve') side += (rng() < 0.5 ? -1 : 1) * 450;

  // Launch: the pace toward the target (a lob by its apex); fall back to a safe arc.
  const target = v3(tx, 0, tz);
  const dir = v3(tx - C.x, 0, tz - C.z);
  const spin = spinFromComponents(dir, top, side);
  let res = null;
  if (type === 'lob') res = solveShot({ from: C, target, spin, apex: clamp(5.2 + 1.4 * u, 5.0, 7.0) });
  else if (type === 'chiquita') {
    // Just over the tape, dying at their feet.
    res = solveShot({ from: C, target, spin, apex: Math.max(C.y + 0.12, netHeightAt(tx) + 0.6 + 0.3 * (1 - q)) });
  } else {
    res = solveShot({ from: C, target, spin, speed: kmh / 3.6 });
    if (!res.ok || !res.clearsNet) {
      res = solveShot({ from: C, target, spin, apex: Math.max(C.y + 0.4, netHeightAt(tx) + 0.7 + 0.06 * dist) });
    }
  }
  const vOut = res && Number.isFinite(res.vel.x) && res.vel.lengthSq() > 1 ? res.vel.clone() : dir.clone().normalize().scale(kmh / 3.6).add(v3(0, 2, 0));
  ball.vel.copy(vOut);
  ball.spin.copy(spin);
  ball.lastSurface = 'racket';
  ball.atRest = false;

  // The racket that would have played it (strike frame, magnetized display, stroke analysis).
  const shoulder = v3(pp.x + dom * 0.18 * k, PLAYER.shoulderHeightRatio * H, pp.z);
  const pose = contactPose(C, vIn, vOut, shoulder, { back, pathDeg: path });
  pose.t = t;

  const label = strokeLabel(type, back);
  const timing = Math.abs(e) <= TIMING.green ? 'good' : e < 0 ? 'early' : 'late';
  let spacing = 'good';
  if (tm.offU && Number.isFinite(tm.dist) && tm.dist > 0.25 && !overhead) {
    const outward = tm.offU.x * dom * (back ? -1 : 1);
    if (Math.abs(outward) > 0.2) spacing = outward > 0 ? 'stretched' : 'cramped';
  }
  return {
    info: {
      hit: true, speedIn, speedOut: vOut.length(), racketSpeed: tm.speed, offCenter: (1 - q) * 0.1, eA: RACKET.apparentCOR,
      quality: q, face: back ? 'back' : 'front',
    },
    stroke: label,
    pathStroke: label,
    groundStroke: back ? (ctx.afterWall ? 'glass-bh' : 'backhand') : ctx.afterWall ? 'glass-fh' : 'forehand',
    q: { timing, spacing, score: q, front: contactU.z, side: contactU.x * dom, height: contactU.y },
    ctx, isServe, contactPos: C, contactU, speedIn, physVel: vOut.clone(), intent: { target, vel: vOut.clone() }, lift: 0,
    pose,
    timing: {
      e, early: tm.early, late: tm.late, speed: tm.speed, pathDeg: path, dist: Number.isFinite(tm.dist) ? tm.dist : null,
      quality: q, type, kmh, top, side, target: { x: tx, z: tz }, predicted: !!tm.predicted, tStar: tm.tStar, family: fam,
    },
  };
}

function strokeLabel(type, back) {
  switch (type) {
    case 'serve': case 'smash': case 'bandeja': case 'vibora': case 'lob': case 'chiquita': return type;
    case 'volley': return back ? 'volley-bh' : 'volley-fh';
    case 'glass': return back ? 'glass-bh' : 'glass-fh';
    default: return back ? 'backhand' : 'forehand';
  }
}

// ---------------------------------------------------------------------------
// Miss reasons

const fmtS = (a, es = false) => {
  const v = Math.abs(a);
  if (v < 0.095) return `${Math.round(v * 1000)} ms`;
  const t = v.toFixed(2).replace(/0$/, '');
  return `${es ? t.replace('.', ',') : t} s`;
};
const cmOf = (m) => Math.max(5, Math.round((Math.abs(m) * 100) / 5) * 5);

/** EN / ES miss texts. */
export function missText(m) {
  const cm = m.cm;
  const dirEn = m.step === 'left' ? 'left' : m.step === 'right' ? 'right' : m.step === 'forward' ? 'forward' : 'back';
  const dirEs = m.step === 'left' ? 'a la izquierda' : m.step === 'right' ? 'a la derecha' : m.step === 'forward' ? 'adelante' : 'atrás';
  switch (m.reason) {
    case 'no-swing':
      return m.speed > 0
        ? { text: `Swing too slow (${Math.round(m.speed)} m/s) — swing a bit faster`, es: 'Golpe demasiado lento: golpea un poco más rápido' }
        : { text: 'No swing detected — swing a bit faster', es: 'No se detectó el golpe: golpea un poco más rápido' };
    case 'early': return { text: `Swing was ${fmtS(m.e)} early`, es: `Golpeaste ${fmtS(m.e, true)} pronto` };
    case 'late': return { text: `Swing was ${fmtS(m.e)} late`, es: `Golpeaste ${fmtS(m.e, true)} tarde` };
    case 'below': return { text: `Racket was ${cm} cm below the ball — swing higher`, es: `La pala pasó ${cm} cm por debajo de la bola` };
    case 'above': return { text: `Racket was ${cm} cm above the ball — get lower`, es: `La pala pasó ${cm} cm por encima: flexiona más` };
    case 'too-far': return { text: `Ball was ${cm} cm out of reach — step ${dirEn}`, es: `La bola quedó a ${cm} cm: da un paso ${dirEs}` };
    case 'too-close': return { text: `Ball was ${cm} cm too close — step ${dirEn}`, es: `Bola ${cm} cm demasiado pegada: un paso ${dirEs}` };
    case 'behind': return { text: `Racket was ${cm} cm behind the ball — step in`, es: `La pala pasó ${cm} cm por detrás: entra a la bola` };
    case 'in-front': return { text: `Racket was ${cm} cm in front of the ball — let it come to you`, es: `La pala pasó ${cm} cm por delante: deja que venga` };
    case 'rules':
      if (m.rule === 'serve') return { text: 'Let the serve bounce', es: 'Deja botar el saque' };
      if (m.rule === 'glass') return { text: 'Let it come off the glass first', es: 'Deja que salga del cristal primero' };
      return { text: 'That ball was not yours to play', es: 'Esa bola no era tuya' };
    case 'out-of-reach': return { text: 'Out of reach', es: 'Fuera de alcance' };
    case 'tracking': return { text: 'Lost you on camera — stay in frame', es: 'No te veo: quédate en el encuadre' };
    case 'late-detect': return { text: 'Hit seen too late — redo the latency test', es: 'Golpe detectado tarde: repite la prueba de latencia' };
    default: return { text: 'Missed', es: 'Fallada' };
  }
}

/** Spatial miss: the largest of the ball-minus-racket offsets (player frame U) at the closest approach. */
function spacingReason(offU, fam, dom) {
  const back = fam === 'bh' || fam === 'vbh';
  const out = offU.x * dom * (back ? -1 : 1); // + : the ball was further out on the hitting side
  const comps = [
    { reason: out > 0 ? 'too-far' : 'too-close', v: Math.abs(out) },
    { reason: offU.y > 0 ? 'below' : 'above', v: Math.abs(offU.y) },
    { reason: offU.z > 0 ? 'behind' : 'in-front', v: Math.abs(offU.z) * 0.8 },
  ];
  const best = comps.reduce((a, b) => (b.v > a.v ? b : a), comps[0]);
  const m = { reason: best.reason, cm: cmOf(best.reason === 'behind' || best.reason === 'in-front' ? offU.z : best.v) };
  if (best.reason === 'too-far' || best.reason === 'too-close') {
    const sideward = Math.sign(offU.x) || dom; // court direction toward the ball
    const toBall = best.reason === 'too-far' ? sideward : -sideward;
    m.step = toBall > 0 ? 'right' : 'left';
  } else if (best.reason === 'behind') m.step = 'forward';
  else if (best.reason === 'in-front') m.step = 'back';
  return m;
}

/** Builds and announces a miss: world.timing.lastMiss, logs, 'player:miss' on the bus (and to the mode). */
export function reportMiss(world, P, m) {
  const T = world.timing;
  const miss = {
    reason: m.reason, e: Number.isFinite(m.e) ? m.e : null, ms: Number.isFinite(m.e) ? Math.round(m.e * 1000) : null,
    cm: m.cm ?? null, step: m.step || null, rule: m.rule || null, speed: m.speed ?? null, dist: m.dist ?? null,
    tStar: P ? P.tStar : null, family: P ? P.family : null, key: P ? P.key : m.key || null, at: world.time,
    glass: !!(P && P.glass),
  };
  Object.assign(miss, missText(miss));
  T.lastMiss = miss;
  T.log.misses[miss.reason] = (T.log.misses[miss.reason] || 0) + 1;
  for (const bm of logMode(world)) bm.misses[miss.reason] = (bm.misses[miss.reason] || 0) + 1;
  emit(world, 'player:miss', miss);
  return miss;
}

/** Swing threshold (m/s) for the planned stroke: volleys, serves and touch shots are gentler. */
export function minSpeedFor(world, cfg, P) {
  const base = cfg ? cfg.minSpeed : 4;
  let f = P ? TIMING.minSpeedFactor[P.family] ?? 1 : 1;
  const hint = world.mode && world.mode.apHints;
  if (hint && hint.shot === 'chiquita') f = Math.min(f, 0.6);
  return base * f;
}

/** Timing meter after a swing: { e, early, late, hit, at, label }. */
function meterOf(world, cfg, e, hit) {
  const a = Math.abs(e);
  const label = a <= TIMING.green ? 'On time' : `${e < 0 ? 'Early' : 'Late'} ${Math.round(a * 1000)} ms`;
  return { e, early: cfg.early, late: cfg.late, hit, at: world.time, label };
}

// ---------------------------------------------------------------------------
// The judge (one per human controller)

/**
 * @param o.racketTrack the human controller's court racket track
 * @param o.posAt (t, out?) -> {x, z} its court position history
 * @param o.prepTimeBefore (c) -> forward-swing time before capture time c (analytics), optional
 * @returns { update(world, dt), onFrame(world) -> ShotRecord[], afterStep(world, { predictor, dt }),
 *   autoTarget(world, own, dt), watch, learnedSpeed(fam), learnedPath(fam) }
 */
export function createTimingJudge({ racketTrack, posAt, prepTimeBefore = null }) {
  const watch = createSwingWatch({ racketTrack, posAt });
  const tmpPose = createRacketPose();
  const pp0 = { x: 0, z: 0 };

  function learned(world, fam) {
    const L = world.timing.learned;
    const d = DEFAULT_SWING[fam] || DEFAULT_SWING.fh;
    return { speed: L.speed[fam] ?? d[0], path: L.path[fam] ?? d[1] };
  }

  function learn(world, fam, ev) {
    const L = world.timing.learned;
    const a = 0.35;
    L.speed[fam] = L.speed[fam] === undefined ? ev.peakSpeed : L.speed[fam] + a * (ev.peakSpeed - L.speed[fam]);
    L.path[fam] = L.path[fam] === undefined ? ev.pathDeg : L.path[fam] + a * (ev.pathDeg - L.path[fam]);
  }

  /** Closest approach of the tracked racket's sweet spot (around the swing peak) to point C. */
  function racketPathMiss(ev, C) {
    let best = Infinity, bx = 0, by = 0, bz = 0;
    for (let c = ev.cPeak - 0.15; c <= ev.cPeak + 0.1 + 1e-9; c += 1 / 120) {
      const p = racketTrack.sample(c, tmpPose);
      if (!p) continue;
      const dx = C.x - p.sweet.x, dy = C.y - p.sweet.y, dz = C.z - p.sweet.z;
      const d = Math.hypot(dx, dy, dz);
      if (d < best) { best = d; bx = dx; by = dy; bz = dz; }
    }
    return { dist: best, offU: { x: bx, y: by, z: -bz } };
  }

  function pushSwing(T, rec) {
    T.swings.push(rec);
    if (T.swings.length > 40) T.swings.shift();
    timingLog.swings.push(rec);
    if (timingLog.swings.length > 40) timingLog.swings.shift();
  }

  function decideMiss(world, cfg, P, m) {
    const T = world.timing;
    if (isDecided(T, P.key)) return null;
    T.decided = { key: P.key, kind: 'miss', at: world.time };
    T.hold = null;
    if (Number.isFinite(m.e)) T.lastSwing = meterOf(world, cfg, m.e, false);
    const b = world.ball;
    if (world.spec && b && world.spec.ballId === b.id) {
      revertSpeculative(world, m.reason);
      T.log.reverted++;
    }
    return reportMiss(world, P, m);
  }

  function decideHit(world, cfg, P, shot, e) {
    const T = world.timing;
    T.decided = { key: P.key, kind: 'hit', at: world.time, shotId: shot.id };
    T.hold = null;
    T.lastSwing = meterOf(world, cfg, e, true);
    T.lastMiss = null;
    T.log.hits++;
    T.flight.hit = true;
    for (const bm of logMode(world)) bm.hits++;
  }

  function rulesOf(world, P, tc) {
    const rj = world.hitRejects;
    if (P.receivingServe && Number.isFinite(P.bounceT) && tc < P.bounceT) return { reason: 'rules', rule: 'serve' };
    if (rj && rj.lastLate && Math.abs(rj.lastLate.t - tc) < 1e-6) return { reason: 'late-detect' };
    return { reason: 'rules', rule: null };
  }

  function contactOf(cfg, P, sw) {
    return {
      timing: {
        e: sw.e, speed: sw.speed, pathDeg: sw.pathDeg, az: sw.az ?? null, dist: sw.dist ?? null, offU: sw.offU || null,
        family: P.family, kind: P.kind, tStar: P.tStar, early: cfg.early, late: cfg.late, reach: cfg.reach,
        predicted: !!sw.predicted, key: P.key,
      },
      face: P.family === 'bh' || P.family === 'vbh' ? 'back' : 'front',
      local: { x: 0, y: RACKET.sweetSpotY },
      offCenter: 0,
    };
  }

  function judgeSwing(world, cfg, ev, shots) {
    const T = world.timing;
    const lat = world.settings.latency ?? 0;
    const P = T.plan;
    const rec = {
      c: +ev.cPeak.toFixed(3), t: +(ev.cPeak - lat).toFixed(3), speed: +ev.peakSpeed.toFixed(2), pathDeg: Math.round(ev.pathDeg),
      tStar: P ? +P.tStar.toFixed(3) : null, e: null, dist: null, result: 'no-ball', at: +world.time.toFixed(3),
    };
    pushSwing(T, rec);
    if (!P || isDecided(T, P.key)) return;
    // The follow-through / recovery after an early swing is the same stroke, not a second one.
    if (P.early && ev.cPeak - (P.early.t + lat) < 0.6 && ev.peakSpeed < 0.75 * P.early.speed) {
      rec.result = 'recovery';
      return;
    }
    const e = ev.cPeak - lat - P.tStar;
    rec.e = +e.toFixed(3);
    if (e < -cfg.early) {
      if (e < -cfg.early - 0.6) {
        rec.result = 'ignored';
        return;
      }
      if (!P.early || e > P.early.e) P.early = { e, speed: ev.peakSpeed, t: ev.cPeak - lat };
      rec.result = 'early';
      T.lastSwing = meterOf(world, cfg, e, false);
      return;
    }
    if (e > cfg.late || P.closed) {
      rec.result = 'late';
      decideMiss(world, cfg, P, { reason: 'late', e: Math.max(e, 0.01) });
      return;
    }
    const tc = contactTimeFor(P, e);
    const at = world.ballHistory.at(tc);
    if (!at || !world.ball || at.id !== world.ball.id || at.atRest) {
      rec.result = 'gone';
      decideMiss(world, cfg, P, { reason: 'late-detect', e });
      return;
    }
    const C = v3(at.pos.x, at.pos.y, at.pos.z);
    const sp = racketPathMiss(ev, C);
    rec.dist = +sp.dist.toFixed(3);
    if (sp.dist > cfg.reach) {
      rec.result = 'far';
      const dom = (world.settings.handed || world.player.handed) === 'left' ? -1 : 1;
      decideMiss(world, cfg, P, { ...spacingReason(sp.offU, P.family, dom), e, dist: sp.dist });
      return;
    }
    const pp = posAt(ev.cPeak, pp0) || world.player.pos;
    const contact = contactOf(cfg, P, { e, speed: ev.peakSpeed, pathDeg: ev.pathDeg, az: ev.az, dist: sp.dist, offU: sp.offU });
    const shot = applyPlayerHit(world, contact, null, tc, {
      playerPos: { x: pp.x, z: pp.z },
      swing: { peakSpeed: ev.peakSpeed, racketTime: ev.cPeak, prepTime: prepTimeBefore ? prepTimeBefore(ev.cPeak) : ev.cPeak - ev.tStart },
    });
    if (!shot) {
      rec.result = 'rejected';
      decideMiss(world, cfg, P, { ...rulesOf(world, P, tc), e });
      return;
    }
    rec.result = 'hit';
    rec.shotId = shot.id;
    decideHit(world, cfg, P, shot, e);
    learn(world, P.family, ev);
    shots.push(shot);
  }

  /**
   * The window has passed (capture time) with no decisive swing: no hit any more (the judge hold is
   * released, a predicted strike undone); the miss reason follows from what was seen, after waiting
   * TIMING.lateWait for a swing that comes too late (so it is reported as late, not as no swing).
   * A predicted strike is undone sooner when the racket has stopped after the ideal moment.
   */
  function closeWindow(world, cfg) {
    const T = world.timing;
    const P = T.plan;
    if (!P || isDecided(T, P.key)) return;
    const lat = world.settings.latency ?? 0;
    const cEnd = P.tStar + lat + cfg.late + TIMING.decideLag;
    const c = watch.lastT;
    const b = world.ball;
    const specHere = world.spec && b && world.spec.ballId === b.id;
    if (!P.closed && specHere && c >= P.tStar + lat && c - watch.stillSince(TIMING.stillSpeed) >= TIMING.stillFor
      && cEnd - TIMING.decideLag - c < TIMING.minBuild) {
      revertSpeculative(world, 'stopped');
      T.log.reverted++;
    }
    if (!P.closed && c >= cEnd) {
      P.closed = true;
      T.hold = null;
      if (world.spec && b && world.spec.ballId === b.id) {
        revertSpeculative(world, 'window');
        T.log.reverted++;
      }
      if (P.early) {
        const glassEarly = P.kind === 'after-wall' && Number.isFinite(P.wallT) && P.early.t < P.wallT;
        const serveEarly = P.receivingServe && Number.isFinite(P.bounceT) && P.early.t < P.bounceT;
        if (serveEarly) decideMiss(world, cfg, P, { reason: 'rules', rule: 'serve', e: P.early.e });
        else if (glassEarly) decideMiss(world, cfg, P, { reason: 'rules', rule: 'glass', e: P.early.e });
        else decideMiss(world, cfg, P, { reason: 'early', e: P.early.e });
        return;
      }
    }
    if (P.closed) {
      // The reason waits for a late swing; frames that stop coming do not keep it (or the
      // rulings it holds) waiting.
      if (c >= cEnd + TIMING.lateWait || world.time > P.tStar + cfg.late + 1.1) {
        const slow = watch.maxSpeed(P.tStar + lat - cfg.early - 0.2, P.tStar + lat + cfg.late);
        decideMiss(world, cfg, P, { reason: 'no-swing', speed: slow >= 1.6 ? slow : 0 });
      }
    } else if (world.time > P.tStar + cfg.late + 0.9) {
      // No camera frames came through (out of frame, tracker stalled).
      P.closed = true;
      decideMiss(world, cfg, P, { reason: 'tracking' });
    }
  }

  /** Each human tick (before physics): the plan for the incoming ball. */
  function update(world) {
    if (!world.timing) return;
    if (timingConfig(world)) planTiming(world);
    else if (world.timing.plan) {
      world.timing.plan = null;
      world.timing.hold = null;
    }
  }

  /** After each pose frame: swings -> hits / misses. Returns the confirmed shots. */
  function onFrame(world) {
    const shots = [];
    const T = world.timing;
    if (!T) return shots;
    const cfg = timingConfig(world);
    const P = T.plan;
    const short = P && (P.family === 'vfh' || P.family === 'vbh' || P.serve || ((world.mode && world.mode.apHints) || {}).shot === 'chiquita');
    const ev = watch.process(minSpeedFor(world, cfg, P), short ? TIMING.minTravelShort : TIMING.minTravel);
    if (!cfg) return shots;
    for (const e of ev) judgeSwing(world, cfg, e, shots);
    closeWindow(world, cfg);
    return shots;
  }

  /**
   * After each tick (ball stepped, display racket predicted): the speculative strike at t*, the
   * magnetized display racket, cues, learning slow motion, and the window timeout without frames.
   */
  function afterStep(world, { predictor = null, dt = 1 / 240 } = {}) {
    const T = world.timing;
    if (!T) return;
    const cfg = timingConfig(world);
    if (!cfg) {
      T.timeScale = 1;
      T.magnet = null;
      return;
    }
    const P = T.plan;
    const b = world.ball;
    const lat = world.settings.latency ?? 0;
    const pl = world.player;
    if (P && b && P.key === flightKeyOf(world) && !isDecided(T, P.key)) {
      const t = P.tStar;
      if (!P.specTried && !P.closed && world.time >= t - 1e-9 && world.time - dt <= t + 1e-9 && !world.spec && world.settings.hitPrediction !== false) {
        P.specTried = true;
        const pp = predictor && predictor.plan;
        const live = pp && !pp.dead && !pp.struck && pp.key === P.key && predictor.mix >= 0.3;
        const punch = P.family === 'vfh' || P.family === 'vbh';
        const prep = live && watch.prepared(t + lat - 0.9, punch ? TIMING.prepTravelShort : TIMING.prepTravel);
        const wentEarly = !!(P.early && P.early.e < -cfg.early);
        const ns = T.log.noStrike;
        if (ns) {
          if (!live) ns.tracking++;
          else if (!prep) ns.prep++;
          else if (wentEarly) ns.early++;
        }
        if (live && prep && !wentEarly) {
          const L = learned(world, P.family);
          const contact = contactOf(cfg, P, { e: 0, speed: L.speed, pathDeg: L.path, az: null, dist: null, offU: null, predicted: true });
          const pos = posAt(t + lat, pp0) || pl.pos;
          const shot = applySpeculativeHit(world, contact, null, t, {
            playerPos: { x: pos.x, z: pos.z }, cStar: t + lat, plan: { fam: P.family, timing: true },
          });
          if (shot) {
            predictor.strike();
            T.log.strikes++;
            if (world.spec && world.spec.pose) T.magnet = { t0: world.time, pose: world.spec.pose };
          }
        }
      }
      closeWindow(world, cfg);
      cues(world, cfg, P);
    }
    // Magnetized display racket: on the ball at the strike, released into the follow-through.
    if (T.magnet) {
      const age = world.time - T.magnet.t0;
      if (age > TIMING.magnetS || !pl.renderRacket) T.magnet = null;
      else blendRacketPose(pl.renderRacket, T.magnet.pose, 1 - smoothstep(0, TIMING.magnetS, age), pl.renderRacket);
    }
    slowmo(world, cfg, dt);
  }

  /** Coaching cues of glass balls (presentation only): intro, the audio tick, "now!". */
  function cues(world, cfg, P) {
    const T = world.timing;
    const C = T.cue;
    if (C.key !== P.key) T.cue = { key: P.key, intro: false, tick: false, now: false, voice: false };
    const c = T.cue;
    const now = world.time;
    const glass = P.glass;
    if (glass && !c.intro && Number.isFinite(P.wallT) && now < P.wallT) {
      c.intro = true;
      emitView(world, 'timing:cue', { kind: 'glass', t: P.tStar, text: 'Let it come off the glass…', es: 'Deja que salga del cristal…' });
    }
    if (glass && !c.voice && now >= P.tStar - 0.32) {
      c.voice = true;
      emitView(world, 'timing:cue', { kind: 'now-voice', t: P.tStar, text: 'Now!', es: '¡Ya!' });
    }
    const wantTick = glass || world.settings.timingTick === true;
    if (wantTick && !c.tick && now >= P.tStar - 0.15) {
      c.tick = true;
      emitView(world, 'timing:cue', { kind: 'tick', t: P.tStar });
    }
    if (glass && !c.now && now >= P.tStar - 0.08) {
      c.now = true;
      emitView(world, 'timing:cue', { kind: 'now', t: P.tStar, text: 'Now!', es: '¡Ya!' });
    }
  }

  /** Learning slow motion (settings.learningSlowmo): 0.7× from the glass rebound to the decision. */
  function slowmo(world, cfg, dt) {
    const T = world.timing;
    const P = T.plan;
    let want = 1;
    if (learningSlowmoOn(world.settings) && P && P.glass && Number.isFinite(P.wallT) && world.time >= P.wallT - 0.05
      && !isDecided(T, P.key) && world.time <= P.tStar + cfg.late + 0.4) want = TIMING.slowmo;
    const rate = dt / TIMING.slowmoEase;
    T.timeScale = clamp(T.timeScale + clamp(want - T.timeScale, -rate, rate), TIMING.slowmo, 1);
  }

  return {
    update,
    onFrame,
    afterStep,
    autoTarget,
    watch,
    learnedSpeed: (world, fam) => learned(world, fam).speed,
    learnedPath: (world, fam) => learned(world, fam).path,
  };
}

/** Reach-ring state for the renderer: { visible, progress (0 at the lead-in -> 1 at t*), green, t } or null. */
export function reachRing(world) {
  const T = world && world.timing;
  const P = T && T.plan;
  if (!P || P.closed || !timingConfig(world) || isDecided(T, P.key) || P.key !== flightKeyOf(world)) return null;
  if (world.spec && world.ball && world.spec.ballId === world.ball.id) return null; // struck on screen
  const cfg = timingConfig(world);
  const now = world.time;
  const t0 = P.tStar - cfg.early - TIMING.ringLead;
  if (now < t0 || now > P.tStar + cfg.late) return null;
  const inWindow = now >= P.tStar - cfg.early;
  return {
    progress: clamp((now - t0) / (P.tStar - t0), 0, 1),
    green: Math.abs(now - P.tStar) <= TIMING.green,
    inWindow,
    after: now > P.tStar,
    fade: now > P.tStar ? 1 - (now - P.tStar) / Math.max(0.05, cfg.late) : 1,
    tStar: P.tStar,
    pStar: P.pStar,
  };
}
