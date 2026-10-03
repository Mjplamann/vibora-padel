// End-to-end: world + drill mode + ball machine + autopilot -> synthetic camera frames at
// 30 fps -> human.onPoseFrame (body tracker, locomotion, racket track) -> lag-compensated
// swept hits -> ball physics -> referee -> drill scoring. Nothing is short-circuited: the
// autopilot only produces a SyntheticBody per frame.
//
// Timing model (as on the real Mac): a frame is captured at sim time T (frame.t = T ms) and
// reaches the pipeline DELIVERY s later (pose inference). The autopilot plays the ball it
// "sees on the TV", which lags the simulation by settings.latency, so it swings at ball
// contact time + latency; the game rewinds hits by the same latency.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createRng } from '../src/util/math.js';
import { createWorld, stepWorld, resolveSettings } from '../src/game/world.js';
import { createHumanController } from '../src/game/human.js';
import { createDrillMode, createMatchMode } from '../src/game/modes.js';
import { getDrill } from '../src/game/drills.js';
import { createSession } from '../src/game/session.js';
import { createAutopilot } from '../src/tracking/autopilot.js';
import { createSyntheticCamera } from '../src/tracking/synthetic.js';

const FPS = 30;
const DT = 1 / 240;
const DELIVERY = 0.045; // s from capture to pose result

function createHarness({ assist = 'club', seed = 7, handed = 'right' } = {}) {
  const settings = resolveSettings({ assist, handed });
  const world = createWorld({ settings, rng: createRng(seed) });
  const human = createHumanController({ settings: world.settings });
  world.human = human;
  const cam = createSyntheticCamera({ hfovDeg: settings.hfovDeg });
  const autopilot = createAutopilot({ rng: createRng(seed + 1), handed });
  let nextFrame = 0;
  const pending = [];
  let frames = 0;
  function tick() {
    if (world.time >= nextFrame - 1e-9) {
      const body = autopilot.update(world, world.time);
      pending.push({ at: world.time + DELIVERY, frame: cam.frame(world.time * 1000, [body]), t: world.time });
      nextFrame += 1 / FPS;
      frames++;
    }
    while (pending.length && pending[0].at <= world.time + 1e-9) {
      const f = pending.shift();
      human.onPoseFrame(world, f.frame, f.t);
    }
    stepWorld(world, DT);
  }
  // Stand still for a second, then calibrate the neutral spot (as the calibration screen does).
  while (world.time < 1.0) tick();
  assert.ok(human.calibrate(), 'calibrated');
  return { world, human, autopilot, tick, get frames() { return frames; } };
}

/** Runs a drill through the full pipeline; returns hit / landing statistics. */
function runDrill(id, { reps, assist = 'club', seed = 7, handed = 'right', session = null } = {}) {
  const h = createHarness({ assist, seed, handed });
  const { world } = h;
  const mode = createDrillMode(getDrill(id, handed), { rng: createRng(seed + 4), reps, session });
  world.mode = mode;
  mode.start(world);
  const results = [];
  const shots = [];
  world.bus.on('shot:result', (p) => results.push(p));
  world.bus.on('ball:hit', (p) => { if (p.shot.by === 'player') shots.push(p.shot); });
  const t0 = performance.now();
  while (!mode.isFinished() && world.time < 15 + reps * 6) h.tick();
  const ms = performance.now() - t0;
  const repsWithShot = mode.state.results.filter((r) => r.shot).length;
  const legal = mode.state.results.filter((r) => r.shot && r.legal).length;
  const strokes = {};
  for (const s of shots) strokes[s.stroke] = (strokes[s.stroke] || 0) + 1;
  const avg = (f) => (shots.length ? shots.reduce((a, s) => a + f(s), 0) / shots.length : 0);
  const stats = {
    drill: id,
    feeds: mode.state.results.length,
    hits: repsWithShot,
    hitRate: repsWithShot / Math.max(1, mode.state.results.length),
    inCourt: legal,
    inCourtRate: legal / Math.max(1, repsWithShot),
    success: mode.summary().successRate,
    points: mode.state.points,
    strokes,
    avgKmh: Math.round(avg((s) => s.speedOut * 3.6)),
    avgTopRpm: Math.round(avg((s) => s.spinRpm.top)),
    avgQuality: +avg((s) => s.quality).toFixed(2),
    timing: shots.reduce((m, s) => ((m[s.timing] = (m[s.timing] || 0) + 1), m), {}),
    simSeconds: +world.time.toFixed(1),
    wallMs: Math.round(ms),
    frames: h.frames,
  };
  return { stats, mode, world, shots };
}

describe('end to end: autopilot -> synthetic camera -> tracking -> lag-compensated hits -> physics', () => {
  test('forehand drive, 20 feeds at club assist: >= 70% hit, >= 50% of shots land in the far court', () => {
    const store = new Map();
    const session = createSession({ storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) } });
    const { stats, shots, mode } = runDrill('fh-drive', { reps: 20, session });
    console.log('[e2e] fh-drive', JSON.stringify(stats));
    const sum = session.summary();
    console.log('[e2e] fh-drive session', JSON.stringify({ shots: sum.shots, byStroke: sum.byStroke, avgReactionMs: sum.avgReactionMs, prepOnTimeRate: sum.prepOnTimeRate, kcal: +sum.kcal.toFixed(2) }));
    assert.equal(sum.shots, stats.hits, 'every player shot reached the session');
    assert.ok(sum.prepOnTimeRate !== null && sum.avgReactionMs !== null, 'reaction and preparation measured');
    assert.ok(sum.avgReactionMs > 0 && sum.avgReactionMs < 600, `reaction ${sum.avgReactionMs} ms`);
    assert.equal(session.bests('fh-drive'), stats.points, 'best saved at drill end');
    assert.equal(stats.feeds, 20);
    assert.ok(stats.hitRate >= 0.7, `hit rate ${stats.hitRate}`);
    assert.ok(stats.inCourtRate >= 0.5, `in-court rate ${stats.inCourtRate}`);
    // Real drive numbers: pace 60–95 km/h, topspin, forehands struck in front of the body.
    assert.ok(stats.avgKmh >= 55 && stats.avgKmh <= 95, `pace ${stats.avgKmh}`);
    assert.ok(stats.avgTopRpm > 0, 'topspin on average');
    assert.ok((stats.strokes.forehand || 0) >= stats.hits * 0.8, `forehands ${JSON.stringify(stats.strokes)}`);
    assert.ok(shots.every((s) => s.contactU && s.contactU.x > 0.2), 'struck on the forehand side');
    assert.ok(mode.isFinished());
  });

  test('net volleys: >= 50% hit and >= 50% in the far court', () => {
    const { stats } = runDrill('volleys', { reps: 12 });
    console.log('[e2e] volleys', JSON.stringify(stats));
    assert.ok(stats.hitRate >= 0.5, `hit rate ${stats.hitRate}`);
    assert.ok(stats.inCourtRate >= 0.5, `in-court rate ${stats.inCourtRate}`);
    const volleys = (stats.strokes['volley-fh'] || 0) + (stats.strokes['volley-bh'] || 0);
    assert.ok(volleys >= stats.hits * 0.8, `volleys ${JSON.stringify(stats.strokes)}`);
    assert.ok(stats.strokes['volley-bh'] >= 2, 'backhand volleys on the alternate feeds');
  });

  test('bandeja: >= 50% hit as an overhead and >= 50% in the far court, at control pace', () => {
    const { stats, shots } = runDrill('bandeja', { reps: 10 });
    console.log('[e2e] bandeja', JSON.stringify(stats));
    assert.ok(stats.hitRate >= 0.5, `hit rate ${stats.hitRate}`);
    assert.ok(stats.inCourtRate >= 0.5, `in-court rate ${stats.inCourtRate}`);
    const overheads = shots.filter((s) => ['bandeja', 'vibora', 'smash'].includes(s.stroke)).length;
    assert.ok(overheads >= shots.length * 0.8, `overheads ${JSON.stringify(stats.strokes)}`);
    assert.ok(stats.avgTopRpm < 0, 'bandejas are sliced');
    assert.ok(stats.avgKmh < 85, `pace ${stats.avgKmh}`);
  });

  test('left-handed player: mirrored drill, the forehand is on the left', () => {
    const { stats, shots } = runDrill('fh-drive', { reps: 8, handed: 'left', seed: 11 });
    console.log('[e2e] fh-drive lefty', JSON.stringify(stats));
    assert.ok(stats.hitRate >= 0.7, `hit rate ${stats.hitRate}`);
    assert.ok(stats.inCourtRate >= 0.5, `in-court rate ${stats.inCourtRate}`);
    assert.ok(shots.every((s) => s.contact.x < 1.5), 'played on the left side of the court');
  });

  test('match: the tracked human (with an AI partner) plays a full game against two AI opponents', () => {
    const h = createHarness({ seed: 21 });
    const { world } = h;
    const mode = createMatchMode({ level: 'club', games: 1, rng: createRng(5), firstServer: { team: 0, player: 0 } });
    world.mode = mode;
    mode.start(world);
    const outcomes = [];
    world.bus.on('rally:outcome', (p) => outcomes.push(p));
    const playerShots = [];
    world.bus.on('ball:hit', (p) => { if (p.shot.by === 'player') playerShots.push(p.shot); });
    let gameDone = false;
    while (!gameDone && world.time < 400) {
      h.tick();
      const g = mode.match.display().games;
      gameDone = g[0] + g[1] >= 1 || mode.isFinished();
    }
    const serves = playerShots.filter((s) => s.isServe);
    console.log('[e2e] match game', JSON.stringify({
      points: outcomes.filter((o) => o.score).length, reasons: outcomes.map((o) => o.reason), playerShots: playerShots.length,
      serves: serves.length, games: mode.match.display().games, simSeconds: +world.time.toFixed(1),
    }));
    assert.ok(gameDone, 'a game was completed');
    assert.ok(serves.length >= 2, 'the human served (drop and hit at waist height)');
    assert.ok(serves.every((s) => s.contact.y <= 0.53 * 1.75 + 0.05), 'serves struck at or below the waist');
    assert.ok(playerShots.length >= 4, `rallied: ${playerShots.length} shots`);
  });
});
