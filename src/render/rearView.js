// Rear-view mirror inset (settings.glassView = 'mirror', the default). Real-world session:
// "turning to the glass wasn't really fluid" — the main first-person view now stays facing the
// net, and while the ball is behind the player's eye on its way to / back from the back or side
// glass, a car-style mirror at the top centre shows the rebound: a second camera at the player's
// head looking back, mirrored horizontally (what is behind you on the left shows on the left),
// rendered cheaply (a small half-float target at reduced resolution, no post-processing, the
// shadow maps of the main view reused) and drawn as a rounded inset with ACES + sRGB applied.
// It fades in as the ball passes the eye plane and out once the ball is back in front.
import * as THREE from 'three';
import { isFiniteVec } from './safeView.js';

export const REAR_VIEW = Object.freeze({
  WIDTH: 0.3, // of the canvas width
  ASPECT: 2.4, // inset width / height
  TOP: 0.02, // gap above the inset (fraction of the canvas height)
  HFOV: 92, // horizontal field of view of the mirror camera (deg): the back glass corner to corner
  PITCH: -10, // deg (looking down a little: the floor in front of the glass shows the bounce)
  GAIN: 1.35, // brightness of the mirror image (the hall behind the glass is dark)
  RES: 0.75, // render resolution relative to the inset's device pixels
  FADE_IN: 0.12, // s
  FADE_OUT: 0.3, // s
  HOLD: 0.5, // s shown at least, once up (no flicker at the eye plane)
  // The hold is released once the ball is back at the eye plane and coming toward the net (merge
  // pass: off the glass the contact is only ~0.25 m in front of the eye, so the held mirror was
  // still fully up, showing an empty glass, at the moment to swing): it fades out quickly then.
  RELEASE_DZ: 0.1, // m: ball no more than this behind the eye
  RELEASE_VZ: -1, // m/s (toward the net)
  RELEASE_FADE: 0.15, // s
  RADIUS: 0.16, // corner radius (fraction of the inset height)
});

const QUAD_SHADER = {
  uniforms: {
    tMap: { value: null },
    opacity: { value: 0 },
    size: { value: new THREE.Vector2(1, 1) },
    radius: { value: 10 },
    gain: { value: 1 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tMap;
    uniform float opacity;
    uniform vec2 size;
    uniform float radius;
    uniform float gain;
    varying vec2 vUv;
    float sdRound(vec2 p, vec2 b, float r) {
      vec2 q = abs(p) - b + r;
      return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
    }
    void main() {
      vec2 p = (vUv - 0.5) * size;
      float d = sdRound(p, size * 0.5, radius);
      if (d > 0.0) discard;
      // Car mirror: flipped left / right.
      vec4 c = texture2D(tMap, vec2(1.0 - vUv.x, vUv.y));
      gl_FragColor = vec4(c.rgb * gain, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      // Dark frame with a thin glass-cyan rim.
      float rim = smoothstep(-5.0, -3.0, d);
      float edge = smoothstep(-2.2, -1.2, d) * (1.0 - smoothstep(-1.0, 0.0, d));
      gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.02, 0.03, 0.05), rim * 0.85);
      gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.55, 0.89, 0.93), edge * 0.6);
      gl_FragColor.a = opacity * (1.0 - smoothstep(-1.0, 0.0, d));
    }`,
};

/**
 * @param {{ renderer: THREE.WebGLRenderer, scene: THREE.Scene }} app
 * @returns {{ update(dt, { want, eye, ball }), render(hidden?: THREE.Object3D[]), opacity, camera, rect(), dispose() }}
 */
export function createRearView(app) {
  const { renderer, scene } = app;
  const camera = new THREE.PerspectiveCamera(40, REAR_VIEW.ASPECT, 0.05, 60);
  camera.rotation.order = 'YXZ';
  // Lets camera-facing aids (ballView's reach ring, labels) tell the mirror from the player's view.
  camera.userData.isMirror = true;
  camera.name = 'rear-view-mirror';
  const target = new THREE.WebGLRenderTarget(16, 16, { type: THREE.HalfFloatType, samples: 0 });
  target.texture.colorSpace = THREE.LinearSRGBColorSpace;
  const material = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.clone(QUAD_SHADER.uniforms),
    vertexShader: QUAD_SHADER.vertexShader,
    fragmentShader: QUAD_SHADER.fragmentShader,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: true,
  });
  material.uniforms.tMap.value = target.texture;
  material.uniforms.gain.value = REAR_VIEW.GAIN;
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  const quadScene = new THREE.Scene();
  quadScene.add(quad);
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const vfov = (2 * Math.atan(Math.tan((REAR_VIEW.HFOV * Math.PI) / 360) / REAR_VIEW.ASPECT) * 180) / Math.PI;
  camera.fov = vfov;
  camera.updateProjectionMatrix();

  let opacity = 0;
  let shownFor = 0;
  let aimX = null, aimY = null;
  const size = new THREE.Vector2();
  const vp = new THREE.Vector4();
  const stats = { frames: 0 };

  /** Inset rectangle in CSS pixels {x, y (from the top), w, h} for the current canvas size. */
  function rect() {
    renderer.getSize(size);
    const w = Math.round(size.x * REAR_VIEW.WIDTH);
    const h = Math.round(w / REAR_VIEW.ASPECT);
    return { x: Math.round((size.x - w) / 2), y: Math.round(size.y * REAR_VIEW.TOP), w, h, canvasH: size.y };
  }

  /**
   * want: show the mirror (ball behind the eye, mirror mode, first-person, no head tracking);
   * eye: the player's eye (court); ball: the shown ball (aims the mirror a little toward it).
   */
  function update(dt, { want = false, eye = null, ball = null } = {}) {
    if (!(dt >= 0)) dt = 0;
    const ok = want && isFiniteVec(eye);
    if (ok) shownFor = 0;
    else shownFor += dt;
    const back = !ok && isFiniteVec(eye) && ball && isFiniteVec(ball.pos) && ball.vel && Number.isFinite(ball.vel.z)
      && ball.pos.z < eye.z + REAR_VIEW.RELEASE_DZ && ball.vel.z < REAR_VIEW.RELEASE_VZ;
    const up = ok || (opacity > 0 && shownFor < REAR_VIEW.HOLD && !back);
    opacity = up ? Math.min(1, opacity + dt / REAR_VIEW.FADE_IN) : Math.max(0, opacity - dt / (back ? REAR_VIEW.RELEASE_FADE : REAR_VIEW.FADE_OUT));
    if (!isFiniteVec(eye)) return;
    // At the head, looking back at the glass; turned a little toward the ball's side.
    const hasBall = ball && isFiniteVec(ball.pos);
    const bx = hasBall ? ball.pos.x : eye.x;
    const by = hasBall ? ball.pos.y : eye.y;
    const k = 1 - Math.exp(-4 * dt);
    aimX = aimX === null ? bx : aimX + (bx - aimX) * k;
    aimY = aimY === null ? by : aimY + (by - aimY) * k;
    camera.position.set(eye.x, eye.y + 0.04, eye.z - 0.05);
    // Toward the ball's side and height at the back glass (smoothed), never far off straight back.
    const gz = Math.max(1, 10 - eye.z);
    const yaw = Math.PI + THREE.MathUtils.clamp(Math.atan2(aimX - eye.x, gz) * 0.8, -0.45, 0.45);
    const pitch = THREE.MathUtils.clamp(Math.atan2(aimY - eye.y, gz) * 0.7 + (REAR_VIEW.PITCH * Math.PI) / 180, -0.4, 0.15);
    camera.rotation.set(pitch, yaw, 0);
    camera.updateMatrixWorld();
  }

  /** Draws the inset over the frame already on screen. hidden: objects not seen in a mirror (the first-person rig). */
  function render(hidden = []) {
    if (opacity <= 0.005) return false;
    const r = rect();
    if (r.w < 8 || r.h < 4) return false;
    const pr = renderer.getPixelRatio();
    const tw = Math.max(16, Math.round(r.w * pr * REAR_VIEW.RES)), th = Math.max(8, Math.round(r.h * pr * REAR_VIEW.RES));
    if (target.width !== tw || target.height !== th) target.setSize(tw, th);
    const was = hidden.map((o) => o.visible);
    hidden.forEach((o) => { o.visible = false; });
    const autoShadow = renderer.shadowMap.autoUpdate;
    const autoClear = renderer.autoClear;
    renderer.shadowMap.autoUpdate = false; // reuse the main view's shadow maps
    const prevTarget = renderer.getRenderTarget();
    renderer.getViewport(vp);
    try {
      renderer.setRenderTarget(target);
      renderer.autoClear = true;
      renderer.clear();
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
      material.uniforms.opacity.value = opacity;
      material.uniforms.size.value.set(r.w, r.h);
      material.uniforms.radius.value = r.h * REAR_VIEW.RADIUS;
      renderer.autoClear = false;
      renderer.setViewport(r.x, r.canvasH - r.y - r.h, r.w, r.h);
      renderer.render(quadScene, quadCam);
      stats.frames++;
    } finally {
      renderer.setViewport(vp);
      renderer.setRenderTarget(prevTarget);
      renderer.autoClear = autoClear;
      renderer.shadowMap.autoUpdate = autoShadow;
      hidden.forEach((o, i) => { o.visible = was[i]; });
    }
    return true;
  }

  return {
    update,
    render,
    rect,
    camera,
    stats,
    get opacity() { return opacity; },
    get visible() { return opacity > 0.005; },
    dispose() {
      target.dispose();
      material.dispose();
      quad.geometry.dispose();
    },
  };
}
