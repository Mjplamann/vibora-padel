// Padel ball renderer: felt + seam texture, visual spin, render interpolation, soft contact
// shadows (floor and nearby glass), a faint additive motion trail, optional halo and flashes,
// and the round-3 visibility aids (minimum on-screen size, glow, drop-line, reach ring).
import * as THREE from 'three';
import { BALL, COURT, SIM, RACKET } from '../config.js';
import { cached, hash2, tileNoise, heightToNormalCanvas, actorQuality } from './actorKit.js';
import { APPROACH, approachRadius } from './approach.js';

// Seam of a tennis/padel ball on the unit sphere: s(t) = (a cos t + b cos 3t, a sin t - b sin 3t, 2 sqrt(ab) sin 2t), a + b = 1.
function seamSamples(n = 220, b = 0.27) {
  const a = 1 - b;
  const k = 2 * Math.sqrt(a * b);
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    out[i * 3] = a * Math.cos(t) + b * Math.cos(3 * t);
    out[i * 3 + 1] = k * Math.sin(2 * t);
    out[i * 3 + 2] = a * Math.sin(t) - b * Math.sin(3 * t);
  }
  return out;
}

/** Equirect felt maps (color + normal) matching SphereGeometry UVs. Cached. */
export function ballFeltMaps() {
  return cached('ballFelt', () => {
    const W = actorQuality().tex < 1 ? 512 : 768, H = W / 2;
    const seam = seamSamples();
    const ns = seam.length / 3;
    const color = document.createElement('canvas');
    color.width = W;
    color.height = H;
    const height = document.createElement('canvas');
    height.width = W;
    height.height = H;
    const cctx = color.getContext('2d');
    const hctx = height.getContext('2d');
    const cimg = cctx.createImageData(W, H);
    const himg = hctx.createImageData(W, H);
    const halfW = 0.085; // seam half-width (radians)
    for (let py = 0; py < H; py++) {
      const theta = ((py + 0.5) / H) * Math.PI;
      const st = Math.sin(theta), ct = Math.cos(theta);
      for (let px = 0; px < W; px++) {
        const phi = ((px + 0.5) / W) * Math.PI * 2;
        const dx = -Math.cos(phi) * st, dy = ct, dz = Math.sin(phi) * st;
        let best = -1;
        for (let i = 0; i < ns; i++) {
          const d = dx * seam[i * 3] + dy * seam[i * 3 + 1] + dz * seam[i * 3 + 2];
          if (d > best) best = d;
        }
        const ang = Math.acos(Math.min(1, best));
        const seamW = 1 - THREE.MathUtils.smoothstep(ang, halfW * 0.65, halfW);
        const u = px / W, v = py / H;
        const fuzz = 0.6 * tileNoise(u * 2, v, 96, 1) + 0.4 * hash2(px, py, 3);
        const blotch = tileNoise(u, v, 8, 7);
        const i = (py * W + px) * 4;
        // Optic yellow felt with fibre variation; seam is off-white rubber.
        const r = 188 + fuzz * 34 - blotch * 14, g = 222 + fuzz * 26 - blotch * 10, bb = 18 + fuzz * 34;
        cimg.data[i] = r * (1 - seamW) + 236 * seamW;
        cimg.data[i + 1] = g * (1 - seamW) + 238 * seamW;
        cimg.data[i + 2] = bb * (1 - seamW) + 228 * seamW;
        cimg.data[i + 3] = 255;
        const hgt = (0.5 + 0.5 * fuzz) * (1 - seamW) + 0.15 * seamW;
        himg.data[i] = himg.data[i + 1] = himg.data[i + 2] = hgt * 255;
        himg.data[i + 3] = 255;
      }
    }
    cctx.putImageData(cimg, 0, 0);
    hctx.putImageData(himg, 0, 0);
    const map = new THREE.CanvasTexture(color);
    map.colorSpace = THREE.SRGBColorSpace;
    map.anisotropy = 4;
    const normal = new THREE.CanvasTexture(heightToNormalCanvas(height, 1.4));
    normal.colorSpace = THREE.NoColorSpace;
    return { map, normal };
  });
}

/** Shared felt material (also used for the machine hopper balls). */
export function createBallMaterial({ emissive = 0.07 } = {}) {
  const { map, normal } = ballFeltMaps();
  return new THREE.MeshPhysicalMaterial({
    map,
    normalMap: normal,
    normalScale: new THREE.Vector2(0.6, 0.6),
    roughness: 0.92,
    metalness: 0,
    sheen: 1,
    sheenRoughness: 0.4,
    sheenColor: new THREE.Color('#e9ff8a'),
    emissive: new THREE.Color('#cfe63a'),
    emissiveMap: map,
    emissiveIntensity: emissive,
  });
}

function blobTexture() {
  return cached('ballBlob', () => {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(0,0,0,1)');
    g.addColorStop(0.35, 'rgba(0,0,0,0.75)');
    g.addColorStop(0.7, 'rgba(0,0,0,0.25)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.NoColorSpace;
    return t;
  });
}

function haloTexture() {
  return cached('ballHalo', () => {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(64, 64, 6, 64, 64, 64);
    g.addColorStop(0, 'rgba(240,255,160,0.9)');
    g.addColorStop(0.25, 'rgba(225,255,90,0.35)');
    g.addColorStop(0.6, 'rgba(210,255,60,0.08)');
    g.addColorStop(1, 'rgba(200,255,60,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  });
}

/** Nearest glass wall within reach: returns {pos, normal, dist} or null. */
function nearestGlass(p, reach, out) {
  let best = null;
  const hw = COURT.halfWidth, hl = COURT.halfLength;
  // Back walls (glass 0..3 m across the full width).
  if (Math.abs(p.x) <= hw && p.y <= COURT.backWall.glassTop) {
    const d = hl - Math.abs(p.z);
    if (d >= 0 && d < reach) best = { d, axis: 'z', s: Math.sign(p.z) || 1 };
  }
  // Side walls, glass height by |z| band.
  const az = Math.abs(p.z);
  const band = COURT.sideWall.find((b) => az >= b.zMin && az <= b.zMax);
  if (band && p.y <= band.glassTop) {
    const d = hw - Math.abs(p.x);
    if (d >= 0 && d < reach && (!best || d < best.d)) best = { d, axis: 'x', s: Math.sign(p.x) || 1 };
  }
  if (!best) return null;
  if (best.axis === 'z') {
    out.pos.set(p.x, p.y, best.s * (hl - 0.012));
    out.normal.set(0, 0, -best.s);
  } else {
    out.pos.set(best.s * (hw - 0.012), p.y, p.z);
    out.normal.set(-best.s, 0, 0);
  }
  out.dist = best.d;
  return out;
}

// Ball visibility modes and the drawn-size rule live in the pure render/ballVisibility.js (round 6:
// tested under Node); re-exported here for compatibility.
export { BALL_VISIBILITY, ballDisplayScale, ENHANCED_TRUE_SIZE_WITHIN } from './ballVisibility.js';
import { BALL_VISIBILITY, ballDisplayScale } from './ballVisibility.js';

/**
 * Felt fuzz: a slightly larger shell whose alpha rises toward the silhouette and is broken into
 * fibres, so the ball's outline reads soft and hairy up close (sub-pixel and invisible far away).
 */
function createFuzzMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color('#cfe63a') }, uLight: { value: 1 } },
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vV; varying vec3 vL;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        vL = position;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uLight;
      varying vec3 vN; varying vec3 vV; varying vec3 vL;
      float h(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
      void main() {
        float rim = 1.0 - abs(dot(normalize(vN), normalize(vV)));
        float fib = h(floor(normalize(vL) * 140.0));
        float a = smoothstep(0.35, 1.0, rim) * (0.25 + 0.75 * fib) * 0.55;
        if (a < 0.02) discard;
        float lit = 0.45 + 0.55 * max(dot(normalize(vN), normalize(vec3(0.2, 1.0, 0.3))), 0.0);
        gl_FragColor = vec4(uColor * lit * uLight, a);
      }`,
    transparent: true,
    depthWrite: false,
  });
}

/**
 * Motion blur at speed: the ball swept over a 1/120 s exposure. The trailing hemisphere of a
 * sphere is pushed back along the velocity in the vertex shader (a capsule), and its alpha is the
 * time the ball covers each point of the streak: subtle at drive pace, a visible smear on smashes.
 * The solid ball stays drawn on top, so readability is never traded for the effect.
 */
export const BLUR_SHUTTER_S = 1 / 120;
function createBlurMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uCenter: { value: new THREE.Vector3() },
      uDir: { value: new THREE.Vector3(0, 0, 1) },
      uR: { value: 0.0325 },
      uLen: { value: 0 },
      uA: { value: 0 },
      uColor: { value: new THREE.Color('#d6ec4a') },
    },
    vertexShader: /* glsl */ `
      uniform vec3 uCenter; uniform vec3 uDir; uniform float uR; uniform float uLen;
      varying float vS;
      void main() {
        vec3 n = normalize(position);
        float back = clamp(-dot(n, uDir) * 3.0, 0.0, 1.0);
        vec3 p = uCenter + n * uR - uDir * uLen * back;
        vS = dot(p - uCenter, -uDir) / max(uLen + uR, 1e-4);
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uA; uniform vec3 uColor;
      varying float vS;
      void main() {
        float s = clamp(vS, 0.0, 1.0);
        float a = uA * pow(1.0 - s, 1.4) * step(0.0, vS);
        if (a < 0.004) discard;
        gl_FragColor = vec4(uColor, a);
      }`,
    transparent: true,
    depthWrite: false,
  });
}

const RING_GREEN = new THREE.Color('#3dff7a');
const GHOST_CYAN = new THREE.Color('#bff7ff');
// Approach circle colours (linear, a little over 1 so they survive the ACES output; below the bloom).
const APPROACH_WHITE = new THREE.Color(1.25, 1.27, 1.3);
const APPROACH_GREEN = new THREE.Color(0.3, 1.35, 0.55);
const APPROACH_PERFECT = new THREE.Color(0.55, 1.6, 0.75);
/** Approach circle line half-width as a fraction of the view height (~2.2 px at 876 px). */
const APPROACH_LINE = 0.00125;

/**
 * Approach circle (round 6, render/approach.js): one camera-facing quad, two rings drawn in its
 * fragment shader with a constant on-screen line width and a dark edge for contrast on bright courts:
 * the closing ring (uRa) and a faint target ring at the ball's outline (uRt), where it closes at t*.
 */
function createApproachMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uRa: { value: 0.4 }, uRt: { value: 0.1 }, uW: { value: 0.01 }, uA: { value: 0 }, uTA: { value: 0.35 },
      uColor: { value: new THREE.Color(1, 1, 1) },
    },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: /* glsl */ `
      varying vec2 vUv; uniform float uRa, uRt, uW, uA, uTA; uniform vec3 uColor;
      void main() {
        float r = length(vUv - 0.5);
        float px = fwidth(r);
        float ring = 1.0 - smoothstep(uW - px, uW + px, abs(r - uRa));
        float tgt = (1.0 - smoothstep(uW * 0.55 - px, uW * 0.55 + px, abs(r - uRt))) * uTA;
        float edge = (1.0 - smoothstep(uW, uW * 2.6 + px, abs(r - uRa))) * 0.5;
        float line = max(ring, tgt);
        float a = line + edge * (1.0 - line);
        float alpha = uA * a;
        if (alpha < 0.004) discard;
        gl_FragColor = vec4(uColor * (line / max(a, 1e-4)), alpha);
      }`,
    transparent: true,
    depthWrite: false,
    depthTest: false,
  });
}

const TRAIL_N = 28;
const TRAIL_SECONDS = 0.12;

/**
 * @param {THREE.Scene|THREE.Object3D} scene
 * @param {{halo?: boolean, trail?: boolean, shadows?: boolean}} opts
 * @returns {{ object: THREE.Group, update(ball, dt, alpha?), setVisible(b), setHalo(b), flash(kind) }}
 */
export function createBallView(scene, { halo = false, trail = true, shadows = true } = {}) {
  const group = new THREE.Group();
  group.name = 'ball-view';
  scene.add(group);
  const r = BALL.radius;

  const mat = createBallMaterial();
  const ball = new THREE.Mesh(new THREE.SphereGeometry(r, ...actorQuality().sphere), mat);
  ball.castShadow = true;
  ball.name = 'ball';
  group.add(ball);

  const fuzzMat = createFuzzMaterial();
  const fuzz = new THREE.Mesh(new THREE.IcosahedronGeometry(1.07, 3), fuzzMat);
  fuzz.renderOrder = 2;
  fuzz.name = 'ball-fuzz';
  ball.add(fuzz);
  fuzz.scale.setScalar(r);
  const blurMat = createBlurMaterial();
  const blur = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 12), blurMat);
  blur.frustumCulled = false;
  blur.renderOrder = 2;
  blur.visible = false;
  blur.name = 'ball-blur';
  group.add(blur);

  const blobMat = new THREE.MeshBasicMaterial({ map: blobTexture(), transparent: true, depthWrite: false, color: 0x000000, opacity: 0.6 });
  blobMat.alphaMap = blobTexture();
  blobMat.map = null;
  const floorBlob = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), blobMat);
  floorBlob.rotation.x = -Math.PI / 2;
  floorBlob.renderOrder = 1;
  const wallBlob = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), blobMat.clone());
  wallBlob.renderOrder = 1;
  group.add(floorBlob, wallBlob);

  const haloSprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: haloTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.55,
  }));
  haloSprite.scale.setScalar(0.32);
  haloSprite.visible = halo;
  group.add(haloSprite);

  // Visibility aids (BALL_VISIBILITY): glow, drop-line, reach ring.
  let vis = BALL_VISIBILITY.enhanced;
  let source = null; // { visibility: () => mode, ring: () => reachRing state | null }
  const glowMat = new THREE.SpriteMaterial({
    map: haloTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.38,
  });
  const glow = new THREE.Sprite(glowMat);
  glow.renderOrder = 3;
  group.add(glow);
  const lineMat = new THREE.ShaderMaterial({
    uniforms: { uA: { value: 0.42 }, uColor: { value: new THREE.Color('#f4ff9a') } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: /* glsl */ `
      varying vec2 vUv; uniform float uA; uniform vec3 uColor;
      void main() {
        float edge = 1.0 - abs(vUv.x - 0.5) * 2.0;
        float a = uA * smoothstep(0.0, 0.35, edge) * (0.35 + 0.65 * vUv.y);
        if (a < 0.004) discard;
        gl_FragColor = vec4(uColor, a);
      }`,
    transparent: true,
    depthWrite: false,
  });
  const lineGeo = new THREE.PlaneGeometry(1, 1);
  lineGeo.translate(0, 0.5, 0);
  const dropLine = new THREE.Mesh(lineGeo, lineMat);
  dropLine.renderOrder = 2;
  dropLine.frustumCulled = false;
  group.add(dropLine);
  // Approach circle (round 6): closes on the ball at t* (render/approach.js). Player's view only.
  const ringMat = createApproachMaterial();
  const ring = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), ringMat);
  ring.name = 'approach-circle';
  ring.renderOrder = 7;
  ring.frustumCulled = false;
  ring.visible = false;
  group.add(ring);
  const ringDraw = { k: 1, alpha: 0, green: 0, perfect: false, after: false };
  // Racket ghost at the planned contact (QA r5, game/swingAssist.js contactGhostPose): a faint
  // racket face (rim, light fill, throat and handle) drawn in the racket's own frame (origin at the
  // grip, +Y handle -> tip, +Z face normal), one quad shaded in the fragment shader: one draw call.
  const GH = { cy: RACKET.faceCenterY, sx: RACKET.faceSemiX + RACKET.frameWidth, sy: RACKET.faceSemiY + RACKET.frameWidth };
  const ghostMat = new THREE.ShaderMaterial({
    uniforms: { uA: { value: 0 }, uColor: { value: new THREE.Color('#bff7ff') } },
    vertexShader: 'varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: /* glsl */ `
      varying vec2 vP; uniform float uA; uniform vec3 uColor;
      void main() {
        vec2 q = (vP - vec2(0.0, ${GH.cy.toFixed(4)})) / vec2(${GH.sx.toFixed(4)}, ${GH.sy.toFixed(4)});
        float e = length(q);
        float rim = smoothstep(0.82, 0.93, e) * (1.0 - smoothstep(0.98, 1.06, e));
        float fill = 0.16 * (1.0 - smoothstep(0.9, 0.98, e));
        float hx = abs(vP.x);
        float throat = (1.0 - smoothstep(0.014, 0.02, hx)) * step(-0.06, vP.y) * (1.0 - smoothstep(${(GH.cy - GH.sy * 0.9).toFixed(4)}, ${(GH.cy - GH.sy * 0.8).toFixed(4)}, vP.y));
        float a = uA * max(rim + fill, throat * 0.7);
        if (a < 0.004) discard;
        gl_FragColor = vec4(uColor, a);
      }`,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  const ghostGeo = new THREE.PlaneGeometry(GH.sx * 2.2, GH.cy + GH.sy * 1.1 + 0.07);
  ghostGeo.translate(0, (GH.cy + GH.sy * 1.1 - 0.07) / 2, 0);
  const ghost = new THREE.Mesh(ghostGeo, ghostMat);
  ghost.renderOrder = 6;
  ghost.frustumCulled = false;
  ghost.visible = false;
  group.add(ghost);
  let ghostAlpha = 0;
  const _gx = new THREE.Vector3(), _gy = new THREE.Vector3(), _gz = new THREE.Vector3(), _gm = new THREE.Matrix4();
  ghost.onBeforeRender = (renderer, sc, camera) => {
    const mirror = !!(camera.userData && camera.userData.isMirror);
    ghostMat.uniforms.uA.value = !mirror && camera === mainCamera ? ghostAlpha : 0;
  };
  let displayScale = 1;
  let lineAlpha = 0.42; // the drop-line's opacity for the visibility setting (faded near the eye)
  let ringState = null;
  let ringOpacity = 0;
  let mainCamera = null; // the first camera to draw the ball each frame (the player's view)
  const _camPos = new THREE.Vector3();
  // Drawn size and the camera-facing aids follow the camera that renders this frame. The reach
  // ring belongs to the player's own view only (not the rear-view mirror inset).
  ball.onBeforeRender = (renderer, sc, camera) => {
    // rearView.js tags its camera (userData.isMirror); otherwise the first camera of the frame is
    // the player's view. When the ball is behind the player only the mirror draws it.
    const mirror = !!(camera.userData && camera.userData.isMirror);
    if (!mainCamera && !mirror) mainCamera = camera;
    camera.getWorldPosition(_camPos);
    const d = _camPos.distanceTo(ball.position);
    const k = ballDisplayScale(d, vis.minDeg);
    displayScale = k;
    if (Math.abs(ball.scale.x - k) > 1e-4) {
      ball.scale.setScalar(k);
      ball.updateMatrixWorld();
    }
    const rr = r * k;
    if (glow.visible) {
      // A soft halo 4.2 ball diameters wide, never under glowMinDeg of the view (findable far away).
      const gMin = vis.glowMinDeg > 0 ? 2 * d * Math.tan((vis.glowMinDeg * Math.PI) / 360) : 0;
      glow.scale.setScalar(Math.max(rr * 2 * 4.2, gMin));
      glow.updateMatrixWorld();
    }
    if (dropLine.visible) {
      dropLine.rotation.y = Math.atan2(_camPos.x - dropLine.position.x, _camPos.z - dropLine.position.z);
      dropLine.scale.x = Math.max(0.005, d * 0.0028);
      dropLine.updateMatrixWorld();
      // Merge pass: a ball overhead (lob, bandeja, smash) puts its drop-line right through the eye,
      // where the thin strip filled a third of the picture as a green column. It fades out within
      // 0.8 m (horizontally) of the camera.
      const dh = Math.hypot(_camPos.x - dropLine.position.x, _camPos.z - dropLine.position.z);
      lineMat.uniforms.uA.value = lineAlpha * THREE.MathUtils.smoothstep(dh, 0.35, 0.8);
    }
  };
  // The approach circle is sized for the camera drawing it: radii as fractions of the view height
  // (render/approach.js approachRadius), so it closes at a constant on-screen rate onto the ball.
  ring.onBeforeRender = (renderer, sc, camera) => {
    const mirror = !!(camera.userData && camera.userData.isMirror);
    if (!mainCamera && !mirror) mainCamera = camera;
    const u = ringMat.uniforms;
    if (mirror || camera !== mainCamera || !ringState) {
      u.uA.value = 0;
      return;
    }
    camera.getWorldPosition(_camPos);
    const d = Math.max(0.05, _camPos.distanceTo(ball.position));
    const fov = camera.isPerspectiveCamera ? (camera.fov * Math.PI) / 180 : 1.2;
    const viewH = 2 * d * Math.tan(fov / 2);
    const ballFrac = (r * displayScale) / viewH;
    const ra = approachRadius(ringDraw.k, ballFrac) * viewH;
    const rt = (ballFrac * APPROACH.close + APPROACH.closePad) * viewH;
    const line = APPROACH_LINE * viewH * (ringDraw.perfect ? 1.7 : 1);
    const size = 2 * (ra + line * 4);
    ring.position.copy(ball.position);
    ring.quaternion.copy(camera.quaternion);
    ring.scale.set(size, size, 1);
    ring.updateMatrixWorld();
    u.uRa.value = ra / size;
    u.uRt.value = rt / size;
    u.uW.value = line / size;
    u.uA.value = ringOpacity;
    u.uTA.value = ringDraw.after ? 0 : 0.4;
  };

  // Trail ribbon, rebuilt camera-facing just before it renders.
  const trailPos = new Float32Array(TRAIL_N * 2 * 3);
  const trailCol = new Float32Array(TRAIL_N * 2 * 3);
  const trailIdx = [];
  for (let i = 0; i < TRAIL_N - 1; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    trailIdx.push(a, b, c, b, d, c);
  }
  const trailGeo = new THREE.BufferGeometry();
  trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPos, 3).setUsage(THREE.DynamicDrawUsage));
  trailGeo.setAttribute('color', new THREE.BufferAttribute(trailCol, 3).setUsage(THREE.DynamicDrawUsage));
  trailGeo.setIndex(trailIdx);
  const trailMesh = new THREE.Mesh(trailGeo, new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  }));
  trailMesh.frustumCulled = false;
  trailMesh.visible = trail;
  group.add(trailMesh);

  // Trail history: a fixed pool of points reused in place (no allocation per frame).
  const histPool = Array.from({ length: TRAIL_N + 2 }, () => ({ x: 0, y: 0, z: 0, t: 0 }));
  const hist = []; // views into histPool, oldest first
  let clock = 0;
  let lastId = null;
  let visible = true;
  let flashT = 0, flashAmp = 0;
  const renderPos = new THREE.Vector3();
  const prevRender = new THREE.Vector3();
  const qSpin = new THREE.Quaternion();
  const wAxis = new THREE.Vector3();
  const glass = { pos: new THREE.Vector3(), normal: new THREE.Vector3(), dist: 0 };
  const _side = new THREE.Vector3();
  const _dir = new THREE.Vector3();
  const _cam = new THREE.Vector3();

  trailMesh.onBeforeRender = (renderer, sc, camera) => {
    const n = hist.length;
    if (n < 2) {
      trailGeo.setDrawRange(0, 0);
      return;
    }
    camera.getWorldPosition(_cam);
    const count = Math.min(n, TRAIL_N);
    for (let i = 0; i < count; i++) {
      const h = hist[n - 1 - i];
      const next = hist[Math.max(0, n - 2 - i)];
      const prev = hist[Math.min(n - 1, n - i)];
      _dir.set(prev.x - next.x, prev.y - next.y, prev.z - next.z);
      if (_dir.lengthSq() < 1e-10) _dir.set(0, 1, 0);
      _side.set(h.x - _cam.x, h.y - _cam.y, h.z - _cam.z).cross(_dir).normalize();
      const age = (clock - h.t) / TRAIL_SECONDS;
      const fade = Math.max(0, 1 - age);
      const w = r * 0.7 * fade;
      const o = i * 6;
      trailPos[o] = h.x + _side.x * w; trailPos[o + 1] = h.y + _side.y * w; trailPos[o + 2] = h.z + _side.z * w;
      trailPos[o + 3] = h.x - _side.x * w; trailPos[o + 4] = h.y - _side.y * w; trailPos[o + 5] = h.z - _side.z * w;
      const c = 0.075 * fade * fade * fade;
      trailCol[o] = trailCol[o + 3] = c * 0.95;
      trailCol[o + 1] = trailCol[o + 4] = c;
      trailCol[o + 2] = trailCol[o + 5] = c * 0.55;
    }
    trailGeo.attributes.position.needsUpdate = true;
    trailGeo.attributes.color.needsUpdate = true;
    trailGeo.setDrawRange(0, (count - 1) * 6);
  };

  function update(b, dt = 1 / 60, alpha = 1) {
    clock += dt;
    mainCamera = null;
    if (!b || !visible) {
      group.visible = false;
      while (hist.length) histPool.push(hist.pop());
      return;
    }
    group.visible = true;
    // Render interpolation: back off along velocity by the un-elapsed part of the tick.
    renderPos.set(b.pos.x, b.pos.y, b.pos.z);
    if (!b.atRest && b.vel && alpha < 1) renderPos.addScaledVector(b.vel, -(1 - alpha) / SIM.tickRate);
    const teleport = (b.id !== undefined && b.id !== lastId) || renderPos.distanceToSquared(prevRender) > 4;
    lastId = b.id;
    if (teleport) while (hist.length) histPool.push(hist.pop());
    prevRender.copy(renderPos);
    ball.position.copy(renderPos);

    // Visual spin (rad/s, world axis).
    if (b.spin && !b.atRest) {
      wAxis.set(b.spin.x, b.spin.y, b.spin.z);
      const w = wAxis.length();
      if (w > 1e-4) {
        qSpin.setFromAxisAngle(wAxis.multiplyScalar(1 / w), w * dt);
        ball.quaternion.premultiply(qSpin);
      }
    }

    // Trail history (only while moving fast enough to read as motion).
    const speed = b.vel ? Math.hypot(b.vel.x, b.vel.y, b.vel.z) : 0;
    while (hist.length && (clock - hist[0].t > TRAIL_SECONDS || hist.length >= TRAIL_N)) histPool.push(hist.shift());
    if (!b.atRest && speed > 3) {
      const h = histPool.pop() || { x: 0, y: 0, z: 0, t: 0 };
      h.x = renderPos.x; h.y = renderPos.y; h.z = renderPos.z; h.t = clock;
      hist.push(h);
    }

    // Motion blur streak (speed × shutter behind the ball, drawn radius).
    const blurLen = !b.atRest ? speed * BLUR_SHUTTER_S : 0;
    const rr = r * Math.max(1, displayScale);
    blur.visible = blurLen > rr * 1.5;
    if (blur.visible) {
      const u = blurMat.uniforms;
      u.uCenter.value.copy(ball.position);
      u.uDir.value.set(b.vel.x, b.vel.y, b.vel.z).multiplyScalar(1 / Math.max(speed, 1e-6));
      u.uR.value = rr * 0.98;
      u.uLen.value = blurLen;
      u.uA.value = Math.min(0.5, (0.9 * 2 * rr) / (blurLen + 2 * rr));
    }

    // Visibility aids: the drawn ball never sinks into the floor when it is drawn bigger.
    if (source && source.visibility) {
      const m = source.visibility();
      vis = BALL_VISIBILITY[m] || BALL_VISIBILITY.enhanced;
    }
    if (displayScale > 1 && renderPos.y < r * displayScale) ball.position.y = r * displayScale;
    glow.visible = vis.glow > 0;
    if (glow.visible) {
      glow.position.copy(ball.position);
      glowMat.opacity = vis.glow;
    }
    const airborne = renderPos.y > 0.18 && !b.atRest;
    dropLine.visible = vis.line > 0 && airborne;
    if (dropLine.visible) {
      dropLine.position.set(renderPos.x, 0.005, renderPos.z);
      dropLine.scale.y = Math.max(0.01, renderPos.y - r * displayScale);
      lineAlpha = vis.line;
      lineMat.uniforms.uA.value = vis.line;
    }
    // Presentation aids that run every frame (app/wiring.js: the timing tick before t*).
    if (source && source.frame) source.frame(dt);
    ringState = source && source.ring ? source.ring() : null;
    ring.visible = !!(ringState && vis.minDeg > 0);
    if (ring.visible) {
      const rs = ringState;
      // Round 6 approach state ({ k, alpha, green 0..1, perfect, after }); round-3 reach-ring states
      // ({ progress, fade, green, inWindow }) still draw (closing linearly with progress).
      ringDraw.k = Number.isFinite(rs.k) ? rs.k : 1 - Math.max(0, Math.min(1, rs.progress ?? 1));
      ringDraw.alpha = Number.isFinite(rs.alpha) ? rs.alpha : Math.max(0, Math.min(1, rs.fade ?? 1));
      ringDraw.green = rs.green === true ? 1 : Number(rs.green) || 0;
      ringDraw.perfect = !!rs.perfect;
      ringDraw.after = !!rs.after;
      const c = ringMat.uniforms.uColor.value;
      c.copy(APPROACH_WHITE).lerp(ringDraw.perfect ? APPROACH_PERFECT : APPROACH_GREEN, ringDraw.green);
      ringOpacity = ringDraw.alpha * (0.62 + 0.38 * ringDraw.green);
    } else ringOpacity = 0;
    const gs = source && source.ghost ? source.ghost() : null;
    ghost.visible = !!(gs && gs.alpha > 0.005);
    if (ghost.visible) {
      _gy.set(gs.axis.x, gs.axis.y, gs.axis.z);
      _gz.set(gs.normal.x, gs.normal.y, gs.normal.z);
      _gx.crossVectors(_gy, _gz);
      if (_gx.lengthSq() > 1e-8 && Number.isFinite(gs.grip.x + gs.grip.y + gs.grip.z)) {
        _gx.normalize();
        _gz.crossVectors(_gx, _gy).normalize();
        _gm.makeBasis(_gx, _gy, _gz);
        ghost.quaternion.setFromRotationMatrix(_gm);
        ghost.position.set(gs.grip.x, gs.grip.y, gs.grip.z);
        ghostMat.uniforms.uColor.value.copy(gs.green ? RING_GREEN : GHOST_CYAN);
        ghostAlpha = gs.alpha;
      } else ghost.visible = false;
    }
    if (!ghost.visible) ghostAlpha = 0;

    // Contact shadows.
    if (shadows) {
      const hgt = Math.max(0, renderPos.y - r);
      const s = r * 2.6 * (1 + hgt * (vis.minDeg > 0 ? 0.5 : 0.9)) * Math.min(displayScale, 2.5);
      floorBlob.position.set(renderPos.x, 0.004, renderPos.z);
      floorBlob.scale.set(s, s, 1);
      floorBlob.material.opacity = vis.shadow / (1 + hgt * vis.shadowFall);
      floorBlob.visible = renderPos.y < 6;
      const g = nearestGlass(renderPos, 1.2, glass);
      if (g) {
        wallBlob.visible = true;
        wallBlob.position.copy(g.pos);
        wallBlob.lookAt(_dir.copy(g.pos).add(g.normal));
        const ws = r * 2.4 * (1 + g.dist * 1.2);
        wallBlob.scale.set(ws, ws, 1);
        wallBlob.material.opacity = 0.35 * (1 - g.dist / 1.2) ** 1.5;
      } else wallBlob.visible = false;
    } else {
      floorBlob.visible = wallBlob.visible = false;
    }

    haloSprite.position.copy(renderPos);
    flashT = Math.max(0, flashT - dt);
    const f = flashT > 0 ? flashAmp * (flashT / 0.18) : 0;
    mat.emissiveIntensity = 0.07 + f;
  }

  return {
    object: group,
    mesh: ball,
    update,
    setVisible(v) {
      visible = !!v;
      group.visible = visible;
      if (!visible) while (hist.length) histPool.push(hist.pop());
    },
    setHalo(on) { haloSprite.visible = !!on; },
    setTrail(on) { trailMesh.visible = !!on; },
    /** 'realistic' | 'enhanced' | 'max' (BALL_VISIBILITY). */
    setVisibility(mode) { vis = BALL_VISIBILITY[mode] || BALL_VISIBILITY.enhanced; },
    /**
     * Live sources for the aids (app/wiring.js): { visibility: () => mode, ring: () => approach-circle
     * state (render/approach.js approachCue: { k, alpha, green, perfect, after }) | null, ghost: () =>
     * racket ghost pose | null, frame: (dt) => per-frame presentation hook } — or null to unbind.
     */
    bind(src) { source = src || null; },
    get visibility() { return vis; },
    get ringVisible() { return ring.visible; },
    /** The approach circle as drawn last frame (tests / screenshots). */
    get ringDraw() { return ring.visible ? { ...ringDraw, opacity: ringOpacity } : null; },
    get displayScale() { return displayScale; },
    /** kind: 'hit' | 'bounce' | 'wall' | 'net' */
    flash(kind = 'hit') {
      flashT = 0.18;
      flashAmp = kind === 'hit' ? 0.9 : kind === 'wall' ? 0.35 : 0.25;
    },
    dispose() {
      scene.remove(group);
      ball.geometry.dispose();
      trailGeo.dispose();
      fuzz.geometry.dispose();
      blur.geometry.dispose();
      fuzzMat.dispose();
      blurMat.dispose();
      ghostGeo.dispose();
      ghostMat.dispose();
      ring.geometry.dispose();
      ringMat.dispose();
    },
  };
}
