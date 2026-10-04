// Test helper (not a test file): app/game.js createGame's autopilot path, with the close-range feed
// (app/closeFeed.js) installed before the calibration stand-still, or the realistic full-body feed.
import { createRng } from '../../src/util/math.js';
import { SIM } from '../../src/config.js';
import { createWorld, stepWorld } from '../../src/game/world.js';
import { createHumanController } from '../../src/game/human.js';
import { createDrillMode, createRallyMode, createMatchMode } from '../../src/game/modes.js';
import { getDrill } from '../../src/game/drills.js';
import { createAutopilotFeed } from '../../src/app/autofeed.js';
import { installCloseFeed } from '../../src/app/closeFeed.js';
import { installRealisticFeed } from '../../src/app/game.js';

const STEP = 1 / SIM.tickRate;

export function createTestGame({
  spec, settings, seed = 1, apLatency = 0.11, apDelivery = 0.15, apJitter = 0.02, apNoise = 1, profile = 'human', close = false, closeOpts = {}, startTime = 10,
}) {
  const world = createWorld({ settings: { ...settings, latency: apLatency }, rng: createRng(seed) });
  world.input = 'autopilot';
  const h = createHumanController({ settings: world.settings });
  world.human = h;
  world.player.handed = world.settings.handed;
  world.player.height = world.settings.height;
  const feed = createAutopilotFeed({ handed: world.settings.handed, height: world.settings.height, hfovDeg: world.settings.hfovDeg, seed: seed + 101, delivery: apDelivery });
  if (close) {
    installCloseFeed(feed, {
      handed: world.settings.handed, height: world.settings.height, hfovDeg: world.settings.hfovDeg, seed: seed + 101,
      delivery: apDelivery, jitter: apJitter, noise: apNoise, profile, ...closeOpts,
    });
  } else {
    if (profile !== 'precise') feed.autopilot.setProfile(profile, { seed: seed * 7919 + 13 });
    if (apJitter > 0 || apNoise > 0) installRealisticFeed(feed, { delivery: apDelivery, jitter: apJitter, noise: apNoise, hfovDeg: world.settings.hfovDeg, seed: seed + 991 });
  }
  world.time = startTime - 1.0;
  while (world.time < startTime - 1e-9) {
    feed.beforeTick(world, h);
    stepWorld(world, STEP);
  }
  h.calibrate();
  const handed = world.settings.handed;
  let mode;
  if (spec.kind === 'drill') mode = createDrillMode(getDrill(spec.drillId, handed), { rng: createRng(seed + 7), session: null });
  else if (spec.kind === 'rally') mode = createRallyMode({ level: spec.level || 'club', rng: createRng(seed + 7), session: null });
  else mode = createMatchMode({ level: spec.level || 'club', games: spec.games || 4, rng: createRng(seed + 7), session: null });
  world.mode = mode;
  mode.start(world);
  const stats = { playerHits: 0 };
  world.bus.on('ball:hit', ({ shot }) => { if (shot.by === 'player' && !shot.provisional) stats.playerHits++; });
  return {
    world, mode, feed, human: h, stats,
    advanceTo(target) {
      while (world.time + STEP <= target + 1e-9) {
        feed.beforeTick(world, h);
        stepWorld(world, STEP);
      }
    },
    isFinished: () => mode.isFinished(world),
  };
}
