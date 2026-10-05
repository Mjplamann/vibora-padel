// Motion-blur ribbon behind the first-person racket head (round 4, smooth swings): a thin sheet
// from the throat to the tip over the last ~0.1 s of the drawn racket's path, fading with age and
// scaled by the head's speed, so a fast swing reads as a sweep instead of a racket jumping between
// frames. Positions are kept relative to the player's court position (a glide does not smear it).
// One draw call while visible, none at rest; no per-frame allocation.
import * as THREE from 'three';
import { TRAIL, trailStrength, TRAIL_POWER, trailPowerOf, trailPower as power, setTrailPower } from './racketTrailMath.js';

// Round 6: a player stroke's power (setTrailPower, pure module) scales the ribbon for a moment.
export { TRAIL, trailStrength, TRAIL_POWER, trailPowerOf, setTrailPower };

/**
 * @param {object} o { color } ribbon tint
 * @returns { mesh, update(dt, grip, axis, bodyPos, { eye, fade }), clear(), stats }
 */
export function createRacketTrail({ color = '#f4efe4' } = {}) {
  const N = TRAIL.samples;
  const pos = new Float32Array(N * 2 * 3);
  const col = new Float32Array(N * 2 * 4);
  const idx = [];
  for (let i = 0; i < N - 1; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    idx.push(a, b, c, b, d, c);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage));
  geo.setIndex(idx);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
  const mat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(color), vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending, toneMapped: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'racket-trail';
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.visible = false;

  // Ring of samples: relative inner / outer points, age, strength.
  const ring = Array.from({ length: N }, () => ({ ix: 0, iy: 0, iz: 0, ox: 0, oy: 0, oz: 0, age: Infinity, k: 0, len: 1 }));
  let head = 0;
  let count = 0;
  let prevMid = null;
  const mid = { x: 0, y: 0, z: 0 };
  let speed = 0;
  const stats = { shownFrames: 0, maxStrength: 0 };

  /**
   * One display frame of the drawn racket (court frame): grip, unit axis; bodyPos = player's court
   * position {x, z} now; o.eye (court) and o.fade (racket opacity 0..1).
   */
  function update(dt, grip, axis, bodyPos, o = {}) {
    if (!(dt > 0) || !grip || !axis) return;
    for (let i = 0; i < count; i++) ring[(head - 1 - i + N) % N].age += dt;
    const ix = grip.x + axis.x * TRAIL.inner - bodyPos.x, iy = grip.y + axis.y * TRAIL.inner, iz = grip.z + axis.z * TRAIL.inner - bodyPos.z;
    const ox = grip.x + axis.x * TRAIL.outer - bodyPos.x, oy = grip.y + axis.y * TRAIL.outer, oz = grip.z + axis.z * TRAIL.outer - bodyPos.z;
    if (!(Number.isFinite(ix) && Number.isFinite(iy) && Number.isFinite(iz) && Number.isFinite(ox) && Number.isFinite(oy) && Number.isFinite(oz))) return;
    mid.x = (ix + ox) / 2; mid.y = (iy + oy) / 2; mid.z = (iz + oz) / 2;
    if (prevMid) {
      const v = Math.hypot(mid.x - prevMid.x, mid.y - prevMid.y, mid.z - prevMid.z) / dt;
      speed += (v - speed) * Math.min(1, dt / 0.02);
    } else prevMid = { x: 0, y: 0, z: 0 };
    prevMid.x = mid.x; prevMid.y = mid.y; prevMid.z = mid.z;
    const s = ring[head];
    s.ix = ix; s.iy = iy; s.iz = iz; s.ox = ox; s.oy = oy; s.oz = oz; s.age = 0;
    // Swing power (setTrailPower): stronger for a hard swing, at least `floor` while it lasts.
    const pw = power.left > 0;
    if (pw) power.left -= dt;
    const k0 = trailStrength(speed);
    s.k = Math.min(1.4, pw ? Math.max(k0 * power.k, k0 > 0.01 || speed > 2 ? power.floor : 0) : k0) * (o.fade ?? 1);
    s.len = pw ? power.k : 1;
    head = (head + 1) % N;
    if (count < N) count++;
    write(bodyPos, o.eye || null);
  }

  function write(bodyPos, eye) {
    let maxA = 0;
    for (let i = 0; i < N; i++) {
      // i = 0 newest.
      const s = i < count ? ring[(head - 1 - i + N) % N] : null;
      const live = s && s.age <= TRAIL.maxAge * (s.len || 1);
      const src = live ? s : ring[(head - 1 + N) % N];
      const p = i * 6, c = i * 8;
      pos[p] = src.ix + bodyPos.x; pos[p + 1] = src.iy; pos[p + 2] = src.iz + bodyPos.z;
      pos[p + 3] = src.ox + bodyPos.x; pos[p + 4] = src.oy; pos[p + 5] = src.oz + bodyPos.z;
      let a = 0;
      if (live) {
        const f = 1 - s.age / (TRAIL.maxAge * (s.len || 1));
        a = TRAIL.opacity * s.k * f * f;
        if (eye) {
          const dx = (s.ix + s.ox) / 2 + bodyPos.x - eye.x, dy = (s.iy + s.oy) / 2 - eye.y, dz = (s.iz + s.oz) / 2 + bodyPos.z - eye.z;
          if (dx * dx + dy * dy + dz * dz < TRAIL.nearEye * TRAIL.nearEye) a = 0;
        }
      }
      // Additive blending: the tint fades with alpha (black adds nothing); the tip edge is brighter.
      col[c] = col[c + 1] = col[c + 2] = a * 0.55; col[c + 3] = a * 0.55;
      col[c + 4] = col[c + 5] = col[c + 6] = a; col[c + 7] = a;
      if (a > maxA) maxA = a;
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
    mesh.visible = maxA > 0.004;
    if (mesh.visible) stats.shownFrames++;
    if (maxA > stats.maxStrength) stats.maxStrength = maxA;
  }

  function clear() {
    count = 0;
    prevMid = null;
    speed = 0;
    mesh.visible = false;
  }

  return { mesh, update, clear, stats, get speed() { return speed; } };
}
