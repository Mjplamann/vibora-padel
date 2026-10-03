// Node checks for the pure parts of audio/engine.js (synth), audio/voice.js, tracking/camera.js
// (label classification + error messages) and input/fallback.js (pointer math, racket
// orientation, auto-swing). If the physics modules exist, the auto-swing is also checked end
// to end: a machine feed simulated with physics/ball.js must be met by sweptContact.
// Usage: node --test dev/units-test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { synth } from '../src/audio/engine.js';
import { createVoice, pickVoice } from '../src/audio/voice.js';
import { classifyCamera, describeCameraError } from '../src/tracking/camera.js';
import {
  pointerToPlane, orientRacket, flickVelocity, forehandness, predictBallPath, chooseContact,
  planSwing, swingSample, createFallbackControls, FALLBACK,
} from '../src/input/fallback.js';
import { createRng } from '../src/util/math.js';
import { v3 } from '../src/util/vec3.js';
import { RACKET } from '../src/config.js';

const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);

// ---------------- audio synthesis ----------------
test('every synthesized sound is finite, non-silent and below full scale', () => {
  const rng = createRng(5);
  const cases = [
    ['racket', { speed: 30, quality: 1 }], ['racket', { speed: 4, quality: 0 }], ['bounce', { speed: 9 }],
    ['bounce', { surface: 'outsideFloor', speed: 4 }], ['bounce', { surface: 'ceiling', speed: 4 }],
    ['glass', { speed: 20 }], ['mesh', { speed: 14 }], ['net', { speed: 9 }], ['cord', {}], ['machine', {}],
    ['footstep', { speed: 5 }], ['ui', { kind: 'confirm' }], ['ui', { kind: 'nope' }], ['cheer', { level: 0.5 }],
  ];
  for (const [k, a] of cases) {
    const out = synth[k](48000, rng, a);
    for (const ch of Array.isArray(out) ? out : [out]) {
      let peak = 0;
      for (const v of ch) {
        assert.ok(Number.isFinite(v), `${k} NaN`);
        peak = Math.max(peak, Math.abs(v));
      }
      assert.ok(peak > 0.01 && peak < 1, `${k} peak ${peak}`);
    }
  }
});

test('racket pock gets brighter with speed and duller off-centre', () => {
  const centroid = (buf) => {
    // zero-crossing rate over the first 20 ms as a cheap brightness proxy
    let zc = 0;
    const n = Math.round(0.02 * 48000);
    for (let i = 1; i < n; i++) if ((buf[i - 1] < 0) !== (buf[i] < 0)) zc++;
    return zc;
  };
  const avg = (args) => {
    let s = 0;
    for (let k = 0; k < 8; k++) s += centroid(synth.racket(48000, createRng(100 + k), args));
    return s / 8;
  };
  const fast = avg({ speed: 30, quality: 1 });
  const slow = avg({ speed: 5, quality: 1 });
  const off = avg({ speed: 30, quality: 0.1 });
  assert.ok(fast > slow, `fast ${fast} > slow ${slow}`);
  assert.ok(fast > off, `clean ${fast} > mishit ${off}`);
});

test('hall impulse has unit energy and ~1.4 s decay', () => {
  const [L] = synth.impulse(48000, createRng(1), 1.4);
  let e = 0, late = 0;
  for (let i = 0; i < L.length; i++) {
    e += L[i] * L[i];
    if (i > 48000 * 0.7) late += L[i] * L[i];
  }
  close(e, 1, 1e-3, 'energy');
  // energy after 0.7 s should be roughly -30 dB of total for rt60 1.4 s
  const db = 10 * Math.log10(late);
  assert.ok(db < -22 && db > -45, `late energy ${db} dB`);
});

// ---------------- voice ----------------
function fakeSpeech(voices) {
  const spoken = [];
  let cur = null;
  const synthObj = {
    speaking: false,
    getVoices: () => voices,
    speak(u) {
      assert.equal(cur, null, 'overlap: speak() while another utterance is active');
      cur = u;
      spoken.push(u);
    },
    cancel() {
      const u = cur;
      cur = null;
      if (u && u.onerror) u.onerror({ error: 'interrupted' });
    },
    addEventListener() {},
    end() {
      const u = cur;
      cur = null;
      if (u && u.onend) u.onend();
    },
  };
  class Utt {
    constructor(text) {
      this.text = text;
    }
  }
  return { synthObj, Utt, spoken };
}

function fakeClock() {
  let t = 0;
  const timers = [];
  return {
    now: () => t,
    setTimer: (fn, ms) => {
      const id = { at: t + ms, fn };
      timers.push(id);
      return id;
    },
    clearTimer: (id) => {
      const i = timers.indexOf(id);
      if (i >= 0) timers.splice(i, 1);
    },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift();
        t = next.at;
        next.fn();
      }
      t = end;
    },
  };
}

test('pickVoice prefers natural macOS voices and skips novelty ones', () => {
  const voices = [
    { name: 'Albert', lang: 'en-US', localService: true },
    { name: 'Fred', lang: 'en-US', localService: true },
    { name: 'Samantha', lang: 'en-US', localService: true },
    { name: 'Daniel (Enhanced)', lang: 'en-GB', localService: true },
    { name: 'Mónica', lang: 'es-ES', localService: true },
    { name: 'Paulina', lang: 'es-MX', localService: true },
  ];
  assert.equal(pickVoice(voices, 'en').name, 'Daniel (Enhanced)');
  assert.equal(pickVoice(voices, 'es').name, 'Mónica');
  assert.equal(pickVoice([{ name: 'Zarvox', lang: 'en-US' }], 'en'), null);
});

test('voice never overlaps, respects priority, dedupes and speaks Spanish', () => {
  const { synthObj, Utt, spoken } = fakeSpeech([{ name: 'Samantha', lang: 'en-US' }, { name: 'Mónica', lang: 'es-ES' }]);
  const clk = fakeClock();
  const v = createVoice({ synth: synthObj, Utterance: Utt, now: clk.now, setTimer: clk.setTimer, clearTimer: clk.clearTimer });
  assert.ok(v.say('Racket back early', { priority: 1 }));
  assert.ok(v.say('Watch the glass', { priority: 1 }));
  assert.ok(v.say('Great shot!', { priority: 2 }));
  assert.equal(v.say('Racket back early'), false, 'dedupe');
  assert.equal(spoken.length, 1);
  synthObj.end();
  clk.advance(800);
  assert.equal(spoken.length, 2);
  assert.equal(spoken[1].text, 'Great shot!', 'higher priority first');
  // urgent interrupts without overlap
  assert.ok(v.say('Por tres!', { priority: 'urgent' }));
  assert.equal(spoken.at(-1).text, 'Por tres!');
  synthObj.end();
  clk.advance(900);
  assert.equal(spoken.at(-1).text, 'Watch the glass');
  synthObj.end();
  clk.advance(900);
  v.setLang('es');
  assert.ok(v.say('Good', { es: 'Bien', priority: 2 }));
  assert.equal(spoken.at(-1).text, 'Bien');
  assert.equal(spoken.at(-1).voice.name, 'Mónica');
  // low-priority tips are rate-limited
  synthObj.end();
  clk.advance(1000);
  assert.ok(v.say('tip one', { priority: 0 }));
  synthObj.end();
  clk.advance(1000);
  assert.equal(v.say('tip two', { priority: 0 }), false);
  // stale cues expire
  assert.ok(v.say('A', { priority: 2 }));
  assert.ok(v.say('B', { priority: 1 }));
  clk.advance(20000); // watchdog releases A, B has expired
  assert.notEqual(spoken.at(-1).text, 'B');
});

test('voice is a silent no-op without speechSynthesis', () => {
  const v = createVoice({ synth: undefined, Utterance: undefined });
  assert.equal(v.available, false);
  assert.equal(v.say('hello'), false);
  v.setEnabled(false);
  v.setLang('es');
});

// ---------------- camera labels / errors ----------------
test('camera labels map to kinds and presets', () => {
  assert.deepEqual(classifyCamera('FaceTime HD Camera'), { kind: 'builtin', presetKey: 'macbook-builtin' });
  assert.deepEqual(classifyCamera('MacBook Pro Camera'), { kind: 'builtin', presetKey: 'macbook-builtin' });
  assert.deepEqual(classifyCamera("Mike's iPhone Camera"), { kind: 'continuity', presetKey: 'iphone-continuity' });
  assert.equal(classifyCamera('iPhone Desk View Camera').unsuitable, true);
  assert.deepEqual(classifyCamera('Logitech BRIO (046d:085e)'), { kind: 'usb', presetKey: 'usb-webcam' });
  assert.deepEqual(classifyCamera(''), { kind: 'unknown', presetKey: 'macbook-builtin' });
});

test('camera errors carry human-readable macOS guidance', () => {
  const os = describeCameraError({ name: 'NotAllowedError', message: 'Permission denied by system' }, { mac: true, browser: 'Google Chrome' });
  assert.equal(os.code, 'os-denied');
  assert.ok(os.help.join(' ').includes('System Settings > Privacy & Security > Camera'));
  const site = describeCameraError({ name: 'NotAllowedError', message: 'Permission denied' }, { mac: true, browser: 'Safari' });
  assert.equal(site.code, 'permission-denied');
  assert.ok(site.help.some((h) => h.includes('Privacy & Security')));
  assert.equal(describeCameraError({ name: 'NotReadableError' }).code, 'in-use');
  assert.equal(describeCameraError({ name: 'NotFoundError' }).code, 'not-found');
});

// ---------------- fallback controls ----------------
const EYE = v3(2.3, 1.64, 7.8);

test('pointer projects onto the plane 0.65 m in front of the eye', () => {
  const p = pointerToPlane(0, 0, EYE, { fovDeg: 70, aspect: 16 / 9, pitchDeg: 0 });
  close(p.z, EYE.z - 0.65, 1e-9, 'z');
  close(p.x, EYE.x, 1e-9, 'x');
  close(p.y, EYE.y, 1e-9, 'y');
  const q = pointerToPlane(0, 1, EYE, { fovDeg: 70, aspect: 16 / 9, pitchDeg: 0 });
  close(q.y - EYE.y, 0.65 * Math.tan((35 * Math.PI) / 180), 1e-9, 'top edge');
  const r = pointerToPlane(1, 0, EYE, { fovDeg: 70, aspect: 2, pitchDeg: 0 });
  close(r.x - EYE.x, 2 * 0.65 * Math.tan((35 * Math.PI) / 180), 1e-9, 'right edge');
  const d = pointerToPlane(0, 0, EYE, { pitchDeg: -6 });
  assert.ok(d.y < EYE.y, 'pitched down');
  close(d.z, EYE.z - 0.65, 1e-9, 'pitched plane z');
});

test('racket orientation: unit, orthogonal, forehand right / backhand left, grip offset', () => {
  for (const handed of ['right', 'left']) {
    const s = handed === 'left' ? -1 : 1;
    const fhSweet = v3(EYE.x + s * 0.6, 1.0, EYE.z - 0.65);
    const bhSweet = v3(EYE.x - s * 0.6, 1.0, EYE.z - 0.65);
    const fh = orientRacket(fhSweet, EYE, v3(0, 0, -1), handed, { grip: v3(), axis: v3(), normal: v3() });
    const bh = orientRacket(bhSweet, EYE, v3(0, 0, -1), handed, { grip: v3(), axis: v3(), normal: v3() });
    for (const p of [fh, bh]) {
      close(p.axis.length(), 1, 1e-9, 'axis unit');
      close(p.normal.length(), 1, 1e-9, 'normal unit');
      close(p.axis.dot(p.normal), 0, 1e-9, 'orthogonal');
    }
    assert.ok(fh.axis.x * s > 0.3, `${handed} forehand head out to the hand side`);
    assert.ok(bh.axis.x * s < -0.3, `${handed} backhand head across`);
    assert.ok(fh.normal.z < -0.5, 'forehand face toward the net');
    assert.ok(bh.normal.z > 0.5, 'backhand: forehand face toward the player (back face hits)');
    const sweet = fh.grip.clone().addScaled(fh.axis, RACKET.sweetSpotY);
    assert.ok(sweet.distanceTo(fhSweet) < 1e-9, 'sweet spot sits at grip + axis*sweetSpotY');
    assert.equal(forehandness(fhSweet, EYE, handed), 1);
    assert.equal(forehandness(bhSweet, EYE, handed), 0);
  }
});

test('flick velocity has 3x gain and drives toward the net', () => {
  const v = flickVelocity(v3(-4, 0.5, 0));
  close(v.length(), 3 * Math.hypot(4, 0.5), 1e-9, 'gain');
  assert.ok(v.z < 0 && v.x < 0, 'forward and with the flick');
  assert.equal(flickVelocity(v3()).length(), 0);
});

test('controller: pointer flick produces a fast racket pose; keys move the target', () => {
  const listeners = {};
  const keyTarget = { addEventListener: (t, f) => (listeners[t] = f), removeEventListener: () => {} };
  const fb = createFallbackControls({ canvas: null, handed: 'right', keyTarget });
  const world = { time: 0, player: { pos: v3(2.3, 0, 7.8), eye: EYE.clone(), height: 1.75 }, ball: null, settings: { fov: 70 } };
  let out = fb.update(1 / 60, world);
  assert.equal(out.moveTarget, null);
  for (let i = 0; i < 6; i++) {
    world.time += 1 / 60;
    fb.setPointer(0.6 - i * 0.12, -0.25);
    out = fb.update(1 / 60, world);
  }
  const sp = out.racket.vel.length();
  assert.ok(sp > 8, `flick speed ${sp}`);
  assert.ok(out.racket.vel.z < 0, 'toward net');
  listeners.keydown({ code: 'KeyW', preventDefault() {}, target: {} });
  world.time += 0.5;
  out = fb.update(0.5, world);
  assert.ok(out.moveTarget && out.moveTarget.z < 7.8, 'W moves toward the net');
  listeners.keyup({ code: 'KeyW' });
  fb.dispose();
});

test('auto-swing passes the sweet spot through the predicted contact at speed', () => {
  const ball = { pos: v3(-1.0, 1.0, -9), vel: v3(4.2, 3.2, 17) };
  const path = predictBallPath(ball);
  const c = chooseContact(path, { x: 2.3, z: 7.8 }, 'right');
  assert.ok(c, 'contact found');
  assert.ok(c.bounced, 'groundstroke after the bounce');
  const plan = planSwing(c, c.t, EYE, 'right');
  const pos = v3(), vel = v3();
  swingSample(plan, c.t, pos, vel);
  assert.ok(pos.distanceTo(c) < 1e-9, 'through contact');
  close(vel.length(), FALLBACK.autoSwingSpeed, 1e-6, 'contact speed');
  swingSample(plan, c.t - 0.2, pos, vel);
  assert.ok(pos.z > c.z, 'backswing behind contact');
});

test('auto-swing meets a physically simulated feed (sweptContact)', async (t) => {
  let phys;
  try {
    phys = {
      ...(await import('../src/physics/ball.js')),
      ...(await import('../src/physics/court.js')),
      ...(await import('../src/physics/racket.js')),
    };
  } catch {
    t.skip('physics modules not available');
    return;
  }
  const { createBall, stepBall, createCourt, sweptContact, cloneBall } = phys;
  const court = createCourt();
  const rng = createRng(2);
  let hits = 0;
  const feeds = [[-1, 4.2, 3.2, 17], [0.5, 3.0, 4.0, 16], [1.5, 1.8, 3.6, 18.5], [-2, 5.5, 2.5, 19]];
  for (const [x0, vx, vy, vz] of feeds) {
    const ball = createBall(v3(x0, 1.0, -9), v3(vx, vy, vz), v3());
    const fb = createFallbackControls({ canvas: null, handed: 'right', keyTarget: null });
    const world = { time: 0, ball, player: { pos: v3(2.3, 0, 7.8), eye: EYE.clone() }, settings: { fov: 70 } };
    fb.setPointer(0.3, -0.3);
    let prevPose = fb.update(1 / 60, world).racket;
    let prevBall = cloneBall(ball);
    fb.triggerAutoSwing();
    let hit = null;
    for (let f = 0; f < 120 && !hit; f++) {
      const ev = [];
      stepBall(ball, 1 / 60, court, rng, ev);
      world.time += 1 / 60;
      const pose = fb.update(1 / 60, world).racket;
      hit = sweptContact(prevPose, pose, prevBall, ball, 0.02);
      prevPose = pose;
      prevBall = cloneBall(ball);
    }
    if (hit) hits++;
  }
  t.diagnostic(`auto-swing hit ${hits}/4 feeds`);
  assert.ok(hits >= 3, `auto-swing hit ${hits}/4 feeds`);
});
