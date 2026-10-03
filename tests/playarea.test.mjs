// A living-room play area: the autopilot (which validates the whole pipeline) stays inside what a
// MacBook / TV camera can track, and the modes' tactical home still lets it cover the court.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createGame } from '../src/app/game.js';
import { loadSettings } from '../src/app/settings.js';
import { ROOM_ENVELOPE } from '../src/tracking/autopilot.js';
import { createTacticalHome, TACTICS } from '../src/game/tactics.js';
import { createWorld, launchBall, stepWorld } from '../src/game/world.js';
import { v3 } from '../src/util/vec3.js';

const D0 = 2.6; // autopilot's calibrated distance (room0)

function run(spec, seconds, seed = 3) {
  const g = createGame({ spec, settings: loadSettings(null), input: 'autopilot', startTime: 10, seed });
  const ap = g.feed.autopilot;
  const r = { minD: 9, maxD: -9, maxX: 0, minZ: 99, maxZ: -99, homeSpeed: 0 };
  let prevHome = null;
  const t0 = g.world.time;
  while (g.world.time < t0 + seconds && !g.isFinished()) {
    g.advanceTo(g.world.time + 0.05);
    const room = ap.state.room;
    r.minD = Math.min(r.minD, room.d);
    r.maxD = Math.max(r.maxD, room.d);
    r.maxX = Math.max(r.maxX, Math.abs(room.x));
    const p = g.world.player.pos;
    r.minZ = Math.min(r.minZ, p.z);
    r.maxZ = Math.max(r.maxZ, p.z);
    const h = g.world.player.home;
    const step = prevHome ? Math.hypot(h.x - prevHome.x, h.z - prevHome.z) : 0;
    // Between points the match places the teams (a deliberate teleport, > 1 m in one step).
    if (step < 1.0) r.homeSpeed = Math.max(r.homeSpeed, step / 0.05);
    prevHome = { x: h.x, z: h.z };
  }
  return { g, r };
}

const inEnvelope = (r) => r.minD >= D0 - ROOM_ENVELOPE.front - 0.03 && r.maxD <= D0 + ROOM_ENVELOPE.back + 0.03 && r.maxX <= ROOM_ENVELOPE.side + 0.03;

describe('play area', () => {
  for (const spec of [{ kind: 'rally', level: 'club' }, { kind: 'match', level: 'club' }]) {
    test(`${spec.kind}: stays in the room envelope yet covers net and baseline`, () => {
      const { g, r } = run(spec, 150);
      assert.ok(inEnvelope(r), `room d ${r.minD.toFixed(2)}..${r.maxD.toFixed(2)}, |x| ${r.maxX.toFixed(2)}`);
      assert.ok(r.minZ < 5.0, `reached the net game: min z ${r.minZ.toFixed(2)}`);
      assert.ok(r.maxZ > 9.0, `reached the back glass: max z ${r.maxZ.toFixed(2)}`);
      assert.ok(r.homeSpeed <= TACTICS.MAX_SPEED + 0.05, `tactical home glides at ${r.homeSpeed.toFixed(2)} m/s`);
      assert.ok(g.stats.playerHits >= 15, `${g.stats.playerHits} hits`);
      assert.ok(g.stats.rallies >= 2, `${g.stats.rallies} points ruled`);
    });
  }

  for (const id of ['live-mix', 'bandeja', 'back-glass', 'volleys']) {
    test(`${id}: inside the envelope, >= 80% hit and >= 80% of those legal`, () => {
      const { g, r } = run({ kind: 'drill', drillId: id }, 200);
      assert.ok(inEnvelope(r), `room d ${r.minD.toFixed(2)}..${r.maxD.toFixed(2)}, |x| ${r.maxX.toFixed(2)}`);
      const res = g.mode.state.results;
      const hit = res.filter((x) => x.shot);
      assert.ok(g.isFinished(), 'finished');
      assert.ok(hit.length >= res.length * 0.8, `hits ${hit.length}/${res.length}`);
      assert.ok(hit.filter((x) => x.legal).length >= hit.length * 0.8, `legal ${hit.filter((x) => x.legal).length}/${hit.length}`);
    });
  }

  test('tactical home: a short ball beyond reach moves the home by the excess only, smoothly', () => {
    const w = createWorld({ settings: { handed: 'right' } });
    const tac = createTacticalHome();
    tac.setBase(w, { x: 0.8, z: 7.8 });
    w.player.snapToHome = false;
    w.player.pos.set(0.8, 0, 7.8);
    // A soft ball dropping short near the service line on the player's forehand side.
    launchBall(w, { pos: v3(0.5, 1.0, -6), vel: v3(0.12, 4.2, 9.2), by: 'coach' });
    tac.update(w, 1 / 240);
    const ic = tac.state.intercept;
    assert.ok(ic, 'intercept predicted');
    assert.ok(7.8 - ic.z > TACTICS.REACH_DEPTH, `the stance ${ic.z.toFixed(2)} is beyond reach`);
    assert.ok(Math.abs(w.player.homeTarget.z - (ic.z + TACTICS.REACH_DEPTH)) < 0.02, 'home target = stance + reach');
    let maxStep = 0, prev = { ...w.player.home };
    for (let i = 0; i < 120; i++) {
      stepWorld(w, 1 / 240);
      tac.update(w, 1 / 240);
      const h = w.player.home;
      maxStep = Math.max(maxStep, Math.hypot(h.x - prev.x, h.z - prev.z) * 240);
      assert.ok(h.z <= prev.z + 1e-9, 'monotonic glide toward the net');
      prev = { ...h };
    }
    assert.ok(maxStep <= TACTICS.MAX_SPEED + 1e-6, `glide ${maxStep.toFixed(2)} m/s`);
    assert.ok(w.player.home.z < 7.8 - 1.0, `moved ${(7.8 - w.player.home.z).toFixed(2)} m in 0.5 s`);
  });
});
