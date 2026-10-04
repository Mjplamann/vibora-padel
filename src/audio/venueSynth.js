// Round-4 synthesis (pure: Float32Array in / out, no browser globals, runs under Node):
//  - the padel racket "pock" (EVA foam core, sweet spot vs frame),
//  - glass panes with their own plate resonances (size, impact point, mounting),
//  - the swing whoosh (racket face through the air, Doppler-ish sweep, smash "whoomp"),
//  - crowd reactions (applause, "ooh", "aah", groan, bed murmur),
//  - open-air ambience (sea, breeze in the palms, gulls, swifts, sparrows),
//  - venue impulse responses (club hall, arena, open air).
import { clamp, createRng } from '../util/math.js';
import { COURT } from '../config.js';
import {
  TAU, Biquad, mode, noise, grains, lowpass1, normalize, fadeTail, impactWeight, jitter, panGains, voice, peakOf, seamless, VOWELS,
} from './dsp.js';

const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

// --------------------------------------------------------------------------------------
// Racket
// --------------------------------------------------------------------------------------

/**
 * Padel racket "pock": a solid perforated face of carbon / glass-fibre skins over an EVA foam
 * core. The contact lasts ~1 ms (longer than strings), so the sound is a short, woody, hollow pop:
 * the pressurised ball's cavity and the damped face modes (two close modes beat: the hollow
 * colour), a felt click, a body thump felt in the hand. On the frame or the heart the face modes
 * die, the carbon tube "clacks" bright and the handle stings (a buzzing low mode and rattle).
 */
export function genPock(sr, rng, { speed = 15, quality = 1, offCenter = null } = {}) {
  const s = clamp(speed / 28, 0, 1.25);
  const sc = Math.min(1, s);
  const off = offCenter != null ? clamp(offCenter, 0, 1) : clamp(1 - quality, 0, 1);
  const frame = smooth(0.5, 0.95, off);
  const buf = new Float32Array(Math.ceil(sr * 0.22));
  const tc = (0.95 - 0.45 * sc + 0.35 * off) / 1000;
  const w = (f) => impactWeight(f, tc);
  const bright = (0.35 + 0.65 * sc) * (1 - 0.45 * off);
  noise(buf, sr, 0, 0.42 * bright + 0.1, 0.00003, 0.00035 + 0.0004 * off, rng, [['hp', 1800 + 2200 * sc, 0.7]], 0.003);
  const fh = 470 * jitter(rng, 0.04) * (1 - 0.08 * off);
  mode(buf, sr, 0, fh, 0.95 * w(fh) * (1 - 0.4 * frame), 0.0078 * (1 - 0.35 * frame), { glide: 0.09, glideTau: 0.004, phase: rng() * TAU });
  mode(buf, sr, 0, fh * 1.07, 0.45 * w(fh) * (1 - 0.4 * frame), 0.0062, { glide: 0.08, phase: rng() * TAU });
  const f1 = 980 * jitter(rng, 0.03);
  mode(buf, sr, 0, f1, 0.75 * w(f1) * (1 - 0.6 * frame), 0.009, { glide: 0.04, phase: rng() * TAU });
  const f2 = 1720 * jitter(rng, 0.03);
  mode(buf, sr, 0, f2, 0.42 * w(f2) * bright, 0.0055, { phase: rng() * TAU });
  const f3 = 2950 * jitter(rng, 0.03);
  mode(buf, sr, 0, f3, 0.22 * w(f3) * bright * sc, 0.0032, { phase: rng() * TAU });
  mode(buf, sr, 0.0004, 175 * jitter(rng, 0.05), 0.26 * (0.6 + 0.8 * off), 0.014 + 0.02 * frame, { attack: 0.0008 });
  if (off > 0.05) {
    mode(buf, sr, 0, 2450 * jitter(rng, 0.05), 0.55 * off, 0.012, { phase: rng() * TAU });
    mode(buf, sr, 0, 3870 * jitter(rng, 0.05), 0.35 * off, 0.008, { phase: rng() * TAU });
    mode(buf, sr, 0, 610 * jitter(rng, 0.05), 0.4 * off, 0.02, { phase: rng() * TAU });
    noise(buf, sr, 0, 0.35 * off, 0.00002, 0.0006, rng, [['hp', 3000, 0.7]], 0.004);
    mode(buf, sr, 0.001, 140 * jitter(rng, 0.05), 0.25 * frame, 0.045, { attack: 0.002 });
    grains(buf, sr, rng, { count: Math.round(6 + 14 * frame), t0: 0.002, spread: 0.03, amp: 0.12 * frame, durMin: 0.0005, durMax: 0.002, fMin: 900, fMax: 2600, q: 3 });
  }
  fadeTail(buf, sr, 0.008);
  return normalize(buf, 0.15 + 0.35 * s ** 0.85);
}

// --------------------------------------------------------------------------------------
// Glass
// --------------------------------------------------------------------------------------

/** Bending-wave constant (π/2)·sqrt(D / ρh) for 12 mm toughened glass (E 70 GPa, ρ 2500, ν 0.22). */
export const GLASS_PLATE_C = 29.5;

/**
 * The glass pane hit at court position pos (neighbouring courts folded onto the main one):
 * { wall, a (width m), b (height m), x0, y0 (impact point in the pane, m), id }.
 */
export function glassPanelAt(pos) {
  let x = pos.x;
  const z = pos.z;
  if (Math.abs(x) > 8) x -= Math.sign(x) * 13;
  const hw = COURT.halfWidth, hl = COURT.halfLength;
  const dBack = hl - Math.abs(z), dSide = hw - Math.abs(x);
  const y0 = clamp(pos.y, 0.02, 2.98);
  if (dBack <= dSide) {
    const i = clamp(Math.floor((x + hw) / 2), 0, 4);
    return { wall: 'back', a: 2, b: 3, x0: clamp(x + hw - i * 2, 0.02, 1.98), y0, id: (z > 0 ? 0 : 10) + i };
  }
  const az = Math.abs(z);
  const b = az >= 8 ? COURT.backWall.glassTop : 2;
  const i = clamp(Math.floor((z + hl) / 2), 0, 9);
  return { wall: 'side', a: 2, b, x0: clamp(z + hl - i * 2, 0.02, 1.98), y0: Math.min(y0, b - 0.02), id: 20 + (x > 0 ? 10 : 0) + i };
}

/** Plate modes of a pane excited at (x0, y0): [{ f, amp, tau }], deterministic per pane id. */
export function paneModes(panel, { fMin = 70, fMax = 1400, max = 48 } = {}) {
  const { a, b, x0, y0, id = 0 } = panel;
  const r = createRng(1000 + id * 7919);
  const out = [];
  for (let m = 1; m <= 12; m++) {
    for (let n = 1; n <= 12; n++) {
      const f = GLASS_PLATE_C * ((m / a) ** 2 + (n / b) ** 2) * (1 + (r() - 0.5) * 0.06);
      if (f < fMin || f > fMax) continue;
      const shape = Math.abs(Math.sin((m * Math.PI * x0) / a) * Math.sin((n * Math.PI * y0) / b));
      out.push({ f, amp: shape * Math.sqrt(100 / f), tau: clamp(0.3 * (110 / f) ** 0.6, 0.025, 0.3) });
    }
  }
  out.sort((p, q) => q.amp - p.amp);
  return out.slice(0, max);
}

/**
 * Toughened glass pane: the ball's bright "tonk" (contact transient, the ball pock against a
 * rigid wall, short high plate modes) plus the pane's own low "thunk": its bending modes for its
 * size and the impact point (a hit near a fixing is deader and clanks on the clamp).
 */
export function genGlassPane(sr, rng, { speed = 10, panel = null } = {}) {
  const P = panel || { a: 2, b: 3, x0: 1, y0: 1.2, id: 0 };
  const s = clamp(speed / 18, 0, 1.25);
  const sc = Math.min(1, s);
  const buf = new Float32Array(Math.ceil(sr * 0.65));
  const tc = (0.5 - 0.25 * sc) / 1000;
  noise(buf, sr, 0, 0.5 * sc + 0.1, 0.00003, 0.0005, rng, [['hp', 3000, 0.7]], 0.004);
  const fb = 1260 * jitter(rng, 0.04);
  mode(buf, sr, 0, fb, 0.75 * impactWeight(fb, tc), 0.0095, { glide: 0.05, phase: rng() * TAU });
  mode(buf, sr, 0, 2900 * jitter(rng, 0.04), 0.4 * sc * impactWeight(2900, tc), 0.005, { phase: rng() * TAU });
  for (const [f, a, tau] of [[1870, 0.2, 0.03], [3160, 0.17, 0.024], [4730, 0.11, 0.016], [6920, 0.06, 0.01]]) {
    mode(buf, sr, 0, f * jitter(rng, 0.02), a * (0.45 + 0.55 * sc), tau, { phase: rng() * TAU });
  }
  // The pane's own bending modes.
  const modes = paneModes(P);
  let sum = 0;
  for (const m of modes) sum += m.amp;
  const k = 1.6 / Math.max(sum, 1e-6);
  for (const m of modes) mode(buf, sr, 0.0008, m.f, m.amp * k * (0.55 + 0.45 * sc), m.tau, { attack: 0.0012, phase: rng() * TAU });
  // Edge hit: the clamps clank, the pane barely rings.
  const edge = Math.min(P.x0, P.a - P.x0, P.y0, P.b - P.y0);
  if (edge < 0.18) {
    const e = 1 - edge / 0.18;
    mode(buf, sr, 0, 1180 * jitter(rng, 0.05), 0.3 * e, 0.012, { phase: rng() * TAU });
    mode(buf, sr, 0, 3420 * jitter(rng, 0.05), 0.18 * e, 0.008, { phase: rng() * TAU });
  }
  grains(buf, sr, rng, { count: 3 + Math.round(5 * sc), t0: 0.012, spread: 0.06, amp: 0.04 * sc, durMin: 0.001, durMax: 0.003, fMin: 1800, fMax: 3200, q: 5 });
  fadeTail(buf, sr, 0.03);
  return normalize(buf, 0.16 + 0.5 * s ** 0.8);
}

// --------------------------------------------------------------------------------------
// Swing whoosh
// --------------------------------------------------------------------------------------

/**
 * The racket face cutting the air: band-passed noise whose centre rises as the racket approaches
 * peak speed and falls after it (a Doppler-like sweep past the ear), loudness ~ v^2.5 (aero-
 * acoustic power grows ~v^5-6), a faint aeolian whistle from the face holes (Strouhal 0.2, 13 mm).
 * Smashes are longer and lower with a "whoomp" of displaced air. The loudest point is at
 * WHOOSH_PEAK_S (smash: 0.11 s) after the start of the buffer.
 */
export const WHOOSH_PEAK_S = 0.085;
export function genWhoosh(sr, rng, { speed = 15, smash = false } = {}) {
  const v = clamp(speed, 0, 40);
  const lv = clamp((v - 4) / 22, 0, 1.4);
  const dur = smash ? 0.42 : 0.3;
  const buf = new Float32Array(Math.ceil(sr * dur));
  const tp = smash ? 0.11 : WHOOSH_PEAK_S;
  const wUp = smash ? 0.07 : 0.055, wDn = smash ? 0.12 : 0.085;
  const f0 = (smash ? 260 : 330) + v * (smash ? 34 : 42);
  const bp1 = new Biquad('bp', f0, 1.3, sr), bp2 = new Biquad('bp', f0 * 2.3, 1.6, sr), lp = new Biquad('lp', 6000, 0.7, sr);
  let ph = 0;
  for (let i = 0; i < buf.length; i++) {
    const t = i / sr;
    const u = t - tp;
    const wdt = u < 0 ? wUp : wDn;
    const env = Math.exp(-(u * u) / (wdt * wdt));
    const dop = 1 + 0.32 * Math.tanh(-u / 0.04) * (smash ? 0.8 : 1);
    if ((i & 15) === 0) {
      bp1.set('bp', f0 * dop, 1.3, sr);
      bp2.set('bp', f0 * 2.3 * dop, 1.6, sr);
    }
    const n = rng() * 2 - 1;
    let y = bp1.process(n) + bp2.process(n) * 0.45;
    ph += (0.2 * v * dop) / 0.013 / sr;
    if (ph > 1) ph -= 1;
    y += Math.sin(TAU * ph) * 0.05 * lv;
    buf[i] = lp.process(y) * env;
  }
  if (smash) mode(buf, sr, tp - 0.035, 92, 0.3, 0.07, { attack: 0.03 });
  fadeTail(buf, sr, 0.03);
  return normalize(buf, 0.02 + 0.2 * lv ** 1.6);
}

// --------------------------------------------------------------------------------------
// Crowd
// --------------------------------------------------------------------------------------

/** Applause: a Poisson stream of hand claps from `people` clappers, spread across the stereo field. */
export function genApplause(sr, rng, { level = 1, dur = 3.4, people = 40 } = {}) {
  const lv = clamp(level, 0, 1);
  const len = Math.ceil(sr * dur);
  const L = new Float32Array(len), R = new Float32Array(len);
  const rate = people * (3.2 + 1.6 * lv);
  const env = (t) => smooth(0, 0.35, t) * Math.exp(-Math.max(0, t - dur * 0.45) / (dur * 0.28));
  const clap = new Float32Array(Math.ceil(sr * 0.014));
  for (let t = 0.02; t < dur - 0.03; t += -Math.log(1 - rng() * 0.999) / rate) {
    const e = env(t);
    if (e < 0.02) continue;
    clap.fill(0);
    noise(clap, sr, 0, 1, 0.0002, 0.0022 + 0.0022 * rng(), rng, [['bp', 800 + 1800 * rng(), 1.2 + rng()]], 0.014);
    const [gl, gr] = panGains(rng() * 1.9 - 0.95);
    const a = e * (0.3 + 0.7 * rng());
    const st = Math.round(t * sr);
    for (let i = 0; i < clap.length && st + i < len; i++) {
      L[st + i] += clap[i] * a * gl;
      R[st + i] += clap[i] * a * gr;
    }
  }
  return scaleStereo([L, R], 0.1 + 0.16 * lv);
}

const CROWD_VOWELS = { ooh: [310, 870], aah: [720, 1220], groan: [560, 900], cheer: [730, 1090] };

/**
 * Many voices on one vowel with a shared pitch contour: 'ooh' (rise then fall, a near miss or a
 * great retrieve), 'aah' (admiration, rising and held), 'groan' (falling, breathy: an error).
 */
export function genCrowdVowel(sr, rng, { kind = 'ooh', voices = 26, dur = 1.6, level = 1 } = {}) {
  const lv = clamp(level, 0, 1);
  const len = Math.ceil(sr * dur);
  const L = new Float32Array(len), R = new Float32Array(len);
  const vw = CROWD_VOWELS[kind] || CROWD_VOWELS.ooh;
  for (let v = 0; v < voices; v++) {
    const female = rng() < 0.45;
    const base = (female ? 230 : 135) * jitter(rng, 0.15);
    const fs = female ? 1.14 : 1;
    const t0 = rng() * 0.12;
    const vd = dur * (0.7 + 0.3 * rng()) - t0;
    const contour = kind === 'groan'
      ? (t) => 1.1 - 0.32 * smooth(0, vd, t)
      : kind === 'aah'
        ? (t) => 0.95 + 0.2 * smooth(0, 0.35, t)
        : (t) => 0.95 + 0.28 * smooth(0, 0.35, t) - 0.25 * smooth(0.4, vd, t);
    voice(L, R, sr, rng, {
      t0, dur: vd, pan: rng() * 1.8 - 0.9, breath: kind === 'groan' ? 0.55 : 0.35 + 0.2 * rng(), amp: 0.5 + 0.5 * rng(),
      f0At: (t) => base * contour(t) * (1 + 0.015 * Math.sin(TAU * 5.2 * t)),
      envAt: (t) => smooth(0, 0.18, t) * (1 - smooth(vd * 0.55, vd, t)),
      vowelAt: () => [vw[0] * fs, vw[1] * fs],
    });
  }
  // Body: a breathy noise bed on the same vowel.
  const fa = new Biquad('bp', vw[0], 2, sr), fb = new Biquad('bp', vw[1], 3, sr);
  const fc = new Biquad('bp', vw[0], 2, sr), fd = new Biquad('bp', vw[1], 3, sr);
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const e = smooth(0, 0.2, t) * (1 - smooth(dur * 0.5, dur, t)) * 0.35;
    L[i] += (fa.process(rng() * 2 - 1) + 0.5 * fb.process(rng() * 2 - 1)) * e;
    R[i] += (fc.process(rng() * 2 - 1) + 0.5 * fd.process(rng() * 2 - 1)) * e;
  }
  for (const ch of [L, R]) {
    lowpass1(ch, sr, 5000);
    fadeTail(ch, sr, 0.1);
  }
  return scaleStereo([L, R], 0.1 + 0.14 * lv);
}

/** Crowd murmur between points (seamless loop): many distant talkers and a low room rumble. */
export function genCrowdBed(sr, rng, { seconds = 14, talkers = 16 } = {}) {
  return seamless(sr, seconds, 1.2, (L, R) => {
    const total = L.length / sr;
    for (let k = 0; k < talkers; k++) {
      const female = rng() < 0.45;
      const base = (female ? 210 : 120) * jitter(rng, 0.14);
      const fs = female ? 1.14 : 1;
      const pan = rng() * 1.8 - 0.9;
      const gain = 0.3 + 0.7 * rng();
      let t = rng() * 1.2;
      while (t < total) {
        const phrase = 0.8 + rng() * 2.2;
        const vw = VOWELS[Math.floor(rng() * VOWELS.length)];
        const sy = 0.12 + rng() * 0.1;
        voice(L, R, sr, rng, {
          t0: t, dur: phrase, pan, breath: 0.6, amp: gain,
          f0At: (tt) => base * (1.1 - 0.2 * (tt / phrase)),
          envAt: (tt) => Math.max(0, Math.sin(Math.PI * ((tt / sy) % 1))) ** 1.5 * (1 - 0.3 * (tt / phrase)),
          vowelAt: (tt) => [vw[0] * fs * (1 + 0.15 * Math.sin(tt * 9)), vw[1] * fs],
        });
        t += phrase + 0.2 + rng() * 1.4;
      }
    }
    const lp = [new Biquad('lp', 160, 0.7, sr), new Biquad('lp', 160, 0.7, sr)];
    [L, R].forEach((ch, c) => {
      for (let i = 0; i < ch.length; i++) ch[i] += lp[c].process(rng() * 2 - 1) * 0.25;
      lowpass1(ch, sr, 1900);
    });
    const k = 0.14 / Math.max(peakOf(L), peakOf(R), 1e-9);
    for (let i = 0; i < L.length; i++) {
      L[i] *= k;
      R[i] *= k;
    }
  });
}

// --------------------------------------------------------------------------------------
// Open-air ambience (sunset)
// --------------------------------------------------------------------------------------

/** Distant sea below the cliff: swells of low surf and the hiss of the wash (seamless loop). */
export function genSea(sr, rng, { seconds = 24 } = {}) {
  return seamless(sr, seconds, 2, (L, R) => {
    [L, R].forEach((ch, c) => {
      const lp = new Biquad('lp', 420, 0.7, sr), bp = new Biquad('bp', 1700, 0.55, sr), hp = new Biquad('hp', 60, 0.7, sr);
      let brown = 0;
      const ph = c * 1.3;
      for (let i = 0; i < ch.length; i++) {
        const t = i / sr;
        const w = rng() * 2 - 1;
        brown = brown * 0.996 + w * 0.05;
        const swell = 0.5 + 0.5 * Math.sin((TAU * t) / 9.3 + ph) * (0.6 + 0.4 * Math.sin((TAU * t) / 23.1));
        const wash = Math.max(0, Math.sin((TAU * (t - 0.9)) / 9.3 + ph)) ** 3;
        ch[i] = hp.process(lp.process(brown) * (0.45 + 0.55 * swell) * 2.2 + bp.process(w) * 0.09 * wash);
      }
    });
    const k = 0.16 / Math.max(peakOf(L), peakOf(R), 1e-9);
    for (let i = 0; i < L.length; i++) {
      L[i] *= k;
      R[i] *= k;
    }
  });
}

/** Evening breeze: gusty wind body and the dry rustle of palm fronds riding the gusts. */
export function genBreeze(sr, rng, { seconds = 20 } = {}) {
  return seamless(sr, seconds, 2, (L, R) => {
    const n = Math.ceil(seconds * 4) + 8;
    const knots = Array.from({ length: n }, () => 0.15 + 0.85 * rng() ** 1.6);
    const gust = (t) => {
      const x = t * 4;
      const i = Math.floor(x), f = x - i;
      const a = knots[i % n], b = knots[(i + 1) % n];
      return a + (b - a) * (f * f * (3 - 2 * f));
    };
    [L, R].forEach((ch) => {
      const bp = new Biquad('bp', 380, 0.5, sr), lp = new Biquad('lp', 900, 0.7, sr);
      for (let i = 0; i < ch.length; i++) {
        const t = i / sr;
        const g = gust(t);
        if ((i & 255) === 0) bp.set('bp', 250 + 380 * g, 0.5, sr);
        ch[i] = lp.process(bp.process(rng() * 2 - 1)) * g * 0.9;
      }
    });
    // Frond rustle: grains whose density follows the gusts.
    const total = L.length / sr;
    const tmp = new Float32Array(Math.ceil(sr * 0.02));
    for (let t = 0; t < total; t += 0.004 + rng() * 0.02 / (0.2 + gust(t))) {
      const g = gust(t);
      if (rng() > g) continue;
      tmp.fill(0);
      noise(tmp, sr, 0, 1, 0.0004, 0.002 + 0.003 * rng(), rng, [['bp', 2500 + 4000 * rng(), 1.5]], 0.02);
      const [gl, gr] = panGains(rng() * 1.6 - 0.8);
      const st = Math.round(t * sr), a = 0.12 * g * rng();
      for (let i = 0; i < tmp.length && st + i < L.length; i++) {
        L[st + i] += tmp[i] * a * gl;
        R[st + i] += tmp[i] * a * gr;
      }
    }
    const k = 0.12 / Math.max(peakOf(L), peakOf(R), 1e-9);
    for (let i = 0; i < L.length; i++) {
      L[i] *= k;
      R[i] *= k;
    }
  });
}

/**
 * A bird call (mono): 'gull' (a nasal falling "kee-ow", a few times), 'swift' (thin screaming
 * trills of a passing group), 'sparrow' (short chirps).
 */
export function genBird(sr, rng, { kind = 'gull' } = {}) {
  if (kind === 'swift') {
    const buf = new Float32Array(Math.ceil(sr * 1.6));
    const birds = 2 + Math.floor(rng() * 3);
    for (let b = 0; b < birds; b++) {
      const t0 = rng() * 0.5, d = 0.35 + rng() * 0.5, f = 5600 + rng() * 1800, trill = 30 + rng() * 25;
      const st = Math.round(t0 * sr), n = Math.round(d * sr);
      let ph = 0;
      for (let i = 0; i < n && st + i < buf.length; i++) {
        const t = i / sr;
        const dop = 1 + 0.06 * Math.tanh((d / 2 - t) / 0.08);
        ph += (f * dop * (1 + 0.05 * Math.sin(TAU * trill * t))) / sr;
        const e = Math.sin((Math.PI * t) / d) ** 2 * (0.6 + 0.4 * Math.sin(TAU * trill * t));
        buf[st + i] += Math.sin(TAU * ph) * e * 0.5;
      }
    }
    return normalize(fadeTail(buf, sr, 0.02), 0.08);
  }
  if (kind === 'sparrow') {
    const buf = new Float32Array(Math.ceil(sr * 1.0));
    const k = 3 + Math.floor(rng() * 4);
    for (let c = 0; c < k; c++) {
      const t0 = c * (0.11 + rng() * 0.05), d = 0.04 + rng() * 0.03, f0 = 3200 + rng() * 1500, f1 = f0 * (0.75 + rng() * 0.5);
      const st = Math.round(t0 * sr), n = Math.round(d * sr);
      let ph = 0;
      for (let i = 0; i < n && st + i < buf.length; i++) {
        const u = i / n;
        ph += (f0 + (f1 - f0) * u) / sr;
        buf[st + i] += Math.sin(TAU * ph) * Math.sin(Math.PI * u) * 0.6;
      }
    }
    return normalize(fadeTail(buf, sr, 0.02), 0.07);
  }
  // gull
  const buf = new Float32Array(Math.ceil(sr * 1.8));
  const calls = 2 + Math.floor(rng() * 3);
  const bp = new Biquad('bp', 1800, 1.2, sr);
  let t0 = 0;
  for (let c = 0; c < calls; c++) {
    const d = 0.28 + rng() * 0.12;
    const st = Math.round(t0 * sr), n = Math.round(d * sr);
    let ph = 0;
    for (let i = 0; i < n && st + i < buf.length; i++) {
      const u = i / n;
      const f = 1050 + 550 * Math.sin(Math.PI * Math.min(1, u * 1.6)) - 350 * u;
      ph += f / sr;
      const src = Math.sin(TAU * ph) + 0.55 * Math.sin(2 * TAU * ph) + 0.35 * Math.sin(3 * TAU * ph);
      const e = Math.sin(Math.PI * u) ** 0.7 * (0.75 + 0.25 * Math.sin(TAU * 42 * (i / sr)));
      buf[st + i] += bp.process(src) * e;
    }
    t0 += d + 0.08 + rng() * 0.12;
  }
  return normalize(fadeTail(buf, sr, 0.02), 0.09);
}

// --------------------------------------------------------------------------------------
// Venue impulse responses
// --------------------------------------------------------------------------------------

/**
 * Stereo impulse response for a venue's acoustics ({ kind, rt60, predelay, damp, early }):
 * 'hall' (the club: 1.4 s, glass and steel), 'arena' (2.3 s, big and dark), 'open' (no tail:
 * early reflections off the court's own glass and a faint slap from the clubhouse). Unit energy.
 */
export function genVenueIR(sr, rng, { kind = 'hall', rt60 = 1.4, predelay = 0.012, damp = 0.55, early = 0.7 } = {}) {
  const open = kind === 'open';
  const len = Math.ceil(sr * (rt60 + predelay + 0.12));
  const out = [];
  for (let c = 0; c < 2; c++) {
    const ch = new Float32Array(len);
    const lpF = new Biquad('lp', 420, 0.7, sr);
    const hpF = new Biquad('hp', 3800 * (1.4 - damp), 0.7, sr);
    const kL = -6.91 / (rt60 * (kind === 'arena' ? 1.3 : 1.15)), kM = -6.91 / rt60, kH = -6.91 / (rt60 * (1 - 0.6 * damp));
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const w = rng() * 2 - 1;
      const lo = lpF.process(w), hi = hpF.process(w), mid = w - lo - hi;
      const td = Math.max(0, t - predelay);
      const onset = t < predelay ? 0 : Math.min(1, td / (open ? 0.004 : 0.03));
      ch[i] = (lo * Math.exp(kL * td) + mid * Math.exp(kM * td) + hi * 0.8 * Math.exp(kH * td)) * onset * (open ? 0.35 : 1);
    }
    const nEarly = Math.round(6 + 16 * early);
    const span = open ? 0.035 : kind === 'arena' ? 0.11 : 0.07;
    for (let r = 0; r < nEarly; r++) {
      const t = 0.004 + rng() * span;
      const i = Math.round(t * sr);
      const a = (1 - t / (span * 1.3)) * (rng() < 0.5 ? -1 : 1) * (0.5 + 0.5 * rng()) * (open ? 1.3 : 1);
      for (let k = 0; k < 4 && i + k < len; k++) ch[i + k] += a * [0.5, 1, 0.6, 0.25][k];
    }
    if (open) {
      const i = Math.round((0.068 + 0.01 * c) * sr);
      for (let k = 0; k < 6 && i + k < len; k++) ch[i + k] += 0.35 * [0.3, 0.8, 1, 0.6, 0.3, 0.1][k];
    }
    let energy = 0;
    for (let i = 0; i < len; i++) energy += ch[i] * ch[i];
    const g = 1 / Math.sqrt(energy || 1);
    for (let i = 0; i < len; i++) ch[i] *= g;
    out.push(ch);
  }
  return out;
}

function scaleStereo([L, R], target) {
  const k = target / Math.max(peakOf(L), peakOf(R), 1e-9);
  for (let i = 0; i < L.length; i++) {
    L[i] *= k;
    R[i] *= k;
  }
  return [L, R];
}

/** Pure entry points (dev/audio-venues.html, tests). */
export const venueSynth = {
  pock: genPock,
  glassPane: genGlassPane,
  whoosh: genWhoosh,
  applause: genApplause,
  crowdVowel: genCrowdVowel,
  crowdBed: genCrowdBed,
  sea: genSea,
  breeze: genBreeze,
  bird: genBird,
  venueIR: genVenueIR,
};
