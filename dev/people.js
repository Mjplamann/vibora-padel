// Dev page for the athletes in a real venue, realistic (baked MakeHuman) or procedural, same setup:
//   ?people=real|sdf  &venue=club|sunset|stadium  &quality=  &lod=0|1|auto
//   &view=close      a portrait (face, hair, collar, hands on the racket); &cam=face|hands
//        kits        eight players, men and women, generated kits
//        strokes     six stroke poses at their contact (forehand, backhand, volley, bandeja, smash, serve)
//        match       four players on court seen from the near baseline (first-person height, 70° FOV)
//        replay      a broadcast-style replay camera close to two players mid-rally
//        swing       one player through a stroke: &stroke=forehand &phase=0.55 (side camera)
//        turn        one player turntable: front / side / back / three-quarter
// window.__people = { ready, mode, calls, tris, people: [{ tris, lod, realistic }] }
import * as THREE from 'three';
import { createRenderer } from '../src/render/scene.js';
import { buildEnvironment } from '../src/render/environment.js';
import { setActorQuality } from '../src/render/actorKit.js';
import { createSkinnedHuman, kitFor, PEOPLE_MODE } from '../src/render/skinnedHuman.js';
import { loadPeopleAssets } from '../src/render/peopleAssets.js';
import { createActorAnimator } from '../src/render/animation/animator.js';
import { buildActorRacket } from '../src/render/actorRacket.js';
import { buildRacket } from '../src/render/racket.js';
import { humanTemplate } from '../src/render/humanModel.js';
import { createFirstPersonRig } from '../src/render/fpRig.js';
import { readyBody } from './actors-bodies.js';

const qs = new URLSearchParams(location.search);
const quality = qs.get('quality') || 'high';
const view = qs.get('view') || 'close';
const lodQ = qs.get('lod');
const lod = lodQ === '1' ? 1 : lodQ === '0' ? 0 : 'auto';
setActorQuality(quality);
const app = createRenderer(document.getElementById('c'), { quality, dynamicResolution: false, fov: 40 });
app.resize(innerWidth, innerHeight);
const env = buildEnvironment(app.scene, app.renderer, { quality, venue: qs.get('venue') || 'sunset' });
env.setOpponentsVisible?.(false);
const label = document.getElementById('label');

if (PEOPLE_MODE === 'real') await loadPeopleAssets();
else humanTemplate(0), humanTemplate(1);

const COACH = { shirt: '#e8572a', trim: '#1d2b4a', shorts: '#1b2a44', skin: '#9a6648', headwear: '#1d2b4a', headwearKind: 'cap', hairStyle: 'short', hair: '#16110e' };
const people = [];
function person(kit, { pos, facing = 0, real = false, handed = 'right', l = lod }) {
  const racket = real ? buildRacket({ color: kit.racket || '#e8572a', handed }) : buildActorRacket({ color: kit.racket || '#e8572a' });
  const h = createSkinnedHuman({ kit, handed, lod: l, racket });
  app.scene.add(h.root);
  const anim = createActorAnimator(h);
  const p = { h, anim, state: { pos: { x: pos[0], y: 0, z: pos[1] }, vel: { x: 0, y: 0, z: 0 }, facing, stroke: null, swingPhase: 0, holding: 'ready', handed }, ctx: { time: 0 } };
  people.push(p);
  return p;
}
const cam = app.camera;
function look(px, py, pz, tx, ty, tz, fov = 40) {
  cam.position.set(px, py, pz);
  cam.lookAt(tx, ty, tz);
  cam.fov = fov;
  cam.updateProjectionMatrix();
}
const dt = 1 / 60;
function settle(frames, each) {
  for (let i = 0; i < frames; i++) {
    for (const p of people) {
      p.ctx.time = (p.ctx.time || 0) + dt;
      if (each) each(p, i);
      p.anim.update(p.state, dt, p.ctx);
    }
  }
}
const swing = (p, stroke, ph) => { p.state.holding = 'swing'; p.state.stroke = stroke; p.state.swingPhase = ph; };

if (view === 'close') {
  const kit = { ...kitFor(qs.get('seed') || 'portrait'), headwearKind: qs.get('hw') || 'none', hairStyle: qs.get('hair') || 'short', ...(qs.get('body') ? { body: qs.get('body') } : {}) };
  const p = person(kit, { pos: [0, -6], facing: 0, real: true });
  p.ctx.ball = { x: 0, y: 1.7, z: 0 };
  settle(40);
  const H = p.h.scale * (p.h.bind.refHeight || 1.8) / 1.8;
  if (qs.get('cam') === 'hands') look(0.45, 1.3 * H, -5.0, 0, 1.1 * H, -6.0, 24);
  else if (qs.get('cam') === 'face') look(0.25, 1.7 * H, -5.2, 0, 1.68 * H, -6.0, 18);
  else look(0.55, 1.55 * H, -4.4, 0, 1.32 * H, -6.0, 30);
  label.textContent = `Close-up (${PEOPLE_MODE})`;
} else if (view === 'kits') {
  const seeds = ['player-0', 'Lucía', 'player-2', 'Carla', 'player-4', 'Marta', 'player-6', 'Sol'];
  seeds.forEach((s, i) => {
    const p = person(kitFor(`rival-${s}`), { pos: [-3.5 + i * 1.0, -6.0], facing: 0, handed: i === 5 ? 'left' : 'right' });
    p.ctx.ball = { x: 0, y: 1.5, z: 0 };
  });
  settle(40);
  look(0, 1.45, -1.0, 0, 1.0, -6.0, 46);
  label.textContent = `Kit variety (${PEOPLE_MODE})`;
} else if (view === 'strokes') {
  const poses = [['forehand', 0.55], ['backhand', 0.5], ['volley-fh', 0.55], ['bandeja', 0.53], ['smash', 0.58], ['serve', 0.6]];
  poses.forEach(([stroke, ph], i) => {
    const p = person(COACH, { pos: [-3.75 + i * 1.5, -6.5], facing: 0 });
    swing(p, stroke, ph);
    p.ctx.ball = { x: -3.75 + i * 1.5 + (stroke === 'backhand' ? 0.5 : -0.5), y: stroke === 'smash' || stroke === 'bandeja' ? 2.2 : 1.0, z: -5.9 };
  });
  settle(50);
  look(4.6, 1.55, -0.6, 0.1, 1.05, -6.4, 44);
  label.textContent = `Strokes at contact (${PEOPLE_MODE})`;
} else if (view === 'match') {
  // Opponents 9-13 m away, a partner beside you, seen from your eyes at the baseline.
  const a = person(kitFor('rival-Paco', { shirt: '#c8263c', trim: '#16181d', shorts: '#16181d' }), { pos: [-2.2, -7.2], facing: 0 });
  const b = person(kitFor('rival-Lucía', { shirt: '#c8263c', trim: '#eef1f4', shorts: '#16181d' }), { pos: [2.4, -3.0], facing: 0 });
  const c = person(kitFor('partner-Marta', { shirt: '#eef1f4', trim: '#1d2b4a', shorts: '#1d2b4a' }), { pos: [-2.6, 5.2], facing: Math.PI });
  swing(a, 'forehand', Number(qs.get('phase') || 0.5));
  b.state.holding = 'ready';
  const ballP = { x: -1.6, y: 1.0, z: -6.6 };
  for (const p of [a, b, c]) p.ctx.ball = ballP;
  settle(50);
  look(2.1, 1.62, 7.9, 0, 1.0, -6, 68);
  label.textContent = `Match from the baseline (${PEOPLE_MODE})`;
} else if (view === 'replay') {
  const a = person(kitFor('rival-Bruno', { shirt: '#f0a020', trim: '#14213a', shorts: '#14213a' }), { pos: [1.4, -6.8], facing: 0, real: true });
  const b = person(kitFor('rival-Inés', { shirt: '#118c6e', trim: '#f4efe4', shorts: '#f4efe4' }), { pos: [-2.2, -5.4], facing: 0, real: true });
  swing(a, qs.get('stroke') || 'forehand', Number(qs.get('phase') || 0.55));
  a.ctx.ball = { x: 0.9, y: 1.0, z: -6.2 };
  b.ctx.ball = a.ctx.ball;
  b.state.holding = 'ready';
  settle(50);
  look(4.2, 1.9, -1.8, 0, 1.0, -6.4, 32);
  label.textContent = `Replay camera (${PEOPLE_MODE})`;
} else if (view === 'swing') {
  const p = person(kitFor(qs.get('seed') || 'rival-Paco'), { pos: [0, -6.5], facing: 0, real: true });
  swing(p, qs.get('stroke') || 'forehand', Number(qs.get('phase') || 0.55));
  p.ctx.ball = { x: -0.5, y: 1.0, z: -5.9 };
  settle(50);
  look(3.6, 1.35, -4.6, 0, 1.0, -6.4, 36);
  label.textContent = `${qs.get('stroke') || 'forehand'} @ ${qs.get('phase') || 0.55} (${PEOPLE_MODE})`;
} else if (view === 'turn') {
  const kit = { ...kitFor(qs.get('seed') || 'portrait'), ...(qs.get('body') ? { body: qs.get('body') } : {}), ...(qs.get('hair') ? { hairStyle: qs.get('hair') } : {}), ...(qs.get('hw') ? { headwearKind: qs.get('hw') } : {}) };
  [0, Math.PI / 2, Math.PI, -0.7].forEach((f, i) => {
    const p = person(kit, { pos: [-2.4 + i * 1.6, -6], facing: f, l: 0 });
    p.ctx.lookAt = { x: -2.4 + i * 1.6 + Math.sin(f) * 5, y: 1.6, z: -6 + Math.cos(f) * 5 };
  });
  settle(40);
  look(0, 1.1, -0.2, 0, 0.95, -6, 34);
  label.textContent = `Turntable (${PEOPLE_MODE})`;
}

if (view === 'hands') {
  // First-person forearms and hands as the app draws them: the rig on a synthetic tracked pose,
  // the camera at the eye (12 cm back, 6 cm down), pitch -14 deg, vertical FOV 74.
  // &pose=ready|contact|backhand|high
  const racket = buildRacket({ color: '#e8572a', handed: 'right' });
  const rig = createFirstPersonRig({ handed: 'right', skinTone: qs.get('skin') || '#c58c6a', racket });
  app.scene.add(rig.root);
  await rig.ready;
  const poses = {
    ready: {},
    // Contact out in front (as the app's forehand drill at contact): the hand ~0.6 m ahead at hip
    // to chest height, the off hand reaching forward-left.
    contact: { wristR: [0.36, 1.2, -0.6], racketAxis: [0.78, 0.22, -0.58], faceNormal: [-0.3, 0.05, -0.95], wristL: [-0.3, 1.3, -0.5] },
    backhand: { wristR: [-0.25, 1.18, -0.6], racketAxis: [-0.85, 0.2, -0.45], faceNormal: [0.25, 0.0, 0.97], wristL: [-0.12, 1.2, -0.38] },
    high: { wristR: [0.3, 1.62, -0.45], racketAxis: [0.1, 0.95, -0.25], faceNormal: [-0.2, 0.25, -0.95], wristL: [-0.25, 1.45, -0.5] },
  };
  const player = readyBody(2.1, 7.7, poses[qs.get('pose') || 'ready'] || {});
  const e = player.eye;
  const eye = new THREE.Vector3(e.x, e.y - 0.06, e.z + 0.12);
  cam.position.copy(eye);
  cam.rotation.set((Number(qs.get('pitch') || -14) * Math.PI) / 180, (Number(qs.get('yaw') || 0) * Math.PI) / 180, 0, 'YXZ');
  cam.fov = Number(qs.get('fov') || 74);
  cam.updateProjectionMatrix();
  const viewDir = cam.getWorldDirection(new THREE.Vector3());
  for (let i = 0; i < 30; i++) rig.update(player, 1 / 60, { eye, eye2: player.eye, viewDir, ball: null });
  // &orbit=deg: a camera 0.7 m from the racket hand (around it, slightly above), looking at it.
  if (qs.has('orbit')) {
    const a = (Number(qs.get('orbit')) * Math.PI) / 180;
    const w = player.bodyCourt.joints.wristR;
    cam.position.set(w.x + Math.sin(a) * 0.7, w.y + 0.25, w.z + Math.cos(a) * 0.7);
    cam.lookAt(w.x, w.y, w.z);
    cam.fov = 40;
    cam.updateProjectionMatrix();
  }
  // &cut=-0.2: no along-the-forearm cut (inspect the whole skinned forearm).
  if (qs.has('cut')) rig.root.traverse((o) => { if (o.isSkinnedMesh && o.material?.userData?.along) { o.material.userData.along.value = Number(qs.get('cut')); o.visible = true; } });
  window.__rig = rig;
  // &probe=1: CPU-skinned forearm metrics of the realistic arms (dshot prints window.__people).
  if (qs.has('probe')) {
    rig.root.updateMatrixWorld(true);
    window.__armProbe = [];
    rig.root.traverse((o) => {
      if (!o.isSkinnedMesh || !o.geometry.getAttribute('limbT')) return;
      o.skeleton.update();
      const lt = o.geometry.getAttribute('limbT');
      const bo = Object.fromEntries(o.skeleton.bones.map((b) => [b.name, b]));
      const E = new THREE.Vector3().setFromMatrixPosition(bo.elbow.matrixWorld), W = new THREE.Vector3().setFromMatrixPosition(bo.wrist.matrixWorld);
      const seg = new THREE.Line3(E, W), cp = new THREE.Vector3(), v = new THREE.Vector3();
      let far = 0, mid = 0, nm = 0;
      for (let i = 0; i < lt.count; i++) {
        o.getVertexPosition(i, v).applyMatrix4(o.matrixWorld);
        if (lt.getX(i) > 1.2) continue;
        seg.closestPointToPoint(v, true, cp);
        far = Math.max(far, v.distanceTo(cp));
        if (lt.getX(i) > 0.4 && lt.getX(i) < 0.6) { mid += v.distanceTo(cp); nm++; }
      }
      window.__armProbe.push({ E: E.toArray().map((x) => +x.toFixed(3)), W: W.toArray().map((x) => +x.toFixed(3)), len: +E.distanceTo(W).toFixed(3), far: +far.toFixed(3), midMean: +(mid / nm).toFixed(3), visible: o.visible, parentVisible: o.parent?.parent?.visible });
    });
  }
  label.textContent = `First-person hands, ${qs.get('pose') || 'ready'} (${PEOPLE_MODE})`;
}

let n = 0;
function frame() {
  env.update?.(dt);
  app.render(dt);
  if (++n < 4) requestAnimationFrame(frame);
  else {
    window.__people = {
      ready: true, mode: PEOPLE_MODE,
      calls: app.renderer.info.render.calls,
      tris: app.renderer.info.render.triangles,
      people: people.map((p) => ({ tris: p.h.triangles, lod: p.h.lod, realistic: p.h.realistic })),
      armProbe: window.__armProbe,
    };
    console.log('PEOPLE', JSON.stringify(window.__people));
  }
}
frame();
