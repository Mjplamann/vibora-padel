// Presence & people (round 4): procedural skinned athletes, their animation and the player's own
// body. Pure modules (sdfMesh, humanModel, strokes, stepper, director) are tested directly; the
// three.js pose solver / actor animator run under Node through a resolve hook for 'three'.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { sdPrim, compileModel, polygonize } from '../src/render/sdfMesh.js';
import { humanTemplate, assembleHuman, BONES, REGION, PART, LIMBS } from '../src/render/humanModel.js';
import { STROKES, STROKE_NAMES, sampleStroke, strokeSample, contactPhase, strokeFamily } from '../src/render/animation/strokes.js';
import { createStepper, STEP } from '../src/render/animation/stepper.js';
import { createDirector, PLAYER_KEY, envelope } from '../src/render/animation/director.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const hook = `
const three = ${JSON.stringify(pathToFileURL(join(ROOT, 'vendor/three/three.module.js')).href)};
const addons = ${JSON.stringify(pathToFileURL(join(ROOT, 'vendor/three/addons/')).href)};
export async function resolve(spec, ctx, next) {
  if (spec === 'three') return { url: three, shortCircuit: true };
  if (spec.startsWith('three/addons/')) return { url: addons + spec.slice(13), shortCircuit: true };
  return next(spec, ctx);
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`);

// ------------------------------------------------------------------ SDF mesher

test('sdf: surface nets give a closed, outward sphere with the right volume', () => {
  const m = compileModel({ prims: [sdPrim.sphere([0, 0, 0], 0.1)], groups: [{ id: 's', prims: [0] }] });
  const r = polygonize(m, { cell: 0.008, ao: false });
  let vol = 0;
  const P = r.positions;
  for (let t = 0; t < r.index.length; t += 3) {
    const [a, b, c] = [r.index[t], r.index[t + 1], r.index[t + 2]];
    const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
    const bx = P[b * 3], by = P[b * 3 + 1], bz = P[b * 3 + 2];
    const cx = P[c * 3], cy = P[c * 3 + 1], cz = P[c * 3 + 2];
    vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  const exact = (4 / 3) * Math.PI * 0.001;
  assert.ok(vol > 0, 'outward winding');
  assert.ok(Math.abs(vol - exact) / exact < 0.04, `volume ${vol} vs ${exact}`);
  // Every vertex sits on the surface (refined along the gradient) with a unit normal.
  for (let v = 0; v < P.length / 3; v++) {
    const d = Math.hypot(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]) - 0.1;
    assert.ok(Math.abs(d) < 0.002, `vertex ${v} off the surface by ${d}`);
    const n = Math.hypot(r.normals[v * 3], r.normals[v * 3 + 1], r.normals[v * 3 + 2]);
    assert.ok(Math.abs(n - 1) < 1e-3);
  }
});

// ------------------------------------------------------------------ human template

test('human template: budgets, normalized smooth weights, valid regions and parts', () => {
  const tpl = humanTemplate(1);
  const h = assembleHuman(tpl, { handed: 'right', hair: 'ponytail', headwear: 'cap' });
  const tris = h.index.length / 3;
  assert.ok(tris < 16000, `LOD1 person ${tris} triangles`);
  const n = h.positions.length / 3;
  let blended = 0;
  for (let v = 0; v < n; v++) {
    let s = 0, k = 0;
    for (let i = 0; i < 4; i++) {
      const w = h.skinWeight[v * 4 + i];
      s += w;
      if (w > 0.02) k++;
      assert.ok(h.skinIndex[v * 4 + i] < BONES.length);
    }
    assert.ok(Math.abs(s - 1) < 1e-4, `weights of ${v} sum to ${s}`);
    if (k > 1) blended++;
    for (let i = 0; i < 3; i++) assert.ok(Number.isFinite(h.positions[v * 3 + i]) && Number.isFinite(h.normals[v * 3 + i]));
    assert.ok(Object.values(REGION).includes(h.region[v]));
    assert.ok(Object.values(PART).includes(h.part[v]));
  }
  // Smooth skin: a real share of the vertices blend two or more bones (joints).
  assert.ok(blended / n > 0.15, `blended share ${(blended / n).toFixed(2)}`);
  // Feet on the floor, head at ~1.8 m.
  let minY = Infinity, maxY = -Infinity;
  for (let v = 0; v < n; v++) { minY = Math.min(minY, h.positions[v * 3 + 1]); maxY = Math.max(maxY, h.positions[v * 3 + 1]); }
  assert.ok(minY > -0.02 && minY < 0.02, `soles at ${minY}`);
  assert.ok(maxY > 1.76 && maxY < 1.86, `top at ${maxY}`);
});

test('human template LOD0 stays affordable', () => {
  const tpl = humanTemplate(0);
  const h = assembleHuman(tpl, { handed: 'left', hair: 'medium', headwear: 'visor' });
  const tris = h.index.length / 3;
  assert.ok(tris < 60000, `LOD0 person ${tris} triangles`);
  // Left-handed: the closed racket fist is on the left hand (model +x).
  assert.ok(h.positions.length / 3 > 10000);
});

// ------------------------------------------------------------------ strokes

test('strokes: finite, orthonormal racket frames, continuous paths, contact in front', () => {
  const o = strokeSample();
  const prev = [0, 0, 0];
  for (const name of STROKE_NAMES) {
    let first = true;
    for (let i = 0; i <= 400; i++) {
      const ph = i / 400;
      sampleStroke(STROKES[name], ph, o);
      for (const k of ['g', 'a', 'n']) for (let j = 0; j < 3; j++) assert.ok(Number.isFinite(o[k][j]), `${name} ${k} at ${ph}`);
      assert.ok(Math.abs(Math.hypot(...o.a) - 1) < 1e-6);
      assert.ok(Math.abs(o.a[0] * o.n[0] + o.a[1] * o.n[1] + o.a[2] * o.n[2]) < 1e-6, 'normal ⟂ axis');
      if (!first) {
        const step = Math.hypot(o.g[0] - prev[0], o.g[1] - prev[1], o.g[2] - prev[2]);
        assert.ok(step < 0.03, `${name}: grip jumps ${step.toFixed(3)} m at phase ${ph}`);
      }
      prev[0] = o.g[0]; prev[1] = o.g[1]; prev[2] = o.g[2];
      first = false;
    }
    sampleStroke(STROKES[name], contactPhase(name), o);
    if (['forehand', 'backhand', 'volley-fh', 'volley-bh', 'lob', 'chiquita', 'serve'].includes(name)) {
      assert.ok(o.g[2] > 0.3, `${name}: contact ${o.g[2].toFixed(2)} m in front`);
    }
    if (strokeFamily(name) === 'oh') assert.ok(o.g[1] > 1.85, `${name}: overhead contact at ${o.g[1].toFixed(2)} m`);
  }
  sampleStroke(STROKES.smash, contactPhase('smash'), o);
  assert.ok(o.jump > 0.15, 'the smash jumps');
});

// ------------------------------------------------------------------ foot planting

function runStepper(seconds, motion, { yaw = 0, stance = { R: [0.24, 0], L: [-0.24, 0] }, cues = () => ({}) } = {}) {
  const st = createStepper();
  const dt = 1 / 60;
  const body = { x: 0, z: 0 };
  st.reset(body.x, body.z, yaw, stance);
  const frames = [];
  for (let i = 0; i < seconds * 60; i++) {
    const t = i * dt;
    const v = motion(t);
    body.x += v.x * dt;
    body.z += v.z * dt;
    const c = cues(t);
    const s = st.update(dt, { x: body.x, z: body.z, vx: v.x, vz: v.z, yaw, stance, hop: !!c.hop, jump: c.jump || 0 });
    frames.push({
      t, body: { ...body }, airborne: s.airborne,
      R: { x: st.feet.R.x, z: st.feet.R.z, planted: st.feet.R.planted, y: st.feet.R.y },
      L: { x: st.feet.L.x, z: st.feet.L.z, planted: st.feet.L.planted, y: st.feet.L.y },
    });
  }
  return { frames, stepper: st };
}

test('stepper: planted feet never slide; feet stay under the body; shuffles never cross', () => {
  // Side shuffle (yaw 0: the actor's right is -x) at up to 2.2 m/s, back and forth.
  const { frames, stepper } = runStepper(6, (t) => ({ x: 2.2 * Math.sin(t * 1.7), z: 0 }));
  let steps = 0;
  for (let i = 1; i < frames.length; i++) {
    for (const s of ['R', 'L']) {
      const a = frames[i - 1][s], b = frames[i][s];
      if (a.planted && b.planted) assert.ok(Math.hypot(a.x - b.x, a.z - b.z) < 1e-9, `${s} slid at ${frames[i].t}`);
      if (a.planted && !b.planted) steps++;
      const d = Math.hypot(b.x - frames[i].body.x, b.z - frames[i].body.z);
      assert.ok(d < 0.8, `${s} foot ${d.toFixed(2)} m from the body`);
    }
    // R foot (actor's right = -x) stays to the right of the L foot.
    assert.ok(frames[i].L.x - frames[i].R.x > STEP.minSep * 0.6, `feet crossed at ${frames[i].t}`);
  }
  // Fast shuffles gallop (a short flight as the lead foot leaves): mostly a foot stays down.
  const flight = frames.filter((f) => f.airborne === 2).length / frames.length;
  assert.ok(flight < 0.2, `both feet off the ground ${(flight * 100).toFixed(0)}% of the time`);
  assert.ok(steps > 12, `${steps} steps`);
  assert.equal(stepper.feet.R.y >= 0, true);
});

test('stepper: a sprint alternates feet within the max stride; standing still does not fidget', () => {
  const run = runStepper(3, (t) => ({ x: 0, z: Math.min(5.5, t * 6) }));
  let lastSide = null, alternations = 0, lifts = 0;
  for (let i = 1; i < run.frames.length; i++) {
    for (const s of ['R', 'L']) {
      if (run.frames[i - 1][s].planted && !run.frames[i][s].planted) {
        lifts++;
        if (lastSide && lastSide !== s) alternations++;
        lastSide = s;
      }
    }
  }
  assert.ok(lifts > 8 && alternations / (lifts - 1) > 0.8, `${lifts} lifts, ${alternations} alternations`);
  const still = runStepper(2, () => ({ x: 0, z: 0 }));
  let moved = 0;
  for (let i = 1; i < still.frames.length; i++) if (still.frames[i - 1].R.planted && !still.frames[i].R.planted) moved++;
  assert.equal(moved, 0);
});

test('stepper: the split-step lifts both feet together and lands them wider', () => {
  const r = runStepper(1.2, () => ({ x: 0, z: 0 }), { cues: (t) => ({ hop: t > 0.3 && t < 0.32 }) });
  const air = r.frames.filter((f) => f.airborne === 2);
  assert.ok(air.length >= 10, `both feet in the air for ${air.length} frames`);
  const before = r.frames[10], after = r.frames[r.frames.length - 1];
  const w0 = Math.abs(before.L.x - before.R.x), w1 = Math.abs(after.L.x - after.R.x);
  assert.ok(w1 > w0 + 0.03, `stance ${w0.toFixed(2)} -> ${w1.toFixed(2)}`);
  assert.equal(after.airborne, 0);
});

// ------------------------------------------------------------------ director

function fakeWorld() {
  const subs = new Map();
  return {
    time: 10,
    bus: {
      on(type, fn) { subs.set(type, fn); return () => subs.delete(type); },
      emit(type, p) { subs.get(type)?.(p); },
    },
    ball: { pos: { x: 0, y: 1, z: -5 }, atRest: false },
    machine: null,
    mode: null,
    referee: null,
  };
}

test('director: split-step lands as the opponent strikes; reactions and high fives after a point', () => {
  const d = createDirector();
  const w = fakeWorld();
  const oppA = { holding: 'swing', stroke: 'forehand', swingPhase: 0.45, swingT: 0.405, team: 1 };
  const people = [
    { key: PLAYER_KEY, team: 0, pos: { x: 2, z: 7 }, state: null },
    { key: 'B', team: 0, pos: { x: -2, z: 7 }, state: { team: 0 } },
    { key: 'C', team: 1, pos: { x: -2, z: -7 }, state: oppA },
    { key: 'D', team: 1, pos: { x: 2, z: -7 }, state: { team: 1 } },
  ];
  d.update(w, people);
  const sp = d.cue(PLAYER_KEY).split;
  assert.ok(sp, 'the player split-steps');
  // Contact in (0.55 - 0.45) * 0.9 = 0.09 s; the hop lands just after it.
  assert.ok(Math.abs(sp.tLand - (10 + 0.09 + 0.05)) < 1e-6);
  assert.ok(d.cue('B').split, 'so does the partner');
  assert.equal(d.cue('D').split, null, 'not the striker\'s own team');
  // Point to the near team: they celebrate and high-five, the far team is frustrated.
  w.bus.emit('rally:outcome', { winner: 0, reason: 'winner' });
  w.time = 10.3;
  d.update(w, people);
  assert.equal(d.cue(PLAYER_KEY).react.kind, 'celebrate');
  assert.equal(d.cue('C').react.kind, 'frustrate');
  assert.equal(d.cue('B').five.with, PLAYER_KEY);
  assert.equal(d.cue('D').five.with, 'C');
  // Envelopes fade in and out.
  const r = d.cue('C').react;
  assert.equal(envelope(r.t0 - 0.1, r.t0, r.dur), 0);
  assert.ok(envelope(r.t0 + r.dur / 2, r.t0, r.dur) > 0.99);
});

test('director: the server bounces the ball while the serve is awaited', () => {
  const d = createDirector();
  const w = fakeWorld();
  w.ball = null;
  w.mode = { state: { serving: { team: 1, player: 1, box: 'right' } } };
  w.referee = { state: { awaitingServe: true } };
  const people = [
    { key: 'C', team: 1, pos: { x: -2, z: -7 }, state: { team: 1 }, serverIndex: 0 },
    { key: 'D', team: 1, pos: { x: 2, z: -7.6 }, state: { team: 1, serveAt: 11.2 }, serverIndex: 1 },
  ];
  d.update(w, people);
  assert.equal(d.cue('C').serve, null);
  assert.deepEqual(d.cue('D').serve, { at: 11.2 });
});

// ------------------------------------------------------------------ pose solver (three)

async function mockHuman(handed = 'right') {
  const THREE = await import('three');
  const { handBindQuat } = await import('../src/render/skinnedHuman.js');
  const root = new THREE.Group();
  const rig = new THREE.Group();
  root.add(rig);
  const bones = {};
  const list = BONES.map((b) => { const o = new THREE.Bone(); o.name = b.name; bones[b.name] = o; return o; });
  BONES.forEach((b, i) => {
    const pp = b.parent >= 0 ? BONES[b.parent].pos : [0, 0, 0];
    list[i].position.set(b.pos[0] - pp[0], b.pos[1] - pp[1], b.pos[2] - pp[2]);
    (b.parent >= 0 ? list[b.parent] : rig).add(list[i]);
  });
  return { THREE, human: { root, rig, bones, handQuat: { R: handBindQuat('R'), L: handBindQuat('L') }, scale: 1, handed } };
}

test('animator: the racket hand reaches the stroke grip, feet stay planted, nothing goes non-finite', async () => {
  const { THREE, human } = await mockHuman();
  const { createActorAnimator } = await import('../src/render/animation/animator.js');
  const { racketInHand } = await import('../src/render/handPose.js');
  const anim = createActorAnimator(human);
  const state = { pos: { x: 1, y: 0, z: -6 }, vel: { x: 0, y: 0, z: 0 }, facing: 0, stroke: 'forehand', swingPhase: 0.55, holding: 'swing', handed: 'right' };
  for (let i = 0; i < 90; i++) anim.update(state, 1 / 60, { time: i / 60, ball: { x: 1.4, y: 1, z: -5.5 } });
  human.root.updateMatrixWorld(true);
  // Racket grip from the hand bone (canonical grip) vs the stroke's grip target in court space.
  const hand = human.bones.handR;
  const r = racketInHand('right');
  const q = new THREE.Quaternion();
  hand.getWorldQuaternion(q);
  const grip = new THREE.Vector3().copy(r.pos).applyQuaternion(human.handQuat.R).applyQuaternion(q).add(hand.getWorldPosition(new THREE.Vector3()));
  const o = sampleStroke(STROKES.forehand, 0.55, strokeSample());
  // Body frame (x = right = court -x for facing 0) -> court.
  const target = new THREE.Vector3(1 - o.g[0], o.g[1], -6 + o.g[2]);
  assert.ok(grip.distanceTo(target) < 0.04, `grip ${grip.distanceTo(target).toFixed(3)} m from the target`);
  // Shuffle: a planted foot's ankle does not slide in court space.
  state.holding = 'run';
  state.stroke = null;
  let prev = null, slid = 0, checked = 0;
  const ank = new THREE.Vector3();
  for (let i = 0; i < 180; i++) {
    const v = 2 * Math.sin(i / 60 * 2);
    state.vel.x = v;
    state.pos.x += v / 60;
    anim.update(state, 1 / 60, { time: 2 + i / 60 });
    human.root.updateMatrixWorld(true);
    human.bones.footR.getWorldPosition(ank);
    const planted = anim.stepper.feet.R.planted;
    if (prev && planted && prev.planted) {
      checked++;
      if (Math.hypot(ank.x - prev.x, ank.z - prev.z) > 0.012) slid++;
    }
    prev = { x: ank.x, z: ank.z, planted };
  }
  assert.ok(checked > 40 && slid / checked < 0.05, `${slid}/${checked} planted frames slid`);
  // Garbage in: NaN / huge inputs never reach the bones.
  for (const bad of [NaN, Infinity, 1e9]) {
    anim.update({ ...state, pos: { x: bad, y: 0, z: 0 }, vel: { x: bad, y: 0, z: 0 }, facing: bad, swingPhase: bad }, 1 / 60, { time: 5, ball: { x: bad, y: 1, z: 0 } });
  }
  for (const b of Object.values(human.bones)) {
    assert.ok([b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w, b.position.x, b.position.y, b.position.z].every(Number.isFinite), b.name);
  }
});
