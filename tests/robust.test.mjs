// Side-on robustness and the black-screen safety net (first real-world session: "a black screen
// with image on the side if you turn left or right far enough"). The frames follow what MediaPipe
// does when a player at 2.1-3.0 m turns side-on to a MacBook camera (tests/sideon-frames.mjs):
// overlapping shoulders / hips, the hidden arm collapsing, left / right label swaps, frames with
// nobody, wild and non-finite landmarks. Each test failed before the fix (numbers in comments).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  createBodyTracker, computeHandFrame, groupSwapped, frontalSwapped, torsoYawDeg, estimateDistance, landmarkTrust,
} from '../src/tracking/body.js';
import { standingBody, createSyntheticCamera, setHandTarget } from '../src/tracking/synthetic.js';
import { createGame } from '../src/app/game.js';
import { loadSettings } from '../src/app/settings.js';
import { viewBall } from '../src/game/world.js';
import { createGaze } from '../src/render/gaze.js';
import { matrixOk, segmentOk, frameOk, ballOk, isFiniteQuat, createSafetyNet, det3 } from '../src/render/safeView.js';
import { sideOnAlpha } from '../src/render/armFade.js';
import { v3 } from '../src/util/vec3.js';
import { turnYaw, turnedBody, createSideOnCorruptor, swapLabels } from './sideon-frames.mjs';

const HFOV = 68;
const DEG = Math.PI / 180;
const fin = (v) => !!v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
const ang = (a, b) => Math.acos(Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z))) / DEG;

/**
 * A calibrated user at distance d0 holding the racket ready, turning to ±peak and back twice at
 * 30 fps; returns per-frame samples (null = no sample) and the tracker.
 */
function turnRun({ kinds, d0 = 2.6, peak = 95, seed = 1 }) {
  const cam = createSyntheticCamera({ hfovDeg: HFOV });
  const tr = createBodyTracker({ hfovDeg: HFOV });
  const base = standingBody({ room: { x: 0.3, d: d0 } });
  setHandTarget(base, 'R', { x: 0.15, y: 1.05, z: 0.35 }, { x: -0.3, y: 0.75, z: 0.55 }, { x: -0.9, y: 0.1, z: 0.35 });
  for (let i = 0; i < 30; i++) tr.update(cam.frame(i * 33.3, [base]));
  tr.calibrate();
  const corrupt = createSideOnCorruptor({ seed, kinds });
  const out = [];
  for (let i = 0; i < 300; i++) {
    const t = 1 + i / 30;
    const yaw = turnYaw(t - 1, { peak: (i < 150 ? 1 : -1) * peak, start: i < 150 ? 0.3 : 5.3 });
    out.push({ yaw, s: tr.update(corrupt(cam.frame(t * 1000 + 1000, [turnedBody(base, yaw)]), yaw)) });
  }
  return { out, tr };
}

const sampleFinite = (s) => fin(s.room ? { x: s.room.x, y: 0, z: s.room.d } : null) && Number.isFinite(s.eyeHeight)
  && Object.values(s.joints).every(fin) && ['L', 'R'].every((k) => fin(s.handFrames[k].grip) && fin(s.handFrames[k].axis) && fin(s.handFrames[k].normal));

describe('body tracker: side-on robustness', () => {
  test('NaN / Infinity landmarks never poison the filters (before: NaN joints for the rest of the session)', () => {
    for (const seed of [1, 2, 3]) {
      const { out, tr } = turnRun({ kinds: ['nan', 'inf', 'occlude'], seed });
      let n = 0;
      for (const { s } of out) {
        if (!s) continue;
        n++;
        assert.ok(sampleFinite(s), `seed ${seed}: non-finite sample`);
        assert.ok(s.valid, `seed ${seed}: invalid sample`);
      }
      assert.ok(n > 280, `${n} samples`);
      assert.ok(tr.stats.rejectedLandmarks > 0, 'the bad landmarks were seen');
    }
  });

  test('wild single-frame landmarks: room position and eye height hold (before: 1.0-1.6 m lateral, 0.36 m eye jumps)', () => {
    for (const seed of [1, 2, 3]) {
      const { out, tr } = turnRun({ kinds: ['outlier'], seed, d0: 3.0 });
      let maxDx = 0, maxDd = 0, maxEye = 0;
      for (const { s } of out) {
        if (!s || !s.valid) continue;
        maxDx = Math.max(maxDx, Math.abs(s.offset.x));
        maxDd = Math.max(maxDd, Math.abs(s.offset.d));
        maxEye = Math.max(maxEye, Math.abs(s.eyeHeight - tr.calibration.eyeHeight));
      }
      assert.ok(maxDx < 0.05 && maxDd < 0.08 && maxEye < 0.05, `seed ${seed}: dx ${maxDx.toFixed(3)} dd ${maxDd.toFixed(3)} eye ${maxEye.toFixed(3)}`);
    }
  });

  test('left / right label swaps when side-on are undone (before: the racket face jumped ~25° per frame)', () => {
    for (const seed of [1, 2, 3]) {
      const { out, tr } = turnRun({ kinds: ['swap'], seed });
      let prev = null, maxJump = 0;
      for (const { s } of out) {
        if (!s) continue;
        if (prev) maxJump = Math.max(maxJump, ang(prev, s.handFrames.R.axis));
        prev = { ...s.handFrames.R.axis };
      }
      assert.ok(tr.stats.swaps > 0, 'swaps detected');
      assert.ok(maxJump < 8, `seed ${seed}: racket axis jumped ${maxJump.toFixed(1)}° in one frame`);
    }
  });

  test('the hidden arm (side-on, collapsing and wandering) moves the racket face far less (before: up to 63°/frame)', () => {
    for (const seed of [1, 2, 3]) {
      const { out } = turnRun({ kinds: ['occlude', 'swap', 'collapse', 'empty', 'outlier'], seed });
      let prev = null, maxJump = 0;
      for (const { s } of out) {
        if (!s) continue;
        if (prev) maxJump = Math.max(maxJump, ang(prev, s.handFrames.R.axis));
        prev = { ...s.handFrames.R.axis };
      }
      assert.ok(maxJump < 45, `seed ${seed}: ${maxJump.toFixed(1)}°`);
    }
  });

  test('side-on at 2.1 and 3.0 m: distance from torso sides and thighs, lateral position steady', () => {
    for (const d0 of [2.1, 3.0]) {
      const { out } = turnRun({ kinds: ['occlude', 'swap'], d0, peak: 110 });
      let maxDx = 0, maxDd = 0, sideOn = 0;
      for (const { s } of out) {
        if (!s || !s.valid) continue;
        if (s.sideOn) sideOn++;
        maxDx = Math.max(maxDx, Math.abs(s.offset.x));
        maxDd = Math.max(maxDd, Math.abs(s.offset.d));
      }
      assert.ok(sideOn > 60, `side-on frames ${sideOn}`);
      assert.ok(maxDx < 0.03 && maxDd < 0.05, `d0 ${d0}: dx ${maxDx.toFixed(3)} dd ${maxDd.toFixed(3)}`);
    }
  });

  test('helpers: torso yaw, swap tests, side-on distance, occlusion trust', () => {
    const cam = createSyntheticCamera({ hfovDeg: HFOV });
    for (const yaw of [0, 40, -70, 100]) {
      const p = cam.frame(0, [turnedBody(standingBody({}), yaw)]).people[0];
      assert.ok(Math.abs(torsoYawDeg(p.world) - yaw) < 1, `yaw ${yaw}: ${torsoYawDeg(p.world)}`);
    }
    const p0 = cam.frame(0, [standingBody({})]).people[0];
    assert.equal(frontalSwapped(p0.world), false);
    const sw = swapLabels({ landmarks: p0.landmarks.map((q) => ({ ...q })), world: p0.world.map((q) => ({ ...q })) });
    assert.equal(frontalSwapped(sw.world), true);
    assert.equal(groupSwapped(sw.world, p0.world, [[11, 12], [13, 14], [15, 16]]), true);
    assert.equal(groupSwapped(p0.world, p0.world, [[11, 12], [13, 14], [15, 16]]), false);
    const ps = cam.frame(0, [turnedBody(standingBody({ room: { x: 0, d: 2.4 } }), 90)]).people[0];
    const d = estimateDistance(ps.landmarks, ps.world, HFOV, 16 / 9, 1, { sideOn: true });
    assert.ok(Math.abs(d - 2.4) < 0.15, `side-on distance ${d}`);
    assert.equal(landmarkTrust({ x: 0.5, y: 0.5, visibility: 0.99 }), 1);
    assert.ok(landmarkTrust({ x: 0.5, y: 0.5, visibility: 0.05 }) < 0.3);
    assert.equal(landmarkTrust({ x: 0.5, y: -0.1, visibility: 0.05 }), 1); // out of the picture: extrapolated, trusted
  });

  test('degenerate palm keeps the previous palm direction and follows the forearm', () => {
    const w = v3(0.3, 1.1, 0.3), e = v3(0.3, 0.84, 0.3);
    const prevNormal = v3(0, 0, 1);
    const hf = computeHandFrame('R', w, w.clone(), w.clone(), w.clone(), e, undefined, { prevNormal, handLength: 0.09 });
    assert.equal(hf.degenerate, true);
    assert.ok(fin(hf.axis) && fin(hf.normal) && fin(hf.grip));
    assert.ok(hf.normal.z > 0.9, `normal ${hf.normal.toArray()}`);
    assert.ok(Math.abs(hf.axis.dot(hf.normal)) < 1e-9);
    // A healthy hand is untouched by the option.
    const ok = computeHandFrame('R', w, v3(0.28, 1.19, 0.3), v3(0.33, 1.18, 0.3), v3(0.26, 1.14, 0.31), e, undefined, { prevNormal: v3(1, 0, 0), handLength: 0.09 });
    assert.equal(ok.degenerate, false);
    assert.ok(ok.normal.z > 0.99);
  });
});

describe('game pipeline: a player turning side-on (Mac latency)', () => {
  test('eye, body, racket, shown ball and gaze stay finite through 40 s of turns with every corruption (before: NaN eye = black view)', () => {
    const kinds = ['occlude', 'swap', 'collapse', 'empty', 'outlier', 'zeroseg', 'nan', 'inf'];
    for (const seed of [1, 2]) {
      const S = loadSettings(null);
      const g = createGame({ spec: { kind: 'drill', drillId: 'fh-drive' }, settings: S, input: 'autopilot', startTime: 10, seed, apLatency: 0.11, apDelivery: 0.15 });
      const ap = g.feed.autopilot;
      const upd = ap.update;
      const T0 = g.world.time;
      let yaw = 0;
      ap.update = (w, t) => {
        const b = upd(w, t);
        yaw = turnYaw((t - T0) % 5, { peak: (Math.floor((t - T0) / 5) % 2 ? -1 : 1) * 95 });
        return turnedBody(b, yaw);
      };
      const corrupt = createSideOnCorruptor({ seed, kinds });
      const h = g.human;
      const opf = h.onPoseFrame;
      h.onPoseFrame = (w, f, t) => opf(w, corrupt(f, yaw), t);
      const gaze = createGaze();
      let frames = 0;
      while (g.world.time < T0 + 40) {
        g.advanceTo(g.world.time + 1 / 60);
        const w = g.world, pl = w.player;
        frames++;
        assert.ok(fin(pl.eye) && fin(pl.pos), `seed ${seed} t ${(w.time - T0).toFixed(2)}: eye ${JSON.stringify(pl.eye)}`);
        if (pl.bodyCourt) assert.ok(Object.values(pl.bodyCourt.joints).every(fin), 'court joints');
        if (pl.racket) assert.ok(frameOk(pl.racket), 'racket frame');
        if (pl.renderRacket) assert.ok(frameOk(pl.renderRacket), 'shown racket frame');
        const b = viewBall(w);
        if (b) assert.ok(ballOk(b), 'shown ball');
        const r = gaze.update(b, pl.eye, 1 / 60, { basePitch: -14 * DEG, glassView: 'mirror' });
        assert.ok(Number.isFinite(r.yaw) && Number.isFinite(r.pitch));
      }
      assert.ok(frames > 2000);
      assert.ok(g.stats.playerHits >= 3, `still plays: ${g.stats.playerHits} hits`);
      g.dispose();
    }
  });
});

describe('render safety net (pure rules)', () => {
  test('a singular or non-finite world matrix is not drawable', () => {
    const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    assert.equal(matrixOk(I), true);
    const flat = I.slice();
    flat[5] = 0; // scale.y = 0: a zero-length arm segment
    assert.equal(det3(flat), 0);
    assert.equal(matrixOk(flat), false);
    const tiny = I.slice();
    tiny[5] = 1e-30;
    assert.equal(matrixOk(tiny), false);
    const nan = I.slice();
    nan[12] = NaN;
    assert.equal(matrixOk(nan), false);
  });

  test('arm segments of implausible length, broken racket frames, NaN balls and quaternions are rejected', () => {
    const a = { x: 0, y: 1, z: 8 };
    assert.equal(segmentOk(a, { x: 0, y: 0.74, z: 8 }, 0.265), true);
    assert.equal(segmentOk(a, a, 0.265), false);
    assert.equal(segmentOk(a, { x: 0, y: 0.99, z: 8 }, 0.265), false);
    assert.equal(segmentOk(a, { x: NaN, y: 0.74, z: 8 }, 0.265), false);
    const f = { grip: v3(0, 1, 8), axis: v3(0, 1, 0), normal: v3(0, 0, 1) };
    assert.equal(frameOk(f), true);
    assert.equal(frameOk({ ...f, axis: v3(0, 0, 0) }), false);
    assert.equal(frameOk({ ...f, normal: v3(0, 1, 0) }), false);
    assert.equal(frameOk({ ...f, grip: v3(Infinity, 1, 8) }), false);
    assert.equal(ballOk({ pos: v3(0, 1, 2), vel: v3(0, 0, 1) }), true);
    assert.equal(ballOk({ pos: v3(0, NaN, 2), vel: v3(0, 0, 1) }), false);
    assert.equal(isFiniteQuat({ x: 0, y: 0, z: 0, w: 1 }), true);
    assert.equal(isFiniteQuat({ x: 0, y: 0, z: 0, w: 0 }), false);
    assert.equal(isFiniteQuat({ x: NaN, y: 0, z: 0, w: 1 }), false);
  });

  test('camera / eye store restores the last good pose and counts it', () => {
    const net = createSafetyNet();
    assert.equal(net.camera({ x: 1, y: 1.6, z: 8 }, { x: 0, y: 0, z: 0, w: 1 }), true);
    assert.equal(net.camera({ x: NaN, y: 1.6, z: 8 }, { x: 0, y: 0, z: 0, w: 1 }), false);
    assert.deepEqual(net.last.pos, { x: 1, y: 1.6, z: 8 });
    const e = net.eye({ x: 2, y: 1.6, z: 8 });
    assert.deepEqual(e, { x: 2, y: 1.6, z: 8 });
    assert.deepEqual(net.eye({ x: 2, y: Infinity, z: 8 }), { x: 2, y: 1.6, z: 8 });
    assert.equal(net.stats.cameraRestored, 1);
    assert.equal(net.stats.eyeRestored, 1);
  });

  test('side-on arm fade: a forearm folded across the chest a hand below the eyes disappears', () => {
    const eye = { x: 0, y: 1.64, z: 8 };
    assert.ok(sideOnAlpha({ x: -0.2, y: 1.4, z: 7.8 }, { x: 0.15, y: 1.42, z: 7.75 }, eye) < 0.05);
    assert.equal(sideOnAlpha({ x: 0.3, y: 1.1, z: 7.5 }, { x: 0.45, y: 1.1, z: 7.4 }, eye), 1);
  });
});
