// Rally hit rate (round 4 leftovers): in rallies off the glass the racket's drop into a low
// take-back (and the take-back to the side) read as a swing 0.3-0.7 s early, and the real stroke
// after it was dismissed as that swing's recovery. game/swingAssist.js isBackswing gates those
// motions out of the swing watch for the planned stroke, and a too-short candidate (a dip in a
// swing's acceleration) no longer disarms the watch for the rest of that swing. Velocities below are
// body-relative racket velocities logged from such misses (court axes: +x right, +y up, -z toward the net).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { v3 } from '../src/util/vec3.js';
import { isBackswing, createSwingWatch, TIMING } from '../src/game/swingAssist.js';
import { createRacketTrack, createRacketPose } from '../src/tracking/racketTrack.js';
import { RACKET } from '../src/config.js';

const gateOf = (v, family, dom = 1) => isBackswing(v, v.length(), { family, dom });

describe('backswing gate', () => {
  test('take-backs logged as early swings in rallies are backswings', () => {
    assert.ok(gateOf(v3(4.2, -3.1, 0.3), 'fh'), 'forehand: to the hitting side and down');
    assert.ok(gateOf(v3(3.6, -2.8, -0.2), 'fh'));
    assert.ok(gateOf(v3(0.4, -6.0, -0.5), 'fh'), 'forehand: the drop into a low take-back');
    assert.ok(gateOf(v3(-2.7, -3.8, 0.3), 'bh'), 'backhand: drop');
    assert.ok(gateOf(v3(-4.6, -4.0, -0.2), 'bh'), 'backhand: to the backhand side and down');
    assert.ok(gateOf(v3(5.6, 0.5, 0.1), 'vfh'), 'forehand volley: taken back to the side');
  });

  test('real strokes pass: drives, slices, backhands, volleys, overheads (both hands)', () => {
    for (const dom of [1, -1]) {
      assert.ok(!gateOf(v3(-3 * dom, 1.5, -9), 'fh', dom), 'topspin forehand');
      assert.ok(!gateOf(v3(-7.5 * dom, -0.4, -0.1), 'fh', dom), 'across the body (the forehand direction)');
      assert.ok(!gateOf(v3(-2 * dom, -3.5, -7), 'fh', dom), 'slice forehand');
      assert.ok(!gateOf(v3(4 * dom, 1, -8), 'bh', dom), 'backhand drive');
      assert.ok(!gateOf(v3(1 * dom, -2, -6), 'vbh', dom), 'backhand volley punch');
      assert.ok(!gateOf(v3(0.5 * dom, -4, -9), 'sm', dom), 'smash');
      assert.ok(!gateOf(v3(-1 * dom, -1.5, -7), 'oh', dom), 'bandeja');
      assert.ok(!gateOf(v3(0.2, 3.5, -6), 'fh', dom), 'low-to-high brush off the glass');
      assert.ok(!gateOf(v3(-0.6 * dom, 3.1, -1.8), 'oh', dom), 'an overhead rising into the contact');
      assert.ok(!gateOf(v3(0.3 * dom, -6, -3), 'sm', dom), 'a smash steeply down through the ball');
    }
    // The handedness flips the hitting side.
    assert.ok(gateOf(v3(-4.2, -1.0, 0.3), 'fh', -1), 'left-handed forehand take-back');
    assert.ok(!gateOf(v3(-4.2, -1.0, 0.3), 'fh', 1), 'the same motion is a right-hander\'s forehand direction');
  });

  test('the swing watch ignores a fast take-back and keeps the stroke after it', () => {
    // A forehand: 0.4 s still, a fast drop to the side (0.15 s), still, then the forward swing.
    const track = createRacketTrack();
    const posAt = (t, out = { x: 0, z: 0 }) => { out.x = 0; out.z = 0; return out; };
    const p = createRacketPose();
    const S = v3(0.25, 1.4, 0);
    const at = (t) => {
      // Sweet spot path (body-relative), m.
      if (t < 0.4) return v3(0.5, 1.1, -0.4);
      if (t < 0.55) { const u = (t - 0.4) / 0.15; return v3(0.5 + 0.5 * u, 1.1 - 0.6 * u, -0.4); }
      if (t < 0.9) return v3(1.0, 0.5, -0.4);
      if (t < 1.15) { const u = (t - 0.9) / 0.25; const a = Math.PI * u; return v3(1.0 - 1.4 * u, 0.5 + 0.5 * u, -0.4 - 0.9 * Math.sin(a * 0.5)); }
      return v3(-0.4, 1.0, -1.3);
    };
    for (let k = 0; k <= 50; k++) {
      const t = k / 30;
      const sw = at(t);
      p.axis.copy(sw.clone().sub(S)).normalize();
      p.normal.set(0, 0, -1).addScaled(p.axis, -p.axis.z).normalize();
      p.grip.copy(sw).addScaled(p.axis, -RACKET.sweetSpotY);
      track.push(t, p);
    }
    const run = (gate) => createSwingWatch({ racketTrack: track, posAt }).process(4, TIMING.minTravel, gate);
    const plain = run(null);
    const gated = run({ family: 'fh', dom: 1 });
    const fmt = (a) => a.map((e) => `${e.cPeak.toFixed(2)}@${e.peakSpeed.toFixed(1)}`).join(' ');
    assert.ok(plain.some((e) => e.cPeak < 0.6), `without the gate the take-back reads as a swing (${fmt(plain)})`);
    assert.ok(!gated.some((e) => e.cPeak < 0.6), 'with it, it does not');
    assert.ok(gated.some((e) => e.cPeak > 0.9 && e.cPeak < 1.2), `the stroke is still a swing (${fmt(gated)})`);
  });

  test('a dip early in a swing does not hide the rest of it (the watch stays armed after a too-short candidate)', () => {
    // Sweet-spot speed per 30 fps frame (m/s): a start, a brief dip, then the real swing at 9-11 m/s.
    const segs = [0, 0, 0, 0, 0, 0, 1, 2, 4, 7, 7, 2, 1.5, 7, 9, 10, 11, 8, 5, 2, 1, 0, 0, 0, 0, 0, 0];
    const track = createRacketTrack();
    const p = createRacketPose();
    const dir = v3(-0.3, 0.2, -1).normalize();
    const x = v3(0.6, 1.0, 0);
    segs.forEach((v, k) => {
      x.addScaled(dir, v / 30);
      p.axis.set(0.6, 0.3, -0.7).normalize();
      p.normal.set(0, 0, -1).addScaled(p.axis, -p.axis.z).normalize();
      p.grip.copy(x).addScaled(p.axis, -RACKET.sweetSpotY);
      track.push(k / 30, p);
    });
    const posAt = (t, out = { x: 0, z: 0 }) => { out.x = 0; out.z = 0; return out; };
    const ev = createSwingWatch({ racketTrack: track, posAt }).process(4, TIMING.minTravel, { family: 'fh', dom: 1 });
    assert.equal(ev.length, 1, `events ${JSON.stringify(ev.map((e) => [e.cPeak, e.peakSpeed]))}`);
    assert.ok(ev[0].peakSpeed > 8, `peak ${ev[0].peakSpeed.toFixed(1)} m/s`);
    assert.ok(ev[0].cPeak > 0.4 && ev[0].cPeak < 0.6);
  });
});
