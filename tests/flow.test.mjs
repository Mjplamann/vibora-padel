// Session flow through the real pipeline (createGame + autopilot): feeds never replace a ball
// the player has struck before it is judged, every rep gets a ruling, rally mode feeds once.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createGame } from '../src/app/game.js';
import { loadSettings } from '../src/app/settings.js';
import { FEED_GAP } from '../src/game/modes.js';
import { HOLD_LEAD } from '../src/game/machine.js';
import { createWorld, judgeMargin, judgeDelay, JUDGE_MARGIN, JUDGE_MARGIN_MAX } from '../src/game/world.js';

function runDrill(drillId, { seed = 3, maxSeconds = 200, settings = {}, apLatency = 0, apDelivery = 0.045 } = {}) {
  const S = { ...loadSettings(null), ...settings };
  const g = createGame({ spec: { kind: 'drill', drillId }, settings: S, input: 'autopilot', startTime: 10, seed, apLatency, apDelivery });
  const w = g.world;
  const log = { launches: [], overLive: 0, results: [], hits: [] };
  let open = null; // the player's struck ball awaiting its ruling
  w.bus.on('ball:hit', ({ shot }) => { if (shot.by === 'player') { open = shot.id; log.hits.push(w.time); } });
  w.bus.on('shot:result', (r) => { log.results.push({ t: w.time, ...r }); if (r.shotId === open) open = null; });
  w.bus.on('ball:launch', ({ by }) => {
    if (by !== 'machine' && by !== 'drop') return;
    if (open !== null) log.overLive++;
    const lastRuling = log.results.length ? log.results[log.results.length - 1].t : -Infinity;
    log.launches.push({ t: w.time, sinceRuling: w.time - lastRuling });
  });
  const t0 = w.time;
  while (!g.isFinished() && w.time < t0 + maxSeconds) g.advanceTo(w.time + 0.05);
  return { g, log };
}

describe('drill feed flow', () => {
  for (const id of ['back-glass', 'double-wall', 'fh-drive', 'serve']) {
    test(`${id}: no feed over a live player shot; every rep ruled`, () => {
      const { g, log } = runDrill(id);
      const res = g.mode.state.results;
      assert.ok(g.isFinished(), 'drill finished');
      assert.equal(log.overLive, 0, 'a feed replaced a struck ball before its ruling');
      // Each launch after the first waits for the previous ruling plus the gap.
      for (const l of log.launches.slice(1)) {
        const gap = id === 'serve' ? 1.0 : FEED_GAP + HOLD_LEAD;
        assert.ok(l.sinceRuling >= gap - 0.02, `launch ${l.sinceRuling.toFixed(2)} s after the ruling`);
      }
      const hit = res.filter((r) => r.shot);
      const legal = hit.filter((r) => r.legal);
      assert.ok(hit.length >= res.length * 0.8, `hits ${hit.length}/${res.length}`);
      assert.ok(legal.length >= hit.length * 0.8, `legal ${legal.length}/${hit.length}`);
      // Every rep that the player struck reached a referee ruling (banner), not a timeout.
      assert.ok(g.stats.rallies >= hit.length, `rulings ${g.stats.rallies} for ${hit.length} struck reps`);
    });
  }

  test('rally mode: the first coach feed is not thrown away by the stall failsafe', () => {
    const S = loadSettings(null);
    const g = createGame({ spec: { kind: 'rally', level: 'club' }, settings: S, input: 'autopilot', startTime: 40, seed: 4 });
    const feeds = [];
    g.world.bus.on('ball:launch', ({ by }) => { if (by === 'coach') feeds.push(g.world.time); });
    const t0 = g.world.time;
    while (g.world.time < t0 + 6) g.advanceTo(g.world.time + 0.05);
    assert.equal(feeds.length, 1, `coach feeds in the first 6 s: ${feeds.map((t) => (t - t0).toFixed(2)).join(', ')}`);
  });

  test('judge margin adapts to the measured pose pipeline', () => {
    const w = createWorld({ settings: { latency: 0.11 } });
    w.tracking.delay = 0; w.tracking.frameDt = 1 / 60;
    assert.equal(judgeMargin(w), JUDGE_MARGIN);
    w.tracking.delay = 0.15; w.tracking.frameDt = 1 / 30;
    assert.equal(judgeMargin(w), JUDGE_MARGIN, '0.15 + 2 frames is inside the floor');
    w.tracking.delay = 0.22;
    assert.ok(Math.abs(judgeMargin(w) - (0.22 + 2 / 30)) < 1e-9);
    assert.ok(Math.abs(judgeDelay(w) - (0.11 + 0.22 + 2 / 30)) < 1e-9);
    w.tracking.delay = 5;
    assert.equal(judgeMargin(w), JUDGE_MARGIN_MAX, 'a stalled tracker cannot freeze the rulings');
  });

  for (const [lat, del] of [[0.11, 0.15], [0.11, 0.2]]) {
    test(`realistic Mac pipeline (latency ${lat} s, capture->result ${del} s at 30 fps): no contact rejected as late`, () => {
      const base = runDrill('fh-drive', { seed: 7 });
      const slow = runDrill('fh-drive', { seed: 7, apLatency: lat, apDelivery: del });
      const rate = (r) => r.g.mode.state.results.filter((x) => x.shot).length / r.g.mode.state.results.length;
      assert.equal(slow.g.world.hitRejects.late, 0, JSON.stringify(slow.g.world.hitRejects));
      assert.ok(rate(slow) >= rate(base) - 0.05, `hit rate ${rate(slow)} vs ${rate(base)} without latency`);
    });
  }
});
