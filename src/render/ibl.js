// Image-based lighting from real HDR photographs (Poly Haven CC0 panoramas, 512 x 256 EXR,
// assets/env/*.exr, see THIRD_PARTY_NOTICES.md), blended with each venue's own capture.
//
// The venue capture (environment.js) knows where this venue's lights, sky and walls are; a
// photographed panorama brings what procedural geometry cannot: real-world clutter, soft bounce
// and texture in the reflections of the glass, steel and turf sheen. The two are mixed per
// direction into one cube before the PMREM:
//   env(d) = venue(d) * wVenue + hdri(R d) * wHdri * tint
// The panorama is normalised at load to a mean luminance of 1 and a neutral average colour (its
// own sun / lamps clamped), so the venue weights read as linear radiance and the tint as the
// venue's white balance. Panoramas are fetched lazily, one per venue, and cached.
import * as THREE from 'three';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { normalizeHalfPanorama, fromHalf as toF } from './iblMath.js';

/** Panoramas shipped with the app (assets/env/<name>.exr). */
export const HDRI_NAMES = Object.freeze(['warehouse', 'sunset', 'esplanade']);

const BASE = new URL('../../assets/env/', import.meta.url);
const cache = new Map();

export { normalizeHalfPanorama };

function parseExr(buffer) {
  const loader = new EXRLoader();
  loader.setDataType(THREE.HalfFloatType);
  const d = loader.parse(buffer);
  if (!d || !d.data || d.format !== THREE.RGBAFormat) throw new Error('unsupported EXR');
  const stats = normalizeHalfPanorama(d.data, d.width, d.height);
  const tex = new THREE.DataTexture(d.data, d.width, d.height, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.flipY = false;
  tex.needsUpdate = true;
  tex.userData.shared = true; // owned by this cache, never disposed with a venue
  tex.userData.stats = stats;
  return tex;
}

/**
 * Loads (once) and normalises a panorama. Resolves to a THREE.DataTexture (half float, equirect)
 * or rejects (missing file, offline without a cached copy): callers keep the venue-only capture.
 */
export function loadHdri(name) {
  if (!name) return Promise.reject(new Error('no panorama'));
  let p = cache.get(name);
  if (!p) {
    p = fetch(new URL(`${name}.exr`, BASE))
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.arrayBuffer();
      })
      .then(parseExr);
    p.catch(() => cache.delete(name));
    cache.set(name, p);
  }
  return p;
}

/** The loaded panorama texture, or null while it is loading / missing. */
const ready = new Map();
export function hdriIfReady(name) {
  return ready.get(name) || null;
}
/** loadHdri + remembers the result for hdriIfReady. */
export function requestHdri(name) {
  return loadHdri(name).then((t) => {
    ready.set(name, t);
    return t;
  });
}

const BLEND_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

const BLEND_FRAG = /* glsl */ `
  uniform samplerCube tVenue;
  uniform sampler2D tHdri;
  uniform float uVenue, uHdri, uUseHdri, uFloor, uSky;
  uniform mat3 uRot;
  uniform vec3 uTint;
  varying vec3 vDir;
  bool bad(float x) { return (floatBitsToUint(x) & 0x7f800000u) == 0x7f800000u; }
  void main() {
    vec3 d = normalize(vDir);
    vec3 c = textureCube(tVenue, d).rgb * uVenue;
    if (uUseHdri > 0.5) {
      vec3 h = uRot * d;
      vec2 uv = vec2(atan(h.z, h.x) * 0.15915494 + 0.5, asin(clamp(h.y, -1.0, 1.0)) * 0.31830989 + 0.5);
      vec3 p = texture2D(tHdri, uv).rgb * uTint * uHdri;
      // Upper / lower hemisphere weights: outdoors the venue's own analytic sky stays in charge above
      // the horizon (uSky), and the panorama's floor can be toned down below it (uFloor).
      p *= mix(uSky, uFloor, smoothstep(0.08, -0.12, d.y));
      c += p;
    }
    if (bad(c.r) || bad(c.g) || bad(c.b)) c = vec3(0.0);
    gl_FragColor = vec4(c, 1.0);
  }`;

/**
 * Venue + panorama capture. One instance per environment; reuses its cube targets.
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.PMREMGenerator} pmrem
 */
export function createIblCapture(renderer, pmrem) {
  let cubeRT = null;
  let cubeCam = null;
  const blendScene = new THREE.Scene();
  // Mean radiance of the venue capture (32 x 16 equirect read back on request, for look development
  // and the diagnostics: how bright the venue is on average next to its panorama).
  const probeRT = new THREE.WebGLRenderTarget(32, 16, { type: THREE.HalfFloatType, depthBuffer: false });
  const probeBuf = new Uint16Array(32 * 16 * 4);
  const probeMat = new THREE.ShaderMaterial({
    uniforms: { tVenue: { value: null } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `uniform samplerCube tVenue; varying vec2 vUv;
      void main() {
        float phi = (vUv.x - 0.5) * 6.2831853, th = (vUv.y - 0.5) * 3.14159265;
        vec3 d = vec3(cos(th) * cos(phi), sin(th), cos(th) * sin(phi));
        gl_FragColor = vec4(textureCube(tVenue, d).rgb, 1.0);
      }`,
    depthTest: false,
    depthWrite: false,
  });
  const probeQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), probeMat);
  probeQuad.frustumCulled = false;
  const probeScene = new THREE.Scene();
  probeScene.add(probeQuad);
  const probeCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  function venueMean() {
    probeMat.uniforms.tVenue.value = cubeRT.texture;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(probeRT);
    renderer.render(probeScene, probeCam);
    renderer.setRenderTarget(prev);
    try {
      renderer.readRenderTargetPixels(probeRT, 0, 0, 32, 16, probeBuf);
    } catch {
      return 1;
    }
    let sum = 0, wsum = 0;
    for (let y = 0; y < 16; y++) {
      const w = Math.cos(((y + 0.5) / 16 - 0.5) * Math.PI);
      for (let x = 0; x < 32; x++) {
        const i = (y * 32 + x) * 4;
        const r = toF(probeBuf[i]), g = toF(probeBuf[i + 1]), b = toF(probeBuf[i + 2]);
        const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        if (Number.isFinite(l)) sum += l * w;
        wsum += w;
      }
    }
    const m = sum / Math.max(wsum, 1e-9);
    return Number.isFinite(m) && m > 0 ? m : 1;
  }
  const uniforms = {
    tVenue: { value: null },
    tHdri: { value: null },
    uVenue: { value: 1 },
    uHdri: { value: 0 },
    uUseHdri: { value: 0 },
    uFloor: { value: 1 },
    uSky: { value: 1 },
    uRot: { value: new THREE.Matrix3() },
    uTint: { value: new THREE.Color(1, 1, 1) },
  };
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(10, 64, 32),
    new THREE.ShaderMaterial({ uniforms, vertexShader: BLEND_VERT, fragmentShader: BLEND_FRAG, side: THREE.BackSide, depthWrite: false, depthTest: false }),
  );
  sphere.frustumCulled = false;
  blendScene.add(sphere);
  const rotM = new THREE.Matrix4();

  function ensure(size) {
    if (cubeRT && cubeRT.width === size) return;
    cubeRT?.dispose();
    cubeRT = new THREE.WebGLCubeRenderTarget(size, { type: THREE.HalfFloatType, generateMipmaps: false, minFilter: THREE.LinearFilter });
    cubeCam = new THREE.CubeCamera(0.05, 140, cubeRT);
  }

  return {
    /**
     * Renders `scene` from `position` into a cube, mixes in the panorama and returns a PMREM render
     * target (the caller owns and disposes it).
     * @param {{ size:number, position:THREE.Vector3, hdri?:THREE.Texture|null, venue?:number, weight?:number,
     *   rotationDeg?:number, tint?:THREE.Color|number[], floor?:number, sky?:number, measure?:boolean }} o  weight: the
     *   panorama's mean radiance in the mix; measure: read back the venue capture's mean (lastMean)
     */
    capture(scene, o) {
      const size = o.size || 256;
      ensure(size);
      cubeCam.position.copy(o.position);
      cubeCam.updateMatrixWorld(true);
      const prevTarget = renderer.getRenderTarget();
      cubeCam.update(renderer, scene);
      renderer.setRenderTarget(prevTarget);
      uniforms.tVenue.value = cubeRT.texture;
      const h = o.hdri || null;
      const useH = !!(h && (o.weight ?? 0) > 0);
      this.lastMean = o.measure ? venueMean() : this.lastMean;
      uniforms.tHdri.value = h;
      uniforms.uUseHdri.value = useH ? 1 : 0;
      uniforms.uVenue.value = o.venue ?? 1;
      // o.weight: the panorama's mean radiance in the mix (linear, exposure 1; normalised mean is 1).
      uniforms.uHdri.value = o.weight ?? 0;
      uniforms.uFloor.value = o.floor ?? 1;
      uniforms.uSky.value = o.sky ?? 1;
      uniforms.uRot.value.setFromMatrix4(rotM.makeRotationY(THREE.MathUtils.degToRad(o.rotationDeg || 0)));
      const t = o.tint;
      if (Array.isArray(t)) uniforms.uTint.value.setRGB(t[0], t[1], t[2]);
      else uniforms.uTint.value.set(t ?? 0xffffff);
      return pmrem.fromScene(blendScene, 0, 0.1, 50, { size });
    },
    lastMean: 0,
    dispose() {
      cubeRT?.dispose();
      probeRT.dispose();
      probeMat.dispose();
      probeQuad.geometry.dispose();
      sphere.geometry.dispose();
      sphere.material.dispose();
    },
  };
}
