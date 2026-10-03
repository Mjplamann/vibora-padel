// Padel ball machine: wheeled trolley chassis, smoked hopper full of balls, feed tube and a
// yaw/pitch launch head with two counter-rotating throwing wheels. Faces +z (toward the near
// side). Group origin = floor point under the machine; launch point at LAUNCH_HEIGHT.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { BALL } from '../config.js';
import { createBallMaterial } from './ballView.js';
import { canvasTexture, cached, loadFonts, DISPLAY_FONT, UI_FONT, mergeStatic } from './actorKit.js';
import { createRng } from '../util/math.js';

export const LAUNCH_HEIGHT = 1.0;
const HEAD_PIVOT = new THREE.Vector3(0, 0.88, 0.16);
const NOZZLE_LEN = 0.2;

function sideDecal() {
  return cached('machineDecal', () => {
    const t = canvasTexture(512, 256, (ctx, w, h) => {
      ctx.fillStyle = '#26282d';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#e8572a';
      ctx.beginPath();
      ctx.moveTo(0, h * 0.72);
      ctx.lineTo(w, h * 0.42);
      ctx.lineTo(w, h * 0.6);
      ctx.lineTo(0, h * 0.9);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#f2f2f2';
      ctx.font = `900 ${Math.round(h * 0.3)}px ${DISPLAY_FONT}`;
      ctx.textBaseline = 'middle';
      ctx.fillText('VÍBORA', w * 0.06, h * 0.3);
      ctx.font = `700 ${Math.round(h * 0.11)}px ${UI_FONT}`;
      ctx.fillStyle = '#c9ccd2';
      ctx.fillText('FEEDER  PRO · 2-WHEEL', w * 0.065, h * 0.52);
    });
    loadFonts().then(() => t.userData.redraw());
    return t;
  });
}

function panelTexture() {
  return cached('machinePanel', () => canvasTexture(256, 128, (ctx, w, h) => {
    ctx.fillStyle = '#0d0f12';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#0f2a22';
    ctx.fillRect(w * 0.06, h * 0.12, w * 0.5, h * 0.42);
    ctx.fillStyle = '#5dffb8';
    ctx.font = `700 ${Math.round(h * 0.28)}px ${UI_FONT}`;
    ctx.textBaseline = 'middle';
    ctx.fillText('62 km/h', w * 0.09, h * 0.33);
    const leds = ['#ff5a36', '#ffd23a', '#5dffb8', '#5dffb8'];
    leds.forEach((c, i) => {
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.arc(w * (0.68 + i * 0.075), h * 0.3, h * 0.05, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.fillStyle = '#2a2d33';
    for (let i = 0; i < 4; i++) {
      ctx.beginPath();
      ctx.arc(w * (0.14 + i * 0.13), h * 0.76, h * 0.09, 0, Math.PI * 2);
      ctx.fill();
    }
  }));
}

function wheel(radius, width, tireMat, hubMat) {
  const g = new THREE.Group();
  const tire = new THREE.Mesh(new THREE.TorusGeometry(radius - width * 0.35, width * 0.42, 14, 36), tireMat);
  tire.rotation.y = Math.PI / 2;
  tire.scale.set(1, 1, 1.15);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.62, radius * 0.62, width * 0.8, 24), hubMat);
  hub.rotation.z = Math.PI / 2;
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.2, radius * 0.2, width * 0.9, 16), tireMat);
  cap.rotation.z = Math.PI / 2;
  g.add(tire, hub, cap);
  return g;
}

/** Heap of balls inside a hopper: positions from a seeded rejection packing. */
function hopperBalls(count, rTop, rBottom, h, seed = 7) {
  const rng = createRng(seed);
  const r = BALL.radius;
  const pts = [];
  let tries = 0;
  while (pts.length < count && tries < 6000) {
    tries++;
    const y = r + rng() * (h - 2 * r) * 0.92;
    const rad = rBottom + (rTop - rBottom) * (y / h) - r * 1.2;
    const a = rng() * Math.PI * 2;
    const d = Math.sqrt(rng()) * Math.max(0, rad);
    const p = new THREE.Vector3(Math.cos(a) * d, y, Math.sin(a) * d);
    if (pts.every((q) => q.distanceToSquared(p) > (2 * r * 0.97) ** 2)) pts.push(p);
  }
  pts.sort((a, b) => a.y - b.y);
  return pts;
}

/**
 * @returns {THREE.Group} with methods setAim(yaw, pitch), pulse(), update(dt, machineState?) and
 *   userData.launchPoint(out) (world launch position).
 */
export function buildBallMachine({ accent = '#e8572a' } = {}) {
  const group = new THREE.Group();
  group.name = 'ball-machine';
  const body = new THREE.MeshPhysicalMaterial({ color: '#2b2e34', roughness: 0.42, metalness: 0.15, clearcoat: 0.6, clearcoatRoughness: 0.25 });
  const dark = new THREE.MeshStandardMaterial({ color: '#15171a', roughness: 0.6, metalness: 0.3 });
  const steel = new THREE.MeshStandardMaterial({ color: '#b9bec6', roughness: 0.28, metalness: 1 });
  const accentM = new THREE.MeshPhysicalMaterial({ color: accent, roughness: 0.4, clearcoat: 0.7 });
  const rubber = new THREE.MeshStandardMaterial({ color: '#111214', roughness: 0.85 });
  const smoke = new THREE.MeshPhysicalMaterial({
    color: '#9fb2c0', roughness: 0.08, metalness: 0, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false,
  });
  const decal = new THREE.MeshPhysicalMaterial({ map: sideDecal(), roughness: 0.38, clearcoat: 0.6 });

  const add = (m, parent = group) => {
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  };

  // Chassis
  const chassis = add(new THREE.Mesh(new RoundedBoxGeometry(0.46, 0.4, 0.58, 4, 0.05), body));
  chassis.position.set(0, 0.36, 0);
  for (const sx of [-1, 1]) {
    const side = add(new THREE.Mesh(new THREE.PlaneGeometry(0.48, 0.24), decal));
    side.position.set(sx * 0.2315, 0.37, 0);
    side.rotation.y = sx * Math.PI / 2;
  }
  const skirt = add(new THREE.Mesh(new RoundedBoxGeometry(0.47, 0.06, 0.6, 2, 0.02), dark));
  skirt.position.set(0, 0.17, 0);
  const panel = add(new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.1), new THREE.MeshStandardMaterial({
    map: panelTexture(), emissive: '#ffffff', emissiveMap: panelTexture(), emissiveIntensity: 0.6, roughness: 0.3,
  })));
  panel.position.set(0, 0.52, -0.2905);
  panel.rotation.y = Math.PI;

  // Wheels at the back, rubber feet at the front, trolley handle.
  for (const sx of [-1, 1]) {
    const w = add(wheel(0.11, 0.05, rubber, steel));
    w.position.set(sx * 0.262, 0.11, -0.2);
    const foot = add(new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 0.17, 12), dark));
    foot.position.set(sx * 0.17, 0.085, 0.22);
    const post = add(new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.62, 12), steel));
    post.position.set(sx * 0.17, 0.83, -0.305);
    post.rotation.x = -0.12;
  }
  const axle = add(new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.56, 10), steel));
  axle.rotation.z = Math.PI / 2;
  axle.position.set(0, 0.11, -0.2);
  const grip = add(new THREE.Mesh(new THREE.CapsuleGeometry(0.018, 0.34, 4, 12), rubber));
  grip.rotation.z = Math.PI / 2;
  grip.position.set(0, 1.135, -0.345);

  // Hopper: smoked truncated cone at the back top, full of balls.
  const hopper = new THREE.Group();
  hopper.position.set(0, 0.58, -0.08);
  group.add(hopper);
  const hopH = 0.36, rTop = 0.27, rBot = 0.1;
  const shell = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, hopH, 40, 1, true), smoke);
  shell.position.y = hopH / 2;
  shell.renderOrder = 2;
  hopper.add(shell);
  const rim = add(new THREE.Mesh(new THREE.TorusGeometry(rTop, 0.008, 8, 48), dark), hopper);
  rim.rotation.x = Math.PI / 2;
  rim.position.y = hopH;
  const collar = add(new THREE.Mesh(new THREE.CylinderGeometry(rBot + 0.01, rBot + 0.03, 0.05, 32), dark), hopper);
  collar.position.y = 0.0;
  const ballPts = hopperBalls(70, rTop, rBot, hopH * 0.86);
  const balls = new THREE.InstancedMesh(new THREE.SphereGeometry(BALL.radius, 20, 14), createBallMaterial({ emissive: 0.03 }), ballPts.length);
  balls.castShadow = true;
  const m4 = new THREE.Matrix4();
  const qb = new THREE.Quaternion();
  const rng = createRng(3);
  const ballBase = ballPts.map((p) => {
    qb.setFromEuler(new THREE.Euler(rng() * 6.28, rng() * 6.28, rng() * 6.28));
    return { p, q: qb.clone() };
  });
  ballBase.forEach((b, i) => balls.setMatrixAt(i, m4.compose(b.p, b.q, new THREE.Vector3(1, 1, 1))));
  hopper.add(balls);

  // Feed tube from the hopper throat to the head.
  const tubeCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0.58, -0.08), new THREE.Vector3(0, 0.6, 0.05), new THREE.Vector3(0, 0.74, 0.12), new THREE.Vector3(0, HEAD_PIVOT.y - 0.02, HEAD_PIVOT.z - 0.05),
  ]);
  add(new THREE.Mesh(new THREE.TubeGeometry(tubeCurve, 24, 0.042, 14), smoke.clone()));

  // Column + yaw turret + pitch yoke + launcher.
  const column = add(new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.06, HEAD_PIVOT.y - 0.56, 20), dark));
  column.position.set(0, (HEAD_PIVOT.y + 0.56) / 2, HEAD_PIVOT.z);
  const yaw = new THREE.Group();
  yaw.position.copy(HEAD_PIVOT);
  group.add(yaw);
  const turret = add(new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.04, 28), body), yaw);
  turret.position.y = -0.02;
  for (const sx of [-1, 1]) {
    const arm = add(new THREE.Mesh(new RoundedBoxGeometry(0.02, 0.14, 0.08, 2, 0.008), accentM), yaw);
    arm.position.set(sx * 0.115, 0.05, 0);
  }
  const pitch = new THREE.Group();
  pitch.position.y = 0.09;
  yaw.add(pitch);
  const housing = add(new THREE.Mesh(new RoundedBoxGeometry(0.2, 0.13, 0.22, 4, 0.03), body), pitch);
  housing.position.set(0, 0, 0.0);
  const stripe = add(new THREE.Mesh(new RoundedBoxGeometry(0.202, 0.025, 0.222, 2, 0.01), accentM), pitch);
  stripe.position.y = 0.035;
  // Throwing wheels (visible through side windows): counter-rotating discs.
  const throwWheels = [];
  for (const sx of [-1, 1]) {
    const w = add(wheel(0.07, 0.03, rubber, steel), pitch);
    w.position.set(sx * 0.072, -0.005, 0.06);
    w.rotation.order = 'ZYX';
    w.rotation.z = Math.PI / 2; // spin axis vertical
    throwWheels.push({ w, dir: sx });
  }
  const recoil = new THREE.Group();
  pitch.add(recoil);
  const nozzle = add(new THREE.Mesh(new THREE.CylinderGeometry(0.043, 0.05, NOZZLE_LEN, 24, 1, true), dark), recoil);
  nozzle.rotation.x = Math.PI / 2;
  nozzle.position.set(0, 0, 0.11 + NOZZLE_LEN / 2);
  nozzle.material = dark.clone();
  nozzle.material.side = THREE.DoubleSide;
  const lip = add(new THREE.Mesh(new THREE.TorusGeometry(0.044, 0.007, 10, 28), accentM), recoil);
  lip.position.set(0, 0, 0.11 + NOZZLE_LEN);

  // Muzzle puff (fades after a pulse).
  const puffTex = cached('machinePuff', () => canvasTexture(64, 64, (ctx, w, h) => {
    const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    g.addColorStop(0, 'rgba(235,240,245,0.9)');
    g.addColorStop(0.5, 'rgba(225,230,238,0.35)');
    g.addColorStop(1, 'rgba(220,225,235,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }));
  const puffMat = new THREE.SpriteMaterial({ map: puffTex, transparent: true, opacity: 0, depthWrite: false });
  const puff = new THREE.Sprite(puffMat);
  puff.scale.setScalar(0.12);
  puff.position.set(0, 0, 0.11 + NOZZLE_LEN + 0.06);
  recoil.add(puff);

  let pulseT = 0;
  let spin = 0;
  let wheelSpeed = 30;
  const target = { yaw: 0, pitch: 0.12 };
  let aimYaw = 0, aimPitch = 0.12;

  function setAim(y, p) {
    target.yaw = y;
    target.pitch = p;
  }
  function pulse() {
    pulseT = 0.22;
    wheelSpeed = 80;
  }
  function update(dt = 1 / 60, state = null) {
    if (state) {
      if (Number.isFinite(state.headYaw)) target.yaw = state.headYaw;
      if (Number.isFinite(state.headPitch)) target.pitch = state.headPitch;
    }
    const k = 1 - Math.exp(-10 * dt);
    aimYaw += (target.yaw - aimYaw) * k;
    aimPitch += (target.pitch - aimPitch) * k;
    yaw.rotation.y = aimYaw;
    pitch.rotation.x = -aimPitch;
    wheelSpeed += (30 - wheelSpeed) * (1 - Math.exp(-2 * dt));
    spin += wheelSpeed * dt;
    for (const t of throwWheels) t.w.rotation.x = spin * t.dir;
    pulseT = Math.max(0, pulseT - dt);
    const p = pulseT / 0.22;
    recoil.position.z = -0.018 * Math.sin(Math.PI * Math.min(1, p * 1.2)) * p;
    puffMat.opacity = 0.5 * p * p;
    puff.scale.setScalar(0.08 + 0.25 * (1 - p));
    // Hopper balls settle with a small jiggle after each feed.
    if (pulseT > 0) {
      ballBase.forEach((b, i) => {
        const j = 0.004 * p * Math.sin(i * 12.9898 + pulseT * 90);
        m4.compose(_v.copy(b.p).add(_w.set(j, Math.abs(j) * 0.5, -j)), b.q, _one);
        balls.setMatrixAt(i, m4);
      });
      balls.instanceMatrix.needsUpdate = true;
    }
  }

  const _v = new THREE.Vector3();
  const _w = new THREE.Vector3();
  const _one = new THREE.Vector3(1, 1, 1);
  // Static parts: one mesh per material (moving head, hopper balls and panel stay separate).
  mergeStatic(group, new Set([yaw, balls, shell]));
  group.setAim = setAim;
  group.pulse = pulse;
  group.update = update;
  group.userData.launchPoint = (out = new THREE.Vector3()) => lip.getWorldPosition(out);
  update(0);
  return group;
}

/** Convenience wrapper: { group, setAim(yaw, pitch), pulse(), update(dt, machineState?) }. */
export function createMachineView(opts) {
  const group = buildBallMachine(opts);
  return { group, setAim: group.setAim, pulse: group.pulse, update: group.update };
}
