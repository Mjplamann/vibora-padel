// Víbora Padel audio engine (SPEC §7).
//
// Every sound is synthesized: no samples. One-shots are rendered sample-by-sample in JS
// (modal synthesis + filtered noise, a few ms of CPU each) into an AudioBuffer, then played
// through an HRTF PannerNode at the event position, with a send into a hall reverb
// (ConvolverNode, generated 1.4 s impulse response). The listener is the player's eye.
//
// Signal graph:
//   one-shot -> gain -> HRTF panner -> sfxBus ------------\
//                  \-> send -> sfxVerb --> convolver -> wet -> master -> limiter -> out
//   ambience loops / neighbour rallies -> ambBus ----------/        ^
//   cheer / ui (stereo, not spatial) -> sfxBus / uiBus ------------/
//
// The synthesis functions are pure (Float32Array in, Float32Array out) and exported as
// `synth` (and `venueSynth`, src/audio/venueSynth.js) so they can be checked under Node. Nothing
// here touches browser globals at import.
//
// Round 4: venues (setVenue(meta) from src/render/venues/meta.js) set the reverb (club hall, open
// air, arena), the ambience bed (HVAC + chatter + neighbour courts / sea, breeze and birds /
// arena crowd murmur) and the crowd (crowd(kind, level): applause, cheer, roar, ooh, aah, groan,
// hush, murmur, heard from the stands around the court). swing(evt) plays the racket whoosh from
// 'player:swing'; duck(amount) lowers the crowd and ambience under speech. The racket pock is the
// padel EVA-core model (venueSynth.genPock) and every glass pane rings with its own modes.

import { createRng, clamp } from '../util/math.js';
import {
  TAU, SPEED_OF_SOUND, Biquad, mode, noise, grains, lowpass1, normalize, fadeTail, impactWeight, jitter,
  VOWELS, panGains, voice, peakOf, seamless,
} from './dsp.js';

import {
  genPock, genGlassPane, glassPanelAt, genWhoosh, WHOOSH_PEAK_S, genApplause, genCrowdVowel, genCrowdBed, genSea, genBreeze,
  genBird, genVenueIR, venueSynth,
} from './venueSynth.js';
import { venueMeta } from '../render/venues/meta.js';

const MAX_VOICES = 48;

// --------------------------------------------------------------------------------------
// One-shot generators. Each returns a mono Float32Array at sample rate sr.
// --------------------------------------------------------------------------------------

/**
 * Padel racket "pock": foam-core (EVA) face, solid face plate with holes. A broadband
 * contact transient excites two face modes (~1.1 kHz, ~2.6 kHz) and the ball's own body
 * resonance. Faster impacts are shorter (brighter); off-centre hits shift energy into
 * low frame modes and lose the upper partials (duller, woodier "clack").
 */
function genRacket(sr, rng, { speed = 15, quality = 1, offCenter = null } = {}) {
  const s = clamp(speed / 28, 0, 1.25);
  const sc = Math.min(1, s);
  const off = offCenter != null ? clamp(offCenter, 0, 1) : clamp(1 - quality, 0, 1);
  const buf = new Float32Array(Math.ceil(sr * 0.3));
  const tc = (0.6 - 0.32 * sc + 0.45 * off) / 1000;
  const bright = (0.32 + 0.68 * sc) * (1 - 0.6 * off);
  const w = (f) => impactWeight(f, tc);
  // contact transient
  noise(buf, sr, 0, 0.7 * bright + 0.15, 0.00004, 0.00045 + 0.0005 * off, rng, [['hp', 1400 + 2600 * sc, 0.7]], 0.004);
  // face modes
  const f1 = 1100 * jitter(rng, 0.03) * (1 - 0.07 * off);
  mode(buf, sr, 0, f1, 1.0 * w(f1), 0.0165 * (0.7 + 0.45 * (1 - off)), { glide: 0.05, phase: rng() * TAU });
  const f2 = 2600 * jitter(rng, 0.025);
  mode(buf, sr, 0, f2, 0.62 * w(f2) * bright, 0.0085, { glide: 0.03, phase: rng() * TAU });
  const f3 = 4180 * jitter(rng, 0.03);
  mode(buf, sr, 0, f3, 0.32 * w(f3) * bright * sc, 0.0042, { phase: rng() * TAU });
  // hollow ball body + racket/handle thunk felt in the hand
  mode(buf, sr, 0, 238 * jitter(rng, 0.04), 0.42, 0.013, { glide: 0.14, phase: rng() * TAU });
  mode(buf, sr, 0.0005, 122 * jitter(rng, 0.05), 0.2 * (0.5 + off), 0.022);
  // off-centre: frame "clack" and a short woody rattle
  if (off > 0.04) {
    mode(buf, sr, 0, 565 * jitter(rng, 0.05), 0.62 * off, 0.026, { phase: rng() * TAU });
    mode(buf, sr, 0, 1640 * jitter(rng, 0.05), 0.36 * off, 0.013, { phase: rng() * TAU });
    mode(buf, sr, 0, 3360 * jitter(rng, 0.05), 0.16 * off, 0.008, { phase: rng() * TAU });
    noise(buf, sr, 0, 0.3 * off, 0.0002, 0.006, rng, [['bp', 900, 1.3]], 0.04);
  }
  // felt fizz on fast, clean hits
  noise(buf, sr, 0, 0.09 * sc * (1 - off), 0.0001, 0.003, rng, [['bp', 6200, 1.5]], 0.02);
  fadeTail(buf, sr);
  return normalize(buf, 0.14 + 0.34 * s ** 0.85);
}

/** Ball on sand-filled artificial turf (thud + felt + sand hiss), concrete or the ceiling. */
function genBounce(sr, rng, { surface = 'turf', speed = 6 } = {}) {
  const s = clamp(speed / 12, 0, 1.25);
  const sc = Math.min(1, s);
  const buf = new Float32Array(Math.ceil(sr * 0.32));
  if (surface === 'outsideFloor') {
    noise(buf, sr, 0, 0.5 * sc + 0.1, 0.00004, 0.0005, rng, [['hp', 2500, 0.7]], 0.003);
    mode(buf, sr, 0, 960 * jitter(rng, 0.04), 0.9, 0.009, { glide: 0.04, phase: rng() * TAU });
    mode(buf, sr, 0, 2150 * jitter(rng, 0.04), 0.4 * sc, 0.005, { phase: rng() * TAU });
    mode(buf, sr, 0, 185 * jitter(rng, 0.05), 0.45, 0.018, { glide: 0.1 });
  } else if (surface === 'ceiling') {
    mode(buf, sr, 0, 420 * jitter(rng, 0.05), 0.8, 0.03, { glide: 0.06 });
    mode(buf, sr, 0, 95, 0.7, 0.06);
    noise(buf, sr, 0, 0.3, 0.0003, 0.02, rng, [['lp', 1500, 0.7]], 0.1);
  } else {
    // turf: compliant pile + sand, so lower and softer than concrete
    noise(buf, sr, 0, 0.32 * sc + 0.06, 0.00008, 0.0007, rng, [['hp', 1800, 0.7]], 0.004);
    mode(buf, sr, 0, 820 * jitter(rng, 0.05), 0.65 * (0.4 + 0.6 * sc), 0.0085, { glide: 0.05, phase: rng() * TAU });
    mode(buf, sr, 0, 1690 * jitter(rng, 0.05), 0.24 * sc, 0.0045, { phase: rng() * TAU });
    mode(buf, sr, 0, 142 * jitter(rng, 0.05), 0.95, 0.024, { glide: 0.18, glideTau: 0.008 });
    mode(buf, sr, 0.001, 74 * jitter(rng, 0.05), 0.45, 0.035);
    noise(buf, sr, 0, 0.32, 0.0003, 0.011, rng, [['lp', 1400, 0.7]], 0.06); // felt brushing the pile
    // sand: a hiss plus discrete grains kicked up and settling
    noise(buf, sr, 0.001, 0.22 * sc + 0.04, 0.001, 0.035, rng, [['bp', 4800, 0.8]], 0.2);
    grains(buf, sr, rng, {
      count: Math.round(14 + 40 * sc), t0: 0.002, spread: 0.09 + 0.06 * sc, amp: 0.2,
      durMin: 0.0002, durMax: 0.0009, fMin: 3500, fMax: 9500, q: 2.5,
    });
  }
  fadeTail(buf, sr);
  return normalize(buf, 0.1 + 0.45 * s ** 0.8);
}

/** Tempered glass panel: bright "tonk" from the ball + ~140 Hz panel boom ringing ~250 ms. */
function genGlass(sr, rng, { speed = 10 } = {}) {
  const s = clamp(speed / 18, 0, 1.25);
  const sc = Math.min(1, s);
  const buf = new Float32Array(Math.ceil(sr * 0.6));
  const tc = (0.5 - 0.25 * sc) / 1000;
  noise(buf, sr, 0, 0.5 * sc + 0.1, 0.00003, 0.0005, rng, [['hp', 3000, 0.7]], 0.004);
  // ball pock against a rigid surface
  const fb = 1260 * jitter(rng, 0.04);
  mode(buf, sr, 0, fb, 0.75 * impactWeight(fb, tc), 0.0095, { glide: 0.05, phase: rng() * TAU });
  mode(buf, sr, 0, 2900 * jitter(rng, 0.04), 0.4 * sc * impactWeight(2900, tc), 0.005, { phase: rng() * TAU });
  // glass plate high modes: inharmonic, short, bright
  const glassModes = [[1870, 0.24, 0.034], [3160, 0.2, 0.026], [4730, 0.13, 0.018], [6920, 0.07, 0.011], [9050, 0.035, 0.007]];
  for (const [f, a, tau] of glassModes) mode(buf, sr, 0, f * jitter(rng, 0.02), a * (0.45 + 0.55 * sc), tau, { phase: rng() * TAU });
  // panel boom: low plate modes of a 2 x 3 m, 12 mm pane in its frame
  mode(buf, sr, 0, 140 * jitter(rng, 0.03), 0.95, 0.085, { attack: 0.0012, phase: rng() * TAU });
  mode(buf, sr, 0, 213 * jitter(rng, 0.03), 0.42, 0.062, { attack: 0.001, phase: rng() * TAU });
  mode(buf, sr, 0, 97 * jitter(rng, 0.03), 0.38 * (0.5 + 0.5 * sc), 0.1, { attack: 0.002 });
  mode(buf, sr, 0, 331 * jitter(rng, 0.03), 0.2, 0.04, { phase: rng() * TAU });
  // clamps buzzing faintly as the pane rings
  grains(buf, sr, rng, { count: 4 + Math.round(6 * sc), t0: 0.012, spread: 0.06, amp: 0.05 * sc, durMin: 0.001, durMax: 0.003, fMin: 1800, fMax: 3200, q: 5 });
  fadeTail(buf, sr, 0.03);
  return normalize(buf, 0.16 + 0.5 * s ** 0.8);
}

/**
 * Welded steel mesh panel: the ball is deadened (dull thud), the panel jangles (many jittered
 * micro-bursts from wire crossings and loose bolts, amplitude-modulated by the panel wobble)
 * and the steel rings with an inharmonic, bar-like clang.
 */
function genMesh(sr, rng, { speed = 10 } = {}) {
  const s = clamp(speed / 16, 0, 1.25);
  const sc = Math.min(1, s);
  const buf = new Float32Array(Math.ceil(sr * 0.85));
  mode(buf, sr, 0, 610 * jitter(rng, 0.05), 0.42, 0.008, { glide: 0.05, phase: rng() * TAU });
  mode(buf, sr, 0, 290 * jitter(rng, 0.05), 0.4, 0.018, { glide: 0.1 });
  mode(buf, sr, 0, 68 * jitter(rng, 0.05), 0.35, 0.08, { attack: 0.003 });
  // free-free bar ratios for the clang
  const f0 = 405 * jitter(rng, 0.06);
  const bar = [[1, 0.3, 0.2], [2.756, 0.27, 0.13], [5.404, 0.18, 0.085], [8.933, 0.11, 0.05], [13.34, 0.07, 0.03]];
  for (const [r, a, tau] of bar) mode(buf, sr, 0.001, f0 * r * jitter(rng, 0.01), a * (0.4 + 0.6 * sc), tau, { phase: rng() * TAU });
  const wobbleHz = 30 + 14 * rng();
  const spread = 0.2 + 0.35 * sc;
  grains(buf, sr, rng, {
    count: Math.round(45 + 140 * sc), t0: 0.001, spread, shape: 1.9, amp: 0.34, decay: 1.1,
    durMin: 0.0007, durMax: 0.0028, fMin: 1300, fMax: 6500, q: 5,
    am: (t) => 0.55 + 0.45 * Math.sin(TAU * wobbleHz * t),
  });
  noise(buf, sr, 0, 0.35 * sc + 0.1, 0.00005, 0.0008, rng, [['hp', 2500, 0.7]], 0.004);
  fadeTail(buf, sr, 0.04);
  return normalize(buf, 0.14 + 0.46 * s ** 0.8);
}

/** Ball into the net body: soft fabric rustle and a dull thump as the net bellies. */
function genNet(sr, rng, { speed = 8 } = {}) {
  const s = clamp(speed / 15, 0, 1.25);
  const sc = Math.min(1, s);
  const buf = new Float32Array(Math.ceil(sr * 0.5));
  mode(buf, sr, 0, 112 * jitter(rng, 0.05), 0.5, 0.05, { attack: 0.004 });
  mode(buf, sr, 0, 540 * jitter(rng, 0.05), 0.25, 0.012, { attack: 0.0008 });
  noise(buf, sr, 0, 0.35, 0.004, 0.06, rng, [['bp', 1500, 0.8]], 0.3);
  grains(buf, sr, rng, {
    count: Math.round(25 + 50 * sc), t0: 0.002, spread: 0.18 + 0.12 * sc, amp: 0.22, shape: 1.4,
    durMin: 0.002, durMax: 0.008, fMin: 800, fMax: 4200, q: 1.4,
  });
  fadeTail(buf, sr, 0.03);
  return normalize(buf, 0.1 + 0.32 * s ** 0.8);
}

/** Net cord: crisp tick on the tape, a little cable twang and tape rustle. */
function genCord(sr, rng) {
  const buf = new Float32Array(Math.ceil(sr * 0.4));
  noise(buf, sr, 0, 0.5, 0.00003, 0.0006, rng, [['hp', 3000, 0.7]], 0.004);
  mode(buf, sr, 0, 3900 * jitter(rng, 0.04), 0.35, 0.0025, { phase: rng() * TAU });
  mode(buf, sr, 0, 1020 * jitter(rng, 0.04), 0.45, 0.006, { glide: 0.04 });
  mode(buf, sr, 0.001, 182 * jitter(rng, 0.03), 0.28, 0.09, { attack: 0.002 });
  mode(buf, sr, 0.001, 523 * jitter(rng, 0.03), 0.12, 0.04);
  grains(buf, sr, rng, { count: 14, t0: 0.003, spread: 0.08, amp: 0.1, durMin: 0.002, durMax: 0.006, fMin: 1200, fMax: 4000, q: 1.5 });
  fadeTail(buf, sr, 0.03);
  return normalize(buf, 0.42);
}

/**
 * Pneumatic ball machine: solenoid valve click, a punch of compressed air (low thump with a
 * falling pitch plus a band-passed air burst sweeping down), then the ball popping out.
 */
function genMachine(sr, rng) {
  const buf = new Float32Array(Math.ceil(sr * 0.55));
  mode(buf, sr, 0, 2240 * jitter(rng, 0.03), 0.3, 0.004, { phase: rng() * TAU });
  noise(buf, sr, 0, 0.25, 0.00005, 0.001, rng, [['hp', 2000, 0.7]], 0.006);
  mode(buf, sr, 0.004, 52, 1.0, 0.07, { glide: 0.9, glideTau: 0.022, attack: 0.0015 });
  mode(buf, sr, 0.004, 128, 0.35, 0.035, { glide: 0.5, glideTau: 0.015 });
  // air burst: band-pass swept from ~2 kHz down to ~450 Hz
  const start = Math.round(0.004 * sr);
  const n = Math.min(buf.length - start, Math.round(0.32 * sr));
  const bp = new Biquad('bp', 2000, 1.1, sr);
  const lp = new Biquad('lp', 5000, 0.7, sr);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    if ((i & 31) === 0) bp.set('bp', 450 + 1600 * Math.exp(-t / 0.045), 1.1, sr);
    const env = (1 - Math.exp(-t / 0.003)) * Math.exp(-t / 0.055);
    buf[start + i] += lp.process(bp.process(rng() * 2 - 1)) * env * 0.9;
  }
  // the ball leaves the barrel
  mode(buf, sr, 0.016, 880 * jitter(rng, 0.04), 0.3, 0.009, { glide: 0.04 });
  mode(buf, sr, 0.03, 61, 0.2, 0.05, { attack: 0.004 });
  fadeTail(buf, sr, 0.04);
  return normalize(buf, 0.5);
}

/** A trainer on sand-dressed turf: heel thud, gritty grains crunching, a short slide scuff. */
function genFootstep(sr, rng, { speed = 2 } = {}) {
  const s = clamp(speed / 6, 0, 1.2);
  const sc = Math.min(1, s);
  const buf = new Float32Array(Math.ceil(sr * 0.32));
  mode(buf, sr, 0, 72 * jitter(rng, 0.08), 0.55, 0.028, { attack: 0.0025 });
  mode(buf, sr, 0, 165 * jitter(rng, 0.08), 0.22, 0.016, { attack: 0.0015 });
  const slide = 0.035 + 0.11 * sc * rng();
  noise(buf, sr, 0.004, 0.13 + 0.2 * sc, 0.008, slide, rng, [['bp', 2300 * jitter(rng, 0.2), 0.7], ['hp', 600, 0.7]], slide * 4);
  grains(buf, sr, rng, {
    count: Math.round(26 + 70 * sc), t0: 0.002, spread: 0.05 + 0.12 * sc, shape: 1.2, amp: 0.28,
    durMin: 0.00012, durMax: 0.0006, fMin: 2500, fMax: 10000, q: 2,
  });
  fadeTail(buf, sr, 0.02);
  return normalize(buf, 0.04 + 0.09 * s);
}

// --------------------------------------------------------------------------------------
// Stereo generators: crowd cheer, ambience beds, hall impulse response, UI.
// --------------------------------------------------------------------------------------

/** Crowd swell for big points: shouts, a noisy roar, applause and, when big, a whistle. */
function genCheer(sr, rng, { level = 1 } = {}) {
  const lv = clamp(level, 0, 1);
  const dur = 2.4 + 2.8 * lv;
  const len = Math.ceil(sr * dur);
  const L = new Float32Array(len), R = new Float32Array(len);
  const decay = 0.7 + 1.5 * lv;
  const swell = (t) => (1 - Math.exp(-t / 0.12)) * Math.exp(-Math.max(0, t - 0.45) / decay);
  // shouts
  const voices = Math.round(8 + 22 * lv);
  for (let v = 0; v < voices; v++) {
    const female = rng() < 0.4;
    const base = (female ? 250 : 150) * jitter(rng, 0.18) * (1 + 0.15 * lv);
    const t0 = rng() * 0.25;
    const vd = 0.5 + rng() * (0.8 + 1.4 * lv);
    const vow = VOWELS[[0, 7, 1, 3][Math.floor(rng() * 4)]];
    const fs = female ? 1.15 : 1;
    const vib = 4.5 + 2 * rng();
    voice(L, R, sr, rng, {
      t0, dur: vd, pan: rng() * 1.8 - 0.9, breath: 0.25 + 0.3 * rng(), amp: 0.5 + 0.5 * rng(),
      f0At: (t) => base * (1 + 0.18 * Math.sin(Math.min(1, t / vd) * Math.PI)) * (1 + 0.02 * Math.sin(TAU * vib * t)),
      envAt: (t) => (1 - Math.exp(-t / 0.05)) * Math.max(0, 1 - t / vd) ** 0.7,
      vowelAt: () => [vow[0] * fs, vow[1] * fs],
    });
  }
  // roar bed: noise through vowel-ish formants
  const fa = new Biquad('bp', 760, 2.2, sr), fb = new Biquad('bp', 1250, 3, sr);
  const fc = new Biquad('bp', 760, 2.2, sr), fd = new Biquad('bp', 1250, 3, sr);
  for (let i = 0; i < len; i++) {
    const e = swell(i / sr) * 0.55;
    L[i] += (fa.process(rng() * 2 - 1) + 0.6 * fb.process(rng() * 2 - 1)) * e;
    R[i] += (fc.process(rng() * 2 - 1) + 0.6 * fd.process(rng() * 2 - 1)) * e;
  }
  // applause: a Poisson stream of hand claps that rises a little after the shout
  const clapRate = 35 + 170 * lv;
  const clapEnv = (t) => (1 - Math.exp(-Math.max(0, t - 0.15) / 0.25)) * Math.exp(-Math.max(0, t - 0.9) / (decay * 1.2));
  const mono = new Float32Array(Math.ceil(sr * 0.012));
  for (let t = 0.1; t < dur - 0.05; t += -Math.log(1 - rng() * 0.999) / clapRate) {
    const e = clapEnv(t);
    if (e < 0.02) continue;
    mono.fill(0);
    noise(mono, sr, 0, 1, 0.0002, 0.0025 + 0.002 * rng(), rng, [['bp', 900 + 1500 * rng(), 1.3 + rng()]], 0.012);
    const [gl, gr] = panGains(rng() * 1.9 - 0.95);
    const a = e * (0.25 + 0.75 * rng()) * 0.55;
    const st = Math.round(t * sr);
    for (let i = 0; i < mono.length && st + i < len; i++) {
      L[st + i] += mono[i] * a * gl;
      R[st + i] += mono[i] * a * gr;
    }
  }
  // a whistle for the big ones
  if (lv > 0.65) {
    const t0 = 0.3 + 0.3 * rng();
    const f = 2700 + 500 * rng();
    const st = Math.round(t0 * sr);
    const n = Math.round(0.55 * sr);
    let ph = 0;
    const [gl, gr] = panGains(rng() * 1.2 - 0.6);
    for (let i = 0; i < n && st + i < len; i++) {
      const t = i / sr;
      ph += (f * (1 + 0.06 * Math.sin(Math.min(1, t / 0.55) * Math.PI) + 0.004 * Math.sin(TAU * 25 * t))) / sr;
      const e = Math.min(1, t / 0.03) * Math.min(1, (0.55 - t) / 0.08) * 0.12;
      const y = Math.sin(TAU * ph) * e;
      L[st + i] += y * gl;
      R[st + i] += y * gr;
    }
  }
  for (const ch of [L, R]) {
    lowpass1(ch, sr, 7000);
    fadeTail(ch, sr, 0.2);
  }
  const peak = Math.max(peakOf(L), peakOf(R));
  const k = (0.14 + 0.14 * lv) / Math.max(peak, 1e-9);
  for (let i = 0; i < len; i++) {
    L[i] *= k;
    R[i] *= k;
  }
  return [L, R];
}

/** HVAC: brown-noise rumble, airflow hiss, faint 50 Hz mains hum, slow breathing. Seamless loop. */
function genHvac(sr, rng, seconds = 12) {
  return seamless(sr, seconds, 1.5, (L, R) => {
    for (const [ch, phase] of [[L, 0], [R, 1.7]]) {
      const lp = new Biquad('lp', 190, 0.7, sr);
      const air = new Biquad('bp', 650, 0.6, sr);
      const hiss = new Biquad('hp', 2500, 0.7, sr);
      let brown = 0;
      for (let i = 0; i < ch.length; i++) {
        const t = i / sr;
        const w = rng() * 2 - 1;
        brown = brown * 0.995 + w * 0.06;
        const breathe = 1 + 0.12 * Math.sin(TAU * 0.071 * t + phase) + 0.06 * Math.sin(TAU * 0.23 * t);
        const hum = 0.018 * Math.sin(TAU * 50 * t) + 0.03 * Math.sin(TAU * 100 * t + phase) + 0.01 * Math.sin(TAU * 150 * t);
        ch[i] = (lp.process(brown) * 1.6 + air.process(w) * 0.07 + hiss.process(w) * 0.012) * breathe + hum;
      }
    }
    const k = 0.15 / Math.max(peakOf(L), peakOf(R), 1e-9);
    for (let i = 0; i < L.length; i++) {
      L[i] *= k;
      R[i] *= k;
    }
  });
}

/** Faint club chatter: a handful of distant talkers built from formant-filtered noise and voicing. */
function genChatter(sr, rng, seconds = 16, talkers = 6) {
  return seamless(sr, seconds, 1.2, (L, R) => {
    const total = L.length / sr;
    for (let k = 0; k < talkers; k++) {
      const female = rng() < 0.45;
      const base = (female ? 205 : 118) * jitter(rng, 0.12);
      const fs = female ? 1.14 : 1;
      const pan = rng() * 1.8 - 0.9;
      const gain = 0.35 + 0.65 * rng();
      let t = rng() * 1.5;
      while (t < total) {
        const phrase = 1.2 + rng() * 2.8;
        const syll = [];
        for (let u = 0; u < phrase;) {
          const d = 0.09 + rng() * 0.17;
          syll.push({ s: u, d, v: VOWELS[Math.floor(rng() * VOWELS.length)] });
          u += d + (rng() < 0.15 ? 0.08 + rng() * 0.12 : 0.01);
        }
        const syllAt = (tt) => {
          for (let i = syll.length - 1; i >= 0; i--) if (tt >= syll[i].s) return syll[i];
          return syll[0];
        };
        voice(L, R, sr, rng, {
          t0: t, dur: phrase + 0.2, pan, breath: 0.55, amp: gain,
          f0At: (tt) => base * (1.12 - 0.22 * (tt / phrase)) * (1 + 0.06 * Math.sin(TAU * 2.1 * tt)),
          envAt: (tt) => {
            const sy = syllAt(tt);
            const u = (tt - sy.s) / sy.d;
            if (u < 0 || u > 1.25) return 0;
            return Math.sin(Math.PI * Math.min(1, u / 1.0)) ** 1.5 * (1 - 0.3 * (tt / phrase));
          },
          vowelAt: (tt) => {
            const v = syllAt(tt).v;
            return [v[0] * fs, v[1] * fs];
          },
        });
        t += phrase + 0.4 + rng() * 2.5;
      }
    }
    for (const ch of [L, R]) lowpass1(ch, sr, 2200);
    const k = 0.12 / Math.max(peakOf(L), peakOf(R), 1e-9);
    for (let i = 0; i < L.length; i++) {
      L[i] *= k;
      R[i] *= k;
    }
  });
}

/**
 * Hall impulse response (stereo): 12 ms pre-delay, sparse early reflections, then a diffuse
 * tail with frequency-dependent decay (lows ~1.6 s, mids rt60, highs ~0.8 s). Normalized to
 * unit energy so a send gain directly sets the wet level.
 */
function genImpulse(sr, rng, rt60 = 1.4) {
  const len = Math.ceil(sr * (rt60 + 0.15));
  const out = [];
  for (let c = 0; c < 2; c++) {
    const ch = new Float32Array(len);
    const lpF = new Biquad('lp', 420, 0.7, sr);
    const hpF = new Biquad('hp', 3800, 0.7, sr);
    const pre = 0.012;
    const kL = -6.91 / (rt60 * 1.15), kM = -6.91 / rt60, kH = -6.91 / (rt60 * 0.55);
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const w = rng() * 2 - 1;
      const lo = lpF.process(w), hi = hpF.process(w), mid = w - lo - hi;
      const td = Math.max(0, t - pre);
      const onset = t < pre ? 0 : Math.min(1, td / 0.03);
      ch[i] = (lo * Math.exp(kL * td) + mid * Math.exp(kM * td) + hi * 0.8 * Math.exp(kH * td)) * onset;
    }
    // early reflections: floor, nearby glass, ceiling trusses
    for (let r = 0; r < 14; r++) {
      const t = 0.005 + rng() * 0.065;
      const i = Math.round(t * sr);
      const a = (0.9 - t * 9) * (rng() < 0.5 ? -1 : 1) * (0.5 + 0.5 * rng());
      for (let k = 0; k < 4 && i + k < len; k++) ch[i + k] += a * [0.5, 1, 0.6, 0.25][k];
    }
    let energy = 0;
    for (let i = 0; i < len; i++) energy += ch[i] * ch[i];
    const g = 1 / Math.sqrt(energy || 1);
    for (let i = 0; i < len; i++) ch[i] *= g;
    out.push(ch);
  }
  return out;
}

/** Interface sounds: soft, warm plucks that sit on top of the court without being harsh. */
function genUi(sr, rng, { kind = 'click' } = {}) {
  const buf = new Float32Array(Math.ceil(sr * 0.6));
  const pluck = (t, f, a, tau = 0.09) => {
    mode(buf, sr, t, f, a, tau, { attack: 0.002 });
    mode(buf, sr, t, f * 2, a * 0.28, tau * 0.5, { attack: 0.002 });
    mode(buf, sr, t, f * 3.01, a * 0.08, tau * 0.3, { attack: 0.002 });
  };
  switch (kind) {
    case 'hover':
      mode(buf, sr, 0, 1850, 0.5, 0.012, { attack: 0.001 });
      return normalize(fadeTail(buf, sr), 0.08);
    case 'tick':
    case 'countdown':
      mode(buf, sr, 0, 1000, 1, 0.035, { attack: 0.0006 });
      mode(buf, sr, 0, 2780, 0.4, 0.012, { attack: 0.0006 });
      return normalize(fadeTail(buf, sr), 0.22);
    case 'go':
      pluck(0, 1318.5, 1, 0.22);
      pluck(0, 1975.5, 0.6, 0.2);
      return normalize(fadeTail(buf, sr), 0.26);
    case 'confirm':
    case 'start':
      pluck(0, 659.3, 1);
      pluck(0.06, 880, 0.9);
      pluck(0.12, 1318.5, 0.8, 0.16);
      return normalize(fadeTail(buf, sr), 0.24);
    case 'back':
      pluck(0, 880, 0.9);
      pluck(0.07, 587.3, 1);
      return normalize(fadeTail(buf, sr), 0.2);
    case 'error':
      for (const t of [0, 0.11]) {
        mode(buf, sr, t, 196, 1, 0.06, { attack: 0.002 });
        mode(buf, sr, t, 588, 0.33, 0.04, { attack: 0.002 });
      }
      return normalize(fadeTail(buf, sr), 0.24);
    case 'success':
    case 'star':
      [784, 987.8, 1174.7, 1568].forEach((f, i) => pluck(i * 0.07, f, 1 - i * 0.1, 0.2));
      noise(buf, sr, 0.2, 0.05, 0.02, 0.15, rng, [['hp', 6000, 0.7]], 0.35);
      return normalize(fadeTail(buf, sr), 0.24);
    case 'pause':
      pluck(0, 523.3, 1, 0.12);
      pluck(0.08, 392, 0.9, 0.14);
      return normalize(fadeTail(buf, sr), 0.2);
    case 'select':
    case 'click':
    default:
      mode(buf, sr, 0, 1240, 1, 0.03, { attack: 0.0008 });
      mode(buf, sr, 0, 2480, 0.3, 0.01, { attack: 0.0008 });
      noise(buf, sr, 0, 0.2, 0.0001, 0.001, rng, [['hp', 3000, 0.7]], 0.004);
      return normalize(fadeTail(buf, sr), kind === 'select' ? 0.2 : 0.16);
  }
}

/** Pure synthesis entry points (also used by dev/audio-test.mjs under Node). */
export const synth = {
  racket: genRacket,
  bounce: genBounce,
  glass: genGlass,
  mesh: genMesh,
  net: genNet,
  cord: genCord,
  machine: genMachine,
  footstep: genFootstep,
  cheer: genCheer,
  ui: genUi,
  hvac: genHvac,
  chatter: genChatter,
  impulse: genImpulse,
  lowpass1,
  // Round 4 (venueSynth.js)
  pock: genPock,
  glassPane: genGlassPane,
  whoosh: genWhoosh,
};
export { venueSynth, glassPanelAt };

// --------------------------------------------------------------------------------------
// WebAudio engine
// --------------------------------------------------------------------------------------

const NOOP_AUDIO = Object.freeze({
  available: false,
  unlocked: false,
  context: null,
  unlock: () => Promise.resolve(false),
  setListener() {},
  racket() {},
  bounce() {},
  wall() {},
  net() {},
  cord() {},
  machine() {},
  footstep() {},
  cheer() {},
  ui() {},
  ambience() {},
  setVolume() {},
  setVenue() {},
  swing() {},
  crowd() {},
  duck() {},
  venue: null,
  bindBus: () => () => {},
  dispose() {},
});

const setParam = (param, value, ctx, smooth = 0) => {
  if (!param) return;
  if (smooth > 0 && ctx) param.setTargetAtTime(value, ctx.currentTime, smooth);
  else param.value = value;
};

const finite = (v) => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);

/**
 * Pock of a player's stroke by swing effort (round 6, "would be cool if swing speed made an impact"):
 * gain x (0.7 + 0.6 effort); above 0.8 the racket speed fed to the synth rises (brighter, higher
 * crack). effort null (AI shots, unknown): unchanged. Returns { speed, gain }.
 */
export function effortPock(speed, effort) {
  if (!Number.isFinite(effort)) return { speed, gain: 1 };
  const e = clamp(effort, 0, 1);
  return { speed: e > 0.8 ? speed * (1 + 0.75 * (e - 0.8)) + 4 * (e - 0.8) : speed, gain: 0.7 + 0.6 * e };
}

/** Crowd bus gain per unit of the crowd volume setting (0.7 -> 0.8, the level the venues were mixed at). */
export const CROWD_TRIM = 0.8 / 0.7;

/**
 * Creates the audio engine. createAudio() with no arguments targets a realtime AudioContext
 * created lazily by unlock(). Pass { context } to render into an existing (e.g. Offline)
 * context, { seed } for deterministic variation.
 */
export function createAudio(opts = {}) {
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!opts.context && !AC) return NOOP_AUDIO;

  let ctx = opts.context || null;
  const offline = !!(ctx && typeof ctx.startRendering === 'function');
  const rng = createRng(opts.seed ?? ((Date.now() ^ 0x5bd1e995) >>> 0));
  // crowd: the crowd bus (reactions, arena murmur), settings.volumes.crowd (default 0.7 -> gain 0.8).
  const vol = { master: 0.9, sfx: 1, ambience: 0.35, crowd: 0.7 };
  const crowdGain = () => vol.crowd * CROWD_TRIM;
  const listener = { pos: { x: 0, y: 1.64, z: 8 }, fwd: { x: 0, y: 0, z: -1 }, up: { x: 0, y: 1, z: 0 } };
  const active = [];
  let n = null; // graph nodes
  let wantAmbience = false;
  let amb = null;
  let disposed = false;
  const cheerCache = new Map();
  let prewarmed = false;
  let venue = venueMeta(opts.venue || 'club');
  const crowdCache = new Map(); // kind -> [[L, R], ...] variants
  let crowdBed = null; // { gains: GainNode[], level }
  let duckAmt = 0;
  let liveWhoosh = null;
  let noiseBuf = null;

  const running = () => n && !disposed && (offline || ctx.state === 'running');

  function build() {
    const out = ctx.createDynamicsCompressor();
    out.threshold.value = -9;
    out.knee.value = 6;
    out.ratio.value = 10;
    out.attack.value = 0.002;
    out.release.value = 0.18;
    out.connect(ctx.destination);
    const master = ctx.createGain();
    master.gain.value = vol.master;
    master.connect(out);
    const sfx = ctx.createGain();
    sfx.gain.value = vol.sfx;
    sfx.connect(master);
    const ui = ctx.createGain();
    ui.gain.value = vol.sfx;
    ui.connect(master);
    const ambBus = ctx.createGain();
    ambBus.gain.value = vol.ambience;
    ambBus.connect(master);
    // Crowd bus: reactions and the arena murmur (ducked under speech with the ambience).
    const crowdBus = ctx.createGain();
    crowdBus.gain.value = crowdGain();
    crowdBus.connect(master);
    const wet = ctx.createGain();
    wet.gain.value = 1;
    wet.connect(master);
    const verb = makeVerb(venue.acoustics);
    verb.connect(wet);
    const sfxVerb = ctx.createGain();
    sfxVerb.gain.value = vol.sfx;
    sfxVerb.connect(verb);
    const ambVerb = ctx.createGain();
    ambVerb.gain.value = vol.ambience;
    ambVerb.connect(verb);
    n = { out, master, sfx, ui, ambBus, crowdBus, verb, wet, sfxVerb, ambVerb };
    applyListener();
  }

  /** Convolver with the venue's impulse response (club hall, arena, open air). */
  function makeVerb(ac) {
    const verb = ctx.createConvolver();
    verb.normalize = false;
    const [irL, irR] = genVenueIR(ctx.sampleRate, createRng(7), ac);
    const ir = ctx.createBuffer(2, irL.length, ctx.sampleRate);
    ir.getChannelData(0).set(irL);
    ir.getChannelData(1).set(irR);
    verb.buffer = ir;
    return verb;
  }

  /** Reverb send scale for the venue (the sends were tuned for the club's 15 % wet hall). */
  const wetScale = () => (venue.acoustics.wet ?? 0.15) / 0.15;

  function applyListener() {
    if (!ctx) return;
    const l = ctx.listener;
    const { pos: p, fwd: f, up: u } = listener;
    if (l.positionX) {
      l.positionX.value = p.x;
      l.positionY.value = p.y;
      l.positionZ.value = p.z;
      l.forwardX.value = f.x;
      l.forwardY.value = f.y;
      l.forwardZ.value = f.z;
      l.upX.value = u.x;
      l.upY.value = u.y;
      l.upZ.value = u.z;
    } else if (l.setPosition) {
      l.setPosition(p.x, p.y, p.z);
      l.setOrientation(f.x, f.y, f.z, u.x, u.y, u.z);
    }
  }

  function makePanner(pos, refDistance = 1.2) {
    const p = ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = refDistance;
    p.maxDistance = 120;
    p.rolloffFactor = 1;
    if (p.positionX) {
      p.positionX.value = pos.x;
      p.positionY.value = pos.y;
      p.positionZ.value = pos.z;
    } else p.setPosition(pos.x, pos.y, pos.z);
    return p;
  }

  const distanceTo = (pos) => Math.hypot(pos.x - listener.pos.x, pos.y - listener.pos.y, pos.z - listener.pos.z);

  /**
   * Plays mono (Float32Array) or stereo ([L, R]) samples. With pos: HRTF-panned with sound
   * propagation delay and air absorption. o: { gain, reverb, bus: 'sfx'|'ui'|'amb', when, occlusion }
   */
  function play(data, pos, o = {}) {
    if (!running()) return;
    const stereo = Array.isArray(data);
    const chans = stereo ? data : [data];
    const sr = ctx.sampleRate;
    let when = o.when ?? ctx.currentTime;
    if (pos) {
      const d = distanceTo(pos);
      when += Math.min(0.15, d / SPEED_OF_SOUND);
      // air absorption + occlusion (neighbouring courts sit behind glass and nets)
      const fc = Math.min(18000, 22000 / (1 + d / 22)) * (o.occlusion ? 0.22 : 1);
      if (fc < sr * 0.4) for (const ch of chans) lowpass1(ch, sr, fc);
    }
    const buffer = ctx.createBuffer(chans.length, chans[0].length, sr);
    chans.forEach((ch, i) => buffer.getChannelData(i).set(ch));
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const g = ctx.createGain();
    g.gain.value = o.gain ?? 1;
    src.connect(g);
    const bus = o.bus === 'ui' ? n.ui : o.bus === 'amb' ? n.ambBus : o.bus === 'crowd' ? n.crowdBus : n.sfx;
    const nodes = [src, g];
    if (pos && finite(pos)) {
      const p = makePanner(pos, o.refDistance ?? 1.2);
      g.connect(p);
      p.connect(bus);
      nodes.push(p);
    } else g.connect(bus);
    const sendGain = (o.reverb ?? 0.2) * (o.bus === 'ui' ? 1 : wetScale());
    if (sendGain > 0) {
      const send = ctx.createGain();
      send.gain.value = sendGain;
      g.connect(send);
      send.connect(o.bus === 'amb' || o.bus === 'crowd' ? n.ambVerb : n.sfxVerb);
      nodes.push(send);
    }
    const voiceRec = { src, nodes, end: when + buffer.duration };
    src.onended = () => {
      for (const node of nodes) node.disconnect();
      const i = active.indexOf(voiceRec);
      if (i >= 0) active.splice(i, 1);
    };
    active.push(voiceRec);
    if (active.length > MAX_VOICES) {
      const old = active.shift();
      try {
        old.src.stop();
      } catch {
        /* already stopped */
      }
    }
    src.start(Math.max(when, ctx.currentTime), o.offset || 0);
  }

  const posOf = (pos) => (pos && finite(pos) ? pos : null);

  // ---- ambience ------------------------------------------------------------------------

  const yieldIdle = () => new Promise((r) => setTimeout(r, 0));

  async function buildAmbienceBeds() {
    const sr = ctx.sampleRate;
    const r = createRng(rng.int(1, 1e9));
    const hvac = genHvac(sr, r, 12);
    // Chatter is built one talker at a time so a realtime page never stalls for long.
    const secs = offline ? Math.min(16, ctx.length / sr + 2) : 16;
    let chatter = null;
    for (let k = 0; k < 6; k++) {
      if (!offline) await yieldIdle();
      const part = genChatter(sr, r, secs, 1);
      const g = 0.35 + 0.65 * r();
      if (!chatter) chatter = [new Float32Array(part[0].length), new Float32Array(part[1].length)];
      for (let c = 0; c < 2; c++) for (let i = 0; i < part[c].length; i++) chatter[c][i] += part[c][i] * g;
    }
    const k = 0.12 / Math.max(peakOf(chatter[0]), peakOf(chatter[1]), 1e-9);
    for (const ch of chatter) for (let i = 0; i < ch.length; i++) ch[i] *= k;
    return { hvac, chatter };
  }

  function startLoop(chans, gain, reverb, { pos = null, bus = null } = {}) {
    const buffer = ctx.createBuffer(2, chans[0].length, ctx.sampleRate);
    buffer.getChannelData(0).set(chans[0]);
    buffer.getChannelData(1).set(chans[1]);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + (offline ? 0.3 : 2.5));
    src.connect(g);
    let out = g;
    if (pos) {
      const p = makePanner(pos);
      p.panningModel = 'equalpower';
      p.refDistance = 8;
      g.connect(p);
      out = p;
    }
    out.connect(bus || n.ambBus);
    const send = ctx.createGain();
    send.gain.value = reverb * wetScale();
    g.connect(send);
    send.connect(n.ambVerb);
    src.start(t, rng() * buffer.duration * 0.9);
    return { src, g, send, gain };
  }

  /** Mono noise loop for the live whoosh (built once). */
  function whiteNoise() {
    if (noiseBuf) return noiseBuf;
    const len = ctx.sampleRate;
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    const r = createRng(99);
    for (let i = 0; i < len; i++) d[i] = r() * 2 - 1;
    return noiseBuf;
  }

  // ---- open air (sunset): birds ----------------------------------------------------------

  function createBirds() {
    let next = ctx.currentTime + 1 + rng() * 3;
    function scheduleUntil(tEnd) {
      while (next < tEnd) {
        const k = rng();
        const kind = k < 0.45 ? 'swift' : k < 0.75 ? 'gull' : 'sparrow';
        const a = rng() * Math.PI * 2;
        const r = kind === 'sparrow' ? 10 + rng() * 6 : 18 + rng() * 30;
        const pos = { x: Math.cos(a) * r, y: kind === 'sparrow' ? 6 + rng() * 4 : 12 + rng() * 22, z: Math.sin(a) * r - 6 };
        play(genBird(ctx.sampleRate, rng, { kind }), pos, { when: next, gain: kind === 'gull' ? 0.9 : 0.7, reverb: 0.05, bus: 'amb' });
        next += 2 + rng() * (kind === 'swift' ? 5 : 8);
      }
    }
    return { scheduleUntil };
  }

  /** Neighbouring courts at x = ±13: rallies of pock - bounce - (glass) - pock, then a pause. */
  function createNeighbours(xs = [-13, 13]) {
    const courts = xs.map((x, i) => ({ x, next: ctx.currentTime + 1 + rng() * 4 + i * 2, end: 1, left: 0 }));
    function scheduleUntil(tEnd) {
      for (const c of courts) {
        while (c.next < tEnd) {
          if (c.left <= 0) {
            c.left = rng.int(3, 14);
            c.end = rng() < 0.5 ? 1 : -1;
          }
          const t = c.next;
          const zHit = c.end * (6.5 + rng() * 3);
          const hitPos = { x: c.x + (rng() - 0.5) * 6, y: 0.7 + rng() * 0.7, z: zHit };
          play(genPock(ctx.sampleRate, rng, { speed: 12 + rng() * 14, quality: 0.6 + 0.4 * rng() }), hitPos,
            { when: t, gain: 0.85, reverb: 0.5, occlusion: true, bus: 'amb' });
          const bounceT = t + 0.6 + rng() * 0.25;
          const bz = -c.end * (5 + rng() * 4);
          play(genBounce(ctx.sampleRate, rng, { surface: 'turf', speed: 5 + rng() * 5 }), { x: c.x + (rng() - 0.5) * 7, y: 0, z: bz },
            { when: bounceT, gain: 0.8, reverb: 0.5, occlusion: true, bus: 'amb' });
          if (rng() < 0.3) {
            const gp = { x: c.x + (rng() - 0.5) * 8, y: 0.6 + rng() * 1.2, z: -c.end * 10 };
            play(genGlassPane(ctx.sampleRate, rng, { speed: 5 + rng() * 6, panel: glassPanelAt(gp) }), gp,
              { when: bounceT + 0.35, gain: 0.8, reverb: 0.55, occlusion: true, bus: 'amb' });
          }
          c.left--;
          c.end = -c.end;
          c.next = c.left > 0 ? t + 1.1 + rng() * 0.5 : t + 4 + rng() * 9;
        }
      }
    }
    return { scheduleUntil };
  }

  async function startAmbience() {
    if (amb || !n) return;
    amb = { loops: [], timer: null, pending: true, kind: venue.ambience };
    const mine = amb;
    const schedulers = [];
    const sr = ctx.sampleRate;
    const r = createRng(rng.int(1, 1e9));
    if (venue.ambience === 'sunset') {
      // Open air: the sea below the cliff, the breeze in the palms, birds, the court next door.
      const secs = offline ? Math.min(24, ctx.length / sr + 2) : 24;
      const sea = genSea(sr, r, { seconds: secs });
      if (!offline) await yieldIdle();
      const breeze = genBreeze(sr, r, { seconds: Math.min(secs, 20) });
      if (amb !== mine || disposed) return;
      amb.loops.push(startLoop(sea, 0.75, 0, { pos: { x: -6, y: -4, z: -40 } }));
      amb.loops.push(startLoop(breeze, 0.6, 0));
      schedulers.push(createBirds(), createNeighbours([13]));
    } else if (venue.ambience === 'stadium') {
      // Arena: the crowd murmur from the stands (spatial), the building's low hum.
      const hvac = genHvac(sr, r, offline ? Math.min(12, ctx.length / sr + 2) : 12);
      const beds = [];
      const nBeds = offline ? 2 : 3;
      for (let k = 0; k < nBeds; k++) {
        if (!offline) await yieldIdle();
        beds.push(genCrowdBed(sr, r, { seconds: offline ? Math.min(14, ctx.length / sr + 2) : 14, talkers: offline ? 6 : 12 }));
      }
      if (amb !== mine || disposed) return;
      amb.loops.push(startLoop(hvac, 0.35, 0.05));
      const src = venue.crowd.sources;
      const gains = [];
      src.forEach((p, i) => {
        const l = startLoop(beds[i % beds.length], 0.55 * venue.crowd.bed, 0.4, { pos: p, bus: n.crowdBus });
        amb.loops.push(l);
        gains.push(l);
      });
      crowdBed = { loops: gains, level: 1 };
    } else {
      const beds = await buildAmbienceBeds();
      if (amb !== mine || disposed) return;
      amb.loops.push(startLoop(beds.hvac, 0.55, 0.05));
      amb.loops.push(startLoop(beds.chatter, 0.5, 0.7));
      schedulers.push(createNeighbours());
    }
    amb.pending = false;
    if (offline) for (const s2 of schedulers) s2.scheduleUntil(ctx.length / ctx.sampleRate);
    else if (schedulers.length) {
      for (const s2 of schedulers) s2.scheduleUntil(ctx.currentTime + 1);
      amb.timer = setInterval(() => running() && schedulers.forEach((s2) => s2.scheduleUntil(ctx.currentTime + 1)), 250);
    }
  }

  function stopAmbience() {
    if (!amb) return;
    const a = amb;
    amb = null;
    crowdBed = null;
    if (a.timer) clearInterval(a.timer);
    const t = ctx.currentTime;
    for (const l of a.loops) {
      l.g.gain.cancelScheduledValues(t);
      l.g.gain.setTargetAtTime(0, t, 0.4);
      try {
        l.src.stop(t + 2);
      } catch {
        /* ignore */
      }
    }
  }

  /** Generates one more crowd variant for a level bucket (1..3) off the hot path. */
  function warmCheer(key) {
    if (disposed || !ctx) return;
    const list = cheerCache.get(key) || [];
    if (list.length >= 2) return;
    list.push(genCheer(ctx.sampleRate, rng, { level: key / 3 }));
    cheerCache.set(key, list);
  }

  function prewarm() {
    if (offline || prewarmed) return;
    prewarmed = true;
    [3, 2, 1, 3].forEach((key, i) => setTimeout(() => warmCheer(key), 2500 + i * 1200));
    prewarmCrowd(4000);
  }

  // ---- crowd reactions ---------------------------------------------------------------------

  /** Crowd size by venue level: people heard in a reaction (a few club members .. a full arena). */
  const crowdPeople = () => Math.round(6 + 60 * venue.crowd.level);

  /** Generates one stereo variant of a reaction kind. */
  function makeCrowd(kind) {
    const sr = ctx.sampleRate;
    const lv = venue.crowd.level;
    const voices = Math.round(4 + 26 * lv);
    switch (kind) {
      case 'applause': return genApplause(sr, rng, { level: 0.6 + 0.4 * lv, people: crowdPeople(), dur: 2.6 + 1.6 * lv });
      case 'ooh': return genCrowdVowel(sr, rng, { kind: 'ooh', voices, dur: 1.5 });
      case 'aah': return genCrowdVowel(sr, rng, { kind: 'aah', voices, dur: 1.6 });
      case 'groan': return genCrowdVowel(sr, rng, { kind: 'groan', voices, dur: 1.5 });
      case 'cheer': return genCheer(sr, rng, { level: 0.35 + 0.4 * lv });
      case 'roar': return genCheer(sr, rng, { level: 0.6 + 0.4 * lv });
      default: return null;
    }
  }

  function crowdVariant(kind, { generate = true } = {}) {
    const key = `${venue.id}:${kind}`;
    const list = crowdCache.get(key) || [];
    if (!list.length && generate) {
      const v = makeCrowd(kind);
      if (v) list.push(v);
      crowdCache.set(key, list);
    }
    return list.length ? list[Math.floor(rng() * list.length)] : null;
  }

  /** Builds two variants of every reaction for this venue off the hot path (idle timeouts). */
  function prewarmCrowd(delay = 500) {
    if (offline || !ctx) return;
    const v = venue.id;
    const kinds = ['applause', 'ooh', 'groan', 'cheer', 'roar', 'aah', 'applause', 'ooh', 'cheer', 'groan'];
    kinds.forEach((kind, i) => setTimeout(() => {
      if (disposed || venue.id !== v) return;
      const key = `${v}:${kind}`;
      const list = crowdCache.get(key) || [];
      if (list.length >= 2) return;
      const x = makeCrowd(kind);
      if (x) list.push(x);
      crowdCache.set(key, list);
    }, delay + i * 700));
  }

  // ---- public API ------------------------------------------------------------------------

  const api = {
    available: true,
    get unlocked() {
      return !!running();
    },
    get context() {
      return ctx;
    },

    /** Call from a user gesture. Creates/resumes the context and builds the graph. */
    async unlock() {
      if (disposed) return false;
      try {
        if (!ctx) ctx = new AC({ latencyHint: 'interactive' });
        if (!n) build();
        if (!offline && ctx.state !== 'running') {
          // Safari/iOS: a silent buffer started inside the gesture unlocks output.
          const b = ctx.createBuffer(1, 1, ctx.sampleRate);
          const s = ctx.createBufferSource();
          s.buffer = b;
          s.connect(ctx.destination);
          s.start();
          await ctx.resume();
        }
        if (wantAmbience) startAmbience();
        prewarm();
        return !!running();
      } catch (err) {
        if (opts.debug) console.warn('audio unlock failed', err);
        return false;
      }
    },

    /** Listener = the player's eye (court frame). forward/up need not be normalized. */
    setListener(pos, forward, up) {
      if (pos && finite(pos)) Object.assign(listener.pos, { x: pos.x, y: pos.y, z: pos.z });
      if (forward && finite(forward)) Object.assign(listener.fwd, { x: forward.x, y: forward.y, z: forward.z });
      if (up && finite(up)) Object.assign(listener.up, { x: up.x, y: up.y, z: up.z });
      if (n) applyListener();
    },

    /** Ball off the racket. speed: racket (sweet-spot) speed m/s; quality 0..1; offCenter 0..1 optional. */
    racket(pos, { speed = 15, quality = 1, offCenter = null, effort = null } = {}) {
      if (!running()) return;
      // Round 6 (swing power): the pock follows the swing's effort (game/timingProfile.js, 0..1):
      // gain x (0.7 + 0.6 effort), a brighter crack on a full swing (effortPock).
      const p = effortPock(speed, effort);
      play(genPock(ctx.sampleRate, rng, { speed: p.speed, quality, offCenter }), posOf(pos), { reverb: 0.2, gain: p.gain });
    },

    /** Floor bounce. surface: 'turf' | 'outsideFloor' | 'ceiling'. speed: normal impact speed m/s. */
    bounce(pos, surface = 'turf', speed = 6) {
      if (!running() || !(speed > 0.35)) return;
      play(genBounce(ctx.sampleRate, rng, { surface, speed }), posOf(pos), { reverb: 0.2 });
    },

    /** Wall hit. surface: 'glass' | 'mesh'. speed: normal impact speed m/s. */
    wall(pos, surface = 'glass', speed = 10) {
      if (!running() || !(speed > 0.3)) return;
      const p = posOf(pos);
      const data = surface === 'mesh'
        ? genMesh(ctx.sampleRate, rng, { speed })
        : genGlassPane(ctx.sampleRate, rng, { speed, panel: p ? glassPanelAt(p) : null });
      play(data, p, { reverb: 0.24 });
    },

    net(pos, speed = 8) {
      if (!running()) return;
      play(genNet(ctx.sampleRate, rng, { speed }), posOf(pos), { reverb: 0.15 });
    },

    cord(pos) {
      if (!running()) return;
      play(genCord(ctx.sampleRate, rng), posOf(pos), { reverb: 0.18 });
    },

    machine(pos) {
      if (!running()) return;
      play(genMachine(ctx.sampleRate, rng), posOf(pos), { reverb: 0.25 });
    },

    /** Player footstep at the feet; speed m/s scales grit and slide. */
    footstep(pos, speed = 2) {
      if (!running()) return;
      play(genFootstep(ctx.sampleRate, rng, { speed }), posOf(pos), { reverb: 0.08 });
    },

    /** Crowd swell for big points, level 0..1. In a venue with a crowd it comes from the stands. */
    cheer(level = 1) {
      if (!running()) return;
      if (venue.id !== 'club') {
        api.crowd(level >= 0.8 ? 'roar' : 'cheer', level);
        return;
      }
      const lv = clamp(level, 0, 1);
      const key = Math.max(1, Math.round(lv * 3));
      const cached = cheerCache.get(key) || [];
      let data;
      if (cached.length) data = cached[Math.floor(rng() * cached.length)];
      else {
        data = genCheer(ctx.sampleRate, rng, { level: key / 3 });
        cached.push(data);
        cheerCache.set(key, cached);
      }
      if (cached.length < 2 && !offline) setTimeout(() => warmCheer(key), 400);
      play([data[0].slice(), data[1].slice()], null, { reverb: 0.35, gain: 1 });
    },

    /** UI feedback: 'click'|'hover'|'select'|'confirm'|'start'|'back'|'error'|'tick'|'countdown'|'go'|'success'|'star'|'pause'. */
    ui(kind = 'click') {
      if (!running()) return;
      play(genUi(ctx.sampleRate, rng, { kind }), null, { bus: 'ui', reverb: 0.05, gain: 0.55 });
    },

    /**
     * Racket whoosh from the tracker's 'player:swing' { t, phase: 'start'|'peak'|'end', speed (m/s),
     * pos }. 'start' opens a live band-passed noise voice at the racket that rises with the swing,
     * 'peak' sets its loudness and pitch from the speed (smash: lower and bigger) and lets it sweep
     * down (the face passing the ear), 'end' closes it. A lone 'peak' plays a pre-rendered whoosh.
     */
    swing(evt = {}) {
      if (!running() || !evt) return;
      const phase = evt.phase || 'peak';
      const speed = Number.isFinite(evt.speed) ? evt.speed : 12;
      const pos = posOf(evt.pos) || { x: listener.pos.x + 0.35, y: listener.pos.y - 0.4, z: listener.pos.z - 0.3 };
      const smash = speed > 17 && pos.y > listener.pos.y + 0.1;
      const t = ctx.currentTime;
      const f0 = (smash ? 260 : 330) + Math.min(40, speed) * (smash ? 34 : 42);
      // Live voice: band-passed white noise sits ~8 dB under the pre-rendered whoosh at equal gain.
      const amp = Math.min(0.5, (0.03 + 0.42 * Math.max(0, (speed - 4) / 22) ** 1.6) * (smash ? 1.25 : 1));
      if (phase === 'start') {
        if (liveWhoosh) liveWhoosh.stop(t);
        const src = ctx.createBufferSource();
        src.buffer = whiteNoise();
        src.loop = true;
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.Q.value = 1.2;
        bp.frequency.setValueAtTime(f0 * 0.55, t);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(amp * 0.25, t + 0.09);
        const p = makePanner(pos);
        src.connect(bp).connect(g).connect(p).connect(n.sfx);
        src.start(t, rng() * 0.9);
        const rec = {
          src, bp, g, p, peaked: false, f0,
          stop(at) {
            try {
              g.gain.cancelScheduledValues(at);
              g.gain.setTargetAtTime(0, at, 0.02);
              src.stop(at + 0.15);
            } catch { /* already stopped */ }
          },
        };
        src.onended = () => {
          for (const x of [src, bp, g, p]) x.disconnect();
          if (liveWhoosh === rec) liveWhoosh = null;
        };
        // Safety: a swing that never peaks fades out.
        g.gain.setTargetAtTime(0, t + 0.6, 0.06);
        src.stop(t + 1.0);
        liveWhoosh = rec;
        return;
      }
      if (phase === 'peak') {
        const w = liveWhoosh;
        if (w && !w.peaked) {
          w.peaked = true;
          const f = w.bp.frequency, g = w.g.gain;
          f.cancelScheduledValues(t);
          f.setValueAtTime(f.value, t);
          f.linearRampToValueAtTime(f0 * 1.25, t + 0.02);
          f.setTargetAtTime(f0 * 0.6, t + 0.03, 0.06);
          g.cancelScheduledValues(t);
          g.setValueAtTime(g.value, t);
          g.linearRampToValueAtTime(amp, t + 0.02);
          g.setTargetAtTime(0, t + 0.04, smash ? 0.09 : 0.06);
          try { w.src.stop(t + 0.6); } catch { /* ignore */ }
          return;
        }
        // No live voice: the pre-rendered whoosh, started so its loudest point lands now.
        play(genWhoosh(ctx.sampleRate, rng, { speed, smash }), pos, { reverb: 0.06, offset: (smash ? 0.11 : WHOOSH_PEAK_S) * 0.7 });
        return;
      }
      if (phase === 'end' && liveWhoosh && !liveWhoosh.peaked) liveWhoosh.stop(t);
    },

    /**
     * Crowd reaction, heard from the venue's stands (venue.crowd.sources), scaled by the venue's
     * crowd level: 'applause' | 'cheer' | 'roar' | 'ooh' | 'aah' | 'groan'; 'hush' quiets the arena
     * murmur before a serve, 'murmur' brings it back. level 0..1.
     */
    crowd(kind, level = 1) {
      if (!running()) return;
      const lv = clamp(level, 0, 1);
      if (kind === 'hush' || kind === 'murmur') {
        const target = kind === 'hush' ? 0.35 : 1;
        if (crowdBed) {
          crowdBed.level = target;
          for (const l of crowdBed.loops) l.g.gain.setTargetAtTime(l.gain * target, ctx.currentTime, kind === 'hush' ? 0.5 : 1.2);
        }
        return;
      }
      const data = crowdVariant(kind, { generate: offline || venue.crowd.level < 0.5 });
      if (!data) {
        if (!offline) prewarmCrowd(50);
        return;
      }
      const vol = lv * (0.35 + 0.65 * venue.crowd.level);
      const src = venue.crowd.sources;
      const nSrc = Math.max(1, Math.min(src.length, Math.round(1 + lv * src.length)));
      const start = Math.floor(rng() * src.length);
      for (let i = 0; i < nSrc; i++) {
        const p = src[(start + i) % src.length];
        const v = i === 0 ? data : crowdVariant(kind, { generate: false }) || data;
        // A stand is a large distributed source: it does not fall off like a point.
        play([v[0].slice(), v[1].slice()], p, {
          bus: 'crowd', gain: (vol * 1.4) / Math.sqrt(nSrc), reverb: 0.35, when: ctx.currentTime + rng() * 0.12, offset: rng() * 0.05,
          refDistance: 9,
        });
      }
    },

    /** Lowers the crowd and ambience under speech (0 = none, 1 = full duck). */
    duck(amount = 1) {
      duckAmt = clamp(Number(amount) || 0, 0, 1);
      if (!n) return;
      const k = 1 - 0.5 * duckAmt;
      setParam(n.ambBus.gain, vol.ambience * k, ctx, 0.08);
      setParam(n.crowdBus.gain, crowdGain() * k, ctx, 0.08);
    },

    /** The venue's acoustics and ambience (metadata from src/render/venues/meta.js, or an id). */
    setVenue(meta) {
      const next = typeof meta === 'string' ? venueMeta(meta) : meta && meta.acoustics ? meta : venueMeta('club');
      if (next.id === venue.id && n) return;
      venue = next;
      if (!n) return;
      // Swap the reverb (crossfade), the ambience bed and prewarm this venue's crowd.
      const t = ctx.currentTime;
      const old = n.verb;
      const verb = makeVerb(venue.acoustics);
      const newWet = ctx.createGain();
      newWet.gain.setValueAtTime(0, t);
      newWet.gain.linearRampToValueAtTime(1, t + 0.4);
      verb.connect(newWet);
      newWet.connect(n.master);
      n.sfxVerb.connect(verb);
      n.ambVerb.connect(verb);
      n.wet.gain.setTargetAtTime(0, t, 0.1);
      const oldWet = n.wet;
      setTimeout(() => {
        try {
          n.sfxVerb.disconnect(old);
          n.ambVerb.disconnect(old);
          old.disconnect();
          oldWet.disconnect();
        } catch { /* ignore */ }
      }, offline ? 0 : 900);
      n.verb = verb;
      n.wet = newWet;
      if (amb) {
        stopAmbience();
        if (wantAmbience) startAmbience();
      }
      prewarmCrowd(600);
    },

    /** The current venue metadata. */
    get venue() {
      return venue;
    },

    /** Indoor-club bed: HVAC, faint chatter and rallies on the neighbouring courts. */
    ambience(on = true) {
      wantAmbience = !!on;
      if (!n) return Promise.resolve();
      if (on) return startAmbience();
      stopAmbience();
      return Promise.resolve();
    },

    /** Linear gains 0..1 (any subset): master, sfx, ambience, crowd. */
    setVolume({ master, sfx, ambience, crowd } = {}) {
      if (Number.isFinite(master)) vol.master = clamp(master, 0, 1.5);
      if (Number.isFinite(sfx)) vol.sfx = clamp(sfx, 0, 1.5);
      if (Number.isFinite(ambience)) vol.ambience = clamp(ambience, 0, 1.5);
      if (Number.isFinite(crowd)) vol.crowd = clamp(crowd, 0, 1.5);
      if (!n) return;
      setParam(n.master.gain, vol.master, ctx, 0.05);
      setParam(n.sfx.gain, vol.sfx, ctx, 0.05);
      setParam(n.ui.gain, vol.sfx, ctx, 0.05);
      setParam(n.sfxVerb.gain, vol.sfx, ctx, 0.05);
      setParam(n.ambBus.gain, vol.ambience * (1 - 0.5 * duckAmt), ctx, 0.05);
      setParam(n.crowdBus.gain, crowdGain() * (1 - 0.5 * duckAmt), ctx, 0.05);
      setParam(n.ambVerb.gain, vol.ambience, ctx, 0.05);
    },

    /**
     * Convenience wiring to the world bus (SPEC §5.1 event names). Returns an unsubscribe fn.
     * o.cheer: map of rally:outcome reason -> cheer level (defaults: por-tres/por-cuatro 1).
     */
    bindBus(bus, o = {}) {
      const cheerFor = o.cheer || { 'por-tres': 1, 'por-cuatro': 1 };
      const evtOf = (p) => (p && p.evt) || p;
      const offs = [
        bus.on('ball:hit', ({ shot } = {}) => {
          if (!shot || !shot.contact) return;
          const speed = shot.racketSpeed ?? (shot.speedOut ? shot.speedOut * 0.55 : 15);
          // A player's stroke carries its effort (round 6: provisional strikes the predicted one).
          const effort = shot.by === 'player' && Number.isFinite(shot.effort) ? shot.effort : null;
          api.racket(shot.contact, { speed, quality: shot.quality ?? 1, offCenter: shot.offCenter ?? null, effort });
        }),
        bus.on('ball:bounce', (p) => {
          const e = evtOf(p);
          if (e && e.pos) api.bounce(e.pos, e.surface || 'turf', e.impactSpeed ?? 5);
        }),
        bus.on('ball:wall', (p) => {
          const e = evtOf(p);
          if (e && e.pos) api.wall(e.pos, e.surface || 'glass', e.impactSpeed ?? 8);
        }),
        bus.on('ball:net', (p) => {
          const e = evtOf(p);
          if (e && e.pos) api.net(e.pos, e.impactSpeed ?? 6);
        }),
        bus.on('ball:netcord', (p) => {
          const e = evtOf(p);
          if (e && e.pos) api.cord(e.pos);
        }),
        bus.on('ball:ceiling', (p) => {
          const e = evtOf(p);
          if (e && e.pos) api.bounce(e.pos, 'ceiling', e.impactSpeed ?? 6);
        }),
        bus.on('ball:launch', ({ ball, by } = {}) => {
          if (by === 'machine' && ball) api.machine(ball.pos);
        }),
        bus.on('player:step', ({ pos, speed } = {}) => {
          if (pos) api.footstep(pos, speed ?? 2);
        }),
        bus.on('player:swing', (e) => api.swing(e)),
        bus.on('rally:outcome', ({ reason } = {}) => {
          const lv = cheerFor[reason];
          if (lv) api.cheer(lv);
        }),
      ];
      return () => offs.forEach((off) => off && off());
    },

    dispose() {
      stopAmbience();
      if (liveWhoosh && ctx) liveWhoosh.stop(ctx.currentTime);
      disposed = true;
      for (const v of active.splice(0)) {
        try {
          v.src.stop();
        } catch {
          /* ignore */
        }
      }
      if (ctx && !offline && !opts.context && ctx.close) ctx.close().catch(() => {});
    },
  };
  return api;
}
