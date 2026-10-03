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
import { getDrill, DRILL_BY_ID } from '../game/drills.js';
import { createSession } from '../game/session.js';
import { createAutopilotFeed } from './autofeed.js';

export const STEP = 1 / SIM.tickRate;
/** Latency (s) used for mouse / trackpad input: one display frame. */
export const FALLBACK_LATENCY = 0;

/**
 * @param {object} o
 * @param {{kind:'drill'|'rally'|'match', drillId?, level?}} o.spec
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
 */
export function createGame({
  spec, settings, input = 'camera', human = null, fallback = null, startTime = 0, storage = null,
  seed = 1, apLatency = 0, apDelivery = 0.045, onFrame = null, attract = false,
}) {
  const overrides = input === 'autopilot' ? { latency: apLatency } : input === 'fallback' ? { latency: FALLBACK_LATENCY, gazeFollow: false } : {};
  const world = createWorld({ settings: { ...settings, ...overrides }, rng: createRng(seed) });
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
  } else {
    mode = createMatchMode({ level: spec.level || 'club', games: spec.games || 4, rng: createRng(seed + 7), session });
  }
  world.mode = mode;
  mode.start(world);

  // Stats for tests / the debug overlay.
  const stats = {
    playerHits: 0, reps: 0, inCourt: 0, judgedShots: 0, points: 0, feeds: 0, rallies: 0, outcomes: {}, lastShot: null,
  };
  const offs = [
    world.bus.on('ball:hit', ({ shot }) => {
      if (shot.by === 'player') {
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
  ];

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
    const b = world.ball;
    if (r.racket && r.racket.vel.length() > FLICK_SWING && world.time - lastFlickSwing > 0.9
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
