// Integration of the parallel QA2 work (hit feel, positioning, physics, app packaging): the
// shared rules agree across modules, settings keep their shapes, and the hand-offs between
// owners hold (assist magnet off the glass, flat autopilot smashes, mouse flicks, aids during a
// predicted hit).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createGame } from '../src/app/game.js';
import { loadSettings, createSettingsStore } from '../src/app/settings.js';
import { createAids } from '../src/app/aids.js';
import { createFallbackControls } from '../src/input/fallback.js';
import { interceptStance } from '../src/game/human.js';
import { STANCE_Z_MAX, GLASS_CLEAR } from '../src/game/intercept.js';
import { SHOT_INTENT, freeFlight } from '../src/game/world.js';
import { COURT } from '../src/config.js';

const FRAME = 1 / 60;

function memStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}

describe('settings shapes', () => {
  test('offAxisYaw defaults off, hitPrediction on, both stay boolean', () => {
    const s = loadSettings(null);
    assert.equal(s.offAxisYaw, false);
    assert.equal(s.hitPrediction, true);
    const odd = loadSettings(memStorage({ 'vibora.settings.v1': JSON.stringify({ offAxisYaw: 'yes', hitPrediction: 0 }) }));
    assert.equal(odd.offAxisYaw, false, 'only a real true enables the experimental correction');
    assert.equal(odd.hitPrediction, true, 'only a real false disables predictive hitting');
    const off = loadSettings(memStorage({ 'vibora.settings.v1': JSON.stringify({ offAxisYaw: true, hitPrediction: false }) }));
    assert.equal(off.offAxisYaw, true);
    assert.equal(off.hitPrediction, false);
    const store = createSettingsStore(null);
    assert.deepEqual(store.patch({ hitPrediction: false, offAxisYaw: true }).sort(), ['hitPrediction', 'offAxisYaw']);
  });
});

describe('assist magnet plans like the tactical home (game/intercept.js)', () => {
  for (const drillId of ['back-glass', 'double-wall', 'fh-drive']) {
    test(`${drillId}: the magnet stance is never deeper than ${STANCE_Z_MAX} m and its contact is off the glass`, () => {
      // The magnet assists physical hitting (round 3: Club's timing hits glide to the stance instead,
      // tests/hittability.test.mjs).
      const S = { ...loadSettings(null), hitMode: 'physical' };
      const g = createGame({ spec: { kind: 'drill', drillId }, settings: S, input: 'autopilot', startTime: 10, seed: 4, apLatency: 0.11, apDelivery: 0.15 });
      const w = g.world;
      let magnets = 0, maxZ = -Infinity, maxContactZ = -Infinity;
      while (!g.isFinished() && w.time < 10 + 70) {
        g.advanceTo(w.time + FRAME);
        if (w.player.magnet) {
          magnets++;
          maxZ = Math.max(maxZ, w.player.magnet.z);
        }
        if (w.ball && !w.ball.atRest && w.flight.team !== 0 && Math.round(w.time * 60) % 30 === 0) {
          const ic = interceptStance(w);
          if (ic) maxContactZ = Math.max(maxContactZ, ic.contact.z);
        }
      }
      assert.ok(magnets > 100, `magnet active (${magnets} frames)`);
      assert.ok(maxZ <= STANCE_Z_MAX + 1e-9, `magnet z ${maxZ.toFixed(2)}`);
      assert.ok(maxContactZ <= COURT.halfLength - GLASS_CLEAR.volley + 1e-9, `planned contact z ${maxContactZ.toFixed(2)}`);
      g.dispose();
    });
  }
});

describe('smash: flat autopilot smash and the intent window reach por tres', () => {
  test('SHOT_INTENT.smash lands 2-4.5 m past the net', () => {
    assert.deepEqual([...SHOT_INTENT.smash.depth], [2.0, 4.5]);
  });

  test('smash-x3 at 0.11/0.15 latency: sidespin < 800 rpm, all read as smashes, por tres happens', () => {
    const S = loadSettings(null);
    const g = createGame({ spec: { kind: 'drill', drillId: 'smash-x3' }, settings: S, input: 'autopilot', startTime: 10, seed: 11, apLatency: 0.11, apDelivery: 0.15 });
    const w = g.world;
    const shots = [];
    w.bus.on('ball:hit', ({ shot }) => { if (shot.by === 'player' && !shot.provisional) shots.push(shot); });
    while (!g.isFinished() && w.time < 10 + 120) g.advanceTo(w.time + 0.1);
    assert.ok(shots.length >= 10, `${shots.length} smashes`);
    const side = shots.map((s) => Math.abs(s.spinRpm.side)).sort((a, b) => a - b);
    assert.ok(side[side.length - 1] < 800, `max |side| ${side[side.length - 1]} rpm`);
    assert.ok(shots.filter((s) => s.stroke === 'smash').length >= shots.length - 1, shots.map((s) => s.stroke).join(','));
    assert.ok((g.stats.outcomes['por-tres'] || 0) >= 2, JSON.stringify(g.stats.outcomes));
    g.dispose();
  });
});

describe('assist intent follows the ball the racket produced', () => {
  // QA2 minor (lobs out on the far glass): a rising racket path labelled a flat 65-75 km/h drive a
  // 'lob', the intent became a 5.5 m-apex lob and the Club blend (direction toward it, pace kept)
  // sent drives that would have landed in onto the far glass on the full: 16 of 103 rally shots
  // and 9 of 68 match shots at these seeds before the fix.
  test('rally and match at 0.11/0.15: the assist almost never turns a ball landing in into one flying long', () => {
    let shots = 0, turnedLong = 0;
    for (const kind of ['rally', 'match']) {
      for (const seed of [1, 2]) {
        const g = createGame({ spec: { kind, level: 'club' }, settings: loadSettings(null), input: 'autopilot', startTime: 10, seed, apLatency: 0.11, apDelivery: 0.15 });
        const w = g.world;
        w.bus.on('ball:hit', ({ shot }) => {
          if (shot.provisional || shot.by !== 'player' || shot.isServe) return;
          const b = w.ball; // the outgoing ball at the contact (emitted before the re-simulation)
          const phys = freeFlight(b.pos, shot.physVel, b.spin);
          const physZ = phys.landed ? phys.z : null;
          const out = freeFlight(b.pos, b.vel, b.spin);
          const outZ = out.landed ? out.z : null;
          shots++;
          if (physZ !== null && physZ < -0.5 && physZ > -COURT.halfLength && (outZ === null || outZ < -COURT.halfLength - 0.2)) turnedLong++;
        });
        while (w.time < 10 + 150 && !g.isFinished()) g.advanceTo(w.time + 0.1);
        g.dispose();
      }
    }
    assert.ok(shots >= 60, `${shots} player shots`);
    assert.ok(turnedLong <= Math.ceil(shots * 0.02), `${turnedLong} of ${shots} in-court shots sent long by the assist`);
  });
});

describe('mouse fallback: only the pointer flicks', () => {
  function runFallback({ pointer }) {
    const s = loadSettings(null);
    const fb = createFallbackControls({ canvas: null, keyTarget: null, handed: 'right' });
    const g = createGame({ spec: { kind: 'drill', drillId: 'fh-drive' }, settings: s, input: 'fallback', fallback: fb, startTime: 10, seed: 5 });
    const w = g.world;
    let t = w.time;
    let k = 0;
    while (t < 40) {
      t += 0.05;
      // A sharp left-right flick of the pointer every frame while a feed comes (when asked).
      if (pointer && w.ball && w.flight.by === 'machine' && w.ball.vel.z > 0 && w.ball.pos.z > -2) fb.setPointer(k++ % 2 ? 0.6 : -0.2, -0.3);
      g.advanceTo(t);
    }
    const st = { hits: g.stats.playerHits, feeds: g.stats.feeds };
    g.dispose();
    return st;
  }

  test('with no input the assist walk is not read as a flick: no swing, no hit', () => {
    const st = runFallback({ pointer: false });
    assert.ok(st.feeds >= 5, `feeds ${st.feeds}`);
    assert.equal(st.hits, 0);
  });

  test('a fast pointer flick while the ball comes starts the timed swing', () => {
    const st = runFallback({ pointer: true });
    assert.ok(st.hits >= st.feeds * 0.6, `hits ${st.hits} of ${st.feeds}`);
  });
});

describe('training aids during a predicted hit', () => {
  test('landing marker and contact ghost clear while world.spec is pending', () => {
    const S = { ...loadSettings(null), contactGhost: true };
    const g = createGame({ spec: { kind: 'drill', drillId: 'fh-drive' }, settings: S, input: 'autopilot', startTime: 10, seed: 3, apLatency: 0.11, apDelivery: 0.15 });
    const w = g.world;
    const aids = createAids();
    let seenSpec = 0, seenLanding = 0;
    while (!g.isFinished() && w.time < 10 + 40) {
      g.advanceTo(w.time + FRAME);
      const a = aids.update(w, { wantLanding: true, wantGhost: true });
      if (w.spec) {
        seenSpec++;
        assert.equal(a.landing, null);
        assert.equal(a.ghost, null);
      } else if (a.landing) seenLanding++;
    }
    assert.ok(seenSpec > 10, `predicted-hit frames ${seenSpec}`);
    assert.ok(seenLanding > 10, `landing marker shown otherwise (${seenLanding})`);
    g.dispose();
  });
});
