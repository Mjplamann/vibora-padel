// One-finger swing gestures for touch screens (swipe mode: phones, tablets, touchscreen laptops).
// Pure module: no DOM, no three, so it runs under node --test. src/input/touch.js binds it to the
// canvas and turns each swing into a synthetic racket swing for the timing judge.
//
// createSwipeRecognizer({ width, height, stick }) -> {
//   down(id, x, y, tMs), move(id, x, y, tMs), up(id, x, y, tMs), cancel(id), poll(tMs)
//     each returns an array of events (usually empty):
//     { type: 'swing', tSwing, tStart, tEnd (ms), effort 0..1, speed (diagonals/s at the peak),
//       length (diagonals), dir {x, y} (unit, screen, y up), aimX -1..1 (left .. right),
//       upness -1..1 (down .. up), curve -1..1 (+ = the path bulges to the left of its chord),
//       curved, lob, path 'up'|'flat'|'down', hint 'topspin'|'lob'|'flat'|'slice'|'curve', x, y, id }
//     { type: 'tap', t, x, y, id }        a short touch without travel (serve)
//     { type: 'pause', t }                a two-finger tap
//     { type: 'stick', x, y, active, id } the optional left-thumb movement stick (-1..1, y up)
//   resize(w, h), setStick(on), active (touch count), reset()
// }
//
// Coordinates are CSS pixels (clientX / clientY, y down) and times are event timestamps in ms
// (performance.now() time base). Speeds and lengths are normalised by the screen diagonal, so a
// flick means the same on a phone and on a tablet: CSS pixels are already density-independent.
//
// A swing starts when the finger's speed (over a ~24 ms window) crosses SWIPE.onSpeed and is
// emitted once it has peaked: when the speed falls under offRatio × the peak, the finger lifts, or
// the swing has lasted maxDur. tSwing is the velocity peak (parabola through the three samples
// around it). Slow drags (scrolls, pans) never reach onSpeed; taps never travel.
//
// shotIntent(swing, ctx) maps a gesture onto the racket swing the timing judge reads
// (game/swingAssist.js timingAnalysis): the swing path angle (topspin up, slice down, lob steep,
// smash / bandeja down on a high ball), the horizontal swing direction (aim, curve -> sidespin,
// víbora), all in the judge's own terms.

export const SWIPE = Object.freeze({
  /** Speed (screen diagonals / s) that starts a swing; a scroll or a slow drag stays below it. */
  onSpeed: 0.9,
  /** The swing ends when the speed falls below offRatio × its peak (after the peak). */
  offRatio: 0.55,
  /** A swing re-arms (same finger) once the speed is below rearm × onSpeed. */
  rearm: 0.45,
  /** Shortest swing (diagonals of travel from its start to its end). */
  minTravel: 0.05,
  /** A swing is emitted at most this long (s) after it started. */
  maxDur: 0.26,
  /** Velocity window (s). */
  velWindow: 0.024,
  /** The finger stopped sending moves this long (s) during a swing: the swing has ended. */
  stall: 0.05,
  /** Tap: at most this travel (diagonals) and duration (s). */
  tapMaxTravel: 0.03,
  tapMaxDur: 0.28,
  /** Two-finger tap: the second finger within this (s) of the first, both up within twoFingerMaxDur. */
  twoFingerWindow: 0.25,
  twoFingerMaxDur: 0.45,
  /** Effort: peak speed (diagonals / s) and length (diagonals) ranges mapped onto 0..1. */
  effortSpeed: Object.freeze([1.2, 5.2]),
  effortLen: Object.freeze([0.08, 0.45]),
  effortSpeedWeight: 0.82,
  /** Horizontal gain of the aim (a 45° diagonal flick aims fully to that side). */
  aimGain: 1.35,
  /** Path classes by the chord's vertical share. */
  upMin: 0.35,
  /** Lob: steep (upness), slow (effort) and long (a deliberate lift, not a gentle flick). */
  lob: Object.freeze({ up: 0.85, effortMax: 0.32, lenMin: 0.2 }),
  /** Curved swipe: |sagitta| / chord at least this. */
  curveMin: 0.09,
  /** Stick (when on): touches starting in the left stickZone of the width; radius in diagonals. */
  stickZone: 0.38,
  stickRadius: 0.11,
  stickDeadzone: 0.12,
});

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v) => clamp(v, 0, 1);

/** Effort 0..1 from a swing's peak speed and length (diagonal units). */
export function effortOf(speed, length, S = SWIPE) {
  const es = clamp01((speed - S.effortSpeed[0]) / (S.effortSpeed[1] - S.effortSpeed[0]));
  const el = clamp01((length - S.effortLen[0]) / (S.effortLen[1] - S.effortLen[0]));
  return clamp01(S.effortSpeedWeight * es + (1 - S.effortSpeedWeight) * el);
}

/**
 * Vertex time of the parabola through three (t, s) samples (non-uniform spacing), clamped to
 * [a.t, c.t]; b.t when the samples do not form a maximum.
 */
export function peakTime(a, b, c) {
  if (!a || !c) return b.t;
  const d1 = (b.s - a.s) / (b.t - a.t);
  const d2 = (c.s - b.s) / (c.t - b.t);
  const A = (d2 - d1) / (c.t - a.t);
  if (!(A < 0)) return b.t;
  const B = d1 - A * (a.t + b.t);
  return clamp(-B / (2 * A), a.t, c.t);
}

/**
 * Shape of a finished swing from its samples (screen px, s): chord direction (y up), length,
 * curvature (signed sagitta / chord, + = bulging to the left of the travel direction).
 */
export function swingShape(pts, i0, i1, diag) {
  const a = pts[i0], b = pts[i1];
  const dx = b.x - a.x, dyUp = a.y - b.y;
  const len = Math.hypot(dx, dyUp);
  if (len < 1e-6) return { dir: { x: 0, y: 1 }, length: 0, curve: 0 };
  const ux = dx / len, uy = dyUp / len;
  let sag = 0;
  for (let i = i0 + 1; i < i1; i++) {
    const px = pts[i].x - a.x, py = a.y - pts[i].y;
    const s = ux * py - uy * px; // + = left of the chord (y up)
    if (Math.abs(s) > Math.abs(sag)) sag = s;
  }
  return { dir: { x: ux, y: uy }, length: len / diag, curve: clamp((2 * sag) / len, -1, 1) };
}

/** The gesture's classes and hint from its shape and effort. */
export function describeSwing({ dir, length, curve, effort }, S = SWIPE) {
  const upness = dir.y;
  const aimX = clamp(dir.x * S.aimGain, -1, 1);
  const curved = Math.abs(curve) / 2 >= S.curveMin;
  const path = upness > S.upMin ? 'up' : upness < -S.upMin ? 'down' : 'flat';
  const lob = upness >= S.lob.up && effort <= S.lob.effortMax && length >= S.lob.lenMin;
  const hint = lob ? 'lob' : curved ? 'curve' : path === 'up' ? 'topspin' : path === 'down' ? 'slice' : 'flat';
  return { upness, aimX, curved, path, lob, hint };
}

/**
 * @param {{width?: number, height?: number, stick?: boolean, opts?: object}} o
 */
export function createSwipeRecognizer({ width = 844, height = 390, stick = false, opts = {} } = {}) {
  const S = { ...SWIPE, ...opts };
  let W = width, H = height, diag = Math.hypot(W, H) || 1;
  let stickOn = !!stick;
  const tracks = new Map();
  const groups = []; // two-finger tap candidates: { ids: Set, t0, up: Set, ok }

  function newTrack(id, x, y, t) {
    return {
      id, x0: x, y0: y, t0: t, pts: [{ x, y, t, s: 0 }], kind: 'swipe', armed: true, sw: null,
      maxTravel: 0, group: null, swung: false, lastT: t, stickOx: x, stickOy: y,
    };
  }

  /** Smoothed velocity at the newest sample: { vx, vy (px/s, y down), s (diag/s), tm (mid time), i0 }. */
  function velocity(tr) {
    const p = tr.pts;
    const n = p.length;
    if (n < 2) return null;
    const b = p[n - 1];
    let j = n - 2;
    while (j > 0 && b.t - p[j].t < S.velWindow) j--;
    const a = p[j];
    const dt = b.t - a.t;
    if (!(dt > 1e-4)) return null;
    const vx = (b.x - a.x) / dt, vy = (b.y - a.y) / dt;
    return { vx, vy, s: Math.hypot(vx, vy) / diag, tm: (a.t + b.t) / 2, i0: j };
  }

  /** Index where the motion that became a swing began (walking back while the finger moved). */
  function motionStart(tr, i0) {
    const p = tr.pts;
    let i = i0;
    const tLimit = p[i0].t - 0.12;
    while (i > 0 && p[i - 1].t >= tLimit) {
      const a = p[i - 1], b = p[i];
      const dt = b.t - a.t;
      const s = dt > 1e-4 ? Math.hypot(b.x - a.x, b.y - a.y) / dt / diag : 0;
      if (s < 0.25 * S.onSpeed) break;
      i--;
    }
    return i;
  }

  function finish(tr, tNow) {
    const sw = tr.sw;
    tr.sw = null;
    tr.armed = false;
    const p = tr.pts;
    const iEnd = p.length - 1;
    const shape = swingShape(p, sw.iStart, iEnd, diag);
    if (shape.length < S.minTravel) return null;
    const k = sw.peakIdx;
    const sm = sw.samples;
    const tPk = peakTime(sm[k - 1], sm[k], sm[k + 1]);
    const effort = effortOf(sw.peak.s, shape.length, S);
    const d = describeSwing({ ...shape, effort }, S);
    tr.swung = true;
    return {
      type: 'swing', id: tr.id, tSwing: tPk * 1000, tStart: p[sw.iStart].t * 1000, tEnd: tNow * 1000,
      effort, speed: sw.peak.s, length: shape.length, dir: shape.dir, curve: shape.curve,
      aimX: d.aimX, upness: d.upness, curved: d.curved, lob: d.lob, path: d.path, hint: d.hint,
      x: p[iEnd].x, y: p[iEnd].y,
    };
  }

  function stickEvent(tr, x, y) {
    const R = S.stickRadius * diag;
    let dx = x - tr.stickOx, dy = y - tr.stickOy;
    const m = Math.hypot(dx, dy);
    if (m > R) {
      // A floating origin: dragging past the rim pulls the centre along, so turning is immediate.
      tr.stickOx = x - (dx / m) * R;
      tr.stickOy = y - (dy / m) * R;
      dx = (dx / m) * R;
      dy = (dy / m) * R;
    }
    let sx = dx / R, sy = -dy / R;
    const mag = Math.hypot(sx, sy);
    if (mag < S.stickDeadzone) sx = sy = 0;
    else {
      const k = (mag - S.stickDeadzone) / (1 - S.stickDeadzone) / mag;
      sx *= k;
      sy *= k;
    }
    return { type: 'stick', id: tr.id, x: sx, y: sy, active: true, ox: tr.stickOx, oy: tr.stickOy };
  }

  function down(id, x, y, tMs) {
    const t = tMs / 1000;
    const out = [];
    const tr = newTrack(id, x, y, t);
    if (stickOn && x < S.stickZone * W) {
      tr.kind = 'stick';
      out.push({ type: 'stick', id, x: 0, y: 0, active: true, ox: x, oy: y });
    } else {
      // A second finger right after the first: a two-finger tap candidate (pause).
      for (const o of tracks.values()) {
        if (o.kind !== 'swipe' || o.swung || o.group || t - o.t0 > S.twoFingerWindow) continue;
        const g = { ids: new Set([o.id, id]), t0: o.t0, up: new Set(), ok: true };
        groups.push(g);
        o.group = g;
        tr.group = g;
        if (o.sw) o.sw = null; // two fingers are not a swing
        break;
      }
    }
    tracks.set(id, tr);
    return out;
  }

  function move(id, x, y, tMs) {
    const tr = tracks.get(id);
    if (!tr) return [];
    const t = tMs / 1000;
    if (t <= tr.lastT) {
      // Same timestamp (coalesced events): replace the newest point.
      const last = tr.pts[tr.pts.length - 1];
      last.x = x;
      last.y = y;
    } else tr.pts.push({ x, y, t, s: 0 });
    tr.lastT = Math.max(tr.lastT, t);
    if (tr.pts.length > 240) {
      const drop = tr.pts.length - 240;
      tr.pts.splice(0, drop);
      if (tr.sw) {
        tr.sw.iStart = Math.max(0, tr.sw.iStart - drop);
      }
    }
    tr.maxTravel = Math.max(tr.maxTravel, Math.hypot(x - tr.x0, y - tr.y0) / diag);
    if (tr.kind === 'stick') return [stickEvent(tr, x, y)];
    if (tr.group) return [];
    const v = velocity(tr);
    if (!v) return [];
    tr.pts[tr.pts.length - 1].s = v.s;
    const out = [];
    if (!tr.sw) {
      if (!tr.armed && v.s < S.rearm * S.onSpeed) tr.armed = true;
      if (tr.armed && v.s >= S.onSpeed) {
        tr.sw = { iStart: motionStart(tr, v.i0), t0: v.tm, peak: { s: v.s, t: v.tm }, samples: [{ t: v.tm, s: v.s }], peakIdx: 0 };
      }
      return out;
    }
    const sw = tr.sw;
    sw.samples.push({ t: v.tm, s: v.s });
    if (v.s > sw.peak.s) {
      sw.peak = { s: v.s, t: v.tm };
      sw.peakIdx = sw.samples.length - 1;
    }
    const after = sw.samples.length - 1 > sw.peakIdx;
    if ((after && v.s < S.offRatio * sw.peak.s) || t - sw.t0 > S.maxDur) {
      const ev = finish(tr, t);
      if (ev) out.push(ev);
    }
    return out;
  }

  function up(id, x, y, tMs) {
    const tr = tracks.get(id);
    if (!tr) return [];
    const out = [];
    if (Number.isFinite(x) && Number.isFinite(y) && tMs / 1000 > tr.lastT) out.push(...move(id, x, y, tMs));
    tracks.delete(id);
    const t = tMs / 1000;
    if (tr.kind === 'stick') {
      out.push({ type: 'stick', id, x: 0, y: 0, active: false });
      return out;
    }
    if (tr.group) {
      const g = tr.group;
      g.up.add(id);
      if (tr.maxTravel > 2 * S.tapMaxTravel) g.ok = false;
      if (g.up.size === g.ids.size) {
        groups.splice(groups.indexOf(g), 1);
        if (g.ok && t - g.t0 <= S.twoFingerMaxDur) out.push({ type: 'pause', t: tMs });
      }
      return out;
    }
    if (tr.sw) {
      // The finger left the glass at speed: that is the end of the swing.
      if (tr.sw.samples.length >= 1) {
        const ev = finish(tr, t);
        if (ev) out.push(ev);
      }
      return out;
    }
    if (!tr.swung && t - tr.t0 <= S.tapMaxDur && tr.maxTravel <= S.tapMaxTravel) {
      out.push({ type: 'tap', id, t: tMs, x: tr.pts[tr.pts.length - 1].x, y: tr.pts[tr.pts.length - 1].y });
    }
    return out;
  }

  function cancel(id) {
    const tr = tracks.get(id);
    tracks.delete(id);
    if (tr && tr.group) {
      const g = tr.group;
      g.ok = false;
      g.up.add(id);
      if (g.up.size === g.ids.size) groups.splice(groups.indexOf(g), 1);
    }
    return tr && tr.kind === 'stick' ? [{ type: 'stick', id, x: 0, y: 0, active: false }] : [];
  }

  /** Time-based endings: a swing whose finger stopped sending moves (held still on the glass). */
  function poll(tMs) {
    const t = tMs / 1000;
    const out = [];
    for (const tr of tracks.values()) {
      if (tr.sw && t - tr.lastT >= S.stall) {
        const ev = finish(tr, tr.lastT);
        if (ev) out.push(ev);
      }
    }
    return out;
  }

  return {
    down, move, up, cancel, poll,
    resize(w, h) {
      W = w > 0 ? w : W;
      H = h > 0 ? h : H;
      diag = Math.hypot(W, H) || 1;
    },
    setStick(on) {
      stickOn = !!on;
    },
    get stick() { return stickOn; },
    get diag() { return diag; },
    get active() { return tracks.size; },
    reset() {
      tracks.clear();
      groups.length = 0;
    },
    opts: S,
  };
}

// ---------------------------------------------------------------------------------------
// Gesture -> racket swing (the timing judge's terms)

/** Stroke family groups of game/human.js / game/swingAssist.js. */
const OVERHEAD = new Set(['oh', 'sm']);
const VOLLEY = new Set(['vfh', 'vbh']);

/** Largest horizontal deviation (rad) the judge reads as aim (swingAssist.js clamps ±0.45). */
export const AIM_DEV = 0.45;
/** Horizontal swing direction (rad) of a víbora (swingAssist.js: |az| > 0.6 on an overhead). */
export const VIBORA_AZ = 0.82;
/** Share of a slice's downward path a full-effort swipe drops (from effort 0.55 up). */
export const SLICE_FLATTEN = 0.5;

/**
 * The racket swing a gesture asks for.
 * ctx: { family: 'fh'|'bh'|'vfh'|'vbh'|'oh'|'sm'|'serve', serve?: boolean }
 * Returns { kind, pathDeg (vertical path angle at the peak, + rising), azDev (rad, horizontal
 * deviation from the family's usual swing direction, + = toward court +x), effort, stroke }:
 *  - groundstrokes: up = topspin drive (more vertical = more brush), flat = flat drive, down = slice,
 *    a steep, slow, long up-swipe = lob; a curved swipe = slice with sidespin, bending the aim;
 *  - volleys: punch (up = a little lift, down = slice);
 *  - overheads: down = smash (effort >= 0.7) or bandeja, up / flat = bandeja, curved or strongly
 *    sideways with some pace = víbora;
 *  - serve: the underhand serve (direction from the aim).
 * stroke: the animation / label hint (render/animation/strokes.js names) or null for the family's.
 */
export function shotIntent(sw, ctx = {}) {
  const fam = ctx.family || 'fh';
  const effort = clamp01(sw.effort ?? 0.5);
  const up = clamp(sw.upness ?? 1, -1, 1);
  const aimX = clamp(sw.aimX ?? 0, -1, 1);
  const curve = clamp(sw.curve ?? 0, -1, 1);
  const curved = !!sw.curved;
  const ramp = (v) => clamp01((Math.abs(v) - SWIPE.upMin) / (1 - SWIPE.upMin));
  if (ctx.serve || fam === 'serve') {
    return { kind: 'serve', pathDeg: 8, azDev: aimX * 0.3, effort, stroke: 'serve' };
  }
  if (OVERHEAD.has(fam)) {
    const lateral = curved ? Math.sign(curve) : Math.abs(aimX) > 0.8 ? Math.sign(aimX) : 0;
    if (lateral && effort >= 0.42) {
      return { kind: 'vibora', pathDeg: -8, azDev: lateral * VIBORA_AZ, effort, stroke: 'vibora' };
    }
    if (up < -SWIPE.upMin && effort >= 0.7) {
      return { kind: 'smash', pathDeg: -24, azDev: aimX * AIM_DEV, effort, stroke: 'smash' };
    }
    return { kind: 'bandeja', pathDeg: up < -SWIPE.upMin ? -12 : -6, azDev: aimX * AIM_DEV, effort, stroke: fam === 'sm' ? 'smash' : 'bandeja' };
  }
  const azDev = clamp(aimX * AIM_DEV + (curved ? curve * 0.35 : 0), -0.6, 0.6);
  if (VOLLEY.has(fam)) {
    const pathDeg = up > SWIPE.upMin ? 6 : up < -SWIPE.upMin ? -16 : 0;
    return { kind: 'volley', pathDeg: pathDeg - (curved ? 6 : 0), azDev, effort, stroke: null };
  }
  if (sw.lob) return { kind: 'lob', pathDeg: 75, azDev: aimX * AIM_DEV * 0.6, effort, stroke: 'lob' };
  let pathDeg;
  let kind;
  if (up > SWIPE.upMin) {
    pathDeg = 12 + 18 * ramp(up);
    kind = 'topspin';
  } else if (up < -SWIPE.upMin) {
    // A hard slice is a flatter, driving cut: the steepest path with the most pace floats long
    // (the judge then falls back to a slow, safe arc: harder would play slower).
    pathDeg = -(14 + 16 * ramp(up)) * (1 - SLICE_FLATTEN * clamp01((effort - 0.55) / 0.45));
    kind = 'slice';
  } else {
    pathDeg = 4;
    kind = 'flat';
  }
  if (curved) {
    // A curve is a cut: slice under the ball and sidespin the way the swipe bends.
    pathDeg = Math.min(pathDeg, -10) - 10 * Math.abs(curve);
    kind = 'slice';
  }
  return { kind, pathDeg, azDev, effort, stroke: null };
}
