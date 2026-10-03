// Shared scalar helpers, seeded RNG, filters and a ring buffer. Pure JS (Node + browser).

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const remap = (v, a0, a1, b0, b1) => lerp(b0, b1, clamp(invLerp(a0, a1, v), 0, 1));
export const smoothstep = (a, b, v) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
export const DEG = Math.PI / 180;
export const msToKmh = (v) => v * 3.6;
export const radsToRpm = (w) => (w * 60) / (2 * Math.PI);
export const rpmToRads = (rpm) => (rpm * 2 * Math.PI) / 60;

/** Frame-rate independent exponential approach: returns new value moving current toward target. */
export const damp = (current, target, lambda, dt) => lerp(current, target, 1 - Math.exp(-lambda * dt));

/** Shortest signed angle difference b - a, wrapped to (-PI, PI]. */
export const angleDiff = (a, b) => {
  let d = (b - a) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d <= -Math.PI) d += 2 * Math.PI;
  return d;
};

/**
 * Seeded PRNG (mulberry32). rng() -> [0,1). Extra helpers hang off the function.
 * Deterministic for a given seed so physics tests and replays are repeatable.
 */
export function createRng(seed = 0x9e3779b9) {
  let s = seed >>> 0;
  const rng = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.range = (a, b) => a + (b - a) * rng();
  rng.int = (a, b) => Math.floor(rng.range(a, b + 1));
  rng.pick = (arr) => arr[Math.floor(rng() * arr.length)];
  rng.chance = (p) => rng() < p;
  /** Standard normal via Box–Muller. */
  rng.normal = (mean = 0, sd = 1) => {
    let u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  rng.getState = () => s;
  rng.setState = (st) => { s = st >>> 0; };
  return rng;
}

/**
 * One Euro filter (Casiez et al. 2012) for noisy real-time signals such as pose landmarks.
 * minCutoff: Hz (lower = smoother at rest), beta: speed coefficient (higher = less lag when moving).
 */
export class OneEuro {
  constructor(minCutoff = 1.0, beta = 0.0, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.x = null;
    this.dx = 0;
    this.t = null;
  }

  static alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  reset() {
    this.x = null;
    this.dx = 0;
    this.t = null;
  }

  /** @param value number @param t seconds (monotonic) */
  filter(value, t) {
    if (this.x === null || this.t === null || t <= this.t) {
      if (this.x === null) this.x = value;
      this.t = t;
      return this.x;
    }
    const dt = t - this.t;
    this.t = t;
    const dxRaw = (value - this.x) / dt;
    this.dx = lerp(this.dx, dxRaw, OneEuro.alpha(this.dCutoff, dt));
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x = lerp(this.x, value, OneEuro.alpha(cutoff, dt));
    return this.x;
  }
}

/** One Euro filter over {x,y,z}; returns a plain object (new each call). */
export class OneEuro3 {
  constructor(minCutoff = 1.0, beta = 0.0, dCutoff = 1.0) {
    this.fx = new OneEuro(minCutoff, beta, dCutoff);
    this.fy = new OneEuro(minCutoff, beta, dCutoff);
    this.fz = new OneEuro(minCutoff, beta, dCutoff);
  }

  reset() {
    this.fx.reset();
    this.fy.reset();
    this.fz.reset();
  }

  filter(v, t) {
    return { x: this.fx.filter(v.x, t), y: this.fy.filter(v.y, t), z: this.fz.filter(v.z, t) };
  }
}

/** Fixed-capacity ring buffer; oldest entries are overwritten. */
export class RingBuffer {
  constructor(capacity) {
    this.capacity = capacity;
    this.items = new Array(capacity);
    this.start = 0;
    this.length = 0;
  }

  push(item) {
    const idx = (this.start + this.length) % this.capacity;
    this.items[idx] = item;
    if (this.length < this.capacity) this.length++;
    else this.start = (this.start + 1) % this.capacity;
    return item;
  }

  /** i = 0 is oldest; negative i counts from newest (-1 = newest). */
  get(i) {
    if (i < 0) i = this.length + i;
    if (i < 0 || i >= this.length) return undefined;
    return this.items[(this.start + i) % this.capacity];
  }

  last() {
    return this.get(-1);
  }

  clear() {
    this.start = 0;
    this.length = 0;
  }

  /** Drops every entry after index i (keeps 0..i). */
  truncateAfter(i) {
    this.length = Math.max(0, Math.min(this.length, i + 1));
  }

  toArray() {
    const out = [];
    for (let i = 0; i < this.length; i++) out.push(this.get(i));
    return out;
  }

  /** Index of the newest entry with key(entry) <= value, or -1. Entries must be sorted by key. */
  findLastIndexAtOrBefore(value, key = (e) => e.t) {
    let lo = 0, hi = this.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (key(this.get(mid)) <= value) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }
}

/** Cubic Hermite interpolation of scalar p0->p1 with tangents m0, m1 over unit interval. */
export function hermite(p0, m0, p1, m1, t) {
  const t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * p0 + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * p1 + (t3 - t2) * m1;
}

/** Minimal event bus used by the game world. */
export function createBus() {
  const map = new Map();
  return {
    on(type, fn) {
      if (!map.has(type)) map.set(type, new Set());
      map.get(type).add(fn);
      return () => map.get(type)?.delete(fn);
    },
    off(type, fn) {
      map.get(type)?.delete(fn);
    },
    emit(type, payload) {
      const set = map.get(type);
      if (set) for (const fn of [...set]) fn(payload, type);
      const any = map.get('*');
      if (any) for (const fn of [...any]) fn(payload, type);
    },
  };
}
