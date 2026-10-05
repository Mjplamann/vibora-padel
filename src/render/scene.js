// Renderer, scene, camera and post-processing chain (SPEC §6.1).
// ScenePass: linear HDR render into its own MSAA half-float target (+ resolved depth), resolved
// once into the single-sample chain with the contact AO and a NaN guard folded in
// -> subtle bloom that only catches emissive LEDs
// -> GradedOutputPass (the venue's tone mapping + sRGB + the venue grade) -> SMAA (ultra / high, on
// top of the scene's MSAA: catches shader aliasing such as wire glints and line edges) or FXAA
// (balanced). Dynamic resolution steers by the GPU frame time when the browser exposes timer
// queries (EXT_disjoint_timer_query_webgl2), by the frame rate otherwise.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FXAAPass } from 'three/addons/postprocessing/FXAAPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

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
 * Display-referred colour grade after tone mapping (per venue, set by environment.js through
 * scene.userData.grade / gradeVersion): lift / gamma / gain per channel (ASC-CDL style), saturation,
 * contrast around mid-grey, a warm/cool white-balance shift and a soft vignette. Identity by default.
 */
const GRADE_GLSL = /* glsl */ `
  uniform vec3 uLift, uGamma, uGain;
  uniform float uSat, uContrast, uWarmth, uVignette, uAspect;
  vec4 gradeColor(vec4 src) {
    vec3 c = clamp(src.rgb, 0.0, 1.0);
    c = c * uGain + uLift * (1.0 - c);
    c = pow(max(c, vec3(0.0)), 1.0 / max(uGamma, vec3(0.05)));
    // Warmth: shift toward amber in the mids and highlights (golden hour), keep the blacks.
    c *= mix(vec3(1.0), vec3(1.05, 1.0, 0.9), uWarmth * smoothstep(0.05, 0.6, dot(c, vec3(0.3333))));
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = mix(vec3(l), c, uSat);
    c = (c - 0.45) * uContrast + 0.45;
    vec2 q = (vUv - 0.5) * vec2(uAspect, 1.0);
    float v = 1.0 - uVignette * smoothstep(0.35, 1.05, length(q));
    return vec4(clamp(c * v, 0.0, 1.0), src.a);
  }`;

/** Standalone pass form of the grade (the main chain folds it into GradedOutputPass). */
export const GRADE_SHADER = {
  name: 'GradeShader',
  uniforms: {
    tDiffuse: { value: null },
    uLift: { value: new THREE.Vector3(0, 0, 0) },
    uGamma: { value: new THREE.Vector3(1, 1, 1) },
    uGain: { value: new THREE.Vector3(1, 1, 1) },
    uSat: { value: 1 },
    uContrast: { value: 1 },
    uWarmth: { value: 0 },
    uVignette: { value: 0 },
    uAspect: { value: 16 / 9 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    varying vec2 vUv;
    ${GRADE_GLSL}
    void main() {
      gl_FragColor = gradeColor(texture2D(tDiffuse, vUv));
    }`,
};

/**
 * Contact ambient occlusion (quality-tiered: ultra / high). Screen-space, from the depth buffer
 * only: it darkens creases where objects meet (feet on the turf, post bases, bench legs, the
 * net's bottom cord, the ball low over the floor). Glass and the sky write no depth, so they
 * never occlude. Half-resolution AO with a rotated 10-tap kernel (normals from depth derivatives),
 * then a depth-aware 3x3 blur that multiplies the colour. Driven by ScenePass.resolve(), which hands
 * it this frame's resolved colour + depth; the resolve also zeroes non-finite pixels (FINITE_GUARD).
 */
export class ContactAOPass extends Pass {
  constructor(camera, { strength = 0.8, radius = 0.42 } = {}) {
    super();
    this.camera = camera;
    this.needsSwap = true;
    this.strength = strength;
    this.radius = radius;
    this.aoTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.UnsignedByteType, depthBuffer: false });
    const common = /* glsl */ `
      uniform sampler2D tDepth;
      uniform float uNear, uFar;
      uniform vec2 uProj; // projectionMatrix[0][0], [1][1]
      bool bad(float x) { return (floatBitsToUint(x) & 0x7f800000u) == 0x7f800000u; }
      vec4 finite(vec4 c) { return (bad(c.r) || bad(c.g) || bad(c.b) || bad(c.a)) ? vec4(0.0, 0.0, 0.0, 1.0) : c; }
      float viewZ(vec2 uv) {
        float d = texture2D(tDepth, uv).x;
        return (uNear * uFar) / ((uFar - uNear) * d - uFar);
      }
      vec3 viewPos(vec2 uv, float z) {
        vec2 ndc = uv * 2.0 - 1.0;
        return vec3(ndc.x * -z / uProj.x, ndc.y * -z / uProj.y, z);
      }`;
    this.aoMat = new THREE.ShaderMaterial({
      uniforms: {
        tDepth: { value: null }, uNear: { value: 0.02 }, uFar: { value: 120 }, uProj: { value: new THREE.Vector2(1, 1) },
        uRadius: { value: radius }, uRes: { value: new THREE.Vector2(1, 1) }, uBias: { value: 0.06 }, uEps: { value: 0.001 },
        uDepthTexel: { value: new THREE.Vector2(1, 1) },
      },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: /* glsl */ `
        ${common}
        uniform float uRadius, uBias, uEps;
        uniform vec2 uRes, uDepthTexel;
        varying vec2 vUv;
        void main() {
          float d0 = texture2D(tDepth, vUv).x;
          if (d0 >= 0.99999) { gl_FragColor = vec4(1.0); return; }
          float z = viewZ(vUv);
          vec3 P = viewPos(vUv, z);
          // Normal from the full-resolution depth: per axis the neighbour on the flatter side
          // (screen-space derivatives of the half-resolution reconstruction stepped across depth
          // texels in rows, which read as horizontal self-occlusion bands on the flat turf).
          vec2 tx = uDepthTexel * 3.0; // a 3-texel baseline: depth quantisation steps average out
          vec2 uL = vUv - vec2(tx.x, 0.0), uR = vUv + vec2(tx.x, 0.0), uD = vUv - vec2(0.0, tx.y), uU = vUv + vec2(0.0, tx.y);
          vec3 PL = viewPos(uL, viewZ(uL)), PR = viewPos(uR, viewZ(uR)), PD = viewPos(uD, viewZ(uD)), PU = viewPos(uU, viewZ(uU));
          vec3 ddx = abs(PR.z - P.z) < abs(P.z - PL.z) ? PR - P : P - PL;
          vec3 ddy = abs(PU.z - P.z) < abs(P.z - PD.z) ? PU - P : P - PD;
          vec3 N = normalize(cross(ddx, ddy));
          if (dot(N, P) > 0.0) N = -N;
          float rPx = clamp(uRadius * uProj.y * 0.5 * uRes.y / -z, 2.0, 48.0);
          float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
          float ao = 0.0;
          for (int i = 0; i < 10; i++) {
            float fi = float(i);
            float ang = (fi + ign) * 2.39996;
            float rr = (fi + 0.5 + ign) / 10.0;
            vec2 off = vec2(cos(ang), sin(ang)) * rPx * rr / uRes;
            vec2 suv = vUv + off;
            float sd = texture2D(tDepth, suv).x;
            vec3 S = viewPos(suv, viewZ(suv));
            vec3 v = S - P;
            float dist = length(v);
            // Height above the receiver's plane, less a depth-precision allowance that grows with
            // z^2 (a step of the depth buffer must not read as an occluder on flat ground).
            float occ = max(0.0, (dot(N, v) - uEps * z * z) / max(dist, 1e-4) - uBias);
            float fall = 1.0 - smoothstep(uRadius * 0.6, uRadius * 1.6, dist);
            ao += sd >= 0.99999 ? 0.0 : occ * fall;
          }
          ao = 1.0 - ao / 10.0 * 2.8;
          // Fade with distance: far creases are sub-pixel and the scale cue matters near the player.
          ao = mix(ao, 1.0, smoothstep(25.0, 45.0, -z));
          gl_FragColor = vec4(vec3(clamp(ao, 0.0, 1.0)), 1.0);
        }`,
      depthTest: false,
      depthWrite: false,
    });
    this.compMat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null }, tAO: { value: null }, tDepth: { value: null }, uNear: { value: 0.02 }, uFar: { value: 120 },
        uProj: { value: new THREE.Vector2(1, 1) }, uTexel: { value: new THREE.Vector2(1, 1) }, uStrength: { value: strength },
        uDebug: { value: 0 },
      },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: /* glsl */ `
        ${common}
        uniform sampler2D tDiffuse;
        uniform sampler2D tAO;
        uniform vec2 uTexel;
        uniform float uStrength;
        uniform float uDebug;
        varying vec2 vUv;
        void main() {
          vec4 c = texture2D(tDiffuse, vUv);
          if (uDebug > 1.5) { gl_FragColor = vec4(vec3(fract(-viewZ(vUv) / 10.0)), 1.0); return; }
          float z0 = viewZ(vUv);
          float sum = 0.0, wsum = 0.0;
          for (int y = -1; y <= 1; y++) {
            for (int x = -1; x <= 1; x++) {
              vec2 uv = vUv + vec2(float(x), float(y)) * uTexel * 2.0;
              float w = 1.0 / (1.0 + abs(viewZ(uv) - z0) * 8.0 / max(-z0, 0.5));
              sum += texture2D(tAO, uv).r * w;
              wsum += w;
            }
          }
          float ao = sum / max(wsum, 1e-4);
          if (uDebug > 0.5) { gl_FragColor = vec4(vec3(ao), 1.0); return; }
          gl_FragColor = finite(vec4(c.rgb * mix(1.0, ao, uStrength), c.a));
        }`,
      depthTest: false,
      depthWrite: false,
    });
    this.copyMat = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        varying vec2 vUv;
        bool bad(float x) { return (floatBitsToUint(x) & 0x7f800000u) == 0x7f800000u; }
        void main() {
          vec4 c = texture2D(tDiffuse, vUv);
          gl_FragColor = (bad(c.r) || bad(c.g) || bad(c.b) || bad(c.a)) ? vec4(0.0, 0.0, 0.0, 1.0) : c;
        }`,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.aoMat);
  }

  setSize(w, h) {
    this.aoTarget.setSize(Math.max(1, Math.floor(w / 2)), Math.max(1, Math.floor(h / 2)));
    this.compMat.uniforms.uTexel.value.set(1 / Math.max(1, w), 1 / Math.max(1, h));
  }

  render(renderer, writeBuffer, readBuffer) {
    this.resolve(renderer, this.renderToScreen ? null : writeBuffer, readBuffer);
  }

  /**
   * Writes `src` (colour + resolved depth texture) into `out`, darkened by the contact AO when
   * enabled, with non-finite pixels zeroed either way.
   */
  resolve(renderer, out, src) {
    const depth = src.depthTexture;
    if (!this.enabled || this.strength <= 0 || !depth || !this.camera.isPerspectiveCamera) {
      this.copyMat.uniforms.tDiffuse.value = src.texture;
      this.quad.material = this.copyMat;
      renderer.setRenderTarget(out);
      this.quad.render(renderer);
      return;
    }
    const cam = this.camera, pm = cam.projectionMatrix.elements;
    for (const m of [this.aoMat, this.compMat]) {
      const u = m.uniforms;
      u.tDepth.value = depth;
      u.uNear.value = cam.near;
      u.uFar.value = cam.far;
      u.uProj.value.set(pm[0], pm[5]);
    }
    this.aoMat.uniforms.uRadius.value = this.radius;
    this.aoMat.uniforms.uRes.value.set(this.aoTarget.width, this.aoTarget.height);
    this.aoMat.uniforms.uDepthTexel.value.set(1 / Math.max(1, src.width), 1 / Math.max(1, src.height));
    this.quad.material = this.aoMat;
    renderer.setRenderTarget(this.aoTarget);
    this.quad.render(renderer);
    const cu = this.compMat.uniforms;
    cu.tDiffuse.value = src.texture;
    cu.tAO.value = this.aoTarget.texture;
    cu.uStrength.value = this.strength;
    this.quad.material = this.compMat;
    renderer.setRenderTarget(out);
    this.quad.render(renderer);
  }

  dispose() {
    this.aoTarget.dispose();
    this.aoMat.dispose();
    this.compMat.dispose();
    this.copyMat.dispose();
    this.quad.dispose();
  }
}

/**
 * The scene render: draws into its own MSAA half-float target with a resolved depth texture, then
 * writes one resolved copy into the composer chain with the contact AO (when enabled) and the NaN
 * guard folded in. The ping-pong targets after it are single-sample and depthless, so bloom and
 * output are plain full-screen writes: the chain used to run every post pass at 4x MSAA plus a
 * colour + depth resolve each (measured ~30% of the frame on a software rasteriser).
 */
export class ScenePass extends Pass {
  constructor(scene, camera, { samples = 4, ao = 0 } = {}) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.needsSwap = true;
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      samples,
      depthTexture: new THREE.DepthTexture(1, 1, THREE.UnsignedIntType),
    });
    this.ao = new ContactAOPass(camera, { strength: ao });
    this.ao.enabled = ao > 0;
  }

  setSize(w, h) {
    this.target.setSize(w, h);
    this.ao.setSize(w, h);
  }

  render(renderer, writeBuffer) {
    const auto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.target);
    renderer.clear();
    renderer.render(this.scene, this.camera);
    renderer.autoClear = auto;
    this.ao.resolve(renderer, this.renderToScreen ? null : writeBuffer, this.target);
  }

  dispose() {
    this.target.depthTexture?.dispose();
    this.target.dispose();
    this.ao.dispose();
  }
}

/** OutputPass (tone mapping + output colour space) with the venue grade applied in the same pass. */
export class GradedOutputPass extends OutputPass {
  constructor() {
    super();
    for (const [k, v] of Object.entries(GRADE_SHADER.uniforms)) {
      if (k !== 'tDiffuse') this.uniforms[k] = { value: v.value.clone ? v.value.clone() : v.value };
    }
    this.material.uniforms = this.uniforms;
    const fs = this.material.fragmentShader;
    const at = fs.indexOf('varying vec2 vUv;') + 'varying vec2 vUv;'.length;
    const end = fs.lastIndexOf('}');
    this.material.fragmentShader = `${fs.slice(0, at)}\n${GRADE_GLSL}\n${fs.slice(at, end)}\n\tgl_FragColor = gradeColor(gl_FragColor);\n${fs.slice(end)}`;
    this.material.needsUpdate = true;
  }
}

/**
 * Copies a venue grade ({lift, gamma, gain: [r,g,b], saturation, contrast, warmth, vignette}, see
 * venues/meta.js) into GRADE_SHADER-style uniforms (a GradedOutputPass's or a grade ShaderPass's).
 */
export function applyGradeUniforms(u, grade, aspect = 16 / 9) {
  const g = grade || {};
  const v3 = (dst, a, d) => dst.set(...(Array.isArray(a) && a.length === 3 ? a : [d, d, d]));
  v3(u.uLift.value, g.lift, 0);
  v3(u.uGamma.value, g.gamma, 1);
  v3(u.uGain.value, g.gain, 1);
  u.uSat.value = g.saturation ?? 1;
  u.uContrast.value = g.contrast ?? 1;
  u.uWarmth.value = g.warmth ?? 0;
  u.uVignette.value = g.vignette ?? 0;
  u.uAspect.value = aspect;
}

/**
 * Quality tiers. `turfSize`/`envSize`/`neighbors`/`fillLights` are read by environment.js at
 * build time; everything else is applied live by setQuality().
 */
export const QUALITY = {
  ultra: {
    msaa: 4, fxaa: false, smaa: true, maxPixelRatio: 2, shadowMapSize: 4096, shadowRadius: 6,
    bloom: true, bloomStrength: 0.22, turfSize: 2048, envSize: 512, neighbors: true, fillLights: true, ao: 0.85, turfShells: 4,
  },
  high: {
    msaa: 4, fxaa: false, smaa: true, maxPixelRatio: 1.5, shadowMapSize: 2048, shadowRadius: 5,
    bloom: true, bloomStrength: 0.2, turfSize: 2048, envSize: 256, neighbors: true, fillLights: true, ao: 0.7, turfShells: 3,
  },
  balanced: {
    msaa: 0, fxaa: true, smaa: false, maxPixelRatio: 1.0, shadowMapSize: 1024, shadowRadius: 3,
    bloom: true, bloomStrength: 0.18, turfSize: 1024, envSize: 256, neighbors: true, fillLights: false, ao: 0, turfShells: 0,
  },
};

/** GPU frame time the dynamic resolution aims for when timer queries are available (ms). */
export const GPU_TARGET_MS = 12.5;

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
  // Read by environment.js: the live tier (venue swaps build for it) and a re-apply hook.
  scene.userData.quality = tier;

  const camera = new THREE.PerspectiveCamera(fov, 16 / 9, 0.02, 120);
  camera.position.set(0, 1.64, 8);
  camera.lookAt(0, 1.2, -10);

  const deviceRatio = () => (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);
  // Apple-silicon GPUs on a Retina / HiDPI display (dpr 2) with GPU timing available: the high tier
  // may climb to 1.75 (the GPU-time controller below holds 60 fps); otherwise the tier's cap.
  const gpuName = (() => {
    try {
      const gl = renderer.getContext();
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
    } catch {
      return '';
    }
  })();
  const appleGpu = /apple/i.test(gpuName) && !/swiftshader|software/i.test(gpuName);
  let gpuTimerReady = false;
  const tierCap = () => q.maxPixelRatio + (appleGpu && gpuTimerReady && tier === 'high' ? 0.25 : 0);
  const maxRatio = () => Math.min(deviceRatio(), 2, tierCap());
  let pixelRatio = maxRatio();
  let width = canvas.clientWidth || canvas.width || 1280;
  let height = canvas.clientHeight || canvas.height || 720;

  let composer = null;
  let scenePass = null;
  let aoPass = null;
  let bloomPass = null;
  let outputPass = null;
  let fxaaPass = null;
  let smaaPass = null;
  let gradeSeen = -1;

  function buildComposer() {
    composer?.renderTarget1?.dispose();
    composer?.renderTarget2?.dispose();
    bloomPass?.dispose?.();
    scenePass?.dispose();
    outputPass?.dispose();
    fxaaPass?.dispose?.();
    smaaPass?.dispose?.();
    const tw = Math.max(1, width * pixelRatio), th = Math.max(1, height * pixelRatio);
    // Single-sample, depthless HDR ping-pong: MSAA and depth live in the ScenePass target only.
    const target = new THREE.WebGLRenderTarget(tw, th, { type: THREE.HalfFloatType, depthBuffer: false });
    composer = new EffectComposer(renderer, target);
    composer.setPixelRatio(pixelRatio);
    composer.setSize(width, height);
    scenePass = new ScenePass(scene, camera, { samples: q.msaa, ao: q.ao || 0 });
    aoPass = scenePass.ao;
    composer.addPass(scenePass);
    bloomPass = new UnrealBloomPass(new THREE.Vector2(width, height), q.bloomStrength, 0.12, BLOOM_THRESHOLD);
    bloomPass.enabled = q.bloom;
    composer.addPass(bloomPass);
    outputPass = new GradedOutputPass();
    composer.addPass(outputPass);
    gradeSeen = -1;
    smaaPass = new SMAAPass();
    smaaPass.enabled = !!q.smaa;
    composer.addPass(smaaPass);
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
    if (outputPass) outputPass.uniforms.uAspect.value = camera.aspect;
  }

  /** Copies the venue's grade (scene.userData.grade) into the grade pass when it changes. */
  function syncGrade() {
    const ver = scene.userData.gradeVersion ?? 0;
    if (ver === gradeSeen || !outputPass) return;
    gradeSeen = ver;
    applyGradeUniforms(outputPass.uniforms, scene.userData.grade, camera.aspect);
  }

  /** Tier-dependent scene state: fill lights, hemisphere boost, wire-mesh alpha mode. */
  function applySceneTier() {
    scene.traverse((o) => {
      if (o.isLight && o.userData.fill) o.visible = q.fillLights;
      if (o.isHemisphereLight && o.userData.baseIntensity !== undefined) {
        o.intensity = o.userData.baseIntensity * (o.userData.noFillBoost ? 1 : q.fillLights ? 1 : 2.5);
      }
      const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      for (const m of mats) {
        if (typeof m.userData?.onTier === 'function') m.userData.onTier(q);
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
  // With GPU timer queries (Chrome on macOS / Windows) it steers by the measured GPU time of the
  // frame toward GPU_TARGET_MS, so it also climbs back up while the display is vsync-capped at 60;
  // without them (Safari, software GL) by the frame rate.
  const dyn = { enabled: dynamicResolution, acc: 0, frames: 0, slow: 0, fast: 0, lastChange: 0, now: 0 };
  const gpuTimer = createGpuTimer(renderer);
  gpuTimerReady = !!gpuTimer;
  function updateDynamicResolution(dt) {
    if (!dyn.enabled) return;
    dyn.now += dt;
    dyn.acc += dt;
    dyn.frames++;
    if (dyn.acc < 0.5) return;
    const fps = dyn.frames / dyn.acc;
    dyn.acc = 0;
    dyn.frames = 0;
    const since = dyn.now - dyn.lastChange;
    let next = pixelRatio;
    const gpu = gpuTimer ? gpuTimer.ms : 0;
    if (gpu > 0) {
      // Fill-rate bound: GPU time scales ~ with the pixel count (ratio squared).
      if (gpu > GPU_TARGET_MS * 1.12 && since > 0.75) next = pixelRatio * Math.max(0.82, Math.min(0.96, Math.sqrt(GPU_TARGET_MS / gpu)));
      else if (gpu < GPU_TARGET_MS * 0.72 && fps > 55 && since > 2.0) next = pixelRatio * Math.min(1.08, Math.sqrt(GPU_TARGET_MS / gpu));
    } else {
      if (fps < 54) {
        dyn.slow++;
        dyn.fast = 0;
      } else if (fps > 58.5) {
        dyn.fast++;
        dyn.slow = 0;
      } else {
        dyn.slow = dyn.fast = 0;
      }
      if (dyn.slow >= 2 && since > 1.0) next = pixelRatio * 0.88;
      else if (dyn.fast >= 6 && since > 3.0) next = pixelRatio * 1.08;
    }
    next = Math.max(MIN_PIXEL_RATIO, Math.min(maxRatio(), next));
    if (Math.abs(next - pixelRatio) > 0.01) {
      pixelRatio = Math.round(next * 100) / 100;
      dyn.lastChange = dyn.now;
      dyn.slow = dyn.fast = 0;
      applySize();
    }
  }

  const stats = { fps: 0, drawCalls: 0, triangles: 0, pixelRatio, frameMs: 0, gpuMs: 0 };
  let lastT = null;

  // Shader warm-up: compile every material in the scene graph in one batch, hidden pools included
  // (skid marks, impact rings, ball motion blur, crowd poses...). Otherwise each one compiles on
  // first use mid-rally, and three's compile check is a synchronous GL round trip that also waits
  // for the previous frame: one hitch per new shader (seconds each on a software rasteriser).
  // Re-runs when the venue changes (gradeVersion), when the realistic people / forearms rebuild
  // after their assets load (peopleVersion), and on frames 3 / 30 for content added late.
  let warmSeen = '';
  let frameNo = 0;
  function warmShaders() {
    frameNo++;
    const key = `${scene.userData.gradeVersion ?? 0}|${scene.userData.peopleVersion ?? 0}`;
    if (key === warmSeen && frameNo !== 3 && frameNo !== 30) return;
    warmSeen = key;
    const prev = renderer.getRenderTarget();
    try {
      // Bound to the scene target so the variants match the real draw (linear output, no tone
      // mapping): compiling against the canvas would build a second, never-used set.
      renderer.setRenderTarget(scenePass ? scenePass.target : null);
      renderer.compile(scene, camera);
      // Run three's first-use program checks now, in one batch, rather than on first draw.
      for (const prog of renderer.info.programs || []) prog.getUniforms?.();
    } catch {
      // A broken shader reports itself on the real draw; warm-up is best effort.
    } finally {
      renderer.setRenderTarget(prev);
    }
  }

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
    /** Renderer string (WEBGL_debug_renderer_info) and whether GPU timing drives the resolution. */
    get gpu() {
      return { name: gpuName, apple: appleGpu, timer: !!gpuTimer, ms: gpuTimer ? gpuTimer.ms : 0 };
    },
    setQuality(next) {
      if (!QUALITY[next]) return;
      const msaaChanged = QUALITY[next].msaa !== q.msaa;
      tier = next;
      q = QUALITY[tier];
      scene.userData.quality = tier;
      pixelRatio = Math.min(pixelRatio, maxRatio());
      if (msaaChanged) buildComposer();
      bloomPass.enabled = q.bloom;
      bloomPass.strength = q.bloomStrength;
      aoPass.enabled = (q.ao || 0) > 0;
      aoPass.strength = q.ao || 0;
      fxaaPass.enabled = q.fxaa;
      smaaPass.enabled = !!q.smaa;
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
      syncGrade();
      warmShaders();
      const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
      gpuTimer?.begin();
      composer.render(dt);
      gpuTimer?.end();
      stats.frameMs = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
      stats.gpuMs = gpuTimer ? Math.round(gpuTimer.ms * 100) / 100 : 0;
      stats.drawCalls = renderer.info.render.calls;
      stats.triangles = renderer.info.render.triangles;
      stats.pixelRatio = pixelRatio;
    },
    /** Contact AO pass (strength / radius, enabled by tier). */
    get aoPass() {
      return aoPass;
    },
    dispose() {
      composer.renderTarget1.dispose();
      composer.renderTarget2.dispose();
      gpuTimer?.dispose();
      smaaPass?.dispose?.();
      scenePass?.dispose();
      outputPass?.dispose();
      bloomPass.dispose?.();
      renderer.dispose();
    },
  };

  scene.userData.refreshQuality = () => {
    applyShadowQuality();
    applySceneTier();
  };
  buildComposer();
  applySize();
  return api;
}

/**
 * GPU frame timer from EXT_disjoint_timer_query_webgl2 (null when unavailable). Non-blocking: a
 * small ring of queries, results read a few frames later; `ms` is a smoothed GPU time per frame.
 */
export function createGpuTimer(renderer) {
  let gl = null, ext = null;
  try {
    gl = renderer.getContext();
    ext = gl && typeof gl.createQuery === 'function' ? gl.getExtension('EXT_disjoint_timer_query_webgl2') : null;
  } catch {
    ext = null;
  }
  if (!ext) return null;
  const ring = [];
  let active = null;
  const t = {
    ms: 0,
    samples: 0,
    begin() {
      if (active) return;
      // Collect finished queries first (oldest first), never waiting on the GPU.
      while (ring.length) {
        const q = ring[0];
        if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
        ring.shift();
        const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
        const ns = gl.getQueryParameter(q, gl.QUERY_RESULT);
        gl.deleteQuery(q);
        if (!disjoint && Number.isFinite(ns) && ns > 0) {
          const v = ns / 1e6;
          t.ms = t.samples ? t.ms + (v - t.ms) * 0.15 : v;
          t.samples++;
        }
      }
      if (ring.length > 4) return; // results not coming back: skip measuring this frame
      active = gl.createQuery();
      gl.beginQuery(ext.TIME_ELAPSED_EXT, active);
    },
    end() {
      if (!active) return;
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      ring.push(active);
      active = null;
    },
    dispose() {
      for (const q of ring) gl.deleteQuery(q);
      ring.length = 0;
    },
  };
  return t;
}
