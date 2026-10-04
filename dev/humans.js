// Dev page for the skinned athletes in the real club: ?view=strokes|kits|close|run|serve|react
//   strokes  the coach in six stroke poses (forehand, backhand, volley, bandeja, smash jump, serve)
//   kits     eight players with generated kits (skin tones, hair, headwear)
//   close    a portrait (face, hair, shirt collar, hands on the racket)
//   run      a player shuffling / sprinting with foot planting (frames advanced, then a shot)
//   react    celebrate / frustrate / high five
// &quality=  &lod=0|1   window.__humans = { stats, ready }
import * as THREE from 'three';
import { createRenderer } from '../src/render/scene.js';
import { buildEnvironment } from '../src/render/environment.js';
import { setActorQuality } from '../src/render/actorKit.js';
import { createSkinnedHuman, kitFor } from '../src/render/skinnedHuman.js';
import { createActorAnimator } from '../src/render/animation/animator.js';
import { buildActorRacket } from '../src/render/actorRacket.js';
import { buildRacket } from '../src/render/racket.js';
import { humanTemplate } from '../src/render/humanModel.js';
import { createFirstPersonBody } from '../src/render/fpBody.js';
import { readyBody } from './actors-bodies.js';

const qs = new URLSearchParams(location.search);
const quality = qs.get('quality') || 'high';
const view = qs.get('view') || 'strokes';
const lod = qs.get('lod') === '1' ? 1 : 0;
setActorQuality(quality);
const app = createRenderer(document.getElementById('c'), { quality, dynamicResolution: false, fov: 40 });
app.resize(innerWidth, innerHeight);
const env = buildEnvironment(app.scene, app.renderer, { quality });
env.setOpponentsVisible?.(false);
const label = document.getElementById('label');

const t0 = performance.now();
humanTemplate(0);
humanTemplate(1);
const buildMs = performance.now() - t0;

const COACH = { shirt: '#e8572a', trim: '#1d2b4a', shorts: '#1b2a44', skin: '#9a6648', headwear: '#1d2b4a', headwearKind: 'cap', hairStyle: 'short', hair: '#16110e' };
const people = [];
function person(kit, { pos, facing = 0, real = false, handed = 'right' }) {
  const racket = real ? buildRacket({ color: kit.racket || '#e8572a', handed }) : buildActorRacket({ color: kit.racket || '#e8572a' });
  const h = createSkinnedHuman({ kit, handed, lod, racket });
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

if (view === 'strokes') {
  const poses = [['forehand', 0.55], ['backhand', 0.5], ['volley-fh', 0.55], ['bandeja', 0.53], ['smash', 0.58], ['serve', 0.6]];
  poses.forEach(([stroke, ph], i) => {
    const p = person(COACH, { pos: [-3.75 + i * 1.5, -6.5], facing: 0 });
    p.state.holding = 'swing';
    p.state.stroke = stroke;
    p.state.swingPhase = ph;
    p.ctx.ball = { x: -3.75 + i * 1.5 + (stroke === 'backhand' ? 0.5 : -0.5), y: stroke === 'smash' || stroke === 'bandeja' ? 2.2 : 1.0, z: -5.9 };
  });
  settle(50);
  look(4.6, 1.55, -0.6, 0.1, 1.05, -6.4, 44);
  label.textContent = 'Coach: forehand · backhand · volley · bandeja · smash (jump) · serve';
} else if (view === 'kits') {
  for (let i = 0; i < 8; i++) {
    const p = person(kitFor(`player-${i}`), { pos: [-3.5 + i * 1.0, -6.0], facing: 0, handed: i === 5 ? 'left' : 'right' });
    p.ctx.ball = { x: 0, y: 1.5, z: 0 };
  }
  settle(40);
  look(0, 1.45, -1.0, 0, 1.0, -6.0, 46);
  label.textContent = 'Kit variety: skin tones, hair styles, caps / visors / headbands, shirts, shorts, shoes';
} else if (view === 'close') {
  const p = person({ ...kitFor('portrait'), headwearKind: qs.get('hw') || 'none', hairStyle: qs.get('hair') || 'medium' }, { pos: [0, -6], facing: 0, real: true });
  p.ctx.ball = { x: 0, y: 1.7, z: 0 };
  settle(40);
  if (qs.get('cam') === 'hands') look(0.45, 1.3, -5.0, 0, 1.1, -6.0, 24);
  else if (qs.get('cam') === 'face') look(0.25, 1.7, -5.2, 0, 1.68, -6.0, 18);
  else look(0.55, 1.55, -4.4, 0, 1.32, -6.0, 30);
  label.textContent = 'Close-up';
} else if (view === 'run') {
  const p = person(COACH, { pos: [-3, -6.5], facing: 0 });
  const q = person(kitFor('runner'), { pos: [3, -8], facing: 0 });
  settle(400, (pp, i) => {
    const t = i * dt;
    if (pp === p) {
      // Side shuffle left/right.
      const v = 2.2 * Math.sin(t * 1.7);
      pp.state.vel.x = v;
      pp.state.pos.x += v * dt;
      pp.state.holding = Math.abs(v) > 0.6 ? 'run' : 'ready';
    } else {
      // Sprint toward the net, then back.
      const v = 5 * Math.sin(t * 0.9);
      pp.state.vel.z = v;
      pp.state.pos.z += v * dt;
      pp.state.holding = Math.abs(v) > 0.6 ? 'run' : 'ready';
    }
  });
  look(6.5, 1.3, -3.5, 0, 0.8, -7.0, 45);
  label.textContent = 'Foot planting: side shuffle (left), sprint (right)';
} else if (view === 'react') {
  const a = person(COACH, { pos: [-2.4, -6.5], facing: 0 });
  const b = person(kitFor('partner-1'), { pos: [-0.9, -6.6], facing: 0 });
  const c = person(kitFor('partner-2'), { pos: [2.0, -6.5], facing: 0 });
  a.ctx.cue = { react: { kind: 'celebrate', t0: 0.2, dur: 5 } };
  b.ctx.cue = { five: { t0: 0.2, dur: 5 } };
  b.ctx.partner = { x: -2.4, z: -6.5 };
  a.ctx.partner = { x: -0.9, z: -6.6 };
  a.ctx.cue.five = { t0: 0.2, dur: 5 };
  c.ctx.cue = { react: { kind: 'frustrate', t0: 0.2, dur: 5 } };
  settle(70);
  look(1.5, 1.5, -1.8, -0.4, 1.1, -6.5, 46);
  label.textContent = 'Fist pump + high five (left), frustration (right)';
} else if (view === 'fp') {
  // The player's own first-person body from a synthetic tracked pose; ?cam=eye|side|back.
  const fp = createFirstPersonBody({ handed: 'right', height: 1.75, kit: { skin: '#c58c6a' } });
  app.scene.add(fp.root);
  const player = readyBody(2.1, 7.7);
  player.vel = { x: 0, y: 0, z: 0 };
  const shuffle = qs.get('move') === '1';
  for (let i = 0; i < 90; i++) {
    if (shuffle) {
      const v = 1.8;
      player.vel.x = v;
      player.pos.x += v / 60;
      for (const j of Object.values(player.bodyCourt.joints)) j.x += v / 60;
      player.racket.grip.x += v / 60;
      player.eye.x += v / 60;
    }
    fp.update(player, 1 / 60, { visible: true, racket: player.racket, time: i / 60, camPos: { y: player.eye.y - 0.03 } });
  }
  window.__fp = fp;
  if (qs.get('nofade') === '1') { const u = fp.meshes.visible.material.userData; u.fpNear.value = 0; u.fpFar.value = 0.0001; }
  if (qs.get('noshadow') === '1') fp.meshes.shadow.visible = false;
  if (qs.get('double') === '1') { fp.meshes.visible.material.side = THREE.DoubleSide; fp.meshes.visible.material.needsUpdate = true; }
  if (qs.get('normalmat') === '1') { fp.meshes.visible.material = fp.meshes.shadow.material.clone(); fp.meshes.visible.material = new THREE.MeshStandardMaterial({ color: '#ff00ff' }); }
  const e = player.eye;
  const camKind = qs.get('cam') || 'eye';
  if (camKind === 'side') look(e.x + 2.6, 1.2, e.z - 0.4, e.x, 0.85, e.z, 45);
  else if (camKind === 'back') look(e.x + 0.6, 2.6, e.z + 2.6, e.x, 0.8, e.z, 45);
  else {
    cam.position.set(e.x, e.y - 0.03, e.z + 0.05);
    cam.rotation.set(-62 * Math.PI / 180, 0, 0, 'YXZ');
    cam.fov = 70;
    cam.updateProjectionMatrix();
  }
  label.textContent = `First-person body (${camKind})`;
  console.log('FP', JSON.stringify({ stats: fp.stats, hips: fp.pose.hipsPos, visible: fp.meshes.visible.visible }));
} else if (view === 'serve') {
  const p = person(COACH, { pos: [0, -7.6], facing: 0 });
  const at = Number(qs.get('t') || 0.5);
  p.ctx.cue = { serve: { at: 2.0 } };
  settle(Math.round((2.0 - at) / dt));
  look(3.0, 1.2, -5.5, 0, 0.8, -7.6, 40);
  label.textContent = `Serve, ${at.toFixed(2)} s before contact`;
}

let n = 0;
function frame() {
  env.update?.(dt);
  app.render(dt);
  if (++n < 4) requestAnimationFrame(frame);
  else {
    window.__humans = {
      ready: true,
      buildMs,
      calls: app.renderer.info.render.calls,
      tris: app.renderer.info.render.triangles,
      people: people.map((p) => ({ tris: p.h.triangles, lod: p.h.lod })),
    };
    console.log('HUMANS', JSON.stringify(window.__humans));
  }
}
frame();
