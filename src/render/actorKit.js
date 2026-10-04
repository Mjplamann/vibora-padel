// Shared helpers for the actor renderers (racket, first-person rig, humanoid, ball, machine):
// cached procedural canvas textures, the skin material with wrap ("subsurface") lighting,
// fabric material, font loading and small geometry builders. Browser-only.
import * as THREE from 'three';

const FONT_FILES = [
  ['Big Shoulders Display', 'big-shoulders-display-latin-900-normal.woff2', '900'],
  ['Big Shoulders Display', 'big-shoulders-display-latin-800-normal.woff2', '800'],
  ['Barlow Semi Condensed', 'barlow-semi-condensed-latin-700-normal.woff2', '700'],
  ['Barlow Semi Condensed', 'barlow-semi-condensed-latin-600-normal.woff2', '600'],
];

let fontPromise = null;
/** Loads the display fonts once (resolves even on failure, so callers can just redraw). */
export function loadFonts() {
  if (fontPromise) return fontPromise;
  if (typeof FontFace === 'undefined' || typeof document === 'undefined') {
    fontPromise = Promise.resolve(false);
    return fontPromise;
  }
  fontPromise = Promise.all(FONT_FILES.map(([family, file, weight]) => {
    const url = new URL(`../../fonts/${file}`, import.meta.url).href;
    const face = new FontFace(family, `url(${url})`, { weight });
    return face.load().then((f) => { document.fonts.add(f); return true; }).catch(() => false);
  })).then((r) => r.every(Boolean));
  return fontPromise;
}

// Quality tiers for actor assets built after the call: 'ultra' | 'high' | 'balanced'.
const QUALITY = {
  ultra: { aniso: 16, radial: 28, tex: 1, sphere: [48, 32] },
  high: { aniso: 8, radial: 20, tex: 1, sphere: [40, 28] },
  balanced: { aniso: 4, radial: 14, tex: 0.5, sphere: [24, 16] },
};
let qualityLevel = 'high';
export function setActorQuality(level) {
  if (QUALITY[level]) qualityLevel = level;
}
export function actorQuality() {
  return { level: qualityLevel, ...QUALITY[qualityLevel] };
}

export const DISPLAY_FONT = '"Big Shoulders Display", "Arial Narrow", Impact, sans-serif';
export const UI_FONT = '"Barlow Semi Condensed", "Arial Narrow", Arial, sans-serif';

/** Canvas-backed texture. draw(ctx, w, h) is re-run by the returned redraw(). */
export function canvasTexture(w, h, draw, { srgb = true, repeat = false, anisotropy = actorQuality().aniso } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  draw(ctx, w, h);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = anisotropy;
  if (repeat) tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.userData.redraw = () => {
    ctx.clearRect(0, 0, w, h);
    draw(ctx, w, h);
    tex.needsUpdate = true;
  };
  return tex;
}

// Deterministic hash noise for texture generation (not for physics).
export function hash2(x, y, seed = 0) {
  let h = (x * 374761393 + y * 668265263 + seed * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Tileable value noise in [0,1] on a period x period lattice. */
export function tileNoise(u, v, period, seed = 0) {
  const x = u * period, y = v * period;
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const w = (a, b) => hash2(((a % period) + period) % period, ((b % period) + period) % period, seed);
  const a = w(xi, yi), b = w(xi + 1, yi), c = w(xi, yi + 1), d = w(xi + 1, yi + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** Converts a grayscale height canvas into a tangent-space normal map canvas. */
export function heightToNormalCanvas(src, strength = 2) {
  const w = src.width, h = src.height;
  const sctx = src.getContext('2d');
  const sd = sctx.getImageData(0, 0, w, h).data;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const octx = out.getContext('2d');
  const img = octx.createImageData(w, h);
  // Heights unpacked once (wrapping lookups and the ImageData accessor stay out of the loop).
  const hs = new Float32Array(w * h);
  for (let k = 0; k < w * h; k++) hs[k] = sd[k * 4] / 255;
  const od = img.data;
  for (let y = 0; y < h; y++) {
    const r0 = y * w, rUp = ((y + h - 1) % h) * w, rDn = ((y + 1) % h) * w;
    for (let x = 0; x < w; x++) {
      const xl = x === 0 ? w - 1 : x - 1, xr = x === w - 1 ? 0 : x + 1;
      const dx = (hs[r0 + xr] - hs[r0 + xl]) * strength;
      const dy = (hs[rDn + x] - hs[rUp + x]) * strength;
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const i = (r0 + x) * 4;
      od[i] = (-dx * inv * 0.5 + 0.5) * 255;
      od[i + 1] = (dy * inv * 0.5 + 0.5) * 255;
      od[i + 2] = (inv * 0.5 + 0.5) * 255;
      od[i + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  return out;
}

const cache = new Map();
/** Memoizes expensive procedural resources by key. */
export function cached(key, make) {
  const k = `${key}@${qualityLevel}`;
  if (!cache.has(k)) cache.set(k, make());
  return cache.get(k);
}

/** Fine skin micro-normal (pores + creases), tileable. */
export function skinNormalTexture() {
  return cached('skinNormal', () => {
    const N = 256;
    const c = document.createElement('canvas');
    c.width = c.height = N;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(N, N);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const u = x / N, v = y / N;
        let h = 0.55 * tileNoise(u, v, 32, 1) + 0.3 * tileNoise(u, v, 64, 2) + 0.15 * tileNoise(u, v, 128, 3);
        if (hash2(x, y, 9) > 0.985) h -= 0.35; // pores
        const g = Math.max(0, Math.min(255, h * 255));
        const i = (y * N + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = g;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(heightToNormalCanvas(c, 1.6));
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.NoColorSpace;
    return tex;
  });
}

/** Knit fabric bump texture (jersey stitches), tileable. */
export function knitNormalTexture() {
  return cached('knitNormal', () => {
    const N = 128;
    const c = document.createElement('canvas');
    c.width = c.height = N;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(N, N);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const cx = (x % 8) / 8, cy = (y % 8) / 8;
        const vshape = Math.abs(Math.abs(cx - 0.5) * 2 - cy); // V-shaped jersey loops
        let h = 1 - Math.min(1, vshape * 2.2);
        h = h * 0.75 + 0.25 * hash2(x, y, 5);
        const g = h * 255;
        const i = (y * N + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = g;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(heightToNormalCanvas(c, 2.2));
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.NoColorSpace;
    return tex;
  });
}

// Wrap lighting: light bleeds past the terminator with a red bias, the cheap look of
// subsurface scattering in skin. Patched into the physical BRDF's direct diffuse term.
const WRAP_FIND = 'reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );';
function wrapChunk(wrap) {
  const chunk = THREE.ShaderChunk.lights_physical_pars_fragment;
  if (!chunk.includes(WRAP_FIND)) return null;
  const w = `vec3(${wrap.map((v) => v.toFixed(3)).join(',')})`;
  return chunk.replace(WRAP_FIND, `{
    float sssNL = dot( geometryNormal, directLight.direction );
    vec3 sssWrap = clamp( ( vec3( sssNL ) + ${w} ) / ( 1.0 + ${w} ), 0.0, 1.0 );
    vec3 sssIrr = sssWrap * directLight.color;
    reflectedLight.directDiffuse += sssIrr * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );
  }`);
}

/** Applies the wrap-lighting patch to a MeshPhysicalMaterial / MeshStandardMaterial. */
export function applyWrapLighting(material, wrap = [0.5, 0.22, 0.14], key = 'skin') {
  const chunk = wrapChunk(wrap);
  if (!chunk) return material;
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <lights_physical_pars_fragment>', chunk);
  };
  material.customProgramCacheKey = () => `wrap-${key}-${wrap.join(',')}`;
  return material;
}

/** Skin: physical material with sheen (peach fuzz), micro normal, and wrap lighting. */
export function createSkinMaterial(color = '#c58c6a', { normalRepeat = 6, roughness = 0.52 } = {}) {
  const nm = skinNormalTexture().clone();
  nm.repeat.set(normalRepeat, normalRepeat);
  nm.needsUpdate = true;
  const m = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(color),
    roughness,
    metalness: 0,
    sheen: 0.35,
    sheenRoughness: 0.6,
    sheenColor: new THREE.Color('#ffb59a'),
    specularIntensity: 0.55,
    normalMap: nm,
    normalScale: new THREE.Vector2(0.18, 0.18),
  });
  return applyWrapLighting(m, [0.55, 0.24, 0.15], 'skin');
}

/** Sports fabric (polyester jersey): sheen + knit normal. */
export function createFabricMaterial(color, { roughness = 0.82, sheen = 0.6, repeat = 20 } = {}) {
  const nm = knitNormalTexture().clone();
  nm.repeat.set(repeat, repeat);
  nm.needsUpdate = true;
  const c = new THREE.Color(color);
  const m = new THREE.MeshPhysicalMaterial({
    color: c,
    roughness,
    metalness: 0,
    sheen,
    sheenRoughness: 0.45,
    sheenColor: c.clone().lerp(new THREE.Color('#ffffff'), 0.45),
    normalMap: nm,
    normalScale: new THREE.Vector2(0.35, 0.35),
  });
  return applyWrapLighting(m, [0.25, 0.25, 0.25], 'fabric');
}

/**
 * Lathe limb along -Y from the origin: profile = [[t (0..1 along length), radius], ...].
 * Ends are closed with a hemispherical cap scaled to the end radius.
 */
export function limbGeometry(length, profile, { radial = actorQuality().radial, capSegments = 5, flatten = 1 } = {}) {
  const pts = [];
  const r0 = profile[0][1];
  const r1 = profile[profile.length - 1][1];
  for (let i = 0; i <= capSegments; i++) {
    const a = (Math.PI / 2) * (1 - i / capSegments);
    pts.push(new THREE.Vector2(Math.cos(a) * r0 + 1e-5, Math.sin(a) * r0 * 0.6));
  }
  for (const [t, r] of profile) pts.push(new THREE.Vector2(r, -t * length));
  for (let i = 1; i <= capSegments; i++) {
    const a = (Math.PI / 2) * (i / capSegments);
    pts.push(new THREE.Vector2(Math.cos(a) * r1 + 1e-5, -length - Math.sin(a) * r1 * 0.6));
  }
  // Lathe expects increasing y for outward normals; build top->bottom then reverse.
  pts.reverse();
  const g = new THREE.LatheGeometry(pts, radial);
  if (flatten !== 1) g.scale(1, 1, flatten);
  g.computeVertexNormals();
  return g;
}

/** Smooth interpolation through a list of [t, value] keys (Catmull-Rom on scalars). */
export function sampleKeys(keys, t) {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 0; i < keys.length - 1; i++) {
    const [t0, v0] = keys[i];
    const [t1, v1] = keys[i + 1];
    if (t <= t1) {
      const u = (t - t0) / (t1 - t0);
      const s = u * u * (3 - 2 * u);
      return v0 + (v1 - v0) * s;
    }
  }
  return keys[keys.length - 1][1];
}

/** Rounded-rectangle path helper for canvas drawing. */
export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Builds an orthonormal basis quaternion from a Y axis and an approximate Z axis. */
export function quatFromYZ(yAxis, zHint, out = new THREE.Quaternion()) {
  const y = _qa.copy(yAxis).normalize();
  const z = _qb.copy(zHint).addScaledVector(y, -_qb.dot(y));
  if (z.lengthSq() < 1e-10) z.set(0, 0, 1).addScaledVector(y, -y.z);
  z.normalize();
  const x = _qc.crossVectors(y, z).normalize();
  _qm.makeBasis(x, y, z);
  return out.setFromRotationMatrix(_qm);
}

/** Basis quaternion from forward (local +Y here = 'fwd') etc. General: columns x,y,z. */
export function quatFromBasis(x, y, z, out = new THREE.Quaternion()) {
  _qm.makeBasis(x, y, z);
  return out.setFromRotationMatrix(_qm);
}

const _qa = new THREE.Vector3();
const _qb = new THREE.Vector3();
const _qc = new THREE.Vector3();
const _qm = new THREE.Matrix4();

// ------------------------------------------------------------------ draw-call reduction

function normalizedGeometry(geo, matrix) {
  let g = geo.index ? geo.toNonIndexed() : geo.clone();
  g.applyMatrix4(matrix);
  for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  if (!g.attributes.normal) g.computeVertexNormals();
  g.clearGroups();
  return g;
}

function concatGeometries(geos) {
  let n = 0;
  for (const g of geos) n += g.attributes.position.count;
  const out = new THREE.BufferGeometry();
  for (const [name, size] of [['position', 3], ['normal', 3], ['uv', 2]]) {
    const arr = new Float32Array(n * size);
    let o = 0;
    for (const g of geos) {
      arr.set(g.attributes[name].array, o);
      o += g.attributes[name].array.length;
    }
    out.setAttribute(name, new THREE.BufferAttribute(arr, size));
  }
  return out;
}

/**
 * Merges every static single-material mesh under root (skipping `exclude` subtrees) into one
 * mesh per material. Returns the number of meshes removed.
 */
export function mergeStatic(root, exclude = new Set()) {
  root.updateMatrixWorld(true);
  const inv = root.matrixWorld.clone().invert();
  const buckets = new Map();
  const visit = (o) => {
    if (exclude.has(o)) return;
    if (o.isMesh && !o.isInstancedMesh && !o.isSkinnedMesh && !Array.isArray(o.material)) {
      if (!buckets.has(o.material)) buckets.set(o.material, []);
      buckets.get(o.material).push(o);
    }
    for (const c of o.children) visit(c);
  };
  for (const c of root.children) visit(c);
  let removed = 0;
  for (const [mat, meshes] of buckets) {
    if (meshes.length < 2) continue;
    const geos = meshes.map((m) => normalizedGeometry(m.geometry, new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld)));
    const merged = new THREE.Mesh(concatGeometries(geos), mat);
    merged.castShadow = meshes.some((m) => m.castShadow);
    merged.receiveShadow = meshes.some((m) => m.receiveShadow);
    merged.renderOrder = meshes[0].renderOrder;
    for (const m of meshes) m.parent.remove(m);
    root.add(merged);
    removed += meshes.length - 1;
  }
  return removed;
}

/**
 * Bakes rigid parts parented to bones into one SkinnedMesh per material (one draw call per
 * material for a whole character). bones: Object3D[] whose direct Mesh children are baked.
 */
export function bakeRigidSkin(container, bones, { boundingRadius = 1.8, center = new THREE.Vector3(0, 1, 0) } = {}) {
  const buckets = new Map();
  bones.forEach((bone, bi) => {
    for (const m of [...bone.children]) {
      if (!m.isMesh || Array.isArray(m.material) || m.userData.noBake) continue;
      m.updateMatrix();
      const g = normalizedGeometry(m.geometry, m.matrix);
      const n = g.attributes.position.count;
      const si = new Uint16Array(n * 4);
      const sw = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) { si[i * 4] = bi; sw[i * 4] = 1; }
      g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
      g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
      if (!buckets.has(m.material)) buckets.set(m.material, []);
      buckets.get(m.material).push(g);
      bone.remove(m);
    }
  });
  const skeleton = new THREE.Skeleton(bones, bones.map(() => new THREE.Matrix4()));
  const meshes = [];
  for (const [mat, geos] of buckets) {
    const g = concatGeometries(geos);
    let n = 0;
    for (const x of geos) n += x.attributes.position.count;
    const si = new Uint16Array(n * 4);
    const sw = new Float32Array(n * 4);
    let o = 0;
    for (const x of geos) {
      si.set(x.attributes.skinIndex.array, o);
      sw.set(x.attributes.skinWeight.array, o);
      o += x.attributes.skinIndex.array.length;
    }
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
    const sm = new THREE.SkinnedMesh(g, mat);
    sm.castShadow = true;
    sm.receiveShadow = true;
    container.add(sm);
    sm.bind(skeleton, new THREE.Matrix4());
    sm.boundingSphere = new THREE.Sphere(center.clone(), boundingRadius);
    meshes.push(sm);
  }
  return { skeleton, meshes };
}
