// Dev harness for the actor renderers. ?view=racket|fp|humanoid|machine|all (default all).
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { buildRacket } from '../src/render/racket.js';
import { createFirstPersonRig } from '../src/render/fpRig.js';
import { readyBody } from './actors-bodies.js';
import { v3 } from '../src/util/vec3.js';
import { COURT } from '../src/config.js';
import { createHumanoid } from '../src/render/humanoid.js';
import { createBallView } from '../src/render/ballView.js';
import { buildBallMachine } from '../src/render/machineView.js';

import { setActorQuality } from '../src/render/actorKit.js';

const params = new URLSearchParams(location.search);
if (params.get('quality')) setActorQuality(params.get('quality'));
const view = params.get('view') || 'all';
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight, false);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const pmrem = new THREE.PMREMGenerator(renderer);
const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
const label = document.getElementById('label');

function studioScene() {
  const scene = new THREE.Scene();
  scene.environment = envTex;
  scene.environmentIntensity = 0.55;
  scene.background = new THREE.Color('#15171c');
  const key = new THREE.DirectionalLight('#fff4e8', 2.6);
  key.position.set(1.5, 3, 2.5);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = key.shadow.camera.bottom = -1.5;
  key.shadow.camera.right = key.shadow.camera.top = 1.5;
  key.shadow.bias = -0.0004;
  scene.add(key);
  const rim = new THREE.DirectionalLight('#9fc4ff', 1.6);
  rim.position.set(-2, 1.5, -2);
  scene.add(rim);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), new THREE.MeshStandardMaterial({ color: '#202329', roughness: 0.85 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  return scene;
}

const views = [];
const pending = [];

// ---------------------------------------------------------------- court stand-in
function courtScene() {
  const scene = new THREE.Scene();
  scene.environment = envTex;
  scene.environmentIntensity = 0.35;
  scene.background = new THREE.Color('#07080b');
  scene.fog = new THREE.Fog('#07080b', 30, 70);
  const hemi = new THREE.HemisphereLight('#b9c8e6', '#1a1c22', 0.5);
  scene.add(hemi);
  const lights = [[-3, -5], [3, -5], [-3, 5], [3, 5]];
  lights.forEach(([x, z], i) => {
    const s = new THREE.SpotLight('#fff3e2', 260, 30, 0.8, 0.6, 2);
    s.position.set(x, 9, z);
    s.target.position.set(x * 0.6, 0, z * 0.8);
    if (i >= 2) {
      s.castShadow = true;
      s.shadow.mapSize.set(2048, 2048);
      s.shadow.bias = -0.0002;
      s.shadow.normalBias = 0.02;
      s.shadow.camera.near = 2;
    }
    scene.add(s, s.target);
  });
  const turf = new THREE.Mesh(new THREE.PlaneGeometry(10, 20), new THREE.MeshStandardMaterial({ color: '#1a3f8f', roughness: 0.95 }));
  turf.rotation.x = -Math.PI / 2;
  turf.receiveShadow = true;
  const outside = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshStandardMaterial({ color: '#2a2c31', roughness: 0.8 }));
  outside.rotation.x = -Math.PI / 2;
  outside.position.y = -0.003;
  outside.receiveShadow = true;
  scene.add(turf, outside);
  const lineMat = new THREE.MeshStandardMaterial({ color: '#f4f4f4', roughness: 0.7 });
  const line = (x, z, w, d) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.002, d), lineMat);
    m.position.set(x, 0.001, z);
    m.receiveShadow = true;
    scene.add(m);
  };
  line(0, COURT.serviceLine, 10, 0.05); line(0, -COURT.serviceLine, 10, 0.05);
  line(0, 0, 0.05, COURT.serviceLine * 2 + 0.4);
  line(0, 9.975, 10, 0.05); line(0, -9.975, 10, 0.05);
  // Net
  const net = new THREE.Mesh(new THREE.BoxGeometry(10, 0.86, 0.01), new THREE.MeshStandardMaterial({ color: '#111', transparent: true, opacity: 0.55, roughness: 1 }));
  net.position.set(0, 0.45, 0);
  const band = new THREE.Mesh(new THREE.BoxGeometry(10, 0.05, 0.02), new THREE.MeshStandardMaterial({ color: '#f2f2f2' }));
  band.position.set(0, 0.88, 0);
  scene.add(net, band);
  // Glass + posts
  const glassMat = new THREE.MeshPhysicalMaterial({ color: '#cfe8e4', roughness: 0.04, transparent: true, opacity: 0.14, envMapIntensity: 1.5, depthWrite: false });
  const postMat = new THREE.MeshStandardMaterial({ color: '#141518', roughness: 0.5, metalness: 0.6 });
  for (const zs of [-1, 1]) {
    const g = new THREE.Mesh(new THREE.BoxGeometry(10, 3, 0.012), glassMat);
    g.position.set(0, 1.5, zs * 10);
    scene.add(g);
    for (const xs of [-1, 1]) {
      const sg = new THREE.Mesh(new THREE.BoxGeometry(0.012, 3, 2), glassMat);
      sg.position.set(xs * 5, 1.5, zs * 9);
      const sg2 = new THREE.Mesh(new THREE.BoxGeometry(0.012, 2, 2), glassMat);
      sg2.position.set(xs * 5, 1.0, zs * 7);
      scene.add(sg, sg2);
    }
    for (let x = -5; x <= 5; x += 2) {
      const p = new THREE.Mesh(new THREE.BoxGeometry(0.06, 4, 0.06), postMat);
      p.position.set(x, 2, zs * 10.03);
      scene.add(p);
    }
  }
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(40, 10), new THREE.MeshStandardMaterial({ color: '#16181d', roughness: 0.9 }));
  wall.position.set(0, 5, -16);
  scene.add(wall);
  return scene;
}

function racketView() {
  const scene = studioScene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 50);
  camera.position.set(0, 0.42, 1.55);
  camera.lookAt(0, 0.3, 0);
  const a = buildRacket({ color: '#e8572a' });
  a.position.set(-0.3, 0.16, 0);
  a.rotation.set(0.0, 0.25, 0.08);
  const b = buildRacket({ color: '#e8572a' });
  b.position.set(0.3, 0.16, 0);
  b.rotation.set(0.0, Math.PI - 0.25, -0.08);
  const c = buildRacket({ color: '#2fb6c8', style: 'white' });
  c.position.set(0.02, 0.06, 0.3);
  c.rotation.set(-1.25, 0.2, 1.1);
  scene.add(a, b, c);
  return { scene, camera, name: '(a) racket — forehand face · backhand face · 3/4 (white style)' };
}

function fpView() {
  const scene = courtScene();
  const camera = new THREE.PerspectiveCamera(70, 1, 0.02, 120);
  const cradle = params.get('cradle') !== '0';
  const player = readyBody(1.8, 7.6, cradle ? { wristL: [0.03, 1.28, -0.47] } : {});
  camera.position.set(player.eye.x, player.eye.y, player.eye.z);
  camera.rotation.set(-14 * Math.PI / 180, 0, 0, 'YXZ');
  const zoom = Number(params.get('zoom') || 1);
  if (zoom > 1) {
    camera.fov = 70 / zoom;
    const r = player.racket;
    camera.lookAt(r.grip.x + r.axis.x * 0.08, r.grip.y + r.axis.y * 0.08, r.grip.z + r.axis.z * 0.08);
  }
  const rig = createFirstPersonRig({ handed: 'right' });
  scene.add(rig.root);
  rig.update(player, 0, {});
  pending.push(rig.ready.then((glb) => { rig.update(player, 0, {}); console.log('fp rig glb', glb, 'wristInRacket', rig.wristInRacket().toArray().map((v) => v.toFixed(3)).join(',')); }));
  return { scene, camera, name: '(b) first person — ready position' };
}

function gripViews() {
  const scene = studioScene();
  import('../src/render/handPose.js').then((m) => { m.DEBUG.on = true; window.__hp = m.DEBUG; });
  const player = readyBody(0, 0);
  const rig = createFirstPersonRig({ handed: 'right' });
  scene.add(rig.root);
  rig.update(player, 0, {});
  pending.push(rig.ready.then(() => { rig.update(player, 0, {}); console.log('HP', window.__hp?.log.slice(-40).join(' | ')); }));
  const g = player.racket.grip;
  const mk = (dx, dy, dz, name) => {
    const camera = new THREE.PerspectiveCamera(32, 1, 0.01, 20);
    camera.position.set(g.x + dx, g.y + dy, g.z + dz);
    camera.lookAt(g.x, g.y - 0.02, g.z);
    return { scene, camera, name };
  };
  return [mk(0.45, 0.12, 0.05, 'grip: outside'), mk(-0.4, 0.1, -0.2, 'grip: inside/front'), mk(-0.12, 0.45, 0.38, 'grip: from eye'), mk(0.15, -0.4, -0.3, 'grip: below')];
}

function gripDebugViews() {
  const scene = studioScene();
  scene.children.filter((o) => o.isMesh).forEach((o) => { o.visible = false; });
  const rig = createFirstPersonRig({ handed: params.get('hand') || 'right' });
  scene.add(rig.root);
  const player = {
    pos: v3(0, 0, 0.5), eye: v3(0, 1.6, 0.6), handed: 'right', height: 1.75,
    racket: { grip: v3(0, 1, 0), axis: v3(0, 1, 0), normal: v3(0, 0, 1), vel: v3(), t: 0 }, bodyCourt: null,
  };
  const ro = { arms: false };
  rig.update(player, 0, ro);
  pending.push(rig.ready.then(() => rig.update(player, 0, ro)));
  const mk = (p, name, up = [0, 1, 0]) => {
    const camera = new THREE.PerspectiveCamera(28, 1, 0.01, 20);
    camera.position.set(p[0], 1 + p[1], p[2]);
    camera.up.set(...up);
    camera.lookAt(0, 0.99, 0);
    return { scene, camera, name };
  };
  return [mk([0, 0, 0.42], 'forehand face (+Z) view'), mk([0, 0, -0.42], 'backhand face (-Z) view'), mk([0.42, 0, 0], 'edge +X'), mk([-0.42, 0, 0.0], 'edge -X'),
    mk([0.25, -0.1, 0.3], '3/4 +X+Z'), mk([-0.02, -0.42, 0.001], 'from butt (-Y)', [0, 0, 1])];
}

function humanoidView() {
  const scene = courtScene();
  scene.environmentIntensity = 0.5;
  const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 100);
  camera.position.set(0.2, 1.45, -1.2);
  camera.lookAt(0.2, 1.0, -6.2);
  const poses = [
    { x: -1.7, label: 'ready', st: { holding: 'ready', stroke: null, swingPhase: 0, vel: v3() } },
    { x: -0.4, label: 'run', st: { holding: 'run', stroke: null, swingPhase: 0, vel: v3(0, 0, 4.2) }, phase: 0.18 },
    { x: 0.9, label: 'forehand contact', st: { holding: 'swing', stroke: 'forehand', swingPhase: 0.55, vel: v3() } },
    { x: 2.2, label: 'smash', st: { holding: 'swing', stroke: params.get('stroke') || 'smash', swingPhase: Number(params.get('phase') || 0.35), vel: v3() } },
  ];
  const shirts = ['#f2f2f2', '#e8572a', '#2fb6c8', '#1d2b4a'];
  const caps = ['#1d2b4a', '#f4f4f2', '#1b1b1f', '#f4f4f2'];
  poses.forEach((p, i) => {
    const h = createHumanoid({ shirt: shirts[i], cap: caps[i], handed: 'right', skin: i % 2 ? '#8d5a3e' : '#b07a5a' });
    const st = { pos: v3(p.x, 0, -6.2), facing: 0, handed: 'right', ...p.st };
    // Warm the animation up so damped values settle.
    for (let k = 0; k < 90; k++) h.update(st, 1 / 60);
    if (p.phase !== undefined) for (let k = 0; k < 3; k++) h.update(st, 1 / 60);
    scene.add(h.root);
  });
  return { scene, camera, name: '(c) humanoid — ready · run · forehand contact · smash' };
}

function machineView() {
  const scene = courtScene();
  scene.environmentIntensity = 0.6;
  const camera = new THREE.PerspectiveCamera(34, 1, 0.05, 100);
  camera.position.set(1.55, 1.25, -6.7);
  camera.lookAt(-0.05, 0.72, -9.15);
  const m = buildBallMachine();
  m.position.set(0, 0, -9.2);
  m.setAim(-0.18, 0.2);
  scene.add(m);
  for (let i = 0; i < 30; i++) m.update(1 / 60);
  m.pulse();
  for (let i = 0; i < 4; i++) m.update(1 / 60);
  // Ball just fed: fly a few frames from the launch point with topspin.
  const bv = createBallView(scene, { halo: params.get('halo') === '1' });
  const lp = m.userData.launchPoint(new THREE.Vector3());
  const ball = { pos: v3(lp.x, lp.y, lp.z), vel: v3(-2.4, 3.2, 13.5), spin: v3(-150, 0, 0), t: 0, atRest: false, id: 1 };
  for (let i = 0; i < 3; i++) {
    const dt = 1 / 60;
    ball.vel.y -= 9.81 * dt;
    ball.pos.x += ball.vel.x * dt; ball.pos.y += ball.vel.y * dt; ball.pos.z += ball.vel.z * dt;
    bv.update(ball, dt, 1);
  }
  // A second ball rolling near the side glass to show the glass contact shadow.
  const bv2 = createBallView(scene);
  bv2.update({ pos: v3(1.25, 0.16, -9.55), vel: v3(0.5, -0.5, 2), spin: v3(), t: 0, atRest: false, id: 2 }, 1 / 60, 1);
  return { scene, camera, name: '(d) ball machine + ball (trail, contact shadows)' };
}

function strokesView() {
  const scene = courtScene();
  scene.environmentIntensity = 0.5;
  const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 100);
  const stroke = params.get('stroke');
  const list = stroke
    ? [0, 0.15, 0.3, 0.4, 0.47, 0.55, 0.65, 0.75, 0.9, 1].map((p) => [stroke, p])
    : ['forehand', 'backhand', 'volley-fh', 'volley-bh', 'bandeja', 'vibora', 'smash', 'lob', 'chiquita', 'serve'].map((k) => [k, k === 'smash' ? 0.6 : 0.55]);
  const side = params.get('side') === '1';
  list.forEach(([k, ph], i) => {
    const h = createHumanoid({ shirt: i % 2 ? '#2fb6c8' : '#f2f2f2', handed: params.get('lefty') === '1' ? 'left' : 'right' });
    const st = { pos: v3(-6.75 + i * 1.5, 0, -6), facing: side ? -Math.PI / 2 : 0, vel: v3(), holding: 'swing', stroke: k, swingPhase: ph };
    for (let f = 0; f < 60; f++) h.update(st, 1 / 60);
    scene.add(h.root);
  });
  camera.position.set(0, 1.6, 6.5);
  camera.lookAt(0, 1.05, -6);
  return { scene, camera, name: `strokes ${stroke || '(contact)'} ${side ? 'side' : 'front'}` };
}

function robustView() {
  const scene = courtScene();
  const camera = new THREE.PerspectiveCamera(70, 1, 0.02, 120);
  const rig = createFirstPersonRig({ handed: 'right' });
  scene.add(rig.root);
  const base = readyBody(1.8, 7.6);
  const results = [];
  const tryCase = (name, fn) => { try { fn(); results.push(`${name}:ok`); } catch (e) { results.push(`${name}:FAIL ${e.message}`); console.error(name, e); } };
  pending.push(rig.ready.then(() => {
    tryCase('normal', () => rig.update(base, 1 / 60, {}));
    tryCase('extrap', () => rig.update({ ...base, racket: { ...base.racket, vel: v3(10, 2, -8), angVel: v3(0, 20, 5) } }, 1 / 60, { extrapolate: 0.05 }));
    tryCase('noBody', () => rig.update({ ...base, bodyCourt: null }, 1 / 60, {}));
    tryCase('noRacket', () => rig.update({ ...base, racket: null }, 1 / 60, {}));
    tryCase('noBoth', () => rig.update({ ...base, racket: null, bodyCourt: null }, 1 / 60, {}));
    tryCase('partialJoints', () => rig.update({ ...base, bodyCourt: { ...base.bodyCourt, joints: { shoulderL: base.bodyCourt.joints.shoulderL } } }, 1 / 60, {}));
    tryCase('lefty', () => { rig.setHanded('left'); rig.update({ ...base, handed: 'left' }, 1 / 60, {}); rig.setHanded('right'); });
    tryCase('skin', () => rig.setSkin('#6b4430'));
    const t0 = performance.now();
    for (let i = 0; i < 600; i++) rig.update(base, 1 / 60, { extrapolate: 0.03 });
    const rigMs = (performance.now() - t0) / 600;
    const h = createHumanoid({});
    const st = { pos: v3(0, 0, -7), vel: v3(2, 0, 1), facing: 0.3, holding: 'run', stroke: null, swingPhase: 0, handed: 'right' };
    const t1 = performance.now();
    for (let i = 0; i < 600; i++) { st.holding = i % 200 < 100 ? 'run' : 'swing'; st.stroke = 'forehand'; st.swingPhase = (i % 100) / 100; h.update(st, 1 / 60); }
    const humMs = (performance.now() - t1) / 600;
    tryCase('humanoidNull', () => h.update(null, 1 / 60));
    tryCase('humanoidLefty', () => h.update({ ...st, handed: 'left' }, 1 / 60));
    const bv = createBallView(scene);
    tryCase('ballNull', () => bv.update(null, 1 / 60));
    tryCase('ballRest', () => bv.update({ pos: v3(0, 0.0325, 0), vel: v3(), spin: v3(), atRest: true }, 1 / 60, 0.5));
    tryCase('flash', () => { bv.flash('hit'); bv.setHalo(true); bv.setVisible(false); bv.setVisible(true); });
    const m = buildBallMachine();
    tryCase('machine', () => { m.setAim(0.3, 0.1); m.pulse(); m.update(1 / 60, { headYaw: 0.1, headPitch: 0.2 }); });
    console.log('ROBUST', results.join(' '), `rig.update ${rigMs.toFixed(3)} ms, humanoid.update ${humMs.toFixed(3)} ms`);
  }));
  camera.position.set(base.eye.x, base.eye.y, base.eye.z);
  return { scene, camera, name: 'robustness' };
}

const builders = { robust: robustView, strokes: strokesView, machine: machineView, humanoid: humanoidView, racket: racketView, fp: fpView, grip: gripViews, gripdbg: gripDebugViews };
const order = view === 'all' ? ['racket', 'fp', 'humanoid', 'machine'] : [view];
for (const k of order) if (builders[k]) views.push(...[].concat(builders[k]()));

function render() {
  const W = innerWidth, H = innerHeight;
  renderer.setScissorTest(views.length > 1);
  const cols = views.length > 1 ? 2 : 1;
  const rows = Math.ceil(views.length / cols);
  views.forEach((v, i) => {
    const w = W / cols, h = H / rows;
    const x = (i % cols) * w, y = H - (Math.floor(i / cols) + 1) * h;
    renderer.setViewport(x, y, w, h);
    renderer.setScissor(x, y, w, h);
    v.camera.aspect = w / h;
    v.camera.updateProjectionMatrix();
    v.update?.(1 / 60);
    renderer.render(v.scene, v.camera);
    v.calls = renderer.info.render.calls;
    v.tris = renderer.info.render.triangles;
  });
  label.textContent = views.map((v) => v.name).join('\n');
}

// Render a few frames (textures redraw after fonts load), then flag readiness.
let frames = 0;
function loop() {
  render();
  if (++frames < 4) setTimeout(loop, 250);
  else {
    window.__ready = true;
    console.log('STATS', views.map((v) => `${v.name.slice(0, 18)}: ${v.calls} calls ${v.tris} tris`).join(' | '));
  }
}
Promise.all(pending).finally(loop);
