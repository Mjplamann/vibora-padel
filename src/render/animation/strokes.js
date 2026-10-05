// Padel stroke library for the procedural athletes (pure: no three). Each stroke is authored as
// the racket's path in the body frame (x = the player's right, y up, z forward toward the target,
// origin on the floor between the feet) for a right-handed player, keyed by swing phase 0..1
// (coach.js swings: contact at 0.55, 0.6 for the smash and the serve), with the shoulder and hip
// turn, crouch, forward lean, a jump height and the off hand. Keys are sampled with a
// Catmull-Rom spline, so the racket accelerates through the contact instead of stopping at every
// key (the old piecewise-smoothstep keys made the swings robotic).
//
// g: grip point, a: racket axis (handle -> tip), n: forehand face normal (palm side),
// turn: shoulder turn toward the racket side (deg), hip: hip turn (deg), crouch 0..1, lean (rad),
// jump (m), off: off-hand target or 'throat' (cradling the racket throat). Round 6: the off arm
// works like a real player's — pointing at the ball in the preparation, folding in front of the chest
// (not onto the hip) through the contact, opening back for balance on the one-handed backhand.
// Off-hand heights are from the floor: a jumping stroke (smash) adds its jump to them.

const READY = { g: [0.06, 1.1, 0.31], a: [-0.28, 0.78, 0.52], n: [-0.9, 0.1, 0.35], turn: 0, hip: 0, off: 'throat', crouch: 0.6, lean: 0.12 };
const k = (p, o) => ({ ...READY, jump: 0, p, ...o });

export const STROKES = {
  forehand: [
    k(0),
    k(0.14, { g: [0.32, 1.16, 0.18], a: [0.05, 0.85, -0.2], n: [-0.4, -0.2, -0.85], turn: 35, hip: 15, off: [0.1, 1.3, 0.48] }),
    k(0.32, { g: [0.52, 1.2, -0.24], a: [0.32, 0.78, -0.52], n: [0.35, -0.55, -0.72], turn: 72, hip: 32, off: [0.14, 1.34, 0.5], crouch: 0.62 }),
    k(0.47, { g: [0.54, 0.98, 0.1], a: [0.72, -0.25, -0.62], n: [0.45, 0.25, 0.85], turn: 38, hip: 22, off: [-0.06, 1.28, 0.42], crouch: 0.66 }),
    k(0.55, { g: [0.44, 0.98, 0.52], a: [0.86, 0.06, 0.48], n: [-0.45, 0.1, 0.88], turn: 0, hip: 5, off: [-0.26, 1.24, 0.34], crouch: 0.64, lean: 0.16 }),
    k(0.66, { g: [0.08, 1.2, 0.62], a: [0.2, 0.55, 0.8], n: [-0.85, 0.25, 0.45], turn: -30, hip: -12, off: [-0.3, 1.22, 0.26], crouch: 0.55, lean: 0.16 }),
    k(0.8, { g: [-0.2, 1.38, 0.4], a: [-0.42, 0.62, -0.62], n: [-0.6, 0.3, 0.5], turn: -48, hip: -18, off: [-0.2, 1.26, 0.24], crouch: 0.48 }),
    k(1, { g: [0.02, 1.2, 0.34], a: [-0.3, 0.8, 0.3], n: [-0.9, 0.0, 0.3], turn: -12, hip: -5, crouch: 0.52 }),
  ],
  backhand: [
    k(0),
    k(0.14, { g: [-0.2, 1.12, 0.2], a: [-0.2, 0.85, -0.1], n: [0.7, 0.0, -0.6], turn: -40, hip: -18 }),
    k(0.32, { g: [-0.44, 1.1, -0.14], a: [-0.3, 0.8, -0.5], n: [0.6, 0.0, -0.7], turn: -82, hip: -35, crouch: 0.62 }),
    k(0.47, { g: [-0.46, 0.97, 0.2], a: [-0.75, -0.1, -0.55], n: [0.5, 0.1, -0.85], turn: -42, hip: -22, off: [-0.42, 1.14, -0.18], crouch: 0.66 }),
    k(0.55, { g: [-0.42, 1.0, 0.52], a: [-0.9, 0.1, 0.4], n: [0.4, -0.05, -0.9], turn: -6, hip: -6, off: [-0.48, 1.15, -0.28], crouch: 0.64, lean: 0.16 }),
    k(0.68, { g: [-0.05, 1.22, 0.6], a: [-0.2, 0.6, 0.75], n: [0.75, -0.1, -0.6], turn: 18, hip: 6, off: [-0.5, 1.17, -0.3], crouch: 0.55 }),
    k(0.8, { g: [0.22, 1.42, 0.38], a: [0.4, 0.8, 0.2], n: [0.8, 0.0, -0.4], turn: 28, hip: 10, off: [-0.48, 1.18, -0.3], crouch: 0.48 }),
    k(1, { g: [0.0, 1.2, 0.35], a: [0.0, 0.85, 0.4], n: [-0.9, 0, 0.3], turn: 0, crouch: 0.52 }),
  ],
  'volley-fh': [
    k(0, { g: [0.12, 1.2, 0.38], crouch: 0.5 }),
    k(0.35, { g: [0.42, 1.28, 0.15], a: [0.25, 0.9, -0.2], n: [-0.1, 0.2, 0.95], turn: 30, hip: 10, off: [-0.1, 1.25, 0.45], crouch: 0.5 }),
    k(0.55, { g: [0.4, 1.2, 0.6], a: [0.45, 0.75, 0.45], n: [-0.2, 0.3, 0.9], turn: 4, hip: 2, off: [-0.2, 1.28, 0.38], crouch: 0.52, lean: 0.18 }),
    k(0.75, { g: [0.26, 1.1, 0.62], a: [0.35, 0.6, 0.6], n: [-0.2, 0.45, 0.85], turn: 0, off: [-0.2, 1.24, 0.36], crouch: 0.5 }),
    k(1, { g: [0.12, 1.2, 0.38], crouch: 0.5 }),
  ],
  'volley-bh': [
    k(0, { g: [0.12, 1.2, 0.38], crouch: 0.5 }),
    k(0.35, { g: [-0.4, 1.28, 0.1], a: [-0.3, 0.9, -0.1], n: [0.1, -0.2, -0.95], turn: -40, hip: -14, crouch: 0.5 }),
    k(0.55, { g: [-0.4, 1.2, 0.6], a: [-0.45, 0.75, 0.45], n: [0.2, -0.3, -0.9], turn: -10, hip: -4, off: [-0.4, 1.1, -0.1], crouch: 0.52, lean: 0.18 }),
    k(0.75, { g: [-0.35, 1.1, 0.58], a: [-0.4, 0.6, 0.6], n: [0.2, -0.45, -0.85], turn: -5, off: [-0.4, 1.1, -0.15], crouch: 0.5 }),
    k(1, { g: [0.12, 1.2, 0.38], crouch: 0.5 }),
  ],
  bandeja: [
    k(0),
    k(0.18, { g: [0.24, 1.45, 0.12], a: [0.0, 0.85, -0.5], n: [-0.8, 0.2, 0.5], turn: 45, hip: 25, off: [0.0, 1.6, 0.42], crouch: 0.35 }),
    k(0.36, { g: [0.3, 1.74, -0.06], a: [0.1, 0.6, -0.8], n: [-0.7, 0.3, 0.6], turn: 78, hip: 40, off: [-0.05, 1.88, 0.45], crouch: 0.25 }),
    k(0.55, { g: [0.25, 1.98, 0.42], a: [0.25, 0.85, 0.45], n: [-0.3, 0.3, 0.9], turn: 25, hip: 15, off: [-0.3, 1.35, 0.2], crouch: 0.2, lean: 0.05 }),
    k(0.72, { g: [-0.05, 1.5, 0.55], a: [-0.4, 0.5, 0.75], n: [-0.3, 0.55, 0.65], turn: -5, hip: 0, off: [-0.3, 1.26, 0.16], crouch: 0.3, lean: 0.16 }),
    k(0.86, { g: [-0.2, 1.3, 0.5], a: [-0.6, 0.25, 0.75], n: [-0.3, 0.6, 0.6], turn: -15, hip: -6, off: [-0.28, 1.22, 0.12], crouch: 0.35 }),
    k(1),
  ],
  vibora: [
    k(0),
    k(0.18, { g: [0.26, 1.45, 0.1], a: [0.05, 0.85, -0.5], n: [-0.8, 0.2, 0.5], turn: 48, hip: 26, off: [0.0, 1.6, 0.42], crouch: 0.35 }),
    k(0.36, { g: [0.34, 1.72, -0.1], a: [0.2, 0.55, -0.8], n: [-0.7, 0.2, 0.6], turn: 82, hip: 42, off: [-0.05, 1.88, 0.45], crouch: 0.25 }),
    k(0.55, { g: [0.4, 1.9, 0.4], a: [0.6, 0.7, 0.35], n: [-0.65, -0.1, 0.75], turn: 25, hip: 14, off: [-0.3, 1.35, 0.2], crouch: 0.2, lean: 0.06 }),
    k(0.7, { g: [0.05, 1.4, 0.55], a: [-0.3, 0.2, 0.9], n: [-0.6, -0.5, 0.6], turn: -12, hip: -4, off: [-0.3, 1.24, 0.15], crouch: 0.32, lean: 0.18 }),
    k(0.84, { g: [-0.25, 1.05, 0.45], a: [-0.7, -0.2, 0.6], n: [-0.4, -0.6, 0.6], turn: -32, hip: -12, off: [-0.3, 1.14, 0.12], crouch: 0.42 }),
    k(1),
  ],
  smash: [
    k(0),
    k(0.18, { g: [0.24, 1.5, 0.08], a: [0.0, 0.8, -0.6], n: [-0.7, 0.3, 0.6], turn: 50, hip: 28, off: [0.0, 1.7, 0.4], crouch: 0.5 }),
    k(0.36, { g: [0.22, 1.66, -0.24], a: [0.05, -0.6, -0.8], n: [0.3, 0.6, -0.7], turn: 78, hip: 42, off: [-0.08, 2.0, 0.35], crouch: 0.45, jump: 0.02 }),
    k(0.52, { g: [0.15, 2.08, 0.18], a: [0.1, 0.95, 0.2], n: [-0.2, 0.2, 0.95], turn: 28, hip: 18, off: [-0.25, 1.5, 0.25], crouch: 0.1, jump: 0.2 }),
    k(0.6, { g: [0.15, 2.05, 0.5], a: [0.15, 0.8, 0.6], n: [-0.1, -0.4, 0.9], turn: 0, hip: 4, off: [-0.3, 1.52, 0.26], crouch: 0.1, jump: 0.24, lean: 0.12 }),
    k(0.72, { g: [-0.05, 1.45, 0.55], a: [-0.1, -0.2, 0.95], n: [-0.3, -0.7, 0.2], turn: -20, hip: -6, off: [-0.26, 1.32, 0.22], crouch: 0.25, jump: 0.12, lean: 0.25 }),
    k(0.85, { g: [-0.3, 0.98, 0.45], a: [-0.35, -0.6, 0.7], n: [-0.5, -0.6, -0.4], turn: -38, hip: -14, off: [-0.26, 1.08, 0.14], crouch: 0.55, jump: 0, lean: 0.3 }),
    k(1),
  ],
  lob: [
    k(0),
    k(0.16, { g: [0.3, 0.95, 0.1], a: [0.3, 0.5, -0.6], n: [0.0, 0.4, -0.9], turn: 30, hip: 15, off: [0.05, 1.1, 0.42], crouch: 0.75 }),
    k(0.32, { g: [0.5, 0.78, -0.15], a: [0.6, 0.05, -0.8], n: [0.0, 0.7, -0.7], turn: 50, hip: 25, off: [0.0, 1.1, 0.4], crouch: 0.9 }),
    k(0.55, { g: [0.45, 0.8, 0.45], a: [0.85, -0.05, 0.5], n: [-0.4, 0.6, 0.7], turn: 0, hip: 4, off: [-0.3, 1.0, 0.2], crouch: 0.85 }),
    k(0.75, { g: [0.22, 1.45, 0.58], a: [0.25, 0.65, 0.72], n: [-0.55, 0.65, 0.4], turn: -15, hip: -5, off: [-0.3, 1.22, 0.22], crouch: 0.55 }),
    k(0.88, { g: [0.1, 1.78, 0.48], a: [0.1, 0.7, 0.7], n: [-0.6, 0.6, 0.3], turn: -20, hip: -8, off: [-0.28, 1.25, 0.2], crouch: 0.4 }),
    k(1),
  ],
  chiquita: [
    k(0),
    k(0.35, { g: [0.45, 0.88, 0.05], a: [0.6, 0.3, -0.6], n: [-0.2, -0.2, 0.95], turn: 35, hip: 15, off: [0.0, 1.0, 0.4], crouch: 1 }),
    k(0.55, { g: [0.45, 0.82, 0.45], a: [0.8, 0.15, 0.55], n: [-0.45, 0.2, 0.85], turn: 5, hip: 2, off: [-0.25, 1.0, 0.25], crouch: 1, lean: 0.22 }),
    k(0.78, { g: [0.25, 0.98, 0.62], a: [0.5, 0.35, 0.8], n: [-0.5, 0.4, 0.75], turn: 0, off: [-0.3, 1.0, 0.2], crouch: 0.9, lean: 0.2 }),
    k(1),
  ],
  serve: [
    k(0, { g: [0.3, 1.12, 0.1], a: [0.2, 0.9, 0.2], n: [-0.9, 0, 0.3], turn: 25, hip: 15, off: [-0.02, 1.0, 0.45], crouch: 0.25 }),
    k(0.3, { g: [0.46, 1.0, -0.22], a: [0.35, 0.6, -0.7], n: [0.2, -0.3, -0.9], turn: 45, hip: 25, off: [-0.1, 0.9, 0.4], crouch: 0.35 }),
    k(0.45, { g: [0.52, 0.86, -0.36], a: [0.4, 0.4, -0.8], n: [0.2, -0.3, -0.9], turn: 50, hip: 28, off: [-0.2, 0.95, 0.3], crouch: 0.45 }),
    k(0.6, { g: [0.4, 0.78, 0.4], a: [0.9, 0.1, 0.4], n: [-0.4, 0.1, 0.9], turn: 0, hip: 6, off: [-0.32, 1.12, 0.44], crouch: 0.45, lean: 0.15 }),
    k(0.82, { g: [0.02, 1.25, 0.56], a: [-0.3, 0.6, 0.7], n: [-0.8, 0.3, 0.4], turn: -20, hip: -6, off: [-0.26, 1.2, 0.32], crouch: 0.3 }),
    k(1),
  ],
};
STROKES['glass-fh'] = STROKES.forehand;
STROKES['glass-bh'] = STROKES.backhand;

export const STROKE_NAMES = Object.keys(STROKES);
/** Phase of the ball contact per stroke (coach.js SWING). */
export const CONTACT_PHASE = Object.freeze({ smash: 0.6, serve: 0.6 });
export const contactPhase = (stroke) => CONTACT_PHASE[stroke] ?? 0.55;

/** Stroke family: 'fh' | 'bh' | 'oh' (overheads) | 'vfh' | 'vbh' | 'low' | 'serve'. */
export function strokeFamily(stroke) {
  if (!stroke) return null;
  if (stroke === 'bandeja' || stroke === 'vibora' || stroke === 'smash') return 'oh';
  if (stroke === 'volley-fh') return 'vfh';
  if (stroke === 'volley-bh') return 'vbh';
  if (stroke === 'serve') return 'serve';
  if (stroke === 'lob' || stroke === 'chiquita') return 'low';
  if (stroke === 'backhand' || stroke.endsWith('bh')) return 'bh';
  return 'fh';
}

/**
 * Feet for a stroke family (body frame [x, z] of the racket-side foot R and the other foot L, for
 * a right-hander) — the open / closed stances of the padel strokes.
 */
export const STANCES = Object.freeze({
  ready: { R: [0.24, 0.02], L: [-0.24, 0.02] },
  split: { R: [0.3, 0.04], L: [-0.3, 0.04] },
  fh: { R: [0.3, -0.14], L: [-0.1, 0.34] },
  bh: { R: [0.12, 0.34], L: [-0.3, -0.14] },
  oh: { R: [0.22, -0.3], L: [-0.18, 0.24] },
  vfh: { R: [0.24, 0.02], L: [-0.18, 0.24] },
  vbh: { R: [0.2, 0.24], L: [-0.22, 0.0] },
  low: { R: [0.32, 0.0], L: [-0.08, 0.42] },
  serve: { R: [0.28, -0.18], L: [-0.12, 0.26] },
  run: { R: [0.13, 0], L: [-0.13, 0] },
});

const CHANNELS_V = ['g', 'a', 'n'];
const CHANNELS_S = ['turn', 'hip', 'crouch', 'lean', 'jump'];

function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

/** Fresh output object for sampleStroke. */
export function strokeSample() {
  return { g: [0, 0, 0], a: [0, 1, 0], n: [0, 0, 1], turn: 0, hip: 0, crouch: 0, lean: 0, jump: 0, off: [0, 0, 0], offThroat: 1 };
}

/**
 * Samples a stroke at phase (0..1) into out (no allocation). Racket directions are renormalised and
 * the face normal re-orthogonalised to the axis.
 */
export function sampleStroke(keys, phase, out) {
  const ph = phase < 0 ? 0 : phase > 1 ? 1 : phase;
  let i = 0;
  while (i < keys.length - 2 && ph > keys[i + 1].p) i++;
  const k1 = keys[i], k2 = keys[i + 1];
  const k0 = keys[Math.max(0, i - 1)], k3 = keys[Math.min(keys.length - 1, i + 2)];
  const span = Math.max(1e-6, k2.p - k1.p);
  const t = Math.min(1, Math.max(0, (ph - k1.p) / span));
  for (const c of CHANNELS_V) {
    const o = out[c];
    for (let j = 0; j < 3; j++) o[j] = catmull(k0[c][j], k1[c][j], k2[c][j], k3[c][j], t);
  }
  for (const c of CHANNELS_S) out[c] = catmull(k0[c] ?? 0, k1[c] ?? 0, k2[c] ?? 0, k3[c] ?? 0, t);
  normalize3(out.a);
  // n ⟂ a
  const d = out.n[0] * out.a[0] + out.n[1] * out.a[1] + out.n[2] * out.a[2];
  out.n[0] -= out.a[0] * d; out.n[1] -= out.a[1] * d; out.n[2] -= out.a[2] * d;
  normalize3(out.n);
  // Off hand: positions blend; 'throat' keys blend the cradle weight.
  const oa = k1.off === 'throat' ? null : k1.off, ob = k2.off === 'throat' ? null : k2.off;
  const s = t * t * (3 - 2 * t);
  out.offThroat = !oa && !ob ? 1 : !oa ? 1 - s : !ob ? s : 0;
  const A = oa || ob, B = ob || oa;
  if (A) for (let j = 0; j < 3; j++) out.off[j] = A[j] + (B[j] - A[j]) * s;
  out.crouch = Math.min(1, Math.max(0, out.crouch));
  out.jump = Math.max(0, out.jump);
  return out;
}

function normalize3(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  v[0] /= l; v[1] /= l; v[2] /= l;
  return v;
}

/** The ready pose as a stroke sample (racket in front, off hand on the throat). */
export function readySample(out = strokeSample()) {
  out.g[0] = READY.g[0]; out.g[1] = READY.g[1]; out.g[2] = READY.g[2];
  out.a[0] = READY.a[0]; out.a[1] = READY.a[1]; out.a[2] = READY.a[2];
  out.n[0] = READY.n[0]; out.n[1] = READY.n[1]; out.n[2] = READY.n[2];
  normalize3(out.a);
  const d = out.n[0] * out.a[0] + out.n[1] * out.a[1] + out.n[2] * out.a[2];
  out.n[0] -= out.a[0] * d; out.n[1] -= out.a[1] * d; out.n[2] -= out.a[2] * d;
  normalize3(out.n);
  out.turn = 0; out.hip = 0; out.crouch = READY.crouch; out.lean = READY.lean; out.jump = 0; out.offThroat = 1;
  return out;
}
