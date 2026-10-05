// MakeHuman proxies (eyes, eyebrows, eyelashes, hair) fitted to a baked body: every proxy vertex is
// a barycentric blend of three body vertices plus an offset (MakeHuman .mhclo fitting, exported to
// JSON by makehuman-data), so the proxies follow the morphed, finger-posed body. Skin weights blend
// the three reference vertices' game weights.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { computeNormals } from './parts.mjs';

/**
 * Proxy sets. slot: texture slot in the hair atlas (textures.mjs); region: REGION key.
 * lod1: simplification ratio for an LOD1 copy (hair).
 */
export const PROXY_SETS = {
  face: [
    { id: 'eyes', path: 'proxies/eyes/HighPolyEyes/HighPolyEyes.json', slot: 'eye', region: 'EYE' },
    { id: 'brows', path: 'proxies/eyebrows/eyebrow010/eyebrow010.json', slot: 'brow', region: 'BROW' },
    { id: 'lashes', path: 'proxies/eyelashes/Eyelashes01/Eyelashes01.json', slot: 'lash', region: 'LASH' },
  ],
  eyesLow: { id: 'eyesLow', path: 'proxies/eyes/Low-Poly/Low-Poly.json', slot: 'eye', region: 'EYE' },
  hair: [
    // bodies: the bodies a style is baked for (the runtime maps other requests to the nearest one).
    { id: 'short', path: 'proxies/hair/short02/short02.json', slot: 'short02', region: 'HAIR', lod1: 0.3, bodies: ['male'] },
    { id: 'crop', path: 'proxies/hair/short04/short04.json', slot: 'short04', region: 'HAIR', lod1: 0.45, bodies: ['male'] },
    { id: 'medium', path: 'proxies/hair/short03/short03.json', slot: 'short03', region: 'HAIR', lod1: 0.35, bodies: ['male', 'female'] },
    { id: 'ponytail', path: 'proxies/hair/ponytail01/ponytail01.json', slot: 'ponytail01', region: 'HAIR', lod1: 0.25, bodies: ['female'] },
    { id: 'bob', path: 'proxies/hair/bob02/bob02.json', slot: 'bob02', region: 'HAIR', lod1: 0.3, bodies: ['female'] },
    { id: 'afro', path: 'proxies/hair/afro01/afro01.json', slot: 'afro01', region: 'HAIR', lod1: 0.3, bodies: ['male'] },
  ],
};

/** Decodes three.js JSON format-3 faces into polygons { v: [..], uv: [..] }. */
export function decodeFaces(F) {
  const out = [];
  let i = 0;
  while (i < F.length) {
    const t = F[i++];
    const nv = t & 1 ? 4 : 3;
    const v = F.slice(i, i + nv); i += nv;
    if (t & 2) i += 1;
    if (t & 4) i += 1;
    let uv = null;
    if (t & 8) { uv = F.slice(i, i + nv); i += nv; }
    if (t & 16) i += 1;
    if (t & 32) i += nv;
    if (t & 64) i += 1;
    if (t & 128) i += nv;
    out.push({ v, uv });
  }
  return out;
}

/**
 * Fits proxy `set` to `base` (posed body positions). Returns a part (positions, normals, uv in
 * the hair atlas, game weights, region, part HEAD) or null when the file is missing.
 */
export function fitProxy(base, npm, set, textures, { REGION, PART, BI }) {
  const file = join(npm, set.path);
  if (!existsSync(file)) return null;
  const d = JSON.parse(readFileSync(file, 'utf8'));
  const P = base.posed;
  const nP = d.ref_vIdxs.length;
  const pos = new Float64Array(nP * 3);
  const weights = [];
  for (let i = 0; i < nP; i++) {
    const r = d.ref_vIdxs[i], w = d.weights[i], o = d.offsets[i];
    for (let k = 0; k < 3; k++) pos[i * 3 + k] = w[0] * P[r[0] * 3 + k] + w[1] * P[r[1] * 3 + k] + w[2] * P[r[2] * 3 + k] + o[k] * base.s;
    const acc = new Map();
    for (let j = 0; j < 3; j++) {
      const g = base.gameW[r[j]];
      if (!g) continue;
      for (const [b, x] of g) acc.set(b, (acc.get(b) || 0) + x * Math.max(0, w[j]));
    }
    weights.push(acc);
  }
  const uvSrc = d.uvs[0];
  const faces = decodeFaces(d.faces);
  const key = new Map();
  const src = [], uvs = [], idx = [];
  for (const f of faces) {
    const c = f.v.map((vi, k) => {
      const ti = f.uv ? f.uv[k] : -1;
      const kk = `${vi}/${ti}`;
      let o = key.get(kk);
      if (o === undefined) {
        o = src.length;
        key.set(kk, o);
        src.push(vi);
        const u = ti >= 0 ? uvSrc[ti * 2] : 0, v = ti >= 0 ? uvSrc[ti * 2 + 1] : 0;
        const a = textures.slotUV(set.slot, u, v);
        uvs.push(a[0], a[1]);
      }
      return o;
    });
    idx.push(c[0], c[1], c[2]);
    if (c.length === 4) idx.push(c[0], c[2], c[3]);
  }
  const n = src.length;
  const part = {
    positions: new Float64Array(n * 3), uv: Float64Array.from(uvs), index: Uint32Array.from(idx),
    region: new Uint8Array(n).fill(REGION[set.region]), part: new Uint8Array(n).fill(PART.HEAD),
    skinIndex: new Uint8Array(n * 4), skinWeight: new Float64Array(n * 4), aux: new Float64Array(n * 2).fill(1),
  };
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) part.positions[i * 3 + k] = pos[src[i] * 3 + k];
  for (let i = 0; i < n; i++) {
    const list = [...weights[src[i]].entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
    let sum = 0;
    for (const [, x] of list) sum += x;
    if (!list.length || sum <= 0) { part.skinIndex[i * 4] = BI.head; part.skinWeight[i * 4] = 1; continue; }
    list.forEach(([b, x], k) => { part.skinIndex[i * 4 + k] = BI[b]; part.skinWeight[i * 4 + k] = x / sum; });
  }
  computeNormals(part, Int32Array.from(src));
  // Hair: aux.x = 0 at the roots .. 1 at the tips (by distance from the scalp), for a root shade.
  return part;
}
