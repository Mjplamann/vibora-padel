// LOD1 by attribute-aware simplification (meshoptimizer, bake time only). Seams (uv splits) are
// handled by meshoptimizer's position-based seam detection; attributes follow the kept vertices.
import { need } from './deps.mjs';

const { MeshoptSimplifier } = await need('meshoptimizer');
await MeshoptSimplifier.ready;
MeshoptSimplifier.useExperimentalFeatures = true;

export function simplifyPart(part, { ratio = 0.3, error = 0.005, cards = false } = {}) {
  const nv = part.positions.length / 3;
  const pos = Float32Array.from(part.positions);
  const target = Math.max(3, Math.floor((part.index.length * ratio) / 3) * 3);
  // Attributes steer the collapse: normals and the region (kit boundaries stay crisp).
  const attr = new Float32Array(nv * 4);
  for (let i = 0; i < nv; i++) {
    attr[i * 4] = part.normals[i * 3]; attr[i * 4 + 1] = part.normals[i * 3 + 1]; attr[i * 4 + 2] = part.normals[i * 3 + 2];
    attr[i * 4 + 3] = part.region[i] * 0.5;
  }
  const weights = cards ? [0.2, 0.2, 0.2, 1] : [0.5, 0.5, 0.5, 2];
  const [idx] = MeshoptSimplifier.simplifyWithAttributes(Uint32Array.from(part.index), pos, 3, attr, 4, weights, null, target, error, cards ? [] : ['LockBorder']);
  // Compact the kept vertices.
  const remap = new Int32Array(nv).fill(-1);
  let n = 0;
  for (const v of idx) if (remap[v] < 0) remap[v] = n++;
  const out = {
    positions: new Float64Array(n * 3), normals: new Float64Array(n * 3), uv: new Float64Array(n * 2), skinIndex: new Uint8Array(n * 4), skinWeight: new Float64Array(n * 4),
    region: new Uint8Array(n), part: new Uint8Array(n), ao: new Float64Array(n), aux: new Float64Array(n * 2), index: new Uint32Array(idx.length),
  };
  for (let v = 0; v < nv; v++) {
    const o = remap[v];
    if (o < 0) continue;
    for (let k = 0; k < 3; k++) { out.positions[o * 3 + k] = part.positions[v * 3 + k]; out.normals[o * 3 + k] = part.normals[v * 3 + k]; }
    for (let k = 0; k < 2; k++) { out.uv[o * 2 + k] = part.uv[v * 2 + k]; out.aux[o * 2 + k] = part.aux ? part.aux[v * 2 + k] : 1; }
    for (let k = 0; k < 4; k++) { out.skinIndex[o * 4 + k] = part.skinIndex[v * 4 + k]; out.skinWeight[o * 4 + k] = part.skinWeight[v * 4 + k]; }
    out.region[o] = part.region[v]; out.part[o] = part.part[v]; out.ao[o] = part.ao ? part.ao[v] : 1;
  }
  for (let i = 0; i < idx.length; i++) out.index[i] = remap[idx[i]];
  return out;
}
