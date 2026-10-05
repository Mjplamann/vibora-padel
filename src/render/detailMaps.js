// Photographic detail normal maps (assets/tex/*.webp, 512 x 512 tileable; @pmndrs/assets CC0, see
// THIRD_PARTY_NOTICES.md) and a world-space triplanar "detail normal" layer that any lit material
// can take on top of its own maps: orange-peel powder coat on the steel, grit on concrete and wall
// panels, grain on the bench wood. Loaded lazily; until an image arrives the texture is a flat 1 x 1
// normal, so the shader variant never changes (no recompile hitch when it lands).
import * as THREE from 'three';

const BASE = new URL('../../assets/tex/', import.meta.url);
const cache = new Map();

/** Detail maps shipped with the app (assets/tex/<name>.webp). */
export const DETAIL_MAPS = Object.freeze(['orange-peel-normal', 'grit-normal', 'grain-normal']);

/** A shared, lazily filled normal-map texture (RepeatWrapping, linear data). */
export function detailNormal(name) {
  let t = cache.get(name);
  if (t) return t;
  const c = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  if (c) {
    c.width = c.height = 1;
    const ctx = c.getContext('2d');
    ctx.fillStyle = 'rgb(128,128,255)';
    ctx.fillRect(0, 0, 1, 1);
  }
  t = new THREE.Texture(c);
  t.colorSpace = THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.needsUpdate = !!c;
  t.userData.shared = true;
  t.userData.loaded = false;
  cache.set(name, t);
  if (typeof Image !== 'undefined') {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      t.image = img;
      t.userData.loaded = true;
      t.needsUpdate = true;
    };
    img.onerror = () => {}; // offline without a cached copy: stays flat
    img.src = new URL(`${name}.webp`, BASE).href;
  }
  return t;
}

/**
 * Adds a world-space triplanar detail normal to a lit material (chains any existing
 * onBeforeCompile). scale: tiles per metre; strength: tangent tilt of the detail.
 */
export function addTriplanarDetail(mat, tex, { scale = 8, strength = 0.25, key = 'd' } = {}) {
  const uniforms = { uDetN: { value: tex }, uDetK: { value: new THREE.Vector2(scale, strength) } };
  mat.userData.detailUniforms = uniforms;
  const prev = mat.onBeforeCompile;
  const prevKey = mat.customProgramCacheKey;
  mat.onBeforeCompile = (sh, r) => {
    if (prev && prev !== THREE.Material.prototype.onBeforeCompile) prev.call(mat, sh, r);
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vDetW;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
        vDetW = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
        #else
        vDetW = (modelMatrix * vec4(transformed, 1.0)).xyz;
        #endif`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vDetW;\nuniform sampler2D uDetN;\nuniform vec2 uDetK;')
      .replace('#include <emissivemap_fragment>', `{
          vec3 nW = inverseTransformDirection(normal, viewMatrix);
          vec3 bw = pow(abs(nW), vec3(4.0));
          bw /= max(bw.x + bw.y + bw.z, 1e-4);
          vec3 p = vDetW * uDetK.x;
          vec2 dx = texture2D(uDetN, p.zy).xy * 2.0 - 1.0;
          vec2 dy = texture2D(uDetN, p.xz).xy * 2.0 - 1.0;
          vec2 dz = texture2D(uDetN, p.xy).xy * 2.0 - 1.0;
          vec3 pert = bw.x * vec3(0.0, dx.y, dx.x) + bw.y * vec3(dy.x, 0.0, dy.y) + bw.z * vec3(dz.x, dz.y, 0.0);
          nW = normalize(nW + pert * uDetK.y);
          normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
        }
        #include <emissivemap_fragment>`);
  };
  mat.customProgramCacheKey = () => `${prevKey && prevKey !== THREE.Material.prototype.customProgramCacheKey ? prevKey.call(mat) : ''}|det-${key}`;
  mat.needsUpdate = true;
  return mat;
}
