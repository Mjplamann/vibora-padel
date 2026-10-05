// Shared part helpers for the athlete bake: skeleton names, regions, merging, weights, normals.
import * as V from './vec.mjs';

export const REF_HEIGHT = 1.8;
export const SOLE = 0.024; // m: the shoe sole lifts the body

/** Game skeleton (same order and names as render/humanModel.js BONES). */
export const BONE_NAMES = [
  'root', 'hips', 'spine', 'chest', 'neck', 'head',
  'clavicleR', 'upperArmR', 'foreArmR', 'handR', 'clavicleL', 'upperArmL', 'foreArmL', 'handL',
  'thighR', 'shinR', 'footR', 'toeR', 'thighL', 'shinL', 'footL', 'toeL',
];
export const BONE_PARENT = {
  root: null, hips: 'root', spine: 'hips', chest: 'spine', neck: 'chest', head: 'neck',
  clavicleR: 'chest', upperArmR: 'clavicleR', foreArmR: 'upperArmR', handR: 'foreArmR',
  clavicleL: 'chest', upperArmL: 'clavicleL', foreArmL: 'upperArmL', handL: 'foreArmL',
  thighR: 'hips', shinR: 'thighR', footR: 'shinR', toeR: 'footR', thighL: 'hips', shinL: 'thighL', footL: 'shinL', toeL: 'footL',
};
export const BI = Object.fromEntries(BONE_NAMES.map((n, i) => [n, i]));

export const REGION = Object.freeze({
  SKIN: 0, SHIRT: 1, TRIM: 2, SHORTS: 3, SHORTS_TRIM: 4, SOCK: 5, SHOE: 6, SOLE: 7, SHOE_ACCENT: 8,
  HAIR: 9, HEADWEAR: 10, HEADWEAR_ACCENT: 11, EYE: 12, IRIS: 13, BAND: 14, LACE: 15, PUPIL: 16, BROW: 17, LASH: 18, INNER: 19,
});
export const PART = Object.freeze({ BODY: 0, HEAD: 1, ARMS: 2 });

/** Concatenates parts with the same attribute layout. */
export function mergeParts(parts) {
  const list = parts.filter(Boolean);
  let nv = 0, ni = 0;
  for (const p of list) { nv += p.positions.length / 3; ni += p.index.length; }
  const o = {
    positions: new Float64Array(nv * 3), normals: new Float64Array(nv * 3), uv: new Float64Array(nv * 2), skinIndex: new Uint8Array(nv * 4),
    skinWeight: new Float64Array(nv * 4), region: new Uint8Array(nv), part: new Uint8Array(nv), ao: new Float64Array(nv).fill(1), aux: new Float64Array(nv * 2).fill(1), index: new Uint32Array(ni),
  };
  let ov = 0, oi = 0;
  for (const p of list) {
    const n = p.positions.length / 3;
    o.positions.set(p.positions, ov * 3); o.normals.set(p.normals, ov * 3); o.uv.set(p.uv, ov * 2);
    o.skinIndex.set(p.skinIndex, ov * 4); o.skinWeight.set(p.skinWeight, ov * 4); o.region.set(p.region, ov); o.part.set(p.part, ov);
    if (p.ao) o.ao.set(p.ao, ov);
    if (p.aux) o.aux.set(p.aux, ov * 2);
    for (let i = 0; i < p.index.length; i++) o.index[oi + i] = p.index[i] + ov;
    ov += n; oi += p.index.length;
  }
  return o;
}

/** Game skin weights (top 4, normalized) from a per-vertex weight map getter. */
export function setWeights(part, base, getW) {
  const n = part.positions.length / 3;
  for (let i = 0; i < n; i++) {
    const w = getW(i);
    const list = w ? [...w.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4) : [['root', 1]];
    let sum = 0;
    for (const [, x] of list) sum += x;
    list.forEach(([b, x], k) => { part.skinIndex[i * 4 + k] = BI[b]; part.skinWeight[i * 4 + k] = x / sum; });
  }
}

/** Area-weighted normals, shared across uv seams (by source vertex id when given). */
export function computeNormals(part, src = null) {
  const n = part.positions.length / 3;
  const P = part.positions;
  const keyOf = src ? (i) => src[i] : (i) => i;
  const acc = new Map();
  const I = part.index;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t], b = I[t + 1], c = I[t + 2];
    const ab = [P[b * 3] - P[a * 3], P[b * 3 + 1] - P[a * 3 + 1], P[b * 3 + 2] - P[a * 3 + 2]];
    const ac = [P[c * 3] - P[a * 3], P[c * 3 + 1] - P[a * 3 + 1], P[c * 3 + 2] - P[a * 3 + 2]];
    const fn = V.cross(ab, ac);
    for (const v of [a, b, c]) {
      const k = keyOf(v);
      const o = acc.get(k) || [0, 0, 0];
      o[0] += fn[0]; o[1] += fn[1]; o[2] += fn[2];
      acc.set(k, o);
    }
  }
  part.normals = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    const v = V.norm(acc.get(keyOf(i)) || [0, 1, 0]);
    part.normals[i * 3] = v[0]; part.normals[i * 3 + 1] = v[1]; part.normals[i * 3 + 2] = v[2];
  }
}

