// Per-vertex ambient occlusion for a baked part: rays over the hemisphere around each vertex normal,
// marched through a voxel occupancy grid of the part's own triangles (armpits, under the chin, the
// crotch, between fingers, inside the collar). Pure, deterministic.
const DIRS = (() => {
  // 28 fixed directions (Fibonacci sphere); the hemisphere is picked per vertex.
  const out = [];
  const n = 56;
  for (let i = 0; i < n; i++) {
    const y = 1 - (i + 0.5) * (2 / n);
    const r = Math.sqrt(1 - y * y);
    const a = i * Math.PI * (3 - Math.sqrt(5));
    out.push([Math.cos(a) * r, y, Math.sin(a) * r]);
  }
  return out;
})();

export function bakeAO(part, { voxel = 0.008, reach = 0.12, strength = 1, exclude = null } = {}) {
  const P = part.positions, N = part.normals, I = part.index;
  const nv = P.length / 3;
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < nv; i++) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], P[i * 3 + k]); mx[k] = Math.max(mx[k], P[i * 3 + k]); }
  mn = mn.map((x) => x - reach); mx = mx.map((x) => x + reach);
  const dim = mn.map((x, k) => Math.ceil((mx[k] - x) / voxel) + 1);
  const grid = new Uint8Array(dim[0] * dim[1] * dim[2]);
  const cell = (x, y, z) => {
    const i = Math.floor((x - mn[0]) / voxel), j = Math.floor((y - mn[1]) / voxel), k = Math.floor((z - mn[2]) / voxel);
    if (i < 0 || j < 0 || k < 0 || i >= dim[0] || j >= dim[1] || k >= dim[2]) return -1;
    return (k * dim[1] + j) * dim[0] + i;
  };
  // Rasterize triangles by dense sampling (step < voxel / 2).
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const e = Math.max(Math.hypot(P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]), Math.hypot(P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]), Math.hypot(P[c] - P[b], P[c + 1] - P[b + 1], P[c + 2] - P[b + 2]));
    const steps = Math.max(1, Math.ceil(e / (voxel * 0.5)));
    for (let u = 0; u <= steps; u++) {
      for (let v = 0; v <= steps - u; v++) {
        const s = u / steps, r = v / steps, q = 1 - s - r;
        const id = cell(P[a] * q + P[b] * s + P[c] * r, P[a + 1] * q + P[b + 1] * s + P[c + 1] * r, P[a + 2] * q + P[b + 2] * s + P[c + 2] * r);
        if (id >= 0) grid[id] = 1;
      }
    }
  }
  const ao = new Float64Array(nv);
  const steps = Math.ceil(reach / (voxel * 0.7));
  for (let i = 0; i < nv; i++) {
    if (exclude && exclude(i)) { ao[i] = 1; continue; }
    const px = P[i * 3], py = P[i * 3 + 1], pz = P[i * 3 + 2];
    const nx = N[i * 3], ny = N[i * 3 + 1], nz = N[i * 3 + 2];
    let occ = 0, wsum = 0;
    for (const d of DIRS) {
      const c = d[0] * nx + d[1] * ny + d[2] * nz;
      if (c <= 0.05) continue;
      wsum += c;
      // Start 1.8 voxels out along the normal (skip the vertex's own surface).
      const ox = px + nx * voxel * 1.8, oy = py + ny * voxel * 1.8, oz = pz + nz * voxel * 1.8;
      for (let s = 1; s <= steps; s++) {
        const dd = s * voxel * 0.7;
        const id = cell(ox + d[0] * dd, oy + d[1] * dd, oz + d[2] * dd);
        if (id >= 0 && grid[id]) { occ += c * (1 - (dd / reach) * 0.6); break; }
      }
    }
    const a = wsum > 0 ? 1 - occ / wsum : 1;
    ao[i] = 1 - (1 - Math.max(0, Math.min(1, a))) * strength;
  }
  part.ao = ao;
  return ao;
}
