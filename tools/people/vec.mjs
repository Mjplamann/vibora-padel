// Small vector / matrix helpers for the athlete bake (plain arrays, pure).
export const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a) => Math.hypot(a[0], a[1], a[2]);
export const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const mean = (list) => { const o = [0, 0, 0]; for (const p of list) { o[0] += p[0]; o[1] += p[1]; o[2] += p[2]; } return scale(o, 1 / list.length); };
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };

/** 3x4 affine matrices as flat arrays [r00 r01 r02 tx, r10 r11 r12 ty, r20 r21 r22 tz]. */
export const IDENT = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
export function mul(A, B) {
  const o = new Array(12);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      o[r * 4 + c] = A[r * 4] * B[c] + A[r * 4 + 1] * B[4 + c] + A[r * 4 + 2] * B[8 + c] + (c === 3 ? A[r * 4 + 3] : 0);
    }
  }
  return o;
}
export const apply = (M, p) => [
  M[0] * p[0] + M[1] * p[1] + M[2] * p[2] + M[3],
  M[4] * p[0] + M[5] * p[1] + M[6] * p[2] + M[7],
  M[8] * p[0] + M[9] * p[1] + M[10] * p[2] + M[11],
];
export const applyDir = (M, d) => [M[0] * d[0] + M[1] * d[1] + M[2] * d[2], M[4] * d[0] + M[5] * d[1] + M[6] * d[2], M[8] * d[0] + M[9] * d[1] + M[10] * d[2]];
/** Rotation about a unit axis through point c by angle a. */
export function rotAbout(axis, a, c) {
  const [x, y, z] = norm(axis);
  const s = Math.sin(a), k = Math.cos(a), t = 1 - k;
  const R = [t * x * x + k, t * x * y - s * z, t * x * z + s * y, 0, t * x * y + s * z, t * y * y + k, t * y * z - s * x, 0, t * x * z - s * y, t * y * z + s * x, t * z * z + k, 0];
  const rc = apply(R, c);
  R[3] = c[0] - rc[0]; R[7] = c[1] - rc[1]; R[11] = c[2] - rc[2];
  return R;
}
/** Basis matrix from columns X, Y, Z and origin O (maps local -> world). */
export const basis = (X, Y, Z, O = [0, 0, 0]) => [X[0], Y[0], Z[0], O[0], X[1], Y[1], Z[1], O[1], X[2], Y[2], Z[2], O[2]];
export function invRigid(M) {
  const R = [M[0], M[4], M[8], 0, M[1], M[5], M[9], 0, M[2], M[6], M[10], 0];
  const t = apply(R, [M[3], M[7], M[11]]);
  R[3] = -t[0]; R[7] = -t[1]; R[11] = -t[2];
  return R;
}
