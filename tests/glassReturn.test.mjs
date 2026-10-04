// Glass returns read as glass returns (round 4 leftovers): off the back glass a slow pace over
// 15-18 m solved into a high, steep arc that the trajectory reading called a lob, and the low-to-high
// brush of a glass return crossed the drill's lob path. game/swingAssist.js: DRIVE_FLIGHT / lobLike
// and the pace-aware lob path (TIMING.lobPathPace).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { v3 } from '../src/util/vec3.js';
import { createBall } from '../src/physics/ball.js';
import { loadSettings } from '../src/app/settings.js';
import { freeFlight } from '../src/game/world.js';
import { relabelByTrajectory } from '../src/tracking/swing.js';
import { timingAnalysis, createTimingState, lobLike, DRIVE_FLIGHT, TIMING } from '../src/game/swingAssist.js';
import { solveShot } from '../src/physics/predict.js';
import { spinFromComponents } from '../src/physics/racket.js';
import { createTestGame } from './helpers/closeGame.mjs';

/** timingAnalysis of a forehand off the back glass at (2.4, y, 7.8) in the back-glass drill. */
function glassReturn({ speed = 8, pathDeg = 30, y = 1.0, e = 0, hint = { shot: 'glass', aim: { x: 0, z: -7.4 } } } = {}) {
  const world = {
    settings: { ...loadSettings(null), handed: 'right' }, player: { pos: v3(1.7, 0, 8.4), height: 1.75, handed: 'right' },
    mode: { apHints: hint }, referee: null, timing: createTimingState(),
  };
  const ball = createBall(v3(2.4, y, 7.8), v3(-0.5, -2, -3), v3());
  const contact = { timing: { e, speed, pathDeg, az: null, dist: 0.2, offU: null, family: 'fh', kind: 'after-wall', tStar: 20, early: 0.2, late: 0.22, key: 'g' } };
  const a = timingAnalysis(world, ball, contact, 20, { playerPos: world.player.pos }, { afterBounce: true, afterWall: true }, false);
  // The label the world gives it (game/world.js strikeAnalysis reads the flight).
  const v = ball.vel;
  const ff = freeFlight(ball.pos, v, ball.spin, 3);
  const launchDeg = (Math.atan2(v.y, Math.hypot(v.x, v.z)) * 180) / Math.PI;
  const label = relabelByTrajectory(a.pathStroke, { apex: ff.apex, launchDeg, speed: v.length() }, a.groundStroke);
  return { a, ball, label, apex: ff.apex, launchDeg };
}

describe('glass returns fly and read as drives', () => {
  test('a slow solved arc over 15 m reads as a lob; the drive flight guard knows it', () => {
    const from = v3(2.4, 1.0, 7.8), target = v3(0, 0, -7.4);
    const spin = spinFromComponents(v3(target.x - from.x, 0, target.z - from.z), 2600, 0);
    const slow = solveShot({ from, target, spin, speed: 52 / 3.6 });
    assert.ok(slow.ok);
    assert.ok(lobLike(slow), `52 km/h topspin: apex ${slow.apex.toFixed(2)} m`);
    const drive = solveShot({ from, target, spin, speed: 60 / 3.6 });
    assert.ok(drive.ok && !lobLike(drive), `60 km/h topspin: apex ${drive.apex.toFixed(2)} m`);
    assert.ok(DRIVE_FLIGHT.apex < 4.35 && DRIVE_FLIGHT.launchDeg < 28);
  });

  test('every swing speed of a glass return plays a glass return, labelled as one', () => {
    for (const speed of [4, 5, 6, 8, 10, 13]) {
      for (const pathDeg of [10, 30, 50]) {
        const r = glassReturn({ speed, pathDeg });
        assert.equal(r.a.timing.type, 'glass', `${speed} m/s, ${pathDeg} deg: ${r.a.timing.type}`);
        assert.equal(r.label, 'glass-fh', `${speed} m/s, ${pathDeg} deg: labelled ${r.label} (apex ${r.apex.toFixed(2)} m, launch ${r.launchDeg.toFixed(1)} deg)`);
        assert.ok(r.ball.vel.z < -8, 'toward the far court');
        assert.ok(r.a.timing.kmh <= TIMING.pace.glass[1] * 1.0001);
      }
    }
  });

  test('a steep brush: fast is a topspin glass return, slow lifts a lob', () => {
    const fast = glassReturn({ speed: 12, pathDeg: 72 });
    assert.equal(fast.a.timing.type, 'glass');
    assert.equal(fast.label, 'glass-fh');
    assert.ok(fast.a.timing.top > 2000, `topspin ${fast.a.timing.top.toFixed(0)} rpm`);
    const slow = glassReturn({ speed: 5, pathDeg: 72 });
    assert.equal(slow.a.timing.type, 'lob');
    assert.equal(slow.label, 'lob');
    // Without a drill intent (rally / match) the steep path alone still makes a lob.
    const rally = glassReturn({ speed: 12, pathDeg: 72, hint: null });
    assert.equal(rally.a.timing.type, 'lob');
  });

  test('in the back-glass drill (human autopilot, Mac latency) most returns read as glass returns', () => {
    let n = 0, lobs = 0;
    for (const seed of [1, 2]) {
      const g = createTestGame({ spec: { kind: 'drill', drillId: 'back-glass' }, settings: loadSettings(null), seed });
      g.world.bus.on('ball:hit', ({ shot }) => {
        if (shot.by !== 'player' || shot.provisional) return;
        n++;
        if (shot.stroke === 'lob') lobs++;
      });
      while (g.world.time < 100 && !g.isFinished()) g.advanceTo(g.world.time + 0.5);
    }
    assert.ok(n >= 15, `hits ${n}`);
    // Round 3: ~40% read as lobs (the autopilot's steepest brushes still lift a few).
    assert.ok(lobs / n <= 0.3, `lob share ${(lobs / n).toFixed(2)} of ${n}`);
  });
});
