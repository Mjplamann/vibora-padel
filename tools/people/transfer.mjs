// Skin-weight transfer for the clothing shells and a posed poke-through test.
//
// A shell vertex starts as a copy of a body vertex, but the drape (Taubin smoothing, the membrane
// over hollows, the outline smoothing, the hanging hem) slides it along the body by up to a few
// centimetres. Keeping its source vertex's weights then lets the skin right under it follow other
// bones, and in a pose (arms forward, a crouch, the head turned) that skin pushes through the cloth.
// transferWeights() gives every shell vertex the weights of the closest point of the skin under it
// (barycentric blend of the triangle's corners), so cloth and the skin beneath move as one.
import * as V from './vec.mjs';
import { BONE_NAMES, BONE_PARENT, BI } from './parts.mjs';

/** Triangles of the given body faces (MakeHuman ids) in a uniform grid. */
export function bodySurface(base, faces, cell = 0.04) {
  const pos = base.posed;
  const p = (i) => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
  const tris = [];
  for (const f of faces) {
    const v = f.v;
    tris.push([v[0], v[1], v[2]]);
    if (v.length === 4) tris.push([v[0], v[2], v[3]]);
  }
  const data = tris.map((t) => {
    const a = p(t[0]), b = p(t[1]), c = p(t[2]);
    return { t, a, b, c, n: V.norm(V.cross(V.sub(b, a), V.sub(c, a))) };
  });
  const grid = new Map();
  const key = (x, y, z) => `${x},${y},${z}`;
  data.forEach((d, k) => {
    const lo = [0, 1, 2].map((ax) => Math.floor(Math.min(d.a[ax], d.b[ax], d.c[ax]) / cell));
    const hi = [0, 1, 2].map((ax) => Math.floor(Math.max(d.a[ax], d.b[ax], d.c[ax]) / cell));
    for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) {
      const kk = key(x, y, z);
      let l = grid.get(kk);
      if (!l) grid.set(kk, (l = []));
      l.push(k);
    }
  });
  return { data, grid, cell, key };
}

/** Closest point on triangle abc to p: barycentric [u, v, w] (p ~ u a + v b + w c). */
function closestBary(p, a, b, c) {
  const ab = V.sub(b, a), ac = V.sub(c, a), ap = V.sub(p, a);
  const d1 = V.dot(ab, ap), d2 = V.dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return [1, 0, 0];
  const bp = V.sub(p, b);
  const d3 = V.dot(ab, bp), d4 = V.dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return [0, 1, 0];
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return [1 - v, v, 0]; }
  const cp = V.sub(p, c);
  const d5 = V.dot(ab, cp), d6 = V.dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return [0, 0, 1];
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return [1 - w, 0, w]; }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / (d4 - d3 + (d5 - d6)); return [0, 1 - w, w]; }
  const den = 1 / (va + vb + vc);
  const v = vb * den, w = vc * den;
  return [1 - v - w, v, w];
}

/**
 * Closest skin point to p whose triangle faces the same way as n (dot > minDot), within maxDist.
 * @returns {{ t: number[], bary: number[], dist: number } | null}
 */
export function closestOnSurface(S, p, n, { maxDist = 0.08, minDot = 0.15 } = {}) {
  const r = Math.ceil(maxDist / S.cell);
  const cx = Math.floor(p[0] / S.cell), cy = Math.floor(p[1] / S.cell), cz = Math.floor(p[2] / S.cell);
  let best = null, bd = maxDist * maxDist;
  const seen = new Set();
  for (let x = cx - r; x <= cx + r; x++) for (let y = cy - r; y <= cy + r; y++) for (let z = cz - r; z <= cz + r; z++) {
    const l = S.grid.get(S.key(x, y, z));
    if (!l) continue;
    for (const k of l) {
      if (seen.has(k)) continue;
      seen.add(k);
      const d = S.data[k];
      if (n && V.dot(d.n, n) < minDot) continue;
      const bc = closestBary(p, d.a, d.b, d.c);
      const q = [0, 1, 2].map((ax) => bc[0] * d.a[ax] + bc[1] * d.b[ax] + bc[2] * d.c[ax]);
      const e = V.sub(p, q);
      const dd = V.dot(e, e);
      if (dd < bd) { bd = dd; best = { t: d.t, bary: bc, dist: Math.sqrt(dd) }; }
    }
  }
  return best;
}

/**
 * Re-weights a shell part (positions, normals, src) from the skin under each vertex. Vertices with
 * no skin in reach keep their source vertex's weights.
 * @returns {{ moved: number, kept: number }}
 */
export function transferWeights(part, S, base, opts = {}) {
  const n = part.positions.length / 3;
  let moved = 0, kept = 0;
  for (let i = 0; i < n; i++) {
    const p = [part.positions[i * 3], part.positions[i * 3 + 1], part.positions[i * 3 + 2]];
    const nn = part.normals ? [part.normals[i * 3], part.normals[i * 3 + 1], part.normals[i * 3 + 2]] : null;
    const hit = closestOnSurface(S, p, nn, opts);
    if (!hit) { kept++; continue; }
    const acc = new Map();
    hit.t.forEach((vi, k) => {
      const w = base.gameW[vi];
      if (!w || hit.bary[k] <= 0) return;
      for (const [b, x] of w) acc.set(b, (acc.get(b) || 0) + x * hit.bary[k]);
    });
    const list = [...acc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
    let sum = 0;
    for (const [, x] of list) sum += x;
    if (!(sum > 0)) { kept++; continue; }
    part.skinIndex.fill(0, i * 4, i * 4 + 4);
    part.skinWeight.fill(0, i * 4, i * 4 + 4);
    list.forEach(([b, x], k) => { part.skinIndex[i * 4 + k] = BI[b]; part.skinWeight[i * 4 + k] = x / sum; });
    moved++;
  }
  return { moved, kept };
}

/** Triangles of a part (its own positions and skin weights) in a uniform grid. */
export function partSurface(part, cell = 0.04) {
  const P = part.positions, I = part.index;
  const p = (i) => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
  const data = [];
  for (let k = 0; k < I.length; k += 3) {
    const t = [I[k], I[k + 1], I[k + 2]];
    const a = p(t[0]), b = p(t[1]), c = p(t[2]);
    const cr = V.cross(V.sub(b, a), V.sub(c, a));
    if (V.len(cr) < 1e-12) continue;
    data.push({ t, a, b, c, n: V.norm(cr) });
  }
  const grid = new Map();
  const key = (x, y, z) => `${x},${y},${z}`;
  data.forEach((d, k) => {
    const lo = [0, 1, 2].map((ax) => Math.floor(Math.min(d.a[ax], d.b[ax], d.c[ax]) / cell));
    const hi = [0, 1, 2].map((ax) => Math.floor(Math.max(d.a[ax], d.b[ax], d.c[ax]) / cell));
    for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) {
      const kk = key(x, y, z);
      let l = grid.get(kk);
      if (!l) grid.set(kk, (l = []));
      l.push(k);
    }
  });
  const weights = (i) => {
    const m = new Map();
    for (let k = 0; k < 4; k++) {
      const w = part.skinWeight[i * 4 + k];
      if (w > 0) m.set(BONE_NAMES[part.skinIndex[i * 4 + k]], w);
    }
    return m;
  };
  return { data, grid, cell, key, weights };
}

/**
 * Upper layer over a lower one (the shirt's hem over the shorts): the vertices `amount(i)` > 0 take
 * that share of the weights of the closest point of the lower layer, so both layers bend together
 * where they overlap.
 */
export function followLayer(part, lower, amount, opts = {}) {
  const n = part.positions.length / 3;
  let moved = 0;
  for (let i = 0; i < n; i++) {
    const a = amount(i);
    if (!(a > 0)) continue;
    const p = [part.positions[i * 3], part.positions[i * 3 + 1], part.positions[i * 3 + 2]];
    const nn = part.normals ? [part.normals[i * 3], part.normals[i * 3 + 1], part.normals[i * 3 + 2]] : null;
    const hit = closestOnSurface(lower, p, nn, opts);
    if (!hit) continue;
    const acc = new Map();
    for (let k = 0; k < 4; k++) {
      const w = part.skinWeight[i * 4 + k];
      if (w > 0) acc.set(BONE_NAMES[part.skinIndex[i * 4 + k]], w * (1 - a));
    }
    hit.t.forEach((vi, k) => {
      if (hit.bary[k] <= 0) return;
      for (const [b, x] of lower.weights(vi)) acc.set(b, (acc.get(b) || 0) + x * hit.bary[k] * a);
    });
    const list = [...acc.entries()].sort((x, y) => y[1] - x[1]).slice(0, 4);
    let sum = 0;
    for (const [, x] of list) sum += x;
    if (!(sum > 0)) continue;
    part.skinIndex.fill(0, i * 4, i * 4 + 4);
    part.skinWeight.fill(0, i * 4, i * 4 + 4);
    list.forEach(([b, x], k) => { part.skinIndex[i * 4 + k] = BI[b]; part.skinWeight[i * 4 + k] = x / sum; });
    moved++;
  }
  return moved;
}

// ------------------------------------------------------------------ posed poke-through test

/** World matrices of the game bones for local rotations given as { bone: [axis, deg] } (bind frame). */
export function poseMatrices(P, rot) {
  const M = {};
  for (const b of BONE_NAMES) {
    const parent = BONE_PARENT[b] ? M[BONE_PARENT[b]] : V.IDENT();
    const r = rot[b];
    const local = r ? r.reduce((acc, [axis, deg]) => V.mul(acc, V.rotAbout(axis, (deg * Math.PI) / 180, P[b])), V.IDENT()) : V.IDENT();
    M[b] = V.mul(parent, local);
  }
  return BONE_NAMES.map((b) => M[b]);
}

/** Linear blend skinning of a part's positions and normals. */
export function skinPart(part, mats) {
  const n = part.positions.length / 3;
  const pos = new Float64Array(n * 3), nrm = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    const M = new Array(12).fill(0);
    for (let k = 0; k < 4; k++) {
      const w = part.skinWeight[i * 4 + k];
      if (!w) continue;
      const B = mats[part.skinIndex[i * 4 + k]];
      for (let e = 0; e < 12; e++) M[e] += B[e] * w;
    }
    const p = V.apply(M, [part.positions[i * 3], part.positions[i * 3 + 1], part.positions[i * 3 + 2]]);
    pos.set(p, i * 3);
    if (part.normals) nrm.set(V.norm(V.applyDir(M, [part.normals[i * 3], part.normals[i * 3 + 1], part.normals[i * 3 + 2]])), i * 3);
  }
  return { pos, nrm };
}

/** Test poses in the bind frame (x = the body's left, y up, z forward): ready stance, a forehand, a reach. */
export const TEST_POSES = {
  bind: {},
  ready: {
    hips: [[[0, 1, 0], 10]], spine: [[[1, 0, 0], 8]], chest: [[[1, 0, 0], 8]], neck: [[[1, 0, 0], 14], [[0, 1, 0], 25]], head: [[[1, 0, 0], 8]],
    clavicleR: [[[0, 1, 0], -14], [[0, 0, 1], -8]], clavicleL: [[[0, 1, 0], 14], [[0, 0, 1], 8]],
    upperArmR: [[[1, 0, 0], -55], [[0, 1, 0], -30]], upperArmL: [[[1, 0, 0], -55], [[0, 1, 0], 30]],
    foreArmR: [[[1, 0, 0], -80]], foreArmL: [[[1, 0, 0], -80]],
    thighR: [[[1, 0, 0], -40], [[0, 0, 1], -8]], thighL: [[[1, 0, 0], -40], [[0, 0, 1], 8]],
    shinR: [[[1, 0, 0], 70]], shinL: [[[1, 0, 0], 70]], footR: [[[1, 0, 0], -30]], footL: [[[1, 0, 0], -30]],
  },
  forehand: {
    hips: [[[0, 1, 0], 30]], spine: [[[0, 1, 0], 15], [[1, 0, 0], 10]], chest: [[[0, 1, 0], 15]], neck: [[[0, 1, 0], -35], [[1, 0, 0], 10]],
    clavicleR: [[[0, 1, 0], 18], [[0, 0, 1], 10]],
    upperArmR: [[[0, 0, 1], 50], [[0, 1, 0], 40]], foreArmR: [[[1, 0, 0], -40]],
    upperArmL: [[[1, 0, 0], -80], [[0, 1, 0], 40]], clavicleL: [[[0, 1, 0], 18]],
    thighR: [[[1, 0, 0], -25]], shinR: [[[1, 0, 0], 40]], thighL: [[[1, 0, 0], 20]], shinL: [[[1, 0, 0], 30]],
  },
  overhead: {
    spine: [[[1, 0, 0], -10]], chest: [[[1, 0, 0], -8]], neck: [[[1, 0, 0], -25]],
    clavicleR: [[[0, 0, 1], 20]], upperArmR: [[[0, 0, 1], 110]], foreArmR: [[[1, 0, 0], -60]],
    clavicleL: [[[0, 0, 1], -15]], upperArmL: [[[0, 0, 1], -100]],
    thighR: [[[1, 0, 0], -15]], thighL: [[[1, 0, 0], -15]],
  },
};

/**
 * Counts visible skin vertices that end up outside a shell (poke-through) and lower-layer shell
 * vertices that end up outside the upper one, in each test pose.
 * @param {object} body trimmed skin part (positions, normals, index, skinIndex, skinWeight)
 * @param {object[]} shells [shirt, shorts]
 */
export function pokeTest(base, body, shells, { margin = 0.001 } = {}) {
  const used = [...new Set(body.index)];
  const n1 = shells.length > 1 ? shells[1].positions.length / 3 : 0;
  const flagsFor = (rot) => {
    const mats = poseMatrices(base.P, rot);
    const B = skinPart(body, mats);
    const Sh = shells.map((s) => skinPart(s, mats));
    const grids = Sh.map((s, si) => {
      const g = new Map();
      const n = shells[si].positions.length / 3;
      for (let i = 0; i < n; i++) {
        const k = `${Math.floor(s.pos[i * 3] / 0.03)},${Math.floor(s.pos[i * 3 + 1] / 0.03)},${Math.floor(s.pos[i * 3 + 2] / 0.03)}`;
        let l = g.get(k);
        if (!l) g.set(k, (l = []));
        l.push(i);
      }
      return g;
    });
    const nearest = (si, p) => {
      const s = Sh[si], g = grids[si];
      const cx = Math.floor(p[0] / 0.03), cy = Math.floor(p[1] / 0.03), cz = Math.floor(p[2] / 0.03);
      let best = -1, bd = 0.03 * 0.03;
      for (let x = cx - 1; x <= cx + 1; x++) for (let y = cy - 1; y <= cy + 1; y++) for (let z = cz - 1; z <= cz + 1; z++) {
        for (const i of g.get(`${x},${y},${z}`) || []) {
          const d = (s.pos[i * 3] - p[0]) ** 2 + (s.pos[i * 3 + 1] - p[1]) ** 2 + (s.pos[i * 3 + 2] - p[2]) ** 2;
          if (d < bd) { bd = d; best = i; }
        }
      }
      return best;
    };
    // Signed height over the nearest shell vertex's tangent plane (null: no shell surface there).
    const height = (si, p, pn) => {
      const i = nearest(si, p);
      if (i < 0) return null;
      const s = Sh[si];
      const n = [s.nrm[i * 3], s.nrm[i * 3 + 1], s.nrm[i * 3 + 2]];
      if (pn && V.dot(n, pn) < 0.3) return null; // another surface (the rim folding in)
      return V.dot(V.sub(p, [s.pos[i * 3], s.pos[i * 3 + 1], s.pos[i * 3 + 2]]), n);
    };
    const skin = used.map((i) => {
      const p = [B.pos[i * 3], B.pos[i * 3 + 1], B.pos[i * 3 + 2]];
      const n = [B.nrm[i * 3], B.nrm[i * 3 + 1], B.nrm[i * 3 + 2]];
      let h = -1;
      shells.forEach((_, si) => { const x = height(si, p, n); if (x !== null) h = Math.max(h, x); });
      return h;
    });
    const layer = [];
    for (let i = 0; i < n1; i++) {
      const s1 = Sh[1];
      const x = height(0, [s1.pos[i * 3], s1.pos[i * 3 + 1], s1.pos[i * 3 + 2]], [s1.nrm[i * 3], s1.nrm[i * 3 + 1], s1.nrm[i * 3 + 2]]);
      layer.push(x === null ? -1 : x);
    }
    return { skin, layer };
  };
  // Only what a pose pushes out counts (the skin around an opening is outside the shell already).
  const bind = flagsFor({});
  const out = {};
  for (const [name, rot] of Object.entries(TEST_POSES)) {
    if (name === 'bind') continue;
    const f = flagsFor(rot);
    let skin = 0, deep = 0, layer = 0;
    const where = {};
    f.skin.forEach((h, k) => {
      if (h > margin && bind.skin[k] <= margin) {
        skin++;
        deep = Math.max(deep, h);
        const b = BONE_NAMES[body.skinIndex[used[k] * 4]];
        where[b] = (where[b] || 0) + 1;
      }
    });
    f.layer.forEach((h, k) => { if (h > margin && bind.layer[k] <= margin) layer++; });
    out[name] = { skin, deepMm: +(deep * 1000).toFixed(1), layer, where };
  }
  return out;
}
