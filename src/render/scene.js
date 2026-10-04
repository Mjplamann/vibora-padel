// Renderer, scene, camera and post-processing chain (SPEC §6.1).
// Linear HDR render (MSAA half-float target) -> subtle bloom that only catches emissive LEDs
// -> OutputPass (ACES filmic tone mapping + sRGB) -> optional FXAA on the balanced tier.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FXAAPass } from 'three/addons/postprocessing/FXAAPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

/**
 * NaN / Inf guard between the scene render and the bloom (real-world session: "a black screen
 * with image on the side"). One non-finite fragment (a degenerate matrix, a zero normal) is
 * smeared over the whole picture by the bloom mip chain, so the WebGL view turns black while the
 * HUD and camera PiP stay. This pass zeroes non-finite pixels; the test is on the float bits
 * (exponent all ones), which survives GPU fast-math that may drop isnan().
 */
export const FINITE_GUARD_SHADER = {
  name: 'FiniteGuardShader',
  uniforms: { tDiffuse: { value: null } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    varying vec2 vUv;
    bool bad(float x) { return (floatBitsToUint(x) & 0x7f800000u) == 0x7f800000u; }
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      if (bad(c.r) || bad(c.g) || bad(c.b) || bad(c.a)) c = vec4(0.0, 0.0, 0.0, 1.0);
      gl_FragColor = c;
    }`,
};

/**
 * Quality tiers. `turfSize`/`envSize`/`neighbors`/`fillLights` are read by environment.js at
 * build time; everything else is applied live by setQuality().
 */
export const QUALITY = {
  ultra: {
    msaa: 4, fxaa: false, maxPixelRatio: 2, shadowMapSize: 4096, shadowRadius: 6,
    bloom: true, bloomStrength: 0.22, turfSize: 2048, envSize: 512, neighbors: true, fillLights: true,
  },
  high: {
    msaa: 4, fxaa: false, maxPixelRatio: 1.5, shadowMapSize: 2048, shadowRadius: 5,
    bloom: true, bloomStrength: 0.2, turfSize: 2048, envSize: 256, neighbors: true, fillLights: true,
  },
  balanced: {
    msaa: 0, fxaa: true, maxPixelRatio: 1.0, shadowMapSize: 1024, shadowRadius: 3,
    bloom: true, bloomStrength: 0.18, turfSize: 1024, envSize: 256, neighbors: true, fillLights: false,
  },
};

export const BLOOM_THRESHOLD = 3.2; // linear HDR luminance; lit surfaces stay below, LED diffusers exceed it
export const DEFAULT_EXPOSURE = 1.0;
const MIN_PIXEL_RATIO = 0.6;

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{quality?: 'ultra'|'high'|'balanced', dynamicResolution?: boolean, fov?: number}} opts
 */
export function createRenderer(canvas, { quality = 'high', dynamicResolution = true, fov = 70 } = {}) {
  let tier = QUALITY[quality] ? quality : 'high';
  let q = QUALITY[tier];

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false, // MSAA happens in the composer's render target
    powerPreference: 'high-performance',
    stencil: false,
    alpha: false,
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = DEFAULT_EXPOSURE;
  renderer.shadowMap.enabled = true;
  // r186 removed PCFSoftShadowMap; PCFShadowMap is now a soft Vogel-disk PCF driven by shadow.radius.
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.info.autoReset = false;
  renderer.setClearColor(0x050608, 1);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050608);

  const camera = new THREE.PerspectiveCamera(fov, 16 / 9, 0.02, 120);
  camera.position.set(0, 1.64, 8);
  camera.lookAt(0, 1.2, -10);

  const deviceRatio = () => (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);
  const maxRatio = () => Math.min(deviceRatio(), 2, q.maxPixelRatio);
  let pixelRatio = maxRatio();
  let width = canvas.clientWidth || canvas.width || 1280;
  let height = canvas.clientHeight || canvas.height || 720;

  let composer = null;
  let renderPass = null;
  let guardPass = null;
  let bloomPass = null;
  let outputPass = null;
  let fxaaPass = null;

  function buildComposer() {
    composer?.renderTarget1?.dispose();
    composer?.renderTarget2?.dispose();
    bloomPass?.dispose?.();
    const target = new THREE.WebGLRenderTarget(Math.max(1, width * pixelRatio), Math.max(1, height * pixelRatio), {
      type: THREE.HalfFloatType,
      samples: q.msaa,
    });
    composer = new EffectComposer(renderer, target);
    composer.setPixelRatio(pixelRatio);
    composer.setSize(width, height);
    renderPass = new RenderPass(scene, camera);
    composer.addPass(renderPass);
    guardPass = new ShaderPass(FINITE_GUARD_SHADER);
    composer.addPass(guardPass);
    bloomPass = new UnrealBloomPass(new THREE.Vector2(width, height), q.bloomStrength, 0.12, BLOOM_THRESHOLD);
    bloomPass.enabled = q.bloom;
    composer.addPass(bloomPass);
    outputPass = new OutputPass();
    composer.addPass(outputPass);
    fxaaPass = new FXAAPass();
    fxaaPass.enabled = q.fxaa;
    composer.addPass(fxaaPass);
    api.composer = composer;
  }

  function applySize() {
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(width, height, false);
    composer.setPixelRatio(pixelRatio);
    composer.setSize(width, height);
    camera.aspect = width / Math.max(1, height);
    camera.updateProjectionMatrix();
  }

  /** Tier-dependent scene state: fill lights, hemisphere boost, wire-mesh alpha mode. */
  function applySceneTier() {
    scene.traverse((o) => {
      if (o.isLight && o.userData.fill) o.visible = q.fillLights;
      if (o.isHemisphereLight && o.userData.baseIntensity !== undefined) {
        o.intensity = o.userData.baseIntensity * (q.fillLights ? 1 : 2.5);
      }
      const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      for (const m of mats) {
        if (m.userData?.alphaMode !== 'coverage-or-blend') continue;
        const a2c = q.msaa > 0;
        if (m.alphaToCoverage !== a2c) {
          m.alphaToCoverage = a2c;
          m.transparent = !a2c;
          m.depthWrite = a2c;
          m.needsUpdate = true;
        }
      }
    });
  }

  function applyShadowQuality() {
    scene.traverse((o) => {
      if (o.isLight && o.castShadow && o.shadow) {
        const size = o.userData.shadowScale ? Math.max(512, q.shadowMapSize * o.userData.shadowScale) : q.shadowMapSize;
        if (o.shadow.mapSize.x !== size) {
          o.shadow.mapSize.set(size, size);
          o.shadow.map?.dispose();
          o.shadow.map = null;
        }
        o.shadow.radius = q.shadowRadius;
      }
    });
  }

  // Dynamic resolution: hold 60 fps by scaling the pixel ratio in small, rate-limited steps.
  const dyn = { enabled: dynamicResolution, acc: 0, frames: 0, slow: 0, fast: 0, lastChange: 0, now: 0 };
  function updateDynamicResolution(dt) {
    if (!dyn.enabled) return;
    dyn.now += dt;
    dyn.acc += dt;
    dyn.frames++;
    if (dyn.acc < 0.5) return;
    const fps = dyn.frames / dyn.acc;
    dyn.acc = 0;
    dyn.frames = 0;
    if (fps < 54) {
      dyn.slow++;
      dyn.fast = 0;
    } else if (fps > 58.5) {
      dyn.fast++;
      dyn.slow = 0;
    } else {
      dyn.slow = dyn.fast = 0;
    }
    const since = dyn.now - dyn.lastChange;
    let next = pixelRatio;
    if (dyn.slow >= 2 && since > 1.0) next = Math.max(MIN_PIXEL_RATIO, pixelRatio * 0.88);
    else if (dyn.fast >= 6 && since > 3.0) next = Math.min(maxRatio(), pixelRatio * 1.08);
    if (Math.abs(next - pixelRatio) > 0.01) {
      pixelRatio = Math.round(next * 100) / 100;
      dyn.lastChange = dyn.now;
      dyn.slow = dyn.fast = 0;
      applySize();
    }
  }

  const stats = { fps: 0, drawCalls: 0, triangles: 0, pixelRatio, frameMs: 0 };
  let lastT = null;

  const api = {
    renderer,
    scene,
    camera,
    composer: null,
    stats,
    get quality() {
      return tier;
    },
    get qualitySettings() {
      return q;
    },
    get dynamicResolution() {
      return dyn.enabled;
    },
    set dynamicResolution(v) {
      dyn.enabled = !!v;
      if (!dyn.enabled) {
        pixelRatio = maxRatio();
        applySize();
      }
    },
    get pixelRatio() {
      return pixelRatio;
    },
    setQuality(next) {
      if (!QUALITY[next]) return;
      const msaaChanged = QUALITY[next].msaa !== q.msaa;
      tier = next;
      q = QUALITY[tier];
      pixelRatio = Math.min(pixelRatio, maxRatio());
      if (msaaChanged) buildComposer();
      bloomPass.enabled = q.bloom;
      bloomPass.strength = q.bloomStrength;
      fxaaPass.enabled = q.fxaa;
      applyShadowQuality();
      applySceneTier();
      applySize();
    },
    resize(w, h) {
      width = Math.max(1, Math.floor(w));
      height = Math.max(1, Math.floor(h));
      pixelRatio = Math.min(pixelRatio, maxRatio());
      applySize();
    },
    setExposure(e) {
      renderer.toneMappingExposure = e;
    },
    /** Re-applies the tier's shadow-map sizes, fills and wire alpha mode after content was added. */
    refreshQuality() {
      applyShadowQuality();
      applySceneTier();
    },
    render(dt) {
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (dt === undefined || dt === null) dt = lastT === null ? 1 / 60 : (now - lastT) / 1000;
      lastT = now;
      dt = Math.min(Math.max(dt, 0), 0.25);
      if (dt > 0) stats.fps = stats.fps ? stats.fps + (1 / dt - stats.fps) * 0.1 : 1 / dt;
      updateDynamicResolution(dt);
      renderer.info.reset();
      const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
      composer.render(dt);
      stats.frameMs = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
      stats.drawCalls = renderer.info.render.calls;
      stats.triangles = renderer.info.render.triangles;
      stats.pixelRatio = pixelRatio;
    },
    dispose() {
      composer.renderTarget1.dispose();
      composer.renderTarget2.dispose();
      bloomPass.dispose?.();
      renderer.dispose();
    },
  };

  buildComposer();
  applySize();
  return api;
}
