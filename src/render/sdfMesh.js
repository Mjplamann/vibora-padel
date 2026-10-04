// Signed-distance modelling and a narrow-band surface-nets polygonizer (pure: no three, no DOM),
// used to build the smooth procedural humans (render/humanModel.js) once at load time.
//
// A model is a list of primitives plus groups:
//   prim  = sdPrim.ellipsoid(c, r) | roundCone(a, b, ra, rb, { flat, flatAxis }) | roundBox(c, half,
//           round, basis) | sphere(c, r) | torusY(c, R, r), each with { k: blend radius into its
//           group, op: 'add' | 'sub', tag: any }.
//   group = { id, prims: [indices], base?: [indices] (shell groups: smooth union of other prims),
//           inflate?: (x,y,z) => m, clip?: [(x,y,z) => signed distance, > 0 removed], priority }.
// The model SDF is the hard union (min) of its groups; a group is the smooth union of its 'add'
// prims (each blended with its own k) minus its 'sub' prims, grown by `inflate`, cut by `clip`.
// Hard unions of shells (a shirt grown 8 mm over the torso and cut at the hem) give real
// clothing edges; smooth unions give continuous skin over muscles and joints.

const sqrt = Math.sqrt;
const abs = Math.abs;
const max = Math.max;
const min = Math.min;

/** Polynomial smooth minimum (iq): blends a and b over a width k. */
export function smin(a, b, k) {
  if (!(k > 0)) return a < b ? a : b;
  const h = max(k - abs(a - b), 0) / k;
  return min(a, b) - h * h * k * 0.25;
}
/** Smooth maximum. */
export function smax(a, b, k) {
  return -smin(-a, -b, k);
}

function aabbOf(cx, cy, cz, rx, ry, rz) {
  return [cx - rx, cy - ry, cz - rz, cx + rx, cy + ry, cz + rz];
}

/** Primitive constructors. Every primitive carries its AABB (for culling) and a type tag. */
export const sdPrim = {
  sphere(c, r, o = {}) {
    return { type: 0, cx: c[0], cy: c[1], cz: c[2], r, aabb: aabbOf(c[0], c[1], c[2], r, r, r), k: 0, op: 'add', ...o };
  },
  /** Axis-aligned ellipsoid (approximate distance, exact on the surface). */
  ellipsoid(c, r, o = {}) {
    return { type: 1, cx: c[0], cy: c[1], cz: c[2], rx: r[0], ry: r[1], rz: r[2], aabb: aabbOf(c[0], c[1], c[2], r[0], r[1], r[2]), k: 0, op: 'add', ...o };
  },
  /**
   * Capsule with a different radius at each end (iq's round cone). `flat` < 1 squashes the cross
   * section along `flatAxis` (a unit vector perpendicular to a-b): forearms, thighs.
   */
  roundCone(a, b, ra, rb, o = {}) {
    const bax = b[0] - a[0], bay = b[1] - a[1], baz = b[2] - a[2];
    const l2 = bax * bax + bay * bay + baz * baz;
    const rr = ra - rb;
    const R = max(ra, rb);
    const p = {
      type: 2, ax: a[0], ay: a[1], az: a[2], bx: bax, by: bay, bz: baz, l2, rr, a2: l2 - rr * rr, il2: 1 / l2, ra, rb,
      aabb: [min(a[0], b[0]) - R, min(a[1], b[1]) - R, min(a[2], b[2]) - R, max(a[0], b[0]) + R, max(a[1], b[1]) + R, max(a[2], b[2]) + R],
      flat: 1, fx: 0, fy: 0, fz: 0, k: 0, op: 'add', ...o,
    };
    if (o.flat && o.flatAxis) {
      p.flat = o.flat;
      [p.fx, p.fy, p.fz] = o.flatAxis;
    }
    return p;
  },
  /** Rounded box; basis = [x axis, y axis, z axis] unit vectors (default: world axes). */
  roundBox(c, half, round, basis = null, o = {}) {
    const B = basis || [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const R = sqrt(half[0] * half[0] + half[1] * half[1] + half[2] * half[2]);
    return {
      type: 3, cx: c[0], cy: c[1], cz: c[2], hx: half[0], hy: half[1], hz: half[2], round,
      ux: B[0], uy: B[1], uz: B[2], aabb: aabbOf(c[0], c[1], c[2], R, R, R), k: 0, op: 'add', ...o,
    };
  },
  /** Torus around the y axis through c (ring radius R, tube radius r). */
  torusY(c, R, r, o = {}) {
    return { type: 4, cx: c[0], cy: c[1], cz: c[2], R, r, aabb: aabbOf(c[0], c[1], c[2], R + r, r, R + r), k: 0, op: 'add', ...o };
  },
};

/** Distance from (x,y,z) to primitive p (negative inside). */
export function primDist(p, x, y, z) {
  switch (p.type) {
    case 0: {
      const dx = x - p.cx, dy = y - p.cy, dz = z - p.cz;
      return sqrt(dx * dx + dy * dy + dz * dz) - p.r;
    }
    case 1: {
      const px = (x - p.cx), py = (y - p.cy), pz = (z - p.cz);
      const ax = px / p.rx, ay = py / p.ry, az = pz / p.rz;
      const k0 = sqrt(ax * ax + ay * ay + az * az);
      const bx = ax / p.rx, by = ay / p.ry, bz = az / p.rz;
      const k1 = sqrt(bx * bx + by * by + bz * bz);
      if (k1 < 1e-12) return -min(p.rx, p.ry, p.rz);
      return (k0 * (k0 - 1)) / k1;
    }
    case 2: {
      let px = x - p.ax, py = y - p.ay, pz = z - p.az;
      if (p.flat !== 1) {
        const t = px * p.fx + py * p.fy + pz * p.fz;
        const s = t / p.flat - t;
        px += p.fx * s; py += p.fy * s; pz += p.fz * s;
      }
      const l2 = p.l2;
      const y0 = px * p.bx + py * p.by + pz * p.bz;
      const z0 = y0 - l2;
      const qx = px * l2 - p.bx * y0, qy = py * l2 - p.by * y0, qz = pz * l2 - p.bz * y0;
      const x2 = qx * qx + qy * qy + qz * qz;
      const y2 = y0 * y0 * l2;
      const z2 = z0 * z0 * l2;
      const rr = p.rr;
      const k = Math.sign(rr) * rr * rr * x2;
      if (Math.sign(z0) * p.a2 * z2 > k) return sqrt(x2 + z2) * p.il2 - p.rb;
      if (Math.sign(y0) * p.a2 * y2 < k) return sqrt(x2 + y2) * p.il2 - p.ra;
      return (sqrt(x2 * p.a2 * p.il2) + y0 * rr) * p.il2 - p.ra;
    }
    case 3: {
      const dx = x - p.cx, dy = y - p.cy, dz = z - p.cz;
      const qx = abs(dx * p.ux[0] + dy * p.ux[1] + dz * p.ux[2]) - p.hx + p.round;
      const qy = abs(dx * p.uy[0] + dy * p.uy[1] + dz * p.uy[2]) - p.hy + p.round;
      const qz = abs(dx * p.uz[0] + dy * p.uz[1] + dz * p.uz[2]) - p.hz + p.round;
      const ox = max(qx, 0), oy = max(qy, 0), oz = max(qz, 0);
      return sqrt(ox * ox + oy * oy + oz * oz) + min(max(qx, qy, qz), 0) - p.round;
    }
    case 4: {
      const dx = x - p.cx, dy = y - p.cy, dz = z - p.cz;
      const q = sqrt(dx * dx + dz * dz) - p.R;
      return sqrt(q * q + dy * dy) - p.r;
    }
    default:
      return 1e9;
  }
}

/**
 * Compiles a model into an evaluator. Returns { eval(x,y,z, active?) -> d, detail(x,y,z, active?)
 * -> { d, group, owner }, aabb } where `active` is a list of primitive indices to evaluate (the
 * others count as far away) or null for all of them.
 */
export function compileModel({ prims, groups }) {
  const n = prims.length;
  const dist = new Float64Array(n);
  const order = groups.map((g, gi) => ({ g, gi }));
  // Bounding box of everything.
  const aabb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const p of prims) {
    for (let i = 0; i < 3; i++) {
      aabb[i] = min(aabb[i], p.aabb[i]);
      aabb[i + 3] = max(aabb[i + 3], p.aabb[i + 3]);
    }
  }
  const FAR = 1e3;

  /** active: null (all primitives) or an Int32Array/array of primitive indices to evaluate. */
  function fill(x, y, z, active) {
    if (!active) {
      for (let i = 0; i < n; i++) dist[i] = primDist(prims[i], x, y, z);
      return;
    }
    dist.fill(FAR);
    for (let j = 0; j < active.length; j++) {
      const i = active[j];
      dist[i] = primDist(prims[i], x, y, z);
    }
  }

  // Per group: additive and subtractive primitive lists (base list for shells).
  const G = groups.map((g) => {
    const list = g.base || g.prims;
    return {
      g,
      add: Int32Array.from(list.filter((i) => prims[i].op !== 'sub')),
      sub: Int32Array.from(list.filter((i) => prims[i].op === 'sub')),
      extra: g.extra ? Int32Array.from(g.extra) : null,
    };
  });

  function groupDist(gi, x, y, z) {
    const { g, add, sub, extra } = G[gi];
    let d = FAR;
    for (let j = 0; j < add.length; j++) {
      const di = dist[add[j]];
      if (di >= FAR) continue;
      d = d >= FAR ? di : smin(d, di, prims[add[j]].k);
    }
    if (d >= FAR && !extra) return FAR;
    for (let j = 0; j < sub.length; j++) {
      const di = dist[sub[j]];
      if (di >= FAR) continue;
      d = smax(d, -di, prims[sub[j]].k);
    }
    if (g.inflate && d < FAR) d -= g.inflate(x, y, z);
    if (extra) for (let j = 0; j < extra.length; j++) d = min(d, dist[extra[j]]);
    if (g.clip) {
      const kc = g.clipK || 0;
      for (const c of g.clip) d = kc > 0 ? smax(d, c(x, y, z), kc) : max(d, c(x, y, z));
    }
    return d;
  }

  function evalAt(x, y, z, active) {
    fill(x, y, z, active);
    let d = FAR;
    for (let gi = 0; gi < G.length; gi++) {
      const gd = groupDist(gi, x, y, z);
      const k = G[gi].g.unionK || 0;
      d = k > 0 && d < FAR ? smin(d, gd, k) : gd < d ? gd : d;
    }
    return d;
  }

  const detailOut = { d: 0, group: 0, owner: 0 };
  function detail(x, y, z, active = null) {
    fill(x, y, z, active);
    let best = FAR, bestG = 0;
    for (const { g, gi } of order) {
      const gd = groupDist(gi, x, y, z) - (g.priority || 0);
      if (gd < best) {
        best = gd;
        bestG = gi;
      }
    }
    const g = groups[bestG];
    const list = g.ownerFrom || g.base || g.prims;
    let owner = list[0], od = Infinity;
    for (const pi of list) {
      if (prims[pi].op === 'sub' || prims[pi].noOwner) continue;
      if (dist[pi] < od) {
        od = dist[pi];
        owner = pi;
      }
    }
    detailOut.d = best;
    detailOut.group = bestG;
    detailOut.owner = owner;
    return detailOut;
  }

  return { eval: evalAt, detail, aabb, prims, groups, count: n };
}

/**
 * Narrow-band surface nets. Returns { positions: Float32Array, normals: Float32Array,
 * index: Uint32Array, group: Uint8Array, owner: Uint16Array, ao: Float32Array, stats }.
 * opts: { cell (m), pad (m, default 2 cells), aabb override [minx..maxz], ao: true }.
 */
export function polygonize(model, { cell, pad = null, aabb = null, ao = true, band = 2.6 } = {}) {
  const h = cell;
  const P = pad ?? 2 * h;
  const bb = aabb || model.aabb;
  const ox = bb[0] - P, oy = bb[1] - P, oz = bb[2] - P;
  const nx = Math.ceil((bb[3] - bb[0] + 2 * P) / h) + 1;
  const ny = Math.ceil((bb[4] - bb[1] + 2 * P) / h) + 1;
  const nz = Math.ceil((bb[5] - bb[2] + 2 * P) / h) + 1;
  const N = nx * ny * nz;
  const f = new Float32Array(N);
  const done = new Uint8Array(N);
  const idx = (i, j, k) => (k * ny + j) * nx + i;
  const prims = model.prims;
  const np = prims.length;
  let evals = 0;

  // Coarse pass: every B-th point.
  const B = 4;
  const cnx = Math.ceil((nx - 1) / B) + 1, cny = Math.ceil((ny - 1) / B) + 1, cnz = Math.ceil((nz - 1) / B) + 1;
  const cf = new Float32Array(cnx * cny * cnz);
  const cidx = (i, j, k) => (k * cny + j) * cnx + i;
  const fineOf = (c, n) => Math.min(c * B, n - 1);
  for (let k = 0; k < cnz; k++) {
    for (let j = 0; j < cny; j++) {
      for (let i = 0; i < cnx; i++) {
        const fi = fineOf(i, nx), fj = fineOf(j, ny), fk = fineOf(k, nz);
        const d = model.eval(ox + fi * h, oy + fj * h, oz + fk * h, null);
        evals += np;
        cf[cidx(i, j, k)] = d;
        const id = idx(fi, fj, fk);
        f[id] = d;
        done[id] = 1;
      }
    }
  }
  // Max blend radius for culling margins.
  let kMax = 0;
  for (const p of prims) kMax = Math.max(kMax, p.k || 0);
  const diag = B * h * 1.75;
  // Culling margins: blend radii + the block diagonal (sign / distance field), plus the AO reach
  // for the per-vertex passes.
  const marginFine = kMax + diag + h;
  const marginVert = marginFine + (ao ? 0.07 : 0);
  const nBlocks = (cnx - 1) * (cny - 1) * (cnz - 1);
  const blockLists = new Array(nBlocks).fill(null);
  const vertLists = new Array(nBlocks).fill(null);
  const bid = (i, j, k) => (k * (cny - 1) + j) * (cnx - 1) + i;
  const scratch = new Int32Array(np);
  function listFor(i0, i1, j0, j1, k0, k1, margin) {
    const bx0 = ox + i0 * h - margin, bx1 = ox + i1 * h + margin;
    const by0 = oy + j0 * h - margin, by1 = oy + j1 * h + margin;
    const bz0 = oz + k0 * h - margin, bz1 = oz + k1 * h + margin;
    let na = 0;
    for (let q = 0; q < np; q++) {
      const a = prims[q].aabb;
      if (a[0] <= bx1 && a[3] >= bx0 && a[1] <= by1 && a[4] >= by0 && a[2] <= bz1 && a[5] >= bz0) scratch[na++] = q;
    }
    return scratch.slice(0, na);
  }
  /** Active primitive list of the coarse block containing a point. */
  function listAt(x, y, z) {
    const i = Math.min(cnx - 2, Math.max(0, Math.floor((x - ox) / (B * h))));
    const j = Math.min(cny - 2, Math.max(0, Math.floor((y - oy) / (B * h))));
    const k = Math.min(cnz - 2, Math.max(0, Math.floor((z - oz) / (B * h))));
    const b = bid(i, j, k);
    if (!vertLists[b]) vertLists[b] = listFor(fineOf(i, nx), fineOf(i + 1, nx), fineOf(j, ny), fineOf(j + 1, ny), fineOf(k, nz), fineOf(k + 1, nz), marginVert);
    return vertLists[b];
  }
  // Fine pass per coarse block.
  for (let k = 0; k < cnz - 1; k++) {
    for (let j = 0; j < cny - 1; j++) {
      for (let i = 0; i < cnx - 1; i++) {
        let mn = Infinity, sgnPos = 0, sgnNeg = 0;
        for (let c = 0; c < 8; c++) {
          const v = cf[cidx(i + (c & 1), j + ((c >> 1) & 1), k + ((c >> 2) & 1))];
          mn = Math.min(mn, Math.abs(v));
          if (v > 0) sgnPos++; else sgnNeg++;
        }
        const i0 = fineOf(i, nx), i1 = fineOf(i + 1, nx), j0 = fineOf(j, ny), j1 = fineOf(j + 1, ny), k0 = fineOf(k, nz), k1 = fineOf(k + 1, nz);
        if (mn > diag * band / 1.75 && (sgnPos === 0 || sgnNeg === 0)) {
          const fillV = sgnPos ? diag : -diag;
          for (let kk = k0; kk <= k1; kk++) for (let jj = j0; jj <= j1; jj++) for (let ii = i0; ii <= i1; ii++) {
            const id = idx(ii, jj, kk);
            if (!done[id]) { f[id] = fillV; done[id] = 2; }
          }
          continue;
        }
        // Active primitives for this block.
        const b = bid(i, j, k);
        const list = blockLists[b] || (blockLists[b] = listFor(i0, i1, j0, j1, k0, k1, marginFine));
        const na = list.length;
        for (let kk = k0; kk <= k1; kk++) for (let jj = j0; jj <= j1; jj++) for (let ii = i0; ii <= i1; ii++) {
          const id = idx(ii, jj, kk);
          if (done[id] === 1) continue;
          f[id] = na ? model.eval(ox + ii * h, oy + jj * h, oz + kk * h, list) : diag;
          evals += na;
          done[id] = 1;
        }
      }
    }
  }

  // Surface nets: one vertex per cell with a sign change.
  const cx = nx - 1, cy = ny - 1, cz = nz - 1;
  const cellVert = new Int32Array(cx * cy * cz).fill(-1);
  const cid = (i, j, k) => (k * cy + j) * cx + i;
  const pos = [];
  const EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const cv = new Float64Array(8);
  for (let k = 0; k < cz; k++) {
    for (let j = 0; j < cy; j++) {
      for (let i = 0; i < cx; i++) {
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          const v = f[idx(i + (c & 1), j + ((c >> 1) & 1), k + ((c >> 2) & 1))];
          cv[c] = v;
          if (v < 0) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;
        let sx = 0, sy = 0, sz = 0, cnt = 0;
        for (const [a, b] of EDGES) {
          const va = cv[a], vb = cv[b];
          if ((va < 0) === (vb < 0)) continue;
          const t = va / (va - vb);
          const ax = a & 1, ay = (a >> 1) & 1, az = (a >> 2) & 1;
          const bx = b & 1, by = (b >> 1) & 1, bz = (b >> 2) & 1;
          sx += ax + (bx - ax) * t;
          sy += ay + (by - ay) * t;
          sz += az + (bz - az) * t;
          cnt++;
        }
        cellVert[cid(i, j, k)] = pos.length / 3;
        pos.push(ox + (i + sx / cnt) * h, oy + (j + sy / cnt) * h, oz + (k + sz / cnt) * h);
      }
    }
  }
  // Quads around every grid edge with a sign change.
  const tris = [];
  const quad = (a, b, c, d, flip) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) tris.push(a, d, c, a, c, b);
    else tris.push(a, b, c, a, c, d);
  };
  // Each grid edge is shared by 4 cells (cyclic order around the edge; winding is fixed below).
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const in0 = f[idx(i, j, k)] < 0;
        if (i < cx && j >= 1 && j < cy && k >= 1 && k < cz && in0 !== (f[idx(i + 1, j, k)] < 0)) {
          quad(cellVert[cid(i, j - 1, k - 1)], cellVert[cid(i, j, k - 1)], cellVert[cid(i, j, k)], cellVert[cid(i, j - 1, k)], in0);
        }
        if (j < cy && i >= 1 && i < cx && k >= 1 && k < cz && in0 !== (f[idx(i, j + 1, k)] < 0)) {
          quad(cellVert[cid(i - 1, j, k - 1)], cellVert[cid(i - 1, j, k)], cellVert[cid(i, j, k)], cellVert[cid(i, j, k - 1)], in0);
        }
        if (k < cz && i >= 1 && i < cx && j >= 1 && j < cy && in0 !== (f[idx(i, j, k + 1)] < 0)) {
          quad(cellVert[cid(i - 1, j - 1, k)], cellVert[cid(i, j - 1, k)], cellVert[cid(i, j, k)], cellVert[cid(i - 1, j, k)], in0);
        }
      }
    }
  }

  // Refine vertices onto the surface and take the SDF gradient as the normal.
  const nv = pos.length / 3;
  const positions = new Float32Array(pos);
  const normals = new Float32Array(nv * 3);
  const group = new Uint8Array(nv);
  const owner = new Uint16Array(nv);
  const e = h * 0.5;
  let cur = null;
  const ev = (x, y, z) => model.eval(x, y, z, cur);
  for (let v = 0; v < nv; v++) {
    let x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2];
    cur = listAt(x, y, z);
    let gx = 0, gy = 0, gz = 1;
    for (let it = 0; it < 2; it++) {
      const d = ev(x, y, z);
      gx = ev(x + e, y, z) - ev(x - e, y, z);
      gy = ev(x, y + e, z) - ev(x, y - e, z);
      gz = ev(x, y, z + e) - ev(x, y, z - e);
      const g2 = gx * gx + gy * gy + gz * gz;
      if (!(g2 > 1e-14)) break;
      const s = (d * 2 * e) / g2; // gradient is (gx,gy,gz) / (2e)
      let mx = gx * s, my = gy * s, mz = gz * s;
      const ml = sqrt(mx * mx + my * my + mz * mz);
      if (ml > h * 0.6) {
        const r = (h * 0.6) / ml;
        mx *= r; my *= r; mz *= r;
      }
      x -= mx; y -= my; z -= mz;
      evals += 7 * cur.length;
    }
    const gl = sqrt(gx * gx + gy * gy + gz * gz) || 1;
    positions[v * 3] = x; positions[v * 3 + 1] = y; positions[v * 3 + 2] = z;
    normals[v * 3] = gx / gl; normals[v * 3 + 1] = gy / gl; normals[v * 3 + 2] = gz / gl;
    const dt = model.detail(x, y, z, cur);
    group[v] = dt.group;
    owner[v] = dt.owner;
  }
  // Consistent outward winding (the gradient decides).
  const index = new Uint32Array(tris.length);
  let w = 0;
  for (let t = 0; t < tris.length; t += 3) {
    let a = tris[t], b = tris[t + 1], c = tris[t + 2];
    const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
    const ux = positions[b * 3] - ax, uy = positions[b * 3 + 1] - ay, uz = positions[b * 3 + 2] - az;
    const vx = positions[c * 3] - ax, vy = positions[c * 3 + 1] - ay, vz = positions[c * 3 + 2] - az;
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    const fl2 = fx * fx + fy * fy + fz * fz;
    if (!(fl2 > 1e-18)) continue; // degenerate
    const nxs = normals[a * 3] + normals[b * 3] + normals[c * 3];
    const nys = normals[a * 3 + 1] + normals[b * 3 + 1] + normals[c * 3 + 1];
    const nzs = normals[a * 3 + 2] + normals[b * 3 + 2] + normals[c * 3 + 2];
    if (fx * nxs + fy * nys + fz * nzs < 0) { const tmp = b; b = c; c = tmp; }
    index[w++] = a; index[w++] = b; index[w++] = c;
  }
  // Baked ambient occlusion from the SDF along the normal (armpits, crotch, under the chin).
  const aoArr = new Float32Array(nv).fill(1);
  if (ao) {
    const H = [0.015, 0.035, 0.065];
    const W = [0.5, 0.32, 0.18];
    for (let v = 0; v < nv; v++) {
      const x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2];
      const a = normals[v * 3], b = normals[v * 3 + 1], c = normals[v * 3 + 2];
      cur = listAt(x, y, z);
      let occ = 0;
      for (let s = 0; s < H.length; s++) {
        const d = ev(x + a * H[s], y + b * H[s], z + c * H[s]);
        occ += W[s] * Math.max(0, (H[s] - d) / H[s]);
      }
      evals += 4 * cur.length;
      aoArr[v] = Math.max(0.35, 1 - occ * 0.9);
    }
  }
  return {
    positions, normals, index: index.slice(0, w), group, owner, ao: aoArr,
    stats: { vertices: nv, triangles: w / 3, grid: [nx, ny, nz], evals },
  };
}
