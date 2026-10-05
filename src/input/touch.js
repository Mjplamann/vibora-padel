// Swipe mode: one-finger swings on a touch screen drive the REAL timing pipeline.
//
// A swipe (src/input/swipe.js) becomes a SYNTHETIC RACKET SWING: court-frame racket poses at a
// 60 Hz capture clock, pushed into a racket track and judged by the same timing judge the camera
// uses (game/swingAssist.js createTimingJudge: swing watch, window, miss reasons, applyPlayerHit ->
// timingAnalysis pace / direction / spin, net safety, rules, scoring). Nothing is short-circuited:
//
//   - timing: the swing's velocity peak sits at capture time tSwing - displayLatency (the frame the
//     player reacted to), and world.settings.latency is 0, so the judge's error e = peak - t*;
//   - pace: the sweet-spot speed at the peak spans the camera-mode range (TIMING.speedRef / volley
//     range) from effort 0 to 1, as the judge's own ±2-frame difference measures it;
//   - direction: the horizontal swing direction is the family's usual one plus the swipe's aim
//     (cross-court <-> down the line; a curve adds sidespin; a sideways overhead is a víbora);
//   - spin / shot: the vertical path angle (up = topspin, down = slice, steep slow = lob, down on a
//     high ball = smash / bandeja);
//   - spacing: the arc passes through the ball at the contact the judge will rewind to (auto
//     positioning puts the player at the plan's stance); beyond arm's reach it falls short and the
//     judge reports "out of reach — step left / right".
//
// Movement: full auto-positioning (human.moveTo toward the timing plan's stance, home between
// balls); the optional left-thumb stick shifts it (fine positioning) or walks between balls.
// Display: the first-person racket (world.player.renderRacket) and the third-person actor state
// (stage.syncWorld selfActor: stroke + swingPhase) play the swing from the moment it is seen.
//
// Pure apart from bindTouchInput() (DOM). createTouchController() runs under node --test.

import { Vec3, v3 } from '../util/vec3.js';
import { clamp, smoothstep, lerp } from '../util/math.js';
import { RACKET, PLAYER, SIM } from '../config.js';
import { createRacketTrack, createRacketPose } from '../tracking/racketTrack.js';
import * as SA from '../game/swingAssist.js';
import { emitView } from '../game/world.js';
import { defaultBounds } from '../tracking/locomotion.js';
import { STROKES, contactPhase } from '../render/animation/strokes.js';
import { createSwipeRecognizer, shotIntent } from './swipe.js';

export const TOUCH = Object.freeze({
  /** Hz of the synthetic pose stream (capture time). */
  rate: 60,
  /** Largest personal timing bias (s) the judge may centre on in swipe mode (a phone's display latency). */
  biasMax: 0.08,
  /**
   * Idle poses trail the sim by this (s): room to insert a swing's approach and forward arc into the
   * past (a swipe is recognised ~0.05-0.1 s after its peak, which is itself a display latency in the
   * past). The judge's own decisions without a swing (no swing, early) wait this much longer.
   */
  holdBack: 0.45,
  /** Finger peak -> swing judged (s): world.tracking.delay (judge margin, held presentation events). */
  detectDelay: 0.07,
  /** Frame shown -> photons (s) on a phone: subtracted from the swipe time (the frame reacted to). */
  displayLatency: 0.045,
  /** Forward arc into the contact (m): at least the judge's minTravel / minTravelShort. */
  chord: 0.42,
  chordShort: 0.28,
  /** Reach (m from the hitting shoulder, 1.75 m player): beyond it the racket falls short of the ball. */
  reach: 1.25,
  /** Racket take-back before the ideal moment: starts / complete (s before t*). */
  prep: Object.freeze([0.9, 0.35]),
  /** Idle racket glide: stiffness (1/s) and speed cap (m/s, under every swing threshold). */
  idleK: 9,
  idleMax: 1.5,
  /** A new swing waits this long (s) after the previous one's peak. */
  cooldown: 0.28,
  /** A serve tap waits this long (s) for the serve plan. */
  tapWait: 2.5,
  /** Shown swing: the forward arc plays in this long (s) from the moment it is seen. */
  showFwd: 0.05,
  /** Stick: fine offset (m) at full tilt with a ball planned; walking speed (m/s) between balls. */
  stickOffset: 0.9,
  stickWalk: 3.0,
  stickRange: 3.0,
});

/** World settings swipe mode keeps (applied every tick; app/game.js may also pass them as overrides). */
export const TOUCH_OVERRIDES = Object.freeze({ latency: 0, hitMode: 'timing', swingDirWeight: 0.35 });

const { createTimingJudge, timingConfig, flightKeyOf, contactTimeFor, TIMING } = SA;

const STROKE_OF = Object.freeze({ fh: 'forehand', bh: 'backhand', vfh: 'volley-fh', vbh: 'volley-bh', oh: 'bandeja', sm: 'smash', serve: 'serve' });
const REF_H = PLAYER.defaultHeight;
const UP = v3(0, 1, 0);

/** Measured speed range (m/s at effort 0 and 1) of a stroke group, from the judge's own references. */
export function speedRange(group) {
  const ref = (TIMING && TIMING.speedRef) || [4, 13];
  const refV = (TIMING && TIMING.speedRefVolley) || [2.4, 8.5];
  if (group === 'volley') return [refV[0] + 0.6, refV[1] + 0.2];
  return [ref[0] + 0.6, ref[1] + 0.2];
}

/** Stroke group of a family for the speed range. */
export const groupOf = (fam) => (fam === 'vfh' || fam === 'vbh' ? 'volley' : fam === 'oh' || fam === 'sm' ? 'overhead' : fam === 'serve' ? 'serve' : 'ground');

/** Measured sweet-spot speed (m/s) for an effort 0..1. */
export function swingSpeed(effort, fam) {
  const r = speedRange(groupOf(fam));
  return lerp(r[0], r[1], clamp(effort, 0, 1));
}

/** The family's usual swing direction at the peak: { az (court azimuth, rad), pathDeg }. */
export function typicalSwing(fam, dom = 1) {
  const typ = TIMING && Number.isFinite(TIMING.typicalSwingAz) ? TIMING.typicalSwingAz : 0.35;
  switch (fam) {
    case 'bh': return { az: dom * typ, pathDeg: 12 };
    case 'vfh': return { az: -dom * 0.2, pathDeg: 0 };
    case 'vbh': return { az: dom * 0.2, pathDeg: 0 };
    case 'oh': case 'sm': return { az: 0, pathDeg: -10 };
    case 'serve': return { az: -dom * 0.2, pathDeg: 10 };
    default: return { az: -dom * typ, pathDeg: 15 };
  }
}

/** Unit swing direction (court axes) from an azimuth (rad, + toward +x) and a path angle (deg, + rising). */
export function dirOf(az, pathDeg, out = new Vec3()) {
  const p = (pathDeg * Math.PI) / 180;
  return out.set(Math.sin(az) * Math.cos(p), Math.sin(p), -Math.cos(az) * Math.cos(p));
}

/**
 * The timing judge's effort scale for swipes (world.timingProfile, game/timingProfile.js interface):
 * a swipe's effort is already normalised by the screen, so a measured swing speed maps back onto it
 * through the fixed ranges the swings are synthesised with (speedRange), not through the player's
 * recent swings. Timing bias (the personal moment the windows centre on: a phone's display
 * latency, the player's habit) is learned by `inner` when there is one.
 */
export function createTouchProfile(inner = null) {
  const groupOfKind = (kind) => (kind === 'volley' || kind === 'overhead' || kind === 'serve' ? kind : 'ground');
  return {
    key: 'touch',
    inner,
    // Only a device-latency-sized correction: in swipe mode the timing is the skill being played.
    get bias() { return inner && Number.isFinite(inner.bias) ? clamp(inner.bias, -TOUCH.biasMax, TOUCH.biasMax) : 0; },
    get n() { return inner && Number.isFinite(inner.n) ? inner.n : 0; },
    addTiming(e) { if (inner && inner.addTiming) inner.addTiming(e); },
    addSwing() { /* fixed scale */ },
    range(kind) { return speedRange(groupOfKind(kind)); },
    effort(kind, speed) {
      if (!Number.isFinite(speed)) return 0.5;
      const [lo, hi] = speedRange(groupOfKind(kind));
      return clamp((speed - lo) / (hi - lo), 0, 1);
    },
    reset() { if (inner && inner.reset) inner.reset(); },
    save() { if (inner && inner.save) inner.save(); },
    summary() {
      const s = (inner && inner.summary && inner.summary()) || { bias: 0, n: 0, kept: 0, text: null };
      const effort = {};
      for (const k of ['ground', 'volley', 'overhead', 'serve']) effort[k] = { range: speedRange(k).map((x) => Math.round(x * 100) / 100), n: 0 };
      return { ...s, key: 'touch', effort };
    },
  };
}

/**
 * Ball time the judge will play a swing peaking at capture time cPeak against plan P (latency 0):
 * swingAssist.js strike() — t* + kappa * e around the player's own moment (timingBias), a held
 * early swing at the window's edge, an early swing at a ball still in the air within reach as a
 * volley at the peak. Optional helpers are read from the module namespace (older judges: t* + kappa e).
 */
export function judgeContactTime(world, P, cPeak) {
  const cfg = timingConfig(world);
  const bias = typeof SA.timingBias === 'function' ? SA.timingBias(world) || 0 : 0;
  const e = cPeak - P.tStar - bias;
  const W = cfg && typeof SA.windowsOf === 'function' ? SA.windowsOf(cfg) : null;
  if (W && cfg && e < -cfg.early) {
    // Round 6 judge: a pre-bounce ball within volley reach of the body is volleyed when the swing peaks.
    if (volleyable(world, P, cPeak)) return cPeak;
    if (e >= -W.bufferEarly) return contactTimeFor(P, Math.max(e, -cfg.early));
  }
  return contactTimeFor(P, e);
}

/** swingAssist.js volleyChance(): the ball at tb is in the air on its way in, within TIMING.volleyReach. */
function volleyable(world, P, tb) {
  const V = TIMING && TIMING.volleyReach;
  if (!V || P.kind === 'volley' || P.serve || P.receivingServe || !Number.isFinite(P.bounceT)) return false;
  if (tb >= P.bounceT - 0.03 || tb <= world.flight.startT + 0.05) return false;
  const b = world.ball;
  if (!b) return false;
  let pos, vz;
  if (tb <= world.time && world.ballHistory) {
    const at = world.ballHistory.at(tb);
    if (!at || at.id !== b.id) return false;
    pos = at.pos;
    vz = at.vel.z;
  } else if (P.pStar && P.vStar) {
    const dt = tb - P.tStar;
    pos = { x: P.pStar.x + P.vStar.x * dt, y: P.pStar.y + P.vStar.y * dt - 0.5 * SIM.gravity * dt * dt, z: P.pStar.z + P.vStar.z * dt };
    vz = P.vStar.z;
  } else return false;
  if (!(pos.z > 0) || !(vz > 0)) return false;
  const pl = world.player;
  const pp = world.human && world.human.posAt ? world.human.posAt(Math.min(tb, world.time)) || pl.pos : pl.pos;
  const k = (world.settings.height || pl.height || REF_H) / REF_H;
  const ux = pos.x - pp.x, uz = pp.z - pos.z;
  return !(uz < -0.15 || uz > V.front * k || Math.abs(ux) > V.side * k || pos.y < V.low || pos.y > V.high * k);
}

// ---------------------------------------------------------------------------------------
// Swing arcs: piecewise cubic Hermite of the body-relative sweet spot (court axes)

function segment(t0, t1, p0, v0, p1, v1) {
  return { t0, t1, p0: new Vec3().copy(p0), v0: new Vec3().copy(v0), p1: new Vec3().copy(p1), v1: new Vec3().copy(v1) };
}

function sampleSegment(s, t, outP, outV) {
  const T = s.t1 - s.t0;
  const u = T > 0 ? clamp((t - s.t0) / T, 0, 1) : 1;
  const u2 = u * u, u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
  const d00 = 6 * u2 - 6 * u, d10 = 3 * u2 - 4 * u + 1, d01 = -6 * u2 + 6 * u, d11 = 3 * u2 - 2 * u;
  for (const k of ['x', 'y', 'z']) {
    outP[k] = h00 * s.p0[k] + h10 * s.v0[k] * T + h01 * s.p1[k] + h11 * s.v1[k] * T;
    if (outV) outV[k] = T > 0 ? (d00 * s.p0[k] + d10 * s.v0[k] * T + d01 * s.p1[k] + d11 * s.v1[k] * T) / T : 0;
  }
}

/**
 * A synthetic swing through `contact` (body-relative) at capture time cPeak, in three straight runs:
 *  1. take-back: from `from` (where the racket is, at rest) to `back` (TOUCH.chord behind the contact
 *     along the swing). The capture stream holds the racket at the planned contact, so this run goes
 *     backward (court +z): the judge's swing speed is forward only, so it never reads as a swing and
 *     may be quick; any other way it stays under approachMax;
 *  2. forward: straight from `back` into the contact along `dir`, the speed rising linearly (from
 *     rest, or from v0 when the time is short) to vPk at cPeak — the judge's watch sees one swing;
 *  3. follow-through: the mirror-image deceleration straight on, so the judge's ±2-frame difference
 *     peaks exactly at cPeak and reads vPk - slope·h (compensated: it reads `speed`).
 * Returns { cPeak, t0, tFwd, tEnd, vPk, speed, end, dir, wrapTo, sample(t, outP, outV) -> boolean }.
 */
export function buildSwing({ cPeak, cMin, from, contact, dir, speed, short = false, wrap = null, rise = 0.12, approachMax = 2.4 }) {
  const h = 1 / TOUCH.rate;
  const L = short ? TOUCH.chordShort : TOUCH.chord;
  const d = new Vec3().copy(dir).normalize();
  const back = new Vec3().copy(contact).addScaled(d, -L);
  const tb = new Vec3().subVectors(back, from);
  const S1 = tb.length();
  // The take-back reads as no swing when it goes backward (court +z) with a margin.
  const backward = S1 > 1e-6 && tb.z > 0.2 * S1;
  const avail = Math.max(0.05, cPeak - cMin);
  // Forward ramp (from rest when it fits) with the peak compensated for the ±2-frame difference.
  let vPk = speed, v0 = 0, T2 = 0, slope = 0;
  const solve = (start) => {
    for (let i = 0; i < 6; i++) {
      T2 = (2 * L) / (start + vPk);
      slope = (vPk - start) / T2;
      vPk = speed + slope * h;
    }
  };
  solve(0);
  // Take-back time: quick when it goes backward, under approachMax otherwise (rest to rest: peak 1.5 x mean).
  let T1 = S1 > 0.01 ? (backward ? clamp((1.5 * S1) / 5, 0.05, 0.16) : (1.5 * S1) / Math.max(0.3, approachMax)) : 0;
  if (T1 + T2 > avail) {
    // Short of time: a quicker take-back first, then a forward run that starts moving.
    if (S1 > 0.01) T1 = Math.max(0.04, Math.min(T1, avail * 0.35));
    const T2max = Math.max(0.035, avail - T1);
    if (T2 > T2max) {
      v0 = clamp((2 * L) / T2max - vPk, 0, 0.8 * speed);
      solve(v0);
    }
  }
  const tFwd = cPeak - T2;
  const t0 = tFwd - T1;
  const Tf = Math.min(0.25, vPk / slope);
  const along = vPk * Tf - 0.5 * slope * Tf * Tf;
  const end = new Vec3().copy(contact).addScaled(d, along);
  // Display only (not the judged stream): the follow-through wraps across the body and rises.
  const wrapTo = new Vec3();
  if (wrap) wrapTo.addScaled(wrap, 0.45 * along);
  wrapTo.y += rise * along;
  const sw = {
    cPeak, t0, tFwd, tEnd: cPeak + Tf, vPk, v0, speed, end, dir: d, T1, T2, Tf, wrapTo, back, backward,
    segs: [{ p0: new Vec3().copy(from) }],
    sample(t, outP, outV = null) {
      if (t < t0 - 1e-9 || t > sw.tEnd + 1e-9) return false;
      if (t >= cPeak) {
        const x = Math.min(t - cPeak, Tf);
        outP.copy(contact).addScaled(d, vPk * x - 0.5 * slope * x * x);
        if (outV) outV.copy(d).scale(Math.max(0, vPk - slope * x));
        return true;
      }
      if (t >= tFwd) {
        const x = t - tFwd; // 0 .. T2
        outP.copy(back).addScaled(d, v0 * x + 0.5 * slope * x * x);
        if (outV) outV.copy(d).scale(v0 + slope * x);
        return true;
      }
      // Take-back: rest-to-rest smoothstep along the straight from `from` to `back`.
      const u = T1 > 0 ? clamp((t - t0) / T1, 0, 1) : 1;
      const e = u * u * (3 - 2 * u);
      outP.copy(from).addScaled(tb, e);
      if (outV) outV.copy(tb).scale(T1 > 0 ? (6 * u * (1 - u)) / T1 : 0);
      return true;
    },
  };
  return sw;
}

/** Racket orientation for a body-relative sweet spot: handle away from the shoulder, face along the swing. */
function orient(sweet, vel, shoulder, faceHint, out) {
  out.axis.subVectors(sweet, shoulder);
  if (out.axis.lengthSq() < 1e-6) out.axis.set(0, 1, 0);
  out.axis.normalize();
  const sp = vel ? vel.length() : 0;
  if (sp > 0.8) out.normal.copy(vel).scale(1 / sp);
  else out.normal.copy(faceHint);
  out.normal.addScaled(out.axis, -out.normal.dot(out.axis));
  if (out.normal.lengthSq() < 1e-6) out.normal.set(0, 0, -1).addScaled(out.axis, out.axis.z);
  out.normal.normalize();
}

// ---------------------------------------------------------------------------------------
// The controller

/**
 * @param {object} [o]
 * @param {'right'|'left'} [o.handed]
 * @param {(ms:number) => number} [o.simTimeOf] performance ms -> sim s (app/clock.js)
 * @param {number} [o.offsetMs] personal timing offset (ms, + = the player's swipes come late)
 * @returns TouchController
 */
export function createTouchController({ handed = 'right', simTimeOf: simTimeOf0 = (ms) => ms / 1000, offsetMs = 0 } = {}) {
  let simTimeOf = simTimeOf0;
  const h = 1 / TOUCH.rate;
  let track = createRacketTrack({ capacity: 360 });
  let posAtFn = null;
  let judge = null;
  let cLast = -Infinity;
  let anchor = 0;
  const idle = { p: new Vec3(), v: new Vec3(), init: false };
  const shown = { p: new Vec3(), v: new Vec3(), init: false };
  let swing = null; // the capture-time swing being streamed
  let lastPeak = -Infinity;
  const queue = []; // swipes / taps not yet processed (tick has the world)
  let pendingTap = null;
  const stick = { x: 0, y: 0, active: false };
  const walk = { x: 0, z: 0 };
  let disp = null; // the shown swing: { s0, sw, stroke, cp, prep, from: Vec3, offset: Vec3 }
  let worldRef = null;
  let lastTime = null;
  const pose = createRacketPose();
  const shownPose = createRacketPose();
  const tmpP = new Vec3(), tmpV = new Vec3(), tmpC = new Vec3(), shoulder = new Vec3(), face = new Vec3();
  const ppOut = { x: 0, z: 0 };
  const ballOut = { pos: new Vec3(), vel: new Vec3(), spin: new Vec3(), t: 0, outside: false, atRest: false, lastSurface: null, id: 0 };
  const log = []; // last 60 swings: { cPeak, tStar, e, effort, kind, aimX, result, speed, at }
  const stats = { swipes: 0, swings: 0, taps: 0, pushed: 0, hits: 0, misses: 0, shadow: 0, ignored: 0 };
  const opts = { offsetMs, handed };
  /** Per stroke group: commanded / wanted speed, learned from the judge's measurements. */
  const gain = { ground: 1.06, volley: 1.06, overhead: 1.06, serve: 1.06 };

  const dom = () => (opts.handed === 'left' ? -1 : 1);
  const kOf = (world) => ((world && (world.player.height || world.settings.height)) || REF_H) / REF_H;

  function shoulderRel(world, fam, out) {
    const k = kOf(world);
    const H = REF_H * k;
    const side = fam === 'bh' || fam === 'vbh' ? 0.6 : 1; // a backhand turns the hitting shoulder in
    return out.set(dom() * 0.18 * k * side, PLAYER.shoulderHeightRatio * H, 0);
  }

  function readyRel(world, out) {
    const k = kOf(world);
    return out.set(dom() * 0.12 * k, 1.02 * k, -0.38 * k);
  }

  /** The live timing plan of the incoming ball (not yet decided), or null. */
  function livePlan(world) {
    const T = world.timing;
    const P = T && T.plan;
    if (!P || P.key !== flightKeyOf(world)) return null;
    return P;
  }
  const decided = (world, P) => !!(world.timing.decided && world.timing.decided.key === P.key);

  /** Body-relative contact of the plan at its stance (the ideal spot). */
  function planContactRel(P, out) {
    return out.set(P.pStar.x - P.stance.x, P.pStar.y, P.pStar.z - P.stance.z);
  }

  function familyOf(P) {
    return P ? (P.serve ? 'serve' : P.family || 'fh') : 'fh';
  }

  /** Prepared (taken back) racket for a plan, body-relative. */
  function preparedRel(world, P, out) {
    const fam = familyOf(P);
    const typ = typicalSwing(fam, dom());
    const d = dirOf(typ.az, typ.pathDeg, tmpV);
    planContactRel(P, out);
    out.addScaled(d, -((fam === 'vfh' || fam === 'vbh' ? TOUCH.chordShort : TOUCH.chord) + 0.04));
    out.y = Math.max(0.3, out.y);
    return out;
  }

  /**
   * Idle target (body-relative) at time t: ready, or for the planned ball — shown: taken back
   * (preparedRel); captured (judged stream): held at the planned contact, a little in front, so a
   * swing's own take-back runs backward and never reads as a swing.
   */
  function idleTarget(world, t, out, captured = false) {
    readyRel(world, out);
    const P = livePlan(world);
    if (!P || decided(world, P)) return out;
    const cfg = timingConfig(world);
    if (cfg && t > P.tStar + cfg.late + 0.15) return out;
    const w = smoothstep(P.tStar - TOUCH.prep[0], P.tStar - TOUCH.prep[1], t);
    if (w <= 0) return out;
    if (captured) {
      planContactRel(P, tmpC);
      tmpC.z -= 0.05;
    } else preparedRel(world, P, tmpC);
    return out.lerp(tmpC, w);
  }

  function glide(state, target, dt) {
    const K = TOUCH.idleK;
    if (!state.init) {
      state.p.copy(target);
      state.v.set(0, 0, 0);
      state.init = true;
      return;
    }
    const ax = K * K * (target.x - state.p.x) - 2 * K * state.v.x;
    const ay = K * K * (target.y - state.p.y) - 2 * K * state.v.y;
    const az = K * K * (target.z - state.p.z) - 2 * K * state.v.z;
    state.v.x += ax * dt; state.v.y += ay * dt; state.v.z += az * dt;
    const sp = state.v.length();
    if (sp > TOUCH.idleMax) state.v.scale(TOUCH.idleMax / sp);
    state.p.addScaled(state.v, dt);
  }

  function ensureJudge(world, human) {
    if (judge && worldRef === world) return;
    worldRef = world;
    track = createRacketTrack({ capacity: 360 });
    posAtFn = (t, out) => human.posAt(t, out);
    judge = createTimingJudge({
      racketTrack: track,
      posAt: (t, out) => posAtFn(t, out),
      prepTimeBefore: (c) => (swing && Math.abs(c - swing.cPeak) < 0.06 ? c - swing.tFwd : null),
    });
    cLast = -Infinity;
    swing = null;
    disp = null;
    idle.init = false;
    shown.init = false;
    queue.length = 0;
    pendingTap = null;
    walk.x = walk.z = 0;
  }

  function applyOverrides(world) {
    const s = world.settings;
    if (s.latency !== TOUCH_OVERRIDES.latency) s.latency = TOUCH_OVERRIDES.latency;
    if (s.hitMode !== TOUCH_OVERRIDES.hitMode) s.hitMode = TOUCH_OVERRIDES.hitMode;
    if (s.swingDirWeight !== TOUCH_OVERRIDES.swingDirWeight) s.swingDirWeight = TOUCH_OVERRIDES.swingDirWeight;
    if (world.tracking) {
      world.tracking.delay = TOUCH.detectDelay;
      world.tracking.frameDt = h;
    }
    opts.handed = s.handed === 'left' ? 'left' : 'right';
  }

  // ---- positioning --------------------------------------------------------------

  function position(world, human, dt) {
    const pl = world.player;
    const P = livePlan(world);
    const cfg = timingConfig(world);
    let tx, tz;
    let planned = false;
    if (P && P.stance && cfg) {
      const dec = decided(world, P) ? world.timing.decided : null;
      const release = dec ? world.time - dec.at > 0.35 : world.time > P.tStar + cfg.late + 0.6;
      if (!release) {
        tx = P.stance.x;
        tz = P.stance.z;
        planned = true;
      }
    }
    if (!planned) {
      // Between balls the stick walks (and the walk is kept); with no stick the player drifts home.
      if (stick.active && (stick.x || stick.y)) {
        walk.x = clamp(walk.x + stick.x * TOUCH.stickWalk * dt, -TOUCH.stickRange, TOUCH.stickRange);
        walk.z = clamp(walk.z - stick.y * TOUCH.stickWalk * dt, -TOUCH.stickRange, TOUCH.stickRange);
      }
      tx = pl.home.x + walk.x;
      tz = pl.home.z + walk.z;
    } else if (stick.active) {
      tx += stick.x * TOUCH.stickOffset;
      tz -= stick.y * TOUCH.stickOffset;
    }
    if (planned) {
      // The auto stance takes over: an old walk offset fades.
      const f = Math.exp(-dt / 1.5);
      walk.x *= f;
      walk.z *= f;
    }
    const b = defaultBounds();
    human.moveTo({ x: clamp(tx, b.xMin, b.xMax), z: clamp(tz, b.zMin, b.zMax) });
  }

  // ---- swings ---------------------------------------------------------------------

  function ballAt(world, tc, P) {
    const b = world.ball;
    if (b && tc <= world.time + 1e-9 && world.ballHistory) {
      const at = world.ballHistory.at(tc, ballOut);
      if (at && at.id === b.id) return tmpC.copy(at.pos);
    }
    if (P && P.pStar && P.vStar) {
      const dt = tc - P.tStar;
      return tmpC.copy(P.pStar).addScaled(P.vStar, dt).add(v3(0, -0.5 * SIM.gravity * dt * dt, 0));
    }
    return b ? tmpC.copy(b.pos) : null;
  }

  function relPoseFromSwing(sw, c, outP, outV) {
    return sw && sw.sample(c, outP, outV);
  }

  /** Starts a swing from a recognised swipe (or a serve tap): the capture-time arc and the shown one. */
  function startSwing(world, human, ev, { auto = false } = {}) {
    const pl = world.player;
    const P0 = livePlan(world);
    const P = P0 && !decided(world, P0) ? P0 : null;
    const fam = familyOf(P);
    const cPeak = auto && P ? P.tStar : simTimeOf(ev.tSwing) - TOUCH.displayLatency - (opts.offsetMs || 0) / 1000;
    if (cPeak - lastPeak < TOUCH.cooldown) {
      stats.ignored++;
      return null;
    }
    const intent = shotIntent(ev, { family: fam, serve: !!(P && P.serve) });
    const speed = swingSpeed(intent.effort, fam);
    const group = groupOf(fam);
    const typ = typicalSwing(fam, dom());
    const d = dirOf(typ.az + intent.azDev, intent.pathDeg, new Vec3());
    const k = kOf(world);
    shoulderRel(world, fam, shoulder);
    // The contact: where the ball will be when the judge rewinds to it (t* moved by the timing error).
    let contact;
    let shadow = false;
    if (P) {
      const tc = judgeContactTime(world, P, cPeak);
      const C = ballAt(world, tc, P);
      const pp = (posAtFn && posAtFn(Math.min(cPeak, world.time), ppOut)) || pl.pos;
      contact = C ? new Vec3(C.x - pp.x, C.y, C.z - pp.z) : planContactRel(P, new Vec3());
    } else {
      shadow = true;
      contact = new Vec3(dom() * 0.68 * k, 0.95 * k, -0.42 * k);
    }
    // Arm's reach: a ball further from the shoulder is met at full stretch (the judge measures the rest).
    const off = new Vec3().subVectors(contact, shoulder);
    const reach = TOUCH.reach * k;
    if (off.length() > reach) contact.copy(shoulder).addScaled(off.normalize(), reach);
    contact.y = Math.max(0.2, contact.y);
    // Where the racket is in the capture stream when this swing may start.
    const cMin = Math.max(cLast + h * 0.5, world.time - TOUCH.holdBack - 0.2);
    const from = new Vec3().copy(idle.p);
    if (swing && swing.tEnd > cLast) swing.sample(cLast, from);
    const wrap = new Vec3(fam === 'bh' || fam === 'vbh' ? dom() : -dom(), 0, 0);
    const short = fam === 'vfh' || fam === 'vbh';
    const cfg = timingConfig(world);
    const th = cfg && P && typeof SA.minSpeedFor === 'function' ? SA.minSpeedFor(world, cfg, P) : 3;
    const sw = buildSwing({
      cPeak, cMin, from, contact, dir: d, speed: speed * (gain[group] || 1), short, wrap: fam === 'oh' || fam === 'sm' ? null : wrap,
      approachMax: 0.7 * th,
      rise: fam === 'oh' || fam === 'sm' ? -0.4 : 0.12,
    });
    sw.fam = fam;
    sw.intent = intent;
    sw.shoulder = shoulder.clone();
    // The judge can only play a contact that is in the past (ball history, rewind): an early swipe's
    // peak is streamed once the ball has reached the contact it will be played at.
    sw.releaseAt = P ? judgeContactTime(world, P, cPeak) + 0.01 : -Infinity;
    swing = sw;
    anchor = cPeak;
    lastPeak = cPeak;
    stats.swings++;
    if (shadow) stats.shadow++;
    // Shown swing: from now, forward arc in TOUCH.showFwd s, then the follow-through.
    const stroke = strokeFor(P, intent);
    // A scheduled swing (serve tap) is shown so that its peak meets the ball at t*.
    const prevActor = actorFor(world);
    disp = {
      s0: auto ? Math.max(world.time, cPeak - TOUCH.showFwd) : world.time, sw, stroke, cp: contactPhase(stroke),
      from: new Vec3().copy(shown.init ? shown.p : idle.p),
      prep: prevActor && prevActor.holding === 'swing' ? prevActor.swingPhase || 0 : 0,
    };
    const rec = {
      at: world.time, cPeak, tStar: P ? P.tStar : null, e: P ? cPeak - P.tStar : null, effort: intent.effort, kind: intent.kind,
      aimX: ev.aimX ?? 0, speed, fam, group, auto, result: P ? 'pending' : 'shadow', shotId: null, key: P ? P.key : null,
    };
    log.push(rec);
    if (log.length > 60) log.shift();
    // Whoosh + workout count (audio engine, game.js): the shown racket's peak, now.
    emitView(world, 'player:swing', { t: world.time, phase: 'peak', speed, pos: new Vec3(pl.pos.x + contact.x, contact.y, pl.pos.z + contact.z) });
    return sw;
  }

  function strokeFor(P, intent) {
    let s = intent && intent.stroke;
    if (!s && P) {
      if (P.serve) s = 'serve';
      else if (P.glass && (P.family === 'fh' || P.family === 'bh')) s = P.family === 'bh' ? 'glass-bh' : 'glass-fh';
      else s = STROKE_OF[P.family] || 'forehand';
    }
    if (!s) s = 'forehand';
    return STROKES[s] ? s : 'forehand';
  }

  // ---- the capture stream -------------------------------------------------------------

  function nextGrid() {
    const n = Math.floor((cLast - anchor) / h + 1e-6) + 1;
    return anchor + n * h;
  }

  function pushPose(world, c) {
    let relOk = false;
    if (swing && c < swing.t0) {
      // A swing is coming (a serve tap, or a forward arc that starts later): hold where it starts.
      tmpP.copy(swing.segs[0].p0);
      tmpV.set(0, 0, 0);
      relOk = true;
    } else if (swing && c <= swing.tEnd + 1e-9) relOk = swing.sample(c, tmpP, tmpV);
    if (relOk) {
      idle.p.copy(tmpP);
      idle.v.set(0, 0, 0);
      idle.init = true;
    } else {
      if (swing && c > swing.tEnd) {
        idle.p.copy(swing.end);
        idle.v.set(0, 0, 0);
        swing = null;
      }
      const target = idleTarget(world, c, tmpC, true);
      glide(idle, target, Number.isFinite(cLast) ? Math.min(0.1, c - cLast) : h);
      tmpP.copy(idle.p);
      tmpV.copy(idle.v);
    }
    const pp = (posAtFn && posAtFn(c, ppOut)) || world.player.pos;
    const fam = swing ? swing.fam : familyOf(livePlan(world));
    shoulderRel(world, fam, shoulder);
    face.set(0, 0, -1);
    orient(tmpP, tmpV, shoulder, face, pose);
    pose.grip.set(pp.x + tmpP.x, tmpP.y, pp.z + tmpP.z).addScaled(pose.axis, -RACKET.sweetSpotY);
    pose.t = c;
    if (track.push(c, pose)) {
      cLast = c;
      stats.pushed++;
      return true;
    }
    return false;
  }

  function stream(world) {
    let front = world.time - TOUCH.holdBack;
    if (swing && swing.t0 <= world.time) {
      let f = Math.min(world.time, swing.tEnd + 2 * h);
      // Hold the stream just short of the peak until the contact moment has passed.
      if (world.time < swing.releaseAt) f = Math.min(f, swing.cPeak - 1.5 * h);
      front = Math.max(front, f);
    }
    if (!Number.isFinite(cLast)) {
      anchor = front;
      cLast = front - h;
    }
    let n = 0;
    while (n < 120) {
      const c = nextGrid();
      if (c > front + 1e-9) break;
      pushPose(world, c);
      n++;
    }
    return n;
  }

  // ---- display -----------------------------------------------------------------------

  function updateShown(world, dt) {
    const pl = world.player;
    if (disp && world.time >= disp.s0) {
      const sw = disp.sw;
      const tau = world.time - disp.s0;
      const fwd = TOUCH.showFwd;
      let arcT;
      if (tau < fwd) arcT = sw.tFwd + (tau / fwd) * (sw.cPeak - sw.tFwd);
      else arcT = sw.cPeak + (tau - fwd);
      if (arcT > sw.tEnd + 0.12) {
        shown.p.copy(sw.end).add(sw.wrapTo);
        shown.v.set(0, 0, 0);
        disp.done = true;
      } else {
        sw.sample(Math.min(arcT, sw.tEnd), shown.p, shown.v);
        if (arcT > sw.cPeak && sw.wrapTo) shown.p.addScaled(sw.wrapTo, smoothstep(0, 1, (arcT - sw.cPeak) / Math.max(0.05, sw.Tf)));
        if (tau < fwd) {
          // The arc starts where the racket is shown (not where the lagging capture stream had it).
          const w = 1 - smoothstep(0, 1, tau / fwd);
          sw.sample(sw.tFwd, tmpP);
          shown.p.addScaled(tmpC.subVectors(disp.from, tmpP), w);
        }
        if (tau < fwd) shown.v.scale((sw.cPeak - sw.tFwd) / fwd);
        shown.init = true;
      }
    }
    if (!disp || disp.done || world.time < disp.s0) {
      const target = idleTarget(world, world.time, tmpC);
      glide(shown, target, dt);
      if (disp && world.time < disp.s0) disp.from.copy(shown.p);
    }
    const fam = disp && !disp.done ? disp.sw.fam : familyOf(livePlan(world));
    shoulderRel(world, fam, shoulder);
    orient(shown.p, shown.v, shoulder, face.set(0, 0, -1), shownPose);
    shownPose.grip.set(pl.pos.x + shown.p.x, shown.p.y, pl.pos.z + shown.p.z).addScaled(shownPose.axis, -RACKET.sweetSpotY);
    shownPose.sweet.set(pl.pos.x + shown.p.x, shown.p.y, pl.pos.z + shown.p.z);
    shownPose.vel.copy(shown.v).add(pl.vel);
    shownPose.angVel.set(0, 0, 0);
    shownPose.t = world.time;
    // First-person view: the drawn racket (stage reads player.racket / renderRacket after the tick).
    if (!pl.renderRacket) pl.renderRacket = createRacketPose();
    copyPose(pl.renderRacket, shownPose);
    if (!pl.racket) pl.racket = createRacketPose();
    copyPose(pl.racket, shownPose);
  }

  function copyPose(dst, src) {
    dst.t = src.t;
    dst.grip.copy(src.grip);
    dst.axis.copy(src.axis);
    dst.normal.copy(src.normal);
    dst.vel.copy(src.vel);
    dst.angVel.copy(src.angVel);
    if (dst.sweet && src.sweet) dst.sweet.copy(src.sweet);
  }

  /** Third-person actor state (stage.syncWorld selfActor): the stroke keyed to the shown swing. */
  const actor = { pos: null, vel: null, facing: Math.PI, handed: 'right', stroke: null, swingPhase: 0, holding: 'ready' };
  function actorFor(world) {
    if (!world || !world.player) return null;
    const pl = world.player;
    const base = actor;
    base.pos = pl.pos;
    base.vel = pl.vel;
    base.handed = opts.handed;
    base.stroke = null;
    base.swingPhase = 0;
    base.holding = pl.speed > 0.6 ? 'run' : 'ready';
    const set = (stroke, phase) => {
      base.stroke = stroke;
      base.swingPhase = phase;
      base.holding = 'swing';
      return base;
    };
    if (disp && !disp.done && world.time >= disp.s0) {
      const tau = world.time - disp.s0;
      const cp = disp.cp;
      const p0 = clamp(disp.prep, 0, cp - 0.05);
      let phase;
      if (tau < 0.07) phase = lerp(p0, cp, smoothstep(0, 1, tau / 0.07));
      else phase = cp + ((tau - 0.07) / 0.42) * (1 - cp);
      if (phase < 1) return set(disp.stroke, phase);
    }
    const P = livePlan(world);
    if (P && !decided(world, P)) {
      const cfg = timingConfig(world);
      const now = world.time;
      if (!(cfg && now > P.tStar + cfg.late + 0.15)) {
        const w = smoothstep(P.tStar - TOUCH.prep[0], P.tStar - TOUCH.prep[1], now);
        if (w > 0.02) return set(strokeFor(P, null), 0.34 * w);
      }
    }
    return base;
  }

  // ---- results -------------------------------------------------------------------------

  function collect(world) {
    const T = world.timing;
    for (const rec of log) {
      if (rec.result !== 'pending') continue;
      const r = T.swings.slice().reverse().find((s) => Math.abs(s.c - rec.cPeak) < 0.03);
      if (r && r.result) {
        rec.result = r.result;
        rec.shotId = r.shotId ?? null;
        rec.measured = r.speed;
        rec.dist = r.dist;
        rec.e = r.e;
        // Speed calibration: the judge's measured peak against the one wanted (damped, bounded).
        if (r.speed > 0 && rec.speed > 0 && gain[rec.group]) {
          gain[rec.group] = clamp(gain[rec.group] * Math.sqrt(rec.speed / r.speed), 0.85, 1.5);
        }
        if (r.result === 'hit') stats.hits++;
        else if (r.result !== 'early' && r.result !== 'recovery') stats.misses++;
      } else if (T.decided && T.decided.key === rec.key && T.decided.kind === 'miss' && world.time - rec.at > 0.6) {
        rec.result = (T.lastMiss && T.lastMiss.reason) || 'miss';
        stats.misses++;
      } else if (world.time - rec.at > 2.5) rec.result = 'unjudged';
    }
  }

  // ---- public ---------------------------------------------------------------------------

  return {
    /** A recognised swing (swipe.js event). Processed on the next tick. */
    onSwipe(ev) {
      if (!ev || ev.type !== 'swing') return;
      stats.swipes++;
      queue.push({ kind: 'swing', ev });
    },
    /** A tap (swipe.js event): the serve, when the player is serving. */
    onTap(ev) {
      stats.taps++;
      queue.push({ kind: 'tap', ev });
    },
    setStick(x, y, active = true) {
      stick.x = clamp(x || 0, -1, 1);
      stick.y = clamp(y || 0, -1, 1);
      stick.active = !!active;
    },
    /**
     * Every fixed tick of the game (after stepWorld): overrides, positioning, queued swipes, the
     * capture stream into the timing judge, and the shown racket / actor.
     */
    tick(world, human, dt = 1 / SIM.tickRate) {
      ensureJudge(world, human);
      applyOverrides(world);
      position(world, human, dt);
      while (queue.length) {
        const q = queue.shift();
        if (q.kind === 'swing') startSwing(world, human, q.ev);
        else {
          const P = livePlan(world);
          if (P && P.serve && !decided(world, P)) startSwing(world, human, { effort: 0.55, upness: 1, aimX: 0, tSwing: 0 }, { auto: true });
          else if (world.flight && world.flight.by === 'drop') pendingTap = world.time;
        }
      }
      if (pendingTap !== null) {
        const P = livePlan(world);
        if (P && P.serve && !decided(world, P)) {
          pendingTap = null;
          startSwing(world, human, { effort: 0.55, upness: 1, aimX: 0, tSwing: 0 }, { auto: true });
        } else if (world.time - pendingTap > TOUCH.tapWait) pendingTap = null;
      }
      if (stream(world) > 0) {
        judge.onFrame(world);
        collect(world);
      }
      updateShown(world, lastTime === null ? dt : Math.max(0, Math.min(0.1, world.time - lastTime)));
      lastTime = world.time;
    },
    /** stage.syncWorld({ selfActor }) for the third-person view (one reused object). */
    selfActor(world = worldRef) {
      return actorFor(world);
    },
    get shownPose() { return shownPose; },
    get log() { return log; },
    get stats() { return stats; },
    get track() { return track; },
    get swing() { return swing; },
    get stick() { return { ...stick }; },
    get gain() { return { ...gain }; },
    /** Settings: personal timing offset (ms) and handedness (also read from world.settings). */
    setOffset(ms) { opts.offsetMs = Number.isFinite(ms) ? clamp(ms, -150, 150) : 0; },
    get offsetMs() { return opts.offsetMs; },
    setHanded(hd) { opts.handed = hd === 'left' ? 'left' : 'right'; },
    /** The clock mapping of touch timestamps (performance ms) to sim seconds (app/clock.js simTimeOf). */
    setClock(fn) { if (typeof fn === 'function') simTimeOf = fn; },
    /** Forget the session (a new world re-creates the judge and track anyway). */
    reset() {
      judge = null;
      worldRef = null;
      lastTime = null;
      lastPeak = -Infinity;
    },
  };
}

/**
 * Drives a TouchController from an app/game.js session: every fixed tick of game.advanceTo
 * (after stepWorld, before the caller's own onTick). Returns detach().
 */
export function attachTouchGame(game, controller) {
  const orig = game.advanceTo;
  const origSync = game.syncSettings;
  const human = game.human;
  game.advanceTo = (target, onTick = null) => orig(target, (w) => {
    controller.tick(w, human, 1 / SIM.tickRate);
    return onTick ? onTick(w) : false;
  });
  game.syncSettings = (s) => {
    origSync(s);
    Object.assign(game.world.settings, TOUCH_OVERRIDES);
  };
  Object.assign(game.world.settings, TOUCH_OVERRIDES);
  // The judge reads a swipe's effort through the touch scale (the timing bias stays the player's).
  const w = game.world;
  if (!(w.timingProfile && w.timingProfile.key === 'touch')) w.timingProfile = createTouchProfile(w.timingProfile || null);
  controller.reset();
  return () => {
    game.advanceTo = orig;
    game.syncSettings = origSync;
  };
}

// ---------------------------------------------------------------------------------------
// DOM binding (browser only)

/**
 * Binds the swipe recognizer to an element (the canvas): touch-action none, non-passive listeners
 * (no scroll, no pinch or double-tap zoom, no overscroll bounce), multi-touch by identifier.
 * Events go to `on` (swing / tap / pause / stick) and, for drawing feedback, to `onTrail`.
 * @returns {{ recognizer, dispose(), setStick(on), poll(tMs) }}
 */
export function bindTouchInput(el, { on = () => {}, onTrail = null, stick = false, opts = {} } = {}) {
  const rect = () => el.getBoundingClientRect();
  const r0 = rect();
  const rec = createSwipeRecognizer({ width: r0.width || innerWidth, height: r0.height || innerHeight, stick, opts });
  const prevTouchAction = el.style.touchAction;
  el.style.touchAction = 'none';
  el.style.webkitUserSelect = 'none';
  el.style.userSelect = 'none';
  el.style.webkitTouchCallout = 'none';
  const emit = (evs) => { for (const e of evs) on(e); };
  const ts = (e) => (Number.isFinite(e.timeStamp) && e.timeStamp > 0 ? e.timeStamp : performance.now());
  const handle = (kind) => (e) => {
    if (e.cancelable) e.preventDefault();
    const t = ts(e);
    for (const tc of e.changedTouches) {
      const id = tc.identifier;
      if (kind === 'start') emit(rec.down(id, tc.clientX, tc.clientY, t));
      else if (kind === 'move') {
        // Coalesced samples when the browser provides them (finer velocity peaks).
        emit(rec.move(id, tc.clientX, tc.clientY, t));
      } else if (kind === 'end') emit(rec.up(id, tc.clientX, tc.clientY, t));
      else emit(rec.cancel(id));
      if (onTrail) onTrail(kind, id, tc.clientX, tc.clientY, t);
    }
  };
  const hs = { touchstart: handle('start'), touchmove: handle('move'), touchend: handle('end'), touchcancel: handle('cancel') };
  for (const [k, fn] of Object.entries(hs)) el.addEventListener(k, fn, { passive: false });
  // iOS Safari pinch / double-tap zoom on the page.
  const stopGesture = (e) => { if (e.cancelable) e.preventDefault(); };
  document.addEventListener('gesturestart', stopGesture, { passive: false });
  document.addEventListener('dblclick', stopGesture, { passive: false });
  const onResize = () => {
    const r = rect();
    rec.resize(r.width || innerWidth, r.height || innerHeight);
  };
  addEventListener('resize', onResize);
  return {
    recognizer: rec,
    poll(tMs = performance.now()) { emit(rec.poll(tMs)); },
    setStick(onOff) { rec.setStick(onOff); },
    dispose() {
      for (const [k, fn] of Object.entries(hs)) el.removeEventListener(k, fn);
      document.removeEventListener('gesturestart', stopGesture);
      document.removeEventListener('dblclick', stopGesture);
      removeEventListener('resize', onResize);
      el.style.touchAction = prevTouchAction;
    },
  };
}
