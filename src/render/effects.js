// Gameplay visual effects (SPEC §6.9): sand puffs, glass shimmer, net shake, racket-hit spark,
// predicted landing ring, drill target zones with labels and the ideal-contact ghost.
// All effects are pooled; nothing allocates per frame after warm-up.
import * as THREE from 'three';
import { labelTexture } from './textures.js';

const ZONE_COLORS = {
  land: new THREE.Color(0.22, 0.84, 1.0),
  'glass-after': new THREE.Color(0.66, 0.52, 1.0),
  exit: new THREE.Color(1.0, 0.56, 0.22),
};
const LABEL_Y = 1.95;
const ZONE_CSS = { land: '#5fd8ff', 'glass-after': '#b39cff', exit: '#ffa45c' };

// ---------------------------------------------------------------------------------------------
// Billboard particle system (instanced quads, velocity-stretched, one draw call per system)

function createParticles(root, { max = 512, additive = false, stretch = 0.0, name }) {
  const base = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = base.index;
  geo.attributes.position = base.attributes.position;
  geo.attributes.uv = base.attributes.uv;
  const iPos = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
  const iVel = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
  const iSize = new THREE.InstancedBufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage);
  const iAlpha = new THREE.InstancedBufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage);
  const iColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('iPos', iPos);
  geo.setAttribute('iVel', iVel);
  geo.setAttribute('iSize', iSize);
  geo.setAttribute('iAlpha', iAlpha);
  geo.setAttribute('iColor', iColor);
  geo.instanceCount = 0;
  const vec3Attrs = [iPos, iVel, iColor];
  const mat = new THREE.ShaderMaterial({
    uniforms: { uStretch: { value: stretch } },
    vertexShader: /* glsl */ `
      attribute vec3 iPos; attribute vec3 iVel; attribute float iSize; attribute float iAlpha; attribute vec3 iColor;
      uniform float uStretch;
      varying vec2 vUv; varying float vAlpha; varying vec3 vColor;
      void main() {
        vUv = uv; vAlpha = iAlpha; vColor = iColor;
        vec4 mv = viewMatrix * vec4(iPos, 1.0);
        vec2 dir = (viewMatrix * vec4(iVel, 0.0)).xy;
        float sp = length(dir);
        vec2 ax = sp > 1e-4 ? dir / sp : vec2(1.0, 0.0);
        vec2 ay = vec2(-ax.y, ax.x);
        float st = 1.0 + sp * uStretch;
        mv.xy += ax * position.x * iSize * st + ay * position.y * iSize;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying vec2 vUv; varying float vAlpha; varying vec3 vColor;
      void main() {
        float d = length(vUv - 0.5) * 2.0;
        float a = 1.0 - smoothstep(0.0, 1.0, d);
        a *= a;
        if (a * vAlpha < 0.002) discard;
        gl_FragColor = vec4(vColor, a * vAlpha);
      }`,
    transparent: true,
    depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 5;
  mesh.name = name;
  root.add(mesh);

  // CPU state (structure of arrays).
  const P = new Float32Array(max * 3), V = new Float32Array(max * 3), C = new Float32Array(max * 3);
  const age = new Float32Array(max), life = new Float32Array(max), s0 = new Float32Array(max), s1 = new Float32Array(max);
  const a0 = new Float32Array(max), drag = new Float32Array(max), grav = new Float32Array(max);
  let count = 0;

  return {
    spawn(px, py, pz, vx, vy, vz, { size = 0.02, sizeEnd = size, alpha = 1, lifetime = 0.6, dragK = 0, gravity = 9.81, r = 1, g = 1, b = 1 }) {
      let i = count;
      if (count < max) count++;
      else {
        // Replace the oldest-looking particle.
        let best = 0;
        for (let k = 1; k < max; k++) if (age[k] / life[k] > age[best] / life[best]) best = k;
        i = best;
      }
      P[i * 3] = px; P[i * 3 + 1] = py; P[i * 3 + 2] = pz;
      V[i * 3] = vx; V[i * 3 + 1] = vy; V[i * 3 + 2] = vz;
      C[i * 3] = r; C[i * 3 + 1] = g; C[i * 3 + 2] = b;
      age[i] = 0; life[i] = lifetime; s0[i] = size; s1[i] = sizeEnd; a0[i] = alpha; drag[i] = dragK; grav[i] = gravity;
    },
    update(dt) {
      let w = 0;
      for (let i = 0; i < count; i++) {
        age[i] += dt;
        if (age[i] >= life[i]) continue;
        const k = Math.exp(-drag[i] * dt);
        V[i * 3] *= k; V[i * 3 + 1] = V[i * 3 + 1] * k - grav[i] * dt; V[i * 3 + 2] *= k;
        P[i * 3] += V[i * 3] * dt; P[i * 3 + 1] += V[i * 3 + 1] * dt; P[i * 3 + 2] += V[i * 3 + 2] * dt;
        if (P[i * 3 + 1] < 0.003 && V[i * 3 + 1] < 0) {
          P[i * 3 + 1] = 0.003;
          V[i * 3 + 1] *= -0.2;
          V[i * 3] *= 0.5; V[i * 3 + 2] *= 0.5;
        }
        // Compact live particles to the front.
        if (w !== i) {
          for (let c = 0; c < 3; c++) {
            P[w * 3 + c] = P[i * 3 + c]; V[w * 3 + c] = V[i * 3 + c]; C[w * 3 + c] = C[i * 3 + c];
          }
          age[w] = age[i]; life[w] = life[i]; s0[w] = s0[i]; s1[w] = s1[i]; a0[w] = a0[i]; drag[w] = drag[i]; grav[w] = grav[i];
        }
        const t = age[w] / life[w];
        for (let c = 0; c < 3; c++) {
          iPos.array[w * 3 + c] = P[w * 3 + c];
          iVel.array[w * 3 + c] = V[w * 3 + c];
          iColor.array[w * 3 + c] = C[w * 3 + c];
        }
        iSize.array[w] = s0[w] + (s1[w] - s0[w]) * Math.sqrt(t);
        iAlpha.array[w] = a0[w] * (1 - t) * (1 - t) * Math.min(1, t * 12 + 0.3);
        w++;
      }
      count = w;
      geo.instanceCount = count;
      if (count) {
        iPos.needsUpdate = iVel.needsUpdate = iColor.needsUpdate = iSize.needsUpdate = iAlpha.needsUpdate = true;
        // Upload only the live range.
        for (let a = 0; a < 3; a++) vec3Attrs[a].clearUpdateRanges(), vec3Attrs[a].addUpdateRange(0, count * 3);
        iSize.clearUpdateRanges(); iSize.addUpdateRange(0, count);
        iAlpha.clearUpdateRanges(); iAlpha.addUpdateRange(0, count);
      }
      mesh.visible = count > 0;
    },
    get count() {
      return count;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Glass ripple (expanding shimmer ring on the panel plane)

function createRipples(root, n = 6) {
  const geo = new THREE.PlaneGeometry(1, 1);
  const pool = [];
  for (let i = 0; i < n; i++) {
    const mat = new THREE.ShaderMaterial({
      uniforms: { uT: { value: 99 }, uAmp: { value: 0 }, uSize: { value: 1.6 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: /* glsl */ `
        varying vec2 vUv; uniform float uT, uAmp, uSize;
        void main() {
          vec2 p = (vUv - 0.5) * uSize;                    // metres from impact on the panel
          float r = length(p);
          float R = 0.04 + uT * 1.9;                        // expanding wavefront
          float w = 0.05 + uT * 0.16;
          float ang = atan(p.y, p.x);
          float wob = 0.75 + 0.25 * sin(ang * 5.0 + uT * 9.0) * sin(ang * 3.0 - 1.3);
          float front = exp(-pow((r - R) / w, 2.0)) * wob;
          // Trailing interference bands behind the front read as a shimmer, not a target.
          float bands = 0.5 + 0.5 * sin((r - R) * 70.0);
          float trail = smoothstep(R, R - 0.35, r) * smoothstep(0.0, R * 0.6, r) * bands * 0.35;
          float fade = exp(-uT * 6.0) * smoothstep(uSize * 0.5, uSize * 0.28, r);
          float flash = exp(-r * r / 0.004) * exp(-uT * 30.0) * 0.6;
          float a = ((front + trail) * fade + flash) * uAmp;
          if (a < 0.003) discard;
          gl_FragColor = vec4(vec3(0.78, 0.93, 1.0) * a, a);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const m = new THREE.Mesh(geo, mat);
    m.visible = false;
    m.renderOrder = 6;
    m.scale.setScalar(1.6);
    root.add(m);
    pool.push(m);
  }
  let next = 0;
  return {
    spawn(pos, normal, speed) {
      const m = pool[next];
      next = (next + 1) % n;
      m.position.set(pos.x + normal.x * 0.012, pos.y + normal.y * 0.012, pos.z + normal.z * 0.012);
      m.lookAt(m.position.x + normal.x, m.position.y + normal.y, m.position.z + normal.z);
      m.material.uniforms.uT.value = 0;
      m.material.uniforms.uAmp.value = Math.min(0.45, 0.08 + speed * 0.016);
      m.visible = true;
    },
    update(dt) {
      for (const m of pool) {
        if (!m.visible) continue;
        const u = m.material.uniforms.uT;
        u.value += dt;
        if (u.value > 0.7) m.visible = false;
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Racket flash (billboard, additive)

function createFlashes(root, n = 4) {
  const geo = new THREE.PlaneGeometry(1, 1);
  const pool = [];
  for (let i = 0; i < n; i++) {
    const mat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color() }, uA: { value: 0 } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          float s = length(modelMatrix[0].xyz);
          mv.xy += position.xy * s;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        varying vec2 vUv; uniform vec3 uColor; uniform float uA;
        void main() {
          vec2 p = vUv - 0.5;
          float r = length(p) * 2.0;
          float core = exp(-r * r * 18.0);
          float glow = exp(-r * r * 4.0) * 0.35;
          float star = exp(-abs(p.x) * 60.0) * exp(-abs(p.y) * 5.0) + exp(-abs(p.y) * 60.0) * exp(-abs(p.x) * 5.0);
          float a = (core + glow + star * 0.25) * uA;
          if (a < 0.003) discard;
          gl_FragColor = vec4(uColor * a, a);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const m = new THREE.Mesh(geo, mat);
    m.visible = false;
    m.renderOrder = 7;
    m.frustumCulled = false;
    m.userData.t = 99;
    root.add(m);
    pool.push(m);
  }
  let next = 0;
  return {
    spawn(pos, color, size) {
      const m = pool[next];
      next = (next + 1) % n;
      m.position.copy(pos);
      m.material.uniforms.uColor.value.copy(color);
      m.userData.t = 0;
      m.userData.size = size;
      m.visible = true;
    },
    update(dt) {
      for (const m of pool) {
        if (!m.visible) continue;
        m.userData.t += dt;
        const t = m.userData.t;
        if (t > 0.16) {
          m.visible = false;
          continue;
        }
        m.scale.setScalar(m.userData.size * (0.6 + t * 5));
        m.material.uniforms.uA.value = Math.exp(-t * 22);
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Landing marker: predicted first-bounce ring on the floor

function createLandingMarker(root) {
  const size = 0.9;
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uA: { value: 0 }, uSize: { value: size } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: /* glsl */ `
      varying vec2 vUv; uniform float uTime, uA, uSize;
      float band(float r, float c, float w) {
        float f = fwidth(r);
        return smoothstep(c - w - f, c - w + f, r) * (1.0 - smoothstep(c + w - f, c + w + f, r));
      }
      void main() {
        vec2 p = (vUv - 0.5) * uSize;
        float r = length(p);
        float ang = atan(p.y, p.x);
        float pulse = 0.5 + 0.5 * sin(uTime * 6.0);
        float ring = band(r, 0.2, 0.012);
        float dash = step(0.5, fract(ang / 6.2831853 * 16.0 + uTime * 0.35));
        float outer = band(r, 0.29 + pulse * 0.015, 0.006) * dash * 0.8;
        float dot = 1.0 - smoothstep(0.018, 0.026, r);
        float fill = (1.0 - smoothstep(0.0, 0.2, r)) * 0.16;
        float shrink = band(r, mix(0.42, 0.21, fract(uTime * 0.9)), 0.004) * (1.0 - fract(uTime * 0.9)) * 0.7;
        float a = (ring + outer + dot + fill + shrink) * uA;
        if (a < 0.003) discard;
        vec3 col = vec3(0.8, 0.96, 1.0) * 1.6;
        gl_FragColor = vec4(col * a, a);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });
  const g = new THREE.PlaneGeometry(size, size);
  g.rotateX(-Math.PI / 2);
  const m = new THREE.Mesh(g, mat);
  m.position.y = 0.006;
  m.renderOrder = 4;
  m.visible = false;
  m.name = 'landing-marker';
  root.add(m);
  const state = { target: null, alpha: 0, has: false };
  return {
    set(pos) {
      if (!pos) {
        state.target = null;
        return;
      }
      const jump = !state.has || Math.hypot(pos.x - m.position.x, pos.z - m.position.z) > 1.2 || state.alpha < 0.02;
      state.target = { x: pos.x, z: pos.z };
      if (jump) m.position.set(pos.x, 0.006, pos.z);
      state.has = true;
    },
    update(dt, time) {
      const want = state.target ? 1 : 0;
      state.alpha += (want - state.alpha) * (1 - Math.exp(-dt * 10));
      if (state.target) {
        const k = 1 - Math.exp(-dt * 18);
        m.position.x += (state.target.x - m.position.x) * k;
        m.position.z += (state.target.z - m.position.z) * k;
      }
      mat.uniforms.uA.value = state.alpha;
      mat.uniforms.uTime.value = time;
      m.visible = state.alpha > 0.01;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Target zones

const zoneVertex = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';

function makeZone(zone) {
  const group = new THREE.Group();
  group.name = `zone-${zone.id}`;
  const w = Math.abs(zone.x1 - zone.x0), d = Math.abs(zone.z1 - zone.z0);
  const cx = (zone.x0 + zone.x1) / 2, cz = (zone.z0 + zone.z1) / 2;
  const color = (ZONE_COLORS[zone.kind] || ZONE_COLORS.land).clone();
  const uniforms = {
    uColor: { value: color }, uSize: { value: new THREE.Vector2(w, d) }, uHi: { value: 0 }, uTime: { value: 0 }, uA: { value: 0 },
  };
  const floorMat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: zoneVertex,
    fragmentShader: /* glsl */ `
      varying vec2 vUv; uniform vec3 uColor; uniform vec2 uSize; uniform float uHi, uTime, uA;
      void main() {
        vec2 p = (vUv - 0.5) * uSize;
        vec2 e2 = uSize * 0.5 - abs(p);
        float e = min(e2.x, e2.y);                       // distance to the nearest edge (m)
        float fw = fwidth(e) * 1.2;
        float lw = 0.045;
        float border = 1.0 - smoothstep(lw - fw, lw + fw, e);
        float corner = step(uSize.x * 0.5 - 0.55, abs(p.x)) * step(uSize.y * 0.5 - 0.55, abs(p.y));
        float glow = exp(-e / 0.35) * 0.35;
        float fill = 0.07 + 0.05 * uHi;
        float scan = uHi * exp(-pow((fract(uTime * 0.45) * (uSize.y + 1.0) - 0.5 - (p.y + uSize.y * 0.5)) / 0.25, 2.0)) * 0.35;
        float pulse = 1.0 + uHi * 0.25 * sin(uTime * 5.0);
        float a = (border * (0.85 + corner * 0.6) + glow + fill + scan) * pulse * uA * (0.85 + 0.6 * uHi);
        if (a < 0.002) discard;
        gl_FragColor = vec4(uColor * a, a);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3,
  });
  const floorGeo = new THREE.PlaneGeometry(w, d);
  floorGeo.rotateX(-Math.PI / 2);
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.position.set(cx, 0.005, cz);
  floor.renderOrder = 4;
  group.add(floor);

  // Low light curtain around the perimeter keeps the zone readable at grazing angles.
  const H = 0.34;
  const sides = [];
  const mk = (len, x, z, rotY) => {
    const g = new THREE.PlaneGeometry(len, H);
    g.rotateY(rotY);
    g.translate(x, H / 2, z);
    sides.push(g);
  };
  mk(w, cx, zone.z0, 0);
  mk(w, cx, zone.z1, 0);
  mk(d, zone.x0, cz, Math.PI / 2);
  mk(d, zone.x1, cz, Math.PI / 2);
  const merged = new THREE.BufferGeometry();
  {
    const pos = [], uv = [], idx = [];
    let off = 0;
    for (const g of sides) {
      const p = g.attributes.position, u = g.attributes.uv;
      for (let i = 0; i < p.count; i++) {
        pos.push(p.getX(i), p.getY(i), p.getZ(i));
        uv.push(u.getX(i), u.getY(i));
      }
      for (let i = 0; i < g.index.count; i++) idx.push(g.index.getX(i) + off);
      off += p.count;
      g.dispose();
    }
    merged.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    merged.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    merged.setIndex(idx);
  }
  const curtainMat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: zoneVertex,
    fragmentShader: /* glsl */ `
      varying vec2 vUv; uniform vec3 uColor; uniform float uHi, uA, uTime;
      void main() {
        float h = vUv.y;
        float a = pow(1.0 - h, 1.8) * (0.45 + 0.45 * uHi) * uA * (1.0 + uHi * 0.2 * sin(uTime * 5.0));
        if (a < 0.002) discard;
        gl_FragColor = vec4(uColor * a, a);
      }`,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  const curtain = new THREE.Mesh(merged, curtainMat);
  curtain.renderOrder = 4;
  group.add(curtain);

  // Label: billboard sprite that keeps a minimum on-screen size for TV legibility.
  const pts = zone.points != null ? `${zone.points} PTS` : '';
  const tex = labelTexture(
    [
      { text: String(zone.label || zone.id).toUpperCase(), size: 0.5, weight: 900, font: 'display', color: '#ffffff' },
      ...(pts ? [{ text: pts, size: 0.3, weight: 700, font: 'ui', color: ZONE_CSS[zone.kind] || ZONE_CSS.land }] : []),
    ],
    { width: 1024, height: 288, background: 'rgba(6,12,20,0.55)' },
  );
  // Colour > 1 so white text survives ACES in the OutputPass (stays below the bloom threshold).
  const spriteMat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0, color: new THREE.Color(1.6, 1.6, 1.6) });
  const sprite = new THREE.Sprite(spriteMat);
  sprite.renderOrder = 8;
  const aspect = 1024 / 288;
  const baseH = 0.5;
  sprite.position.set(cx, LABEL_Y + baseH * 0.5, cz);
  sprite.scale.set(baseH * aspect, baseH, 1);
  // Size, stacking and HUD avoidance are laid out for all labels at once (createTargets.layout).
  group.add(sprite);

  return {
    group,
    uniforms,
    sprite,
    cx,
    // Labels of zones beyond the walls (exit zones) float just inside the glass, not behind it.
    cz: Math.max(-9.8, Math.min(9.8, cz)),
    baseH,
    aspect,
    hudFade: 1,
    fade: 1,
    dispose() {
      floorGeo.dispose();
      merged.dispose();
      floorMat.dispose();
      curtainMat.dispose();
      tex.dispose();
      spriteMat.dispose();
    },
  };
}

function createTargets(root) {
  const group = new THREE.Group();
  group.name = 'target-zones';
  root.add(group);
  let key = '';
  let zones = [];
  let highlight = null;
  let visibleTarget = 0;
  let alpha = 0;
  let occluders = []; // HUD blocks in normalized screen coords [x0, y0, x1, y1] (y down)
  let laidFrame = -1;
  const camPos = new THREE.Vector3();
  const v = new THREE.Vector3();

  /**
   * Once per rendered frame, for every label: keep >= 5.2% of the view height (TV legibility),
   * stack labels that would overlap on screen (the lower one keeps its place) and fade a label
   * that falls under a HUD block.
   */
  function layout(renderer, camera) {
    const frame = renderer.info.render.frame;
    if (frame === laidFrame) return;
    laidFrame = frame;
    camPos.setFromMatrixPosition(camera.matrixWorld);
    const fov = camera.isPerspectiveCamera ? THREE.MathUtils.degToRad(camera.fov) : 1.2;
    const tanH = Math.tan(fov / 2);
    const asp = camera.aspect || 16 / 9;
    const items = [];
    for (const z of zones) {
      const dist = Math.max(0.5, camPos.distanceTo(v.set(z.cx, LABEL_Y, z.cz)));
      const h = Math.max(z.baseH, 2 * dist * tanH * 0.052) * (1 + 0.08 * z.uniforms.uHi.value);
      // On-screen size follows the view-space depth (not the distance) for off-axis labels.
      v.set(z.cx, LABEL_Y + h * 0.5, z.cz).applyMatrix4(camera.matrixWorldInverse);
      const front = -v.z > 0.3;
      const depth = Math.max(0.3, -v.z);
      v.applyMatrix4(camera.projectionMatrix);
      const hN = h / (depth * tanH);
      items.push({ z, h, dist: depth, x: v.x, y: v.y, hN, wN: (hN * z.aspect) / asp, lift: 0, front });
    }
    items.sort((a, b) => a.y - b.y);
    for (let i = 1; i < items.length; i++) {
      const b = items[i];
      for (let j = 0; j < i; j++) {
        const a = items[j];
        if (!a.front || !b.front || Math.abs(a.x - b.x) > (a.wN + b.wN) / 2) continue;
        const need = ((a.hN + b.hN) / 2) * 1.08 - (b.y + b.lift - (a.y + a.lift));
        if (need > 0) b.lift += need;
      }
    }
    for (const it of items) {
      const sp = it.z.sprite;
      sp.scale.set(it.h * it.z.aspect, it.h, 1);
      sp.position.set(it.z.cx, LABEL_Y + it.h * 0.5 + it.lift * it.dist * tanH, it.z.cz);
      sp.updateMatrixWorld();
      const yc = it.y + it.lift;
      const sx0 = (it.x - it.wN / 2 + 1) / 2, sx1 = (it.x + it.wN / 2 + 1) / 2;
      const sy0 = (1 - (yc + it.hN / 2)) / 2, sy1 = (1 - (yc - it.hN / 2)) / 2;
      let under = false;
      for (const r of occluders) if (sx1 > r[0] && sx0 < r[2] && sy1 > r[1] && sy0 < r[3]) under = true;
      it.z.rect = [sx0, sy0, sx1, sy1];
      it.z.hudFade = under ? 0.1 : 1;
    }
  }

  return {
    set(list, highlightId) {
      highlight = highlightId ?? null;
      if (!list || !list.length) {
        visibleTarget = 0;
        return;
      }
      visibleTarget = 1;
      const k = JSON.stringify(list.map((z) => [z.id, z.label, z.x0, z.x1, z.z0, z.z1, z.points, z.kind]));
      if (k === key) return;
      key = k;
      for (const z of zones) {
        group.remove(z.group);
        z.dispose();
      }
      zones = list.map((z) => {
        const vz = makeZone(z);
        vz.id = z.id;
        vz.sprite.onBeforeRender = (renderer, _s, camera) => layout(renderer, camera);
        group.add(vz.group);
        return vz;
      });
    },
    /** Debug / tests: label layout state. */
    get debug() { return { occluders, labels: zones.map((z) => ({ id: z.id, fade: z.fade, hudFade: z.hudFade, rect: z.rect || null })) }; },
    /** HUD blocks to keep labels out of: [[x0, y0, x1, y1], ...] in 0..1 screen coords, y down. */
    setOccluders(rects) {
      occluders = Array.isArray(rects) ? rects : [];
    },
    update(dt, time) {
      alpha += (visibleTarget - alpha) * (1 - Math.exp(-dt * 6));
      group.visible = alpha > 0.01 && zones.length > 0;
      for (const z of zones) {
        const u = z.uniforms;
        const want = highlight != null && z.id === highlight ? 1 : 0;
        u.uHi.value += (want - u.uHi.value) * (1 - Math.exp(-dt * 8));
        u.uTime.value = time;
        u.uA.value = alpha;
        z.fade += (z.hudFade - z.fade) * (1 - Math.exp(-dt * 10));
        z.sprite.material.opacity = alpha * z.fade;
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Ideal-contact ghost

function createGhost(root) {
  const group = new THREE.Group();
  group.name = 'contact-ghost';
  const uniforms = { uA: { value: 0 }, uTime: { value: 0 }, uColor: { value: new THREE.Color(0.62, 1.0, 0.9) } };
  const sphereMat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vV;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vN; varying vec3 vV; uniform float uA, uTime; uniform vec3 uColor;
      void main() {
        float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
        float rim = pow(f, 2.2);
        float a = (rim * 1.1 + 0.07) * uA * (0.85 + 0.15 * sin(uTime * 7.0));
        gl_FragColor = vec4(uColor * a * 1.4, a);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const sphere = new THREE.Mesh(new THREE.IcosahedronGeometry(0.07, 4), sphereMat);
  sphere.renderOrder = 6;
  group.add(sphere);
  // Floor marker + plumb line give a depth cue for where to be.
  const lineMat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: 'varying float vY; void main(){ vY = position.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: /* glsl */ `
      varying float vY; uniform float uA; uniform vec3 uColor;
      void main() {
        float dash = step(0.5, fract(vY * 12.0));
        float a = dash * 0.35 * uA;
        if (a < 0.003) discard;
        gl_FragColor = vec4(uColor * a, a);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const lineGeo = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 1, 0], 3));
  const line = new THREE.LineSegments(lineGeo, lineMat);
  line.frustumCulled = false;
  root.add(line);
  const footMat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: /* glsl */ `
      varying vec2 vUv; uniform float uA; uniform vec3 uColor;
      void main() {
        float r = length(vUv - 0.5) * 2.0;
        float f = fwidth(r);
        float ring = smoothstep(0.78 - f, 0.78 + f, r) * (1.0 - smoothstep(0.92 - f, 0.92 + f, r));
        float a = (ring * 0.7 + (1.0 - smoothstep(0.0, 0.9, r)) * 0.12) * uA;
        if (a < 0.003) discard;
        gl_FragColor = vec4(uColor * a, a);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3,
  });
  const footGeo = new THREE.PlaneGeometry(0.3, 0.3);
  footGeo.rotateX(-Math.PI / 2);
  const foot = new THREE.Mesh(footGeo, footMat);
  foot.renderOrder = 4;
  root.add(foot);
  root.add(group);

  const state = { target: null, alpha: 0, has: false };
  const pos = new THREE.Vector3();
  return {
    set(p) {
      if (!p) {
        state.target = null;
        return;
      }
      if (!state.has || state.alpha < 0.02) pos.set(p.x, p.y, p.z);
      state.target = { x: p.x, y: p.y, z: p.z };
      state.has = true;
    },
    update(dt, time) {
      const want = state.target ? 1 : 0;
      state.alpha += (want - state.alpha) * (1 - Math.exp(-dt * 8));
      if (state.target) {
        const k = 1 - Math.exp(-dt * 14);
        pos.x += (state.target.x - pos.x) * k;
        pos.y += (state.target.y - pos.y) * k;
        pos.z += (state.target.z - pos.z) * k;
      }
      uniforms.uA.value = state.alpha;
      uniforms.uTime.value = time;
      const vis = state.alpha > 0.01;
      group.visible = line.visible = foot.visible = vis;
      if (!vis) return;
      group.position.copy(pos);
      group.scale.setScalar(1 + 0.05 * Math.sin(time * 7));
      const arr = lineGeo.attributes.position.array;
      arr[0] = pos.x; arr[1] = 0.01; arr[2] = pos.z;
      arr[3] = pos.x; arr[4] = Math.max(0.02, pos.y - 0.075); arr[5] = pos.z;
      lineGeo.attributes.position.needsUpdate = true;
      foot.position.set(pos.x, 0.006, pos.z);
    },
  };
}

// ---------------------------------------------------------------------------------------------

/**
 * @param {THREE.Scene} scene
 * @param {{net?: {shake(x:number, speed:number):void}}} [opts] net from buildEnvironment(); if omitted,
 *   it is looked up in the scene by name ('vibora-net').
 */
export function createEffects(scene, opts = {}) {
  const root = new THREE.Group();
  root.name = 'vibora-effects';
  scene.add(root);

  const dust = createParticles(root, { max: 600, additive: false, stretch: 0.0, name: 'fx-dust' });
  const sparks = createParticles(root, { max: 300, additive: true, stretch: 0.06, name: 'fx-sparks' });
  const ripples = createRipples(root);
  const flashes = createFlashes(root);
  const landing = createLandingMarker(root);
  const targets = createTargets(root);
  const ghost = createGhost(root);
  let net = opts.net || null;
  let time = 0;

  const rnd = Math.random;
  const tmpColor = new THREE.Color();

  function sandPuff(pos, speed, outside) {
    const k = Math.min(1.4, Math.max(0.3, speed / 14));
    const nDust = Math.round(5 + 10 * k);
    for (let i = 0; i < nDust; i++) {
      const a = rnd() * Math.PI * 2, h = (0.15 + rnd() * 0.55) * k;
      const tone = 0.8 + rnd() * 0.3;
      const [r, g, b] = outside ? [0.14, 0.14, 0.15] : [0.42 * tone, 0.39 * tone, 0.33 * tone];
      dust.spawn(pos.x + (rnd() - 0.5) * 0.04, 0.01, pos.z + (rnd() - 0.5) * 0.04,
        Math.cos(a) * h, (0.25 + rnd() * 0.5) * k, Math.sin(a) * h,
        { size: 0.04, sizeEnd: 0.14 + 0.12 * k, alpha: outside ? 0.25 : 0.38, lifetime: 0.7 + rnd() * 0.7, dragK: 4.0, gravity: 0.2, r, g, b });
    }
    if (outside) return;
    const nGrain = Math.round(6 + 16 * k);
    for (let i = 0; i < nGrain; i++) {
      const a = rnd() * Math.PI * 2, h = (0.4 + rnd() * 1.1) * k;
      dust.spawn(pos.x, 0.012, pos.z, Math.cos(a) * h, (0.6 + rnd() * 1.3) * k, Math.sin(a) * h,
        { size: 0.008, sizeEnd: 0.007, alpha: 0.95, lifetime: 0.35 + rnd() * 0.3, dragK: 1.2, gravity: 9.81, r: 0.5, g: 0.46, b: 0.38 });
    }
  }

  return {
    root,
    /** Floor bounce: sand puff on turf, faint dust elsewhere. */
    bounce(pos, surface = 'turf', speed = 8) {
      if (surface === 'turf' || surface === 'outsideFloor' || surface == null) sandPuff(pos, speed, surface === 'outsideFloor');
    },
    /** Glass impact: shimmer ripple on the panel plane + fine dust and a couple of glints. */
    glassHit(pos, normal, speed = 8) {
      const n = normal || { x: 0, y: 0, z: 1 };
      ripples.spawn(pos, n, speed);
      const k = Math.min(1.3, speed / 15);
      for (let i = 0; i < Math.round(4 + 8 * k); i++) {
        const sx = (rnd() - 0.5) * 0.6, sy = (rnd() - 0.5) * 0.6, sz = (rnd() - 0.5) * 0.6;
        dust.spawn(pos.x + n.x * 0.03, pos.y + n.y * 0.03, pos.z + n.z * 0.03,
          n.x * (0.3 + rnd() * 0.5) + sx, n.y * 0.3 + sy - 0.1, n.z * (0.3 + rnd() * 0.5) + sz,
          { size: 0.02, sizeEnd: 0.07, alpha: 0.22, lifetime: 0.5 + rnd() * 0.4, dragK: 5, gravity: 0.4, r: 0.36, g: 0.36, b: 0.32 });
      }
    },
    /** Net impact: forwarded to the environment's net shader wobble. */
    netShake(x, speed = 5) {
      if (!net) net = scene.getObjectByName('vibora-net')?.userData?.netApi || null;
      net?.shake(x, speed);
    },
    /** Racket contact flash; quality 0..1 tints it (gold = sweet spot, orange = frame). */
    racketHit(pos, quality = 0.8) {
      const q = Math.max(0, Math.min(1, quality));
      if (q >= 0.75) tmpColor.setRGB(2.3, 2.0, 1.35);
      else if (q >= 0.4) tmpColor.setRGB(1.9, 1.9, 1.9);
      else tmpColor.setRGB(1.8, 0.85, 0.4);
      flashes.spawn(pos, tmpColor, 0.16 + q * 0.12);
      const n = Math.round(6 + q * 10);
      for (let i = 0; i < n; i++) {
        const u = rnd() * 2 - 1, a = rnd() * Math.PI * 2, s = Math.sqrt(1 - u * u);
        const sp = 2.5 + rnd() * 3.5;
        sparks.spawn(pos.x, pos.y, pos.z, s * Math.cos(a) * sp, u * sp, s * Math.sin(a) * sp,
          { size: 0.007, sizeEnd: 0.004, alpha: 0.9, lifetime: 0.12 + rnd() * 0.16, dragK: 6, gravity: 2, r: tmpColor.r, g: tmpColor.g, b: tmpColor.b });
      }
      // Felt fuzz knocked off the ball.
      for (let i = 0; i < 5; i++) {
        dust.spawn(pos.x, pos.y, pos.z, (rnd() - 0.5) * 0.8, (rnd() - 0.3) * 0.6, (rnd() - 0.5) * 0.8,
          { size: 0.008, sizeEnd: 0.02, alpha: 0.5, lifetime: 0.5 + rnd() * 0.4, dragK: 6, gravity: 0.3, r: 0.55, g: 0.6, b: 0.18 });
      }
    },
    landingMarker(pos) {
      landing.set(pos);
    },
    targets(zones, highlightId = null) {
      targets.set(zones, highlightId);
    },
    /** Screen rects (0..1, y down) of HUD blocks that zone labels must not sit under. */
    setLabelOccluders(rects) {
      targets.setOccluders(rects);
    },
    get labelDebug() {
      return targets.debug;
    },
    contactGhost(pos) {
      ghost.set(pos);
    },
    setNet(n) {
      net = n;
    },
    update(dt) {
      time += dt;
      dust.update(dt);
      sparks.update(dt);
      ripples.update(dt);
      flashes.update(dt);
      landing.update(dt, time);
      targets.update(dt, time);
      ghost.update(dt, time);
    },
  };
}
