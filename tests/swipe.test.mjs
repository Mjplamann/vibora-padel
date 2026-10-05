// Swipe mode: the one-finger swing recognizer and the gesture -> racket swing mapping
// (src/input/swipe.js). Gestures are synthesised as touch samples at 60 or 120 Hz.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSwipeRecognizer, shotIntent, effortOf, peakTime, swingShape, SWIPE, AIM_DEV, VIBORA_AZ } from '../src/input/swipe.js';

const PHONE = { width: 844, height: 390 }; // iPhone 15 Pro landscape (CSS px)

/**
 * Touch samples of a flick: from (x0, y0) by (dx, dy) (px, y down) over `dur` s starting at t0 (ms),
 * position eased so the speed is a bell peaking at `peakAt` (0..1 of the duration), sampled at
 * `hz`. bend: sideways bulge of the path (px, + = to the left of the travel direction, y up).
 */
function flick({ x0 = 600, y0 = 330, dx = 0, dy = -220, dur = 0.12, t0 = 1000, hz = 60, peakAt = 0.5, bend = 0, holdBefore = 0.08, holdAfter = 0 } = {}) {
  const pts = [];
  const len = Math.hypot(dx, dy) || 1;
  // Left of the travel direction (y up) is (-u.y, u.x) with u = (dx, -dy) / len; in screen coords (y down):
  const lx = dy / len, ly = -dx / len;
  const ease = (u) => {
    // Speed ∝ a bell centred at peakAt: integrate a raised cosine warped by peakAt.
    const w = u < peakAt ? 0.5 * (u / peakAt) : 0.5 + 0.5 * ((u - peakAt) / (1 - peakAt));
    return w - Math.sin(2 * Math.PI * w) / (2 * Math.PI);
  };
  const step = 1 / hz;
  for (let t = -holdBefore; t <= dur + holdAfter + 1e-9; t += step) {
    const u = Math.min(1, Math.max(0, t / dur));
    const e = ease(u);
    const b = bend * 4 * e * (1 - e);
    pts.push({ x: x0 + dx * e + lx * b, y: y0 + dy * e + ly * b, t: t0 + t * 1000 });
  }
  return pts;
}

function run(rec, pts, id = 1, { lift = true } = {}) {
  const evs = [];
  evs.push(...rec.down(id, pts[0].x, pts[0].y, pts[0].t));
  for (let i = 1; i < pts.length; i++) evs.push(...rec.move(id, pts[i].x, pts[i].y, pts[i].t));
  const last = pts[pts.length - 1];
  if (lift) evs.push(...rec.up(id, last.x, last.y, last.t + 8));
  return evs;
}

const swings = (evs) => evs.filter((e) => e.type === 'swing');

test('a fast upward flick is one swing: topspin, centred aim, high effort, tSwing at the velocity peak', () => {
  for (const hz of [60, 120]) {
    const rec = createSwipeRecognizer(PHONE);
    const pts = flick({ dy: -260, dur: 0.11, hz });
    const sw = swings(run(rec, pts));
    assert.equal(sw.length, 1, `${hz} Hz`);
    const s = sw[0];
    assert.equal(s.hint, 'topspin');
    assert.equal(s.path, 'up');
    assert.ok(Math.abs(s.aimX) < 0.05, `aimX ${s.aimX}`);
    assert.ok(s.upness > 0.99);
    assert.ok(s.effort > 0.5, `effort ${s.effort}`);
    // The bell peaks at 55 ms after the start (t0 = 1000 ms); the windowed velocity lags by ~half the window.
    assert.ok(Math.abs(s.tSwing - 1055) < 16, `tSwing ${s.tSwing}`);
    assert.ok(s.tStart < s.tSwing && s.tSwing <= s.tEnd);
  }
});

test('slow drags (scrolls, pans) and tiny twitches are never swings; a still touch is a tap', () => {
  const rec = createSwipeRecognizer(PHONE);
  assert.equal(swings(run(rec, flick({ dy: -200, dur: 1.4 }))).length, 0, 'slow drag');
  assert.equal(swings(run(rec, flick({ dx: 300, dy: 0, dur: 1.0 }), 2)).length, 0, 'slow pan');
  // A very fast but tiny flick (20 px) is below the minimum travel.
  const twitch = run(rec, flick({ dy: -20, dur: 0.03, hz: 120 }), 3);
  assert.equal(swings(twitch).length, 0, 'twitch');
  const tap = run(createSwipeRecognizer(PHONE), [{ x: 400, y: 200, t: 0 }, { x: 402, y: 201, t: 60 }, { x: 402, y: 201, t: 120 }], 4);
  assert.deepEqual(tap.map((e) => e.type), ['tap']);
  // Held too long: not a tap.
  const hold = run(createSwipeRecognizer(PHONE), [{ x: 400, y: 200, t: 0 }, { x: 401, y: 200, t: 400 }], 5);
  assert.equal(hold.length, 0);
});

test('effort grows with swipe speed and is normalised by the screen size', () => {
  const rec = createSwipeRecognizer(PHONE);
  const efforts = [0.5, 0.3, 0.2, 0.12, 0.08].map((dur, i) => swings(run(rec, flick({ dy: -230, dur, t0: 1000 + i * 2000 }), 10 + i))[0].effort);
  for (let i = 1; i < efforts.length; i++) assert.ok(efforts[i] > efforts[i - 1], `efforts ${efforts.map((e) => e.toFixed(2))}`);
  assert.ok(efforts[0] < 0.25 && efforts[efforts.length - 1] > 0.8, `range ${efforts[0].toFixed(2)}..${efforts[efforts.length - 1].toFixed(2)}`);
  // The same gesture on a tablet twice as large (all distances doubled) has the same effort.
  const tablet = createSwipeRecognizer({ width: 1688, height: 780 });
  const a = swings(run(createSwipeRecognizer(PHONE), flick({ dy: -200, dur: 0.15 })))[0].effort;
  const b = swings(run(tablet, flick({ x0: 1200, y0: 660, dy: -400, dur: 0.15 })))[0].effort;
  assert.ok(Math.abs(a - b) < 0.02, `${a} vs ${b}`);
  assert.equal(effortOf(SWIPE.effortSpeed[1] + 1, SWIPE.effortLen[1] + 1), 1);
  assert.equal(effortOf(0, 0), 0);
});

test('aim: the horizontal direction of the flick (left -1 .. right +1)', () => {
  const rec = createSwipeRecognizer(PHONE);
  const left = swings(run(rec, flick({ dx: -170, dy: -170, dur: 0.1 }), 1))[0];
  const right = swings(run(rec, flick({ dx: 170, dy: -170, dur: 0.1, t0: 5000 }), 2))[0];
  const slight = swings(run(rec, flick({ dx: 60, dy: -220, dur: 0.1, t0: 9000 }), 3))[0];
  assert.ok(left.aimX < -0.9 && right.aimX > 0.9, `${left.aimX} ${right.aimX}`);
  assert.ok(slight.aimX > 0.2 && slight.aimX < 0.5, `${slight.aimX}`);
});

test('path: down flicks slice, steep slow long up-swipes lob, curves are curved (signed)', () => {
  const rec = createSwipeRecognizer(PHONE);
  const down = swings(run(rec, flick({ y0: 60, dy: 240, dur: 0.1 }), 1))[0];
  assert.equal(down.path, 'down');
  assert.equal(down.hint, 'slice');
  assert.ok(down.upness < -0.99);
  const lob = swings(run(rec, flick({ dy: -250, dur: 0.42, t0: 4000 }), 2))[0];
  assert.ok(lob, 'a lob swipe still reaches the swing speed');
  assert.equal(lob.lob, true);
  assert.equal(lob.hint, 'lob');
  const fastUp = swings(run(rec, flick({ dy: -250, dur: 0.1, t0: 8000 }), 3))[0];
  assert.equal(fastUp.lob, false, 'a fast steep flick is a drive');
  const curveL = swings(run(rec, flick({ dy: -240, dur: 0.12, bend: 70, t0: 12000 }), 4))[0];
  const curveR = swings(run(rec, flick({ dy: -240, dur: 0.12, bend: -70, t0: 16000 }), 5))[0];
  assert.equal(curveL.curved, true);
  assert.equal(curveL.hint, 'curve');
  assert.ok(curveL.curve > 0 && curveR.curve < 0, `${curveL.curve} ${curveR.curve}`);
  const straight = swings(run(rec, flick({ dy: -240, dur: 0.12, t0: 20000 }), 6))[0];
  assert.equal(straight.curved, false);
});

test('two-finger tap pauses (no taps or swings from those fingers)', () => {
  const rec = createSwipeRecognizer(PHONE);
  const evs = [];
  evs.push(...rec.down(1, 300, 200, 0));
  evs.push(...rec.down(2, 420, 210, 60));
  evs.push(...rec.move(1, 301, 201, 90));
  evs.push(...rec.up(1, 301, 201, 150));
  evs.push(...rec.up(2, 421, 210, 170));
  assert.deepEqual(evs.map((e) => e.type), ['pause']);
  // Too slow (held) or moving: no pause.
  const slow = createSwipeRecognizer(PHONE);
  const e2 = [...slow.down(1, 300, 200, 0), ...slow.down(2, 420, 210, 60), ...slow.up(1, 300, 200, 700), ...slow.up(2, 420, 210, 720)];
  assert.equal(e2.filter((e) => e.type === 'pause').length, 0);
});

test('stick: left-zone drags steer (when on); flicks elsewhere are still swings', () => {
  const rec = createSwipeRecognizer({ ...PHONE, stick: true });
  const evs = [];
  evs.push(...rec.down(7, 120, 300, 0));
  evs.push(...rec.move(7, 120 + 60, 300, 50));
  evs.push(...rec.move(7, 120 + 60, 300 - 60, 100));
  const st = evs.filter((e) => e.type === 'stick');
  assert.ok(st.length >= 2);
  const last = st[st.length - 1];
  assert.ok(last.x > 0.3 && last.y > 0.3, `stick ${last.x}, ${last.y}`);
  assert.ok(Math.hypot(last.x, last.y) <= 1 + 1e-9);
  // Dragged past the rim: the origin follows, the vector stays unit.
  const far = rec.move(7, 120 + 400, 300, 150)[0];
  assert.ok(far.x > 0.95 && Math.abs(far.y) < 0.05, `${far.x}, ${far.y}`);
  const end = rec.up(7, 520, 300, 200);
  assert.deepEqual(end.map((e) => [e.type, e.active]).pop(), ['stick', false], 'released: the stick centres');
  // A flick on the right while the stick is held.
  rec.down(8, 100, 300, 300);
  const sw = swings(run(rec, flick({ x0: 650, dy: -230, dur: 0.1, t0: 320 }), 9));
  assert.equal(sw.length, 1);
  // Stick off: the left zone swings too.
  const off = createSwipeRecognizer(PHONE);
  assert.equal(swings(run(off, flick({ x0: 120, dy: -230, dur: 0.1 }))).length, 1);
});

test('a finger held still at the end of a flick still emits (poll), and coalesced timestamps are tolerated', () => {
  const rec = createSwipeRecognizer(PHONE);
  const pts = flick({ dy: -230, dur: 0.1, peakAt: 0.85 });
  const evs = run(rec, pts, 1, { lift: false });
  const all = [...evs, ...rec.poll(pts[pts.length - 1].t + 80)];
  assert.equal(swings(all).length, 1);
  const rec2 = createSwipeRecognizer(PHONE);
  const p2 = flick({ dy: -230, dur: 0.1, hz: 120 });
  const dup = [];
  for (const p of p2) { dup.push(p); dup.push({ ...p, x: p.x + 0.5 }); }
  assert.equal(swings(run(rec2, dup)).length, 1);
});

test('one finger can swing twice once the speed has dropped in between', () => {
  const rec = createSwipeRecognizer(PHONE);
  const a = flick({ y0: 340, dy: -150, dur: 0.1, t0: 0, holdAfter: 0.15 });
  const b = flick({ x0: a[a.length - 1].x, y0: a[a.length - 1].y, dy: 150, dur: 0.1, t0: a[a.length - 1].t + 16, holdBefore: 0 });
  const evs = run(rec, [...a, ...b.slice(1)]);
  const sw = swings(evs);
  assert.equal(sw.length, 2);
  assert.equal(sw[0].path, 'up');
  assert.equal(sw[1].path, 'down');
});

test('helpers: peak parabola and swing shape', () => {
  assert.ok(Math.abs(peakTime({ t: 0, s: 1 }, { t: 1, s: 2 }, { t: 2, s: 1 }) - 1) < 1e-9);
  const t = peakTime({ t: 0, s: 1 }, { t: 1, s: 2 }, { t: 2, s: 1.5 });
  assert.ok(t > 1 && t < 1.5, `${t}`);
  assert.equal(peakTime({ t: 0, s: 1 }, { t: 1, s: 1 }, { t: 2, s: 3 }), 1, 'no maximum: the middle sample');
  const sh = swingShape([{ x: 0, y: 100 }, { x: 10, y: 50 }, { x: 0, y: 0 }], 0, 2, 100);
  assert.ok(sh.dir.y > 0.99 && sh.curve < 0, `bulging right of an upward chord: ${sh.curve}`);
});

test('shotIntent: groundstroke, volley, overhead and serve swings in the judge\'s terms', () => {
  const base = { effort: 0.6, upness: 1, aimX: 0, curve: 0, curved: false, lob: false };
  const top = shotIntent(base, { family: 'fh' });
  assert.equal(top.kind, 'topspin');
  assert.ok(top.pathDeg >= 12 && top.pathDeg <= 30);
  const flat = shotIntent({ ...base, upness: 0.1 }, { family: 'bh' });
  assert.equal(flat.kind, 'flat');
  const slice = shotIntent({ ...base, upness: -0.9 }, { family: 'fh' });
  assert.equal(slice.kind, 'slice');
  assert.ok(slice.pathDeg < -12);
  const lob = shotIntent({ ...base, lob: true }, { family: 'fh' });
  assert.equal(lob.kind, 'lob');
  assert.ok(lob.pathDeg > 70, 'above every lob threshold of the judge');
  const right = shotIntent({ ...base, aimX: 1 }, { family: 'fh' });
  assert.ok(Math.abs(right.azDev - AIM_DEV) < 1e-9);
  const curve = shotIntent({ ...base, upness: 0.2, curved: true, curve: 0.6 }, { family: 'fh' });
  assert.equal(curve.kind, 'slice');
  assert.ok(curve.azDev > 0 && curve.pathDeg <= -10, 'a curve cuts: slice with sidespin');
  const upCurve = shotIntent({ ...base, curved: true, curve: -0.5 }, { family: 'bh' });
  assert.equal(upCurve.kind, 'slice');
  assert.ok(upCurve.azDev < 0);
  const volley = shotIntent({ ...base, upness: -0.8 }, { family: 'vfh' });
  assert.equal(volley.kind, 'volley');
  assert.ok(volley.pathDeg < 0);
  const smash = shotIntent({ ...base, upness: -0.9, effort: 0.85 }, { family: 'oh' });
  assert.equal(smash.kind, 'smash');
  assert.ok(smash.pathDeg < -12, 'the judge plays a smash below -12°');
  const bandeja = shotIntent({ ...base, upness: -0.9, effort: 0.5 }, { family: 'oh' });
  assert.equal(bandeja.kind, 'bandeja');
  const vibora = shotIntent({ ...base, curved: true, curve: -0.5, effort: 0.6 }, { family: 'oh' });
  assert.equal(vibora.kind, 'vibora');
  assert.ok(Math.abs(vibora.azDev) === VIBORA_AZ && vibora.azDev < 0, 'lateral swing beyond 0.6 rad');
  const serve = shotIntent({ ...base, aimX: -1 }, { family: 'fh', serve: true });
  assert.equal(serve.kind, 'serve');
  assert.ok(serve.azDev < 0);
});
