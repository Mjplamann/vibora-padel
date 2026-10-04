// Shared geometry / material helpers for the court and the venues (club, sunset, stadium).
// Court frame: metres, Y up, net plane z = 0, interior x ∈ [-5, 5], z ∈ [-10, 10].
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createRng } from '../../util/math.js';

export function boxAt(w, h, d, x, y, z, { rotY = 0, rotZ = 0, rotX = 0 } = {}) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rotX) g.rotateX(rotX);
  if (rotZ) g.rotateZ(rotZ);
  if (rotY) g.rotateY(rotY);
  g.translate(x, y, z);
  return g;
}

/** Vertical plane with UVs in tiles (metres / tile). axis 'x' = spans x (normal ±z), 'z' = spans z (normal ±x). */
export function wallPlane(axis, a0, a1, y0, y1, c, tile, facing = 1) {
  const w = a1 - a0, h = y1 - y0;
  const g = new THREE.PlaneGeometry(w, h);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, ((uv.getX(i) * w) + a0) / tile, ((uv.getY(i) * h) + y0) / tile);
  if (axis === 'x') {
    if (facing < 0) g.rotateY(Math.PI);
    g.translate((a0 + a1) / 2, (y0 + y1) / 2, c);
  } else {
    g.rotateY(facing > 0 ? Math.PI / 2 : -Math.PI / 2);
    g.translate(c, (y0 + y1) / 2, (a0 + a1) / 2);
  }
  return g;
}

export function floorPlane(x0, x1, z0, z1, y, tile, segs = 1) {
  const w = x1 - x0, d = z1 - z0;
  const g = new THREE.PlaneGeometry(w, d, segs, segs);
  g.rotateX(-Math.PI / 2);
  g.translate((x0 + x1) / 2, y, (z0 + z1) / 2);
  const uv = g.attributes.uv, pos = g.attributes.position;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, pos.getX(i) / tile, pos.getZ(i) / tile);
  return g;
}

/**
 * A floor plane with rectangular holes (the court footprints, inset by `inset` so the turf edge
 * still overlaps it): the floor sits 12 mm under the turf, and where both exist the far turf
 * speckles with floor showing through whenever depth precision runs out (high replay camera,
 * software rasterisers). Grid-decomposed into quads; UVs stay continuous (world / tile).
 * @param {{x0:number,x1:number,z0:number,z1:number}[]} holes
 */
export function floorAround(x0, x1, z0, z1, y, tile, holes, inset = 0.03) {
  const H = holes
    .map((h) => ({ x0: h.x0 + inset, x1: h.x1 - inset, z0: h.z0 + inset, z1: h.z1 - inset }))
    .filter((h) => h.x1 > x0 && h.x0 < x1 && h.z1 > z0 && h.z0 < z1);
  const clampX = (v) => Math.min(x1, Math.max(x0, v)), clampZ = (v) => Math.min(z1, Math.max(z0, v));
  const xs = new Set([x0, x1]), zs = new Set([z0, z1]);
  for (const h of H) {
    xs.add(clampX(h.x0)); xs.add(clampX(h.x1));
    zs.add(clampZ(h.z0)); zs.add(clampZ(h.z1));
  }
  const X = [...xs].sort((a, b) => a - b), Z = [...zs].sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i + 1 < X.length; i++) {
    for (let j = 0; j + 1 < Z.length; j++) {
      if (X[i + 1] - X[i] < 1e-4 || Z[j + 1] - Z[j] < 1e-4) continue;
      const cx = (X[i] + X[i + 1]) / 2, cz = (Z[j] + Z[j + 1]) / 2;
      if (H.some((h) => cx > h.x0 && cx < h.x1 && cz > h.z0 && cz < h.z1)) continue;
      parts.push(floorPlane(X[i], X[i + 1], Z[j], Z[j + 1], y, tile));
    }
  }
  return merge(parts);
}

/** Court footprint rectangles (turf extent) for floorAround(). */
export function courtFootprints(xs, hw, hl) {
  return xs.map((cx) => ({ x0: cx - hw, x1: cx + hw, z0: -hl, z1: hl }));
}

/** Merges geometries (all indexed or all non-indexed) and disposes the parts. */
export function merge(list) {
  const norm = list.some((g) => g.index) ? list.map((g) => (g.index ? g : indexed(g))) : list;
  // Attribute sets must match: keep position / normal / uv (+ color when every part has it).
  const keep = ['position', 'normal', 'uv'];
  if (norm.every((g) => g.attributes.color)) keep.push('color');
  for (const g of norm) {
    for (const k of Object.keys(g.attributes)) if (!keep.includes(k)) g.deleteAttribute(k);
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    if (!g.attributes.normal) g.computeVertexNormals();
  }
  const g = mergeGeometries(norm, false);
  for (const x of list) x.dispose();
  return g;
}

function indexed(g) {
  const n = g.attributes.position.count;
  const idx = new Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  g.setIndex(idx);
  return g;
}

/** Paints a constant vertex colour (linear RGB) onto a geometry (for merged multi-colour props). */
export function tint(g, color) {
  const c = color instanceof THREE.Color ? color : new THREE.Color(color);
  const n = g.attributes.position.count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    a[i * 3] = c.r;
    a[i * 3 + 1] = c.g;
    a[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}

/** One InstancedMesh with an instance per x offset (courts side by side). */
export function instanced(geometry, material, xs, { cast = false, receive = true, name = '' } = {}) {
  const m = new THREE.InstancedMesh(geometry, material, xs.length);
  const mat4 = new THREE.Matrix4();
  xs.forEach((x, i) => m.setMatrixAt(i, mat4.makeTranslation(x, 0, 0)));
  m.instanceMatrix.needsUpdate = true;
  m.computeBoundingSphere();
  m.castShadow = cast;
  m.receiveShadow = receive;
  m.name = name;
  return m;
}

/** InstancedMesh from a list of matrices. */
export function instancedFrom(geometry, material, matrices, { cast = false, receive = true, name = '' } = {}) {
  const m = new THREE.InstancedMesh(geometry, material, Math.max(1, matrices.length));
  matrices.forEach((mat, i) => m.setMatrixAt(i, mat));
  m.count = matrices.length;
  m.instanceMatrix.needsUpdate = true;
  m.computeBoundingSphere();
  m.castShadow = cast;
  m.receiveShadow = receive;
  m.name = name;
  return m;
}

export const seeded = (seed) => createRng(seed);

/** Neighbouring courts sit at x = ±NEIGHBOR_OFFSET (club: both, sunset: the right one). */
export const NEIGHBOR_OFFSET = 13;


/** Frees geometries / materials / textures below a root (venue teardown). */
export function disposeTree(root, { keep = new Set() } = {}) {
  root.traverse((o) => {
    // A shadow-casting light owns its shadow map (a render target with a depth texture): without
    // this every venue switch left the old venue's shadow maps on the GPU (QA r5: +4 textures each).
    if (o.isLight && typeof o.dispose === 'function') o.dispose();
    if (o.geometry && !keep.has(o.geometry)) o.geometry.dispose();
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of mats) {
      if (keep.has(m)) continue;
      for (const v of Object.values(m)) if (v && v.isTexture && !keep.has(v) && !v.userData?.shared) v.dispose();
      if (m.uniforms) for (const u of Object.values(m.uniforms)) if (u && u.value && u.value.isTexture && !keep.has(u.value) && !u.value.userData?.shared) u.value.dispose();
      m.dispose();
    }
  });
}

/** Court materials (and their textures) shared by every venue: never disposed with a venue. */
export function keepSet(courtMats) {
  const keep = new Set();
  for (const m of Object.values(courtMats || {})) {
    if (!m) continue;
    keep.add(m);
    for (const v of Object.values(m)) if (v && v.isTexture) keep.add(v);
  }
  return keep;
}

/** Linear-HDR colour helper. */
export const hdr = (hex, k = 1) => new THREE.Color(hex).multiplyScalar(k);
