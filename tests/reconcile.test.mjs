// Lag-compensated hits rewrite the ball's path after the fact; the renderer must not show the
// jump. Real pipeline (autopilot -> tracking -> rewound hits) at realistic Mac latency, rendered
// at 60 Hz exactly as the stage does (reconciler in front of ballView).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createGame } from '../src/app/game.js';
import { loadSettings } from '../src/app/settings.js';
import { createBallReconciler, RECONCILE_BLEND_S } from '../src/render/reconcile.js';
import { createRecorder } from '../src/app/replay.js';

const FRAME = 1 / 60;

describe('hit reconciliation', () => {
  test('fh-drive at 0.11 s latency + 0.15 s inference: no teleport on screen, the replay shows the corrected path', () => {
    const g = createGame({
      spec: { kind: 'drill', drillId: 'fh-drive' }, settings: loadSettings(null), input: 'autopilot',
      startTime: 10, seed: 5, apLatency: 0.11, apDelivery: 0.15,
    });
    const w = g.world;
    const rec = createRecorder({ seconds: 6 });
    w.bus.on('ball:hit', ({ shot }) => rec.onHit(shot));
    const recon = createBallReconciler();
    let prevRaw = null, prevShown = null, prevId = null, prevVel = null;
    let rawMax = 0, shownMax = 0, corrections = 0, lastSeq = null;
    const t0 = w.time;
    while (w.time < t0 + 40) {
      g.advanceTo(w.time + FRAME, (ww) => rec.record(ww));
      const b = w.ball;
      const shown = recon.update(b, w.ballCorrection, FRAME);
      if (w.ballCorrection && w.ballCorrection.seq !== lastSeq) { corrections++; lastSeq = w.ballCorrection.seq; }
      if (b && prevRaw && b.id === prevId) {
        // Displacement beyond what the ball's own speed explains in one frame.
        const free = Math.max(prevVel, Math.hypot(b.vel.x, b.vel.y, b.vel.z)) * FRAME + 0.02;
        const raw = Math.hypot(b.pos.x - prevRaw.x, b.pos.y - prevRaw.y, b.pos.z - prevRaw.z) - free;
        const sh = Math.hypot(shown.pos.x - prevShown.x, shown.pos.y - prevShown.y, shown.pos.z - prevShown.z) - free;
        rawMax = Math.max(rawMax, raw);
        shownMax = Math.max(shownMax, sh);
      }
      prevRaw = b ? { x: b.pos.x, y: b.pos.y, z: b.pos.z } : null;
      prevShown = shown ? { x: shown.pos.x, y: shown.pos.y, z: shown.pos.z } : null;
      prevVel = b ? Math.hypot(b.vel.x, b.vel.y, b.vel.z) : 0;
      prevId = b ? b.id : null;
    }
    console.log(`[reconcile] corrections ${corrections}  raw max jump ${rawMax.toFixed(2)} m  on-screen max extra step ${shownMax.toFixed(2)} m`);
    assert.ok(corrections >= 5, `${corrections} lag-compensated hits`);
    assert.ok(rawMax > 2.0, `the raw path does jump (${rawMax.toFixed(2)} m)`);
    // Smoothstep blend: at most ~1.5 * dt / BLEND of the jump per frame.
    const bound = rawMax * (1.5 * FRAME / RECONCILE_BLEND_S) + 0.15;
    assert.ok(shownMax < bound, `on screen the largest extra step is ${shownMax.toFixed(2)} m (bound ${bound.toFixed(2)}, raw ${rawMax.toFixed(2)})`);

    // Replay: frames after each contact were rewritten from the corrected history (no jump).
    const snap = rec.snapshot();
    let replayMax = 0;
    for (let i = 1; i < snap.frames.length; i++) {
      const a = snap.frames[i - 1].ball, b = snap.frames[i].ball;
      if (!a || !b || a.id !== b.id) continue;
      const dt = snap.frames[i].t - snap.frames[i - 1].t;
      const free = Math.max(Math.hypot(a.vel.x, a.vel.y, a.vel.z), Math.hypot(b.vel.x, b.vel.y, b.vel.z)) * dt + 0.05;
      replayMax = Math.max(replayMax, Math.hypot(b.pos.x - a.pos.x, b.pos.y - a.pos.y, b.pos.z - a.pos.z) - free);
    }
    console.log(`[reconcile] replay max extra step ${replayMax.toFixed(2)} m`);
    assert.ok(snap.hits.length >= 1);
    assert.ok(replayMax < 0.3, `replay jump ${replayMax.toFixed(2)} m`);
  });
});
