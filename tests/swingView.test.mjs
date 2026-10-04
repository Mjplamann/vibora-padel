// Smooth swings (round 4): the render-rate racket view (game/swingView.js) between 30 fps camera
// poses, the rest spring, swing-aware follow-through over stale (motion-blurred) poses, the
// 'player:swing' events, and the presentation-only pieces (render/racketTrail.js strength,
// render/armFade.js along-forearm fade). Hits never read the view (racketTrack / judge untouched).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { Vec3 } from '../src/util/vec3.js';
import { RACKET } from '../src/config.js';
import { createRng } from '../src/util/math.js';
import { createRacketTrack, createRacketPose } from '../src/tracking/racketTrack.js';
import { createSwingView, VIEW } from '../src/game/swingView.js';
import { trailStrength, TRAIL } from '../src/render/racketTrailMath.js';
import { alongCutStart, alongCutAlpha, alongCutHide, ALONG_CUT, nearCutAlpha, nearCutDepths, stubShown, STUB_SHOW, ARM_RADIUS } from '../src/render/armFade.js';
import { loadSettings } from '../src/app/settings.js';
import { createTestGame } from './helpers/closeGame.mjs';

const SWEET = RACKET.sweetSpotY;
const CAPTURE = 1 / 30;
const DELIVERY = 0.15;
const LAT = 0.11;
const S = new Vec3(0.2, 1.4, 0); // hitting shoulder (court frame, the body stands at the origin)
const R = 0.75; // shoulder -> sweet spot

/** Racket pose with the sweet spot at angle th (rad) on a horizontal circle about S. */
function poseAt(th, out = createRacketPose()) {
  const dx = Math.cos(th), dz = -Math.sin(th);
  out.axis.set(dx, 0, dz);
  out.normal.set(-Math.sin(th), 0, -Math.cos(th));
  out.sweet.set(S.x + R * dx, S.y, S.z + R * dz);
  out.grip.copy(out.sweet).addScaled(out.axis, -SWEET);
  return out;
}

/**
 * Drives a swing view from a camera that captures angle th(t) at 30 fps (delivered DELIVERY s
 * late, `perturb` may spoil a pose) and samples the drawn racket at `fps`.
 */
function drive({ th, until, fps = 60, perturb = null, from = 0 }) {
  const track = createRacketTrack();
  const posAt = (t, out = { x: 0, z: 0 }) => { out.x = 0; out.z = 0; return out; };
  const view = createSwingView({ racketTrack: track, posAt });
  const world = { time: from, settings: { latency: LAT, handed: 'right' }, player: { pos: new Vec3(), vel: new Vec3(), handed: 'right' } };
  const frames = [];
  const events = [];
  const pending = [];
  let next = from;
  const p = createRacketPose();
  const step = 1 / 240;
  const every = Math.round(240 / fps);
  for (let k = 0; world.time < until; k++) {
    world.time = from + k * step;
    if (world.time >= next - 1e-9) {
      pending.push({ t: next, at: next + DELIVERY });
      next += CAPTURE;
    }
    while (pending.length && pending[0].at <= world.time + 1e-9) {
      const c = pending.shift();
      poseAt(th(c.t), p);
      if (perturb) perturb(p, c.t);
      track.push(c.t, p);
    }
    const shown = view.racket(world, null);
    const evs = view.drainEvents();
    if (evs) events.push(...evs);
    if (shown && k % every === 0) {
      frames.push({ T: world.time, sweet: shown.sweet.clone(), axis: shown.axis.clone(), normal: shown.normal.clone(), latest: track.latest().sweet.clone(), latestAxis: track.latest().axis.clone() });
    }
  }
  return { frames, events, view, track };
}

const deg = (a, b) => (Math.acos(Math.max(-1, Math.min(1, a.dot(b)))) * 180) / Math.PI;
const q = (a, p) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))];
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

describe('render-rate interpolation (30 fps poses, 60 fps display)', () => {
  test('a steady swing is drawn at render rate: no 30 Hz stepping, bounded second difference', () => {
    const w = 8; // rad/s, sweet spot at 6 m/s
    const { frames } = drive({ th: (t) => w * t, until: 3 });
    const d2 = [], d2Raw = [];
    for (let i = 2; i < frames.length; i++) {
      if (frames[i].T < 1) continue;
      const a = frames[i - 2], b = frames[i - 1], c = frames[i];
      d2.push(c.sweet.clone().sub(b.sweet).sub(b.sweet.clone().sub(a.sweet)).length() * 100);
      d2Raw.push(c.latest.clone().sub(b.latest).sub(b.latest.clone().sub(a.latest)).length() * 100);
    }
    // The newest camera pose alone steps 20 cm every other display frame.
    assert.ok(q(d2Raw, 0.95) > 15, `raw p95 ${q(d2Raw, 0.95)}`);
    assert.ok(Math.max(...d2) < 2.5, `drawn max second difference ${Math.max(...d2).toFixed(2)} cm`);
    // Every display frame moves (no frame repeats the previous one).
    for (let i = 1; i < frames.length; i++) {
      if (frames[i].T < 1) continue;
      assert.ok(frames[i].sweet.distanceTo(frames[i - 1].sweet) > 0.04, `frame ${i} stalls`);
    }
  });

  test('a late camera frame is bridged by bounded extrapolation, not a freeze then a jump', () => {
    // Frames between 1.50 and 1.62 s capture time arrive 0.1 s later than the rest.
    const w = 8;
    const track = createRacketTrack();
    const posAt = (t, out = { x: 0, z: 0 }) => { out.x = 0; out.z = 0; return out; };
    const view = createSwingView({ racketTrack: track, posAt });
    const world = { time: 0, settings: { latency: LAT, handed: 'right' }, player: { pos: new Vec3(), vel: new Vec3(), handed: 'right' } };
    const pending = [];
    let next = 0;
    let prev = null, prevD = null;
    let worst = 0;
    const p = createRacketPose();
    for (let k = 0; world.time < 3; k++) {
      world.time = k / 240;
      if (world.time >= next - 1e-9) {
        const late = next > 1.5 && next < 1.62 ? 0.1 : 0;
        pending.push({ t: next, at: next + DELIVERY + late });
        pending.sort((a, b) => a.at - b.at);
        next += CAPTURE;
      }
      while (pending.length && pending[0].at <= world.time + 1e-9) {
        const c = pending.shift();
        track.push(c.t, poseAt(w * c.t, p));
      }
      const shown = view.racket(world, null);
      if (k % 4 || !shown) continue;
      const cur = shown.sweet.clone();
      if (prev) {
        const d = cur.clone().sub(prev);
        if (prevD && world.time > 1) worst = Math.max(worst, d.clone().sub(prevD).length());
        prevD = d;
      }
      prev = cur;
    }
    assert.ok(worst * 100 < 12, `largest second difference across the late frames ${(worst * 100).toFixed(1)} cm`);
  });
});

describe('rest spring', () => {
  test('a still racket under webcam noise: jitter per display frame drops several-fold', () => {
    const rng = createRng(5);
    const noise = (p) => {
      p.grip.x += rng.normal(0, 0.008); p.grip.y += rng.normal(0, 0.008); p.grip.z += rng.normal(0, 0.012);
      const a = rng.normal(0, 0.05), b = rng.normal(0, 0.05);
      p.axis.x += a; p.axis.z += b; p.axis.normalize();
      p.normal.addScaled(p.axis, -p.normal.dot(p.axis)).normalize();
    };
    const { frames } = drive({ th: () => 0.3, until: 8, perturb: noise });
    const shown = [], raw = [];
    for (let i = 1; i < frames.length; i++) {
      if (frames[i].T < 2) continue;
      shown.push(Math.max(deg(frames[i].axis, frames[i - 1].axis), deg(frames[i].normal, frames[i - 1].normal)));
      raw.push(deg(frames[i].latestAxis, frames[i - 1].latestAxis));
    }
    const m = mean(shown), mRaw = mean(raw);
    assert.ok(m < 1.0, `drawn racket turns ${m.toFixed(2)} deg / frame at rest`);
    // The newest camera pose (what was drawn before round 4) turns by several degrees every other frame.
    assert.ok(mRaw > 4 * m, `raw ${mRaw.toFixed(2)} vs drawn ${m.toFixed(2)} deg / frame`);
  });
});

describe('player:swing events', () => {
  // Rest, then one swing: angular speed W sin^2 over D s, then rest.
  const W = 14, D = 0.5, T0 = 1.5;
  const th = (t) => {
    if (t < T0) return 0;
    const u = Math.min(1, (t - T0) / D);
    return W * D * (u / 2 - Math.sin(2 * Math.PI * u) / (4 * Math.PI));
  };
  test('one swing -> start, peak, end in order, peak speed of the drawn sweet spot, finite positions', () => {
    const { events } = drive({ th, until: 4 });
    const phases = events.map((e) => e.phase);
    assert.deepEqual(phases, ['start', 'peak', 'end'], `events ${phases.join(',')}`);
    const [s, pk, e] = events;
    assert.ok(s.t < pk.t && pk.t <= e.t);
    // Truth peak: W x R = 10.5 m/s at T0 + D/2 (capture time); drawn within the lead's reach.
    assert.ok(pk.speed > 6 && pk.speed < 16, `peak speed ${pk.speed}`);
    assert.ok(pk.t > T0 && pk.t < T0 + D + DELIVERY + 0.2, `peak at ${pk.t.toFixed(3)}`);
    for (const ev of events) {
      assert.ok(Number.isFinite(ev.pos.x) && Number.isFinite(ev.pos.y) && Number.isFinite(ev.pos.z));
      assert.ok(Number.isFinite(ev.speed));
    }
  });

  test('a still racket emits nothing', () => {
    const { events } = drive({ th: () => 0.2, until: 3 });
    assert.equal(events.length, 0);
  });
});

describe('follow-through over motion-blurred poses', () => {
  test('stale wrist poses after the peak: the drawn racket coasts on instead of stopping or flicking back', () => {
    const W = 16, D = 0.5, T0 = 1.5;
    const th = (t) => {
      if (t < T0) return 0;
      const u = Math.min(1, (t - T0) / D);
      return W * D * (u / 2 - Math.sin(2 * Math.PI * u) / (4 * Math.PI));
    };
    // Past the peak, two frames come back stuck where the hand was a frame earlier (a smear).
    const blurFrom = T0 + D / 2, blurTo = blurFrom + 0.07;
    const stale = (p, t) => {
      if (t > blurFrom && t < blurTo) poseAt(th(blurFrom), p);
    };
    const run = drive({ th, until: 3.2, perturb: stale });
    assert.ok(run.view.stats.staleCoasts >= 1, `stale coasts ${run.view.stats.staleCoasts}`);
    // Between the start of the swing on screen and its end the drawn sweet spot keeps moving forward
    // and, past the peak, slows smoothly: no frame steps back, none stalls, no sudden dip (a step
    // under 60% of the previous one) or burst (over 150% + 2 cm) while it moves over 5 cm a frame.
    const fr = run.frames.filter((f) => f.T > T0 + 0.1 && f.T < T0 + D + DELIVERY + 0.1);
    let back = 0, stall = 0, dip = 0, burst = 0;
    for (let i = 2; i < fr.length; i++) {
      const d1 = fr[i].sweet.clone().sub(fr[i - 1].sweet), d0 = fr[i - 1].sweet.clone().sub(fr[i - 2].sweet);
      const l1 = d1.length(), l0 = d0.length();
      if (l0 > 1e-3 && d1.dot(d0) / l0 < -0.01) back++;
      if (l0 > 0.05 && l1 < 0.003) stall++;
      // Past the swing's peak on screen (the onset of a real swing accelerates that fast too).
      if (fr[i].T < blurFrom + DELIVERY - 0.05) continue;
      if (l0 > 0.05 && l1 < 0.6 * l0) dip++;
      if (l0 > 0.05 && l1 > 1.5 * l0 + 0.02) burst++;
    }
    assert.equal(back, 0, 'flicks back');
    assert.equal(stall, 0, 'stalls');
    assert.equal(dip + burst, 0, `${dip} dips, ${burst} bursts`);
  });
});

describe('presentation helpers', () => {
  test('racket trail strength: off at rest, full in a fast swing, monotonic', () => {
    assert.equal(trailStrength(0), 0);
    assert.equal(trailStrength(TRAIL.speedOn), 0);
    assert.equal(trailStrength(TRAIL.speedFull), 1);
    assert.equal(trailStrength(40), 1);
    let prev = 0;
    for (let v = 0; v <= 20; v += 0.5) {
      const k = trailStrength(v);
      assert.ok(k >= prev - 1e-12);
      prev = k;
    }
  });

  test('forearm cut along the limb (QA r5 ghost bulb): narrow soft edge, the cap goes with the stub, a cuff at the eye', () => {
    // With the stub drawn the whole forearm (elbow cap included) is solid.
    const cStub = alongCutStart(true, 0.7);
    assert.ok(alongCutAlpha(0, cStub) > 0.99 && alongCutAlpha(1, cStub) > 0.99);
    // Stub hidden: the rounded elbow cap (t <= 0.02) is fully cut, the hand end solid.
    const cCap = alongCutStart(false, 0.7);
    assert.equal(alongCutAlpha(0, cCap), 0);
    assert.ok(alongCutAlpha(0.25, cCap) > 0.99);
    // Elbow at the eye: only the wrist end (a cuff) stays.
    const cCuff = alongCutStart(false, ALONG_CUT.near - 0.05);
    assert.equal(alongCutAlpha(0.45, cCuff), 0);
    assert.ok(alongCutAlpha(0.9, cCuff) > 0.99);
    // A whole-forearm factor of 0 (wrist at the eye) hides it all; 1 keeps the cut.
    assert.equal(alongCutAlpha(1, alongCutHide(cCap, 0)), 0);
    assert.equal(alongCutHide(cCap, 1), cCap);
    // Never a wide half-transparent area: for every elbow distance / factor, the part of the
    // forearm drawn with 0.1 < alpha < 0.9 is at most 3.5 cm (of a 26.5 cm forearm).
    for (const stub of [true, false]) {
      for (let d = 0.2; d <= 0.8; d += 0.02) {
        for (const f of [1, 0.7, 0.4, 0.1]) {
          const c = alongCutHide(alongCutStart(stub, d), f);
          let partial = 0;
          for (let t = 0; t <= 1; t += 0.005) {
            const a = alongCutAlpha(t, c);
            if (a > 0.1 && a < 0.9) partial += 0.005;
          }
          assert.ok(partial * 0.265 <= 0.035, `stub ${stub} d ${d.toFixed(2)} f ${f}: ${(partial * 26.5).toFixed(1)} cm half transparent`);
        }
      }
    }
  });

  test('near cut by view depth: a 3 cm band; the stub is solid or hidden, with hysteresis', () => {
    const { near, far } = nearCutDepths(ARM_RADIUS.fore);
    assert.ok(far - near <= 0.035 && far - near > 0.01, `band ${(far - near).toFixed(3)} m`);
    assert.equal(nearCutAlpha(ARM_RADIUS.fore, near - 0.001), 0);
    assert.equal(nearCutAlpha(ARM_RADIUS.fore, far + 0.001), 1);
    // Stub: on beyond STUB_SHOW.on, kept until STUB_SHOW.off; never while looking down at the body.
    assert.equal(stubShown(false, 0.63, 0, 1), false);
    assert.equal(stubShown(false, 0.7, 0, 1), true);
    assert.equal(stubShown(true, 0.63, 0, 1), true);
    assert.equal(stubShown(true, 0.55, 0, 1), false);
    assert.equal(stubShown(true, 0.8, STUB_SHOW.minViewY - 0.05, 1), false);
    assert.equal(stubShown(false, 0.8, 0, 0.3), false, 'raised elbow / beside the eye');
  });
});

describe('in the game (human autopilot, Mac latency, 30 fps webcam feed)', () => {
  test('drawn racket: events per swing, bounded jumps, follow-through, hits unchanged by the view', () => {
    const settings = loadSettings(null);
    const g = createTestGame({ spec: { kind: 'drill', drillId: 'fh-drive' }, settings, seed: 2 });
    const w = g.world;
    const ev = [];
    w.bus.on('player:swing', (e) => ev.push(e));
    const tip = RACKET.length + RACKET.buttY;
    let prev = null, prevD = null;
    const d2 = [];
    while (w.time < 40 && !g.isFinished()) {
      g.advanceTo(w.time + 1 / 60);
      const r = w.player.renderRacket;
      if (!r) { prev = null; continue; }
      const pp = w.player.pos;
      const head = new Vec3(r.grip.x + r.axis.x * tip - pp.x, r.grip.y + r.axis.y * tip, r.grip.z + r.axis.z * tip - pp.z);
      if (prev) {
        const d = head.clone().sub(prev);
        if (prevD && w.time > 11) d2.push(d.clone().sub(prevD).length() * 100);
        prevD = d;
      }
      prev = head;
    }
    const starts = ev.filter((e) => e.phase === 'start').length;
    const peaks = ev.filter((e) => e.phase === 'peak').length;
    const ends = ev.filter((e) => e.phase === 'end').length;
    assert.ok(g.stats.playerHits >= 6, `hits ${g.stats.playerHits}`);
    assert.ok(starts >= g.stats.playerHits * 0.8, `starts ${starts} for ${g.stats.playerHits} hits`);
    assert.ok(Math.abs(starts - ends) <= 1 && peaks <= starts, `start ${starts} peak ${peaks} end ${ends}`);
    // Smooth at 60 fps: the 95th percentile second difference of the racket head stays small.
    assert.ok(q(d2, 0.95) < 20, `p95 second difference ${q(d2, 0.95).toFixed(1)} cm`);
    assert.ok(g.human.view.stats.coasts > 0, 'follow-through coasts');
  });
});

void VIEW;
