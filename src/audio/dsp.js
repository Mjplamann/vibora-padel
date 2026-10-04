// DSP kit shared by the audio engine and the venue synthesis (pure: Float32Array in / out, no
// browser globals). RBJ biquads, damped modes, enveloped noise, granular textures, a formant voice.
import { clamp } from '../util/math.js';

export const TAU = Math.PI * 2;
export const SPEED_OF_SOUND = 343;

// --------------------------------------------------------------------------------------
// DSP kit
// --------------------------------------------------------------------------------------

/** RBJ-cookbook biquad, transposed direct form II. */
export class Biquad {
  constructor(type, f, q, sr, gainDb = 0) {
    this.z1 = 0;
    this.z2 = 0;
    this.set(type, f, q, sr, gainDb);
  }

  set(type, f, q, sr, gainDb = 0) {
    const w = (TAU * clamp(f, 10, sr * 0.45)) / sr;
    const cw = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    let b0, b1, b2, a1, a2;
    let a0 = 1 + alpha;
    if (type === 'lp') {
      b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; a1 = -2 * cw; a2 = 1 - alpha;
    } else if (type === 'hp') {
      b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a1 = -2 * cw; a2 = 1 - alpha;
    } else if (type === 'bp') {
      b0 = alpha; b1 = 0; b2 = -alpha; a1 = -2 * cw; a2 = 1 - alpha;
    } else {
      const A = 10 ** (gainDb / 40);
      b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A;
      a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A;
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0;
    this.a1 = a1 / a0; this.a2 = a2 / a0;
    return this;
  }

  process(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

export const makeFilters = (specs, sr) => (specs || []).map(([type, f, q, g]) => new Biquad(type, f, q, sr, g));
export const runFilters = (fs, x) => {
  for (let k = 0; k < fs.length; k++) x = fs[k].process(x);
  return x;
};

/**
 * Adds a damped sinusoid (one vibration mode) to buf.
 * o: { glide: initial relative pitch excess (pitch falls to f), glideTau, attack, phase, pan }
 */
export function mode(buf, sr, t0, f, amp, tau, o = {}) {
  if (amp <= 0 || f >= sr * 0.48) return;
  const start = Math.max(0, Math.round(t0 * sr));
  const n = Math.min(buf.length - start, Math.ceil(tau * sr * 7));
  const dk = Math.exp(-1 / (tau * sr));
  const ga = Math.exp(-1 / ((o.glideTau ?? 0.012) * sr));
  const aa = Math.exp(-1 / ((o.attack ?? 0.00015) * sr));
  const w = (TAU * f) / sr;
  let e = amp, g = o.glide || 0, a = 1, ph = o.phase ?? 0;
  for (let i = 0; i < n; i++) {
    buf[start + i] += e * (1 - a) * Math.sin(ph);
    ph += w * (1 + g);
    e *= dk;
    g *= ga;
    a *= aa;
  }
}

/** Adds an enveloped, filtered noise burst: (1 - e^(-t/attack)) * e^(-t/tau), cut at dur. */
export function noise(buf, sr, t0, amp, attack, tau, rng, filters = null, dur = tau * 7) {
  if (amp <= 0) return;
  const start = Math.max(0, Math.round(t0 * sr));
  const n = Math.min(buf.length - start, Math.ceil(dur * sr));
  const fs = makeFilters(filters, sr);
  const dk = Math.exp(-1 / (tau * sr));
  const aa = Math.exp(-1 / (Math.max(attack, 1e-5) * sr));
  let e = amp, a = 1;
  const fade = Math.min(n, Math.ceil(0.002 * sr));
  for (let i = 0; i < n; i++) {
    let x = rng() * 2 - 1;
    x = runFilters(fs, x);
    const tail = i > n - fade ? (n - i) / fade : 1;
    buf[start + i] += x * e * (1 - a) * tail;
    e *= dk;
    a *= aa;
  }
}

/** Sparse granular texture (sand, mesh rattle, net rustle): many tiny filtered noise grains. */
export function grains(buf, sr, rng, { count, t0 = 0, spread, shape = 1.6, amp, durMin, durMax, fMin, fMax, q = 4, decay = 1.2, am = null }) {
  for (let g = 0; g < count; g++) {
    const u = rng() ** shape; // denser near the start
    const t = t0 + u * spread;
    const life = 1 - u;
    let a = amp * life ** decay * (0.25 + 0.75 * rng());
    if (am) a *= am(t);
    const f = fMin * (fMax / fMin) ** rng();
    const dur = durMin + (durMax - durMin) * rng();
    noise(buf, sr, t, a, dur * 0.08, dur * 0.35, rng, [['bp', f, q]], dur);
  }
}

/** One-pole low-pass over the whole buffer (air absorption / occlusion). */
export function lowpass1(buf, sr, fc) {
  if (fc >= sr * 0.45) return;
  const a = Math.exp((-TAU * fc) / sr);
  let y = 0;
  for (let i = 0; i < buf.length; i++) {
    y = buf[i] + a * (y - buf[i]);
    buf[i] = y;
  }
}

/** Scales the buffer so its peak equals target (keeps dynamics consistent per sound family). */
export function normalize(buf, target) {
  let peak = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = Math.abs(buf[i]);
    if (v > peak) peak = v;
  }
  if (peak > 1e-9) {
    const k = target / peak;
    for (let i = 0; i < buf.length; i++) buf[i] *= k;
  }
  return buf;
}

/** Short raised-cosine fade at the end so buffers never stop on a click. */
export function fadeTail(buf, sr, sec = 0.01) {
  const n = Math.min(buf.length, Math.ceil(sec * sr));
  for (let i = 0; i < n; i++) buf[buf.length - 1 - i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / n);
  return buf;
}

/** Excitation weight of mode frequency f for an impact with an effective pulse width tc (s). */
export const impactWeight = (f, tc) => 1 / Math.sqrt(1 + (f * tc * 2.2) ** 2);

export const jitter = (rng, amount) => 1 + (rng() - 0.5) * 2 * amount;

export const VOWELS = [
  [730, 1090], [530, 1840], [270, 2290], [570, 840], [300, 870], [660, 1720], [490, 1350], [640, 1190],
];

/** Equal-power pan of a mono signal sample into [L, R]. */
export const panGains = (p) => [Math.cos(((p + 1) * Math.PI) / 4), Math.sin(((p + 1) * Math.PI) / 4)];

/**
 * A single voice: naive sawtooth glottal source + breath noise through two formant
 * band-passes. Writes into L/R with a fixed pan. f0At(t) and envAt(t) shape intonation/loudness.
 */
export function voice(L, R, sr, rng, { t0, dur, pan, f0At, envAt, vowelAt, breath = 0.35, amp = 1 }) {
  const start = Math.max(0, Math.round(t0 * sr));
  const n = Math.min(L.length - start, Math.round(dur * sr));
  const [gl, gr] = panGains(pan);
  const f1 = new Biquad('bp', 700, 5, sr);
  const f2 = new Biquad('bp', 1200, 7, sr);
  const tilt = new Biquad('lp', 2600, 0.7, sr);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    if ((i & 63) === 0) {
      const [a, b] = vowelAt(t);
      f1.set('bp', a, 5, sr);
      f2.set('bp', b, 7, sr);
    }
    const e = envAt(t);
    if (e < 1e-4) continue;
    ph += f0At(t) / sr;
    if (ph >= 1) ph -= 1;
    const src = (2 * ph - 1) * (1 - breath) + (rng() * 2 - 1) * breath;
    const y = tilt.process(f1.process(src) * 1.0 + f2.process(src) * 0.6) * e * amp;
    L[start + i] += y * gl;
    R[start + i] += y * gr;
  }
}

export function peakOf(buf) {
  let p = 0;
  for (let i = 0; i < buf.length; i++) p = Math.max(p, Math.abs(buf[i]));
  return p;
}

/** Writes a seamless loop: generates len + xf samples via fill(), crossfades the tail into the head. */
export function seamless(sr, seconds, xfSec, fill) {
  const len = Math.ceil(sr * seconds);
  const xf = Math.ceil(sr * xfSec);
  const L = new Float32Array(len + xf), R = new Float32Array(len + xf);
  fill(L, R);
  const outL = L.slice(0, len), outR = R.slice(0, len);
  for (let i = 0; i < xf; i++) {
    const a = Math.sin((Math.PI / 2) * (i / xf));
    const b = Math.cos((Math.PI / 2) * (i / xf));
    outL[i] = L[i] * a + L[len + i] * b;
    outR[i] = R[i] * a + R[len + i] * b;
  }
  return [outL, outR];
}

