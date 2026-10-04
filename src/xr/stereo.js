// Side-by-side stereo for the VITURE Beast's 3D mode (experimental). Left eye -> left half,
// right eye -> right half; each eye is the app camera moved ±IPD/2 along its own right axis
// (parallel axes, like a headset: each eye has its own display), with the eye's vertical FOV
// (camera.fov, which the glasses profile overrides) and the aspect each half is SHOWN at, so it
// works for full SBS (3840×1200, halves shown 1:1) and half SBS (1920×1200, halves stretched ×2).
//
// Post-processing is optional and cheap: 'post' renders each eye through a small composer of
// its own (MSAA render target -> NaN guard -> tone mapping + sRGB, no bloom); 'fast' renders
// straight to the canvas (tone mapping in the materials, no anti-aliasing). Shadow maps are
// rendered once per frame (the second eye reuses them).
//
// DOM overlays cannot be stereo, so a minimal head-locked HUD (reps / points / last shot / miss
// reason / prompt) is drawn into the world 2 m in front of the head after each eye.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FINITE_GUARD_SHADER } from '../render/scene.js';
import { sbsLayout, eyeOffsets, hudPlacement, BEAST } from './display.js';
import { hudLines } from './hudText.js';

const FONT_DISPLAY = '"Big Shoulders Display", "Barlow Semi Condensed", "Arial Narrow", sans-serif';
const FONT_UI = '"Barlow Semi Condensed", "Arial Narrow", system-ui, sans-serif';
const C = { panel: 'rgba(6, 12, 21, 0.74)', line: 'rgba(139, 228, 238, 0.55)', glass: '#8be4ee', text: '#f4efe4', text2: 'rgba(244, 239, 228, 0.78)', ball: '#dcf53c', warn: '#ffb35c' };

/**
 * Head-locked HUD strip: one canvas texture on a plane that each eye renders with its own
 * parallax (so it sits at a real depth, 2 m away, in both eyes).
 */
export function createStereoHud({ width = 1024, height = 256 } = {}) {
  const canvas = typeof OffscreenCanvas !== 'undefined' && typeof document === 'undefined'
    ? new OffscreenCanvas(width, height)
    : Object.assign(document.createElement('canvas'), { width, height });
  const ctx = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false });
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  plane.renderOrder = 1e6;
  plane.frustumCulled = false;
  plane.name = 'xr-hud';
  const root = new THREE.Group();
  root.name = 'xr-hud-root';
  root.add(plane);
  let key = null;
  let visible = true;

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function fit(text, font, maxW) {
    ctx.font = font;
    if (ctx.measureText(text).width <= maxW) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
    return `${t}…`;
  }

  function draw(L) {
    const W = width, H = height;
    ctx.clearRect(0, 0, W, H);
    if (!L.title && !L.reps && !L.points && !L.shot && !L.note) return;
    const pad = 22;
    roundRect(4, 4, W - 8, H - 8, 18);
    ctx.fillStyle = C.panel;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = C.line;
    ctx.stroke();
    ctx.textBaseline = 'alphabetic';
    // Row 1: title + reps (left), points + streak (right).
    ctx.textAlign = 'left';
    ctx.fillStyle = C.glass;
    ctx.fillText(fit(L.title.toUpperCase(), `700 30px ${FONT_UI}`, W * 0.45), pad, 48);
    ctx.fillStyle = C.text;
    ctx.fillText(fit(L.reps, `800 52px ${FONT_DISPLAY}`, W * 0.5), pad, 104);
    ctx.textAlign = 'right';
    ctx.fillStyle = C.ball;
    ctx.fillText(L.points, W - pad, 104);
    ctx.font = `600 28px ${FONT_UI}`;
    ctx.fillStyle = C.text2;
    if (L.streak) ctx.fillText(L.streak, W - pad, 48);
    // Row 2: last shot or miss reason.
    ctx.textAlign = 'center';
    if (L.shot) {
      ctx.fillStyle = L.shotKind === 'miss' ? C.warn : L.shotKind === 'good' ? C.text : C.text2;
      ctx.fillText(fit(L.shot, `700 46px ${FONT_UI}`, W - 2 * pad), W / 2, 170);
    }
    // Row 3: banner / prompt.
    if (L.note) {
      ctx.fillStyle = C.glass;
      ctx.fillText(fit(L.note, `600 34px ${FONT_UI}`, W - 2 * pad), W / 2, 222);
    }
  }

  /** Redraws when the shown text changes. Returns true if it redrew. */
  function update(h) {
    const L = hudLines(h);
    if (L.key === key) return false;
    key = L.key;
    draw(L);
    tex.needsUpdate = true;
    return true;
  }

  const tmpPos = new THREE.Vector3(), tmpQuat = new THREE.Quaternion(), tmpScale = new THREE.Vector3();
  /** Locks the strip to the head (camera world pose) for a vertical FOV and eye aspect. */
  function place(camera, vfovDeg, aspect) {
    camera.matrixWorld.decompose(tmpPos, tmpQuat, tmpScale);
    root.position.copy(tmpPos);
    root.quaternion.copy(tmpQuat);
    const p = hudPlacement(vfovDeg, aspect, { texAspect: width / height });
    plane.position.set(0, p.y, -p.distance);
    plane.scale.set(p.width, p.height, 1);
    root.updateMatrixWorld(true);
  }

  return {
    root,
    plane,
    canvas,
    update,
    place,
    get visible() { return visible; },
    set visible(v) {
      visible = !!v;
      root.visible = visible;
    },
    /** True when there is something on the strip. */
    get hasContent() { return !!key && key.replace(/\|/g, '') !== ''; },
    dispose() {
      tex.dispose();
      mat.dispose();
      plane.geometry.dispose();
    },
  };
}

/**
 * @param {object} [o]
 * @param {number} [o.ipd]   metres (default 0.063)
 * @param {'auto'|'full'|'half'} [o.layout]
 * @param {boolean} [o.post] own composer (MSAA + tone mapping) per eye; false = straight to canvas
 * @param {boolean} [o.hud]
 */
export function createStereoRenderer({ ipd = BEAST.ipdMm / 1000, layout = 'auto', post = true, hud = true } = {}) {
  const eyes = [new THREE.PerspectiveCamera(), new THREE.PerspectiveCamera()];
  eyes[0].name = 'xr-eye-left';
  eyes[1].name = 'xr-eye-right';
  const hudScene = new THREE.Scene();
  const hudLayer = hud ? createStereoHud() : null;
  if (hudLayer) hudScene.add(hudLayer.root);
  const size = new THREE.Vector2();
  const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scl = new THREE.Vector3(), right = new THREE.Vector3();
  const stats = { frames: 0, frameMs: 0, drawCalls: 0, layout: null, eyeWidth: 0, eyeHeight: 0, post: false };

  let composer = null, renderPass = null, target = null, compKey = '';
  function ensureComposer(renderer, wPx, hPx, samples) {
    const k = `${wPx}x${hPx}x${samples}`;
    if (composer && k === compKey) return composer;
    disposeComposer();
    target = new THREE.WebGLRenderTarget(wPx, hPx, { type: THREE.HalfFloatType, samples });
    composer = new EffectComposer(renderer, target);
    composer.setPixelRatio(1);
    composer.setSize(wPx, hPx);
    renderPass = new RenderPass(new THREE.Scene(), eyes[0]);
    composer.addPass(renderPass);
    composer.addPass(new ShaderPass(FINITE_GUARD_SHADER));
    composer.addPass(new OutputPass());
    compKey = k;
    return composer;
  }
  function disposeComposer() {
    if (!composer) return;
    composer.renderTarget1.dispose();
    composer.renderTarget2.dispose();
    target = null;
    composer = null;
    compKey = '';
  }

  /**
   * Renders both eyes into the canvas (the app.xr.stereo.render contract).
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Scene} scene
   * @param {THREE.PerspectiveCamera} camera  the mono (head) camera, already posed this frame
   * @param {object} [appComposer]  the app's composer (its MSAA sample count is reused)
   */
  function render(renderer, scene, camera, appComposer) {
    const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
    renderer.getSize(size);
    const L = sbsLayout(size.x, size.y, api.layout);
    const pr = renderer.getPixelRatio();
    stats.layout = L.kind;
    camera.updateMatrixWorld();
    camera.matrixWorld.decompose(pos, quat, scl);
    right.set(1, 0, 0).applyQuaternion(quat);
    const offs = eyeOffsets(api.ipd);
    if (hudLayer) {
      hudLayer.place(camera, camera.fov, L.eyeAspect);
      hudLayer.root.visible = hudLayer.visible && hudLayer.hasContent;
    }
    const usePost = api.post;
    stats.post = usePost;
    if (usePost) {
      const samples = appComposer && appComposer.renderTarget1 ? appComposer.renderTarget1.samples || 0 : 4;
      ensureComposer(renderer, Math.max(1, Math.round(L.left.width * pr)), Math.max(1, Math.round(L.left.height * pr)), samples);
      renderPass.scene = scene;
    }
    stats.eyeWidth = Math.round(L.left.width * pr);
    stats.eyeHeight = Math.round(L.left.height * pr);
    const autoShadow = renderer.shadowMap.autoUpdate;
    const autoClear = renderer.autoClear;
    if (renderer.info.autoReset === false) renderer.info.reset();
    try {
      renderer.setRenderTarget(null);
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, size.x, size.y);
      renderer.clear(true, true, false);
      for (let i = 0; i < 2; i++) {
        const e = eyes[i];
        e.fov = camera.fov;
        e.aspect = L.eyeAspect;
        e.near = camera.near;
        e.far = camera.far;
        e.updateProjectionMatrix();
        e.position.copy(pos).addScaledVector(right, offs[i]);
        e.quaternion.copy(quat);
        e.updateMatrixWorld(true);
        const vp = i === 0 ? L.left : L.right;
        if (i === 1) renderer.shadowMap.autoUpdate = false;
        if (usePost) {
          renderPass.camera = e;
          renderer.setViewport(vp.x, vp.y, vp.width, vp.height);
          renderer.setScissor(vp.x, vp.y, vp.width, vp.height);
          renderer.setScissorTest(true);
          composer.render();
        } else {
          renderer.setRenderTarget(null);
          renderer.setViewport(vp.x, vp.y, vp.width, vp.height);
          renderer.setScissor(vp.x, vp.y, vp.width, vp.height);
          renderer.setScissorTest(true);
          renderer.autoClear = false;
          renderer.clear(true, true, false);
          renderer.render(scene, e);
        }
        if (hudLayer && hudLayer.root.visible) {
          renderer.setRenderTarget(null);
          renderer.setViewport(vp.x, vp.y, vp.width, vp.height);
          renderer.setScissor(vp.x, vp.y, vp.width, vp.height);
          renderer.setScissorTest(true);
          renderer.autoClear = false;
          renderer.clearDepth();
          renderer.render(hudScene, e);
        }
        renderer.autoClear = autoClear;
      }
    } finally {
      renderer.shadowMap.autoUpdate = autoShadow;
      renderer.autoClear = autoClear;
      renderer.setScissorTest(false);
      renderer.setRenderTarget(null);
      renderer.setViewport(0, 0, size.x, size.y);
    }
    stats.frames++;
    stats.drawCalls = renderer.info.render.calls;
    stats.frameMs = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
  }

  const api = {
    enabled: true,
    ipd,
    layout,
    post,
    eyes,
    hud: hudLayer,
    stats,
    render,
    dispose() {
      disposeComposer();
      if (hudLayer) hudLayer.dispose();
    },
  };
  return api;
}
