// Realistic athletes (round 6): the baked MakeHuman assets (assets/people/*), their runtime
// geometry, kits, binds and the pose solver on a realistic skeleton. Node + three via a resolve hook.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, statSync } from 'node:fs';

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

const { parseGlb, loadPeopleAssets } = await import('../src/render/peopleAssets.js');
const { BONES } = await import('../src/render/humanModel.js');
const { chainNames } = await import('../src/render/handPose.js');

const DIR = join(ROOT, 'assets/people');
const buf = readFileSync(join(DIR, 'athletes.glb'));
const glb = parseGlb(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
const extras = glb.json.scenes[0].extras;

/** A library like loadPeopleAssets() builds (no textures in Node). */
async function nodeLib() {
  return loadPeopleAssets({ fetchImpl: async () => ({ ok: true, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) }) });
}

test('people assets: files, licence-ready sizes, both bodies with the game skeleton', () => {
  for (const f of ['athletes.glb', 'skin.webp', 'hair.webp', 'pores.webp', 'wrinkles.webp']) assert.ok(statSync(join(DIR, f)).size > 1000, f);
  const total = ['athletes.glb', 'skin.webp', 'hair.webp', 'pores.webp', 'wrinkles.webp'].reduce((a, f) => a + statSync(join(DIR, f)).size, 0);
  assert.ok(total < 5.5e6, `payload ${(total / 1e6).toFixed(2)} MB`);
  assert.deepEqual(extras.bones, BONES.map((b) => b.name));
  assert.deepEqual(extras.parents, BONES.map((b) => b.parent));
  for (const name of ['male', 'female']) {
    const t = extras.templates[name];
    assert.equal(t.bones.length, BONES.length);
    for (const p of t.bones) assert.ok(p.every(Number.isFinite));
    assert.ok(t.refHeight > 1.5 && t.refHeight < 1.95, `${name} ${t.refHeight}`);
    for (const k of ['upperArm', 'foreArm', 'thigh', 'shin', 'hipY', 'ankleY', 'hipX', 'shoulderY']) assert.ok(t.limbs[k] > 0, k);
    // Hand frames are orthonormal and right-handed (X = Y x Z).
    for (const S of ['R', 'L']) {
      const { X, Y, Z } = t.hand[S];
      const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      assert.ok(Math.abs(dot(X, Y)) < 1e-3 && Math.abs(dot(Y, Z)) < 1e-3 && Math.abs(dot(X, Z)) < 1e-3);
      const c = [Y[1] * Z[2] - Y[2] * Z[1], Y[2] * Z[0] - Y[0] * Z[2], Y[0] * Z[1] - Y[1] * Z[0]];
      assert.ok(dot(c, X) > 0.99);
    }
  }
});

test('people assets: budgets, valid skinning and attributes in every mesh', () => {
  const tris = (name) => glb.meshes[name].index.length / 3;
  for (const b of ['male', 'female']) {
    assert.ok(tris(`${b}/body/0`) < 36000, `${b} LOD0 ${tris(`${b}/body/0`)}`);
    assert.ok(tris(`${b}/body/1`) < 11000, `${b} LOD1 ${tris(`${b}/body/1`)}`);
  }
  for (const [name, m] of Object.entries(glb.meshes)) {
    const A = m.attributes;
    const n = A.POSITION.array.length / 3;
    for (const v of A.POSITION.array) assert.ok(Number.isFinite(v));
    for (const i of m.index) assert.ok(i < n, name);
    const W = A.WEIGHTS_0.array, J = A.JOINTS_0.array;
    const nJ = name.includes('/fparm/') ? 27 : BONES.length;
    for (let v = 0; v < n; v++) {
      let s = 0;
      for (let k = 0; k < 4; k++) { s += W[v * 4 + k]; if (W[v * 4 + k] > 0) assert.ok(J[v * 4 + k] < nJ, `${name} joint`); }
      assert.equal(s, 255, `${name} vertex ${v} weights`);
    }
  }
});

test('people assets: first-person arms carry the WebXR hand joints plus the forearm joints', () => {
  const fp = extras.templates.male.fparm.R;
  const want = ['wrist', ...Object.values(chainNames()).flat(), 'elbow', 'forearm-mid'];
  assert.deepEqual([...fp.joints.names].sort(), [...new Set(want)].sort());
  assert.ok(fp.length > 0.2 && fp.length < 0.32, `forearm ${fp.length}`);
  const m = glb.meshes['male/fparm/R'];
  const t = m.attributes._LIMBT.array;
  // Forearm vertices span 0..1 along the forearm; hand vertices sit beyond the cut range (1.5).
  const vals = Array.from(t, (x) => (x / 255) * 1.5);
  assert.ok(vals.some((x) => x < 0.1) && vals.some((x) => x > 0.9 && x <= 1) && vals.some((x) => x > 1.45));
});

test('kits: deterministic, bodies from names, heights and styles in range', async () => {
  const { kitFor, bodyForSeed } = await import('../src/render/skinnedHuman.js');
  assert.deepEqual(kitFor('rival-Paco'), kitFor('rival-Paco'));
  assert.equal(bodyForSeed('rival-Lucía'), 'female');
  assert.equal(bodyForSeed('partner-Marta'), 'female');
  assert.equal(bodyForSeed('rival-Paco'), 'male');
  assert.equal(bodyForSeed('coach'), 'male');
  for (let i = 0; i < 40; i++) {
    const k = kitFor(`player-${i}`);
    assert.ok(['male', 'female'].includes(k.body));
    assert.ok(k.height > 1.55 && k.height < 1.95);
    assert.ok(['short', 'buzz', 'medium', 'ponytail', 'bun', 'afro'].includes(k.hairStyle), k.hairStyle);
  }
  // Base fields (team colours, a career player's look) win.
  assert.equal(kitFor('x', { shirt: '#123456', body: 'female' }).shirt, '#123456');
  assert.equal(kitFor('x', { body: 'female' }).body, 'female');
});

test('realistic geometry: one draw call per person, mirrored left-handers stay closed and outward', async () => {
  const lib = await nodeLib();
  assert.ok(lib && lib.templates.male && lib.templates.female);
  const { buildRealGeometry, kitFor } = await import('../src/render/skinnedHuman.js');
  const vol = (g) => {
    const P = g.attributes.position.array, I = g.index.array;
    let v = 0;
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
      v += (P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c])) / 6;
    }
    return v;
  };
  for (const body of ['male', 'female']) {
    const kit = kitFor('t', { body, hairStyle: body === 'male' ? 'short' : 'ponytail', headwearKind: 'cap' });
    const r = buildRealGeometry(lib, body, 0, kit, 'right');
    const l = buildRealGeometry(lib, body, 0, kit, 'left');
    for (const g of [r, l]) {
      for (const a of ['position', 'normal', 'uv', 'color', 'surf', 'part', 'hmode', 'hao', 'skinIndex', 'skinWeight']) assert.ok(g.attributes[a], a);
      for (const x of g.attributes.color.array) assert.ok(Number.isFinite(x) && x >= 0);
    }
    assert.equal(r.index.count, l.index.count);
    // Mirroring keeps the winding outward (same signed volume) and swaps the bones' sides.
    const vr = vol(r), vl = vol(l);
    assert.ok(vr > 0.03 && Math.abs(vl - vr) / vr < 0.02, `${body} volumes ${vr} ${vl}`);
    const hi = BONES.findIndex((b) => b.name === 'handR'), li = BONES.findIndex((b) => b.name === 'handL');
    const count = (g, j) => Array.from(g.attributes.skinIndex.array).filter((x) => x === j).length;
    assert.equal(count(r, hi), count(l, li));
  }
});

test('realistic bind: the pose solver puts the racket on the stroke grip and keeps feet planted', async () => {
  const THREE = await import('three');
  const lib = await nodeLib();
  const { realBind } = await import('../src/render/skinnedHuman.js');
  const { createActorAnimator } = await import('../src/render/animation/animator.js');
  const { racketInHand } = await import('../src/render/handPose.js');
  const { STROKES, sampleStroke, strokeSample } = await import('../src/render/animation/strokes.js');
  for (const [body, handed] of [['male', 'right'], ['female', 'left']]) {
    const bind = realBind(lib.templates[body], handed, 1);
    const root = new THREE.Group();
    const rig = new THREE.Group();
    root.add(rig);
    const bones = {};
    const list = BONES.map((b) => { const o = new THREE.Bone(); o.name = b.name; bones[b.name] = o; return o; });
    BONES.forEach((b, i) => {
      const p = bind.positions[i], pp = b.parent >= 0 ? bind.positions[b.parent] : [0, 0, 0];
      list[i].position.set(p[0] - pp[0], p[1] - pp[1], p[2] - pp[2]);
      (b.parent >= 0 ? list[b.parent] : rig).add(list[i]);
    });
    const q = (b) => new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(...b.X), new THREE.Vector3(...b.Y), new THREE.Vector3(...b.Z)));
    const human = { root, rig, bones, handQuat: { R: q(bind.handBasis.R), L: q(bind.handBasis.L) }, scale: 1, handed, bind, kit: { body } };
    const anim = createActorAnimator(human);
    const state = { pos: { x: 1, y: 0, z: -6 }, vel: { x: 0, y: 0, z: 0 }, facing: 0, stroke: 'forehand', swingPhase: 0.55, holding: 'swing', handed };
    for (let i = 0; i < 90; i++) anim.update(state, 1 / 60, { time: i / 60, ball: { x: 1.4, y: 1, z: -5.5 } });
    root.updateMatrixWorld(true);
    const S = handed === 'left' ? 'L' : 'R';
    const hand = bones[`hand${S}`];
    const r = racketInHand(handed);
    const wq = new THREE.Quaternion();
    hand.getWorldQuaternion(wq);
    const grip = new THREE.Vector3().copy(r.pos).applyQuaternion(human.handQuat[S]).applyQuaternion(wq).add(hand.getWorldPosition(new THREE.Vector3()));
    const o = sampleStroke(STROKES.forehand, 0.55, strokeSample());
    const mir = handed === 'left' ? -1 : 1;
    const bs = bind.bodyScale;
    // Body frame -> court (facing 0: the player's right is court -x); targets scale with the body.
    const target = new THREE.Vector3(1 - mir * o.g[0] * bs, o.g[1] * bs, -6 + o.g[2] * bs);
    // The weight transfer moves the pelvis a few cm: the hand still holds the grip within 6 cm.
    assert.ok(grip.distanceTo(target) < 0.09, `${body} grip ${grip.distanceTo(target).toFixed(3)} m from the target`);
    for (const b of Object.values(bones)) assert.ok([b.quaternion.x, b.quaternion.w, b.position.x].every(Number.isFinite), b.name);
  }
});

test('people assets: licence file names every source as CC0', () => {
  const lic = readFileSync(join(DIR, 'LICENSE.md'), 'utf8');
  for (const f of ['athletes.glb', 'skin.webp', 'hair.webp', 'pores.webp', 'wrinkles.webp']) assert.ok(lic.includes(f), f);
  assert.ok(/MakeHuman/.test(lic) && /CC0 1\.0/.test(lic) && /@pmndrs\/assets/.test(lic));
});

test('realistic geometry: the shorts waistband tucks under the shirt hem, the legs do not move', async () => {
  const lib = await nodeLib();
  const { buildRealGeometry, kitFor } = await import('../src/render/skinnedHuman.js');
  const { REGION } = await import('../src/render/humanModel.js');
  for (const body of ['male', 'female']) {
    const tpl = lib.templates[body];
    const part = tpl.parts['body/0'];
    const g = buildRealGeometry(lib, body, 0, { ...kitFor('t'), hairStyle: 'none', headwearKind: 'none', body }, 'right');
    const P0 = part.attributes.POSITION.array, R = part.attributes._REGION.array, N = part.attributes.NORMAL.array;
    const P1 = g.getAttribute('position').array;
    const hipY = tpl.limbs.hipY;
    let top = 0, topIn = 0, legs = 0, legMoved = 0;
    for (let v = 0; v < P0.length / 3; v++) {
      if (R[v] !== REGION.SHORTS) continue;
      const d = [P1[v * 3] - P0[v * 3], P1[v * 3 + 1] - P0[v * 3 + 1], P1[v * 3 + 2] - P0[v * 3 + 2]];
      const along = (d[0] * N[v * 3] + d[1] * N[v * 3 + 1] + d[2] * N[v * 3 + 2]) / 127;
      if (P0[v * 3 + 1] > hipY - 0.05) { top++; if (along < -0.011) topIn++; }
      if (P0[v * 3 + 1] < hipY - 0.12) { legs++; if (Math.hypot(...d) > 1e-6) legMoved++; }
    }
    assert.ok(top > 50 && topIn === top, `${body}: ${topIn}/${top} waistband vertices tucked`);
    assert.ok(legs > 50 && legMoved === 0, `${body}: ${legMoved} leg vertices moved`);
  }
});

test('first-person realistic arms: a baked sweatband at the wrist, recoloured with the outfit', async () => {
  const lib = await nodeLib();
  const THREE = await import('three');
  const { realArm, realBandWeight, REAL_BAND, REAL_ELBOW_TRIM } = await import('../src/render/fpRig.js');
  assert.equal(realBandWeight(0.5), 0);
  assert.equal(realBandWeight(1.4), 0);
  assert.ok(realBandWeight((REAL_BAND.t0 + REAL_BAND.t1) / 2) > 0.99);
  assert.ok(REAL_ELBOW_TRIM > 0.05 && REAL_ELBOW_TRIM < REAL_BAND.t0);
  const arm = realArm(lib, 'right', new THREE.MeshBasicMaterial(), 'male', { skin: '#5f3b27', band: '#ffffff', stripe: '#000000' });
  const g = arm.mesh.geometry;
  const t = g.getAttribute('limbT'), c = g.getAttribute('color'), s = g.getAttribute('surf'), hm = g.getAttribute('hmode');
  let band = 0, skin = 0;
  for (let i = 0; i < t.count; i++) {
    const w = realBandWeight(t.getX(i));
    if (w === 1) {
      band++;
      // White band with a black stripe: every band vertex is a grey between them (no skin tint).
      assert.ok(Math.abs(c.getX(i) - c.getY(i)) < 1e-4 && Math.abs(c.getY(i) - c.getZ(i)) < 1e-4, 'band vertex is band / stripe coloured');
      assert.equal(hm.getX(i), 0);
      assert.equal(s.getY(i), 1);
    } else if (w === 0) {
      skin++;
      assert.ok(Math.abs(c.getX(i) - new THREE.Color('#5f3b27').r) < 1e-4);
      assert.equal(hm.getX(i), 1);
    }
  }
  assert.ok(band > 40 && skin > 1000, `${band} band, ${skin} skin vertices`);
  // The library's shared position array is not modified by the band lift.
  const src = lib.templates.male.parts['fparm/R'].attributes.POSITION.array;
  assert.notEqual(g.getAttribute('position').array, src);
  arm.setColors('#f2cdb0', '#1f6fd1', '#ffffff');
  const i0 = Array.from({ length: t.count }, (_, i) => i).find((i) => realBandWeight(t.getX(i)) > 0.99 && Math.abs(t.getX(i) - (REAL_BAND.t0 + 0.03)) < 0.03);
  assert.ok(c.getZ(i0) > c.getX(i0), 'blue band after setColors');
});

test('people: requestWarmup bumps the holding scene for a batched shader compile', async () => {
  const THREE = await import('three');
  const { requestWarmup } = await import('../src/render/peopleAssets.js');
  const scene = new THREE.Scene();
  const a = new THREE.Group();
  const b = new THREE.Group();
  scene.add(a);
  a.add(b);
  requestWarmup(b);
  requestWarmup(b);
  assert.equal(scene.userData.peopleVersion, 2);
  requestWarmup(new THREE.Group()); // not in a scene: nothing to do
});
