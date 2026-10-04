// Padel ball renderer: felt + seam texture, visual spin, render interpolation, soft contact
// shadows (floor and nearby glass), a faint additive motion trail, optional halo and flashes,
// and the round-3 visibility aids (minimum on-screen size, glow, drop-line, reach ring).
import * as THREE from 'three';
import { BALL, COURT, SIM } from '../config.js';
import { cached, hash2, tileNoise, heightToNormalCanvas, actorQuality } from './actorKit.js';

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

/** Ring texture (white, tinted by the sprite material) for the reach ring. */
function ringTexture() {
  return cached('ballRing', () => {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d');
    ctx.strokeStyle = 'rgba(255,255,255,1)';
    ctx.lineWidth = 9;
    ctx.beginPath();
    ctx.arc(64, 64, 52, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 18;
    ctx.beginPath();
    ctx.arc(64, 64, 52, 0, Math.PI * 2);
    ctx.stroke();
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  });
}

/**
 * Ball visibility (round 3, "like trying to hit a fruit fly" from 2-3 m on a TV): 'realistic' is the
 * true ball; 'enhanced' (default) keeps it at least minDeg of the view (drawn bigger with distance),
 * adds a soft glow, a stronger contact shadow and a thin drop-line to the floor; 'max' more so.
 */
export const BALL_VISIBILITY = Object.freeze({
  realistic: Object.freeze({ minDeg: 0, glow: 0, line: 0, shadow: 0.62, shadowFall: 2.2 }),
  enhanced: Object.freeze({ minDeg: 0.45, glow: 0.38, line: 0.42, shadow: 0.85, shadowFall: 0.9 }),
  max: Object.freeze({ minDeg: 0.8, glow: 0.6, line: 0.62, shadow: 0.95, shadowFall: 0.5 }),
});

/** Drawn-size factor that keeps a ball of radius r at distance d at least minDeg wide (>= 1). */
export function ballDisplayScale(d, minDeg, r = BALL.radius) {
  if (!(minDeg > 0) || !(d > 0)) return 1;
  const want = 2 * d * Math.tan((minDeg * Math.PI) / 360);
  return Math.max(1, want / (2 * r));
}

const RING_YELLOW = new THREE.Color('#ffd84a');
const RING_GREEN = new THREE.Color('#3dff7a');

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
  const ringMat = new THREE.SpriteMaterial({ map: ringTexture(), transparent: true, depthWrite: false, depthTest: false, color: RING_YELLOW, opacity: 0 });
  const ring = new THREE.Sprite(ringMat);
  ring.renderOrder = 7;
  ring.visible = false;
  group.add(ring);
  let displayScale = 1;
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
    ringMat.opacity = !mirror && camera === mainCamera ? ringOpacity : 0;
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
      glow.scale.setScalar(rr * 2 * 4.2);
      glow.updateMatrixWorld();
    }
    if (dropLine.visible) {
      dropLine.rotation.y = Math.atan2(_camPos.x - dropLine.position.x, _camPos.z - dropLine.position.z);
      dropLine.scale.x = Math.max(0.005, d * 0.0028);
      dropLine.updateMatrixWorld();
    }
    if (ring.visible && ringState) {
      const p = ringState.progress;
      const size = rr * 2 * (1.9 + 3.2 * (1 - p) * (1 - p)) * (ringState.green ? 1.15 : 1);
      ring.scale.setScalar(Math.max(size, d * 0.012));
      ring.updateMatrixWorld();
    }
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

  const hist = []; // {x,y,z,t}
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
      hist.length = 0;
      return;
    }
    group.visible = true;
    // Render interpolation: back off along velocity by the un-elapsed part of the tick.
    renderPos.set(b.pos.x, b.pos.y, b.pos.z);
    if (!b.atRest && b.vel && alpha < 1) renderPos.addScaledVector(b.vel, -(1 - alpha) / SIM.tickRate);
    const teleport = (b.id !== undefined && b.id !== lastId) || renderPos.distanceToSquared(prevRender) > 4;
    lastId = b.id;
    if (teleport) hist.length = 0;
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
    if (!b.atRest && speed > 3) hist.push({ x: renderPos.x, y: renderPos.y, z: renderPos.z, t: clock });
    while (hist.length && (clock - hist[0].t > TRAIL_SECONDS || hist.length > TRAIL_N)) hist.shift();

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
      lineMat.uniforms.uA.value = vis.line;
    }
    ringState = source && source.ring ? source.ring() : null;
    ring.visible = !!(ringState && vis.minDeg > 0);
    if (ring.visible) {
      ring.position.copy(ball.position);
      ringMat.color.copy(ringState.green ? RING_GREEN : RING_YELLOW);
      ringOpacity = Math.max(0, Math.min(1, ringState.fade)) * (ringState.green ? 1 : ringState.inWindow ? 0.85 : 0.5);
    } else ringOpacity = 0;
    ringMat.opacity = ringOpacity;

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
      if (!visible) hist.length = 0;
    },
    setHalo(on) { haloSprite.visible = !!on; },
    setTrail(on) { trailMesh.visible = !!on; },
    /** 'realistic' | 'enhanced' | 'max' (BALL_VISIBILITY). */
    setVisibility(mode) { vis = BALL_VISIBILITY[mode] || BALL_VISIBILITY.enhanced; },
    /**
     * Live sources for the aids (app/wiring.js): { visibility: () => mode, ring: () => reach-ring
     * state ({ progress 0..1, green, inWindow, fade }) | null } — or null to unbind.
     */
    bind(src) { source = src || null; },
    get visibility() { return vis; },
    get ringVisible() { return ring.visible; },
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
    },
  };
}
