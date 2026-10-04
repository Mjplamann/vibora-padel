// A one-draw-call padel racket for the AI players: the real racket (racket.js) merged into a single
// mesh whose vertex colours carry each part's material colour (the face graphics and carbon
// weave average to their mean colour). The full racket costs ~10 draw calls plus as many per
// shadow light; on a player 5-17 m away the textures are sub-pixel anyway. Browser-only.
import * as THREE from 'three';
import { buildRacket } from './racket.js';

const cache = new Map();

/** Mean linear colour of a material (its colour times the mean of its map, when it has one). */
function meanColor(mat, out) {
  out.copy(mat.color || out.set(1, 1, 1));
  const img = mat.map && mat.map.image;
  if (img && typeof document !== 'undefined' && (img.width || img.videoWidth)) {
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 8;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, 8, 8);
      const d = ctx.getImageData(0, 0, 8, 8).data;
      let r = 0, g = 0, b = 0;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
      const n = d.length / 4;
      const m = new THREE.Color().setRGB(r / n / 255, g / n / 255, b / n / 255, THREE.SRGBColorSpace);
      out.multiply(m);
    } catch {
      // keep the plain colour
    }
  }
  return out;
}

function mergedGeometry(color) {
  const src = buildRacket({ color, cord: false });
  src.updateMatrixWorld(true);
  const pos = [], nrm = [], col = [];
  const c = new THREE.Color();
  const nm = new THREE.Matrix3();
  const v = new THREE.Vector3();
  src.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const groups = g.groups.length ? g.groups : [{ start: 0, count: g.attributes.position.count, materialIndex: 0 }];
    nm.getNormalMatrix(o.matrixWorld);
    const P = g.attributes.position, N = g.attributes.normal;
    for (const gr of groups) {
      meanColor(mats[gr.materialIndex] || mats[0], c);
      for (let i = gr.start; i < gr.start + gr.count && i < P.count; i++) {
        v.fromBufferAttribute(P, i).applyMatrix4(o.matrixWorld);
        pos.push(v.x, v.y, v.z);
        if (N) v.fromBufferAttribute(N, i).applyMatrix3(nm).normalize();
        else v.set(0, 0, 1);
        nrm.push(v.x, v.y, v.z);
        col.push(c.r, c.g, c.b);
      }
    }
  });
  src.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeBoundingSphere();
  return geo;
}

let sharedMat = null;

/**
 * @param {{ color?: string }} o
 * @returns {THREE.Group} origin = grip, +Y handle -> tip, +Z forehand face (racket.js frame).
 */
export function buildActorRacket({ color = '#e8572a' } = {}) {
  if (!cache.has(color)) cache.set(color, mergedGeometry(color));
  if (!sharedMat) sharedMat = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.08, clearcoat: 0.6, clearcoatRoughness: 0.3 });
  const group = new THREE.Group();
  group.name = 'actor-racket';
  const mesh = new THREE.Mesh(cache.get(color), sharedMat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  group.userData.setHanded = () => {};
  return group;
}
