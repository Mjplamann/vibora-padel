// Personal timing and swing-speed profile (round 6). Pure module: storage is injected.
//
// The second real session (MacBook Air camera, close mode at 1.23 m, Rookie) swung a median
// 0.18 s before the ideal contact moment and its webcam measured 2-12 m/s swings (median 4.3), so
// every shot came out at the bottom of the pace range. A person's timing and their camera's speed
// scale are both personal; this profile learns them online, per device (storage) and camera (key):
//
//   bias    the robust centre of the timing errors e (s, swing peak - ideal contact) of the swings
//           judged against a playable ball: the last TIMING_ADAPT.window of them, the mode of their
//           main cluster (a flat-kernel mean shift of half-width `band` s started at the median, so
//           anticipation swings 0.6 s early and late recoveries do not drag it), shrunk toward 0 by
//           `prior` pseudo-samples and clamped to ±clamp. The timing judge centres its windows on it
//           (swingAssist.js).
//   effort  a swing's speed against the player's own recent swings of the same kind (ground,
//           volley, overhead, serve): their p10 maps to 0 and p90 to 1, blended with a prior range
//           (EFFORT.prior, a typical webcam) by EFFORT.priorN pseudo-swings, so a slow camera
//           (2-6 m/s) and a fast one (6-16 m/s) both span the full 0..1.
//
// Stored as JSON under TIMING_STORE_KEY: { [cameraKey]: { e: number[], v: { ground: number[], ... }, at } }.

export const TIMING_STORE_KEY = 'vibora.timing.v1';

export const TIMING_ADAPT = Object.freeze({
  window: 24, // timing errors kept
  minN: 3, // no bias before this many swings
  prior: 2, // pseudo-samples at 0 s (shrinkage of a short history)
  band: 0.2, // half-width (s) of the mean-shift window around the main cluster
  iterations: 6,
  clamp: 0.35, // |bias| limit (s)
  maxAbs: 1.0, // swings further than this from the ideal moment teach nothing
});

export const EFFORT = Object.freeze({
  window: 40, // swing speeds kept per kind
  priorN: 6, // pseudo-swings of the prior range
  lo: 0.1, // percentile that maps to effort 0
  hi: 0.9, // percentile that maps to effort 1
  minSpan: 1.6, // m/s: the learned range is never narrower
  /** Prior [effort 0, effort 1] measured speeds (m/s, body-relative sweet spot, a typical webcam). */
  prior: Object.freeze({
    ground: Object.freeze([4, 11]), volley: Object.freeze([2.4, 7.5]), overhead: Object.freeze([4, 12]), serve: Object.freeze([3, 9]),
  }),
});

const KINDS = Object.freeze(['ground', 'volley', 'overhead', 'serve']);

/** Swing kind of a stroke family ('fh'|'bh'|'vfh'|'vbh'|'oh'|'sm'|'serve'). */
export function effortKind(family, serve = false) {
  if (serve || family === 'serve') return 'serve';
  if (family === 'vfh' || family === 'vbh') return 'volley';
  if (family === 'oh' || family === 'sm') return 'overhead';
  return 'ground';
}

function quantile(sorted, q) {
  const n = sorted.length;
  if (!n) return NaN;
  const x = clamp01(q) * (n - 1);
  const i = Math.floor(x);
  const f = x - i;
  return i + 1 < n ? sorted[i] + (sorted[i + 1] - sorted[i]) * f : sorted[i];
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** Robust timing bias of a list of errors (s): see TIMING_ADAPT. Returns { bias, n, kept }. */
export function robustBias(errors, A = TIMING_ADAPT) {
  const es = errors.filter((e) => finite(e) && Math.abs(e) <= A.maxAbs);
  if (es.length < A.minN) return { bias: 0, n: es.length, kept: 0 };
  let c = quantile(es.slice().sort((a, b) => a - b), 0.5);
  let kept = 0;
  for (let it = 0; it < A.iterations; it++) {
    let sum = 0, n = 0;
    for (const e of es) {
      if (Math.abs(e - c) <= A.band) {
        sum += e;
        n++;
      }
    }
    if (!n) break;
    kept = n;
    const m = sum / n;
    const moved = Math.abs(m - c);
    c = m;
    if (moved < 1e-4) break;
  }
  const bias = (c * kept) / (kept + A.prior);
  return { bias: Math.max(-A.clamp, Math.min(A.clamp, bias)), n: es.length, kept };
}

/** "Timing tuned to you: −0.21 s" (U+2212 minus), or null without a bias yet. */
export function tunedText(bias, n = 1) {
  if (!finite(bias) || !(n > 0)) return null;
  const v = Math.abs(bias) < 0.005 ? '0.00' : `${bias < 0 ? '−' : '+'}${Math.abs(bias).toFixed(2)}`;
  return `Timing tuned to you: ${v} s`;
}

/**
 * @param o.storage { getItem, setItem } or null (in memory)
 * @param o.key camera key (settings.cameraPreset), so a Continuity Camera and the built-in one learn apart
 * @returns TimingProfile = { key, bias, n, addTiming(e), addSwing(kind, speed), effort(kind, speed),
 *   range(kind) -> [lo, hi], reset(), summary(), save() }
 */
export function createTimingProfile({ storage = null, key = 'default' } = {}) {
  const data = { e: [], v: {} };
  for (const k of KINDS) data.v[k] = [];
  let cached = null; // { bias, n, kept }

  function load() {
    if (!storage) return;
    try {
      const all = JSON.parse(storage.getItem(TIMING_STORE_KEY) || '{}');
      const d = all && all[key];
      if (!d) return;
      if (Array.isArray(d.e)) data.e = d.e.filter(finite).slice(-TIMING_ADAPT.window);
      for (const k of KINDS) if (d.v && Array.isArray(d.v[k])) data.v[k] = d.v[k].filter((x) => finite(x) && x > 0).slice(-EFFORT.window);
    } catch {
      /* a broken store starts afresh */
    }
  }

  function save() {
    if (!storage) return;
    try {
      const all = JSON.parse(storage.getItem(TIMING_STORE_KEY) || '{}') || {};
      all[key] = { e: data.e.map((x) => Math.round(x * 1000) / 1000), v: Object.fromEntries(KINDS.map((k) => [k, data.v[k].map((x) => Math.round(x * 100) / 100)])), at: Date.now() };
      storage.setItem(TIMING_STORE_KEY, JSON.stringify(all));
    } catch {
      /* storage full / unavailable: keep learning in memory */
    }
  }

  const stats = () => cached || (cached = robustBias(data.e));

  /** [lo, hi] measured speeds (m/s) that map to effort 0 and 1 for a swing kind. */
  function range(kind) {
    const pr = EFFORT.prior[kind] || EFFORT.prior.ground;
    const v = data.v[kind] || [];
    const n = v.length;
    let lo = pr[0], hi = pr[1];
    if (n) {
      const s = v.slice().sort((a, b) => a - b);
      const w = n + EFFORT.priorN;
      lo = (n * quantile(s, EFFORT.lo) + EFFORT.priorN * pr[0]) / w;
      hi = (n * quantile(s, EFFORT.hi) + EFFORT.priorN * pr[1]) / w;
    }
    if (hi - lo < EFFORT.minSpan) {
      const mid = (hi + lo) / 2;
      lo = Math.max(0.5, mid - EFFORT.minSpan / 2);
      hi = lo + EFFORT.minSpan;
    }
    return [lo, hi];
  }

  load();

  return {
    key,
    get bias() { return stats().bias; },
    get n() { return data.e.length; },
    /** Learns one judged swing's timing error (s, raw: swing peak - ideal contact). */
    addTiming(e) {
      if (!finite(e) || Math.abs(e) > TIMING_ADAPT.maxAbs) return;
      data.e.push(e);
      if (data.e.length > TIMING_ADAPT.window) data.e.shift();
      cached = null;
      save();
    },
    /** Learns one judged swing's measured peak speed (m/s) for its kind. */
    addSwing(kind, speed) {
      if (!finite(speed) || !(speed > 0) || !data.v[kind]) return;
      const v = data.v[kind];
      v.push(speed);
      if (v.length > EFFORT.window) v.shift();
    },
    /** Effort 0..1 of a swing of `speed` m/s against the player's own swings of that kind. */
    effort(kind, speed) {
      if (!finite(speed)) return 0.5;
      const [lo, hi] = range(kind);
      return clamp01((speed - lo) / (hi - lo));
    },
    range,
    /** Quantile q of the player's own measured swing speeds of a kind (m/s), or null below `minN` of them. */
    speedQuantile(kind, q, minN = 2) {
      const v = data.v[kind] || [];
      if (v.length < minN) return null;
      return quantile(v.slice().sort((a, b) => a - b), q);
    },
    reset() {
      data.e.length = 0;
      for (const k of KINDS) data.v[k].length = 0;
      cached = null;
      save();
    },
    save,
    /** Diagnostics / Settings: { bias, n, kept, text, effort: { kind: [lo, hi] (m/s), n } }. */
    summary() {
      const s = stats();
      const r = (x) => Math.round(x * 1000) / 1000;
      return {
        key,
        bias: r(s.bias),
        n: s.n,
        kept: s.kept,
        text: s.n >= TIMING_ADAPT.minN ? tunedText(s.bias, s.n) : null,
        effort: Object.fromEntries(KINDS.map((k) => [k, { range: range(k).map((x) => Math.round(x * 100) / 100), n: data.v[k].length }])),
      };
    },
  };
}

// Shared profiles of the app session (camera input): one object per storage key, so successive
// games share and persist it. Autopilot and tests use their own (createTimingProfile()).
const shared = new Map();

/** The app's profile for a camera key (cached; loaded from and saved to `storage`). */
export function sharedTimingProfile(storage, key = 'default') {
  let p = shared.get(key);
  if (!p) {
    p = createTimingProfile({ storage, key });
    shared.set(key, p);
  }
  return p;
}

/** Settings "Reset timing": forgets the learned bias and speeds of a camera key (or all of them). */
export function resetTimingProfile(storage, key = null) {
  if (key === null) {
    for (const p of shared.values()) p.reset();
    if (storage) {
      try { storage.setItem(TIMING_STORE_KEY, '{}'); } catch { /* ignore */ }
    }
    return;
  }
  const p = shared.get(key) || createTimingProfile({ storage, key });
  p.reset();
}

/** Summary of the app's profile for a key without creating state (diagnostics). */
export function timingProfileSummary(key = null) {
  if (key !== null) return shared.has(key) ? shared.get(key).summary() : null;
  const out = {};
  for (const [k, p] of shared) out[k] = p.summary();
  return Object.keys(out).length ? out : null;
}
