// Game world: the single live ball, its history, the court, actors, the referee feed
// and lag-compensated player hits (SPEC §5.1). Pure module: no DOM, no three.
//
// Time model
//   world.time is the simulation clock (s). Physics events are emitted on the bus as soon
//   as they are simulated (render / audio react immediately), but the referee and the
//   game mode receive them through a short *judge queue*: an event is ruled only once it
//   is older than `settings.latency + JUDGE_MARGIN`. A player hit is detected late (the
//   camera shows the swing ~latency + one frame after the contact it caused), is rewound
//   to its contact time and invalidates the not-yet-judged events of the old trajectory,
//   so the referee always sees the true order: ...bounce, player hit, new events...
//   Judged items reach the mode as bus types 'judge:event' | 'judge:hit' | 'judge:launch'.
//
// Every bus emission made through `emit` is forwarded to world.mode.onBus(type, payload, world).

import { Vec3, v3 } from '../util/vec3.js';
import { clamp, createRng, createBus } from '../util/math.js';
import { COURT, BALL, SIM, PLAYER, TRACKING, ASSIST, DEFAULT_ASSIST, RACKET, netHeightAt } from '../config.js';
import { createBall, cloneBall, stepBall } from '../physics/ball.js';
import { createCourt } from '../physics/court.js';
import { createBallHistory } from '../physics/history.js';
import { predict, solveShot, netClearance, firstBounce } from '../physics/predict.js';
import { racketImpact, blendTowardIntent, spinComponents } from '../physics/racket.js';
import { classifyStroke, contactQuality, relabelByTrajectory } from '../tracking/swing.js';
import { createTimingState, timingAnalysis, judgeHoldOf } from './swingAssist.js';

const R = BALL.radius;
const UP = new Vec3(0, 1, 0);

/**
 * Minimum extra delay (s) on top of settings.latency before physics events are ruled. The
 * real margin adapts to the measured tracking pipeline (world.tracking): a contact is only
 * detected once its camera frame has been inferred (capture -> result) and the next frame
 * has settled the racket velocity (plus one more frame for a margin-only contact).
 */
export const JUDGE_MARGIN = 0.25;
/** Upper bound of the adaptive margin (s): a stalled tracker must not freeze the rulings. */
export const JUDGE_MARGIN_MAX = 0.6;
/** Minimum time between two player hits (s), SPEC §10.4. */
export const HIT_COOLDOWN = 0.25;

export const DEFAULT_SETTINGS = Object.freeze({
  assist: DEFAULT_ASSIST,
  latency: TRACKING.latencyDefault,
  height: PLAYER.defaultHeight,
  handed: 'right',
  gainLateral: TRACKING.gainLateral,
  gainDepth: TRACKING.gainDepth,
  hfovDeg: TRACKING.cameraPresets[TRACKING.defaultCamera].hfov,
  cameraPreset: TRACKING.defaultCamera,
  gazeFollow: true,
  fov: 70,
  landingMarker: true,
  contactGhost: false,
  halo: false,
  quality: 'high',
  voice: 'en',
  volumes: Object.freeze({ master: 0.9, sfx: 1, ambience: 0.5 }),
  // Predictive hitting: the racket shown meets the ball the player sees (swingPredict.js) and
  // the hit is played at once, then confirmed (or undone) by the lag-compensated detector.
  hitPrediction: true,
  // Round 3 (game/swingAssist.js): 'auto' = the assist's mode (Club / Rookie timing, Pro physical),
  // or 'timing' / 'physical' for every level.
  hitMode: 'auto',
  // Learning slow motion off the glass: 'auto' (on for Rookie), true or false.
  learningSlowmo: 'auto',
  // Audio tick 0.15 s before the moment to swing on every ball (glass balls always tick).
  timingTick: false,
});

/** Merges a partial settings object over DEFAULT_SETTINGS (volumes merged too). */
export function resolveSettings(patch = {}) {
  return {
    ...DEFAULT_SETTINGS,
    ...patch,
    volumes: { ...DEFAULT_SETTINGS.volumes, ...(patch.volumes || {}) },
  };
}

/** Team of a launcher / hitter tag. */
export function teamOfBy(by, fallback = 1) {
  if (by === 'player' || by === 'drop') return 0;
  if (by === 'machine' || by === 'coach') return 1;
  return fallback;
}

function createPlayer(settings) {
  const h = settings.height || PLAYER.defaultHeight;
  const home = { x: 0, z: 8 };
  return {
    pos: v3(home.x, 0, home.z),
    vel: v3(),
    home,
    height: h,
    handed: settings.handed || 'right',
    eye: v3(home.x, h * PLAYER.eyeHeightRatio, home.z),
    body: null,
    bodyCourt: null,
    racket: null,
    renderRacket: null, // racket to draw this frame: predicted (human.afterStep / swingPredict.js)
    lastHitAt: -Infinity,
    team: 0,
    magnet: null, // {x, z} assist stance point or null
    snapToHome: true, // teleport to home on the next controller update
    speed: 0,
  };
}

/**
 * @param {{settings?: object, rng?: Function, court?: object}} o
 * @returns World (SPEC §5.1 plus: human, flight, judge, lastHit, nextShotId)
 */
export function createWorld({ settings = {}, rng = createRng(1), court = null } = {}) {
  const s = resolveSettings(settings);
  return {
    time: 0,
    rng,
    court: court || createCourt(),
    bus: createBus(),
    settings: s,
    ball: null,
    ballHistory: createBallHistory(SIM.historySeconds, SIM.tickRate),
    ballEvents: [],
    player: createPlayer(s),
    coach: null,
    machine: null,
    ai: [],
    mode: null,
    referee: null,
    shots: [],
    // Extensions
    human: null, // createHumanController(); stepWorld calls human.update(world, dt)
    flight: { by: null, team: null, startT: 0, events: [] }, // events since the last launch / hit
    judge: { queue: [], delivered: -Infinity, until: -Infinity },
    lastHit: null, // { by, team, t }
    nextShotId: 1,
    // Measured pose pipeline (set by the app / autopilot feed): capture -> result delay and the
    // camera frame interval, both in s. Drives the adaptive judge margin.
    tracking: { delay: 0, frameDt: 1 / 30 },
    // Last lag-compensation rewrite of the live ball's path (renderer reconciles the jump).
    ballCorrection: null, // { seq, ballId, contactT, at, contact }
    // Player contacts the game refused, by reason (debug overlay, tests).
    hitRejects: { late: 0, rules: 0, other: 0, lastLate: null },
    // Speculative (predicted) player hit awaiting the camera's confirmation, or null. The live
    // ball stays the authoritative, unhit one; spec.ball is what is shown (see viewBall()).
    spec: null,
    // Discontinuities of the SHOWN ball (strike / confirm / revert / late): the renderer's cue.
    viewCorrection: null, // { seq, kind, ballId, contactT, at, contact }
    // Bus (presentation) events of the live ball held back because a hit may still erase them.
    held: [],
    // Ball within the player's reach recently (late hits can only erase events after that).
    reach: { key: null, lastIn: -Infinity },
    nextSpecId: 1000001,
    specStats: { strikes: 0, confirmed: 0, reverted: 0, cancelled: 0, lateOnly: 0, heldDropped: 0, dirDiffDeg: [], dtContact: [] },
    // Input kind ('camera' | 'autopilot' | 'fallback', set by app/game.js): mouse play keeps physical hits.
    input: null,
    // Timing-based hitting (game/swingAssist.js): contact plan, decisions, swings, misses, auto-positioning.
    timing: createTimingState(),
  };
}

/** Bus emit that also forwards to the active mode. */
export function emit(world, type, payload) {
  world.bus.emit(type, payload);
  if (world.mode && world.mode.onBus) world.mode.onBus(type, payload, world);
}

/**
 * Presentation-only emit (render, audio, UI): speculative hits and the shown ball's events.
 * The mode never sees these; rules and scoring follow the authoritative timeline only.
 */
export function emitView(world, type, payload) {
  world.bus.emit(type, payload);
}

/** The ball to draw: the speculatively struck ball while a predicted hit awaits confirmation. */
export function viewBall(world) {
  return world.spec ? world.spec.ball : world.ball;
}

// ---------------------------------------------------------------------------
// Judge queue

/** Extra judge delay (s) beyond settings.latency for the measured pipeline. */
export function judgeMargin(world) {
  const tr = world.tracking;
  const need = tr ? (tr.delay || 0) + 2 * (tr.frameDt || 1 / 30) : 0;
  return clamp(Math.max(JUDGE_MARGIN, need), JUDGE_MARGIN, JUDGE_MARGIN_MAX);
}

export function judgeDelay(world) {
  return (world.settings.latency ?? TRACKING.latencyDefault) + judgeMargin(world);
}

function queueJudge(world, item) {
  const q = world.judge.queue;
  let i = q.length;
  while (i > 0 && q[i - 1].t > item.t) i--;
  q.splice(i, 0, item);
}

function deliver(world, item) {
  const ref = world.referee;
  if (item.kind === 'event') {
    world.judge.delivered = Math.max(world.judge.delivered, item.t);
    if (ref) ref.onEvent(item.evt);
    emit(world, 'judge:event', { evt: item.evt });
  } else if (item.kind === 'hit') {
    if (ref) ref.onHit(item.team, { isServe: !!item.isServe, volley: !!item.volley });
    emit(world, 'judge:hit', { team: item.team, by: item.by, shot: item.shot || null, t: item.t, isServe: !!item.isServe });
  } else if (item.kind === 'launch') {
    emit(world, 'judge:launch', { by: item.by, ballId: item.ballId, t: item.t, team: item.team });
  }
}

/** Delivers every queued item with t <= time (in time order). */
export function flushJudge(world, time = Infinity) {
  const q = world.judge.queue;
  while (q.length && q[0].t <= time + 1e-9) deliver(world, q.shift());
  if (Number.isFinite(time)) world.judge.until = Math.max(world.judge.until, time);
}

function dropQueuedEventsAfter(world, t) {
  const q = world.judge.queue;
  for (let i = q.length - 1; i >= 0; i--) if (q[i].kind === 'event' && q[i].t > t + 1e-9) q.splice(i, 1);
}

// ---------------------------------------------------------------------------
// Events

const BUS_TYPE = {
  bounce: 'ball:bounce', wall: 'ball:wall', net: 'ball:net', netcord: 'ball:netcord', exit: 'ball:exit',
  ceiling: 'ball:ceiling', 'outside-bounce': 'ball:outside-bounce', rest: 'ball:rest',
};

/**
 * Physics event of the live ball: logged, queued for the judge and announced on the bus.
 * opts.silent: judged but not announced (the speculative ball already showed that stretch).
 */
function recordEvent(world, evt, opts = {}) {
  world.ballEvents.push(evt);
  world.flight.events.push(evt);
  const type = BUS_TYPE[evt.type];
  if (type && !opts.silent) {
    const release = holdUntil(world, evt);
    if (release === null) emit(world, type, { evt });
    else if (release === TIMING_HELD) world.held.push({ type, evt, release: Infinity, spec: false, timing: true });
    else world.held.push({ type, evt, release, spec: release === Infinity });
  }
  queueJudge(world, { kind: 'event', t: evt.t, evt });
}

// ---------------------------------------------------------------------------
// Held presentation events
//
// A late (lag-compensated) player hit erases the incoming ball's path after its contact. The
// sounds, glass shimmer and felt marks of that path must not play first. Events of the
// incoming ball close to the player are therefore announced a little late (<= the judge
// margin) and dropped if a hit erases them. Far-side events and events before any possible
// contact are announced at once.

/** Reach (m, 1.75 m player) from the hitting shoulder within which a contact is possible. */
export const HOLD_REACH = 1.3;
/** Longest hold (s) of a near-side event that a late hit might still erase. */
export const HOLD_MAX = 0.25;

const flightKeyOf = (world) => (world.ball ? `${world.ball.id}:${world.flight.startT}` : null);

function incomingToPlayer(world) {
  const f = world.flight;
  if (f.team === 0 && f.by !== 'drop') return false;
  const lh = world.lastHit;
  return !(lh && lh.team === 0 && lh.t >= f.startT - 1e-9);
}

/** Loop delay (s) between a contact and its detection: rewind latency + camera pipeline. */
export function detectionDelay(world) {
  const tr = world.tracking || {};
  return (world.settings.latency ?? 0) + (tr.delay || 0) + 2 * (tr.frameDt || 1 / 30);
}

/** holdUntil: held until the timing judge rules on the incoming ball (see releaseTimingHeld). */
const TIMING_HELD = -2;
/** Pose frames still arrive (s since the last one): otherwise no swing can be ruled a hit. */
const TIMING_FRAME_GAP = 0.5;
const timingFramesLive = (world) => !!(world.human && world.human.lastFrameAt > world.time - TIMING_FRAME_GAP);

/**
 * Release time of a live-ball event (Infinity: until the pending prediction resolves; TIMING_HELD:
 * until the timing judge rules) or null (now).
 */
function holdUntil(world, evt) {
  if (!world.human || !world.ball) return null;
  if (world.spec && world.spec.ballId === world.ball.id && evt.t > world.spec.t - 1e-9) return Infinity;
  // Timing hits: a swing can still be ruled a hit with any contact after the judge hold (the
  // earliest possible contact) until the judge decides or closes the window, which at webcam
  // latency comes ~0.4 s after the ideal moment. Events after that point wait for the ruling.
  if (world.timing && timingFramesLive(world) && evt.t > judgeHoldOf(world, true)) return TIMING_HELD;
  if (!incomingToPlayer(world) || evt.side !== 'near') return null;
  // Mouse controls (no latency, no camera pipeline): hits are found within a frame.
  if ((world.settings.latency ?? 0) + ((world.tracking && world.tracking.delay) || 0) < 0.04) return null;
  const loop = detectionDelay(world);
  const r = world.reach;
  if (r.key !== flightKeyOf(world) || evt.t - r.lastIn > loop) return null;
  // The player is waiting for a later contact (predicted swing): this event stands.
  const tc = world.human.predictedContact ? world.human.predictedContact(world) : null;
  if (tc !== null && tc > evt.t + 0.03) return null;
  return evt.t + Math.min(judgeMargin(world), loop, HOLD_MAX);
}

/** Tracks whether the incoming ball is within the player's reach (once per tick). */
function trackReach(world) {
  const b = world.ball;
  if (!b || b.atRest || !incomingToPlayer(world)) return;
  const pl = world.player;
  const k = (pl.height || PLAYER.defaultHeight) / PLAYER.defaultHeight;
  const dom = (world.settings.handed || pl.handed) === 'left' ? -1 : 1;
  const dx = b.pos.x - (pl.pos.x + dom * 0.18 * k);
  const dy = b.pos.y - PLAYER.shoulderHeightRatio * (pl.height || PLAYER.defaultHeight);
  const dz = b.pos.z - pl.pos.z;
  const key = flightKeyOf(world);
  if (world.reach.key !== key) {
    world.reach.key = key;
    world.reach.lastIn = -Infinity;
  }
  if (b.pos.y > 0.12 && dx * dx + dy * dy + dz * dz <= (HOLD_REACH * k) ** 2) world.reach.lastIn = world.time;
}

/** Announces held events that are due (time-ordered). */
function releaseHeld(world, now = world.time) {
  const h = world.held;
  if (!h.length) return;
  let keep = 0;
  for (let i = 0; i < h.length; i++) {
    const it = h[i];
    if (it.release <= now + 1e-9) emitView(world, it.type, { evt: it.evt });
    else h[keep++] = it;
  }
  h.length = keep;
}

/** A hit at contactT erased the live ball's path after it: its held events never happened. */
function dropHeldAfter(world, contactT) {
  const h = world.held;
  let keep = 0;
  for (let i = 0; i < h.length; i++) {
    if (h[i].evt.t > contactT + 1e-9) world.specStats.heldDropped++;
    else h[keep++] = h[i];
  }
  h.length = keep;
}

/** Releases events held for a timing ruling once it is made (recent ones now, stale ones dropped). */
function releaseTimingHeld(world, maxAge = 0.35) {
  if (!world.held.length || (Number.isFinite(judgeHoldOf(world, true)) && timingFramesLive(world))) return;
  let any = false;
  for (const it of world.held) {
    if (!it.timing) continue;
    it.timing = false;
    any = true;
    it.release = world.time - it.evt.t <= maxAge ? world.time : -1;
  }
  if (!any) return;
  const h = world.held;
  let keep = 0;
  for (let i = 0; i < h.length; i++) {
    if (h[i].release < 0) world.specStats.heldDropped++;
    else h[keep++] = h[i];
  }
  h.length = keep;
}

/** Releases events held for a speculative hit (recent ones now, stale ones dropped). */
function releaseSpecHeld(world, maxAge = 0.35) {
  for (const it of world.held) {
    if (!it.spec) continue;
    it.spec = false;
    it.release = world.time - it.evt.t <= maxAge ? world.time : -1;
  }
  const h = world.held;
  let keep = 0;
  for (let i = 0; i < h.length; i++) {
    if (h[i].release < 0) world.specStats.heldDropped++;
    else h[keep++] = h[i];
  }
  h.length = keep;
  releaseHeld(world);
}

// ---------------------------------------------------------------------------
// Ball lifecycle

/**
 * Replaces the live ball, resets its history and emits 'ball:launch'.
 * opts.strike = { team, isServe } additionally queues that team's stroke at launch time
 * (used for machine / AI serves, which leave the racket at the launch point).
 */
export function launchBall(world, { pos, vel = v3(), spin = v3(), by = 'machine', team = null, strike = null }) {
  const ball = createBall(pos, vel, spin);
  ball.t = world.time;
  if (world.spec) cancelSpeculative(world);
  // A new ball: what is still held of the old one plays now (it can no longer be erased).
  for (const it of world.held) it.release = it.spec || (it.timing && world.time - it.evt.t > 0.35) ? -1 : world.time;
  world.held = world.held.filter((it) => it.release >= 0);
  releaseHeld(world);
  world.ball = ball;
  world.ballHistory.clear();
  world.ballHistory.push(ball);
  const tm = team ?? teamOfBy(by);
  world.flight = { by, team: tm, startT: world.time, events: [] };
  world.lastHit = strike ? { by, team: strike.team, t: world.time } : null;
  emit(world, 'ball:launch', { ball, by });
  queueJudge(world, { kind: 'launch', t: world.time, by, ballId: ball.id, team: tm });
  if (strike) {
    // The ball leaves a racket (AI serve): it is a stroke like any other for the bus and the log.
    const fl = analyseFlight(world, ball);
    const shot = {
      id: world.nextShotId++, t: world.time, by, team: strike.team, stroke: strike.stroke || (strike.isServe ? 'serve' : 'forehand'),
      contact: ball.pos.clone(), contactU: null, racketSpeed: null, speedIn: 0, speedOut: ball.vel.length(),
      spinRpm: spinComponents(ball.vel, ball.spin), offCenter: 0, quality: 1, assist: null, timing: null, spacing: null,
      netClearance: fl.netClearance, predictedLanding: fl.predictedLanding, afterBounce: false, afterWall: false,
      isServe: !!strike.isServe, volley: false, apex: fl.apex, actorPos: strike.actorPos || null,
    };
    world.shots.push(shot);
    queueJudge(world, { kind: 'hit', t: world.time, team: strike.team, by, isServe: !!strike.isServe, volley: false, shot });
    emit(world, 'ball:hit', { shot });
  }
  return ball;
}

const stepEvents = []; // scratch: events of one tick (the event objects themselves are kept)
let correctionSeq = 0; // unique across worlds (renderers compare it)

/** One fixed tick: actors -> ball physics -> events -> history -> judged items. */
export function stepWorld(world, dt = 1 / SIM.tickRate) {
  if (!(dt > 0)) return world;
  world.ballEvents.length = 0;
  if (world.human) world.human.update(world, dt);
  if (world.machine) world.machine.update(world, dt);
  if (world.coach) world.coach.update(world, dt);
  for (let i = 0; i < world.ai.length; i++) world.ai[i].update(world, dt);
  if (world.mode && world.mode.update) world.mode.update(world, dt);

  const t1 = world.time + dt;
  const ball = world.ball;
  if (ball) {
    const evs = stepEvents;
    evs.length = 0;
    stepBall(ball, t1 - ball.t > 0 ? t1 - ball.t : dt, world.court, world.rng, evs);
    ball.t = t1;
    for (let i = 0; i < evs.length; i++) recordEvent(world, evs[i]);
    evs.length = 0;
  }
  world.time = t1;
  if (ball) world.ballHistory.push(ball);
  trackReach(world);
  if (world.spec) stepSpeculative(world);
  // Swing prediction, speculative contacts and their resolution (human controller).
  if (world.human && world.human.afterStep) world.human.afterStep(world, dt);
  if (world.timing) releaseTimingHeld(world);
  releaseHeld(world);
  // Timing hits: rulings after the earliest possible contact wait until the swing is decided (a
  // miss until its reason is known, so the rep / point result carries it).
  flushJudge(world, Math.min(world.time - judgeDelay(world), world.timing ? judgeHoldOf(world) : Infinity));
  return world;
}

// ---------------------------------------------------------------------------
// Hits

/** Whether the human (team 0) may strike a ball contacted at sim time t. Flushes the judge up to t. */
export function playerMayHit(world, t) {
  if (!world.ball) return false;
  const rj = world.hitRejects;
  if (world.lastHit && t <= world.lastHit.t + 1e-6) { if (rj) rj.other++; return false; } // somebody struck it after that
  if (world.judge.delivered > t + 1e-9) {
    // Already ruled on what came after: the contact was detected too late for the judge window.
    if (rj) { rj.late++; rj.lastLate = { t, at: world.time, by: world.time - t }; }
    return false;
  }
  flushJudge(world, t);
  const ref = world.referee;
  if (!ref) return world.flight.team !== 0 || world.flight.by === 'drop';
  const ok = ref.canContact ? ref.canContact(0) : ref.canHit(0);
  if (!ok && rj) rj.rules++;
  return ok;
}

const freeB = createBall();
const freeOut = { landed: false, x: 0, z: 0, t: 0, apex: 0, net: null };

/**
 * Free flight (no walls / net) to the floor: { landed, x, z, t, apex, net } (net = centre
 * height over the tape at z = 0, or null). Returns a shared object: copy what you keep.
 */
export function freeFlight(pos, vel, spin, maxTime = 4) {
  freeB.pos.copy(pos);
  freeB.vel.copy(vel);
  freeB.spin.copy(spin);
  freeB.t = 0;
  freeB.atRest = false;
  freeB.outside = false;
  const h = 1 / SIM.tickRate;
  const out = freeOut;
  out.landed = false;
  out.apex = pos.y;
  out.net = null;
  for (let t = 0; t < maxTime; t += h) {
    const px = freeB.pos.x, py = freeB.pos.y, pz = freeB.pos.z;
    stepBall(freeB, h, null, null, null);
    const p = freeB.pos;
    if (p.y > out.apex) out.apex = p.y;
    if (out.net === null && ((pz > 0 && p.z <= 0) || (pz < 0 && p.z >= 0))) {
      const f = pz / (pz - p.z);
      out.net = py + (p.y - py) * f - netHeightAt(px + (p.x - px) * f);
    }
    if (p.y <= R && py > R) {
      const f = (py - R) / (py - p.y);
      out.landed = true;
      out.x = px + (p.x - px) * f;
      out.z = pz + (p.z - pz) * f;
      out.t = t + f * h;
      return out;
    }
  }
  out.x = freeB.pos.x;
  out.z = freeB.pos.z;
  out.t = maxTime;
  return out;
}

/**
 * Intended landing depth windows (m past the net) per stroke, used by the assist blend.
 * apex: lob apex window (ball centre, m). maxSpeed (m/s) caps the intended pace.
 */
export const SHOT_INTENT = Object.freeze({
  forehand: { depth: [7.5, 9.0] },
  backhand: { depth: [7.5, 9.0] },
  'glass-fh': { depth: [7.5, 9.0] },
  'glass-bh': { depth: [7.5, 9.0] },
  'volley-fh': { depth: [6.5, 9.0] },
  'volley-bh': { depth: [6.5, 9.0] },
  lob: { depth: [7.5, 9.3], apex: [5.5, 7.0] },
  bandeja: { depth: [7.0, 9.3], maxSpeed: 85 / 3.6 },
  vibora: { depth: [6.5, 9.3] },
  // Por tres needs a bounce 2-3.5 m past the net at >= 120 km/h (turf crater model, court.js).
  smash: { depth: [2.0, 4.5] },
  chiquita: { depth: [1.5, 5.0], maxSpeed: 45 / 3.6 },
  serve: { depth: [3.0, 6.6] },
});

/**
 * The shot the player was going for: same azimuth and pace as the physical one, the
 * stroke's typical depth (drive deep, lob deep and high, smash steep, chiquita short).
 * from: contact point, phys: physical outgoing velocity, spin: outgoing spin.
 * dirZ: -1 when hitting toward the far side (near player). Returns {vel, target} or null.
 */
export function intendedShot(from, phys, spin, stroke, { dirZ = -1, serveBox = null } = {}) {
  if (phys.z * dirZ < 0.5) return null; // not heading over the net
  const ff = freeFlight(from, phys, spin);
  // The intent follows what the shot physically is: a soft short ball is a chiquita / drop and a
  // high one a lob, whatever the stroke label (contact height thresholds are fuzzy).
  const overhead = stroke === 'bandeja' || stroke === 'vibora' || stroke === 'smash';
  let key = stroke;
  if (!overhead && stroke !== 'serve') {
    const physDepth = ff.landed ? ff.z * dirZ : 0;
    if (ff.apex > 4.0) key = 'lob';
    else if (phys.length() < 14 && physDepth < 5.0) key = 'chiquita';
  }
  const spec = SHOT_INTENT[key] || SHOT_INTENT.forehand;
  const depth = clamp(ff.landed ? ff.z * dirZ : spec.depth[0], spec.depth[0], spec.depth[1]);
  const tz = dirZ * depth;
  let tx = from.x + (phys.x / phys.z) * (tz - from.z);
  tx = clamp(tx, -COURT.halfWidth + 0.6, COURT.halfWidth - 0.6);
  if (stroke === 'serve' && serveBox) {
    // Diagonal box of the receiver (near server -> far box: 'right' is x <= 0).
    const sgn = (serveBox === 'right' ? -1 : 1) * (dirZ < 0 ? 1 : -1);
    tx = sgn > 0 ? clamp(tx, 0.3, COURT.halfWidth - 0.6) : clamp(tx, -COURT.halfWidth + 0.6, -0.3);
  }
  const target = v3(tx, 0, tz);
  let speed = phys.length();
  if (spec.maxSpeed) speed = Math.min(speed, spec.maxSpeed);
  let res = null;
  if (spec.apex) {
    res = solveShot({ from, target, spin, apex: clamp(ff.apex, spec.apex[0], spec.apex[1]) });
  } else {
    res = solveShot({ from, target, spin, speed });
    if (!res.ok || !res.clearsNet) {
      const dist = Math.hypot(tx - from.x, tz - from.z);
      res = solveShot({ from, target, spin, apex: Math.max(from.y + 0.5, netHeightAt(tx) + 0.9 + 0.08 * dist) });
    }
  }
  if (!res || !res.ok) return null;
  return { vel: res.vel, target };
}

const nsV = new Vec3();
const nsW = new Vec3();

function rotateUp(vel, delta, out) {
  const s = vel.length();
  nsV.copy(vel).scale(1 / s);
  nsW.copy(UP).addScaled(nsV, -nsV.y);
  if (nsW.lengthSq() < 1e-12) return out.copy(vel);
  nsW.normalize();
  return out.copy(nsV).scale(Math.cos(delta)).addScaled(nsW, Math.sin(delta)).scale(s);
}

/**
 * Net-safety assist: if the ball would hit the net (centre clearance < 0.12 m or falls
 * short), lift its launch angle by `strength` of the lift that gives a 0.35 m clearance.
 * Mutates ball.vel. Returns the lift applied (rad).
 */
export function applyNetSafety(ball, strength, dirZ = -1) {
  if (!(strength > 0) || ball.vel.z * dirZ <= 0) return 0;
  const clearOk = (vel, need) => {
    const f = freeFlight(ball.pos, vel, ball.spin, 3);
    return f.net !== null && f.net >= need;
  };
  if (clearOk(ball.vel, 0.12)) return 0;
  const trial = new Vec3();
  let lo = 0, hi = 0.6;
  if (!clearOk(rotateUp(ball.vel, hi, trial), 0.35)) return 0;
  for (let i = 0; i < 14; i++) {
    const mid = 0.5 * (lo + hi);
    if (clearOk(rotateUp(ball.vel, mid, trial), 0.35)) hi = mid;
    else lo = mid;
  }
  const delta = hi * clamp(strength, 0, 1);
  rotateUp(ball.vel, delta, ball.vel);
  return delta;
}

/** Shot analytics shared by every hitter: net clearance, landing and apex of the new flight. */
function analyseFlight(world, ball) {
  const pred = predict(ball, world.court, { maxTime: 3.5 });
  let apex = ball.pos.y;
  for (const s of pred.samples) if (s.pos.y > apex) apex = s.pos.y;
  const fb = firstBounce(pred);
  return { netClearance: netClearance(pred), predictedLanding: fb ? fb.pos.clone() : null, apex, prediction: pred };
}

function flightContext(world, t, side) {
  let bounced = false, afterWall = false;
  for (const e of world.flight.events) {
    if (e.t > t + 1e-9) break;
    if (e.side !== side) continue;
    if (e.type === 'bounce') bounced = true;
    else if (e.type === 'wall' && bounced) afterWall = true;
  }
  return { afterBounce: bounced, afterWall };
}

/**
 * Racket impact, stroke analysis and assist of a player contact. Mutates `ball` (at the
 * contact) into the outgoing ball. Shared by the authoritative and the speculative hit so
 * both see exactly the same physics. Returns the analysis (shot fields) or null (no hit).
 */
function strikeAnalysis(world, ball, contact, poseAtContact, contactTime, extra, assist) {
  const s = world.settings;
  const ref = world.referee;
  const isServe = !!(ref && ref.state.awaitingServe && ref.state.serving && ref.state.serving.team === 0);
  const ctx = flightContext(world, contactTime, 'near');
  if (contact && contact.timing) {
    // Timing hit (swingAssist.js): the shot comes from the swing's timing, speed and path.
    const a = timingAnalysis(world, ball, contact, contactTime, extra, ctx, isServe);
    if (!a) return null;
    a.lift = applyNetSafety(ball, assist.netSafety, -1);
    const v = ball.vel;
    const ff = freeFlight(ball.pos, v, ball.spin, 3);
    const launchDeg = (Math.atan2(v.y, Math.hypot(v.x, v.z)) * 180) / Math.PI;
    a.stroke = relabelByTrajectory(a.pathStroke, { apex: ff.apex, launchDeg, speed: v.length() }, a.groundStroke);
    a.info.speedOut = v.length();
    return a;
  }
  const contactPos = ball.pos.clone();
  const speedIn = ball.vel.length();

  const info = racketImpact(ball, poseAtContact, contact, { margin: assist.contactMargin });
  if (!info.hit) return null;

  // Stroke and contact analysis in the user frame U at the contact.
  const pl = world.player;
  const pp = extra.playerPos || pl.pos;
  const contactU = v3(contactPos.x - pp.x, contactPos.y, pp.z - contactPos.z);
  const rv = poseAtContact.vel || v3();
  const racketVelU = v3(rv.x, rv.y, -rv.z);
  const nrm = poseAtContact.normal;
  const racketNormalU = v3(nrm.x, nrm.y, -nrm.z);
  const handed = s.handed || pl.handed;
  const strokeArgs = {
    contactU, racketVelU, handed, ballBounced: ctx.afterBounce, ballAfterWall: ctx.afterWall,
    playerZ: pp.z, isServe, racketNormalU, height: s.height,
  };
  const pathStroke = classifyStroke(strokeArgs);
  const groundStroke = pathStroke === 'lob' ? classifyStroke({ ...strokeArgs, noLob: true }) : pathStroke;

  // Assist: blend toward the intended shot, then net safety.
  const physVel = ball.vel.clone();
  let intent = null;
  if (assist.shotBlend > 0) {
    // The intent follows the ball the racket physically produced, like the label below (merge
    // pass): a rising racket path on a flat 65-75 km/h drive made the intent a 5.5 m-apex lob,
    // and blending toward it at the drive's pace sent the ball onto the far glass on the full.
    const pf = freeFlight(ball.pos, physVel, ball.spin, 3);
    const physLaunch = (Math.atan2(physVel.y, Math.hypot(physVel.x, physVel.z)) * 180) / Math.PI;
    const intentStroke = relabelByTrajectory(pathStroke, { apex: pf.apex, launchDeg: physLaunch, speed: physVel.length() }, groundStroke);
    intent = intendedShot(ball.pos, physVel, ball.spin, intentStroke, { dirZ: -1, serveBox: isServe ? ref.state.serving.box : null });
    if (intent) blendTowardIntent(physVel, intent.vel, assist.shotBlend, ball.vel);
  }
  const lift = applyNetSafety(ball, assist.netSafety, -1);

  // Lob or drive is read from the ball that left the racket (racket path as tie-breaker).
  const v = ball.vel;
  const ff = freeFlight(ball.pos, v, ball.spin, 3);
  const launchDeg = (Math.atan2(v.y, Math.hypot(v.x, v.z)) * 180) / Math.PI;
  const stroke = relabelByTrajectory(pathStroke, { apex: ff.apex, launchDeg, speed: v.length() }, groundStroke);
  const q = contactQuality({ contactU, handed, stroke, height: s.height });
  return { info, stroke, pathStroke, q, ctx, isServe, contactPos, contactU, speedIn, physVel, intent, lift };
}

function makePlayerShot(world, a, ball, fl, contactTime, extra, id) {
  return {
    id,
    t: contactTime,
    by: 'player',
    team: 0,
    stroke: a.stroke,
    contact: a.contactPos,
    contactU: a.contactU,
    racketSpeed: a.info.racketSpeed,
    speedIn: a.speedIn,
    speedOut: ball.vel.length(),
    spinRpm: spinComponents(ball.vel, ball.spin),
    offCenter: a.info.offCenter,
    quality: a.info.quality,
    assist: world.settings.assist,
    timing: a.q.timing,
    spacing: a.q.spacing,
    netClearance: fl.netClearance,
    predictedLanding: fl.predictedLanding,
    afterBounce: a.ctx.afterBounce,
    afterWall: a.ctx.afterWall,
    // Extensions
    isServe: a.isServe,
    volley: !a.ctx.afterBounce,
    face: a.info.face,
    contactScore: a.q.score,
    contactFront: a.q.front,
    contactSide: a.q.side,
    contactHeight: a.q.height,
    physSpeedOut: a.info.speedOut,
    physVel: a.physVel.clone(),
    assistLiftDeg: (a.lift * 180) / Math.PI,
    intentTarget: a.intent ? a.intent.target : null,
    apex: fl.apex,
    eA: a.info.eA,
    racketStroke: a.pathStroke,
    swing: extra.swing || null,
    // Timing hit (swingAssist.js): timing error, swing speed / path, quality, shot type, aim.
    timingHit: a.timing || null,
  };
}

/**
 * Lag-compensated player hit (SPEC §5.1). Rewinds the ball to contactTime, applies the
 * racket impact, the assist (intent blend + net safety), re-simulates to world.time and
 * emits 'ball:hit'. Returns the ShotRecord, or null when the hit is not allowed.
 * With a speculative hit of the same ball pending, this is its confirmation: the shown ball
 * blends from the speculative path onto this one, and the shot carries `confirms` (the
 * provisional shot's id; its sound and effects have already played).
 * @param contact sweptContact() result (local, face, ...)
 * @param poseAtContact RacketPose at the contact (court frame, with vel / angVel)
 * @param contactTime sim time of the contact (ball clock)
 * @param extra optional { playerPos: {x,z} at contact, swing: {...} }
 */
export function applyPlayerHit(world, contact, poseAtContact, contactTime, extra = {}) {
  const s = world.settings;
  const assist = ASSIST[s.assist] || ASSIST[DEFAULT_ASSIST];
  if (!world.ball || contactTime > world.time + 1e-9) return null;
  if (!playerMayHit(world, contactTime)) return null;

  const snap = world.ballHistory.rewindTo(contactTime);
  if (!snap || snap.id !== world.ball.id) return null;
  const ball = snap;
  if (contactTime > ball.t) stepBall(ball, contactTime - ball.t, world.court, null, null, { deterministic: true });
  ball.t = contactTime;
  if (ball.atRest) return null;

  const a = strikeAnalysis(world, ball, contact, poseAtContact, contactTime, extra, assist);
  if (!a) return null;
  const outVel = ball.vel.clone();

  // Commit: the old trajectory after contactTime never happened.
  world.ballHistory.truncateAfter(contactTime);
  const tickTimes = [];
  const latest = world.ballHistory.latest();
  // Tick times between the contact and now, on the world's tick grid.
  const step = 1 / SIM.tickRate;
  let tk = latest ? latest.t + step : contactTime + step;
  while (tk < world.time - 1e-9) {
    if (tk > contactTime + 1e-9) tickTimes.push(tk);
    tk += step;
  }
  tickTimes.push(world.time);
  world.ballHistory.push(ball);
  dropQueuedEventsAfter(world, contactTime);
  const fe = world.flight.events;
  while (fe.length && fe[fe.length - 1].t > contactTime + 1e-9) fe.pop();

  const fl = analyseFlight(world, ball);
  const shot = makePlayerShot(world, a, ball, fl, contactTime, extra, world.nextShotId++);
  const pl = world.player;

  // A pending prediction of this ball: this hit confirms it.
  const spec = world.spec && world.spec.ballId === ball.id ? world.spec : null;
  if (spec) {
    shot.confirms = spec.id;
    shot.provisionalT = spec.t;
    const st = world.specStats;
    st.confirmed++;
    const c = (outVel.dot(spec.outVel) / Math.max(1e-9, outVel.length() * spec.outVel.length()));
    st.dirDiffDeg.push((Math.acos(clamp(c, -1, 1)) * 180) / Math.PI);
    st.dtContact.push(spec.t - contactTime);
    if (st.detail && poseAtContact) {
      const ang = (a, b) => (Math.acos(clamp(a.dot(b) / Math.max(1e-9, a.length() * b.length()), -1, 1)) * 180) / Math.PI;
      const pv = poseAtContact.vel || v3();
      st.detail.push({
        normal: Math.min(ang(spec.pose.normal, poseAtContact.normal), 180 - ang(spec.pose.normal, poseAtContact.normal)),
        velDir: ang(spec.pose.vel, pv), speedRatio: spec.pose.vel.length() / Math.max(1e-9, pv.length()),
        pos: spec.contact.distanceTo(a.contactPos), dt: spec.t - contactTime, out: st.dirDiffDeg[st.dirDiffDeg.length - 1],
        stroke: shot.stroke, plan: spec.plan || null, specC: spec.contact.clone(), authC: a.contactPos.clone(), pl: { x: world.player.pos.x, z: world.player.pos.z },
      });
    }
    world.spec = null;
  } else if (world.spec) {
    cancelSpeculative(world);
  } else world.specStats.lateOnly++;
  dropHeldAfter(world, contactTime);
  if (spec) releaseSpecHeld(world);

  pl.lastHitAt = contactTime;
  world.ball = ball;
  world.ballCorrection = {
    seq: ++correctionSeq,
    ballId: ball.id, contactT: contactTime, at: world.time, contact: a.contactPos,
  };
  world.viewCorrection = {
    seq: correctionSeq, kind: spec ? 'confirm' : 'late', ballId: ball.id, contactT: contactTime, at: world.time, contact: a.contactPos,
  };
  world.flight = { by: 'player', team: 0, startT: contactTime, events: [] };
  world.lastHit = { by: 'player', team: 0, t: contactTime };
  world.shots.push(shot);
  queueJudge(world, { kind: 'hit', t: contactTime, team: 0, by: 'player', isServe: a.isServe, volley: shot.volley, shot });
  emit(world, 'ball:hit', { shot });

  // Re-simulate to the present; the new events keep their real times. After a confirmed
  // prediction the shown (speculative) ball has already played this stretch.
  for (const t of tickTimes) {
    const evs = [];
    if (t > ball.t) stepBall(ball, t - ball.t, world.court, world.rng, evs);
    ball.t = t;
    world.ballHistory.push(ball);
    for (const e of evs) recordEvent(world, e, { silent: !!spec });
  }
  flushJudge(world, Math.min(contactTime, world.time - judgeDelay(world)));
  return shot;
}

// ---------------------------------------------------------------------------
// Speculative (predicted) hits

/** Whether the live ball may be struck speculatively now (no judge flush: rules as known). */
export function mayStrikeSpeculatively(world, t) {
  const b = world.ball;
  if (!b || b.atRest || b.outside || world.spec) return false;
  if (world.settings.hitPrediction === false) return false;
  if (!incomingToPlayer(world)) return false;
  if (t - world.player.lastHitAt < HIT_COOLDOWN) return false;
  const f = world.flight;
  let nearBounces = 0;
  for (const e of f.events) {
    if (e.t > t + 1e-9) break;
    if (e.type === 'exit' || e.type === 'outside-bounce' || e.type === 'rest') return false;
    if (e.type === 'bounce' && e.side === 'near' && ++nearBounces >= 2) return false;
  }
  const ref = world.referee;
  if (!ref) return true;
  // The opponent's stroke may still be in the judge queue: then it is theirs to have hit.
  const q = world.judge.queue;
  for (let i = 0; i < q.length; i++) if (q[i].kind === 'hit' && q[i].team !== 0 && q[i].t >= f.startT - 1e-9) return true;
  return ref.canContact ? ref.canContact(0) : ref.canHit(0);
}

/**
 * Speculative player hit (predicted swing met the shown ball): the shown ball is struck at
 * contact time t (<= now) with the predicted racket pose, the usual assist, and flown to the
 * present. The authoritative ball, its history and the judge are untouched: the camera's
 * swing confirms it (applyPlayerHit) or the prediction is undone (revertSpeculative).
 * Emits 'ball:hit' with shot.provisional = true on the bus only (not to the mode).
 * extra: { playerPos, cStar (racket capture time of the predicted contact) }
 */
export function applySpeculativeHit(world, contact, poseAtContact, t, extra = {}) {
  if (t > world.time + 1e-9 || !mayStrikeSpeculatively(world, t)) return null;
  const assist = ASSIST[world.settings.assist] || ASSIST[DEFAULT_ASSIST];
  const at = world.ballHistory.at(t);
  if (!at || at.id !== world.ball.id || at.atRest) return null;
  const ball = cloneBall(at);
  ball.t = t;
  const a = strikeAnalysis(world, ball, contact, poseAtContact, t, extra, assist);
  if (!a) return null;
  const outVel = ball.vel.clone();
  const fl = analyseFlight(world, ball);
  const shot = makePlayerShot(world, a, ball, fl, t, extra, world.nextSpecId++);
  shot.provisional = true;
  // Fly to the present (deterministic: the authoritative simulation's rng is not touched).
  const evs = [];
  if (world.time > ball.t) stepBall(ball, world.time - ball.t, world.court, null, evs, { deterministic: true });
  ball.t = world.time;
  // A timing strike has no tracked racket at the contact: its virtual contact pose is drawn.
  if (a.pose) poseAtContact = a.pose;
  const pose = {
    grip: poseAtContact.grip.clone(), axis: poseAtContact.axis.clone(), normal: poseAtContact.normal.clone(),
    vel: (poseAtContact.vel || v3()).clone(), angVel: (poseAtContact.angVel || v3()).clone(), t,
  };
  pose.sweet = pose.grip.clone().addScaled(pose.axis, RACKET.sweetSpotY);
  world.spec = {
    id: shot.id, ballId: world.ball.id, flightStartT: world.flight.startT, t, ball, shot, outVel, pose,
    contact: a.contactPos, cStar: extra.cStar ?? t + (world.settings.latency ?? 0), at: world.time, plan: extra.plan || null,
  };
  world.viewCorrection = { seq: ++correctionSeq, kind: 'strike', ballId: ball.id, contactT: t, at: world.time, contact: a.contactPos, pose };
  world.specStats.strikes++;
  emitView(world, 'ball:hit', { shot });
  for (const e of evs) announceSpecEvent(world, e);
  return shot;
}

function announceSpecEvent(world, e) {
  const type = BUS_TYPE[e.type];
  e.speculative = true;
  if (type) emitView(world, type, { evt: e });
}

/** Advances the shown speculative ball to world.time (its events are presentation only). */
function stepSpeculative(world) {
  const sp = world.spec;
  if (!world.ball || world.ball.id !== sp.ballId) {
    cancelSpeculative(world);
    return;
  }
  const b = sp.ball;
  if (world.time > b.t) {
    const evs = [];
    stepBall(b, world.time - b.t, world.court, null, evs, { deterministic: true });
    b.t = world.time;
    for (const e of evs) announceSpecEvent(world, e);
  }
}

/**
 * The camera saw no contact where the prediction struck (a whiff, or a swing stopped short):
 * the shown ball returns to the real one, the held sounds of its path play, and
 * 'ball:unhit' { shot } cancels the provisional shot.
 */
export function revertSpeculative(world, reason = 'whiff') {
  const sp = world.spec;
  if (!sp) return false;
  world.spec = null;
  world.specStats.reverted++;
  world.viewCorrection = { seq: ++correctionSeq, kind: 'revert', ballId: sp.ballId, contactT: sp.t, at: world.time, contact: sp.contact };
  emitView(world, 'ball:unhit', { shot: sp.shot, reason });
  releaseSpecHeld(world);
  return true;
}

/** Drops a pending prediction without a visual blend (the ball itself was replaced or taken). */
function cancelSpeculative(world) {
  const sp = world.spec;
  if (!sp) return;
  world.spec = null;
  world.specStats.cancelled++;
  if (world.ball && world.ball.id === sp.ballId) {
    world.viewCorrection = { seq: ++correctionSeq, kind: 'revert', ballId: sp.ballId, contactT: sp.t, at: world.time, contact: sp.contact };
  }
  emitView(world, 'ball:unhit', { shot: sp.shot, reason: 'cancelled' });
  releaseSpecHeld(world);
}

/**
 * Strike by an AI actor (coach, opponents, partner) at world.time: sets the ball's
 * velocity and spin, emits 'ball:hit' with a ShotRecord and queues the referee hit.
 * Returns the ShotRecord, or null if the referee does not allow that team to hit.
 * opts: { by: 'coach'|'ai'|'player', team, vel, spin, stroke, racketSpeed?, quality?, actorPos?, isServe?, force?,
 *         extra?: fields merged into the ShotRecord (e.g. choice, aim, error) }
 */
export function applyAiHit(world, opts) {
  const ball = world.ball;
  if (!ball || ball.atRest) return null;
  const { by = 'coach', team = 1, vel, spin, stroke = 'forehand' } = opts;
  if (!opts.force && world.flight.team === team && world.flight.by !== 'drop') return null; // own team's ball
  flushJudge(world, world.time);
  const ref = world.referee;
  if (ref && !opts.force && !ref.canHit(team)) return null;
  if (world.spec) cancelSpeculative(world); // somebody else (AI partner) played it
  const side = team === 0 ? 'near' : 'far';
  const ctx = flightContext(world, world.time, side);
  const contact = ball.pos.clone();
  const speedIn = ball.vel.length();
  ball.vel.copy(vel);
  ball.spin.copy(spin);
  ball.lastSurface = 'racket';
  ball.atRest = false;
  world.ballHistory.push(ball); // replaces the snapshot at this time
  const fl = analyseFlight(world, ball);
  const ap = opts.actorPos;
  const shot = {
    id: world.nextShotId++,
    t: world.time,
    by,
    team,
    stroke,
    contact,
    contactU: null,
    racketSpeed: opts.racketSpeed ?? null,
    speedIn,
    speedOut: ball.vel.length(),
    spinRpm: spinComponents(ball.vel, ball.spin),
    offCenter: 0,
    quality: opts.quality ?? 1,
    assist: null,
    timing: null,
    spacing: null,
    netClearance: fl.netClearance,
    predictedLanding: fl.predictedLanding,
    afterBounce: ctx.afterBounce,
    afterWall: ctx.afterWall,
    isServe: !!opts.isServe,
    volley: !ctx.afterBounce,
    apex: fl.apex,
    actorPos: ap ? { x: ap.x, z: ap.z } : null,
    ...(opts.extra || {}),
  };
  world.flight = { by, team, startT: world.time, events: [] };
  world.lastHit = { by, team, t: world.time };
  world.shots.push(shot);
  queueJudge(world, { kind: 'hit', t: world.time, team, by, isServe: !!opts.isServe, volley: shot.volley, shot });
  flushJudge(world, world.time);
  emit(world, 'ball:hit', { shot });
  return shot;
}

/**
 * predict() of the live ball whose events are prefixed with the events the current flight
 * already had (bounces / walls since the last launch or hit). interceptCandidates() labels
 * contacts from the events it walks, so without this a ball that has already bounced would
 * be read as not having bounced (a volley) and its next bounce as the first one.
 */
export function predictFlight(world, opts = {}) {
  const pred = predict(world.ball, world.court, opts);
  const t = world.ball.t + 1e-9;
  const past = world.flight.events.filter((e) => e.t <= t);
  if (past.length) pred.events = past.concat(pred.events);
  return pred;
}

/**
 * The stroke that put the live ball in flight (ShotRecord) or null (fed / dropped ball).
 * Unlike referee.state this is current: the referee hears about strokes after the judge delay.
 */
export function currentStroke(world) {
  const s = world.shots.length ? world.shots[world.shots.length - 1] : null;
  return s && world.ball && s.t >= world.flight.startT - 1e-9 ? s : null;
}

/** Copy of the live ball (or null). */
export function ballSnapshot(world) {
  return world.ball ? cloneBall(world.ball) : null;
}
