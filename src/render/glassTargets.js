// Glass Breaker targets (game/challenges.js): glowing rings on the far back glass and a shatter
// burst when one is hit. Three target quads (one draw call each), one instanced mesh of shards
// (one draw call) and one flash quad; nothing is allocated per frame.
import * as THREE from 'three';

const MAX_TARGETS = 4;
const SHARDS = 72;
const SHARD_LIFE = 1.4;
const FLASH_LIFE = 0.55;
const G = 9.81;

function ringTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d');
  const cx = 128;
  const glow = ctx.createRadialGradient(cx, cx, 20, cx, cx, 128);
  glow.addColorStop(0, 'rgba(220,245,60,0.0)');
  glow.addColorStop(0.62, 'rgba(220,245,60,0.18)');
  glow.addColorStop(0.8, 'rgba(220,245,60,0.55)');
  glow.addColorStop(1, 'rgba(220,245,60,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, 256, 256);
  const ring = (r, w, a) => {
    ctx.strokeStyle = `rgba(236,255,120,${a})`;
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.arc(cx, cx, r, 0, Math.PI * 2);
    ctx.stroke();
  };
  ring(100, 10, 1);
  ring(68, 6, 0.85);
  ring(36, 5, 0.7);
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.beginPath();
  ctx.arc(cx, cx, 12, 0, Math.PI * 2);
  ctx.fill();
  // Crosshair ticks.
  ctx.strokeStyle = 'rgba(236,255,120,0.9)';
  ctx.lineWidth = 4;
  for (const [x0, y0, x1, y1] of [[cx, 6, cx, 30], [cx, 226, cx, 250], [6, cx, 30, cx], [226, cx, 250, cx]]) {
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function flashTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.3, 'rgba(200,250,255,0.7)');
  g.addColorStop(1, 'rgba(139,228,238,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * @param {THREE.Scene} scene
 * @returns {{ set(targets), hit(id, pos), update(dt), clear(), dispose(), group }}
 *   targets: [{ id, x, y, z, r, wall: 'back' }] (court frame; back glass at z = ±10).
 */
export function createGlassTargets(scene) {
  const group = new THREE.Group();
  group.name = 'glass-targets';
  scene.add(group);

  const ringMat = new THREE.MeshBasicMaterial({
    map: ringTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, side: THREE.DoubleSide,
  });
  // The other lit targets are dimmer: the bright one is where an on-time drive flies (aim).
  const dimMat = ringMat.clone();
  dimMat.opacity = 0.42;
  const quad = new THREE.PlaneGeometry(1, 1);
  const slots = [];
  for (let i = 0; i < MAX_TARGETS; i++) {
    const m = new THREE.Mesh(quad, ringMat);
    m.visible = false;
    m.renderOrder = 5;
    m.frustumCulled = false;
    group.add(m);
    slots.push({ mesh: m, id: null, r: 0.6, born: 0, x: 0, y: 0, z: 0, aim: false });
  }

  // Shatter: shards (instanced, additive, per-instance fade through instanceColor) and a flash.
  const shardGeo = new THREE.BufferGeometry();
  // Shards ~10 cm across: they must read from the other end of the court (18 m).
  shardGeo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0.1, 0, -0.07, -0.06, 0, 0.08, -0.05, 0], 3));
  shardGeo.computeVertexNormals();
  const shardMat = new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, side: THREE.DoubleSide,
  });
  const shards = new THREE.InstancedMesh(shardGeo, shardMat, SHARDS);
  shards.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  shards.setColorAt(0, new THREE.Color(0, 0, 0));
  shards.instanceColor.setUsage(THREE.DynamicDrawUsage);
  shards.frustumCulled = false;
  shards.count = 0;
  shards.renderOrder = 6;
  group.add(shards);
  const sp = new Float32Array(SHARDS * 3); // positions
  const sv = new Float32Array(SHARDS * 3); // velocities
  const sr = new Float32Array(SHARDS * 3); // rotation (euler) and spin
  const sw = new Float32Array(SHARDS * 3); // angular velocity
  const sz = new Float32Array(SHARDS); // size
  let shardAge = Infinity;

  const flash = new THREE.Mesh(quad, new THREE.MeshBasicMaterial({
    map: flashTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, opacity: 0,
  }));
  flash.visible = false;
  flash.renderOrder = 7;
  group.add(flash);
  let flashAge = Infinity;

  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const pv = new THREE.Vector3();
  const sc = new THREE.Vector3();
  const col = new THREE.Color();
  let time = 0;
  let seed = 1;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  function place(slot, t) {
    const zIn = t.z < 0 ? t.z + 0.03 : t.z - 0.03; // just in front of the glass, on the court side
    slot.x = t.x;
    slot.y = t.y;
    slot.z = zIn;
    slot.r = t.r || 0.6;
    slot.aim = t.aim !== false;
    slot.mesh.material = slot.aim ? ringMat : dimMat;
    slot.mesh.position.set(t.x, t.y, zIn);
    slot.mesh.rotation.set(0, t.z < 0 ? 0 : Math.PI, 0);
    slot.mesh.visible = true;
  }

  /** Shows exactly these targets (new ones pop in). */
  function set(targets = []) {
    const keep = new Set(targets.map((t) => t.id));
    for (const s of slots) {
      if (s.id && !keep.has(s.id)) {
        s.id = null;
        s.mesh.visible = false;
      }
    }
    for (const t of targets) {
      let s = slots.find((x) => x.id === t.id);
      if (!s) {
        s = slots.find((x) => !x.id);
        if (!s) continue;
        s.id = t.id;
        s.born = time;
      }
      place(s, t);
    }
  }

  /** Shatters a target at pos (or its centre). */
  function hit(id, pos = null) {
    const s = slots.find((x) => x.id === id);
    const px = pos ? pos.x : s ? s.x : 0;
    const py = pos ? pos.y : s ? s.y : 1.2;
    const pz = s ? s.z : pos ? (pos.z < 0 ? pos.z + 0.03 : pos.z - 0.03) : -9.97;
    const dirZ = pz < 0 ? 1 : -1; // shards fly back into the court
    if (s) {
      s.id = null;
      s.mesh.visible = false;
    }
    seed = (Math.floor(px * 1000) ^ Math.floor(py * 7919)) >>> 0 || 1;
    for (let i = 0; i < SHARDS; i++) {
      const a = rnd() * Math.PI * 2;
      const r = Math.sqrt(rnd()) * 0.55;
      sp[i * 3] = px + Math.cos(a) * r;
      sp[i * 3 + 1] = py + Math.sin(a) * r;
      sp[i * 3 + 2] = pz;
      const out = 1.2 + rnd() * 3.2;
      sv[i * 3] = Math.cos(a) * (0.6 + rnd() * 2.2);
      sv[i * 3 + 1] = Math.sin(a) * (0.6 + rnd() * 2.2) + 1.2;
      sv[i * 3 + 2] = dirZ * out;
      sr[i * 3] = rnd() * 6.28;
      sr[i * 3 + 1] = rnd() * 6.28;
      sr[i * 3 + 2] = rnd() * 6.28;
      sw[i * 3] = (rnd() - 0.5) * 20;
      sw[i * 3 + 1] = (rnd() - 0.5) * 20;
      sw[i * 3 + 2] = (rnd() - 0.5) * 20;
      sz[i] = 0.7 + rnd() * 1.5;
    }
    shards.count = SHARDS;
    shardAge = 0;
    flash.position.set(px, py, pz + dirZ * 0.02);
    flash.rotation.set(0, dirZ > 0 ? 0 : Math.PI, 0);
    flash.visible = true;
    flashAge = 0;
  }

  function update(dt) {
    time += dt;
    // Targets breathe so they read as live from across the court.
    for (const s of slots) {
      if (!s.id) continue;
      const age = time - s.born;
      const pop = Math.min(1, age / 0.25);
      const k = (2 * s.r) * (0.6 + 0.4 * pop) * (s.aim ? 1.06 + 0.07 * Math.sin(time * 7) : 1 + 0.03 * Math.sin(time * 4));
      s.mesh.scale.set(k, k, 1);
    }
    if (shardAge < SHARD_LIFE) {
      shardAge += dt;
      const fade = Math.max(0, 1 - shardAge / SHARD_LIFE);
      for (let i = 0; i < SHARDS; i++) {
        const o = i * 3;
        sv[o + 1] -= G * dt;
        sp[o] += sv[o] * dt;
        sp[o + 1] += sv[o + 1] * dt;
        sp[o + 2] += sv[o + 2] * dt;
        if (sp[o + 1] < 0.01) {
          sp[o + 1] = 0.01;
          sv[o + 1] *= -0.25;
          sv[o] *= 0.6;
          sv[o + 2] *= 0.6;
        }
        sr[o] += sw[o] * dt;
        sr[o + 1] += sw[o + 1] * dt;
        sr[o + 2] += sw[o + 2] * dt;
        e.set(sr[o], sr[o + 1], sr[o + 2]);
        q.setFromEuler(e);
        pv.set(sp[o], sp[o + 1], sp[o + 2]);
        sc.set(sz[i], sz[i], sz[i]);
        m4.compose(pv, q, sc);
        shards.setMatrixAt(i, m4);
        // Glass glint: cyan-white, flickering as it tumbles.
        const glint = 0.55 + 0.45 * Math.abs(Math.sin(sr[o] * 2.1 + sr[o + 1]));
        col.setRGB(0.75 * glint * fade, 0.95 * glint * fade, glint * fade);
        shards.setColorAt(i, col);
      }
      shards.instanceMatrix.needsUpdate = true;
      shards.instanceColor.needsUpdate = true;
      if (shardAge >= SHARD_LIFE) shards.count = 0;
    }
    if (flashAge < FLASH_LIFE) {
      flashAge += dt;
      const u = Math.min(1, flashAge / FLASH_LIFE);
      flash.material.opacity = 1 - u;
      const k = 1.2 + 3.4 * Math.sqrt(u);
      flash.scale.set(k, k, 1);
      if (u >= 1) flash.visible = false;
    }
  }

  function clear() {
    for (const s of slots) {
      s.id = null;
      s.mesh.visible = false;
    }
    shards.count = 0;
    shardAge = Infinity;
    flash.visible = false;
    flashAge = Infinity;
  }

  function dispose() {
    clear();
    scene.remove(group);
    quad.dispose();
    shardGeo.dispose();
    ringMat.map.dispose();
    ringMat.dispose();
    dimMat.dispose();
    shardMat.dispose();
    flash.material.map.dispose();
    flash.material.dispose();
    shards.dispose();
  }

  return { set, hit, update, clear, dispose, group, get active() { return slots.filter((s) => s.id).length; } };
}
