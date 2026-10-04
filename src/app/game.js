// One playing session: world + human controller + mode + session stats, advanced by the
// fixed-step loop. Pure (no DOM / three), so it also runs under Node.
//
// Time: every world continues the global sim clock (world.time starts at the clock's
// current value), so the shared camera human controller (racket track, position history)
// always sees increasing times across sessions.
import { createRng } from '../util/math.js';
import { SIM, ASSIST, DEFAULT_ASSIST } from '../config.js';
import { createWorld, stepWorld, emit } from '../game/world.js';
import { createHumanController } from '../game/human.js';
import { createDrillMode, createRallyMode, createMatchMode } from '../game/modes.js';
import { createChallengeMode } from '../game/challenges.js';
import { racketById } from '../game/progression.js';
import { setRacketProfile, makeRacketProfile } from '../physics/racket.js';
import { getDrill, DRILL_BY_ID } from '../game/drills.js';
import { createSession } from '../game/session.js';
import { createAutopilotFeed } from './autofeed.js';
import { installCloseFeed } from './closeFeed.js';
import { createSyntheticCamera } from '../tracking/synthetic.js';

/** Workout recap: a counted swing (m/s at the sweet spot) and the window that groups its peaks (s). */
export const SWING_COUNT = Object.freeze({ min: 3, group: 0.8 });
export const STEP = 1 / SIM.tickRate;
/** Latency (s) used for mouse / trackpad input: one display frame. */
export const FALLBACK_LATENCY = 0;

/**
 * @param {object} o
 * @param {{kind:'drill'|'rally'|'match'|'challenge', drillId?, level?, games?, challengeId?, daily?,
 *   opponents?, partner?, teamNames?, resume?, career?, venue?}} o.spec  (round 4: arcade challenges and
 *   career matches: named AI pairs with personalities, the partner, a saved score to resume)
 * @param {object} o.settings live app settings (copied into world.settings and kept in sync)
 * @param {'camera'|'autopilot'|'fallback'} o.input
 * @param {object} [o.human] the camera human controller (input 'camera')
 * @param {object} [o.fallback] createFallbackControls() instance (input 'fallback')
 * @param {number} o.startTime sim time the world starts at
 * @param {object} [o.storage] {getItem,setItem} for bests
 * @param {number} [o.seed]
 * @param {number} [o.apLatency] display latency of the autopilot (s)
 * @param {number} [o.apDelivery] capture -> pose result delay of the autopilot feed (s)
 * @param {(frame, sample) => void} [o.onFrame] synthetic frames (autopilot) for PiP / cursor
 * @param {boolean} [o.attract] demo behind the title: no session records
 * @param {'precise'|'human'} [o.apProfile] the autopilot's play (tracking/autopilot.js HUMAN_PROFILE);
 *   default settings.apProfile or 'precise'
 * @param {number} [o.apJitter] extra random capture -> result delay (s, uniform 0..apJitter)
 * @param {number} [o.apNoise] landmark noise of the synthetic camera (1 = a typical webcam at 2.5 m)
 * @param {boolean} [o.apClose] close-mode autopilot (app/closeFeed.js): 1.7 m from a camera at chest
 *   height, legs out of the picture, a 30 fps webcam-like delivery (?apclose=1)
 */
export function createGame({
  spec, settings, input = 'camera', human = null, fallback = null, startTime = 0, storage = null,
  seed = 1, apLatency = 0, apDelivery = 0.045, onFrame = null, attract = false,
  apProfile = null, apJitter = null, apNoise = null, apClose = false,
}) {
  const overrides = input === 'autopilot' ? { latency: apLatency } : input === 'fallback' ? { latency: FALLBACK_LATENCY, gazeFollow: false } : {};
  const world = createWorld({ settings: { ...settings, ...overrides }, rng: createRng(seed) });
  world.input = input; // mouse play keeps physical hits (game/swingAssist.js timingConfig)
  // The equipped racket (game/progression.js RACKETS) sets the impact physics of this session.
  setRacketProfile(makeRacketProfile(racketById(world.settings.racketModel)));
  const session = attract ? null : createSession({ storage });
  let feed = null;
  let h = human;
  if (input !== 'camera' || !h) h = createHumanController({ settings: world.settings });
  world.human = h;
  world.player.handed = world.settings.handed;
  world.player.height = world.settings.height;

  if (input === 'autopilot') {
    feed = createAutopilotFeed({
      handed: world.settings.handed, height: world.settings.height, hfovDeg: world.settings.hfovDeg, seed: seed + 101,
      delivery: apDelivery,
    });
    const profile = attract ? 'precise' : apProfile || settings.apProfile || 'precise';
    const jit = apJitter ?? settings.apJitter ?? 0;
    const noise = apNoise ?? settings.apNoise ?? 0;
    if (apClose && !attract) {
      // Close mode: the virtual player stands 1.7 m from a camera at chest height (legs out of view).
      installCloseFeed(feed, {
        handed: world.settings.handed, height: world.settings.height, hfovDeg: world.settings.hfovDeg, seed: seed + 101,
        delivery: apDelivery, jitter: jit || 0.02, noise, profile,
      });
    } else {
      if (profile !== 'precise' && feed.autopilot.setProfile) feed.autopilot.setProfile(profile, { seed: seed * 7919 + 13 });
      if (jit > 0 || noise > 0) installRealisticFeed(feed, { delivery: apDelivery, jitter: jit, noise, hfovDeg: world.settings.hfovDeg, seed: seed + 991 });
    }
    // Stand still for a second, then calibrate the neutral spot (what the calibration screen does).
    world.time = startTime - 1.0;
    while (world.time < startTime - 1e-9) {
      feed.beforeTick(world, h, onFrame);
      stepWorld(world, STEP);
    }
    h.calibrate();
  } else {
    world.time = startTime;
  }

  // Mode.
  const handed = world.settings.handed;
  let mode;
  let drill = null;
  if (spec.kind === 'drill') {
    drill = getDrill(spec.drillId, handed) || getDrill('fh-drive', handed);
    mode = createDrillMode(drill, { rng: createRng(seed + 7), session });
  } else if (spec.kind === 'rally') {
    mode = createRallyMode({ level: spec.level || 'club', rng: createRng(seed + 7), session });
  } else if (spec.kind === 'challenge') {
    mode = createChallengeMode(spec.challengeId || 'por-tres-party', { rng: createRng(seed + 7), session, daily: spec.daily || null });
    drill = mode.activeDrill || null;
  } else {
    mode = createMatchMode({
      level: spec.level || 'club', games: spec.games || 4, rng: createRng(seed + 7), session,
      opponents: spec.opponents || null, partner: spec.partner || null, teamNames: spec.teamNames || null, resume: spec.resume || null,
      skill: Number.isFinite(spec.skill) ? spec.skill : null, partnerSkill: Number.isFinite(spec.partnerSkill) ? spec.partnerSkill : null,
      callouts: world.settings.callouts !== false,
      title: spec.career ? spec.career.eventName : 'Match',
      subtitle: spec.career ? `${spec.career.round} · ${spec.pairName || ''}` : null,
    });
  }
  world.mode = mode;
  mode.start(world);
  if (spec.kind === 'challenge') drill = mode.activeDrill || null;

  // Stats for tests / the debug overlay.
  const stats = {
    playerHits: 0, reps: 0, inCourt: 0, judgedShots: 0, points: 0, feeds: 0, rallies: 0, outcomes: {}, lastShot: null,
  };
  const offs = [
    world.bus.on('ball:hit', ({ shot }) => {
      // Provisional (predicted) hits are presentation: stats count the confirmed ones only.
      if (shot.by === 'player' && !shot.provisional) {
        stats.playerHits++;
        stats.lastShot = shot;
      }
    }),
    world.bus.on('ball:launch', ({ by }) => { if (by === 'machine' || by === 'drop' || by === 'coach') stats.feeds++; }),
    world.bus.on('shot:result', (r) => {
      if (r.shotId != null) {
        stats.judgedShots++;
        if (r.legal) stats.inCourt++;
      }
    }),
    world.bus.on('drill:rep', (r) => {
      stats.reps = r.index + 1;
      stats.points = r.totalPoints;
    }),
    world.bus.on('rally:outcome', (o) => {
      stats.rallies++;
      stats.outcomes[o.reason] = (stats.outcomes[o.reason] || 0) + 1;
    }),
    // Fitness recap: swing peaks the tracking reports ('player:swing' { phase, speed }). QA r5: the
    // take-back and the recovery around each stroke counted too (12 shots, 25 swings): peaks below
    // SWING_COUNT.min m/s are ignored and peaks within SWING_COUNT.group s of a counted one belong
    // to the same swing (its speed is the fastest of them).
    world.bus.on('player:swing', (p) => {
      if (!session || !p || p.phase !== 'peak' || !(p.speed >= SWING_COUNT.min)) return;
      if (world.time - lastSwingAt < SWING_COUNT.group) session.swingUpdate(p.speed);
      else session.swing(p.speed);
      lastSwingAt = world.time;
    }),
  ];

  let lastSwingAt = -Infinity;
  let lastKeyMove = -Infinity;
  let lastMoveKey = '';
  let fbNext = null;
  let lastFlickSwing = -Infinity;
  const FB_DT = 1 / 60;
  /** Pointer flick speed (m/s of the 3x-gained racket velocity) that starts an assisted swing. */
  const FLICK_SWING = 7;

  /** Fixed steps until world.time reaches `target` (sim s). Returns the number of ticks. */
  function advanceTo(target, onTick = null) {
    let n = 0;
    while (world.time + STEP <= target + 1e-9) {
      if (feed) feed.beforeTick(world, h, onFrame);
      // Mouse / trackpad input is sampled at 60 Hz of sim time, like a camera, so hits do not
      // depend on the display frame rate.
      if (input === 'fallback' && fallback && (fbNext === null || world.time >= fbNext - 1e-9)) {
        fallbackTick(FB_DT);
        fbNext = (fbNext === null ? world.time : fbNext) + FB_DT;
        if (fbNext < world.time) fbNext = world.time + FB_DT;
      }
      stepWorld(world, STEP);
      n++;
      if (onTick && onTick(world) === true) break; // e.g. a test freeze rule fired
    }
    return n;
  }

  /** One sample of the mouse / trackpad controls (fallback). */
  function fallbackTick(dt) {
    const nowReal = world.time;
    const r = fallback.update(dt, world);
    const pl = world.player;
    const key = r.moveTarget ? `${r.moveTarget.x.toFixed(3)},${r.moveTarget.z.toFixed(3)}` : '';
    if (key && key !== lastMoveKey) lastKeyMove = nowReal;
    lastMoveKey = key;
    let target = null;
    if (r.moveTarget && nowReal - lastKeyMove < 2.0) target = r.moveTarget;
    else {
      if (r.moveTarget) fallback.resetTarget();
      // Without keys the assist walks you to the ball (Rookie / Club), Pro stays home.
      const strength = (ASSIST[world.settings.assist] || ASSIST[DEFAULT_ASSIST]).magnet;
      target = pl.magnet && strength > 0 ? { x: pl.magnet.x, z: pl.magnet.z } : { x: pl.home.x, z: pl.home.z };
    }
    h.moveTo(target);
    // A pointer only moves the racket on a plane in front of the eyes, so a raw flick has almost
    // no speed toward the ball (in tests 3 of 15 flicks connected, at 7-17 km/h). A fast flick
    // while a ball is coming therefore starts the timed swing that Space starts.
    // The auto-swing's own racket speed (~11 m/s) must not re-trigger it around the contact.
    const b = world.ball;
    const swinging = !!(fallback.autoPlan && fallback.autoPlan.live);
    // The pointer's own flick speed (fallback.flickSpeed): walking (keys, magnet) is not a flick.
    const flick = r.flickSpeed ?? (r.racket ? r.racket.vel.length() : 0);
    if (!swinging && r.racket && flick > FLICK_SWING && world.time - lastFlickSwing > 0.9
      && b && !b.atRest && world.flight.team !== 0 && b.vel.z > 0) {
      lastFlickSwing = world.time;
      fallback.triggerAutoSwing();
    }
    if (r.racket) h.onRacketPose(world, r.racket, world.time);
  }

  /** Re-applies the live app settings to world.settings (keeping the input overrides). */
  function syncSettings(s) {
    Object.assign(world.settings, s, overrides);
    world.settings.volumes = { ...s.volumes };
    world.player.height = s.height;
    world.player.handed = s.handed;
  }

  function hud() {
    return mode.hud(world);
  }

  return {
    world,
    mode,
    session,
    drill,
    spec,
    input,
    feed,
    stats,
    attract,
    get human() { return h; },
    advanceTo,
    syncSettings,
    hud,
    emitHud(state) { emit(world, 'mode:hud', state); },
    isFinished: () => mode.isFinished(world),
    /**
     * Sim rate wanted right now (1, or < 1 during the learning slow motion off the glass,
     * game/swingAssist.js). The app's clock runs at speed × timeScale().
     */
    timeScale: () => (world.timing && Number.isFinite(world.timing.timeScale) ? world.timing.timeScale : 1),
    /** In play for kcal / active time: ball live and the referee not between points. */
    inPlay() {
      const ref = world.referee;
      return !!world.ball && !world.ball.atRest && !(ref && ref.state && ref.state.phase === 'dead');
    },
    dispose() {
      offs.forEach((off) => off());
      world.mode = null;
    },
  };
}

export const DRILL_IDS = Object.keys(DRILL_BY_ID);

/** Landmark noise (σ) of a webcam at ~2.5 m for apNoise = 1: image (normalised) and world (m) coordinates. */
export const WEBCAM_NOISE = Object.freeze({ image: 0.0016, world: 0.012, worldZ: 0.03 });

/**
 * Replaces an autopilot feed's frame delivery with a realistic one: 30 fps capture, each pose
 * result delivered `delivery` + U(0, jitter) s later (never out of order), and optional landmark
 * noise like a MacBook camera's (WEBCAM_NOISE × noise). The autopilot and camera are the feed's own.
 */
export function installRealisticFeed(feed, { delivery = 0.15, jitter = 0.02, noise = 0, fps = 30, hfovDeg = 68, seed = 991 } = {}) {
  const cam = createSyntheticCamera({ hfovDeg });
  const ap = feed.autopilot;
  const rng = createRng(seed);
  const pending = [];
  let next = null;
  const N = WEBCAM_NOISE;
  const perturb = (frame) => {
    if (!(noise > 0)) return frame;
    for (const p of frame.people || []) {
      for (const l of p.landmarks) {
        l.x += rng.normal(0, N.image * noise);
        l.y += rng.normal(0, N.image * noise);
      }
      for (const l of p.world) {
        l.x += rng.normal(0, N.world * noise);
        l.y += rng.normal(0, N.world * noise);
        l.z += rng.normal(0, N.worldZ * noise);
      }
    }
    return frame;
  };
  feed.beforeTick = (world, human, onFrame = null) => {
    if (next === null) next = world.time;
    if (world.tracking) {
      world.tracking.delay = delivery + jitter / 2;
      world.tracking.frameDt = 1 / fps;
    }
    if (world.time >= next - 1e-9) {
      const body = ap.update(world, world.time);
      const at = Math.max(world.time + delivery + rng() * jitter, pending.length ? pending[pending.length - 1].at : 0);
      pending.push({ at, frame: perturb(cam.frame(world.time * 1000, [body])), t: world.time });
      next += 1 / fps;
      if (next < world.time) next = world.time + 1 / fps;
    }
    while (pending.length && pending[0].at <= world.time + 1e-9) {
      const f = pending.shift();
      const sample = human.onPoseFrame(world, f.frame, f.t);
      if (onFrame) onFrame(f.frame, sample);
    }
  };
  return feed;
}
